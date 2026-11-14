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
  it("is fitted without the fields, which are added only when they still fit", async () => {
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
    const { cache, timing, ...bare } = (roomy.structuredContent as { metadata: Record<string, unknown> }).metadata;
    expect(timing).toBeDefined();
    expect(cache).toBeUndefined();
    const withoutFields = {
      ...roomy,
      structuredContent: { ...roomy.structuredContent, metadata: bare },
    };
    const bareBytes = Buffer.byteLength(JSON.stringify(withoutFields), "utf8");
    expect(bareBytes).toBeGreaterThan(1_000);

    // Room for the result but not for the fields: every row is kept, the fields are dropped.
    const tight = await call(bareBytes + 10);
    expect(tight.isError).toBeUndefined();
    const tightContent = tight.structuredContent as { data: { record_count: number }; metadata: Record<string, unknown> };
    expect(tightContent.data.record_count).toBe(6);
    expect(tightContent.metadata).not.toHaveProperty("timing");
    expect(tightContent.metadata).not.toHaveProperty("cache");

    // With room for both, both are there and no row is lost.
    const fits = await call(bareBytes + 300);
    const fitsContent = fits.structuredContent as { data: { record_count: number }; metadata: Record<string, unknown> };
    expect(fitsContent.data.record_count).toBe(6);
    expect(fitsContent.metadata).toHaveProperty("timing");
    expect(Buffer.byteLength(JSON.stringify(fits), "utf8")).toBeLessThanOrEqual(bareBytes + 300);
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
