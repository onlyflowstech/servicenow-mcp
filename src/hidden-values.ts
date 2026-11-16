/**
 * Which field values are hidden by what a field *is*, not what it is called.
 *
 * Field policy hides a value by name (`isSensitiveFieldName`), but a field of
 * internal type `password` (a one-way hash) or `password2` (two-way
 * encrypted) can be called anything: `ssh_passphrase`, `key`, `answer`,
 * `secure_value`, `temppassword`. ServiceNow does not mask either type in
 * Table API responses, and a `password2` display value can be the decrypted
 * text. This module is the one place that decides type-based hiding:
 *
 * - {@link HIDDEN_FIELD_TYPES}, the internal types whose values are hidden;
 * - {@link loadFieldTypes}, which builds a table's hidden-typed fields from
 *   ONE instance-wide `sys_dictionary` read (fields of those types only),
 *   projected over each table's extension chain, with database views
 *   resolved to the tables they join;
 * - {@link classifyField}, the per-field verdict (including dot-walks) with a
 *   reason, for tools that show a value-hidden marker instead of dropping;
 * - {@link withoutFields}, whole-field removal for every response shape;
 * - row rules for tables whose secrecy is a per-row value (`sys_properties`).
 *
 * The loader never returns an empty map for "could not read": an unreadable
 * dictionary is the explicit `unavailable` state, and a table it could not
 * resolve has no entry (so every field on it is `unknown_type`).
 *
 * The scope at the bottom carries one call's resolved sets to field policy,
 * which enforces them; see `field-policy.ts`.
 *
 * @module hidden-values
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { isServiceNowRequestCancellation, type ServiceNowOperations } from "./client.js";
import { isCredentialTableHierarchy } from "./credential-tables.js";
import { derivedMetadataMemo, uncachedOperations } from "./metadata-cache.js";

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
}

export type FieldTypes =
  | {
      readonly state: "available";
      /** Resolved tables. A requested table that is missing is unresolved. */
      readonly tables: ReadonlyMap<string, ResolvedTableTypes>;
    }
  | { readonly state: "unavailable" };

export const FIELD_TYPES_UNAVAILABLE: FieldTypes = Object.freeze({ state: "unavailable" });

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
 * path `unknown_type`. Field policy rejects dot-walked names outright today;
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
 * the caller will ask about to its chain (the table first). With
 * `complete: true` the rows are every field of those chains, so a field with
 * no row is `unknown_type`; otherwise only hidden-typed rows matter.
 */
export function fieldTypesFromRows(
  rows: Iterable<DictionaryRow>,
  hierarchies: Readonly<Record<string, readonly string[]>>,
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
    const hierarchy = chain.map(normalizeName);
    if (table === undefined || hierarchy.length === 0 || hierarchy.some((entry) => entry === undefined)) {
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
 * `sysparm_display_value=all` pair. A display value is never kept on its own,
 * since a `password2` display value can be the decrypted text.
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

// ── Loader ─────────────────────────────────────────────────────────

/**
 * How long a loaded map serves without any request. A field that becomes
 * hidden-typed within this window is still hidden by name if its name is
 * sensitive; otherwise it is hidden from the next load. Capped by the
 * profile's metadata-cache TTL.
 */
export const FIELD_TYPES_TTL_MS = 60 * 60 * 1000;
/** How long an unreadable dictionary is remembered before it is retried. */
export const FIELD_TYPES_UNAVAILABLE_TTL_MS = 30 * 1000;
/** A read that returns this many rows may be cut short, so it is unavailable. */
export const MAX_HIDDEN_DICTIONARY_ROWS = 10_000;
const MAX_HIERARCHY_DEPTH = 12;
const MAX_VIEW_SOURCE_ROWS = 1_000;
const MAX_DOT_WALK_HOPS = 8;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const DICTIONARY_MEMO_KEY = "hidden-values:dictionary:v1";
const TABLE_MEMO_PREFIX = "hidden-values:table:v1:";
const CHAIN_FLIGHT_PREFIX = "hidden-values:chain-read:v1:";

type DictionaryState = ReadonlyMap<string, ReadonlyMap<string, string>> | "unavailable";
/** A table's chain, `null` when sys_db_object has no row for it. */
type ChainState = readonly string[] | null;

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

/**
 * Resolve the hidden-typed fields of every table in `tables`.
 *
 * Requests, made with the call's own credentials and no table grant (the
 * implicit metadata path the all-fields projection uses): one instance-wide
 * `sys_dictionary` read of the hidden types, one `sys_db_object` read for the
 * chains of all the tables not yet known, and, only for a name with no
 * `sys_db_object` row, one `sys_db_view_table` read (plus the joined tables'
 * chains). Each result is kept in the metadata cache's per-credential memo
 * (`derivedMetadataMemo`), so a later call that finds everything there makes
 * no request at all; the reads skip the cache's watermark, since the memo is
 * their cache. The dictionary and chain reads run in parallel, and concurrent
 * calls in one scope share each read in flight (one per key). `forceRecache`
 * skips the memo.
 *
 * The dictionary read failing, returning no rows, or returning a full page
 * gives `unavailable`. A table whose chain or view cannot be resolved is left
 * out of `tables`, so its fields are `unknown_type`. A cancelled read rethrows.
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
    memo?.set(TABLE_MEMO_PREFIX + table, entry, 128 + JSON.stringify(entry).length, FIELD_TYPES_TTL_MS);
  const recall = (table: string): boolean => {
    const known = force ? undefined : memo?.get(TABLE_MEMO_PREFIX + table);
    if (!isTableShape(known)) return false;
    if (known.kind === "table") chains.set(table, known.chain);
    else {
      chains.set(table, null);
      views.set(table, known.sources);
    }
    return true;
  };

  const pending = requested.filter((table) => !recall(table));
  // The dictionary and the chains do not depend on each other: one round trip.
  const [dictionary, read] = await Promise.all([
    hiddenDictionary(reader, memo, force),
    pending.length === 0
      ? Promise.resolve(new Map<string, ChainState>())
      : sharedChains(reader, memo, pending),
  ]);
  if (dictionary === "unavailable") return FIELD_TYPES_UNAVAILABLE;
  if (pending.length > 0) {
    for (const [table, chain] of read) {
      chains.set(table, chain);
      if (chain !== null) remember(table, Object.freeze({ kind: "table", chain }));
    }
    const absent = pending.filter((table) => read.get(table) === null);
    if (absent.length > 0) {
      for (const [view, sources] of await viewSources(reader, absent)) {
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
    for (const [table, chain] of await sharedChains(reader, memo, joined)) {
      chains.set(table, chain);
      if (chain !== null) remember(table, Object.freeze({ kind: "table", chain }));
    }
  }

  const tables = new Map<string, ResolvedTableTypes>();
  for (const table of requested) {
    const resolved = resolveTable(table, chains, views, dictionary);
    if (resolved !== undefined) tables.set(table, resolved);
  }
  return Object.freeze({ state: "available", tables });
}

/** What the memo keeps per table: its chain, or a view's joined tables. */
type TableShape =
  | { readonly kind: "table"; readonly chain: readonly string[] }
  | { readonly kind: "view"; readonly sources: readonly ViewSource[] };

function isTableShape(candidate: unknown): candidate is TableShape {
  if (typeof candidate !== "object" || candidate === null) return false;
  const shape = candidate as Partial<Record<string, unknown>>;
  return (
    (shape.kind === "table" && Array.isArray(shape.chain)) ||
    (shape.kind === "view" && Array.isArray(shape.sources))
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
  if (chain === undefined) return undefined;
  if (chain !== null) return resolvedTable(chain, inheritedHidden(chain, dictionary));
  // No sys_db_object row: only a database view resolves; a view column is
  // `<prefix>_<field>` of the table joined under that prefix.
  const sources = views.get(table);
  if (sources === undefined || sources.length === 0) return undefined;
  const hidden = new Map<string, string>();
  const hierarchy = [table];
  for (const source of sources) {
    const sourceChain = chains.get(source.table);
    if (sourceChain === undefined || sourceChain === null) return undefined;
    hierarchy.push(...sourceChain.filter((entry) => !hierarchy.includes(entry)));
    for (const [element, type] of inheritedHidden(sourceChain, dictionary)) {
      const column = `${source.prefix}_${element}`;
      if (FIELD_NAME.test(column)) hidden.set(column, type);
    }
  }
  return resolvedTable(hierarchy, hidden);
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
  allTypes?: ReadonlyMap<string, string>
): ResolvedTableTypes {
  return Object.freeze({
    hierarchy: Object.freeze([...hierarchy]),
    hidden,
    hiddenNames: new Set(hidden.keys()) as ReadonlySet<string>,
    ...(allTypes === undefined ? {} : { allTypes }),
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
  if (known === "unavailable" || known instanceof Map) return known as DictionaryState;
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
  tables: readonly string[]
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
    const batch = tableChains(client, own);
    for (const table of own) {
      memo?.track(CHAIN_FLIGHT_PREFIX + table, batch.then((read) => read.get(table)));
    }
    for (const [table, chain] of await batch) chains.set(table, chain);
  }
  const retry: string[] = [];
  for (const [table, pending] of waiting) {
    try {
      const chain = await pending;
      if (chain !== undefined) chains.set(table, chain);
    } catch {
      retry.push(table);
    }
  }
  if (retry.length > 0) {
    for (const [table, chain] of await tableChains(client, retry)) chains.set(table, chain);
  }
  return chains;
}

async function readDictionary(client: ServiceNowOperations, memo: Memo): Promise<DictionaryState> {
  let rows: unknown;
  try {
    const response = await client.getWithMeta<{ result?: unknown }>("/api/now/table/sys_dictionary", {
      sysparm_query:
        `internal_typeIN${HIDDEN_FIELD_TYPES.join(",")}` + "^ORDERBYname^ORDERBYelement",
      sysparm_fields: "name,element,internal_type",
      sysparm_limit: String(MAX_HIDDEN_DICTIONARY_ROWS),
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
    });
    rows = response.status === 200 ? response.data?.result : undefined;
  } catch (error) {
    if (isServiceNowRequestCancellation(error)) throw error;
    memo?.set(DICTIONARY_MEMO_KEY, "unavailable", 64, FIELD_TYPES_UNAVAILABLE_TTL_MS);
    return "unavailable";
  }
  const parsed = parseDictionaryRows(rows);
  if (parsed === "unavailable") {
    memo?.set(DICTIONARY_MEMO_KEY, "unavailable", 64, FIELD_TYPES_UNAVAILABLE_TTL_MS);
    return parsed;
  }
  let bytes = 256;
  for (const [table, fields] of parsed) {
    bytes += table.length + 64;
    for (const [element, type] of fields) bytes += element.length + type.length + 32;
  }
  memo?.set(DICTIONARY_MEMO_KEY, parsed, bytes, FIELD_TYPES_TTL_MS);
  return parsed;
}

/**
 * Rows to a frozen map. No rows at all means the rows were hidden from this
 * user (every instance has hidden-typed fields, `sys_user.user_password`
 * among them), and a full page may be cut short: both are unavailable.
 */
function parseDictionaryRows(rows: unknown): DictionaryState {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length >= MAX_HIDDEN_DICTIONARY_ROWS) {
    return "unavailable";
  }
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
  if (byTable.size === 0) return "unavailable";
  return byTable;
}

/** Chains for `tables`, in one read. Unread tables are left out of the map. */
async function tableChains(
  client: ServiceNowOperations,
  tables: readonly string[]
): Promise<Map<string, ChainState>> {
  const chains = new Map<string, ChainState>();
  const ancestorFields = Array.from(
    { length: MAX_HIERARCHY_DEPTH - 1 },
    (_, index) => `${"super_class.".repeat(index + 1)}name`
  );
  let rows: unknown;
  try {
    const response = await client.getWithMeta<{ result?: unknown }>("/api/now/table/sys_db_object", {
      sysparm_query: `nameIN${tables.join(",")}`,
      sysparm_fields: ["name", ...ancestorFields].join(","),
      sysparm_limit: String(tables.length),
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
    });
    rows = response.status === 200 ? response.data?.result : undefined;
  } catch (error) {
    if (isServiceNowRequestCancellation(error)) throw error;
    return chains;
  }
  if (!Array.isArray(rows)) return chains;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const table = normalizeName(storedText(record.name));
    if (table === undefined || !tables.includes(table)) continue;
    const chain = [table];
    for (const field of ancestorFields) {
      const ancestor = normalizeName(storedText(record[field]));
      if (ancestor === undefined || chain.includes(ancestor)) break;
      chain.push(ancestor);
    }
    chains.set(table, Object.freeze(chain));
  }
  // The read succeeded: a table it did not return has no sys_db_object row.
  for (const table of tables) if (!chains.has(table)) chains.set(table, null);
  return chains;
}

/** Joined tables of the database views among `tables`. Unread views are left out. */
async function viewSources(
  client: ServiceNowOperations,
  tables: readonly string[]
): Promise<Map<string, ViewSource[]>> {
  const views = new Map<string, ViewSource[]>();
  let rows: unknown;
  try {
    const response = await client.getWithMeta<{ result?: unknown }>("/api/now/table/sys_db_view_table", {
      sysparm_query: `view.nameIN${tables.join(",")}`,
      sysparm_fields: "view.name,table,variable_prefix",
      sysparm_limit: String(MAX_VIEW_SOURCE_ROWS),
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
    });
    rows = response.status === 200 ? response.data?.result : undefined;
  } catch (error) {
    if (isServiceNowRequestCancellation(error)) throw error;
    return views;
  }
  if (!Array.isArray(rows) || rows.length >= MAX_VIEW_SOURCE_ROWS) return views;
  const broken = new Set<string>();
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
  return views;
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
}

const HIDDEN_FIELD_SCOPE = new AsyncLocalStorage<HiddenFieldScope>();

/** Run `callback` with `scope` as the call's hidden-typed fields. */
export function runWithHiddenFieldScope<T>(scope: HiddenFieldScope, callback: () => T): T {
  return HIDDEN_FIELD_SCOPE.run(
    Object.freeze({ tables: scope.tables, unresolved: scope.unresolved }),
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
  }
  if (missing && !namesOnly) return { degraded: false };
  return {
    scope: Object.freeze({ tables: resolved, unresolved: namesOnly ? "names_only" : "deny" }),
    degraded: missing,
  };
}

const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>;

/**
 * The fixed refusal when field types cannot be read and the profile has not
 * opted out. It names what to grant; it carries no table or field name.
 */
export const FIELD_TYPES_UNAVAILABLE_MESSAGE =
  "Access denied by policy: field types could not be read from the instance, so " +
  "password-type fields cannot be told apart from other fields. Grant the integration " +
  "user read access to sys_dictionary and sys_db_object (and sys_db_view_table for " +
  "database views), or set \"fieldTypes\": { \"dictionary\": \"not_required\" } on this " +
  "profile to hide fields by name only.";

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
