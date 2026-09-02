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

function operations(changed = false) {
  const getWithMeta = vi.fn(async (path: string, params?: Record<string, string>) => {
    return result({ result: [{ sys_id: `${path}:${params?.sysparm_fields ?? "all"}` }] });
  });
  const get = vi.fn(async () => ({ result: changed ? [{ sys_id: "changed" }] : [] }));
  const base = {
    get,
    getWithMeta,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postBinary: vi.fn(),
    getRaw: vi.fn(),
  } as unknown as ServiceNowOperations & { get: typeof get; getWithMeta: typeof getWithMeta };
  return { base, get, getWithMeta };
}

describe("metadata cache", () => {
  it("serves metadata table reads from a per-instance cache after a clean changed-since probe", async () => {
    const { base, get, getWithMeta } = operations(false);
    const cached = createCachedServiceNowOperations(base, "https://a.service-now.com", { ttlMs: 60_000 });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/now/table/sys_dictionary", expect.objectContaining({
      sysparm_fields: "sys_id,sys_updated_on",
      sysparm_limit: "1",
    }));
  });

  it("refreshes metadata cache when forced and strips the internal force flag upstream", async () => {
    const { base, getWithMeta } = operations(false);
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
    const { base, get, getWithMeta } = operations(false);
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
    const admin = operations(false);
    const readonlyUser = operations(false);
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
    const { base, getWithMeta } = operations(false);
    const scope = "https://reuse.service-now.com|fingerprint-a";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cached = createCachedServiceNowOperations(base, scope, { ttlMs: 60_000 });
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    }

    expect(getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("expires entries and refuses to serve them past the TTL", async () => {
    const { base, get, getWithMeta } = operations(false);
    const cached = createCachedServiceNowOperations(base, "https://ttl.service-now.com|fp", {
      ttlMs: 1_000,
    });

    vi.useFakeTimers();
    try {
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      vi.setSystemTime(Date.now() + 2_000);
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    } finally {
      vi.useRealTimers();
    }

    expect(getWithMeta).toHaveBeenCalledTimes(2);
    // An expired entry is dropped without spending a freshness probe.
    expect(get).not.toHaveBeenCalled();
  });

  it("does not cache a 204 no-content response", async () => {
    const { base, getWithMeta } = operations(false);
    getWithMeta.mockResolvedValue({ data: null, status: 204, headers: new Headers() });
    const cached = createCachedServiceNowOperations(base, "https://empty.service-now.com|fp", {
      ttlMs: 60_000,
    });

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("bounds a single scope to the entry cap", async () => {
    const { base, getWithMeta } = operations(false);
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
    const { base, getWithMeta } = operations(false);
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

    const { base, get, getWithMeta } = operations(false);
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
    const { base, getWithMeta } = operations(false);
    const cached = createCachedServiceNowOperations(base, "https://optin.service-now.com|fp", {
      ttlMs: 60_000,
      tables: ["sys_properties"],
    });

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

    const admin = operations(false);
    const readonlyUser = operations(false);
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
  });

  it("strips the internal force flag on non-metadata passthrough reads too", () => {
    // sysparm_force_recache is this module's own parameter. It must never
    // reach ServiceNow, cached table or not.
    const { base, getWithMeta } = operations(false);
    const cached = createCachedServiceNowOperations(base, "https://strip.service-now.com|fp", {
      ttlMs: 60_000,
    });

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
});
