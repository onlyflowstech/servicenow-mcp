import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import {
  MAX_ALL_FIELDS,
  allFieldsCapNotice,
  boundedAllFields,
} from "../src/tools/all-fields-cap.js";
import { resolveReadableFields } from "../src/field-policy.js";

const INCIDENT_DEFAULTS = resolveReadableFields("incident");

/** Dictionary fixture: `columns` on the table, `parent` columns inherited. */
function client(options: {
  readonly columns?: readonly string[];
  readonly parent?: { readonly name: string; readonly columns: readonly string[] };
  readonly dictionaryThrows?: boolean;
}) {
  const get = vi.fn(async (path: string, params?: Record<string, string>) => {
    if (path === "/api/now/table/sys_db_object") {
      const name = params?.sysparm_query?.replace("name=", "");
      return name === "incident" && options.parent
        ? { result: [{ name, super_class: { display_value: options.parent.name } }] }
        : { result: [{ name, super_class: "" }] };
    }
    if (path === "/api/now/table/sys_dictionary") {
      if (options.dictionaryThrows) throw new Error("ACL denied");
      const all = [...(options.columns ?? []), ...(options.parent?.columns ?? [])];
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
