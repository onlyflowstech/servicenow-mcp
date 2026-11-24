/**
 * Trusted, caller-safe error contract shared by ServiceNow and MCP boundaries.
 *
 * Raw exception messages are never part of this contract. The one place
 * instance text enters an error is `createAmbiguousCiNameError`, which lists
 * CI names and classes after `inertText` (inert-text.ts) has cleaned them.
 * Error provenance is
 * held in a module-private WeakMap, so an arbitrary object that happens to
 * expose fields such as `status` or `category` cannot forge a public category.
 *
 * @module tool-error
 */

import { quotedInertText } from "./inert-text.js";
import { isIssuedResponseTooLargeError } from "./response-too-large.js";

/** Exact stable categories exposed to MCP callers. */
export type ToolErrorCategory =
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "timeout"
  | "upstream"
  | "too_large"
  | "internal";

/** Bounded retry decisions; callers never receive arbitrary retry prose. */
export type ToolErrorRetry =
  | "do_not_retry"
  | "retry_after_correction"
  | "retry_if_safe_and_idempotent"
  | "retry_later";

/**
 * Fixed sub-reasons within the `upstream` category for a response that is an
 * HTML page instead of an API response. No upstream text is part of either.
 */
export type ToolErrorReason =
  | "instance_hibernating"
  | "html_response"
  | "invalid_response"
  | "redirected"
  | "basic_auth_restricted"
  | "unknown_filter_field"
  | "filter_fields_too_large"
  | "invalid_cursor"
  | "max_response_bytes_too_small"
  | "ambiguous_ci_name"
  | "start_ci_required"
  | "argument_too_long";

export interface ToolErrorDescriptor {
  readonly category: ToolErrorCategory;
  readonly reason?: ToolErrorReason;
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
    too_large:
      "The response was too large to return in one call. Lower limit, request " +
      "fewer fields, or narrow the query, then retry.",
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

const TOO_LARGE_DESCRIPTOR: ToolErrorDescriptor = descriptor(
  "too_large",
  "retry_after_correction"
);

const HTML_RESPONSE_MESSAGE =
  "The instance returned an HTML page instead of an API response. It may be " +
  "asleep, behind single sign-on, or under maintenance. Check that the " +
  "instance URL is reachable in a browser.";

/**
 * Fixed guidance for a 401 on a basic-auth profile. It is module-owned text:
 * no credential, host or response byte is ever part of it.
 */
export const BASIC_AUTH_401_HINT =
  "If the username and password are correct, this instance may be rejecting " +
  "Basic Auth for REST API calls (see KB3096078). Current instances require " +
  "the role snc_basic_auth_api_access for REST Basic auth; a " +
  "Web-Service-Access-Only account is also exempt. ServiceNow is retiring " +
  "Basic auth, so OAuth client credentials are recommended: switch this " +
  "profile to OAuth (authType: 'oauth').";

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/u;

function hibernatingMessage(host: string | undefined): string {
  const subject =
    host !== undefined && HOST_PATTERN.test(host)
      ? `The ServiceNow instance ${host}`
      : "The ServiceNow instance";
  return (
    `${subject} appears to be hibernating. Developer instances sleep when ` +
    "idle: wake it at https://developer.servicenow.com, wait a few minutes, " +
    "then retry."
  );
}

/**
 * Issue the trusted error for a hibernating instance. `host` must come from
 * the validated profile configuration, never from a response; a value that is
 * not a plain host[:port] is dropped rather than echoed.
 */
export function createInstanceHibernatingError(host?: string): Error {
  return issue({
    category: "upstream",
    reason: "instance_hibernating",
    message: hibernatingMessage(host),
    retry: "retry_later",
  });
}

/** Issue the trusted error for an HTML page where an API response was due. */
export function createHtmlResponseError(): Error {
  return issue({
    category: "upstream",
    reason: "html_response",
    message: HTML_RESPONSE_MESSAGE,
    retry: "retry_after_correction",
  });
}

/** Issue the trusted error for a success response whose body is not valid JSON. */
export function createInvalidResponseError(): Error {
  return issue({
    category: "upstream",
    reason: "invalid_response",
    message:
      "The instance returned a response that is not valid JSON. Check that the " +
      "instance URL is correct and reachable in a browser.",
    retry: "do_not_retry",
  });
}

/** Issue the trusted error for a 3xx response; the Location is never read. */
export function createRedirectedError(): Error {
  return issue({
    category: "upstream",
    reason: "redirected",
    message:
      "The instance redirected the request to another location. Check that " +
      "the profile's instance URL is the instance's canonical URL.",
    retry: "retry_after_correction",
  });
}

/**
 * Issue the trusted authentication error for a 401 on a basic-auth profile.
 * The text is the fixed category message plus {@link BASIC_AUTH_401_HINT};
 * the response body and the credential are never read into it.
 */
export function createBasicAuthRestrictedError(): Error {
  return issue({
    category: "authentication",
    reason: "basic_auth_restricted",
    message: `${CATEGORY_MESSAGES.authentication} ${BASIC_AUTH_401_HINT}`,
    retry: "retry_after_correction",
  });
}

/**
 * A canonical field name: lowercase identifier, with dot-walked segments. It
 * is the only shape a field name is echoed in, and it bounds the echo.
 */
export const CANONICAL_FIELD_PATTERN =
  /^[a-z][a-z0-9_]{0,79}(?:\.[a-z][a-z0-9_]{0,79}){0,7}$/u;

/**
 * Issue the trusted error for a filter or order on a field the rows do not
 * carry. The field name is echoed only when it is canonical, never anything
 * else the caller typed.
 */
export function createUnknownFilterFieldError(field: string): Error {
  const subject =
    typeof field === "string" && CANONICAL_FIELD_PATTERN.test(field)
      ? `The filter field "${field}"`
      : "A filter or order field";
  return issue({
    category: "not_found",
    reason: "unknown_filter_field",
    message:
      `${subject} was not found on the table, or is not readable by this ` +
      "user. ServiceNow ignores a condition on a field it does not have, so " +
      "the filter would match unrelated rows. Check the field name with " +
      "sn_schema.",
    retry: "retry_after_correction",
  });
}

/**
 * Issue the trusted error for a read that passed the response size bound only
 * because the filter's own fields were asked for with it.
 */
export function createFilterFieldsTooLargeError(): Error {
  return issue({
    category: "upstream",
    reason: "filter_fields_too_large",
    message:
      "The response was too large once the fields used by the filter were " +
      "included. Lower limit and try again.",
    retry: "retry_after_correction",
  });
}

/**
 * Issue the trusted error for a result that cannot be fitted to the caller's
 * `max_response_bytes` at all, for a tool whose limit the caller sets.
 */
export function createResponseBytesTooSmallError(): Error {
  return issue({
    category: "too_large",
    reason: "max_response_bytes_too_small",
    message:
      "The result does not fit max_response_bytes. Raise max_response_bytes, " +
      "or lower limit, and try again.",
    retry: "retry_after_correction",
  });
}

/**
 * Issue the trusted error for a tail request that cannot be served: a cursor
 * that is malformed, oversized or issued for different filters, an offset
 * sent with a tail, or a cursor older than the longest read window. The text is fixed, so a rejected cursor is never echoed,
 * and for a cursor it does not say which of the three it was.
 */
export function createInvalidCursorError(problem: "cursor" | "offset" | "window" = "cursor"): Error {
  return issue({
    category: "conflict",
    reason: "invalid_cursor",
    message:
      problem === "offset"
        ? "offset cannot be used with tail or after_cursor; a tail pages by cursor."
        : problem === "window"
          ? "The after_cursor is older than the longest window a read allows. " +
            "Start a new tail with tail=true."
          : "The after_cursor cannot be used. It is malformed, or it was issued " +
          "for a different level, source or message filter. Repeat the original " +
          "filters with the cursor from the last call, or start a new tail with " +
          "tail=true.",
    retry: "retry_after_correction",
  });
}

/** One CI an ambiguous name matched; `name` and `class` only when the profile can read them. */
export interface AmbiguousCiMatch {
  readonly sys_id: string;
  readonly name?: string;
  readonly class?: string;
}

const MAX_AMBIGUOUS_MATCHES = 10;
const AMBIGUOUS_SYS_ID = /^[0-9a-f]{32}$/u;

/**
 * Issue the trusted error for a CI name that matches more than one CI. It
 * lists up to the first {@link MAX_AMBIGUOUS_MATCHES} matches the caller was
 * shown the fields of, each as name, class and sys_id, and says if more CIs
 * share the name, so one retry can name the CI by sys_id. Names and classes
 * are instance text read from `cmdb_ci` under the profile's field policy; they
 * are made inert and bounded here, and a sys_id that is not 32 hex characters
 * is dropped.
 */
export function createAmbiguousCiNameError(
  name: string,
  matches: readonly AmbiguousCiMatch[],
  more: boolean
): Error {
  const listed = matches
    .filter((match) => typeof match.sys_id === "string" && AMBIGUOUS_SYS_ID.test(match.sys_id))
    .slice(0, MAX_AMBIGUOUS_MATCHES)
    .map((match) => {
      const label = quotedInertText(match.name);
      const cls = quotedInertText(match.class, 60);
      return [
        label === "" ? "(no name shown)" : label,
        ...(cls === "" ? [] : [`class ${cls}`]),
        `sys_id ${match.sys_id}`,
      ].join(", ");
    });
  const subject = quotedInertText(name);
  return issue({
    category: "conflict",
    reason: "ambiguous_ci_name",
    message:
      `ci_name "${subject}" matches more than one CI. Retry with sys_id set to one of: ` +
      `${listed.join("; ")}${more ? "; more CIs share this name" : ""}.`,
    retry: "retry_after_correction",
  });
}

/** Issue the trusted error for an argument over its length bound; only a fixed argument name is echoed, never the value. */
export function createArgumentTooLongError(argument: "ci_name" | "type" | "class", max: number): Error {
  const name = argument === "ci_name" || argument === "type" || argument === "class" ? argument : "An argument";
  return issue({
    category: "conflict",
    reason: "argument_too_long",
    message: `The ${name} argument is longer than ${Number.isSafeInteger(max) ? max : 0} characters. Shorten it and try again.`,
    retry: "retry_after_correction",
  });
}

/** Issue the trusted error for a traversal given neither `ci_name` nor `sys_id`. */
export function createStartCiRequiredError(): Error {
  return issue({
    category: "conflict",
    reason: "start_ci_required",
    message: "Either ci_name or sys_id is required to name the CI to start from.",
    retry: "retry_after_correction",
  });
}

function issue(candidate: ToolErrorDescriptor): Error {
  const safeDescriptor = Object.freeze({ ...candidate });
  const error = new Error(formatToolErrorDescriptor(safeDescriptor));
  error.name = "ServiceNowToolError";
  TOOL_ERROR_PROVENANCE.set(error, safeDescriptor);
  return Object.freeze(error);
}

/**
 * Issue a trusted structural error. Only fixed module-owned text is attached
 * to the Error; raw upstream/configuration values belong in neither the Error
 * nor its public descriptor (the one exception, a CI name made inert, is
 * issued by `createAmbiguousCiNameError`).
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

/**
 * The HTTP status of an upstream response, kept beside (never inside) an
 * issued error. A separate map, so no descriptor, message or public text
 * changes: only the field-types texts read it, and only as an integer.
 */
const TOOL_ERROR_HTTP_STATUS = new WeakMap<object, number>();

/**
 * Record the integer HTTP status (100-599) of the response `error` was issued
 * for. Any other value is ignored.
 */
export function recordTrustedHttpStatus<E extends Error>(error: E, status: number): E {
  if (Number.isInteger(status) && status >= 100 && status <= 599 && trustedToolErrorDescriptor(error) !== undefined) {
    TOOL_ERROR_HTTP_STATUS.set(error, status);
  }
  return error;
}

/** The HTTP status recorded for an error this module issued, if any. */
export function trustedHttpStatus(candidate: unknown): number | undefined {
  if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) {
    return undefined;
  }
  return TOOL_ERROR_HTTP_STATUS.get(candidate);
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
 * Normalize any thrown value without inspecting it. An unissued error becomes
 * the fixed internal category, including hostile Proxies and getters, except
 * the client's own byte-limit error, which is a request the caller can change
 * and so is reported as `too_large`. Both checks are provenance lookups that
 * run no code of the candidate.
 *
 * This is the one place a thrown byte-limit error is given a public category:
 * every tool boundary, audit record and aggregate failure reads it from here.
 * `trustedToolErrorDescriptor` is deliberately unchanged, so a caller that
 * treats an unreadable or over-budget response as an unknown outcome (a bulk
 * write, the cache's structural-failure rule) keeps doing so.
 */
export function safeToolErrorDescriptor(candidate: unknown): ToolErrorDescriptor {
  return (
    trustedToolErrorDescriptor(candidate) ??
    (isIssuedResponseTooLargeError(candidate) ? TOO_LARGE_DESCRIPTOR : INTERNAL_DESCRIPTOR)
  );
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
  if (
    first.reason !== undefined &&
    descriptors.every(
      (candidate) =>
        candidate.reason === first.reason && candidate.message === first.message
    )
  ) {
    return issue(first);
  }
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
