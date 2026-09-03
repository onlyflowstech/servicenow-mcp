import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  authorizeRawEncodedRead,
  ENCODED_QUERY_MIGRATION_MESSAGE,
} from "../encoded-query-policy.js";
import {
  fieldSelectionToSysparmFields,
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { ok, escapeQueryValue, truncate } from "../utils.js";

/**
 * syslog.level stores NUMERIC severities, not the labels the UI shows.
 * The out-of-box scale (matching the "System Log > Errors" module filter
 * and the sys_choice values for syslog.level) is:
 *   -1=debug, 0=information, 1=warning, 2=error.
 * Filtering on a label (level=error) matches zero rows, so level names
 * are mapped to their numeric values; numeric input ("-1".."2") is
 * passed through unchanged. Raw encoded-query input is intentionally not
 * exposed by this tool; use an explicitly policy-approved `sn_query` rule for
 * controlled legacy reads.
 */
const SYSLOG_LEVEL_VALUES: Record<string, string> = {
  debug: "-1",
  info: "0",
  warning: "1",
  error: "2",
};

const LEVEL_ENUM = ["error", "warning", "info", "debug", "-1", "0", "1", "2"] as const;

export const definition = {
  name: "sn_syslog",
  description:
    "Query ServiceNow system logs (syslog table) with severity, source, and time-based filters. " +
    "Results ordered newest first, with pagination metadata (record_count, total, has_more, next_offset).",
  annotations: {
    title: "Query system logs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z
  .object({
    level: z.enum(LEVEL_ENUM).optional().describe("Filter by severity level: a name (error, warning, info, debug) or the numeric value syslog stores (-1=debug, 0=info, 1=warning, 2=error)"),
    source: z.string().optional().describe("Filter by source field (LIKE match)"),
    message: z.string().optional().describe("Filter message contains text (LIKE match)"),
    limit: z.number().int().min(1).max(1000).optional().default(25).describe("Max records (default 25, max 1000)"),
    offset: z.number().int().min(0).max(10000).optional().describe("Pagination offset (max 10000)"),
    since: z.number().int().min(1).max(525600).optional().default(60).describe("Show logs from last N minutes (default 60, max 525600)"),
    fields: z.string().optional().describe("Fields to return (default: sys_id,level,source,message,sys_created_on)"),
  })
  .strict(ENCODED_QUERY_MIGRATION_MESSAGE);

function parseTotalCountHeader(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  try {
    const rawQuery = (args as unknown as Readonly<Record<string, unknown>>).query;
    if (rawQuery !== undefined) {
      authorizeRawEncodedRead(_context?.effectivePolicy.encodedQueryAccess, {
        tool: "sn_syslog",
        table: "syslog",
        query: rawQuery,
        limit: args.limit,
        offset: args.offset ?? 0,
        maxResponseBytes: 100_000,
        outputFields: [],
      });
    }
    const readableFields =
      preparedReadableFields(args, "syslog") ??
      resolveReadableFields("syslog", { fields: args.fields });
    const fields = fieldSelectionToSysparmFields(readableFields);
    let sysparmQuery: string;

    const parts: string[] = [];
    if (args.level) {
      parts.push(`level=${SYSLOG_LEVEL_VALUES[args.level] ?? args.level}`);
    }
    if (args.source) parts.push(`sourceLIKE${escapeQueryValue(args.source)}`);
    if (args.message) parts.push(`messageLIKE${escapeQueryValue(args.message)}`);
    parts.push(`sys_created_on>=javascript:gs.minutesAgoStart(${args.since})`);
    sysparmQuery = parts.join("^");

    // Always order newest first
    sysparmQuery += "^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id";

    const params: Record<string, string> = {
      sysparm_query: sysparmQuery,
      sysparm_limit: String(args.limit),
      ...(fields ? { sysparm_fields: fields } : {}),
    };
    if (args.offset !== undefined) params.sysparm_offset = String(args.offset);

    const resp = await client.getWithMeta("/api/now/table/syslog", params);

    const filtered = filterReadableRecord(resp.data?.result || [], readableFields);
    const records = Array.isArray(filtered) ? filtered : [];
    const results = records
      .filter(
        (record): record is Record<string, unknown> =>
          typeof record === "object" && record !== null && !Array.isArray(record)
      )
      .map((r) => ({
        sys_id: r.sys_id,
        timestamp: r.sys_created_on,
        level: r.level,
        source: r.source,
        message: r.message ? truncate(String(r.message), 300) : undefined,
      }));

    const offset = args.offset ?? 0;
    const recordCount = results.length;
    const total = parseTotalCountHeader(resp.headers.get("x-total-count"));
    const hasMore =
      total !== undefined ? offset + recordCount < total : recordCount === args.limit;

    const payload: Record<string, unknown> = { record_count: recordCount };
    if (total !== undefined) payload.total = total;
    payload.has_more = hasMore;
    if (hasMore) {
      // Advance by the requested limit, not the returned count -- see the
      // matching comment in sn_query (ACL-trimmed pages).
      const nextOffset = offset + args.limit;
      payload.next_offset = nextOffset;
      payload.hint = `More records available. Call sn_syslog again with offset=${nextOffset}.`;
    }
    payload.results = results;
    return ok(payload);
  } catch (error) {
    throw error;
  }
}
