/**
 * One sanitizer for instance text that a tool writes into its own prose: an
 * error, a warning, a line of rendered text.
 *
 * The character sets are the ones `encodeMermaidLabel` removes from a diagram
 * label (`sn_flow_view`'s rules E3 steps 2 and 3), so a name is cleaned the
 * same way wherever it is shown: line breaks and tabs become a space; C0/C1
 * controls and DEL, bidi controls, zero-width and other invisible characters,
 * unpaired surrogates and Unicode tag characters (U+E0000-E007F, which render
 * as nothing but read as ASCII) are removed; runs of white space collapse to
 * one space; and the result is trimmed and cut at a code-point bound, with a
 * marker when it was cut.
 *
 * @module inert-text
 */

// Line breaks (CR, LF, NEL, LS, PS) and tab become a space. This runs before
// the stripping, which would otherwise delete CR/LF/tab as C0 controls and
// glue the words on either side together.
export const LINE_BREAKS_AND_TABS = /[\r\n\t\u0085\u2028\u2029]/gu;
// C0/C1 controls and DEL; bidi controls U+061C, U+200E, U+200F,
// U+202A-202E, U+2066-2069; invisibles U+00AD, U+200B-200D, U+2060-2064,
// U+FEFF; tag characters U+E0000-E007F.
export const STRIPPED_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
// With the `u` flag this matches only unpaired surrogates.
export const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;

const WHITESPACE_RUNS = /\s+/gu;
const TRUNCATION_MARKER = "…";

/**
 * `value` as one line of inert text of at most `max` code points (and a
 * marker when cut). Anything that is not a string gives "". Only a bounded
 * prefix of the value is examined.
 */
export function inertText(value: unknown, max = 80): string {
  if (typeof value !== "string") return "";
  const examined = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const flat = examined
    .replace(LINE_BREAKS_AND_TABS, " ")
    .replace(STRIPPED_CHARACTERS, "")
    .replace(LONE_SURROGATES, "")
    .replace(WHITESPACE_RUNS, " ")
    .trim();
  const characters = Array.from(flat);
  return characters.length > max || value.length > examined.length
    ? `${characters.slice(0, max).join("")}${TRUNCATION_MARKER}`
    : flat;
}

/** `value` made inert as {@link inertText}, with double quotes neutralized, for use between quotes. */
export function quotedInertText(value: unknown, max = 80): string {
  return inertText(value, max).replace(/"/gu, "'");
}
