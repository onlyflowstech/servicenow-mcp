/**
 * The smallest budgets, where the shared envelope's own metadata leaves room
 * for little beside the counts. The labelled truncation hint (#37) is longer
 * than the bare one was; at 1000 bytes with a wide row, no row fitted beside
 * it and the call failed as an internal error. A truncated read must always
 * come back as a normal truncated result, whatever the budget.
 */
import { afterEach, describe, expect, it } from "vitest";

import { SUPPORTED_ENCODED_QUERY_OPERATORS } from "../src/encoded-query-policy.js";
import { parseTruncationHint } from "../src/tools/truncation-hint.js";
import { closeHarnesses, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

const CAP = 5_000;
const SCHEMA_MAX = 1_000_000;

/** The owner's black-box step 5: eight fields, one of them a long description. */
const OWNER_FIELDS = [
  "sys_id",
  "name",
  "api_name",
  "active",
  "client_callable",
  "sys_scope",
  "sys_updated_on",
  "description",
];
/** Twelve readable fields of sys_script_include, the long one second. */
const SWEEP_FIELDS = [
  "sys_id",
  "description",
  "name",
  "api_name",
  "active",
  "client_callable",
  "sys_scope",
  "sys_updated_on",
  "access",
  "caller_access",
  "mobile_callable",
  "sandbox_callable",
];

function rowsFor(fields: readonly string[], count: number) {
  return Array.from({ length: count }, (_, index) => {
    const row: Record<string, string> = {};
    for (const field of fields) {
      row[field] =
        field === "sys_id"
          ? index.toString(16).padStart(32, "0")
          : field === "description"
            ? "secret-description-text ".repeat(13)
            : field === "sys_updated_on"
              ? "2026-11-01 12:00:00"
              : `v${index}`;
    }
    return row;
  });
}

function rule(fields: readonly string[]) {
  return {
    tool: "sn_query",
    table: "sys_script_include",
    maxLength: 512,
    maxTerms: 8,
    fields: [...new Set(["sys_id", "name", "script", ...fields])],
    operators: SUPPORTED_ENCODED_QUERY_OPERATORS,
    maxLimit: 100,
    maxOffset: 1_000,
    maxResponseBytes: CAP,
  };
}

interface Structured {
  data: {
    record_count: number;
    has_more?: boolean;
    next_offset?: number;
    truncated?: boolean;
    dropped_records?: number;
    hint?: string;
    results: unknown[];
  };
  metadata: {
    truncation: { truncated: boolean; dropped_records?: number };
    pagination: { has_more?: boolean; next_offset?: number; recovery?: string };
  };
}

/** What every truncated hint must satisfy, whatever the budget. */
function checkHint(structured: Structured, effectiveCap: number, label: string): void {
  const { data } = structured;
  if (data.truncated !== true) return;
  const hint = data.hint ?? "";
  expect(hint.length, label).toBeLessThanOrEqual(600);
  const parts = parseTruncationHint(hint);
  expect(parts, `${label}: ${hint}`).toBeDefined();
  // The count in the hint is the final dropped count.
  expect(parts?.dropped, label).toBe(data.dropped_records);
  expect(parts?.dropped, label).toBe(structured.metadata.truncation.dropped_records);
  expect(parts?.total, label).toBe(data.record_count + (data.dropped_records ?? 0));
  // Every figure it names is one the schema, and the rule, would accept.
  const named = [...hint.matchAll(/max_response_bytes[= ]\(?(\d+)/gu)].map((match) => Number(match[1]));
  expect(Math.max(0, ...named), `${label}: ${hint}`).toBeLessThanOrEqual(effectiveCap);
  // A hint that says the next row cannot fit never also names a page that does.
  expect(hint.includes("exceeds the maximum") && hint.includes("fits all"), `${label}: ${hint}`).toBe(false);
  // No row content is repeated, whatever the form.
  expect(hint, label).not.toContain("secret-description-text");
  if (data.record_count === 0) {
    expect(data.has_more, label).toBe(true);
    expect(data, label).not.toHaveProperty("next_offset");
    expect(structured.metadata.pagination.has_more, label).toBe(true);
    expect(structured.metadata.pagination.next_offset, label).toBeUndefined();
    expect(structured.metadata.pagination.recovery, label).toBeDefined();
  }
}

/**
 * 1000 to 1300 in steps of 10 (where the hint's forms change, and the owner's
 * step 5 and the 1000-byte minimum sit), then on to 3000 in steps of 200.
 */
const BUDGETS: number[] = [];
for (let budget = 1_000; budget <= 1_300; budget += 10) BUDGETS.push(budget);
for (let budget = 1_400; budget <= 3_000; budget += 200) BUDGETS.push(budget);

describe("a truncated read at the smallest budgets (regression in 77448fa, #37)", () => {
  it("returns a normal truncated result for the owner's step 5 call", async () => {
    const connected = await harness(rowsFor(OWNER_FIELDS, 22));
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "p",
        table: "sys_script_include",
        fields: OWNER_FIELDS.join(","),
        limit: 50,
        max_response_bytes: 1_000,
      },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    const structured = result.structuredContent as unknown as Structured;
    expect(structured.data.truncated).toBe(true);
    expect(structured.data.record_count).toBe(0);
    expect(structured.data.dropped_records).toBe(22);
    expect(structured.data.has_more).toBe(true);
    expect(structured.data).not.toHaveProperty("next_offset");
    expect(structured.metadata.pagination.recovery).toBeDefined();
    expect(structured.metadata.truncation).toMatchObject({ truncated: true, dropped_records: 22 });
    const hint = structured.data.hint ?? "";
    expect(hint).toMatch(/^Dropped 22\/22; row too large; retry offset=0 with /u);
    expect(hint).toContain("(fits the next row)");
    checkHint(structured, SCHEMA_MAX, "owner step 5");

    // The budget it names holds at least one row.
    const named = parseTruncationHint(hint)?.neededBytes as number;
    const retry = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "p",
        table: "sys_script_include",
        fields: OWNER_FIELDS.join(","),
        limit: 50,
        max_response_bytes: named,
      },
    });
    expect(retry.isError).toBeUndefined();
    expect((retry.structuredContent as unknown as Structured).data.results.length).toBeGreaterThan(0);
  });

  it("never throws or returns an internal error, from 1000 to 3000 bytes, with and without a rule cap", async () => {
    let calls = 0;
    let truncatedCalls = 0;
    let emptyCalls = 0;
    for (const capped of [false, true]) {
      for (const fieldCount of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        const fields = SWEEP_FIELDS.slice(0, fieldCount);
        for (const limit of [1, 5, 22, 50]) {
          const connected = await harness(
            rowsFor(fields, Math.min(limit, 22)),
            capped ? { encodedQueryAccess: { rules: [rule(fields)] } } : {}
          );
          for (const budget of BUDGETS) {
            const label = `${capped ? "capped" : "uncapped"} fields ${fieldCount} limit ${limit} budget ${budget}`;
            const result = await connected.client.callTool({
              name: "sn_query",
              arguments: {
                profile: "p",
                table: "sys_script_include",
                ...(capped ? { query: "nameSTARTSWITHalpha" } : {}),
                fields: fields.join(","),
                limit,
                max_response_bytes: budget,
              },
            });
            calls += 1;
            expect(result.isError, `${label}: ${JSON.stringify(result.content)}`).toBeUndefined();
            const structured = result.structuredContent as unknown as Structured;
            if (structured.data.truncated === true) {
              truncatedCalls += 1;
              if (structured.data.record_count === 0) emptyCalls += 1;
              // The rows here are a few hundred bytes, so the next row always
              // fits under both caps: the hint never says it cannot, and always
              // names the budget for it (never a sizing probe's text).
              const hint = structured.data.hint ?? "";
              expect(hint, `${label}: ${hint}`).not.toContain("exceeds the maximum");
              expect(hint, `${label}: ${hint}`).toContain("(fits the next row)");
              // Spot-check that the figure holds a row, where the rows are
              // returned most tightly.
              if (budget % 50 === 0) {
                const named = parseTruncationHint(hint)?.neededBytes as number;
                const again = await connected.client.callTool({
                  name: "sn_query",
                  arguments: {
                    profile: "p",
                    table: "sys_script_include",
                    ...(capped ? { query: "nameSTARTSWITHalpha" } : {}),
                    fields: fields.join(","),
                    limit,
                    max_response_bytes: named,
                  },
                });
                const retried = again.structuredContent as unknown as Structured;
                expect(again.isError, `${label}: retry ${named}`).toBeUndefined();
                expect(retried.data.record_count, `${label}: retry ${named}`).toBeGreaterThan(
                  structured.data.record_count
                );
              }
            }
            checkHint(structured, capped ? CAP : SCHEMA_MAX, label);
          }
        }
      }
    }
    expect(calls).toBe(2 * 12 * 4 * BUDGETS.length);
    // The sweep reaches the case that failed, and the ones around it.
    expect(truncatedCalls).toBeGreaterThan(500);
    expect(emptyCalls).toBeGreaterThan(100);
  }, 120_000);
});
