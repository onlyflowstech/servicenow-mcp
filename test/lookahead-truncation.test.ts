/**
 * The look-ahead row is not a dropped record. A tool that reads one row past
 * its page to learn whether another page exists (sn_codesearch, sn_discover,
 * sn_aggregate) must report has_more and next_offset for it, and nothing in
 * metadata.truncation: no data was lost. Truncation stays for rows the
 * response could not hold and for results the tool itself cut.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { handler as aggregateHandler, schema as aggregateSchema } from "../src/tools/aggregate.js";
import { handler as atfHandler, schema as atfSchema } from "../src/tools/atf.js";
import { handler as attachHandler, schema as attachSchema } from "../src/tools/attach.js";
import { handler as discoverHandler, schema as discoverSchema } from "../src/tools/discover.js";
import { enrichSuccessfulResult } from "../src/tools/index.js";
import { handler as syslogHandler, schema as syslogSchema } from "../src/tools/syslog.js";
import {
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
  type ProductionToolName,
} from "../src/tools/result-envelope.js";
import { fakeInstance, scriptWith, sysId } from "./code-search-fake.js";
import { closeHarnesses, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

interface Envelope {
  data: Record<string, unknown>;
  metadata: {
    record_count: number;
    pagination: {
      has_more: boolean;
      next_offset?: number;
      returned: number;
      offset: number;
      recovery?: string;
    };
    truncation: { truncated: boolean; reason?: string; dropped_records?: number };
  };
}

/** What a client receives for a legacy handler result, the way the registered module builds it. */
function envelopeOf(
  tool: ProductionToolName,
  args: Record<string, unknown>,
  legacy: Parameters<typeof envelopeCompatibilityResult>[2]
): Envelope {
  const result = finalizeEnvelopeResult(
    enrichSuccessfulResult(envelopeCompatibilityResult(tool, args, legacy), "p"),
    tool
  );
  expect(result).toBeDefined();
  return result!.structuredContent as unknown as Envelope;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/** Rows a table answers by sysparm_offset and sysparm_limit, like ServiceNow. */
function paged(rows: readonly Record<string, unknown>[]) {
  return vi.fn(async (_path: string, params: Record<string, string> = {}) => {
    const offset = Number(params.sysparm_offset ?? 0);
    const limit = Number(params.sysparm_limit ?? rows.length);
    return { result: rows.slice(offset, offset + limit) };
  });
}

function numbered(count: number, extra: (index: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    sys_id: sysId(index),
    name: `row-${String(index).padStart(3, "0")}`,
    ...extra(index),
  }));
}

const NOT_TRUNCATED = { truncated: false };

function expectNoTruncation(envelope: Envelope): void {
  expect(envelope.metadata.truncation).toEqual(NOT_TRUNCATED);
  expect(envelope.data).not.toHaveProperty("truncated");
  expect(envelope.data).not.toHaveProperty("dropped_records");
}

describe("sn_codesearch through the registered server", () => {
  const order = ["sys_script_include", "sys_script", "sys_ui_script", "sys_script_client", "sys_ws_operation"];

  function instance(perTable: number) {
    return fakeInstance(
      Object.fromEntries(
        order.map((table, salt) => [
          table,
          Array.from({ length: perTable }, (_, index) => ({
            sys_id: sysId(index, salt),
            name: `${table}-${index}`,
            script: scriptWith("needle", 300),
            operation_script: scriptWith("needle", 300),
          })),
        ])
      )
    );
  }

  async function search(perTable: number, args: Record<string, unknown>): Promise<Envelope> {
    const connected = await harness([], { codeTables: true });
    connected.get.mockImplementation(instance(perTable).get as never);
    const result = await connected.client.callTool({
      name: "sn_codesearch",
      arguments: { profile: "p", search_term: "needle", ...args },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    return result.structuredContent as unknown as Envelope;
  }

  it("reports more rows without reporting a drop, for one table", async () => {
    const page = await search(30, { table: "sys_script_include", limit: 20 });
    expect(page.metadata.record_count).toBe(20);
    expect(page.data.results).toHaveLength(20);
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: 20, returned: 20 });
    expectNoTruncation(page);
  });

  it("reports more rows without reporting a drop, across tables", async () => {
    const page = await search(30, { limit: 20 });
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: 20, returned: 20 });
    expectNoTruncation(page);
  });

  it("reports one row more than the limit as more, not as a loss", async () => {
    const page = await search(21, { table: "sys_script_include", limit: 20 });
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: 20 });
    expectNoTruncation(page);
  });

  it("reports no truncation on a full page that is also the last", async () => {
    // No look-ahead row came back, so nothing was cut. (has_more on a full page
    // stays the envelope's conservative answer; this change does not touch it.)
    const page = await search(30, { table: "sys_script_include", limit: 20, offset: 10 });
    expect(page.metadata.record_count).toBe(20);
    expectNoTruncation(page);
  });

  it("reports neither on a last page with fewer rows than the limit", async () => {
    const page = await search(30, { table: "sys_script_include", limit: 20, offset: 20 });
    expect(page.metadata.record_count).toBe(10);
    expect(page.metadata.pagination.has_more).toBe(false);
    expect(page.metadata.pagination).not.toHaveProperty("next_offset");
    expectNoTruncation(page);
  });

  it("reports neither on a last page across tables", async () => {
    const page = await search(30, { limit: 20, offset: 140 });
    expect(page.metadata.record_count).toBe(10);
    expect(page.metadata.pagination.has_more).toBe(false);
    expectNoTruncation(page);
  });
});

describe("sn_discover and sn_aggregate read a look-ahead row too", () => {
  const types = ["tables", "plugins", "apps"] as const;

  it.each(types)("%s: more rows is has_more, not a drop", async (type) => {
    const args = discoverSchema.parse({ type, limit: 5 });
    const get = paged(numbered(12));
    const page = envelopeOf("sn_discover", args, await discoverHandler(args, { get } as never, {} as never, {} as never));
    expect(page.metadata.record_count).toBe(5);
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: 5, returned: 5 });
    expectNoTruncation(page);
  });

  it.each(types)("%s: a last page reports neither", async (type) => {
    // Apps read two tables, so the combined 12 rows are 24: page past them.
    const rows = type === "apps" ? 3 : 8;
    const args = discoverSchema.parse({ type, limit: 5, offset: 5 });
    const get = paged(numbered(rows));
    const page = envelopeOf("sn_discover", args, await discoverHandler(args, { get } as never, {} as never, {} as never));
    expect(page.metadata.pagination.has_more).toBe(false);
    expect(page.metadata.pagination).not.toHaveProperty("next_offset");
    expectNoTruncation(page);
  });

  const group = (value: string) => ({
    groupby_fields: [{ field: "priority", value, display_value: value }],
    stats: { count: "1" },
  });

  it("sn_aggregate: a sentinel group is has_more, not a drop", async () => {
    const args = aggregateSchema.parse({ table: "incident", type: "COUNT", group_by: "priority", limit: 2 });
    const get = vi.fn(async () => ({ result: [group("1"), group("2"), group("3")] }));
    const page = envelopeOf("sn_aggregate", args, await aggregateHandler(args, { get } as never, {} as never, {} as never));
    expect(page.metadata.record_count).toBe(2);
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: 2 });
    expectNoTruncation(page);
  });

  it("sn_aggregate: a last page reports neither", async () => {
    const args = aggregateSchema.parse({ table: "incident", type: "COUNT", group_by: "priority", limit: 2 });
    const get = vi.fn(async () => ({ result: [group("1")] }));
    const page = envelopeOf("sn_aggregate", args, await aggregateHandler(args, { get } as never, {} as never, {} as never));
    expect(page.metadata.pagination.has_more).toBe(false);
    expectNoTruncation(page);
  });
});

describe("a real size cut still reports byte_limit, without counting the look-ahead row", () => {
  // 21 rows of about 8 KiB: the page's 20 do not fit the 100000-byte limit.
  const big = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ sys_id: sysId(index), name: "n", snippet: "x".repeat(8_000) }));

  it.each(["sn_codesearch", "sn_discover"] as const)("%s counts only the page rows it dropped for size", (tool) => {
    const page = envelopeOf(tool, { limit: 20 }, json({ results: big(21) }));
    const kept = page.metadata.record_count;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(20);
    expect(page.metadata.truncation).toEqual({
      truncated: true,
      reason: "byte_limit",
      dropped_records: 20 - kept,
    });
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: kept });
  });

  it("reports the same count whether or not a look-ahead row came with the page", () => {
    const withRow = envelopeOf("sn_codesearch", { limit: 20 }, json({ results: big(21) }));
    const without = envelopeOf("sn_codesearch", { limit: 20 }, json({ results: big(20) }));
    expect(withRow.metadata.truncation).toEqual(without.metadata.truncation);
  });
});

describe("rows cut by the limit are still reported", () => {
  const rows = (count: number) => numbered(count).map((row) => ({ ...row }));

  it("a tool that does not look ahead and returns more than the limit has dropped records", () => {
    const page = envelopeOf("sn_schema", { limit: 20 }, json(rows(21)));
    expect(page.metadata.truncation).toEqual({ truncated: true, reason: "record_limit", dropped_records: 1 });
  });

  it("a look-ahead tool that returns more than one row past the limit reports the rest", () => {
    const page = envelopeOf("sn_codesearch", { limit: 20 }, json({ results: rows(23) }));
    expect(page.metadata.truncation).toEqual({ truncated: true, reason: "record_limit", dropped_records: 2 });
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: 20 });
  });

  it("a result the tool itself cut stays truncated", () => {
    const page = envelopeOf(
      "sn_query",
      { limit: 20 },
      json({ record_count: 10, has_more: true, truncated: true, dropped_records: 4, results: rows(10) })
    );
    expect(page.metadata.truncation).toMatchObject({ truncated: true, reason: "byte_limit", dropped_records: 4 });
  });
});

describe("tools that never read a look-ahead row report no truncation on a page with more", () => {
  it("sn_atf list", async () => {
    const args = atfSchema.parse({ action: "list", limit: 5 });
    const get = paged(numbered(12));
    const page = envelopeOf("sn_atf", args, await atfHandler(args, { get } as never, {} as never, {} as never));
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: 5, returned: 5 });
    expectNoTruncation(page);
  });

  it("sn_atf list, last page", async () => {
    const args = atfSchema.parse({ action: "list", limit: 5, offset: 10 });
    const get = paged(numbered(12).slice(10));
    const page = envelopeOf("sn_atf", args, await atfHandler(args, { get } as never, {} as never, {} as never));
    expect(page.metadata.pagination.has_more).toBe(false);
    expectNoTruncation(page);
  });

  it("sn_syslog", async () => {
    const args = syslogSchema.parse({ limit: 5 });
    const getWithMeta = vi.fn(async () => ({
      data: { result: numbered(5, () => ({ sys_created_on: "2026-01-01 00:00:00", level: "0", source: "s", message: "m" })) },
      status: 200,
      headers: new Headers({ "x-total-count": "12" }),
    }));
    const page = envelopeOf("sn_syslog", args, await syslogHandler(args, { getWithMeta } as never, {} as never, {} as never));
    expect(page.metadata.pagination).toMatchObject({ has_more: true, next_offset: 5, returned: 5 });
    expectNoTruncation(page);
  });

  it("sn_attach list", async () => {
    const args = attachSchema.parse({ action: "list", table: "incident", sys_id: "a".repeat(32), limit: 5 });
    const get = paged(numbered(5, () => ({ file_name: "f", size_bytes: "1", content_type: "text/plain", download_link: "l" })));
    const page = envelopeOf("sn_attach", args, await attachHandler(args, { get } as never, {} as never, {} as never));
    expectNoTruncation(page);
  });
});
