import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_STRUCTURED_QUERY_NESTING,
  STRUCTURED_FILTER_ERROR_MESSAGE,
  STRUCTURED_FILTER_LIST_ERROR_MESSAGE,
  structuredQueryFilterSchema,
} from "../src/structured-query.js";
import { ACTIVE, NAMED, callError, closeHarnesses, group, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

describe("structured_query.filter errors reach the client (#18)", () => {
  it("carries the custom message through the real MCP server for each kind of mistake", async () => {
    const connected = await harness();
    const mistakes: Record<string, unknown> = {
      "a list nested in a list": [[ACTIVE]],
      "a string": "active=true",
      "no type": { field: "active", operator: "eq", value: true },
      "a bad operator": { type: "equality", field: "active", operator: "=", value: true },
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
    expect(message).toContain(STRUCTURED_FILTER_LIST_ERROR_MESSAGE);
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

  it("adds nothing to what tools/list advertises", async () => {
    const connected = await harness();
    const { tools } = await connected.client.listTools();
    for (const name of ["sn_query", "sn_batch"]) {
      const advertised = JSON.stringify(tools.find((tool) => tool.name === name));
      expect(advertised).not.toContain("fleet");
      expect(advertised).not.toContain("levels deep");
    }
    // The custom text is an error message only; the schema itself still rejects.
    expect(structuredQueryFilterSchema.safeParse("x").success).toBe(false);
  });
});
