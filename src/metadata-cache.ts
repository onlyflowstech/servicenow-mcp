/**
 * Per-identity read-through cache for stable ServiceNow metadata table reads.
 *
 * Cached reads are scoped by caller-supplied cache scope and full GET
 * selector. The scope must discriminate credential identity as well as
 * instance: ServiceNow evaluates ACLs per user, and a cache hit skips the
 * upstream read entirely, so a scope shared between identities would serve
 * one caller's authorized rows to another. Callers can force refresh by
 * passing the internal sysparm_force_recache=true parameter, which is stripped
 * before upstream I/O.
 *
 * Freshness is a server watermark: the table's row count (X-Total-Count) and
 * its newest row by sys_updated_on, read back as the stored UTC value. Each
 * entry keeps the watermark read just before its rows were fetched, and a
 * cache hit is served only while a new watermark read still matches it. Both
 * sides of the comparison come from the instance, so the session timezone,
 * date format, DST and clock skew between this host and the instance play no
 * part, and no user lookup is needed: caching behaves the same in every auth
 * mode.
 *
 * An insert or an update makes its row the newest, and an insert or a delete
 * changes the count, so every write moves the watermark -- at one-second
 * resolution. An update within the stored watermark's own second, to a row
 * other than the newest, can still go unseen; so can a write that skips the
 * system fields. Such a row stays stale for at most one TTL: a matching
 * watermark refreshes recency for eviction but never extends expiresAt, so the
 * entry still expires on schedule and forces a genuine refetch.
 *
 * Two memos keep the watermark from costing more than it saves. Within one
 * tool call each table's watermark is read once, however many reads of the
 * table the call makes. Across calls, a table whose watermark proved unusable
 * is read straight through, without a watermark, for a while: long for causes
 * that persist (an incomplete or future-dated watermark, a 4xx), short for
 * transient ones (429, 5xx, timeouts, network).
 *
 * @module metadata-cache
 */

import {
  isServiceNowRequestCancellation,
  type RequestResult,
  type ServiceNowOperations,
} from "./client.js";
import { parsePositiveIntegerEnv } from "./config.js";
import { trustedToolErrorDescriptor } from "./tool-error.js";

export const DEFAULT_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Tables cached by default.
 *
 * The bar for inclusion is a large payload relative to the watermark read,
 * not merely "this table changes rarely" -- a cache hit still costs one
 * upstream round trip (see tableWatermark), so the saving is payload bytes,
 * never request count. Why each pattern is here:
 *
 * - sys_dictionary, sys_db_object: the field and table definitions behind
 *   sn_schema, the all-fields cap and sn_discover. A table's dictionary alone
 *   is hundreds of rows, and a hierarchy walk reads them repeatedly.
 * - sys_app, sys_plugins, sys_glide_object, sys_metadata*, sys_flow*:
 *   application, plugin, field-type and application-file listings, and the
 *   Flow Designer tables. They are large and change rarely. The list is the
 *   original metadata set; not every table in it has a reader in this
 *   server today.
 * - sys_script, sys_script_include, sys_ui_script, sys_script_client,
 *   sys_ws_operation: the five code tables sn_codesearch searches, which
 *   sn_query also reads. Each row carries a full script body, so a repeated
 *   search or page is among the heaviest reads this server makes. Editing a
 *   script moves sys_updated_on, which the watermark sees, so a cached search
 *   never outlives a save. They are not covered by sys_metadata*: patterns
 *   match a table's name, not its place in the table hierarchy.
 *
 * sys_properties is deliberately absent: its rows are ACL-restricted per user
 * and routinely hold integration secrets in `value`, and the only reads of it
 * here are three single-value build-info lookups whose payloads are far too
 * small to be worth retaining for a day. Operators who want it can add it
 * through SN_METADATA_CACHE_TABLES.
 *
 * An explicit SN_METADATA_CACHE_TABLES or `metadataCache.tables` replaces this
 * list; it does not extend it, so a profile that sets its own list must name
 * the code tables itself to cache them.
 */
export const DEFAULT_METADATA_CACHE_TABLES = Object.freeze([
  "sys_glide_object",
  "sys_dictionary",
  "sys_db_object",
  "sys_app",
  "sys_plugins",
  "sys_metadata*",
  "sys_flow*",
  "sys_script",
  "sys_script_include",
  "sys_ui_script",
  "sys_script_client",
  "sys_ws_operation",
]);

export interface MetadataCacheConfigInput {
  readonly ttlMs?: number;
  readonly tables?: readonly string[];
}

export interface MetadataCacheConfig {
  readonly ttlMs: number;
  readonly tables: readonly string[];
}

type Jsonish = Awaited<ReturnType<Response["json"]>>;

/**
 * A table's row count and newest row, as the instance reports them. An empty
 * table has count 0 and blank row fields.
 */
interface Watermark {
  readonly count: number;
  readonly sysId: string;
  readonly updatedOn: string;
}

/**
 * Why a watermark cannot be used, which decides how long the table's reads go
 * straight through. A cancelled read says nothing about the table.
 */
type UnusableReason = "structural" | "transient" | "cancelled";

type WatermarkRead =
  | { readonly usable: true; readonly watermark: Watermark }
  | { readonly usable: false; readonly reason: UnusableReason };

interface CacheEntry {
  readonly expiresAt: number;
  /** Read before `data` was fetched, never after -- see cachedGetWithMeta. */
  readonly watermark: Watermark;
  readonly data: Jsonish | null;
  readonly status: number;
  readonly headers: readonly [string, string][];
  /** Estimated retained size: the serialized body plus key and header overhead. */
  readonly bytes: number;
}

interface ScopeState {
  readonly entries: Map<string, CacheEntry>;
  /** Table -> epoch ms until which its reads pass through without a watermark. */
  readonly uncacheable: Map<string, number>;
  /** Sum of `bytes` over `entries`. */
  bytes: number;
  /** Set once the scope is evicted, so a call still holding it stores nothing. */
  detached: boolean;
}

const SCOPED_CACHES = new Map<string, ScopeState>();
/** Sum of every scope's `bytes`; kept in step by storeEntry and removeEntry. */
let totalCachedBytes = 0;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
/** sys_updated_on as returned with sysparm_display_value=false (UTC). */
const STORED_DATE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u;
const ROW_COUNT = /^(?:0|[1-9]\d{0,15})$/u;
export const FORCE_RECACHE_PARAM = "sysparm_force_recache";
const MAX_CACHE_TABLE_PATTERNS = 128;
const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds on process-global cache state. Scopes multiply with credential
 * rotation and profiles, and entries multiply with distinct GET selectors,
 * so both are capped and evicted in least-recently-used order. */
export const MAX_METADATA_CACHE_SCOPES = 64;
export const MAX_METADATA_CACHE_ENTRIES_PER_SCOPE = 512;
/**
 * Byte bounds. The entry count is not a memory bound: a code-table entry holds
 * a whole response of script bodies, up to the client's 1 MiB ceiling, so 512
 * of them would retain about half a GiB in one scope. A response larger than
 * the entry cap is returned but never kept (and any older entry under its key
 * is dropped); a scope over its budget evicts its least recently used entries;
 * the whole cache over its budget evicts from the least recently used scope
 * first. Sizes are estimates (serialized body plus key and header overhead),
 * not heap measurements.
 */
export const MAX_METADATA_CACHE_ENTRY_BYTES = 512 * 1024;
export const MAX_METADATA_CACHE_SCOPE_BYTES = 32 * 1024 * 1024;
export const MAX_METADATA_CACHE_TOTAL_BYTES = 128 * 1024 * 1024;
/** Fixed allowance per entry for the frozen record, watermark and map slot. */
const ENTRY_OVERHEAD_BYTES = 512;
/** How long a table goes uncached after its watermark proved unusable; never
 * longer than the cache TTL. */
export const STRUCTURAL_UNCACHEABLE_MS = 15 * 60 * 1000;
export const TRANSIENT_UNCACHEABLE_MS = 30 * 1000;

interface MetadataCacheEnvironment {
  readonly SN_METADATA_CACHE_TTL_MS?: string;
  readonly SN_METADATA_CACHE_TABLES?: string;
}

export function metadataCacheConfigFromEnvironment(
  environment: MetadataCacheEnvironment = process.env as MetadataCacheEnvironment
): MetadataCacheConfigInput {
  const ttlMs = parsePositiveIntegerEnv(
    environment.SN_METADATA_CACHE_TTL_MS,
    "SN_METADATA_CACHE_TTL_MS",
    { max: MAX_CACHE_TTL_MS }
  );
  const tables = parseTablePatterns(environment.SN_METADATA_CACHE_TABLES);
  return Object.freeze({
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(tables === undefined ? {} : { tables }),
  });
}

export function createMetadataCacheConfig(
  input: MetadataCacheConfigInput | undefined
): MetadataCacheConfig {
  return Object.freeze({
    ttlMs: validateTtlMs(input?.ttlMs ?? DEFAULT_METADATA_CACHE_TTL_MS),
    tables: normalizeTablePatterns(input?.tables ?? DEFAULT_METADATA_CACHE_TABLES),
  });
}

/** The operations each cached wrapper reads through. */
const UNCACHED_OPERATIONS = new WeakMap<ServiceNowOperations, ServiceNowOperations>();

/**
 * The operations underneath a cached wrapper, or `operations` itself when it
 * is not one.
 *
 * Use it for a read whose answer decides a write, such as the records a bulk
 * update or delete targets. A cache hit can be stale within the watermark's
 * documented gaps, which a read can tolerate but a write target cannot. The
 * read costs one request, with no watermark, and leaves the cache untouched.
 * The internal force-recache parameter is no substitute: it costs a watermark
 * read as well, stores a single-use entry, and reaches ServiceNow unstripped
 * when no wrapper is in place.
 */
export function uncachedOperations(operations: ServiceNowOperations): ServiceNowOperations {
  return UNCACHED_OPERATIONS.get(operations) ?? operations;
}

/**
 * @param scope Cache partition key. Must identify the ServiceNow instance
 *   *and* the credential identity reading from it -- see the module docstring.
 */
export function createCachedServiceNowOperations(
  operations: ServiceNowOperations,
  scope: string,
  config: MetadataCacheConfigInput | undefined
): ServiceNowOperations {
  if (config === undefined && process.env.NODE_ENV === "test") {
    return operations;
  }
  const cacheConfig = createMetadataCacheConfig(config);
  const state = stateForScope(scope);
  // One watermark per table for this wrapper's lifetime, which is one tool
  // call: the dispatcher builds a wrapper per call. A hierarchy walk then
  // reads sys_db_object's watermark once, not once per hop. Any write the call
  // makes clears it, so the call's later reads see its own writes. No memo
  // spans calls: that would add staleness across calls for almost no time.
  const watermarks = new Map<string, Promise<WatermarkRead>>();
  const clearingWatermarks = <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await write(...args);
      } finally {
        watermarks.clear();
      }
    };
  const cached = Object.create(null) as ServiceNowOperations;
  Object.defineProperties(cached, {
    get: {
      value: async <T = Jsonish>(path: string, params?: Record<string, string>) =>
        (await cachedGetWithMeta<T>(operations, state, watermarks, cacheConfig, path, params)).data,
    },
    getWithMeta: {
      value: <T = Jsonish>(path: string, params?: Record<string, string>) =>
        cachedGetWithMeta<T>(operations, state, watermarks, cacheConfig, path, params),
    },
    post: { value: clearingWatermarks(operations.post.bind(operations)) },
    patch: { value: clearingWatermarks(operations.patch.bind(operations)) },
    delete: { value: clearingWatermarks(operations.delete.bind(operations)) },
    postBinary: { value: clearingWatermarks(operations.postBinary.bind(operations)) },
    getRaw: { value: operations.getRaw.bind(operations) },
    ...(operations.saveAtfStepInputs ? { saveAtfStepInputs: { value: clearingWatermarks(operations.saveAtfStepInputs.bind(operations)) } } : {}),
  });
  Object.freeze(cached);
  UNCACHED_OPERATIONS.set(cached, operations);
  return cached;
}

async function cachedGetWithMeta<T>(
  operations: ServiceNowOperations,
  state: ScopeState,
  watermarks: Map<string, Promise<WatermarkRead>>,
  config: MetadataCacheConfig,
  path: string,
  params: Record<string, string> | undefined
): Promise<RequestResult<T>> {
  // Strip the internal flag before any upstream call, including the
  // passthrough: sysparm_force_recache is this module's own parameter and must
  // never reach ServiceNow, whether or not the table is cached.
  const { cleanParams, forceRecache } = stripForceRecache(params);
  const match = metadataTableFromPath(path);
  if (!match || !tableMatches(config.tables, match)) {
    return operations.getWithMeta<T>(path, cleanParams);
  }

  const now = Date.now();
  const uncacheableUntil = state.uncacheable.get(match);
  if (uncacheableUntil !== undefined) {
    if (!forceRecache && uncacheableUntil > now) {
      return operations.getWithMeta<T>(path, cleanParams);
    }
    // Expired, or the caller asked for a refresh: try the watermark again.
    state.uncacheable.delete(match);
    watermarks.delete(match);
  }

  const cache = state.entries;
  const key = cacheKey(path, cleanParams);
  const existing = cache.get(key);

  // Read on a miss too, and always before the rows. An update landing between
  // the two reads is then in the rows but not the watermark, which costs one
  // extra refresh; read the other way round it would be in the watermark but
  // not the rows, and the next comparison would serve it stale until expiry.
  // A watermark memoized earlier in the call was also read before these rows.
  const read = await callWatermark(operations, watermarks, match);
  if (!read.usable) markUncacheable(state, match, read.reason, config.ttlMs);
  const watermark = read.usable ? read.watermark : undefined;
  if (
    !forceRecache &&
    existing !== undefined &&
    existing.expiresAt > now &&
    watermark !== undefined &&
    sameWatermark(existing.watermark, watermark)
  ) {
    // Re-insert to mark the entry most recently used for eviction order. Only
    // while it is still the one stored: another call may have evicted or
    // replaced it during the awaits above, and putting it back would hold
    // bytes the byte totals no longer count.
    if (cache.get(key) === existing) {
      cache.delete(key);
      cache.set(key, existing);
    }
    return cloneCachedResult<T>(existing);
  }

  // A forced refresh must never leave behind the rows it was asked to replace:
  // it is how a caller surfaces a write the watermark missed. Any other
  // refetch leaves the entry until it is replaced -- if these rows cannot be
  // kept, the old ones are still correct against any later watermark read that
  // matches theirs, so they serve again once the table is cacheable again.
  if (forceRecache) removeEntry(state, key);
  const fresh = await operations.getWithMeta<T>(path, cleanParams);
  // Only a materialized 200 body is reusable. A 204 carries no rows, and a
  // failed read throws before reaching here, so nothing negative is cached.
  // Rows without a watermark could never be revalidated, so they are not kept.
  if (fresh.status !== 200 || fresh.data === null || watermark === undefined) {
    return fresh;
  }
  // Serialize once: the string is both the size measure and the copy's source.
  const serialized = JSON.stringify(fresh.data);
  const bodyBytes = Buffer.byteLength(serialized, "utf8");
  if (bodyBytes > MAX_METADATA_CACHE_ENTRY_BYTES) {
    // Too big to keep. The older entry under this key is now known stale or
    // superseded, so free it rather than let its body sit until eviction.
    removeEntry(state, key);
    return fresh;
  }
  const headers = Object.freeze([...fresh.headers.entries()]);
  storeEntry(
    state,
    key,
    Object.freeze({
      expiresAt: now + config.ttlMs,
      watermark,
      data: JSON.parse(serialized) as Jsonish,
      status: fresh.status,
      headers,
      bytes:
        bodyBytes +
        key.length +
        headers.reduce((sum, [name, value]) => sum + name.length + value.length, 0) +
        ENTRY_OVERHEAD_BYTES,
    }),
    now
  );
  return fresh;
}

/**
 * Estimated bytes retained for one scope, or for the whole cache when no scope
 * is given. For tests and diagnostics; the cache never reads it.
 */
export function metadataCacheBytes(scope?: string): number {
  if (scope === undefined) return totalCachedBytes;
  return SCOPED_CACHES.get(scope)?.bytes ?? 0;
}

/** Drop one entry and release its bytes from the scope and the global total. */
function removeEntry(state: ScopeState, key: string): void {
  const entry = state.entries.get(key);
  if (entry === undefined) return;
  state.entries.delete(key);
  state.bytes -= entry.bytes;
  if (!state.detached) totalCachedBytes -= entry.bytes;
}

/**
 * Insert an entry, then enforce every bound. Expired entries at the old end
 * go first, since they can never be served again; the walk stops at the first
 * live entry, so it examines only what it removes plus one. Then the entry
 * count, the scope's byte budget and the global byte budget, each evicting
 * least recently used first.
 */
function storeEntry(state: ScopeState, key: string, entry: CacheEntry, now: number): void {
  if (state.detached) return;
  removeEntry(state, key);
  for (const [oldKey, oldEntry] of state.entries) {
    if (oldEntry.expiresAt > now) break;
    removeEntry(state, oldKey);
  }
  state.entries.set(key, entry);
  state.bytes += entry.bytes;
  totalCachedBytes += entry.bytes;
  evictEntries(state, (candidate) =>
    candidate.entries.size > MAX_METADATA_CACHE_ENTRIES_PER_SCOPE ||
    candidate.bytes > MAX_METADATA_CACHE_SCOPE_BYTES
  );
  // Over the global budget: the least recently used scope gives up entries
  // first (SCOPED_CACHES iterates in recency order, oldest first). A scope
  // emptied this way stays registered; it holds no bytes.
  for (const scopeState of SCOPED_CACHES.values()) {
    if (totalCachedBytes <= MAX_METADATA_CACHE_TOTAL_BYTES) break;
    evictEntries(scopeState, () => totalCachedBytes > MAX_METADATA_CACHE_TOTAL_BYTES);
  }
}

/** Evict a scope's oldest entries while `over` holds. */
function evictEntries(state: ScopeState, over: (state: ScopeState) => boolean): void {
  while (over(state)) {
    const oldest = state.entries.keys().next();
    if (oldest.done) return;
    removeEntry(state, oldest.value);
  }
}

function callWatermark(
  operations: ServiceNowOperations,
  watermarks: Map<string, Promise<WatermarkRead>>,
  table: string
): Promise<WatermarkRead> {
  let pending = watermarks.get(table);
  if (pending === undefined) {
    pending = tableWatermark(operations, table);
    watermarks.set(table, pending);
  }
  return pending;
}

function markUncacheable(
  state: ScopeState,
  table: string,
  reason: UnusableReason,
  ttlMs: number
): void {
  if (reason === "cancelled") return;
  const period = reason === "structural" ? STRUCTURAL_UNCACHEABLE_MS : TRANSIENT_UNCACHEABLE_MS;
  state.uncacheable.delete(table);
  state.uncacheable.set(table, Date.now() + Math.min(period, ttlMs));
  evictOldest(state.uncacheable, MAX_METADATA_CACHE_ENTRIES_PER_SCOPE);
}

/** Drop least-recently-used entries until the map is within `limit`. */
function evictOldest(entries: Map<string, unknown>, limit: number): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    entries.delete(oldest.value);
  }
}

/**
 * The table's row count and newest row by sys_updated_on, read back as stored.
 *
 * The order is evaluated on the instance and the values are compared as opaque
 * strings, so no date literal is ever built on this side. The count is the
 * X-Total-Count header of the same request, which carries the table's total
 * only while sysparm_no_count is left unset (with it set, the header still
 * comes back but holds the page size).
 *
 * A count of 0 with no rows is a valid watermark for an empty table: the
 * header counts rows before row ACLs filter them (a table whose newest row is
 * ACL-hidden reads back a positive count and no row), so any insert moves it.
 *
 * The watermark is unusable, structurally, when:
 * - the response is not a 200, or the count or a row field is missing or
 *   malformed (an unreadable sys_updated_on would compare equal forever);
 * - the count is positive but no row came back, which is what a row ACL that
 *   filters after the limit produces when it hides the newest row;
 * - the newest row is dated after the instance's own clock (the response Date
 *   header). Such a row stays the newest however many others are updated, so
 *   only the count would move, and in-place updates would go unseen.
 * A thrown read is classified by readFailureReason.
 */
async function tableWatermark(
  operations: ServiceNowOperations,
  table: string
): Promise<WatermarkRead> {
  const structural = { usable: false, reason: "structural" } as const;
  try {
    const response = await operations.getWithMeta<{ result?: unknown[] }>(
      `/api/now/table/${table}`,
      {
        sysparm_query: "ORDERBYDESCsys_updated_on",
        sysparm_fields: "sys_id,sys_updated_on",
        sysparm_limit: "1",
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      }
    );
    const count = response.headers.get("x-total-count") ?? "";
    if (response.status !== 200 || !ROW_COUNT.test(count)) return structural;
    const rows = response.data?.result;
    if (!Array.isArray(rows)) return structural;
    if (rows.length === 0) {
      return count === "0"
        ? { usable: true, watermark: Object.freeze({ count: 0, sysId: "", updatedOn: "" }) }
        : structural;
    }
    const row: unknown = rows[0];
    if (typeof row !== "object" || row === null) return structural;
    const { sys_id: sysId, sys_updated_on: updatedOn } = row as Record<string, unknown>;
    if (typeof sysId !== "string" || sysId === "") return structural;
    if (typeof updatedOn !== "string") return structural;
    const stored = STORED_DATE_TIME.exec(updatedOn);
    const updatedAt = stored ? Date.parse(`${stored[1]}T${stored[2]}Z`) : Number.NaN;
    const serverNow = Date.parse(response.headers.get("date") ?? "");
    if (!Number.isFinite(updatedAt) || !Number.isFinite(serverNow)) return structural;
    if (updatedAt > serverNow) return structural;
    return { usable: true, watermark: Object.freeze({ count: Number(count), sysId, updatedOn }) };
  } catch (error) {
    // A failed read must not serve stale metadata.
    return { usable: false, reason: readFailureReason(error) };
  }
}

/**
 * A 403, 404, 409 or other fixed rejection of this request shape will repeat,
 * so it is structural. A 401 (a token refresh can fix it), 429, 5xx, timeout,
 * network or unrecognized failure is transient.
 */
function readFailureReason(error: unknown): UnusableReason {
  if (isServiceNowRequestCancellation(error)) return "cancelled";
  const descriptor = trustedToolErrorDescriptor(error);
  switch (descriptor?.category) {
    case "authorization":
    case "not_found":
    case "conflict":
      return "structural";
    case "upstream":
      // The client marks a 5xx GET retryable and any other status do_not_retry.
      return descriptor.retry === "do_not_retry" ? "structural" : "transient";
    default:
      return "transient";
  }
}

/**
 * Every field counts. The count catches inserts and deletes; the sys_id also
 * catches the newest row being replaced as newest within the same second. A
 * tie at the top that the instance orders differently between reads only
 * costs an extra refresh.
 */
function sameWatermark(left: Watermark, right: Watermark): boolean {
  return (
    left.count === right.count &&
    left.sysId === right.sysId &&
    left.updatedOn === right.updatedOn
  );
}

function metadataTableFromPath(path: string): string | undefined {
  const match = /^\/api\/now\/table\/([a-z][a-z0-9_]{0,79})(?:\/|$)/u.exec(path);
  return match?.[1];
}

function tableMatches(patterns: readonly string[], table: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*")
      ? table.startsWith(pattern.slice(0, -1))
      : pattern === table
  );
}

function stripForceRecache(params: Record<string, string> | undefined): {
  readonly cleanParams: Record<string, string> | undefined;
  readonly forceRecache: boolean;
} {
  if (!params || params[FORCE_RECACHE_PARAM] === undefined) {
    return { cleanParams: params, forceRecache: false };
  }
  const { [FORCE_RECACHE_PARAM]: forceValue, ...rest } = params;
  return {
    cleanParams: Object.keys(rest).length === 0 ? undefined : rest,
    forceRecache: forceValue === "true" || forceValue === "1",
  };
}

function stateForScope(scope: string): ScopeState {
  const existing = SCOPED_CACHES.get(scope);
  if (existing) {
    SCOPED_CACHES.delete(scope);
    SCOPED_CACHES.set(scope, existing);
    return existing;
  }
  const next: ScopeState = { entries: new Map(), uncacheable: new Map(), bytes: 0, detached: false };
  SCOPED_CACHES.set(scope, next);
  while (SCOPED_CACHES.size > MAX_METADATA_CACHE_SCOPES) {
    const oldest = SCOPED_CACHES.entries().next();
    if (oldest.done) break;
    const [oldScope, oldState] = oldest.value;
    SCOPED_CACHES.delete(oldScope);
    totalCachedBytes -= oldState.bytes;
    oldState.entries.clear();
    oldState.bytes = 0;
    oldState.detached = true;
  }
  return next;
}

function cacheKey(path: string, params: Record<string, string> | undefined): string {
  return JSON.stringify({
    path,
    params: Object.fromEntries(Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  });
}

function cloneCachedResult<T>(entry: CacheEntry): RequestResult<T> {
  return {
    data: cloneJson(entry.data) as T | null,
    status: entry.status,
    headers: new Headers([...entry.headers]),
  };
}

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateTtlMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CACHE_TTL_MS
  ) {
    throw new TypeError(`metadata cache TTL must be between 1 and ${MAX_CACHE_TTL_MS}`);
  }
  return value;
}

function parseTablePatterns(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value.split(",").map((entry) => entry.trim());
}

function normalizeTablePatterns(patterns: readonly string[]): readonly string[] {
  if (!Array.isArray(patterns) || patterns.length > MAX_CACHE_TABLE_PATTERNS) {
    throw new TypeError("metadata cache tables are invalid or exceed the limit");
  }
  const out = new Set<string>();
  for (const candidate of patterns) {
    if (typeof candidate !== "string") {
      throw new TypeError("metadata cache table pattern must be a string");
    }
    const normalized = candidate.trim().toLowerCase();
    const base = normalized.endsWith("*") ? normalized.slice(0, -1) : normalized;
    if (!TABLE_NAME.test(base)) {
      throw new TypeError("metadata cache table pattern must be a ServiceNow identifier or prefix*");
    }
    out.add(normalized);
  }
  return Object.freeze([...out].sort());
}
