import { describe, expect, it, vi } from "vitest";
import {
  buildTableParams,
  err,
  escapeQueryValue,
  formatError,
  ok,
  stripEmpty,
  truncate,
} from "../src/utils.js";
import {
  createToolError,
  type ToolErrorCategory,
  type ToolErrorRetry,
} from "../src/tool-error.js";

describe("ok", () => {
  it("wraps a string as-is in text content", () => {
    const result = ok("hello");
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("serializes objects as compact JSON with no indentation", () => {
    const result = ok({ a: 1, b: "two", nested: { c: [1, 2] } });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe('{"a":1,"b":"two","nested":{"c":[1,2]}}');
    expect(result.content[0].text).not.toContain("\n");
    expect(result.content[0].text).not.toContain("  ");
  });

  it("does not set isError", () => {
    expect(ok("x")).not.toHaveProperty("isError");
  });
});

describe("stripEmpty", () => {
  it("drops empty-string and null object entries", () => {
    expect(stripEmpty({ a: "", b: null, c: "keep" })).toEqual({ c: "keep" });
  });

  it("keeps false, 0, and empty arrays", () => {
    expect(stripEmpty({ active: false, count: 0, tags: [] })).toEqual({
      active: false,
      count: 0,
      tags: [],
    });
  });

  it("recurses into nested objects", () => {
    expect(
      stripEmpty({ outer: { a: "", b: null, c: "x", inner: { d: null, e: 1 } } })
    ).toEqual({ outer: { c: "x", inner: { e: 1 } } });
  });

  it("recurses into arrays of objects without removing array elements", () => {
    expect(
      stripEmpty([
        { a: "", b: "one" },
        { a: null, b: "two" },
      ])
    ).toEqual([{ b: "one" }, { b: "two" }]);
  });

  it("keeps empty objects produced by stripping", () => {
    expect(stripEmpty({ meta: { a: "", b: null } })).toEqual({ meta: {} });
  });

  it("passes primitives through unchanged", () => {
    expect(stripEmpty("text")).toBe("text");
    expect(stripEmpty(42)).toBe(42);
    expect(stripEmpty(false)).toBe(false);
    expect(stripEmpty(null)).toBe(null);
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
  it.each([
    [
      "authentication",
      "retry_after_correction",
      "ServiceNow authentication could not be completed. Error category: authentication. Retry after correcting the request or configuration.",
    ],
    [
      "authorization",
      "retry_after_correction",
      "ServiceNow access was denied. Error category: authorization. Retry after correcting the request or configuration.",
    ],
    [
      "not_found",
      "do_not_retry",
      "The requested ServiceNow resource was not found. Error category: not_found. Retry unchanged is not recommended.",
    ],
    [
      "timeout",
      "retry_if_safe_and_idempotent",
      "The ServiceNow request timed out. Error category: timeout. Retry only if the operation is safe and idempotent.",
    ],
    [
      "conflict",
      "retry_after_correction",
      "ServiceNow reported a conflicting resource state. Error category: conflict. Retry after correcting the request or configuration.",
    ],
    [
      "rate_limit",
      "retry_later",
      "ServiceNow rate limit was exceeded. Error category: rate_limit. Retry later.",
    ],
    [
      "upstream",
      "retry_if_safe_and_idempotent",
      "ServiceNow could not complete the request. Error category: upstream. Retry only if the operation is safe and idempotent.",
    ],
    [
      "internal",
      "do_not_retry",
      "The operation failed unexpectedly. Error category: internal. Retry unchanged is not recommended.",
    ],
  ] as ReadonlyArray<readonly [ToolErrorCategory, ToolErrorRetry, string]>) (
    "uses fixed safe guidance for trusted %s errors",
    (category, retry, expected) => {
      expect(formatError(createToolError(category, retry))).toBe(expected);
    }
  );

  it.each([
    new Error(
      "Authorization: Bearer RAW_SECRET_TOKEN https://host.invalid/api?secret=RAW_QUERY_SECRET"
    ),
    "RAW_STRING_SECRET",
    null,
    {
      message: "RAW_MESSAGE_SECRET",
      detail: "RAW_DETAIL_SECRET",
      cause: new Error("RAW_CAUSE_SECRET"),
      body: { token: "RAW_BODY_SECRET" },
      headers: { Authorization: "Bearer RAW_HEADER_SECRET" },
    },
    { status: "403", message: "RAW_COERCION_SECRET" },
    { status: Number.NaN, detail: "RAW_NAN_SECRET" },
    { status: 999, detail: "RAW_RANGE_SECRET" },
  ])("replaces arbitrary thrown values and nested details with one safe message", (error) => {
    const formatted = formatError(error);
    expect(formatted).toBe(
      "The operation failed unexpectedly. Error category: internal. " +
        "Retry unchanged is not recommended."
    );
    expect(formatted).not.toMatch(/RAW_|Bearer|Authorization|secret=|host\.invalid/i);
  });

  it("fails closed when reading a hostile status getter throws", () => {
    const hostile = Object.defineProperty({}, "status", {
      get() {
        throw new Error("RAW_GETTER_SECRET");
      },
    });
    expect(formatError(hostile)).toBe(
      "The operation failed unexpectedly. Error category: internal. " +
        "Retry unchanged is not recommended."
    );
  });

  it("does not execute Proxy traps while checking encoded-policy provenance", () => {
    const getPrototypeOf = vi.fn(() => {
      throw new Error("RAW_POLICY_PROXY_SECRET");
    });
    const hostile = new Proxy({}, { getPrototypeOf });

    expect(formatError(hostile)).toBe(
      "The operation failed unexpectedly. Error category: internal. " +
        "Retry unchanged is not recommended."
    );
    expect(getPrototypeOf).not.toHaveBeenCalled();
  });
});

describe("buildTableParams", () => {
  it("always sets sysparm_exclude_reference_link=true, even for empty options", () => {
    expect(buildTableParams({})).toEqual({
      sysparm_exclude_reference_link: "true",
    });
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
      sysparm_exclude_reference_link: "true",
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
      sysparm_exclude_reference_link: "true",
      sysparm_limit: "0",
      sysparm_offset: "0",
    });
  });

  it("omits empty-string query, fields, orderby, and displayValue", () => {
    expect(
      buildTableParams({ query: "", fields: "", orderby: "", displayValue: "" })
    ).toEqual({ sysparm_exclude_reference_link: "true" });
  });
});

describe("escapeQueryValue", () => {
  it("strips the ^ condition separator so values cannot inject conditions", () => {
    expect(escapeQueryValue("x^ORactive=false")).toBe("xORactive=false");
  });

  it("strips every occurrence, including chained ^OR/^NQ sequences", () => {
    expect(escapeQueryValue("a^ORb^NQc^EQ")).toBe("aORbNQcEQ");
  });

  it("passes ordinary values through unchanged", () => {
    expect(escapeQueryValue("web-server-01")).toBe("web-server-01");
    expect(escapeQueryValue("has spaces & symbols =!<>")).toBe("has spaces & symbols =!<>");
    expect(escapeQueryValue("")).toBe("");
  });

  // ServiceNow evaluates a leading "javascript:" on the value side of a
  // condition server-side -- a value must never opt into evaluation.
  it("strips a leading javascript: prefix so values are matched literally", () => {
    expect(escapeQueryValue("javascript:gs.getUserID()")).toBe("gs.getUserID()");
  });

  it("strips the prefix case-insensitively and when nested", () => {
    expect(escapeQueryValue("JavaScript:gs.getUserID()")).toBe("gs.getUserID()");
    expect(escapeQueryValue("javascript:javascript:gs.now()")).toBe("gs.now()");
    expect(escapeQueryValue("  javascript:gs.now()")).toBe("gs.now()");
  });

  it("strips a javascript: prefix revealed by ^ removal", () => {
    expect(escapeQueryValue("java^script:gs.now()")).toBe("gs.now()");
  });

  it("leaves javascript: intact when it is not a prefix", () => {
    expect(escapeQueryValue("about javascript: the language")).toBe(
      "about javascript: the language"
    );
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
