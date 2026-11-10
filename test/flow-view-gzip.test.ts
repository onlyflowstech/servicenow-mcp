import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { FLOW_VIEW_LIMITS } from "../src/tools/flow-view-contracts.js";
import {
  createDecompressionBudget,
  decodeCompressedJson,
  parseBoundedJson,
  type DecompressionBudget,
} from "../src/tools/flow-view-gzip.js";

const BLOBS = JSON.parse(
  readFileSync(new URL("./fixtures/flow-view/table/adversarial/blobs.json", import.meta.url), "utf8")
) as Record<string, string>;

const L = FLOW_VIEW_LIMITS;

function blob(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");
}

function fresh(): DecompressionBudget {
  return createDecompressionBudget();
}

describe("decodeCompressedJson", () => {
  it("decodes a gzip+base64 JSON blob and charges the budget its output size", () => {
    const value = [{ name: "short_description", value: "Synthetic" }];
    const budget = fresh();
    expect(decodeCompressedJson(blob(value), budget)).toEqual({ ok: true, value });
    expect(budget.remainingBytes).toBe(
      L.MAX_GZIP_OUTPUT_BYTES_PER_LOAD - Buffer.byteLength(JSON.stringify(value))
    );
  });

  it("unwraps one Table API {value, display_value} cell", () => {
    const encoded = blob({ inputs: [] });
    expect(decodeCompressedJson({ value: encoded, display_value: encoded }, fresh())).toEqual({
      ok: true,
      value: { inputs: [] },
    });
    expect(decodeCompressedJson({ display_value: encoded }, fresh())).toEqual({
      ok: false,
      reason: "not_compressed",
    });
  });

  it("starts with a fresh per-load budget", () => {
    expect(createDecompressionBudget()).toEqual({ remainingBytes: L.MAX_GZIP_OUTPUT_BYTES_PER_LOAD });
    expect(createDecompressionBudget()).not.toBe(createDecompressionBudget());
  });

  it("rejects anything that is not a gzip+base64 string as not_compressed", () => {
    for (const value of [
      undefined,
      null,
      42,
      true,
      ["H4sI"],
      "",
      BLOBS.not_gzip_base64_json,
      BLOBS.not_gzip_plain_json,
    ]) {
      expect(decodeCompressedJson(value, fresh()), JSON.stringify(value)).toEqual({
        ok: false,
        reason: "not_compressed",
      });
    }
  });

  it("rejects an H4sI prefix with a bad base64 body as invalid_base64", () => {
    for (const key of ["invalid_base64_alphabet", "invalid_base64_padding", "invalid_base64_whitespace"]) {
      expect(decodeCompressedJson(BLOBS[key], fresh()), key).toEqual({ ok: false, reason: "invalid_base64" });
    }
    // Unpadded base64 (length not a multiple of 4).
    expect(decodeCompressedJson(blob([1]).replace(/=+$/u, "").slice(0, -1), fresh())).toEqual({
      ok: false,
      reason: "invalid_base64",
    });
  });

  it("rejects an oversized base64 string before decoding it", () => {
    const budget = fresh();
    const huge = `H4sI${"A".repeat(L.MAX_GZIP_BASE64_CHARS)}`;
    expect(decodeCompressedJson(huge, budget)).toEqual({ ok: false, reason: "too_large" });
    expect(budget.remainingBytes).toBe(L.MAX_GZIP_OUTPUT_BYTES_PER_LOAD);
  });

  it("stops a decompression bomb at maxOutputLength and charges the attempted cap", () => {
    const budget = fresh();
    expect(BLOBS.bomb_8mib!.length).toBeLessThan(16_384);
    expect(decodeCompressedJson(BLOBS.bomb_8mib, budget)).toEqual({ ok: false, reason: "too_large" });
    expect(budget.remainingBytes).toBe(L.MAX_GZIP_OUTPUT_BYTES_PER_LOAD - L.MAX_GZIP_OUTPUT_BYTES);
    expect(decodeCompressedJson(BLOBS.over_blob_cap, fresh())).toEqual({ ok: false, reason: "too_large" });
  });

  it("enforces the per-load budget across blobs", () => {
    const budget = fresh();
    const outputBytes = 200_000 + 4; // ["x…"] with 200,000 x characters
    let decoded = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = decodeCompressedJson(BLOBS.near_blob_cap, budget);
      if (!result.ok) {
        expect(result.reason).toBe("too_large");
        break;
      }
      decoded += 1;
    }
    expect(decoded).toBe(Math.floor(L.MAX_GZIP_OUTPUT_BYTES_PER_LOAD / outputBytes));
    // Once exhausted, even a tiny blob is refused without decompressing.
    const empty: DecompressionBudget = { remainingBytes: 0 };
    expect(decodeCompressedJson(blob([]), empty)).toEqual({ ok: false, reason: "too_large" });
    expect(decodeCompressedJson(blob([]), { remainingBytes: Number.NaN })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("caps one blob at the remaining budget when that is lower than the per-blob cap", () => {
    const budget: DecompressionBudget = { remainingBytes: 100 };
    expect(decodeCompressedJson(blob(["x".repeat(200)]), budget)).toEqual({ ok: false, reason: "too_large" });
    expect(budget.remainingBytes).toBe(0);
  });

  it("reports a corrupt gzip stream as gunzip_failed", () => {
    expect(decodeCompressedJson(BLOBS.corrupt_gzip, fresh())).toEqual({ ok: false, reason: "gunzip_failed" });
    const truncated = blob([{ name: "a", value: "b".repeat(100) }]);
    expect(decodeCompressedJson(truncated.slice(0, 24), fresh())).toEqual({ ok: false, reason: "gunzip_failed" });
  });

  it("reports non-JSON and invalid UTF-8 output as invalid_json", () => {
    expect(decodeCompressedJson(BLOBS.non_json, fresh())).toEqual({ ok: false, reason: "invalid_json" });
    expect(decodeCompressedJson(BLOBS.invalid_utf8, fresh())).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("bounds JSON depth at MAX_DECODED_JSON_DEPTH", () => {
    expect(decodeCompressedJson(BLOBS.depth_24, fresh()).ok).toBe(true);
    expect(decodeCompressedJson(BLOBS.depth_25, fresh())).toEqual({ ok: false, reason: "too_deep" });
    // Brackets inside strings do not count.
    expect(decodeCompressedJson(BLOBS.depth_deep_in_string, fresh())).toEqual({
      ok: true,
      value: ["[".repeat(100)],
    });
  });

  it("bounds the JSON node count at MAX_DECODED_JSON_NODES", () => {
    expect(decodeCompressedJson(BLOBS.nodes_20001, fresh())).toEqual({ ok: false, reason: "too_deep" });
    const atLimit = Array.from({ length: L.MAX_DECODED_JSON_NODES - 1 }, () => 0);
    expect(decodeCompressedJson(blob(atLimit), fresh()).ok).toBe(true);
  });

  it("never throws, even on hostile inputs", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      }
    );
    expect(decodeCompressedJson(hostile, fresh())).toEqual({ ok: false, reason: "not_compressed" });
    for (const value of Object.values(BLOBS)) {
      expect(() => decodeCompressedJson(value, fresh())).not.toThrow();
    }
  });
});

describe("parseBoundedJson", () => {
  it("parses bounded JSON and rejects the rest", () => {
    expect(parseBoundedJson('[{"name":"a","label":"b"}]')).toEqual({
      ok: true,
      value: [{ name: "a", label: "b" }],
    });
    expect(parseBoundedJson("{nope")).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseBoundedJson(`${"[".repeat(25)}${"]".repeat(25)}`)).toEqual({ ok: false, reason: "too_deep" });
    expect(parseBoundedJson('["\\"[[[[[[[[[[[[[[[[[[[[[[[[[[["]').ok).toBe(true);
    expect(parseBoundedJson(" ".repeat(L.MAX_GZIP_OUTPUT_BYTES + 1))).toEqual({
      ok: false,
      reason: "invalid_json",
    });
    expect(parseBoundedJson(42 as unknown as string)).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("keeps __proto__ as plain data", () => {
    const result = parseBoundedJson('{"__proto__":{"polluted":true}}');
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
