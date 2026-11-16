/**
 * A minimal, bounded XML reader for `sys_update_xml.payload`.
 *
 * Payloads come from this instance and, for a remote set, from another one, so
 * the reader treats every byte as hostile:
 *   - iterative, never recursive, with caps on depth, element count,
 *     attributes per element, name length and total bytes;
 *   - no DTD of any kind: DOCTYPE, ENTITY and every other `<!` declaration are
 *     rejected, so nothing can declare an entity or point at an external one;
 *   - only the five predefined entities and valid numeric character
 *     references are decoded; any other `&name;` is rejected;
 *   - processing instructions are rejected, except one leading
 *     `<?xml version=… encoding=… standalone=…?>` declaration at offset 0
 *     (after an optional byte-order mark), which every payload has;
 *   - an XInclude namespace binding is rejected, although nothing here would
 *     act on it;
 *   - comments are skipped and kept out of the tree.
 * It never throws on input. A failure is a fixed code plus a fixed message;
 * neither carries any payload text.
 *
 * No dependency: the npm XML parsers either resolve entities or are far larger
 * than this format needs.
 */

/** Default caps. Callers may lower any of them; `maxBytes` may also be raised, to `XML_READER_MAX_BYTES`. */
export const XML_READER_LIMITS = Object.freeze({
  maxDepth: 64,
  maxElements: 20_000,
  maxAttributesPerElement: 64,
  /** UTF-8 bytes. The evaluator's per-payload cap. */
  maxBytes: 262_144,
  maxNameLength: 256,
});

/** The ceiling for a caller's `maxBytes`. */
export const XML_READER_MAX_BYTES = 1_048_576;

export interface XmlReaderOptions {
  readonly maxDepth?: number;
  readonly maxElements?: number;
  readonly maxAttributesPerElement?: number;
  readonly maxBytes?: number;
}

export interface XmlDeclaration {
  readonly version: string;
  readonly encoding: string | null;
  readonly standalone: "yes" | "no" | null;
}

export interface XmlText {
  readonly kind: "text";
  /** Decoded text. */
  readonly value: string;
  /** True when the text came from a CDATA section. */
  readonly cdata: boolean;
}

export interface XmlElement {
  readonly kind: "element";
  readonly name: string;
  /** Decoded attribute values, in document order. */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | XmlText;

export interface XmlDocument {
  readonly declaration: XmlDeclaration | null;
  readonly root: XmlElement;
  readonly elementCount: number;
  readonly maxDepth: number;
  /** UTF-8 length of the input. */
  readonly bytes: number;
}

export const XML_READ_ERROR_CODES = Object.freeze([
  "not_text",
  "too_large",
  "no_root",
  "invalid_declaration",
  "processing_instruction",
  "doctype",
  "entity_declaration",
  "markup_declaration",
  "external_reference",
  "invalid_entity_reference",
  "invalid_character_reference",
  "malformed_tag",
  "invalid_name",
  "name_too_long",
  "invalid_attribute",
  "duplicate_attribute",
  "mismatched_tag",
  "unclosed_element",
  "unclosed_comment",
  "unclosed_cdata",
  "content_outside_root",
  "multiple_roots",
  "depth_limit",
  "element_limit",
  "attribute_limit",
] as const);

export type XmlReadErrorCode = (typeof XML_READ_ERROR_CODES)[number];

/** One fixed sentence per code. None interpolates anything. */
export const XML_READ_ERROR_MESSAGES: Readonly<Record<XmlReadErrorCode, string>> = Object.freeze({
  not_text: "The payload is not text.",
  too_large: "The payload is larger than the XML reader accepts.",
  no_root: "The payload has no root element.",
  invalid_declaration: "The payload's XML declaration is not one the reader accepts.",
  processing_instruction: "The payload has a processing instruction other than the leading XML declaration.",
  doctype: "The payload has a DOCTYPE declaration, which the reader does not accept.",
  entity_declaration: "The payload has an ENTITY declaration, which the reader does not accept.",
  markup_declaration: "The payload has a markup declaration, which the reader does not accept.",
  external_reference: "The payload refers to external content, which the reader does not accept.",
  invalid_entity_reference: "The payload has an entity reference other than the five predefined ones.",
  invalid_character_reference: "The payload has a character reference that is not a valid XML character.",
  malformed_tag: "The payload has a malformed tag.",
  invalid_name: "The payload has an element or attribute name the reader does not accept.",
  name_too_long: "The payload has an element or attribute name longer than the reader accepts.",
  invalid_attribute: "The payload has a malformed attribute.",
  duplicate_attribute: "The payload has an element with the same attribute twice.",
  mismatched_tag: "The payload has an end tag that does not match its start tag.",
  unclosed_element: "The payload ends before every element is closed.",
  unclosed_comment: "The payload has a comment that is not closed.",
  unclosed_cdata: "The payload has a CDATA section that is not closed.",
  content_outside_root: "The payload has content outside its root element.",
  multiple_roots: "The payload has more than one root element.",
  depth_limit: "The payload nests elements deeper than the reader accepts.",
  element_limit: "The payload has more elements than the reader accepts.",
  attribute_limit: "The payload has an element with more attributes than the reader accepts.",
});

export interface XmlReadFailure {
  readonly ok: false;
  readonly code: XmlReadErrorCode;
  readonly message: string;
}

export type XmlReadResult = { readonly ok: true; readonly document: XmlDocument } | XmlReadFailure;

const XINCLUDE_NAMESPACE = "http://www.w3.org/2001/XInclude";
const BOM = 0xfeff;

interface Limits {
  readonly maxDepth: number;
  readonly maxElements: number;
  readonly maxAttributesPerElement: number;
  readonly maxBytes: number;
}

function resolveLimits(options: XmlReaderOptions | undefined): Limits {
  const pick = (key: keyof Limits, ceiling: number): number => {
    const value = options?.[key];
    if (value === undefined) return XML_READER_LIMITS[key];
    if (!Number.isInteger(value) || value < 1 || value > ceiling) {
      throw new RangeError(`XML reader option ${key} is out of range.`);
    }
    return value;
  };
  return {
    maxDepth: pick("maxDepth", XML_READER_LIMITS.maxDepth),
    maxElements: pick("maxElements", XML_READER_LIMITS.maxElements),
    maxAttributesPerElement: pick("maxAttributesPerElement", XML_READER_LIMITS.maxAttributesPerElement),
    maxBytes: pick("maxBytes", XML_READER_MAX_BYTES),
  };
}

/** Thrown inside the reader only; `readXml` turns it into a result. */
class Reject {
  constructor(readonly code: XmlReadErrorCode) {}
}

function fail(code: XmlReadErrorCode): XmlReadFailure {
  return { ok: false, code, message: XML_READ_ERROR_MESSAGES[code] };
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58; // A-Z a-z _ :
const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46; // 0-9 - .

/** The XML 1.0 `Char` production. */
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

const PREDEFINED: Readonly<Record<string, string>> = Object.freeze({
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
});

/**
 * Decodes references in `text[from, to)`. Every search stays inside the
 * segment and each reference is bounded (at most ten characters between `&`
 * and `;`), so the work is linear in the segment.
 */
function decode(text: string, from: number, to: number, normalizeWhitespace: boolean): string {
  const segment = text.slice(from, to);
  const raw = (value: string) => (normalizeWhitespace ? value.replace(/[\t\n\r]/gu, " ") : value);
  let amp = segment.indexOf("&");
  if (amp < 0) return raw(segment);
  const parts: string[] = [];
  let cursor = 0;
  while (amp >= 0) {
    parts.push(raw(segment.slice(cursor, amp)));
    const semi = segment.indexOf(";", amp + 1);
    if (semi < 0 || semi - amp > 11) throw new Reject("invalid_entity_reference");
    const body = segment.slice(amp + 1, semi);
    if (body.charCodeAt(0) === 35) {
      // #
      const hex = body.charCodeAt(1) === 120; // x
      const digits = body.slice(hex ? 2 : 1);
      const valid = hex ? /^[0-9A-Fa-f]{1,6}$/u.test(digits) : /^[0-9]{1,7}$/u.test(digits);
      const code = valid ? Number.parseInt(digits, hex ? 16 : 10) : -1;
      if (!isXmlChar(code)) throw new Reject("invalid_character_reference");
      parts.push(String.fromCodePoint(code));
    } else {
      const value = Object.hasOwn(PREDEFINED, body) ? PREDEFINED[body] : undefined;
      if (value === undefined) throw new Reject("invalid_entity_reference");
      parts.push(value);
    }
    cursor = semi + 1;
    amp = segment.indexOf("&", cursor);
  }
  parts.push(raw(segment.slice(cursor)));
  return parts.join("");
}

interface OpenElement {
  readonly name: string;
  readonly attributes: Map<string, string>;
  readonly children: XmlNode[];
}

/** Reads the `<?xml …?>` declaration at `at`; returns it and the offset after `?>`. */
function readDeclaration(text: string, at: number): { declaration: XmlDeclaration; next: number } {
  const close = text.indexOf("?>", at);
  if (close < 0 || close - at > 256) throw new Reject("invalid_declaration");
  const body = text.slice(at + 5, close);
  // version, then optional encoding, then optional standalone; quotes must match.
  const match =
    /^[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"(1\.[0-9]{1,3})"|'(1\.[0-9]{1,3})')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"([A-Za-z][A-Za-z0-9._-]{0,39})"|'([A-Za-z][A-Za-z0-9._-]{0,39})'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(yes|no)"|'(yes|no)'))?[ \t\r\n]*$/u.exec(
      body
    );
  if (!match) throw new Reject("invalid_declaration");
  const standalone = match[5] ?? match[6];
  return {
    declaration: {
      version: match[1] ?? match[2] ?? "1.0",
      encoding: match[3] ?? match[4] ?? null,
      standalone: standalone === "yes" || standalone === "no" ? standalone : null,
    },
    next: close + 2,
  };
}

function readName(text: string, at: number): number {
  if (!isNameStart(text.charCodeAt(at))) {
    throw new Reject(at < text.length && !isSpace(text.charCodeAt(at)) ? "invalid_name" : "malformed_tag");
  }
  let i = at + 1;
  while (i < text.length && isNameChar(text.charCodeAt(i))) i++;
  if (i - at > XML_READER_LIMITS.maxNameLength) throw new Reject("name_too_long");
  const next = text.charCodeAt(i);
  // A name ends at whitespace, `/`, `>` or `=`; anything else (non-ASCII included) is not accepted.
  if (i < text.length && !isSpace(next) && next !== 47 && next !== 62 && next !== 61) {
    throw new Reject("invalid_name");
  }
  return i;
}

function skipSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  return i;
}

function parse(text: string, limits: Limits, bytes: number): XmlDocument {
  let i = 0;
  if (text.charCodeAt(0) === BOM) i = 1;
  let declaration: XmlDeclaration | null = null;
  if (text.startsWith("<?xml", i) && isSpace(text.charCodeAt(i + 5))) {
    const read = readDeclaration(text, i);
    declaration = read.declaration;
    i = read.next;
  }

  const stack: OpenElement[] = [];
  let root: XmlElement | null = null;
  let elementCount = 0;
  let maxDepth = 0;
  const length = text.length;

  const addText = (value: string, cdata: boolean) => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (cdata || !/^[ \t\r\n]*$/u.test(value)) throw new Reject("content_outside_root");
      return;
    }
    if (value.length > 0) parent.children.push({ kind: "text", value, cdata });
  };

  while (i < length) {
    const lt = text.indexOf("<", i);
    const textEnd = lt < 0 ? length : lt;
    if (textEnd > i) {
      if (stack.length === 0) {
        // Outside the root only whitespace may appear, and it carries no references.
        for (let k = i; k < textEnd; k++) {
          if (!isSpace(text.charCodeAt(k))) throw new Reject("content_outside_root");
        }
      } else {
        addText(decode(text, i, textEnd, false), false);
      }
    }
    if (lt < 0) break;
    i = lt;
    const next = text.charCodeAt(i + 1);

    if (next === 63) throw new Reject("processing_instruction"); // <?

    if (next === 33) {
      // <!
      if (text.startsWith("<!--", i)) {
        const close = text.indexOf("-->", i + 4);
        if (close < 0) throw new Reject("unclosed_comment");
        i = close + 3;
        continue;
      }
      if (text.startsWith("<![CDATA[", i)) {
        const close = text.indexOf("]]>", i + 9);
        if (close < 0) throw new Reject("unclosed_cdata");
        addText(text.slice(i + 9, close), true);
        i = close + 3;
        continue;
      }
      const keyword = text.slice(i + 2, i + 9).toUpperCase();
      if (keyword.startsWith("DOCTYPE")) throw new Reject("doctype");
      if (keyword.startsWith("ENTITY")) throw new Reject("entity_declaration");
      throw new Reject("markup_declaration");
    }

    if (next === 47) {
      // </name>
      const nameEnd = readName(text, i + 2);
      const name = text.slice(i + 2, nameEnd);
      const close = skipSpace(text, nameEnd);
      if (text.charCodeAt(close) !== 62) throw new Reject("malformed_tag");
      const open = stack.pop();
      if (open === undefined || open.name !== name) throw new Reject("mismatched_tag");
      const element: XmlElement = { kind: "element", name, attributes: open.attributes, children: open.children };
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
      i = close + 1;
      continue;
    }

    // <name attr="value" …> or <name …/>
    if (root !== null) throw new Reject("multiple_roots");
    const nameEnd = readName(text, i + 1);
    const name = text.slice(i + 1, nameEnd);
    elementCount++;
    if (elementCount > limits.maxElements) throw new Reject("element_limit");
    if (stack.length + 1 > limits.maxDepth) throw new Reject("depth_limit");
    maxDepth = Math.max(maxDepth, stack.length + 1);

    const attributes = new Map<string, string>();
    let j = nameEnd;
    let selfClosing = false;
    for (;;) {
      const afterSpace = skipSpace(text, j);
      const c = text.charCodeAt(afterSpace);
      if (afterSpace >= length) throw new Reject("malformed_tag");
      if (c === 62) {
        j = afterSpace + 1;
        break;
      }
      if (c === 47) {
        if (text.charCodeAt(afterSpace + 1) !== 62) throw new Reject("malformed_tag");
        selfClosing = true;
        j = afterSpace + 2;
        break;
      }
      if (afterSpace === j) throw new Reject("malformed_tag"); // attributes need whitespace before them
      const attrEnd = readName(text, afterSpace);
      const attrName = text.slice(afterSpace, attrEnd);
      let k = skipSpace(text, attrEnd);
      if (text.charCodeAt(k) !== 61) throw new Reject("invalid_attribute"); // =
      k = skipSpace(text, k + 1);
      const quote = text.charCodeAt(k);
      if (quote !== 34 && quote !== 39) throw new Reject("invalid_attribute");
      const valueEnd = text.indexOf(quote === 34 ? '"' : "'", k + 1);
      if (valueEnd < 0) throw new Reject("invalid_attribute");
      if (attributes.has(attrName)) throw new Reject("duplicate_attribute");
      if (attributes.size + 1 > limits.maxAttributesPerElement) throw new Reject("attribute_limit");
      // A raw `<` is not allowed in a value; the check stays inside the value.
      for (let v = k + 1; v < valueEnd; v++) {
        if (text.charCodeAt(v) === 60) throw new Reject("invalid_attribute");
      }
      const value = decode(text, k + 1, valueEnd, true);
      if (value.trim() === XINCLUDE_NAMESPACE) throw new Reject("external_reference");
      attributes.set(attrName, value);
      j = valueEnd + 1;
    }

    if (selfClosing) {
      const element: XmlElement = { kind: "element", name, attributes, children: [] };
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
    } else {
      stack.push({ name, attributes, children: [] });
    }
    i = j;
  }

  if (stack.length > 0) throw new Reject("unclosed_element");
  if (root === null) throw new Reject("no_root");
  return { declaration, root, elementCount, maxDepth, bytes };
}

/**
 * Reads a payload. Never throws on input; a bad option value (a programming
 * error) throws a `RangeError` with a fixed message.
 */
export function readXml(text: string, options?: XmlReaderOptions): XmlReadResult {
  const limits = resolveLimits(options);
  if (typeof text !== "string") return fail("not_text");
  // UTF-8 never takes fewer bytes than UTF-16 code units, so the length is a cheap first check.
  if (text.length > limits.maxBytes) return fail("too_large");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limits.maxBytes) return fail("too_large");
  try {
    return { ok: true, document: parse(text, limits, bytes) };
  } catch (error) {
    if (error instanceof Reject) return fail(error.code);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export function getAttribute(element: XmlElement, name: string): string | undefined {
  return element.attributes.get(name);
}

/** Direct child elements, optionally only those with `name`. */
export function childElements(element: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (child.kind === "element" && (name === undefined || child.name === name)) out.push(child);
  }
  return out;
}

export function firstChildElement(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (child.kind === "element" && child.name === name) return child;
  }
  return undefined;
}

/** The element's own text: its direct text and CDATA children, joined. Descendants are not included. */
export function textContent(element: XmlElement): string {
  let out = "";
  for (const child of element.children) if (child.kind === "text") out += child.value;
  return out;
}

/**
 * Visits every element in document order, iteratively. `ancestors` runs from
 * the root to the element's parent and is only valid during the call. Return
 * `"skip"` to leave an element's children unvisited.
 */
export function walkElements(
  root: XmlElement,
  visit: (element: XmlElement, ancestors: readonly XmlElement[]) => void | "skip"
): void {
  const ancestors: XmlElement[] = [];
  const pending: Array<{ element: XmlElement; depth: number }> = [{ element: root, depth: 0 }];
  while (pending.length > 0) {
    const { element, depth } = pending.pop() as { element: XmlElement; depth: number };
    ancestors.length = depth;
    if (visit(element, ancestors) === "skip") continue;
    ancestors.push(element);
    for (let k = element.children.length - 1; k >= 0; k--) {
      const child = element.children[k];
      if (child.kind === "element") pending.push({ element: child, depth: depth + 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export interface XmlSerializeOptions {
  /** Emit `<?xml version="1.0" encoding="UTF-8"?>` first. Default false. */
  readonly declaration?: boolean;
  /** Rewrites each text node before it is escaped; `ancestors` ends with `parent`. */
  readonly text?: (value: string, parent: XmlElement, ancestors: readonly XmlElement[]) => string;
  /** Rewrites each attribute value before it is escaped; `ancestors` ends with `element`. */
  readonly attribute?: (
    name: string,
    value: string,
    element: XmlElement,
    ancestors: readonly XmlElement[]
  ) => string;
}

function escapeText(value: string): string {
  return value.replace(/[&<>\r]/gu, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#13;"));
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"\t\n\r]/gu, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "\t":
        return "&#9;";
      case "\n":
        return "&#10;";
      default:
        return "&#13;";
    }
  });
}

/**
 * Writes a tree back out, iteratively. CDATA comes out as escaped text, so
 * nothing in a value can close a section early. The hooks let a caller mask
 * text and attribute values on the way out (the payload view's masking)
 * without copying the tree.
 */
export function serializeXml(root: XmlElement, options?: XmlSerializeOptions): string {
  const out: string[] = [];
  if (options?.declaration) out.push('<?xml version="1.0" encoding="UTF-8"?>');
  const ancestors: XmlElement[] = [];
  const frames: Array<{ element: XmlElement; index: number }> = [];

  const open = (element: XmlElement) => {
    ancestors.push(element);
    out.push("<", element.name);
    for (const [name, value] of element.attributes) {
      const written = options?.attribute ? options.attribute(name, value, element, ancestors) : value;
      out.push(" ", name, '="', escapeAttribute(written), '"');
    }
    if (element.children.length === 0) {
      out.push("/>");
      ancestors.pop();
      return;
    }
    out.push(">");
    frames.push({ element, index: 0 });
  };

  open(root);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.index >= frame.element.children.length) {
      out.push("</", frame.element.name, ">");
      frames.pop();
      ancestors.pop();
      continue;
    }
    const child = frame.element.children[frame.index++];
    if (child.kind === "text") {
      const written = options?.text ? options.text(child.value, frame.element, ancestors) : child.value;
      out.push(escapeText(written));
    } else {
      open(child);
    }
  }
  return out.join("");
}
