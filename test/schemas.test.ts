import { describe, expect, it } from "vitest";
import { schema as querySchema } from "../src/tools/query.js";
import { schema as getSchema } from "../src/tools/get.js";
import { schema as batchSchema } from "../src/tools/batch.js";
import { schema as atfSchema } from "../src/tools/atf.js";
import { schema as profileSchema } from "../src/tools/profile.js";
import { profileNameSchema } from "../src/tools/index.js";

/** Join zod issues the same way executeTool renders them. */
function issueString(result: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }): string {
  if (result.success || !result.error) return "";
  return result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
}

describe("sn_query schema", () => {
  it("parses minimal valid input and applies the defaults", () => {
    const parsed = querySchema.parse({ table: "incident" });
    expect(parsed).toEqual({
      table: "incident",
      limit: 20,
      response_format: "concise",
      max_response_bytes: 100000,
    });
  });

  it("parses full valid input", () => {
    const parsed = querySchema.parse({
      table: "change_request",
      query: "active=true",
      fields: "sys_id,number",
      limit: 5,
      offset: 10,
      orderby: "-sys_created_on",
      display_value: "all",
    });
    expect(parsed.table).toBe("change_request");
    expect(parsed.limit).toBe(5);
  });

  it("rejects missing table with a table field path", () => {
    const result = querySchema.safeParse({});
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("table:");
  });

  it("rejects a non-numeric limit with a limit field path", () => {
    const result = querySchema.safeParse({ table: "incident", limit: "20" });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("limit:");
  });

  it("rejects display_value outside the true/false/all enum", () => {
    const result = querySchema.safeParse({ table: "incident", display_value: "yes" });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("display_value:");
  });

  it("rejects out-of-bounds and non-integer limits", () => {
    expect(querySchema.safeParse({ table: "incident", limit: 0 }).success).toBe(false);
    expect(querySchema.safeParse({ table: "incident", limit: 1001 }).success).toBe(false);
    expect(querySchema.safeParse({ table: "incident", limit: 2.5 }).success).toBe(false);
    expect(querySchema.safeParse({ table: "incident", limit: 1 }).success).toBe(true);
    expect(querySchema.safeParse({ table: "incident", limit: 1000 }).success).toBe(true);
  });

  it("rejects negative and non-integer offsets", () => {
    expect(querySchema.safeParse({ table: "incident", offset: -1 }).success).toBe(false);
    expect(querySchema.safeParse({ table: "incident", offset: 1.5 }).success).toBe(false);
    expect(querySchema.safeParse({ table: "incident", offset: 0 }).success).toBe(true);
  });
});

describe("sn_get schema", () => {
  it("rejects display_value outside the true/false/all enum", () => {
    const result = getSchema.safeParse({
      table: "incident",
      sys_id: "11111111111111111111111111111111",
      display_value: "maybe",
    });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("display_value:");
  });

  it("accepts every display_value enum member", () => {
    for (const dv of ["true", "false", "all"]) {
      expect(
        getSchema.safeParse({ table: "incident", sys_id: "11111111111111111111111111111111", display_value: dv }).success
      ).toBe(true);
    }
  });
});

describe("sn_batch schema", () => {
  it("parses a valid update and applies defaults (dry-run, limit 200)", () => {
    const parsed = batchSchema.parse({
      table: "incident",
      structured_query: {
        filter: { type: "equality", field: "active", operator: "eq", value: true },
      },
      action: "update",
      fields: { state: "7" },
    });
    expect(parsed.confirm).toBe(false);
    expect(parsed.limit).toBe(200);
    expect(parsed.action).toBe("update");
  });

  it("parses a valid delete without fields", () => {
    const parsed = batchSchema.parse({
      table: "incident",
      structured_query: {
        filter: { type: "equality", field: "active", operator: "eq", value: false },
      },
      action: "delete",
    });
    expect(parsed.fields).toBeUndefined();
  });

  it("rejects an unknown action with an action field path", () => {
    const result = batchSchema.safeParse({
      table: "incident",
      structured_query: {
        filter: { type: "equality", field: "active", operator: "eq", value: true },
      },
      action: "upsert",
    });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("action:");
  });

  it("rejects missing structured_query with a structured_query field path", () => {
    const result = batchSchema.safeParse({ table: "incident", action: "delete" });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("structured_query:");
  });

  it("does not publish or accept the removed raw query selector", () => {
    expect(Object.keys(batchSchema.shape)).not.toContain("query");
    const result = batchSchema.safeParse({
      table: "incident",
      query: "active=true^ORpasswordISNOTEMPTY",
      action: "delete",
    });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("Use structured_query");

    const mixed = batchSchema.safeParse({
      table: "incident",
      structured_query: {
        filter: { type: "equality", field: "active", operator: "eq", value: true },
      },
      query: "active=true",
      action: "delete",
    });
    expect(mixed.success).toBe(false);
    expect(issueString(mixed)).toContain("Use structured_query");
  });

  it("requires an actual filter and rejects order-only bulk selection", () => {
    const result = batchSchema.safeParse({
      table: "incident",
      structured_query: { order_by: [{ field: "priority" }] },
      action: "delete",
    });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("structured_query.filter");
  });
});

describe("sn_atf schema", () => {
  it("parses minimal valid input and applies defaults (wait, limit)", () => {
    const parsed = atfSchema.parse({ action: "list" });
    expect(parsed.wait).toBe(true);
    expect(parsed.limit).toBe(20);
  });

  it("accepts every documented action", () => {
    for (const action of ["list", "suites", "run", "run-suite", "results"]) {
      expect(atfSchema.safeParse({ action }).success).toBe(true);
    }
  });

  it("rejects an unknown action with an action field path", () => {
    const result = atfSchema.safeParse({ action: "explode" });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("action:");
  });

  it("rejects a non-numeric timeout with a timeout field path", () => {
    const result = atfSchema.safeParse({ action: "run", timeout: "soon" });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("timeout:");
  });
});

describe("sn_profile schema", () => {
  it("has no tool-specific inputs beyond the shared profile selector", () => {
    expect(Object.keys(profileSchema.shape)).toEqual([]);
  });

  it("requires a non-empty profile name and trims it", () => {
    expect(profileNameSchema.safeParse(7).success).toBe(false);
    expect(profileNameSchema.safeParse("").success).toBe(false);
    expect(profileNameSchema.safeParse("   ").success).toBe(false);
    expect(profileNameSchema.safeParse("x".repeat(129)).success).toBe(false);
    expect(profileNameSchema.parse("  secondary  ")).toBe("secondary");
  });
});
