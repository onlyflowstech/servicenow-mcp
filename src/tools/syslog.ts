import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  authorizeRawEncodedRead,
  ENCODED_QUERY_STRICT_OBJECT_PARAMS,
} from "../encoded-query-policy.js";
import {
  fieldSelectionToSysparmFields,
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { uncachedOperations } from "../metadata-cache.js";
import { createInvalidCursorError } from "../tool-error.js";
import { ok, escapeQueryValue, truncate } from "../utils.js";
import {
  decodeTailCursor,
  encodeTailCursor,
  hashTailFilters,
  isStoredTimestamp,
  isSysId,
  isTailCursor,
  MAX_CURSOR_LENGTH,
  TAIL_HINT_EMPTY,
  TAIL_HINT_MORE,
  TAIL_HINT_START,
} from "./syslog-cursor.js";

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

/** The longest `since`, in minutes; a cursor may not reach further back either. */
const MAX_SINCE_MINUTES = 525_600;

const INVALID_CURSOR_MESSAGE = "after_cursor is not a valid cursor";

const LEVEL_ENUM = ["error", "warning", "info", "debug", "-1", "0", "1", "2"] as const;

export const definition = {
  name: "sn_syslog",
  description:
    "Query ServiceNow system logs (syslog table) with severity, source, and time-based filters. " +
    "Results ordered newest first, with pagination metadata (record_count, total, has_more, next_offset). " +
    "To tail: tail=true, then after_cursor=cursor for newer entries, oldest first.",
  annotations: {
    title: "Query system logs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z
  .strictObject({
    level: z.enum(LEVEL_ENUM).optional().describe("Filter by severity level: a name (error, warning, info, debug) or the numeric value syslog stores (-1=debug, 0=info, 1=warning, 2=error)"),
    source: z.string().optional().describe("Filter by source field (LIKE match)"),
    message: z.string().optional().describe("Filter message contains text (LIKE match)"),
    limit: z.number().int().min(1).max(1000).optional().default(25).describe("Max records (default 25, max 1000)"),
    offset: z.number().int().min(0).max(10000).optional().describe("Pagination offset (max 10000)"),
    since: z.number().int().min(1).max(MAX_SINCE_MINUTES).optional().default(60).describe("Show logs from last N minutes (default 60, max 525600)"),
    fields: z.string().optional().describe("Fields to return (default: sys_id,level,source,message,sys_created_on)"),
    tail: z.boolean().optional().describe("Start a tail: newest entries plus a cursor"),
    after_cursor: z
      .string()
      .max(MAX_CURSOR_LENGTH, INVALID_CURSOR_MESSAGE)
      .refine(isTailCursor, INVALID_CURSOR_MESSAGE)
      .optional()
      .describe("Cursor from the last call. Same level/source/message; since ignored"),
  }, ENCODED_QUERY_STRICT_OBJECT_PARAMS);

function parseTotalCountHeader(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Read the log as a tail.
 *
 * The first call (`tail`, no cursor) returns the newest `limit` entries,
 * oldest first, and a cursor at the newest. A call with `after_cursor`
 * returns the entries after that position, oldest first, with a new cursor at
 * the last one returned; `has_more` says the limit cut the page short.
 *
 * Rows are ordered and compared on (`sys_created_on`, `sys_id`), because many
 * rows share a second: "after (T, I)" is `created > T`, or `created = T` and
 * `sys_id > I`. The encoded query reads that as `created >= T`, then
 * `(created > T ^OR sys_id > I)`, an AND of two conditions, one of them an OR
 * group. T is a stored UTC value and is sent as a literal, which the instance
 * reads as UTC; no time zone is applied here.
 *
 * Tail reads go to the instance directly (never the metadata cache), ask for
 * the stored value (`sysparm_display_value=false`) and for no total count.
 */
async function tailRead(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  readableFields: ReturnType<typeof resolveReadableFields>
) {
  const level = args.level ? (SYSLOG_LEVEL_VALUES[args.level] ?? args.level) : undefined;
  const filter = hashTailFilters({
    ...(level === undefined ? {} : { level }),
    ...(args.source ? { source: args.source } : {}),
    ...(args.message ? { message: args.message } : {}),
  });
  const after = args.after_cursor === undefined ? undefined : decodeTailCursor(args.after_cursor);
  // The schema has already refused a bad cursor; this is the same check for a
  // caller that reaches the handler another way, plus the filter binding.
  if (args.after_cursor !== undefined && (after === undefined || after.filter !== filter)) {
    throw createInvalidCursorError();
  }
  if (args.offset !== undefined) throw createInvalidCursorError("offset");
  // A follow-up ignores `since`, but a cursor may not reach back further than
  // the longest window a plain read allows, so a made-up old cursor cannot walk
  // the whole log.
  if (
    after !== undefined &&
    Date.parse(`${after.timestamp.replace(" ", "T")}Z`) < Date.now() - MAX_SINCE_MINUTES * 60_000
  ) {
    throw createInvalidCursorError("window");
  }

  const parts: string[] = [];
  if (level !== undefined) parts.push(`level=${level}`);
  if (args.source) parts.push(`sourceLIKE${escapeQueryValue(args.source)}`);
  if (args.message) parts.push(`messageLIKE${escapeQueryValue(args.message)}`);
  let sysparmQuery: string;
  let rowLimit: number;
  if (after === undefined) {
    parts.push(`sys_created_on>=javascript:gs.minutesAgoStart(${args.since})`);
    sysparmQuery = `${parts.join("^")}^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id`;
    rowLimit = args.limit;
  } else {
    // The date and id are validated shapes (digits, dashes, colon, one space;
    // 32 hex), so nothing here can carry query syntax.
    parts.push(
      `sys_created_on>=${after.timestamp}`,
      `sys_created_on>${after.timestamp}^ORsys_id>${after.sysId}`
    );
    sysparmQuery = `${parts.join("^")}^ORDERBYsys_created_on^ORDERBYsys_id`;
    // One more than asked for, to learn whether more exist; it is not returned.
    rowLimit = args.limit + 1;
  }
  const fields = fieldSelectionToSysparmFields(readableFields);
  const resp = await uncachedOperations(client).getWithMeta("/api/now/table/syslog", {
    sysparm_query: sysparmQuery,
    sysparm_limit: String(rowLimit),
    sysparm_display_value: "false",
    sysparm_no_count: "true",
    ...(fields ? { sysparm_fields: fields } : {}),
  });

  const filtered = filterReadableRecord(resp.data?.result || [], readableFields);
  let rows = (Array.isArray(filtered) ? filtered : []).filter(
    (record): record is Record<string, unknown> =>
      typeof record === "object" && record !== null && !Array.isArray(record)
  );
  if (after === undefined) rows.reverse();
  const hasMore = after !== undefined && rows.length > args.limit;
  if (hasMore) rows = rows.slice(0, args.limit);

  const results = rows.map((r) => ({
    sys_id: r.sys_id,
    timestamp: r.sys_created_on,
    level: r.level,
    source: r.source,
    message: r.message ? truncate(String(r.message), 300) : undefined,
  }));

  // The cursor is the last row returned, or, with nothing new, the position
  // the caller already held, written out again from its decoded parts.
  const last = rows.at(-1);
  let position: { timestamp: string; sysId: string } | undefined = after;
  if (last !== undefined) {
    if (!isStoredTimestamp(last.sys_created_on) || !isSysId(last.sys_id)) {
      // A row without a usable position cannot anchor a cursor. Fail closed
      // rather than hand out one that could skip or repeat entries.
      throw new TypeError("syslog row has no usable position");
    }
    position = { timestamp: last.sys_created_on, sysId: last.sys_id };
  }

  const payload: Record<string, unknown> = { record_count: results.length, has_more: hasMore };
  if (position !== undefined) payload.cursor = encodeTailCursor({ ...position, filter });
  if (hasMore) payload.hint = TAIL_HINT_MORE;
  else if (after === undefined) {
    payload.hint = position === undefined ? TAIL_HINT_EMPTY : TAIL_HINT_START;
  }
  payload.results = results;
  return ok(payload);
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
    if (args.tail === true || args.after_cursor !== undefined) {
      return await tailRead(args, client, readableFields);
    }
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
