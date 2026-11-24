/**
 * `loadFieldTypesInPlan`: the type helper's plan-bounded loader. It reads only
 * `sys_db_object` (one level per read, through a one-hop dot-walk) and
 * `sys_dictionary`, and answers with the instance-wide loader's semantics:
 * hidden-typed rows only, `unavailable` instead of an empty map, and an
 * unresolved table instead of a guess. Every read goes through the platform
 * view harness's recording client and is judged against that two-table plan.
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import {
  PLAN_CHAIN_LEVELS,
  PLAN_FIELD_TYPE_DOT_WALKS,
  PLAN_FIELD_TYPE_FIELDS,
  MAX_HIDDEN_DICTIONARY_ROWS,
  classifyField,
  hiddenTypedFields,
  loadFieldTypes,
  loadFieldTypesInPlan,
} from "../src/hidden-values.js";
import { sysDbObjectRow } from "./fixtures/field-types.js";
import { expectReadsWithin, recordingInstance, type RecordedCall, type RecordingInstance } from "./platform-view-harness.js";

const PLAN = Object.keys(PLAN_FIELD_TYPE_FIELDS);

interface World {
  /** Table -> parent, or null when it extends nothing. A table not listed has no row. */
  tables: Record<string, string | null>;
  dictionary: { name: string; element: string; internal_type: string }[];
  /** Tables whose sys_db_object row this account cannot read (see `sysDbObjectRow`). */
  hiddenRows?: string[];
  /** Tables whose row comes back without the stored `super_class` reference. */
  withoutParentLinks?: string[];
}

/** `name`'s ancestors in `tables`, nearest first. */
function chainOf(tables: Record<string, string | null>, name: string): string[] {
  const chain: string[] = [];
  for (let parent = tables[name]; parent !== null && parent !== undefined && !chain.includes(parent); parent = tables[parent]) {
    chain.push(parent);
  }
  return chain;
}

const WORLD: World = {
  tables: {
    sys_metadata: null,
    // The anchor row the first chain read also asks for: the read could see rows.
    sys_db_object: null,
    sys_user: null,
    u_vendor: null,
    u_vendor_child: "u_vendor",
    u_vendor_grandchild: "u_vendor_child",
    discovery_credentials: null,
    ssh_credentials: "discovery_credentials",
    sys_script_include: "sys_metadata",
  },
  dictionary: [
    { name: "sys_user", element: "user_password", internal_type: "password" },
    { name: "u_vendor", element: "u_api_password", internal_type: "password2" },
    { name: "u_vendor", element: "u_mask", internal_type: "masked" },
    { name: "discovery_credentials", element: "password", internal_type: "password2" },
  ],
};

interface FakeOptions {
  /** Return every dictionary row whatever the type filter says, as a misbehaving server might. */
  ignoreTypeFilter?: boolean;
  /** Throw this for a read, before answering it. */
  fail?: (call: RecordedCall) => Error | undefined;
  /** The dictionary read's HTTP status. */
  dictionaryStatus?: number;
}

/** A recording instance that answers the two metadata tables from `world`. */
function fake(world: World, options: FakeOptions = {}): { instance: RecordingInstance; ops: ServiceNowOperations } {
  const instance = recordingInstance();
  const answer = (call: RecordedCall): unknown => {
    const failure = options.fail?.(call);
    if (failure !== undefined) throw failure;
    const table = call.path.split("/").at(-1);
    const query = call.params.sysparm_query ?? "";
    if (table === "sys_db_object") {
      const names = /^nameIN([^^]*)/u.exec(query)![1]!.split(",");
      // Every field the caller asks for, as the instance answers it.
      return {
        result: names
          .filter((name) => name in world.tables && !(world.hiddenRows ?? []).includes(name))
          .map((name) => {
            const row = sysDbObjectRow(name, chainOf(world.tables, name), call.params.sysparm_fields ?? "name", world.hiddenRows);
            if ((world.withoutParentLinks ?? []).includes(name)) {
              for (const key of Object.keys(row)) if (key.endsWith("super_class")) delete row[key];
            }
            return row;
          }),
      };
    }
    if (table === "sys_dictionary") {
      const types = /internal_typeIN([^^]*)/u.exec(query)?.[1]?.split(",");
      return {
        result: world.dictionary
          .filter((row) => options.ignoreTypeFilter === true || types === undefined || types.includes(row.internal_type))
          .map((row) => ({ ...row })),
      };
    }
    throw new Error(`no table ${String(table)} in this fake`);
  };
  const ops = {
    ...instance.ops,
    get: async (path: string, params?: Record<string, string>) => {
      await instance.ops.get(path, params);
      return answer({ operation: "get", path, params: { ...params } });
    },
    getWithMeta: async (path: string, params?: Record<string, string>) => {
      await instance.ops.getWithMeta(path, params);
      const data = answer({ operation: "getWithMeta", path, params: { ...params } });
      const status = path.endsWith("/sys_dictionary") ? options.dictionaryStatus ?? 200 : 200;
      return { data, status, headers: new Headers() };
    },
  } as unknown as ServiceNowOperations;
  return { instance, ops };
}

const tablesRead = (instance: RecordingInstance) => instance.calls.map((call) => call.path.split("/").at(-1));

describe("loadFieldTypesInPlan: reads stay in the plan", () => {
  it("reads only sys_db_object (one hop at a time) and sys_dictionary, never sys_db_view_table", async () => {
    const { instance, ops } = fake(WORLD);
    const loaded = await loadFieldTypesInPlan(ops, ["ssh_credentials", "u_vendor_grandchild", "sys_user", "u_db_view"]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    expect(new Set(tablesRead(instance))).toEqual(new Set(["sys_db_object", "sys_dictionary"]));
    for (const call of instance.calls.filter((c) => c.path.endsWith("/sys_db_object"))) {
      expect(call.params.sysparm_fields).toBe("name,super_class,super_class.name");
    }
    // Levels: the three tables, then their parents, then the grandchild's root.
    expect(instance.calls.filter((c) => c.path.endsWith("/sys_db_object")).map((c) => c.params.sysparm_query)).toEqual([
      "nameINssh_credentials,u_vendor_grandchild,sys_user,u_db_view,sys_db_object",
      "nameINdiscovery_credentials,u_vendor_child",
      "nameINu_vendor",
    ]);
    expect(loaded.hierarchyRead).toBe(true);
    expect(loaded.chains.get("ssh_credentials")).toEqual({ tables: ["ssh_credentials", "discovery_credentials"], complete: true });
    expect(loaded.chains.get("u_vendor_grandchild")?.tables).toEqual(["u_vendor_grandchild", "u_vendor_child", "u_vendor"]);
    expect([...hiddenTypedFields(loaded.types, "ssh_credentials")!]).toEqual(["password"]);
    expect(new Set(hiddenTypedFields(loaded.types, "u_vendor_grandchild"))).toEqual(new Set(["u_api_password", "u_mask"]));
    // A database view has no sys_db_object row: unresolved, so every field on it is unknown.
    expect(loaded.chains.has("u_db_view")).toBe(false);
    expect(hiddenTypedFields(loaded.types, "u_db_view")).toBeUndefined();
    expect(classifyField(loaded.types, "u_db_view", "u_name")).toBe("unknown_type");
    expect(classifyField(loaded.types, "ssh_credentials", "u_name")).toBe("credential_table");
    expect(classifyField(loaded.types, "sys_user", "user_password")).toBe("type");
    expect(classifyField(loaded.types, "sys_user", "user_name")).toBe("visible");
  });

  it("never reads sys_metadata's row: it extends nothing", async () => {
    const { instance, ops } = fake(WORLD);
    const loaded = await loadFieldTypesInPlan(ops, ["sys_script_include", "sys_metadata"]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    const chainReads = instance.calls.filter((c) => c.path.endsWith("/sys_db_object"));
    expect(chainReads.map((c) => c.params.sysparm_query)).toEqual(["nameINsys_script_include,sys_db_object"]);
    expect(loaded.chains.get("sys_metadata")).toEqual({ tables: ["sys_metadata"], complete: true });
  });

  it("agrees with the instance-wide loader on every table that has a sys_db_object row", async () => {
    const tables = ["ssh_credentials", "u_vendor_grandchild", "u_vendor_child", "sys_user", "sys_script_include"];
    const inPlan = fake(WORLD);
    const plan = await loadFieldTypesInPlan(inPlan.ops, tables);
    expectReadsWithin(inPlan.instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    const wide = fake(WORLD);
    const instanceWide = await loadFieldTypes(wide.ops, tables);
    // The instance-wide loader's multi-hop reads are outside any view's plan; it is judged here only as the reference.
    wide.instance.judged = wide.instance.calls.length;
    for (const table of tables) {
      expect(new Set(hiddenTypedFields(plan.types, table)), table).toEqual(new Set(hiddenTypedFields(instanceWide, table)));
    }
  });

  it("reads nothing for no tables, or when both reads are turned off", async () => {
    const { instance, ops } = fake(WORLD);
    const none = await loadFieldTypesInPlan(ops, []);
    expect(none.types.state).toBe("unavailable");
    expect(none.hierarchyRead).toBe(true);
    const off = await loadFieldTypesInPlan(ops, ["sys_user"], { readChains: false, readTypes: false });
    expect(off.types.state).toBe("unavailable");
    expect(off.hierarchyRead).toBe(false);
    expect(instance.calls).toEqual([]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
  });

  it("drops a table name that is not one before it reaches a query", async () => {
    const { instance, ops } = fake(WORLD);
    await loadFieldTypesInPlan(ops, ["sys_user", "x,y", "javascript:gs.userID", "SYS_USER", ""]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    expect(instance.calls.find((c) => c.path.endsWith("/sys_db_object"))!.params.sysparm_query).toBe("nameINsys_user,sys_db_object");
  });
});

describe("loadFieldTypesInPlan: unavailable, never empty", () => {
  const cases: Record<string, { world?: Partial<World>; options?: FakeOptions; load?: Parameters<typeof loadFieldTypesInPlan>[2] }> = {
    "no rows": { world: { dictionary: [] } },
    "a failed read": { options: { fail: (c) => (c.path.endsWith("/sys_dictionary") ? new Error("refused") : undefined) } },
    "a status other than 200": { options: { dictionaryStatus: 403 } },
    "a full page": {
      world: {
        dictionary: Array.from({ length: MAX_HIDDEN_DICTIONARY_ROWS }, (_, index) => ({
          name: `u_table_${index}`,
          element: "u_secret",
          internal_type: "password2",
        })),
      },
    },
    "only rows of other types": {
      world: { dictionary: [{ name: "u_vendor", element: "u_name", internal_type: "string" }] },
      options: { ignoreTypeFilter: true },
    },
    "field policy hiding the dictionary": { load: { readTypes: false } },
    "a filter that drops the type column": { load: { filterDictionaryRow: ({ internal_type: _drop, ...rest }) => rest } },
  };
  for (const [label, { world, options, load }] of Object.entries(cases)) {
    it(`answers unavailable for ${label}`, async () => {
      const { instance, ops } = fake({ ...WORLD, ...world }, options);
      const loaded = await loadFieldTypesInPlan(ops, ["sys_user", "u_vendor_child"], load);
      expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
      expect(loaded.types.state).toBe("unavailable");
      expect(hiddenTypedFields(loaded.types, "sys_user")).toBeUndefined();
      expect(classifyField(loaded.types, "sys_user", "user_name")).toBe("unknown_type");
      // The chains are still read: the credential check does not depend on the types.
      expect(loaded.chains.get("u_vendor_child")?.complete).toBe(true);
    });
  }

  it("rethrows a read that fails after the call was cancelled", async () => {
    const controller = new AbortController();
    const { instance, ops } = fake(WORLD, {
      fail: (c) => {
        if (!c.path.endsWith("/sys_dictionary")) return undefined;
        controller.abort();
        return new Error("aborted");
      },
    });
    await expect(loadFieldTypesInPlan(ops, ["sys_user"], { signal: controller.signal })).rejects.toThrow("aborted");
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
  });
});

describe("loadFieldTypesInPlan: unresolved tables", () => {
  it("leaves a table out of the types when its chain read fails, and says the hierarchy was not read", async () => {
    const { instance, ops } = fake(WORLD, { fail: (c) => (c.path.endsWith("/sys_db_object") ? new Error("refused") : undefined) });
    const loaded = await loadFieldTypesInPlan(ops, ["sys_user", "u_vendor_child"]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    expect(loaded.hierarchyRead).toBe(false);
    expect(loaded.types.state).toBe("available");
    expect(hiddenTypedFields(loaded.types, "sys_user")).toBeUndefined();
    expect(classifyField(loaded.types, "u_vendor_child", "u_name")).toBe("unknown_type");
  });

  it("keeps the levels read before a later level fails, and leaves the incomplete chain unresolved", async () => {
    let reads = 0;
    const { instance, ops } = fake(WORLD, {
      fail: (c) => (c.path.endsWith("/sys_db_object") && ++reads === 2 ? new Error("refused") : undefined),
    });
    const loaded = await loadFieldTypesInPlan(ops, ["u_vendor_child", "sys_user"]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    expect(loaded.hierarchyRead).toBe(false);
    expect(loaded.chains.get("sys_user")).toEqual({ tables: ["sys_user"], complete: true });
    expect(loaded.chains.get("u_vendor_child")).toEqual({ tables: ["u_vendor_child", "u_vendor"], complete: false, gap: "no_row" });
    // A read that failed says so, not a table that is missing.
    expect(loaded.chainsFailure).toEqual({ kind: "failed" });
    expect(loaded.missing).toBeUndefined();
    expect(hiddenTypedFields(loaded.types, "sys_user")).toEqual(new Set(["user_password"]));
    expect(hiddenTypedFields(loaded.types, "u_vendor_child")).toBeUndefined();
  });

  it("stops at the level cap, and treats a chain it did not finish as unresolved", async () => {
    const tables: Record<string, string | null> = { u_level_0: null };
    for (let level = 1; level <= PLAN_CHAIN_LEVELS + 2; level += 1) tables[`u_level_${level}`] = `u_level_${level - 1}`;
    const deepest = `u_level_${PLAN_CHAIN_LEVELS + 2}`;
    const { instance, ops } = fake({ ...WORLD, tables: { ...WORLD.tables, ...tables } });
    const loaded = await loadFieldTypesInPlan(ops, [deepest]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    expect(instance.calls.filter((c) => c.path.endsWith("/sys_db_object"))).toHaveLength(PLAN_CHAIN_LEVELS);
    expect(loaded.hierarchyRead).toBe(false);
    expect(loaded.chains.get(deepest)?.complete).toBe(false);
    expect(hiddenTypedFields(loaded.types, deepest)).toBeUndefined();
  });

  it("reads a chain of up to 12 tables in full, as the instance-wide loader does, and no further", async () => {
    // u_depth_<n>_1 extends u_depth_<n>_2 … up to u_depth_<n>_<n>, which extends nothing.
    const chainOf = (length: number): Record<string, string | null> =>
      Object.fromEntries(
        Array.from({ length }, (_, index) => [`u_depth_${length}_${index + 1}`, index + 1 < length ? `u_depth_${length}_${index + 2}` : null])
      );
    for (const [length, complete] of [[9, true], [12, true], [13, false]] as const) {
      const { instance, ops } = fake({ ...WORLD, tables: { ...WORLD.tables, ...chainOf(length) } });
      const loaded = await loadFieldTypesInPlan(ops, [`u_depth_${length}_1`]);
      expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
      expect(loaded.chains.get(`u_depth_${length}_1`)?.complete, String(length)).toBe(complete);
      expect(loaded.hierarchyRead, String(length)).toBe(complete);
      expect(instance.calls.filter((c) => c.path.endsWith("/sys_db_object")), String(length)).toHaveLength(Math.min(length, 12));
    }
    expect(PLAN_CHAIN_LEVELS).toBe(12);
  });

  it("treats a parent that is not a table name, or a cycle, as an incomplete chain", async () => {
    const { instance, ops } = fake({
      ...WORLD,
      tables: { ...WORLD.tables, u_odd: "Not A Table", u_loop_a: "u_loop_b", u_loop_b: "u_loop_a" },
    });
    const loaded = await loadFieldTypesInPlan(ops, ["u_odd", "u_loop_a"]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    expect(loaded.chains.get("u_odd")).toEqual({ tables: ["u_odd"], complete: false, gap: "malformed" });
    expect(loaded.chains.get("u_loop_a")).toEqual({ tables: ["u_loop_a", "u_loop_b"], complete: false, gap: "malformed" });
    expect(hiddenTypedFields(loaded.types, "u_odd")).toBeUndefined();
    expect(hiddenTypedFields(loaded.types, "u_loop_a")).toBeUndefined();
  });
});

describe("loadFieldTypesInPlan: a child's row never un-hides its parent's type", () => {
  it("keeps an inherited hidden field hidden when the server returns a non-hidden row for it on the child", async () => {
    const world: World = {
      ...WORLD,
      dictionary: [
        ...WORLD.dictionary,
        { name: "u_vendor_child", element: "u_api_password", internal_type: "string" },
        { name: "u_vendor_child", element: "u_mask", internal_type: "string" },
        { name: "u_vendor_grandchild", element: "u_mask", internal_type: "string" },
      ],
    };
    const { instance, ops } = fake(world, { ignoreTypeFilter: true });
    const loaded = await loadFieldTypesInPlan(ops, ["u_vendor_child", "u_vendor_grandchild"]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    for (const table of ["u_vendor_child", "u_vendor_grandchild"]) {
      expect(hiddenTypedFields(loaded.types, table), table).toEqual(new Set(["u_api_password", "u_mask"]));
      expect(classifyField(loaded.types, table, "u_api_password")).toBe("type");
      expect(classifyField(loaded.types, table, "u_mask")).toBe("type");
    }
  });

  it("asks the dictionary for hidden types only, with the fields it declares", async () => {
    const { instance, ops } = fake(WORLD);
    await loadFieldTypesInPlan(ops, ["sys_user"]);
    expectReadsWithin(instance, PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
    const read = instance.calls.find((c) => c.path.endsWith("/sys_dictionary"))!;
    expect(read.params.sysparm_query).toBe("internal_typeINpassword,password2,masked,encrypted_text^ORDERBYname^ORDERBYelement");
    expect(read.params.sysparm_fields).toBe(PLAN_FIELD_TYPE_FIELDS.sys_dictionary.join(","));
  });
});
