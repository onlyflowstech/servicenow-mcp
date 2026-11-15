import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  ServiceNowClient,
  createServiceNowOperations,
} from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { createCachedServiceNowOperations } from "../src/metadata-cache.js";
import {
  handler as codesearchHandler,
  schema as codesearchSchema,
} from "../src/tools/codesearch.js";

/**
 * A no-table sn_codesearch reads five code tables. The reads run together,
 * through the real client so its per-origin limiter applies, over a fetch
 * double that tracks how many requests are in flight.
 */

const TABLES = [
  "sys_script",
  "sys_script_include",
  "sys_ui_script",
  "sys_script_client",
  "sys_ws_operation",
] as const;

let counter = 0;

function harness(options: { denied?: readonly string[]; delays?: Partial<Record<string, number>> } = {}) {
  counter += 1;
  const instance = `https://codesearch-concurrency-${counter}.service-now.com`;
  const config: ServiceNowConfig = {
    instance,
    user: "tester",
    password: "placeholder-not-a-real-credential",
    displayValue: "true",
    relDepth: 3,
  };
  let inFlight = 0;
  let peak = 0;
  const watermarks: string[] = [];
  const searches: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const table = /\/api\/now\/table\/([a-z_]+)/u.exec(url.pathname)![1];
      const watermark = url.searchParams.get("sysparm_query") === "ORDERBYDESCsys_updated_on";
      (watermark ? watermarks : searches).push(table);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // A test can make earlier targets answer slower, so completion order is
      // the reverse of target order.
      await new Promise((resolve) => setTimeout(resolve, options.delays?.[table] ?? 15));
      inFlight -= 1;
      if (options.denied?.includes(table)) {
        return new Response(JSON.stringify({ error: { message: "forbidden" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = watermark
        ? { result: [{ sys_id: `${table}-newest`, sys_updated_on: "2026-11-01 08:00:00" }] }
        : { result: [{ sys_id: `${table}-hit`, name: `${table} fixture`, script: "needle", operation_script: "needle" }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Total-Count": "3",
          Date: new Date("2026-11-14T12:00:00Z").toUTCString(),
        },
      });
    })
  );
  const client = new ServiceNowClient(config, { baseRetryDelayMs: 1, sleep: async () => {} });
  const call = (args: Record<string, unknown> = {}) =>
    codesearchHandler(
      codesearchSchema.parse({ search_term: "needle", ...args }),
      // One wrapper per tool call, as the dispatcher builds them.
      createCachedServiceNowOperations(
        createServiceNowOperations(client),
        `${instance}|identity`,
        // The fixture's few-hundred-byte pages are below the default
        // threshold, which would keep them out of the cache this test warms.
        { smallReadBytes: 0 }
      ) as never,
      config,
      undefined as never
    );
  return { call, watermarks, searches, peak: () => peak };
}

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sn_codesearch per-table reads", () => {
  it("reads the five tables together, within the client's concurrency limit, cold then warm", async () => {
    const { call, watermarks, searches, peak } = harness();

    const cold = parseText(await call());
    expect(watermarks.slice().sort()).toEqual([...TABLES].sort());
    expect(searches.slice().sort()).toEqual([...TABLES].sort());
    expect(cold).toHaveLength(5);
    // More than one in flight (it is not serial), never above the limit.
    expect(peak()).toBeGreaterThan(1);
    expect(peak()).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT_REQUESTS);

    watermarks.length = 0;
    searches.length = 0;
    const warm = parseText(await call());
    expect(warm).toEqual(cold);
    expect(watermarks.slice().sort()).toEqual([...TABLES].sort());
    expect(searches).toEqual([]);
  });

  it("returns results in the fixed table order, script includes first, whichever read finishes first", async () => {
    const { call } = harness({
      delays: { sys_script: 60, sys_script_include: 45, sys_ui_script: 30, sys_script_client: 15, sys_ws_operation: 1 },
    });
    const results = parseText(await call()) as Array<{ table: string }>;
    expect(results.map((row) => row.table)).toEqual([
      "sys_script_include",
      "sys_script",
      "sys_ui_script",
      "sys_script_client",
      "sys_ws_operation",
    ]);
  });

  it("reports warnings in target order, and the other tables still return", async () => {
    const { call } = harness({
      denied: ["sys_ws_operation", "sys_script_include"],
      delays: { sys_script_include: 60, sys_ws_operation: 1 },
    });
    const parsed = parseText(await call());

    // sys_script_include precedes sys_ws_operation in target order even though
    // its read finished last.
    expect(parsed.warnings.map((warning: string) => warning.split(":")[0])).toEqual([
      "sys_script_include",
      "sys_ws_operation",
    ]);
    expect(parsed.results.map((row: { table: string }) => row.table).sort()).toEqual([
      "sys_script",
      "sys_script_client",
      "sys_ui_script",
    ]);
  });
});
