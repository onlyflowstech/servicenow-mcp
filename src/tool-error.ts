/**
 * Trusted, caller-safe error contract shared by ServiceNow and MCP boundaries.
 *
 * Raw exception messages are never part of this contract. Error provenance is
 * held in a module-private WeakMap, so an arbitrary object that happens to
 * expose fields such as `status` or `category` cannot forge a public category.
 *
 * @module tool-error
 */

/** Exact stable categories exposed to MCP callers. */
export type ToolErrorCategory =
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "timeout"
  | "upstream"
  | "internal";

/** Bounded retry decisions; callers never receive arbitrary retry prose. */
export type ToolErrorRetry =
  | "do_not_retry"
  | "retry_after_correction"
  | "retry_if_safe_and_idempotent"
  | "retry_later";

export interface ToolErrorDescriptor {
  readonly category: ToolErrorCategory;
  readonly message: string;
  readonly retry: ToolErrorRetry;
  readonly retryAfterSeconds?: number;
}

/** Maximum client-visible Retry-After guidance: one hour. */
export const MAX_TOOL_ERROR_RETRY_AFTER_SECONDS = 3_600;

const CATEGORY_MESSAGES: Readonly<Record<ToolErrorCategory, string>> =
  Object.freeze({
    authentication: "ServiceNow authentication could not be completed.",
    authorization: "ServiceNow access was denied.",
    not_found: "The requested ServiceNow resource was not found.",
    conflict: "ServiceNow reported a conflicting resource state.",
    rate_limit: "ServiceNow rate limit was exceeded.",
    timeout: "The ServiceNow request timed out.",
    upstream: "ServiceNow could not complete the request.",
    internal: "The operation failed unexpectedly.",
  });

const RETRY_GUIDANCE: Readonly<Record<ToolErrorRetry, string>> = Object.freeze({
  do_not_retry: "Retry unchanged is not recommended.",
  retry_after_correction: "Retry after correcting the request or configuration.",
  retry_if_safe_and_idempotent:
    "Retry only if the operation is safe and idempotent.",
  retry_later: "Retry later.",
});

const TOOL_ERROR_PROVENANCE = new WeakMap<object, ToolErrorDescriptor>();

const INTERNAL_DESCRIPTOR: ToolErrorDescriptor = descriptor(
  "internal",
  "do_not_retry"
);

/**
 * Issue a trusted structural error. Only fixed module-owned text is attached
 * to the Error; raw upstream/configuration values belong in neither the Error
 * nor its public descriptor.
 */
export function createToolError(
  category: ToolErrorCategory,
  retry: ToolErrorRetry,
  retryAfterSeconds?: number
): Error {
  assertCategory(category);
  assertRetry(retry);
  const safeRetryAfter = validateRetryAfter(retry, retryAfterSeconds);
  const safeDescriptor = descriptor(category, retry, safeRetryAfter);
  const error = new Error(formatToolErrorDescriptor(safeDescriptor));
  error.name = "ServiceNowToolError";
  TOOL_ERROR_PROVENANCE.set(error, safeDescriptor);
  return Object.freeze(error);
}

/** Return trusted metadata only for errors issued by this module. */
export function trustedToolErrorDescriptor(
  candidate: unknown
): ToolErrorDescriptor | undefined {
  if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) {
    return undefined;
  }
  return TOOL_ERROR_PROVENANCE.get(candidate);
}

/**
 * Normalize any thrown value without inspecting it. Unissued errors always
 * become the fixed internal category, including hostile Proxies and getters.
 */
export function safeToolErrorDescriptor(candidate: unknown): ToolErrorDescriptor {
  return trustedToolErrorDescriptor(candidate) ?? INTERNAL_DESCRIPTOR;
}

/** Render one deterministic client-safe sentence sequence. */
export function formatToolErrorDescriptor(value: ToolErrorDescriptor): string {
  const retryAfter =
    value.retryAfterSeconds === undefined
      ? ""
      : ` Retry after ${value.retryAfterSeconds} seconds.`;
  return (
    `${value.message} Error category: ${value.category}. ` +
    `${RETRY_GUIDANCE[value.retry]}${retryAfter}`
  );
}

/** Safely render a trusted error or the fixed internal fallback. */
export function formatToolError(candidate: unknown): string {
  return formatToolErrorDescriptor(safeToolErrorDescriptor(candidate));
}

/**
 * Issue one trusted aggregate failure without retaining any input objects.
 * A unanimous category/retry decision survives. Mixed failures use the fixed
 * conservative `internal` / `do_not_retry` rule. Retry-After survives only
 * when every failure supplies the same bounded value.
 */
export function createCommonToolError(candidates: readonly unknown[]): Error {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return createToolError("internal", "do_not_retry");
  }
  const descriptors = candidates.map((candidate) =>
    safeToolErrorDescriptor(candidate)
  );
  const first = descriptors[0]!;
  if (
    !descriptors.every(
      (candidate) =>
        candidate.category === first.category && candidate.retry === first.retry
    )
  ) {
    return createToolError("internal", "do_not_retry");
  }
  const retryAfterSeconds = descriptors.every(
    (candidate) => candidate.retryAfterSeconds === first.retryAfterSeconds
  )
    ? first.retryAfterSeconds
    : undefined;
  return createToolError(first.category, first.retry, retryAfterSeconds);
}

/** Convert a bounded millisecond delay to safe whole-second guidance. */
export function boundedRetryAfterSeconds(
  milliseconds: number | undefined
): number | undefined {
  if (
    typeof milliseconds !== "number" ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  ) {
    return undefined;
  }
  return Math.min(
    Math.max(1, Math.ceil(milliseconds / 1_000)),
    MAX_TOOL_ERROR_RETRY_AFTER_SECONDS
  );
}

function descriptor(
  category: ToolErrorCategory,
  retry: ToolErrorRetry,
  retryAfterSeconds?: number
): ToolErrorDescriptor {
  return Object.freeze({
    category,
    message: CATEGORY_MESSAGES[category],
    retry,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

function validateRetryAfter(
  retry: ToolErrorRetry,
  candidate: number | undefined
): number | undefined {
  if (candidate === undefined) return undefined;
  if (
    retry !== "retry_later" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > MAX_TOOL_ERROR_RETRY_AFTER_SECONDS
  ) {
    throw new TypeError("tool error retry-after is invalid");
  }
  return candidate;
}

function assertCategory(candidate: string): asserts candidate is ToolErrorCategory {
  if (!Object.hasOwn(CATEGORY_MESSAGES, candidate)) {
    throw new TypeError("tool error category is invalid");
  }
}

function assertRetry(candidate: string): asserts candidate is ToolErrorRetry {
  if (!Object.hasOwn(RETRY_GUIDANCE, candidate)) {
    throw new TypeError("tool error retry decision is invalid");
  }
}
