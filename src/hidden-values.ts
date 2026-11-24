/**
 * Which field values are hidden by what a field *is*, not what it is called.
 *
 * Field policy hides a value by name (`isSensitiveFieldName`), but a field of
 * internal type `password` (a one-way hash) or `password2` (two-way
 * encrypted) can be called anything: `ssh_passphrase`, `key`, `answer`,
 * `secure_value`, `temppassword`. Their stored values are never returned, in
 * any display shape. This module is the one place that decides type-based
 * hiding:
 *
 * - {@link HIDDEN_FIELD_TYPES}, the internal types whose values are hidden;
 * - {@link loadFieldTypes}, which builds a table's hidden-typed fields from
 *   ONE instance-wide `sys_dictionary` read (fields of those types only),
 *   projected over each table's extension chain, with database views
 *   resolved to the tables they join;
 * - {@link loadFieldTypesInPlan}, the same answer from reads a tool declares
 *   in its own plan (`sys_db_object` one level at a time, and
 *   `sys_dictionary`), for tools whose type lookup must stay inside it;
 * - {@link classifyField}, the per-field verdict (including dot-walks) with a
 *   reason, for tools that show a value-hidden marker instead of dropping;
 * - {@link withoutFields}, whole-field removal for every response shape;
 * - row rules for tables whose secrecy is a per-row value (`sys_properties`).
 *
 * The loader never returns an empty map for "could not read": an unreadable
 * dictionary is the explicit `unavailable` state, and a table it could not
 * resolve has no entry (so every field on it is `unknown_type`). A table
 * resolves only when its whole extension chain is known ({@link TableChain}):
 * a chain that may stop short could hide that the table inherits a
 * hidden-typed field.
 *
 * The scope at the bottom carries one call's resolved sets to field policy,
 * which enforces them; see `field-policy.ts`.
 *
 * @module hidden-values
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  currentServiceNowRequestSignal,
  isServiceNowRequestCancellation,
  pauseUnlessServiceNowRequestCancelled,
  type ServiceNowOperations,
} from "./client.js";
import { isCredentialTableHierarchy } from "./credential-tables.js";
import { derivedMetadataMemo, uncachedOperations } from "./metadata-cache.js";
import { createToolError, trustedHttpStatus, trustedToolErrorDescriptor } from "./tool-error.js";

/**
 * Internal types whose stored values are never returned. `password` and
 * `password2` are the ones found on instances; `masked` and `encrypted_text`
 * are kept as a precaution (Flow Designer uses the same spellings).
 */
export const HIDDEN_FIELD_TYPES: readonly string[] = Object.freeze([
  "password",
  "password2",
  "masked",
  "encrypted_text",
]);

const HIDDEN_TYPE_SET: ReadonlySet<string> = new Set(HIDDEN_FIELD_TYPES);

/** True when `type` (an internal type name) is one whose values are hidden. */
export function isHiddenFieldType(type: unknown): boolean {
  return typeof type === "string" && HIDDEN_TYPE_SET.has(type.trim().toLowerCase());
}

/** Why a value is hidden; `visible` when it is not. */
export type FieldVerdict = "visible" | "type" | "credential_table" | "unknown_type";

/** One resolved table: its extension chain and the hidden-typed fields on it. */
export interface ResolvedTableTypes {
  /** The table first, then its ancestors. A view lists its joined tables. */
  readonly hierarchy: readonly string[];
  /** Hidden-typed field -> its internal type, inherited ones included. */
  readonly hidden: ReadonlyMap<string, string>;
  /** The same names, as a set. */
  readonly hiddenNames: ReadonlySet<string>;
  /**
   * Every field's internal type, when the caller supplied complete dictionary
   * rows (see {@link fieldTypesFromRows}); a field missing from it is then
   * `unknown_type`. Absent for the instance-wide loader, which reads only the
   * hidden types, so a field it does not list is not hidden.
   */
  readonly allTypes?: ReadonlyMap<string, string>;
  /**
   * For a database view: each joined table's column prefix and extension
   * chain (the table first), as the loader read them. A view's column
   * `<prefix>_<field>` is that table's `field`. Absent for a table.
   */
  readonly viewSources?: readonly ViewColumnSource[];
}

/** One table a database view joins: its column prefix and extension chain. */
export interface ViewColumnSource {
  readonly prefix: string;
  readonly hierarchy: readonly string[];
}

/**
 * Why a metadata read gave no answer. Every field is bounded: an HTTP status
 * is an integer from 100 to 599 that the client recorded from a response
 * (never text from one), and everything else is a fixed literal. No upstream
 * message, header or body is ever part of it.
 */
export type FieldTypesReadFailure =
  /** This server's profile or field policy kept the read from being made. */
  | { readonly kind: "policy"; readonly table: "sys_dictionary" | "sys_db_object" }
  /** The instance refused the read (401, 403), or returned 200 with no readable rows (status 200). */
  | { readonly kind: "refused"; readonly status: number }
  /** A 5xx or 429, a timeout, or a network failure (no status). `retried`: the read was tried twice. */
  | {
      readonly kind: "transient";
      readonly status?: number;
      readonly timeout?: true;
      readonly retried?: true;
    }
  /** The read filled its page, so it may be cut short. */
  | { readonly kind: "incomplete" }
  /** Anything else: a 400, an invalid or HTML response, a redirect, an internal fault. */
  | { readonly kind: "failed"; readonly status?: number };

/** Why a table's extension chain is not known to be complete. */
export type ChainGap = "parent_unreadable" | "too_long" | "malformed" | "no_row";

/** The metadata read a failure or problem is about. */
export type FieldTypesReadName = "sys_dictionary" | "sys_db_object" | "sys_db_view_table";

/** Why one requested table is unresolved. */
export type FieldTypesTableProblem =
  /** sys_db_object answered (its own row came back), has no row for the table, and the table is not a view. */
  | { readonly kind: "not_found" }
  /** `at` is the last table resolved; the gap is at it (its parent, or its own row for `no_row`). */
  | { readonly kind: "chain"; readonly at: string; readonly gap: ChainGap }
  /** The read of the chain (or of the view's joined tables) itself failed. */
  | {
      readonly kind: "read";
      readonly failure: FieldTypesReadFailure;
      readonly read?: "sys_db_object" | "sys_db_view_table";
    };

export type FieldTypes =
  | {
      readonly state: "available";
      /** Resolved tables. A requested table that is missing is unresolved. */
      readonly tables: ReadonlyMap<string, ResolvedTableTypes>;
      /** Why each requested table that is not in `tables` is unresolved, where the loader knows. */
      readonly problems?: ReadonlyMap<string, FieldTypesTableProblem>;
    }
  | {
      readonly state: "unavailable";
      /** Why the dictionary was not read; absent for a loader that does not say. */
      readonly cause?: FieldTypesReadFailure;
      readonly problems?: ReadonlyMap<string, FieldTypesTableProblem>;
    };

/** The cause-less unavailable state: a loader (or a test double) that does not say why. */
export const FIELD_TYPES_UNAVAILABLE: FieldTypes = Object.freeze({ state: "unavailable" });

/** The unavailable state with its cause. */
export function fieldTypesUnavailable(
  cause: FieldTypesReadFailure | undefined,
  problems?: ReadonlyMap<string, FieldTypesTableProblem>
): FieldTypes {
  if (cause === undefined && (problems === undefined || problems.size === 0)) return FIELD_TYPES_UNAVAILABLE;
  return Object.freeze({
    state: "unavailable" as const,
    ...(cause === undefined ? {} : { cause }),
    ...(problems === undefined || problems.size === 0 ? {} : { problems }),
  });
}

/**
 * The hidden-typed fields of `table`, or undefined when `table` could not be
 * resolved (or the types are unavailable). Undefined means unknown: a caller
 * must treat every field of the table as hidden, never as visible.
 */
export function hiddenTypedFields(
  types: FieldTypes,
  table: string
): ReadonlySet<string> | undefined {
  if (types.state !== "available") return undefined;
  return types.tables.get(normalizeName(table) ?? "")?.hiddenNames;
}

/** Resolves a reference field to the table it points at, for dot-walks. */
export type ReferenceResolver = (table: string, field: string) => string | undefined;

/**
 * The verdict for one field path on `table`.
 *
 * A dot-walked path (`caller_id.user_password`) is decided on the table it
 * ends at, for both the type and the credential-table check; each hop's
 * target comes from `referenceTarget`, and a hop it cannot resolve makes the
 * path `unknown_type`, as does a table that is not in `types` (a loader or
 * {@link fieldTypesFromRows} leaves out every table whose chain is not
 * complete). Field policy rejects dot-walked names outright today;
 * this is for tools that read paths from the instance (history, payloads).
 */
export function classifyField(
  types: FieldTypes,
  table: string,
  path: string,
  options: { readonly referenceTarget?: ReferenceResolver } = {}
): FieldVerdict {
  if (types.state !== "available" || typeof path !== "string") return "unknown_type";
  const parts = path.trim().toLowerCase().split(".");
  if (parts.length === 0 || parts.length > MAX_DOT_WALK_HOPS + 1) return "unknown_type";
  if (!parts.every((part) => FIELD_NAME.test(part))) return "unknown_type";
  let current = normalizeName(table);
  for (const hop of parts.slice(0, -1)) {
    if (current === undefined) return "unknown_type";
    const resolved = types.tables.get(current);
    if (resolved === undefined) return "unknown_type";
    // A reference that is itself hidden-typed is never walked through.
    if (resolved.hiddenNames.has(hop)) return "type";
    let next: string | undefined;
    try {
      next = normalizeName(options.referenceTarget?.(current, hop));
    } catch {
      next = undefined;
    }
    current = next;
  }
  if (current === undefined) return "unknown_type";
  const terminal = types.tables.get(current);
  if (terminal === undefined) return "unknown_type";
  const field = parts[parts.length - 1]!;
  if (isCredentialTableHierarchy(terminal.hierarchy)) return "credential_table";
  if (terminal.hiddenNames.has(field)) return "type";
  if (terminal.allTypes !== undefined) {
    const type = terminal.allTypes.get(field);
    if (type === undefined) return "unknown_type";
    if (isHiddenFieldType(type)) return "type";
  }
  return "visible";
}

/** One dictionary row as a caller already read it. */
export interface DictionaryRow {
  /** The table that defines the field (`sys_dictionary.name`). */
  readonly table: string;
  readonly element: string;
  readonly internal_type: string;
}

/**
 * Field types from dictionary rows the caller has already read, so the read
 * stays inside that caller's own declared plan. `hierarchies` maps each table
 * the caller will ask about to its chain (the table first) and whether that
 * chain is complete; a table whose chain is not complete is left unresolved,
 * so every field on it is `unknown_type`. With `complete: true` the rows are
 * every field of those chains, so a field with no row is `unknown_type`;
 * otherwise only hidden-typed rows matter.
 */
export function fieldTypesFromRows(
  rows: Iterable<DictionaryRow>,
  hierarchies: Readonly<Record<string, TableChain>>,
  options: { readonly complete?: boolean } = {}
): FieldTypes {
  const byTable = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const table = normalizeName(row?.table);
    const element = normalizeName(row?.element);
    const type = typeof row?.internal_type === "string" ? row.internal_type.trim().toLowerCase() : "";
    if (table === undefined || element === undefined || type === "") continue;
    let fields = byTable.get(table);
    if (!fields) byTable.set(table, (fields = new Map()));
    if (!fields.has(element)) fields.set(element, type);
  }
  const tables = new Map<string, ResolvedTableTypes>();
  for (const [name, chain] of Object.entries(hierarchies)) {
    const table = normalizeName(name);
    if (table === undefined || chain?.complete !== true || !Array.isArray(chain.tables)) continue;
    const hierarchy = chain.tables.map(normalizeName);
    if (hierarchy.length === 0 || hierarchy.some((entry) => entry === undefined)) {
      continue;
    }
    const all = new Map<string, string>();
    // Nearest definition first: a child's own row overrides an inherited one.
    for (const owner of hierarchy as string[]) {
      for (const [element, type] of byTable.get(owner) ?? []) {
        if (!all.has(element)) all.set(element, type);
      }
    }
    const hidden = new Map([...all].filter(([, type]) => isHiddenFieldType(type)));
    tables.set(
      table,
      resolvedTable(hierarchy as string[], hidden, options.complete === true ? all : undefined)
    );
  }
  return Object.freeze({ state: "available", tables });
}

/**
 * A copy of `record` without the named fields. The whole entry goes, whatever
 * its shape: a plain value, `{value, display_value, link}`, or the
 * `sysparm_display_value=all` pair. A display value is never kept on its own:
 * it is treated as secret as the stored value.
 */
export function withoutFields(
  record: Readonly<Record<string, unknown>>,
  fields: ReadonlySet<string>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (fields.has(key.trim().toLowerCase())) continue;
    Object.defineProperty(output, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}

// ── Row rules ──────────────────────────────────────────────────────

/**
 * A table whose secret is a per-row value: `valueField` is hidden on a row
 * unless that row's `typeField` names a known non-secret type. The dictionary
 * types both columns `string`, so no type rule can see it.
 */
export interface RowValueRule {
  readonly table: string;
  readonly valueField: string;
  readonly typeField: string;
  /** Fields refused as filter, order, group or aggregate fields on the table. */
  readonly queryDenied: ReadonlySet<string>;
  /** Known types whose value is shown, compared without case or spaces. */
  readonly visibleTypes: ReadonlySet<string>;
}

/**
 * `sys_properties`: `value` is shown only for a property whose `type` is one
 * of these. A secret type (`password`, `password2`), an empty or missing type,
 * and any type not listed hide the value. The list is the non-secret choices;
 * an unknown label (another language, a custom type) hides, never shows.
 */
const SYS_PROPERTIES_RULE: RowValueRule = Object.freeze({
  table: "sys_properties",
  valueField: "value",
  typeField: "type",
  queryDenied: Object.freeze(new Set(["value"])) as ReadonlySet<string>,
  visibleTypes: Object.freeze(
    new Set([
      "string",
      "short_string",
      "integer",
      "boolean",
      "true|false",
      "choicelist",
      "color",
      "date_format",
      "time_format",
      "timezone",
      "image",
      "uploaded_image",
    ])
  ) as ReadonlySet<string>,
});

const ROW_RULES: ReadonlyMap<string, RowValueRule> = new Map([
  [SYS_PROPERTIES_RULE.table, SYS_PROPERTIES_RULE],
]);

/** The row rule for `table`, if it has one. */
export function rowValueRule(table: unknown): RowValueRule | undefined {
  const normalized = normalizeName(table);
  return normalized === undefined ? undefined : ROW_RULES.get(normalized);
}

/**
 * True when the rule hides this row's value. The type is read from the row
 * in any display shape: a plain string, or an object's `value` (the stored
 * value of `sysparm_display_value=all`) or else its `display_value`.
 */
export function rowValueHidden(rule: RowValueRule, row: Readonly<Record<string, unknown>>): boolean {
  const type = typeText(row[rule.typeField]);
  if (type === undefined) return true;
  return !rule.visibleTypes.has(type.replace(/\s+/gu, "").toLowerCase());
}

function typeText(candidate: unknown): string | undefined {
  if (typeof candidate === "string") return candidate.trim() === "" ? undefined : candidate;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  for (const key of ["value", "display_value"]) {
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

// ── Extension chains ───────────────────────────────────────────────

/**
 * A table's extension chain as `sys_db_object` gave it, and whether it is
 * known to end there.
 */
export interface TableChain {
  /** The table first, then its ancestors, nearest first. */
  readonly tables: readonly string[];
  /**
   * True only when the last table's parent link came back empty, both the
   * stored reference and the parent's name: that table extends nothing.
   * False when the row is missing, a link or name is absent from the row, a
   * link has no name (the parent's row could not be read), a parent is not a
   * table name, the chain loops, or it is longer than the read covers. An
   * incomplete chain is unknown: the table may extend one that defines a
   * hidden-typed field, or a credential table.
   */
  readonly complete: boolean;
  /**
   * Why the chain is not complete, when it is not: the last table of `tables`
   * is the one the gap is at (its parent, or its own row for `no_row`).
   */
  readonly gap?: ChainGap;
}

/** The stored parent reference of the table `hops` levels up a `sys_db_object` row's chain. */
function parentLinkField(hops: number): string {
  return `${"super_class.".repeat(hops)}super_class`;
}

/** That parent's name, dot-walked. */
function parentNameField(hops: number): string {
  return `${"super_class.".repeat(hops)}super_class.name`;
}

/**
 * The `sys_db_object` fields that give a chain of up to `maxTables` tables in
 * one read of the table's own row: its name, then, for each table of the
 * chain, its stored parent reference and that parent's name (dot-walked).
 * The last table's reference is read without a name, to tell a chain that
 * ends there from one that goes on past the read.
 */
export function tableChainFields(maxTables: number): string[] {
  const fields = ["name"];
  for (let hops = 0; hops < maxTables; hops += 1) {
    fields.push(parentLinkField(hops));
    if (hops < maxTables - 1) fields.push(parentNameField(hops));
  }
  return fields;
}

/**
 * The chain of `table` from its `sys_db_object` row, read with
 * {@link tableChainFields}`(maxTables)`. Only an empty reference with an
 * empty name ends a chain; see {@link TableChain.complete}.
 */
export function tableChainFromRow(
  row: Readonly<Record<string, unknown>>,
  table: string,
  maxTables: number
): TableChain {
  const tables = [table];
  const chain = (complete: boolean, gap?: ChainGap): TableChain =>
    Object.freeze({
      tables: Object.freeze(tables),
      complete,
      ...(complete || gap === undefined ? {} : { gap }),
    });
  for (let hops = 0; hops < maxTables; hops += 1) {
    if (hops === maxTables - 1) {
      // The last table read: its reference alone says whether the chain ends
      // there or goes on past the read.
      const link = fieldText(row, parentLinkField(hops));
      if (link === undefined) return chain(false, "malformed");
      return link.trim() === "" ? chain(true) : chain(false, "too_long");
    }
    const step = parentStepOf(row, parentLinkField(hops), parentNameField(hops));
    if ("gap" in step) return chain(false, step.gap);
    if (step.parent === null) return chain(true);
    // A loop.
    if (tables.includes(step.parent)) return chain(false, "malformed");
    tables.push(step.parent);
  }
  return chain(false, "too_long");
}

/** One parent link of a `sys_db_object` row: the parent's name, `null` when the table extends nothing, or why it is unknown. */
type ParentStep = { readonly parent: string | null } | { readonly gap: ChainGap };

/**
 * One parent link of a `sys_db_object` row: the parent's name, `null` when
 * the table extends nothing, or the gap when the row does not say. Both
 * fields must be present: an absent one is unknown, never empty.
 */
function parentStepOf(
  row: Readonly<Record<string, unknown>>,
  linkField: string,
  nameField: string
): ParentStep {
  const link = fieldText(row, linkField);
  const name = fieldText(row, nameField);
  if (link === undefined || name === undefined) return { gap: "malformed" };
  const linkEmpty = link.trim() === "";
  const parent = name.trim().toLowerCase();
  if (linkEmpty && parent === "") return { parent: null };
  // A name with no reference is unknown.
  if (linkEmpty) return { gap: "malformed" };
  // A reference whose name did not come back: the parent's row is hidden from
  // this account.
  if (parent === "") return { gap: "parent_unreadable" };
  return FIELD_NAME.test(parent) ? { parent } : { gap: "malformed" };
}

/** A field's stored text, or undefined when the row does not carry it as text. */
function fieldText(row: Readonly<Record<string, unknown>>, field: string): string | undefined {
  return Object.hasOwn(row, field) ? storedText(row[field]) : undefined;
}

// ── Loader ─────────────────────────────────────────────────────────

/**
 * How long a loaded map serves without any request. A field that becomes
 * hidden-typed within this window is still hidden by name if its name is
 * sensitive; otherwise it is hidden from the next load. Capped by the
 * profile's metadata-cache TTL.
 */
export const FIELD_TYPES_TTL_MS = 60 * 60 * 1000;
/**
 * How long a refused or cut-short dictionary, or a chain that does not show
 * where it ends, is remembered before it is read again. A transient failure
 * (a timeout, a 5xx, a network error) is never remembered.
 */
export const FIELD_TYPES_UNAVAILABLE_TTL_MS = 30 * 1000;
/** A read that returns this many rows may be cut short, so it is unavailable. */
export const MAX_HIDDEN_DICTIONARY_ROWS = 10_000;
/**
 * The pause before the one retry of a read that timed out, returned a 5xx or
 * failed on the network. Short: the retry is for a blip, not an outage.
 */
export const FIELD_TYPES_RETRY_PAUSE_MS = 300;
/**
 * Order of the instance-wide hidden-type read. The result is parsed into a map
 * and a full page is refused, so the order carries no meaning; it is kept
 * only as the read has always been made.
 */
const HIDDEN_DICTIONARY_ORDER_BY = "^ORDERBYname^ORDERBYelement";
const MAX_HIERARCHY_DEPTH = 12;
const MAX_VIEW_SOURCE_ROWS = 1_000;
const MAX_DOT_WALK_HOPS = 8;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const DICTIONARY_MEMO_KEY = "hidden-values:dictionary:v1";
const TABLE_MEMO_PREFIX = "hidden-values:table:v1:";
const CHAIN_FLIGHT_PREFIX = "hidden-values:chain-read:v1:";
/**
 * The table every chain read also asks for: the row of `sys_db_object`
 * itself. When it comes back, the read could see the table's rows, so a table
 * with no row is absent; when it does not, the read showed this user nothing.
 */
const CHAIN_ANCHOR_TABLE = "sys_db_object";

/** The dictionary: its hidden-typed fields by table, or why it could not be read. */
type DictionaryState =
  | ReadonlyMap<string, ReadonlyMap<string, string>>
  | { readonly unavailable: FieldTypesReadFailure | undefined };

function dictionaryUnavailable(cause?: FieldTypesReadFailure): DictionaryState {
  return Object.freeze({ unavailable: cause });
}

/** What the dictionary memo keeps for a refusal or a full page: the cause, for 30 seconds. */
function isKeptUnavailable(candidate: unknown): candidate is { readonly unavailable: FieldTypesReadFailure } {
  if (typeof candidate !== "object" || candidate === null || candidate instanceof Map) return false;
  const cause = (candidate as { unavailable?: unknown }).unavailable;
  return isReadFailure(cause) && (cause.kind === "refused" || cause.kind === "incomplete");
}

function isReadFailure(candidate: unknown): candidate is FieldTypesReadFailure {
  if (typeof candidate !== "object" || candidate === null) return false;
  const kind = (candidate as { kind?: unknown }).kind;
  return kind === "policy" || kind === "refused" || kind === "transient" || kind === "incomplete" || kind === "failed";
}

/**
 * What the chain read found for a table: a complete chain; `null` for no
 * `sys_db_object` row when the read showed rows (its anchor came back);
 * an incomplete one, with where it stops and why; "unconfirmed" for no row
 * when the anchor did not come back either; or that the read itself failed.
 */
type ChainState =
  | readonly string[]
  | null
  | { readonly kind: "incomplete"; readonly at: string; readonly gap: ChainGap }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "failed"; readonly failure: FieldTypesReadFailure };

type IncompleteChainState = Extract<ChainState, { kind: "incomplete" }>;

function isKnownChain(chain: ChainState | undefined): chain is readonly string[] {
  return Array.isArray(chain);
}

/** No row, whether or not the anchor came back: a view may still be behind the name. */
function hasNoRow(chain: ChainState | undefined): boolean {
  return chain === null || (chain !== undefined && !Array.isArray(chain) && (chain as { kind?: string }).kind === "unconfirmed");
}

function incompleteChain(chain: ChainState | undefined): IncompleteChainState | undefined {
  return chain !== undefined && chain !== null && !Array.isArray(chain) && (chain as { kind?: string }).kind === "incomplete"
    ? (chain as IncompleteChainState)
    : undefined;
}

export interface LoadFieldTypesOptions {
  /** Refresh the memo and the metadata cache behind it. */
  readonly forceRecache?: boolean;
}

/** The shape of {@link loadFieldTypes}, for an injected test double. */
export type FieldTypeLoader = (
  client: ServiceNowOperations,
  tables: Iterable<string>,
  options?: LoadFieldTypesOptions
) => Promise<FieldTypes>;

// ── Reading failures ───────────────────────────────────────────────

/** Errors whose read was tried twice: the classifier then says so. */
const RETRIED_ERRORS = new WeakSet<object>();

/**
 * Say why a metadata read threw, from what only this server issued: the
 * trusted error category and reason, and the HTTP status the client recorded.
 * No message or text of the error is read. A cancellation is not a failure to
 * classify: callers rethrow it before they get here.
 */
export function classifyReadFailure(error: unknown): FieldTypesReadFailure {
  const descriptor = trustedToolErrorDescriptor(error);
  const status = trustedHttpStatus(error);
  if (descriptor === undefined) return Object.freeze({ kind: "failed" as const });
  const retried = typeof error === "object" && error !== null && RETRIED_ERRORS.has(error);
  const transient = (extra: { status?: number; timeout?: true }): FieldTypesReadFailure =>
    Object.freeze({ kind: "transient" as const, ...extra, ...(retried ? { retried: true as const } : {}) });
  switch (descriptor.category) {
    case "authentication":
      return Object.freeze({ kind: "refused" as const, status: status ?? 401 });
    case "authorization":
      return Object.freeze({ kind: "refused" as const, status: status ?? 403 });
    case "timeout":
      return transient({ timeout: true });
    case "rate_limit":
      return transient({ status: status ?? 429 });
    case "upstream":
      if (descriptor.reason === "instance_hibernating") return transient({});
      if (descriptor.reason !== undefined) return Object.freeze({ kind: "failed" as const, ...(status === undefined ? {} : { status }) });
      if (status === undefined) return transient({});
      return status >= 500 ? transient({ status }) : Object.freeze({ kind: "failed" as const, status });
    default:
      return Object.freeze({ kind: "failed" as const, ...(status === undefined ? {} : { status }) });
  }
}

/**
 * A read worth one more try: it timed out, returned a 5xx, or failed on the
 * network. Not a 429 (the client already waits for its Retry-After), not a
 * hibernating instance, and nothing a retry cannot change (a refusal, a 4xx).
 */
function isRetryableFailure(error: unknown): boolean {
  const failure = classifyReadFailure(error);
  if (failure.kind !== "transient") return false;
  if (trustedToolErrorDescriptor(error)?.reason === "instance_hibernating") return false;
  return failure.timeout === true || failure.status === undefined || failure.status >= 500;
}

/** One retry shared by several reads of a kind in one lookup. */
export interface FieldTypesRetryBudget {
  spent: boolean;
}

export interface RetryTransientOptions {
  /** The call's signal; default the running call's. An aborted signal skips the retry. */
  readonly signal?: AbortSignal | undefined;
  /** Pause before the retry; default {@link FIELD_TYPES_RETRY_PAUSE_MS}. */
  readonly pauseMs?: number;
  /** When given, the retry is made only once for every read sharing it. */
  readonly budget?: FieldTypesRetryBudget;
}

/**
 * Run `read`; if it fails the way a blip fails (a timeout, a 5xx, a network
 * error: see {@link isRetryableFailure}), wait a short pause and run it once
 * more. A cancellation, an aborted signal, a 429 and any 4xx are never
 * retried, and a cancellation during the pause rethrows.
 *
 * The retry sits inside a single-flight read, so concurrent waiters share one
 * retry. Worst case for one read is two attempts of the client's timeout plus
 * the pause, inside the call's signal: the call's own deadline aborts it, so a
 * retry never outlives the call.
 */
export async function retryTransientOnce<T>(
  read: () => Promise<T>,
  options: RetryTransientOptions = {}
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const signal = options.signal ?? currentServiceNowRequestSignal();
    if (isServiceNowRequestCancellation(error) || signal?.aborted === true) throw error;
    if (options.budget?.spent === true || !isRetryableFailure(error)) throw error;
    if (options.budget !== undefined) options.budget.spent = true;
    await pauseUnlessServiceNowRequestCancelled(options.pauseMs ?? FIELD_TYPES_RETRY_PAUSE_MS, signal);
    try {
      return await read();
    } catch (second) {
      if (typeof second === "object" && second !== null) RETRIED_ERRORS.add(second);
      throw second;
    }
  }
}

/**
 * Resolve the hidden-typed fields of every table in `tables`.
 *
 * Requests, made with the call's own credentials and no table grant (the
 * implicit metadata path the all-fields projection uses): one instance-wide
 * `sys_dictionary` read of the hidden types, one `sys_db_object` read for the
 * chains of all the tables not yet known (it also asks for `sys_db_object`'s
 * own row, to tell a table that does not exist from a read that showed
 * nothing), and, only for a name with no `sys_db_object` row, one
 * `sys_db_view_table` read (plus the joined tables' chains). Each result is
 * kept in the metadata cache's per-credential memo (`derivedMetadataMemo`), so
 * a later call that finds everything there makes no request at all; the reads
 * skip the cache's watermark, since the memo is their cache. The dictionary
 * and chain reads run in parallel, and concurrent calls in one scope share
 * each read in flight (one per key). `forceRecache` skips the memo.
 *
 * A dictionary read that fails, returns no rows, or returns a full page gives
 * `unavailable`, with the cause ({@link FieldTypesReadFailure}). A timeout, a
 * 5xx or a network error is read once more after a short pause
 * ({@link retryTransientOnce}) and is never remembered; a refusal or a full
 * page is remembered for {@link FIELD_TYPES_UNAVAILABLE_TTL_MS}, with its
 * cause. A table whose chain or view cannot be resolved is left out of
 * `tables`, so its fields are `unknown_type`, and `problems` says why: it does
 * not exist, its chain is not complete ({@link TableChain}, such as a parent
 * reference whose name did not come back, or a chain longer than 12 tables),
 * or the read failed. A complete chain is kept in the memo for the hour; an
 * incomplete one for {@link FIELD_TYPES_UNAVAILABLE_TTL_MS}, so a table whose
 * parent cannot be read is not read again on every call. A cancelled read
 * rethrows.
 */
export async function loadFieldTypes(
  client: ServiceNowOperations,
  tablesCandidate: Iterable<string>,
  options: LoadFieldTypesOptions = {}
): Promise<FieldTypes> {
  const memo = derivedMetadataMemo(client);
  const force = options.forceRecache === true;
  // The memo is the cache for these reads. Through the metadata cache each
  // would also cost a watermark read, and a sys_dictionary watermark costs
  // more than the plain read (see SMALL_READ_BYTES), so they go straight up.
  const reader = uncachedOperations(client);

  const requested = [...new Set([...tablesCandidate].map(normalizeName))].filter(
    (name): name is string => name !== undefined
  );
  const chains = new Map<string, ChainState>();
  const views = new Map<string, readonly ViewSource[]>();
  const remember = (table: string, entry: TableShape) =>
    memo?.set(
      TABLE_MEMO_PREFIX + table,
      entry,
      128 + JSON.stringify(entry).length,
      entry.kind === "incomplete" ? FIELD_TYPES_UNAVAILABLE_TTL_MS : FIELD_TYPES_TTL_MS
    );
  /** What a read found for `table`, kept: a complete chain for the hour, an incomplete one briefly. */
  const rememberChain = (table: string, chain: ChainState) => {
    if (isKnownChain(chain)) remember(table, Object.freeze({ kind: "table", chain }));
    else {
      const incomplete = incompleteChain(chain);
      if (incomplete !== undefined) {
        remember(table, Object.freeze({ kind: "incomplete", at: incomplete.at, gap: incomplete.gap }));
      }
    }
  };
  const recall = (table: string): boolean => {
    const known = force ? undefined : memo?.get(TABLE_MEMO_PREFIX + table);
    if (!isTableShape(known)) return false;
    if (known.kind === "table") chains.set(table, known.chain);
    else if (known.kind === "incomplete") chains.set(table, Object.freeze({ kind: "incomplete", at: known.at, gap: known.gap }));
    else {
      chains.set(table, null);
      views.set(table, known.sources);
    }
    return true;
  };

  // One retry of the sys_db_object read for the whole lookup, however many
  // reads (the tables', then a view's joined tables') it makes.
  const chainRetry: FieldTypesRetryBudget = { spent: false };
  const pending = requested.filter((table) => !recall(table));
  // The dictionary and the chains do not depend on each other: one round trip.
  const [dictionary, read] = await Promise.all([
    hiddenDictionary(reader, memo, force),
    pending.length === 0
      ? Promise.resolve(new Map<string, ChainState>())
      : sharedChains(reader, memo, pending, chainRetry),
  ]);
  if (!(dictionary instanceof Map)) {
    return fieldTypesUnavailable((dictionary as { unavailable: FieldTypesReadFailure | undefined }).unavailable);
  }
  let viewFailure: FieldTypesReadFailure | undefined;
  const brokenViews = new Set<string>();
  if (pending.length > 0) {
    for (const [table, chain] of read) {
      chains.set(table, chain);
      rememberChain(table, chain);
    }
    const absent = pending.filter((table) => hasNoRow(read.get(table)));
    if (absent.length > 0) {
      const found = await viewSources(reader, absent);
      viewFailure = found.failure;
      for (const view of found.broken) brokenViews.add(view);
      for (const [view, sources] of found.views) {
        views.set(view, sources);
        remember(view, Object.freeze({ kind: "view", sources: Object.freeze(sources) }));
      }
    }
  }
  // The tables joined by a view need their own chains.
  const joined = [...new Set([...views.values()].flat().map((source) => source.table))].filter(
    (table) => !chains.has(table) && !recall(table)
  );
  if (joined.length > 0) {
    for (const [table, chain] of await sharedChains(reader, memo, joined, chainRetry)) {
      chains.set(table, chain);
      rememberChain(table, chain);
    }
  }

  const tables = new Map<string, ResolvedTableTypes>();
  const problems = new Map<string, FieldTypesTableProblem>();
  for (const table of requested) {
    const resolved = resolveTable(table, chains, views, dictionary);
    if (resolved !== undefined) {
      tables.set(table, resolved);
      continue;
    }
    problems.set(table, problemOf(table, chains, views, viewFailure, brokenViews));
  }
  return Object.freeze({
    state: "available",
    tables,
    ...(problems.size === 0 ? {} : { problems }),
  });
}

/** Why `table` did not resolve, from what the lookup read. */
function problemOf(
  table: string,
  chains: ReadonlyMap<string, ChainState>,
  views: ReadonlyMap<string, readonly ViewSource[]>,
  viewFailure: FieldTypesReadFailure | undefined,
  brokenViews: ReadonlySet<string>
): FieldTypesTableProblem {
  const chain = chains.get(table);
  if (chain === undefined) return Object.freeze({ kind: "read", failure: Object.freeze({ kind: "failed" }) });
  if (!Array.isArray(chain) && chain !== null) {
    const state = chain as Exclude<ChainState, readonly string[] | null>;
    if (state.kind === "failed") return Object.freeze({ kind: "read", failure: state.failure });
    if (state.kind === "incomplete") return Object.freeze({ kind: "chain", at: state.at, gap: state.gap });
  }
  if (Array.isArray(chain)) {
    // A complete chain always resolves.
    return Object.freeze({ kind: "read", failure: Object.freeze({ kind: "failed" }) });
  }
  // No sys_db_object row: only a database view resolves.
  const sources = views.get(table);
  if (sources !== undefined && sources.length > 0) {
    for (const source of sources) {
      const sourceChain = chains.get(source.table);
      if (isKnownChain(sourceChain)) continue;
      const incomplete = incompleteChain(sourceChain);
      if (incomplete !== undefined) return Object.freeze({ kind: "chain", at: incomplete.at, gap: incomplete.gap });
      if (sourceChain !== undefined && sourceChain !== null && (sourceChain as { kind?: string }).kind === "failed") {
        return Object.freeze({ kind: "read", failure: (sourceChain as { failure: FieldTypesReadFailure }).failure });
      }
      return Object.freeze({ kind: "chain", at: source.table, gap: "no_row" });
    }
    return Object.freeze({ kind: "read", failure: Object.freeze({ kind: "failed" }) });
  }
  if (brokenViews.has(table)) {
    return Object.freeze({ kind: "read", read: "sys_db_view_table", failure: Object.freeze({ kind: "failed" }) });
  }
  if (viewFailure !== undefined) return Object.freeze({ kind: "read", read: "sys_db_view_table", failure: viewFailure });
  // The read showed rows and found neither a table nor a view of this name.
  if (chain === null) return Object.freeze({ kind: "not_found" });
  return Object.freeze({
    kind: "read",
    read: "sys_db_object",
    failure: Object.freeze({ kind: "refused", status: 200 }),
  });
}

/**
 * What the memo keeps per table: its complete chain, a view's joined tables,
 * or, for {@link FIELD_TYPES_UNAVAILABLE_TTL_MS} only, where its chain stopped
 * and why (the table stays unresolved until the entry expires).
 */
type TableShape =
  | { readonly kind: "table"; readonly chain: readonly string[] }
  | { readonly kind: "view"; readonly sources: readonly ViewSource[] }
  | { readonly kind: "incomplete"; readonly at: string; readonly gap: ChainGap };

const CHAIN_GAPS: ReadonlySet<string> = new Set(["parent_unreadable", "too_long", "malformed", "no_row"]);

function isTableShape(candidate: unknown): candidate is TableShape {
  if (typeof candidate !== "object" || candidate === null) return false;
  const shape = candidate as Partial<Record<string, unknown>>;
  return (
    (shape.kind === "table" && Array.isArray(shape.chain)) ||
    (shape.kind === "view" && Array.isArray(shape.sources)) ||
    (shape.kind === "incomplete" &&
      typeof shape.at === "string" &&
      FIELD_NAME.test(shape.at) &&
      typeof shape.gap === "string" &&
      CHAIN_GAPS.has(shape.gap))
  );
}

interface ViewSource {
  readonly table: string;
  readonly prefix: string;
}

function resolveTable(
  table: string,
  chains: ReadonlyMap<string, ChainState | undefined>,
  views: ReadonlyMap<string, readonly ViewSource[]>,
  dictionary: ReadonlyMap<string, ReadonlyMap<string, string>>
): ResolvedTableTypes | undefined {
  const chain = chains.get(table);
  if (isKnownChain(chain)) return resolvedTable(chain, inheritedHidden(chain, dictionary));
  // Only a table with no sys_db_object row can be a database view; a view
  // column is `<prefix>_<field>` of the table joined under that prefix.
  if (!hasNoRow(chain)) return undefined;
  const sources = views.get(table);
  if (sources === undefined || sources.length === 0) return undefined;
  const hidden = new Map<string, string>();
  const hierarchy = [table];
  const viewSources: ViewColumnSource[] = [];
  for (const source of sources) {
    const sourceChain = chains.get(source.table);
    if (!isKnownChain(sourceChain)) return undefined;
    hierarchy.push(...sourceChain.filter((entry) => !hierarchy.includes(entry)));
    viewSources.push(Object.freeze({ prefix: source.prefix, hierarchy: Object.freeze([...sourceChain]) }));
    for (const [element, type] of inheritedHidden(sourceChain, dictionary)) {
      const column = `${source.prefix}_${element}`;
      if (FIELD_NAME.test(column)) hidden.set(column, type);
    }
  }
  return resolvedTable(hierarchy, hidden, undefined, viewSources);
}

function inheritedHidden(
  chain: readonly string[],
  dictionary: ReadonlyMap<string, ReadonlyMap<string, string>>
): Map<string, string> {
  const hidden = new Map<string, string>();
  for (const owner of chain) {
    for (const [element, type] of dictionary.get(owner) ?? []) {
      if (!hidden.has(element)) hidden.set(element, type);
    }
  }
  return hidden;
}

function resolvedTable(
  hierarchy: readonly string[],
  hidden: ReadonlyMap<string, string>,
  allTypes?: ReadonlyMap<string, string>,
  viewSources?: readonly ViewColumnSource[]
): ResolvedTableTypes {
  return Object.freeze({
    hierarchy: Object.freeze([...hierarchy]),
    hidden,
    hiddenNames: new Set(hidden.keys()) as ReadonlySet<string>,
    ...(allTypes === undefined ? {} : { allTypes }),
    ...(viewSources === undefined ? {} : { viewSources: Object.freeze([...viewSources]) }),
  });
}

/**
 * The instance-wide map of hidden-typed fields, by defining table. The same
 * implicit metadata read the all-fields projection makes (`sys_dictionary`
 * through the call's cached operations), so it needs no table grant.
 */
async function hiddenDictionary(
  client: ServiceNowOperations,
  memo: Memo,
  force: boolean
): Promise<DictionaryState> {
  const known = force ? undefined : memo?.get(DICTIONARY_MEMO_KEY);
  if (known instanceof Map) return known as DictionaryState;
  // A refusal or a full page kept 30 seconds, with its cause (an older entry
  // without one reads as no cause).
  if (isKeptUnavailable(known)) return known;
  if (known === "unavailable") return dictionaryUnavailable();
  return singleFlight(memo, DICTIONARY_MEMO_KEY, () => readDictionary(client, memo));
}

type Memo = ReturnType<typeof derivedMetadataMemo>;

/**
 * Run `start` once for every concurrent caller in the credential scope: a
 * caller that finds the same key in flight waits for that read instead of
 * making its own. Neither read here rejects for an instance's answer (a
 * refusal or an error is the `unavailable` state, which every waiter gets);
 * only a cancelled read rejects, and then the cancellation was the reading
 * call's own, so a waiter reads for itself instead of failing.
 */
async function singleFlight<T>(memo: Memo, key: string, start: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = memo?.pending(key) as Promise<T> | undefined;
    if (pending === undefined) break;
    try {
      return await pending;
    } catch {
      // The reading call was cancelled; look again, or read.
    }
  }
  const promise = start();
  return memo === undefined ? promise : memo.track(key, promise);
}

/**
 * {@link tableChains} with one read in flight per table across concurrent
 * calls: tables another call is reading are waited for, the rest are read
 * together in one request.
 */
async function sharedChains(
  client: ServiceNowOperations,
  memo: Memo,
  tables: readonly string[],
  retry: FieldTypesRetryBudget
): Promise<Map<string, ChainState>> {
  const waiting: Array<[string, Promise<ChainState | undefined>]> = [];
  const own: string[] = [];
  for (const table of tables) {
    const pending = memo?.pending(CHAIN_FLIGHT_PREFIX + table) as Promise<ChainState | undefined> | undefined;
    if (pending === undefined) own.push(table);
    else waiting.push([table, pending]);
  }
  const chains = new Map<string, ChainState>();
  if (own.length > 0) {
    const batch = tableChains(client, own, retry);
    for (const table of own) {
      memo?.track(CHAIN_FLIGHT_PREFIX + table, batch.then((read) => read.get(table)));
    }
    for (const [table, chain] of await batch) chains.set(table, chain);
  }
  const rereads: string[] = [];
  for (const [table, pending] of waiting) {
    try {
      const chain = await pending;
      if (chain !== undefined) chains.set(table, chain);
    } catch {
      rereads.push(table);
    }
  }
  if (rereads.length > 0) {
    for (const [table, chain] of await tableChains(client, rereads, retry)) chains.set(table, chain);
  }
  return chains;
}

/** The failure to keep for a dictionary read that gave no map, and whether it is kept 30 seconds. */
function rememberedUnavailable(failure: FieldTypesReadFailure): boolean {
  return failure.kind === "refused" || failure.kind === "incomplete";
}

async function readDictionary(client: ServiceNowOperations, memo: Memo): Promise<DictionaryState> {
  const unavailable = (failure: FieldTypesReadFailure): DictionaryState => {
    // A refusal or a full page does not change in a moment: kept briefly, with
    // its cause. A transient failure or any other is read again on the next call.
    if (rememberedUnavailable(failure)) {
      memo?.set(DICTIONARY_MEMO_KEY, Object.freeze({ unavailable: failure }), 96, FIELD_TYPES_UNAVAILABLE_TTL_MS);
    }
    return dictionaryUnavailable(failure);
  };
  let rows: unknown;
  try {
    const response = await retryTransientOnce(() =>
      client.getWithMeta<{ result?: unknown }>("/api/now/table/sys_dictionary", {
        sysparm_query: `internal_typeIN${HIDDEN_FIELD_TYPES.join(",")}${HIDDEN_DICTIONARY_ORDER_BY}`,
        sysparm_fields: "name,element,internal_type",
        sysparm_limit: String(MAX_HIDDEN_DICTIONARY_ROWS),
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      })
    );
    if (response.status !== 200) return unavailable(failedStatus(response.status));
    rows = response.data?.result;
  } catch (error) {
    if (isServiceNowRequestCancellation(error)) throw error;
    return unavailable(classifyReadFailure(error));
  }
  const parsed = parseDictionaryRows(rows);
  if (!(parsed instanceof Map)) {
    const cause = (parsed as { unavailable: FieldTypesReadFailure | undefined }).unavailable;
    return unavailable(cause ?? Object.freeze({ kind: "failed" }));
  }
  let bytes = 256;
  for (const [table, fields] of parsed) {
    bytes += table.length + 64;
    for (const [element, type] of fields) bytes += element.length + type.length + 32;
  }
  memo?.set(DICTIONARY_MEMO_KEY, parsed, bytes, FIELD_TYPES_TTL_MS);
  return parsed;
}

/** A response that was not a 200 and not an error: the status, when it is one. */
function failedStatus(status: unknown): FieldTypesReadFailure {
  return Object.freeze({
    kind: "failed" as const,
    ...(validStatus(status) ? { status } : {}),
  });
}

/**
 * Rows to a frozen map. No rows at all means the rows were hidden from this
 * user (every instance has hidden-typed fields, `sys_user.user_password`
 * among them), and a full page may be cut short: both are unavailable.
 */
function parseDictionaryRows(rows: unknown): DictionaryState {
  if (!Array.isArray(rows)) return dictionaryUnavailable(Object.freeze({ kind: "failed" }));
  if (rows.length === 0) return dictionaryUnavailable(NO_ROWS_READABLE);
  if (rows.length >= MAX_HIDDEN_DICTIONARY_ROWS) return dictionaryUnavailable(Object.freeze({ kind: "incomplete" }));
  const byTable = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const table = normalizeName(storedText(record.name));
    const element = normalizeName(storedText(record.element));
    const type = storedText(record.internal_type)?.trim().toLowerCase();
    if (table === undefined || element === undefined || !isHiddenFieldType(type)) continue;
    let fields = byTable.get(table);
    if (!fields) byTable.set(table, (fields = new Map()));
    fields.set(element, type!);
  }
  if (byTable.size === 0) return dictionaryUnavailable(NO_ROWS_READABLE);
  return byTable;
}

/** HTTP 200 with no row this user can read: the instance hides the table's rows from them. */
const NO_ROWS_READABLE: FieldTypesReadFailure = Object.freeze({ kind: "refused", status: 200 });

/**
 * Chains for `tables`, in one read of their own `sys_db_object` rows with the
 * stored parent references and the parents' names up to 12 tables, and, in the
 * same request, the row of `sys_db_object` itself (one more row). Every table
 * is in the map: a read that failed says so for all of them, and a table with
 * no row is `null` when the anchor row came back, otherwise unconfirmed.
 */
async function tableChains(
  client: ServiceNowOperations,
  tables: readonly string[],
  retry: FieldTypesRetryBudget
): Promise<Map<string, ChainState>> {
  const chains = new Map<string, ChainState>();
  const failAll = (failure: FieldTypesReadFailure) => {
    const state: ChainState = Object.freeze({ kind: "failed", failure });
    for (const table of tables) chains.set(table, state);
    return chains;
  };
  const anchored = !tables.includes(CHAIN_ANCHOR_TABLE);
  let rows: unknown;
  try {
    const response = await retryTransientOnce(
      () =>
        client.getWithMeta<{ result?: unknown }>("/api/now/table/sys_db_object", {
          sysparm_query: `nameIN${[...tables, ...(anchored ? [CHAIN_ANCHOR_TABLE] : [])].join(",")}`,
          sysparm_fields: tableChainFields(MAX_HIERARCHY_DEPTH).join(","),
          sysparm_limit: String(tables.length + (anchored ? 1 : 0)),
          sysparm_display_value: "false",
          sysparm_exclude_reference_link: "true",
        }),
      { budget: retry }
    );
    if (response.status !== 200) return failAll(failedStatus(response.status));
    rows = response.data?.result;
  } catch (error) {
    if (isServiceNowRequestCancellation(error)) throw error;
    return failAll(classifyReadFailure(error));
  }
  if (!Array.isArray(rows)) return failAll(Object.freeze({ kind: "failed" }));
  let anchorSeen = false;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const table = normalizeName(storedText(record.name));
    if (table === CHAIN_ANCHOR_TABLE) anchorSeen = true;
    if (table === undefined || !tables.includes(table)) continue;
    const chain = tableChainFromRow(record, table, MAX_HIERARCHY_DEPTH);
    chains.set(
      table,
      chain.complete
        ? chain.tables
        : Object.freeze({
            kind: "incomplete" as const,
            at: chain.tables[chain.tables.length - 1] ?? table,
            gap: chain.gap ?? "malformed",
          })
    );
  }
  // The read succeeded: a table it did not return has no sys_db_object row.
  const absent: ChainState = anchorSeen ? null : Object.freeze({ kind: "unconfirmed" as const });
  for (const table of tables) if (!chains.has(table)) chains.set(table, absent);
  return chains;
}

/**
 * Joined tables of the database views among `tables`. A view with no row, or
 * whose read did not complete, is left out, with `failure` saying why when the
 * read itself failed and `broken` naming a view with a joined table that has
 * no name or prefix.
 */
async function viewSources(
  client: ServiceNowOperations,
  tables: readonly string[]
): Promise<{
  readonly views: Map<string, ViewSource[]>;
  readonly broken: ReadonlySet<string>;
  readonly failure?: FieldTypesReadFailure;
}> {
  const views = new Map<string, ViewSource[]>();
  const broken = new Set<string>();
  let rows: unknown;
  try {
    const response = await client.getWithMeta<{ result?: unknown }>("/api/now/table/sys_db_view_table", {
      sysparm_query: `view.nameIN${tables.join(",")}`,
      sysparm_fields: "view.name,table,variable_prefix",
      sysparm_limit: String(MAX_VIEW_SOURCE_ROWS),
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
    });
    if (response.status !== 200) return { views, broken, failure: failedStatus(response.status) };
    rows = response.data?.result;
  } catch (error) {
    if (isServiceNowRequestCancellation(error)) throw error;
    return { views, broken, failure: classifyReadFailure(error) };
  }
  if (!Array.isArray(rows)) return { views, broken, failure: Object.freeze({ kind: "failed" }) };
  if (rows.length >= MAX_VIEW_SOURCE_ROWS) return { views, broken, failure: Object.freeze({ kind: "incomplete" }) };
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const view = normalizeName(storedText(record["view.name"]));
    if (view === undefined || !tables.includes(view)) continue;
    const table = normalizeName(storedText(record.table));
    const prefix = normalizeName(storedText(record.variable_prefix));
    // A joined table without a name or prefix cannot be projected: the view
    // stays unresolved rather than missing that table's hidden fields.
    if (table === undefined || prefix === undefined) {
      broken.add(view);
      continue;
    }
    let sources = views.get(view);
    if (!sources) views.set(view, (sources = []));
    sources.push(Object.freeze({ table, prefix }));
  }
  for (const view of broken) views.delete(view);
  return { views, broken };
}

// ── Plan-bounded loader ────────────────────────────────────────────

/**
 * The fields {@link loadFieldTypesInPlan} reads, by table. A tool that calls
 * it declares both tables in its access plan with at least these fields.
 */
export const PLAN_FIELD_TYPE_FIELDS: Readonly<Record<"sys_db_object" | "sys_dictionary", readonly string[]>> =
  Object.freeze({
    sys_db_object: Object.freeze(["name", "super_class"]),
    sys_dictionary: Object.freeze(["name", "element", "internal_type"]),
  });

/** The one dot-walk {@link loadFieldTypesInPlan} makes: a table's parent's name, one hop, into the same table. */
export const PLAN_FIELD_TYPE_DOT_WALKS = Object.freeze([
  Object.freeze({ from: "sys_db_object", field: "super_class", target: "sys_db_object" }),
]);

/** `sys_db_object` levels read per call, at most: the dispatcher's 12-table chain. */
export const PLAN_CHAIN_LEVELS = 12;
/** Tables in one chain, at most; a longer chain is incomplete. */
const PLAN_CHAIN_TABLES = 16;
const PLAN_PARENT_LINK = "super_class";
const PLAN_PARENT_NAME = "super_class.name";
/** The base table of all metadata, which extends nothing: never read. */
const PLAN_METADATA_ROOT = "sys_metadata";

/** A table's chain as the plan-bounded loader read it. */
export type PlanTableChain = TableChain;

/** What {@link loadFieldTypesInPlan} returns. */
export interface PlanFieldTypes {
  /**
   * The hidden-typed fields of every requested table whose chain is complete.
   * `unavailable` when the dictionary was not read, failed, returned no
   * hidden-typed row or a full page; a requested table with an incomplete or
   * unknown chain has no entry (every field on it is `unknown_type`).
   */
  readonly types: FieldTypes;
  /**
   * Each requested table that `sys_db_object` returned a row for, with its
   * chain. A table missing here has no row, or was not read.
   */
  readonly chains: ReadonlyMap<string, PlanTableChain>;
  /** False when a chain read was skipped, failed, or ran out of levels. */
  readonly hierarchyRead: boolean;
  /** Why `types` is unavailable, when the loader knows. */
  readonly typesFailure?: FieldTypesReadFailure;
  /**
   * Why a chain read gave no answer: skipped by field policy, failed, or (for
   * a read that came back without any `sys_db_object` row, its own included)
   * showed this user nothing. Not set for a chain that only ran out of levels,
   * which {@link PlanTableChain.gap} says.
   */
  readonly chainsFailure?: FieldTypesReadFailure;
  /**
   * Requested tables `sys_db_object` has no row for. Set only when the same
   * read returned `sys_db_object`'s own row, so the read could see rows: the
   * table does not exist (or is a database view, which this loader leaves
   * unresolved).
   */
  readonly missing?: ReadonlySet<string>;
}

export interface LoadFieldTypesInPlanOptions {
  /** Read `sys_db_object` (default true). False when field policy hides its fields. */
  readonly readChains?: boolean;
  /** Read `sys_dictionary` (default true). False when field policy hides its fields. */
  readonly readTypes?: boolean;
  /** `sys_db_object` levels to read, at most {@link PLAN_CHAIN_LEVELS}. */
  readonly maxLevels?: number;
  /**
   * Each dictionary row before it is read, for the caller's field policy (a
   * field it drops reads as missing). Not applied to `sys_db_object` rows,
   * whose parent column is a dot-walk.
   */
  readonly filterDictionaryRow?: (row: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  /** The call's signal: an error after it aborted is a cancellation, and rethrows. */
  readonly signal?: AbortSignal;
}

/** A table's parent as the plan-bounded loader read it: its name, `null` for none, or why it is unknown. */
type PlanParent = string | null | { readonly gap: ChainGap };

/**
 * Field types for `tables`, read only from tables a tool can declare in its
 * own plan: `sys_db_object` one level per read (the stored `super_class`
 * reference, and the parent's name as a one-hop dot-walk,
 * {@link PLAN_FIELD_TYPE_DOT_WALKS}) and one instance-wide `sys_dictionary`
 * read of the hidden types. The two run in parallel. A chain ends only at a
 * row whose reference and parent name are both empty; a reference whose name
 * did not come back leaves the chain incomplete ({@link TableChain}).
 *
 * Unlike {@link loadFieldTypes} it never reads `sys_db_view_table` and keeps
 * nothing in the memo: a database view (no `sys_db_object` row) stays
 * unresolved, so every field on it is `unknown_type`. Otherwise the answer
 * has the same semantics:
 * - only rows of a hidden type ({@link isHiddenFieldType}) count, so a child's
 *   row of another type never un-hides an inherited hidden field;
 * - a dictionary read that fails, is not 200, returns no hidden-typed row or
 *   returns a full page gives `unavailable`;
 * - a table whose chain is unknown or incomplete is left out of `types`.
 *
 * A read that times out, returns a 5xx or fails on the network is read once
 * more after a short pause ({@link retryTransientOnce}): once for the
 * dictionary, and once shared by all the levels of the chain read. The first
 * level also asks for `sys_db_object`'s own row, to tell a table that does not
 * exist from a read that showed nothing. A chain read that fails keeps the
 * levels read before it, and sets `hierarchyRead` false. A cancelled read
 * rethrows.
 */
export async function loadFieldTypesInPlan(
  client: ServiceNowOperations,
  tablesCandidate: Iterable<string>,
  options: LoadFieldTypesInPlanOptions = {}
): Promise<PlanFieldTypes> {
  const tables = [...new Set([...tablesCandidate].map(normalizeName))].filter(
    (name): name is string => name !== undefined
  );
  const maxLevels = Math.max(0, Math.min(options.maxLevels ?? PLAN_CHAIN_LEVELS, PLAN_CHAIN_LEVELS));
  const cancelled = (error: unknown) => options.signal?.aborted === true || isServiceNowRequestCancellation(error);
  /** Table -> its parent: null when it extends nothing, a gap when the row named no usable parent. */
  const parents = new Map<string, PlanParent>([[PLAN_METADATA_ROOT, null]]);
  /** Tables whose row was never asked for because the levels ran out. */
  const unread = new Set<string>();
  const missing = new Set<string>();
  let hierarchyRead = true;
  let dictionaryRows: DictionaryRow[] | undefined;
  let typesFailure: FieldTypesReadFailure | undefined;
  let chainsFailure: FieldTypesReadFailure | undefined;
  const retryOptions = { signal: options.signal };

  const readChains = async (): Promise<void> => {
    if (options.readChains === false) {
      hierarchyRead = false;
      chainsFailure = Object.freeze({ kind: "policy", table: "sys_db_object" });
      return;
    }
    // One retry for every level of the chain read.
    const budget: FieldTypesRetryBudget = { spent: false };
    let pending = tables.filter((table) => !parents.has(table));
    for (let level = 0; pending.length > 0; level += 1) {
      if (level >= maxLevels) {
        hierarchyRead = false;
        for (const table of pending) unread.add(table);
        return;
      }
      // The first level also asks for sys_db_object's own row: when it comes
      // back, a table with no row does not exist.
      const anchored = level === 0 && !pending.includes(CHAIN_ANCHOR_TABLE);
      const asked = anchored ? [...pending, CHAIN_ANCHOR_TABLE] : pending;
      const response = await retryTransientOnce(
        () =>
          client.get("/api/now/table/sys_db_object", {
            sysparm_query: `nameIN${asked.join(",")}`,
            sysparm_fields: ["name", PLAN_PARENT_LINK, PLAN_PARENT_NAME].join(","),
            sysparm_limit: String(asked.length),
            sysparm_display_value: "false",
            sysparm_exclude_reference_link: "true",
          }),
        { ...retryOptions, budget }
      );
      const next = new Set<string>();
      let anchorSeen = false;
      const returned = new Set<string>();
      for (const row of resultRows(response)) {
        const name = rawText(row.name)?.trim().toLowerCase();
        if (name === CHAIN_ANCHOR_TABLE) anchorSeen = true;
        if (name === undefined || !pending.includes(name)) continue;
        returned.add(name);
        // Null when it extends nothing; a gap (the chain stops, unknown) for a
        // reference whose name did not come back, an absent field, or a
        // parent that is not a table name.
        const step = parentStepOf(row, PLAN_PARENT_LINK, PLAN_PARENT_NAME);
        const parent: PlanParent = "gap" in step ? Object.freeze({ gap: step.gap }) : step.parent;
        parents.set(name, parent);
        if (typeof parent === "string" && !parents.has(parent)) next.add(parent);
      }
      if (level === 0) {
        if (anchorSeen) {
          for (const table of pending) if (!returned.has(table)) missing.add(table);
        } else if (returned.size < pending.length) {
          // No row came back for the anchor, and some for the tables did not
          // either: the read showed this user nothing, so those are not "absent".
          chainsFailure = NO_ROWS_READABLE;
        }
      }
      pending = [...next].filter((table) => !parents.has(table));
    }
  };

  const readTypes = async (): Promise<void> => {
    if (options.readTypes === false) {
      typesFailure = Object.freeze({ kind: "policy", table: "sys_dictionary" });
      return;
    }
    const response = await retryTransientOnce(
      () =>
        client.getWithMeta<{ result?: unknown }>("/api/now/table/sys_dictionary", {
          sysparm_query: `internal_typeIN${HIDDEN_FIELD_TYPES.join(",")}${HIDDEN_DICTIONARY_ORDER_BY}`,
          sysparm_fields: PLAN_FIELD_TYPE_FIELDS.sys_dictionary.join(","),
          sysparm_limit: String(MAX_HIDDEN_DICTIONARY_ROWS),
          sysparm_display_value: "false",
          sysparm_exclude_reference_link: "true",
        }),
      retryOptions
    );
    if (response.status !== 200) {
      typesFailure = failedStatus(response.status);
      return;
    }
    const rows = resultRows(response.data);
    // No rows means they are hidden from this account (every instance has
    // password-typed fields), and a full page may be cut short: both are
    // unavailable, never "no hidden fields".
    if (rows.length === 0) {
      typesFailure = NO_ROWS_READABLE;
      return;
    }
    if (rows.length >= MAX_HIDDEN_DICTIONARY_ROWS) {
      typesFailure = Object.freeze({ kind: "incomplete" });
      return;
    }
    const kept: DictionaryRow[] = [];
    for (const row of rows) {
      const entry = options.filterDictionaryRow?.(row) ?? row;
      const table = rawText(entry.name);
      const element = rawText(entry.element);
      const type = rawText(entry.internal_type);
      // Hidden-typed rows only, as the instance-wide loader keeps: a row of any
      // other type the server returned must not override an inherited one.
      if (table === undefined || element === undefined || !isHiddenFieldType(type)) continue;
      kept.push({ table, element, internal_type: type! });
    }
    // As the instance-wide loader: no hidden-typed row at all is unavailable.
    if (kept.length > 0) dictionaryRows = kept;
    else typesFailure = NO_ROWS_READABLE;
  };

  if (tables.length > 0) {
    await Promise.all([
      readChains().catch((error: unknown) => {
        if (cancelled(error)) throw error;
        hierarchyRead = false;
        chainsFailure = classifyReadFailure(error);
      }),
      readTypes().catch((error: unknown) => {
        if (cancelled(error)) throw error;
        dictionaryRows = undefined;
        typesFailure = classifyReadFailure(error);
      }),
    ]);
  }

  const chains = new Map<string, PlanTableChain>();
  for (const table of tables) {
    const chain = planChainOf(table, parents, unread);
    if (chain !== undefined) chains.set(table, chain);
  }
  // Only complete chains resolve (fieldTypesFromRows leaves the rest out).
  const hierarchies: Record<string, TableChain> = Object.fromEntries(chains);
  const types =
    dictionaryRows === undefined
      ? fieldTypesUnavailable(typesFailure)
      : fieldTypesFromRows(dictionaryRows, hierarchies);
  return Object.freeze({
    types,
    chains,
    hierarchyRead,
    ...(typesFailure === undefined || dictionaryRows !== undefined ? {} : { typesFailure }),
    ...(chainsFailure === undefined ? {} : { chainsFailure }),
    ...(missing.size === 0 ? {} : { missing }),
  });
}

function planChainOf(
  table: string,
  parents: ReadonlyMap<string, PlanParent>,
  unread: ReadonlySet<string>
): PlanTableChain | undefined {
  if (!parents.has(table)) return undefined;
  const tables = [table];
  const incomplete = (gap: ChainGap): PlanTableChain =>
    Object.freeze({ tables: Object.freeze(tables), complete: false, gap });
  let current: PlanParent = parents.get(table) ?? null;
  while (current !== null) {
    if (typeof current === "object") return incomplete(current.gap);
    if (tables.includes(current)) return incomplete("malformed");
    if (tables.length >= PLAN_CHAIN_TABLES) return incomplete("too_long");
    tables.push(current);
    const ancestor: string = current;
    current = parents.has(ancestor)
      ? (parents.get(ancestor) ?? null)
      : Object.freeze({ gap: unread.has(ancestor) ? ("too_long" as const) : ("no_row" as const) });
  }
  return Object.freeze({ tables: Object.freeze(tables), complete: true });
}

/** Rows of a Table API response, objects only. */
function resultRows(response: unknown): Record<string, unknown>[] {
  const result = (response as { result?: unknown } | null | undefined)?.result;
  return Array.isArray(result)
    ? result.filter(
        (row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row)
      )
    : [];
}

/** A field value as text: a string, number or boolean, or the `value` of a pair. */
function rawText(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (depth < 2 && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return rawText((value as { value?: unknown }).value, depth + 1);
  }
  return undefined;
}

function storedText(candidate: unknown): string | undefined {
  if (typeof candidate === "string") return candidate;
  if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
    const value = (candidate as Record<string, unknown>).value;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizeName(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  const normalized = candidate.trim().toLowerCase();
  return FIELD_NAME.test(normalized) ? normalized : undefined;
}

// ── Call scope ─────────────────────────────────────────────────────

/**
 * One call's resolved hidden-typed fields, for field policy to enforce.
 *
 * `tables` holds every table of the call's access plan that was resolved.
 * A table field policy meets that is not in it is handled by `unresolved`:
 * `"deny"` refuses (the default), `"names_only"` falls back to name-only
 * hiding (the profile opted out of the dictionary requirement).
 */
export interface HiddenFieldScope {
  readonly tables: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unresolved: "deny" | "names_only";
  /**
   * Each resolved table's extension chain, the table first. A table that did
   * not resolve (or a scope built without chains) has none, and field policy
   * then knows no ancestor for it.
   */
  readonly hierarchies?: ReadonlyMap<string, readonly string[]>;
  /**
   * Each resolved database view's joined tables, with their column prefixes
   * and chains. A view has no entry in `hierarchies`: its columns are its
   * sources' columns under a prefix, not its own.
   */
  readonly views?: ReadonlyMap<string, readonly ViewColumnSource[]>;
}

const HIDDEN_FIELD_SCOPE = new AsyncLocalStorage<HiddenFieldScope>();

/** Run `callback` with `scope` as the call's hidden-typed fields. */
export function runWithHiddenFieldScope<T>(scope: HiddenFieldScope, callback: () => T): T {
  return HIDDEN_FIELD_SCOPE.run(
    Object.freeze({
      tables: scope.tables,
      unresolved: scope.unresolved,
      ...(scope.hierarchies === undefined ? {} : { hierarchies: scope.hierarchies }),
      ...(scope.views === undefined ? {} : { views: scope.views }),
    }),
    callback
  );
}

/** The scope of the running call, if the dispatcher set one. */
export function currentHiddenFieldScope(): HiddenFieldScope | undefined {
  return HIDDEN_FIELD_SCOPE.getStore();
}

/**
 * The scope for a call over `tables`. Unavailable types, or a table that did
 * not resolve, deny unless `namesOnly` (the profile's opt-out) is set; then
 * they fall back to name-only hiding and `degraded` is true so the caller can
 * warn.
 */
export function hiddenFieldScope(
  types: FieldTypes,
  tables: Iterable<string>,
  namesOnly: boolean
): { readonly scope?: HiddenFieldScope; readonly degraded: boolean } {
  const resolved = new Map<string, ReadonlySet<string>>();
  const hierarchies = new Map<string, readonly string[]>();
  const views = new Map<string, readonly ViewColumnSource[]>();
  let missing = types.state !== "available";
  for (const candidate of tables) {
    const table = normalizeName(candidate);
    if (table === undefined) continue;
    const hidden = hiddenTypedFields(types, table);
    if (hidden === undefined) {
      missing = true;
      if (namesOnly) resolved.set(table, EMPTY_SET);
      continue;
    }
    resolved.set(table, hidden);
    if (types.state === "available") {
      const entry = types.tables.get(table);
      if (entry?.viewSources !== undefined) views.set(table, entry.viewSources);
      else if (entry !== undefined) hierarchies.set(table, entry.hierarchy);
    }
  }
  if (missing && !namesOnly) return { degraded: false };
  return {
    scope: Object.freeze({
      tables: resolved,
      unresolved: namesOnly ? "names_only" : "deny",
      hierarchies,
      views,
    }),
    degraded: missing,
  };
}

const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;

// ── Refusal and warning texts ──────────────────────────────────────

/** Where a field-types problem is reported; each surface words it for its reader. */
export type FieldTypesSurface = "dispatcher" | "history" | "payload" | "evaluate";

export interface FieldTypesProblemInput {
  readonly surface: FieldTypesSurface;
  /**
   * The table a table-level problem is about. It is echoed only when it
   * passes the table-name pattern; leave it out where the table came from
   * untrusted input (a payload).
   */
  readonly table?: string;
  /** One table's problem. */
  readonly problem?: FieldTypesTableProblem;
  /** Or the failure of a whole read (`read` names it; default sys_dictionary). */
  readonly failure?: FieldTypesReadFailure;
  readonly read?: FieldTypesReadName;
  /**
   * What the reader of a plan-bounded read lost: the field types (default) or
   * the table hierarchies. Only the payload and evaluate surfaces say which.
   */
  readonly about?: "types" | "hierarchy";
  /**
   * The profile may opt out of requiring field types (`fieldTypes.dictionary:
   * "not_required"`): name it as a remedy. Only the dispatcher's refusal does.
   */
  readonly optIn?: boolean;
}

const OPT_OUT_TAIL = '"fieldTypes": { "dictionary": "not_required" } on this profile to hide fields by name only.';
/** After a grant: ", or set ...". */
const OR_OPT_OUT = `, or set ${OPT_OUT_TAIL}`;
/** Standing alone: " Set ...". */
const ALONE_OPT_OUT = ` Set ${OPT_OUT_TAIL}`;
const CAUSELESS_MESSAGE = "Field types could not be read from the instance, so no values are returned.";
const POLICY_CLAUSE =
  "this profile does not grant read on sys_db_object and sys_dictionary (name, element, internal_type)";

/**
 * The cause-less refusal: a loader that does not say why. It never begins with
 * "Access denied by policy", which is for a refusal this server's own policy
 * makes.
 */
export const FIELD_TYPES_UNAVAILABLE_MESSAGE = CAUSELESS_MESSAGE;

/** The refusal for a table outside the call's resolved plan, a decision of this server's own plan. */
export function fieldTypesPlanDenialText(table?: unknown): string {
  const name = typeof table === "string" && FIELD_NAME.test(table) ? table : undefined;
  return (
    `Access denied by policy: ${name === undefined ? "a requested table is" : `"${name}" is`} not part of this ` +
    "call's plan, so its field types were not read."
  );
}

function validStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;
}

function statusClause(status: number | undefined): string {
  return validStatus(status) ? ` (HTTP ${status})` : "";
}

/** What went wrong with one read, as a clause that follows "the" or stands alone. */
function readClause(failure: FieldTypesReadFailure, read: FieldTypesReadName): string {
  switch (failure.kind) {
    case "policy":
      return POLICY_CLAUSE;
    case "refused":
      return failure.status === 200
        ? `the instance returned no ${read} rows to the integration user (HTTP 200)`
        : `the instance refused the ${read} read${statusClause(failure.status)}`;
    case "transient": {
      const after = failure.retried === true ? " after one retry" : "";
      if (failure.timeout === true) return `the ${read} request timed out${after}`;
      if (failure.status !== undefined && validStatus(failure.status)) {
        return `the ${read} request returned HTTP ${failure.status}${after}`;
      }
      return `the ${read} request could not reach the instance${after}`;
    }
    case "incomplete":
      return read === "sys_dictionary"
        ? "sys_dictionary has more password-type fields than one read returns"
        : `${read} has more rows than one read returns`;
    case "failed":
      return `the ${read} read failed${statusClause(failure.status)}`;
  }
}

/** `subject`: the sentence already names the table, so a clause can say "its". */
function gapClause(at: string | undefined, gap: ChainGap, subject = false): string {
  const name = at !== undefined && FIELD_NAME.test(at) ? `"${at}"` : undefined;
  switch (gap) {
    case "parent_unreadable":
      return `the parent table of ${name ?? "a table"} could not be read (the instance did not return its name to the integration user)`;
    case "too_long":
      return `${subject ? "its" : "the"} table hierarchy is more than 12 tables deep`;
    case "malformed":
      return `the sys_db_object row of ${name ?? "a table"} does not name a valid parent`;
    case "no_row":
      return `no sys_db_object row of ${name ?? "a table"} is readable`;
  }
}

function grantClause(read: FieldTypesReadName): string {
  return read === "sys_db_view_table"
    ? "Grant the integration user read access to sys_db_view_table"
    : "Grant the integration user read access to sys_dictionary and sys_db_object";
}

/** Surfaces that may name a table: the others take their tables from untrusted input. */
function namesTables(surface: FieldTypesSurface): boolean {
  return surface === "dispatcher" || surface === "history";
}

/**
 * Why field types are not known, as a clause with no sentence around it, or
 * undefined when the input names no cause. It never names a table on a
 * surface that does not {@link namesTables}.
 */
function fieldTypesCauseClause(input: Omit<FieldTypesProblemInput, "optIn">): string | undefined {
  const named = namesTables(input.surface);
  const problem = input.problem;
  if (problem?.kind === "not_found") return "a table has no row in sys_db_object";
  if (problem?.kind === "chain") return gapClause(named ? problem.at : undefined, problem.gap);
  const failure = problem?.kind === "read" ? problem.failure : input.failure;
  if (failure === undefined) return undefined;
  const read: FieldTypesReadName =
    problem?.kind === "read" ? (problem.read ?? "sys_db_object") : (input.read ?? "sys_dictionary");
  return readClause(failure, read);
}

/** How a sentence about one surface ends, by what the reader lost. */
const SURFACE_TAIL: Readonly<
  Record<Exclude<FieldTypesSurface, "dispatcher">, Readonly<Record<"types" | "hierarchy", string>>>
> = Object.freeze({
  history: Object.freeze({ types: ", so no values are shown.", hierarchy: ", so no values are shown." }),
  payload: Object.freeze({
    types: ", so password-type fields cannot be hidden; the payload is not shown.",
    hierarchy: ", so the payload is not shown.",
  }),
  evaluate: Object.freeze({
    types: "; password-typed field checks were not made.",
    hierarchy: "; some table checks were not made.",
  }),
});

const POLICY_CLAUSE_TEXT =
  "This profile does not grant read on sys_db_object and sys_dictionary (name, element, internal_type)";

/**
 * The one source of the sentences that say why field types could not be read.
 * Only a validated table name (on the dispatcher and history, never where the
 * table came from a payload), an integer status and fixed words are
 * interpolated; no upstream text is ever part of one. "Access denied by
 * policy" is only for a cause of this server's own policy ({@link
 * FieldTypesReadFailure} `policy`) and for {@link fieldTypesPlanDenialText}.
 */
export function fieldTypesProblemText(input: FieldTypesProblemInput): string {
  const optIn = input.optIn === true;
  const surface = input.surface;
  const table = input.table !== undefined && FIELD_NAME.test(input.table) ? input.table : undefined;
  const problem = input.problem;
  const failure = problem?.kind === "read" ? problem.failure : input.failure;
  const read: FieldTypesReadName =
    problem?.kind === "read" ? (problem.read ?? "sys_db_object") : (input.read ?? "sys_dictionary");

  if (surface !== "dispatcher") {
    const about = input.about ?? "types";
    const tail = SURFACE_TAIL[surface][about];
    const subject = about === "hierarchy" ? "Table hierarchies" : "Field types";
    if (failure?.kind === "policy") return `${POLICY_CLAUSE_TEXT}${tail}`;
    const clause = fieldTypesCauseClause(input);
    if (clause === undefined) return `${subject} could not be read${tail}`;
    const lead =
      problem?.kind === "chain"
        ? about === "hierarchy"
          ? "Table hierarchies could not be read in full"
          : "Field types could not be confirmed"
        : `${subject} could not be read`;
    return `${lead}: ${clause}${tail}`;
  }

  // The dispatcher's refusal, with what to do about it.
  if (problem?.kind === "not_found") {
    return table === undefined
      ? "A table does not exist on this instance: sys_db_object has no row for it. Check the table name."
      : `Table "${table}" does not exist on this instance: sys_db_object has no row for it. Check the table name.`;
  }
  if (problem?.kind === "chain") {
    const clause = gapClause(problem.at, problem.gap, table !== undefined);
    const subject = table === undefined ? "the table" : `"${table}"`;
    const fixable = problem.gap === "parent_unreadable" || problem.gap === "no_row";
    const remedy = fixable
      ? ` Grant the integration user read access to sys_db_object${optIn ? OR_OPT_OUT : "."}`
      : optIn
        ? ALONE_OPT_OUT
        : "";
    return `Field types for ${subject} could not be confirmed: ${clause}. No values were returned.${remedy}`;
  }
  if (failure === undefined) return CAUSELESS_MESSAGE;
  if (failure.kind === "policy") {
    return "Access denied by policy: this profile does not grant read on sys_db_object and sys_dictionary, so field types were not read and no values are returned.";
  }
  const clause = readClause(failure, read);
  switch (failure.kind) {
    case "refused":
      return (
        `Field types could not be read: ${clause}, so password-type fields can't be told apart and no values are returned. ` +
        `${grantClause(read)}${optIn ? OR_OPT_OUT : "."}`
      );
    case "transient":
      return `Field types are temporarily unavailable: ${clause}. No values were returned. Retry the call.`;
    case "incomplete":
      return `Field types could not be read in full: ${clause}, so no values are returned.${optIn ? ALONE_OPT_OUT : ""}`;
    case "failed":
      return `Field types could not be read: ${clause}. No values were returned.`;
  }
}

/**
 * The cause to report for a plan-bounded read of the tables `tables`: a table
 * `sys_db_object` has no row for, then why the chain read gave no answer, then
 * the first incomplete chain. Undefined when the loader knows none.
 */
export function planHierarchyProblem(
  loaded: PlanFieldTypes,
  tables: Iterable<string>
): Pick<FieldTypesProblemInput, "problem" | "failure" | "read"> | undefined {
  if (loaded.missing !== undefined && loaded.missing.size > 0) {
    return { problem: Object.freeze({ kind: "not_found" as const }) };
  }
  if (loaded.chainsFailure !== undefined) return { failure: loaded.chainsFailure, read: "sys_db_object" };
  for (const table of tables) {
    const chain = loaded.chains.get(table);
    if (chain !== undefined && !chain.complete && chain.gap !== undefined) {
      return {
        problem: Object.freeze({
          kind: "chain" as const,
          at: chain.tables[chain.tables.length - 1] ?? table,
          gap: chain.gap,
        }),
      };
    }
  }
  return undefined;
}

/** The cause to report when a plan-bounded read's field types are unavailable. */
export function planTypesProblem(
  loaded: PlanFieldTypes
): Pick<FieldTypesProblemInput, "failure" | "read"> | undefined {
  const failure = loaded.typesFailure ?? (loaded.types.state === "unavailable" ? loaded.types.cause : undefined);
  return failure === undefined ? undefined : { failure, read: "sys_dictionary" };
}

/** What to tell the caller when the call's field types are not known, and how to audit it. */
export interface FieldTypesRefusal {
  readonly message: string;
  /** True when the cause is this server's own policy (audited as a policy rejection). */
  readonly policy: boolean;
  /** An error carrying only a bounded category and retry decision, for the audit record. */
  readonly auditError: Error;
}

/**
 * Pick the one cause to report for a call over `tables` whose field types are
 * not usable, from what the loader found. A table that does not exist comes
 * first (the caller's to fix, and a retry cannot help), then the dictionary's
 * cause, then the first table's failed chain read, then its chain gap. The
 * result is a refusal; whether the call is refused at all is
 * {@link hiddenFieldScope}'s answer.
 */
export function fieldTypesRefusal(types: FieldTypes, tables: Iterable<string>): FieldTypesRefusal {
  const names = [...tables].map(normalizeName).filter((name): name is string => name !== undefined);
  const problems = types.problems;
  const withProblem = (kind: FieldTypesTableProblem["kind"]) =>
    names.find((name) => problems?.get(name)?.kind === kind);
  const notFound = withProblem("not_found");
  if (notFound !== undefined) {
    return refusalFor({ surface: "dispatcher", optIn: true, table: notFound, problem: problems!.get(notFound)! });
  }
  if (types.state === "unavailable" && types.cause !== undefined) {
    return refusalFor({ surface: "dispatcher", optIn: true, failure: types.cause });
  }
  const unreadable = withProblem("read");
  if (unreadable !== undefined) {
    return refusalFor({ surface: "dispatcher", optIn: true, table: unreadable, problem: problems!.get(unreadable)! });
  }
  const gap = withProblem("chain");
  if (gap !== undefined) {
    return refusalFor({ surface: "dispatcher", optIn: true, table: gap, problem: problems!.get(gap)! });
  }
  return Object.freeze({
    message: CAUSELESS_MESSAGE,
    policy: false,
    auditError: createToolError("upstream", "retry_after_correction"),
  });
}

function refusalFor(input: FieldTypesProblemInput): FieldTypesRefusal {
  const failure = input.problem?.kind === "read" ? input.problem.failure : input.failure;
  return Object.freeze({
    message: fieldTypesProblemText(input),
    policy: failure?.kind === "policy",
    auditError: auditErrorFor(input),
  });
}

/** A bounded error for the audit record: a category and a retry decision, no text. */
function auditErrorFor(input: FieldTypesProblemInput): Error {
  if (input.problem?.kind === "not_found") return createToolError("not_found", "retry_after_correction");
  if (input.problem?.kind === "chain") return createToolError("upstream", "retry_after_correction");
  const failure = input.problem?.kind === "read" ? input.problem.failure : input.failure;
  switch (failure?.kind) {
    case "refused":
      return createToolError(failure.status === 401 ? "authentication" : "authorization", "retry_after_correction");
    case "transient":
      return createToolError(failure.timeout === true ? "timeout" : "upstream", "retry_later");
    case "incomplete":
      return createToolError("too_large", "retry_after_correction");
    default:
      return createToolError("upstream", "do_not_retry");
  }
}

// ── Profile opt-out ────────────────────────────────────────────────

/**
 * Whether a profile's read tools require the field types. `"required"` (the
 * default) refuses every field-policy tool call while the types cannot be
 * read. `"not_required"` lets those calls run with name-only hiding instead;
 * the server logs a warning each time it falls back, and the policy card
 * flags the profile.
 */
export type DictionaryRequirement = "required" | "not_required";

export interface FieldTypesConfigInput {
  readonly dictionary?: DictionaryRequirement;
}

const FIELD_TYPES_CONFIG_KEYS = Object.freeze(["dictionary"] as const);
const FIELD_TYPES_DICTIONARY_ENV = "SN_FIELD_TYPES_DICTIONARY";

/** A profile's `fieldTypes` is invalid; the message names only the key. */
export class FieldTypesConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldTypesConfigurationError";
  }
}

/** Validate a profile's `fieldTypes` block; throws on any other shape. */
export function validateFieldTypesConfig(candidate: unknown): FieldTypesConfigInput {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new FieldTypesConfigurationError("fieldTypes must be an object");
  }
  for (const key of Object.keys(candidate)) {
    if (!(FIELD_TYPES_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new FieldTypesConfigurationError(
        `fieldTypes supports only ${FIELD_TYPES_CONFIG_KEYS.join(", ")}`
      );
    }
  }
  const dictionary = (candidate as Record<string, unknown>).dictionary;
  if (dictionary !== undefined && dictionary !== "required" && dictionary !== "not_required") {
    throw new FieldTypesConfigurationError(
      'fieldTypes.dictionary must be "required" or "not_required"'
    );
  }
  return Object.freeze(dictionary === undefined ? {} : { dictionary });
}

/** The environment profile's `fieldTypes`, from SN_FIELD_TYPES_DICTIONARY. */
export function fieldTypesConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env
): FieldTypesConfigInput {
  const raw = environment[FIELD_TYPES_DICTIONARY_ENV]?.trim();
  if (raw === undefined || raw === "") return Object.freeze({});
  if (raw !== "required" && raw !== "not_required") {
    throw new FieldTypesConfigurationError(
      `${FIELD_TYPES_DICTIONARY_ENV} must be "required" or "not_required"`
    );
  }
  return Object.freeze({ dictionary: raw });
}

/** True when the profile opted out of requiring the field types. */
export function dictionaryNotRequired(config: FieldTypesConfigInput | undefined): boolean {
  return config?.dictionary === "not_required";
}

/**
 * The startup warning for profiles that opted out of requiring the field
 * types, or undefined when none did. Profile names are JSON-quoted.
 */
export function fieldTypesOptOutWarning(profiles: readonly string[]): string | undefined {
  if (profiles.length === 0) return undefined;
  return (
    `[servicenow-mcp] WARNING: ${profiles.length} profile(s) set fieldTypes.dictionary ` +
    `to "not_required" (${profiles.map((name) => JSON.stringify(name)).join(", ")}): while ` +
    "the instance's field types cannot be read, their tools hide password-type fields " +
    "by name only.\n"
  );
}
