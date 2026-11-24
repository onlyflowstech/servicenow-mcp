/**
 * A table's extension chain is complete only when it is known to end at a
 * table that extends nothing: its stored `super_class` reference and that
 * parent's name both came back empty. Every reader of the shared helpers
 * (the instance-wide loader, the plan-bounded loader, `resolveTableChain`)
 * reports a chain that may stop short as incomplete, and every table on one
 * is unresolved, so `classifyField` answers `unknown_type`. Synthetic data
 * only.
 */
import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import {
  classifyField,
  fieldTypesFromRows,
  hiddenTypedFields,
  loadFieldTypes,
  loadFieldTypesInPlan,
  tableChainFields,
  tableChainFromRow,
} from "../src/hidden-values.js";
import { resolveTableChain } from "../src/tools/table-hierarchy.js";
import { fakeTableSysId, fieldTypeAnswer, sysDbObjectRow, type FieldTypeFixture } from "./fixtures/field-types.js";

const LINK = fakeTableSysId("parent");

describe("tableChainFields", () => {
  it("asks for each table's stored reference and its parent's name, and the last table's reference alone", () => {
    expect(tableChainFields(3)).toEqual([
      "name",
      "super_class",
      "super_class.name",
      "super_class.super_class",
      "super_class.super_class.name",
      "super_class.super_class.super_class",
    ]);
    expect(tableChainFields(1)).toEqual(["name", "super_class"]);
  });
});

describe("tableChainFromRow", () => {
  const fields = tableChainFields(3).join(",");
  const row = (parents: string[], hidden: string[] = []) => sysDbObjectRow("u_child", parents, fields, hidden);

  it("is complete only where a reference and its name are both empty", () => {
    expect(tableChainFromRow(row([]), "u_child", 3)).toEqual({ tables: ["u_child"], complete: true });
    expect(tableChainFromRow(row(["u_parent", "u_root"]), "u_child", 3)).toEqual({
      tables: ["u_child", "u_parent", "u_root"],
      complete: true,
    });
  });

  it("is incomplete for a reference whose name did not come back", () => {
    expect(tableChainFromRow(row(["u_parent"], ["u_parent"]), "u_child", 3)).toEqual({
      tables: ["u_child"],
      complete: false,
      gap: "parent_unreadable",
    });
    const unnamed = tableChainFromRow({ name: "u_child", super_class: LINK, "super_class.name": "" }, "u_child", 2);
    expect(unnamed.complete).toBe(false);
    expect(unnamed.gap).toBe("parent_unreadable");
  });

  it("is incomplete for an absent field, never empty", () => {
    for (const [candidate, maxTables] of [
      [{ name: "u_child", "super_class.name": "" }, 2],
      [{ name: "u_child", super_class: "" }, 2],
      [{ name: "u_child", super_class: null, "super_class.name": "" }, 2],
      [{ name: "u_child" }, 1],
    ] as const) {
      const chain = tableChainFromRow(candidate, "u_child", maxTables);
      expect(chain.complete).toBe(false);
      expect(chain.gap).toBe("malformed");
    }
  });

  it("is incomplete for a name with no reference, a parent that is not a table name, or a loop", () => {
    for (const candidate of [
      { name: "u_child", super_class: "", "super_class.name": "u_parent" },
      { name: "u_child", super_class: LINK, "super_class.name": "Parent Table" },
    ]) {
      const chain = tableChainFromRow(candidate, "u_child", 2);
      expect(chain.complete).toBe(false);
      expect(chain.gap).toBe("malformed");
    }
    expect(tableChainFromRow(row(["u_parent", "u_child"]), "u_child", 3)).toEqual({
      tables: ["u_child", "u_parent"],
      complete: false,
      gap: "malformed",
    });
  });

  it("is incomplete when the chain goes on past the tables read, and complete when it ends on the last", () => {
    expect(tableChainFromRow(row(["u_parent", "u_root"]), "u_child", 2)).toEqual({
      tables: ["u_child", "u_parent"],
      complete: false,
      gap: "too_long",
    });
    const exact = sysDbObjectRow("u_child", ["u_parent"], tableChainFields(2).join(","));
    expect(tableChainFromRow(exact, "u_child", 2)).toEqual({ tables: ["u_child", "u_parent"], complete: true });
  });

  it("reads a stored value in the `{ value }` shape too", () => {
    const shaped = { name: "u_child", super_class: { value: "" }, "super_class.name": { value: "" } };
    expect(tableChainFromRow(shaped, "u_child", 2).complete).toBe(true);
  });
});

describe("resolveTableChain", () => {
  const chains: Record<string, string[]> = { u_fake_oauth: ["oauth_entity"], u_deep: Array.from({ length: 12 }, (_, i) => `u_level_${i}`) };
  const operations = (hidden: string[] = []) => {
    const get = vi.fn(async (_path: string, params?: Record<string, string>) => {
      const name = /^name=(.+)$/u.exec(params?.sysparm_query ?? "")?.[1] ?? "";
      if (!(name in chains) || hidden.includes(name)) return { result: [] };
      return { result: [sysDbObjectRow(name, chains[name]!, params?.sysparm_fields ?? "name", hidden)] };
    });
    return { get, ops: { get } as unknown as ServiceNowOperations };
  };

  it("reads the table's own row once, with stored values and the chain fields", async () => {
    const { get, ops } = operations();
    expect(await resolveTableChain(ops, "u_fake_oauth", 12, false)).toEqual({ tables: ["u_fake_oauth", "oauth_entity"], complete: true });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![1]).toMatchObject({
      sysparm_query: "name=u_fake_oauth",
      sysparm_fields: tableChainFields(12).join(","),
      sysparm_limit: "1",
      sysparm_display_value: "false",
    });
  });

  it("is incomplete with no row, a parent whose row is hidden, or more than maxDepth tables", async () => {
    expect(await resolveTableChain(operations(["u_fake_oauth"]).ops, "u_fake_oauth", 12, false)).toEqual({
      tables: ["u_fake_oauth"],
      complete: false,
      gap: "no_row",
    });
    const hiddenParent = await resolveTableChain(operations(["oauth_entity"]).ops, "u_fake_oauth", 12, false);
    expect(hiddenParent.complete).toBe(false);
    expect(hiddenParent.gap).toBe("parent_unreadable");
    const deep = await resolveTableChain(operations().ops, "u_deep", 12, false);
    expect(deep.tables).toHaveLength(12);
    expect(deep.complete).toBe(false);
    expect(deep.gap).toBe("too_long");
    expect((await resolveTableChain(operations().ops, "u_deep", 13, false)).complete).toBe(true);
  });

  it("is incomplete for a row of another table, and rejects a name that is not a table name before reading", async () => {
    const get = vi.fn(async () => ({ result: [{ name: "u_other", super_class: "", "super_class.name": "" }] }));
    expect((await resolveTableChain({ get } as unknown as ServiceNowOperations, "u_fake_oauth", 12, false)).complete).toBe(false);
    await expect(resolveTableChain({ get } as unknown as ServiceNowOperations, "x,y", 12, false)).rejects.toThrow(TypeError);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("classifyField on a credential child whose chain is incomplete", () => {
  // u_fake_oauth extends oauth_entity; its own field is a plain string, so
  // only the credential-table rule withholds it.
  const levels = Array.from({ length: 11 }, (_, index) => `u_fake_level_${index + 1}`);
  const base: FieldTypeFixture = {
    dictionary: [{ name: "sys_user", element: "user_password", internal_type: "password" }],
    parents: { u_fake_oauth: ["oauth_entity"] },
    absent: [],
    views: {},
  };
  const cases: Record<string, FieldTypeFixture> = {
    "no sys_db_object row": { ...base, absent: ["u_fake_oauth"] },
    "an empty parent link": { ...base, hiddenRows: ["oauth_entity"], withoutParentLinks: ["u_fake_oauth"] },
    "a parent reference with no name": { ...base, hiddenRows: ["oauth_entity"] },
    // Every table of the chain has its own row, for the loader that reads one level at a time.
    "a chain longer than 12 tables": {
      ...base,
      parents: Object.fromEntries(
        ["u_fake_oauth", ...levels].map((table, index, chain) => [table, [...chain.slice(index + 1), "oauth_entity"]])
      ),
    },
  };
  const ops = (fixture: FieldTypeFixture) =>
    ({
      getWithMeta: async (path: string, params: Record<string, string> = {}) =>
        fieldTypeAnswer(path, params, fixture) ?? { data: { result: [] }, status: 200, headers: new Headers() },
      get: async (path: string, params: Record<string, string> = {}) => fieldTypeAnswer(path, params, fixture)?.data ?? { result: [] },
    }) as unknown as ServiceNowOperations;

  it("is credential_table when the chain is complete, through either loader", async () => {
    const wide = await loadFieldTypes(ops(base), ["u_fake_oauth"]);
    expect(classifyField(wide, "u_fake_oauth", "u_label")).toBe("credential_table");
    const plan = await loadFieldTypesInPlan(ops(base), ["u_fake_oauth"]);
    expect(plan.chains.get("u_fake_oauth")).toEqual({ tables: ["u_fake_oauth", "oauth_entity"], complete: true });
  });

  for (const [label, fixture] of Object.entries(cases)) {
    it(`is unknown_type, with the table unresolved, for ${label}`, async () => {
      const wide = await loadFieldTypes(ops(fixture), ["u_fake_oauth", "sys_user"]);
      expect(wide.state).toBe("available");
      expect(hiddenTypedFields(wide, "u_fake_oauth")).toBeUndefined();
      expect(classifyField(wide, "u_fake_oauth", "u_label")).toBe("unknown_type");
      // A dot-walk that ends on it is unknown too.
      const referenceTarget = () => "u_fake_oauth";
      expect(classifyField(wide, "sys_user", "u_client.u_label", { referenceTarget })).toBe("unknown_type");
      expect(classifyField(wide, "sys_user", "user_password")).toBe("type");

      const plan = await loadFieldTypesInPlan(ops(fixture), ["u_fake_oauth"]);
      expect(plan.chains.get("u_fake_oauth")?.complete ?? false).toBe(false);
      expect(hiddenTypedFields(plan.types, "u_fake_oauth")).toBeUndefined();
      expect(classifyField(plan.types, "u_fake_oauth", "u_label")).toBe("unknown_type");
    });
  }

  it("is unknown_type for a chain a caller passes as incomplete, whatever the rows say", () => {
    const rows = [{ table: "u_fake_oauth", element: "u_label", internal_type: "string" }];
    const types = fieldTypesFromRows(rows, { u_fake_oauth: { tables: ["u_fake_oauth"], complete: false } }, { complete: true });
    expect(types.state).toBe("available");
    expect(hiddenTypedFields(types, "u_fake_oauth")).toBeUndefined();
    expect(classifyField(types, "u_fake_oauth", "u_label")).toBe("unknown_type");
    const known = fieldTypesFromRows(rows, { u_fake_oauth: { tables: ["u_fake_oauth"], complete: true } }, { complete: true });
    expect(classifyField(known, "u_fake_oauth", "u_label")).toBe("visible");
  });
});
