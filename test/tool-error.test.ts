import { describe, expect, it, vi } from "vitest";

import {
  MAX_TOOL_ERROR_RETRY_AFTER_SECONDS,
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
