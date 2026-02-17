/**
 * Shared utilities for tool handlers.
 *
 * @module utils
 */

/**
 * Format a successful tool result as MCP text content.
 */
export function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
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
 * Build a query parameter map for table API requests.
 */
export function buildTableParams(opts: {
  query?: string;
  fields?: string;
  limit?: number;
  offset?: number;
  orderby?: string;
  displayValue?: string;
}): Record<string, string> {
  const params: Record<string, string> = {};
  if (opts.limit !== undefined) params.sysparm_limit = String(opts.limit);
  if (opts.query) params.sysparm_query = opts.query;
  if (opts.fields) params.sysparm_fields = opts.fields;
  if (opts.offset !== undefined) params.sysparm_offset = String(opts.offset);
  if (opts.orderby) params.sysparm_orderby = opts.orderby;
  if (opts.displayValue) params.sysparm_display_value = opts.displayValue;
  return params;
}

/**
 * Truncate a string if it exceeds maxLen, appending "...".
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}
