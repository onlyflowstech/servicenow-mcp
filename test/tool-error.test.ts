import { describe, expect, it, vi } from "vitest";

import { ServiceNowResponseTooLargeError } from "../src/client.js";
import {
  BASIC_AUTH_401_HINT,
  MAX_TOOL_ERROR_RETRY_AFTER_SECONDS,
  createAmbiguousCiNameError,
  createBasicAuthRestrictedError,
  createFilterFieldsTooLargeError,
  createUnknownFilterFieldError,
  boundedRetryAfterSeconds,
  createCommonToolError,
  createToolError,
  formatToolError,
  safeToolErrorDescriptor,
  trustedToolErrorDescriptor,
  type ToolErrorCategory,
  type ToolErrorRetry,
} from "../src/tool-error.js";

const CASES: ReadonlyArray<
  readonly [ToolErrorCategory, ToolErrorRetry, string]
> = [
  [
    "authentication",
    "retry_after_correction",
    "ServiceNow authentication could not be completed.",
  ],
  ["authorization", "retry_after_correction", "ServiceNow access was denied."],
  ["not_found", "do_not_retry", "The requested ServiceNow resource was not found."],
  ["conflict", "retry_after_correction", "ServiceNow reported a conflicting resource state."],
  ["rate_limit", "retry_later", "ServiceNow rate limit was exceeded."],
  ["timeout", "retry_if_safe_and_idempotent", "The ServiceNow request timed out."],
  ["upstream", "retry_if_safe_and_idempotent", "ServiceNow could not complete the request."],
  [
    "too_large",
    "retry_after_correction",
    "The response was too large to return in one call. Lower limit, request fewer fields, or narrow the query, then retry.",
  ],
  ["internal", "do_not_retry", "The operation failed unexpectedly."],
];

describe("trusted tool-error contract", () => {
  it.each(CASES)(
    "issues fixed, frozen %s errors",
    (category, retry, expectedMessage) => {
      const error = createToolError(category, retry);
      const publicError = trustedToolErrorDescriptor(error);

      expect(Object.isFrozen(error)).toBe(true);
      expect(Object.isFrozen(publicError)).toBe(true);
      expect(publicError).toEqual({
        category,
        message: expectedMessage,
        retry,
      });
      expect(formatToolError(error)).toContain(`Error category: ${category}.`);
      expect(error.message).toBe(formatToolError(error));
    }
  );

  it("does not trust forged fields or inspect hostile values", () => {
    const getter = vi.fn(() => {
      throw new Error("RAW_GETTER_SECRET");
    });
    const forged = new Proxy(
      Object.defineProperties({}, {
        category: { get: getter },
        retry: { get: getter },
        message: { get: getter },
        status: { get: getter },
      }),
      {
        get() {
          throw new Error("RAW_PROXY_SECRET");
        },
      }
    );

    expect(trustedToolErrorDescriptor(forged)).toBeUndefined();
    expect(safeToolErrorDescriptor(forged)).toEqual({
      category: "internal",
      message: "The operation failed unexpectedly.",
      retry: "do_not_retry",
    });
    expect(formatToolError(forged)).toBe(
      "The operation failed unexpectedly. Error category: internal. " +
        "Retry unchanged is not recommended."
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("never reproduces arbitrary thrown text", () => {
    const canary =
      "Authorization: Bearer RAW_TOKEN https://host.invalid/?sysparm_query=secret";
    const rendered = formatToolError(
      Object.assign(new Error(canary), {
        detail: canary,
        body: { credential: canary },
      })
    );

    expect(rendered).toBe(
      "The operation failed unexpectedly. Error category: internal. " +
        "Retry unchanged is not recommended."
    );
    expect(rendered).not.toMatch(/RAW_TOKEN|sysparm_query|credential|host\.invalid/u);
  });

  it("accepts only bounded retry-after guidance for retry_later", () => {
    expect(
      trustedToolErrorDescriptor(createToolError("rate_limit", "retry_later", 17))
    ).toEqual({
      category: "rate_limit",
      message: "ServiceNow rate limit was exceeded.",
      retry: "retry_later",
      retryAfterSeconds: 17,
    });
    expect(formatToolError(createToolError("rate_limit", "retry_later", 17))).toBe(
      "ServiceNow rate limit was exceeded. Error category: rate_limit. " +
        "Retry later. Retry after 17 seconds."
    );
    expect(() => createToolError("rate_limit", "retry_later", 0)).toThrow(
      "tool error retry-after is invalid"
    );
    expect(() =>
      createToolError(
        "rate_limit",
        "retry_later",
        MAX_TOOL_ERROR_RETRY_AFTER_SECONDS + 1
      )
    ).toThrow("tool error retry-after is invalid");
    expect(() => createToolError("timeout", "do_not_retry", 1)).toThrow(
      "tool error retry-after is invalid"
    );
  });

  it("converts retry delays without exposing hostile magnitudes", () => {
    expect(boundedRetryAfterSeconds(undefined)).toBeUndefined();
    expect(boundedRetryAfterSeconds(Number.NaN)).toBeUndefined();
    expect(boundedRetryAfterSeconds(-1)).toBeUndefined();
    expect(boundedRetryAfterSeconds(0)).toBe(1);
    expect(boundedRetryAfterSeconds(1_001)).toBe(2);
    expect(boundedRetryAfterSeconds(Number.MAX_VALUE)).toBe(
      MAX_TOOL_ERROR_RETRY_AFTER_SECONDS
    );
  });

  it("preserves unanimous aggregate taxonomy and fails mixed sets closed", () => {
    const unanimous = createCommonToolError([
      createToolError("authorization", "retry_after_correction"),
      createToolError("authorization", "retry_after_correction"),
    ]);
    expect(trustedToolErrorDescriptor(unanimous)).toEqual({
      category: "authorization",
      message: "ServiceNow access was denied.",
      retry: "retry_after_correction",
    });

    const sameRateLimit = createCommonToolError([
      createToolError("rate_limit", "retry_later", 19),
      createToolError("rate_limit", "retry_later", 19),
    ]);
    expect(trustedToolErrorDescriptor(sameRateLimit)).toMatchObject({
      category: "rate_limit",
      retry: "retry_later",
      retryAfterSeconds: 19,
    });
    const differingRetryAfter = createCommonToolError([
      createToolError("rate_limit", "retry_later", 19),
      createToolError("rate_limit", "retry_later", 23),
    ]);
    expect(trustedToolErrorDescriptor(differingRetryAfter)).toMatchObject({
      category: "rate_limit",
      retry: "retry_later",
    });
    expect(
      trustedToolErrorDescriptor(differingRetryAfter)?.retryAfterSeconds
    ).toBeUndefined();

    const mixed = createCommonToolError([
      createToolError("authorization", "retry_after_correction"),
      createToolError("timeout", "retry_if_safe_and_idempotent"),
    ]);
    expect(trustedToolErrorDescriptor(mixed)).toEqual({
      category: "internal",
      message: "The operation failed unexpectedly.",
      retry: "do_not_retry",
    });
  });
});

describe("basic-auth restriction error", () => {
  it("is an authentication error carrying only the fixed hint", () => {
    const error = createBasicAuthRestrictedError();
    expect(trustedToolErrorDescriptor(error)).toMatchObject({
      category: "authentication",
      reason: "basic_auth_restricted",
      retry: "retry_after_correction",
    });
    expect(formatToolError(error)).toBe(
      `ServiceNow authentication could not be completed. ${BASIC_AUTH_401_HINT} ` +
        "Error category: authentication. Retry after correcting the request or configuration."
    );
    expect(BASIC_AUTH_401_HINT).toContain("snc_basic_auth_api_access");
  });

  it("survives aggregation only when every failure is the same error", () => {
    const same = createCommonToolError([
      createBasicAuthRestrictedError(),
      createBasicAuthRestrictedError(),
    ]);
    expect(trustedToolErrorDescriptor(same)?.reason).toBe("basic_auth_restricted");

    const mixed = createCommonToolError([
      createBasicAuthRestrictedError(),
      createToolError("authentication", "retry_after_correction"),
    ]);
    expect(trustedToolErrorDescriptor(mixed)?.reason).toBeUndefined();
  });
});

describe("a response that passed its byte limit", () => {
  const TOO_LARGE_MESSAGE =
    "The response was too large to return in one call. Lower limit, request fewer fields, " +
    "or narrow the query, then retry. Error category: too_large. " +
    "Retry after correcting the request or configuration.";

  it("is reported as too_large, with a remedy, for the response cap and the call's budget", () => {
    for (const message of [
      "raw response exceeds configured byte limit",
      "cumulative upstream response exceeds configured byte limit",
    ]) {
      const error = new ServiceNowResponseTooLargeError(message);
      expect(safeToolErrorDescriptor(error)).toEqual({
        category: "too_large",
        message:
          "The response was too large to return in one call. Lower limit, request fewer fields, or narrow the query, then retry.",
        retry: "retry_after_correction",
      });
      expect(formatToolError(error)).toBe(TOO_LARGE_MESSAGE);
      // The text is fixed: nothing of the raw message reaches the caller.
      expect(formatToolError(error)).not.toContain(message);
    }
  });

  it("never replaces a trusted error that is about a too-large read, the unknown-field error or the basic-auth hint", () => {
    const filterFields = createFilterFieldsTooLargeError();
    expect(safeToolErrorDescriptor(filterFields)).toMatchObject({
      category: "upstream",
      reason: "filter_fields_too_large",
    });
    expect(formatToolError(filterFields)).toContain("Lower limit and try again.");
    expect(formatToolError(filterFields)).not.toContain("too_large");
    expect(safeToolErrorDescriptor(createUnknownFilterFieldError("u_nope"))).toMatchObject({
      category: "not_found",
      reason: "unknown_filter_field",
    });
    expect(formatToolError(createBasicAuthRestrictedError())).toContain(BASIC_AUTH_401_HINT);
    expect(safeToolErrorDescriptor(createBasicAuthRestrictedError()).category).toBe("authentication");
  });

  it("keeps its unissued status for callers that must treat an over-budget response as an unknown outcome", () => {
    expect(trustedToolErrorDescriptor(new ServiceNowResponseTooLargeError("x"))).toBeUndefined();
  });

  it("is not forged by a look-alike error or a hostile object", () => {
    const lookAlike = new RangeError("raw response exceeds configured byte limit");
    lookAlike.name = "ServiceNowResponseTooLargeError";
    expect(safeToolErrorDescriptor(lookAlike).category).toBe("internal");
    expect(safeToolErrorDescriptor(new RangeError("Maximum call stack size exceeded")).category).toBe(
      "internal"
    );
    const trap = vi.fn(() => {
      throw new Error("RAW_TRAP_SECRET");
    });
    const hostile = new Proxy(new ServiceNowResponseTooLargeError("x"), {
      get: trap,
      getPrototypeOf: trap,
      has: trap,
    });
    expect(safeToolErrorDescriptor(hostile).category).toBe("internal");
    expect(trap).not.toHaveBeenCalled();
  });

  it("survives an aggregate of the same failure and loses to a different one", () => {
    const sameFailure = createCommonToolError([
      new ServiceNowResponseTooLargeError("a"),
      new ServiceNowResponseTooLargeError("b"),
    ]);
    expect(trustedToolErrorDescriptor(sameFailure)).toMatchObject({
      category: "too_large",
      retry: "retry_after_correction",
    });
    const mixed = createCommonToolError([
      new ServiceNowResponseTooLargeError("a"),
      createToolError("timeout", "retry_if_safe_and_idempotent"),
    ]);
    expect(trustedToolErrorDescriptor(mixed)?.category).toBe("internal");
  });
});


describe("the ambiguous CI name error", () => {
  const id = (digit: string) => digit.repeat(32);

  it("lists each match with its name, class and sys_id, and says when more share the name", () => {
    const error = createAmbiguousCiNameError(
      "web-01",
      [
        { sys_id: id("a"), name: "web-01", class: "Linux Server" },
        { sys_id: id("b"), name: "web-01" },
        { sys_id: id("c") },
      ],
      true
    );
    expect(trustedToolErrorDescriptor(error)).toMatchObject({
      category: "conflict",
      reason: "ambiguous_ci_name",
      retry: "retry_after_correction",
    });
    expect(formatToolError(error)).toContain(
      `ci_name "web-01" matches more than one CI. Retry with sys_id set to one of: ` +
        `web-01, class Linux Server, sys_id ${id("a")}; web-01, sys_id ${id("b")}; ` +
        `(no name shown), sys_id ${id("c")}; more CIs share this name.`
    );
  });

  it("makes instance text inert and bounded, and drops a match without a real sys_id", () => {
    const error = createAmbiguousCiNameError(
      'bad "name"\n\u202E' + "x".repeat(500),
      [
        { sys_id: "not-a-sys-id", name: "dropped" },
        { sys_id: id("d"), name: 'line\nbreak "quoted"', class: "y".repeat(500) },
      ],
      false
    );
    const text = formatToolError(error);
    expect(text).not.toMatch(/[\n\u202E]/u);
    expect(text).not.toContain("dropped");
    expect(text).toContain("line break 'quoted'");
    expect(text.length).toBeLessThan(900);
    expect(text).not.toContain("more CIs share");
  });

  it("lists at most ten matches", () => {
    const many = Array.from({ length: 15 }, (_, index) => ({ sys_id: index.toString(16).padStart(32, "0") }));
    expect(formatToolError(createAmbiguousCiNameError("n", many, false)).match(/sys_id [0-9a-f]{32}/gu)).toHaveLength(10);
  });

  it("removes tag, bidi and zero-width characters from a name and a class label", () => {
    const tags = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e, 0xe007f);
    const hidden = `${tags}\u202E\u200B\u2060\uFEFF\u00AD`;
    const text = formatToolError(
      createAmbiguousCiNameError(
        `web${hidden}-01`,
        [{ sys_id: id("a"), name: `web${hidden}-01`, class: `Linux${hidden} Server` }],
        false
      )
    );
    expect(text).toContain(`ci_name "web-01" matches more than one CI`);
    expect(text).toContain(`web-01, class Linux Server, sys_id ${id("a")}`);
    expect(text).not.toMatch(/[\u{E0000}-\u{E007F}\u202A-\u202E\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/u);
  });
});
