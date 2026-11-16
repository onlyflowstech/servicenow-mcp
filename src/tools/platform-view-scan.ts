/**
 * `sn_platform_view`, view `scan_findings`: the findings of one Instance Scan
 * result, by check and as rows.
 *
 * Reads, each in its own response scope and never cached:
 * 1. `scan_result`: the result (a given sys_id, or the latest complete one,
 *    chosen from the ten most recent) and its header;
 * 2. `scan_finding`, together: one Aggregate API call grouped on `check`, and
 *    one page of the finding rows, both under the same filter;
 * 3. `scan_check`: names, categories and priorities of the checks the groups
 *    and rows name, in chunks of at most 100 ids (a check is looked up by
 *    sys_id only). At most three chunks, read together.
 *
 * A `category`, `priority` or check-name filter is a dot-walk from the finding
 * to its check (`check.category=...`). That reads `scan_check`, which is in the
 * view's plan, and the filter is string equality: `category` and `priority`
 * are String fields, not choice lists.
 *
 * Never requested, in any `sysparm_fields`, query or group: `finding_details`,
 * `scan_finding.task`, `scan_finding.user`, `scan_check.script` and
 * `scan_result.message`. A row the instance returns anyway is projected to the
 * view's own fields, so these cannot reach the output.
 *
 * @module tools/platform-view-scan
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ServiceNowOperations } from "../client.js";
import { uncachedOperations } from "../metadata-cache.js";
import {
  asRecord,
  cleanText,
  errorCategory,
  FIELD_POLICY_HINT,
  firstUnreadable,
  flag,
  inOwnScope,
  isMissingTable,
  listParams,
  liveFieldAccess,
  memoizedFieldAccess,
  pageOf,
  readableOf,
  readableRow,
  rowsOf,
  scalar,
  STATS_PATH,
  SYS_ID,
  TABLE_PATH,
  viewResult,
  wholeNumber,
  type FieldAccessHandler,
  type PlatformViewFieldAccess,
} from "./platform-view-upgrades.js";
import type { CanonicalPlatformViewArgs } from "./platform-view-contracts.js";
import { bulletList, headline, renderMarkdown, table, text, untrustedBlock, type MarkdownFragment } from "./markdown.js";
import type { ServiceNowToolHandlerServices } from "./tool-module.js";

/** Never `message`. */
export const SCAN_RESULT_FIELDS = Object.freeze(["sys_id", "number", "state", "finding_count", "scan_type", "sys_created_on"]);
/** Never `finding_details`, `task` or `user`. */
export const SCAN_FINDING_FIELDS = Object.freeze(["sys_id", "check", "source_table", "source", "count", "muted"]);
/** Never `script`. */
export const SCAN_CHECK_FIELDS = Object.freeze(["sys_id", "name", "category", "priority", "short_description"]);

/**
 * Every field this view may request or filter on, by table: what the module
 * prepares in `resolveAccess` (intersected with what the profile may read; a
 * field that is not readable is left out, never an error). `scan_finding.result`
 * is filtered on, not requested.
 */
export const SCAN_FINDINGS_FIELD_PLAN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  scan_result: SCAN_RESULT_FIELDS,
  scan_finding: [...SCAN_FINDING_FIELDS, "result"],
  scan_check: SCAN_CHECK_FIELDS,
});

const RESULT_REQUIRED = Object.freeze(["sys_id", "state"]);
const FINDING_REQUIRED = Object.freeze(["sys_id", "check", "result"]);

/** The newest results read to find the latest complete one. */
const RECENT_RESULTS = 10;
/** Groups read from the Aggregate API, and checks shown from them. */
const MAX_GROUPS = 1_000;
const BY_CHECK_SHOWN = 25;
/** Check ids per `scan_check` read. */
const CHECK_CHUNK = 100;

export const SCAN_DENIED_HINT = "Reading Instance Scan results was denied for this account.";
export const SCAN_UNAVAILABLE_HINT = "Instance Scan is not available on this instance: its tables were not found.";

interface CheckDetail {
  readonly name?: string;
  readonly category?: string;
  readonly priority?: string;
  readonly short_description?: string;
}

function isCompleteState(state: string | undefined): boolean {
  return state !== undefined && state.trim().toLowerCase().startsWith("complete");
}

function projectResult(row: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const id = scalar(row.sys_id)?.trim().toLowerCase();
  if (id === undefined || !SYS_ID.test(id)) return undefined;
  const number = cleanText(row.number, 80);
  const state = cleanText(row.state, 40);
  const created = cleanText(row.sys_created_on, 40);
  const type = cleanText(row.scan_type, 40);
  const count = wholeNumber(row.finding_count);
  return {
    sys_id: id,
    ...(number === undefined ? {} : { number }),
    ...(state === undefined ? {} : { state }),
    ...(count === undefined ? {} : { finding_count: count }),
    ...(type === undefined ? {} : { scan_type: type }),
    ...(created === undefined ? {} : { created }),
  };
}

/** `[{check, findings, occurrences?}]` from an Aggregate API response, largest first. */
function checkGroups(response: unknown, withSum: boolean): { check: string; findings: number; occurrences?: number }[] {
  const result = (response as { result?: unknown } | null | undefined)?.result;
  const groups = Array.isArray(result) ? result : typeof result === "object" && result !== null ? [result] : [];
  const out: { check: string; findings: number; occurrences?: number }[] = [];
  for (const entry of groups) {
    const group = asRecord(entry);
    const fields = Array.isArray(group.groupby_fields) ? group.groupby_fields : [];
    const keyed = fields.map(asRecord).find((field) => scalar(field.field) === "check");
    const check = scalar(keyed?.value)?.trim().toLowerCase();
    const stats = asRecord(group.stats);
    const findings = wholeNumber(stats.count);
    if (check === undefined || !SYS_ID.test(check) || findings === undefined) continue;
    const occurrences = withSum ? wholeNumber(asRecord(stats.sum).count) : undefined;
    out.push({ check, findings, ...(occurrences === undefined ? {} : { occurrences }) });
  }
  return out.sort((a, b) => b.findings - a.findings || (a.check < b.check ? -1 : 1));
}

/**
 * Build the `view: "scan_findings"` handler. `handleScanFindings` is the one
 * the module registers; a test builds its own with a fixed field access.
 */
export function createScanFindingsHandler(
  defaults: { readonly fieldAccess?: PlatformViewFieldAccess } = {}
): FieldAccessHandler {
  return async (
    args: CanonicalPlatformViewArgs,
    services: ServiceNowToolHandlerServices,
    fieldAccess?: PlatformViewFieldAccess
  ): Promise<CallToolResult> => {
    const access = memoizedFieldAccess(fieldAccess ?? defaults.fieldAccess ?? liveFieldAccess);
    const ops: ServiceNowOperations = uncachedOperations(services.serviceNow);
    const signal = services.context?.signal;
    const denied = (hint: string, status: "denied" | "unavailable" = "denied") =>
      viewResult(args, { view: "scan_findings", status, hint });

    // A filter, order or group on a field the profile cannot read would tell it
    // something about that field, so every field this view queries must be readable.
    const filterFields: Record<string, readonly string[]> = {
      scan_finding: [
        ...FINDING_REQUIRED,
        ...(args.include_muted === true ? [] : ["muted"]),
        ...(args.source_table === undefined ? [] : ["source_table"]),
      ],
      scan_check: [
        ...(args.check !== undefined && !SYS_ID.test(args.check) ? ["name"] : []),
        ...(args.category === undefined ? [] : ["category"]),
        ...(args.priority === undefined ? [] : ["priority"]),
      ],
    };
    if (
      // "Latest" sorts on `sys_created_on`; a named result does not.
      firstUnreadable(access, "scan_result", [
        ...RESULT_REQUIRED,
        ...(args.result === undefined || args.result === "latest" ? ["sys_created_on"] : []),
      ]) !== undefined ||
      firstUnreadable(access, "scan_finding", filterFields.scan_finding!) !== undefined ||
      firstUnreadable(access, "scan_check", filterFields.scan_check!) !== undefined
    ) {
      return denied(FIELD_POLICY_HINT);
    }

    // 1. The result.
    const selected = args.result !== undefined && args.result !== "latest" ? args.result : undefined;
    let resultRows: Record<string, unknown>[];
    try {
      resultRows = rowsOf(
        await inOwnScope(signal, () =>
          ops.get(
            `${TABLE_PATH}scan_result`,
            listParams({
              fields: readableOf(access, "scan_result", SCAN_RESULT_FIELDS),
              query: selected === undefined ? "ORDERBYDESCsys_created_on" : `sys_id=${selected}`,
              limit: selected === undefined ? RECENT_RESULTS : 1,
            })
          )
        )
      );
    } catch (error) {
      if (errorCategory(error) === "authorization") return denied(SCAN_DENIED_HINT);
      if (isMissingTable(error)) return denied(SCAN_UNAVAILABLE_HINT, "unavailable");
      throw error;
    }
    const resultFields = readableOf(access, "scan_result", SCAN_RESULT_FIELDS);
    const recent = resultRows
      .map((row) => projectResult(readableRow(access, "scan_result", row, resultFields)))
      .filter((row): row is Record<string, unknown> => row !== undefined);
    const chosen =
      selected === undefined ? recent.find((row) => isCompleteState(scalar(row.state))) : recent[0];
    if (chosen === undefined) {
      return viewResult(args, {
        view: "scan_findings",
        status: "ok",
        summary: {
          result: null,
          ...(selected === undefined && recent.length > 0 ? { recent_results: recent.slice(0, 5) } : {}),
        },
        results: [],
        hint:
          selected === undefined
            ? "No complete scan result was found among the most recent ones. Pass result: <sys_id> to read one."
            : "No scan result matches the given sys_id.",
      });
    }
    const resultId = scalar(chosen.sys_id) ?? "";

    // 2. The findings, grouped by check and as rows, under one filter.
    const clauses = [`result=${resultId}`];
    if (args.include_muted !== true) clauses.push("muted=false");
    if (args.source_table !== undefined) clauses.push(`source_table=${args.source_table}`);
    if (args.check !== undefined) {
      clauses.push(SYS_ID.test(args.check.toLowerCase()) ? `check=${args.check.toLowerCase()}` : `check.name=${args.check}`);
    }
    if (args.category !== undefined) clauses.push(`check.category=${args.category}`);
    if (args.priority !== undefined) clauses.push(`check.priority=${args.priority}`);
    const filter = clauses.join("^");
    const sumCount = access.canRead("scan_finding", "count");
    const order = `${sumCount ? "^ORDERBYDESCcount" : ""}^ORDERBYsys_id`;

    let groups: ReturnType<typeof checkGroups>;
    let findingRows: Record<string, unknown>[];
    try {
      [groups, findingRows] = await Promise.all([
        inOwnScope(signal, () =>
          ops.get(`${STATS_PATH}scan_finding`, {
            sysparm_query: filter,
            sysparm_group_by: "check",
            sysparm_count: "true",
            ...(sumCount ? { sysparm_sum_fields: "count" } : {}),
            sysparm_limit: String(MAX_GROUPS + 1),
          })
        ).then((response) => checkGroups(response, sumCount)),
        inOwnScope(signal, () =>
          ops.get(
            `${TABLE_PATH}scan_finding`,
            listParams({
              fields: readableOf(access, "scan_finding", SCAN_FINDING_FIELDS),
              query: `${filter}${order}`,
              limit: args.limit + 1,
              offset: args.offset,
            })
          )
        ).then(rowsOf),
      ]);
    } catch (error) {
      if (errorCategory(error) === "authorization") return denied(SCAN_DENIED_HINT);
      throw error;
    }
    const groupsTruncated = groups.length > MAX_GROUPS;
    const allGroups = groups.slice(0, MAX_GROUPS);
    const shownGroups = allGroups.slice(0, BY_CHECK_SHOWN);
    const { page, hasMore } = pageOf(findingRows, args.limit);
    const findingFields = readableOf(access, "scan_finding", SCAN_FINDING_FIELDS);
    const rows = page.map((row) => readableRow(access, "scan_finding", row, findingFields));

    // 3. The checks those name.
    const wanted = new Set<string>(shownGroups.map((group) => group.check));
    for (const row of rows) {
      const id = scalar(row.check)?.trim().toLowerCase();
      if (id !== undefined && SYS_ID.test(id)) wanted.add(id);
    }
    const details = new Map<string, CheckDetail>();
    const warnings: string[] = [];
    const checkFields = readableOf(access, "scan_check", SCAN_CHECK_FIELDS);
    // Without `sys_id` a row cannot be matched to its check, and an empty
    // projection would mean every field (`script` among them): read nothing.
    const ids = checkFields.includes("sys_id") ? [...wanted] : [];
    const chunks: string[][] = [];
    for (let start = 0; start < ids.length; start += CHECK_CHUNK) chunks.push(ids.slice(start, start + CHECK_CHUNK));
    try {
      // At most three chunks, read together; `Promise.all` keeps their order,
      // so the result does not depend on which read finishes first.
      const perChunk = await Promise.all(
        chunks.map((chunk) =>
          inOwnScope(signal, () =>
            ops.get(
              `${TABLE_PATH}scan_check`,
              listParams({ fields: checkFields, query: `sys_idIN${chunk.join(",")}`, limit: chunk.length })
            )
          ).then(rowsOf)
        )
      );
      for (const checkRows of perChunk) {
        for (const raw of checkRows) {
          const row = readableRow(access, "scan_check", raw, checkFields);
          const id = scalar(row.sys_id)?.trim().toLowerCase();
          if (id === undefined || !SYS_ID.test(id)) continue;
          const name = cleanText(row.name, 100);
          const category = cleanText(row.category, 40);
          const priority = cleanText(row.priority, 40);
          const short = cleanText(row.short_description, 120);
          details.set(id, {
            ...(name === undefined ? {} : { name }),
            ...(category === undefined ? {} : { category }),
            ...(priority === undefined ? {} : { priority }),
            ...(short === undefined ? {} : { short_description: short }),
          });
        }
      }
    } catch (error) {
      if (errorCategory(error) !== "authorization") throw error;
      warnings.push("Check details were not readable; checks are shown by sys_id.");
    }

    const byCheck = shownGroups.map((group) => ({
      check: group.check,
      ...details.get(group.check),
      findings: group.findings,
      ...(group.occurrences === undefined ? {} : { occurrences: group.occurrences }),
    }));
    const results = rows.flatMap((row): Record<string, unknown>[] => {
      const id = scalar(row.sys_id)?.trim().toLowerCase();
      if (id === undefined || !SYS_ID.test(id)) return [];
      const check = scalar(row.check)?.trim().toLowerCase();
      const name = check === undefined ? undefined : details.get(check)?.name;
      const sourceTable = cleanText(row.source_table, 80);
      const source = cleanText(row.source, 32);
      const count = wholeNumber(row.count);
      const muted = flag(row.muted);
      return [
        {
          sys_id: id,
          ...(check === undefined ? {} : { check }),
          ...(name === undefined ? {} : { check_name: name }),
          ...(sourceTable === undefined ? {} : { source_table: sourceTable }),
          ...(source === undefined ? {} : { source }),
          ...(count === undefined ? {} : { count }),
          ...(muted === undefined ? {} : { muted }),
        },
      ];
    });
    if (groupsTruncated) warnings.push(`More than ${MAX_GROUPS} checks have findings; the totals cover the first ${MAX_GROUPS}.`);

    const totalFindings = allGroups.reduce((sum, group) => sum + group.findings, 0);
    return viewResult(args, {
      view: "scan_findings",
      status: "ok",
      summary: {
        result: chosen,
        filters: {
          include_muted: args.include_muted === true,
          ...(args.check === undefined ? {} : { check: args.check }),
          ...(args.category === undefined ? {} : { category: args.category }),
          ...(args.priority === undefined ? {} : { priority: args.priority }),
          ...(args.source_table === undefined ? {} : { source_table: args.source_table }),
        },
        totals: { findings: totalFindings, checks: allGroups.length },
        by_check: byCheck,
        ...(allGroups.length > shownGroups.length ? { by_check_truncated: true } : {}),
      },
      results,
      record_count: results.length,
      has_more: hasMore,
      ...(hasMore ? { next_offset: args.offset + page.length } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  };
}

/** The handler the dispatcher registers. */
export const handleScanFindings: FieldAccessHandler = createScanFindingsHandler();

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function shown(value: unknown): string {
  return scalar(value) ?? "-";
}

/**
 * The readable text of a `scan_findings` result. Every value is instance text:
 * names and categories are escaped table cells, check descriptions and the
 * finding rows sit inside an `untrustedBlock`.
 */
export function renderScanFindingsText(data: unknown): string | undefined {
  const record = asRecord(data);
  if (record.view !== "scan_findings") return undefined;
  const summary = asRecord(record.summary);
  if (record.status !== "ok") {
    return renderMarkdown(headline("Instance Scan", { status: "fail", detail: scalar(record.hint) ?? "not available" }));
  }
  const result = asRecord(summary.result);
  if (summary.result === null || Object.keys(result).length === 0) {
    return renderMarkdown(
      headline("Instance Scan findings", { status: "warn", detail: "no result" }),
      scalar(record.hint) === undefined ? undefined : text(scalar(record.hint))
    );
  }
  const totals = asRecord(summary.totals);
  const blocks: (MarkdownFragment | undefined)[] = [
    headline("Instance Scan findings", {
      status: "pass",
      detail: `${shown(result.number)} (${shown(result.state)}), ${shown(totals.findings)} findings in ${shown(totals.checks)} checks`,
    }),
  ];
  const byCheck = Array.isArray(summary.by_check) ? summary.by_check.map(asRecord) : [];
  blocks.push(
    table(
      ["Check", "Category", "Priority", "Findings", "Occurrences"],
      byCheck.map((entry) => [
        scalar(entry.name) ?? shown(entry.check),
        shown(entry.category),
        shown(entry.priority),
        shown(entry.findings),
        shown(entry.occurrences),
      ])
    )
  );
  const described = byCheck.filter((entry) => scalar(entry.short_description) !== undefined);
  if (described.length > 0) {
    blocks.push(
      untrustedBlock(
        "Check descriptions",
        described.map((entry) => `${scalar(entry.name) ?? shown(entry.check)}: ${shown(entry.short_description)}`).join("\n")
      )
    );
  }
  if (summary.by_check_truncated === true) blocks.push(text("Only the checks with the most findings are listed."));
  const rows = Array.isArray(record.results) ? record.results.map(asRecord) : [];
  blocks.push(
    untrustedBlock(
      "Findings (check | source table | source | count | muted)",
      rows
        .map(
          (row) =>
            `${scalar(row.check_name) ?? shown(row.check)} | ${shown(row.source_table)} | ${shown(row.source)} | ${shown(row.count)} | ${shown(row.muted)}`
        )
        .join("\n")
    )
  );
  if (record.has_more === true) blocks.push(text(`More rows: next_offset ${shown(record.next_offset)}.`));
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  if (warnings.length > 0) blocks.push(bulletList(warnings.map((warning) => String(scalar(warning) ?? ""))));
  return renderMarkdown(...blocks);
}
