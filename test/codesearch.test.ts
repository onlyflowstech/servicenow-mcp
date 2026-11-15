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
        "sys_script, sys_script_client, sys_ws_operation, sys_module, sys_atf_step (needs read on sys_variable_value, sys_atf_step, sys_atf_test). To include one, run " +
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
      "Not searched, because this profile does not allow sn_codesearch to read them: " +
        "sys_ws_operation, sys_module, sys_atf_step (needs read on sys_variable_value, sys_atf_step, sys_atf_test). To include one, run servicenow-mcp-setup grant " +
        "--profile <profile> --read <table> --tools sn_codesearch.",
    ]);

    const five = { ...all, sys_ws_operation: ["sn_codesearch"] };
    const almost = await harness([], { tableAccess: grants(five) });
    almost.get.mockImplementation(fiveTables().get as never);
    expect((await search(almost, { search_term: "needle" })).data.warnings).toEqual([
      "Not searched, because this profile does not allow sn_codesearch to read them: " +
        "sys_module, sys_atf_step (needs read on sys_variable_value, sys_atf_step, sys_atf_test). To include one, run servicenow-mcp-setup grant " +
        "--profile <profile> --read <table> --tools sn_codesearch.",
    ]);

    const six = { ...five, sys_module: ["sn_codesearch"] };
    const nearly = await harness([], { tableAccess: grants(six) });
    nearly.get.mockImplementation(fiveTables().get as never);
    expect((await search(nearly, { search_term: "needle" })).data.warnings).toEqual([
      "Not searched, because this profile does not allow sn_codesearch to read it: " +
        "sys_atf_step (needs read on sys_variable_value, sys_atf_step, sys_atf_test). To include it, run servicenow-mcp-setup grant " +
        "--profile <profile> --read <table> --tools sn_codesearch.",
    ]);

    // The ATF step scripts need all three of their tables bound to the tool.
    const full = await harness([], {
      tableAccess: grants({
        ...six,
        sys_variable_value: ["sn_codesearch"],
        sys_atf_step: ["sn_codesearch"],
        sys_atf_test: ["sn_codesearch"],
      }),
    });
    full.get.mockImplementation(fiveTables().get as never);
    expect((await search(full, { search_term: "needle" })).data.warnings).toBeUndefined();
  });

  it("searches everything under a read wildcard, with no warning", async () => {
    const connected = await harness([], { tableAccess: { readTables: ["*"] } });
    const fake = fiveTables();
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle" });
    expect(new Set(fake.reads.map((read) => read.table)).size).toBe(7);
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
    expect(message).toContain(
      "(sys_script_include, sys_script, sys_ui_script, sys_script_client, sys_ws_operation, sys_module, sys_atf_step)"
    );
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
        sys_module: { readable: ["sys_id"] },
        sys_variable_value: { readable: ["sys_id"] },
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

describe("ES modules", () => {
  const module = {
    sys_id: "e".repeat(32),
    path: "x_app/lib/fleet.js",
    content: `${"// pad\n".repeat(30)}import { needle } from './needle';\n`,
  };

  it("searches content by the module's path", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({ result: [module] });
    const { data } = await search(connected, { search_term: "needle", table: "sys_module" });
    const [read] = reads(connected);
    expect(read!.path).toBe("/api/now/table/sys_module");
    expect(read!.params.sysparm_query).toBe("contentLIKEneedle^ORDERBYsys_id");
    // The table has no name column: the path names the row.
    expect(read!.params.sysparm_fields).toBe("sys_id,path,content");
    expect(data.results[0]).toMatchObject({
      table: "sys_module",
      table_label: "sys_module",
      sys_id: module.sys_id,
      name: "x_app/lib/fleet.js",
      line: 31,
    });
    expect(String(data.results[0]!.snippet)).toContain("import { needle }");
  });

  it("searches the path itself when asked, without repeating it in the projection", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockResolvedValue({ result: [module] });
    const { data } = await search(connected, { search_term: "fleet", table: "sys_module", field: "path" });
    const [read] = reads(connected);
    expect(read!.params.sysparm_query).toBe("pathLIKEfleet^ORDERBYsys_id");
    expect(read!.params.sysparm_fields).toBe("sys_id,path");
    expect(data.results[0]).toMatchObject({ name: "x_app/lib/fleet.js", snippet: "x_app/lib/fleet.js" });
  });

  it("takes its turn in a search across tables, labelled as ES modules, and is last in a round", async () => {
    const connected = await harness([], { codeTables: true });
    const order = ["sys_script_include", "sys_script", "sys_ui_script", "sys_script_client", "sys_ws_operation", "sys_module"];
    const fake = fakeInstance(
      Object.fromEntries(
        order.map((table, salt) => [
          table,
          [
            {
              sys_id: sysId(1, salt),
              name: `${table}-n`,
              path: `${table}-p`,
              script: scriptWith("needle", 100),
              operation_script: scriptWith("needle", 100),
              content: scriptWith("needle", 100),
            },
          ],
        ])
      )
    );
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle" });
    expect(data.results.map((row) => row.table)).toEqual(order);
    expect(data.results.at(-1)).toMatchObject({ table_label: "ES Modules", name: "sys_module-p" });
    // The ES module is read with its own searched field and label field.
    const moduleRead = fake.finds().find((read) => read.table === "sys_module")!;
    expect(moduleRead.params).toMatchObject({
      sysparm_query: "contentLIKEneedle^ORDERBYsys_id",
      sysparm_fields: "sys_id,path",
    });
  });

  it("is refused for a profile that does not hold it, by name", async () => {
    const connected = await harness([], {
      tableAccess: grants({ sys_script_include: ["sn_codesearch"] }),
    });
    const message = await callError(connected, "sn_codesearch", { search_term: "x", table: "sys_module" });
    expect(message).toContain('no read grant on "sys_module" that allows sn_codesearch');
    expect(message).toContain("--read sys_module --tools sn_codesearch");
    expect(connected.get).not.toHaveBeenCalled();
  });

  it("is read through the field policy: content must be readable, and a path-only profile may search the path", async () => {
    const connected = await harness([], {
      tableAccess: { readTables: ["*"] },
      fieldPolicy: { sys_module: { readable: ["sys_id", "path"] } },
    });
    connected.get.mockResolvedValue({ result: [module] });
    const denied = await callError(connected, "sn_codesearch", { search_term: "x", table: "sys_module" });
    expect(denied).toContain('field "content"');
    expect(denied).toContain("fieldPolicy.sys_module.readable");
    const { data } = await search(connected, { search_term: "fleet", table: "sys_module", field: "path" });
    expect(data.results).toHaveLength(1);
  });
});

describe("ATF step scripts", () => {
  const STEP_1 = "a1".repeat(16);
  const STEP_2 = "a2".repeat(16);
  const STEP_3 = "a3".repeat(16);
  const TEST_1 = "b1".repeat(16);
  const TEST_2 = "b2".repeat(16);
  const atfGrants = (extra: Record<string, readonly string[]> = {}) =>
    grants({
      sys_variable_value: ["sn_codesearch"],
      sys_atf_step: ["sn_codesearch"],
      sys_atf_test: ["sn_codesearch"],
      ...extra,
    });

  function atfInstance() {
    // `document_key` and `test` come back as { link, value } unless the read
    // asks for the value alone, as they do on an instance.
    return fakeInstance(
      {
      sys_variable_value: [
        // Two script inputs of ATF steps that hold the term.
        { sys_id: sysId(1), document: "sys_atf_step", document_key: STEP_1, variable: "script", value: "var a = 1;\ngs.info('needle');" },
        { sys_id: sysId(2), document: "sys_atf_step", document_key: STEP_3, variable: "script", value: "needle first" },
        // An ATF step's other input that holds it too: not a script.
        { sys_id: sysId(3), document: "sys_atf_step", document_key: STEP_2, variable: "description", value: "a needle in a description" },
        // Another owner's script variable: not an ATF step.
        { sys_id: sysId(4), document: "sc_cat_item", document_key: "c".repeat(32), variable: "script", value: "needle in a catalog script" },
        // An ATF step script that does not hold it.
        { sys_id: sysId(5), document: "sys_atf_step", document_key: STEP_2, variable: "script", value: "no match here" },
      ],
      sys_atf_step: [
        { sys_id: STEP_1, test: TEST_1, order: "100" },
        { sys_id: STEP_2, test: TEST_1, order: "200" },
        { sys_id: STEP_3, test: TEST_2, order: "300" },
      ],
      sys_atf_test: [
        { sys_id: TEST_1, name: "Login flow" },
        { sys_id: TEST_2, name: "Approve change" },
      ],
      },
      { referenceFields: ["document_key", "test"] }
    );
  }

  it("searches only the script inputs of ATF steps, with the query fixed on the server", async () => {
    const connected = await harness([], { tableAccess: atfGrants() });
    const fake = atfInstance();
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle", table: "sys_atf_step" });

    const [find] = fake.finds();
    expect(find!.table).toBe("sys_variable_value");
    expect(find!.params.sysparm_query).toBe(
      "document=sys_atf_step^variableENDSWITHscript^valueLIKEneedle^ORDERBYsys_id"
    );
    // The rows are the two script inputs: not the description, not the catalog item's script.
    expect(data.results.map((row) => row.sys_id)).toEqual([STEP_1, STEP_3]);
    expect(data.results[0]).toMatchObject({
      table: "sys_atf_step",
      table_label: "sys_atf_step",
      name: "Login flow > step 100",
      line: 2,
    });
    expect(String(data.results[0]!.snippet)).toContain("gs.info('needle')");
    expect(data.results[1]).toMatchObject({ name: "Approve change > step 300", line: 1 });
  });

  it("reads the steps and then their tests, once each, for the rows of the page only", async () => {
    const connected = await harness([], { tableAccess: atfGrants() });
    const fake = atfInstance();
    connected.get.mockImplementation(fake.get as never);
    await search(connected, { search_term: "needle", table: "sys_atf_step" });
    expect(fake.reads.map((read) => read.table)).toEqual(["sys_variable_value", "sys_atf_step", "sys_atf_test"]);
    const [, steps, tests] = fake.reads;
    expect(steps!.params).toMatchObject({
      sysparm_query: `sys_idIN${STEP_1},${STEP_3}`,
      sysparm_fields: "sys_id,test,order",
      sysparm_exclude_reference_link: "true",
    });
    expect(tests!.params).toMatchObject({
      sysparm_query: `sys_idIN${TEST_1},${TEST_2}`,
      sysparm_fields: "sys_id,name",
    });
  });

  it("cannot be widened by the search term, the field, or a table argument", async () => {
    const connected = await harness([], { tableAccess: atfGrants() });
    const fake = atfInstance();
    connected.get.mockImplementation(fake.get as never);
    await search(connected, { search_term: "x^document=sc_cat_item^NQvariable=password", table: "sys_atf_step" });
    expect(fake.finds()[0]!.params.sysparm_query).toBe(
      "document=sys_atf_step^variableENDSWITHscript^valueLIKExdocument=sc_cat_itemNQvariable=password^ORDERBYsys_id"
    );

    for (const field of ["value", "variable", "document"]) {
      const message = await callError(connected, "sn_codesearch", {
        search_term: "needle",
        table: "sys_atf_step",
        field,
      });
      expect(message).toContain("denied by policy");
    }
    // The value table itself is not a search target: only its ATF step rows are.
    const direct = await callError(connected, "sn_codesearch", { search_term: "needle", table: "sys_variable_value" });
    expect(direct).toContain('sn_codesearch does not support table "sys_variable_value"');
  });

  it("reads the scripts in batches when the page is large", async () => {
    const connected = await harness([], { tableAccess: atfGrants() });
    const fake = atfInstance();
    connected.get.mockImplementation(fake.get as never);
    await search(connected, { search_term: "needle", table: "sys_atf_step", limit: 60 });
    expect(fake.finds()[0]!.params).toMatchObject({ sysparm_fields: "sys_id,document_key", sysparm_limit: "61" });
    const [bodies] = fake.bodies();
    expect(bodies).toMatchObject({ table: "sys_variable_value" });
    expect(bodies!.params.sysparm_fields).toBe("sys_id,value");
  });

  it("needs a grant on all three tables, and says which one is missing", async () => {
    const connected = await harness([], {
      tableAccess: grants({ sys_variable_value: ["sn_codesearch"], sys_atf_step: ["sn_codesearch"] }),
    });
    const message = await callError(connected, "sn_codesearch", { search_term: "needle", table: "sys_atf_step" });
    expect(message).toContain('no read grant on "sys_atf_test" that allows sn_codesearch');
    expect(message).toContain("--read sys_atf_test --tools sn_codesearch");
    expect(connected.get).not.toHaveBeenCalled();

    const unbound = await harness([], {
      tableAccess: grants({
        sys_variable_value: ["sn_query"],
        sys_atf_step: ["sn_codesearch"],
        sys_atf_test: ["sn_codesearch"],
      }),
    });
    const second = await callError(unbound, "sn_codesearch", { search_term: "needle", table: "sys_atf_step" });
    expect(second).toContain('"sys_variable_value" is granted to this profile, but not for sn_codesearch');
  });

  it("is searched in a search with no table once all three are held, after ES modules", async () => {
    const connected = await harness([], { tableAccess: { readTables: ["*"] } });
    const fake = atfInstance();
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle" });
    expect(data.results.map((row) => row.table)).toEqual(["sys_atf_step", "sys_atf_step"]);
    expect(data.results[0]).toMatchObject({ table_label: "ATF Step Scripts", name: "Login flow > step 100" });
    expect(data.warnings).toBeUndefined();
  });

  it("goes through the field policy of each table it reads", async () => {
    const value = await harness([], {
      tableAccess: atfGrants(),
      fieldPolicy: { sys_variable_value: { readable: ["sys_id", "document_key"] } },
    });
    expect(await callError(value, "sn_codesearch", { search_term: "x", table: "sys_atf_step" })).toContain(
      'field "value"'
    );
    const names = await harness([], {
      tableAccess: atfGrants(),
      fieldPolicy: { sys_atf_test: { readable: ["sys_id"] } },
    });
    expect(await callError(names, "sn_codesearch", { search_term: "x", table: "sys_atf_step" })).toContain(
      "fieldPolicy.sys_atf_test.readable"
    );
    expect(value.get).not.toHaveBeenCalled();
    expect(names.get).not.toHaveBeenCalled();
  });

  it("leaves a step it cannot name as 'unnamed' with a warning, and ignores a malformed step id", async () => {
    const connected = await harness([], { tableAccess: atfGrants() });
    const fake = fakeInstance(
      {
        sys_variable_value: [
          { sys_id: sysId(1), document: "sys_atf_step", document_key: STEP_1, variable: "script", value: "needle" },
          { sys_id: sysId(2), document: "sys_atf_step", document_key: "not-a-sys-id^x", variable: "script", value: "needle" },
        ],
        sys_atf_step: [{ sys_id: STEP_1, test: TEST_1, order: "100" }],
        sys_atf_test: [{ sys_id: TEST_1, name: "Login flow" }],
      },
      { fail: { sys_atf_test: new Error("RAW_DETAIL") } }
    );
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle", table: "sys_atf_step" });
    expect(data.results.map((row) => row.name)).toEqual(["step 100", "unnamed"]);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings![0]).toContain("sys_atf_test: names unavailable for some results.");
    expect(data.warnings![0]).not.toContain("RAW_DETAIL");
    // The malformed id never reaches a query.
    expect(JSON.stringify(fake.reads.map((read) => read.params))).not.toContain("not-a-sys-id");
  });

  it("names two matches of one step with one read of the step", async () => {
    const connected = await harness([], { tableAccess: atfGrants() });
    const fake = fakeInstance({
      sys_variable_value: [
        { sys_id: sysId(1), document: "sys_atf_step", document_key: STEP_1, variable: "script", value: "needle one" },
        { sys_id: sysId(2), document: "sys_atf_step", document_key: STEP_1, variable: "setup script", value: "needle two" },
      ],
      sys_atf_step: [{ sys_id: STEP_1, test: TEST_1, order: "100" }],
      sys_atf_test: [{ sys_id: TEST_1, name: "Login flow" }],
    });
    connected.get.mockImplementation(fake.get as never);
    const { data } = await search(connected, { search_term: "needle", table: "sys_atf_step" });
    expect(data.results.map((row) => row.name)).toEqual(["Login flow > step 100", "Login flow > step 100"]);
    expect(fake.reads.filter((read) => read.table === "sys_atf_step")).toHaveLength(1);
  });
});
