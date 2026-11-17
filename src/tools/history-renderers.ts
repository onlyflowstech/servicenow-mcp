/**
 * The readable text of an `sn_history` result.
 *
 * Every value, user name, field name and flow name in a result is instance
 * text. They are rendered only inside one `untrustedBlock`; the trusted parts
 * (the headline, the source table, the paging note) hold only values this
 * server produced: validated table names and sys_ids, fixed statuses and
 * counts.
 *
 * `historyTextRenderer` is registered in `catalog.ts`. The text repeats the
 * page's events beside the structured result, so on a large page it shows
 * the newest events that fit `max_response_bytes`, or none, with a note.
 *
 * @module tools/history-renderers
 */

import { HISTORY_SOURCES } from "./history-contracts.js";
import { bulletList, headline, renderMarkdown, table, text, untrustedBlock, type MarkdownFragment } from "./markdown.js";
import { envelopeTextFits } from "./envelope-text-fit.js";
import type { EnvelopeTextRenderer } from "./result-envelope.js";

/** Room for a full page of events in the fenced block; markdown.ts cuts beyond it. */
const MAX_EVENTS_TEXT = 60_000;
/** The shortest events block tried before the text leaves the events out. */
const MIN_EVENTS_TEXT = 1_000;

export interface HistoryTextOptions {
  /** Characters of event lines to show (default MAX_EVENTS_TEXT), whole lines, newest first; 0 shows none. */
  readonly eventChars?: number;
}
const SYS_ID = /^[0-9a-f]{32}$/u;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One event as a line of the fenced block: time | source | field | by | change. */
function eventLine(event: Record<string, unknown>): string {
  const flow = asRecord(event.flow);
  const flat = (value: unknown): string => (str(value) ?? "").replace(/\s+/gu, " ").trim();
  let change: string;
  if (event.source === "flows") {
    const parts = [flat(flow.name) || "(flow)", flat(flow.state)].filter((part) => part !== "");
    change = parts.join(", ") + (flow.test === true ? " (test run)" : "");
  } else if (event.value_hidden === true) {
    change = "(value hidden)";
  } else if (event.source === "journal") {
    change = flat(event.new);
  } else if (event.old !== undefined || event.new !== undefined) {
    change = `${flat(event.old) || "(empty)"} -> ${flat(event.new) || "(empty)"}`;
  } else {
    change = "";
  }
  if (event.value_truncated === true) change += " (value cut)";
  return [flat(event.time), flat(event.source), flat(event.field) || "-", flat(event.user) || "-", change].join(" | ");
}

/**
 * The text of a `sn_history` result, or undefined for anything else (the
 * dispatcher then keeps its one-line summary).
 */
export function renderHistoryText(data: unknown, options: HistoryTextOptions = {}): string | undefined {
  const record = asRecord(data);
  const target = asRecord(record.record);
  const tableName = str(target.table);
  const sysId = str(target.sys_id);
  if (tableName === undefined || sysId === undefined || !TABLE_NAME.test(tableName) || !SYS_ID.test(sysId)) {
    return undefined;
  }
  const title = `History of ${tableName} ${sysId}`;
  if (record.status !== "ok") {
    return renderMarkdown(
      headline(title, { status: "fail", detail: record.status === "wrong_class" ? "wrong class" : "invalid cursor" }),
      str(record.hint) === undefined ? undefined : text(str(record.hint))
    );
  }
  const events = Array.isArray(record.events) ? record.events.map(asRecord) : [];
  const sources = asRecord(record.sources);
  const omitted = asRecord(record.omitted);
  const blocks: (MarkdownFragment | undefined)[] = [
    headline(title, {
      status: events.length > 0 ? "pass" : "skip",
      detail: `${events.length} event${events.length === 1 ? "" : "s"}`,
    }),
  ];
  const rows: string[][] = [];
  for (const source of HISTORY_SOURCES) {
    const entry = asRecord(sources[source]);
    if (typeof entry.status !== "string") continue;
    rows.push([source, entry.status, String(entry.returned ?? 0), entry.has_more === true ? "yes" : "no"]);
  }
  if (rows.length > 0) blocks.push(table(["Source", "Status", "Returned", "More"], rows));
  const notes: string[] = [];
  if (events.length > 0) {
    const lines = events.map(eventLine);
    // The newest whole lines that fit the room; a line is never cut.
    const room = options.eventChars ?? MAX_EVENTS_TEXT;
    let shown = 0;
    let used = 0;
    while (shown < lines.length && used + lines[shown]!.length + 1 <= room) {
      used += lines[shown]!.length + 1;
      shown += 1;
    }
    if (shown > 0) {
      blocks.push(untrustedBlock("Events (time | source | field | by | change)", lines.slice(0, shown).join("\n"), MAX_EVENTS_TEXT));
    }
    if (shown < lines.length) {
      notes.push(
        `This text shows ${shown === 0 ? "none" : `the newest ${shown}`} of the ${lines.length} events to fit ` +
          "max_response_bytes; the structured result has them all. A lower limit shows every event here."
      );
    }
  }
  const unreadable = typeof omitted.unreadable === "number" ? omitted.unreadable : 0;
  const mismatch = typeof omitted.mismatch === "number" ? omitted.mismatch : 0;
  if (unreadable > 0) notes.push(`${unreadable} entr${unreadable === 1 ? "y" : "ies"} omitted: field not readable under policy.`);
  if (mismatch > 0) notes.push(`${mismatch} entr${mismatch === 1 ? "y" : "ies"} omitted: not about this record.`);
  if (typeof record.hint === "string") notes.push(record.hint);
  if (record.audit_enabled === false) notes.push("Auditing is off for this class, so field changes may be missing.");
  for (const warning of Array.isArray(record.warnings) ? record.warnings : []) {
    if (typeof warning === "string") notes.push(warning);
  }
  notes.push("Business rules and script includes leave no history.");
  if (record.next_cursor !== undefined) notes.push("More history: repeat the call with cursor set to next_cursor.");
  blocks.push(bulletList(notes));
  return renderMarkdown(...blocks);
}

/**
 * The envelope renderer to register for `sn_history`. The full text when it
 * fits beside the result; otherwise the newest events that fit, halving the
 * room each time; otherwise the text without events; otherwise the summary.
 */
export const historyTextRenderer: EnvelopeTextRenderer = (envelope, context) => {
  const full = renderHistoryText(envelope.data);
  if (full === undefined) return context.summary;
  const fits = envelopeTextFits(envelope);
  if (fits(full)) return full;
  for (let chars = MAX_EVENTS_TEXT / 2; chars >= MIN_EVENTS_TEXT; chars = Math.floor(chars / 2)) {
    const cut = renderHistoryText(envelope.data, { eventChars: chars });
    if (cut !== undefined && fits(cut)) return cut;
  }
  const bare = renderHistoryText(envelope.data, { eventChars: 0 });
  return bare !== undefined && fits(bare) ? bare : context.summary;
};
