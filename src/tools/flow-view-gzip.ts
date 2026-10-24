/**
 * Bounded decoding of the gzip+base64 JSON blobs that V2 flow storage keeps
 * in `values`, `trigger_inputs` and `subflow_inputs`.
 *
 * Every step is bounded before it runs:
 * 1. the input is a string that looks like gzip in base64 (`H4sI` prefix,
 *    strict alphabet, padded) and is at most MAX_GZIP_BASE64_CHARS long;
 * 2. `zlib.gunzipSync` runs with `maxOutputLength` set to the smaller of the
 *    per-blob cap and what is left of the per-load budget, so a decompression
 *    bomb stops at the cap instead of filling memory;
 * 3. the budget is charged with the real output size (or the whole attempted
 *    cap when the blob overflows it, so repeated bombs exhaust it);
 * 4. the UTF-8 text is pre-scanned for nesting depth before `JSON.parse`, and
 *    the parsed value is walked to bound its node count.
 *
 * Nothing here throws: every failure is a fixed reason code.
 *
 * @module tools/flow-view-gzip
 */

import { gunzipSync } from "node:zlib";
import { types as nodeUtilTypes } from "node:util";

import { FLOW_VIEW_LIMITS } from "./flow-view-contracts.js";

/** Bytes of decompressed output a single flow load may still produce. */
export interface DecompressionBudget {
  remainingBytes: number;
}

export type DecodeFailureReason =
  | "not_compressed"
  | "invalid_base64"
  | "too_large"
  | "gunzip_failed"
  | "invalid_json"
  | "too_deep";

export type DecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: DecodeFailureReason };

export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "invalid_json" | "too_deep" };

/** gzip magic (1f 8b 08) in base64, then the strict, padded base64 alphabet. */
const GZIP_BASE64 = /^H4sI[A-Za-z0-9+/]*={0,2}$/u;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** A fresh budget for one flow load (MAX_GZIP_OUTPUT_BYTES_PER_LOAD). */
export function createDecompressionBudget(): DecompressionBudget {
  return { remainingBytes: FLOW_VIEW_LIMITS.MAX_GZIP_OUTPUT_BYTES_PER_LOAD };
}

function ownValue(candidate: object): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, "value");
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Unwrap one level of a Table API `{value, display_value}` cell. */
function unwrap(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  if (nodeUtilTypes.isProxy(value)) return undefined;
  return ownValue(value);
}

function remaining(budget: DecompressionBudget): number {
  const left = budget.remainingBytes;
  return Number.isSafeInteger(left) && left > 0 ? left : 0;
}

/**
 * Decode one compressed JSON blob within the per-blob and per-load bounds.
 * The budget is shared by every blob of one flow load and is decremented here.
 */
export function decodeCompressedJson(value: unknown, budget: DecompressionBudget): DecodeResult {
  const candidate = unwrap(value);
  if (typeof candidate !== "string") return { ok: false, reason: "not_compressed" };
  if (candidate.length > FLOW_VIEW_LIMITS.MAX_GZIP_BASE64_CHARS) {
    return { ok: false, reason: "too_large" };
  }
  if (!candidate.startsWith("H4sI")) return { ok: false, reason: "not_compressed" };
  if (!GZIP_BASE64.test(candidate) || candidate.length % 4 !== 0) {
    return { ok: false, reason: "invalid_base64" };
  }

  const limit = Math.min(FLOW_VIEW_LIMITS.MAX_GZIP_OUTPUT_BYTES, remaining(budget));
  if (limit < 1) return { ok: false, reason: "too_large" };

  let output: Buffer;
  try {
    output = gunzipSync(Buffer.from(candidate, "base64"), { maxOutputLength: limit });
  } catch (error) {
    if (isBufferTooLarge(error)) {
      budget.remainingBytes = remaining(budget) - limit;
      return { ok: false, reason: "too_large" };
    }
    return { ok: false, reason: "gunzip_failed" };
  }
  budget.remainingBytes = remaining(budget) - output.length;

  let text: string;
  try {
    text = UTF8.decode(output);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  return parseBoundedJson(text);
}

function isBufferTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE";
  } catch {
    return false;
  }
}

/**
 * Parse JSON text whose nesting stays within MAX_DECODED_JSON_DEPTH and whose
 * value count stays within MAX_DECODED_JSON_NODES. The text length must
 * already be bounded by the caller (at most MAX_GZIP_OUTPUT_BYTES here).
 */
export function parseBoundedJson(text: string): BoundedJsonResult {
  if (typeof text !== "string" || text.length > FLOW_VIEW_LIMITS.MAX_GZIP_OUTPUT_BYTES) {
    return { ok: false, reason: "invalid_json" };
  }
  if (nestingDepth(text) > FLOW_VIEW_LIMITS.MAX_DECODED_JSON_DEPTH) {
    return { ok: false, reason: "too_deep" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (countNodes(value) > FLOW_VIEW_LIMITS.MAX_DECODED_JSON_NODES) {
    return { ok: false, reason: "too_deep" };
  }
  return { ok: true, value };
}

/** Maximum bracket nesting outside string literals, by one linear scan. */
function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === 0x5c) index += 1; // backslash: skip the escaped character
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) inString = true;
    else if (code === 0x5b || code === 0x7b) {
      depth += 1;
      if (depth > max) max = depth;
      if (max > FLOW_VIEW_LIMITS.MAX_DECODED_JSON_DEPTH) return max;
    } else if (code === 0x5d || code === 0x7d) depth -= 1;
  }
  return max;
}

/**
 * Count JSON values, stopping once the bound is passed. The depth pre-scan
 * already bounds recursion to MAX_DECODED_JSON_DEPTH.
 */
function countNodes(value: unknown): number {
  const limit = FLOW_VIEW_LIMITS.MAX_DECODED_JSON_NODES;
  let count = 0;
  const visit = (node: unknown): void => {
    count += 1;
    if (count > limit || node === null || typeof node !== "object") return;
    const items = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const item of items) {
      visit(item);
      if (count > limit) return;
    }
  };
  visit(value);
  return count;
}
