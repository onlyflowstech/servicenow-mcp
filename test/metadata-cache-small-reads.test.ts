import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWithServiceNowRequestSignal,
  type RequestResult,
  type ServiceNowOperations,
} from "../src/client.js";
import { CallMetrics } from "../src/call-metrics.js";
import {
  FORCE_RECACHE_PARAM,
  MAX_SMALL_READ_KEYS_PER_SCOPE,
  SMALL_READ_KEY_RAW_LENGTH,
  SMALL_READ_BYTES,
  createCachedServiceNowOperations,
  createMetadataCacheConfig,
  metadataCacheBytes,
} from "../src/metadata-cache.js";

/**
 * A response below SMALL_READ_BYTES is not kept: a cache hit costs a watermark
 * round trip, about what the plain read costs, so keeping it saves nothing.
 * Its key is remembered as small, and later reads go straight upstream in one
 * request. These tests count requests; no ServiceNow is involved.
 */

const PATH = "/api/now/table/sys_script_include";
const WATERMARK_QUERY = "ORDERBYDESCsys_updated_on";
const EMPTY_BODY_BYTES = Buffer.byteLength(JSON.stringify({ result: [{ pad: "" }] }), "utf8");

/** A body whose serialized size is exactly `bytes`. */
function bodyOf(bytes: number): unknown {
  return { result: [{ pad: "x".repeat(bytes - EMPTY_BODY_BYTES) }] };
}

function upstream() {
  const state = { bodyBytes: 1_000, newest: "2026-11-14 12:00:00", failFullRead: false };
  const watermark = vi.fn();
  const fullReads = vi.fn();
  const getWithMeta = async (
    path: string,
    params?: Record<string, string>
  ): Promise<RequestResult<unknown>> => {
    if (params?.sysparm_query === WATERMARK_QUERY) {
      watermark(path, params);
      return {
        data: { result: [{ sys_id: "row-1", sys_updated_on: state.newest }] },
        status: 200,
        headers: new Headers({
          "x-total-count": "10",
          date: "Sat, 14 Nov 2026 13:00:00 GMT",
        }),
      };
    }
    fullReads(path, params);
    if (state.failFullRead) throw new Error("socket hang up");
    return { data: bodyOf(state.bodyBytes), status: 200, headers: new Headers() };
  };
  const base = {
    get: vi.fn(),
    getWithMeta,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postBinary: vi.fn(),
    getRaw: vi.fn(),
  } as unknown as ServiceNowOperations;
  return { base, state, watermark, fullReads };
}

let scopeSequence = 0;
const nextScope = () => `https://small-reads-${(scopeSequence += 1)}.service-now.com|identity`;

/** One read as its own tool call (one wrapper per call), reporting its cache outcome. */
async function read(
  base: ServiceNowOperations,
  scope: string,
  params: Record<string, string> = { sysparm_fields: "sys_id" },
  config?: Parameters<typeof createCachedServiceNowOperations>[2]
): Promise<string | undefined> {
  const metrics = new CallMetrics();
  await runWithServiceNowRequestSignal(
    new AbortController().signal,
    () => createCachedServiceNowOperations(base, scope, config ?? {}).getWithMeta(PATH, params),
    metrics
  );
  return metrics.snapshot().cache;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("metadata cache: small responses", () => {
  it("reads a small response in one plain request from the second call on, with no watermark", async () => {
    const { base, watermark, fullReads } = upstream();
    const scope = nextScope();

    expect(await read(base, scope)).toBe("miss");
    // The first read paid its watermark and then fetched the rows.
    expect(watermark).toHaveBeenCalledTimes(1);
    expect(fullReads).toHaveBeenCalledTimes(1);

    expect(await read(base, scope)).toBe("miss");
    expect(await read(base, scope)).toBe("miss");
    expect(watermark).toHaveBeenCalledTimes(1);
    expect(fullReads).toHaveBeenCalledTimes(3);
    // Nothing was kept.
    expect(metadataCacheBytes(scope)).toBe(0);
  });

  it("still serves a large response from the cache, with one watermark request per hit", async () => {
    const { base, state, watermark, fullReads } = upstream();
    state.bodyBytes = SMALL_READ_BYTES;
    const scope = nextScope();

    expect(await read(base, scope)).toBe("miss");
    expect(await read(base, scope)).toBe("hit");
    expect(await read(base, scope)).toBe("hit");

    expect(fullReads).toHaveBeenCalledTimes(1);
    expect(watermark).toHaveBeenCalledTimes(3);
    expect(metadataCacheBytes(scope)).toBeGreaterThan(SMALL_READ_BYTES);
  });

  it("draws the line at SMALL_READ_BYTES: one byte under is not kept, the threshold itself is", async () => {
    const under = upstream();
    under.state.bodyBytes = SMALL_READ_BYTES - 1;
    const scopeUnder = nextScope();
    await read(under.base, scopeUnder);
    await read(under.base, scopeUnder);
    expect(under.fullReads).toHaveBeenCalledTimes(2);
    expect(under.watermark).toHaveBeenCalledTimes(1);

    const at = upstream();
    at.state.bodyBytes = SMALL_READ_BYTES;
    const scopeAt = nextScope();
    await read(at.base, scopeAt);
    await read(at.base, scopeAt);
    expect(at.fullReads).toHaveBeenCalledTimes(1);
    expect(at.watermark).toHaveBeenCalledTimes(2);
  });

  it("caches again once a remembered-small key comes back large", async () => {
    const { base, state, watermark, fullReads } = upstream();
    const scope = nextScope();

    await read(base, scope); // small: marked
    await read(base, scope); // direct
    expect(watermark).toHaveBeenCalledTimes(1);

    state.bodyBytes = SMALL_READ_BYTES + 5_000;
    // The direct read sees the large body and forgets the mark. It is not kept
    // itself: only a read that paid the watermark can be stored.
    expect(await read(base, scope)).toBe("miss");
    expect(watermark).toHaveBeenCalledTimes(1);
    expect(fullReads).toHaveBeenCalledTimes(3);
    expect(metadataCacheBytes(scope)).toBe(0);

    // The next read takes the cached path and keeps the rows.
    expect(await read(base, scope)).toBe("miss");
    expect(watermark).toHaveBeenCalledTimes(2);
    expect(fullReads).toHaveBeenCalledTimes(4);
    expect(metadataCacheBytes(scope)).toBeGreaterThan(SMALL_READ_BYTES);

    expect(await read(base, scope)).toBe("hit");
    expect(fullReads).toHaveBeenCalledTimes(4);
    expect(watermark).toHaveBeenCalledTimes(3);
  });

  it("drops a cached entry whose refetch comes back small, and reads that key directly", async () => {
    const { base, state, watermark, fullReads } = upstream();
    state.bodyBytes = SMALL_READ_BYTES + 1_000;
    const scope = nextScope();

    await read(base, scope);
    expect(metadataCacheBytes(scope)).toBeGreaterThan(0);

    // The table changed and the rows shrank.
    state.newest = "2026-11-14 12:30:00";
    state.bodyBytes = 2_000;
    expect(await read(base, scope)).toBe("miss");
    expect(metadataCacheBytes(scope)).toBe(0);

    const watermarksBefore = watermark.mock.calls.length;
    expect(await read(base, scope)).toBe("miss");
    expect(watermark).toHaveBeenCalledTimes(watermarksBefore);
    expect(fullReads).toHaveBeenCalledTimes(3);
  });

  it("remembers keys separately: a large read of one selector does not make another direct", async () => {
    const { base, state, watermark } = upstream();
    const scope = nextScope();
    const small = { sysparm_fields: "sys_id" };
    const large = { sysparm_fields: "sys_id,script" };

    await read(base, scope, small);
    state.bodyBytes = SMALL_READ_BYTES;
    await read(base, scope, large);
    expect(watermark).toHaveBeenCalledTimes(2);

    expect(await read(base, scope, large)).toBe("hit");
    expect(watermark).toHaveBeenCalledTimes(3);
    await read(base, scope, small); // direct
    expect(watermark).toHaveBeenCalledTimes(3);
  });

  it("keeps force_recache a bypass, and re-measures the response", async () => {
    const { base, state, watermark, fullReads } = upstream();
    const scope = nextScope();
    const forced = { sysparm_fields: "sys_id", [FORCE_RECACHE_PARAM]: "true" };

    await read(base, scope);
    await read(base, scope); // direct
    expect(watermark).toHaveBeenCalledTimes(1);

    // Forced: the watermark is read and the rows are fetched, and the flag
    // never reaches the instance.
    expect(await read(base, scope, forced)).toBe("bypass");
    expect(watermark).toHaveBeenCalledTimes(2);
    expect(fullReads).toHaveBeenCalledTimes(3);
    expect(fullReads).toHaveBeenLastCalledWith(PATH, { sysparm_fields: "sys_id" });

    // Still small: the key goes straight upstream again.
    await read(base, scope);
    expect(watermark).toHaveBeenCalledTimes(2);

    // Forced, and the rows have grown: now they are cached.
    state.bodyBytes = SMALL_READ_BYTES + 1_000;
    expect(await read(base, scope, forced)).toBe("bypass");
    expect(metadataCacheBytes(scope)).toBeGreaterThan(SMALL_READ_BYTES);
    expect(await read(base, scope)).toBe("hit");
  });

  it("scopes the memory like the cache: another credential on the same instance pays its own watermark", async () => {
    const { base, watermark } = upstream();
    const instance = "https://small-scope.service-now.com";
    const admin = `${instance}|admin`;
    const reader = `${instance}|reader`;

    await read(base, admin);
    await read(base, admin); // direct: no watermark
    expect(watermark).toHaveBeenCalledTimes(1);

    // The reader has never read this key, so nothing is known about it.
    await read(base, reader);
    expect(watermark).toHaveBeenCalledTimes(2);
    await read(base, reader); // now direct for the reader too
    expect(watermark).toHaveBeenCalledTimes(2);
  });

  it("bounds the memory by key count, evicting the least recently used", async () => {
    const { base, watermark } = upstream();
    const scope = nextScope();
    const key = (index: number) => ({ sysparm_fields: "sys_id", sysparm_query: `k${index}` });

    for (let index = 0; index < MAX_SMALL_READ_KEYS_PER_SCOPE; index += 1) {
      await read(base, scope, key(index));
    }
    // Touch key 0 (a direct read refreshes recency), then add one more key.
    await read(base, scope, key(0));
    await read(base, scope, key(MAX_SMALL_READ_KEYS_PER_SCOPE));
    const afterFill = watermark.mock.calls.length;
    expect(afterFill).toBe(MAX_SMALL_READ_KEYS_PER_SCOPE + 1);

    // Key 0 survived and reads directly; key 1, the oldest, was forgotten and
    // pays a watermark again.
    await read(base, scope, key(0));
    expect(watermark).toHaveBeenCalledTimes(afterFill);
    await read(base, scope, key(1));
    expect(watermark).toHaveBeenCalledTimes(afterFill + 1);
  });

  it("remembers a long key by its digest: 2,100- and 8,000-character selectors cost one watermark in total", async () => {
    const { base, watermark, fullReads } = upstream();
    const scope = nextScope();
    for (const length of [2_100, 8_000]) {
      const long = { sysparm_fields: "sys_id", sysparm_query: "a".repeat(length) };
      for (let call = 0; call < 3; call += 1) {
        expect(await read(base, scope, long)).toBe("miss");
      }
    }
    // One watermark per selector, on its first read; the repeats are plain reads.
    expect(watermark).toHaveBeenCalledTimes(2);
    expect(fullReads).toHaveBeenCalledTimes(6);
    expect(metadataCacheBytes(scope)).toBe(0);
  });

  it("treats the memo's keys at the raw-length boundary alike, and keeps long ones distinct", async () => {
    const { base, watermark } = upstream();
    const scope = nextScope();
    // The cache key is JSON around the selector; pad it to either side of the limit.
    const overhead = JSON.stringify({ path: PATH, params: { sysparm_fields: "sys_id", sysparm_query: "" } }).length;
    const atLimit = { sysparm_fields: "sys_id", sysparm_query: "b".repeat(SMALL_READ_KEY_RAW_LENGTH - overhead) };
    const overLimit = { sysparm_fields: "sys_id", sysparm_query: "b".repeat(SMALL_READ_KEY_RAW_LENGTH - overhead + 1) };
    for (const params of [atLimit, overLimit]) {
      await read(base, scope, params);
      await read(base, scope, params);
    }
    expect(watermark).toHaveBeenCalledTimes(2);

    // Two long selectors that differ in one character are separate keys.
    const one = { sysparm_fields: "sys_id", sysparm_query: `${"c".repeat(3_000)}1` };
    const other = { sysparm_fields: "sys_id", sysparm_query: `${"c".repeat(3_000)}2` };
    await read(base, scope, one);
    await read(base, scope, other);
    expect(watermark).toHaveBeenCalledTimes(4);
  });

  it("expires the memory with the cache TTL, and a direct read does not extend it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    const { base, watermark } = upstream();
    const scope = nextScope();
    const config = { ttlMs: 1_000 };

    await read(base, scope, undefined, config); // marked until +1000
    vi.setSystemTime(new Date("2026-11-14T12:00:00.600Z"));
    await read(base, scope, undefined, config); // direct
    expect(watermark).toHaveBeenCalledTimes(1);

    // 1,100 ms after the measuring read, though only 500 after the direct one.
    vi.setSystemTime(new Date("2026-11-14T12:00:01.100Z"));
    await read(base, scope, undefined, config);
    expect(watermark).toHaveBeenCalledTimes(2);
    // Measured again, found small, remembered for another TTL.
    await read(base, scope, undefined, config);
    expect(watermark).toHaveBeenCalledTimes(2);
  });

  it("leaves the mark in place when a direct read fails", async () => {
    const { base, state, watermark } = upstream();
    const scope = nextScope();

    await read(base, scope);
    state.failFullRead = true;
    await expect(read(base, scope)).rejects.toThrow("socket hang up");
    state.failFullRead = false;
    await read(base, scope);
    expect(watermark).toHaveBeenCalledTimes(1);
  });

  it("does not remember a response that was not a materialized 200", async () => {
    const { base, watermark } = upstream();
    const noContent = {
      ...base,
      getWithMeta: async (path: string, params?: Record<string, string>) =>
        params?.sysparm_query === WATERMARK_QUERY
          ? base.getWithMeta(path, params)
          : ({ data: null, status: 204, headers: new Headers() } as RequestResult<unknown>),
    } as unknown as ServiceNowOperations;
    const scope = nextScope();

    await read(noContent, scope);
    await read(noContent, scope);
    expect(watermark).toHaveBeenCalledTimes(2);
  });

  it("caches every response when smallReadBytes is 0, and rejects values outside its range", async () => {
    const { base, watermark, fullReads } = upstream();
    const scope = nextScope();

    await read(base, scope, undefined, { smallReadBytes: 0 });
    expect(await read(base, scope, undefined, { smallReadBytes: 0 })).toBe("hit");
    expect(fullReads).toHaveBeenCalledTimes(1);
    expect(watermark).toHaveBeenCalledTimes(2);

    expect(createMetadataCacheConfig(undefined).smallReadBytes).toBe(SMALL_READ_BYTES);
    for (const value of [-1, 1.5, Number.NaN, 512 * 1024 + 1]) {
      expect(() => createMetadataCacheConfig({ smallReadBytes: value })).toThrow(TypeError);
    }
  });
});
