import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestResult, ServiceNowOperations } from "../src/client.js";
import {
  MAX_METADATA_CACHE_ENTRIES_PER_SCOPE,
  MAX_METADATA_CACHE_ENTRY_BYTES,
  MAX_METADATA_CACHE_SCOPE_BYTES,
  MAX_METADATA_CACHE_TOTAL_BYTES,
  FORCE_RECACHE_PARAM,
  createCachedServiceNowOperations,
  metadataCacheBytes,
} from "../src/metadata-cache.js";

/**
 * The cache is bounded by bytes as well as by entry count. Every payload here
 * is synthetic padding; the upstream double sizes each response from the
 * `size` selector, so a test states exactly how large an entry is.
 */

let scopeCounter = 0;
const nextScope = () => `https://bytes-${(scopeCounter += 1)}.service-now.com|identity`;

function upstream() {
  const table: { count: number; sizeOverride: number | undefined } = { count: 7, sizeOverride: undefined };
  const fullReads: string[] = [];
  const getWithMeta = vi.fn(
    async (path: string, params: Record<string, string> = {}): Promise<RequestResult<unknown>> => {
      if (params.sysparm_query === "ORDERBYDESCsys_updated_on") {
        return {
          data: { result: [{ sys_id: "newest", sys_updated_on: "2026-11-01 08:00:00" }] },
          status: 200,
          headers: new Headers({
            "x-total-count": String(table.count),
            date: new Date(Date.now() + 60_000).toUTCString(),
          }),
        };
      }
      fullReads.push(params.id ?? "?");
      return {
        data: { result: [{ pad: "x".repeat(table.sizeOverride ?? Number(params.size ?? 100)) }] },
        status: 200,
        headers: new Headers(),
      };
    }
  );
  const base = {
    get: vi.fn(),
    getWithMeta,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postBinary: vi.fn(),
    getRaw: vi.fn(),
  } as unknown as ServiceNowOperations;
  /** One wrapper per tool call, as the dispatcher builds them. */
  const read = (scope: string, id: string, size: number, extra: Record<string, string> = {}, ttlMs = 60_000) =>
    createCachedServiceNowOperations(base, scope, { ttlMs, smallReadBytes: 0 }).getWithMeta("/api/now/table/sys_dictionary", {
      id,
      size: String(size),
      ...extra,
    });
  return { read, table, fullReads };
}

const KIB = 1024;
const MIB = 1024 * KIB;
/** About 480 KiB of body: under the entry cap, so 68 of them fill a scope. */
const BIG = 480 * KIB;

afterEach(() => {
  vi.useRealTimers();
});

describe("metadata cache byte bounds", () => {
  it("exports the documented limits", () => {
    expect(MAX_METADATA_CACHE_ENTRY_BYTES).toBe(512 * KIB);
    expect(MAX_METADATA_CACHE_SCOPE_BYTES).toBe(32 * MIB);
    expect(MAX_METADATA_CACHE_TOTAL_BYTES).toBe(128 * MIB);
    expect(MAX_METADATA_CACHE_ENTRIES_PER_SCOPE).toBe(512);
  });

  it("charges an entry about its body size", async () => {
    const { read } = upstream();
    const scope = nextScope();
    await read(scope, "a", 100_000);
    const bytes = metadataCacheBytes(scope);
    expect(bytes).toBeGreaterThan(100_000);
    expect(bytes).toBeLessThan(102_000);
  });

  it("returns an over-cap response but never stores it", async () => {
    const { read, fullReads } = upstream();
    const scope = nextScope();
    const first = await read(scope, "big", MAX_METADATA_CACHE_ENTRY_BYTES + 1);
    expect((first.data as { result: Array<{ pad: string }> }).result[0].pad.length).toBe(
      MAX_METADATA_CACHE_ENTRY_BYTES + 1
    );
    expect(metadataCacheBytes(scope)).toBe(0);

    await read(scope, "big", MAX_METADATA_CACHE_ENTRY_BYTES + 1);
    expect(fullReads).toEqual(["big", "big"]);
  });

  it("drops an older entry under the key when its refetch is over the cap", async () => {
    const { read, table, fullReads } = upstream();
    const scope = nextScope();
    await read(scope, "k", 1_000);
    expect(metadataCacheBytes(scope)).toBeGreaterThan(0);

    // Same selector, but the table moved and the rows grew past the cap.
    table.count += 1;
    table.sizeOverride = MAX_METADATA_CACHE_ENTRY_BYTES + 10;
    await read(scope, "k", 1_000);

    expect(metadataCacheBytes(scope)).toBe(0);
    expect(fullReads).toEqual(["k", "k"]);
  });

  it("keeps a scope within its byte budget and evicts the least recently used entry first", async () => {
    const { read, fullReads } = upstream();
    const scope = nextScope();
    const perEntry = (await read(scope, "e0", BIG), metadataCacheBytes(scope));
    const fits = Math.floor(MAX_METADATA_CACHE_SCOPE_BYTES / perEntry);
    for (let i = 1; i < fits + 5; i += 1) {
      await read(scope, `e${i}`, BIG);
      expect(metadataCacheBytes(scope)).toBeLessThanOrEqual(MAX_METADATA_CACHE_SCOPE_BYTES);
    }
    expect(fullReads).toHaveLength(fits + 5);

    // The oldest went first; the newest is still served.
    fullReads.length = 0;
    await read(scope, `e${fits + 4}`, BIG);
    expect(fullReads).toEqual([]);
    await read(scope, "e0", BIG);
    expect(fullReads).toEqual(["e0"]);
  });

  it("refreshes recency on a hit so a recently read entry outlives older ones", async () => {
    const { read, fullReads } = upstream();
    const scope = nextScope();
    const perEntry = (await read(scope, "e0", BIG), metadataCacheBytes(scope));
    const fits = Math.floor(MAX_METADATA_CACHE_SCOPE_BYTES / perEntry);
    for (let i = 1; i < fits; i += 1) await read(scope, `e${i}`, BIG);
    expect(fullReads).toHaveLength(fits);

    await read(scope, "e0", BIG); // hit: e0 becomes the newest
    expect(fullReads).toHaveLength(fits);
    await read(scope, "extra-1", BIG); // evicts e1, not e0
    fullReads.length = 0;

    await read(scope, "e0", BIG);
    expect(fullReads).toEqual([]);
    await read(scope, "e1", BIG);
    expect(fullReads).toEqual(["e1"]);
  });

  it("holds the whole cache to its budget across scopes, evicting the least recently used scope first", async () => {
    const { read } = upstream();
    const scopes = Array.from({ length: 5 }, nextScope);
    const perEntry = (await read(scopes[0], "probe", BIG), metadataCacheBytes(scopes[0]));
    const fits = Math.floor(MAX_METADATA_CACHE_SCOPE_BYTES / perEntry);
    for (const scope of scopes) {
      for (let i = 0; i < fits; i += 1) await read(scope, `e${i}`, BIG);
      expect(metadataCacheBytes()).toBeLessThanOrEqual(MAX_METADATA_CACHE_TOTAL_BYTES);
    }
    // Five scopes at about 32 MiB each cannot all fit in 128 MiB. The first
    // scope was the least recently used, so it gave up bytes first and the
    // newest scope kept its full set.
    expect(metadataCacheBytes(scopes[0])).toBeLessThan(metadataCacheBytes(scopes[4]));
    expect(metadataCacheBytes(scopes[4])).toBeGreaterThan(MAX_METADATA_CACHE_SCOPE_BYTES - 2 * perEntry);
  }, 60_000);

  it("keeps the byte totals exact when an entry is replaced or force-recached", async () => {
    const { read, table } = upstream();
    const scope = nextScope();
    const before = metadataCacheBytes();
    await read(scope, "ka", 50_000);
    const one = metadataCacheBytes(scope);
    expect(metadataCacheBytes() - before).toBe(one);

    // A moved watermark refetches and replaces the entry under the same key.
    table.count += 1;
    await read(scope, "ka", 50_000);
    expect(metadataCacheBytes(scope)).toBe(one);
    expect(metadataCacheBytes() - before).toBe(one);

    // A forced refresh deletes then re-stores it.
    await read(scope, "ka", 50_000, { [FORCE_RECACHE_PARAM]: "true" });
    expect(metadataCacheBytes(scope)).toBe(one);
    expect(metadataCacheBytes() - before).toBe(one);

    // A second key adds exactly its own bytes.
    await read(scope, "kb", 50_000);
    expect(metadataCacheBytes(scope)).toBe(2 * one);
  });

  it("sweeps expired entries when a new one is stored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    const { read } = upstream();
    const scope = nextScope();
    await read(scope, "k1", 40_000, {}, 1_000);
    await read(scope, "k2", 40_000, {}, 1_000);
    const two = metadataCacheBytes(scope);

    vi.setSystemTime(new Date("2026-11-14T12:00:05Z")); // past both TTLs
    await read(scope, "k3", 40_000, {}, 1_000);

    // Only the new entry remains charged, though nothing came near a limit.
    expect(metadataCacheBytes(scope)).toBeLessThan(two);
    expect(metadataCacheBytes(scope)).toBe(two / 2);
  });
});
