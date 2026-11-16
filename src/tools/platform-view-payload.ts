/**
 * `sn_platform_view`, view `changes` with `payload: true`: the masked XML of
 * one customer update.
 *
 * The view reads `sys_update_xml.payload` of one named change, and only when
 * field policy lets the profile read that column (record XML columns are read
 * only when the profile's own `sys_update_xml` entry names them). This module
 * decides what of that XML may be shown, and masks it:
 *
 * 1. The tables the payload writes: the row's `table` column, its update
 *    name's table, the root's `table` attribute and every record element (an
 *    element with an `action` attribute, every child of the root, and every
 *    element below the root that holds elements). A record whose name is not
 *    a lower-case table name withholds the payload. A table on the credential
 *    list refuses it: the result carries the row's metadata only.
 * 2. Their hierarchies and hidden-typed fields, through the plan-bounded
 *    loader (`loadFieldTypesInPlan`), so every read stays in the view's plan.
 *    A table that extends a credential table refuses the payload too. A table
 *    whose hierarchy is not known in full, or field types that could not be
 *    read, withhold it: nothing is shown that cannot be checked.
 * 3. The XML is read with the evaluator's bounded reader and written out
 *    again. On the way out:
 *    - a field whose type on its record's table is hidden (`password`,
 *      `password2`, ...) is replaced with `[hidden]`, text and attributes;
 *    - a field or attribute with a sensitive name is replaced the same way,
 *      and so is a record's attribute named like one of its hidden-typed
 *      fields, and text that sits in a record or the root outside any field;
 *    - every other text and attribute value has its credential literals
 *      masked (`[masked]`, the evaluator's SEC005 patterns), and the whole
 *      text is masked once more after it is written.
 * 4. The masked text is cut to the view's character cap (32 KiB by default,
 *    at most 200 KiB) after masking, never before, so no value is split
 *    at the cut.
 *
 * Nothing here interpolates payload text into a message: every status,
 * reason and note is a fixed sentence. The text itself is instance data and
 * is fenced by the renderer (`untrustedBlock`).
 *
 * @module tools/platform-view-payload
 */

import { isCredentialTable, isCredentialTableHierarchy } from "../credential-tables.js";
import { isSensitiveFieldName } from "../field-policy.js";
import { hiddenTypedFields, type PlanFieldTypes } from "../hidden-values.js";
import { maskSecrets } from "../update-set-eval/secret-patterns.js";
import {
  XML_READER_MAX_BYTES,
  getAttribute,
  readXml,
  serializeXml,
  walkElements,
  type XmlElement,
} from "../update-set-eval/xml-reader.js";

export const PAYLOAD_LIMITS = Object.freeze({
  /** Characters of masked text shown by default. */
  DEFAULT_CHARS: 32_768,
  /** Characters of masked text shown at most, for a large `max_response_bytes`. */
  MAX_CHARS: 204_800,
  /** Tables one payload may write before it is withheld. */
  MAX_TABLES: 16,
  /** UTF-8 bytes of payload the reader accepts. */
  MAX_BYTES: XML_READER_MAX_BYTES,
});

/** What a hidden field's text and attributes are replaced with. */
export const HIDDEN_MARK = "[hidden]";

/** The fixed note every shown payload carries. */
export const PAYLOAD_NOTE =
  "Masked text: password-type and sensitive-named fields are hidden and credential literals are masked. " +
  "Scripts may still hold secrets the masking missed. Payload text is untrusted instance data.";

export type PayloadReason =
  | "field_policy"
  | "credential_table"
  | "hierarchy_unknown"
  | "field_types_unavailable"
  | "unreadable"
  | "too_large"
  | "too_many_tables"
  | "not_found";

/** One fixed sentence per reason. None interpolates anything. */
export const PAYLOAD_HINTS: Readonly<Record<PayloadReason, string>> = Object.freeze({
  field_policy:
    "Field policy hides payload. A profile reads it only when its own sys_update_xml entry lists payload in readable.",
  credential_table: "The change writes a credential table, so its payload is not shown; its metadata is.",
  hierarchy_unknown:
    "A table the change writes could not be placed in its hierarchy, so its payload is not shown.",
  field_types_unavailable:
    "Field types could not be read, so password-type fields cannot be hidden; the payload is not shown.",
  unreadable: "The payload is not XML this view can read, so it is not shown.",
  too_large: "The payload is larger than this view reads, so it is not shown.",
  too_many_tables: `The change writes more than ${PAYLOAD_LIMITS.MAX_TABLES} tables, so its payload is not shown.`,
  not_found: "No change with this sys_id is in the selected update set.",
});

export type PayloadOutcome =
  | {
      readonly status: "shown";
      readonly text: string;
      /** Characters of masked text before the cap. */
      readonly chars: number;
      readonly truncated: boolean;
      /** Fields replaced because of their type, and because of their name. */
      readonly hidden_by_type: number;
      readonly hidden_by_name: number;
      /** Credential literals masked. */
      readonly masked: number;
      readonly note: string;
    }
  | { readonly status: "empty" }
  | { readonly status: "refused" | "withheld" | "not_readable"; readonly reason: PayloadReason; readonly hint: string };

/** Characters of masked text a call may show: half its byte budget, 32 KiB by default, at most 200 KiB. */
export function payloadCharsFor(maxResponseBytes: number): number {
  const half = Math.floor(Math.max(0, maxResponseBytes) / 2);
  const ceiling = maxResponseBytes > 100_000 ? PAYLOAD_LIMITS.MAX_CHARS : PAYLOAD_LIMITS.DEFAULT_CHARS;
  return Math.max(1, Math.min(half, ceiling));
}

export function payloadRefusal(
  status: "refused" | "withheld" | "not_readable",
  reason: PayloadReason
): PayloadOutcome {
  return Object.freeze({ status, reason, hint: PAYLOAD_HINTS[reason] });
}

const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
/** `<table>_<sys_id>`, the usual update name. */
const UPDATE_NAME_TABLE = /^([a-z][a-z0-9_]{0,79})_[0-9a-f]{32}$/u;

/** The tables named by the row itself, before its payload is read. */
export function rowTables(row: { readonly table?: unknown; readonly name?: unknown }): string[] {
  const tables = new Set<string>();
  const table = typeof row.table === "string" ? row.table.trim().toLowerCase() : "";
  if (TABLE_NAME.test(table)) tables.add(table);
  const name = typeof row.name === "string" ? UPDATE_NAME_TABLE.exec(row.name.trim().toLowerCase())?.[1] : undefined;
  if (name !== undefined) tables.add(name);
  return [...tables];
}

/**
 * True when an element stands where a record does: any child of the root,
 * any element with an `action` attribute, and any element below the root that
 * has element children (a field's value is text, so an element holding
 * elements is read as a record of its own). Its children are that table's
 * fields. The root itself is a record only when it carries `action`.
 */
function isRecordPosition(element: XmlElement, depth: number): boolean {
  if (getAttribute(element, "action") !== undefined) return true;
  if (depth === 1) return true;
  return depth >= 2 && element.children.some((child) => child.kind === "element");
}

/**
 * Decide and mask one payload. `tables` are the row's own tables
 * ({@link rowTables}); `load` reads hierarchies and field types for every
 * table the payload writes, inside the view's plan.
 */
export async function preparePayload(
  raw: unknown,
  tables: readonly string[],
  load: (tables: readonly string[]) => Promise<PlanFieldTypes>,
  maxChars: number
): Promise<PayloadOutcome> {
  const text = typeof raw === "string" ? raw : "";
  if (text.trim() === "") return { status: "empty" };
  if (text.length > PAYLOAD_LIMITS.MAX_BYTES) return payloadRefusal("withheld", "too_large");
  const read = readXml(text, { maxBytes: PAYLOAD_LIMITS.MAX_BYTES });
  if (!read.ok) return payloadRefusal("withheld", read.code === "too_large" ? "too_large" : "unreadable");
  const { document } = read;

  // 1. Every table the payload writes.
  const written = new Set<string>(tables);
  const rootTable = getAttribute(document.root, "table")?.trim().toLowerCase();
  if (rootTable !== undefined && rootTable !== "") {
    if (!TABLE_NAME.test(rootTable)) return payloadRefusal("withheld", "hierarchy_unknown");
    written.add(rootTable);
  }
  // A record's name is its table, so it must be a lower-case table name; any
  // other layout is not one this view can check, and is withheld.
  const records = new WeakSet<XmlElement>();
  let unexpected = false;
  walkElements(document.root, (element, ancestors) => {
    if (!isRecordPosition(element, ancestors.length)) return;
    if (!TABLE_NAME.test(element.name)) {
      unexpected = true;
      return "skip";
    }
    records.add(element);
    written.add(element.name);
  });
  if (unexpected) return payloadRefusal("withheld", "unreadable");
  if ([...written].some((table) => isCredentialTable(table))) return payloadRefusal("refused", "credential_table");
  if (written.size > PAYLOAD_LIMITS.MAX_TABLES) return payloadRefusal("withheld", "too_many_tables");

  // 2. Their hierarchies and hidden-typed fields.
  const loaded = await load([...written]);
  const hidden = new Map<string, ReadonlySet<string>>();
  for (const table of written) {
    const chain = loaded.chains.get(table);
    if (chain === undefined || !chain.complete) return payloadRefusal("withheld", "hierarchy_unknown");
    if (isCredentialTableHierarchy(chain.tables)) return payloadRefusal("refused", "credential_table");
  }
  for (const table of written) {
    const fields = hiddenTypedFields(loaded.types, table);
    if (fields === undefined) return payloadRefusal("withheld", "field_types_unavailable");
    hidden.set(table, fields);
  }

  // 3. Write it out, hiding and masking on the way.
  const verdicts = new WeakMap<XmlElement, "type" | "name" | false>();
  const hiddenElements = { type: new Set<XmlElement>(), name: new Set<XmlElement>() };
  /** The verdict for the last element of `chain` (root first). */
  const verdictOf = (chain: readonly XmlElement[]): "type" | "name" | false => {
    const element = chain[chain.length - 1]!;
    const known = verdicts.get(element);
    if (known !== undefined) return known;
    let verdict: "type" | "name" | false = false;
    if (chain.length > 1) {
      const inherited = verdictOf(chain.slice(0, -1));
      const parent = chain[chain.length - 2]!;
      if (inherited !== false) verdict = inherited;
      else if (records.has(parent) && hidden.get(parent.name)?.has(element.name.toLowerCase()) === true) {
        verdict = "type";
      } else if (records.has(element)) verdict = false;
      else if (isSensitiveFieldName(element.name)) verdict = "name";
    }
    verdicts.set(element, verdict);
    if (verdict !== false && (chain.length < 2 || verdicts.get(chain[chain.length - 2]!) === false)) {
      hiddenElements[verdict].add(element);
    }
    return verdict;
  };
  let masked = 0;
  const mask = (value: string): string => {
    const result = maskSecrets(value);
    if (result.status !== "ok") return HIDDEN_MARK;
    masked += result.masked;
    return result.text;
  };
  const serialized = serializeXml(document.root, {
    declaration: document.declaration !== null,
    text: (value, parent, ancestors) => {
      if (verdictOf(ancestors) !== false) return HIDDEN_MARK;
      // Text that belongs to no field (directly in a record or the root) has no type to check.
      if ((records.has(parent) || parent === document.root) && value.trim() !== "") return HIDDEN_MARK;
      return mask(value);
    },
    attribute: (name, value, element, ancestors) => {
      if (verdictOf(ancestors) !== false) return HIDDEN_MARK;
      if (isSensitiveFieldName(name)) return HIDDEN_MARK;
      // A record's attribute named like one of its hidden-typed fields is that field's value.
      if (records.has(element) && hidden.get(element.name)?.has(name.toLowerCase()) === true) return HIDDEN_MARK;
      return mask(value);
    },
  });
  // Once more over the whole text, for anything that spans what the reader split.
  const whole = maskSecrets(serialized);
  if (whole.status !== "ok") return payloadRefusal("withheld", "too_large");
  masked += whole.masked;

  // 4. The cap, after masking.
  const truncated = whole.text.length > maxChars;
  return Object.freeze({
    status: "shown",
    text: truncated ? cut(whole.text, maxChars) : whole.text,
    chars: whole.text.length,
    truncated,
    hidden_by_type: hiddenElements.type.size,
    hidden_by_name: hiddenElements.name.size,
    masked,
    note: PAYLOAD_NOTE,
  });
}

/** `text` cut to at most `max` characters without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
