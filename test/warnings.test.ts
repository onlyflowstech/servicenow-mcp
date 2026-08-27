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
import { formatError, withWarnings } from "../src/utils.js";
import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import {
  createToolError,
  trustedToolErrorDescriptor,
} from "../src/tool-error.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

/** A genuine trusted authorization failure issued by the client boundary. */
const FORBIDDEN = createToolError("authorization", "retry_after_correction");
const NOT_FOUND = createToolError("not_found", "do_not_retry");
const AMBIGUOUS_POST = createToolError("upstream", "do_not_retry");
const TIMEOUT = createToolError("timeout", "retry_if_safe_and_idempotent");
/** What formatError() renders FORBIDDEN as. */
const FORBIDDEN_TEXT = formatError(FORBIDDEN);
const INTERNAL_TEXT = formatError(new Error("untrusted"));
const ROOT_SYS_ID = "0123456789abcdef0123456789abcdef";
const TEST_SYS_ID = "11111111111111111111111111111111";
const SUITE_SYS_ID = "22222222222222222222222222222222";

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function rejectedDescriptor(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return trustedToolErrorDescriptor(error);
  }
  throw new Error("expected operation to reject");
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
  it("does not leak exception messages, details, causes, headers, URLs, or bodies", async () => {
    const secretProbe = {
      status: 403,
      message: "Authorization: Bearer RAW_SECRET_TOKEN",
      detail: "https://host.invalid/api?secret=RAW_QUERY_SECRET",
      cause: new Error("RAW_CAUSE_SECRET"),
      headers: { Authorization: "Bearer RAW_HEADER_SECRET" },
      body: { token: "RAW_BODY_SECRET" },
    };
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/sys_app")) throw secretProbe;
      return { result: [{ sys_id: "safe", name: "Safe Store App" }] };
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await discoverHandler(
      discoverSchema.parse({ type: "apps" }),
      client,
      config
    );
    const serialized = JSON.stringify(result);

    expect(result.isError).toBeUndefined();
    expect(parseText(result).warnings).toEqual([`sys_app: ${INTERNAL_TEXT}`]);
    for (const probe of [
      "RAW_SECRET_TOKEN",
      "RAW_QUERY_SECRET",
      "RAW_CAUSE_SECRET",
      "RAW_HEADER_SECRET",
      "RAW_BODY_SECRET",
      "host.invalid",
      "Authorization",
      "Bearer",
    ]) {
      expect(serialized).not.toContain(probe);
    }
  });

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
  it("preserves unanimous taxonomy when BOTH app tables are forbidden", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        discoverHandler(discoverSchema.parse({ type: "apps" }), client, config)
      )
    ).toMatchObject({
      category: "authorization",
      retry: "retry_after_correction",
    });
  });

  it("uses the fixed internal rule when both app failures disagree", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(FORBIDDEN)
      .mockRejectedValueOnce(TIMEOUT);
    const client = { get } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        discoverHandler(discoverSchema.parse({ type: "apps" }), client, config)
      )
    ).toMatchObject({ category: "internal", retry: "do_not_retry" });
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
  it("preserves unanimous taxonomy when ALL code tables fail", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        codesearchHandler(
          codesearchSchema.parse({ search_term: "getUser" }),
          client,
          config
        )
      )
    ).toMatchObject({
      category: "authorization",
      retry: "retry_after_correction",
    });
  });

  it("returns isError when the single requested table fails", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        codesearchHandler(
          codesearchSchema.parse({
            search_term: "getUser",
            table: "sys_script",
          }),
          client,
          config
        )
      )
    ).toMatchObject({
      category: "authorization",
      retry: "retry_after_correction",
    });
  });

  it("uses the fixed internal rule when code-table failures disagree", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(FORBIDDEN)
      .mockRejectedValue(TIMEOUT);
    const client = { get } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        codesearchHandler(
          codesearchSchema.parse({ search_term: "getUser" }),
          client,
          config
        )
      )
    ).toMatchObject({ category: "internal", retry: "do_not_retry" });
  });
});

describe("sn_relationships warnings", () => {
  const rootRecord = {
    result: {
      sys_id: ROOT_SYS_ID,
      name: "web-server-01",
      sys_class_name: "cmdb_ci_server",
    },
  };

  it("surfaces a forbidden cmdb_rel_ci traversal instead of returning silently", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("cmdb_rel_ci")) throw FORBIDDEN;
      return rootRecord;
    });
    const client = { get } as unknown as ServiceNowClient;

    const result = await relationshipsHandler(
      relationshipsSchema.parse({ sys_id: ROOT_SYS_ID }),
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
        relationshipsSchema.parse({ sys_id: ROOT_SYS_ID }),
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
  it("preserves unanimous taxonomy when EVERY sub-request fails", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        healthHandler(healthSchema.parse({}), client, config)
      )
    ).toMatchObject({
      category: "authorization",
      retry: "retry_after_correction",
    });
  });

  it("returns isError when a single-section check fails entirely", async () => {
    const get = vi.fn(async () => {
      throw FORBIDDEN;
    });
    const client = { get } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        healthHandler(
          healthSchema.parse({ check: "nodes" }),
          client,
          config
        )
      )
    ).toMatchObject({
      category: "authorization",
      retry: "retry_after_correction",
    });
  });

  it("uses the fixed internal rule when health sub-check failures disagree", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(FORBIDDEN)
      .mockRejectedValue(TIMEOUT);
    const client = { get } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        healthHandler(healthSchema.parse({ check: "version" }), client, config)
      )
    ).toMatchObject({ category: "internal", retry: "do_not_retry" });
  });
});

describe("sn_atf fallback-chain warnings", () => {
  it("run: falls back after a trusted endpoint not-found", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/api/sn_atf/rest/test") throw NOT_FOUND;
      return { result: { sys_id: "res1" } };
    });
    const client = { post } as unknown as ServiceNowClient;

    const result = await atfHandler(
      atfSchema.parse({ action: "run", test_sys_id: TEST_SYS_ID, wait: false }),
      client,
      config
    );
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.sys_id).toBe("res1");
    expect(parsed.warnings).toEqual([
      `POST /api/sn_atf/rest/test: ${formatError(NOT_FOUND)}`,
    ]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("run: omits warnings when the first strategy succeeds", async () => {
    const post = vi.fn(async () => ({ result: { sys_id: "res1" } }));
    const client = { post } as unknown as ServiceNowClient;

    const parsed = parseText(
      await atfHandler(
        atfSchema.parse({
          action: "run",
          test_sys_id: TEST_SYS_ID,
          wait: false,
        }),
        client,
        config
      )
    );
    expect(parsed).toEqual({ sys_id: "res1" });
  });

  it("run: never duplicates an ambiguous first POST failure", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(AMBIGUOUS_POST)
      .mockResolvedValue({ result: { sys_id: "must-not-run" } });
    const client = { post } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        atfHandler(
          atfSchema.parse({
            action: "run",
            test_sys_id: TEST_SYS_ID,
            wait: false,
          }),
          client,
          config
        )
      )
    ).toMatchObject({ category: "upstream", retry: "do_not_retry" });
    expect(post).toHaveBeenCalledOnce();
  });

  it("run: stops before the third POST after an ambiguous second failure", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(NOT_FOUND)
      .mockRejectedValueOnce(AMBIGUOUS_POST)
      .mockResolvedValue({ result: { sys_id: "must-not-run" } });
    const client = { post } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        atfHandler(
          atfSchema.parse({
            action: "run",
            test_sys_id: TEST_SYS_ID,
            wait: false,
          }),
          client,
          config
        )
      )
    ).toMatchObject({ category: "upstream", retry: "do_not_retry" });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("run: reaches the final strategy only after two trusted not-found responses", async () => {
    const post = vi.fn(async () => {
      throw NOT_FOUND;
    });
    const client = { post } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        atfHandler(
          atfSchema.parse({ action: "run", test_sys_id: TEST_SYS_ID }),
          client,
          config
        )
      )
    ).toMatchObject({ category: "not_found", retry: "do_not_retry" });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("run-suite: falls back after a trusted endpoint not-found", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/api/sn_atf/rest/suite") throw NOT_FOUND;
      return { result: { tracker_id: "trk1" } };
    });
    const client = { post } as unknown as ServiceNowClient;

    const result = await atfHandler(
      atfSchema.parse({
        action: "run-suite",
        suite_sys_id: SUITE_SYS_ID,
        wait: false,
      }),
      client,
      config
    );
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.tracker_id).toBe("trk1");
    expect(parsed.warnings).toEqual([
      `POST /api/sn_atf/rest/suite: ${formatError(NOT_FOUND)}`,
    ]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("run-suite: never duplicates an ambiguous first POST failure", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(AMBIGUOUS_POST)
      .mockResolvedValue({ result: { tracker_id: "must-not-run" } });
    const client = { post } as unknown as ServiceNowClient;

    expect(
      await rejectedDescriptor(
        atfHandler(
          atfSchema.parse({
            action: "run-suite",
            suite_sys_id: SUITE_SYS_ID,
            wait: false,
          }),
          client,
          config
        )
      )
    ).toMatchObject({ category: "upstream", retry: "do_not_retry" });
    expect(post).toHaveBeenCalledOnce();
  });
});
