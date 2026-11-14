/**
 * The recovery hint on a byte-truncated record list.
 *
 * Two stages can drop rows from one response: the tool's own budget check and,
 * after the shared envelope adds its metadata, the envelope's fit. The first
 * writes the hint; the second changes how many rows were dropped. The text is
 * therefore built and parsed here, in one place, so the envelope can rewrite
 * the counts and the continuation (the offset of the first row not returned,
 * which is `next_offset`) from its final state and the two never disagree. Rendering and parsing are covered by one round-trip test.
 *
 * @module truncation-hint
 */

/** Advice used when no field list can be suggested. */
export const LOWER_LIMIT_ADVICE = "a lower limit";

const BUDGET_ADVICE = "a higher max_response_bytes";
const HINT_MAX_LENGTH = 600;

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
   * suggestion, or {@link LOWER_LIMIT_ADVICE} when none applies.
   */
  readonly advice: string;
}

/**
 * Render the hint. When no row is left, the row itself exceeds the budget, so
 * a lower limit cannot help and the single-record read is offered instead.
 */
export function renderTruncationHint(parts: TruncationHintParts): string {
  const empty = parts.dropped >= parts.total;
  const returned = parts.total - parts.dropped;
  const options = [
    empty && parts.advice === LOWER_LIMIT_ADVICE ? undefined : parts.advice,
    BUDGET_ADVICE,
  ]
    .filter((option): option is string => option !== undefined)
    .join(" or ");
  return (
    `Dropped ${parts.dropped}/${parts.total}` +
    (empty ? "; row too large" : `; continue offset=${parts.offset + returned}`) +
    `; recover offset=${parts.offset} with ${options}` +
    (empty ? ", or sn_get" : "") +
    "."
  );
}

const HINT_PATTERN =
  /^Dropped (\d+)\/(\d+)(?:; row too large|; continue offset=\d+); recover offset=(\d+) with (?:(.+?) or )?a higher max_response_bytes(?:, or sn_get)?\.$/u;

/** Read back a hint {@link renderTruncationHint} wrote; anything else is undefined. */
export function parseTruncationHint(hint: string): TruncationHintParts | undefined {
  if (hint.length > HINT_MAX_LENGTH) return undefined;
  const match = HINT_PATTERN.exec(hint);
  if (match === null) return undefined;
  const [, dropped, total, offset, advice] = match;
  const parts: TruncationHintParts = {
    dropped: Number(dropped),
    total: Number(total),
    offset: Number(offset),
    advice: advice ?? LOWER_LIMIT_ADVICE,
  };
  return [parts.dropped, parts.total, parts.offset].every(Number.isSafeInteger)
    ? parts
    : undefined;
}

/**
 * Restate a hint for the response's final state: how many rows were dropped
 * from the window, and so where to continue. Only hints this module wrote are
 * touched; any other text is returned as it came.
 */
export function refreshTruncationHint(
  hint: string,
  final: { readonly dropped: number; readonly returned: number }
): string {
  const parts = parseTruncationHint(hint);
  if (parts === undefined) return hint;
  return renderTruncationHint({
    dropped: final.dropped,
    total: final.dropped + final.returned,
    offset: parts.offset,
    advice: parts.advice,
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
