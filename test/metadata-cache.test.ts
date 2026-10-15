import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ServiceNowConfig } from "../src/config.js";
import type { RequestResult, ServiceNowOperations } from "../src/client.js";
import { credentialFingerprint } from "../src/profile-manager.js";
import {
  DEFAULT_METADATA_CACHE_TABLES,
  FORCE_RECACHE_PARAM,
  MAX_METADATA_CACHE_ENTRIES_PER_SCOPE,
  createCachedServiceNowOperations,
  createMetadataCacheConfig,
} from "../src/metadata-cache.js";

function result(payload: unknown): RequestResult<unknown> {
  return { data: payload, status: 200, headers: new Headers({ "x-total-count": "1" }) };
}

interface TableRow {
  readonly sys_id?: unknown;
  readonly sys_updated_on?: unknown;
}

/**
 * Upstream double. `table.newest` is the row the instance would return for
 * ORDERBYDESCsys_updated_on, as stored; tests move it to simulate writes.
 */
function operations() {
  const table: { newest: TableRow | undefined; watermarkThrows: boolean } = {
    newest: { sys_id: "row-1", sys_updated_on: "2025-01-15 12:00:00" },
    watermarkThrows: false,
  };
  const getWithMeta = vi.fn(async (path: string, params?: Record<string, string>) => {
    return result({ result: [{ sys_id: `${path}:${params?.sysparm_fields ?? "all"}` }] });
  });
  const get = vi.fn(async (_path: string, _params?: Record<string, string>) => {
    if (table.watermarkThrows) throw new Error("upstream 500");
    return { result: table.newest === undefined ? [] : [{ ...table.newest }] };
  });
  const base = {
    get,
    getWithMeta,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postBinary: vi.fn(),
    getRaw: vi.fn(),
  } as unknown as ServiceNowOperations & { get: typeof get; getWithMeta: typeof getWithMeta };
  return { base, get, getWithMeta, table };
}

describe("metadata cache", () => {
  it("serves metadata table reads from a per-instance cache while the watermark matches", async () => {
    const { base, get, getWithMeta } = operations();
    const cached = createCachedServiceNowOperations(base, "https://a.service-now.com", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(1);
    // One watermark read before the fetch, one to validate the hit.
    expect(get).toHaveBeenCalledTimes(2);
    for (const [path, params] of get.mock.calls) {
      expect(path).toBe("/api/now/table/sys_dictionary");
      expect(params).toEqual({
        sysparm_query: "ORDERBYDESCsys_updated_on",
        sysparm_fields: "sys_id,sys_updated_on",
        sysparm_limit: "1",
        sysparm_no_count: "true",
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      });
    }
  });

  it("refreshes once the watermark moves", async () => {
    const { base, getWithMeta, table } = operations();
    const cached = createCachedServiceNowOperations(base, "https://moved.service-now.com|fp", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    table.newest = { sys_id: "row-2", sys_updated_on: "2025-01-15 12:00:07" };
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    // Refetched once for the move, then served against the new watermark.
    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("refreshes when only the newest row's sys_id changes", async () => {
    // The newest row was deleted, or another row took the top within the same
    // second. The timestamp alone would call this unchanged.
    const { base, getWithMeta, table } = operations();
    const cached = createCachedServiceNowOperations(base, "https://sysid.service-now.com|fp", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    table.newest = { sys_id: "row-0", sys_updated_on: "2025-01-15 12:00:00" };
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("refreshes metadata cache when forced and strips the internal force flag upstream", async () => {
    const { base, getWithMeta } = operations();
    const cached = createCachedServiceNowOperations(base, "https://b.service-now.com", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_metadata_action", {
      sysparm_fields: "sys_id",
      [FORCE_RECACHE_PARAM]: "true",
    });

    expect(getWithMeta).toHaveBeenCalledWith("/api/now/table/sys_metadata_action", {
      sysparm_fields: "sys_id",
    });
  });

  it("does not cache non-metadata table reads", async () => {
    const { base, get, getWithMeta } = operations();
    const cached = createCachedServiceNowOperations(base, "https://c.service-now.com", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/incident", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/incident", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled();
  });

  it("never shares cached rows between two identities on one instance", async () => {
    // ServiceNow evaluates ACLs per user and a cache hit skips the upstream
    // read entirely, so an instance-only scope would serve one identity's
    // authorized rows to another.
    const instance = "https://shared.service-now.com";
    const admin = operations();
    const readonlyUser = operations();
    const adminCache = createCachedServiceNowOperations(
      admin.base,
      `${instance}|fingerprint-admin`,
      { ttlMs: 60_000 }
    );
    const readonlyCache = createCachedServiceNowOperations(
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
      const cached = createCachedServiceNowOperations(base, scope, { ttlMs: 60_000 });
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    }

    expect(getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("expires entries and refuses to serve them past the TTL", async () => {
    const { base, get, getWithMeta } = operations();
    const cached = createCachedServiceNowOperations(
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
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not cache a 204 no-content response", async () => {
    const { base, getWithMeta } = operations();
    getWithMeta.mockResolvedValue({ data: null, status: 204, headers: new Headers() });
    const cached = createCachedServiceNowOperations(
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
    const cached = createCachedServiceNowOperations(base, scope, { ttlMs: 60_000 });
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
    const cached = createCachedServiceNowOperations(base, "https://default.service-now.com|fp", {});

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

    const { base, get, getWithMeta } = operations();
    const cached = createCachedServiceNowOperations(base, "https://props.service-now.com|fp", {});

    await cached.getWithMeta("/api/now/table/sys_properties", {
      sysparm_query: "name=glide.war",
      sysparm_fields: "value",
    });
    await cached.getWithMeta("/api/now/table/sys_properties", {
      sysparm_query: "name=glide.war",
      sysparm_fields: "value",
    });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled();
  });

  it("still caches sys_properties when an operator opts in explicitly", async () => {
    const { base, getWithMeta } = operations();
    const cached = createCachedServiceNowOperations(
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
    await createCachedServiceNowOperations(admin.base, adminScope, { ttlMs: 60_000 })
      .getWithMeta("/api/now/table/sys_properties", selector);
    await createCachedServiceNowOperations(readonlyUser.base, readonlyScope, { ttlMs: 60_000 })
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
    const cached = createCachedServiceNowOperations(
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
      const { base, get, getWithMeta } = operations();
      const cached = createCachedServiceNowOperations(
        base,
        "https://clientcreds.service-now.com|fp",
        {}
      );

      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

      expect(getWithMeta).toHaveBeenCalledTimes(1);
      expect(new Set(get.mock.calls.map(([path]) => path))).toEqual(
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
    const { base, get, getWithMeta, table } = operations();
    const cached = createCachedServiceNowOperations(
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
    for (const [, params] of get.mock.calls) {
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
    const cached = createCachedServiceNowOperations(
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
    ["the watermark read fails", { watermarkThrows: true }],
    ["the table reads back empty", { newest: undefined }],
    ["sys_updated_on is not readable", { newest: { sys_id: "row-1", sys_updated_on: "" } }],
    ["sys_updated_on is a display value", { newest: { sys_id: "row-1", sys_updated_on: "15/01/2025 07:00:00" } }],
    ["the row has no sys_id", { newest: { sys_updated_on: "2025-01-15 12:00:00" } }],
  ])("serves fresh rows and keeps nothing when %s", async (_label, state) => {
    const { base, getWithMeta, table } = operations();
    Object.assign(table, state);
    const cached = createCachedServiceNowOperations(
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

  it("refetches rather than serving when the watermark read fails on a hit", async () => {
    const { base, getWithMeta, table } = operations();
    const cached = createCachedServiceNowOperations(
      base,
      "https://hitfail.service-now.com|fp",
      { ttlMs: 60_000 }
    );

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    table.watermarkThrows = true;
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("drops the old entry on a forced refresh even when the new one cannot be kept", async () => {
    // force_recache is how a caller surfaces a delete before expiry. The
    // watermark would still match the old entry, so leaving it in place would
    // serve the deleted row again on the next call.
    const { base, getWithMeta, table } = operations();
    const cached = createCachedServiceNowOperations(
      base,
      "https://forced.service-now.com|fp",
      { ttlMs: 60_000 }
    );
    const selector = { sysparm_fields: "sys_id" };

    await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
    table.watermarkThrows = true;
    await cached.getWithMeta("/api/now/table/sys_dictionary", { ...selector, [FORCE_RECACHE_PARAM]: "true" });
    table.watermarkThrows = false;
    await cached.getWithMeta("/api/now/table/sys_dictionary", selector);

    expect(getWithMeta).toHaveBeenCalledTimes(3);
  });

  it("re-caches after a forced refresh", async () => {
    const { base, getWithMeta } = operations();
    const cached = createCachedServiceNowOperations(
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
    const cached = createCachedServiceNowOperations(
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
