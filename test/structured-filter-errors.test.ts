import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_STRUCTURED_QUERY_NESTING,
  STRUCTURED_FILTER_ERROR_MESSAGE,
  STRUCTURED_FILTER_LIST_ERROR_MESSAGE,
  structuredQueryFilterSchema,
} from "../src/structured-query.js";
import { ACTIVE, NAMED, callError, closeHarnesses, group, harness, nested } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

describe("structured_query.filter errors reach the client", () => {
  it("carries the custom message through the real MCP server for each kind of mistake", async () => {
    const connected = await harness();
    const mistakes: Record<string, unknown> = {
      "a list nested in a list": [[ACTIVE]],
      "a string": "active=true",
      "a number": 7,
    };
    for (const [label, filter] of Object.entries(mistakes)) {
      const message = await callError(connected, "sn_query", {
        table: "incident",
        structured_query: { filter },
      });
      expect(message, label).toContain(STRUCTURED_FILTER_LIST_ERROR_MESSAGE);
      expect(message, label).toContain("at structured_query.filter");
      expect(message, label).toContain("{type:'text', field:'name', operator:'contains', value:'fleet'}");
      expect(message, label).toContain("{type:'group', operator:'and', conditions:[...]}");
      expect(message, label).toContain(`${MAX_STRUCTURED_QUERY_NESTING} levels`);
      expect(message, label).not.toContain("Invalid input at");
    }
    expect(connected.getWithMeta).not.toHaveBeenCalled();
  });

  it("gives one message at the filter for a bad condition nested in a group", async () => {
    const connected = await harness();
    const message = await callError(connected, "sn_query", {
      table: "incident",
      structured_query: { filter: group("and", ACTIVE, group("or", NAMED, { type: "text", field: "name" })) },
    });
    // The outer union reports one issue at the filter; nested unions never surface.
    expect(message).toContain(
      'filter.conditions[1].conditions[1]: a "text" condition needs operator one of'
    );
    expect(message.match(/ at structured_query\./g)).toHaveLength(1);
    expect(message).toContain("at structured_query.filter");
  });

  it("names the depth limit when a filter nests too deep", async () => {
    const connected = await harness();
    let tooDeep: unknown = ACTIVE;
    for (let level = 0; level <= MAX_STRUCTURED_QUERY_NESTING; level += 1) {
      tooDeep = group("and", tooDeep, NAMED);
    }
    const message = await callError(connected, "sn_query", {
      table: "incident",
      structured_query: { filter: tooDeep },
    });
    expect(message).toContain(`groups nest at most ${MAX_STRUCTURED_QUERY_NESTING} levels deep`);
  });

  it("tells sn_batch the filter is one object, with no list", async () => {
    const connected = await harness();
    const message = await callError(connected, "sn_batch", {
      table: "incident",
      action: "update",
      fields: { state: "2" },
      structured_query: { filter: "active=true" },
    });
    expect(message).toContain(STRUCTURED_FILTER_ERROR_MESSAGE);
    expect(message).not.toContain("treated as AND");
    expect(connected.post).not.toHaveBeenCalled();
  });

  it("adds no error text to what tools/list advertises", async () => {
    const connected = await harness();
    const { tools } = await connected.client.listTools();
    for (const name of ["sn_query", "sn_batch"]) {
      const advertised = JSON.stringify(tools.find((tool) => tool.name === name));
      // The advertised `filter` text is the short example from #19; the longer
      // error message, with its depth limit and group form, is never advertised.
      expect(advertised).not.toContain("levels deep");
      expect(advertised).not.toContain("Combine");
    }
    // The custom text is an error message only; the schema itself still rejects.
    expect(structuredQueryFilterSchema.safeParse("x").success).toBe(false);
  });
});

const TEXT_OPERATORS = "contains, not_contains, starts_with, ends_with";
const BAD_TEXT = { type: "text", field: "name", operator: "like", value: "fleet" };

async function queryError(
  connected: Awaited<ReturnType<typeof harness>>,
  filter: unknown,
  tool: "sn_query" | "sn_batch" = "sn_query"
): Promise<string> {
  const message = await callError(
    connected,
    tool,
    tool === "sn_query"
      ? { table: "incident", structured_query: { filter } }
      : { table: "incident", action: "update", fields: { state: "2" }, structured_query: { filter } }
  );
  expect(connected.getWithMeta).not.toHaveBeenCalled();
  expect(connected.post).not.toHaveBeenCalled();
  return message;
}

describe("structured_query.filter errors name the mistake", () => {
  it("names a bad operator, with the valid operators of that condition type", async () => {
    const connected = await harness();
    const cases: Array<[string, unknown, string]> = [
      ["equality", { ...ACTIVE, operator: "=" }, 'a "equality" condition needs operator one of eq, neq'],
      ["set", { type: "set", field: "state", operator: "any", values: [1] }, 'a "set" condition needs operator one of in, not_in'],
      ["range", { ...ACTIVE, type: "range", operator: "like" }, 'a "range" condition needs operator one of gt, gte, lt, lte, between'],
      ["text", BAD_TEXT, `a "text" condition needs operator one of ${TEXT_OPERATORS}`],
      ["null", { type: "null", field: "name", operator: "empty" }, 'a "null" condition needs operator one of is_null, is_not_null'],
      ["no operator", { type: "text", field: "name", value: "x" }, `a "text" condition needs operator one of ${TEXT_OPERATORS}`],
    ];
    for (const [label, filter, expected] of cases) {
      const message = await queryError(connected, filter);
      expect(message, label).toContain(`${expected}.`);
      // A top-level condition needs no path; the SDK already says where.
      expect(message, label).not.toContain("filter:");
      expect(message, label).toContain("Example: {type:'text', field:'name'");
      expect(message, label).toContain("at structured_query.filter");
      expect(message, label).not.toContain("must be one condition or group");
    }
  });

  it("names the condition's path when the bad operator is nested in a group", async () => {
    const connected = await harness();
    const second = await queryError(connected, group("and", ACTIVE, BAD_TEXT));
    expect(second).toContain(
      `filter.conditions[1]: a "text" condition needs operator one of ${TEXT_OPERATORS}.`
    );
    const deeper = await queryError(connected, group("or", NAMED, group("and", ACTIVE, group("or", NAMED, BAD_TEXT))));
    expect(deeper).toContain(
      `filter.conditions[1].conditions[1].conditions[1]: a "text" condition needs operator one of ${TEXT_OPERATORS}.`
    );
  });

  it("names the caller's own position for a list filter", async () => {
    const connected = await harness();
    expect(await queryError(connected, [ACTIVE, BAD_TEXT])).toContain(
      `filter[1]: a "text" condition needs operator one of ${TEXT_OPERATORS}.`
    );
    expect(await queryError(connected, [BAD_TEXT])).toContain(
      `filter[0]: a "text" condition needs operator one of ${TEXT_OPERATORS}.`
    );
    expect(await queryError(connected, [NAMED, group("or", ACTIVE, BAD_TEXT)])).toContain(
      `filter[1].conditions[1]: a "text" condition needs operator one of ${TEXT_OPERATORS}.`
    );
  });

  it("names a bad type, with the known types and without quoting what was sent", async () => {
    const connected = await harness();
    const known = "type must be one of equality, set, range, text, null, group";
    for (const filter of [
      { ...ACTIVE, type: "equals" },
      { field: "active", operator: "eq", value: true },
      { ...ACTIVE, type: 7 },
    ]) {
      expect(await queryError(connected, filter)).toContain(`${known}.`);
    }
    expect(await queryError(connected, group("and", ACTIVE, { ...NAMED, type: "like" }))).toContain(
      `filter.conditions[1]: ${known}.`
    );
  });

  it("names a bad group", async () => {
    const connected = await harness();
    const need = "a group needs operator and or or, and a non-empty conditions list";
    expect(await queryError(connected, { type: "group", operator: "xor", conditions: [ACTIVE] })).toContain(
      `${need}.`
    );
    expect(await queryError(connected, { type: "group", operator: "and", conditions: "x" })).toContain(
      `${need}.`
    );
    expect(await queryError(connected, { type: "group", conditions: [ACTIVE] })).toContain(`${need}.`);
    expect(
      await queryError(connected, group("and", ACTIVE, { type: "group", operator: "nor", conditions: [NAMED] }))
    ).toContain(`filter.conditions[1]: ${need}.`);
    expect(await queryError(connected, group("and", ACTIVE, "name=fleet"))).toContain(
      "filter.conditions[1]: a condition must be an object with a type."
    );
  });

  it("names missing keys and values of the wrong kind", async () => {
    const connected = await harness();
    expect(await queryError(connected, { type: "equality", field: "active", operator: "eq" })).toContain(
      'a "equality" condition needs field and value.'
    );
    expect(
      await queryError(connected, { type: "range", field: "priority", operator: "between", lower: 1 })
    ).toContain('a "range" condition needs field, lower and upper.');
    expect(await queryError(connected, { type: "null", operator: "is_null" })).toContain(
      'a "null" condition needs field.'
    );
    expect(await queryError(connected, { ...ACTIVE, value: { nested: true } })).toContain(
      'a "equality" condition needs value as a string, number or boolean.'
    );
    expect(await queryError(connected, { ...NAMED, value: 5 })).toContain(
      'a "text" condition needs value as a string.'
    );
    expect(
      await queryError(connected, { type: "set", field: "state", operator: "in", values: [{}] })
    ).toContain('a "set" condition needs values as a list of 1 to 20 strings, numbers or booleans.');
  });

  it("names the depth limit and the group that is too deep", async () => {
    const connected = await harness();
    const message = await queryError(connected, nested(MAX_STRUCTURED_QUERY_NESTING + 1));
    expect(message).toContain(
      `filter.conditions[0].conditions[0].conditions[0]: groups nest at most ${MAX_STRUCTURED_QUERY_NESTING} levels deep.`
    );
  });

  it("keeps the shape message for what it cannot diagnose", async () => {
    const connected = await harness();
    for (const filter of ["active=true", 7, [[ACTIVE]], [[ACTIVE, NAMED]]]) {
      const message = await queryError(connected, filter);
      expect(message).toContain(STRUCTURED_FILTER_LIST_ERROR_MESSAGE);
    }
    expect(await queryError(connected, "active=true", "sn_batch")).toContain(
      STRUCTURED_FILTER_ERROR_MESSAGE
    );
  });

  it("never repeats a string the caller sent, however hostile", async () => {
    const connected = await harness();
    const marker = "ZZMARK\u0007<script>alert(1)</script>${x}%s'\"\\";
    const long = `${marker}${"A".repeat(5_000)}`;
    const hostile: unknown[] = [
      { type: "text", field: "name", operator: marker, value: "x" },
      { type: "text", field: "name", operator: long, value: "x" },
      { type: marker, field: "name", operator: "eq", value: "x" },
      { type: long },
      { type: "group", operator: marker, conditions: [ACTIVE] },
      { type: "group", operator: "and", conditions: marker },
      { type: "equality", field: "active", operator: "eq", value: { [marker]: marker } },
      { type: "equality", field: marker, operator: "eq" },
      group("and", ACTIVE, { type: "text", field: "name", operator: marker, value: marker }),
      group("or", group("and", NAMED, { type: marker })),
      [ACTIVE, { type: "null", field: "name", operator: marker }],
      [{ type: "set", field: "state", operator: "in", values: [marker, {}] }],
      group("and", ACTIVE, marker),
      { [marker]: marker },
    ];
    for (const tool of ["sn_query", "sn_batch"] as const) {
      for (const [index, filter] of hostile.entries()) {
        const list = Array.isArray(filter);
        if (list && tool === "sn_batch") continue;
        const message = await queryError(connected, filter, tool);
        const label = `${tool} #${index}`;
        expect(message, label).not.toContain("ZZMARK");
        expect(message, label).not.toContain("script");
        expect(message, label).not.toContain("AAAA");
        expect(message.length, label).toBeLessThan(900);
      }
    }
  });

  it("tells sn_batch the same mistake, and still refuses a list", async () => {
    const connected = await harness();
    const message = await queryError(connected, group("and", ACTIVE, BAD_TEXT), "sn_batch");
    expect(message).toContain(
      `filter.conditions[1]: a "text" condition needs operator one of ${TEXT_OPERATORS}.`
    );
    const list = await queryError(connected, [ACTIVE, NAMED], "sn_batch");
    expect(list).toContain(STRUCTURED_FILTER_ERROR_MESSAGE);
    expect(list).toContain("A list is not accepted here.");
    expect(list).not.toContain("treated as AND");
  });

  it("adds nothing to what tools/list advertises", async () => {
    const connected = await harness();
    const { tools } = await connected.client.listTools();
    for (const name of ["sn_query", "sn_batch"]) {
      const advertised = JSON.stringify(tools.find((tool) => tool.name === name));
      for (const text of ["needs operator", "type must be one of", "a group needs"]) {
        expect(advertised, `${name}: ${text}`).not.toContain(text);
      }
    }
  });
});
