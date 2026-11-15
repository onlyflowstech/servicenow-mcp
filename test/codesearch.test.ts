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

/** A profile that holds some code tables, each bound to the tools given. */
function grants(tools: Record<string, readonly string[]>) {
  return {
    readTables: Object.keys(tools),
    targets: Object.entries(tools).map(([table, bound]) => ({
      table,
      kind: "canonical" as const,
      tools: [...bound],
      closureComplete: true as const,
      relatedTables: [table],
    })),
  };
}

function fiveTables() {
  const tables = ["sys_script_include", "sys_script", "sys_ui_script", "sys_script_client", "sys_ws_operation"];
  return fakeInstance(
    Object.fromEntries(
      tables.map((table, salt) => [
        table,
        Array.from({ length: 4 }, (_, index) => ({
          sys_id: sysId(index, salt),
          name: `${table}-${index}`,
          script: scriptWith("needle", 120),
          operation_script: scriptWith("needle", 120),
        })),
      ])
    )
  );
}

describe("a search with no table over a partial grant", () => {
  it("searches the tables the profile holds for sn_codesearch and names the ones it left out", async () => {
    const connected = await harness([], {
      tableAccess: grants({
        sys_script_include: ["sn_codesearch"],
        sys_ui_script: ["sn_query", "sn_codesearch"],
        sys_script: ["sn_query"],
      }),
    });
    const fake = fiveTables();
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle", limit: 20 });

    // Only the two tables it may read were asked; sys_script is bound to sn_query only.
    expect(new Set(fake.reads.map((read) => read.table))).toEqual(
      new Set(["sys_script_include", "sys_ui_script"])
    );
    expect(data.results.map((row) => row.table)).toEqual([
      "sys_script_include",
      "sys_ui_script",
      "sys_script_include",
      "sys_ui_script",
      "sys_script_include",
      "sys_ui_script",
      "sys_script_include",
      "sys_ui_script",
    ]);
    expect(data.warnings).toEqual([
      "Not searched, because this profile does not allow sn_codesearch to read them: " +
        "sys_script, sys_script_client, sys_ws_operation. To include one, run " +
        "servicenow-mcp-setup grant --profile <profile> --read <table> --tools sn_codesearch.",
    ]);
  });

  it("says it in the singular for one table, and adds no warning when all are held", async () => {
    const all = {
      sys_script_include: ["sn_codesearch"],
      sys_script: ["sn_codesearch"],
      sys_ui_script: ["sn_codesearch"],
      sys_script_client: ["sn_codesearch"],
    };
    const connected = await harness([], { tableAccess: grants(all) });
    connected.get.mockImplementation(fiveTables().get as never);
    const four = await search(connected, { search_term: "needle" });
    expect(four.data.warnings).toEqual([
      "Not searched, because this profile does not allow sn_codesearch to read it: sys_ws_operation. " +
        "To include it, run servicenow-mcp-setup grant --profile <profile> --read <table> --tools sn_codesearch.",
    ]);

    const full = await harness([], { tableAccess: grants({ ...all, sys_ws_operation: ["sn_codesearch"] }) });
    full.get.mockImplementation(fiveTables().get as never);
    expect((await search(full, { search_term: "needle" })).data.warnings).toBeUndefined();
  });

  it("searches everything under a read wildcard, with no warning", async () => {
    const connected = await harness([], { tableAccess: { readTables: ["*"] } });
    const fake = fiveTables();
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle" });
    expect(new Set(fake.reads.map((read) => read.table)).size).toBe(5);
    expect(data.warnings).toBeUndefined();
  });

  it("fails, naming the tool and the grant, when the profile holds none of the tables", async () => {
    const connected = await harness([], {
      tableAccess: grants({ incident: ["sn_query"], sys_script: ["sn_query"] }),
    });
    const message = await callError(connected, "sn_codesearch", { search_term: "needle" });
    expect(message).toContain(
      "this profile does not allow sn_codesearch to read any of the tables it searches"
    );
    expect(message).toContain("(sys_script_include, sys_script, sys_ui_script, sys_script_client, sys_ws_operation)");
    expect(message).toContain("--read <table> --tools sn_codesearch");
    expect(message).not.toContain("incident");
    expect(connected.get).not.toHaveBeenCalled();
  });

  it("leaves out a table whose script field the field policy does not let it read, and says so", async () => {
    const connected = await harness([], {
      tableAccess: { readTables: ["*"] },
      fieldPolicy: { sys_script: { readable: ["sys_id", "name"] } },
    });
    const fake = fiveTables();
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle" });
    expect(fake.reads.map((read) => read.table)).not.toContain("sys_script");
    expect(data.warnings?.[0]).toContain("to read it: sys_script.");

    // Named on its own, the same table is refused with the field and the key to change.
    const message = await callError(connected, "sn_codesearch", {
      search_term: "needle",
      table: "sys_script",
    });
    expect(message).toContain('field "script"');
    expect(message).toContain("fieldPolicy.sys_script.readable");
  });

  it("fails with the field denial when every table is held but none may be read", async () => {
    const connected = await harness([], {
      tableAccess: { readTables: ["*"] },
      fieldPolicy: {
        sys_script: { readable: ["sys_id"] },
        sys_script_include: { readable: ["sys_id"] },
        sys_ui_script: { readable: ["sys_id"] },
        sys_script_client: { readable: ["sys_id"] },
        sys_ws_operation: { readable: ["sys_id"] },
      },
    });
    const message = await callError(connected, "sn_codesearch", { search_term: "needle" });
    expect(message).toContain("is not readable on");
    expect(message).not.toContain("none of the tables");
    expect(connected.get).not.toHaveBeenCalled();
  });

  it("still names the table and the tool when a named table is refused", async () => {
    const connected = await harness([], {
      tableAccess: grants({ sys_script_include: ["sn_codesearch"], sys_script: ["sn_query"] }),
    });
    const unbound = await callError(connected, "sn_codesearch", { search_term: "x", table: "sys_script" });
    expect(unbound).toContain('"sys_script" is granted to this profile, but not for sn_codesearch');
    const absent = await callError(connected, "sn_codesearch", { search_term: "x", table: "sys_ui_script" });
    expect(absent).toContain('no read grant on "sys_ui_script" that allows sn_codesearch');
    const unsupported = await callError(connected, "sn_codesearch", { search_term: "x", table: "incident" });
    expect(unsupported).toContain('sn_codesearch does not support table "incident"');
    expect(connected.get).not.toHaveBeenCalled();
  });

  it("keeps the interleaved order stable over the tables it may read", async () => {
    const connected = await harness([], {
      tableAccess: grants({ sys_ws_operation: ["sn_codesearch"], sys_script: ["sn_codesearch"] }),
    });
    connected.get.mockImplementation(fiveTables().get as never);
    const first = await search(connected, { search_term: "needle", limit: 4 });
    const again = await search(connected, { search_term: "needle", limit: 4 });
    expect(first.data.results.map((row) => row.table)).toEqual([
      "sys_script",
      "sys_ws_operation",
      "sys_script",
      "sys_ws_operation",
    ]);
    expect(again.data.results).toEqual(first.data.results);
  });
});
