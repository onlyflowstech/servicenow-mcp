import { describe, expect, it } from "vitest";
import { buildTableParams, err, formatError, ok, truncate } from "../src/utils.js";

describe("ok", () => {
  it("wraps a string as-is in text content", () => {
    const result = ok("hello");
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("pretty-prints objects as 2-space-indented JSON", () => {
    const result = ok({ a: 1, b: "two" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(JSON.stringify({ a: 1, b: "two" }, null, 2));
    expect(result.content[0].text).toContain("\n  ");
  });

  it("does not set isError", () => {
    expect(ok("x")).not.toHaveProperty("isError");
  });
});

describe("err", () => {
  it("prefixes the message with ERROR: and sets isError", () => {
    const result = err("something broke");
    expect(result).toEqual({
      content: [{ type: "text", text: "ERROR: something broke" }],
      isError: true,
    });
  });
});

describe("formatError", () => {
  it("formats a ServiceNow error object with message, detail, and status", () => {
    const formatted = formatError({
      message: "Insufficient rights",
      detail: "User lacks the itil role",
      status: 403,
    });
    expect(formatted).toBe("Insufficient rights\nDetail: User lacks the itil role (HTTP 403)");
  });

  it("formats a message-only error object", () => {
    expect(formatError({ message: "Not found" })).toBe("Not found");
  });

  it("appends status without detail", () => {
    expect(formatError({ message: "Nope", status: 404 })).toBe("Nope (HTTP 404)");
  });

  it("uses the message of an Error instance", () => {
    expect(formatError(new Error("kaboom"))).toBe("kaboom");
  });

  it("stringifies plain strings", () => {
    expect(formatError("just a string")).toBe("just a string");
  });

  it("stringifies null and objects without a message", () => {
    expect(formatError(null)).toBe("null");
    expect(formatError({ detail: "no message field" })).toBe("[object Object]");
  });
});

describe("buildTableParams", () => {
  it("returns an empty object for empty options", () => {
    expect(buildTableParams({})).toEqual({});
  });

  it("maps every option to its sysparm_* parameter", () => {
    expect(
      buildTableParams({
        query: "active=true^priority=1",
        fields: "sys_id,number,short_description",
        limit: 50,
        offset: 100,
        orderby: "-sys_created_on",
        displayValue: "all",
      })
    ).toEqual({
      sysparm_query: "active=true^priority=1",
      sysparm_fields: "sys_id,number,short_description",
      sysparm_limit: "50",
      sysparm_offset: "100",
      sysparm_orderby: "-sys_created_on",
      sysparm_display_value: "all",
    });
  });

  it("includes zero-valued limit and offset", () => {
    expect(buildTableParams({ limit: 0, offset: 0 })).toEqual({
      sysparm_limit: "0",
      sysparm_offset: "0",
    });
  });

  it("omits empty-string query, fields, orderby, and displayValue", () => {
    expect(
      buildTableParams({ query: "", fields: "", orderby: "", displayValue: "" })
    ).toEqual({});
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("returns strings exactly at maxLen unchanged", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("truncates longer strings and appends an ellipsis", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcde...");
  });
});
