import { afterEach, describe, expect, it } from "vitest";

import {
  compileStructuredQuery,
  MAX_STRUCTURED_QUERY_NESTING,
  STRUCTURED_FILTER_EMPTY_LIST_MESSAGE,
  STRUCTURED_FILTER_ERROR_MESSAGE,
  STRUCTURED_FILTER_LIST_ERROR_MESSAGE,
  STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE,
  structuredQueryReadSchema,
  structuredQuerySchema,
} from "../src/structured-query.js";
import {
  ACTIVE,
  NAMED,
  PRIORITY,
  callError,
  closeHarnesses,
  group,
  harness,
  lastQuery,
  nested,
} from "./structured-filter-harness.js";

afterEach(closeHarnesses);

async function query(
  connected: Awaited<ReturnType<typeof harness>>,
  table: string,
  filter: unknown
) {
  return connected.client.callTool({
    name: "sn_query",
    arguments: { profile: "p", table, structured_query: { filter } },
  });
}

describe("sn_query reads a list filter as an implicit AND", () => {
  it("reads a one-element list as that element", async () => {
    const connected = await harness();
    expect((await query(connected, "incident", [ACTIVE])).isError).toBeUndefined();
    const listQuery = lastQuery(connected);
    expect((await query(connected, "incident", ACTIVE)).isError).toBeUndefined();
    expect(listQuery).toBe(lastQuery(connected));
    expect(listQuery).toContain("active=true");
  });

  it("reads a multi-element list as the explicit and group", async () => {
    const connected = await harness();
    expect((await query(connected, "sys_script_include", [ACTIVE, NAMED])).isError).toBeUndefined();
    const listQuery = lastQuery(connected);
    expect(
      (await query(connected, "sys_script_include", group("and", ACTIVE, NAMED))).isError
    ).toBeUndefined();
    expect(listQuery).toBe(lastQuery(connected));
    expect(listQuery).toContain("active=true^nameLIKEfleet");
  });

  it("keeps a group inside the list, and the wrapper takes one level", async () => {
    const connected = await harness();
    // The limit is 3 group levels: the list is level 1, so a 2-level group fits.
    expect((await query(connected, "incident", [PRIORITY, nested(2)])).isError).toBeUndefined();
    expect(lastQuery(connected)).toContain("priority<=2");
  });

  it("a one-element list adds no level: a 3-level group alone still fits", async () => {
    const connected = await harness();
    expect((await query(connected, "incident", [nested(3)])).isError).toBeUndefined();
  });

  it("rejects a list that would need one level too many, naming the depth limit", async () => {
    const connected = await harness();
    const message = await callError(connected, "sn_query", {
      table: "incident",
      structured_query: { filter: [PRIORITY, nested(3)] },
    });
    // The diagnosis names the group that is one level too deep and how a
    // list counts; the shape message stays the fallback.
    expect(message).toContain("filter[1].conditions[0].conditions[0]: groups nest at most");
    expect(message).toContain(`at most ${MAX_STRUCTURED_QUERY_NESTING} levels`);
    expect(message).toContain("counts as one level");
    // The same tree written as an explicit 4-level group is refused alike.
    const explicit = await callError(connected, "sn_query", {
      table: "incident",
      structured_query: { filter: group("and", PRIORITY, nested(3)) },
    });
    expect(explicit).toContain(`at most ${MAX_STRUCTURED_QUERY_NESTING} levels`);
    expect(connected.getWithMeta).not.toHaveBeenCalled();
  });

  it("rejects an empty list with its own clear message", async () => {
    const connected = await harness();
    const message = await callError(connected, "sn_query", {
      table: "incident",
      structured_query: { filter: [] },
    });
    expect(message).toContain(STRUCTURED_FILTER_EMPTY_LIST_MESSAGE);
    expect(message).toContain("at structured_query.filter");
    expect(connected.getWithMeta).not.toHaveBeenCalled();
  });

  it("does not read a list nested inside a group or another list", async () => {
    const connected = await harness();
    const inGroup = await callError(connected, "sn_query", {
      table: "incident",
      structured_query: { filter: group("and", [ACTIVE, NAMED]) },
    });
    expect(inGroup).toContain("filter.conditions[0]: a condition must be one object, not a list");
    const inList = await callError(connected, "sn_query", {
      table: "incident",
      structured_query: { filter: [[ACTIVE, NAMED]] },
    });
    expect(inList).toContain(STRUCTURED_FILTER_LIST_ERROR_MESSAGE);
  });

  it("applies the structural bounds to the list's elements", () => {
    const leaves = (count: number) => ({ filter: Array.from({ length: count }, () => ACTIVE) });
    expect(structuredQueryReadSchema.safeParse(leaves(32)).success).toBe(true);
    expect(structuredQueryReadSchema.safeParse(leaves(33)).success).toBe(false);
  });

  it("counts the groups and leaves inside a list before any union runs", () => {
    // 32 elements of 4 leaves each is 128 leaves, past the 64-leaf bound. The
    // bound must hold for a list as it does for one group, or the elements
    // would reach the union walk uncounted.
    const hostile = { filter: Array.from({ length: 32 }, () => nested(3)) };
    const started = performance.now();
    const parsed = structuredQueryReadSchema.safeParse(hostile);
    expect(performance.now() - started).toBeLessThan(250);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ message: STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE }),
    ]);
  });

  it("still authorizes every field of a list against the readable set", () => {
    const parsed = structuredQueryReadSchema.parse({
      filter: [ACTIVE, { type: "equality", field: "u_other", operator: "eq", value: "x" }],
    });
    expect(() => compileStructuredQuery(parsed, ["sys_id", "active"])).toThrow();
    expect(compileStructuredQuery(parsed, ["sys_id", "active", "u_other"]).encodedQuery).toBe(
      "active=true^u_other=x"
    );
  });
});

describe("a fault inside a list element keeps its own message", () => {
  // The texts below are what 53d39ea (before the list was published) answers
  // for the same fault in the same list. A fault that is only a check (a bad
  // field name, a control character, an over-long value) used to be reported
  // by the filter's own union; the list branch must not turn it into the
  // generic list message. Only the path differs: base pointed into the group
  // it wrapped the list in (`filter.conditions[1].field`), the message now
  // names the caller's own position (`filter[1].field`).
  const FIELD = "field must be a canonical ServiceNow field name";
  const CONTROL = "query values must not contain control or separator characters";
  const LONG = "Too big: expected string to have <=512 characters";
  const OPERATOR =
    'a "text" condition needs operator one of contains, not_contains, starts_with, ends_with';
  const faults: ReadonlyArray<readonly [string, unknown, string, string | undefined]> = [
    ["bad field name", { ...ACTIVE, field: "1bad" }, FIELD, "field"],
    ["control character", { ...NAMED, value: "a\u0001b" }, CONTROL, "value"],
    ["over-long value", { ...NAMED, value: "x".repeat(600) }, LONG, "value"],
    ["bad operator", { ...NAMED, operator: "between" }, OPERATOR, undefined],
  ];
  const GENERIC = "treated as AND";

  for (const [label, fault, text, key] of faults) {
    it(`names ${label} at the caller's position, as base did`, async () => {
      const connected = await harness();
      const where = async (filter: unknown) =>
        callError(connected, "sn_query", { table: "incident", structured_query: { filter } });
      const positions: ReadonlyArray<readonly [string, unknown, string]> = [
        ["a one-element list", [fault], "filter[0]"],
        ["the second of a list", [ACTIVE, fault], "filter[1]"],
        ["a group inside a list", [ACTIVE, group("or", ACTIVE, fault)], "filter[1].conditions[1]"],
      ];
      for (const [place, filter, path] of positions) {
        const message = await where(filter);
        expect(message, place).toContain(text);
        expect(message, place).not.toContain(GENERIC);
        // A check names its own key; a walk message leads with the position.
        expect(message, place).toContain(
          key === undefined ? `${path}: ` : `structured_query.${path}.${key}`
        );
        // Fixed text only: nothing the caller sent comes back.
        expect(message, place).not.toContain("1bad");
        expect(message, place).not.toContain("\u0001");
        expect(message, place).not.toContain("x".repeat(20));
      }
      expect(connected.getWithMeta).not.toHaveBeenCalled();
    });
  }

  it("says the same for the fault alone, not in a list", async () => {
    const connected = await harness();
    for (const [label, fault, text] of faults) {
      const message = await callError(connected, "sn_query", {
        table: "incident",
        structured_query: { filter: fault },
      });
      expect(message, label).toContain(text);
    }
  });
});

describe("sn_batch keeps its write filter strict", () => {
  it("rejects a list filter through the server, before any lookup or write", async () => {
    const connected = await harness();
    // Every way the tool can reach the instance: reads (`get`, `getWithMeta`)
    // and writes (`post`, `patch`, `put`, `delete`).
    const reaches = () =>
      [
        connected.get,
        connected.getWithMeta,
        connected.post,
        connected.patch,
        connected.put,
        connected.delete,
      ].reduce((sum, method) => sum + method.mock.calls.length, 0);
    let rejected = 0;
    for (const action of ["update", "delete"] as const) {
      for (const confirm of [undefined, true]) {
        for (const filter of [[ACTIVE], [ACTIVE, NAMED], []]) {
          const message = await callError(connected, "sn_batch", {
            table: "incident",
            action,
            ...(action === "update" ? { fields: { state: "2" } } : {}),
            ...(confirm === undefined ? {} : { confirm }),
            structured_query: { filter },
          });
          expect(message).toContain(STRUCTURED_FILTER_ERROR_MESSAGE);
          rejected += 1;
        }
      }
    }
    expect(rejected).toBe(12);
    expect(reaches()).toBe(0);

    // The control: the same call with one object does reach the instance
    // (a lookup through `get`), so a count of zero above means something.
    const accepted = await connected.client.callTool({
      name: "sn_batch",
      arguments: {
        profile: "p",
        table: "incident",
        action: "update",
        fields: { state: "2" },
        structured_query: { filter: ACTIVE },
      },
    });
    expect(accepted.isError).toBeUndefined();
    expect(reaches()).toBeGreaterThan(0);
  });

  it("keeps the shared strict schema from reading a list", () => {
    expect(structuredQuerySchema.safeParse({ filter: [ACTIVE] }).success).toBe(false);
    expect(structuredQuerySchema.safeParse({ filter: ACTIVE }).success).toBe(true);
  });

  it("never tells an sn_batch client that a list works", async () => {
    const connected = await harness();
    const { tools } = await connected.client.listTools();
    const advertised = JSON.stringify(tools.find((tool) => tool.name === "sn_batch"));
    expect(advertised).not.toContain("treated as AND");
    expect(advertised).not.toContain("implicit");
    expect(advertised).not.toMatch(/list (means|read as) AND/);
    // The advertised text for sn_query is checked in filter-examples.test.ts.
  });
});
