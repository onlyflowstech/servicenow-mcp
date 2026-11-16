/**
 * Credential-literal patterns for update-set payloads.
 *
 * One set of patterns serves two callers: the evaluator's SEC005 rule, which
 * only needs to know that a pattern matched, and the payload view, which masks
 * each matched value before it shows the text. Neither caller may echo what
 * matched, so the results here carry pattern ids and offsets, never text, and
 * the patterns themselves are not exported.
 *
 * Linear time by construction. Payloads come from other instances and the scan
 * runs on the event loop every HTTP tenant shares, so no pattern may
 * backtrack without bound:
 *   - each rule finds an anchor with a regular expression that starts with a
 *     literal, and whose quantifiers are all bounded (at most 40);
 *   - a hand-written reader then reads the secret value forward, one pass;
 *   - an anchor's look-behind excludes every character its reader consumes,
 *     so no anchor can start inside a value its rule has already read;
 *   - scanning resumes after whatever the reader consumed.
 * Every rule is one linear pass, and a scan is one pass per rule.
 */

/** Stable ids, in scan order. Findings and counters name these, nothing else. */
export const SECRET_PATTERN_IDS = Object.freeze([
  "basic_auth_call",
  "authorization_basic",
  "bearer_token",
  "key_header",
  "credential_assignment",
  "url_credentials",
  "url_query_secret",
  "private_key_block",
  "aws_access_key_id",
  "github_token",
  "slack_token",
  "slack_webhook",
  "google_api_key",
  "stripe_secret_key",
  "jwt",
] as const);

export type SecretPatternId = (typeof SECRET_PATTERN_IDS)[number];

/** What a masked value is replaced with. */
export const SECRET_MASK = "[masked]";

/**
 * The longest text a scan accepts, in UTF-16 code units. The evaluator caps a
 * payload at 256 kB and the payload view's text at 200 kB, so 1 Mi leaves room
 * for either without letting a caller hand over an unbounded string.
 */
export const SECRET_SCAN_MAX_CHARS = 1_048_576;

/**
 * The cap on a speculative read: the user argument of `setBasicAuth` and a
 * header name, which only decide whether a rule applies and are never masked.
 * A value read has no cap. It runs to its real end, and the scan resumes past
 * it, so the work stays linear.
 */
const MAX_SPECULATIVE_READ = 65_536;

/** One match: the pattern, and the half-open span of the secret value. */
export interface SecretMatch {
  readonly id: SecretPatternId;
  readonly start: number;
  readonly end: number;
}

export interface SecretScanOptions {
  /** Stop after this many matches (default and ceiling: no limit below the text length). */
  readonly maxMatches?: number;
}

export type SecretScanResult =
  | {
      readonly status: "ok";
      /** Sorted by start offset, then by pattern order. Spans may overlap across patterns. */
      readonly matches: readonly SecretMatch[];
      /** True when `maxMatches` stopped the scan early. */
      readonly truncated: boolean;
    }
  | { readonly status: "too_large" };

export type SecretMaskResult =
  | {
      readonly status: "ok";
      readonly text: string;
      /** Masked spans after overlapping matches are merged. */
      readonly masked: number;
      /** The patterns that matched, in `SECRET_PATTERN_IDS` order. */
      readonly ids: readonly SecretPatternId[];
    }
  | { readonly status: "too_large" };

// ---------------------------------------------------------------------------
// Character classes, by char code
// ---------------------------------------------------------------------------

const isDigit = (c: number) => c >= 48 && c <= 57;
const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isAlnum = (c: number) => isDigit(c) || isUpper(c) || isLower(c);
const isUpperAlnum = (c: number) => isDigit(c) || isUpper(c);
const isWord = (c: number) => isAlnum(c) || c === 95; // _
const isWordDash = (c: number) => isWord(c) || c === 45; // -
const isAlnumDash = (c: number) => isAlnum(c) || c === 45;
const isBase64 = (c: number) => isAlnum(c) || c === 43 || c === 47; // + /
/** RFC 6750 token68 characters, without the trailing `=` padding. */
const isToken68 = (c: number) =>
  isAlnum(c) || c === 45 || c === 46 || c === 95 || c === 126 || c === 43 || c === 47; // - . _ ~ + /
const isWebhookPath = (c: number) => isWord(c) || c === 47;
const isInlineSpace = (c: number) => c === 32 || c === 9;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

const QUOTE_SINGLE = 39;
const QUOTE_DOUBLE = 34;
const BACKTICK = 96;
const BACKSLASH = 92;

/** End of the run of `accept` characters starting at `from` (no cap: callers resume after it). */
function runEnd(text: string, from: number, accept: (c: number) => boolean): number {
  let i = from;
  while (i < text.length && accept(text.charCodeAt(i))) i++;
  return i;
}

function skip(text: string, from: number, accept: (c: number) => boolean, max: number): number {
  let i = from;
  const limit = Math.min(text.length, from + max);
  while (i < limit && accept(text.charCodeAt(i))) i++;
  return i;
}

interface Literal {
  /** Offset of the first character inside the quotes. */
  readonly start: number;
  /** Offset of the closing quote, or of where the read stopped. */
  readonly end: number;
  /** Offset just after the literal. */
  readonly next: number;
  /** A backtick literal with a `${` substitution: not a constant. */
  readonly interpolated: boolean;
}

const isQuote = (c: number) => c === QUOTE_SINGLE || c === QUOTE_DOUBLE;

/**
 * Reads a JavaScript string literal whose opening quote is at `at`. A `'` or
 * `"` literal ends at its closing quote or at a line break (an unterminated
 * literal is still read, so a cut-off value is still masked); a backtick
 * literal ends at its closing backtick. Escapes are skipped two characters at
 * a time. `cap` bounds a speculative read only. Returns null when there is no
 * quote at `at`.
 */
function readLiteral(text: string, at: number, cap = Number.POSITIVE_INFINITY): Literal | null {
  const quote = text.charCodeAt(at);
  if (quote !== QUOTE_SINGLE && quote !== QUOTE_DOUBLE && quote !== BACKTICK) return null;
  const start = at + 1;
  const limit = Math.min(text.length, start + cap);
  let interpolated = false;
  let i = start;
  while (i < limit) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH) {
      i += 2;
      continue;
    }
    if (c === quote) return { start, end: i, next: i + 1, interpolated };
    if (quote !== BACKTICK && (c === 10 || c === 13)) return { start, end: i, next: i, interpolated };
    if (quote === BACKTICK && c === 36 && text.charCodeAt(i + 1) === 123) interpolated = true; // ${
    i++;
  }
  const end = Math.min(i, text.length);
  return { start, end, next: end, interpolated };
}

/**
 * Reads a string nested in another string, whose quotes are escaped: the
 * `\"x\"` in `"{\"password\":\"x\"}"`. It starts at a backslash followed by a
 * quote, and ends at the next backslash and that quote, at the outer literal's
 * bare quote, at a line break, or at the end of the text. A value that itself
 * holds a doubly escaped quote ends there, early.
 */
function readEscapedLiteral(text: string, at: number): Literal | null {
  const quote = text.charCodeAt(at + 1);
  if (text.charCodeAt(at) !== BACKSLASH || !isQuote(quote)) return null;
  const start = at + 2;
  let i = start;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH) {
      if (text.charCodeAt(i + 1) === quote) return { start, end: i, next: i + 2, interpolated: false };
      i += 2;
      continue;
    }
    if (c === quote || c === 10 || c === 13) return { start, end: i, next: i, interpolated: false };
    i++;
  }
  return { start, end: text.length, next: text.length, interpolated: false };
}

/** A plain or an escaped string literal at `at`. */
function readValue(text: string, at: number): Literal | null {
  return readLiteral(text, at) ?? readEscapedLiteral(text, at);
}

/**
 * True when the quoted key that ends at `keyEnd` (its keyword starting at
 * `keywordStart`) is a call's first argument: `setValue('password', …)`, not
 * `['user_name', 'password', 'email']`. The backward read stops at the key's
 * opening quote, at a line break, or after 256 characters. Only keys followed
 * by a quote reach it, so no two reads overlap and the work stays linear.
 */
function isFirstArgument(text: string, keywordStart: number, quote: number): boolean {
  const floor = Math.max(0, keywordStart - 256);
  let i = keywordStart - 1;
  while (i >= floor) {
    const c = text.charCodeAt(i);
    if (c === quote) break;
    if (c === 10 || c === 13) return false;
    i--;
  }
  if (i < floor) return false;
  i--;
  if (text.charCodeAt(i) === BACKSLASH) i--;
  const stop = Math.max(0, i - 16);
  while (i >= stop && isSpace(text.charCodeAt(i))) i--;
  return text.charCodeAt(i) === 40; // (
}

/** True when the literal is a constant with at least `min` non-space characters. */
function isConstantLiteral(text: string, literal: Literal, min: number): boolean {
  if (literal.interpolated) return false;
  let count = 0;
  let allStars = true;
  for (let i = literal.start; i < literal.end; i++) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) continue;
    count++;
    if (c !== 42) allStars = false; // *
    if (count >= min && !allStars) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** What a reader found: the secret span, if any, and where the scan resumes. */
interface ReadOutcome {
  readonly span: readonly [number, number] | null;
  readonly resume: number;
}

interface SecretRule {
  readonly id: SecretPatternId;
  /** Global, literal-led, bounded. Module-private: never exported or rendered. */
  readonly anchor: RegExp;
  readonly read: (text: string, anchorStart: number, anchorEnd: number) => ReadOutcome;
}

const miss = (resume: number): ReadOutcome => ({ span: null, resume });

interface TokenShape {
  /** Characters the token's run may hold. */
  readonly accept: (c: number) => boolean;
  /** Whether the run's length is right. */
  readonly length: (runLength: number) => boolean;
  /** A character that may not follow the run (default: a word character). */
  readonly boundary?: (c: number) => boolean;
  /** Mask the anchor too (a vendor prefix), or only the run (a URL path). Default true. */
  readonly maskPrefix?: boolean;
}

/** A token: the anchor, then a run of `accept` characters of the right length. */
function tokenRule(id: SecretPatternId, anchor: RegExp, shape: TokenShape): SecretRule {
  const boundary = shape.boundary ?? isWord;
  const maskPrefix = shape.maskPrefix ?? true;
  return {
    id,
    anchor,
    read(text, anchorStart, anchorEnd) {
      const end = runEnd(text, anchorEnd, shape.accept);
      const ok = shape.length(end - anchorEnd) && !boundary(text.charCodeAt(end));
      return ok ? { span: [maskPrefix ? anchorStart : anchorEnd, end], resume: end } : miss(end);
    },
  };
}

/** Separator between a key and its value: `:`, `=`, `==` or `===`, never `=>`. */
function readSeparator(text: string, at: number): number {
  const c = text.charCodeAt(at);
  if (c === 58) return at + 1; // :
  if (c !== 61) return -1; // =
  let i = at + 1;
  while (i < at + 3 && text.charCodeAt(i) === 61) i++;
  if (text.charCodeAt(i) === 62) return -1; // =>
  return i;
}

/** Header names whose value is a credential when it is a string constant. */
const CREDENTIAL_HEADER =
  /^(?:proxy-)?authorization$|^(?:x-)?[a-z0-9-]{0,40}(?:key|token|secret|password|passwd|auth|signature)$/iu;

const RULES: readonly SecretRule[] = Object.freeze([
  {
    // setBasicAuth(user, 'password'): the second argument as a constant.
    id: "basic_auth_call",
    anchor: /setBasicAuth[ \t\r\n]{0,16}\([ \t\r\n]{0,16}/gu,
    read(text, _anchorStart, anchorEnd) {
      let i = anchorEnd;
      const user = readLiteral(text, i, MAX_SPECULATIVE_READ);
      if (user) {
        i = user.next;
      } else {
        // A variable or member expression; no nested calls.
        const end = Math.min(text.length, i + 256);
        while (i < end) {
          const c = text.charCodeAt(i);
          if (c === 44 || c === 40 || c === 41 || c === 59 || c === 10 || c === 13) break; // , ( ) ; \n \r
          i++;
        }
      }
      i = skip(text, i, isSpace, 16);
      if (text.charCodeAt(i) !== 44) return miss(anchorEnd); // ,
      i = skip(text, i + 1, isSpace, 16);
      const password = readLiteral(text, i);
      if (!password) return miss(anchorEnd);
      return isConstantLiteral(text, password, 1)
        ? { span: [password.start, password.end], resume: password.next }
        : miss(password.next);
    },
  },
  {
    // Authorization: Basic <base64 of user:password>
    id: "authorization_basic",
    anchor: /(?<![A-Za-z0-9_+/])Basic[ \t]{1,8}/gu,
    read(text, _anchorStart, anchorEnd) {
      const body = runEnd(text, anchorEnd, isBase64);
      let end = body;
      while (end < body + 2 && text.charCodeAt(end) === 61) end++; // =
      const length = end - anchorEnd;
      // A miss resumes at the anchor's end, so `Basic Basic <b64>` still finds
      // the second; no anchor starts inside the run, so this stays linear.
      if (length < 8 || length % 4 !== 0 || isWord(text.charCodeAt(end))) return miss(anchorEnd);
      const decoded = Buffer.from(text.slice(anchorEnd, end), "base64");
      return decoded.includes(58) ? { span: [anchorEnd, end], resume: end } : miss(anchorEnd); // :
    },
  },
  {
    // Bearer <token>; a token with no digit must be long, so prose doesn't match.
    id: "bearer_token",
    anchor: /(?<![A-Za-z0-9_.~+/-])bearer[ \t]{1,8}/giu,
    read(text, _anchorStart, anchorEnd) {
      const body = runEnd(text, anchorEnd, isToken68);
      let end = body;
      while (end < body + 2 && text.charCodeAt(end) === 61) end++;
      const length = body - anchorEnd;
      if (length < 16) return miss(anchorEnd);
      let digit = false;
      for (let i = anchorEnd; i < body && !digit; i++) digit = isDigit(text.charCodeAt(i));
      return digit || length >= 40 ? { span: [anchorEnd, end], resume: end } : miss(anchorEnd);
    },
  },
  {
    // setRequestHeader('X-API-Key', 'constant')
    id: "key_header",
    anchor: /setRequestHeader[ \t\r\n]{0,16}\([ \t\r\n]{0,16}/gu,
    read(text, _anchorStart, anchorEnd) {
      const name = readLiteral(text, anchorEnd, MAX_SPECULATIVE_READ);
      if (!name || name.end === name.next || name.end - name.start > 64) return miss(anchorEnd);
      if (!CREDENTIAL_HEADER.test(text.slice(name.start, name.end))) return miss(name.next);
      let i = skip(text, name.next, isSpace, 16);
      if (text.charCodeAt(i) !== 44) return miss(name.next);
      i = skip(text, i + 1, isSpace, 16);
      const value = readLiteral(text, i);
      if (!value) return miss(i);
      // `'Bearer ' + token` is a prefix, not a credential.
      const after = skip(text, value.next, isSpace, 16);
      if (!isConstantLiteral(text, value, 8) || text.charCodeAt(after) === 43) return miss(value.next);
      return { span: [value.start, value.end], resume: value.next };
    },
  },
  {
    // password = 'x', clientSecret: "x", 'x-api-key': 'x', headers['api_key'] = 'x',
    // gr.setValue('password', 'x'), gs.setProperty('x.password', 'x'),
    // map.put("apiKey", "x") and escaped JSON, "{\"password\":\"x\"}".
    // The keyword must end the identifier or the key; anything may come before it.
    id: "credential_assignment",
    anchor:
      /(?:pass(?:word|wd|phrase)|pwd|secret|(?:api|access|private|client|encryption|signing|auth|secret)[_-]?key|apikey|(?:access|auth|refresh|bearer|api|session|id)[_-]?token|credentials?)(?![A-Za-z0-9_$])/giu,
    read(text, anchorStart, anchorEnd) {
      let i = anchorEnd;
      // A key that ends a quoted literal: ', ", or an escaped \' or \".
      let keyQuote = 0;
      const c = text.charCodeAt(i);
      if (isQuote(c)) {
        keyQuote = c;
        i++;
      } else if (c === BACKSLASH && isQuote(text.charCodeAt(i + 1))) {
        keyQuote = text.charCodeAt(i + 1);
        i += 2;
      }
      if (text.charCodeAt(i) === 93) i++; // ]
      i = skip(text, i, keyQuote === 0 ? isInlineSpace : isSpace, 16);
      // A comma separates only a quoted key that is a call's first argument.
      const argument = keyQuote !== 0 && text.charCodeAt(i) === 44 && isFirstArgument(text, anchorStart, keyQuote);
      i = argument ? i + 1 : readSeparator(text, i);
      if (i < 0) return miss(anchorEnd);
      i = skip(text, i, argument ? isSpace : isInlineSpace, 16);
      const value = readValue(text, i);
      if (!value) return miss(i);
      return isConstantLiteral(text, value, 1)
        ? { span: [value.start, value.end], resume: value.next }
        : miss(value.next);
    },
  },
  {
    // scheme://user:password@host
    id: "url_credentials",
    anchor: /(?<=[A-Za-z0-9]):\/\//gu,
    read(text, _anchorStart, anchorEnd) {
      const limit = Math.min(text.length, anchorEnd + 512);
      let colon = -1;
      let i = anchorEnd;
      for (; i < limit; i++) {
        const c = text.charCodeAt(i);
        if (c === 64) break; // @
        if (c === 58 && colon < 0) colon = i; // :
        // / ? # whitespace quotes \ < > ( ) ,
        if (
          c === 47 || c === 63 || c === 35 || isSpace(c) || c === QUOTE_SINGLE || c === QUOTE_DOUBLE ||
          c === BACKTICK || c === BACKSLASH || c === 60 || c === 62 || c === 40 || c === 41 || c === 44
        ) {
          return miss(anchorEnd);
        }
      }
      if (i >= limit || colon < 0 || colon + 1 === i) return miss(anchorEnd);
      return { span: [colon + 1, i], resume: i };
    },
  },
  {
    // ?api_key=value, &access_token=value, &sig=value; also a key=value
    // string that starts at its quote ('password=x&…') and connection
    // strings (;password=x;, ;PWD=x; and the ADO.NET style ; Password=x;).
    id: "url_query_secret",
    anchor:
      /(?:[?&'"]|;[ \t]{0,4})(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd|sig|signature|key)=/giu,
    read(text, _anchorStart, anchorEnd) {
      // Stops at ? & ; and quotes too, so no anchor can start inside a value.
      let end = anchorEnd;
      while (end < text.length) {
        const c = text.charCodeAt(end);
        if (
          c === 38 || c === 63 || c === 59 || c === 35 || isSpace(c) || c === QUOTE_SINGLE || c === QUOTE_DOUBLE ||
          c === BACKTICK || c === 60 || c === 62 || c === BACKSLASH
        ) {
          break;
        }
        end++;
      }
      if (end - anchorEnd < 4) return miss(end);
      // `?key=${value}` and `?key=' + value` read as a placeholder, not a constant.
      if (text.charCodeAt(anchorEnd) === 36 && text.charCodeAt(anchorEnd + 1) === 123) return miss(end);
      return { span: [anchorEnd, end], resume: end };
    },
  },
  {
    // PEM and PGP private keys: everything to the END line, or to the end of the text.
    id: "private_key_block",
    anchor: /-----BEGIN (?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----/gu,
    read(text, _anchorStart, anchorEnd) {
      const found = text.indexOf("-----END", anchorEnd);
      const end = found < 0 ? text.length : found;
      return end > anchorEnd ? { span: [anchorEnd, end], resume: end } : miss(anchorEnd);
    },
  },
  tokenRule("aws_access_key_id", /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)/gu, {
    accept: isUpperAlnum,
    length: (n) => n === 16,
    boundary: isAlnum,
  }),
  {
    id: "github_token",
    anchor: /(?<![A-Za-z0-9_])(?:gh[pousr]_|github_pat_)/gu,
    read(text, anchorStart, anchorEnd) {
      const fineGrained = anchorEnd - anchorStart === 11;
      const end = runEnd(text, anchorEnd, isWord);
      const length = end - anchorEnd;
      let ok = fineGrained ? length >= 22 : length >= 36;
      for (let i = anchorEnd; ok && !fineGrained && i < end; i++) ok = text.charCodeAt(i) !== 95;
      return ok ? { span: [anchorStart, end], resume: end } : miss(end);
    },
  },
  tokenRule("slack_token", /(?<![A-Za-z0-9_-])xox[abposr]-/gu, { accept: isAlnumDash, length: (n) => n >= 10 }),
  tokenRule("slack_webhook", /hooks\.slack\.com\/services\//gu, {
    accept: isWebhookPath,
    length: (n) => n >= 20,
    maskPrefix: false,
  }),
  tokenRule("google_api_key", /(?<![A-Za-z0-9_-])AIza/gu, { accept: isWordDash, length: (n) => n === 35 }),
  tokenRule("stripe_secret_key", /(?<![A-Za-z0-9_])[sr]k_live_/gu, { accept: isAlnum, length: (n) => n >= 16 }),
  {
    // header.payload.signature, each base64url; the header and payload are JSON objects.
    id: "jwt",
    anchor: /(?<![A-Za-z0-9_.-])eyJ/gu,
    read(text, anchorStart) {
      const header = runEnd(text, anchorStart, isWordDash);
      if (header - anchorStart < 8 || text.charCodeAt(header) !== 46) return miss(header);
      const payloadStart = header + 1;
      if (!text.startsWith("eyJ", payloadStart)) return miss(payloadStart);
      const payload = runEnd(text, payloadStart, isWordDash);
      if (payload - payloadStart < 8 || text.charCodeAt(payload) !== 46) return miss(payload);
      const signature = runEnd(text, payload + 1, isWordDash);
      return signature - payload - 1 >= 8 ? { span: [anchorStart, signature], resume: signature } : miss(signature);
    },
  },
] satisfies SecretRule[]);

// ---------------------------------------------------------------------------
// Scan and mask
// ---------------------------------------------------------------------------

const PATTERN_ORDER: ReadonlyMap<SecretPatternId, number> = new Map(
  SECRET_PATTERN_IDS.map((id, index) => [id, index])
);

function runRule(rule: SecretRule, text: string, out: SecretMatch[], limit: number): boolean {
  const anchor = rule.anchor;
  let position = 0;
  while (position < text.length) {
    anchor.lastIndex = position;
    const found = anchor.exec(text);
    if (found === null) break;
    const anchorEnd = found.index + found[0].length;
    const outcome = rule.read(text, found.index, anchorEnd);
    if (outcome.span !== null && outcome.span[1] > outcome.span[0]) {
      out.push({ id: rule.id, start: outcome.span[0], end: outcome.span[1] });
      if (out.length >= limit) {
        anchor.lastIndex = 0;
        return true;
      }
    }
    position = Math.max(outcome.resume, anchorEnd, found.index + 1);
  }
  anchor.lastIndex = 0;
  return false;
}

function matchLimit(options: SecretScanOptions | undefined): number {
  const requested = options?.maxMatches;
  if (requested === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new RangeError("maxMatches must be a positive integer.");
  }
  return requested;
}

/**
 * Finds credential literals in `text`. Returns pattern ids and offsets only.
 * Text longer than `SECRET_SCAN_MAX_CHARS` is refused (`too_large`) rather
 * than scanned in part. A caller that shows a capped excerpt masks the whole
 * text first and cuts it afterwards, so no value is split at the cut; text
 * too large to mask is not shown.
 */
export function scanSecrets(text: string, options?: SecretScanOptions): SecretScanResult {
  const limit = matchLimit(options);
  if (typeof text !== "string" || text.length > SECRET_SCAN_MAX_CHARS) return { status: "too_large" };
  const matches: SecretMatch[] = [];
  let truncated = false;
  for (const rule of RULES) {
    if (runRule(rule, text, matches, limit)) {
      truncated = true;
      break;
    }
  }
  matches.sort((a, b) => a.start - b.start || (PATTERN_ORDER.get(a.id) ?? 0) - (PATTERN_ORDER.get(b.id) ?? 0));
  return { status: "ok", matches, truncated };
}

/**
 * Replaces every matched secret value with `SECRET_MASK`. The text around a
 * value (the call, the key, the quotes) is kept, so the masked text still
 * reads as code. Masking is idempotent.
 */
export function maskSecrets(text: string): SecretMaskResult {
  const scan = scanSecrets(text);
  if (scan.status !== "ok") return scan;
  if (scan.matches.length === 0) return { status: "ok", text, masked: 0, ids: [] };

  const seen = new Set<SecretPatternId>();
  const parts: string[] = [];
  let cursor = 0;
  let spanStart = -1;
  let spanEnd = -1;
  let masked = 0;
  const flush = () => {
    parts.push(text.slice(cursor, spanStart), SECRET_MASK);
    cursor = spanEnd;
    masked++;
  };
  for (const match of scan.matches) {
    seen.add(match.id);
    if (spanStart >= 0 && match.start <= spanEnd) {
      spanEnd = Math.max(spanEnd, match.end);
      continue;
    }
    if (spanStart >= 0) flush();
    spanStart = match.start;
    spanEnd = match.end;
  }
  flush();
  parts.push(text.slice(cursor));
  return {
    status: "ok",
    text: parts.join(""),
    masked,
    ids: SECRET_PATTERN_IDS.filter((id) => seen.has(id)),
  };
}
