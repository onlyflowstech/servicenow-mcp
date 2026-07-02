import { describe, expect, it, vi } from "vitest";
import {
  handler as discoverHandler,
  schema as discoverSchema,
} from "../src/tools/discover.js";
import {
  handler as codesearchHandler,
  schema as codesearchSchema,
} from "../src/tools/codesearch.js";
import {
  handler as relationshipsHandler,
  schema as relationshipsSchema,
} from "../src/tools/relationships.js";
import { handler as healthHandler, schema as healthSchema } from "../src/tools/health.js";
import { handler as atfHandler, schema as atfSchema } from "../src/tools/atf.js";
import { withWarnings } from "../src/utils.js";
import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

/** The error shape ServiceNowClient throws on a 403. */
const FORBIDDEN = { message: "insufficient rights", status: 403 };
/** What formatError() renders FORBIDDEN as. */
const FORBIDDEN_TEXT = "insufficient rights (HTTP 403)";

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("withWarnings", () => {
  it("returns data unchanged when there are no warnings", () => {
    const arr = [1, 2];
    const obj = { a: 1 };
    expect(withWarnings(arr, [])).toBe(arr);
    expect(withWarnings(obj, [])).toBe(obj);
  });

  it("wraps arrays as { results, warnings }", () => {
    expect(withWarnings([1], ["w"])).toEqual({ results: [1], warnings: ["w"] });
  });

  it("adds a warnings key to plain objects", () => {
    expect(withWarnings({ a: 1 }, ["w"])).toEqual({ a: 1, warnings: ["w"] });
  });

  it("wraps scalars as { result, warnings }", () => {
    expect(withWarnings("x", ["w"])).toEqual({ result: "x", warnings: ["w"] });
    expect(withWarnings(null, ["w"])).toEqual({ result: null, warnings: ["w"] });
  });
});

describe("sn_discover apps warnings", () => {
  it("returns store apps plus a warning when sys_app is forbidden", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/sys_app")) throw FORBIDDEN;
      return {
        result: [
          { sys_id: "s1", name: "Store App", version: "1.0", scope: "x_s", active: "true" },
        ],
      };
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await discoverHandler(
      discoverSchema.parse({ type: "apps" }),
      client,
      config
    );
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.warnings).toEqual([`sys_app: ${FORBIDDEN_TEXT}`]);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].source).toBe("store");
  });

  // Behavior change (review fix): a TOTAL failure is an error, not an
  // empty success -- `results: []` would misread as "no apps installed".
  it("returns isError when BOTH app tables are forbidden", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await discoverHandler(
      discoverSchema.parse({ type: "apps" }),
      client,
      config
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain(`sys_app: ${FORBIDDEN_TEXT}`);
    expect(text).toContain(`sys_store_app: ${FORBIDDEN_TEXT}`);
  });

  it("keeps the bare-array shape (no warnings) when both tables succeed", async () => {
    const get = vi.fn(async () => ({
      result: [{ sys_id: "a1", name: "App", version: "1.0", scope: "x_a", active: "true" }],
    }));
    const client = { get } as unknown as ServiceNowClient;

    const parsed = parseText(
      await discoverHandler(discoverSchema.parse({ type: "apps" }), client, config)
    );
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2); // scoped + store rows
  });
});

describe("sn_codesearch warnings", () => {
  it("reports a forbidden table while returning results from the rest", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("sys_script_include")) throw FORBIDDEN;
      return { result: [{ sys_id: "r1", name: "rec", script: "gs.info('x')" }] };
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await codesearchHandler(
      codesearchSchema.parse({ search_term: "gs.info" }),
      client,
      config
    );
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.warnings).toEqual([`sys_script_include: ${FORBIDDEN_TEXT}`]);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(
      parsed.results.every((r: { table: string }) => r.table !== "sys_script_include")
    ).toBe(true);
  });

  it("keeps the bare-array shape (no warnings) when every table succeeds", async () => {
    const get = vi.fn(async () => ({
      result: [{ sys_id: "r1", name: "rec", script: "gs.info('x')" }],
    }));
    const client = { get } as unknown as ServiceNowClient;

    const parsed = parseText(
      await codesearchHandler(
        codesearchSchema.parse({ search_term: "gs.info" }),
        client,
        config
      )
    );
    expect(Array.isArray(parsed)).toBe(true);
  });

  // Regression (review fix): every table failing (expired credentials,
  // no ACLs anywhere) must be isError -- `results: []` would misread as
  // "no code references this term".
  it("returns isError when ALL code tables fail", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await codesearchHandler(
      codesearchSchema.parse({ search_term: "getUser" }),
      client,
      config
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    for (const table of [
      "sys_script",
      "sys_script_include",
      "sys_ui_script",
      "sys_script_client",
      "sys_ws_operation",
    ]) {
      expect(text).toContain(`${table}: ${FORBIDDEN_TEXT}`);
    }
  });

  it("returns isError when the single requested table fails", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await codesearchHandler(
      codesearchSchema.parse({ search_term: "getUser", table: "sys_script" }),
      client,
      config
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`sys_script: ${FORBIDDEN_TEXT}`);
  });
});

describe("sn_relationships warnings", () => {
  const rootRecord = {
    result: { sys_id: "root1", name: "web-server-01", sys_class_name: "cmdb_ci_server" },
  };

  it("surfaces a forbidden cmdb_rel_ci traversal instead of returning silently", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("cmdb_rel_ci")) throw FORBIDDEN;
      return rootRecord;
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await relationshipsHandler(
      relationshipsSchema.parse({ sys_id: "root1" }),
      client,
      config
    );
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.root.name).toBe("web-server-01");
    expect(parsed.relationships).toEqual([]);
    expect(parsed.warnings).toEqual([
      `cmdb_rel_ci (traversal at depth 1): ${FORBIDDEN_TEXT}`,
    ]);
  });

  it("omits warnings on a clean traversal", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("cmdb_rel_ci")) return { result: [] };
      return rootRecord;
    });
    const client = { get } as unknown as ServiceNowClient;

    const parsed = parseText(
      await relationshipsHandler(
        relationshipsSchema.parse({ sys_id: "root1" }),
        client,
        config
      )
    );
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.meta.total).toBe(0);
  });
});

describe("sn_health warnings", () => {
  it("names the forbidden sub-check while the other checks still return", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("sys_cluster_state")) throw FORBIDDEN;
      if (path.includes("/stats/")) return { result: { stats: { count: "3" } } };
      return { result: [{ value: "glide-x.y.z" }] };
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await healthHandler(healthSchema.parse({}), client, config);
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.version.build).toBe("glide-x.y.z");
    expect(parsed.nodes.error).toContain("sys_cluster_state");
    expect(parsed.stats.incidents_active).toBe(3);
    expect(parsed.warnings).toEqual([`sys_cluster_state: ${FORBIDDEN_TEXT}`]);
  });

  it("omits warnings when every sub-check succeeds", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/stats/")) return { result: { stats: { count: "3" } } };
      return { result: [{ value: "glide-x.y.z" }] };
    });
    const client = { get } as unknown as ServiceNowClient;

    const parsed = parseText(
      await healthHandler(healthSchema.parse({}), client, config)
    );
    expect(parsed.warnings).toBeUndefined();
  });

  // Regression (review fix): a fully broken connection must be isError,
  // not a healthy-looking envelope of instance + timestamp + placeholders.
  it("returns isError when EVERY sub-request fails (check=all)", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await healthHandler(healthSchema.parse({}), client, config);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("no health data could be retrieved");
    expect(text).toContain(`sys_cluster_state: ${FORBIDDEN_TEXT}`);
    expect(text).toContain(`sys_trigger: ${FORBIDDEN_TEXT}`);
  });

  it("returns isError when a single-section check fails entirely", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await healthHandler(
      healthSchema.parse({ check: "nodes" }),
      client,
      config
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`sys_cluster_state: ${FORBIDDEN_TEXT}`);
  });
});

describe("sn_atf fallback-chain warnings", () => {
  it("run: reports strategies that failed before the one that succeeded", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/api/sn_atf/rest/test") throw FORBIDDEN;
      return { result: { sys_id: "res1" } };
    });
    const client = { post } as unknown as ServiceNowClient;

    const result = await atfHandler(
      atfSchema.parse({ action: "run", test_sys_id: "t1", wait: false }),
      client,
      config
    );
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.sys_id).toBe("res1");
    expect(parsed.warnings).toEqual([
      `POST /api/sn_atf/rest/test: ${FORBIDDEN_TEXT}`,
    ]);
  });

  it("run: omits warnings when the first strategy succeeds", async () => {
    const post = vi.fn(async () => ({ result: { sys_id: "res1" } }));
    const client = { post } as unknown as ServiceNowClient;

    const parsed = parseText(
      await atfHandler(
        atfSchema.parse({ action: "run", test_sys_id: "t1", wait: false }),
        client,
        config
      )
    );
    expect(parsed).toEqual({ sys_id: "res1" });
  });

  it("run: the final error lists every failed strategy and why", async () => {
    const post = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { post } as unknown as ServiceNowClient;

    const result = await atfHandler(
      atfSchema.parse({ action: "run", test_sys_id: "t1" }),
      client,
      config
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain(`POST /api/sn_atf/rest/test: ${FORBIDDEN_TEXT}`);
    expect(text).toContain(`POST /api/now/atf/test/{id}/run: ${FORBIDDEN_TEXT}`);
    expect(text).toContain(
      `sys_atf_test_result (schedule via Table API): ${FORBIDDEN_TEXT}`
    );
  });

  it("run-suite: reports the failed first strategy when the fallback succeeds", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/api/sn_atf/rest/suite") throw FORBIDDEN;
      return { result: { tracker_id: "trk1" } };
    });
    const client = { post } as unknown as ServiceNowClient;

    const result = await atfHandler(
      atfSchema.parse({ action: "run-suite", suite_sys_id: "s1", wait: false }),
      client,
      config
    );
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.tracker_id).toBe("trk1");
    expect(parsed.warnings).toEqual([
      `POST /api/sn_atf/rest/suite: ${FORBIDDEN_TEXT}`,
    ]);
  });

  it("run-suite: the final error lists both failed strategies", async () => {
    const post = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { post } as unknown as ServiceNowClient;

    const result = await atfHandler(
      atfSchema.parse({ action: "run-suite", suite_sys_id: "s1" }),
      client,
      config
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain(`POST /api/sn_atf/rest/suite: ${FORBIDDEN_TEXT}`);
    expect(text).toContain(`POST /api/now/atf/suite/{id}/run: ${FORBIDDEN_TEXT}`);
  });
});
