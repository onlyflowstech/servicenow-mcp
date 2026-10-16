import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import {
  MAX_ALL_FIELDS,
  allFieldsCapNotice,
  boundedAllFields,
} from "../src/tools/all-fields-cap.js";
import { resolveReadableFields } from "../src/field-policy.js";

const INCIDENT_DEFAULTS = resolveReadableFields("incident");

/**
 * Dictionary fixture: `columns` on the queried table, and each of `ancestors`
 * (nearest first) contributing its own columns. sys_db_object answers the
 * dot-walked super_class.name fields by name; super_class itself carries the
 * parent's label, which the walk must never follow.
 */
function client(options: {
  readonly table?: string;
  readonly columns?: readonly string[];
  readonly parent?: { readonly name: string; readonly columns: readonly string[] };
  readonly ancestors?: readonly { readonly name: string; readonly label: string; readonly columns: readonly string[] }[];
  readonly dictionaryThrows?: boolean;
}) {
  const table = options.table ?? "incident";
  const ancestors = options.ancestors ??
    (options.parent ? [{ ...options.parent, label: options.parent.name }] : []);
  const columnsByTable = new Map<string, readonly string[]>([
    [table, options.columns ?? []],
    ...ancestors.map(({ name, columns }) => [name, columns] as const),
  ]);
  const get = vi.fn(async (path: string, params?: Record<string, string>) => {
    if (path === "/api/now/table/sys_db_object") {
      const name = params?.sysparm_query?.replace("name=", "");
      if (name !== table) return { result: [] };
      const row: Record<string, string> = { name, super_class: ancestors[0]?.label ?? "" };
      for (const field of (params?.sysparm_fields ?? "").split(",")) {
        const depth = field.split("super_class.").length - 1;
        if (depth > 0) row[field] = ancestors[depth - 1]?.name ?? "";
      }
      return { result: [row] };
    }
    if (path === "/api/now/table/sys_dictionary") {
      if (options.dictionaryThrows) throw new Error("ACL denied");
      const names = /^nameIN([^^]+)/u.exec(params?.sysparm_query ?? "")?.[1]?.split(",") ?? [];
      const all = names.flatMap((name) => columnsByTable.get(name) ?? []);
      return { result: all.map((element) => ({ element })) };
    }
    return { result: [] };
  });
  return { operations: { get } as unknown as ServiceNowOperations, get };
}

describe("bounded all-fields projection", () => {
  it("caps a wide table at 100 fields and reports the total", async () => {
    const wide = Array.from({ length: 300 }, (_, index) =>
      `u_col_${String(index).padStart(3, "0")}`
    );
    const { operations } = client({ columns: [...INCIDENT_DEFAULTS, ...wide] });

    const bounded = await boundedAllFields(operations, "incident", INCIDENT_DEFAULTS);

    expect(bounded.fields).toHaveLength(MAX_ALL_FIELDS);
    expect(bounded.capped).toBe(true);
    expect(bounded.total).toBe(INCIDENT_DEFAULTS.length + wide.length);
  });

  it("orders defaults first, then the rest alphabetically, and is stable", async () => {
    const columns = ["zulu", "alpha", "number", "mike", "sys_id"];
    const { operations } = client({ columns });

    const first = await boundedAllFields(operations, "incident", INCIDENT_DEFAULTS);
    const second = await boundedAllFields(operations, "incident", INCIDENT_DEFAULTS);

    // sys_id and number are defaults, in their declared order; the rest sort.
    expect(first.fields).toEqual(["sys_id", "number", "alpha", "mike", "zulu"]);
    expect(second.fields).toEqual(first.fields);
    expect(first.capped).toBe(false);
  });

  it("leaves a table with fewer than the cap untouched", async () => {
    const columns = [...INCIDENT_DEFAULTS, "u_extra"];
    const { operations } = client({ columns });

    const bounded = await boundedAllFields(operations, "incident", INCIDENT_DEFAULTS);

    expect(bounded.fields).toEqual([...INCIDENT_DEFAULTS, "u_extra"]);
    expect(bounded.capped).toBe(false);
  });

  it("includes inherited columns from the table hierarchy", async () => {
    const { operations } = client({
      columns: ["u_child"],
      parent: { name: "task", columns: ["u_parent"] },
    });

    const bounded = await boundedAllFields(operations, "incident", INCIDENT_DEFAULTS);

    expect(bounded.fields).toContain("u_child");
    expect(bounded.fields).toContain("u_parent");
  });

  it("includes inherited columns from every level of a six-table chain, by name", async () => {
    // cmdb_ci_linux_server's super_class label is "Server"; following it
    // found no table and kept only 113 of 546 columns on a live instance.
    const { operations, get } = client({
      table: "cmdb_ci_linux_server",
      columns: ["kernel_release"],
      ancestors: [
        { name: "cmdb_ci_server", label: "Server", columns: ["classification"] },
        { name: "cmdb_ci_computer", label: "Computer", columns: ["cpu_count"] },
        { name: "cmdb_ci_hardware", label: "Hardware", columns: ["serial_number"] },
        { name: "cmdb_ci", label: "Configuration Item", columns: ["name", "ip_address"] },
        { name: "cmdb", label: "Base Configuration Item", columns: ["sys_class_name"] },
      ],
    });

    const bounded = await boundedAllFields(operations, "cmdb_ci_linux_server", ["sys_id", "name"]);

    expect([...bounded.fields].sort()).toEqual(
      ["classification", "cpu_count", "ip_address", "kernel_release", "name", "serial_number", "sys_class_name"].sort()
    );
    expect(get.mock.calls.filter(([path]) => path === "/api/now/table/sys_db_object")).toHaveLength(1);
    const dictionary = get.mock.calls.find(([path]) => path === "/api/now/table/sys_dictionary");
    expect(dictionary?.[1]?.sysparm_query).toMatch(
      /^nameINcmdb_ci_linux_server,cmdb_ci_server,cmdb_ci_computer,cmdb_ci_hardware,cmdb_ci,cmdb\^/u
    );
  });

  it("falls back to the defaults for a table name that would widen nameIN", async () => {
    // "incident,sys_user" spliced into nameIN would read sys_user's
    // dictionary too. The walk rejects it, and no dictionary read is sent.
    const { operations, get } = client({ columns: ["u_column"] });

    const bounded = await boundedAllFields(operations, "incident,sys_user", ["sys_id", "number"]);

    expect(bounded).toEqual({ fields: ["sys_id", "number"], capped: true });
    expect(get).not.toHaveBeenCalled();
  });

  it("never names a sensitive column in the request", async () => {
    // Under a wildcard selection the value was scrubbed after arriving. Naming
    // it in sysparm_fields would pull it over the wire deliberately.
    const { operations } = client({
      columns: ["number", "user_password", "client_secret", "api_key", "u_safe"],
    });

    const bounded = await boundedAllFields(operations, "incident", INCIDENT_DEFAULTS);

    expect(bounded.fields).toEqual(["number", "u_safe"]);
    for (const sensitive of ["user_password", "client_secret", "api_key"]) {
      expect(bounded.fields).not.toContain(sensitive);
    }
  });

  it.each([
    ["the dictionary read fails", { dictionaryThrows: true }],
    ["the table resolves no columns", { columns: [] }],
  ])("falls back to the bounded default projection when %s", async (_label, options) => {
    const { operations } = client(options);

    const bounded = await boundedAllFields(operations, "incident", INCIDENT_DEFAULTS);

    // Bounded, never a wildcard: falling back to "every column" would
    // reinstate the defect this exists to prevent.
    expect(bounded.fields).toEqual([...INCIDENT_DEFAULTS]);
    expect(bounded.fields).not.toContain("*");
    expect(bounded.total).toBeUndefined();
    expect(bounded.capped).toBe(true);
  });

  it("explains a cap and a fallback differently to the caller", async () => {
    const capped = allFieldsCapNotice(
      { fields: Array.from({ length: 100 }, (_, i) => `f${i}`), capped: true, total: 312 },
      "incident"
    );
    expect(capped).toContain("capped at 100 of 312");
    expect(capped).toContain("name them explicitly");

    const fallback = allFieldsCapNotice(
      { fields: ["sys_id"], capped: true },
      "incident"
    );
    expect(fallback).toContain("could not be resolved");
    expect(fallback).not.toContain("capped at");
  });
});
