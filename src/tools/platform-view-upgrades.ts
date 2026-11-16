/**
 * `sn_platform_view`, view `upgrade_skipped`: the skipped files of one upgrade
 * run, and what the run's own counters say.
 *
 * Reads, in this order, each in its own response scope and never cached:
 * 1. `sys_upgrade_history`: the run (a given sys_id, or the latest of its
 *    `kind`) and, for "latest", up to five other recent runs, in one read;
 * 2. `sys_upgrade_history_log`: the page of skipped files of that run, with
 *    dispositions in {4, 9, 10, 11, 104} only. A 403 here is not an error: the
 *    run summary is returned with `log: "denied"` and a fixed hint that names
 *    the `upgrade_admin` role;
 * 3. `sys_choice`: the labels of the dispositions. Its query is fixed, so it
 *    starts together with the log read, and its answer is used only when log
 *    rows come back. It cannot fail the call: without it, codes are `unknown(n)`.
 *
 * The run's counters are exactly `skipped`, `skipped_error`,
 * `skipped_manual_merge` and `skipped_apply_once`. `kind` is a heuristic: a
 * run whose `from_version` is empty or "n/a" is an app install, anything else
 * an upgrade, and the result says so.
 *
 * Never requested: `payload`, `payload_diff`, `comments`, `file_path`.
 * Every row passes the field access the module supplies (see
 * `PlatformViewFieldAccess`) before it is projected.
 *
 * Text: instance strings are bounded here and rendered by
 * `renderUpgradeSkippedText` through `markdown.ts` (escaped cells and an
 * `untrustedBlock`), never concatenated.
 *
 * @module tools/platform-view-upgrades
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { isServiceNowRequestCancellation, runWithServiceNowRequestSignal } from "../client.js";
import type { ServiceNowOperations } from "../client.js";
import { filterReadableRecord, resolveReadableFields } from "../field-policy.js";
import { uncachedOperations } from "../metadata-cache.js";
import { createToolError, trustedToolErrorDescriptor, type ToolErrorCategory } from "../tool-error.js";
import { ok } from "../utils.js";
import {
  type CanonicalPlatformViewArgs,
  type PlatformViewData,
  UPGRADE_KINDS,
} from "./platform-view-contracts.js";
import { bulletList, headline, renderMarkdown, table, text, untrustedBlock, type MarkdownFragment } from "./markdown.js";
import { envelopeCompatibilityResult } from "./result-envelope.js";
import type { ServiceNowToolHandlerServices } from "./tool-module.js";

// ---------------------------------------------------------------------------
// Field access: the plug-in point for the module's field policy
// ---------------------------------------------------------------------------

/**
 * What a view needs from field policy, supplied by the module per call:
 * - `canRead(table, field)`: whether the profile may read the field. A view
 *   asks for, filters on and orders by readable fields only, so an unreadable
 *   field is never an oracle.
 * - `filter(table, row)`: the row with only its readable fields. Every row an
 *   upstream read returns passes through it before it is projected.
 *
 * The module builds it from the call's prepared field arguments
 * (`preparedReadableFields` and `filterReadableRecord`) and passes it as the
 * handler's third argument. Without it a handler falls back to
 * `liveFieldAccess`, which asks the field policy of the current scope.
 */
export interface PlatformViewFieldAccess {
  canRead(table: string, field: string): boolean;
  filter(table: string, row: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

/**
 * A view handler as the dispatcher's `PlatformViewHandler`, plus the module's
 * field access as an optional third argument. Assignable to `PlatformViewHandler`.
 */
export type FieldAccessHandler = (
  args: CanonicalPlatformViewArgs,
  services: ServiceNowToolHandlerServices,
  fieldAccess?: PlatformViewFieldAccess
) => Promise<CallToolResult>;

/** The current scope's field policy, for a handler the module has not given an access. */
export const liveFieldAccess: PlatformViewFieldAccess = Object.freeze({
  canRead(table: string, field: string): boolean {
    try {
      resolveReadableFields(table, { fields: field });
      return true;
    } catch {
      return false;
    }
  },
  filter(table: string, row: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const keys = Object.keys(row).filter((key) => liveFieldAccess.canRead(table, key));
    if (keys.length === 0) return {};
    const kept = filterReadableRecord(row, resolveReadableFields(table, { fields: keys.join(",") }));
    return typeof kept === "object" && kept !== null && !Array.isArray(kept) ? (kept as Record<string, unknown>) : {};
  },
});

/** A per-call memo of `canRead`: a view asks about the same field many times. */
export function memoizedFieldAccess(access: PlatformViewFieldAccess): PlatformViewFieldAccess {
  const seen = new Map<string, boolean>();
  return {
    canRead(table, field) {
      const key = `${table}\u0000${field}`;
      let known = seen.get(key);
      if (known === undefined) {
        known = access.canRead(table, field);
        seen.set(key, known);
      }
      return known;
    },
    filter: (table, row) => access.filter(table, row),
  };
}

/**
 * One upstream row, as the view may show it: it passes the module's `filter`,
 * then only the fields the view asked for stay, so a field the instance
 * returned unasked (or the policy hid after the request) never reaches a
 * projection.
 */
export function readableRow(
  access: PlatformViewFieldAccess,
  table: string,
  row: Readonly<Record<string, unknown>>,
  asked: readonly string[]
): Record<string, unknown> {
  const filtered = access.filter(table, row);
  return Object.fromEntries(Object.entries(filtered).filter(([key]) => asked.includes(key)));
}

/** The fields of `candidates` the profile may read on `table`, in order. */
export function readableOf(access: PlatformViewFieldAccess, table: string, candidates: readonly string[]): string[] {
  return candidates.filter((field) => access.canRead(table, field));
}

// ---------------------------------------------------------------------------
// Shared read helpers (also used by the scan view)
// ---------------------------------------------------------------------------

export const TABLE_PATH = "/api/now/table/";
export const STATS_PATH = "/api/now/stats/";
export const SYS_ID = /^[0-9a-f]{32}$/u;

/** Rows of a Table API response, or none. */
export function rowsOf(response: unknown): Record<string, unknown>[] {
  const result = (response as { result?: unknown } | null | undefined)?.result;
  return Array.isArray(result)
    ? result.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
}

/** A field value as text: a string, or the `value` of a `{value, display_value}` pair. */
export function scalar(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (depth < 2 && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return scalar((value as { value?: unknown }).value, depth + 1);
  }
  return undefined;
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

/** Instance text: control characters replaced, trimmed, cut at `max` without splitting a surrogate pair. */
export function cleanText(value: unknown, max: number): string | undefined {
  const raw = scalar(value);
  if (raw === undefined) return undefined;
  const flat = raw.replace(CONTROL_CHARACTERS, " ").trim();
  if (flat === "") return undefined;
  if (flat.length <= max) return flat;
  let end = max - 1;
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${flat.slice(0, end)}…`;
}

/** A whole number from a string field, or undefined. */
export function wholeNumber(value: unknown): number | undefined {
  const raw = scalar(value)?.trim();
  return raw !== undefined && /^-?\d{1,9}$/u.test(raw) ? Number(raw) : undefined;
}

/** A boolean field. */
export function flag(value: unknown): boolean | undefined {
  const raw = scalar(value)?.trim().toLowerCase();
  return raw === "true" ? true : raw === "false" ? false : undefined;
}

/** The category of an issued tool error, or undefined for anything else. */
export function errorCategory(error: unknown): ToolErrorCategory | undefined {
  return trustedToolErrorDescriptor(error)?.category;
}

/**
 * What the Table API returns (HTTP 400) for a table that does not exist: an
 * issued `upstream` error with no retry and no reason. An error with a reason
 * (an HTML page, a redirect, a hibernating instance) is a bad response, not a
 * missing table.
 */
export function isMissingTable(error: unknown): boolean {
  const descriptor = trustedToolErrorDescriptor(error);
  return descriptor?.category === "upstream" && descriptor.retry === "do_not_retry" && descriptor.reason === undefined;
}

/**
 * Run `operation` in a fresh response scope bound to the call's signal, so one
 * read's bytes do not count against the next one's 1 MiB allowance. Without a
 * signal (a handler called directly) it runs in the caller's scope.
 */
export function inOwnScope<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  return signal instanceof AbortSignal ? runWithServiceNowRequestSignal(signal, operation) : operation();
}

/** Parameters of one Table API list read. Raw values only: no display values, no links. */
export function listParams(options: {
  readonly fields: readonly string[];
  readonly query: string;
  readonly limit: number;
  readonly offset?: number;
}): Record<string, string> {
  // An empty `sysparm_fields` means every field, including the ones a view never reads.
  if (options.fields.length === 0) throw createToolError("internal", "do_not_retry");
  return {
    sysparm_query: options.query,
    sysparm_fields: options.fields.join(","),
    sysparm_display_value: "false",
    sysparm_exclude_reference_link: "true",
    sysparm_limit: String(options.limit),
    ...(options.offset !== undefined && options.offset > 0 ? { sysparm_offset: String(options.offset) } : {}),
  };
}

/** The first table in `table` that has none of `required` readable, as a field name; undefined when all are. */
export function firstUnreadable(
  access: PlatformViewFieldAccess,
  table: string,
  required: readonly string[]
): string | undefined {
  return required.find((field) => !access.canRead(table, field));
}

export const FIELD_POLICY_HINT = "Field policy hides a field this view needs.";

/** The result of a view. The envelope adds counts, paging and limits. */
export function viewResult(args: CanonicalPlatformViewArgs, data: PlatformViewData): CallToolResult {
  return envelopeCompatibilityResult("sn_platform_view" as never, args as unknown as Record<string, unknown>, ok(data));
}

/** One page of rows read with one look-ahead row: the page, and whether more exist. */
export function pageOf<T>(rows: readonly T[], limit: number): { readonly page: T[]; readonly hasMore: boolean } {
  return { page: rows.slice(0, limit), hasMore: rows.length > limit };
}

// ---------------------------------------------------------------------------
// upgrade_skipped
// ---------------------------------------------------------------------------

/** Dispositions of `sys_upgrade_history_log` that mean a file was skipped. */
export const SKIPPED_DISPOSITIONS = Object.freeze([4, 9, 10, 11, 104] as const);

/** The four run counters, and no other `skipped*` field. */
export const RUN_COUNTER_FIELDS = Object.freeze([
  "skipped",
  "skipped_error",
  "skipped_manual_merge",
  "skipped_apply_once",
] as const);

export const RUN_FIELDS = Object.freeze([
  "sys_id",
  "from_version",
  "to_version",
  "state",
  "upgrade_started",
  "upgrade_finished",
  "sys_created_on",
  ...RUN_COUNTER_FIELDS,
]);
const RUN_REQUIRED = Object.freeze(["sys_id", "from_version", "to_version"]);

/** Never `payload`, `payload_diff`, `comments` or `file_path`. */
export const UPGRADE_LOG_FIELDS = Object.freeze([
  "sys_id",
  "file_name",
  "type",
  "target_name",
  "disposition",
  "resolution_status",
  "change_type",
  "plugin",
]);
/** `upgrade_history` is filtered on, not requested. */
const LOG_REQUIRED = Object.freeze(["sys_id", "disposition", "upgrade_history"]);
const CHOICE_FIELDS = Object.freeze(["value", "label", "language"]);

/**
 * Every field this view may request or filter on, by table: what the module
 * prepares in `resolveAccess` (intersected with what the profile may read; a
 * field that is not readable is left out, never an error).
 */
export const UPGRADE_SKIPPED_FIELD_PLAN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sys_upgrade_history: RUN_FIELDS,
  sys_upgrade_history_log: [...UPGRADE_LOG_FIELDS, "upgrade_history"],
  sys_choice: CHOICE_FIELDS,
});

const OTHER_RUNS = 5;
const MAX_VERSION_CHARS = 60;
const MAX_FILE_CHARS = 255;
const MAX_NAME_CHARS = 250;
const MAX_SHORT_CHARS = 80;

export const UPGRADE_LOG_DENIED_HINT = "Reading the upgrade log needs the `upgrade_admin` role.";
export const UPGRADE_HISTORY_DENIED_HINT = "Reading the upgrade history was denied for this account.";
export const KIND_BASIS =
  "Heuristic: a run whose from_version is empty or n/a is an app install; any other run is an upgrade.";

export type UpgradeKind = Exclude<(typeof UPGRADE_KINDS)[number], "all">;

/** A run's `kind`: an app install has no `from_version` (empty or "n/a"). */
export function upgradeKindOf(fromVersion: string | undefined): UpgradeKind {
  const from = fromVersion?.trim().toLowerCase() ?? "";
  return from === "" || from === "n/a" ? "app_install" : "upgrade";
}

/** The label of a disposition, from the choice list; `unknown(n)` when the list has none. */
export function dispositionLabel(value: number, labels: ReadonlyMap<number, string>): string {
  return labels.get(value) ?? `unknown(${value})`;
}

function runQuery(args: CanonicalPlatformViewArgs): { query: string; latest: boolean } {
  const upgrade = args.upgrade;
  if (upgrade !== undefined && upgrade !== "latest") return { query: `sys_id=${upgrade}`, latest: false };
  const kind = args.kind ?? "upgrade";
  const order = "ORDERBYDESCsys_created_on";
  if (kind === "upgrade") return { query: `from_versionISNOTEMPTY^from_version!=n/a^${order}`, latest: true };
  if (kind === "app_install") return { query: `from_versionISEMPTY^ORfrom_version=n/a^${order}`, latest: true };
  return { query: order, latest: true };
}

interface RunSummary {
  readonly sys_id: string;
  readonly from_version?: string;
  readonly to_version?: string;
  readonly kind: UpgradeKind;
  readonly state?: string;
  readonly started?: string;
  readonly finished?: string;
  readonly counters?: Record<string, number | null>;
}

function projectRun(row: Readonly<Record<string, unknown>>, withCounters: boolean): RunSummary | undefined {
  const id = scalar(row.sys_id)?.trim().toLowerCase();
  if (id === undefined || !SYS_ID.test(id)) return undefined;
  const from = cleanText(row.from_version, MAX_VERSION_CHARS);
  const to = cleanText(row.to_version, MAX_VERSION_CHARS);
  const state = cleanText(row.state, 40);
  const started = cleanText(row.upgrade_started ?? row.sys_created_on, 40);
  const finished = cleanText(row.upgrade_finished, 40);
  return {
    sys_id: id,
    ...(from === undefined ? {} : { from_version: from }),
    ...(to === undefined ? {} : { to_version: to }),
    kind: upgradeKindOf(from),
    ...(state === undefined ? {} : { state }),
    ...(started === undefined ? {} : { started }),
    ...(finished === undefined ? {} : { finished }),
    ...(withCounters
      ? { counters: Object.fromEntries(RUN_COUNTER_FIELDS.map((name) => [name, wholeNumber(row[name]) ?? null])) }
      : {}),
  };
}

/** Choice labels by disposition value; the English row wins, then the first. */
function choiceLabels(rows: readonly Record<string, unknown>[]): Map<number, string> {
  const best = new Map<number, { label: string; english: boolean }>();
  for (const row of rows) {
    const value = wholeNumber(row.value);
    const label = cleanText(row.label, 80);
    if (value === undefined || label === undefined) continue;
    const language = scalar(row.language)?.trim().toLowerCase();
    const english = language === undefined || language === "" || language === "en";
    const known = best.get(value);
    if (known === undefined || (english && !known.english)) best.set(value, { label, english });
  }
  return new Map([...best].map(([value, entry]) => [value, entry.label]));
}

/**
 * Build the `view: "upgrade_skipped"` handler. `handleUpgradeSkipped` is the
 * one the module registers; a test builds its own with a fixed field access.
 */
export function createUpgradeSkippedHandler(
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

    // A disposition outside the skipped set is a different view's question.
    if (args.disposition !== undefined && !(SKIPPED_DISPOSITIONS as readonly number[]).includes(args.disposition)) {
      throw createToolError("conflict", "retry_after_correction");
    }

    // Every field the view filters or sorts on must be readable, or the query
    // would tell a profile something about a field it cannot see. "Latest"
    // sorts on `sys_created_on`; a named run does not.
    const sortsRuns = args.upgrade === undefined || args.upgrade === "latest";
    const hidden =
      firstUnreadable(access, "sys_upgrade_history", [...RUN_REQUIRED, ...(sortsRuns ? ["sys_created_on"] : [])]) ??
      firstUnreadable(access, "sys_upgrade_history_log", [...LOG_REQUIRED, ...(args.type === undefined ? [] : ["type"])]);
    if (hidden !== undefined) {
      return viewResult(args, { view: "upgrade_skipped", status: "denied", hint: FIELD_POLICY_HINT });
    }

    // 1. The run, and the recent others.
    const { query, latest } = runQuery(args);
    const runFields = readableOf(access, "sys_upgrade_history", RUN_FIELDS);
    let runRows: Record<string, unknown>[];
    try {
      runRows = rowsOf(
        await inOwnScope(signal, () =>
          ops.get(`${TABLE_PATH}sys_upgrade_history`, listParams({ fields: runFields, query, limit: latest ? OTHER_RUNS + 1 : 1 }))
        )
      );
    } catch (error) {
      if (errorCategory(error) === "authorization") {
        return viewResult(args, { view: "upgrade_skipped", status: "denied", hint: UPGRADE_HISTORY_DENIED_HINT });
      }
      throw error;
    }
    const filtered = runRows.map((row) => readableRow(access, "sys_upgrade_history", row, runFields));
    const first = filtered[0] === undefined ? undefined : projectRun(filtered[0], true);
    const wanted = latest ? undefined : args.kind;
    const run = first !== undefined && (wanted === undefined || first.kind === wanted) ? first : undefined;
    if (run === undefined) {
      const kind = args.kind ?? "upgrade";
      return viewResult(args, {
        view: "upgrade_skipped",
        status: "ok",
        summary: { run: null, kind_basis: KIND_BASIS },
        results: [],
        hint:
          latest && kind !== "all"
            ? `No ${kind === "upgrade" ? "upgrade" : "app install"} run was found. Try kind: all, or pass upgrade: <sys_id>.`
            : "No upgrade run matches the given sys_id.",
      });
    }
    const others = latest
      ? filtered
          .slice(1)
          .map((row) => projectRun(row, false))
          .filter((other): other is RunSummary => other !== undefined)
      : [];

    // 2. The skipped files of that run.
    const warnings: string[] = [];
    const readable = readableOf(access, "sys_upgrade_history_log", UPGRADE_LOG_FIELDS);
    const dispositionClause =
      args.disposition === undefined ? `dispositionIN${SKIPPED_DISPOSITIONS.join(",")}` : `disposition=${args.disposition}`;
    const typeClause = args.type === undefined ? "" : `^type=${args.type}`;
    const orderClause = access.canRead("sys_upgrade_history_log", "file_name") ? "^ORDERBYfile_name^ORDERBYsys_id" : "^ORDERBYsys_id";
    const logQuery = `upgrade_history=${run.sys_id}^${dispositionClause}${typeClause}${orderClause}`;

    // The label read has a fixed query, so it starts with the log read and is
    // used only if log rows come back (a wasted read of about 1 KB when the
    // log is empty or denied). It settles into a value either way: a failure
    // is held until the rows are known and is never an unhandled rejection.
    const choiceFields = readableOf(access, "sys_choice", CHOICE_FIELDS);
    const choiceReadable = choiceFields.includes("value") && choiceFields.includes("label");
    const choices: Promise<{ rows: Record<string, unknown>[] } | { error: unknown }> = choiceReadable
      ? inOwnScope(signal, () =>
          ops.get(
            `${TABLE_PATH}sys_choice`,
            listParams({
              fields: choiceFields,
              query: `name=sys_upgrade_history_log^element=disposition^valueIN${SKIPPED_DISPOSITIONS.join(",")}`,
              limit: 100,
            })
          )
        ).then(
          (response) => ({ rows: rowsOf(response) }),
          (error: unknown) => ({ error })
        )
      : Promise.resolve({ rows: [] });

    let logRows: Record<string, unknown>[] | undefined;
    try {
      logRows = rowsOf(
        await inOwnScope(signal, () =>
          ops.get(
            `${TABLE_PATH}sys_upgrade_history_log`,
            listParams({ fields: readable, query: logQuery, limit: args.limit + 1, offset: args.offset })
          )
        )
      );
    } catch (error) {
      await choices;
      if (errorCategory(error) !== "authorization") throw error;
    }

    if (logRows === undefined) {
      return viewResult(args, {
        view: "upgrade_skipped",
        status: "ok",
        summary: { run, ...(others.length > 0 ? { other_runs: others } : {}), kind_basis: KIND_BASIS, log: "denied" },
        hint: UPGRADE_LOG_DENIED_HINT,
      });
    }

    // 3. Labels, only when there is something to label. A label read that
    // failed for any reason but the call's own cancellation costs the labels,
    // not the call.
    let labels = new Map<number, string>();
    const settled = await choices;
    if (logRows.length > 0) {
      if ("error" in settled) {
        if (signal?.aborted === true || isServiceNowRequestCancellation(settled.error)) throw settled.error;
        warnings.push("Disposition labels were not readable; codes are shown as unknown(n).");
      } else if (!choiceReadable) {
        warnings.push("Disposition labels were not readable; codes are shown as unknown(n).");
      } else {
        labels = choiceLabels(settled.rows.map((row) => readableRow(access, "sys_choice", row, choiceFields)));
      }
    }

    const { page, hasMore } = pageOf(logRows, args.limit);
    let ignored = 0;
    const results: Record<string, unknown>[] = [];
    for (const raw of page) {
      const row = readableRow(access, "sys_upgrade_history_log", raw, readable);
      const disposition = wholeNumber(row.disposition);
      if (disposition === undefined || !(SKIPPED_DISPOSITIONS as readonly number[]).includes(disposition)) {
        ignored += 1;
        continue;
      }
      const entry: Record<string, unknown> = {
        ...optionalText("sys_id", row.sys_id, 32),
        ...optionalText("file_name", row.file_name, MAX_FILE_CHARS),
        ...optionalText("type", row.type, 40),
        ...optionalText("target_name", row.target_name, MAX_NAME_CHARS),
        disposition,
        disposition_label: dispositionLabel(disposition, labels),
        ...optionalText("resolution_status", row.resolution_status, MAX_SHORT_CHARS),
        ...optionalText("change_type", row.change_type, MAX_SHORT_CHARS),
        ...optionalText("plugin", row.plugin, 255),
      };
      results.push(entry);
    }
    if (ignored > 0) warnings.push(`${ignored} row(s) outside the skipped dispositions were ignored.`);

    return viewResult(args, {
      view: "upgrade_skipped",
      status: "ok",
      summary: {
        run,
        ...(others.length > 0 ? { other_runs: others } : {}),
        kind_basis: KIND_BASIS,
        log: "read",
      },
      results,
      record_count: results.length,
      has_more: hasMore,
      ...(hasMore ? { next_offset: args.offset + page.length } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  };
}

function optionalText(key: string, value: unknown, max: number): Record<string, string> {
  const clean = cleanText(value, max);
  return clean === undefined ? {} : { [key]: clean };
}

/** The handler the dispatcher registers. */
export const handleUpgradeSkipped: FieldAccessHandler = createUpgradeSkippedHandler();

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function shown(value: unknown): string {
  return scalar(value) ?? "-";
}

/**
 * The readable text of an `upgrade_skipped` result. `data` is the envelope's
 * `data`; every value in it is instance text, so it reaches the output only as
 * an escaped table cell, escaped inline text or inside an `untrustedBlock`.
 */
export function renderUpgradeSkippedText(data: unknown): string | undefined {
  const record = asRecord(data);
  if (record.view !== "upgrade_skipped") return undefined;
  const summary = asRecord(record.summary);
  const run = asRecord(summary.run);
  const status = scalar(record.status);
  const blocks: (MarkdownFragment | undefined)[] = [];
  if (status !== "ok") {
    blocks.push(headline("Upgrade history", { status: "fail", detail: scalar(record.hint) ?? "not available" }));
    return renderMarkdown(...blocks);
  }
  if (summary.run === null || Object.keys(run).length === 0) {
    return renderMarkdown(
      headline("Skipped upgrade files", { status: "warn", detail: "no run" }),
      scalar(record.hint) === undefined ? undefined : text(scalar(record.hint))
    );
  }
  const counters = asRecord(run.counters);
  blocks.push(
    headline("Skipped upgrade files", {
      status: summary.log === "denied" ? "warn" : "pass",
      detail: `${shown(run.from_version)} to ${shown(run.to_version)} (${shown(run.kind)})`,
    }),
    table(
      ["Counter", "Files"],
      Object.keys(counters).map((name) => [name, shown(counters[name])])
    ),
    text(summary.kind_basis === undefined ? "" : String(scalar(summary.kind_basis) ?? ""))
  );
  const others = Array.isArray(summary.other_runs) ? summary.other_runs : [];
  if (others.length > 0) {
    blocks.push(
      bulletList(
        others.map((entry) => {
          const other = asRecord(entry);
          return `${shown(other.sys_id)}: ${shown(other.from_version)} to ${shown(other.to_version)} (${shown(other.kind)})`;
        })
      )
    );
  }
  if (summary.log === "denied") {
    blocks.push(text(scalar(record.hint) ?? UPGRADE_LOG_DENIED_HINT));
    return renderMarkdown(...blocks);
  }
  const rows = Array.isArray(record.results) ? record.results : [];
  const lines = rows.map((entry) => {
    const row = asRecord(entry);
    return (
      `${shown(row.disposition_label)} | ${shown(row.type)} | ${shown(row.file_name)}` +
      ` | ${shown(row.target_name)} | ${shown(row.resolution_status)} | ${shown(row.change_type)} | ${shown(row.plugin)}`
    );
  });
  blocks.push(untrustedBlock("Skipped files (disposition | type | file | target | resolution | change | plugin)", lines.join("\n")));
  if (record.has_more === true) blocks.push(text(`More rows: next_offset ${shown(record.next_offset)}.`));
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  if (warnings.length > 0) blocks.push(bulletList(warnings.map((warning) => String(scalar(warning) ?? ""))));
  return renderMarkdown(...blocks);
}
