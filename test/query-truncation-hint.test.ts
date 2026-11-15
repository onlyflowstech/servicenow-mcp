import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { runWithFieldPolicyConfiguration } from "../src/field-policy.js";
import { handler as queryHandler, schema as querySchema } from "../src/tools/query.js";
import {
  neededResponseBytes,
  parseTruncationHint,
  refreshTruncationHint,
  renderTruncationHint,
  type TruncationHintParts,
} from "../src/tools/truncation-hint.js";
import { closeHarnesses, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

/**
 * The byte budget for the through-the-server cases. The shared envelope's own
 * metadata takes most of the 1000-byte minimum, so a budget this size leaves
 * room for some rows, and for the envelope to drop rows the tool kept.
 */
const SERVER_BUDGET = 2000;

function sysId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

/** Rows of roughly `size` serialized bytes: sys_id, name and a bulky script. */
function scriptRows(count: number, size: number) {
  return Array.from({ length: count }, (_, index) => ({
    sys_id: sysId(index),
    name: `Include${String(index).padStart(2, "0")}`,
    script: "x".repeat(Math.max(1, size - 90)),
  }));
}

/** Run sn_query directly (no shared envelope) and parse its payload. */
async function directHint(
  args: Record<string, unknown>,
  records: unknown[],
  policy?: unknown
): Promise<string> {
  const client = {
    getWithMeta: vi.fn(async () => ({
      data: { result: records },
      status: 200,
      headers: new Headers(),
    })),
  } as unknown as ServiceNowClient;
  const run = () =>
    queryHandler(querySchema.parse({ max_response_bytes: 1000, ...args }), client, config);
  const result = await (policy === undefined
    ? run()
    : runWithFieldPolicyConfiguration({ fieldPolicy: policy } as never, run));
  const payload = JSON.parse((result.content[0] as { text: string }).text) as { hint?: string };
  if (typeof payload.hint !== "string") throw new Error("expected a truncation hint");
  return payload.hint;
}

describe("truncation hint text", () => {
  const OVER = Number.POSITIVE_INFINITY;
  const variants: Array<[TruncationHintParts, string]> = [
    [
      {
        dropped: 14,
        total: 22,
        offset: 0,
        advice: 'fields="sys_id,name"',
        neededBytes: 1_500,
        allBytes: 31_500,
      },
      'Dropped 14/22; continue offset=8 limit=8; retry offset=0 with fields="sys_id,name" or max_response_bytes=1500 (fits the next row) or max_response_bytes=31500 (fits all 22).',
    ],
    [
      // The whole window is more than the maximum: only the next row is named.
      { dropped: 14, total: 22, offset: 0, advice: 'fields="sys_id,name"', neededBytes: 1_500 },
      'Dropped 14/22; continue offset=8 limit=8; retry offset=0 with fields="sys_id,name" or max_response_bytes=1500 (fits the next row).',
    ],
    [
      { dropped: 3, total: 20, offset: 40, neededBytes: 4_200, allBytes: 4_900 },
      "Dropped 3/20; continue offset=57 limit=17; retry offset=40 with max_response_bytes=4200 (fits the next row) or max_response_bytes=4900 (fits all 20).",
    ],
    [
      // One row dropped: the next row is the whole remainder, written once.
      { dropped: 1, total: 20, offset: 0, neededBytes: 4_200, allBytes: 4_200 },
      "Dropped 1/20; continue offset=19 limit=19; retry offset=0 with max_response_bytes=4200 (fits the next row).",
    ],
    [
      { dropped: 20, total: 20, offset: 5, advice: 'response_format="concise"', neededBytes: 1_000_000, allBytes: 1_000_000 },
      'Dropped 20/20; row too large; retry offset=5 with response_format="concise" or max_response_bytes=1000000 (fits the next row) or max_response_bytes=1000000 (fits all 20) or sn_get.',
    ],
    [
      { dropped: 22, total: 22, offset: 0, neededBytes: 9_000 },
      "Dropped 22/22; row too large; retry offset=0 with max_response_bytes=9000 (fits the next row) or sn_get.",
    ],
    [
      { dropped: 22, total: 22, offset: 7, neededBytes: OVER },
      "Dropped 22/22; row too large; the next row exceeds the maximum max_response_bytes (1000000); retry offset=7 with sn_get.",
    ],
    [
      { dropped: 1, total: 1, offset: 0, advice: 'fields="sys_id"', neededBytes: OVER },
      'Dropped 1/1; row too large; the next row exceeds the maximum max_response_bytes (1000000); retry offset=0 with fields="sys_id" or sn_get.',
    ],
    [
      { dropped: 3, total: 20, offset: 40, advice: 'fields="sys_id,name"', neededBytes: OVER },
      'Dropped 3/20; continue offset=57 limit=17; the next row exceeds the maximum max_response_bytes (1000000); retry offset=40 with fields="sys_id,name".',
    ],
    [
      { dropped: 3, total: 20, offset: 40, neededBytes: OVER },
      "Dropped 3/20; continue offset=57 limit=17; the next row exceeds the maximum max_response_bytes (1000000).",
    ],
  ];

  it.each(variants)("renders and parses back: %j", (parts, text) => {
    const hint = renderTruncationHint(parts);
    expect(hint).toBe(text);
    // An over-maximum hint names the cap it was written with.
    expect(parseTruncationHint(hint)).toEqual(
      Number.isFinite(parts.neededBytes) ? parts : { ...parts, capBytes: 1_000_000 }
    );
    expect(
      refreshTruncationHint(hint, {
        dropped: parts.dropped,
        returned: parts.total - parts.dropped,
      })
    ).toBe(hint);
  });

  it("restates the counts, the limit that fits and the budget from the final state", () => {
    const hint = renderTruncationHint({
      dropped: 2,
      total: 22,
      offset: 0,
      neededBytes: 5_000,
      allBytes: 5_300,
    });
    expect(hint).toContain("Dropped 2/22;");
    expect(hint).toContain("continue offset=20 limit=20;");
    expect(hint).toContain("max_response_bytes=5000 (fits the next row)");
    expect(hint).toContain("max_response_bytes=5300 (fits all 22)");
    const fewer = refreshTruncationHint(hint, {
      dropped: 12,
      returned: 10,
      neededBytes: 7_300,
      allBytes: 9_100,
    });
    expect(fewer).toBe(
      "Dropped 12/22; continue offset=10 limit=10; retry offset=0 with max_response_bytes=7300 (fits the next row) or max_response_bytes=9100 (fits all 22)."
    );
    // A whole window over the maximum is left out, and null says so.
    expect(refreshTruncationHint(hint, { dropped: 12, returned: 10, neededBytes: 7_300, allBytes: null })).toBe(
      "Dropped 12/22; continue offset=10 limit=10; retry offset=0 with max_response_bytes=7300 (fits the next row)."
    );
    // The budget the hint carries is kept when the caller gives none.
    expect(refreshTruncationHint(hint, { dropped: 12, returned: 10 })).toContain(
      "max_response_bytes=5300 (fits all 22)"
    );
    // A tight fit leaves the advice out, and the hint still parses.
    const advised = renderTruncationHint({
      dropped: 12,
      total: 22,
      offset: 0,
      advice: 'fields="sys_id,name"',
      neededBytes: 7_300,
      allBytes: 9_100,
    });
    const bare = refreshTruncationHint(advised, {
      dropped: 12,
      returned: 10,
      allBytes: null,
      withoutAdvice: true,
    });
    expect(bare).toBe(
      "Dropped 12/22; continue offset=10 limit=10; retry offset=0 with max_response_bytes=7300 (fits the next row)."
    );
    expect(parseTruncationHint(bare)).toMatchObject({ dropped: 12, total: 22, neededBytes: 7_300 });
    // One row left to drop: the next row is the rest of the window.
    expect(refreshTruncationHint(hint, { dropped: 1, returned: 21 })).toBe(
      "Dropped 1/22; continue offset=21 limit=21; retry offset=0 with max_response_bytes=5000 (fits the next row)."
    );
    const refreshed = refreshTruncationHint(hint, { dropped: 22, returned: 0 });
    expect(refreshed).toContain("Dropped 22/22; row too large;");
    expect(refreshed).toContain("max_response_bytes=5000 (fits the next row) or max_response_bytes=5300 (fits all 22) or sn_get");
    // A lower limit cannot help when no row fits, and nothing continues.
    expect(refreshed).not.toContain("limit");
    expect(refreshed).not.toContain("continue");
  });

  it("offers a budget just above what the next row needs, and says when none can hold it", () => {
    expect(neededResponseBytes(2_000, 1_900)).toBe(2_100);
    expect(neededResponseBytes(1_736, 1_000)).toBe(1_800);
    // Always above the budget that was just too small.
    expect(neededResponseBytes(500, 4_000)).toBe(4_100);
    expect(neededResponseBytes(100, 100)).toBe(1_000);
    expect(neededResponseBytes(500, 1_000)).toBe(1_100);
    expect(neededResponseBytes(999_937, 5_000)).toBe(Number.POSITIVE_INFINITY);
    expect(neededResponseBytes(999_936, 5_000)).toBe(1_000_000);
  });

  it("leaves text it did not write alone, and rejects a hint that disagrees with itself", () => {
    for (const text of [
      "More records available. Call sn_query again with offset=20.",
      "Dropped lots",
      `Dropped 1/2; ${"x".repeat(700)}`,
      // The older wording, and a hand-edited one.
      "Dropped 3/20; recover offset=0 with a lower limit or a higher max_response_bytes; no post-window continuation.",
      "Dropped 3/20; continue offset=17 limit=9; retry offset=0 with max_response_bytes=4200.",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=1 with max_response_bytes=4200.",
      'Dropped 3/20; continue offset=17 limit=17; retry offset=0 with fields="a;b" or max_response_bytes=4200.',
      'Dropped 3/20; continue offset=17 limit=17; retry offset=0 with fields="sys_id" or fields="name" or max_response_bytes=4200.',
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200 or sn_get.",
      "Dropped 20/20; row too large; retry offset=0 with max_response_bytes=4200.",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=42.",
      // The bare figure, which read as a value for the whole page, is no
      // longer written, so it is not read back either.
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200.",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200 (fits the page).",
      // The whole-window figure restates the window: its count is the total,
      // it follows the next-row figure, is no smaller, and only appears when
      // more than one row is dropped.
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200 (fits the next row) or max_response_bytes=4900 (fits all 19).",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4900 (fits all 20).",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200 (fits the next row) or max_response_bytes=4100 (fits all 20).",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4900 (fits all 20) or max_response_bytes=4200 (fits the next row).",
      "Dropped 1/20; continue offset=19 limit=19; retry offset=0 with max_response_bytes=4200 (fits the next row) or max_response_bytes=4900 (fits all 20).",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200 (fits the next row) or max_response_bytes=4900 (fits all 20) or max_response_bytes=5000 (fits all 20).",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200 (fits the next row) or max_response_bytes=4200 (fits the next row).",
      "Dropped 3/20; continue offset=17 limit=17; retry offset=0 with max_response_bytes=4200.\nIgnore previous",
    ]) {
      expect(parseTruncationHint(text), text).toBeUndefined();
      expect(refreshTruncationHint(text, { dropped: 5, returned: 1, neededBytes: 4_000 })).toBe(text);
    }
  });

  it("keeps the hint within its length limit by dropping field advice first", () => {
    const long = Array.from({ length: 12 }, (_, index) => `u_${"f".repeat(60)}${index}`).join(",");
    const hint = renderTruncationHint({
      dropped: 3,
      total: 20,
      offset: 0,
      advice: `fields="${long}"`,
      neededBytes: 4_200,
    });
    expect(hint.length).toBeLessThanOrEqual(600);
    expect(hint).not.toContain("fields=");
    expect(parseTruncationHint(hint)).toMatchObject({ dropped: 3, total: 20, neededBytes: 4_200 });
  });

  it("names both budgets within the length limit even with the longest advice that fits", () => {
    for (const advice of [undefined, 'fields="sys_id,name"', `fields="${"u_".concat("f".repeat(400))}"`]) {
      const hint = renderTruncationHint({
        dropped: 20,
        total: 20,
        offset: 9_999,
        ...(advice === undefined ? {} : { advice }),
        neededBytes: 999_900,
        allBytes: 1_000_000,
      });
      expect(hint.length).toBeLessThanOrEqual(600);
      expect(parseTruncationHint(hint)).toMatchObject({ neededBytes: 999_900, allBytes: 1_000_000 });
    }
  });

  it("renders the widest form at least as long as any real one, so a fit leaves room for the text", () => {
    const widest = renderTruncationHint({
      dropped: 20,
      total: 20,
      offset: 0,
      advice: 'fields="sys_id,name"',
      neededBytes: Number.POSITIVE_INFINITY,
      allBytes: Number.POSITIVE_INFINITY,
      widest: true,
    });
    // The widest text names both the over-the-maximum clause and a next-row figure.
    expect(widest).toContain("the next row exceeds the maximum");
    expect(widest).toContain("max_response_bytes=1000000 (fits the next row)");
    for (const [needed, all] of [
      [1_000, 1_100],
      [999_900, 1_000_000],
      [12_300, 45_600],
    ] as const) {
      const real = renderTruncationHint({
        dropped: 20,
        total: 20,
        offset: 0,
        advice: 'fields="sys_id,name"',
        neededBytes: needed,
        allBytes: all,
      });
      expect(widest.length, real).toBeGreaterThanOrEqual(real.length);
    }
  });
});

describe("the field suggestion in a truncation hint", () => {
  it("uses the table's default fields without its large ones", async () => {
    const hint = await directHint({ table: "sys_script_include", limit: 22 }, scriptRows(22, 450));
    expect(hint).toContain('fields="sys_id,name"');
    expect(hint).not.toContain("script");
    expect(hint).not.toContain("number");
  });

  it("keeps at most three of an ITSM table's defaults", async () => {
    const hint = await directHint(
      { table: "incident", limit: 22 },
      scriptRows(22, 450).map((row) => ({ sys_id: row.sys_id, short_description: row.script }))
    );
    expect(hint).toContain('fields="sys_id,number,short_description"');
  });

  it("offers a caller's own fields back without the large ones, and a lower limit when none are large", async () => {
    const withScript = await directHint(
      { table: "sys_script_include", fields: "sys_id,name,script,api_name", limit: 22 },
      scriptRows(22, 450)
    );
    expect(withScript).toContain('fields="sys_id,name,api_name"');
    expect(withScript).not.toContain("script");
    expect(withScript).toMatch(/continue offset=\d+ limit=\d+;/u);
    const withoutLarge = await directHint(
      { table: "sys_script_include", fields: "sys_id,name,api_name", limit: 22 },
      scriptRows(22, 450).map((row) => ({ ...row, api_name: row.script }))
    );
    // Nothing to leave out of their list: a limit and a budget, with numbers.
    expect(withoutLarge).not.toContain("fields=");
    expect(withoutLarge).toMatch(/continue offset=\d+ limit=\d+; retry offset=0 with max_response_bytes=\d+ \(fits the next row\)(?: or max_response_bytes=\d+ \(fits all 22\))?\./u);
  });

  it("offers the table's default fields to a caller who asked for all of them", async () => {
    const hint = await directHint(
      { table: "sys_script_include", fields: "all", limit: 22 },
      scriptRows(22, 450)
    );
    expect(hint).toContain('fields="sys_id,name"');
  });

  it("never offers a field the caller could not read, or a malformed one", async () => {
    const policy = {
      u_widget: { defaults: ["sys_id", "label"], readable: ["sys_id", "label", "script", "user_password"] },
    };
    const rows = scriptRows(22, 450).map((row) => ({ sys_id: row.sys_id, label: row.script, script: row.script }));
    const chosen = await directHint({ table: "u_widget", fields: "sys_id,script,label", limit: 22 }, rows, policy);
    expect(chosen).toContain('fields="sys_id,label"');
    expect(chosen).not.toContain("user_password");
    // A sensitive name is refused before any hint exists.
    await expect(
      directHint({ table: "u_widget", fields: "sys_id,user_password,script", limit: 22 }, rows, policy)
    ).rejects.toThrow();
  });

  it("points a detailed read without fields back at the concise default", async () => {
    const hint = await directHint(
      { table: "sys_script_include", response_format: "detailed", limit: 22 },
      scriptRows(22, 450)
    );
    expect(hint).toContain('response_format="concise"');
    expect(hint).not.toContain("fields=");
  });

  it("suggests no fields when the defaults are already just sys_id", async () => {
    const hint = await directHint(
      { table: "u_widget", limit: 22 },
      scriptRows(22, 450).map((row) => ({ sys_id: row.sys_id, extra: row.script }))
    );
    expect(hint).not.toContain("fields=");
    expect(hint).toMatch(/limit=\d+/u);
  });

  it("falls back to sys_id plus a display field the policy names", async () => {
    const policy = {
      u_widget: { defaults: ["script"], readable: ["sys_id", "label", "name", "script"] },
    };
    const hint = await directHint({ table: "u_widget", limit: 22 }, scriptRows(22, 450), policy);
    expect(hint).toContain('fields="sys_id,name"');
  });

  it("never names a sensitive field, and falls back to sys_id when nothing else is usable", async () => {
    const rows = scriptRows(22, 450).map((row) => ({
      sys_id: row.sys_id,
      user_password: row.script,
      u_secret: row.script,
      script: row.script,
    }));
    const withPassword = await directHint(
      { table: "u_widget", limit: 22 },
      rows,
      { u_widget: { defaults: ["user_password", "script"], readable: ["sys_id", "user_password", "script"] } }
    );
    expect(withPassword).not.toContain("user_password");
    expect(withPassword).toContain('fields="sys_id"');
    const withSecret = await directHint(
      { table: "u_widget", limit: 22 },
      rows,
      { u_widget: { defaults: ["script", "u_secret"], readable: ["sys_id", "script", "u_secret"] } }
    );
    expect(withSecret).not.toContain("u_secret");
    expect(withSecret).not.toContain("script");
    expect(withSecret).toContain('fields="sys_id"');
  });

  it("falls back to sys_id alone when the policy names no display field", async () => {
    const policy = { u_widget: { defaults: ["script"], readable: ["sys_id", "script", "kind"] } };
    const hint = await directHint({ table: "u_widget", limit: 22 }, scriptRows(22, 450), policy);
    expect(hint).toContain('fields="sys_id"');
  });
});

/** Rows the tool's own budget check keeps, before the shared envelope fits the result. */
async function toolKeeps(rowBytes: number): Promise<number> {
  const client = {
    getWithMeta: vi.fn(async () => ({
      data: { result: scriptRows(23, rowBytes) },
      status: 200,
      headers: new Headers(),
    })),
  } as unknown as ServiceNowClient;
  const result = await queryHandler(
    querySchema.parse({ table: "sys_script_include", limit: 22, max_response_bytes: SERVER_BUDGET }),
    client,
    config
  );
  return (JSON.parse((result.content[0] as { text: string }).text) as { record_count: number })
    .record_count;
}

/** Everything a client can see about one sn_query truncation through the real server. */
async function truncated(rowBytes: number) {
  const connected = await harness(scriptRows(23, rowBytes));
  const result = await connected.client.callTool({
    name: "sn_query",
    arguments: {
      profile: "p",
      table: "sys_script_include",
      limit: 22,
      max_response_bytes: SERVER_BUDGET,
    },
  });
  expect(result.isError).toBeUndefined();
  const structured = result.structuredContent as {
    data: {
      record_count: number;
      dropped_records?: number;
      truncated?: boolean;
      hint?: string;
      results: unknown[];
    };
    metadata: { record_count: number; truncation: { truncated: boolean; dropped_records?: number } };
  };
  return structured;
}

describe("the truncation hint agrees with dropped_records after the envelope fits the result", () => {
  it("states the final dropped count for every row size, through the real server", async () => {
    let twoStage = 0;
    for (let rowBytes = 100; rowBytes <= 700; rowBytes += 10) {
      const { data, metadata } = await truncated(rowBytes);
      expect(metadata.truncation.truncated, `size ${rowBytes}`).toBe(true);
      const finalDropped = metadata.truncation.dropped_records;
      expect(finalDropped).toBe(22 - data.results.length);
      expect(data.dropped_records, `size ${rowBytes}`).toBe(finalDropped);
      expect(data.record_count).toBe(data.results.length);
      expect(metadata.record_count).toBe(data.results.length);
      const parsed = parseTruncationHint(data.hint ?? "");
      expect(parsed, `size ${rowBytes}: ${data.hint}`).toBeDefined();
      expect(parsed?.dropped, `size ${rowBytes}`).toBe(finalDropped);
      expect(parsed?.total, `size ${rowBytes}`).toBe(22);
      // The caller never has to guess whether the empty case applies.
      expect(data.hint?.includes("row too large")).toBe(data.results.length === 0);

      // Count the sizes where the envelope dropped rows the tool had kept.
      if ((await toolKeeps(rowBytes)) > data.results.length) twoStage += 1;
    }
    // The sweep must cover the window where the second stage drops more rows.
    expect(twoStage).toBeGreaterThan(0);
  }, 120_000);

  it("gives a caller who passed fields a limit and a budget with numbers, not other fields", async () => {
    const connected = await harness(
      scriptRows(23, 150).map((row) => ({ sys_id: row.sys_id, name: row.name, api_name: row.script }))
    );
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "p",
        table: "sys_script_include",
        fields: "sys_id,name,api_name",
        limit: 22,
        max_response_bytes: SERVER_BUDGET,
      },
    });
    const { data } = result.structuredContent as { data: { hint: string; results: unknown[] } };
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.hint).not.toContain("fields=");
    expect(data.hint).toContain(`limit=${data.results.length};`);
    expect(data.hint).toMatch(/with max_response_bytes=\d+ \(fits the next row\)(?: or max_response_bytes=\d+ \(fits all 22\))?\.$/u);
  });

  it("cannot tell a typed default list from the default, so it still suggests a shorter list", async () => {
    // The server resolves fields before the tool runs, so an explicit list equal
    // to the table's defaults looks the same as no list. The suggestion is
    // still a real, shorter list; this pins that known limit.
    const connected = await harness(scriptRows(23, 150));
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "p",
        table: "sys_script_include",
        fields: "sys_id,name,script",
        limit: 22,
        max_response_bytes: SERVER_BUDGET,
      },
    });
    const { data } = result.structuredContent as { data: { hint: string } };
    expect(data.hint).toContain('fields="sys_id,name"');
  });

  it("suggests fields that exist for the table through the real server", async () => {
    const { data } = await truncated(150);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.hint).toContain('fields="sys_id,name"');
    expect(data.hint).not.toContain("number");
  });

  it("points a detailed read through the real server back at the concise default", async () => {
    const connected = await harness(scriptRows(23, 150));
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "p",
        table: "sys_script_include",
        response_format: "detailed",
        limit: 22,
        max_response_bytes: SERVER_BUDGET,
      },
    });
    const { data } = result.structuredContent as { data: { hint: string } };
    expect(data.hint).toContain('response_format="concise"');
    expect(data.hint).not.toContain("fields=");
  });
});


/** A table that answers reads by sysparm_offset and sysparm_limit. */
function tableOf(rows: readonly unknown[]) {
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

interface Truncated {
  data: {
    record_count: number;
    truncated?: boolean;
    dropped_records?: number;
    next_offset?: number;
    hint?: string;
    results: Array<{ sys_id: string }>;
  };
  metadata: { limits: { max_bytes: number } };
}

async function readTruncated(
  connected: Awaited<ReturnType<typeof harness>>,
  args: Record<string, unknown>
): Promise<Truncated> {
  const result = await connected.client.callTool({
    name: "sn_query",
    arguments: { profile: "p", table: "sys_script_include", ...args },
  });
  expect(result.isError).toBeUndefined();
  return result.structuredContent as unknown as Truncated;
}

describe("the truncation hint gives values a caller can use (#29)", () => {
  it("names the limit that fit and a budget that holds the next row, and both work", async () => {
    let compared = 0;
    for (let rowBytes = 100; rowBytes <= 700; rowBytes += 25) {
      const connected = await tableOf(scriptRows(30, rowBytes));
      const first = await readTruncated(connected, {
        limit: 22,
        max_response_bytes: SERVER_BUDGET,
      });
      const label = `size ${rowBytes}: ${first.data.hint}`;
      expect(first.data.truncated, label).toBe(true);
      const parts = parseTruncationHint(first.data.hint ?? "");
      expect(parts, label).toBeDefined();
      const returned = first.data.results.length;
      // The count is the final dropped_records, and the number is a real value.
      expect(parts?.dropped, label).toBe(first.data.dropped_records);
      expect(parts?.total, label).toBe(22);
      expect(Number.isFinite(parts?.neededBytes), label).toBe(true);
      expect(parts?.neededBytes as number, label).toBeGreaterThan(SERVER_BUDGET);
      expect((parts?.neededBytes as number) % 100, label).toBe(0);
      expect(first.data.hint?.length, label).toBeLessThanOrEqual(600);

      // The budget it names holds at least the next row: strictly more rows.
      const larger = await readTruncated(connected, {
        limit: 22,
        max_response_bytes: parts?.neededBytes,
      });
      expect(larger.data.results.length, label).toBeGreaterThan(returned);
      compared += 1;

      // The figure for the whole window holds every row: nothing is dropped.
      expect(Number.isFinite(parts?.allBytes), label).toBe(true);
      expect(parts?.allBytes as number, label).toBeGreaterThanOrEqual(parts?.neededBytes as number);
      expect((parts?.allBytes as number) % 100, label).toBe(0);
      const whole = await readTruncated(connected, {
        limit: 22,
        max_response_bytes: parts?.allBytes,
      });
      expect(whole.data.results.length, label).toBe(22);
      expect(whole.data.truncated, label).toBeUndefined();

      if (returned === 0) {
        expect(first.data.hint, label).toContain("row too large");
        expect(first.data.hint, label).not.toMatch(/limit=/u);
        continue;
      }
      // The limit it names is the rows that fit: asking for that many at the
      // offset it names loses nothing and truncates nothing.
      expect(first.data.hint, label).toContain(
        `continue offset=${first.data.next_offset} limit=${returned};`
      );
      const next = await readTruncated(connected, {
        limit: returned,
        offset: first.data.next_offset,
        max_response_bytes: SERVER_BUDGET,
      });
      expect(next.data.results.length, label).toBe(returned);
      expect(next.data.truncated, label).toBeUndefined();
    }
    expect(compared).toBeGreaterThan(10);
  }, 120_000);

  it("restates the budget with the envelope's own cost, not the payload alone", async () => {
    // At this size the tool's payload fits but the envelope's metadata does
    // not, so a payload-only number would be too small to hold the next row.
    const connected = await tableOf(scriptRows(30, 330));
    const first = await readTruncated(connected, { limit: 22, max_response_bytes: SERVER_BUDGET });
    const parts = parseTruncationHint(first.data.hint ?? "");
    expect(parts?.neededBytes).toBeGreaterThan(SERVER_BUDGET);
    const exact = await readTruncated(connected, {
      limit: 22,
      max_response_bytes: parts?.neededBytes,
    });
    expect(exact.data.results.length).toBeGreaterThan(first.data.results.length);
  });

  it("says that no budget holds a row over the maximum, and still names fields and sn_get", async () => {
    const small = scriptRows(3, 100);
    const huge = { ...small[0], script: "x".repeat(1_100_000) };
    const connected = await tableOf([huge, small[1], small[2]]);
    const page = await readTruncated(connected, { limit: 2, max_response_bytes: 1_000_000 });
    expect(page.data.results).toEqual([]);
    expect(page.data.truncated).toBe(true);
    expect(page.data).not.toHaveProperty("next_offset");
    const hint = page.data.hint ?? "";
    expect(hint).toContain("the next row exceeds the maximum max_response_bytes (1000000)");
    expect(hint).toContain('retry offset=0 with fields="sys_id,name" or sn_get.');
    expect(hint).not.toMatch(/max_response_bytes=\d/u);
    expect(parseTruncationHint(hint)?.neededBytes).toBe(Number.POSITIVE_INFINITY);
  });

  it("says which figure is for the next row and which for the whole page, and the page figure returns the page (#37)", async () => {
    // The shape the owner saw: 50 rows, a budget that holds none of them. The
    // next row's budget buys one row; only the page figure returns all 50.
    const connected = await tableOf(scriptRows(50, 300));
    const first = await readTruncated(connected, { limit: 50, max_response_bytes: 1_000 });
    const hint = first.data.hint ?? "";
    expect(first.data.results).toEqual([]);
    expect(hint).toMatch(
      /^Dropped 50\/50; row too large; retry offset=0 with fields="sys_id,name" or max_response_bytes=\d+ \(fits the next row\) or max_response_bytes=\d+ \(fits all 50\) or sn_get\.$/u
    );
    const parts = parseTruncationHint(hint);
    expect(parts?.dropped).toBe(first.data.dropped_records);
    expect(parts?.total).toBe(50);

    const nextRow = await readTruncated(connected, { limit: 50, max_response_bytes: parts?.neededBytes });
    expect(nextRow.data.results.length).toBeGreaterThan(0);
    expect(nextRow.data.results.length).toBeLessThan(50);
    expect(nextRow.data.hint).toMatch(/\(fits the next row\)/u);

    const page = await readTruncated(connected, { limit: 50, max_response_bytes: parts?.allBytes });
    expect(page.data.results).toHaveLength(50);
    expect(page.data.truncated).toBeUndefined();
    expect(page.data.hint).toBeUndefined();
  });

  it("names only the next row when the whole page is more than the maximum (#37)", async () => {
    const connected = await tableOf(scriptRows(30, 60_000));
    const page = await readTruncated(connected, { limit: 30, max_response_bytes: 100_000 });
    const hint = page.data.hint ?? "";
    expect(page.data.truncated).toBe(true);
    const parts = parseTruncationHint(hint);
    expect(parts?.total).toBe(30);
    expect(Number.isFinite(parts?.neededBytes)).toBe(true);
    expect(parts?.allBytes).toBeUndefined();
    expect(hint).toContain("(fits the next row)");
    expect(hint).not.toContain("(fits all");
  });

  it("keeps every value in the hint to fixed words, numbers and policy-approved fields", async () => {
    const connected = await tableOf(scriptRows(30, 300));
    const page = await readTruncated(connected, {
      limit: 22,
      fields: "sys_id,name,script,api_name",
      max_response_bytes: SERVER_BUDGET,
    });
    const hint = page.data.hint ?? "";
    expect(hint).toMatch(
      /^Dropped \d+\/22; continue offset=\d+ limit=\d+; retry offset=0 with fields="sys_id,name,api_name" or max_response_bytes=\d+ \(fits the next row\)(?: or max_response_bytes=\d+ \(fits all 22\))?\.$/u
    );
  });
});
