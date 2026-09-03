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

interface OperationsOptions {
  /** sys_user.time_zone for the session account; "" means the field is empty. */
  readonly userTimeZone?: string;
  /** glide.sys.default.tz; undefined means the property is absent. */
  readonly systemTimeZone?: string;
  /** Throw on the sys_user lookup, as an unreadable table would. */
  readonly userLookupThrows?: boolean;
}

const SESSION_USER = "integration.user";

/** Probe calls only -- the timezone lookups share the same `get` mock. */
function probeCalls(get: { mock: { calls: unknown[][] } }): unknown[][] {
  return get.mock.calls.filter(
    ([path]) =>
      path !== "/api/now/table/sys_user" && path !== "/api/now/table/sys_properties"
  );
}

function operations(changed = false, options: OperationsOptions = {}) {
  const { userTimeZone = "UTC", systemTimeZone, userLookupThrows = false } = options;
  const getWithMeta = vi.fn(async (path: string, params?: Record<string, string>) => {
    return result({ result: [{ sys_id: `${path}:${params?.sysparm_fields ?? "all"}` }] });
  });
  const get = vi.fn(async (path: string) => {
    if (path === "/api/now/table/sys_user") {
      if (userLookupThrows) throw new Error("ACL denied");
      return { result: [{ time_zone: userTimeZone }] };
    }
    if (path === "/api/now/table/sys_properties") {
      return {
        result: systemTimeZone === undefined ? [] : [{ value: systemTimeZone }],
      };
    }
    return { result: changed ? [{ sys_id: "changed" }] : [] };
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
  return { base, get, getWithMeta };
}

describe("metadata cache", () => {
  it("serves metadata table reads from a per-instance cache after a clean changed-since probe", async () => {
    const { base, get, getWithMeta } = operations(false);
    const cached = createCachedServiceNowOperations(base, "https://a.service-now.com", { ttlMs: 60_000 }, SESSION_USER);

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(1);
    expect(probeCalls(get)).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/api/now/table/sys_dictionary", expect.objectContaining({
      sysparm_fields: "sys_id,sys_updated_on",
      sysparm_limit: "1",
    }));
  });

  it("refreshes metadata cache when forced and strips the internal force flag upstream", async () => {
    const { base, getWithMeta } = operations(false);
    const cached = createCachedServiceNowOperations(base, "https://b.service-now.com", { ttlMs: 60_000 }, SESSION_USER);

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
    const cached = createCachedServiceNowOperations(base, "https://c.service-now.com", { ttlMs: 60_000 }, SESSION_USER);

    await cached.getWithMeta("/api/now/table/incident", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/incident", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
    expect(probeCalls(get)).toHaveLength(0);
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
      { ttlMs: 60_000 },
      SESSION_USER
    );
    const readonlyCache = createCachedServiceNowOperations(
      readonlyUser.base,
      `${instance}|fingerprint-readonly`,
      { ttlMs: 60_000 },
      SESSION_USER
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
      const cached = createCachedServiceNowOperations(base, scope, { ttlMs: 60_000 }, SESSION_USER);
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    }

    expect(getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("expires entries and refuses to serve them past the TTL", async () => {
    const { base, get, getWithMeta } = operations(false);
    const cached = createCachedServiceNowOperations(
      base,
      "https://ttl.service-now.com|fp",
      { ttlMs: 1_000 },
      SESSION_USER
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
    // An expired entry is dropped without spending a freshness probe.
    expect(probeCalls(get)).toHaveLength(0);
  });

  it("does not cache a 204 no-content response", async () => {
    const { base, getWithMeta } = operations(false);
    getWithMeta.mockResolvedValue({ data: null, status: 204, headers: new Headers() });
    const cached = createCachedServiceNowOperations(
      base,
      "https://empty.service-now.com|fp",
      { ttlMs: 60_000 },
      SESSION_USER
    );

    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

    expect(getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("bounds a single scope to the entry cap", async () => {
    const { base, getWithMeta } = operations(false);
    const scope = "https://bounded.service-now.com|fp";
    const cached = createCachedServiceNowOperations(base, scope, { ttlMs: 60_000 }, SESSION_USER);
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
    const cached = createCachedServiceNowOperations(base, "https://default.service-now.com|fp", {}, SESSION_USER);

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
    const cached = createCachedServiceNowOperations(base, "https://props.service-now.com|fp", {}, SESSION_USER);

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
    const cached = createCachedServiceNowOperations(
      base,
      "https://optin.service-now.com|fp",
      { ttlMs: 60_000, tables: ["sys_properties"] },
      SESSION_USER
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

    const admin = operations(false);
    const readonlyUser = operations(false);
    const selector = { sysparm_query: "nameLIKEglide" };
    await createCachedServiceNowOperations(admin.base, adminScope, { ttlMs: 60_000 }, SESSION_USER)
      .getWithMeta("/api/now/table/sys_properties", selector);
    await createCachedServiceNowOperations(readonlyUser.base, readonlyScope, { ttlMs: 60_000 }, SESSION_USER)
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
    const cached = createCachedServiceNowOperations(
      base,
      "https://strip.service-now.com|fp",
      { ttlMs: 60_000 },
      SESSION_USER
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

  it("formats the freshness probe in the session timezone, not UTC", async () => {
    const { base, get } = operations(false, { userTimeZone: "US/Eastern" });
    const cached = createCachedServiceNowOperations(
      base,
      "https://tz.service-now.com|fp",
      { ttlMs: 60_000 },
      SESSION_USER
    );

    vi.useFakeTimers();
    try {
      // 2025-01-15T12:00:00Z is 07:00 in US/Eastern (UTC-5).
      vi.setSystemTime(Date.parse("2025-01-15T12:00:00Z"));
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      vi.setSystemTime(Date.parse("2025-01-15T12:00:30Z"));
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    } finally {
      vi.useRealTimers();
    }

    const [, params] = probeCalls(get)[0] as [string, Record<string, string>];
    expect(params.sysparm_query).toBe("sys_updated_on>2025-01-15 07:00:00");
    expect(params.sysparm_query).not.toContain("12:00:00");
  });

  it("resolves the offset per instant, so a DST transition is not skewed", async () => {
    // The whole reason a NAME is cached and not an offset: the same zone is
    // UTC-5 before the transition and UTC-4 after it, and a cached -05:00
    // would silently reintroduce the skew for half the year.
    const probeQueries: string[] = [];
    for (const instant of ["2025-03-09T06:30:00Z", "2025-03-09T07:30:00Z"]) {
      const { base, get } = operations(false, { userTimeZone: "US/Eastern" });
      const cached = createCachedServiceNowOperations(
        base,
        `https://dst-${instant}.service-now.com|fp`,
        { ttlMs: 60_000 },
        SESSION_USER
      );
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.parse(instant));
        await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
        vi.setSystemTime(Date.parse(instant) + 30_000);
        await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      } finally {
        vi.useRealTimers();
      }
      const [, params] = probeCalls(get)[0] as [string, Record<string, string>];
      probeQueries.push(params.sysparm_query!);
    }

    // 06:30Z is 01:30 EST (UTC-5); 07:30Z is 03:30 EDT (UTC-4).
    expect(probeQueries[0]).toBe("sys_updated_on>2025-03-09 01:30:00");
    expect(probeQueries[1]).toBe("sys_updated_on>2025-03-09 03:30:00");
  });

  it("falls back to the instance default when the user timezone is empty", async () => {
    // `time_zone` is not required and is frequently empty. Empty means
    // "inherit the system default" -- never UTC.
    const { base, get } = operations(false, {
      userTimeZone: "",
      systemTimeZone: "Australia/Sydney",
    });
    const cached = createCachedServiceNowOperations(
      base,
      "https://inherit.service-now.com|fp",
      { ttlMs: 60_000 },
      SESSION_USER
    );

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2025-06-15T00:00:00Z"));
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      vi.setSystemTime(Date.parse("2025-06-15T00:00:30Z"));
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
    } finally {
      vi.useRealTimers();
    }

    const [, params] = probeCalls(get)[0] as [string, Record<string, string>];
    // Sydney is UTC+10 in June (no DST in the southern winter).
    expect(params.sysparm_query).toBe("sys_updated_on>2025-06-15 10:00:00");
  });

  it.each([
    ["sys_user is unreadable", { userLookupThrows: true }],
    ["both the field and the property are empty", { userTimeZone: "" }],
    ["the resolved name is not a real zone", { userTimeZone: "Not/AZone" }],
  ])("disables caching entirely when %s", async (_label, options) => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { base, getWithMeta } = operations(false, options);
      const cached = createCachedServiceNowOperations(
        base,
        `https://unresolved-${_label}.service-now.com|fp`,
        { ttlMs: 60_000 },
        SESSION_USER
      );

      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

      // Fails toward not caching rather than assuming UTC and serving stale
      // metadata that only misbehaves for narrowly granted profiles.
      expect(getWithMeta).toHaveBeenCalledTimes(2);
      const warned = warn.mock.calls.map(([line]) => String(line)).join("");
      expect(warned).toContain("metadata caching is disabled");
      expect(warned).toContain(SESSION_USER);
      expect(warned).not.toContain("fp");
    } finally {
      warn.mockRestore();
    }
  });

  it("disables caching when the profile has no configured user name", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { base, getWithMeta } = operations(false, { userTimeZone: "US/Eastern" });
      const cached = createCachedServiceNowOperations(
        base,
        "https://nouser.service-now.com|fp",
        { ttlMs: 60_000 },
        ""
      );

      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
      await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });

      expect(getWithMeta).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map(([line]) => String(line)).join("")).toContain(
        "no configured user name"
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("never shares a resolved timezone between identities on one instance", async () => {
    // The HIGH-4 bug again, one layer up: two accounts on one instance can be
    // in different timezones, and sharing a resolution corrupts both windows.
    const instance = "https://tzshared.service-now.com";
    const eastern = operations(false, { userTimeZone: "US/Eastern" });
    const sydney = operations(false, { userTimeZone: "Australia/Sydney" });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2025-01-15T12:00:00Z"));
      for (const [ops, fingerprint] of [
        [eastern, "fingerprint-eastern"],
        [sydney, "fingerprint-sydney"],
      ] as const) {
        const cached = createCachedServiceNowOperations(
          ops.base,
          `${instance}|${fingerprint}`,
          { ttlMs: 60_000 },
          SESSION_USER
        );
        await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
        vi.setSystemTime(Date.parse("2025-01-15T12:00:30Z"));
        await cached.getWithMeta("/api/now/table/sys_dictionary", { sysparm_fields: "sys_id" });
        vi.setSystemTime(Date.parse("2025-01-15T12:00:00Z"));
      }
    } finally {
      vi.useRealTimers();
    }

    const easternQuery = (probeCalls(eastern.get)[0] as [string, Record<string, string>])[1];
    const sydneyQuery = (probeCalls(sydney.get)[0] as [string, Record<string, string>])[1];
    expect(easternQuery.sysparm_query).toBe("sys_updated_on>2025-01-15 07:00:00");
    expect(sydneyQuery.sysparm_query).toBe("sys_updated_on>2025-01-15 23:00:00");
  });

  it("does not extend expiresAt when a freshness probe succeeds", async () => {
    // Deletions are only surfaced by expiry, so a repeatedly probed entry must
    // still expire on schedule. If a clean probe slid expiresAt forward, a hot
    // entry would be retained indefinitely and a delete would never surface.
    const { base, getWithMeta } = operations(false, { userTimeZone: "UTC" });
    const cached = createCachedServiceNowOperations(
      base,
      "https://expiry.service-now.com|fp",
      { ttlMs: 10_000 },
      SESSION_USER
    );
    const selector = { sysparm_fields: "sys_id" };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2025-01-01T00:00:00Z"));
      await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
      // Probe repeatedly, well inside the TTL, each time served from cache.
      for (const offset of [2_000, 4_000, 6_000, 8_000]) {
        vi.setSystemTime(Date.parse("2025-01-01T00:00:00Z") + offset);
        await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
      }
      expect(getWithMeta).toHaveBeenCalledTimes(1);

      // Past the original expiry, the entry is gone despite the clean probes.
      vi.setSystemTime(Date.parse("2025-01-01T00:00:00Z") + 10_001);
      await cached.getWithMeta("/api/now/table/sys_dictionary", selector);
      expect(getWithMeta).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
