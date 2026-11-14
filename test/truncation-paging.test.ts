/**
 * has_more and next_offset when rows are dropped for size (#28), through the
 * real MCP server path with synthetic rows. The contract:
 *
 * - `record_count`, `truncated` and `dropped_records` keep their meaning.
 * - `has_more` is true when rows were dropped for size or rows exist past the
 *   window: rows exist that this response did not contain.
 * - `next_offset` is `offset + record_count` when a row came back, so a client
 *   that only follows it loses nothing. With no row returned it is omitted
 *   and the request has to change.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
} from "../src/tools/result-envelope.js";
import { enrichSuccessfulResult } from "../src/tools/index.js";
import { restateContinuationHint } from "../src/tools/truncation-hint.js";
import { closeHarnesses, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

function sysId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

/** A row of roughly `size` serialized bytes. */
function row(index: number, size: number) {
  return {
    sys_id: sysId(index),
    name: `Include${String(index).padStart(2, "0")}`,
    script: "x".repeat(Math.max(1, size - 90)),
  };
}

type Row = ReturnType<typeof row>;

/** A table that answers reads by sysparm_offset and sysparm_limit, like ServiceNow. */
async function tableHarness(rows: readonly Row[]) {
  return harness(rows, {
    upstream: async (_path, params) => {
      const offset = Number(params?.sysparm_offset ?? 0);
      const limit = Number(params?.sysparm_limit ?? rows.length);
      return {
        data: { result: rows.slice(offset, offset + limit) },
        status: 200,
        headers: new Headers(),
      };
    },
  });
}

interface Page {
  readonly data: {
    record_count: number;
    has_more: boolean;
    next_offset?: number;
    truncated?: boolean;
    dropped_records?: number;
    hint?: string;
    results: Array<{ sys_id: string }>;
  };
  readonly metadata: {
    pagination: {
      has_more: boolean;
      next_offset?: number;
      offset: number;
      returned: number;
      recovery?: string;
    };
    truncation: { truncated: boolean; dropped_records?: number };
  };
}

async function read(
  connected: Awaited<ReturnType<typeof harness>>,
  args: Record<string, unknown>
): Promise<Page> {
  const result = await connected.client.callTool({
    name: "sn_query",
    arguments: { profile: "p", table: "sys_script_include", ...args },
  });
  expect(result.isError).toBeUndefined();
  return result.structuredContent as unknown as Page;
}

/** Rows whose sizes vary, so pages truncate at different points. */
const MIXED_ROWS: readonly Row[] = Array.from({ length: 22 }, (_, index) =>
  row(index, 250 + ((index * 137) % 400))
);

describe("has_more and next_offset account for rows dropped for size (#28)", () => {
  it("pages through every row exactly once by following next_offset alone", async () => {
    const connected = await tableHarness(MIXED_ROWS);
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    let truncatedPages = 0;
    while (offset !== undefined) {
      const page: Page = await read(connected, { limit: 10, offset, max_response_bytes: 2500 });
      pages += 1;
      expect(pages).toBeLessThan(40);
      // A row came back, so the next offset exists and advances by exactly
      // the rows returned: nothing is skipped and nothing repeats.
      expect(page.data.record_count).toBeGreaterThan(0);
      expect(page.data.results).toHaveLength(page.data.record_count);
      seen.push(...page.data.results.map((entry) => entry.sys_id));
      if (page.data.truncated === true) {
        truncatedPages += 1;
        expect(page.data.has_more).toBe(true);
        expect(page.data.next_offset).toBe(offset + page.data.record_count);
        expect(page.metadata.pagination.next_offset).toBe(offset + page.data.record_count);
        expect(page.data.dropped_records).toBeGreaterThan(0);
      }
      offset = page.data.has_more ? page.data.next_offset : undefined;
      if (!page.data.has_more) expect(page.data).not.toHaveProperty("next_offset");
    }
    expect(truncatedPages).toBeGreaterThan(2);
    expect(seen).toEqual(MIXED_ROWS.map((entry) => entry.sys_id));
    expect(new Set(seen).size).toBe(MIXED_ROWS.length);
  });

  it("sees every row once even when one row exceeds the budget, by changing the request", async () => {
    const rows = MIXED_ROWS.map((entry, index) => (index === 7 ? row(index, 6_000) : entry));
    const connected = await tableHarness(rows);
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let narrowed = false;
    let pages = 0;
    while (offset !== undefined) {
      pages += 1;
      expect(pages).toBeLessThan(40);
      const page: Page = await read(connected, {
        limit: 10,
        offset,
        max_response_bytes: 2500,
        ...(narrowed ? { fields: "sys_id,name" } : {}),
      });
      if (page.data.record_count === 0) {
        // Nothing came back: rows exist, no offset advances, the request must change.
        expect(page.data.has_more).toBe(true);
        expect(page.data.truncated).toBe(true);
        expect(page.data).not.toHaveProperty("next_offset");
        expect(page.metadata.pagination).not.toHaveProperty("next_offset");
        expect(page.metadata.pagination.recovery).toBe("adjust_request_and_retry_same_offset");
        expect(page.data.hint).toContain("row too large");
        expect(narrowed, "one change of request is enough").toBe(false);
        narrowed = true;
        continue;
      }
      seen.push(...page.data.results.map((entry) => entry.sys_id));
      offset = page.data.has_more ? page.data.next_offset : undefined;
    }
    expect(narrowed).toBe(true);
    expect(seen).toEqual(rows.map((entry) => entry.sys_id));
  });

  it("reports has_more with no next_offset when every row is dropped on the last page", async () => {
    const connected = await tableHarness(MIXED_ROWS);
    const page = await read(connected, { limit: 22, max_response_bytes: 1000 });
    expect(page.data.record_count).toBe(0);
    expect(page.data.truncated).toBe(true);
    expect(page.data.dropped_records).toBe(22);
    // The window held every row: nothing lies beyond it, yet rows exist that
    // this response lacks.
    expect(page.data.has_more).toBe(true);
    expect(page.data).not.toHaveProperty("next_offset");
    expect(page.metadata.pagination).toMatchObject({
      has_more: true,
      returned: 0,
      recovery: "adjust_request_and_retry_same_offset",
    });
    expect(page.metadata.pagination).not.toHaveProperty("next_offset");
    expect(page.data.hint).toContain("row too large");
  });

  it("reports has_more with no next_offset when every row of a window with rows beyond it is dropped", async () => {
    const connected = await tableHarness(MIXED_ROWS);
    const page = await read(connected, { limit: 10, max_response_bytes: 1000 });
    expect(page.data.record_count).toBe(0);
    expect(page.data.has_more).toBe(true);
    // The post-window offset (10) would skip every row of the window.
    expect(page.data).not.toHaveProperty("next_offset");
  });

  it("continues at offset + record_count after a partial drop", async () => {
    const connected = await tableHarness(MIXED_ROWS);
    const page = await read(connected, { limit: 10, offset: 4, max_response_bytes: 2500 });
    expect(page.data.truncated).toBe(true);
    expect(page.data.record_count).toBeGreaterThan(0);
    expect(page.data.record_count).toBeLessThan(10);
    expect(page.data.dropped_records).toBe(10 - page.data.record_count);
    expect(page.data.has_more).toBe(true);
    expect(page.data.next_offset).toBe(4 + page.data.record_count);
    expect(page.metadata.pagination).toMatchObject({
      offset: 4,
      returned: page.data.record_count,
      has_more: true,
      next_offset: 4 + page.data.record_count,
    });
    // The first row after the returned ones is exactly where the page resumes.
    const next = await read(connected, {
      limit: 10,
      offset: page.data.next_offset,
      max_response_bytes: 100_000,
    });
    expect(next.data.results[0]?.sys_id).toBe(MIXED_ROWS[4 + page.data.record_count]?.sys_id);
  });

  it("holds for every row size, whichever stage dropped the rows", async () => {
    for (let size = 100; size <= 700; size += 20) {
      const rows = Array.from({ length: 23 }, (_, index) => row(index, size));
      const connected = await tableHarness(rows);
      const page = await read(connected, { limit: 22, max_response_bytes: 2000 });
      const returned = page.data.results.length;
      expect(page.data.truncated, `size ${size}`).toBe(true);
      expect(page.data.has_more, `size ${size}`).toBe(true);
      if (returned > 0) {
        expect(page.data.next_offset, `size ${size}`).toBe(returned);
        expect(page.metadata.pagination.next_offset, `size ${size}`).toBe(returned);
      } else {
        expect(page.data, `size ${size}`).not.toHaveProperty("next_offset");
      }
      expect(page.data.record_count).toBe(returned);
      expect(page.metadata.truncation.dropped_records).toBe(22 - returned);
    }
  });

  it("leaves has_more false, with no next_offset, when nothing was dropped and no rows remain", async () => {
    const connected = await tableHarness(MIXED_ROWS);
    const last = await read(connected, { limit: 10, offset: 12, max_response_bytes: 100_000 });
    expect(last.data.record_count).toBe(10);
    expect(last.data.has_more).toBe(false);
    expect(last.data).not.toHaveProperty("next_offset");
    expect(last.data).not.toHaveProperty("truncated");
    expect(last.metadata.pagination).not.toHaveProperty("next_offset");
    expect(last.metadata.pagination).not.toHaveProperty("recovery");
    expect(last.metadata.truncation.truncated).toBe(false);

    const whole = await read(connected, { limit: 30, max_response_bytes: 100_000 });
    expect(whole.data.record_count).toBe(22);
    expect(whole.data.has_more).toBe(false);
    expect(whole.data).not.toHaveProperty("next_offset");
  });

  it("keeps the post-window offset when nothing was dropped and rows remain", async () => {
    const connected = await tableHarness(MIXED_ROWS);
    const page = await read(connected, { limit: 10, offset: 2, max_response_bytes: 100_000 });
    expect(page.data.record_count).toBe(10);
    expect(page.data.has_more).toBe(true);
    expect(page.data.next_offset).toBe(12);
    expect(page.data).not.toHaveProperty("truncated");
  });
});

describe("a drop made only by the envelope keeps the hint and next_offset in agreement (#28)", () => {
  /** Tiny rows: the tool's own payload fits the budget, the envelope's metadata does not. */
  const tiny = (count: number, size: number) =>
    Array.from({ length: count }, (_, index) => row(index, size));

  it("restates the continuation hint at next_offset, not at the end of the page", async () => {
    let envelopeOnly = 0;
    for (let size = 40; size <= 110; size += 5) {
      const connected = await tableHarness(tiny(30, size));
      const page = await read(connected, { limit: 22, offset: 3, max_response_bytes: 2000 });
      const label = `size ${size}: ${page.data.hint}`;
      if (page.data.truncated === true) continue;
      if (!page.metadata.truncation.truncated) continue;
      envelopeOnly += 1;
      const returned = page.data.results.length;
      expect(page.data.has_more, label).toBe(true);
      if (returned > 0) {
        expect(page.data.next_offset, label).toBe(3 + returned);
        // Following the hint's own text loses nothing either.
        expect(page.data.hint, label).toBe(
          `More records available. Call sn_query again with offset=${3 + returned}.`
        );
      } else {
        expect(page.data, label).not.toHaveProperty("next_offset");
        expect(page.data.hint, label).toContain("no row fit");
        expect(page.data.hint, label).toContain("retry offset=3");
        expect(page.data.hint, label).not.toMatch(/offset=25/u);
      }
    }
    expect(envelopeOnly).toBeGreaterThan(0);
  });

  it("says no row fit when the envelope alone drops every row", async () => {
    let found = 0;
    for (let size = 150; size <= 700; size += 25) {
      const connected = await tableHarness(tiny(4, size));
      const page = await read(connected, { limit: 1, offset: 2, max_response_bytes: 1000 });
      // The tool kept its one row (its payload fits); only the envelope dropped it.
      if (page.data.truncated === true || page.data.record_count > 0) continue;
      found += 1;
      expect(page.data.has_more).toBe(true);
      expect(page.data).not.toHaveProperty("next_offset");
      expect(page.data.hint).toBe(
        "More records available, but no row fit; adjust the request (fewer fields, a lower limit " +
          "or a higher max_response_bytes) and retry offset=2."
      );
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("restating a tool's continuation hint (#28)", () => {
  it("points a continuation hint at the first row not returned, and says so when none fit", () => {
    const hint = "More records available. Call sn_query again with offset=22.";
    expect(restateContinuationHint(hint, { offset: 0, nextOffset: 14 })).toBe(
      "More records available. Call sn_query again with offset=14."
    );
    expect(restateContinuationHint(hint, { offset: 0, nextOffset: 22 })).toBe(hint);
    expect(
      restateContinuationHint("More records available. Call sn_syslog again with offset=5.", {
        offset: 0,
        nextOffset: 3,
      })
    ).toBe("More records available. Call sn_syslog again with offset=3.");
    expect(restateContinuationHint(hint, { offset: 4 })).toBe(
      "More records available, but no row fit; adjust the request (fewer fields, a lower limit " +
        "or a higher max_response_bytes) and retry offset=4."
    );
    // A notice a tool appended stays.
    expect(
      restateContinuationHint(`${hint} Capped at 100 columns.`, { offset: 0, nextOffset: 9 })
    ).toBe("More records available. Call sn_query again with offset=9. Capped at 100 columns.");
  });

  it("leaves any other text alone", () => {
    for (const text of [
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200.",
      "More records available. Call something_else again with offset=22.",
      "More records available. Call sn_query again with offset=22 and then rm -rf.",
      "",
    ]) {
      expect(restateContinuationHint(text, { offset: 0, nextOffset: 9 })).toBe(text);
    }
  });
});

describe("the shared envelope applies the same rule to every collection tool (#28)", () => {
  const profile = "p";
  const big = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      sys_id: sysId(index),
      note: "x".repeat(200),
    }));

  function fit(tool: Parameters<typeof envelopeCompatibilityResult>[0], args: Record<string, unknown>, data: unknown) {
    const adapted = envelopeCompatibilityResult(tool, args, {
      content: [{ type: "text", text: JSON.stringify(data) }],
    });
    const result = finalizeEnvelopeResult(enrichSuccessfulResult(adapted, profile), tool);
    expect(result).toBeDefined();
    return (result as { structuredContent: { data: unknown; metadata: { pagination: Record<string, unknown>; record_count: number; truncation: { truncated: boolean } } } })
      .structuredContent;
  }

  const paged: Array<[Parameters<typeof envelopeCompatibilityResult>[0], Record<string, unknown>, unknown]> = [
    ["sn_syslog", { offset: 30, limit: 600 }, { record_count: 600, has_more: false, results: big(600) }],
    ["sn_schema", { offset: 30, limit: 600 }, big(600)],
    ["sn_codesearch", { offset: 30, limit: 600 }, { results: big(600) }],
    ["sn_discover", { offset: 30, limit: 600 }, { results: big(600) }],
    ["sn_attach", { action: "list", offset: 30, limit: 600 }, { results: big(600) }],
    [
      "sn_atf",
      { action: "list", offset: 30, limit: 600 },
      { record_count: 600, limit: 600, offset: 30, has_more: false, results: big(600) },
    ],
    ["sn_relationships", { offset: 30, limit: 600 }, { root: { sys_id: sysId(0) }, relationships: big(600), meta: { has_more: false } }],
  ];

  it.each(paged)("%s continues at offset + rows returned", (tool, args, data) => {
    const { metadata } = fit(tool, args, data);
    const returned = metadata.record_count;
    expect(metadata.truncation.truncated).toBe(true);
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThan(600);
    expect(metadata.pagination).toMatchObject({
      has_more: true,
      offset: 30,
      returned,
      next_offset: 30 + returned,
      recovery: "adjust_request_and_retry_same_offset",
    });
  });

  it("gives a collection with no offset argument has_more and no next_offset", () => {
    const { metadata } = fit("sn_nl", {}, { results: big(600) });
    expect(metadata.truncation.truncated).toBe(true);
    expect(metadata.pagination).toMatchObject({ has_more: true });
    expect(metadata.pagination).not.toHaveProperty("next_offset");
  });
});
