/**
 * Structural bounds for untrusted JSON-RPC messages, checked before any
 * schema validation runs.
 *
 * Schema libraries walk every element of a collection they validate and can
 * record one issue (or one issue tree, for a union) per failing element. That
 * work grows with the element count rather than the byte count, so a
 * request well inside the body-size limit can still cost far more memory and
 * time to reject than to accept. The protocol schemas for methods such as
 * `initialize` and `prompts/get` run before any tool-level bound can apply,
 * so this module is the only layer that covers them.
 *
 * {@link inspectJsonShape} is plain JavaScript, independent of the schema
 * library and its version. It is a single iterative pass with an explicit
 * stack (no recursion, so no call-stack limit to reach) and it stops at the
 * first bound crossed.
 *
 * The bounds are derived from the largest input any tool legitimately
 * accepts, so a request that passes every later policy check also passes
 * here:
 *
 * - an array may hold at most {@link MAX_FIELD_ARRAY_LENGTH} elements, the
 *   field-policy bound for a single array value;
 * - the message may hold at most {@link MAX_JSON_MESSAGE_ELEMENTS} array
 *   elements and object members in total: the tool-argument budget plus a
 *   fixed allowance for the JSON-RPC envelope;
 * - no value may sit deeper than {@link MAX_JSON_MESSAGE_DEPTH} levels below
 *   the message root. The deepest legitimate value is a field-write value at
 *   the field-policy depth limit, reached through `params.arguments.fields`.
 *
 * @module json-shape-limits
 */

import {
  MAX_FIELD_ARRAY_LENGTH,
  MAX_FIELD_VALUE_DEPTH,
  MAX_FIELD_VALUE_NODES,
  MAX_TOOL_ARGUMENT_OWN_KEYS,
} from "./field-policy.js";
import { MAX_STRUCTURED_QUERY_NODES } from "./structured-query.js";

/**
 * Element budget for one tool call's arguments, as the SDK counts it (every
 * array element and own object member below the arguments object).
 *
 * The largest legitimate call is a bulk write: a full field-value budget, a
 * structured filter at the compiler's node bound, and the argument keys
 * themselves. Every value in a field-write map counts once as a member of its
 * parent, which is exactly how the field policy counts nodes.
 */
export const MAX_TOOL_INPUT_ELEMENTS =
  MAX_FIELD_VALUE_NODES + MAX_STRUCTURED_QUERY_NODES + MAX_TOOL_ARGUMENT_OWN_KEYS;

/** Members outside the tool arguments: `jsonrpc`, `id`, `method`, `params`, `_meta`, and so on. */
const JSON_RPC_ENVELOPE_ALLOWANCE = 64;

export const MAX_JSON_MESSAGE_ELEMENTS = MAX_TOOL_INPUT_ELEMENTS + JSON_RPC_ENVELOPE_ALLOWANCE;
export const MAX_JSON_MESSAGE_ARRAY_LENGTH = MAX_FIELD_ARRAY_LENGTH;
/**
 * Root is depth 0. A field value sits at depth 4 (`params`, `arguments`,
 * `fields`, the field) and may nest {@link MAX_FIELD_VALUE_DEPTH} levels
 * further, which gives 28; the remainder is headroom for envelope changes.
 */
export const MAX_JSON_MESSAGE_DEPTH = MAX_FIELD_VALUE_DEPTH + 8;

export type JsonShapeViolation = "array_length" | "element_count" | "depth";

export interface JsonShapeLimits {
  readonly maxArrayLength: number;
  readonly maxElements: number;
  readonly maxDepth: number;
}

export const JSON_MESSAGE_SHAPE_LIMITS: JsonShapeLimits = Object.freeze({
  maxArrayLength: MAX_JSON_MESSAGE_ARRAY_LENGTH,
  maxElements: MAX_JSON_MESSAGE_ELEMENTS,
  maxDepth: MAX_JSON_MESSAGE_DEPTH,
});

/** Fixed rejection text. It never includes any part of the rejected input. */
export const JSON_SHAPE_REJECTION_MESSAGE = "Request exceeds structural limits.";
/** JSON-RPC "Invalid Request". */
export const JSON_SHAPE_REJECTION_CODE = -32600;

/**
 * Check a parsed JSON value against structural bounds.
 *
 * Returns `undefined` when the value is within every bound, or the first bound
 * it crosses. Only plain JSON data is expected (the output of `JSON.parse`),
 * but anything that throws while being read is reported as a violation rather
 * than propagated.
 */
export function inspectJsonShape(
  value: unknown,
  limits: JsonShapeLimits = JSON_MESSAGE_SHAPE_LIMITS
): JsonShapeViolation | undefined {
  if (value === null || typeof value !== "object") return undefined;
  // Parallel stacks avoid allocating a pair per container. Only containers
  // are pushed, and each push follows a counted member, so the stacks never
  // grow past maxElements entries.
  const values: object[] = [value];
  const depths: number[] = [0];
  let elements = 0;
  try {
    while (values.length > 0) {
      const node = values.pop() as object;
      const childDepth = (depths.pop() as number) + 1;
      if (Array.isArray(node)) {
        const length = node.length;
        if (length > limits.maxArrayLength) return "array_length";
        elements += length;
        if (elements > limits.maxElements) return "element_count";
        if (length === 0) continue;
        if (childDepth > limits.maxDepth) return "depth";
        for (let index = 0; index < length; index += 1) {
          const child: unknown = node[index];
          if (child !== null && typeof child === "object") {
            values.push(child);
            depths.push(childDepth);
          }
        }
      } else {
        for (const key in node) {
          if (!Object.hasOwn(node, key)) continue;
          elements += 1;
          if (elements > limits.maxElements) return "element_count";
          if (childDepth > limits.maxDepth) return "depth";
          const child: unknown = (node as Record<string, unknown>)[key];
          if (child !== null && typeof child === "object") {
            values.push(child);
            depths.push(childDepth);
          }
        }
      }
    }
  } catch {
    return "element_count";
  }
  return undefined;
}
