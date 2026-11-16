/**
 * A linear tokenizer for the JavaScript in update-set payloads, and the token
 * queries the rules use.
 *
 * One pass, no regular expression over the script text: comments are
 * skipped; string, template and regular-expression literals become single
 * tokens; brackets are matched with a stack; and loop bodies are marked with
 * a difference array. Rules then walk the token array, so no rule rescans
 * the text. The tokenizer does not parse: a template literal's `${…}` code is
 * part of the literal, and a regular expression is told from a division by
 * the token before it. Both are approximations that only matter for odd code.
 */

export const TokenKind = Object.freeze({
  Identifier: 1,
  Number: 2,
  String: 3,
  Punct: 4,
  Regex: 5,
} as const);
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

export interface Token {
  readonly kind: TokenKind;
  /** Identifier, number or punctuator text; a string's content without its quotes. */
  readonly value: string;
  /** Offset in the script text. */
  readonly start: number;
}

export interface ScriptTokens {
  readonly text: string;
  readonly tokens: readonly Token[];
  /** For a bracket token, the index of its partner; -1 otherwise or when unmatched. */
  readonly match: Int32Array;
  /** How many loop bodies hold each token. */
  readonly loopDepth: Int32Array;
  /** Loops: the header's `(` index and the body's `{` index (or -1 when unbraced). */
  readonly loops: readonly { readonly keyword: number; readonly header: number; readonly body: number }[];
}

const isIdentStart = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127; // A-Z a-z _ $ non-ASCII
const isIdentPart = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number) => c >= 48 && c <= 57;

/** Keywords after which a `/` starts a regular expression. */
const REGEX_AFTER_KEYWORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof"]);
/** Punctuators after which a `/` starts a regular expression. */
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "==", "===", "!=", "!==", "&&", "||", "=>", "<=", ">="]);

const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/** Decodes a `\uXXXX` or `\u{X…}` escape at `at`; null when it is not a valid one. Reads at most 10 characters. */
function unicodeEscape(text: string, at: number): { readonly char: string; readonly end: number } | null {
  if (text.charCodeAt(at) !== 92 || text.charCodeAt(at + 1) !== 117) return null;
  let digits: string;
  let end: number;
  if (text.charCodeAt(at + 2) === 123) {
    // Bounded: the closing brace must come within six digits.
    let close = -1;
    for (let k = at + 3; k < Math.min(text.length, at + 10); k++) {
      if (text.charCodeAt(k) === 125) {
        close = k;
        break;
      }
    }
    if (close < 0 || close - (at + 3) < 1 || close - (at + 3) > 6) return null;
    digits = text.slice(at + 3, close);
    end = close + 1;
  } else {
    digits = text.slice(at + 2, at + 6);
    end = at + 6;
    if (digits.length !== 4) return null;
  }
  for (let k = 0; k < digits.length; k++) if (!isHex(digits.charCodeAt(k))) return null;
  const code = Number.parseInt(digits, 16);
  return code <= 0x10ffff ? { char: String.fromCodePoint(code), end } : null;
}

/**
 * Reads an identifier at `at`, decoding `\u` escapes, so `\u0065val` reads as
 * `eval`. Returns null when there is none.
 */
function readIdentifier(text: string, at: number): { readonly value: string; readonly end: number } | null {
  let j = at;
  let segment = at;
  let value = "";
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (j === at ? isIdentStart(c) : isIdentPart(c)) {
      j++;
      continue;
    }
    if (c === 92) {
      const escape = unicodeEscape(text, j);
      if (escape === null) break;
      value += text.slice(segment, j) + escape.char;
      j = escape.end;
      segment = j;
      continue;
    }
    break;
  }
  if (j === at) return null;
  return { value: value + text.slice(segment, j), end: j };
}

function regexAllowed(previous: Token | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.kind === TokenKind.Punct) return REGEX_AFTER_PUNCT.has(previous.value);
  if (previous.kind === TokenKind.Identifier) return REGEX_AFTER_KEYWORD.has(previous.value);
  return false;
}

/** Tokenizes `text` in one pass. */
export function tokenize(text: string): ScriptTokens {
  const tokens: Token[] = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || c === 0xfeff) {
      i++;
      continue;
    }
    const next = text.charCodeAt(i + 1);
    if (c === 47 && next === 47) {
      // // line comment
      const end = text.indexOf("\n", i + 2);
      i = end < 0 ? length : end + 1;
      continue;
    }
    if (c === 47 && next === 42) {
      // /* block comment */
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? length : end + 2;
      continue;
    }
    if (isIdentStart(c) || c === 92) {
      const identifier = readIdentifier(text, i);
      if (identifier !== null) {
        tokens.push({ kind: TokenKind.Identifier, value: identifier.value, start: i });
        i = identifier.end;
        continue;
      }
    }
    if (isDigit(c) || (c === 46 && isDigit(next))) {
      let j = i + 1;
      while (j < length && (isIdentPart(text.charCodeAt(j)) || text.charCodeAt(j) === 46)) j++;
      tokens.push({ kind: TokenKind.Number, value: text.slice(i, j), start: i });
      i = j;
      continue;
    }
    if (c === 39 || c === 34 || c === 96) {
      // ' " ` literal; ' and " end at a line break too
      let j = i + 1;
      while (j < length) {
        const d = text.charCodeAt(j);
        if (d === 92) {
          j += 2;
          continue;
        }
        if (d === c) break;
        if (c !== 96 && (d === 10 || d === 13)) break;
        j++;
      }
      const end = Math.min(j, length);
      tokens.push({ kind: TokenKind.String, value: text.slice(i + 1, end), start: i });
      i = text.charCodeAt(end) === c ? end + 1 : end;
      continue;
    }
    if (c === 47 && regexAllowed(tokens[tokens.length - 1])) {
      // /regex/flags, ending at an unescaped / outside a class, or at a line break
      let j = i + 1;
      let inClass = false;
      while (j < length) {
        const d = text.charCodeAt(j);
        if (d === 92) {
          j += 2;
          continue;
        }
        if (d === 10 || d === 13) break;
        if (d === 91) inClass = true;
        else if (d === 93) inClass = false;
        else if (d === 47 && !inClass) break;
        j++;
      }
      j = Math.min(j + 1, length);
      while (j < length && isIdentPart(text.charCodeAt(j))) j++;
      tokens.push({ kind: TokenKind.Regex, value: "", start: i });
      i = j;
      continue;
    }
    // Punctuators: = ! < > with following =, =>, && and ||; everything else is one character.
    let j = i + 1;
    if (c === 61 || c === 33 || c === 60 || c === 62) {
      if (c === 61 && next === 62) j = i + 2;
      else
        while (j < length && j < i + 3 && text.charCodeAt(j) === 61) j++;
    } else if ((c === 38 && next === 38) || (c === 124 && next === 124)) {
      j = i + 2;
    }
    tokens.push({ kind: TokenKind.Punct, value: text.slice(i, j), start: i });
    i = j;
  }

  const count = tokens.length;
  const match = new Int32Array(count).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < count; k++) {
    const token = tokens[k];
    if (token.kind !== TokenKind.Punct) continue;
    const v = token.value;
    if (v === "(" || v === "[" || v === "{") {
      stack.push(k);
    } else if (v === ")" || v === "]" || v === "}") {
      const open = v === ")" ? "(" : v === "]" ? "[" : "{";
      // Pop to the nearest matching opener; an unmatched closer is ignored.
      for (let s = stack.length - 1; s >= 0 && s >= stack.length - 8; s--) {
        if (tokens[stack[s]].value === open) {
          match[stack[s]] = k;
          match[k] = stack[s];
          stack.length = s;
          break;
        }
      }
    }
  }

  const loops: { keyword: number; header: number; body: number }[] = [];
  const diff = new Int32Array(count + 1);
  for (let k = 0; k < count; k++) {
    const token = tokens[k];
    if (token.kind !== TokenKind.Identifier) continue;
    if (token.value === "while" || token.value === "for") {
      const header = k + 1;
      if (header >= count || tokens[header].value !== "(" || match[header] < 0) continue;
      const after = match[header] + 1;
      const body = after < count && tokens[after].value === "{" && match[after] > after ? after : -1;
      loops.push({ keyword: k, header, body });
      if (body >= 0) {
        diff[body + 1]++;
        diff[match[body]]--;
      }
    } else if (token.value === "do" && k + 1 < count && tokens[k + 1].value === "{" && match[k + 1] > k + 1) {
      loops.push({ keyword: k, header: -1, body: k + 1 });
      diff[k + 2]++;
      diff[match[k + 1]]--;
    }
  }
  const loopDepth = new Int32Array(count);
  let depth = 0;
  for (let k = 0; k < count; k++) {
    depth += diff[k];
    loopDepth[k] = depth;
  }
  return { text, tokens, match, loopDepth, loops };
}

/** True when the tokens from `at` read `values`, one value per token. */
export function tokensAre(scan: ScriptTokens, at: number, values: readonly string[]): boolean {
  if (at < 0 || at + values.length > scan.tokens.length) return false;
  for (let k = 0; k < values.length; k++) {
    const token = scan.tokens[at + k];
    if (token.kind === TokenKind.String || token.value !== values[k]) return false;
  }
  return true;
}

/** Index of the first `name (` call at or after `from` whose receiver is `receiver` (any receiver when null). */
export function findCall(scan: ScriptTokens, receiver: string | null, name: string, from = 0): number {
  const { tokens } = scan;
  for (let k = Math.max(from, 0); k + 1 < tokens.length; k++) {
    const token = tokens[k];
    if (token.kind !== TokenKind.Identifier || token.value !== name || tokens[k + 1].value !== "(") continue;
    if (receiver === null) return k;
    if (k >= 2 && tokens[k - 1].value === "." && tokens[k - 2].kind === TokenKind.Identifier && tokens[k - 2].value === receiver) {
      return k;
    }
  }
  return -1;
}

/** Index of the first `.name (` method call at or after `from`, on any receiver. */
export function findMethod(scan: ScriptTokens, name: string, from = 0): number {
  const { tokens } = scan;
  for (let k = Math.max(from, 1); k + 1 < tokens.length; k++) {
    const token = tokens[k];
    if (token.kind === TokenKind.Identifier && token.value === name && tokens[k - 1].value === "." && tokens[k + 1].value === "(") {
      return k;
    }
  }
  return -1;
}

/** Index of the first identifier `name` at or after `from`. */
export function findIdentifier(scan: ScriptTokens, name: string, from = 0): number {
  const { tokens } = scan;
  for (let k = Math.max(from, 0); k < tokens.length; k++) {
    if (tokens[k].kind === TokenKind.Identifier && tokens[k].value === name) return k;
  }
  return -1;
}

/**
 * The arguments of the call whose `(` is at `open`: the number of top-level
 * arguments and the index of each one's first token. -1 entries never occur.
 */
export function callArguments(scan: ScriptTokens, open: number): readonly number[] {
  const close = scan.match[open];
  if (close < 0 || close === open + 1) return [];
  const starts = [open + 1];
  for (let k = open + 1; k < close; k++) {
    const token = scan.tokens[k];
    const partner = scan.match[k];
    if (partner > k) {
      k = partner;
      continue;
    }
    if (token.kind === TokenKind.Punct && token.value === ",") starts.push(k + 1);
  }
  return starts;
}

/** Line starts per tokenized script, computed on the first finding that needs a line. */
const LINE_STARTS = new WeakMap<ScriptTokens, Int32Array>();

function lineStarts(text: string): Int32Array {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
  }
  return Int32Array.from(starts);
}

/**
 * 1-based line of `offset` in the script, with the same line breaks as
 * `lineAt`. The line starts are computed once per script, so each further
 * lookup is a binary search.
 */
export function scriptLine(scan: ScriptTokens, offset: number): number {
  let starts = LINE_STARTS.get(scan);
  if (starts === undefined) {
    starts = lineStarts(scan.text);
    LINE_STARTS.set(scan, starts);
  }
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** 1-based line of `offset` in `text`, counting LF, CRLF and lone CR as one break each. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) line++;
  }
  return line;
}
