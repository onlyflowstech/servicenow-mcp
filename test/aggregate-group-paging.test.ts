/**
 * sn_aggregate pages grouped results itself. The Stats API may ignore
 * sysparm_limit and sysparm_offset when it groups, so a grouped call reads the
 * group list once, orders it, and pages it with `offset` and `limit`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceNowResponseTooLargeError } from "../src/response-too-large.js";
import { MAX_AGGREGATE_GROUPS, handler, schema } from "../src/tools/aggregate.js";
import { enrichSuccessfulResult } from "../src/tools/index.js";
import {
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
} from "../src/tools/result-envelope.js";
import { closeHarnesses, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

interface Envelope {
  data: {
    result: Array<{ groupby_fields: Array<{ value: string }>; stats: { count: string } }>;
    has_more?: boolean;
    next_offset?: number;
    total_groups?: number;
    truncated?: boolean;
    warnings?: string[];
  };
  metadata: {
    record_count: number;
    pagination: { has_more: boolean; next_offset?: number; returned: number; offset: number; recovery?: string };
    truncation: { truncated: boolean; reason?: string; dropped_records?: number };
  };
}

const key = (index: number) => `k${String(index).padStart(5, "0")}`;

function groupRow(index: number, extra = "") {
  return {
    groupby_fields: [{ field: "priority", value: key(index), display_value: `${key(index)}${extra}` }],
    stats: { count: String(index + 1) },
  };
}

function groupList(count: number, extra = "") {
  return Array.from({ length: count }, (_, index) => groupRow(index, extra));
}

/** What a server that ignores sysparm_limit and sysparm_offset answers: every group, in its own order. */
function ignoringServer(rows: readonly unknown[]) {
  const scrambled = [...rows].reverse();
  return vi.fn(async (_path: string, _params: Record<string, string> = {}) => ({ result: scrambled }));
}

/** What a server that honours them answers. */
function honouringServer(rows: readonly unknown[]) {
  return vi.fn(async (_path: string, params: Record<string, string> = {}) => {
    const offset = Number(params.sysparm_offset ?? 0);
    const limit = Number(params.sysparm_limit ?? rows.length);
    return { result: rows.slice(offset, offset + limit) };
  });
}

async function call(
  get: ReturnType<typeof vi.fn>,
  input: Record<string, unknown>
): Promise<{ envelope: Envelope; text: string }> {
  const args = schema.parse({ table: "incident", type: "COUNT", group_by: "priority", ...input });
  const legacy = await handler(args, { get } as never, {} as never, {} as never);
  const result = finalizeEnvelopeResult(
    enrichSuccessfulResult(envelopeCompatibilityResult("sn_aggregate", args, legacy), "p"),
    "sn_aggregate"
  );
  expect(result).toBeDefined();
  const block = result!.content[0];
  return {
    envelope: result!.structuredContent as unknown as Envelope,
    text: block?.type === "text" ? block.text : "",
  };
}

const values = (envelope: Envelope) => envelope.data.result.map((row) => row.groupby_fields[0]!.value);

describe("sn_aggregate grouped paging", () => {
  it("pages a server that ignores limit and offset: pages differ and cover every group once", async () => {
    const get = ignoringServer(groupList(23));
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const { envelope } = await call(get, { limit: 5, offset });
      pages += 1;
      seen.push(...values(envelope));
      expect(envelope.metadata.pagination.offset).toBe(offset);
      if (!envelope.metadata.pagination.has_more) break;
      expect(envelope.metadata.pagination.next_offset).toBe(offset + 5);
      offset = envelope.metadata.pagination.next_offset!;
    }
    expect(pages).toBe(5);
    expect(seen).toEqual(Array.from({ length: 23 }, (_, index) => key(index)));
    expect(new Set(seen).size).toBe(23);
  });

  it("returns different groups for offset 0 and offset 5", async () => {
    const get = ignoringServer(groupList(23));
    const first = await call(get, { limit: 5, offset: 0 });
    const second = await call(get, { limit: 5, offset: 5 });
    expect(values(first.envelope)).toEqual([0, 1, 2, 3, 4].map(key));
    expect(values(second.envelope)).toEqual([5, 6, 7, 8, 9].map(key));
  });

  it("gives the same pages from a server that honours limit and offset", async () => {
    const rows = groupList(23);
    const ignoring = ignoringServer(rows);
    const honouring = honouringServer(rows);
    for (const offset of [0, 5, 20]) {
      const a = await call(ignoring, { limit: 5, offset });
      const b = await call(honouring, { limit: 5, offset });
      expect(values(b.envelope)).toEqual(values(a.envelope));
      expect(b.envelope.metadata.pagination).toEqual(a.envelope.metadata.pagination);
    }
  });

  it("makes one request, bounded by the cap, with no offset", async () => {
    const get = ignoringServer(groupList(10));
    await call(get, { limit: 3, offset: 6 });
    expect(get).toHaveBeenCalledTimes(1);
    const params = get.mock.calls[0]![1]!;
    expect(params.sysparm_limit).toBe(String(MAX_AGGREGATE_GROUPS + 1));
    expect(params).not.toHaveProperty("sysparm_offset");
    expect(params.sysparm_group_by).toBe("priority");
  });

  it("returns an empty last page when the offset is past the end", async () => {
    const get = ignoringServer(groupList(7));
    const { envelope, text } = await call(get, { limit: 5, offset: 50 });
    expect(envelope.data.result).toEqual([]);
    expect(envelope.metadata.record_count).toBe(0);
    expect(envelope.metadata.pagination).toMatchObject({ has_more: false, returned: 0, offset: 50 });
    expect(envelope.metadata.pagination).not.toHaveProperty("next_offset");
    expect(envelope.metadata.truncation).toEqual({ truncated: false });
    expect(envelope.data.total_groups).toBe(7);
    expect(text).not.toMatch(/More records/u);
  });

  it("says a full page that is also the last has no more", async () => {
    const get = ignoringServer(groupList(10));
    const { envelope, text } = await call(get, { limit: 5, offset: 5 });
    expect(envelope.data.result).toHaveLength(5);
    expect(envelope.metadata.pagination.has_more).toBe(false);
    expect(envelope.metadata.pagination).not.toHaveProperty("next_offset");
    expect(envelope.data.has_more).toBe(false);
    expect(envelope.metadata.truncation).toEqual({ truncated: false });
    expect(text).not.toMatch(/More records/u);
  });

  it("reports has_more and next_offset in the data and the text, counting the look-ahead as no drop", async () => {
    const get = ignoringServer(groupList(12));
    const { envelope, text } = await call(get, { limit: 5, offset: 0 });
    expect(envelope.data.result).toHaveLength(5);
    expect(envelope.data).toMatchObject({ has_more: true, next_offset: 5 });
    expect(envelope.metadata.pagination).toMatchObject({ has_more: true, next_offset: 5, returned: 5 });
    expect(envelope.metadata.truncation).toEqual({ truncated: false });
    expect(text).toContain("More records are available at offset 5.");
  });

  it("reports the group total when every group was read, on every page", async () => {
    const get = ignoringServer(groupList(23));
    for (const offset of [0, 10, 20]) {
      const { envelope } = await call(get, { limit: 10, offset });
      expect(envelope.data.total_groups).toBe(23);
    }
  });

  it("reports a count of one when the table has a single group", async () => {
    const { envelope } = await call(ignoringServer(groupList(1)), {});
    expect(envelope.data.total_groups).toBe(1);
    expect(envelope.metadata.pagination.has_more).toBe(false);
  });

  it("orders groups the same however the server ordered them", async () => {
    const rows = groupList(30);
    const shuffled = [...rows.slice(10), ...rows.slice(0, 10)].reverse();
    const a = await call(ignoringServer(rows), { limit: 30 });
    const b = await call(vi.fn(async () => ({ result: shuffled })), { limit: 30 });
    expect(values(b.envelope)).toEqual(values(a.envelope));
  });
});

describe("sn_aggregate grouped paging at the group cap", () => {
  // Just past the cap, in one response, as a server that ignores the limit answers.
  const over = MAX_AGGREGATE_GROUPS + 40;

  it("reports the cut: truncation, a warning, no total, never silent", async () => {
    const get = ignoringServer(groupList(over));
    const { envelope, text } = await call(get, { limit: 10, offset: 0 });
    expect(envelope.data.total_groups).toBeUndefined();
    expect(envelope.data.truncated).toBe(true);
    expect(envelope.data.warnings).toHaveLength(1);
    expect(envelope.data.warnings![0]).toContain(String(MAX_AGGREGATE_GROUPS));
    expect(envelope.data.warnings![0]).toMatch(/fewer distinct values/u);
    expect(envelope.metadata.truncation).toEqual({ truncated: true, reason: "record_limit" });
    expect(envelope.metadata.pagination).toMatchObject({ has_more: true, next_offset: 10 });
    expect(envelope.metadata.pagination).not.toHaveProperty("recovery");
    expect(text).toContain("truncated by record_limit");
  });

  it("serves the same capped groups to a server that honours the limit", async () => {
    // It would answer cap + 1 groups, the most this call asks for.
    const rows = groupList(over);
    const honouring = honouringServer(rows);
    const ignoring = ignoringServer(rows);
    const a = await call(ignoring, { limit: 10, offset: MAX_AGGREGATE_GROUPS - 10 });
    const b = await call(honouring, { limit: 10, offset: MAX_AGGREGATE_GROUPS - 10 });
    expect(values(b.envelope)).toEqual(values(a.envelope));
    expect(b.envelope.data.truncated).toBe(true);
  });

  it("ends the pages at the cap: the last page says no more, and says it was cut", async () => {
    const get = ignoringServer(groupList(over));
    const { envelope, text } = await call(get, { limit: 10, offset: MAX_AGGREGATE_GROUPS - 10 });
    expect(envelope.data.result).toHaveLength(10);
    expect(envelope.metadata.pagination.has_more).toBe(false);
    expect(envelope.metadata.pagination).not.toHaveProperty("next_offset");
    expect(envelope.metadata.truncation).toEqual({ truncated: true, reason: "record_limit" });
    expect(envelope.data.warnings).toHaveLength(1);
    expect(text).toContain("truncated by record_limit");
    expect(text).not.toMatch(/More records/u);
  });

  it("is not capped at exactly the cap", async () => {
    const { envelope } = await call(ignoringServer(groupList(MAX_AGGREGATE_GROUPS)), { limit: 10 });
    expect(envelope.data.total_groups).toBe(MAX_AGGREGATE_GROUPS);
    expect(envelope.metadata.truncation).toEqual({ truncated: false });
  });
});

describe("sn_aggregate grouped page cut for size", () => {
  // 1,000 groups of about 400 bytes: far past the 100,000-byte result limit.
  const rows = groupList(1_200, "x".repeat(300));

  it("continues at the first group not returned, in the data, the metadata and the text", async () => {
    const get = ignoringServer(rows);
    const { envelope, text } = await call(get, { limit: 1_000, offset: 0 });
    const kept = envelope.data.result.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(1_000);
    expect(envelope.metadata.record_count).toBe(kept);
    expect(envelope.metadata.pagination).toMatchObject({ has_more: true, next_offset: kept, returned: kept });
    expect(envelope.data).toMatchObject({ has_more: true, next_offset: kept });
    expect(envelope.metadata.truncation).toEqual({
      truncated: true,
      reason: "byte_limit",
      dropped_records: 1_000 - kept,
    });
    expect(text).toContain(`More records are available at offset ${kept}.`);
    expect(envelope.data.total_groups).toBe(1_200);

    // Following next_offset loses and repeats nothing.
    const seen = values(envelope);
    let offset = envelope.metadata.pagination.next_offset!;
    for (let guard = 0; guard < 50; guard += 1) {
      const next = await call(get, { limit: 1_000, offset });
      seen.push(...values(next.envelope));
      if (!next.envelope.metadata.pagination.has_more) break;
      offset = next.envelope.metadata.pagination.next_offset!;
    }
    expect(seen).toEqual(Array.from({ length: 1_200 }, (_, index) => key(index)));
  });

  it("does not count the look-ahead group as dropped when the page also fits", async () => {
    const { envelope } = await call(ignoringServer(groupList(40)), { limit: 30 });
    expect(envelope.metadata.truncation).toEqual({ truncated: false });
    expect(envelope.metadata.pagination).toMatchObject({ has_more: true, next_offset: 30 });
  });
});

describe("sn_aggregate grouped text", () => {
  it("names the group total after the paging line on a normal page", async () => {
    const { text } = await call(ignoringServer(groupList(23)), { limit: 10 });
    expect(text).toBe(
      'Success for profile "p": collection result with 10 records. More records are available at offset 10. Total groups: 23.'
    );
  });

  it("names the total on a last page and on an empty page past the end", async () => {
    expect((await call(ignoringServer(groupList(23)), { limit: 10, offset: 20 })).text).toBe(
      'Success for profile "p": collection result with 3 records. Total groups: 23.'
    );
    expect((await call(ignoringServer(groupList(7)), { limit: 5, offset: 50 })).text).toContain("Total groups: 7.");
  });

  it("says the list was capped, and how to narrow it, on a capped list", async () => {
    const { text } = await call(ignoringServer(groupList(MAX_AGGREGATE_GROUPS + 40)), { limit: 10 });
    expect(text).toContain("More records are available at offset 10.");
    expect(text).toContain("truncated by record_limit");
    expect(text).toContain(`More than ${MAX_AGGREGATE_GROUPS} groups exist`);
    expect(text).toContain("Group by a field with fewer distinct values");
    expect(text).not.toContain("Total groups");
  });

  it("keeps the continuation, the total and the cut reason when a page is cut for size", async () => {
    const { text, envelope } = await call(ignoringServer(groupList(1_200, "x".repeat(300))), { limit: 1_000 });
    const kept = envelope.data.result.length;
    expect(text).toContain(`More records are available at offset ${kept}.`);
    expect(text).toContain("truncated by byte_limit");
    expect(text).toContain("Total groups: 1200.");
  });

  it("keeps the cap visible, in the data and the text, when a capped list is also cut for size", async () => {
    const { text, envelope } = await call(ignoringServer(groupList(MAX_AGGREGATE_GROUPS + 40, "x".repeat(300))), {
      limit: 1_000,
    });
    const kept = envelope.data.result.length;
    expect(kept).toBeLessThan(1_000);
    expect(envelope.metadata.truncation.reason).toBe("byte_limit");
    expect(envelope.data.truncated).toBe(true);
    expect(envelope.data.warnings).toHaveLength(1);
    expect(text).toContain(`More records are available at offset ${kept}.`);
    expect(text).toContain(`More than ${MAX_AGGREGATE_GROUPS} groups exist`);
  });

  it("leaves the text of an ungrouped result as the summary", async () => {
    const get = vi.fn(async () => ({ result: { stats: { count: "42" } } }));
    const args = schema.parse({ table: "incident", type: "COUNT" });
    const legacy = await handler(args, { get } as never, {} as never, {} as never);
    const result = finalizeEnvelopeResult(
      enrichSuccessfulResult(envelopeCompatibilityResult("sn_aggregate", args, legacy), "p"),
      "sn_aggregate"
    );
    expect(result!.content[0]).toEqual({
      type: "text",
      text: 'Success for profile "p": collection result with 1 record.',
    });
  });
});

describe("sn_aggregate grouped errors and the other paths", () => {
  it("answers an upstream response over the byte limit with how to narrow it", async () => {
    const get = vi.fn(async () => {
      throw new ServiceNowResponseTooLargeError("cumulative upstream response exceeds configured byte limit");
    });
    const args = schema.parse({ table: "incident", type: "COUNT", group_by: "priority" });
    const result = await handler(args, { get } as never, {} as never, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/too large/u);
    expect(result.content[0]!.text).toMatch(/fewer distinct values/u);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("leaves other upstream failures to the caller", async () => {
    const get = vi.fn(async () => {
      throw new Error("boom");
    });
    const args = schema.parse({ table: "incident", type: "COUNT", group_by: "priority" });
    await expect(handler(args, { get } as never, {} as never, {} as never)).rejects.toThrow("boom");
  });

  it("refuses a group_by field the policy does not allow, before any request", async () => {
    const get = vi.fn(async () => ({ result: [] }));
    const args = schema.parse({ table: "incident", type: "COUNT", group_by: "password" });
    await expect(handler(args, { get } as never, {} as never, {} as never)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps the ungrouped call as it was: one row, limit 1, offset 0, no paging fields", async () => {
    const get = vi.fn(async () => ({ result: { stats: { count: "42" } } }));
    const args = schema.parse({ table: "incident", type: "COUNT" });
    const legacy = await handler(args, { get } as never, {} as never, {} as never);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![1]).toMatchObject({ sysparm_limit: "1", sysparm_offset: "0", sysparm_count: "true" });
    expect(get.mock.calls[0]![1]).not.toHaveProperty("sysparm_group_by");
    expect(JSON.parse(legacy.content[0]!.text)).toEqual([{ stats: { count: "42" } }]);
    const result = finalizeEnvelopeResult(
      enrichSuccessfulResult(envelopeCompatibilityResult("sn_aggregate", args, legacy), "p"),
      "sn_aggregate"
    );
    const envelope = result!.structuredContent as unknown as Envelope;
    expect(envelope.data).toEqual({ result: [{ stats: { count: "42" } }] });
    expect(envelope.metadata.truncation).toEqual({ truncated: false });
  });
});

describe("sn_aggregate grouped paging through the registered server", () => {
  const tableAccess = {
    readTables: ["incident"],
    writeTables: [],
    targets: [
      {
        table: "incident",
        kind: "canonical" as const,
        tools: ["sn_aggregate"],
        closureComplete: true,
        relatedTables: ["incident"],
      },
    ],
  };

  async function page(rows: readonly unknown[], args: Record<string, unknown>) {
    const connected = await harness([], { tableAccess });
    connected.get.mockImplementation(ignoringServer(rows) as never);
    const result = await connected.client.callTool({
      name: "sn_aggregate",
      arguments: { profile: "p", table: "incident", type: "COUNT", group_by: "priority", ...args },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    const block = (result.content as Array<{ type: string; text?: string }>)[0];
    return { envelope: result.structuredContent as unknown as Envelope, text: block?.text ?? "", get: connected.get };
  }

  it("validates against the output schema and pages", async () => {
    const rows = groupList(12);
    const first = await page(rows, { limit: 5 });
    expect(values(first.envelope)).toEqual([0, 1, 2, 3, 4].map(key));
    expect(first.envelope.data).toMatchObject({ has_more: true, next_offset: 5, total_groups: 12 });
    expect(first.text).toContain("More records are available at offset 5.");
    const second = await page(rows, { limit: 5, offset: 5 });
    expect(values(second.envelope)).toEqual([5, 6, 7, 8, 9].map(key));
    expect(first.get).toHaveBeenCalledTimes(1);
  });

  it("validates a capped page and a page cut for size", async () => {
    const capped = await page(groupList(MAX_AGGREGATE_GROUPS + 1), { limit: 5 });
    expect(capped.envelope.data.truncated).toBe(true);
    expect(capped.envelope.metadata.truncation).toEqual({ truncated: true, reason: "record_limit" });
    const cut = await page(groupList(900, "x".repeat(300)), { limit: 1_000 });
    expect(cut.envelope.metadata.truncation.reason).toBe("byte_limit");
    expect(cut.envelope.metadata.pagination.has_more).toBe(true);
    expect(cut.envelope.metadata.pagination.next_offset).toBe(cut.envelope.data.result.length);
    expect(cut.text).toContain(`at offset ${cut.envelope.data.result.length}.`);
  });

  it("refuses an unreadable group_by field without a request", async () => {
    const connected = await harness([], { tableAccess });
    const result = await connected.client.callTool({
      name: "sn_aggregate",
      arguments: { profile: "p", table: "incident", type: "COUNT", group_by: "password" },
    });
    expect(result.isError).toBe(true);
    expect(connected.get).not.toHaveBeenCalled();
  });
});
