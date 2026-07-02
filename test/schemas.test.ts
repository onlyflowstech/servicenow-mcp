import { describe, expect, it } from "vitest";
import { schema as querySchema } from "../src/tools/query.js";
import { schema as getSchema } from "../src/tools/get.js";
import { schema as batchSchema } from "../src/tools/batch.js";
import { schema as atfSchema } from "../src/tools/atf.js";

/** Join zod issues the same way executeTool renders them. */
function issueString(result: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }): string {
  if (result.success || !result.error) return "";
  return result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
}

describe("sn_query schema", () => {
  it("parses minimal valid input and applies the default limit", () => {
    const parsed = querySchema.parse({ table: "incident" });
    expect(parsed).toEqual({ table: "incident", limit: 20 });
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
      profile: "secondary",
    });
    expect(parsed.table).toBe("change_request");
    expect(parsed.limit).toBe(5);
    expect(parsed.profile).toBe("secondary");
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
      sys_id: "abc",
      display_value: "maybe",
    });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("display_value:");
  });

  it("accepts every display_value enum member", () => {
    for (const dv of ["true", "false", "all"]) {
      expect(
        getSchema.safeParse({ table: "incident", sys_id: "abc", display_value: dv }).success
      ).toBe(true);
    }
  });
});

describe("sn_batch schema", () => {
  it("parses a valid update and applies defaults (dry-run, limit 200)", () => {
    const parsed = batchSchema.parse({
      table: "incident",
      query: "active=true",
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
      query: "active=false",
      action: "delete",
    });
    expect(parsed.fields).toBeUndefined();
  });

  it("rejects an unknown action with an action field path", () => {
    const result = batchSchema.safeParse({
      table: "incident",
      query: "active=true",
      action: "upsert",
    });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("action:");
  });

  it("rejects missing query with a query field path", () => {
    const result = batchSchema.safeParse({ table: "incident", action: "delete" });
    expect(result.success).toBe(false);
    expect(issueString(result)).toContain("query:");
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
