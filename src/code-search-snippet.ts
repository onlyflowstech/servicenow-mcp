/**
 * The excerpt `sn_codesearch` shows for a hit: the text around the first
 * match, not the start of the script, so a reader can see why the record
 * matched without a second read.
 *
 * @module code-search-snippet
 */

/** About how many characters of the script a snippet shows. */
export const SNIPPET_WIDTH = 200;

export interface CodeSnippet {
  readonly text: string;
  /** 1-based line of the first match; absent when the text holds no match. */
  readonly line?: number;
}

/**
 * A window of about `width` characters of `body` around the first
 * case-insensitive occurrence of `term`, with "..." where text was cut, and the
 * line the match is on.
 *
 * The instance matched with its own collation, which can be looser than a
 * literal comparison (accents, for example). When the term is not found here
 * the head of the body is shown instead, as it always was, with no line.
 */
export function snippetAround(
  body: string,
  term: string,
  width: number = SNIPPET_WIDTH
): CodeSnippet {
  const match = firstMatch(body, term);
  if (match === undefined) return { text: clip(body, 0, Math.min(body.length, width)) };

  const matchLength = Math.min(match.length, width);
  const room = width - matchLength;
  let start = Math.max(0, match.index - Math.floor(room / 2));
  const end = Math.min(body.length, start + width);
  // Near the end of the body, spend the unused room before the match instead.
  start = Math.max(0, end - width);
  return { text: clip(body, start, end), line: lineOf(body, match.index) };
}

function firstMatch(
  body: string,
  term: string
): { readonly index: number; readonly length: number } | undefined {
  if (term.length === 0) return undefined;
  const found = new RegExp(escapeForRegExp(term), "i").exec(body);
  return found === null ? undefined : { index: found.index, length: found[0].length };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lineOf(body: string, index: number): number {
  let line = 1;
  for (let at = body.indexOf("\n"); at !== -1 && at < index; at = body.indexOf("\n", at + 1)) {
    line += 1;
  }
  return line;
}

/** `body[start, end)` with "..." where it is cut, never splitting a surrogate pair. */
function clip(body: string, start: number, end: number): string {
  let from = start;
  let to = end;
  if (from > 0 && isLowSurrogate(body.charCodeAt(from))) from += 1;
  if (to < body.length && isHighSurrogate(body.charCodeAt(to - 1))) to -= 1;
  return `${from > 0 ? "..." : ""}${body.slice(from, to)}${to < body.length ? "..." : ""}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
