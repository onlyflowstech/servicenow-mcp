/**
 * `sn_platform_view`, view `evaluate`: runs the update set evaluator
 * (`update-set-eval/engine.ts`) over a scope the view reads itself, inside the
 * view's access plan.
 *
 * Scope, from exactly one selector:
 * - `update_set` (sys_id or exact name): a local set, with its descendants
 *   unless `include_children: false`;
 * - `batch_root` (sys_id): a local batch, the root and every descendant;
 * - `remote_update_set` (sys_id): a retrieved set's rows, with its descendant
 *   remote sets unless `include_children: false`. This is the input a commit
 *   plan evaluates: what will actually be committed.
 *
 * Reads, each group in its own 1 MiB response scope, at most
 * {@link EVALUATE_LIMITS}.MAX_SCOPES (12) scopes per call:
 * 1. resolve: the set (`sys_update_set` or `sys_remote_update_set`), its
 *    descendants one level per read through `parent` (depth and count
 *    capped, cycle-safe; a level too large for the scope stops the descent
 *    and makes the result partial), one Aggregate API count of its rows per
 *    set, and one read of the sys_ids that have a description (set reads
 *    never ask for the description itself);
 * 2. rows: `sys_update_xml` pages with `payload`, keyed on `sys_id`, one
 *    scope per page. The first page is 10 rows; later pages grow (at least
 *    doubling, up to 50) while the measured payloads fit. A page too large
 *    for its scope is read again at half the size, and that size becomes a
 *    ceiling. A single row too large for a scope is read without its
 *    payload and counts as not scanned. Rows stop at `max_updates`
 *    (effectively 400 when not given) or when only the scopes the next steps
 *    need are left;
 * 3. context, one scope: the tables the rows write to, from `sys_db_object`
 *    one level per read (the parent's name is a declared one-hop dot-walk),
 *    and the hidden-typed fields from one `sys_dictionary` read. These feed
 *    the shared credential-table list and type helper, so the type read stays
 *    inside this view's plan (`fieldTypesFromRows`). A table whose hierarchy
 *    is not known in full is treated as a possible credential table: its
 *    rows are not scanned, and the result is partial. When the `bp` group
 *    runs, the update versions of the rows' names (BP005, at most 500 names)
 *    are counted in this scope too;
 * 4. when the `bp` group runs, one more scope: the preview problems of a
 *    remote scope, or, for a local scope, the same update names in other
 *    open sets (BP004).
 *
 * Update names go into a `nameIN` list only when they are plain names with
 * no script prefix ({@link isListableName}); any other name is not checked,
 * and is counted.
 *
 * Payload: only `sys_update_xml.payload` is read, always by name in an
 * explicit field list, and only when field policy allows that field.
 * `sys_update_version` (which also carries payloads) is counted through the
 * Aggregate API, never read as rows. A row on a credential table, or on a
 * table that extends one, is never scanned: the engine keeps its metadata and
 * reports SEC010.
 *
 * A fact that could not be read, in full or in part, is counted in
 * `coverage.checks_unavailable` and makes the result `partial`; it never
 * reads as clean. A payload that field policy hides runs the metadata rules
 * only (`metadata_only`).
 *
 * Text: the engine's messages are fixed sentences and its findings carry no
 * payload text. Row and set names, target names, types and SEC011's table are
 * instance text: they are bounded here and rendered by
 * {@link renderEvaluateText} inside an `untrustedBlock`, never as markdown.
 * Every warning and hint is a fixed sentence. A throw from the engine is
 * replaced by a fixed internal error.
 *
 * @module tools/platform-view-evaluate
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { isServiceNowRequestCancellation, isServiceNowResponseTooLarge, type ServiceNowOperations } from "../client.js";
import { isCredentialTable, isCredentialTableHierarchy } from "../credential-tables.js";
import { PLAN_FIELD_TYPE_FIELDS, hiddenTypedFields, loadFieldTypesInPlan, type PlanFieldTypes } from "../hidden-values.js";
import { uncachedOperations } from "../metadata-cache.js";
import { createToolError } from "../tool-error.js";
import { escapeQueryValue } from "../utils.js";
import { ENGINE_LIMITS, YIELD_AFTER_MS, evaluateUpdateSets, type EngineHooks } from "../update-set-eval/engine.js";
import type {
  EngineLimits,
  EvaluateContext,
  EvaluateSet,
  EvaluateUpdate,
  EvaluationInput,
  EvaluationResult,
  Finding,
  PreviewProblem,
} from "../update-set-eval/types.js";
import { FlowViewScopeBudget } from "./flow-view-module.js";
import { bulletList, headline, renderMarkdown, table, text, untrustedBlock, type MarkdownFragment } from "./markdown.js";
import type { CanonicalPlatformViewArgs } from "./platform-view-contracts.js";
import {
  FIELD_POLICY_HINT,
  STATS_PATH,
  SYS_ID,
  TABLE_PATH,
  asRecord,
  cleanText,
  errorCategory,
  firstUnreadable,
  flag,
  inOwnScope,
  isMissingTable,
  listParams,
  liveFieldAccess,
  memoizedFieldAccess,
  readableOf,
  readableRow,
  rowsOf,
  scalar,
  viewResult,
  wholeNumber,
  type FieldAccessHandler,
  type PlatformViewFieldAccess,
} from "./platform-view-upgrades.js";
import type { ServiceNowToolHandlerServices } from "./tool-module.js";

// ---------------------------------------------------------------------------
// Limits and fixed text
// ---------------------------------------------------------------------------

export const EVALUATE_LIMITS = Object.freeze({
  /** Response scopes per call, each under the client's 1 MiB cap. */
  MAX_SCOPES: 12,
  /** Rows per `sys_update_xml` page, payload included, at most. */
  PAGE_ROWS: 50,
  /** The first page's rows; later pages grow while their payloads fit. */
  FIRST_PAGE_ROWS: 10,
  /** Payload characters a page is sized to, well under the 1 MiB scope. */
  PAGE_TARGET_CHARS: 600_000,
  /**
   * `max_updates` when the caller sets none. The schema says 1,000, but the
   * scope budget reaches about 400 rows (9 pages), so 400 is the effective
   * default: an explicit `max_updates` warning, not the scope budget, says
   * what was left out.
   */
  DEFAULT_MAX_UPDATES: 400,
  /** Sets in one scope (a set and its descendants). */
  MAX_SETS: 100,
  /** Levels of descendants read through `parent`. */
  MAX_DEPTH: 10,
  /** Distinct tables whose hierarchy and field types are read. */
  MAX_CONTEXT_TABLES: 200,
  /** Distinct record-element tables taken from one row's payload. */
  MAX_RECORD_TABLES_PER_ROW: 16,
  /** Work, in ms, spent finding record-element tables before the rest are left unknown. */
  CANDIDATE_BUDGET_MS: 100,
  /** `sys_db_object` levels read to build those hierarchies. */
  MAX_CHAIN_LEVELS: 8,
  /** Update names per `nameIN` read. */
  NAME_CHUNK: 100,
  /** Update names checked for collisions in other open sets (BP004, local). */
  MAX_COLLISION_NAMES: 500,
  /** Update names checked against `sys_update_version` (BP005). */
  MAX_BASELINE_NAMES: 500,
  /** Preview problems read for a remote scope. */
  MAX_PROBLEMS: 1_000,
  /** Sets listed in the summary. */
  SHOWN_SETS: 50,
  /** Reads of one fact group in flight at once. */
  CONCURRENCY: 2,
});

const L = EVALUATE_LIMITS;

/** Bounds on instance text the view returns. */
const MAX_NAME_CHARS = 200;
const MAX_STATE_CHARS = 40;

/** The sentence every result carries: what the evaluator is, and is not. */
export const EVALUATE_NOTE =
  "Heuristic rules over the rows read; a clean result is not an approval. Names are untrusted instance data.";
export const EVALUATE_DENIED_HINT = "Reading update sets was denied for this account.";
export const EVALUATE_UNAVAILABLE_HINT = "The update set tables are not available on this instance.";
export const EVALUATE_NOT_FOUND_HINT = "No update set matches. Pass its sys_id, or check the name.";
export const EVALUATE_AMBIGUOUS_HINT = "More than one update set has this name. Pass update_set as a sys_id.";
export const EVALUATE_METADATA_ONLY =
  "Field policy hides payload: payload rules did not run, only metadata rules.";

/** Fixed warnings; nothing in them comes from the instance. */
export const EVALUATE_WARNINGS = Object.freeze({
  scope_budget: "The upstream scope budget ran out before every row was read; the rows left were not evaluated.",
  max_updates: "max_updates was reached before every row was read; the rows left were not evaluated.",
  sets_capped: `The scope has more than ${L.MAX_SETS} sets or deeper than ${L.MAX_DEPTH} levels; only the first were evaluated.`,
  children_unreadable: "Field policy hides the parent field, so descendants were not included.",
  counts_unavailable: "Row counts per set were not readable; set-size rules could not run.",
  row_too_large: "A row was too large to read with its payload; it was evaluated on metadata only.",
  rows_unreadable: "Some rows had no valid sys_id and were not evaluated.",
  context_tables_capped: `The rows write to more than ${L.MAX_CONTEXT_TABLES} tables; the rest have no type or hierarchy facts.`,
  hierarchy_unavailable: "Table hierarchies could not be read in full; some table checks were not made.",
  field_types_unavailable: "Field types could not be read; password-typed field checks were not made.",
  problems_unavailable: "Preview problems could not be read; the commit-blocking check was not made.",
  problems_capped: `More than ${L.MAX_PROBLEMS} preview problems; the commit-blocking check is incomplete.`,
  collisions_unavailable: "Other open update sets could not be checked in full for the same updates.",
  baseline_unavailable: "Update versions could not be read in full; the baseline-record check is incomplete.",
  descriptions_unavailable: "Set descriptions could not be checked; the missing-description check was not made.",
  names_unlistable: "Some update names cannot be used in a query; their collision and baseline checks were not made.",
  context_tables_budget: "Finding the tables nested in payloads ran out of time; rows with unknown nested tables were not scanned.",
});

export type EvaluateWarning = keyof typeof EVALUATE_WARNINGS;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const LOCAL_SET_FIELDS = Object.freeze([
  "sys_id", "name", "state", "is_default", "application", "parent", "description",
]);
const REMOTE_SET_FIELDS = Object.freeze(["sys_id", "name", "state", "parent", "description"]);
/**
 * Set reads never ask for `description`: it can be long, and a batch of long
 * ones would fill the resolve scope. Whether a set has one is a separate read
 * of sys_ids only (`descriptionISNOTEMPTY`).
 */
const withoutDescription = (fields: readonly string[]) => fields.filter((field) => field !== "description");
/** Never `payload_diff`. `payload` is added only when field policy allows it. */
const ROW_FIELDS = Object.freeze([
  "sys_id", "name", "type", "target_name", "action", "table", "application", "replace_on_upgrade",
]);
const PROBLEM_FIELDS = Object.freeze(["sys_id", "remote_update", "status", "type"]);
const DICTIONARY_FIELDS = PLAN_FIELD_TYPE_FIELDS.sys_dictionary;

/**
 * Every field this view may request or filter on, by table, for the module's
 * field-policy preparation. `super_class` and `update_set` are also the heads
 * of the view's two dot-walks, both into tables of its own plan.
 */
export const EVALUATE_FIELD_PLAN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sys_update_set: [...LOCAL_SET_FIELDS],
  sys_remote_update_set: [...REMOTE_SET_FIELDS],
  sys_update_xml: [...ROW_FIELDS, "payload", "update_set", "remote_update_set"],
  sys_update_preview_problem: [...PROBLEM_FIELDS, "remote_update_set"],
  sys_update_version: ["name", "source_table"],
  sys_db_object: ["name", "super_class"],
  sys_dictionary: [...DICTIONARY_FIELDS],
});

/** The dot-walks this view makes; each target is in its plan. */
export const EVALUATE_DOT_WALKS = Object.freeze([
  Object.freeze({ from: "sys_db_object", field: "super_class", target: "sys_db_object" }),
  Object.freeze({ from: "sys_update_xml", field: "update_set", target: "sys_update_set" }),
]);

/** Version sources that are the customer's own changes; any other named source is a baseline. */
const CUSTOMER_VERSION_SOURCES: ReadonlySet<string> = new Set(["sys_update_set", "sys_remote_update_set"]);

const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
/** `<table>_<sys_id>`, the usual update name. */
const UPDATE_NAME_TABLE = /^([a-z][a-z0-9_]{0,79})_[0-9a-f]{32}$/u;
/** An update name that is safe in a `nameIN` list: no comma, no query syntax. */
const LISTABLE_NAME = /^[A-Za-z0-9_.:-]{1,200}$/u;
/**
 * A script prefix ServiceNow evaluates in a query value, in any case and with
 * any spacing before the colon. Update names are instance text (from another
 * instance, for a retrieved set), so a name holding it is never listed.
 */
const SCRIPT_PREFIX = /javascript\s*:/iu;
/** The payload's declared table, read from its first bytes only. */
const ROOT_TABLE = /<record_update\b[^>]{0,400}?\btable="([a-z][a-z0-9_]{0,79})"/u;
const ROOT_HEAD_CHARS = 1_024;
/** A record element: a table-named element with an `action` attribute. */
const RECORD_ELEMENT = /<([a-z][a-z0-9_]{0,79})\s+action="/gu;
/** The base table of all metadata, which extends nothing. */
const METADATA_ROOT = "sys_metadata";
/** The credential check's answer for a table whose hierarchy is not known. */
const UNKNOWN_TABLE = "unknown";

// ---------------------------------------------------------------------------
// Handler options
// ---------------------------------------------------------------------------

export interface EvaluateHandlerOptions {
  readonly fieldAccess?: PlatformViewFieldAccess;
  /** Engine limits; a test lowers the CPU budget here. Production uses `ENGINE_LIMITS`. */
  readonly limits?: Partial<EngineLimits>;
  readonly hooks?: EngineHooks;
  /** Response scopes per call; at most `EVALUATE_LIMITS.MAX_SCOPES`. */
  readonly maxScopes?: number;
}

type Source = "local" | "remote";

interface Selector {
  readonly source: Source;
  /** A sys_id, or a name for a local `update_set`. */
  readonly id?: string;
  readonly name?: string;
  readonly children: boolean;
}

interface Reader {
  readonly ops: ServiceNowOperations;
  /** Through the metadata cache: `sys_db_object` and `sys_dictionary` only. */
  readonly meta: ServiceNowOperations;
  readonly signal: AbortSignal | undefined;
  readonly scopes: FlowViewScopeBudget;
  /** The clock and yield the engine uses; a test injects them. */
  readonly hooks: EngineHooks;
}

/** Raised inside a step for a fixed `denied` or `unavailable` result. */
class ViewStop {
  constructor(readonly status: "denied" | "unavailable", readonly hint: string) {}
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || isServiceNowRequestCancellation(error);
}

function isTooLarge(error: unknown): boolean {
  return isServiceNowResponseTooLarge(error) || errorCategory(error) === "too_large";
}

/** Run `operation` in a new response scope, or return undefined when none is left. */
async function inScope<T>(reader: Reader, operation: () => Promise<T>): Promise<{ value: T } | undefined> {
  if (!reader.scopes.take()) return undefined;
  return { value: await inOwnScope(reader.signal, operation) };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** Map with at most `limit` calls in flight; results keep input order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const lowerId = (value: unknown): string | undefined => {
  const id = scalar(value)?.trim().toLowerCase();
  return id !== undefined && SYS_ID.test(id) ? id : undefined;
};

const textOrNull = (value: unknown): string | null => scalar(value) ?? null;

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

/** Exactly one of `update_set`, `batch_root` or `remote_update_set`. */
function selectorOf(args: CanonicalPlatformViewArgs): Selector {
  const given = [args.update_set, args.batch_root, args.remote_update_set].filter((value) => value !== undefined);
  if (given.length !== 1) throw createToolError("conflict", "retry_after_correction");
  if (args.batch_root !== undefined) {
    // A batch is the root with its descendants; leaving them out is a different question.
    if (args.include_children === false) throw createToolError("conflict", "retry_after_correction");
    return { source: "local", id: args.batch_root, children: true };
  }
  const children = args.include_children !== false;
  if (args.remote_update_set !== undefined) return { source: "remote", id: args.remote_update_set, children };
  const value = args.update_set!;
  return SYS_ID.test(value) ? { source: "local", id: value, children } : { source: "local", name: value, children };
}

// ---------------------------------------------------------------------------
// 1. Resolve the scope
// ---------------------------------------------------------------------------

interface ResolvedScope {
  readonly source: Source;
  readonly root: string;
  readonly sets: readonly EvaluateSet[];
  readonly setsCapped: boolean;
  readonly countsKnown: boolean;
  /** False when whether each set has a description could not be read. */
  readonly descriptionsKnown: boolean;
  readonly total: number;
}

type Resolution =
  | { readonly kind: "scope"; readonly scope: ResolvedScope }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly Record<string, unknown>[] };

function setTable(source: Source): string {
  return source === "local" ? "sys_update_set" : "sys_remote_update_set";
}

/** The `sys_update_xml` column that names a row's set. */
function rowSetField(source: Source): string {
  return source === "local" ? "update_set" : "remote_update_set";
}

function projectSet(
  source: Source,
  row: Readonly<Record<string, unknown>>,
  count: number,
  description: boolean | undefined
): EvaluateSet | undefined {
  const sysId = lowerId(row.sys_id);
  if (sysId === undefined) return undefined;
  return {
    sys_id: sysId,
    name: cleanText(row.name, MAX_NAME_CHARS) ?? "",
    state: cleanText(row.state, MAX_STATE_CHARS) ?? null,
    ...(source === "local" && flag(row.is_default) !== undefined ? { is_default: flag(row.is_default) } : {}),
    ...(description === undefined ? {} : { has_description: description }),
    application: source === "local" ? lowerId(row.application) ?? null : null,
    parent: lowerId(row.parent) ?? null,
    update_count: count,
  };
}

async function resolveScope(
  reader: Reader,
  access: PlatformViewFieldAccess,
  selector: Selector,
  warnings: Set<EvaluateWarning>
): Promise<Resolution> {
  const tableName = setTable(selector.source);
  const fields = withoutDescription(
    readableOf(access, tableName, selector.source === "local" ? LOCAL_SET_FIELDS : REMOTE_SET_FIELDS)
  );
  const descriptionReadable = access.canRead(tableName, "description");
  const required = ["sys_id", ...(selector.name !== undefined ? ["name"] : [])];
  if (firstUnreadable(access, tableName, required) !== undefined) throw new ViewStop("denied", FIELD_POLICY_HINT);
  const setField = rowSetField(selector.source);
  if (firstUnreadable(access, "sys_update_xml", ["sys_id", setField]) !== undefined) {
    throw new ViewStop("denied", FIELD_POLICY_HINT);
  }
  const children = selector.children && access.canRead(tableName, "parent");
  if (selector.children && !children) warnings.add("children_unreadable");

  const read = await inScope(reader, async () => {
    const path = `${TABLE_PATH}${tableName}`;
    const first = rowsOf(
      await reader.ops.get(
        path,
        listParams({
          fields,
          query: selector.id !== undefined ? `sys_id=${selector.id}` : `name=${selector.name}^ORDERBYsys_id`,
          limit: selector.id !== undefined ? 1 : 2,
        })
      )
    ).map((row) => readableRow(access, tableName, row, fields));
    if (first.length === 0) return { kind: "not_found" as const };
    if (first.length > 1) {
      return {
        kind: "ambiguous" as const,
        candidates: first.flatMap((row) => {
          const id = lowerId(row.sys_id);
          return id === undefined ? [] : [{ sys_id: id, state: cleanText(row.state, MAX_STATE_CHARS) ?? null }];
        }),
      };
    }
    const rootRow = first[0]!;
    const root = lowerId(rootRow.sys_id);
    if (root === undefined) return { kind: "not_found" as const };

    // Descendants, one level per read, cycle-safe and capped. The descent
    // stops at the first cap, and a level too large for the scope is a cap
    // too: the sets read so far are evaluated and the result is partial.
    const rows = new Map<string, Record<string, unknown>>([[root, rootRow]]);
    let capped = false;
    if (children) {
      let frontier = [root];
      for (let depth = 0; frontier.length > 0 && !capped; depth += 1) {
        if (depth >= L.MAX_DEPTH) {
          capped = true;
          break;
        }
        let level: Record<string, unknown>[];
        try {
          level = rowsOf(
            await reader.ops.get(
              path,
              listParams({
                fields,
                query: `parentIN${frontier.join(",")}^ORDERBYsys_id`,
                limit: L.MAX_SETS + 1,
              })
            )
          ).map((row) => readableRow(access, tableName, row, fields));
        } catch (error) {
          if (!isTooLarge(error)) throw error;
          capped = true;
          break;
        }
        const next: string[] = [];
        for (const row of level) {
          const id = lowerId(row.sys_id);
          if (id === undefined || rows.has(id)) continue;
          if (rows.size >= L.MAX_SETS) {
            capped = true;
            break;
          }
          rows.set(id, row);
          next.push(id);
        }
        frontier = next;
      }
    }

    // Row counts per set; an absent group is 0.
    const ids = [...rows.keys()];
    const counts = new Map<string, number>();
    let countsKnown = true;
    try {
      const stats = rowsOf(
        await reader.ops.get(`${STATS_PATH}sys_update_xml`, {
          sysparm_query: `${setField}IN${ids.join(",")}`,
          sysparm_group_by: setField,
          sysparm_count: "true",
        })
      );
      for (const group of stats) {
        const by = Array.isArray(group.groupby_fields) ? group.groupby_fields : [];
        const id = lowerId(asRecord(by.find((entry) => asRecord(entry).field === setField)).value);
        const count = wholeNumber(asRecord(group.stats).count);
        if (id !== undefined && count !== undefined && count >= 0) counts.set(id, count);
      }
    } catch (error) {
      if (isCancellation(error, reader.signal)) throw error;
      countsKnown = false;
    }
    // Which sets have a description: their sys_ids only, never the text.
    let described: Set<string> | undefined;
    let descriptionsKnown = false;
    if (descriptionReadable) {
      try {
        described = new Set(
          rowsOf(
            await reader.ops.get(
              path,
              listParams({ fields: ["sys_id"], query: `sys_idIN${ids.join(",")}^descriptionISNOTEMPTY`, limit: ids.length })
            )
          ).flatMap((row) => {
            const id = lowerId(readableRow(access, tableName, row, ["sys_id"]).sys_id);
            return id === undefined ? [] : [id];
          })
        );
        descriptionsKnown = true;
      } catch (error) {
        if (isCancellation(error, reader.signal)) throw error;
      }
    }
    const sets = ids.flatMap((id) => {
      const set = projectSet(
        selector.source,
        rows.get(id)!,
        countsKnown ? counts.get(id) ?? 0 : Number.NaN,
        described === undefined ? undefined : described.has(id)
      );
      return set === undefined ? [] : [set];
    });
    const total = countsKnown ? sets.reduce((sum, set) => sum + set.update_count, 0) : Number.NaN;
    return {
      kind: "scope" as const,
      scope: { source: selector.source, root, sets, setsCapped: capped, countsKnown, descriptionsKnown, total },
    };
  });
  // The first scope of a call always exists.
  if (read === undefined) throw createToolError("internal", "do_not_retry");
  if (read.value.kind === "scope") {
    if (read.value.scope.setsCapped) warnings.add("sets_capped");
    if (!read.value.scope.countsKnown) warnings.add("counts_unavailable");
    if (!read.value.scope.descriptionsKnown) warnings.add("descriptions_unavailable");
  }
  return read.value;
}

// ---------------------------------------------------------------------------
// 2. Rows
// ---------------------------------------------------------------------------

interface RowRead {
  readonly updates: EvaluateUpdate[];
  readonly scopeBudgetHit: boolean;
  readonly maxUpdatesHit: boolean;
}

function projectRow(
  source: Source,
  row: Readonly<Record<string, unknown>>,
  withPayload: boolean
): EvaluateUpdate | undefined {
  const sysId = lowerId(row.sys_id);
  const set = lowerId(row[rowSetField(source)]);
  if (sysId === undefined || set === undefined) return undefined;
  return {
    sys_id: sysId,
    name: scalar(row.name) ?? "",
    type: textOrNull(row.type),
    target_name: textOrNull(row.target_name),
    update_set: set,
    action: textOrNull(row.action),
    table: textOrNull(row.table),
    application: lowerId(row.application) ?? null,
    replace_on_upgrade: flag(row.replace_on_upgrade) === true,
    // Only a string is a payload; anything else reads as absent (not scanned).
    payload: withPayload && typeof row.payload === "string" ? row.payload : null,
  };
}

async function readRows(
  reader: Reader,
  access: PlatformViewFieldAccess,
  scope: ResolvedScope,
  options: { readonly maxUpdates: number; readonly reserved: number; readonly payload: boolean },
  warnings: Set<EvaluateWarning>
): Promise<RowRead> {
  const setField = rowSetField(scope.source);
  const base = readableOf(access, "sys_update_xml", [...ROW_FIELDS, setField]);
  const withPayload = [...base, "payload"];
  const ids = scope.sets.map((set) => set.sys_id);
  const known = Number.isFinite(scope.total) ? scope.total : Number.POSITIVE_INFINITY;
  const wanted = Math.min(options.maxUpdates, known);
  const updates: EvaluateUpdate[] = [];
  let last: string | undefined;
  // The page starts small and grows while its payloads fit. A page too large
  // for its scope sets a ceiling the size never climbs back over, so large
  // payloads do not keep failing and spending scopes.
  let pageSize: number = L.FIRST_PAGE_ROWS;
  let ceiling: number = L.PAGE_ROWS;
  /** The largest page size read with payloads so far. */
  let lastGood = 0;
  let scopeBudgetHit = false;
  let exhausted = false;
  let invalid = 0;

  const page = (size: number, fields: readonly string[]) =>
    listParams({
      fields,
      query: `${setField}IN${ids.join(",")}${last === undefined ? "" : `^sys_id>${last}`}^ORDERBYsys_id`,
      limit: size,
    });

  while (updates.length + invalid < wanted && !exhausted) {
    if (reader.scopes.max - reader.scopes.opened <= options.reserved) {
      scopeBudgetHit = true;
      break;
    }
    const size = Math.min(pageSize, wanted - updates.length - invalid);
    let rows: Record<string, unknown>[];
    let payloadRead = options.payload;
    try {
      const read = await inScope(reader, () =>
        reader.ops.get(`${TABLE_PATH}sys_update_xml`, page(size, options.payload ? withPayload : base))
      );
      if (read === undefined) {
        scopeBudgetHit = true;
        break;
      }
      rows = rowsOf(read.value);
      if (options.payload) lastGood = Math.max(lastGood, size);
    } catch (error) {
      if (!options.payload || !isTooLarge(error)) throw error;
      if (size > 1) {
        // A page of large payloads: the same rows again, half as many at a time.
        pageSize = Math.ceil(size / 2);
        ceiling = pageSize;
        continue;
      }
      // One row too large for a scope: its metadata only, so paging can go on.
      if (reader.scopes.max - reader.scopes.opened <= options.reserved) {
        scopeBudgetHit = true;
        break;
      }
      const single = await inScope(reader, () => reader.ops.get(`${TABLE_PATH}sys_update_xml`, page(1, base)));
      if (single === undefined) {
        scopeBudgetHit = true;
        break;
      }
      rows = rowsOf(single.value);
      payloadRead = false;
      warnings.add("row_too_large");
      // That one row set the ceiling to 1; the rows after it may fit as many
      // as the largest page that has fitted.
      ceiling = Math.max(1, lastGood);
    }
    if (rows.length < size) exhausted = true;
    let pageChars = 0;
    let lastOfPage: string | undefined;
    for (const raw of rows) {
      const id = lowerId(raw.sys_id);
      if (id !== undefined && (lastOfPage === undefined || id > lastOfPage)) lastOfPage = id;
      const fields = payloadRead ? withPayload : base;
      const update = projectRow(scope.source, readableRow(access, "sys_update_xml", raw, fields), payloadRead);
      if (update === undefined) invalid += 1;
      else updates.push(update);
      pageChars += update?.payload?.length ?? 0;
    }
    // Keyset paging: without a valid sys_id there is no next key.
    if (lastOfPage === undefined || (last !== undefined && lastOfPage <= last)) exhausted = true;
    last = lastOfPage;
    // Grow: at least double, or straight to what the measured payloads say
    // fits; never past the ceiling.
    const perRow = rows.length === 0 ? 0 : pageChars / rows.length;
    const fits = perRow === 0 ? L.PAGE_ROWS : Math.floor(L.PAGE_TARGET_CHARS / perRow);
    pageSize = Math.max(1, Math.min(ceiling, Math.max(pageSize * 2, fits)));
  }
  if (invalid > 0) warnings.add("rows_unreadable");
  const maxUpdatesHit = !exhausted && !scopeBudgetHit && updates.length + invalid >= options.maxUpdates && known > options.maxUpdates;
  if (scopeBudgetHit) warnings.add("scope_budget");
  if (maxUpdatesHit) warnings.add("max_updates");
  return { updates, scopeBudgetHit, maxUpdatesHit };
}

// ---------------------------------------------------------------------------
// 3. Context: hierarchies and field types
// ---------------------------------------------------------------------------

interface ContextRead {
  readonly context: EvaluateContext;
  /** Tables whose facts could not be read (cap or failure), counted as unavailable checks by the engine. */
  readonly hierarchyComplete: boolean;
  readonly fieldTypes: "available" | "unavailable";
  /** True when finding record-element tables ran out of its CPU budget. */
  readonly collectionBudgetHit: boolean;
}

/**
 * The text of a payload with its CDATA sections and comments removed, so
 * markup-like text inside a script is never read as a record. An
 * unterminated section drops the rest of the text.
 *
 * Linear: the next opener of each kind is searched for again only once the
 * scan has passed the last one found, so a kind that does not occur is
 * searched for once, and every character is read a bounded number of times.
 */
export function outsideCdataAndComments(text: string): string {
  const parts: string[] = [];
  let at = 0;
  let cdata = text.indexOf("<![CDATA[");
  let comment = text.indexOf("<!--");
  while (at < text.length) {
    if (cdata >= 0 && cdata < at) cdata = text.indexOf("<![CDATA[", at);
    if (comment >= 0 && comment < at) comment = text.indexOf("<!--", at);
    const next = cdata < 0 ? comment : comment < 0 ? cdata : Math.min(cdata, comment);
    if (next < 0) {
      parts.push(text.slice(at));
      break;
    }
    parts.push(text.slice(at, next));
    const close = next === cdata ? text.indexOf("]]>", next + 9) : text.indexOf("-->", next + 4);
    if (close < 0) break;
    at = close + 3;
    parts.push(" ");
  }
  return parts.join("");
}

/**
 * Tables a row may write to, most certain first, so the table cap is filled
 * by the tables every row names before any payload can add more:
 * 1. each row's `table` column, update-name prefix and payload root table;
 * 2. record elements (a table-named element with an `action` attribute)
 *    found outside CDATA and comments, in the part of the payload the engine
 *    reads, at most {@link EVALUATE_LIMITS}.MAX_RECORD_TABLES_PER_ROW per
 *    row, taken one per row in turn, so one row cannot crowd out the rest.
 * A table missed here has no facts, so the credential check treats it as
 * unknown and its rows are not scanned: a miss fails closed, for those rows.
 */
export function candidateTables(updates: readonly EvaluateUpdate[], maxPayloadChars: number = ENGINE_LIMITS.maxPayloadBytes): string[] {
  const direct = new Set<string>();
  const nested: string[][] = [];
  for (const update of updates) {
    directTables(update, direct);
    nested.push(recordTables(update, maxPayloadChars));
  }
  return mergeTables(direct, nested);
}

/** Priority 1 for one row: its `table` column, update-name prefix and payload root. Cheap. */
function directTables(update: EvaluateUpdate, into: Set<string>): void {
  if (typeof update.table === "string" && TABLE_NAME.test(update.table)) into.add(update.table);
  const named = UPDATE_NAME_TABLE.exec(update.name);
  if (named !== null) into.add(named[1]!);
  if (update.payload === null) return;
  const declared = ROOT_TABLE.exec(update.payload.slice(0, ROOT_HEAD_CHARS));
  if (declared !== null) into.add(declared[1]!);
}

/** Priority 2 for one row: its record elements outside CDATA and comments, capped. Linear in the payload. */
function recordTables(update: EvaluateUpdate, maxPayloadChars: number): string[] {
  if (update.payload === null) return [];
  const own = new Set<string>();
  for (const match of outsideCdataAndComments(update.payload.slice(0, maxPayloadChars)).matchAll(RECORD_ELEMENT)) {
    own.add(match[1]!);
    if (own.size >= L.MAX_RECORD_TABLES_PER_ROW) break;
  }
  return [...own];
}

function mergeTables(direct: ReadonlySet<string>, nested: readonly (readonly string[])[]): string[] {
  const tables = new Set(direct);
  for (let round = 0; round < L.MAX_RECORD_TABLES_PER_ROW; round += 1) {
    for (const own of nested) if (own[round] !== undefined) tables.add(own[round]!);
  }
  return [...tables];
}

/**
 * {@link candidateTables} as the handler runs it: it yields to the event loop
 * after {@link YIELD_AFTER_MS} of work, as the engine does, and stops reading
 * record elements once {@link EVALUATE_LIMITS}.CANDIDATE_BUDGET_MS of work is
 * spent. Rows left then keep only their direct tables; a nested record they
 * hold is unknown, so those rows fail closed, and `budgetHit` says so.
 */
export async function collectCandidateTables(
  updates: readonly EvaluateUpdate[],
  hooks: EngineHooks = {},
  maxPayloadChars: number = ENGINE_LIMITS.maxPayloadBytes
): Promise<{ readonly tables: string[]; readonly budgetHit: boolean }> {
  const now = hooks.now ?? (() => performance.now());
  const yieldToLoop = hooks.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const direct = new Set<string>();
  const nested: string[][] = [];
  let spent = 0;
  let segmentStart = now();
  let budgetHit = false;
  for (const update of updates) {
    directTables(update, direct);
    if (budgetHit) continue;
    let elapsed = now() - segmentStart;
    if (elapsed >= YIELD_AFTER_MS) {
      spent += elapsed;
      await yieldToLoop();
      segmentStart = now();
      elapsed = 0;
    }
    if (spent + elapsed >= L.CANDIDATE_BUDGET_MS) {
      budgetHit = true;
      continue;
    }
    nested.push(recordTables(update, maxPayloadChars));
  }
  return { tables: mergeTables(direct, nested), budgetHit };
}

/**
 * The context reads, in one scope. `extra` (the update-version counts, small
 * like these) runs in the same scope, alongside them; it handles its own
 * failures and is told when no scope was left.
 *
 * Hierarchies and field types come from the shared plan-bounded loader
 * (`loadFieldTypesInPlan`): `sys_db_object` one level per read, through a
 * declared one-hop dot-walk, and one hidden-types `sys_dictionary` read.
 */
async function readContext(
  reader: Reader,
  access: PlatformViewFieldAccess,
  updates: readonly EvaluateUpdate[],
  warnings: Set<EvaluateWarning>,
  extra?: { readonly run: () => Promise<void>; readonly noScope: () => void }
): Promise<ContextRead> {
  const { tables: all, budgetHit } = await collectCandidateTables(updates, reader.hooks);
  if (budgetHit) warnings.add("context_tables_budget");
  if (all.length > L.MAX_CONTEXT_TABLES) warnings.add("context_tables_capped");
  // The cap keeps the most certain tables; the reads list them sorted.
  const tables = all.slice(0, L.MAX_CONTEXT_TABLES).sort();

  const loaderOptions = {
    readChains: firstUnreadable(access, "sys_db_object", ["name", "super_class"]) === undefined,
    readTypes: firstUnreadable(access, "sys_dictionary", DICTIONARY_FIELDS) === undefined,
    maxLevels: L.MAX_CHAIN_LEVELS,
    filterDictionaryRow: (row: Readonly<Record<string, unknown>>) =>
      readableRow(access, "sys_dictionary", row, DICTIONARY_FIELDS),
    signal: reader.signal,
  };
  let loaded: PlanFieldTypes | undefined;
  let noScope = false;
  if (tables.length > 0 || extra !== undefined) {
    const read = await inScope(reader, async () => {
      // The reads do not depend on each other. A failure costs the facts it
      // would have given, never the call; a cancellation ends the call.
      const [types] = await Promise.all([loadFieldTypesInPlan(reader.meta, tables, loaderOptions), extra?.run()]);
      return types;
    });
    if (read === undefined) {
      noScope = true;
      extra?.noScope();
    } else loaded = read.value;
  }
  // No scope was left, or nothing to read: the same shape, with nothing read.
  loaded ??= await loadFieldTypesInPlan(reader.meta, tables, { ...loaderOptions, readChains: false, readTypes: false });
  const { chains, types: fieldTypes } = loaded;
  if (noScope || !loaded.hierarchyRead || tables.some((tableName) => chains.get(tableName)?.complete !== true)) {
    warnings.add("hierarchy_unavailable");
  }
  if (fieldTypes.state === "unavailable" && tables.length > 0) warnings.add("field_types_unavailable");

  const context: EvaluateContext = {
    isCredentialTable(tableName) {
      if (isCredentialTable(tableName)) return true;
      const chain = chains.get(tableName);
      if (chain !== undefined && isCredentialTableHierarchy(chain.tables)) return true;
      if (chain?.complete === true) return false;
      // No row, an incomplete chain, a failed read or a table past the cap:
      // it may extend a credential table. The engine reads an answer that is
      // not a boolean as "credential" and counts it, so the row is not
      // scanned and the result is partial.
      return UNKNOWN_TABLE as unknown as boolean;
    },
    hiddenFieldNames(tableName) {
      return hiddenTypedFields(fieldTypes, tableName) ?? "unavailable";
    },
    extendsMetadata(tableName) {
      if (tableName === METADATA_ROOT) return true;
      const chain = chains.get(tableName);
      if (chain === undefined) return "unknown";
      if (chain.tables.includes(METADATA_ROOT)) return true;
      return chain.complete ? false : "unknown";
    },
  };
  return {
    context,
    hierarchyComplete: !warnings.has("hierarchy_unavailable"),
    fieldTypes: fieldTypes.state,
    collectionBudgetHit: budgetHit,
  };
}

// ---------------------------------------------------------------------------
// 4. Facts for the extra-read rules
// ---------------------------------------------------------------------------

interface Facts {
  problems?: PreviewProblem[];
  collisions?: Map<string, number>;
  baseline?: Map<string, "baseline" | "customer">;
  /** Checks the adapter knows were not made (names it could not check for collisions). */
  unavailable: number;
}

/**
 * True when an update name may go into a `nameIN` list as it is: only the
 * allowed characters, no script prefix, and nothing `escapeQueryValue` would
 * change. Any other name is not checked, and is counted.
 */
export function isListableName(name: string): boolean {
  return LISTABLE_NAME.test(name) && !SCRIPT_PREFIX.test(name) && escapeQueryValue(name) === name;
}

function listableNames(updates: readonly EvaluateUpdate[]): { listable: string[]; unlistable: number } {
  const names = new Set<string>();
  let unlistable = 0;
  for (const update of updates) {
    if (isListableName(update.name)) names.add(update.name);
    else unlistable += 1;
  }
  return { listable: [...names].sort(), unlistable };
}

function groupsOf(response: unknown): { fields: Map<string, string>; count: number | undefined }[] {
  return rowsOf(response).map((group) => {
    const fields = new Map<string, string>();
    for (const entry of Array.isArray(group.groupby_fields) ? group.groupby_fields : []) {
      const record = asRecord(entry);
      const field = scalar(record.field);
      const value = scalar(record.value);
      if (field !== undefined && value !== undefined) fields.set(field, value);
    }
    return { fields, count: wholeNumber(asRecord(group.stats).count) };
  });
}

async function readProblems(
  reader: Reader,
  access: PlatformViewFieldAccess,
  scope: ResolvedScope,
  facts: Facts,
  warnings: Set<EvaluateWarning>
): Promise<void> {
  const table = "sys_update_preview_problem";
  if (firstUnreadable(access, table, ["sys_id", "remote_update", "status", "remote_update_set"]) !== undefined) {
    warnings.add("problems_unavailable");
    return;
  }
  const fields = readableOf(access, table, PROBLEM_FIELDS);
  try {
    const read = await inScope(reader, () =>
      reader.ops.get(
        `${TABLE_PATH}${table}`,
        listParams({
          fields,
          query: `remote_update_setIN${scope.sets.map((set) => set.sys_id).join(",")}^ORDERBYsys_id`,
          limit: L.MAX_PROBLEMS + 1,
        })
      )
    );
    if (read === undefined) {
      warnings.add("problems_unavailable");
      return;
    }
    const rows = rowsOf(read.value).map((row) => readableRow(access, table, row, fields));
    if (rows.length > L.MAX_PROBLEMS) {
      warnings.add("problems_capped");
      facts.unavailable += 1;
    }
    facts.problems = rows.slice(0, L.MAX_PROBLEMS).map((row) => ({
      sys_id: lowerId(row.sys_id) ?? "",
      remote_update: lowerId(row.remote_update) ?? null,
      // Only a string status can be resolved; anything else blocks.
      status: typeof row.status === "string" ? row.status : null,
      type: textOrNull(row.type),
    }));
  } catch (error) {
    if (isCancellation(error, reader.signal)) throw error;
    warnings.add("problems_unavailable");
  }
}

/** Local BP004: each name's rows in other open sets. A name not checked is counted. */
async function readCollisions(
  reader: Reader,
  access: PlatformViewFieldAccess,
  scope: ResolvedScope,
  updates: readonly EvaluateUpdate[],
  facts: Facts,
  warnings: Set<EvaluateWarning>
): Promise<void> {
  const readable =
    firstUnreadable(access, "sys_update_xml", ["name", "update_set"]) === undefined &&
    access.canRead("sys_update_set", "state");
  const { listable, unlistable } = listableNames(updates);
  if (!readable) {
    warnings.add("collisions_unavailable");
    return; // the engine counts the missing fact
  }
  const checked = listable.slice(0, L.MAX_COLLISION_NAMES);
  const notChecked = listable.length - checked.length + unlistable;
  if (unlistable > 0) warnings.add("names_unlistable");
  const collisions = new Map<string, number>();
  const exclude = scope.sets.map((set) => set.sys_id).join(",");
  try {
    const read = await inScope(reader, () =>
      mapLimited(chunks(checked, L.NAME_CHUNK), L.CONCURRENCY, (chunk) =>
        reader.ops.get(`${STATS_PATH}sys_update_xml`, {
          sysparm_query: `nameIN${chunk.join(",")}^update_set.state=in progress^update_setNOT IN${exclude}`,
          sysparm_group_by: "name",
          sysparm_count: "true",
        })
      )
    );
    if (read === undefined) {
      warnings.add("collisions_unavailable");
      return;
    }
    for (const response of read.value) {
      for (const group of groupsOf(response)) {
        const name = group.fields.get("name");
        // A group with no readable count still says the name is held elsewhere.
        if (name !== undefined && checked.includes(name)) collisions.set(name, group.count ?? 1);
      }
    }
  } catch (error) {
    if (isCancellation(error, reader.signal)) throw error;
    warnings.add("collisions_unavailable");
    return;
  }
  facts.collisions = collisions;
  if (notChecked > 0) {
    facts.unavailable += notChecked;
    warnings.add("collisions_unavailable");
  }
}

/** BP005: which names have a version from a source other than the customer's own sets. */
/** BP005, run inside the context's scope (see {@link readContext}). */
async function readBaseline(
  reader: Reader,
  access: PlatformViewFieldAccess,
  updates: readonly EvaluateUpdate[],
  facts: Facts,
  warnings: Set<EvaluateWarning>
): Promise<void> {
  if (firstUnreadable(access, "sys_update_version", ["name", "source_table"]) !== undefined) {
    warnings.add("baseline_unavailable");
    return;
  }
  const { listable, unlistable } = listableNames(updates);
  const checked = listable.slice(0, L.MAX_BASELINE_NAMES);
  try {
    const responses = await mapLimited(chunks(checked, L.NAME_CHUNK), L.CONCURRENCY, (chunk) =>
      reader.ops.get(`${STATS_PATH}sys_update_version`, {
        sysparm_query: `nameIN${chunk.join(",")}`,
        sysparm_group_by: "name,source_table",
        sysparm_count: "true",
      })
    );
    // A checked name with no version is a new record: the customer's own. A
    // version with no source says nothing, so a name with only such versions
    // (and none from a baseline) is left out: the engine counts it unchecked.
    const baseline = new Map<string, "baseline" | "customer">(checked.map((name) => [name, "customer"]));
    const unsourced = new Set<string>();
    for (const response of responses) {
      for (const group of groupsOf(response)) {
        const name = group.fields.get("name");
        const source = group.fields.get("source_table")?.trim().toLowerCase() ?? "";
        if (name === undefined || !baseline.has(name)) continue;
        if (source === "") unsourced.add(name);
        else if (!CUSTOMER_VERSION_SOURCES.has(source)) baseline.set(name, "baseline");
      }
    }
    for (const name of unsourced) if (baseline.get(name) !== "baseline") baseline.delete(name);
    if (unsourced.size > 0) warnings.add("baseline_unavailable");
    facts.baseline = baseline;
  } catch (error) {
    if (isCancellation(error, reader.signal)) throw error;
    warnings.add("baseline_unavailable");
    return;
  }
  // Names left out are missing from the map; the engine counts each one.
  if (listable.length > checked.length) warnings.add("baseline_unavailable");
  if (unlistable > 0) warnings.add("names_unlistable");
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function findingRow(finding: Finding): Record<string, unknown> {
  return {
    rule_id: finding.rule_id,
    group: finding.group,
    severity: finding.severity,
    confidence: finding.confidence,
    message: finding.message,
    ...(finding.update === undefined
      ? {}
      : {
          update: {
            sys_id: finding.update.sys_id,
            name: cleanText(finding.update.name, MAX_NAME_CHARS) ?? "",
            type: cleanText(finding.update.type, MAX_NAME_CHARS) ?? null,
            target_name: cleanText(finding.update.target_name, MAX_NAME_CHARS) ?? null,
            update_set: finding.update.update_set,
          },
        }),
    ...(finding.update_set === undefined
      ? {}
      : { update_set: { sys_id: finding.update_set.sys_id, name: cleanText(finding.update_set.name, MAX_NAME_CHARS) ?? "" } }),
    ...(finding.table === undefined || !TABLE_NAME.test(finding.table) ? {} : { table: finding.table }),
    ...(finding.field === undefined ? {} : { field: finding.field }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Build the `view: "evaluate"` handler. `handleEvaluate` is the one the module
 * registers; a test builds its own with a fixed field access, engine limits,
 * a fake clock or a smaller scope budget.
 */
export function createEvaluateHandler(defaults: EvaluateHandlerOptions = {}): FieldAccessHandler {
  const maxScopes = Math.min(L.MAX_SCOPES, Math.max(1, Math.floor(defaults.maxScopes ?? L.MAX_SCOPES)));
  const limits: EngineLimits = { ...ENGINE_LIMITS, ...defaults.limits };
  return async (
    args: CanonicalPlatformViewArgs,
    services: ServiceNowToolHandlerServices,
    fieldAccess?: PlatformViewFieldAccess
  ): Promise<CallToolResult> => {
    const selector = selectorOf(args);
    const access = memoizedFieldAccess(fieldAccess ?? defaults.fieldAccess ?? liveFieldAccess);
    const reader: Reader = {
      ops: uncachedOperations(services.serviceNow),
      meta: services.serviceNow,
      signal: services.context?.signal,
      scopes: new FlowViewScopeBudget(maxScopes),
      hooks: defaults.hooks ?? {},
    };
    const warnings = new Set<EvaluateWarning>();
    const groups = args.groups === undefined || args.groups.length === 0 ? undefined : args.groups;
    const factsWanted = groups === undefined || groups.includes("bp");

    try {
      // 1. The scope.
      let resolution: Resolution;
      try {
        resolution = await resolveScope(reader, access, selector, warnings);
      } catch (error) {
        if (errorCategory(error) === "authorization") throw new ViewStop("denied", EVALUATE_DENIED_HINT);
        if (isMissingTable(error)) throw new ViewStop("unavailable", EVALUATE_UNAVAILABLE_HINT);
        throw error;
      }
      if (resolution.kind === "not_found") {
        return viewResult(args, { view: "evaluate", status: "ok", summary: { scope: null, note: EVALUATE_NOTE }, results: [], hint: EVALUATE_NOT_FOUND_HINT });
      }
      if (resolution.kind === "ambiguous") {
        return viewResult(args, {
          view: "evaluate",
          status: "ok",
          summary: { scope: null, candidates: resolution.candidates, note: EVALUATE_NOTE },
          results: [],
          hint: EVALUATE_AMBIGUOUS_HINT,
        });
      }
      const scope = resolution.scope;

      // 2. Rows, leaving the scopes the context and the facts need.
      const payloadAccess = access.canRead("sys_update_xml", "payload") ? "granted" : "denied";
      // One scope for the context (with the update-version counts), and one
      // for the problems or collisions when the facts are read.
      const reserved = 1 + (factsWanted ? 1 : 0);
      let rows: RowRead;
      try {
        rows = await readRows(
          reader,
          access,
          scope,
          {
            maxUpdates: args.max_updates ?? L.DEFAULT_MAX_UPDATES,
            reserved,
            payload: payloadAccess === "granted",
          },
          warnings
        );
      } catch (error) {
        if (errorCategory(error) === "authorization") throw new ViewStop("denied", EVALUATE_DENIED_HINT);
        throw error;
      }

      // 3 and 4. Context and facts, together: none depends on another.
      const facts: Facts = { unavailable: 0 };
      // A set whose description could not be checked is a check not made.
      if (factsWanted && !scope.descriptionsKnown) facts.unavailable += 1;
      const baseline =
        factsWanted && rows.updates.length > 0
          ? {
              run: () => readBaseline(reader, access, rows.updates, facts, warnings),
              noScope: () => warnings.add("baseline_unavailable"),
            }
          : undefined;
      const steps: Promise<unknown>[] = [readContext(reader, access, rows.updates, warnings, baseline)];
      if (factsWanted && rows.updates.length > 0) {
        if (scope.source === "remote") steps.push(readProblems(reader, access, scope, facts, warnings));
        else steps.push(readCollisions(reader, access, scope, rows.updates, facts, warnings));
      } else if (factsWanted && scope.source === "remote") {
        // An empty remote scope still needs its problems: a problem with no row blocks too.
        steps.push(readProblems(reader, access, scope, facts, warnings));
      }
      const [context] = (await Promise.all(steps)) as [ContextRead, ...unknown[]];
      if (context.collectionBudgetHit) facts.unavailable += 1;

      const input: EvaluationInput = {
        source: scope.source,
        sets: scope.sets,
        batch_root: selector.children ? scope.root : null,
        updates: rows.updates,
        updates_total: Number.isFinite(scope.total) ? scope.total : Number.NaN,
        payload_access: payloadAccess,
        ...(facts.problems === undefined ? {} : { problems: facts.problems }),
        ...(facts.collisions === undefined ? {} : { open_set_collisions: facts.collisions }),
        ...(facts.baseline === undefined ? {} : { baseline_versions: facts.baseline }),
        context: context.context,
      };

      let result: EvaluationResult;
      try {
        result = await evaluateUpdateSets(
          input,
          { ...(groups === undefined ? {} : { groups }), ...(args.min_severity === undefined ? {} : { min_severity: args.min_severity }) },
          limits,
          defaults.hooks
        );
      } catch {
        // Nothing the engine or a check threw reaches the caller.
        throw createToolError("internal", "do_not_retry");
      }

      const adapterPartial = scope.setsCapped || rows.scopeBudgetHit || facts.unavailable > 0;
      const coverage = {
        ...result.coverage,
        checks_unavailable: result.coverage.checks_unavailable + facts.unavailable,
        partial: result.coverage.partial || adapterPartial,
        rows_read: rows.updates.length,
        sets_capped: scope.setsCapped,
        scope_budget_hit: rows.scopeBudgetHit,
        upstream_scopes: reader.scopes.opened,
      };
      const findings = result.findings.map(findingRow);
      const page = findings.slice(args.offset, args.offset + args.limit);
      const hasMore = args.offset + page.length < findings.length;
      const shownSets = scope.sets.slice(0, L.SHOWN_SETS).map((set) => ({
        sys_id: set.sys_id,
        name: set.name,
        state: set.state ?? null,
        update_count: Number.isFinite(set.update_count) ? set.update_count : null,
      }));
      const warningList = [
        ...(payloadAccess === "denied" ? [EVALUATE_METADATA_ONLY] : []),
        ...[...warnings].map((key) => EVALUATE_WARNINGS[key]),
      ];
      return viewResult(args, {
        view: "evaluate",
        status: "ok",
        summary: {
          scope: {
            source: scope.source,
            root: scope.root,
            sets: shownSets,
            sets_total: scope.sets.length,
            updates_total: Number.isFinite(scope.total) ? scope.total : null,
          },
          rules_version: result.rules_version,
          by_group: result.summary.by_group,
          by_severity: result.summary.by_severity,
          findings_returned: findings.length,
          findings_truncated: result.findings_truncated,
          coverage,
          facts: {
            field_types: context.fieldTypes,
            hierarchy: context.hierarchyComplete ? "complete" : "partial",
          },
          note: EVALUATE_NOTE,
        },
        results: page,
        record_count: page.length,
        has_more: hasMore,
        ...(hasMore ? { next_offset: args.offset + page.length } : {}),
        ...(warningList.length > 0 ? { warnings: warningList.slice(0, 20) } : {}),
      });
    } catch (error) {
      if (error instanceof ViewStop) {
        return viewResult(args, { view: "evaluate", status: error.status, hint: error.hint });
      }
      throw error;
    }
  };
}

/** The handler the dispatcher registers. */
export const handleEvaluate: FieldAccessHandler = createEvaluateHandler();

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function shown(value: unknown): string {
  return scalar(value) ?? "-";
}

/** One line of instance text: control characters gone, bounded. */
function line(value: unknown): string {
  return cleanText(value, MAX_NAME_CHARS) ?? "-";
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

/**
 * The readable text of an `evaluate` result. Counts, rule ids, severities and
 * the engine's fixed messages are this server's own text. Every name (set,
 * update, target, type, table) is instance text and appears only inside an
 * `untrustedBlock`. A result with no findings never says only that: it says
 * what was examined, and that it is not an approval.
 */
export function renderEvaluateText(data: unknown): string | undefined {
  const record = asRecord(data);
  if (record.view !== "evaluate") return undefined;
  const status = scalar(record.status);
  if (status !== "ok") {
    return renderMarkdown(headline("Update set evaluation", { status: "fail", detail: scalar(record.hint) ?? "not available" }));
  }
  const summary = asRecord(record.summary);
  const scope = asRecord(summary.scope);
  if (summary.scope === null || Object.keys(scope).length === 0) {
    const candidates = Array.isArray(summary.candidates) ? summary.candidates : [];
    return renderMarkdown(
      headline("Update set evaluation", { status: "warn", detail: "no scope" }),
      text(scalar(record.hint) ?? EVALUATE_NOT_FOUND_HINT),
      candidates.length === 0
        ? undefined
        : untrustedBlock(
            "Candidates (sys_id | state)",
            candidates.map((entry) => `${line(asRecord(entry).sys_id)} | ${line(asRecord(entry).state)}`).join("\n")
          )
    );
  }
  const coverage = asRecord(summary.coverage);
  const bySeverity = asRecord(summary.by_severity);
  const total = SEVERITY_ORDER.reduce((sum, severity) => sum + (wholeNumber(bySeverity[severity]) ?? 0), 0);
  const partial = coverage.partial === true;
  const blocks: (MarkdownFragment | undefined)[] = [
    headline("Update set evaluation", {
      status: total > 0 || partial ? "warn" : "pass",
      detail: `${scalar(scope.source) === "remote" ? "remote" : "local"} scope, ${total} finding(s)${partial ? ", partial" : ""}`,
    }),
    table(
      ["Severity", "Findings"],
      SEVERITY_ORDER.map((severity) => [severity, String(wholeNumber(bySeverity[severity]) ?? 0)])
    ),
    table(
      ["Coverage", "Rows"],
      [
        ["in scope", shown(coverage.updates_total)],
        ["read", shown(coverage.rows_read)],
        ["scanned", shown(coverage.scanned)],
        ["metadata only (unreadable payload)", shown(coverage.skipped_unreadable)],
        ["credential rows (not scanned)", shown(coverage.credential_rows)],
        ["not evaluated", shown(coverage.not_evaluated)],
        ["checks unavailable", shown(coverage.checks_unavailable)],
      ]
    ),
  ];
  const states: string[] = [];
  if (coverage.metadata_only === true) states.push(EVALUATE_METADATA_ONLY);
  if (coverage.cpu_budget_hit === true) states.push("The CPU budget ran out; the result is partial.");
  if (coverage.bytes_cap_hit === true) states.push("The payload byte cap was reached; the result is partial.");
  if (summary.findings_truncated === true) states.push("More than 500 findings; the highest-severity 500 are kept.");
  if (total === 0) states.push("No rule matched in what was examined.");
  states.push(EVALUATE_NOTE);
  blocks.push(bulletList(states));

  const sets = Array.isArray(scope.sets) ? scope.sets : [];
  blocks.push(
    untrustedBlock(
      "Sets (sys_id | state | rows | name)",
      sets
        .map((entry) => {
          const set = asRecord(entry);
          return `${line(set.sys_id)} | ${line(set.state)} | ${shown(set.update_count)} | ${line(set.name)}`;
        })
        .join("\n"),
      8_000
    )
  );

  const rows = Array.isArray(record.results) ? record.results : [];
  if (rows.length > 0) {
    const lines = rows.map((entry) => {
      const finding = asRecord(entry);
      const update = asRecord(finding.update);
      const set = asRecord(finding.update_set);
      const where =
        Object.keys(update).length > 0
          ? `${line(update.name)} | ${line(update.type)} | ${line(update.target_name)} | set ${line(update.update_set)}`
          : `set ${line(set.sys_id)} ${line(set.name)}`;
      const extra = [
        finding.table === undefined ? "" : ` | table ${line(finding.table)}`,
        finding.field === undefined ? "" : ` | ${line(finding.field)}${finding.line === undefined ? "" : `:${shown(finding.line)}`}`,
      ].join("");
      return `${shown(finding.severity)} | ${shown(finding.rule_id)} | ${shown(finding.message)} | ${where}${extra}`;
    });
    blocks.push(untrustedBlock("Findings (severity | rule | message | update | type | target | set)", lines.join("\n"), 16_000));
  }
  if (record.has_more === true) blocks.push(text(`More findings: next_offset ${shown(record.next_offset)}.`));
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  if (warnings.length > 0) blocks.push(bulletList(warnings.map((warning) => String(scalar(warning) ?? ""))));
  return renderMarkdown(...blocks);
}
