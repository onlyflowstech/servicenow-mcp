import { afterEach, describe, expect, it } from "vitest";

import { isAllFieldSelection, resolveReadableFields } from "../src/field-policy.js";
import { closeHarnesses, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

/**
 * A code table lists by identity and metadata. Its script body runs to
 * kilobytes, so a default read that carried it filled the response budget
 * after a handful of rows; the body is read by naming it.
 */
const CODE_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["sys_script", "script"],
  ["sys_script_include", "script"],
  ["sys_ui_script", "script"],
  ["sys_script_client", "script"],
  ["sys_ws_operation", "operation_script"],
];

describe("the code tables' default fields", () => {
  it.each(CODE_TABLES)("leave the body out of %s and keep it readable", (table, bodyField) => {
    const defaults = resolveReadableFields(table);
    expect(defaults).toContain("sys_id");
    expect(defaults).toContain("name");
    expect(defaults).toContain("active");
    expect(defaults).not.toContain(bodyField);
    // The body is still one named field away, and `all` still reaches it.
    expect(resolveReadableFields(table, { fields: bodyField })).toEqual([bodyField]);
    // `all` and a detailed read select every readable field, the body among them.
    expect(isAllFieldSelection(resolveReadableFields(table, { fields: "all" }))).toBe(true);
    expect(isAllFieldSelection(resolveReadableFields(table, { responseFormat: "detailed" }))).toBe(true);
  });

  it("lists script includes by name, API name and state", () => {
    expect(resolveReadableFields("sys_script_include")).toEqual([
      "sys_id",
      "name",
      "api_name",
      "active",
      "sys_updated_on",
    ]);
  });
});

function scripts(count: number, bodyBytes: number) {
  return Array.from({ length: count }, (_, index) => ({
    sys_id: index.toString(16).padStart(32, "0"),
    name: `Include${String(index).padStart(3, "0")}`,
    api_name: `x_app.Include${index}`,
    active: "true",
    sys_updated_on: "2026-11-01 08:00:00",
    script: "x".repeat(bodyBytes),
  }));
}

describe("a default sn_query on a code table", () => {
  it("returns a page of script includes whole, where bodies filled the budget after a few", async () => {
    // 87 rows of 4 KB bodies: the shape in which a default read once kept 9.
    const connected = await harness(scripts(87, 4_000));
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "p", table: "sys_script_include", limit: 87 },
    });
    expect(result.isError).toBeUndefined();
    const { data, metadata } = result.structuredContent as {
      data: { results: Array<Record<string, unknown>>; truncated?: boolean };
      metadata: { truncation: { truncated: boolean } };
    };
    expect(data.results).toHaveLength(87);
    expect(data.truncated).toBeUndefined();
    expect(metadata.truncation.truncated).toBe(false);
    expect(Object.keys(data.results[0]!).sort()).toEqual(
      ["active", "api_name", "name", "sys_id", "sys_updated_on"]
    );
    expect(JSON.stringify(data).length).toBeLessThan(30_000);
  });

  it("still returns the body when it is named", async () => {
    const connected = await harness(scripts(3, 50));
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "p", table: "sys_script_include", fields: "sys_id,name,script", limit: 3 },
    });
    const { data } = result.structuredContent as { data: { results: Array<Record<string, unknown>> } };
    expect(data.results[0]).toHaveProperty("script");
  });
});
