/**
 * Shared utilities for tool handlers.
 *
 * @module utils
 */

/**
 * Format a successful tool result as MCP text content.
 * Objects are serialized as compact JSON (no pretty-print indent).
 */
export function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text", text }] };
}

/**
 * Deep-strip empty values from record payloads: removes object entries
 * whose value is "" or null. Keeps false, 0, and empty arrays. Recurses
 * into nested objects and arrays. ServiceNow records are full of empty
 * strings -- stripping them cuts serialized size substantially.
 */
export function stripEmpty<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripEmpty(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === "" || entry === null) continue;
      out[key] = stripEmpty(entry);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Format an error tool result as MCP text content.
 */
export function err(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

/**
 * Safely format a ServiceNow error for display.
 */
export function formatError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (e.message) {
      let msg = String(e.message);
      if (e.detail) msg += `\nDetail: ${e.detail}`;
      if (e.status) msg += ` (HTTP ${e.status})`;
      return msg;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Attach a list of per-request failure warnings to a success payload.
 *
 * No-op when there are no warnings -- the success shape is unchanged.
 * With warnings, plain objects gain a `warnings` key; arrays are wrapped
 * as `{ results, warnings }` and scalars as `{ result, warnings }` since
 * neither can carry extra keys. This lets tools that fan out over several
 * sub-requests report partial failures (e.g. an ACL-denied table) instead
 * of silently returning fewer results.
 */
export function withWarnings(data: unknown, warnings: string[]): unknown {
  if (warnings.length === 0) return data;
  if (Array.isArray(data)) return { results: data, warnings };
  if (data !== null && typeof data === "object") {
    return { ...(data as Record<string, unknown>), warnings };
  }
  return { result: data, warnings };
}

/**
 * Build a query parameter map for table API requests.
 * Always excludes reference links (link+value objects are pure URL noise
 * in tool output).
 */
export function buildTableParams(opts: {
  query?: string;
  fields?: string;
  limit?: number;
  offset?: number;
  orderby?: string;
  displayValue?: string;
}): Record<string, string> {
  const params: Record<string, string> = {
    sysparm_exclude_reference_link: "true",
  };
  if (opts.limit !== undefined) params.sysparm_limit = String(opts.limit);
  if (opts.query) params.sysparm_query = opts.query;
  if (opts.fields) params.sysparm_fields = opts.fields;
  if (opts.offset !== undefined) params.sysparm_offset = String(opts.offset);
  if (opts.orderby) params.sysparm_orderby = opts.orderby;
  if (opts.displayValue) params.sysparm_display_value = opts.displayValue;
  return params;
}

/**
 * Neutralize encoded-query metacharacters in a user-supplied VALUE that
 * is interpolated into a sysparm_query string.
 *
 * ServiceNow's encoded-query syntax has NO escape sequence: `^` always
 * terminates the current condition, and `^OR` / `^NQ` / `^EQ` chain new
 * ones, so a literal `^` inside a value cannot be represented at all.
 * The only fail-closed strategy is to strip `^` before interpolation:
 * a stripped value can no longer inject extra conditions (e.g. a ci_name
 * of "x^ORactive=false" becomes the harmless literal "xORactive=false"),
 * at the cost that field values genuinely containing `^` cannot be
 * matched through the convenience filters -- a platform limitation, not
 * a tool one. Raw `query` parameters that accept a full encoded query
 * are intentionally passed through untouched.
 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\^/g, "");
}

/**
 * Truncate a string if it exceeds maxLen, appending "...".
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

/**
 * Bounds for the max_response_bytes guard shared by sn_query / sn_get.
 * Referenced from both the hand-written JSON schemas and the zod schemas
 * so the two cannot drift.
 */
export const MAX_RESPONSE_BYTES_DEFAULT = 100000;
export const MAX_RESPONSE_BYTES_MIN = 1000;
export const MAX_RESPONSE_BYTES_MAX = 1000000;

/**
 * UTF-8 byte length of a value's compact-JSON serialization -- the exact
 * size `ok()` would emit for it.
 */
export function serializedBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}
