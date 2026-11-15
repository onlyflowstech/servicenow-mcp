/**
 * The cursor `sn_syslog` hands out when it tails the log.
 *
 * A syslog row is identified by its creation second (`sys_created_on`, stored
 * in UTC) and its `sys_id`; many rows share one second, so the second alone
 * cannot say where a reader stopped. The cursor holds both, plus a short hash
 * of the filters it was issued for. The token is opaque to callers (URL-safe
 * base64 of a fixed text form) and is checked strictly on the way in: a
 * length cap, the exact alphabet, a canonical re-encoding, every field in its
 * exact shape, a real calendar date, and a checksum that catches a mangled
 * token. The checksum is not a signature: anyone can mint a cursor, which is
 * harmless because a cursor only chooses a position in rows the caller may
 * already read under the same table and field policy.
 *
 * Nothing here ever returns, logs or throws the text it was given.
 */

import { createHash } from "node:crypto";

/** Upper bound on a cursor's length; a real one is 87 characters. */
export const MAX_CURSOR_LENGTH = 128;

/** `sys_created_on` as the Table API returns it (UTC, display_value=false). */
const STORED_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u;
const COMPACT_TIMESTAMP = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u;
const SYS_ID = /^[0-9a-f]{32}$/u;
const HEX8 = /^[0-9a-f]{8}$/u;
const HEX6 = /^[0-9a-f]{6}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const VERSION = "1";

/** Where a reader stopped: the last row it was given. */
export interface TailPosition {
  /** `sys_created_on` of that row, as stored (UTC). */
  readonly timestamp: string;
  readonly sysId: string;
}

export interface TailCursor extends TailPosition {
  /** Hash of the filters the cursor was issued for. */
  readonly filter: string;
}

/** The filters a tail is bound to; `since` and `limit` are not part of it. */
export interface TailFilters {
  /** The numeric `level` value, as sent upstream. */
  readonly level?: string;
  readonly source?: string;
  readonly message?: string;
}

export function hashTailFilters(filters: TailFilters): string {
  return createHash("sha256")
    .update(
      JSON.stringify([filters.level ?? null, filters.source ?? null, filters.message ?? null])
    )
    .digest("hex")
    .slice(0, 8);
}

/** True for a `sys_created_on` value that is a real UTC date and time. */
export function isStoredTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = STORED_TIMESTAMP.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [
    number, number, number, number, number, number, number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export function isSysId(value: unknown): value is string {
  return typeof value === "string" && SYS_ID.test(value);
}

function checksum(body: string): string {
  return createHash("sha256").update(`sn_syslog.tail.${body}`).digest("hex").slice(0, 6);
}

export function encodeTailCursor(cursor: TailCursor): string {
  if (
    !isStoredTimestamp(cursor.timestamp) ||
    !isSysId(cursor.sysId) ||
    !HEX8.test(cursor.filter)
  ) {
    throw new TypeError("tail cursor fields are not canonical");
  }
  const compact = cursor.timestamp.replace(/[- :]/gu, "");
  const body = [VERSION, compact, cursor.sysId, cursor.filter].join("|");
  return Buffer.from(`${body}|${checksum(body)}`, "utf8").toString("base64url");
}

/** The cursor a token holds, or undefined for anything that is not one. */
export function decodeTailCursor(token: unknown): TailCursor | undefined {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_CURSOR_LENGTH ||
    !BASE64URL.test(token)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(token, "base64url");
  // Only the canonical, unpadded encoding of the bytes is accepted, so two
  // different tokens never mean the same position.
  if (bytes.toString("base64url") !== token) return undefined;
  const parts = bytes.toString("utf8").split("|");
  if (parts.length !== 5) return undefined;
  const [version, compact, sysId, filter, check] = parts as [
    string, string, string, string, string,
  ];
  if (version !== VERSION || !SYS_ID.test(sysId) || !HEX8.test(filter) || !HEX6.test(check)) {
    return undefined;
  }
  if (check !== checksum([version, compact, sysId, filter].join("|"))) return undefined;
  const match = COMPACT_TIMESTAMP.exec(compact);
  if (match === null) return undefined;
  const timestamp = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  if (!isStoredTimestamp(timestamp)) return undefined;
  return Object.freeze({ timestamp, sysId, filter });
}

/** True when a string is a cursor this module issued (or could have). */
export function isTailCursor(token: unknown): boolean {
  return decodeTailCursor(token) !== undefined;
}

export const TAIL_HINT_START = "Pass cursor as after_cursor to read newer entries.";
export const TAIL_HINT_MORE = "More entries are waiting. Call again with after_cursor set to cursor.";
export const TAIL_HINT_EMPTY = "No entries in the window yet. Call again with tail=true.";
export const TAIL_HINT_NONE_FIT = "No entry fit the response limit. Call again with fewer fields or a lower limit.";

/**
 * Bring a tail page's cursor back in step with the rows it holds, after the
 * response fit dropped rows from its end for size.
 *
 * The cursor the tool wrote points past the last row it fetched. With rows
 * gone, that would skip them, so the cursor moves to the last row that is
 * still there and `has_more` is true; the dropped rows come with the next
 * call. With no row left there is no position to name, so the cursor is
 * removed and the caller repeats its last call (a lower limit or fewer fields
 * lets a row fit). The filter binding is carried over from the old cursor.
 */
export function restateTailPageAfterFit(data: unknown, kept: number): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const page = data as Record<string, unknown>;
  const previous = decodeTailCursor(page.cursor);
  delete page.cursor;
  page.has_more = true;
  const rows = Array.isArray(page.results) ? page.results : [];
  const last: unknown = kept > 0 ? rows[kept - 1] : undefined;
  if (previous !== undefined && typeof last === "object" && last !== null) {
    const row = last as Record<string, unknown>;
    if (isStoredTimestamp(row.timestamp) && isSysId(row.sys_id)) {
      page.cursor = encodeTailCursor({
        timestamp: row.timestamp,
        sysId: row.sys_id,
        filter: previous.filter,
      });
    }
  }
  page.hint = page.cursor === undefined ? TAIL_HINT_NONE_FIT : TAIL_HINT_MORE;
}
