import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeHarnesses,
  harness,
  nested,
  ACTIVE,
  NAMED,
  PRIORITY,
  type Harness,
} from "./structured-filter-harness.js";

/**
 * What a client that validates arguments against `tools/list` sees for
 * `structured_query.filter`: the list form is published for sn_query and
 * not for sn_batch, both by reference to definitions that sit inside each
 * tool's own inputSchema, and a strict validator and the server agree.
 */

afterEach(closeHarnesses);

type Json = Record<string, unknown>;
interface Listed {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Json;
}

async function listed(connected: Harness): Promise<Map<string, Listed>> {
  const { tools } = await connected.client.listTools();
  return new Map(tools.map((tool) => [tool.name, tool as unknown as Listed]));
}

/** Every `$ref` string anywhere under `node`. */
function refsIn(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) refsIn(item, found);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else refsIn(value, found);
    }
  }
  return found;
}

/** Follow a local `#/definitions/<id>` reference inside one schema, or undefined. */
function resolve(root: Json, ref: string): Json | undefined {
  const match = /^#\/definitions\/([A-Za-z0-9_]+)$/u.exec(ref);
  const definitions = root.definitions as Record<string, Json> | undefined;
  return match === null ? undefined : definitions?.[match[1]!];
}

/** True when some branch a value of this schema may take is an array. */
function offersArray(root: Json, node: Json, seen = new Set<Json>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (node.type === "array") return true;
  if (typeof node.$ref === "string") {
    const target = resolve(root, node.$ref);
    return target !== undefined && offersArray(root, target, seen);
  }
  return ["anyOf", "oneOf", "allOf"].some((keyword) =>
    ((node[keyword] as Json[] | undefined) ?? []).some((branch) => offersArray(root, branch, seen))
  );
}

function filterOf(tool: Listed): Json {
  const properties = tool.inputSchema.properties as Record<string, Json>;
  return (properties.structured_query!.properties as Record<string, Json>).filter!;
}

/** An example as written in the advertised text, `{type:"x"}` style, as JSON. */
function parseExample(text: string): unknown {
  return JSON.parse(text.replace(/([{,])([a-z_]+):/g, '$1"$2":'));
}

/** The arguments each tool needs around a filter. */
function argumentsFor(tool: string, filter: unknown): Record<string, unknown> {
  return tool === "sn_batch"
    ? {
        profile: "p",
        table: "incident",
        action: "update",
        fields: { state: "2" },
        structured_query: { filter },
      }
    : { profile: "p", table: "incident", structured_query: { filter } };
}

describe("the published structured_query.filter schema", () => {
  it("gives sn_query an array option and sn_batch none", async () => {
    const tools = await listed(await harness());
    const query = tools.get("sn_query")!;
    const batch = tools.get("sn_batch")!;

    const queryFilter = filterOf(query);
    const options = queryFilter.anyOf as Json[];
    expect(options).toHaveLength(2);
    const list = options.find((option) => option.type === "array")!;
    expect(list).toMatchObject({ type: "array", minItems: 1, maxItems: 32 });
    expect((list.items as Json).$ref).toMatch(/^#\/definitions\//u);
    expect(options.find((option) => option.type !== "array")).toEqual({ $ref: (list.items as Json).$ref });
    expect(offersArray(query.inputSchema, queryFilter)).toBe(true);

    // The write tool has no array branch, however far its references are followed.
    expect(offersArray(batch.inputSchema, filterOf(batch))).toBe(false);
    expect(JSON.stringify(filterOf(batch))).not.toContain('"array"');
  });

  it("publishes each shared piece once, inside each tool's own schema", async () => {
    const tools = await listed(await harness());
    for (const name of ["sn_query", "sn_batch"]) {
      const schema = tools.get(name)!.inputSchema;
      expect(Object.keys(schema.definitions as Json).sort(), name).toEqual(["StructuredQueryCondition", "StructuredQueryFilter"]);
      const refs = refsIn(schema);
      expect(refs.length, name).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(resolve(schema, ref), `${name} ${ref}`).toBeDefined();
      }
      // Both pieces are used, and the leaf union is written out nowhere else.
      expect(new Set(refs), name).toEqual(new Set([
        "#/definitions/StructuredQueryCondition",
        "#/definitions/StructuredQueryFilter",
      ]));
      expect(JSON.stringify(schema).match(/"const":"equality"/gu), name).toHaveLength(1);
    }
  });

  it("leaves no reference unresolved in any tool, input or output", async () => {
    const tools = await listed(await harness());
    for (const tool of tools.values()) {
      const full = tool as unknown as { inputSchema: Json; outputSchema?: Json };
      for (const schema of [full.inputSchema, full.outputSchema]) {
        if (schema === undefined) continue;
        for (const ref of refsIn(schema)) {
          expect(resolve(schema, ref), `${tool.name} ${ref}`).toBeDefined();
        }
      }
    }
  });
});

describe("the advertised examples validate against the published schema", () => {
  async function examples() {
    const connected = await harness();
    const tools = await listed(connected);
    const queryText = String(tools.get("sn_query")!.description);
    const list = /Example: (\[.*\])$/u.exec(String(filterOf(tools.get("sn_query")!).description))?.[1];
    const single = /Example: (\{.*?\})\./u.exec(String(filterOf(tools.get("sn_batch")!).description))?.[1];
    const orForm = /OR: (\{type:"group".*?\})\./u.exec(queryText)?.[1];
    const inline = /structured_query=(\{filter:\[.*?\]\})/u.exec(queryText)?.[1];
    expect(list).toBeDefined();
    expect(single).toBeDefined();
    expect(orForm).toBeDefined();
    expect(inline).toBeDefined();
    const group = {
      ...(parseExample(orForm!.replace("[...]", "[]")) as Json),
      conditions: [parseExample(single!)],
    };
    return {
      connected,
      tools,
      list: parseExample(list!),
      single: parseExample(single!),
      group,
      inline: parseExample(inline!) as { filter: unknown },
    };
  }

  /** A strict validator: unknown keywords and unresolved references throw. */
  function validatorFor(tool: Listed) {
    return new Ajv({ strict: true, allErrors: true }).compile(tool.inputSchema);
  }

  it("accepts the list, single and group examples for sn_query", async () => {
    const { tools, list, single, group, inline } = await examples();
    const validate = validatorFor(tools.get("sn_query")!);
    for (const [label, filter] of [
      ["list", list],
      ["single", single],
      ["group", group],
      ["inline", inline.filter],
    ] as const) {
      expect(validate(argumentsFor("sn_query", filter)), `${label}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    // The tool description's whole structured_query is valid as written.
    expect(validate({ profile: "p", table: "incident", structured_query: inline })).toBe(true);
  });

  it("accepts the single and group examples for sn_batch, and refuses the list", async () => {
    const { tools, list, single, group } = await examples();
    const validate = validatorFor(tools.get("sn_batch")!);
    for (const [label, filter] of [
      ["single", single],
      ["group", group],
    ] as const) {
      expect(validate(argumentsFor("sn_batch", filter)), `${label}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    expect(validate(argumentsFor("sn_batch", list))).toBe(false);
    expect(validate(argumentsFor("sn_batch", [single]))).toBe(false);
  });

  it("is accepted by the server too, for every example", async () => {
    const { connected, list, single, group, inline } = await examples();
    for (const [name, filter] of [
      ["sn_query", list],
      ["sn_query", single],
      ["sn_query", group],
      ["sn_query", inline.filter],
      ["sn_batch", single],
      ["sn_batch", group],
    ] as const) {
      const result = await connected.client.callTool({ name, arguments: argumentsFor(name, filter) });
      expect(result.isError, `${name} ${JSON.stringify(filter)}`).toBeUndefined();
    }
  });
});

describe("a strict validator and the server agree on the published filter", () => {
  const BETWEEN = { type: "range", field: "priority", operator: "between", lower: 1, upper: 3 };
  const SET = { type: "set", field: "priority", operator: "in", values: [1, 2] };
  const NULLISH = { type: "null", field: "active", operator: "is_null" };
  const group = (operator: string, ...conditions: unknown[]) => ({ type: "group", operator, conditions });

  const valid: ReadonlyArray<readonly [string, unknown, { query: boolean; batch: boolean }]> = [
    ["one condition", ACTIVE, { query: true, batch: true }],
    ["between", BETWEEN, { query: true, batch: true }],
    ["set", SET, { query: true, batch: true }],
    ["null", NULLISH, { query: true, batch: true }],
    ["and group", group("and", ACTIVE, PRIORITY), { query: true, batch: true }],
    ["or group", group("or", ACTIVE, PRIORITY), { query: true, batch: true }],
    ["three levels", nested(3), { query: true, batch: true }],
    ["list of one", [ACTIVE], { query: true, batch: false }],
    ["list of two", [ACTIVE, PRIORITY], { query: true, batch: false }],
    ["list with groups", [ACTIVE, group("or", PRIORITY, NULLISH)], { query: true, batch: false }],
    ["list of one three-level group", [nested(3)], { query: true, batch: false }],
  ];
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ["empty list", []],
    ["list of 33", Array.from({ length: 33 }, () => ACTIVE)],
    ["empty object", {}],
    ["null", null],
    ["a string", "active=true"],
    ["a number", 7],
    ["unknown type", { ...ACTIVE, type: "like" }],
    ["bad operator", { ...ACTIVE, operator: "between" }],
    ["missing value", { type: "equality", field: "active", operator: "eq" }],
    ["extra key", { ...ACTIVE, extra: 1 }],
    ["bad field name", { ...ACTIVE, field: "1active" }],
    ["empty group", group("and")],
    ["bad group operator", group("xor", ACTIVE)],
    ["four levels", nested(4)],
    ["list holding a string", [ACTIVE, "x"]],
    ["list holding a list", [[ACTIVE]]],
    ["list holding a bad condition", [ACTIVE, { ...PRIORITY, operator: "contains" }]],
    ["list in a group", group("and", [ACTIVE, NAMED])],
  ];

  async function accepted(connected: Harness, name: string, filter: unknown): Promise<boolean> {
    try {
      const result = await connected.client.callTool({ name, arguments: argumentsFor(name, filter) });
      return result.isError !== true;
    } catch {
      return false;
    }
  }

  it("give the same verdict for real valid and invalid filters, on both tools", async () => {
    const connected = await harness();
    const tools = await listed(connected);
    const verdict = (name: string, filter: unknown) => {
      const validate = new Ajv({ strict: true }).compile(tools.get(name)!.inputSchema);
      return validate(argumentsFor(name, filter));
    };
    for (const [label, filter, expected] of valid) {
      expect(verdict("sn_query", filter), `ajv sn_query ${label}`).toBe(expected.query);
      expect(await accepted(connected, "sn_query", filter), `server sn_query ${label}`).toBe(expected.query);
      expect(verdict("sn_batch", filter), `ajv sn_batch ${label}`).toBe(expected.batch);
      expect(await accepted(connected, "sn_batch", filter), `server sn_batch ${label}`).toBe(expected.batch);
    }
    for (const [label, filter] of invalid) {
      for (const name of ["sn_query", "sn_batch"]) {
        expect(verdict(name, filter), `ajv ${name} ${label}`).toBe(false);
        expect(await accepted(connected, name, filter), `server ${name} ${label}`).toBe(false);
      }
    }
  }, 120_000);

  it("differ only where the published schema cannot say what the server checks", async () => {
    const connected = await harness();
    const tools = await listed(connected);
    const validate = new Ajv({ strict: true }).compile(tools.get("sn_query")!.inputSchema);
    // A list of two or more takes one group level, which a JSON Schema for the
    // element cannot subtract: the schema accepts, the server refuses.
    const deepList = [PRIORITY, nested(3)];
    expect(validate(argumentsFor("sn_query", deepList))).toBe(true);
    expect(await accepted(connected, "sn_query", deepList)).toBe(false);
    // The server trims and lowercases a field name before its pattern: the
    // schema, which describes the text as sent, is the stricter of the two.
    const shouting = { ...ACTIVE, field: "Active" };
    expect(validate(argumentsFor("sn_query", shouting))).toBe(false);
    expect(await accepted(connected, "sn_query", shouting)).toBe(true);
  });
});
