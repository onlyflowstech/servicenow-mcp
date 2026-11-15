import { afterEach, describe, expect, it } from "vitest";

import { fakeInstance, scriptWith, sysId } from "./code-search-fake.js";
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
      pagination: { has_more: boolean; next_offset?: number; returned: number; order_by?: string[] };
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

describe("the snippet", () => {
  const body = `${"// padding line\n".repeat(60)}var found = new GlideRecord('needle_table');\n${"// more padding\n".repeat(60)}`;

  it("shows the text around the first match, about 200 characters, with its line", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({ result: [{ sys_id: id(1), name: "Fleet", script: body }] });
    const { data } = await search(connected, { search_term: "GlideRecord", table: "sys_script_include" });
    const row = data.results[0]!;
    const snippet = String(row.snippet);
    expect(snippet).toContain("new GlideRecord('needle_table')");
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet.length).toBe(200 + 6);
    expect(row.line).toBe(61);
  });

  it("matches the term as the query sent it, with the caret removed", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({ result: [{ sys_id: id(1), name: "N", script: "a ab c" }] });
    const { data } = await search(connected, { search_term: "a^b", table: "sys_script_include" });
    expect(reads(connected)[0]!.params.sysparm_query).toBe("scriptLIKEab^ORDERBYsys_id");
    expect(data.results[0]).toMatchObject({ snippet: "a ab c", line: 1 });
  });

  it("is the head, with no line, when the term is not found in the text", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({ result: [{ sys_id: id(1), name: "N", script: "caf\u00e9 only" }] });
    const { data } = await search(connected, { search_term: "cafe", table: "sys_script_include" });
    expect(data.results[0]).toMatchObject({ snippet: "caf\u00e9 only" });
    expect(data.results[0]).not.toHaveProperty("line");
  });

  it("is empty for a row with no body", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({ result: [{ sys_id: id(1), name: "N", script: "" }] });
    const { data } = await search(connected, { search_term: "x", table: "sys_script_include" });
    expect(data.results[0]).toMatchObject({ snippet: "" });
  });
});

describe("paging through the server", () => {
  const order = ["sys_script_include", "sys_script", "sys_ui_script", "sys_script_client", "sys_ws_operation"];

  function instance(perTable: number) {
    return fakeInstance(
      Object.fromEntries(
        order.map((table, salt) => [
          table,
          Array.from({ length: perTable }, (_, index) => ({
            sys_id: sysId(index, salt),
            name: `${table}-${index}`,
            script: scriptWith("needle", 300),
            operation_script: scriptWith("needle", 300),
          })),
        ])
      )
    );
  }

  it("says where the next page starts, and the order is interleaved across tables", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockImplementation(instance(30).get as never);
    const first = await search(connected, { search_term: "needle", limit: 20 });
    expect(first.data.results).toHaveLength(20);
    expect(first.data.results.slice(0, 5).map((row) => row.table)).toEqual(order);
    expect(first.metadata.pagination).toMatchObject({ has_more: true, next_offset: 20, returned: 20 });
    expect(first.metadata.pagination).toMatchObject({ order_by: ["round", "table", "sys_id"] });

    const second = await search(connected, { search_term: "needle", limit: 20, offset: 20 });
    const seen = new Set(
      [...first.data.results, ...second.data.results].map((row) => `${row.table}:${row.sys_id}`)
    );
    expect(seen.size).toBe(40);
  });

  it("orders a one-table search by sys_id alone", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockImplementation(instance(30).get as never);
    const page = await search(connected, { search_term: "needle", table: "sys_script", limit: 5 });
    expect(page.metadata.pagination).toMatchObject({ order_by: ["sys_id"] });
  });
});
