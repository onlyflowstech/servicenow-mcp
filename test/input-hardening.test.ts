/**
 * Structural bounds that run before schema validation.
 *
 * Schema validation of a collection visits every element and can record an
 * issue per failing element, so rejecting a large hostile collection can cost
 * far more than its byte size suggests. These tests hold each pre-schema
 * bound to two properties: hostile input is rejected quickly with a handful of
 * issues and bounded memory, and the largest legitimate input still passes.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  boundedArray,
  boundedRecord,
  hasMoreOwnKeysThan,
  withStructuralCheck,
} from "../src/bounded-input.js";
import {
  MAX_FIELD_ARRAY_LENGTH,
  MAX_FIELD_VALUE_DEPTH,
  MAX_FIELD_VALUE_NODES,
  MAX_TOOL_ARGUMENT_OWN_KEYS,
  validateWritableFields,
} from "../src/field-policy.js";
import {
  inspectJsonShape,
  MAX_JSON_MESSAGE_ARRAY_LENGTH,
  MAX_JSON_MESSAGE_DEPTH,
  MAX_JSON_MESSAGE_ELEMENTS,
  MAX_TOOL_INPUT_ELEMENTS,
} from "../src/json-shape-limits.js";
import { createMcpServer, type McpServerRegistrationSurface } from "../src/server.js";
import {
  compileStructuredQuery,
  MAX_STRUCTURED_QUERY_CONDITIONS,
  MAX_STRUCTURED_QUERY_GROUPS,
  MAX_STRUCTURED_QUERY_LEAVES,
  MAX_STRUCTURED_QUERY_NODES,
  MAX_STRUCTURED_QUERY_TERMS,
  STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE,
  StructuredQueryError,
  structuredQuerySchema,
  structuredQueryShapeWithinLimits,
} from "../src/structured-query.js";
import { atfAuthorInputSchema } from "../src/tools/atf-author-module.js";
import { schema as batchSchema } from "../src/tools/batch.js";
import { moduleInputSchema as queryModuleInputSchema } from "../src/tools/query-module.js";
import { withRequiredProfile } from "../src/tools/tool-module.js";

const ONE_MIB = 1024 * 1024;
const SYS_ID = "0123456789abcdef0123456789abcdef";
/**
 * Time ceiling for one hostile rejection, applied to the best of
 * {@link TIMING_ROUNDS} rounds. This is a regression gate, not a benchmark: a
 * single wall-clock reading on a loaded machine measures the machine as much
 * as this code (a 100 ms ceiling failed at 158 ms under load). The measured
 * cost is a few milliseconds; the ceiling catches an order-of-magnitude
 * regression. The strict properties are the issue counts below, and in H5 the
 * 128 MB heap and the 1 KB response bound: before these checks every hostile
 * case produced hundreds of thousands of issues or ran out of memory.
 */
const REJECTION_CEILING_MS = 1_000;
const TIMING_ROUNDS = 3;
const MAX_ISSUES = 50;

/** The SDK's own count: array elements plus own object members, below the root. */
function elementCount(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      count += 1;
      stack.push(child);
    }
  }
  return count;
}

/** A field-write map with exactly `nodes` field-policy nodes, in arrays at the array bound. */
function fieldWrite(nodes: number): Record<string, unknown> {
  const names = ["description", "short_description", "close_notes", "comments", "work_notes", "u_extra"];
  const fields: Record<string, unknown> = {};
  let remaining = nodes;
  for (const name of names) {
    if (remaining <= 0) break;
    const length = Math.min(MAX_FIELD_ARRAY_LENGTH, remaining - 1);
    fields[name] = new Array(length).fill("x");
    remaining -= length + 1;
  }
  return fields;
}

const group = (conditions: unknown[], operator: "and" | "or" = "and") => ({
  type: "group",
  operator,
  conditions,
});
const leaf = (index: number) => ({
  type: "equality",
  field: "number",
  operator: "eq",
  value: `INC${index}`,
});
const repeat = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

/** Run `run` {@link TIMING_ROUNDS} times; report the last result and the fastest round. */
async function timed<T>(run: () => Promise<T> | T): Promise<{ result: T; ms: number }> {
  let ms = Number.POSITIVE_INFINITY;
  let result: T | undefined;
  for (let round = 0; round < TIMING_ROUNDS; round += 1) {
    const started = performance.now();
    result = await run();
    ms = Math.min(ms, performance.now() - started);
  }
  return { result: result as T, ms };
}

describe("H1 message shape bounds", () => {
  it("derives its budgets from the tool-level bounds", () => {
    expect(MAX_TOOL_INPUT_ELEMENTS).toBe(
      MAX_FIELD_VALUE_NODES + MAX_STRUCTURED_QUERY_NODES + MAX_TOOL_ARGUMENT_OWN_KEYS
    );
    expect(MAX_JSON_MESSAGE_ELEMENTS).toBeGreaterThan(MAX_TOOL_INPUT_ELEMENTS);
    expect(MAX_JSON_MESSAGE_ARRAY_LENGTH).toBe(MAX_FIELD_ARRAY_LENGTH);
    // params, arguments, fields, the field, then the field-policy depth.
    expect(MAX_JSON_MESSAGE_DEPTH).toBeGreaterThanOrEqual(4 + MAX_FIELD_VALUE_DEPTH);
  });

  it("accepts each bound exactly and rejects one past it", () => {
    expect(inspectJsonShape(new Array(MAX_JSON_MESSAGE_ARRAY_LENGTH).fill(0))).toBeUndefined();
    expect(inspectJsonShape(new Array(MAX_JSON_MESSAGE_ARRAY_LENGTH + 1).fill(0))).toBe(
      "array_length"
    );

    const atElementBound = repeat(
      Math.ceil(MAX_JSON_MESSAGE_ELEMENTS / MAX_JSON_MESSAGE_ARRAY_LENGTH),
      () => [] as number[]
    );
    let remaining = MAX_JSON_MESSAGE_ELEMENTS - atElementBound.length;
    for (const array of atElementBound) {
      const length = Math.min(MAX_JSON_MESSAGE_ARRAY_LENGTH, remaining);
      array.push(...new Array<number>(length).fill(0));
      remaining -= length;
    }
    expect(elementCount(atElementBound)).toBe(MAX_JSON_MESSAGE_ELEMENTS);
    expect(inspectJsonShape(atElementBound)).toBeUndefined();
    atElementBound.push([]);
    expect(inspectJsonShape(atElementBound)).toBe("element_count");

    const nested = (levels: number) => {
      let value: unknown = 0;
      for (let level = 0; level < levels; level += 1) value = { a: value };
      return value;
    };
    expect(inspectJsonShape(nested(MAX_JSON_MESSAGE_DEPTH))).toBeUndefined();
    expect(inspectJsonShape(nested(MAX_JSON_MESSAGE_DEPTH + 1))).toBe("depth");
  });

  it("walks iteratively, so extreme nesting is a rejection and not a stack overflow", () => {
    let value: unknown = 0;
    for (let level = 0; level < 200_000; level += 1) value = [value];
    expect(inspectJsonShape(value)).toBe("depth");
  });

  it("stops at the first bound crossed", async () => {
    const huge = new Array(5_000_000).fill(0);
    const { result, ms } = await timed(() => inspectJsonShape(huge));
    expect(result).toBe("array_length");
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
  });

  it("accepts the largest legitimate tool call", () => {
    const fields = fieldWrite(MAX_FIELD_VALUE_NODES);
    let deepest: unknown = "x";
    for (let level = 0; level < MAX_FIELD_VALUE_DEPTH; level += 1) deepest = [deepest];
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "sn_batch",
        _meta: { progressToken: 1 },
        arguments: {
          profile: "p",
          table: "incident",
          action: "update",
          confirm: true,
          limit: 10_000,
          structured_query: {
            filter: group(repeat(2, () => group(repeat(16, leaf))), "or"),
            order_by: [{ field: "number", direction: "asc" }],
          },
          fields: { ...fields, u_deep: deepest },
        },
      },
    };
    expect(inspectJsonShape(message)).toBeUndefined();
  });
});

describe("H2 tool input element bound", () => {
  async function callProbe(args: Record<string, unknown>) {
    let received: unknown;
    const server = await createMcpServer({
      dependencies: {},
      register: (surface: McpServerRegistrationSurface) => {
        surface.registerTool(
          "probe",
          { inputSchema: batchSchema.shape },
          async (input) => {
            received = input;
            return { content: [{ type: "text", text: "reached" }] };
          }
        );
      },
    });
    const client = new Client({ name: "h2", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "probe", arguments: args });
      return { result, received };
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("passes the largest legitimate field write, which the field policy also accepts", async () => {
    const fields = fieldWrite(MAX_FIELD_VALUE_NODES);
    expect(() => validateWritableFields("incident", fields)).not.toThrow();
    const args = {
      table: "incident",
      action: "update",
      structured_query: {
        filter: group(repeat(MAX_STRUCTURED_QUERY_CONDITIONS, leaf)),
      },
      fields,
    };

    const { result, received } = await callProbe(args);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "reached" }]);
    expect((received as { fields: unknown }).fields).toEqual(fields);
  });

  it("rejects one element past the bound before the schema runs", async () => {
    const args = {
      table: "incident",
      action: "update",
      structured_query: { filter: leaf(0) },
      fields: fieldWrite(MAX_TOOL_INPUT_ELEMENTS),
    };
    expect(elementCount(args)).toBeGreaterThan(MAX_TOOL_INPUT_ELEMENTS);

    const { result, received } = await callProbe(args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      `more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`
    );
    expect(received).toBeUndefined();
  });
});

describe("H3 structured query pre-check", () => {
  it("bounds leaf and group conditions at the documented values", () => {
    const leaves = (count: number) => ({
      filter: group(repeat(Math.ceil(count / 32), (block) =>
        group(repeat(Math.min(32, count - block * 32), leaf))
      )),
    });
    expect(structuredQueryShapeWithinLimits(leaves(MAX_STRUCTURED_QUERY_LEAVES))).toBe(true);
    expect(structuredQueryShapeWithinLimits(leaves(MAX_STRUCTURED_QUERY_LEAVES + 1))).toBe(false);

    // One top group, 32 groups below it, and one group below each of those.
    const groups = (count: number) => ({
      filter: group(repeat(32, (index) =>
        group(index < count - 33 ? [group([leaf(index)])] : [leaf(index)])
      )),
    });
    expect(structuredQueryShapeWithinLimits(groups(MAX_STRUCTURED_QUERY_GROUPS))).toBe(true);
    expect(() => compileStructuredQuery(groups(MAX_STRUCTURED_QUERY_GROUPS), ["*"])).not.toThrow();
    // One more group, wrapped around the deepest leaf of the first branch.
    const tooMany = groups(MAX_STRUCTURED_QUERY_GROUPS);
    const second = (tooMany.filter.conditions[0] as { conditions: Array<{ conditions: unknown[] }> })
      .conditions[0];
    second.conditions = [group(second.conditions)];
    expect(structuredQueryShapeWithinLimits(tooMany)).toBe(false);
  });

  it("applies the compiler's own snapshot bounds", () => {
    const keys = (count: number) => ({
      order_by: [Object.fromEntries(repeat(count, (index) => [`k${index}`, index]))],
    });
    expect(structuredQueryShapeWithinLimits(keys(8))).toBe(true);
    expect(structuredQueryShapeWithinLimits(keys(9))).toBe(false);
    expect(structuredQueryShapeWithinLimits({ order_by: repeat(32, () => 0) })).toBe(true);
    expect(structuredQueryShapeWithinLimits({ order_by: repeat(33, () => 0) })).toBe(false);
    let deep: unknown = 0;
    for (let level = 0; level < 11; level += 1) deep = [deep];
    expect(structuredQueryShapeWithinLimits({ order_by: deep })).toBe(true);
    expect(structuredQueryShapeWithinLimits({ order_by: [deep] })).toBe(false);
    // Exactly `count` values, root included, every array and object in bounds.
    const withNodes = (count: number) => {
      const orderBy: Array<Record<string, number[]>> = [];
      let nodes = 2; // the root and the order_by array
      while (nodes < count) {
        let object = orderBy.at(-1);
        if (object === undefined || Object.keys(object).length === 8) {
          object = {};
          orderBy.push(object);
          nodes += 1;
          continue;
        }
        const keys = Object.keys(object);
        const last = keys.length === 0 ? undefined : object[keys[keys.length - 1] as string];
        if (last === undefined || last.length === 32) {
          object[`k${keys.length}`] = [];
        } else {
          last.push(0);
        }
        nodes += 1;
      }
      expect(orderBy.length).toBeLessThanOrEqual(32);
      return { order_by: orderBy };
    };
    expect(structuredQueryShapeWithinLimits(withNodes(MAX_STRUCTURED_QUERY_NODES))).toBe(true);
    expect(structuredQueryShapeWithinLimits(withNodes(MAX_STRUCTURED_QUERY_NODES + 1))).toBe(false);
  });

  it("rejects nothing that compiles: every compiled query is inside the bounds", () => {
    // Deterministic generator of policy-shaped queries at every nesting level
    // and width, so many compile and many hit a compiler bound.
    let seed = 0x5eed;
    // mulberry32: small, deterministic, and exact in 32-bit integer math.
    const random = (limit: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
    };
    const operators = ["and", "or"] as const;
    const makeLeaf = (): unknown => {
      switch (random(4)) {
        case 0:
          return leaf(random(1000));
        case 1:
          return {
            type: "set",
            field: "state",
            operator: "in",
            values: repeat(1 + random(20), (index) => index),
          };
        case 2:
          return { type: "null", field: "assigned_to", operator: "is_null" };
        default:
          return { type: "text", field: "short_description", operator: "contains", value: "x" };
      }
    };
    const makeFilter = (level: number): unknown => {
      if (level === 3 || random(3) === 0) return makeLeaf();
      const width = 1 + random(random(4) === 0 ? MAX_STRUCTURED_QUERY_CONDITIONS : 4);
      return group(
        repeat(width, () => makeFilter(level + 1)),
        operators[random(2)]
      );
    };

    let compiled = 0;
    let rejectedByCompiler = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const query = { filter: makeFilter(0) };
      let encoded: string | undefined;
      try {
        encoded = compileStructuredQuery(query, ["*"]).encodedQuery;
      } catch (error) {
        expect(error).toBeInstanceOf(StructuredQueryError);
        rejectedByCompiler += 1;
        continue;
      }
      compiled += 1;
      expect(structuredQueryShapeWithinLimits(query)).toBe(true);
      expect(structuredQuerySchema.safeParse(query).success).toBe(true);
      const terms = encoded
        .split("^NQ")
        .reduce((total, clause) => total + clause.split("^").length, 0);
      expect(terms).toBeLessThanOrEqual(MAX_STRUCTURED_QUERY_TERMS);
    }
    expect(compiled).toBeGreaterThan(200);
    expect(rejectedByCompiler).toBeGreaterThan(200);
  });

  it("leaves the compiler's own leaf bound below the pre-check's", () => {
    expect(MAX_STRUCTURED_QUERY_CONDITIONS).toBeLessThanOrEqual(MAX_STRUCTURED_QUERY_LEAVES);
    expect(() =>
      compileStructuredQuery(
        { filter: group(repeat(2, (block) => group(repeat(32, (index) => leaf(block * 32 + index))))) },
        ["*"]
      )
    ).toThrow(StructuredQueryError);
  });

  it.each([
    ["1 MiB of flat conditions", () => ({ filter: group(repeat(Math.floor(ONE_MIB / 3), () => ({}))) })],
    [
      "nesting 32 wide at every level",
      () => ({ filter: group(repeat(32, () => group(repeat(32, () => group(repeat(32, () => ({}))))))) }),
    ],
    [
      "1 MiB of set values",
      () => ({ filter: { type: "set", field: "state", operator: "in", values: repeat(Math.floor(ONE_MIB / 5), () => null) } }),
    ],
    ["1 MiB of order_by", () => ({ order_by: repeat(Math.floor(ONE_MIB / 2), () => 0) })],
  ])("rejects %s with one issue, fast", async (_label, build) => {
    const value = build();
    const { result, ms } = await timed(() => structuredQuerySchema.safeParseAsync(value));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.message).toBe(STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE);
    }
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
  });
});

describe("hostile rejections read a bounded number of elements", () => {
  // The deterministic form of "rejected fast": count element reads through a
  // Proxy instead of timing them, so machine load cannot affect the result.
  // A bound that stops at a collection's length reads none of its elements;
  // without that early exit these inputs are read in full (millions of reads).
  // The time ceiling stays only as a guard against hangs.
  const MAX_ELEMENT_READS = 64;
  function countingArray<T>(elements: T[]): { array: T[]; reads: () => number } {
    let reads = 0;
    const array = new Proxy(elements, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { array, reads: () => reads };
  }

  it("H1: an oversized array is rejected on its length alone", async () => {
    const { array, reads } = countingArray(new Array<number>(5_000_000).fill(0));
    const { result, ms } = await timed(() => inspectJsonShape(array));
    expect(result).toBe("array_length");
    expect(reads()).toBeLessThanOrEqual(MAX_ELEMENT_READS);
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
  });

  it("H3: 1 MiB of flat conditions is rejected on the conditions' length alone", async () => {
    const { array, reads } = countingArray(
      Array.from({ length: Math.floor(ONE_MIB / 3) }, () => ({}))
    );
    const { result, ms } = await timed(() =>
      structuredQuerySchema.safeParseAsync({ filter: group(array) })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.message).toBe(STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE);
    }
    expect(reads()).toBeLessThanOrEqual(MAX_ELEMENT_READS);
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
  });

  it("H4: an oversized bounded array is rejected by boundedArray's own pre-check", async () => {
    // zod 4.6.7's .max() also stops before the elements, so a read count
    // alone cannot tell the two apart. The pre-check reports a custom issue
    // (with .max()'s text); zod's own bound would report too_big.
    const { array, reads } = countingArray(new Array<number>(ONE_MIB).fill(0));
    const { result, ms } = await timed(() => boundedArray(z.number(), 50).safeParseAsync(array));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: "custom", message: "Too big: expected array to have <=50 items" }),
      ]);
    }
    expect(reads()).toBeLessThanOrEqual(MAX_ELEMENT_READS);
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
  });

  it("H4: an oversized bounded record is rejected without reading its values", async () => {
    // zod has no size bound for records, so without boundedRecord's pre-check
    // every value would be read and parsed.
    let reads = 0;
    const record = new Proxy(
      Object.fromEntries(repeat(100_000, (index) => [`k${index}`, index])),
      {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      }
    );
    const schema = boundedRecord(z.record(z.string(), z.number()), 50, "too many entries");
    const { result, ms } = await timed(() => schema.safeParseAsync(record));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: "custom", message: "too many entries" }),
      ]);
    }
    expect(reads).toBeLessThanOrEqual(MAX_ELEMENT_READS);
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
  });
});

describe("H4 bounded arrays", () => {
  it("checks the length before parsing any element", () => {
    let parsed = 0;
    const counted = z.unknown().refine(() => {
      parsed += 1;
      return false;
    });
    const result = boundedArray(counted, 4).safeParse(new Array(100_000).fill(0));
    expect(result.success).toBe(false);
    expect(parsed).toBe(0);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      // The same text the plain `.max()` reports.
      expect(result.error.issues[0]?.message).toBe(
        (z.array(z.unknown()).max(4).safeParse([1, 2, 3, 4, 5]) as { error: z.ZodError }).error
          .issues[0]?.message
      );
    }
    expect(boundedArray(z.number(), 4, { min: 1 }).safeParse([]).success).toBe(false);
    expect(boundedArray(z.number(), 4, { min: 1 }).safeParse([1, 2, 3, 4]).success).toBe(true);
  });

  it("checks record size before parsing any key or value", () => {
    let parsed = 0;
    const counted = z.record(
      z.string(),
      z.unknown().refine(() => {
        parsed += 1;
        return true;
      })
    );
    const big = Object.fromEntries(repeat(10_000, (index) => [`k${index}`, index]));
    const result = boundedRecord(counted, 50, "too many entries").safeParse(big);
    expect(result.success).toBe(false);
    expect(parsed).toBe(0);
    expect(hasMoreOwnKeysThan({ a: 1, b: 2 }, 2)).toBe(false);
    expect(hasMoreOwnKeysThan({ a: 1, b: 2, c: 3 }, 2)).toBe(true);
    expect(hasMoreOwnKeysThan([1, 2, 3], 2)).toBe(false);
  });

  it("serves the same JSON Schema as the plain array", async () => {
    const register = (array: z.ZodTypeAny) => async () => {
      const server = await createMcpServer({
        dependencies: {},
        register: (surface: McpServerRegistrationSurface) => {
          surface.registerTool("probe", { inputSchema: { items: array.optional() } }, async () => ({
            content: [],
          }));
        },
      });
      const client = new Client({ name: "h4", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        return (await client.listTools()).tools;
      } finally {
        await client.close();
        await server.close();
      }
    };
    const plain = await register(z.array(z.string()).min(1).max(7))();
    const bounded = await register(boundedArray(z.string(), 7, { min: 1 }))();
    expect(bounded).toEqual(plain);
  });

  it("bounds sn_atf_author steps and test_sys_ids at their documented maximums", () => {
    const steps = (count: number) => ({
      profile: "p",
      action: "add_steps",
      test_sys_id: SYS_ID,
      steps: repeat(count, () => ({ type: "open_form", inputs: {} })),
    });
    expect(atfAuthorInputSchema.safeParse(steps(50)).success).toBe(true);
    const overSteps = atfAuthorInputSchema.safeParse(steps(51));
    expect(overSteps.success).toBe(false);
    if (!overSteps.success) {
      expect(overSteps.error.issues).toEqual([
        expect.objectContaining({
          path: ["steps"],
          message: "Too big: expected array to have <=50 items",
        }),
      ]);
    }

    const ids = (count: number) => ({
      profile: "p",
      action: "add_tests_to_suite",
      suite_sys_id: SYS_ID,
      test_sys_ids: repeat(count, (index) => index.toString(16).padStart(32, "0")),
    });
    expect(atfAuthorInputSchema.safeParse(ids(100)).success).toBe(true);
    const overIds = atfAuthorInputSchema.safeParse(ids(101));
    expect(overIds.success).toBe(false);
    if (!overIds.success) {
      expect(overIds.error.issues).toHaveLength(1);
      expect(overIds.error.issues[0]?.message).toBe("Too big: expected array to have <=100 items");
    }
    // Uniqueness is still enforced within the bound.
    expect(
      atfAuthorInputSchema.safeParse({ ...ids(2), test_sys_ids: [SYS_ID, SYS_ID] }).success
    ).toBe(false);
  });

  it.each([
    ["1 MiB of steps", "add_steps", "steps", () => repeat(Math.floor(ONE_MIB / 3), () => ({}))],
    ["1 MiB of test_sys_ids", "add_tests_to_suite", "test_sys_ids", () => repeat(Math.floor(ONE_MIB / 2), () => 0)],
  ])("rejects %s with one issue, fast", async (_label, action, key, build) => {
    const value = { profile: "p", action, test_sys_id: SYS_ID, suite_sys_id: SYS_ID, [key]: build() };
    const { result, ms } = await timed(() => atfAuthorInputSchema.safeParseAsync(value));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeLessThanOrEqual(MAX_ISSUES);
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
  });
});

describe("pre-schema checks are fatal and run before parsing (installed zod)", () => {
  // The H3/H4 hooks rely on a pipe stopping at its first stage when that
  // stage reports an issue. These cases hold that to the installed zod
  // version, both on a plain wrapper and inside the hardened graph every
  // published tool schema is rebuilt into.
  const tooManyKeys = (value: unknown) =>
    hasMoreOwnKeysThan(value, 2) ? "too many keys" : undefined;
  const hugeRecord = () => Object.fromEntries(repeat(100_000, (index) => [`k${index}`, index]));
  function counted() {
    const seen = { elements: 0, containers: 0 };
    const element = z.unknown().refine(() => {
      seen.elements += 1;
      return true;
    });
    const record = z.record(z.string(), element).superRefine(() => {
      seen.containers += 1;
    });
    return { seen, element, record };
  }

  it("stops at the check with one custom issue; the wrapped schema never runs", async () => {
    const { seen, record } = counted();
    const wrapped = withStructuralCheck(record, tooManyKeys);
    const hostile = hugeRecord();
    for (const result of [wrapped.safeParse(hostile), await wrapped.safeParseAsync(hostile)]) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual([
          expect.objectContaining({ code: "custom", message: "too many keys", path: [] }),
        ]);
      }
    }
    expect(seen).toEqual({ elements: 0, containers: 0 });
    // A value inside the bound reaches the wrapped schema unchanged.
    expect(wrapped.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(seen).toEqual({ elements: 2, containers: 1 });
  });

  it("keeps both properties inside a hardened tool schema", async () => {
    const { seen, element, record } = counted();
    const issued = withRequiredProfile(
      z
        .object({
          items: boundedArray(element, 4).optional(),
          map: withStructuralCheck(record, tooManyKeys).optional(),
        })
        .strict()
    );
    const wrapper = (issued.shape.items as z.ZodOptional<z.ZodType>)._zod.def.innerType;
    expect(wrapper).toBeInstanceOf(z.ZodPreprocess);
    expect(Object.isFrozen(wrapper)).toBe(true);

    const { result, ms } = await timed(() =>
      issued.safeParseAsync({ profile: "p", items: new Array(100_000).fill(0), map: hugeRecord() })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => [issue.code, issue.path[0]])).toEqual([
        ["custom", "items"],
        ["custom", "map"],
      ]);
    }
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
    expect(seen).toEqual({ elements: 0, containers: 0 });

    expect(issued.safeParse({ profile: "p", items: [1], map: { a: 1 } }).success).toBe(true);
    expect(seen).toEqual({ elements: 2, containers: 1 });
  });

  it.each([
    ["1 MiB of flat conditions", () => group(repeat(Math.floor(ONE_MIB / 3), () => ({})))],
    [
      "nesting 32 wide at every level",
      () => group(repeat(32, () => group(repeat(32, () => group(repeat(32, () => ({}))))))),
    ],
  ])("bounds %s through the published sn_query input schema", async (_label, build) => {
    const { result, ms } = await timed(() =>
      queryModuleInputSchema.safeParseAsync({
        profile: "p",
        table: "incident",
        structured_query: { filter: build() },
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeLessThanOrEqual(MAX_ISSUES);
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: "custom",
          path: ["structured_query"],
          message: STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE,
        }),
      ]);
    }
    expect(ms).toBeLessThan(REJECTION_CEILING_MS);
  });
});

describe("H5 hostile messages through the built server under a reduced heap", () => {
  const harness = fileURLToPath(new URL("./fixtures/input-hardening-harness.mjs", import.meta.url));

  interface CaseResult {
    readonly name: string;
    readonly hostile: boolean;
    readonly minMs: number;
    readonly kind: "rpc-error" | "validation-error" | "tool-result";
    readonly issues: number;
    readonly responseBytes: number;
    readonly head: string;
  }

  // Each layer runs in its own process with a 128 MB old-space limit. Before
  // these bounds, every hostile case below needed more than 512 MB, so a case
  // that regresses ends the child with an out-of-memory abort.
  it.each(["stdio", "server"])(
    "%s: rejects every hostile case fast with few issues and passes every legitimate maximum",
    (layer) => {
      const child = spawnSync(
        process.execPath,
        ["--max-old-space-size=128", harness, layer, "3"],
        { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * ONE_MIB }
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const results = child.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CaseResult);
      expect(results.length).toBeGreaterThanOrEqual(layer === "stdio" ? 16 : 14);

      for (const result of results) {
        if (result.hostile) {
          expect(result.kind, result.name).not.toBe("tool-result");
          expect(result.issues, result.name).toBeLessThanOrEqual(MAX_ISSUES);
          expect(result.responseBytes, result.name).toBeLessThan(1024);
          expect(result.minMs, result.name).toBeLessThan(REJECTION_CEILING_MS);
        } else {
          // Past input validation: the harness has no profile, so the
          // handler's first step is what answers.
          expect(result.kind, `${result.name}: ${result.head}`).toBe("tool-result");
          expect(result.head, result.name).toMatch(/Unknown profile/u);
        }
      }
      if (layer === "stdio") {
        const protocol = results.filter((result) => /^(initialize|prompts)/u.test(result.name));
        expect(protocol).toHaveLength(2);
        for (const result of protocol) expect(result.kind).toBe("rpc-error");
      }
    },
    150_000
  );
});
