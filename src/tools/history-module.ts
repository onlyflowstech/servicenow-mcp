/**
 * `sn_history`: one record's history, newest first: its audited field
 * changes (`sys_audit`), its comments and work notes (`sys_journal_field`)
 * and the flows that ran on it (`sys_flow_context`).
 *
 * Access plan (`historyAccessPlan`), decided before any read:
 * - the record's table, with `sys_id` and `sys_class_name` readable under
 *   field policy (otherwise the call is refused before it reads anything);
 * - `sys_db_object` and `sys_dictionary`, for the class's field types, when
 *   the profile may read them. Without them every value is withheld;
 * - each source the profile may read, decided on its own as `sn_codesearch`
 *   decides its code tables: a source whose table is not granted (including a
 *   named-only table under `"*"`, or a target not bound to this tool), or
 *   whose key columns field policy hides, is reported `not_granted` and left
 *   out of the plan. The call fails only when a source the caller named
 *   explicitly is refused, or when no source is left.
 * The mirror tables (`sys_history_line`, `sys_audit_delete`,
 * `sys_email`) are never read.
 *
 * Reads, at most six per page (four once the class's types are memoized):
 * 1. the record (`GET <table>/<sys_id>`, `sys_id,sys_class_name`). A record
 *    that is missing or that the instance refuses is `not_found`; a record
 *    whose class is not `table` is refused with the class to call with;
 * 2. the class's extension chain (`sys_db_object`) and every dictionary row
 *    of that chain (`sys_dictionary`), uncached and then kept for an hour in
 *    the per-credential memo, so a warm call skips both. Skipped as well when
 *    no source on the page needs types. The chain counts only when it is
 *    known to end at a table that extends nothing;
 * 3. each planned source, newest first, `limit + 1` rows, uncached. The
 *    journal and flow reads run with step 2; the audit read follows it, so
 *    its query leaves out the chain's journal fields. A source whose page is
 *    too large for the client is asked again for half the rows, down to one
 *    row; past that it alone is `too_large` and the others still answer.
 *
 * Every source row must carry the record's class and sys_id in its key
 * columns, or it is dropped (`omitted.mismatch`). Then, in order:
 * (a) an audit row for a journal-typed field (by the dictionary type found
 *     walking up the class's chain, never by name) is left out of the audit
 *     query, and dropped if it comes back anyway: journal text, and whether
 *     there is any, comes only through the journal source and its own grant.
 *     Without types, the platform's journal field names are left out the same
 *     way unless the call reads the journal source;
 * (b) a row whose field the profile may not read on the class (field policy,
 *     a sensitive name, a type the call hides, or a column that field policy
 *     keeps closed, such as a record payload or a process command line) is
 *     dropped (`omitted.unreadable`), unnamed;
 * (c) a value whose field is hidden by type, sits on a credential table or
 *     has an unknown type is withheld (`value_hidden`). This uses the shared
 *     type helper over the dictionary rows of step 2, so an unreadable
 *     dictionary withholds every value.
 * Values are cut at 2,000 characters; references stay raw sys_ids. No row is
 * cached.
 *
 * Paging: each source has its own position, `encodeTailCursor` bound to the
 * record, the source and the filters (`historyCursorFilter`). The newest
 * `limit` events of all sources are returned; a source's cursor stands at
 * the last of its rows this page consumed, so a page never skips or repeats.
 *
 * A page where every source that still has entries is `too_large` carries a
 * `hint` (`STUCK_PAGE_HINT`): repeating the call unchanged would not move on.
 *
 * Registered in `catalog.ts`; its output schema and byte limit are its
 * result-envelope entries.
 *
 * @module tools/history-module
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  isServiceNowRequestCancellation,
  isServiceNowResponseTooLarge,
  runWithServiceNowRequestSignal,
  type ServiceNowOperations,
} from "../client.js";
import {
  explicitReadColumns,
  FieldPolicyError,
  isFieldPolicyError,
  resolveReadableFields,
} from "../field-policy.js";
import {
  FIELD_TYPES_TTL_MS,
  FIELD_TYPES_UNAVAILABLE_TTL_MS,
  classifyField,
  classifyReadFailure,
  fieldTypesFromRows,
  fieldTypesProblemText,
  fieldTypesUnavailable,
  retryTransientOnce,
  type ChainGap,
  type DictionaryRow,
  type FieldTypes,
  type FieldTypesProblemInput,
  type FieldTypesReadFailure,
} from "../hidden-values.js";
import { derivedMetadataMemo, uncachedOperations } from "../metadata-cache.js";
import { serviceNowSysIdPathSegment } from "../servicenow-identifiers.js";
import {
  TablePolicyError,
  authorizeTableAccess,
  isTablePolicyError,
  type TableAccessPolicy,
  type TableAccessRequest,
} from "../table-policy.js";
import { createToolError, trustedToolErrorDescriptor } from "../tool-error.js";
import { ok } from "../utils.js";
import {
  HISTORY_DESCRIPTION,
  HISTORY_DICTIONARY_AUDIT_FIELD,
  HISTORY_DICTIONARY_FIELDS,
  HISTORY_FIXED_TABLES,
  HISTORY_HIERARCHY_FIELDS,
  HISTORY_LIMITS,
  HISTORY_SOURCES,
  HISTORY_SOURCE_SPECS,
  HistoryArgumentError,
  NOT_RECORDED,
  canonicalHistoryArgs,
  historyCursorFilter,
  historyInputSchema,
  type CanonicalHistoryArgs,
  type HistoryData,
  type HistoryEvent,
  type HistorySource,
  type HistorySourceSpec,
} from "./history-contracts.js";
import { envelopeCompatibilityResult, productionToolOutputSchemas } from "./result-envelope.js";
import { encodeTailCursor, isStoredTimestamp, isSysId, type TailCursor, type TailPosition } from "./syslog-cursor.js";
import { resolveTableChain } from "./table-hierarchy.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  type ServiceNowToolHandlerServices,
} from "./tool-module.js";

const TOOL = "sn_history";
const TABLE_PATH = "/api/now/table/";
const L = HISTORY_LIMITS;

/** Dictionary types whose values are journal text. */
const JOURNAL_TYPES: ReadonlySet<string> = new Set(["journal", "journal_input", "journal_list"]);
/**
 * The platform's own journal fields, by name. Used only to leave rows out when
 * the types cannot be read and the journal source is not in the call: a name
 * never makes a row visible.
 */
export const JOURNAL_FIELD_NAMES: readonly string[] = Object.freeze(["comments", "comments_and_work_notes", "work_notes"]);
/** Depth of the class chain walked for field types. */
const MAX_HIERARCHY_DEPTH = 12;
/** A dictionary read that returns this many rows may be cut short, so its types are unavailable. */
export const MAX_HISTORY_DICTIONARY_ROWS = 5_000;
/** Bytes kept back from `max_response_bytes` for the envelope around `data`. */
const ENVELOPE_RESERVE_BYTES = 2_000;
/** The highest sys_id: a position at the end of one second, for a source this page did not reach. */
const END_OF_SECOND = "f".repeat(32);
/** A position before every row: where a source that returned nothing yet starts again. */
const BEFORE_ALL: TailPosition = Object.freeze({ timestamp: "9999-12-31 23:59:59", sysId: END_OF_SECOND });
/** The fewest rows a source read asks for after a response was too large: one row and the look-ahead. */
export const MIN_SOURCE_READ_ROWS = 2;

const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;

export const WRONG_CLASS_HINT = (recordClass: string) =>
  `This record's class is ${recordClass}. Call again with table: ${recordClass}.`;
export const INVALID_CURSOR_HINT =
  "The cursor was returned for another record, source or filter. Repeat the call that returned it with " +
  "the same arguments, or leave cursor out to start from the newest entry.";
export const VALUES_NOT_READABLE_WARNING = (source: HistorySource) =>
  `Field policy hides the ${source} value columns, so no ${source} values are shown.`;
export const TOO_LARGE_WARNING = (source: HistorySource) =>
  `The newest ${source} entries were too large to return, so ${source} was skipped on this page. ` +
  "Repeat the call with include_values: false or a narrower since/until to read them.";
/**
 * Every source with entries left was too large to read on this page, so
 * repeating the call with the same arguments returns the same page. The
 * limit is the client's per-response cap, which `max_response_bytes` does
 * not change.
 */
export const STUCK_PAGE_HINT = (sources: readonly HistorySource[]) =>
  `Paging on with the same arguments will not progress: ${sources.join(", ")} ` +
  `${sources.length === 1 ? "is" : "are"} too large to read. Use include_values: false, a narrower ` +
  `since/until, or leave ${sources.length === 1 ? "that source" : "them"} out of sources.`;
export const FITTED_WARNING =
  "Fewer events than limit fit max_response_bytes; the rest follow with next_cursor.";

// ---------------------------------------------------------------------------
// Access plan
// ---------------------------------------------------------------------------

export interface HistorySourcePlan {
  readonly source: HistorySource;
  readonly spec: HistorySourceSpec;
  /** `not_granted`: refused by table or field policy, and left out of the plan. */
  readonly granted: boolean;
  /** `sysparm_fields` for the read. */
  readonly fields: readonly string[];
  readonly user: boolean;
  /** The value columns are requested (`include_values` and readable). */
  readonly values: boolean;
  /** `include_values` was asked for but field policy hides the value columns. */
  readonly valuesHidden: boolean;
}

export interface HistoryPlan {
  readonly table: string;
  /** `sys_db_object` and `sys_dictionary` are in the plan. */
  readonly dictionary: boolean;
  /** The dictionary's `audit` column is readable. */
  readonly auditFlag: boolean;
  /** The sources asked for (explicitly, or every one by default), in canonical order. */
  readonly sources: readonly HistorySourcePlan[];
  readonly requests: readonly TableAccessRequest[];
}

function read(table: string): TableAccessRequest {
  return Object.freeze({ operation: "read" as const, table });
}

/** Whether every one of `fields` is readable on `table` under the call's field policy. */
function canRead(table: string, fields: readonly string[]): boolean {
  try {
    resolveReadableFields(table, { fields: fields.join(",") });
    return true;
  } catch (error) {
    if (isFieldPolicyError(error)) return false;
    throw error;
  }
}

/**
 * True for a column that field policy keeps closed on `table` (a record
 * payload or a process command line; see `explicitReadColumns`). History
 * never shows such a column, even where a profile opened it for reading: its
 * audit rows are dropped and it cannot be named in `fields`. A table that
 * extends one with such columns has them too, wherever its chain is known.
 */
export function isRecordContentColumn(table: string, field: string): boolean {
  return explicitReadColumns(table)?.has(field) === true;
}

/**
 * The call's access plan. It throws (and so refuses the call before any read)
 * when the record cannot be identified under field policy, when `fields`
 * names a field the profile may not read, when a source the caller named is
 * refused, or when no source is left. Every other refusal narrows the plan.
 *
 * Pure apart from the policy it consults: the dispatcher runs it inside the
 * call's field-policy and type scopes, and the handler runs it again there,
 * so both see the same plan.
 */
export function historyAccessPlan(args: CanonicalHistoryArgs, tableAccess: TableAccessPolicy): HistoryPlan {
  const table = args.table;
  // The class is read before anything else; a profile that may not read
  // it gets nothing, rather than a history keyed to a guessed class.
  resolveReadableFields(table, { fields: "sys_id,sys_class_name" });
  if (args.fields !== undefined) {
    resolveReadableFields(table, { fields: args.fields.join(",") });
    const content = args.fields.find((field) => isRecordContentColumn(table, field));
    if (content !== undefined) throw new FieldPolicyError("unreadable_field", { table, field: content });
  }

  let dictionary = false;
  try {
    authorizeTableAccess(tableAccess, read("sys_db_object"), TOOL);
    authorizeTableAccess(tableAccess, read("sys_dictionary"), TOOL);
    dictionary = canRead("sys_db_object", HISTORY_HIERARCHY_FIELDS) && canRead("sys_dictionary", HISTORY_DICTIONARY_FIELDS);
  } catch (error) {
    if (!isTablePolicyError(error)) throw error;
  }
  const auditFlag = dictionary && canRead("sys_dictionary", [HISTORY_DICTIONARY_AUDIT_FIELD]);

  const explicit = args.sources !== undefined;
  const asked = args.sources ?? HISTORY_SOURCES;
  const sources: HistorySourcePlan[] = [];
  let firstDenial: unknown;
  for (const source of asked) {
    const spec = HISTORY_SOURCE_SPECS[source];
    try {
      authorizeTableAccess(tableAccess, read(spec.table), TOOL);
      resolveReadableFields(spec.table, { fields: spec.keys.join(",") });
    } catch (error) {
      if (!isTablePolicyError(error) && !isFieldPolicyError(error)) throw error;
      if (explicit) throw error;
      firstDenial ??= error;
      sources.push(Object.freeze({ source, spec, granted: false, fields: [], user: false, values: false, valuesHidden: false }));
      continue;
    }
    const user = canRead(spec.table, [spec.user]);
    const valuesReadable = spec.values.length > 0 && canRead(spec.table, spec.values);
    const values = args.include_values && valuesReadable;
    const extras = spec.extras.filter((field) => canRead(spec.table, [field]));
    sources.push(
      Object.freeze({
        source,
        spec,
        granted: true,
        fields: Object.freeze([...spec.keys, ...(user ? [spec.user] : []), ...(values ? spec.values : []), ...extras]),
        user,
        values,
        valuesHidden: args.include_values && spec.values.length > 0 && !valuesReadable,
      })
    );
  }
  if (!sources.some((entry) => entry.granted)) {
    if (isFieldPolicyError(firstDenial)) throw firstDenial;
    throw new TablePolicyError({
      reason: "none_granted",
      operation: "read",
      tool: TOOL,
      tables: HISTORY_SOURCES.map((source) => HISTORY_SOURCE_SPECS[source].table),
    });
  }

  const tables = [
    table,
    ...(dictionary ? ["sys_db_object", "sys_dictionary"] : []),
    ...sources.filter((entry) => entry.granted).map((entry) => entry.spec.table),
  ];
  return Object.freeze({
    table,
    dictionary,
    auditFlag,
    sources: Object.freeze(sources),
    requests: Object.freeze([...new Set(tables)].map(read)),
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function inOwnScope<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  return signal instanceof AbortSignal ? runWithServiceNowRequestSignal(signal, operation) : operation();
}

function rowsOf(response: unknown): Record<string, unknown>[] {
  const result = (response as { result?: unknown } | null | undefined)?.result;
  return Array.isArray(result)
    ? result.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
}

/** A stored value as text: a string, or the `value` of a `{value, display_value}` pair. */
function stored(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner;
  }
  return undefined;
}

function key(value: unknown): string {
  return (stored(value) ?? "").trim().toLowerCase();
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

/** Cut at `max` code units without splitting a surrogate pair. */
function cut(value: string, max: number): { readonly text: string; readonly cut: boolean } {
  if (value.length <= max) return { text: value, cut: false };
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), cut: true };
}

/** A short instance string on one line, or undefined when empty. */
function shortText(value: unknown, max: number): string | undefined {
  const raw = stored(value);
  if (raw === undefined) return undefined;
  const flat = raw.replace(CONTROL_CHARACTERS, " ").trim();
  return flat === "" ? undefined : cut(flat, max).text;
}

function errorCategory(error: unknown): string | undefined {
  return trustedToolErrorDescriptor(error)?.category;
}

/** The Table API's answer for a table that does not exist: an `upstream` error with no reason. */
function isMissingTable(error: unknown): boolean {
  const descriptor = trustedToolErrorDescriptor(error);
  return descriptor?.category === "upstream" && descriptor.retry === "do_not_retry" && descriptor.reason === undefined;
}

/**
 * The record's class. A missing record, one the instance refuses to show and
 * a table the instance does not have are all `not_found`, so the answer says
 * nothing about a record the caller cannot see. An empty class means the
 * table is not extended: the class is the table.
 */
async function readRecordClass(
  ops: ServiceNowOperations,
  args: CanonicalHistoryArgs,
  signal: AbortSignal | undefined
): Promise<string> {
  let response: unknown;
  try {
    response = await inOwnScope(signal, () =>
      ops.get(`${TABLE_PATH}${args.table}/${serviceNowSysIdPathSegment(args.sys_id)}`, {
        sysparm_fields: "sys_id,sys_class_name",
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      })
    );
  } catch (error) {
    if (isServiceNowRequestCancellation(error) || signal?.aborted) throw error;
    const category = errorCategory(error);
    if (category === "not_found" || category === "authorization" || isMissingTable(error)) {
      throw createToolError("not_found", "do_not_retry");
    }
    throw error;
  }
  const result = (response as { result?: unknown } | null | undefined)?.result;
  const row = Array.isArray(result) ? result[0] : result;
  if (typeof row !== "object" || row === null || key((row as Record<string, unknown>).sys_id) !== args.sys_id) {
    throw createToolError("not_found", "do_not_retry");
  }
  const recordClass = key((row as Record<string, unknown>).sys_class_name);
  if (recordClass === "") return args.table;
  // Only a valid table name is ever repeated or put in a query.
  if (!TABLE_NAME.test(recordClass)) throw createToolError("upstream", "do_not_retry");
  return recordClass;
}

/** Why a class's types are not known, as the pieces {@link fieldTypesProblemText} words. */
type ClassTypesWhy = Pick<FieldTypesProblemInput, "problem" | "failure" | "read">;

interface ClassTypes {
  readonly types: FieldTypes;
  readonly auditEnabled: boolean | null;
  /** Set when `types` is unavailable: the cause, for the warning. */
  readonly why?: ClassTypesWhy;
}

/** This profile's plan does not read sys_db_object and sys_dictionary: a cause of this server's own policy. */
const POLICY_WHY: ClassTypesWhy = Object.freeze({
  failure: Object.freeze({ kind: "policy" as const, table: "sys_dictionary" as const }),
});

/** The types of a call whose profile does not read them: one value, shared. */
const POLICY_TYPES: ClassTypes = unavailableTypes(POLICY_WHY);

/** The warning for a class whose types are not known, worded from its cause. */
export function classTypesWarning(why: ClassTypesWhy | undefined): string {
  return fieldTypesProblemText({ surface: "history", ...(why ?? {}) });
}

function unavailableTypes(
  why: ClassTypesWhy,
  auditEnabled: boolean | null = null
): ClassTypes {
  return Object.freeze({
    types: fieldTypesUnavailable(why.failure ?? (why.problem?.kind === "read" ? why.problem.failure : undefined)),
    auditEnabled,
    why,
  });
}

/** What one read of a class's chain and dictionary found; kept in the per-credential memo. */
interface ClassTypesEntry {
  readonly chain: readonly string[];
  readonly rows: readonly DictionaryRow[];
  readonly auditEnabled: boolean | null;
  /** The chain is known to end at a table that extends nothing (see `TableChain`). */
  readonly complete: boolean;
  /** Why it is not, when it is not: the last table of `chain` is where the gap is. */
  readonly gap?: ChainGap;
  /** The dictionary read filled its page, so it may be cut short. */
  readonly full: boolean;
}

/** A read that did not answer. Never kept in the memo. */
interface ClassTypesFailure {
  readonly failed: FieldTypesReadFailure;
  readonly read: "sys_dictionary" | "sys_db_object";
}

const CLASS_TYPES_MEMO_PREFIX = "sn_history:class-types:v1:";

function isClassTypesEntry(candidate: unknown): candidate is ClassTypesEntry {
  if (typeof candidate !== "object" || candidate === null) return false;
  const entry = candidate as Partial<Record<keyof ClassTypesEntry, unknown>>;
  return Array.isArray(entry.chain) && Array.isArray(entry.rows) && typeof entry.complete === "boolean" && typeof entry.full === "boolean";
}

function isClassTypesFailure(candidate: unknown): candidate is ClassTypesFailure {
  return typeof candidate === "object" && candidate !== null && "failed" in candidate && "read" in candidate;
}

function failureTypes(failure: ClassTypesFailure): ClassTypes {
  return unavailableTypes({ failure: failure.failed, read: failure.read });
}

function typesOf(entry: ClassTypesEntry, recordClass: string): ClassTypes {
  if (entry.full) return unavailableTypes({ failure: Object.freeze({ kind: "incomplete" as const }), read: "sys_dictionary" });
  if (!entry.complete) {
    // The class's own row is not readable: the instance showed this user no
    // sys_db_object row for it. Otherwise the chain stops short at a table.
    if (entry.gap === "no_row") {
      return unavailableTypes({ failure: Object.freeze({ kind: "refused" as const, status: 200 }), read: "sys_db_object" }, entry.auditEnabled);
    }
    return unavailableTypes(
      {
        problem: Object.freeze({
          kind: "chain" as const,
          at: entry.chain[entry.chain.length - 1] ?? recordClass,
          gap: entry.gap ?? ("malformed" as const),
        }),
      },
      entry.auditEnabled
    );
  }
  return {
    types: fieldTypesFromRows(entry.rows, { [recordClass]: { tables: entry.chain, complete: true } }, { complete: true }),
    auditEnabled: entry.auditEnabled,
  };
}

/**
 * The class's field types: its chain, then every dictionary row of the chain,
 * each field typed by its nearest definition (`incident.work_notes` is
 * defined on `task`).
 *
 * The reads go straight to the instance, and what they find is kept in the
 * metadata cache's per-credential memo for an hour (the type-hiding memo's
 * time), as `loadFieldTypes` does: a warm call reads nothing here, and a wide
 * chain never pays for a `sys_dictionary` watermark. Concurrent calls for one
 * class share one read. A read that times out or returns a 5xx the client does
 * not retry itself is made once more after a short pause; any failure is not kept and
 * gives the `unavailable` state, with its cause. A full page or a chain that
 * stops short is kept for 30 seconds and gives it too, with its cause. A
 * cancellation rethrows.
 *
 * The chain is only trusted when the shared reader reports it complete: it
 * ends at a table whose stored parent reference and parent name are both
 * empty. A chain that may stop short (no row, a parent whose row did not come
 * back, or one longer than the read) could hide that the class extends a
 * credential table, so its types are `unavailable` too.
 */
async function readClassTypes(
  services: ServiceNowOperations,
  recordClass: string,
  plan: HistoryPlan,
  signal: AbortSignal | undefined
): Promise<ClassTypes> {
  if (!plan.dictionary) return POLICY_TYPES;
  const memo = derivedMetadataMemo(services);
  const memoKey = `${CLASS_TYPES_MEMO_PREFIX}${plan.auditFlag ? "audit" : "plain"}:${recordClass}`;
  const known = memo?.get(memoKey);
  if (isClassTypesEntry(known)) return typesOf(known, recordClass);
  const pending = memo?.pending(memoKey);
  if (pending !== undefined) {
    try {
      const shared = await pending;
      if (isClassTypesEntry(shared)) return typesOf(shared, recordClass);
      if (isClassTypesFailure(shared)) return failureTypes(shared);
    } catch {
      // That call was cancelled; read for this one.
    }
  }
  const read = readClassTypesEntry(uncachedOperations(services), recordClass, plan, signal);
  const entry = await (memo === undefined ? read : memo.track(memoKey, read));
  if (isClassTypesFailure(entry)) return failureTypes(entry);
  memo?.set(
    memoKey,
    entry,
    128 + JSON.stringify(entry).length,
    entry.complete && !entry.full ? FIELD_TYPES_TTL_MS : FIELD_TYPES_UNAVAILABLE_TTL_MS
  );
  return typesOf(entry, recordClass);
}

/** One uncached read of the chain and its dictionary rows; a failure says which read and why. */
async function readClassTypesEntry(
  reader: ServiceNowOperations,
  recordClass: string,
  plan: HistoryPlan,
  signal: AbortSignal | undefined
): Promise<ClassTypesEntry | ClassTypesFailure> {
  let reading: "sys_dictionary" | "sys_db_object" = "sys_db_object";
  try {
    const { tables: chain, complete, gap } = await retryTransientOnce(
      () => inOwnScope(signal, () => resolveTableChain(reader, recordClass, MAX_HIERARCHY_DEPTH, false)),
      { signal }
    );
    reading = "sys_dictionary";
    const fields = [...HISTORY_DICTIONARY_FIELDS, ...(plan.auditFlag ? [HISTORY_DICTIONARY_AUDIT_FIELD] : [])];
    const response = await retryTransientOnce(
      () =>
        inOwnScope(signal, () =>
          reader.get(`${TABLE_PATH}sys_dictionary`, {
            sysparm_query: `nameIN${chain.join(",")}^ORDERBYname^ORDERBYelement`,
            sysparm_fields: fields.join(","),
            sysparm_limit: String(MAX_HISTORY_DICTIONARY_ROWS),
            sysparm_display_value: "false",
            sysparm_exclude_reference_link: "true",
          })
        ),
      { signal }
    );
    const rows = rowsOf(response);
    if (rows.length >= MAX_HISTORY_DICTIONARY_ROWS) {
      return Object.freeze({ chain, rows: [], auditEnabled: null, complete: false, full: true });
    }
    const dictionaryRows: DictionaryRow[] = [];
    let auditEnabled: boolean | null = null;
    for (const row of rows) {
      const table = key(row.name);
      const element = key(row.element);
      const type = key(row.internal_type);
      if (!chain.includes(table) || type === "") continue;
      if (element === "") {
        if (table === recordClass && type === "collection" && plan.auditFlag) {
          const flag = key(row[HISTORY_DICTIONARY_AUDIT_FIELD]);
          auditEnabled = flag === "true" ? true : flag === "false" ? false : null;
        }
        continue;
      }
      dictionaryRows.push(Object.freeze({ table, element, internal_type: type }));
    }
    return Object.freeze({
      chain: Object.freeze([...chain]),
      rows: Object.freeze(dictionaryRows),
      auditEnabled,
      complete,
      ...(complete || gap === undefined ? {} : { gap }),
      full: false,
    });
  } catch (error) {
    if (isServiceNowRequestCancellation(error) || signal?.aborted) throw error;
    return Object.freeze({ failed: classifyReadFailure(error), read: reading });
  }
}

/**
 * The audit fields the audit read leaves out, so journal rows never reach a
 * page, its cursors, `has_more` or its counts: every journal-typed field of
 * the class's chain when the types are known. Without types, the platform's
 * journal field names, unless the call also reads the journal source (then
 * those rows are shown without values, as every audit row is).
 */
export function auditExclusions(types: FieldTypes, recordClass: string, journalInCall: boolean): readonly string[] {
  if (types.state === "available") {
    const all = types.tables.get(recordClass)?.allTypes;
    return [...(all ?? new Map<string, string>())]
      .filter(([, type]) => JOURNAL_TYPES.has(type))
      .map(([field]) => field)
      .sort();
  }
  return journalInCall ? [] : JOURNAL_FIELD_NAMES;
}

/** The encoded query of one source's page: position first, then the record, then the filters. */
export function sourceQuery(
  spec: HistorySourceSpec,
  recordClass: string,
  args: CanonicalHistoryArgs,
  position: TailPosition | undefined,
  /** Field names the source must not return (journal fields, for the audit log). */
  exclude: readonly string[] = []
): string {
  const parts: string[] = [];
  if (position !== undefined) {
    // Newest first, strictly before (T, I): `<=T` and (`<T` or `sys_id<I`).
    // `^OR` binds to the clause before it, so the record filter that follows
    // applies to both branches.
    parts.push(`sys_created_on<=${position.timestamp}`, `sys_created_on<${position.timestamp}^ORsys_id<${position.sysId}`);
  }
  parts.push(`${spec.classColumn}=${recordClass}`, `${spec.idColumn}=${args.sys_id}`);
  if (args.fields !== undefined && spec.fieldColumn !== undefined) parts.push(`${spec.fieldColumn}IN${args.fields.join(",")}`);
  if (exclude.length > 0 && spec.fieldColumn !== undefined) parts.push(`${spec.fieldColumn}NOT IN${exclude.join(",")}`);
  if (args.since !== undefined) parts.push(`sys_created_on>=${args.since}`);
  if (args.until !== undefined) parts.push(`sys_created_on<=${args.until}`);
  return `${parts.join("^")}^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id`;
}

type SourceRead =
  | {
      readonly status: "ok";
      readonly rows: readonly Record<string, unknown>[];
      /** The rows asked for: `limit + 1`, or fewer after a response was too large. */
      readonly asked: number;
    }
  | { readonly status: "denied" | "unavailable" | "done" | "not_granted" | "too_large" };

/**
 * One source's page. A response too large for the client is asked again for
 * half the rows, down to one row and the look-ahead; if even that is too
 * large, the source alone is `too_large` and the other sources still answer.
 * Each attempt runs in its own response scope.
 */

async function readSource(
  ops: ServiceNowOperations,
  plan: HistorySourcePlan,
  recordClass: string,
  args: CanonicalHistoryArgs,
  signal: AbortSignal | undefined,
  exclude: readonly string[] = []
): Promise<SourceRead> {
  if (!plan.granted) return { status: "not_granted" };
  const position = args.cursor?.[plan.source];
  // A follow-up page reads only the sources its cursor names: the others are finished.
  if (args.cursor !== undefined && position === undefined) return { status: "done" };
  const query = sourceQuery(plan.spec, recordClass, args, position, exclude);
  let asked = args.limit + 1;
  for (;;) {
    try {
      const response = await inOwnScope(signal, () =>
        ops.get(`${TABLE_PATH}${plan.spec.table}`, {
          sysparm_query: query,
          sysparm_fields: plan.fields.join(","),
          sysparm_limit: String(asked),
          sysparm_display_value: "false",
          sysparm_exclude_reference_link: "true",
        })
      );
      return { status: "ok", rows: rowsOf(response), asked };
    } catch (error) {
      if (isServiceNowRequestCancellation(error) || signal?.aborted) throw error;
      if (isServiceNowResponseTooLarge(error)) {
        if (asked <= MIN_SOURCE_READ_ROWS) return { status: "too_large" };
        asked = Math.max(MIN_SOURCE_READ_ROWS, Math.floor(asked / 2));
        continue;
      }
      if (errorCategory(error) === "authorization") return { status: "denied" };
      if (isMissingTable(error)) return { status: "unavailable" };
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Rows to events
// ---------------------------------------------------------------------------

/** One source row in page order: an event to show, or a row dropped and only counted. */
interface Candidate {
  readonly source: HistorySource;
  readonly order: number;
  readonly position: TailPosition;
  readonly event?: HistoryEvent;
  readonly omitted?: "unreadable" | "mismatch";
}

interface RowJudge {
  readonly recordClass: string;
  readonly sysId: string;
  readonly types: FieldTypes;
  /** Audit fields left out of the read; a row the instance returns anyway is dropped. */
  readonly excluded: ReadonlySet<string>;
  /** Field readability on the class, memoized per call. */
  readonly readable: (field: string) => boolean;
}

function judgeRow(plan: HistorySourcePlan, row: Readonly<Record<string, unknown>>, judge: RowJudge): Omit<Candidate, "source" | "order" | "position"> | null {
  const spec = plan.spec;
  // A row about another record is never shown, whatever the query said.
  if (key(row[spec.classColumn]) !== judge.recordClass || key(row[spec.idColumn]) !== judge.sysId) {
    return { omitted: "mismatch" };
  }
  const time = stored(row.sys_created_on)!;
  const user = plan.user ? shortText(row[spec.user], L.MAX_USER_CHARS) : undefined;
  if (plan.source === "flows") {
    const name = shortText(row.name, L.MAX_FLOW_NAME_CHARS);
    const state = shortText(row.state, L.MAX_FLOW_STATE_CHARS);
    const test = key(row.is_test_run);
    const flow = {
      ...(name === undefined ? {} : { name }),
      ...(state === undefined ? {} : { state }),
      ...(test === "true" ? { test: true } : test === "false" ? { test: false } : {}),
    };
    return { event: { time, source: "flows", ...(user === undefined ? {} : { user }), flow } };
  }
  const field = key(row[spec.fieldColumn!]);
  // (a) Journal text never comes through the audit log, by the field's type.
  if (plan.source === "audit") {
    if (judge.excluded.has(field)) return null;
    if (judge.types.state === "available") {
      const type = judge.types.tables.get(judge.recordClass)?.allTypes?.get(field);
      if (type !== undefined && JOURNAL_TYPES.has(type)) return null;
    }
  }
  // (b) The field must be one the profile may read on the class.
  if (!judge.readable(field)) return { omitted: "unreadable" };
  const event: HistoryEvent = { time, source: plan.source, field, ...(user === undefined ? {} : { user }) };
  if (plan.valuesHidden) return { event: { ...event, value_hidden: true } };
  if (!plan.values) return { event };
  // (c) Values by type and table, through the shared helper.
  if (classifyField(judge.types, judge.recordClass, field) !== "visible") return { event: { ...event, value_hidden: true } };
  let truncated = false;
  const value = (column: string): string | undefined => {
    const raw = stored(row[column]);
    if (raw === undefined || raw === "") return undefined;
    const shown = cut(raw, L.MAX_VALUE_CHARS);
    truncated ||= shown.cut;
    return shown.text;
  };
  const values =
    plan.source === "audit"
      ? { old: value("oldvalue"), new: value("newvalue") }
      : { new: value("value") };
  return {
    event: {
      ...event,
      ...(values.old === undefined ? {} : { old: values.old }),
      ...(values.new === undefined ? {} : { new: values.new }),
      ...(truncated ? { value_truncated: true as const } : {}),
    },
  };
}

/**
 * A source's rows as candidates, newest first. Of `asked` rows, the last is
 * the look-ahead: it only says more exist, so at most `asked - 1` (and at most
 * `limit`) rows are candidates.
 */
function candidatesOf(
  plan: HistorySourcePlan,
  rows: readonly Record<string, unknown>[],
  limit: number,
  judge: RowJudge
): { readonly candidates: Candidate[]; readonly full: boolean } {
  const order = HISTORY_SOURCES.indexOf(plan.source);
  const positioned = rows.map((row) => {
    const timestamp = stored(row.sys_created_on);
    const sysId = key(row.sys_id);
    // A row without a position cannot be paged past: fail closed, as the log tail does.
    if (!isStoredTimestamp(timestamp) || !isSysId(sysId)) throw createToolError("upstream", "do_not_retry");
    return { row, position: { timestamp, sysId } };
  });
  positioned.sort((a, b) => compareNewestFirst(a.position, b.position));
  const candidates: Candidate[] = [];
  for (const { row, position } of positioned.slice(0, limit)) {
    const judged = judgeRow(plan, row, judge);
    candidates.push({ source: plan.source, order, position, ...(judged ?? {}) });
  }
  return { candidates, full: rows.length > limit };
}

function compareNewestFirst(a: TailPosition, b: TailPosition): number {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp ? -1 : 1;
  if (a.sysId !== b.sysId) return a.sysId > b.sysId ? -1 : 1;
  return 0;
}

interface PageWalk {
  readonly events: HistoryEvent[];
  readonly omitted: { unreadable: number; mismatch: number };
  readonly perSource: Map<HistorySource, { returned: number; consumed: number; last?: TailPosition }>;
  readonly cut?: TailPosition;
}

/** Newest first across sources: time, then source order, then sys_id. */
function compareMerged(a: Candidate, b: Candidate): number {
  if (a.position.timestamp !== b.position.timestamp) return a.position.timestamp > b.position.timestamp ? -1 : 1;
  return a.order - b.order || compareNewestFirst(a.position, b.position);
}

/**
 * Walk all sources' candidates newest first and take at most `emitLimit`
 * events. A dropped row is consumed as it is passed, so a page of dropped rows
 * still moves the cursor on; the walk stops at the first event past the limit.
 *
 * A source that has rows past its candidates (`full`) bounds the walk: its
 * next row is unknown and may be newer than anything after its last
 * candidate, so the walk never passes that candidate. Each page therefore
 * holds a prefix of the whole history in its one order, and consumes at least
 * one row while any source has one.
 */
function walkPage(all: readonly Candidate[], emitLimit: number, full: ReadonlySet<HistorySource>): PageWalk {
  const merged = [...all].sort(compareMerged);
  let end = merged.length;
  for (const source of full) {
    let last = -1;
    merged.forEach((candidate, index) => {
      if (candidate.source === source) last = index;
    });
    if (last >= 0) end = Math.min(end, last + 1);
  }
  const events: HistoryEvent[] = [];
  const omitted = { unreadable: 0, mismatch: 0 };
  const perSource = new Map<HistorySource, { returned: number; consumed: number; last?: TailPosition }>();
  for (const source of HISTORY_SOURCES) perSource.set(source, { returned: 0, consumed: 0 });
  let cutAt: TailPosition | undefined;
  for (const candidate of merged.slice(0, end)) {
    const state = perSource.get(candidate.source)!;
    if (candidate.event !== undefined) {
      if (events.length >= emitLimit) break;
      events.push(candidate.event);
      state.returned += 1;
    } else if (candidate.omitted !== undefined) {
      omitted[candidate.omitted] += 1;
    }
    state.consumed += 1;
    state.last = candidate.position;
    cutAt = candidate.position;
  }
  return { events, omitted, perSource, ...(cutAt === undefined ? {} : { cut: cutAt }) };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function historyResult(args: CanonicalHistoryArgs, data: HistoryData): CallToolResult {
  return envelopeCompatibilityResult(TOOL, args as unknown as Record<string, unknown>, ok(data));
}

function dataBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

async function handleHistory(
  rawArgs: Record<string, unknown>,
  services: ServiceNowToolHandlerServices
): Promise<CallToolResult> {
  let args: CanonicalHistoryArgs;
  try {
    args = canonicalHistoryArgs(rawArgs);
  } catch (error) {
    if (error instanceof HistoryArgumentError) throw createToolError("conflict", "retry_after_correction");
    throw error;
  }
  // A window that ends before it starts: the caller can correct it.
  if (args.since !== undefined && args.until !== undefined && args.since > args.until) {
    throw createToolError("conflict", "retry_after_correction");
  }
  const plan = historyAccessPlan(args, services.policy.tableAccess);
  const record = { table: args.table, sys_id: args.sys_id };

  // A cursor is checked before any read: it must have been issued for this
  // record, this source and these filters.
  for (const source of HISTORY_SOURCES) {
    const position = args.cursor?.[source];
    if (position !== undefined && position.filter !== historyCursorFilter(args, args.table, source)) {
      return historyResult(args, { status: "invalid_cursor", record, hint: INVALID_CURSOR_HINT });
    }
  }

  const signal = services.context?.signal;
  const ops = uncachedOperations(services.serviceNow);
  // 1. The record's class.
  const recordClass = await readRecordClass(ops, args, signal);
  if (recordClass !== args.table) {
    return historyResult(args, { status: "wrong_class", record, hint: WRONG_CLASS_HINT(recordClass) });
  }

  // 2 and 3: the class's field types, and every source's page. The journal
  // and flow reads start with the types; the audit read waits for them, to
  // leave journal fields out of its query.
  const journalInCall = plan.sources.some((source) => source.source === "journal" && source.granted);
  // Types are needed only by a source this page reads that has audit rows
  // to judge or journal values to show; a flows-only page skips them.
  const live = (source: HistorySourcePlan) => source.granted && (args.cursor === undefined || args.cursor[source.source] !== undefined);
  const needsTypes = plan.sources.some(
    (source) => live(source) && (source.source === "audit" || (source.source === "journal" && source.values))
  );
  const typesRead = needsTypes
    ? readClassTypes(services.serviceNow, recordClass, plan, signal)
    : Promise.resolve(POLICY_TYPES);
  const [classTypes, reads] = await Promise.all([
    typesRead,
    Promise.all(
      plan.sources.map((source) =>
        source.source === "audit" && source.granted
          ? typesRead.then((types) =>
              readSource(ops, source, recordClass, args, signal, auditExclusions(types.types, recordClass, journalInCall))
            )
          : readSource(ops, source, recordClass, args, signal)
      )
    ),
  ]);
  const excluded = new Set(auditExclusions(classTypes.types, recordClass, journalInCall));

  const readableMemo = new Map<string, boolean>();
  const judge: RowJudge = {
    recordClass,
    sysId: args.sys_id,
    types: classTypes.types,
    excluded,
    readable: (field) => {
      let known = readableMemo.get(field);
      if (known === undefined) {
        known = TABLE_NAME.test(field) && !isRecordContentColumn(recordClass, field) && canRead(recordClass, [field]);
        readableMemo.set(field, known);
      }
      return known;
    },
  };
  const all: Candidate[] = [];
  const full = new Set<HistorySource>();
  plan.sources.forEach((source, index) => {
    const result = reads[index]!;
    if (result.status !== "ok") return;
    const page = candidatesOf(source, result.rows, Math.min(args.limit, result.asked - 1), judge);
    all.push(...page.candidates);
    if (page.full) full.add(source.source);
  });

  const warnings: string[] = [];
  if (needsTypes && args.include_values && classTypes.types.state !== "available") {
    warnings.push(classTypesWarning(classTypes.why));
  }
  for (const source of plan.sources) {
    if (source.granted && source.valuesHidden) warnings.push(VALUES_NOT_READABLE_WARNING(source.source));
  }
  plan.sources.forEach((source, index) => {
    if (reads[index]!.status === "too_large") warnings.push(TOO_LARGE_WARNING(source.source));
  });

  const build = (emitLimit: number): HistoryData => {
    const walk = walkPage(all, emitLimit, full);
    const sources: Record<string, { status: string; returned: number; has_more: boolean }> = {};
    const nextCursor: Partial<Record<HistorySource, string>> = {};
    plan.sources.forEach((source, index) => {
      const result = reads[index]!;
      const filter = historyCursorFilter(args, recordClass, source.source);
      if (result.status === "too_large") {
        // Nothing of it was read, so it starts again where it was: its own
        // position, or before every row. Its rows may then follow newer rows
        // of the other sources on later pages, but none is skipped.
        sources[source.source] = { status: "too_large", returned: 0, has_more: true };
        nextCursor[source.source] = encodeTailCursor({ ...(args.cursor?.[source.source] ?? BEFORE_ALL), filter });
        return;
      }
      if (result.status !== "ok") {
        sources[source.source] = { status: result.status, returned: 0, has_more: false };
        return;
      }
      const state = walk.perSource.get(source.source)!;
      const candidates = all.filter((candidate) => candidate.source === source.source).length;
      const hasMore = state.consumed < candidates || full.has(source.source);
      sources[source.source] = { status: "ok", returned: state.returned, has_more: hasMore };
      if (!hasMore) return;
      // The last row this page consumed; for a source it did not reach, the
      // position it was given, or the end of the second the page stopped in.
      const position: TailPosition | undefined =
        state.last ?? args.cursor?.[source.source] ?? (walk.cut === undefined ? undefined : { timestamp: walk.cut.timestamp, sysId: END_OF_SECOND });
      if (position === undefined) return;
      const cursor: TailCursor = { ...position, filter };
      nextCursor[source.source] = encodeTailCursor(cursor);
    });
    // The sources with entries left; if every one is too large, the next
    // page would read the same thing and fail the same way.
    const pending = HISTORY_SOURCES.filter((source) => sources[source]?.has_more === true);
    const stuck = pending.length > 0 && pending.every((source) => sources[source]!.status === "too_large");
    return {
      status: "ok",
      record,
      audit_enabled: classTypes.auditEnabled,
      events: walk.events,
      sources: sources as HistoryData["sources"],
      omitted: walk.omitted,
      not_recorded: [...NOT_RECORDED],
      ...(Object.keys(nextCursor).length > 0 ? { next_cursor: nextCursor } : {}),
      ...(stuck ? { hint: STUCK_PAGE_HINT(pending) } : {}),
      ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    };
  };

  // Fit `max_response_bytes`: keep the newest events that fit, and let the
  // cursors carry the rest. One event is always kept, without its values if
  // they alone are too large, so a page always moves on.
  // The result envelope holds the result to the same `max_response_bytes`.
  const budget = Math.max(0, args.max_response_bytes - ENVELOPE_RESERVE_BYTES);
  let data = build(args.limit);
  if (dataBytes(data) > budget && (data.events?.length ?? 0) > 0) {
    const events = data.events!;
    const base = dataBytes({ ...data, events: [], warnings: [...(data.warnings ?? []), FITTED_WARNING] });
    let used = base;
    let fit = 0;
    for (const event of events) {
      used += dataBytes(event) + 1;
      if (used > budget) break;
      fit += 1;
    }
    warnings.push(FITTED_WARNING);
    data = build(Math.max(1, fit));
    if (fit === 0) {
      const first: HistoryEvent = { ...data.events![0]! };
      if (first.old !== undefined || first.new !== undefined) {
        delete first.old;
        delete first.new;
        first.value_truncated = true;
      }
      data = { ...data, events: [first] };
    }
  }
  return historyResult(args, data);
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const schema = withRequiredProfile(historyInputSchema);

/** The plan for one call, as the dispatcher authorizes it. */
export function resolveHistoryAccess(candidate: unknown, tableAccess: TableAccessPolicy) {
  const input = schema.parse(candidate);
  const args = canonicalHistoryArgs(input);
  const plan = historyAccessPlan(args, tableAccess);
  return Object.freeze({
    args: Object.freeze({ ...input }) as Record<string, unknown>,
    requests: plan.requests,
  });
}

export const historyToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition: {
    name: TOOL,
    description: HISTORY_DESCRIPTION,
    annotations: {
      title: "View record history",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  inputSchema: schema,
  outputSchema: productionToolOutputSchemas.sn_history,
  requirements: {
    permissions: ["read"],
    tables: {
      kind: "dynamic",
      names: HISTORY_FIXED_TABLES,
      description: "The record's own table (its class), plus the history sources the profile may read",
    },
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["record:history"],
  },
  resolveAccess: (candidate, policy) => resolveHistoryAccess(candidate, policy.tableAccess),
  handler: handleHistory,
});
