/**
 * The recovery hint on a byte-truncated record list.
 *
 * Two stages can drop rows from one response: the tool's own budget check and,
 * after the shared envelope adds its metadata, the envelope's fit. The first
 * writes the hint; the second changes how many rows were dropped. The text is
 * therefore built and parsed here, in one place, so the envelope can rewrite
 * the counts and the continuation from its final state and the two never
 * disagree. Rendering and parsing are covered by one round-trip test.
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
  /** Offset to re-read to get the dropped rows. */
  readonly offset: number;
  /**
   * How to shrink the rows: a `fields="..."` or `response_format="..."`
   * suggestion, or {@link LOWER_LIMIT_ADVICE} when none applies.
   */
  readonly advice: string;
  /** Where to continue after the window; absent when nothing continues. */
  readonly resume?: { readonly offset: number; readonly limit: number };
}

/**
 * Render the hint. When no row is left, the row itself exceeds the budget, so
 * a lower limit cannot help and the single-record read is offered instead.
 */
export function renderTruncationHint(parts: TruncationHintParts): string {
  const empty = parts.dropped >= parts.total;
  const options = [
    empty && parts.advice === LOWER_LIMIT_ADVICE ? undefined : parts.advice,
    BUDGET_ADVICE,
  ]
    .filter((option): option is string => option !== undefined)
    .join(" or ");
  return (
    `Dropped ${parts.dropped}/${parts.total}` +
    (empty ? "; row too large" : "") +
    `; recover offset=${parts.offset} with ${options}` +
    (empty ? ", or sn_get" : "") +
    (parts.resume === undefined
      ? "; no post-window continuation."
      : `; resume offset=${parts.resume.offset} limit=${parts.resume.limit}.`)
  );
}

const HINT_PATTERN =
  /^Dropped (\d+)\/(\d+)(?:; row too large)?; recover offset=(\d+) with (?:(.+?) or )?a higher max_response_bytes(?:, or sn_get)?(?:; resume offset=(\d+) limit=(\d+)\.|; no post-window continuation\.)$/u;

/** Read back a hint {@link renderTruncationHint} wrote; anything else is undefined. */
export function parseTruncationHint(hint: string): TruncationHintParts | undefined {
  if (hint.length > HINT_MAX_LENGTH) return undefined;
  const match = HINT_PATTERN.exec(hint);
  if (match === null) return undefined;
  const [, dropped, total, offset, advice, resumeOffset, resumeLimit] = match;
  const parts: TruncationHintParts = {
    dropped: Number(dropped),
    total: Number(total),
    offset: Number(offset),
    advice: advice ?? LOWER_LIMIT_ADVICE,
    ...(resumeOffset === undefined
      ? {}
      : { resume: { offset: Number(resumeOffset), limit: Number(resumeLimit) } }),
  };
  return [parts.dropped, parts.total, parts.offset].every(Number.isSafeInteger)
    ? parts
    : undefined;
}

/**
 * Restate a hint for the response's final state: how many rows were dropped
 * from the window and where, if anywhere, to continue. Only hints this module
 * wrote are touched; any other text is returned as it came.
 */
export function refreshTruncationHint(
  hint: string,
  final: {
    readonly dropped: number;
    readonly returned: number;
    readonly resume?: { readonly offset: number; readonly limit: number };
  }
): string {
  const parts = parseTruncationHint(hint);
  if (parts === undefined) return hint;
  return renderTruncationHint({
    dropped: final.dropped,
    total: final.dropped + final.returned,
    offset: parts.offset,
    advice: parts.advice,
    ...(final.resume === undefined ? {} : { resume: final.resume }),
  });
}
