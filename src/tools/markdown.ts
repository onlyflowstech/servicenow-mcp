/**
 * Escaping-first markdown builders for tool text renderers.
 *
 * Everything a renderer shows a person passes through here. ServiceNow
 * content -- test names, step output, messages -- is untrusted: a record can
 * carry markdown, HTML, or text written to steer whoever reads it. Plain
 * values are therefore always escaped into inert text, and only fragments
 * issued by this module are composed verbatim. A hand-built look-alike object
 * is never trusted, so instance text has no path to becoming a link, an
 * image, raw HTML, a table break, or an escape from a fenced block.
 *
 * @module tools/markdown
 */

export const MAX_INLINE_LENGTH = 300;
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLUMNS = 12;
export const MAX_LIST_ITEMS = 50;
export const MAX_UNTRUSTED_BLOCK_LENGTH = 2_000;

/** Opaque, frozen markdown issued by this module. */
export interface MarkdownFragment {
  readonly markdown: string;
}

/** Inline content: an issued inline fragment verbatim, anything else escaped. */
export type MarkdownInline =
  | MarkdownFragment
  | string
  | number
  | boolean
  | null
  | undefined;

export type StatusKind = "pass" | "fail" | "warn" | "skip";

type FragmentKind = "inline" | "block";

const ISSUED_FRAGMENTS = new WeakMap<object, FragmentKind>();

const STATUS_BADGES: Readonly<Record<StatusKind, string>> = Object.freeze({
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
  skip: "⏭",
});

const LINE_BREAKS = /\r\n?|[\n\u2028\u2029]/gu;
// C0/C1 controls (tab and newline are handled separately) and bidirectional
// overrides, which can make displayed text read differently from its bytes.
const UNSAFE_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;
// Characters with inline meaning. Escaping brackets and angle brackets
// disables links, images, autolinks, and raw HTML; `|` keeps table cells
// intact; backticks prevent code spans; `&` blocks character references.
const INLINE_SPECIAL = /[\\`*~[\]<>|&]/gu;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const SYS_ID = /^[0-9a-f]{32}$/u;
const ZONED_ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const SERVICENOW_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;

function issue(markdown: string, kind: FragmentKind): MarkdownFragment {
  const fragment = Object.freeze({ markdown });
  ISSUED_FRAGMENTS.set(fragment, kind);
  return fragment;
}

/** True only for fragments this module issued, never for look-alikes. */
export function isMarkdownFragment(value: unknown): value is MarkdownFragment {
  return (
    typeof value === "object" && value !== null && ISSUED_FRAGMENTS.has(value)
  );
}

function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function truncate(text: string, maxLength: number, marker: string): string {
  const limit = Math.max(1, Math.floor(maxLength));
  // Code points are at most two UTF-16 units, so this bounds the split work
  // without cutting inside anything that survives the final slice.
  const characters = Array.from(text.slice(0, (limit + 1) * 2));
  if (characters.length <= limit) return text;
  return characters.slice(0, limit).join("") + marker;
}

function escapeLeadingBlockMarker(text: string): string {
  const ordered = /^(\d{1,9})([.)])/u.exec(text);
  if (ordered) {
    return `${ordered[1]}\\${ordered[2]}${text.slice(ordered[0].length)}`;
  }
  return /^[#>+\-=!]/u.test(text) ? `\\${text}` : text;
}

/** Stop GFM from turning bare URLs, www. hosts, or addresses into links. */
function defuseAutolinks(text: string): string {
  return text
    .replace(/:\/\//gu, "\\://")
    .replace(/\b(www)\./giu, "$1\\.")
    .replace(/@/gu, "\\@");
}

/**
 * Escape any value into single-line inert markdown text, bounded to
 * `maxLength` code points before escaping.
 */
export function escapeInline(
  value: unknown,
  maxLength = MAX_INLINE_LENGTH
): string {
  const flat = plainText(value)
    .replace(LINE_BREAKS, " ")
    .replace(/\t/gu, " ")
    .replace(UNSAFE_CHARACTERS, "");
  return escapeLeadingBlockMarker(
    defuseAutolinks(truncate(flat, maxLength, "…").replace(INLINE_SPECIAL, "\\$&"))
  );
}

function inlineMarkdown(value: MarkdownInline, maxLength = MAX_INLINE_LENGTH): string {
  if (isMarkdownFragment(value)) {
    if (ISSUED_FRAGMENTS.get(value) !== "inline") {
      throw new TypeError("a block markdown fragment cannot be used inline");
    }
    return value.markdown;
  }
  return escapeInline(value, maxLength);
}

function cellMarkdown(value: MarkdownInline, maxLength: number): string {
  return isMarkdownFragment(value)
    ? inlineMarkdown(value)
    : escapeInline(plainText(value).trim(), maxLength);
}

/** Escaped inline text. */
export function text(value: unknown, maxLength = MAX_INLINE_LENGTH): MarkdownFragment {
  return issue(escapeInline(value, maxLength), "inline");
}

/** Concatenate inline parts; plain parts are escaped. */
export function inline(...parts: readonly MarkdownInline[]): MarkdownFragment {
  return issue(parts.map((part) => inlineMarkdown(part)).join(""), "inline");
}

export function badge(kind: StatusKind): MarkdownFragment {
  if (!Object.hasOwn(STATUS_BADGES, kind)) {
    throw new TypeError("unknown status badge");
  }
  return issue(STATUS_BADGES[kind], "inline");
}

export function headline(
  title: MarkdownInline,
  options: { readonly status?: StatusKind; readonly detail?: MarkdownInline } = {}
): MarkdownFragment {
  const prefix = options.status === undefined ? "" : `${badge(options.status).markdown} `;
  const detail =
    options.detail === undefined || options.detail === null || options.detail === ""
      ? ""
      : ` — ${inlineMarkdown(options.detail)}`;
  return issue(`### ${prefix}${inlineMarkdown(title)}${detail}`, "block");
}

/** A GFM table with escaped, bounded cells and a bounded row count. */
export function table(
  columns: readonly MarkdownInline[],
  rows: readonly (readonly MarkdownInline[])[],
  options: { readonly maxRows?: number; readonly maxCellLength?: number } = {}
): MarkdownFragment {
  if (columns.length === 0 || columns.length > MAX_TABLE_COLUMNS) {
    throw new TypeError(`a table needs 1 to ${MAX_TABLE_COLUMNS} columns`);
  }
  if (rows.length === 0) return issue("_No rows._", "block");
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? MAX_TABLE_ROWS));
  const maxCellLength = options.maxCellLength ?? MAX_INLINE_LENGTH;
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  const lines = [
    line(columns.map((column) => cellMarkdown(column, maxCellLength))),
    line(columns.map(() => "---")),
    ...rows
      .slice(0, maxRows)
      .map((row) =>
        line(columns.map((_, index) => cellMarkdown(row[index], maxCellLength)))
      ),
  ];
  const omitted = rows.length - maxRows;
  if (omitted > 0) lines.push("", `_…and ${omitted} more not shown._`);
  return issue(lines.join("\n"), "block");
}

export function bulletList(
  items: readonly MarkdownInline[],
  maxItems = MAX_LIST_ITEMS
): MarkdownFragment {
  if (items.length === 0) return issue("_None._", "block");
  const limit = Math.max(1, Math.floor(maxItems));
  const lines = items
    .slice(0, limit)
    .map((item) => `- ${cellMarkdown(item, MAX_INLINE_LENGTH)}`);
  const omitted = items.length - limit;
  if (omitted > 0) lines.push(`- _…and ${omitted} more not shown._`);
  return issue(lines.join("\n"), "block");
}

/**
 * Untrusted multi-line text in a fenced block. The fence is longer than any
 * backtick run in the content, so no content line can close it.
 */
export function untrustedBlock(
  label: MarkdownInline,
  content: unknown,
  maxLength = MAX_UNTRUSTED_BLOCK_LENGTH
): MarkdownFragment {
  const body =
    truncate(
      plainText(content)
        .replace(LINE_BREAKS, "\n")
        .replace(UNSAFE_CHARACTERS, ""),
      maxLength,
      "…[truncated]"
    ) || "(empty)";
  const longestRun = (body.match(/`+/gu) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return issue(
    `**${inlineMarkdown(label)} (untrusted):**\n${fence}text\n${body}\n${fence}`,
    "block"
  );
}

function httpsOrigin(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return undefined;
  }
  return url.origin;
}

/**
 * Link to one record on the profile's instance. The URL is built only from a
 * validated https origin, a ServiceNow table identifier, and a canonical
 * sys_id; anything else degrades to the escaped label with no link.
 */
export function recordLink(
  instanceOrigin: string,
  tableName: string,
  sysId: string,
  label: MarkdownInline
): MarkdownFragment {
  const origin = httpsOrigin(instanceOrigin);
  const escapedLabel = inlineMarkdown(label);
  if (origin === undefined || !TABLE_NAME.test(tableName) || !SYS_ID.test(sysId)) {
    return issue(escapedLabel, "inline");
  }
  return issue(
    `[${escapedLabel}](${origin}/${tableName}.do?sys_id=${sysId})`,
    "inline"
  );
}

/** Compact duration such as `45s`, `3m12s`, or `1h02m`. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return milliseconds === 0 ? "0s" : "<1s";
  const total = Math.round(milliseconds / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}h${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m${pad(seconds)}s`;
  return `${seconds}s`;
}

/**
 * Format an instant as `YYYY-MM-DD HH:MM:SS UTC`. A zoneless ServiceNow
 * timestamp is already in the instance's zone and is returned unchanged;
 * any other string is not guessed at.
 */
export function formatTimestamp(value: Date | number | string): string {
  if (typeof value === "string") {
    if (SERVICENOW_TIMESTAMP.test(value)) return value;
    if (!ZONED_ISO_TIMESTAMP.test(value)) return "—";
  }
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return "—";
  return `${instant.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Join blocks into the final renderer text. Anything that is not an issued
 * fragment is escaped as a paragraph rather than passed through.
 */
export function renderMarkdown(
  ...blocks: readonly (MarkdownFragment | false | null | undefined)[]
): string {
  return blocks
    .filter((block): block is MarkdownFragment => Boolean(block))
    .map((block) => (isMarkdownFragment(block) ? block.markdown : escapeInline(block)))
    .join("\n\n");
}
