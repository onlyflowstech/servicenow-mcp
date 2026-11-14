import { afterEach, describe, expect, it } from "vitest";

import {
  STRUCTURED_FILTER_DESCRIPTION,
  STRUCTURED_FILTER_LIST_DESCRIPTION,
} from "../src/structured-query.js";
import { callError, closeHarnesses, harness, lastQuery } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

/** An example as written in the advertised text, `{type:"x"}` style, as JSON. */
function parseExample(text: string): unknown {
  return JSON.parse(text.replace(/([{,])([a-z_]+):/g, '$1"$2":'));
}

async function listed(name: string) {
  const connected = await harness();
  const { tools } = await connected.client.listTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`${name} is not listed`);
  type Property = { properties?: Record<string, Record<string, unknown> | undefined> };
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, Property | undefined>;
  return {
    connected,
    description: tool.description ?? "",
    filter: properties.structured_query?.properties?.filter,
  };
}

describe("working filter examples in tools/list (#19)", () => {
  it("sn_query's filter says a list is read as AND and shows a working example", async () => {
    const { connected, filter } = await listed("sn_query");
    expect(filter?.description).toBe(STRUCTURED_FILTER_LIST_DESCRIPTION);
    expect(filter?.description).toContain("a list read as AND");
    const example = /Example: (\[.*\])$/.exec(String(filter?.description))?.[1];
    expect(example).toBeDefined();
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "p", table: "sys_script_include", structured_query: { filter: parseExample(example!) } },
    });
    expect(result.isError).toBeUndefined();
    expect(lastQuery(connected)).toContain("active=true^nameLIKEfleet");
  });

  it("sn_query's tool description shows a working structured_query and the OR form", async () => {
    const { connected, description } = await listed("sn_query");
    const example = /structured_query=(\{filter:\[.*?\]\})/.exec(description)?.[1];
    expect(example).toBeDefined();
    expect(description).toContain("a list means AND");
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "p", table: "sys_script_include", structured_query: parseExample(example!) },
    });
    expect(result.isError).toBeUndefined();
    expect(lastQuery(connected)).toContain("active=true^nameLIKEfleet");
    const orForm = /OR: (\{type:"group".*?\})\./.exec(description)?.[1];
    expect(orForm).toBeDefined();
    const conditions = [parseExample('{type:"equality",field:"active",operator:"eq",value:true}')];
    const group = { ...(parseExample(orForm!.replace("[...]", "[]")) as object), conditions };
    const grouped = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "p", table: "incident", structured_query: { filter: group } },
    });
    expect(grouped.isError).toBeUndefined();
  });

  it("sn_batch's filter never offers a list, and its example works", async () => {
    const { connected, description, filter } = await listed("sn_batch");
    expect(filter?.description).toBe(STRUCTURED_FILTER_DESCRIPTION);
    expect(filter?.description).toContain("A list is not accepted");
    expect(JSON.stringify(filter)).not.toMatch(/list (means|read as) AND/);
    expect(description).not.toMatch(/list|AND/);
    const example = /Example: (\{.*?\})\./.exec(String(filter?.description))?.[1];
    expect(example).toBeDefined();
    const dryRun = await connected.client.callTool({
      name: "sn_batch",
      arguments: {
        profile: "p",
        table: "incident",
        action: "update",
        fields: { state: "2" },
        structured_query: { filter: parseExample(example!) },
      },
    });
    expect(dryRun.isError).toBeUndefined();
    // The same list that sn_query reads is still refused here, as the text says.
    const message = await callError(connected, "sn_batch", {
      table: "incident",
      action: "update",
      fields: { state: "2" },
      structured_query: { filter: [parseExample(example!)] },
    });
    expect(message).toContain("filter must be one condition or group object");
  });
});

describe("tools/list size ledger (#19)", () => {
  // Sizes of each entry as the client receives it, in characters of JSON.
  // A change here is a change in what every client pays for on every session:
  // update the numbers on purpose, and say why in the commit.
  it("keeps every tool entry at its recorded size", async () => {
    const connected = await harness();
    const { tools } = await connected.client.listTools();
    const sizes = Object.fromEntries(
      tools.map((tool) => [tool.name, JSON.stringify(tool).length])
    );
    const total = Object.values(sizes).reduce((sum, size) => sum + size, 0);
    expect({ total, ...sizes }).toMatchInlineSnapshot(`
      {
        "sn_aggregate": 3876,
        "sn_atf": 4401,
        "sn_atf_author": 5728,
        "sn_atf_readiness": 3641,
        "sn_atf_results": 13494,
        "sn_atf_run": 8273,
        "sn_attach": 4771,
        "sn_batch": 14896,
        "sn_codesearch": 3736,
        "sn_create": 3707,
        "sn_delete": 3373,
        "sn_discover": 3554,
        "sn_flow_view": 14943,
        "sn_get": 4765,
        "sn_health": 3208,
        "sn_incident_add_comment": 3361,
        "sn_incident_add_work_note": 3359,
        "sn_nl": 3669,
        "sn_profile": 3380,
        "sn_query": 16660,
        "sn_relationships": 4373,
        "sn_schema": 3599,
        "sn_syslog": 4324,
        "sn_update": 3742,
        "total": 142833,
      }
    `);
  });
});
