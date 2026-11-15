import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";

import { CallMetrics } from "../src/call-metrics.js";
import { closeHarnesses, harness } from "./structured-filter-harness.js";

/**
 * metadata.cache and metadata.timing (#21), end to end: a real MCP server and
 * the real metadata cache over a scripted ServiceNow. Rows are placeholders.
 */

afterEach(closeHarnesses);

const NEWEST = { sys_id: "a".repeat(32), sys_updated_on: "2026-11-01 08:00:00" };
let instanceCounter = 0;

interface Scripted {
  /** Per table: the newest row and total count that the watermark read returns. */
  readonly tables: Map<string, { newest: typeof NEWEST; count: number }>;
  readonly reads: Array<{ table: string; kind: "watermark" | "rows" }>;
  readonly upstream: NonNullable<Parameters<typeof harness>[1]>["upstream"];
}

function scripted(delayMs = 0): Scripted {
  const tables = new Map<string, { newest: typeof NEWEST; count: number }>();
  const reads: Scripted["reads"] = [];
  return {
    tables,
    reads,
    upstream: async (path, params) => {
      const table = /\/api\/now\/table\/([a-z_]+)/u.exec(path)![1];
      const state = tables.get(table) ?? { newest: { ...NEWEST }, count: 3 };
      tables.set(table, state);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (params?.sysparm_query === "ORDERBYDESCsys_updated_on") {
        reads.push({ table, kind: "watermark" });
        return {
          data: { result: [{ ...state.newest }] },
          status: 200,
          headers: new Headers({
            "x-total-count": String(state.count),
            date: "Sun, 15 Nov 2026 12:00:00 GMT",
          }),
        };
      }
      reads.push({ table, kind: "rows" });
      return {
        data: { result: [{ sys_id: "b".repeat(32), name: `${table} fixture`, script: "needle" }] },
        status: 200,
        headers: new Headers({ "x-total-count": "1" }),
      };
    },
  };
}

async function cachedServer(delayMs = 0) {
  const double = scripted(delayMs);
  instanceCounter += 1;
  const connected = await harness(undefined, {
    instance: `https://call-metadata-${instanceCounter}.service-now.com`,
    metadataCache: {},
    upstream: double.upstream,
    codeTables: true,
  });
  return { connected, double };
}

type Connected = Awaited<ReturnType<typeof cachedServer>>["connected"];

async function metadataOf(connected: Connected, name: string, args: Record<string, unknown>) {
  const result = await connected.client.callTool({ name, arguments: { profile: "p", ...args } });
  expect(result.isError).toBeUndefined();
  return (result.structuredContent as { metadata: Record<string, unknown> }).metadata;
}

const queryScripts = (extra: Record<string, unknown> = {}) => ({
  table: "sys_script_include",
  limit: 22,
  ...extra,
});

describe("metadata.cache", () => {
  it("is miss, then hit, then bypass for a forced recache, on a code-table read", async () => {
    const { connected } = await cachedServer();
    expect((await metadataOf(connected, "sn_query", queryScripts())).cache).toBe("miss");
    expect((await metadataOf(connected, "sn_query", queryScripts())).cache).toBe("hit");
    expect((await metadataOf(connected, "sn_query", queryScripts({ force_recache: true }))).cache).toBe("bypass");
    // The forced refresh stored fresh rows, so the next read is served from them.
    expect((await metadataOf(connected, "sn_query", queryScripts())).cache).toBe("hit");
  });

  it("is miss again once the table's watermark moves", async () => {
    const { connected, double } = await cachedServer();
    await metadataOf(connected, "sn_query", queryScripts());
    expect((await metadataOf(connected, "sn_query", queryScripts())).cache).toBe("hit");
    double.tables.get("sys_script_include")!.count += 1;
    expect((await metadataOf(connected, "sn_query", queryScripts())).cache).toBe("miss");
  });

  it("is mixed for a no-table sn_codesearch whose five reads differ, then hit when all hit", async () => {
    const { connected } = await cachedServer();
    // Warm two of the five code tables.
    for (const table of ["sys_script", "sys_ui_script"]) {
      expect((await metadataOf(connected, "sn_codesearch", { search_term: "needle", table })).cache).toBe("miss");
    }
    const mixed = await metadataOf(connected, "sn_codesearch", { search_term: "needle" });
    expect(mixed.cache).toBe("mixed");
    // Every table is warm now, so all five reads hit and the call says so.
    expect((await metadataOf(connected, "sn_codesearch", { search_term: "needle" })).cache).toBe("hit");
  });

  it("is miss when all five reads miss", async () => {
    const { connected, double } = await cachedServer();
    expect((await metadataOf(connected, "sn_codesearch", { search_term: "needle" })).cache).toBe("miss");
    expect(double.reads.filter((read) => read.kind === "rows")).toHaveLength(5);
  });

  it("is absent when the call made no cacheable read, and timing is still there", async () => {
    const { connected } = await cachedServer();
    const metadata = await metadataOf(connected, "sn_query", { table: "incident" });
    expect(metadata).not.toHaveProperty("cache");
    expect(metadata.timing).toBeDefined();
  });

  it("is absent with the metadata cache off, for a table that would be cached", async () => {
    const connected = await harness();
    const metadata = await metadataOf(connected, "sn_query", { table: "sys_script_include" });
    expect(metadata).not.toHaveProperty("cache");
  });

  it("does not change what the cache does", async () => {
    const { connected, double } = await cachedServer();
    await metadataOf(connected, "sn_query", queryScripts());
    await metadataOf(connected, "sn_query", queryScripts());
    await metadataOf(connected, "sn_query", queryScripts({ force_recache: true }));
    // miss: watermark + rows; hit: watermark only; bypass: watermark + rows.
    expect(double.reads.map((read) => read.kind)).toEqual([
      "watermark", "rows", "watermark", "watermark", "rows",
    ]);
  });
});

describe("metadata.timing", () => {
  const FIELDS = ["total_ms", "upstream_ms", "watermark_ms"];

  function expectSane(timing: unknown) {
    const record = timing as Record<string, number>;
    expect(Object.keys(record).sort()).toEqual([...FIELDS].sort());
    for (const field of FIELDS) {
      expect(Number.isInteger(record[field]), field).toBe(true);
      expect(record[field], field).toBeGreaterThanOrEqual(0);
    }
    expect(record.upstream_ms).toBeLessThanOrEqual(record.total_ms);
    expect(record.watermark_ms).toBeLessThanOrEqual(record.total_ms);
  }

  it("is present on every cache outcome and on an uncached read, with sane integers", async () => {
    const { connected } = await cachedServer();
    for (const args of [
      queryScripts(),
      queryScripts(),
      queryScripts({ force_recache: true }),
      { table: "incident" },
    ]) {
      expectSane((await metadataOf(connected, "sn_query", args)).timing);
    }
  });

  it("splits the time between watermark reads and the other requests", async () => {
    const { connected } = await cachedServer(25);
    const miss = (await metadataOf(connected, "sn_query", queryScripts())).timing as Record<string, number>;
    expectSane(miss);
    // A miss is one watermark read and one row read, each about 25 ms, in turn.
    expect(miss.watermark_ms).toBeGreaterThanOrEqual(15);
    expect(miss.upstream_ms).toBeGreaterThanOrEqual(15);
    expect(miss.total_ms).toBeGreaterThanOrEqual(miss.watermark_ms + miss.upstream_ms - 2);
    const hit = (await metadataOf(connected, "sn_query", queryScripts())).timing as Record<string, number>;
    expectSane(hit);
    // A hit makes the watermark request and no other.
    expect(hit.watermark_ms).toBeGreaterThanOrEqual(15);
    expect(hit.upstream_ms).toBe(0);
  });

  it("counts overlapping requests once: five parallel reads take about one read's time", async () => {
    const { connected } = await cachedServer(40);
    const timing = (await metadataOf(connected, "sn_codesearch", { search_term: "needle" })).timing as Record<string, number>;
    expectSane(timing);
    // Five tables, a watermark read and a row read each, run in parallel (the
    // client limiter is not in play with the stubbed client): summed, the
    // upstream figure would be about 200 ms; as wall-clock it stays near 40.
    expect(timing.upstream_ms).toBeLessThan(150);
    expect(timing.watermark_ms).toBeLessThan(150);
    expect(timing.upstream_ms).toBeLessThanOrEqual(timing.total_ms);
  });

  it("carries nothing but numbers and fixed strings", async () => {
    const { connected } = await cachedServer();
    const metadata = await metadataOf(connected, "sn_query", queryScripts());
    const extra = { cache: metadata.cache, timing: metadata.timing };
    expect(JSON.stringify(extra)).toMatch(/^\{"cache":"(hit|miss|bypass|mixed)","timing":\{("[a-z_]+":\d+,?){3}\}\}$/);
    expect(JSON.stringify(extra)).not.toMatch(/service-now|https?:|\//);
  });
});

describe("the byte limit", () => {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

  /** The same response with cache and timing taken out of its metadata. */
  function withoutFields(result: { structuredContent?: unknown } & Record<string, unknown>) {
    const content = result.structuredContent as { metadata: Record<string, unknown> };
    const { cache, timing, ...bare } = content.metadata;
    void cache;
    void timing;
    return { ...result, structuredContent: { ...content, metadata: bare } };
  }

  it("fits the result without counting the fields, which are always added after", async () => {
    const records = Array.from({ length: 6 }, (_, index) => ({
      sys_id: String(index).repeat(32),
      short_description: `row ${index} ${"x".repeat(120)}`,
    }));
    const connected = await harness(records);
    const call = (maxBytes: number) =>
      connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "p", table: "incident", fields: "sys_id,short_description", max_response_bytes: maxBytes },
      });
    const roomy = await call(100_000);
    const bareBytes = bytes(withoutFields(roomy));
    expect(bareBytes).toBeGreaterThan(1_000);

    // Room for the rows and not for the fields: every row is kept, and the
    // fields are there anyway, past the limit by their own size.
    for (const slack of [0, 10, 40, 300]) {
      const result = await call(bareBytes + slack);
      expect(result.isError).toBeUndefined();
      const content = result.structuredContent as { data: { record_count: number }; metadata: Record<string, unknown> };
      expect(content.data.record_count, `slack ${slack}`).toBe(6);
      expect(content.metadata, `slack ${slack}`).toHaveProperty("timing");
      expect(bytes(result) - bareBytes, `slack ${slack}`).toBeLessThan(100);
    }
  });

  it("keeps cache and timing on every response of a budget sweep, truncated or not", async () => {
    // About 380 bytes a row, so that the slack under a budget takes every
    // value from 0 to a row's size, which is what made the fields drop.
    const rows = Array.from({ length: 22 }, (_, index) => ({
      sys_id: String(index % 10).repeat(32),
      name: `Util${index}`,
      script: `/* ${"x".repeat(300)} */`,
    }));
    instanceCounter += 1;
    const connected = await harness(rows, {
      instance: `https://call-metadata-sweep-${instanceCounter}.service-now.com`,
      metadataCache: {},
      upstream: async (_path, params) => {
        const watermark = params?.sysparm_query === "ORDERBYDESCsys_updated_on";
        return {
          data: { result: watermark ? [{ ...NEWEST }] : rows },
          status: 200,
          headers: new Headers(
            watermark
              ? { "x-total-count": "22", date: "Sun, 15 Nov 2026 12:00:00 GMT" }
              : { "x-total-count": "22" }
          ),
        };
      },
      codeTables: true,
    });
    const budgets = [
      ...Array.from({ length: 276 }, (_, index) => 1_000 + index * 29),
      1_000, 1_001, 20_000, 100_000,
    ];
    let truncated = 0;
    let whole = 0;
    let largestFields = 0;
    for (const budget of budgets) {
      const result = await connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "p", table: "sys_script_include", limit: 22, max_response_bytes: budget },
      });
      expect(result.isError, `budget ${budget}`).toBeUndefined();
      const content = result.structuredContent as {
        metadata: { cache?: unknown; timing?: Record<string, unknown>; truncation: { truncated: boolean } };
      };
      expect(["hit", "miss"], `budget ${budget}`).toContain(content.metadata.cache);
      expect(Object.keys(content.metadata.timing ?? {}).sort(), `budget ${budget}`).toEqual([
        "total_ms", "upstream_ms", "watermark_ms",
      ]);
      // Over the limit by at most the two fields, and never by more.
      const fieldsBytes = bytes(result) - bytes(withoutFields(result));
      expect(fieldsBytes, `budget ${budget}`).toBeGreaterThan(0);
      expect(fieldsBytes, `budget ${budget}`).toBeLessThan(100);
      expect(bytes(result) - fieldsBytes, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(bytes(result), `budget ${budget}`).toBeLessThanOrEqual(budget + fieldsBytes);
      largestFields = Math.max(largestFields, fieldsBytes);
      if (content.metadata.truncation.truncated) truncated += 1;
      else whole += 1;
    }
    // The sweep covers both kinds, and the truncated ones are most of it.
    expect(truncated).toBeGreaterThan(200);
    expect(whole).toBeGreaterThan(0);
    expect(largestFields).toBeLessThan(100);
  });

  it("says in each byte budget's description that cache and timing are not counted", async () => {
    const connected = await harness();
    const { tools } = await connected.client.listTools();
    for (const name of ["sn_query", "sn_get", "sn_flow_view"]) {
      const properties = tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, { description?: string }>;
      expect(properties.max_response_bytes?.description, name).toContain(
        "Cache and timing metadata (under 100 bytes) are not counted."
      );
    }
  });

  it("keeps the fields on a response truncated down to the 1000-byte minimum, and leaves the fit alone", async () => {
    const rows = Array.from({ length: 22 }, (_, index) => ({
      sys_id: String(index % 10).repeat(32),
      name: `Util${index}`,
      script: `/* ${"x".repeat(300)} */`,
    }));
    const connected = await harness(rows);
    const call = (maxBytes: number) =>
      connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "p", table: "sys_script_include", limit: 22, max_response_bytes: maxBytes },
      });
    const minimum = await call(1_000);
    const content = minimum.structuredContent as {
      data: { record_count: number };
      metadata: { timing?: unknown; truncation: { truncated: boolean }; limits: { max_bytes: number } };
    };
    expect(content.metadata.truncation.truncated).toBe(true);
    expect(content.metadata.limits.max_bytes).toBe(1_000);
    expect(content.metadata.timing).toBeDefined();
    // The fit never saw the fields: it is what it was for the same budget.
    expect(bytes(withoutFields(minimum))).toBeLessThanOrEqual(1_000);
  });
});

describe("the output schema", () => {
  it("describes the new fields and validates real responses of every kind", async () => {
    const { connected } = await cachedServer();
    const { tools } = await connected.client.listTools();
    const ajv = new Ajv({ strict: false });
    const responses: Array<[string, Record<string, unknown>]> = [
      ["sn_query", queryScripts()],
      ["sn_query", queryScripts()],
      ["sn_query", queryScripts({ force_recache: true })],
      ["sn_query", { table: "incident" }],
      ["sn_codesearch", { search_term: "needle" }],
    ];
    let validated = 0;
    for (const [name, args] of responses) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const validate = ajv.compile(tool.outputSchema!);
      const result = await connected.client.callTool({ name, arguments: { profile: "p", ...args } });
      expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true);
      validated += 1;
    }
    expect(validated).toBe(responses.length);
    for (const tool of tools) {
      const metadata = (tool.outputSchema as { properties: { metadata: { properties: Record<string, unknown> } } })
        .properties.metadata.properties;
      expect(metadata.cache, tool.name).toEqual({ type: "string", enum: ["hit", "miss", "bypass", "mixed"] });
      expect(Object.keys((metadata.timing as { properties: object }).properties), tool.name).toEqual([
        "total_ms", "upstream_ms", "watermark_ms",
      ]);
      // The advertised bound is left out to keep the list small; the type and minimum stay.
      for (const field of Object.values((metadata.timing as { properties: Record<string, unknown> }).properties)) {
        expect(field, tool.name).toEqual({ type: "integer", minimum: 0 });
      }
    }
  });

  it("rejects a timing or cache value outside the contract", async () => {
    const connected = await harness();
    const { tools } = await connected.client.listTools();
    const validate = new Ajv({ strict: false }).compile(
      tools.find((tool) => tool.name === "sn_query")!.outputSchema!
    );
    const base = {
      profile: "p",
      data: { record_count: 0, has_more: false, results: [] },
      metadata: {
        kind: "collection",
        record_count: 0,
        limits: { max_records: 1000, max_bytes: 100000 },
        pagination: { mode: "none" },
        truncation: { truncated: false },
      },
    };
    const withMetadata = (extra: object) => ({ ...base, metadata: { ...base.metadata, ...extra } });
    expect(validate(withMetadata({ cache: "hit", timing: { total_ms: 1, upstream_ms: 0, watermark_ms: 0 } }))).toBe(true);
    expect(validate(withMetadata({ cache: "stale" }))).toBe(false);
    expect(validate(withMetadata({ timing: { total_ms: -1, upstream_ms: 0, watermark_ms: 0 } }))).toBe(false);
    expect(validate(withMetadata({ timing: { total_ms: 1.5, upstream_ms: 0, watermark_ms: 0 } }))).toBe(false);
    expect(validate(withMetadata({ timing: { total_ms: 1, upstream_ms: 0 } }))).toBe(false);
    expect(validate(withMetadata({ timing: { total_ms: 1, upstream_ms: 0, watermark_ms: 0, host: "x" } }))).toBe(false);
  });
});

describe("CallMetrics", () => {
  it("reports one outcome as itself and different outcomes as mixed", () => {
    const metrics = new CallMetrics();
    expect(metrics.snapshot().cache).toBeUndefined();
    metrics.recordCache("hit");
    metrics.recordCache("hit");
    expect(metrics.snapshot().cache).toBe("hit");
    metrics.recordCache("bypass");
    expect(metrics.snapshot().cache).toBe("mixed");
  });

  it("times a request that throws, and a request still running at the snapshot", async () => {
    const metrics = new CallMetrics();
    await expect(
      metrics.measure("upstream", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(metrics.snapshot().timing.upstream_ms).toBeGreaterThanOrEqual(15);
    const running = metrics.measure("watermark", () => new Promise((resolve) => setTimeout(resolve, 40)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(metrics.snapshot().timing.watermark_ms).toBeGreaterThanOrEqual(10);
    await running;
  });
});
