import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { runWithFieldPolicyConfiguration } from "../src/field-policy.js";
import { handler as queryHandler, schema as querySchema } from "../src/tools/query.js";
import {
  LOWER_LIMIT_ADVICE,
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
  const variants: TruncationHintParts[] = [
    { dropped: 3, total: 20, offset: 0, advice: 'fields="sys_id,name"', resume: { offset: 20, limit: 20 } },
    { dropped: 3, total: 20, offset: 40, advice: LOWER_LIMIT_ADVICE },
    { dropped: 20, total: 20, offset: 5, advice: 'response_format="concise"', resume: { offset: 25, limit: 20 } },
    { dropped: 1, total: 1, offset: 0, advice: LOWER_LIMIT_ADVICE },
    { dropped: 22, total: 22, offset: 0, advice: 'fields="sys_id"' },
  ];

  it.each(variants)("parses back what it renders: %j", (parts) => {
    const hint = renderTruncationHint(parts);
    expect(parseTruncationHint(hint)).toEqual(parts);
    expect(
      refreshTruncationHint(hint, {
        dropped: parts.dropped,
        returned: parts.total - parts.dropped,
        ...(parts.resume === undefined ? {} : { resume: parts.resume }),
      })
    ).toBe(hint);
  });

  it("restates the counts, the empty case and the continuation from the final state", () => {
    const hint = renderTruncationHint({
      dropped: 2,
      total: 22,
      offset: 0,
      advice: LOWER_LIMIT_ADVICE,
      resume: { offset: 22, limit: 22 },
    });
    expect(hint).toContain("Dropped 2/22;");
    expect(hint).toContain("a lower limit or a higher max_response_bytes");
    const refreshed = refreshTruncationHint(hint, { dropped: 22, returned: 0 });
    expect(refreshed).toContain("Dropped 22/22; row too large;");
    expect(refreshed).toContain(", or sn_get");
    // A lower limit cannot help when no row fits.
    expect(refreshed).not.toContain("lower limit");
    expect(refreshed).toContain("no post-window continuation");
    expect(refreshed).not.toContain("resume");
  });

  it("leaves text it did not write alone", () => {
    for (const text of [
      "More records available. Call sn_query again with offset=20.",
      "Dropped lots",
      `Dropped 1/2; ${"x".repeat(700)}`,
    ]) {
      expect(refreshTruncationHint(text, { dropped: 5, returned: 1 })).toBe(text);
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

  it("does not suggest fields to a caller who passed fields, including all", async () => {
    for (const fields of ["sys_id,name,api_name", "all"]) {
      const hint = await directHint(
        { table: "sys_script_include", fields, limit: 22 },
        scriptRows(22, 450)
      );
      expect(hint, fields).not.toContain("fields=");
      expect(hint, fields).toContain("a lower limit or a higher max_response_bytes");
    }
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
    expect(hint).toContain("a lower limit");
  });

  it("falls back to sys_id plus a display field the policy names", async () => {
    const policy = {
      u_widget: { defaults: ["script"], readable: ["sys_id", "label", "name", "script"] },
    };
    const hint = await directHint({ table: "u_widget", limit: 22 }, scriptRows(22, 450), policy);
    expect(hint).toContain('fields="sys_id,name"');
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
  });

  it("tells a caller who passed fields to lower the limit, not which fields to use", async () => {
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
    expect(data.hint).toContain("a lower limit or a higher max_response_bytes");
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
