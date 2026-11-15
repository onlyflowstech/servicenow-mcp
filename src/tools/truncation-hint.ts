/**
 * The recovery hint on a byte-truncated record list.
 *
 * Two stages can drop rows from one response: the tool's own budget check and,
 * after the shared envelope adds its metadata, the envelope's fit. The first
 * writes the hint; the second changes how many rows were dropped and knows
 * what the envelope itself costs. The text is therefore built and parsed here,
 * in one place, so the envelope can rewrite the counts, the continuation (the
 * offset of the first row not returned, which is `next_offset`) and the byte
 * budget that would hold the next row from its final state, and the hint and
 * the fields beside it never disagree. Rendering and parsing are covered by
 * one round-trip test.
 *
 * The hint is a list of fixed clauses joined by "; ", each matched on its own
 * by an anchored pattern, so only text this module wrote is ever rewritten:
 *
 *     Dropped 14/22; continue offset=8 limit=8; retry offset=0 with
 *     fields="sys_id,name" or max_response_bytes=1500 (fits the next row) or
 *     max_response_bytes=31500 (fits all 22).
 *
 * The two budgets are different numbers and the text says which is which:
 * the first holds one more row than this response did (each retry with it
 * buys a row), the second the whole window. The second is left out when it is
 * the first (one row dropped) or when it is more than the maximum.
 *
 * @module truncation-hint
 */

import { MAX_RESPONSE_BYTES_MAX, MAX_RESPONSE_BYTES_MIN } from "../utils.js";

const HINT_MAX_LENGTH = 600;

/**
 * Bytes added to the measured size of the next row's response before it is
 * offered as `max_response_bytes`, so that a budget with a longer digit count
 * or a slightly longer hint still holds it.
 */
const NEEDED_BYTES_SLACK = 64;
const NEEDED_BYTES_STEP = 100;

/**
 * `max_response_bytes` that would hold the next row: the measured size of the
 * response with that row (`measured`) plus a small margin, rounded up to a
 * whole {@link NEEDED_BYTES_STEP} (but never past `cap`), and always above the
 * budget just used (`current`). Infinity when that is more than `cap`: no
 * value the caller may use would hold the row. `cap` is the largest budget the
 * schema accepts, or less when a raw-read rule holds the call to a smaller one.
 */
export function neededResponseBytes(
  measured: number,
  current: number,
  cap: number = MAX_RESPONSE_BYTES_MAX
): number {
  const padded = Math.max(measured + NEEDED_BYTES_SLACK, current + 1, MAX_RESPONSE_BYTES_MIN);
  if (padded > cap) return Number.POSITIVE_INFINITY;
  return Math.min(Math.ceil(padded / NEEDED_BYTES_STEP) * NEEDED_BYTES_STEP, cap);
}

export interface TruncationHintParts {
  /** Rows dropped from the window the caller asked for. */
  readonly dropped: number;
  /** Rows the window held before any were dropped. */
  readonly total: number;
  /**
   * The window's offset: re-read it with a narrower request to get every
   * dropped row in one response. The offset to continue at (`next_offset`)
   * is not stored; it is this offset plus the rows that were returned.
   */
  readonly offset: number;
  /**
   * How to shrink the rows: a `fields="..."` or `response_format="..."`
   * suggestion. Absent when none applies; the hint then offers the lower
   * `limit` (while a row fits) and the byte budget.
   */
  readonly advice?: string;
  /**
   * The `max_response_bytes` that would hold at least the next row, or
   * Infinity when that is more than the maximum budget.
   */
  readonly neededBytes: number;
  /**
   * The `max_response_bytes` that would hold every row of the window
   * (`total`), when that is no more than the maximum budget; absent when it
   * is more. When one row was dropped the next row is the whole remainder, so
   * this is `neededBytes` and is written once. Infinity stands for the widest
   * rendering, which a fit uses to leave room for the real text and which is
   * never parsed back.
   */
  readonly allBytes?: number;
  /**
   * Render the longest text these parts could ever take, for a fit to size
   * rows with: the "exceeds the maximum" clause and a 7-digit next-row figure
   * together (no real hint has both), and the 7-digit page figure when
   * `allBytes` is Infinity. Never written to a caller as it is, and never
   * parsed back.
   */
  readonly widest?: boolean;
  /**
   * The largest `max_response_bytes` the caller may use, named when the next
   * row exceeds it. Defaults to the schema maximum; a raw-read rule can set a
   * smaller one. Only read back from a hint's "exceeds the maximum" clause.
   */
  readonly capBytes?: number;
}

/** What a hint names for the rows that fit: the continuation and the `limit` to use. */
function returnedRows(parts: TruncationHintParts): number {
  return parts.total - parts.dropped;
}

const EMPTY_CLAUSE = "row too large";
const NEXT_ROW_NOTE = " (fits the next row)";
function allRowsNote(total: number): string {
  return ` (fits all ${total})`;
}
const SN_GET_OPTION = "sn_get";
function overMaximumClause(cap: number): string {
  return `the next row exceeds the maximum max_response_bytes (${cap})`;
}

function renderHint(parts: TruncationHintParts, withAdvice: boolean): string {
  const returned = returnedRows(parts);
  const empty = returned <= 0;
  const over = !Number.isFinite(parts.neededBytes) || parts.widest === true;
  // With one row dropped the next row is the whole remainder: one figure.
  const nextRow =
    parts.widest === true
      ? `max_response_bytes=${MAX_RESPONSE_BYTES_MAX}${NEXT_ROW_NOTE}`
      : Number.isFinite(parts.neededBytes)
        ? `max_response_bytes=${parts.neededBytes}${NEXT_ROW_NOTE}`
        : undefined;
  const allBytes = parts.dropped > 1 ? parts.allBytes : undefined;
  const options = [
    withAdvice ? parts.advice : undefined,
    nextRow,
    allBytes === undefined
      ? undefined
      // Infinity is the widest form, used while fitting (see finalizeSummaryResult).
      : `max_response_bytes=${Number.isFinite(allBytes) ? allBytes : MAX_RESPONSE_BYTES_MAX}${allRowsNote(parts.total)}`,
    // When no row fits, a narrower page cannot help; the single-record read can.
    empty ? SN_GET_OPTION : undefined,
  ].filter((option): option is string => option !== undefined);
  const clauses = [`Dropped ${parts.dropped}/${parts.total}`];
  if (empty) clauses.push(EMPTY_CLAUSE);
  else clauses.push(`continue offset=${parts.offset + returned} limit=${returned}`);
  if (over) clauses.push(overMaximumClause(parts.capBytes ?? MAX_RESPONSE_BYTES_MAX));
  if (options.length > 0) {
    clauses.push(`retry offset=${parts.offset} with ${options.join(" or ")}`);
  }
  return `${clauses.join("; ")}.`;
}

/**
 * Render the hint. When no row is left, the row itself exceeds the budget, so
 * a lower limit cannot help and the single-record read is offered instead.
 * Field advice that would push the hint past its length limit, in its widest
 * form, is left out, so the hint always parses back and a longer real text
 * never replaces a shorter one that was used to size the rows.
 */
export function renderTruncationHint(parts: TruncationHintParts): string {
  // Whether the advice fits is decided once, from the widest rendering of
  // these parts (the "exceeds the maximum" clause with a 7-digit next-row
  // figure, and a 7-digit page figure: no real figures make a longer text). A
  // fit sizes rows with that widest text and then swaps in the real one, so the
  // two must make the same choice: if the widest dropped the advice and the
  // real text kept it, the real text could be hundreds of characters longer
  // than the one the rows were sized for. The page figure is always in this
  // text, whether or not the real text has one (it has none when the page is
  // over the cap, and a form without it is sized with the same decision), so
  // the choice depends only on what the probe and the real text share.
  const widest = renderHint(
    {
      ...parts,
      widest: true,
      neededBytes: Number.POSITIVE_INFINITY,
      allBytes: Number.POSITIVE_INFINITY,
    },
    true
  );
  return renderHint(parts, widest.length <= HINT_MAX_LENGTH);
}

const DROPPED_CLAUSE = /^Dropped (\d+)\/(\d+)$/u;
const CONTINUE_CLAUSE = /^continue offset=(\d+) limit=(\d+)$/u;
const RETRY_CLAUSE = /^retry offset=(\d+) with (.+)$/u;
const ADVICE_OPTION =
  /^(?:fields="[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*"|response_format="concise")$/u;
const NEXT_ROW_OPTION = /^max_response_bytes=([1-9]\d{3,6}) \(fits the next row\)$/u;
const ALL_ROWS_OPTION = /^max_response_bytes=([1-9]\d{3,6}) \(fits all ([1-9]\d{0,15})\)$/u;
const OVER_MAXIMUM = /^the next row exceeds the maximum max_response_bytes \(([1-9]\d{3,6})\)$/u;

/** A byte value the schema could accept: 1000 to 1,000,000. */
function budgetValue(digits: string | undefined): number | undefined {
  const value = Number(digits);
  return Number.isSafeInteger(value) && value >= MAX_RESPONSE_BYTES_MIN && value <= MAX_RESPONSE_BYTES_MAX
    ? value
    : undefined;
}

/** Read back a hint {@link renderTruncationHint} wrote; anything else is undefined. */
export function parseTruncationHint(hint: string): TruncationHintParts | undefined {
  if (hint.length > HINT_MAX_LENGTH || !hint.endsWith(".")) return undefined;
  const clauses = hint.slice(0, -1).split("; ");
  let index = 0;
  const dropped = DROPPED_CLAUSE.exec(clauses[index++] ?? "");
  if (dropped === null) return undefined;
  const droppedCount = Number(dropped[1]);
  const total = Number(dropped[2]);
  if (!Number.isSafeInteger(droppedCount) || !Number.isSafeInteger(total) || droppedCount > total) {
    return undefined;
  }
  const returned = total - droppedCount;
  const empty = returned === 0;
  let offset: number | undefined;
  if (empty) {
    if (clauses[index++] !== EMPTY_CLAUSE) return undefined;
  } else {
    const next = CONTINUE_CLAUSE.exec(clauses[index++] ?? "");
    // The clause restates numbers the counts already fix; a hint that
    // disagrees with itself was not written here.
    if (next === null || Number(next[2]) !== returned) return undefined;
    offset = Number(next[1]) - returned;
  }
  let neededBytes: number | undefined;
  let allBytes: number | undefined;
  let capBytes: number | undefined;
  const over = OVER_MAXIMUM.exec(clauses[index] ?? "");
  if (over !== null) {
    capBytes = budgetValue(over[1]);
    if (capBytes === undefined) return undefined;
    neededBytes = Number.POSITIVE_INFINITY;
    index += 1;
  }
  let advice: string | undefined;
  let sawSnGet = false;
  const retry = clauses[index] === undefined ? null : RETRY_CLAUSE.exec(clauses[index] ?? "");
  if (retry !== null) {
    index += 1;
    const retryOffset = Number(retry[1]);
    if (offset !== undefined && offset !== retryOffset) return undefined;
    offset = retryOffset;
    for (const option of (retry[2] ?? "").split(" or ")) {
      const next = NEXT_ROW_OPTION.exec(option);
      const all = next === null ? ALL_ROWS_OPTION.exec(option) : null;
      if (next !== null) {
        const value = budgetValue(next[1]);
        if (neededBytes !== undefined || value === undefined) return undefined;
        neededBytes = value;
      } else if (all !== null) {
        const value = budgetValue(all[1]);
        // The count restates the window; the figure must follow the next-row
        // one, be no smaller, and exist only when more than one row is left.
        if (
          allBytes !== undefined ||
          value === undefined ||
          Number(all[2]) !== total ||
          droppedCount < 2 ||
          neededBytes === undefined ||
          !Number.isFinite(neededBytes) ||
          value < neededBytes
        ) {
          return undefined;
        }
        allBytes = value;
      } else if (ADVICE_OPTION.test(option) && advice === undefined) {
        advice = option;
      } else if (option === SN_GET_OPTION && !sawSnGet) {
        sawSnGet = true;
      } else {
        return undefined;
      }
    }
  }
  if (
    index !== clauses.length ||
    offset === undefined ||
    neededBytes === undefined ||
    sawSnGet !== empty ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return undefined;
  }
  // One row dropped: the next row is the whole remainder, written once.
  if (droppedCount === 1 && Number.isFinite(neededBytes)) allBytes = neededBytes;
  return {
    dropped: droppedCount,
    total,
    offset,
    ...(advice === undefined ? {} : { advice }),
    neededBytes,
    ...(allBytes === undefined ? {} : { allBytes }),
    ...(capBytes === undefined ? {} : { capBytes }),
  };
}

/**
 * Restate a hint for the response's final state: how many rows were dropped
 * from the window, so where to continue and which `limit` fits, and, when the
 * caller supplies it, the byte budget that would hold the next row. Only hints
 * this module wrote are touched; any other text is returned as it came.
 */
export function refreshTruncationHint(
  hint: string,
  final: {
    readonly dropped: number;
    readonly returned: number;
    readonly neededBytes?: number;
    /**
     * The budget for the whole window: a number to name it, null when it is
     * more than the maximum (so it is left out), absent to keep the hint's own.
     */
    readonly allBytes?: number | null;
    /** Leave the field advice out, as a fit does when the result is too tight to carry it. */
    readonly withoutAdvice?: boolean;
    /** Render the widest text instead (see {@link TruncationHintParts.widest}). */
    readonly widest?: boolean;
    /** The cap to name if the next row exceeds it; else the one the hint named. */
    readonly capBytes?: number;
  }
): string {
  const parts = parseTruncationHint(hint);
  if (parts === undefined) return hint;
  return renderTruncationHint({
    dropped: final.dropped,
    total: final.dropped + final.returned,
    offset: parts.offset,
    ...(parts.advice === undefined || final.withoutAdvice === true ? {} : { advice: parts.advice }),
    neededBytes: final.neededBytes ?? parts.neededBytes,
    ...(final.widest === true ? { widest: true } : {}),
    ...(final.allBytes === null || (final.allBytes ?? parts.allBytes) === undefined
      ? {}
      : { allBytes: (final.allBytes ?? parts.allBytes) as number }),
    ...(final.capBytes ?? parts.capBytes) === undefined
      ? {}
      : { capBytes: (final.capBytes ?? parts.capBytes) as number },
  });
}

/**
 * The continuation hint a paging tool writes when nothing was dropped:
 * "More records available. Call sn_query again with offset=22." (an
 * all-fields notice may follow). A tool writes it from the page it fetched, so
 * when the shared envelope later drops rows for size, its offset is stale.
 */
const CONTINUATION_HINT =
  /^(More records available\. Call sn_[a-z_]+ again with offset=)\d+(\.)((?: .*)?)$/su;

/**
 * Restate a continuation hint for the final paging state: the offset of the
 * first row not returned, or, when no row fit and there is none, the plain
 * instruction that the request must change. Text that is not a continuation
 * hint comes back as it was.
 */
export function restateContinuationHint(
  hint: string,
  final: { readonly offset: number; readonly nextOffset?: number }
): string {
  const match = CONTINUATION_HINT.exec(hint);
  if (match === null) return hint;
  const notice = match[3] ?? "";
  if (final.nextOffset === undefined) {
    return (
      "More records available, but no row fit; adjust the request (fewer fields, " +
      `a lower limit or a higher max_response_bytes) and retry offset=${final.offset}.${notice}`
    );
  }
  return `${match[1]}${final.nextOffset}.${notice}`;
}
