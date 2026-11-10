import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ServiceNowConfig } from "../src/config.js";
import {
  ServiceNowClient,
  isServiceNowRequestCancellation,
  runWithServiceNowRequestSignal,
  type RequestResult,
  type ServiceNowOperations,
} from "../src/client.js";
import { credentialFingerprint } from "../src/profile-manager.js";
import {
  DEFAULT_METADATA_CACHE_TABLES,
  FORCE_RECACHE_PARAM,
  MAX_METADATA_CACHE_ENTRIES_PER_SCOPE,
  STRUCTURAL_UNCACHEABLE_MS,
  TRANSIENT_UNCACHEABLE_MS,
  createCachedServiceNowOperations,
  createMetadataCacheConfig,
  type MetadataCacheConfigInput,
} from "../src/metadata-cache.js";
import { createToolError } from "../src/tool-error.js";

function result(payload: unknown): RequestResult<unknown> {
  return { data: payload, status: 200, headers: new Headers({ "x-total-count": "1" }) };
}

interface TableRow {
  readonly sys_id?: unknown;
  readonly sys_updated_on?: unknown;
}

const WATERMARK_PARAMS = Object.freeze({
  sysparm_query: "ORDERBYDESCsys_updated_on",
  sysparm_fields: "sys_id,sys_updated_on",
  sysparm_limit: "1",
  sysparm_display_value: "false",
  sysparm_exclude_reference_link: "true",
});

function isWatermarkRead(params: Record<string, string> | undefined): boolean {
  return params?.sysparm_query === WATERMARK_PARAMS.sysparm_query &&
    params.sysparm_fields === WATERMARK_PARAMS.sysparm_fields;
}

/**
 * Upstream double. `table` is what the instance reports for the watermark
 * read: `newest` is the ORDERBYDESCsys_updated_on row as stored, `count` the
 * X-Total-Count header, `serverDate` the Date header. Tests mutate it to
 * simulate writes. `getWithMeta` records full reads only; watermark reads go
 * to `watermark`.
 */
function operations() {
  const table: {
    newest: TableRow | undefined;
    count: string | undefined;
    serverDate: string | undefined;
    /** Thrown by the watermark read when set. */
    watermarkError: unknown;
  } = {
    newest: { sys_id: "row-1", sys_updated_on: "2025-01-15 12:00:00" },
    count: "42",
    serverDate: "Wed, 15 Jan 2025 13:00:00 GMT",
    watermarkError: undefined,
  };
  const watermark = vi.fn(async (_path: string, _params?: Record<string, string>) => {
    if (table.watermarkError !== undefined) throw table.watermarkError;
    const headers = new Headers();
    if (table.count !== undefined) headers.set("x-total-count", table.count);
    if (table.serverDate !== undefined) headers.set("date", table.serverDate);
    return {
      data: { result: table.newest === undefined ? [] : [{ ...table.newest }] },
      status: 200,
      headers,
    } as RequestResult<unknown>;
  });
  const getWithMeta = vi.fn(async (path: string, params?: Record<string, string>) => {
    return result({ result: [{ sys_id: `${path}:${params?.sysparm_fields ?? "all"}` }] });
  });
  const base = {
    get: vi.fn(),
    getWithMeta: (path: string, params?: Record<string, string>) =>
      isWatermarkRead(params) ? watermark(path, params) : getWithMeta(path, params),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postBinary: vi.fn(),
    getRaw: vi.fn(),
  } as unknown as ServiceNowOperations;
  return { base, watermark, getWithMeta, table };
}

/**
 * Each read is its own tool call: the dispatcher builds one wrapper per call,
 * and the wrapper memoizes watermarks for the call's lifetime.
 */
function perCall(
  base: ServiceNowOperations,
  scope: string,
  config: MetadataCacheConfigInput | undefined
): Pick<ServiceNowOperations, "getWithMeta"> {
  return {
    getWithMeta: (path, params) =>
      createCachedServiceNowOperations(base, scope, config).getWithMeta(path, params),
  };
}

/** A network-level failure: no trusted descriptor, so transient. */
const NETWORK_ERROR = new Error("socket hang up");

describe("metadata cache", () => {
  it("serves metadata table reads from a per-instance cache while the watermark matches", async () => {
    const { base, watermark, getWithMeta } = operations();
    const cached = perCall(base, "https://a.service-now.com", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(1);
    // One watermark read before the fetch, one to validate the hit. No
    // sysparm_no_count: with it set, X-Total-Count holds the page size.
    expect(watermark).toHaveBeenCalledTimes(2);
    for (const [path, params] of watermark.mock.calls) {
      expect(path).toBe("/api/now/table/sys_dictionary");
      expect(params).toEqual(WATERMARK_PARAMS);
    }
  });

  it("refreshes once the watermark moves", async () => {
    const { base, getWithMeta, table } = operations();
    const cached = perCall(base, "https://moved.service-now.com|fp", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    table.newest = { sys_id: "row-2", sys_updated_on: "2025-01-15 12:00:07" };
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    // Refetched once for the move, then served against the new watermark.
    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("refreshes when only the count changes", async () => {
    // A delete of any row but the newest leaves the newest row in place.
    const { base, getWithMeta, table } = operations();
    const cached = perCall(base, "https://deleted.service-now.com|fp", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    table.count = "41";
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("refreshes when only the newest row's sys_id changes", async () => {
    // The newest row was deleted, or another row took the top within the same
    // second. The timestamp alone would call this unchanged.
    const { base, getWithMeta, table } = operations();
    const cached = perCall(base, "https://sysid.service-now.com|fp", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    table.newest = { sys_id: "row-0", sys_updated_on: "2025-01-15 12:00:00" };
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("refreshes metadata cache when forced and strips the internal force flag upstream", async () => {
    const { base, getWithMeta } = operations();
    const cached = perCall(base, "https://b.service-now.com", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_metadata_action", {
      sysparm_fields: "sys_id",
      [FORCE_RECACHE_PARAM]: "true",
    });

    expect(getWithMeta).toHaveBeenCalledWith("/api/now/table/sys_metadata_action", {
      sysparm_fields: "sys_id",
    });
  });

  it("does not cache non-metadata table reads", async () => {
    const { base, watermark, getWithMeta } = operations();
    const cached = perCall(base, "https://c.service-now.com", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/incident", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/incident", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
    expect(watermark).not.toHaveBeenCalled();
  });

  it("never shares cached rows between two identities on one instance", async () => {
    // ServiceNow evaluates ACLs per user and a cache hit skips the upstream
    // read entirely, so an instance-only scope would serve one identity's
    // authorized rows to another.
    const instance = "https://shared.service-now.com";
    const admin = operations();
    const readonlyUser = operations();
    const adminCache = perCall(
      admin.base,
      `${instance}|fingerprint-admin`,
      { ttlMs: 60_000 }
    );
    const readonlyCache = perCall(
      readonlyUser.base,
      `${instance}|fingerprint-readonly`,
      { ttlMs: 60_000 }
    );
    const selector = { sysparm_query: "nameLIKEglide" };

    await adminCache.getWithMeta("/api/now/table/sys_properties", selector);
    await readonlyCache.getWithMeta("/api/now/table/sys_properties", selector);

    // The second identity must have gone upstream under its own credentials.
    expect(readonlyUser.getWithMeta).toHaveBeenCalledTimes(1);
    expect(admin.getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("reuses one identity's cache across repeated tool invocations", async () => {
    const { base, getWithMeta } = operations();
    const scope = "https://reuse.service-now.com|fingerprint-a";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cached = perCall(base, scope, { ttlMs: 60_000 });
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    }

    expect(getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("expires entries and refuses to serve them past the TTL", async () => {
    const { base, watermark, getWithMeta } = operations();
    const cached = perCall(
      base,
      "https://ttl.service-now.com|fp",
      { ttlMs: 1_000 }
    );

    vi.useFakeTimers();
    try {
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      vi.setSystemTime(Date.now() + 2_000);
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    } finally {
      vi.useRealTimers();
    }

    expect(getWithMeta).toHaveBeenCalledTimes(2);
    // Each fetch is preceded by its own watermark read; the expired entry is
    // never served even though its watermark still matches.
    expect(watermark).toHaveBeenCalledTimes(2);
  });

  it("does not cache a 204 no-content response", async () => {
    const { base, getWithMeta } = operations();
    getWithMeta.mockResolvedValue({ data: null, status: 204, headers: new Headers() });
    const cached = perCall(
      base,
      "https://empty.service-now.com|fp",
      { ttlMs: 60_000 }
    );

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("bounds a single scope to the entry cap", async () => {
    const { base, getWithMeta } = operations();
    const scope = "https://bounded.service-now.com|fp";
    const cached = perCall(base, scope, { ttlMs: 60_000 });
    const overflow = MAX_METADATA_CACHE_ENTRIES_PER_SCOPE + 1;

    for (let index = 0; index < overflow; index += 1) {
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_query: `n=${index}` });
    }
    // The first selector was evicted, so replaying it goes upstream again.
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_query: "n=0" });

    expect(getWithMeta).toHaveBeenCalledTimes(overflow + 1);
  });

  it("applies the production default TTL and table set when config is empty", async () => {
    const { base, getWithMeta } = operations();
    const cached = perCall(base, "https://default.service-now.com|fp", {});

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "element" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "element" });

    expect(getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("keeps sys_properties out of the default cache set", async () => {
    // ACL-restricted per user and routinely holds integration secrets in
    // `value`. The only reads of it are three single-value build-info lookups,
    // so there is no payload saving to justify retaining it for a day.
    expect(DEFAULT_METADATA_CACHE_TABLES).not.toContain("sys_properties");
    expect(createMetadataCacheConfig(undefined).tables).not.toContain("sys_properties");

    const { base, watermark, getWithMeta } = operations();
    const cached = perCall(base, "https://props.service-now.com|fp", {});

    await cached.getWithMeta("/api/now/table/sys_properties", {
      sysparm_query: "name=glide.war",
      sysparm_fields: "value",
    });
    await cached.getWithMeta("/api/now/table/sys_properties", {
      sysparm_query: "name=glide.war",
      sysparm_fields: "value",
    });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
    expect(watermark).not.toHaveBeenCalled();
  });

  it("still caches sys_properties when an operator opts in explicitly", async () => {
    const { base, getWithMeta } = operations();
    const cached = perCall(
      base,
      "https://optin.service-now.com|fp",
      { ttlMs: 60_000, tables: ["sys_properties"] }
    );

    await cached.getWithMeta("/api/now/table/sys_properties", { sysparm_fields: "value" });
    await cached.getWithMeta("/api/now/table/sys_properties", { sysparm_fields: "value" });

    expect(getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("derives a distinct cache scope for each credential identity on one instance", async () => {
    // The wiring defect this guards was in the caller: the scope was the
    // instance URL alone, so two profiles against one instance collided.
    const instance = "https://acme.service-now.com";
    const base: ServiceNowConfig = {
      instance,
      user: "integration",
      password: "admin-secret",
    } as ServiceNowConfig;
    const other: ServiceNowConfig = { ...base, password: "readonly-secret" };

    const adminScope = `${instance}|${credentialFingerprint(base)}`;
    const readonlyScope = `${instance}|${credentialFingerprint(other)}`;
    expect(adminScope).not.toBe(readonlyScope);
    // Identical credential material must keep reusing one partition.
    expect(`${instance}|${credentialFingerprint({ ...base })}`).toBe(adminScope);

    const admin = operations();
    const readonlyUser = operations();
    const selector = { sysparm_query: "nameLIKEglide" };
    await perCall(admin.base, adminScope, { ttlMs: 60_000 })
      .getWithMeta("/api/now/table/sys_properties", selector);
    await perCall(readonlyUser.base, readonlyScope, { ttlMs: 60_000 })
      .getWithMeta("/api/now/table/sys_properties", selector);

    expect(readonlyUser.getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("wires the dispatcher cache scope from instance and credential identity", () => {
    // The cache is disabled under NODE_ENV=test when no config is supplied,
    // so the dispatcher composition is guarded at the source. A scope built
    // from the instance alone is the HIGH-4 cross-identity leak.
    const dispatcher = readFileSync(
      new URL("../src/tools/index.ts", import.meta.url),
      "utf8"
    );
    const call = /createCachedServiceNowOperations\(([\s\S]*?)\n {10}\),/u.exec(dispatcher);

    expect(call, "createCachedServiceNowOperations call not found").not.toBeNull();
    expect(call![1]).toContain("credentialFingerprint(config)");
    expect(call![1]).toContain("context.profile.instance");
    // Caching must not depend on a configured user name, which
    // client-credentials and API-key profiles do not have.
    expect(call![1]).not.toContain("config.user");
  });

  it("strips the internal force flag on non-metadata passthrough reads too", () => {
    // sysparm_force_recache is this module's own parameter. It must never
    // reach ServiceNow, cached table or not.
    const { base, getWithMeta } = operations();
    const cached = perCall(
      base,
      "https://strip.service-now.com|fp",
      { ttlMs: 60_000 }
    );

    return cached
      .getWithMeta("/api/now/table/incident", {
        sysparm_fields: "sys_id",
        [FORCE_RECACHE_PARAM]: "true",
      })
      .then(() => {
        expect(getWithMeta).toHaveBeenCalledWith("/api/now/table/incident", {
          sysparm_fields: "sys_id",
        });
      });
  });

  it("caches with no user name or lookup, in every auth mode", async () => {
    // Client-credentials and API-key profiles carry no user name. The
    // watermark needs none: the only upstream reads are the cached table's own.
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { base, watermark, getWithMeta } = operations();
      const cached = createCachedServiceNowOperations(
        base,
        "https://clientcreds.service-now.com|fp",
        {}
      );

      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

      expect(getWithMeta).toHaveBeenCalledTimes(1);
      expect(new Set(watermark.mock.calls.map(([path]) => path))).toEqual(
        new Set(["/api/now/table/sys_dictionary"])
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("never builds a date literal, so the host clock and zone play no part", async () => {
    // A host clock years ahead of the instance would have hidden this update
    // from a sys_updated_on>{local time} probe until the entry expired.
    const { base, watermark, getWithMeta, table } = operations();
    const cached = perCall(
      base,
      "https://skew.service-now.com|fp",
      { ttlMs: 60_000 }
    );

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2030-06-15T00:00:00Z"));
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      table.newest = { sys_id: "row-1", sys_updated_on: "2025-01-15 12:00:05" };
      vi.setSystemTime(Date.parse("2030-06-15T00:00:30Z"));
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    } finally {
      vi.useRealTimers();
    }

    expect(getWithMeta).toHaveBeenCalledTimes(2);
    for (const [, params] of watermark.mock.calls) {
      expect(params?.sysparm_query).toBe("ORDERBYDESCsys_updated_on");
    }
  });

  it("reads the watermark before the rows, so an update between them is not lost", async () => {
    const { base, getWithMeta, table } = operations();
    getWithMeta.mockImplementationOnce(async () => {
      // A write lands after the watermark read and before the rows are read.
      table.newest = { sys_id: "row-1", sys_updated_on: "2025-01-15 12:00:09" };
      return result({ result: [{ sys_id: "first" }] });
    });
    const cached = perCall(
      base,
      "https://order.service-now.com|fp",
      { ttlMs: 60_000 }
    );

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    // Read after the rows, the stored watermark would already include the
    // write and the second call would be a hit. The cost here is one refresh.
    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the watermark read fails", { watermarkError: NETWORK_ERROR }],
    ["the count is positive but no row comes back", { newest: undefined }],
    ["sys_updated_on is not readable", { newest: { sys_id: "row-1", sys_updated_on: "" } }],
    ["sys_updated_on is a display value", { newest: { sys_id: "row-1", sys_updated_on: "15/01/2025 07:00:00" } }],
    ["the row has no sys_id", { newest: { sys_updated_on: "2025-01-15 12:00:00" } }],
    ["there is no X-Total-Count", { count: undefined }],
    ["X-Total-Count is not a count", { count: "-1" }],
    ["there is no Date header", { serverDate: undefined }],
    // Seen live: a sys_metadata row dated a year ahead stays the newest row
    // however many others are updated, so only the count could move.
    ["the newest row is dated after the instance clock", { newest: { sys_id: "row-1", sys_updated_on: "2027-09-04 12:21:59" } }],
  ])("serves fresh rows and keeps nothing when %s", async (_label, state) => {
    const { base, getWithMeta, table } = operations();
    Object.assign(table, state);
    const cached = perCall(
      base,
      `https://unusable-${_label}.service-now.com|fp`,
      { ttlMs: 60_000 }
    );

    const first = await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    // A watermark that cannot change would compare equal forever.
    expect(first.data).toEqual({ result: [{ sys_id: "/api/now/table/sys_dictionary:sys_id" }] });
    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache while a failed watermark read is remembered, then serves the kept entry", async () => {
    const { base, watermark, getWithMeta, table } = operations();
    const cached = perCall(base, "https://hitfail.service-now.com|fp", { ttlMs: 60_000 });
    const read = () => cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    vi.useFakeTimers();
    try {
      await read();
      table.watermarkError = NETWORK_ERROR;
      await read();
      expect(getWithMeta).toHaveBeenCalledTimes(2);

      // Within the transient period the table passes straight through.
      table.watermarkError = undefined;
      const watermarkReads = watermark.mock.calls.length;
      await read();
      expect(getWithMeta).toHaveBeenCalledTimes(3);
      expect(watermark).toHaveBeenCalledTimes(watermarkReads);

      // Afterwards the entry kept from the first call serves again: nothing
      // changed since its watermark.
      vi.setSystemTime(Date.now() + TRANSIENT_UNCACHEABLE_MS + 1);
      await read();
      expect(getWithMeta).toHaveBeenCalledTimes(3);
      expect(watermark).toHaveBeenCalledTimes(watermarkReads + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the old entry on a forced refresh even when the new one cannot be kept", async () => {
    // force_recache is how a caller surfaces a write the watermark missed.
    // The watermark would still match the old entry, so leaving it in place
    // would serve the missed write's old rows again on the next call.
    const { base, getWithMeta, table } = operations();
    const cached = perCall(base, "https://forced.service-now.com|fp", { ttlMs: 60_000 });
    const selector = { sysparm_fields: "sys_id" };

    vi.useFakeTimers();
    try {
      await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
      table.watermarkError = NETWORK_ERROR;
      await cached.getWithMeta("/api/now/table/sys_dictionary", { ...selector, [FORCE_RECACHE_PARAM]: "true" });
      table.watermarkError = undefined;
      vi.setSystemTime(Date.now() + TRANSIENT_UNCACHEABLE_MS + 1);
      await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
    } finally {
      vi.useRealTimers();
    }

    expect(getWithMeta).toHaveBeenCalledTimes(3);
  });

  it("re-caches after a forced refresh", async () => {
    const { base, getWithMeta } = operations();
    const cached = perCall(
      base,
      "https://recache.service-now.com|fp",
      { ttlMs: 60_000 }
    );
    const selector = { sysparm_fields: "sys_id" };

    await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
    await cached.getWithMeta("/api/now/table/sys_dictionary", { ...selector, [FORCE_RECACHE_PARAM]: "true" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", selector);

    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("does not extend expiresAt when the watermark matches", async () => {
    // Most deletions are only surfaced by expiry, so a repeatedly validated
    // entry must still expire on schedule. If a matching watermark slid
    // expiresAt forward, a hot entry would be retained indefinitely and a
    // delete would never surface.
    const { base, getWithMeta } = operations();
    const cached = perCall(
      base,
      "https://expiry.service-now.com|fp",
      { ttlMs: 10_000 }
    );
    const selector = { sysparm_fields: "sys_id" };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2025-01-01T00:00:00Z"));
      await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
      // Validate repeatedly, well inside the TTL, each time served from cache.
      for (const offset of [2_000, 4_000, 6_000, 8_000]) {
        vi.setSystemTime(Date.parse("2025-01-01T00:00:00Z") + offset);
        await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
      }
      expect(getWithMeta).toHaveBeenCalledTimes(1);

      // Past the original expiry, the entry is gone despite the matches.
      vi.setSystemTime(Date.parse("2025-01-01T00:00:00Z") + 10_001);
      await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
      expect(getWithMeta).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("metadata cache: watermark containment", () => {
  it("keeps the watermark request fixed whatever the caller's selector holds", async () => {
    const { base, watermark, getWithMeta } = operations();
    const hostile = {
      sysparm_query: "name=incident^NQjavascript:gs.getUserID()^ORDERBYsys_created_on",
      sysparm_fields: "element,sys_id",
      sysparm_limit: "500",
      sysparm_offset: "100",
      sysparm_no_count: "true",
    };
    const cached = perCall(base, "https://hostile.service-now.com|fp", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", hostile);
    await cached.getWithMeta("/api/now/table/sys_dictionary", hostile);

    expect(watermark).toHaveBeenCalledTimes(2);
    for (const [path, params] of watermark.mock.calls) {
      expect(path).toBe("/api/now/table/sys_dictionary");
      expect(params).toEqual(WATERMARK_PARAMS);
    }
    // The caller's own selector still reaches its own read unchanged.
    expect(getWithMeta).toHaveBeenCalledWith("/api/now/table/sys_dictionary", hostile);
  });

  it("never returns the watermark's values, on a miss or a hit", async () => {
    const { base, table } = operations();
    table.count = "424242";
    table.newest = { sys_id: "deadbeefdeadbeefdeadbeefdeadbeef", sys_updated_on: "2025-01-02 03:04:05" };
    const cached = perCall(base, "https://contained.service-now.com|fp", { ttlMs: 60_000 });

    for (let call = 0; call < 2; call += 1) {
      const response = await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "element" });
      const exposed = JSON.stringify({ data: response.data, headers: [...response.headers.entries()] });
      expect(exposed).not.toContain("424242");
      expect(exposed).not.toContain("deadbeefdeadbeefdeadbeefdeadbeef");
      expect(exposed).not.toContain("2025-01-02 03:04:05");
    }
  });

  it("swallows a failed watermark read without surfacing its text", async () => {
    const { base, getWithMeta, table } = operations();
    table.watermarkError = new Error("SECRET-UPSTREAM-DETAIL token=abc");
    const cached = perCall(base, "https://swallowed.service-now.com|fp", { ttlMs: 60_000 });

    const response = await cached.getWithMeta("/api/now/table/sys_db_object", { sysparm_fields: "name" });

    expect(JSON.stringify({ data: response.data, headers: [...response.headers.entries()] })).not.toContain("SECRET");
    expect(getWithMeta).toHaveBeenCalledTimes(1);
  });
});

describe("metadata cache: one watermark per table per tool call", () => {
  it("reads each table's watermark once across a multi-hop walk", async () => {
    // resolveTableHierarchy reads sys_db_object once per hop in one call.
    const { base, watermark, getWithMeta } = operations();
    const call = createCachedServiceNowOperations(base, "https://walk.service-now.com|fp", { ttlMs: 60_000 });

    for (const name of ["cmdb_ci_linux_server", "cmdb_ci_server", "cmdb_ci_computer", "cmdb_ci"]) {
      await call.getWithMeta("/api/now/table/sys_db_object", { sysparm_query: `name=${name}` });
    }
    await call.getWithMeta("/api/now/table/sys_dictionary", { sysparm_query: "nameINcmdb_ci" });

    expect(getWithMeta).toHaveBeenCalledTimes(5);
    expect(watermark.mock.calls.map(([path]) => path)).toEqual([
      "/api/now/table/sys_db_object",
      "/api/now/table/sys_dictionary",
    ]);
  });

  it("shares one in-flight watermark read between concurrent reads", async () => {
    const { base, watermark } = operations();
    const call = createCachedServiceNowOperations(base, "https://concurrent.service-now.com|fp", { ttlMs: 60_000 });

    await Promise.all(
      ["a", "b", "c"].map((name) =>
        call.getWithMeta("/api/now/table/sys_db_object", { sysparm_query: `name=${name}` })
      )
    );

    expect(watermark).toHaveBeenCalledTimes(1);
  });

  it.each(["post", "patch", "delete", "postBinary"] as const)(
    "re-reads the watermark after the call writes with %s",
    async (method) => {
      const { base, watermark, getWithMeta, table } = operations();
      const write = vi.fn(async () => {
        // The write lands on a cached table.
        table.newest = { sys_id: "row-2", sys_updated_on: "2025-01-15 12:00:05" };
        return null;
      });
      (base as unknown as Record<string, unknown>)[method] = write;
      const call = createCachedServiceNowOperations(base, `https://write-${method}.service-now.com|fp`, { ttlMs: 60_000 });
      const selector = { sysparm_query: "name=incident" };

      await call.getWithMeta("/api/now/table/sys_db_object", selector);
      await (call[method] as (...args: unknown[]) => Promise<unknown>)("/api/now/table/sys_db_object", {});
      await call.getWithMeta("/api/now/table/sys_db_object", selector);

      expect(write).toHaveBeenCalledTimes(1);
      expect(watermark).toHaveBeenCalledTimes(2);
      // The moved watermark refreshed the entry within the same call.
      expect(getWithMeta).toHaveBeenCalledTimes(2);
    }
  );

  it("clears the memo even when the write fails", async () => {
    const { base, watermark } = operations();
    (base as unknown as Record<string, unknown>).patch = vi.fn(async () => {
      throw new Error("rejected");
    });
    const call = createCachedServiceNowOperations(base, "https://write-fails.service-now.com|fp", { ttlMs: 60_000 });

    await call.getWithMeta("/api/now/table/sys_db_object", { sysparm_query: "name=a" });
    await expect(call.patch("/api/now/table/sys_db_object/x", {})).rejects.toThrow("rejected");
    await call.getWithMeta("/api/now/table/sys_db_object", { sysparm_query: "name=b" });

    expect(watermark).toHaveBeenCalledTimes(2);
  });

  it("re-reads in a new tool call", async () => {
    const { base, watermark, getWithMeta } = operations();
    const scope = "https://newcall.service-now.com|fp";

    for (let call = 0; call < 3; call += 1) {
      await createCachedServiceNowOperations(base, scope, { ttlMs: 60_000 })
        .getWithMeta("/api/now/table/sys_db_object", { sysparm_query: "name=incident" });
    }

    expect(watermark).toHaveBeenCalledTimes(3);
    expect(getWithMeta).toHaveBeenCalledTimes(1);
  });
});

describe("metadata cache: tables with an unusable watermark", () => {
  const TTL = 24 * 60 * 60 * 1000;
  let scopeSeq = 0;

  /** Two calls inside the period, one after it. Returns watermark reads per call. */
  async function remembered(state: Record<string, unknown>, periodMs: number, ttlMs = TTL) {
    const { base, watermark, getWithMeta, table } = operations();
    Object.assign(table, state);
    scopeSeq += 1;
    const cached = perCall(base, `https://uncacheable-${scopeSeq}.service-now.com|fp`, { ttlMs });
    const read = () => cached.getWithMeta("/api/now/table/sys_metadata", { sysparm_query: "sys_class_name=sys_script" });
    const reads: number[] = [];
    let before = 0;
    const step = async () => {
      await read();
      reads.push(watermark.mock.calls.length - before);
      before = watermark.mock.calls.length;
    };

    vi.useFakeTimers();
    try {
      const start = Date.now();
      await step();
      vi.setSystemTime(start + periodMs - 1);
      await step();
      vi.setSystemTime(start + periodMs + 1);
      await step();
    } finally {
      vi.useRealTimers();
    }
    return { reads, fullReads: getWithMeta.mock.calls.length };
  }

  it.each([
    ["the count is positive but no row comes back", { newest: undefined }],
    ["sys_updated_on is missing", { newest: { sys_id: "row-1" } }],
    ["sys_updated_on is a display value", { newest: { sys_id: "row-1", sys_updated_on: "15/01/2025 07:00:00" } }],
    ["the row has no sys_id", { newest: { sys_updated_on: "2025-01-15 12:00:00" } }],
    ["there is no X-Total-Count", { count: undefined }],
    ["there is no Date header", { serverDate: undefined }],
    ["the newest row is dated after the instance clock", { newest: { sys_id: "row-1", sys_updated_on: "2027-09-04 12:21:59" } }],
    ["the read is refused (403)", { watermarkError: createToolError("authorization", "retry_after_correction") }],
    ["the table is not found (404)", { watermarkError: createToolError("not_found", "do_not_retry") }],
    ["the request shape is rejected (400)", { watermarkError: createToolError("upstream", "do_not_retry") }],
  ])("remembers a structural cause for the long period: %s", async (_label, state) => {
    const { reads, fullReads } = await remembered(state, STRUCTURAL_UNCACHEABLE_MS);

    // Read once, then straight through until the period ends, then asked again.
    expect(reads).toEqual([1, 0, 1]);
    expect(fullReads).toBe(3);
  });

  it.each([
    ["a network error", { watermarkError: NETWORK_ERROR }],
    ["429", { watermarkError: createToolError("rate_limit", "retry_later", 5) }],
    ["5xx", { watermarkError: createToolError("upstream", "retry_if_safe_and_idempotent") }],
    ["a timeout", { watermarkError: createToolError("timeout", "retry_if_safe_and_idempotent") }],
    ["401, which a token refresh can fix", { watermarkError: createToolError("authentication", "retry_after_correction") }],
  ])("remembers a transient cause for the short period: %s", async (_label, state) => {
    const { reads, fullReads } = await remembered(state, TRANSIENT_UNCACHEABLE_MS);

    expect(reads).toEqual([1, 0, 1]);
    expect(fullReads).toBe(3);
  });

  it("never remembers a table for longer than the cache TTL", async () => {
    const { reads } = await remembered({ newest: undefined }, 10_000, 10_000);

    expect(reads).toEqual([1, 0, 1]);
  });

  it("does not remember a cancelled read", async () => {
    const cancelled = await cancellationError();
    expect(isServiceNowRequestCancellation(cancelled)).toBe(true);
    const { base, watermark, table } = operations();
    table.watermarkError = cancelled;
    const cached = perCall(base, "https://cancelled.service-now.com|fp", { ttlMs: TTL });

    await cached.getWithMeta("/api/now/table/sys_metadata", {});
    await cached.getWithMeta("/api/now/table/sys_metadata", {});

    expect(watermark).toHaveBeenCalledTimes(2);
  });

  it("keeps each credential scope's memo to itself", async () => {
    const refused = operations();
    refused.table.watermarkError = createToolError("authorization", "retry_after_correction");
    const allowed = operations();
    const instance = "https://scoped-memo.service-now.com";
    const selector = { sysparm_query: "name=incident" };

    await perCall(refused.base, `${instance}|fingerprint-a`, { ttlMs: TTL }).getWithMeta("/api/now/table/sys_db_object", selector);
    for (let call = 0; call < 2; call += 1) {
      await perCall(allowed.base, `${instance}|fingerprint-b`, { ttlMs: TTL }).getWithMeta("/api/now/table/sys_db_object", selector);
    }

    expect(allowed.watermark).toHaveBeenCalledTimes(2);
    expect(allowed.getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("keeps the memo to the one table", async () => {
    const { base, watermark } = operations();
    const scope = "https://per-table.service-now.com|fp";
    const original = watermark.getMockImplementation()!;
    watermark.mockImplementation(async (path, params) => {
      if (path === "/api/now/table/sys_metadata") throw createToolError("authorization", "retry_after_correction");
      return original(path, params);
    });

    await perCall(base, scope, { ttlMs: TTL }).getWithMeta("/api/now/table/sys_metadata", {});
    await perCall(base, scope, { ttlMs: TTL }).getWithMeta("/api/now/table/sys_db_object", {});
    await perCall(base, scope, { ttlMs: TTL }).getWithMeta("/api/now/table/sys_db_object", {});

    expect(watermark.mock.calls.map(([path]) => path)).toEqual([
      "/api/now/table/sys_metadata",
      "/api/now/table/sys_db_object",
      "/api/now/table/sys_db_object",
    ]);
  });

  it("asks again on force_recache and caches if the watermark is usable now", async () => {
    const { base, watermark, getWithMeta, table } = operations();
    table.newest = { sys_id: "row-1", sys_updated_on: "2027-09-04 12:21:59" };
    const cached = perCall(base, "https://force-memo.service-now.com|fp", { ttlMs: TTL });
    const selector = { sysparm_query: "name=incident" };

    await cached.getWithMeta("/api/now/table/sys_metadata", selector);
    table.newest = { sys_id: "row-1", sys_updated_on: "2025-01-15 12:00:00" };
    await cached.getWithMeta("/api/now/table/sys_metadata", { ...selector, [FORCE_RECACHE_PARAM]: "true" });
    await cached.getWithMeta("/api/now/table/sys_metadata", selector);

    expect(watermark).toHaveBeenCalledTimes(3);
    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("caches an empty table, and an insert refreshes it", async () => {
    // X-Total-Count counts rows before row ACLs, so 0 means no rows at all.
    const { base, getWithMeta, table } = operations();
    table.count = "0";
    table.newest = undefined;
    const cached = perCall(base, "https://empty-table.service-now.com|fp", { ttlMs: TTL });
    const read = () => cached.getWithMeta("/api/now/table/sys_flow_report_doc", {});

    await read();
    await read();
    expect(getWithMeta).toHaveBeenCalledTimes(1);

    table.count = "1";
    table.newest = { sys_id: "row-1", sys_updated_on: "2025-01-15 12:00:00" };
    await read();
    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });
});

async function cancellationError(): Promise<unknown> {
  const client = new ServiceNowClient(
    { instance: "https://cancel.service-now.com", user: "u", password: "p" } as ServiceNowConfig,
    { maxRetries: 0 }
  );
  const controller = new AbortController();
  controller.abort();
  try {
    await runWithServiceNowRequestSignal(controller.signal, () =>
      client.getWithMeta("/api/now/table/sys_metadata")
    );
  } catch (error) {
    return error;
  }
  throw new Error("expected the aborted request to be cancelled");
}
