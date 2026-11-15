import { afterEach, describe, expect, it } from "vitest";

import { callError, closeHarnesses, harness, type Harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

/**
 * sn_codesearch through the registered server, so the access preflight, the
 * field policy and the envelope run as they do for a client. The ServiceNow
 * client is a stub that records every read.
 */

interface Read {
  readonly path: string;
  readonly params: Record<string, string>;
}

function reads(connected: Harness): Read[] {
  return (connected.get.mock.calls as unknown as Array<[string, Record<string, string>]>).map(
    ([path, params]) => ({ path, params })
  );
}

async function search(connected: Harness, args: Record<string, unknown>) {
  const result = await connected.client.callTool({
    name: "sn_codesearch",
    arguments: { profile: "p", ...args },
  });
  expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
  return result.structuredContent as unknown as {
    data: { results: Array<Record<string, unknown>>; warnings?: string[] };
    metadata: {
      pagination: { has_more: boolean; next_offset?: number; returned: number };
      truncation: { truncated: boolean };
    };
  };
}

function id(index: number): string {
  return index.toString(16).padStart(32, "0");
}

describe("the search query orders by sys_id", () => {
  it("puts ORDERBYsys_id in the encoded query and sends no sysparm_orderby", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({ result: [] });
    await search(connected, { search_term: "needle", table: "sys_script_include" });
    const [read] = reads(connected);
    expect(read!.params.sysparm_query).toBe("scriptLIKEneedle^ORDERBYsys_id");
    expect(read!.params).not.toHaveProperty("sysparm_orderby");
  });
});

describe("searching a field the projection already holds", () => {
  it.each([
    ["name", "nameLIKEneedle^ORDERBYsys_id", "sys_id,name"],
    ["sys_id", "sys_idLIKEneedle^ORDERBYsys_id", "sys_id,name"],
    ["script", "scriptLIKEneedle^ORDERBYsys_id", "sys_id,name,script"],
  ])("accepts field %s and lists each projected field once", async (field, query, fields) => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({
      result: [{ sys_id: id(1), name: "ValueNeedleHere", script: "var needle = 1;" }],
    });
    const { data } = await search(connected, { search_term: "needle", table: "sys_script_include", field });
    const [read] = reads(connected);
    expect(read!.params.sysparm_query).toBe(query);
    expect(read!.params.sysparm_fields).toBe(fields);
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({ table: "sys_script_include", sys_id: id(1) });
  });

  it("searches the name column and shows the name as the snippet", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({ result: [{ sys_id: id(1), name: "FleetNeedleUtil" }] });
    const { data } = await search(connected, { search_term: "needle", table: "sys_script", field: "name" });
    expect(data.results[0]).toMatchObject({ name: "FleetNeedleUtil", snippet: "FleetNeedleUtil" });
  });

  it.each(["name,script", "script,script", "sys_id,name"])(
    "refuses a list of fields (%s) before any request",
    async (field) => {
      const connected = await harness([], { codeTables: true });
      const message = await callError(connected, "sn_codesearch", {
        search_term: "needle",
        table: "sys_script_include",
        field,
      });
      expect(message).toContain("denied by policy");
      expect(connected.get).not.toHaveBeenCalled();
    }
  );

  it("still refuses a sensitive or unknown-to-policy field, and never echoes it", async () => {
    const connected = await harness([], { codeTables: true });
    const message = await callError(connected, "sn_codesearch", {
      search_term: "needle",
      table: "sys_script_include",
      field: "user_password",
    });
    expect(message).toContain("denied by policy");
    expect(message).not.toContain("user_password");
    expect(connected.get).not.toHaveBeenCalled();
  });
});
