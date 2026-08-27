/** Guarded snapshot boundary for untrusted tool-handler output. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { types as utilTypes } from "node:util";

import { ATTACHMENT_RESULT_BYTE_LIMIT } from "./result-envelope.js";

const MAX_HANDLER_RESULT_DEPTH = 32;
const MAX_HANDLER_RESULT_NODES = 100_000;
const MAX_HANDLER_RESULT_OWN_KEYS = 200_000;
const MAX_HANDLER_RESULT_STRING_BYTES = ATTACHMENT_RESULT_BYTE_LIMIT + 64 * 1024;

export type GuardedHandlerResult =
  | { readonly kind: "error" }
  | { readonly kind: "success"; readonly result: CallToolResult };

interface SnapshotState {
  depth: number;
  nodes: number;
  ownKeys: number;
  stringBytes: number;
  readonly active: WeakSet<object>;
}

/**
 * Snapshot one result without invoking accessors, Proxy traps, iterators,
 * coercion hooks, or `toJSON`. Only bounded JSON-compatible data survives.
 */
export function guardedHandlerResult(candidate: unknown): GuardedHandlerResult {
  const state: SnapshotState = {
    depth: 0,
    nodes: 0,
    ownKeys: 0,
    stringBytes: 0,
    active: new WeakSet<object>(),
  };
  const snapshot = snapshotJson(candidate, state, "handler result");
  if (!isPlainRecord(snapshot)) {
    throw new TypeError("handler result must be a plain object");
  }
  const keys = Object.keys(snapshot);
  if (
    keys.some(
      (key) =>
        key !== "content" &&
        key !== "structuredContent" &&
        key !== "isError"
    )
  ) {
    throw new TypeError("handler result contains unsupported properties");
  }
  if (!Array.isArray(snapshot.content)) {
    throw new TypeError("handler result content must be an array");
  }
  if (
    snapshot.content.length !== 1
  ) {
    throw new TypeError("handler result content count is invalid");
  }
  if (
    snapshot.isError !== undefined &&
    typeof snapshot.isError !== "boolean"
  ) {
    throw new TypeError("handler result isError must be boolean");
  }
  if (snapshot.isError === true) return Object.freeze({ kind: "error" });
  if (snapshot.isError === false) {
    throw new TypeError("successful handler result must omit isError");
  }
  const content = snapshot.content[0];
  if (
    !isPlainRecord(content) ||
    Object.keys(content).length !== 2 ||
    content.type !== "text" ||
    typeof content.text !== "string"
  ) {
    throw new TypeError("handler result content must be one exact text block");
  }
  return Object.freeze({
    kind: "success",
    result: snapshot as unknown as CallToolResult,
  });
}

function snapshotJson(
  candidate: unknown,
  state: SnapshotState,
  label: string
): unknown {
  if (
    candidate === null ||
    typeof candidate === "boolean" ||
    typeof candidate === "undefined"
  ) {
    return candidate;
  }
  if (typeof candidate === "string") {
    state.stringBytes += Buffer.byteLength(candidate, "utf8");
    if (state.stringBytes > MAX_HANDLER_RESULT_STRING_BYTES) {
      throw new RangeError("handler result string budget exceeded");
    }
    return candidate;
  }
  if (typeof candidate === "number") {
    if (!Number.isFinite(candidate)) {
      throw new TypeError(`${label} contains a non-finite number`);
    }
    return candidate;
  }
  if (typeof candidate !== "object" || utilTypes.isProxy(candidate)) {
    throw new TypeError(`${label} contains unsupported data`);
  }
  if (state.active.has(candidate)) {
    throw new TypeError("handler result must not contain cycles");
  }
  state.depth += 1;
  state.nodes += 1;
  if (
    state.depth > MAX_HANDLER_RESULT_DEPTH ||
    state.nodes > MAX_HANDLER_RESULT_NODES
  ) {
    state.depth -= 1;
    throw new RangeError("handler result traversal budget exceeded");
  }
  state.active.add(candidate);
  try {
    return Array.isArray(candidate)
      ? snapshotArray(candidate, state, label)
      : snapshotRecord(candidate, state, label);
  } finally {
    state.active.delete(candidate);
    state.depth -= 1;
  }
}

function snapshotArray(
  candidate: unknown[],
  state: SnapshotState,
  label: string
): unknown[] {
  const descriptors = boundedDescriptors(candidate, state, label);
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_HANDLER_RESULT_NODES
  ) {
    throw new TypeError(`${label} array length is invalid`);
  }
  const length = lengthDescriptor.value as number;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = descriptors[String(index)];
    if (!item || !("value" in item)) {
      throw new TypeError(`${label} arrays must not be sparse or accessor-backed`);
    }
    const value = snapshotJson(item.value, state, `${label}[${index}]`);
    if (value === undefined) {
      throw new TypeError(`${label} arrays must not contain undefined`);
    }
    output.push(value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= length
    ) {
      throw new TypeError(`${label} array contains unsupported properties`);
    }
  }
  return output;
}

function snapshotRecord(
  candidate: object,
  state: SnapshotState,
  label: string
): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain objects`);
  }
  const descriptors = boundedDescriptors(candidate, state, label);
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const property = descriptors[key] as PropertyDescriptor;
    if (
      typeof key !== "string" ||
      !property.enumerable ||
      !("value" in property)
    ) {
      throw new TypeError(`${label} must contain enumerable data properties`);
    }
    output[key] = snapshotJson(property.value, state, `${label}.${key}`);
  }
  return output;
}

function boundedDescriptors(
  candidate: object,
  state: SnapshotState,
  label: string
): Record<PropertyKey, PropertyDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(candidate) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const keys = Reflect.ownKeys(descriptors);
  state.ownKeys += keys.length;
  if (state.ownKeys > MAX_HANDLER_RESULT_OWN_KEYS) {
    throw new RangeError("handler result property budget exceeded");
  }
  for (const key of keys) {
    const property = descriptors[key] as PropertyDescriptor;
    if (!("value" in property)) {
      throw new TypeError(`${label} must not contain accessors`);
    }
  }
  return descriptors;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
