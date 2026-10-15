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
 * never request count. sys_properties is deliberately absent: its rows are
 * ACL-restricted per user and routinely hold integration secrets in `value`,
 * and the only reads of it here are three single-value build-info lookups
 * whose payloads are far too small to be worth retaining for a day. Operators
 * who want it can add it through SN_METADATA_CACHE_TABLES.
 */
export const DEFAULT_METADATA_CACHE_TABLES = Object.freeze([
  "sys_glide_object",
  "sys_dictionary",
  "sys_db_object",
  "sys_app",
  "sys_plugins",
  "sys_metadata*",
  "sys_flow*",
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
}

interface ScopeState {
  readonly entries: Map<string, CacheEntry>;
  /** Table -> epoch ms until which its reads pass through without a watermark. */
  readonly uncacheable: Map<string, number>;
}

const SCOPED_CACHES = new Map<string, ScopeState>();
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
  return Object.freeze(cached);
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
    // Re-insert to mark the entry most recently used for eviction order.
    cache.delete(key);
    cache.set(key, existing);
    return cloneCachedResult<T>(existing);
  }

  // A forced refresh must never leave behind the rows it was asked to replace:
  // it is how a caller surfaces a write the watermark missed. Any other
  // refetch leaves the entry until it is replaced -- if these rows cannot be
  // kept, the old ones are still correct against any later watermark read that
  // matches theirs, so they serve again once the table is cacheable again.
  if (forceRecache) cache.delete(key);
  const fresh = await operations.getWithMeta<T>(path, cleanParams);
  // Only a materialized 200 body is reusable. A 204 carries no rows, and a
  // failed read throws before reaching here, so nothing negative is cached.
  // Rows without a watermark could never be revalidated, so they are not kept.
  if (fresh.status !== 200 || fresh.data === null || watermark === undefined) {
    return fresh;
  }
  cache.delete(key);
  cache.set(
    key,
    Object.freeze({
      expiresAt: now + config.ttlMs,
      watermark,
      data: cloneJson(fresh.data),
      status: fresh.status,
      headers: Object.freeze([...fresh.headers.entries()]),
    })
  );
  evictOldest(cache, MAX_METADATA_CACHE_ENTRIES_PER_SCOPE);
  return fresh;
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
  const next: ScopeState = Object.freeze({ entries: new Map(), uncacheable: new Map() });
  SCOPED_CACHES.set(scope, next);
  evictOldest(SCOPED_CACHES, MAX_METADATA_CACHE_SCOPES);
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
