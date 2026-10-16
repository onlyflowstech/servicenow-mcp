import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import { FORCE_RECACHE_PARAM } from "../src/metadata-cache.js";
import { resolveTableHierarchy } from "../src/tools/table-hierarchy.js";

/** Ancestors by name, nearest first, as sys_db_object would resolve them. */
const CMDB_CHAIN: Readonly<Record<string, readonly string[]>> = {
  cmdb_ci_linux_server: ["cmdb_ci_server", "cmdb_ci_computer", "cmdb_ci_hardware", "cmdb_ci", "cmdb"],
};
/** What the old walk followed: super_class's display value is the label. */
const LABELS: Readonly<Record<string, string>> = {
  cmdb_ci_linux_server: "Server",
  cmdb_ci_server: "Computer",
};

/**
 * sys_db_object double that answers the dot-walked fields it is asked for.
 * `super_class` itself is always the parent's label, as with display values.
 */
function sysDbObject(chains: Readonly<Record<string, readonly string[]>>) {
  const get = vi.fn(async (_path: string, params?: Record<string, string>) => {
    const name = /^name=(.+)$/u.exec(params?.sysparm_query ?? "")?.[1] ?? "";
    const ancestors = chains[name];
    if (ancestors === undefined) return { result: [] };
    const row: Record<string, string> = { name, super_class: LABELS[name] ?? "" };
    for (const field of (params?.sysparm_fields ?? "").split(",")) {
      const depth = field.split("super_class.").length - 1;
      if (depth > 0) row[field] = ancestors[depth - 1] ?? "";
    }
    return { result: [row] };
  });
  return { get, operations: { get } as unknown as ServiceNowOperations };
}

describe("table hierarchy by name", () => {
  it("resolves a six-table CMDB chain by name in one request", async () => {
    const { get, operations } = sysDbObject(CMDB_CHAIN);

    const hierarchy = await resolveTableHierarchy(operations, "cmdb_ci_linux_server", 12, false);

    expect(hierarchy).toEqual([
      "cmdb_ci_linux_server",
      "cmdb_ci_server",
      "cmdb_ci_computer",
      "cmdb_ci_hardware",
      "cmdb_ci",
      "cmdb",
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    const [path, params] = get.mock.calls[0]!;
    expect(path).toBe("/api/now/table/sys_db_object");
    expect(params).toMatchObject({
      sysparm_query: "name=cmdb_ci_linux_server",
      sysparm_limit: "1",
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
    });
    expect(params?.sysparm_fields?.split(",")).toEqual([
      "name",
      ...Array.from({ length: 11 }, (_, index) => `${"super_class.".repeat(index + 1)}name`),
    ]);
  });

  it("follows the parent's name, never its label", async () => {
    // The label "Server" lowercases to a valid-looking table name; following
    // it is exactly the defect.
    const { operations } = sysDbObject(CMDB_CHAIN);

    const hierarchy = await resolveTableHierarchy(operations, "cmdb_ci_linux_server", 8, false);

    expect(hierarchy[1]).toBe("cmdb_ci_server");
    expect(hierarchy).not.toContain("server");
    expect(hierarchy).not.toContain("computer");
  });

  it("stops at the first repeated table, so a cycle cannot loop", async () => {
    const { operations } = sysDbObject({ u_a: ["u_b", "u_a", "u_b", "u_c"] });

    expect(await resolveTableHierarchy(operations, "u_a", 12, false)).toEqual(["u_a", "u_b"]);
  });

  it.each([
    [8, 7],
    [12, 11],
    [3, 2],
  ])("returns at most %i tables and asks for %i ancestors", async (maxDepth, levels) => {
    const deep = { u_t0: Array.from({ length: 20 }, (_, index) => `u_t${index + 1}`) };
    const { get, operations } = sysDbObject(deep);

    const hierarchy = await resolveTableHierarchy(operations, "u_t0", maxDepth, false);

    expect(hierarchy).toHaveLength(maxDepth);
    expect(get.mock.calls[0]![1]?.sysparm_fields?.split(",")).toHaveLength(levels + 1);
  });

  it("asks nothing for a depth of one", async () => {
    const { get, operations } = sysDbObject(CMDB_CHAIN);

    expect(await resolveTableHierarchy(operations, "cmdb_ci_linux_server", 1, false)).toEqual(["cmdb_ci_linux_server"]);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty level", ["u_parent", "", "u_after_gap"]],
    ["a value that is not a table name", ["u_parent", "Not A Table", "u_after"]],
  ])("stops at %s", async (_label, ancestors) => {
    const { operations } = sysDbObject({ u_child: ancestors });

    expect(await resolveTableHierarchy(operations, "u_child", 12, false)).toEqual(["u_child", "u_parent"]);
  });

  it("returns the table alone when sys_db_object has no row for it", async () => {
    const { operations } = sysDbObject({});

    expect(await resolveTableHierarchy(operations, "u_missing", 12, false)).toEqual(["u_missing"]);
  });

  it.each(["incident,sys_user", "incident^NQsys_user", "not a table", ""])(
    "rejects the invalid table name %j before any request",
    async (table) => {
      // Callers splice the chain into nameIN: a comma would add sys_user.
      const { get, operations } = sysDbObject(CMDB_CHAIN);

      await expect(resolveTableHierarchy(operations, table, 12, false)).rejects.toThrow(TypeError);
      expect(get).not.toHaveBeenCalled();
    }
  );

  it("passes force_recache through to the metadata cache", async () => {
    const { get, operations } = sysDbObject(CMDB_CHAIN);

    await resolveTableHierarchy(operations, "cmdb_ci_linux_server", 8, true);

    expect(get.mock.calls[0]![1]).toMatchObject({ [FORCE_RECACHE_PARAM]: "true" });
  });

  it("propagates a failed read", async () => {
    const get = vi.fn(async () => {
      throw new Error("ACL denied");
    });

    await expect(
      resolveTableHierarchy({ get } as unknown as ServiceNowOperations, "incident", 8, false)
    ).rejects.toThrow("ACL denied");
  });
});
