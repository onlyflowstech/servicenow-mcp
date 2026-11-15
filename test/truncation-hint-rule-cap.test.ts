/**
 * A raw-read rule can hold `max_response_bytes` below the schema maximum. The
 * truncation hint must never offer a value the policy would then deny: it is
 * capped at the rule's `maxResponseBytes`, and past it the hint says the next
 * row exceeds that maximum and names it.
 */
import { afterEach, describe, expect, it } from "vitest";

import { SUPPORTED_ENCODED_QUERY_OPERATORS } from "../src/encoded-query-policy.js";
import { enrichSuccessfulResult } from "../src/tools/index.js";
import {
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
} from "../src/tools/result-envelope.js";
import {
  neededResponseBytes,
  parseTruncationHint,
  renderTruncationHint,
} from "../src/tools/truncation-hint.js";
import { closeHarnesses, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

const CAP = 5000;

const RULE = {
  tool: "sn_query",
  table: "sys_script_include",
  maxLength: 512,
  maxTerms: 8,
  fields: ["sys_id", "name", "script"],
  operators: SUPPORTED_ENCODED_QUERY_OPERATORS,
  maxLimit: 100,
  maxOffset: 1_000,
  maxResponseBytes: CAP,
};

function rows(count: number, size: number) {
  return Array.from({ length: count }, (_, index) => ({
    sys_id: index.toString(16).padStart(32, "0"),
    name: `Include${String(index).padStart(2, "0")}`,
    script: "x".repeat(Math.max(1, size - 90)),
  }));
}

async function rawRead(
  data: unknown[],
  args: Record<string, unknown>,
  rule: Record<string, unknown> = RULE
) {
  const connected = await harness(data, { encodedQueryAccess: { rules: [rule] } });
  const call = (extra: Record<string, unknown>) =>
    connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "p",
        table: "sys_script_include",
        query: "nameSTARTSWITHInclude",
        ...extra,
      },
    });
  return { call, first: await call(args) };
}

function hintOf(result: Awaited<ReturnType<typeof rawRead>>["first"]): {
  hint: string;
  count: number;
} {
  expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
  const data = (result.structuredContent as { data: { hint: string; results: unknown[] } }).data;
  return { hint: data.hint, count: data.results.length };
}

/** Every byte value a hint names. */
function named(hint: string): number[] {
  return [...hint.matchAll(/max_response_bytes[= ]\(?(\d+)/gu)].map((match) => Number(match[1]));
}

describe("the hint stays within a raw-read rule's byte cap", () => {
  it("caps the budget the neededResponseBytes arithmetic offers", () => {
    expect(neededResponseBytes(4_000, 3_000, CAP)).toBe(4_100);
    // Rounding up never passes the cap when the value itself fits.
    expect(neededResponseBytes(4_960, 3_000, 5_050)).toBe(5_050);
    expect(neededResponseBytes(4_940, 3_000, CAP)).toBe(Number.POSITIVE_INFINITY);
    expect(neededResponseBytes(500, 5_000, CAP)).toBe(Number.POSITIVE_INFINITY);
    expect(neededResponseBytes(4_940, 3_000)).toBe(5_100);
  });

  it("renders and parses the over-maximum clause with its cap", () => {
    const text = renderTruncationHint({
      dropped: 3,
      total: 20,
      offset: 40,
      neededBytes: Number.POSITIVE_INFINITY,
      capBytes: CAP,
    });
    expect(text).toBe(
      "Dropped 3/20; continue offset=57 limit=17; the next row exceeds the maximum max_response_bytes (5000)."
    );
    expect(parseTruncationHint(text)).toEqual({
      dropped: 3,
      total: 20,
      offset: 40,
      neededBytes: Number.POSITIVE_INFINITY,
      capBytes: CAP,
    });
    // Values the schema cannot take are not hints this code wrote.
    for (const bad of [
      "Dropped 3/20; continue offset=57 limit=17; the next row exceeds the maximum max_response_bytes (1000001).",
      "Dropped 3/20; continue offset=57 limit=17; the next row exceeds the maximum max_response_bytes (999).",
      "Dropped 3/20; continue offset=57 limit=17; retry offset=40 with max_response_bytes=1000001.",
      "Dropped 3/20; continue offset=57 limit=17; retry offset=40 with max_response_bytes=9999999.",
    ]) {
      expect(parseTruncationHint(bad), bad).toBeUndefined();
    }
  });

  it("names no value above the cap when the tool cuts, and what it names is allowed", async () => {
    let finite = 0;
    let over = 0;
    for (const budget of [3_000, CAP]) {
      for (let size = 600; size <= 2_600; size += 100) {
        const { call, first } = await rawRead(rows(12, size), { limit: 12, max_response_bytes: budget });
        const { hint, count } = hintOf(first);
        const label = `budget ${budget} size ${size}: ${hint}`;
        expect(Math.max(0, ...named(hint)), label).toBeLessThanOrEqual(CAP);
        const parts = parseTruncationHint(hint);
        expect(parts, label).toBeDefined();
        if (Number.isFinite(parts?.neededBytes)) {
          finite += 1;
          // The policy accepts the value, and it holds more rows.
          const again = hintOf(await call({ limit: 12, max_response_bytes: parts?.neededBytes }));
          expect(again.count, label).toBeGreaterThan(count);
        } else {
          over += 1;
          expect(hint, label).toContain("the next row exceeds the maximum max_response_bytes (5000)");
          expect(hint, label).not.toMatch(/max_response_bytes=\d/u);
        }
      }
    }
    // The sweep covers both a value that fits under the cap and one that does not.
    expect(finite).toBeGreaterThan(0);
    expect(over).toBeGreaterThan(0);
  });

  it("names the whole window only while it fits under the cap, and the next row alone otherwise", async () => {
    let both = 0;
    let nextOnly = 0;
    for (let size = 300; size <= 2_600; size += 100) {
      const { call, first } = await rawRead(rows(12, size), { limit: 12, max_response_bytes: 3_000 });
      const { hint } = hintOf(first);
      const parts = parseTruncationHint(hint);
      const label = `size ${size}: ${hint}`;
      if (!Number.isFinite(parts?.neededBytes)) continue;
      if (parts?.dropped === 1) continue; // one figure, whichever name it has
      if (parts?.allBytes === undefined) {
        nextOnly += 1;
        expect(hint, label).toContain("(fits the next row)");
        expect(hint, label).not.toContain("(fits all");
        continue;
      }
      both += 1;
      expect(parts.allBytes, label).toBeLessThanOrEqual(CAP);
      // The policy accepts it, and it holds every row of the window.
      const whole = hintOf(await call({ limit: 12, max_response_bytes: parts.allBytes }));
      expect(whole.count, label).toBe(12);
    }
    // The sweep covers a whole window that fits under the cap and one that does not.
    expect(both).toBeGreaterThan(0);
    expect(nextOnly).toBeGreaterThan(0);
  });

  it("decides whether the advice fits from the widest text, so the sizing probe is never shorter than the real hint", () => {
    const names = (length: number) =>
      Array.from({ length: 11 }, (_, i) => `u_${String(i).padStart(2, "0")}_${"f".repeat(60)}`.slice(0, length));
    const adviceOf = (nameLength: number | undefined) =>
      nameLength === undefined ? undefined : `fields="${names(nameLength).join(",")}"`;
    let compared = 0;
    for (const nameLength of [undefined, 3, 30, 33, 36, 38, 40, 42, 44, 46]) {
      const advice = adviceOf(nameLength);
      // The windows a hint can describe: rows returned, one row dropped, none returned.
      for (const [dropped, total] of [[20, 22], [1, 22], [22, 22], [1, 1], [5, 5], [999, 1_000]] as const) {
        // The forms a fit uses, and a real over-the-maximum hint.
        for (const real of [
          { neededBytes: 4_900, allBytes: 5_000 },
          { neededBytes: 1_000, allBytes: 1_100 },
          { neededBytes: 999_900, allBytes: 1_000_000 },
          { neededBytes: 4_900 },
          { neededBytes: Number.POSITIVE_INFINITY },
        ]) {
          for (const withoutAdvice of [false, true]) {
            const base = {
              dropped,
              total,
              offset: 9_999,
              ...(advice === undefined || withoutAdvice ? {} : { advice }),
              capBytes: CAP,
              ...real,
            };
            const hint = renderTruncationHint(base);
            // What the fit renders as this form's probe: the same parts, widest.
            const widest = renderTruncationHint({
              ...base,
              widest: true,
              neededBytes: Number.POSITIVE_INFINITY,
              ...("allBytes" in real ? { allBytes: Number.POSITIVE_INFINITY } : {}),
            });
            const label = `advice ${advice?.length} ${dropped}/${total} ${JSON.stringify(real)} withoutAdvice ${withoutAdvice}: ${hint.length} against widest ${widest.length}`;
            expect(widest.length, label).toBeGreaterThanOrEqual(hint.length);
            expect(hint.length, label).toBeLessThanOrEqual(600);
            // The same choice for both: the advice is in both or in neither.
            expect(hint.includes("fields="), label).toBe(widest.includes("fields="));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("never names a value above the cap, or says exceeds beside a fits-all figure, with about 440 characters of advice (security R1)", async () => {
    const names = Array.from({ length: 11 }, (_, i) => `u_${String(i).padStart(2, "0")}_${"f".repeat(60)}`.slice(0, 38));
    const rule = { ...RULE, fields: ["sys_id", "name", "script", ...names] };
    const fields = ["script", ...names].join(",");
    let hints = 0;
    let withAdvice = 0;
    for (let size = 150; size <= 1_500; size += 10) {
      const data = Array.from({ length: 12 }, (_, i) => ({
        sys_id: i.toString(16).padStart(32, "0"),
        script: "x".repeat(size),
        ...Object.fromEntries(names.map((name) => [name, "v"])),
      }));
      const { first } = await rawRead(data, { fields, limit: 12, max_response_bytes: CAP }, rule);
      if (first.isError) continue;
      const hint = (first.structuredContent as { data: { hint?: string } }).data.hint;
      if (typeof hint !== "string") continue;
      hints += 1;
      if (hint.includes('fields="')) withAdvice += 1;
      const label = `size ${size}: ${hint.replace(/fields="[^"]*"/u, 'fields="..."')}`;
      expect(Math.max(0, ...named(hint)), label).toBeLessThanOrEqual(CAP);
      expect(hint.includes("exceeds the maximum") && hint.includes("fits all"), label).toBe(false);
      expect(parseTruncationHint(hint), label).toBeDefined();
    }
    expect(hints).toBeGreaterThan(20);
    // The advice is about 437 characters: with both figures it does not fit
    // the 600 limit in the widest form, so it is left out everywhere.
    expect(withAdvice).toBe(0);
  });

  it("is still offered up to the schema maximum when no rule caps the call", async () => {
    const wide = { ...RULE, maxResponseBytes: 100_000 };
    const { first } = await rawRead(rows(12, 2_400), { limit: 12, max_response_bytes: CAP }, wide);
    const { hint } = hintOf(first);
    expect(Math.max(...named(hint))).toBeGreaterThan(CAP);
    expect(hint).not.toContain("exceeds the maximum");
  });
});

describe("the envelope's refit honours the same cap", () => {
  const profile = "p";
  function fit(
    data: unknown,
    args: Record<string, unknown>,
    options: { maxResponseBytesCap?: number }
  ) {
    const adapted = envelopeCompatibilityResult("sn_query", args, {
      content: [{ type: "text", text: JSON.stringify(data) }],
    });
    const result = finalizeEnvelopeResult(
      enrichSuccessfulResult(adapted, profile),
      "sn_query",
      options
    );
    expect(result).toBeDefined();
    return (result as { structuredContent: { data: { hint: string; results: unknown[] } } })
      .structuredContent.data;
  }

  function toolOutput(count: number, size: number, neededBytes: number) {
    const kept = rows(count, size);
    return {
      record_count: count,
      has_more: true,
      next_offset: count,
      truncated: true,
      dropped_records: 3,
      hint: renderTruncationHint({
        dropped: 3,
        total: count + 3,
        offset: 0,
        neededBytes,
        capBytes: CAP,
      }),
      results: kept,
    };
  }

  it("when the envelope drops more rows, and the next row would not fit under the cap", () => {
    // 7 rows of 700 bytes cannot fit a 5000-byte result: the envelope drops some.
    const data = fit(toolOutput(7, 700, 4_900), { limit: 10, max_response_bytes: CAP }, { maxResponseBytesCap: CAP });
    expect(data.results.length).toBeLessThan(7);
    expect(Math.max(0, ...named(data.hint))).toBeLessThanOrEqual(CAP);
    const parts = parseTruncationHint(data.hint);
    expect(parts).toBeDefined();
    const uncapped = fit(toolOutput(7, 700, 4_900), { limit: 10, max_response_bytes: CAP }, {});
    // Without a rule cap the same refit would offer a budget above 5000.
    expect(Math.max(...named(uncapped.hint))).toBeGreaterThan(CAP);
  });

  it("when the result fits and only the envelope's own cost pushes the number past the cap", () => {
    const data = fit(toolOutput(2, 300, 4_300), { limit: 10, max_response_bytes: CAP }, { maxResponseBytesCap: CAP });
    expect(data.results).toHaveLength(2);
    expect(data.hint).toContain("the next row exceeds the maximum max_response_bytes (5000)");
    expect(Math.max(0, ...named(data.hint))).toBeLessThanOrEqual(CAP);
    const uncapped = fit(toolOutput(2, 300, 4_300), { limit: 10, max_response_bytes: CAP }, {});
    expect(Math.max(...named(uncapped.hint))).toBeGreaterThan(CAP);
  });
});
