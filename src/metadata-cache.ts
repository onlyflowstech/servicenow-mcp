/**
 * Per-identity read-through cache for stable ServiceNow metadata table reads.
 *
 * Cached reads are scoped by caller-supplied cache scope and full GET
 * selector. The scope must discriminate credential identity as well as
 * instance: ServiceNow evaluates ACLs per user, and a cache hit skips the
 * upstream read entirely, so a scope shared between identities would serve
 * one caller's authorized rows to another. A cache hit performs a lightweight
 * sys_updated_on probe before reuse; changed rows force a refresh. Callers can
 * force refresh by passing the internal sysparm_force_recache=true parameter,
 * which is stripped before upstream I/O.
 *
 * The freshness probe compares sys_updated_on, which ServiceNow evaluates in
 * the session user's timezone, so the probe timestamp is formatted in that
 * timezone rather than UTC. The zone is resolved per identity from
 * sys_user.time_zone, falling back to the glide.sys.default.tz property; when
 * it cannot be resolved, caching is disabled for that identity rather than
 * assuming UTC and serving silently stale metadata.
 *
 * Deletions are not detected by the probe, which sees updates only. A row
 * deleted upstream stays visible for at most one TTL: a successful probe
 * refreshes recency for eviction but never extends expiresAt, so the entry
 * still expires on schedule and forces a genuine refetch.
 *
 * @module metadata-cache
 */

import type {
  RequestResult,
  ServiceNowOperations,
} from "./client.js";
import { parsePositiveIntegerEnv } from "./config.js";
import { escapeQueryValue } from "./utils.js";

export const DEFAULT_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Tables cached by default.
 *
 * The bar for inclusion is a large payload relative to the freshness probe,
 * not merely "this table changes rarely" -- a cache hit still costs one
 * upstream round trip (see hasChangedSince), so the saving is payload bytes,
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

interface CacheEntry {
  readonly expiresAt: number;
  readonly lastSyncedAt: number;
  readonly data: Jsonish | null;
  readonly status: number;
  readonly headers: readonly [string, string][];
}

const SCOPED_CACHES = new Map<string, Map<string, CacheEntry>>();
const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
export const FORCE_RECACHE_PARAM = "sysparm_force_recache";
const MAX_CACHE_TABLE_PATTERNS = 128;
const MAX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds on process-global cache state. Scopes multiply with credential
 * rotation and profiles, and entries multiply with distinct GET selectors,
 * so both are capped and evicted in least-recently-used order. */
export const MAX_METADATA_CACHE_SCOPES = 64;
export const MAX_METADATA_CACHE_ENTRIES_PER_SCOPE = 512;

/**
 * Resolved ServiceNow session timezone per cache scope.
 *
 * A timezone NAME is cached, never a numeric offset: an offset is wrong for
 * half the year, and a cached one silently reintroduces the skew at every DST
 * transition -- the longer the TTL, the longer it stays wrong. The offset is
 * computed from the name for the specific instant being compared.
 *
 * Keyed by the same scope as the metadata cache, so it discriminates instance
 * AND credential identity: two profiles on one instance can authenticate as
 * accounts in different timezones, and sharing a resolution between them would
 * corrupt the freshness window for both.
 */
const SCOPED_TIME_ZONES = new Map<string, Promise<string | undefined>>();
const TIME_ZONE_WARNED_SCOPES = new Set<string>();
const DEFAULT_TIME_ZONE_PROPERTY = "glide.sys.default.tz";

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
 * @param sessionUserName ServiceNow user_name this scope authenticates as.
 *   Required to resolve the session timezone; without it the freshness probe
 *   cannot be made correct, so caching is disabled for the scope.
 */
export function createCachedServiceNowOperations(
  operations: ServiceNowOperations,
  scope: string,
  config: MetadataCacheConfigInput | undefined,
  sessionUserName?: string
): ServiceNowOperations {
  if (config === undefined && process.env.NODE_ENV === "test") {
    return operations;
  }
  const cacheConfig = createMetadataCacheConfig(config);
  const scopedCache = cacheForScope(scope);
  const cached = Object.create(null) as ServiceNowOperations;
  Object.defineProperties(cached, {
    get: {
      value: async <T = Jsonish>(path: string, params?: Record<string, string>) =>
        (
          await cachedGetWithMeta<T>(
            operations,
            scopedCache,
            cacheConfig,
            path,
            params,
            { scope, sessionUserName }
          )
        ).data,
    },
    getWithMeta: {
      value: <T = Jsonish>(path: string, params?: Record<string, string>) =>
        cachedGetWithMeta<T>(operations, scopedCache, cacheConfig, path, params, {
          scope,
          sessionUserName,
        }),
    },
    post: { value: operations.post.bind(operations) },
    patch: { value: operations.patch.bind(operations) },
    delete: { value: operations.delete.bind(operations) },
    postBinary: { value: operations.postBinary.bind(operations) },
    getRaw: { value: operations.getRaw.bind(operations) },
  });
  return Object.freeze(cached);
}

interface CacheIdentity {
  readonly scope: string;
  readonly sessionUserName: string | undefined;
}

async function cachedGetWithMeta<T>(
  operations: ServiceNowOperations,
  cache: Map<string, CacheEntry>,
  config: MetadataCacheConfig,
  path: string,
  params: Record<string, string> | undefined,
  identity: CacheIdentity
): Promise<RequestResult<T>> {
  // Strip the internal flag before any upstream call, including the
  // passthrough: sysparm_force_recache is this module's own parameter and must
  // never reach ServiceNow, whether or not the table is cached.
  const { cleanParams, forceRecache } = stripForceRecache(params);
  const match = metadataTableFromPath(path);
  if (!match || !tableMatches(config.tables, match)) {
    return operations.getWithMeta<T>(path, cleanParams);
  }

  // The freshness probe compares sys_updated_on in the session user's
  // timezone. Without knowing that timezone the probe is wrong by the offset,
  // so caching is disabled for this identity rather than assuming UTC.
  const timeZone = await sessionTimeZone(operations, identity);
  if (timeZone === undefined) {
    return operations.getWithMeta<T>(path, cleanParams);
  }

  const key = cacheKey(path, cleanParams);
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt <= now) cache.delete(key);
  if (!forceRecache && existing && existing.expiresAt > now) {
    const changed = await hasChangedSince(
      operations,
      match,
      existing.lastSyncedAt,
      timeZone
    );
    if (!changed) {
      // Re-insert to mark the entry most recently used for eviction order.
      cache.delete(key);
      cache.set(key, existing);
      return cloneCachedResult<T>(existing);
    }
  }

  const lastSyncedAt = Date.now();
  const fresh = await operations.getWithMeta<T>(path, cleanParams);
  // Only a materialized 200 body is reusable. A 204 carries no rows, and a
  // failed read throws before reaching here, so nothing negative is cached.
  if (fresh.status !== 200 || fresh.data === null) return fresh;
  cache.delete(key);
  cache.set(
    key,
    Object.freeze({
      expiresAt: lastSyncedAt + config.ttlMs,
      lastSyncedAt,
      data: cloneJson(fresh.data),
      status: fresh.status,
      headers: Object.freeze([...fresh.headers.entries()]),
    })
  );
  evictOldest(cache, MAX_METADATA_CACHE_ENTRIES_PER_SCOPE);
  return fresh;
}

/** Drop least-recently-used entries until the map is within `limit`. */
function evictOldest(entries: Map<string, unknown>, limit: number): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    entries.delete(oldest.value);
  }
}

async function hasChangedSince(
  operations: ServiceNowOperations,
  table: string,
  lastSyncedAt: number,
  timeZone: string
): Promise<boolean> {
  try {
    const response = await operations.get<{ result?: unknown[] }>(
      `/api/now/table/${table}`,
      {
        sysparm_query: `sys_updated_on>${serviceNowDateTime(lastSyncedAt, timeZone)}`,
        sysparm_fields: "sys_id,sys_updated_on",
        sysparm_limit: "1",
        sysparm_no_count: "true",
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      }
    );
    return Array.isArray(response?.result) && response.result.length > 0;
  } catch {
    // A failed probe must not serve stale metadata indefinitely.
    return true;
  }
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

function cacheForScope(scope: string): Map<string, CacheEntry> {
  const existing = SCOPED_CACHES.get(scope);
  if (existing) {
    SCOPED_CACHES.delete(scope);
    SCOPED_CACHES.set(scope, existing);
    return existing;
  }
  const next = new Map<string, CacheEntry>();
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

/**
 * Format an instant as ServiceNow's `YYYY-MM-DD HH:mm:ss` in the given zone.
 *
 * The offset is derived from the zone NAME for this specific instant, so a
 * timestamp on either side of a DST transition resolves to the offset actually
 * in force then. This is why the name is what gets cached.
 */
function serviceNowDateTime(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return (
    `${field("year")}-${field("month")}-${field("day")} ` +
    `${field("hour")}:${field("minute")}:${field("second")}`
  );
}

/** True when Intl recognizes the name, so a bad value never silently formats. */
function isUsableTimeZone(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve, and memoize per scope, the timezone the session user's
 * `sys_updated_on` comparisons are evaluated in.
 *
 * Chain: the user's own `sys_user.time_zone`, then the instance default in
 * `glide.sys.default.tz`, then unresolved. `time_zone` is not a required field
 * and is frequently empty; an empty value means "inherit the system default"
 * and must never be read as UTC, which is the very error this fixes.
 */
async function sessionTimeZone(
  operations: ServiceNowOperations,
  identity: CacheIdentity
): Promise<string | undefined> {
  const existing = SCOPED_TIME_ZONES.get(identity.scope);
  if (existing) {
    SCOPED_TIME_ZONES.delete(identity.scope);
    SCOPED_TIME_ZONES.set(identity.scope, existing);
    return existing;
  }
  const pending = resolveSessionTimeZone(operations, identity);
  SCOPED_TIME_ZONES.set(identity.scope, pending);
  evictOldest(SCOPED_TIME_ZONES, MAX_METADATA_CACHE_SCOPES);
  return pending;
}

async function resolveSessionTimeZone(
  operations: ServiceNowOperations,
  identity: CacheIdentity
): Promise<string | undefined> {
  const resolved =
    (await userTimeZone(operations, identity.sessionUserName)) ??
    (await instanceDefaultTimeZone(operations));
  if (resolved === undefined) warnTimeZoneUnresolved(identity);
  return resolved;
}

async function userTimeZone(
  operations: ServiceNowOperations,
  sessionUserName: string | undefined
): Promise<string | undefined> {
  if (typeof sessionUserName !== "string" || sessionUserName.trim() === "") {
    return undefined;
  }
  return firstUsableValue(operations, "/api/now/table/sys_user", {
    sysparm_query: `user_name=${escapeQueryValue(sessionUserName.trim())}`,
    sysparm_fields: "time_zone",
    sysparm_limit: "1",
  }, "time_zone");
}

async function instanceDefaultTimeZone(
  operations: ServiceNowOperations
): Promise<string | undefined> {
  return firstUsableValue(operations, "/api/now/table/sys_properties", {
    sysparm_query: `name=${DEFAULT_TIME_ZONE_PROPERTY}`,
    sysparm_fields: "value",
    sysparm_limit: "1",
  }, "value");
}

async function firstUsableValue(
  operations: ServiceNowOperations,
  path: string,
  params: Record<string, string>,
  field: string
): Promise<string | undefined> {
  try {
    const response = await operations.get<{ result?: unknown[] }>(path, {
      ...params,
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
    });
    const row = Array.isArray(response?.result) ? response.result[0] : undefined;
    if (typeof row !== "object" || row === null) return undefined;
    const value = (row as Record<string, unknown>)[field];
    return isUsableTimeZone(value) ? value.trim() : undefined;
  } catch {
    // An unreadable lookup is indistinguishable from an empty one here, and
    // both mean the same thing: the probe cannot be made correct.
    return undefined;
  }
}

/**
 * Report the degradation once per scope. Names the account, never the scope
 * key -- that carries the credential fingerprint.
 */
function warnTimeZoneUnresolved(identity: CacheIdentity): void {
  if (TIME_ZONE_WARNED_SCOPES.has(identity.scope)) return;
  TIME_ZONE_WARNED_SCOPES.add(identity.scope);
  const account =
    typeof identity.sessionUserName === "string" && identity.sessionUserName.trim() !== ""
      ? `account "${identity.sessionUserName.trim()}"`
      : "an account with no configured user name";
  process.stderr.write(
    `[servicenow-mcp] WARNING: metadata caching is disabled for ${account}: the ` +
      `ServiceNow session timezone could not be resolved. Grant read access to ` +
      `sys_user (time_zone) and sys_properties (${DEFAULT_TIME_ZONE_PROPERTY}), or ` +
      `set the account's timezone, to re-enable it.\n`
  );
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
