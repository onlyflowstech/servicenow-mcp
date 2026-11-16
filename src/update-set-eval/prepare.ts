/**
 * Prepares one `sys_update_xml` row for the rules, once.
 *
 * The payload is read once, every script element is tokenized once, and
 * every element's text is scanned for credential literals once; all 32 rules
 * share the result. A payload that is absent, too large or unreadable is
 * marked so, and only metadata rules run on its row: it counts as not
 * scanned, never as clean. A credential-table row keeps only an allowlist of
 * metadata elements and is never scanned for scripts or values.
 */

import { scanSecrets, type SecretMatch } from "./secret-patterns.js";
import { tokenize, type ScriptTokens } from "./script-scan.js";
import type { EvaluateContext, EvaluateUpdate, FindingUpdate } from "./types.js";
import { childElements, getAttribute, readXml, textContent, type XmlElement } from "./xml-reader.js";

/** A table name the engine may put into a message or use as a key. */
const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
/** A payload element name the engine may report as a finding's `field`. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/u;
const SYS_ID = /^[0-9a-f]{32}$/u;
/** `<table>_<sys_id>`, the usual `sys_update_xml.name`. */
const UPDATE_NAME = /^([a-z][a-z0-9_]{0,79})_[0-9a-f]{32}$/u;

/** Row metadata is returned as data, capped so one row cannot bloat a result. */
const METADATA_MAX = 200;

/** Matches kept per element: enough for SEC005 to look past excluded call shapes. */
export const SECRET_MATCHES_PER_FIELD = 64;

export const isTableName = (value: unknown): value is string => typeof value === "string" && TABLE_NAME.test(value);
export const isFieldName = (value: string): boolean => FIELD_NAME.test(value);
export const isSysId = (value: unknown): value is string => typeof value === "string" && SYS_ID.test(value);

export type ScriptSide = "server" | "client";

/**
 * Script elements per table. Any other table: `script` is server code,
 * `client_script` is client code. A Map, because the key is instance text and
 * a plain object would answer `constructor` from its prototype.
 */
const SCRIPT_FIELDS: ReadonlyMap<string, { readonly server?: readonly string[]; readonly client?: readonly string[] }> =
  new Map(Object.entries({
    sys_script: { server: ["script", "condition"] },
    sys_script_include: { server: ["script"] },
    sys_script_client: { client: ["script"] },
    catalog_script_client: { client: ["script"] },
    sys_ui_script: { client: ["script"] },
    sys_ui_policy: { client: ["script_true", "script_false"] },
    sys_ui_page: { server: ["processing_script"], client: ["client_script"] },
    sp_widget: { server: ["script"], client: ["client_script", "link"] },
    sys_ws_operation: { server: ["operation_script"] },
    sys_processor: { server: ["script"] },
    sysauto_script: { server: ["script"] },
    sys_script_fix: { server: ["script"] },
    sysevent_script_action: { server: ["script"] },
    sys_security_acl: { server: ["script"] },
    sys_transform_script: { server: ["script"] },
    sys_transform_map: { server: ["script"] },
    sys_transform_entry: { server: ["source_script"] },
    sys_script_email: { server: ["script"] },
    sysevent_email_action: { server: ["advanced_condition"] },
  }));

/** On a credential-table row, only these elements are kept: metadata, never values. */
const CREDENTIAL_ROW_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([["sys_properties", ["name", "type"]]]);

export interface PreparedRecord {
  /** The element name, when it is a valid table name. */
  readonly table: string | null;
  /** The record's `action` attribute (`INSERT_OR_UPDATE`, `DELETE`, …). */
  readonly action: string | null;
  /** Each child element's own text, first occurrence. */
  readonly fields: ReadonlyMap<string, string>;
  /** Each child element's `display_value` attribute, when it has one. */
  readonly displayValues: ReadonlyMap<string, string>;
}

export interface PreparedScript {
  readonly record: number;
  readonly field: string;
  readonly side: ScriptSide;
  readonly scan: ScriptTokens;
}

export interface PreparedSecrets {
  readonly field: string;
  /** The element's text, for the SEC005 call-shape check; never output. */
  readonly text: string;
  readonly matches: readonly SecretMatch[];
  readonly truncated: boolean;
}

export type PayloadState = "read" | "absent" | "too_large" | "unreadable" | "credential";

export interface PreparedRow {
  readonly update: EvaluateUpdate;
  readonly finding: FindingUpdate;
  /** The record's table: from the payload, then the `table` column, then the update name. */
  readonly table: string | null;
  readonly payload: PayloadState;
  /** UTF-8 bytes of the payload that was read; 0 otherwise. */
  readonly bytes: number;
  /** The records in the payload, the main one first. Empty when the payload was not read. */
  readonly records: readonly PreparedRecord[];
  readonly scripts: readonly PreparedScript[];
  readonly secrets: readonly PreparedSecrets[];
}

function cap(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > METADATA_MAX ? value.slice(0, METADATA_MAX) : value;
}

/** The row metadata a finding carries. Null when the row's ids are not valid sys_ids. */
export function findingUpdate(update: EvaluateUpdate): FindingUpdate | null {
  if (!isSysId(update.sys_id) || !isSysId(update.update_set)) return null;
  return {
    sys_id: update.sys_id,
    name: cap(update.name) ?? "",
    type: cap(update.type),
    target_name: cap(update.target_name),
    update_set: update.update_set,
  };
}

function metadataTable(update: EvaluateUpdate): string | null {
  if (isTableName(update.table)) return update.table;
  const match = typeof update.name === "string" ? UPDATE_NAME.exec(update.name) : null;
  return match ? match[1] : null;
}

/**
 * Reads a record's fields, or returns null when its shape is one the rules
 * could not cover: a field name that repeats (which copy the platform applies
 * is not the reader's call) or a field that holds elements (no rule reads
 * nested content). The row is then not scanned, rather than half scanned.
 */
function readRecord(element: XmlElement, keep: readonly string[] | null): PreparedRecord | null {
  const fields = new Map<string, string>();
  const displayValues = new Map<string, string>();
  const seen = new Set<string>();
  for (const child of childElements(element)) {
    if (seen.has(child.name) || child.children.some((node) => node.kind === "element")) return null;
    seen.add(child.name);
    if (keep !== null && !keep.includes(child.name)) continue;
    fields.set(child.name, textContent(child));
    const display = getAttribute(child, "display_value");
    if (display !== undefined) displayValues.set(child.name, display);
  }
  return {
    table: isTableName(element.name) ? element.name : null,
    action: getAttribute(element, "action") ?? null,
    fields,
    displayValues,
  };
}

function scriptFields(table: string | null, record: PreparedRecord): { field: string; side: ScriptSide }[] {
  const known = table === null ? undefined : SCRIPT_FIELDS.get(table);
  const out: { field: string; side: ScriptSide }[] = [];
  if (known) {
    for (const field of known.server ?? []) out.push({ field, side: "server" });
    for (const field of known.client ?? []) out.push({ field, side: "client" });
  } else if (table === "sys_ui_action") {
    // A UI action's script runs in the browser when `client` is true; its condition runs on the server.
    out.push({ field: "script", side: record.fields.get("client") === "true" ? "client" : "server" });
    out.push({ field: "condition", side: "server" });
  } else {
    out.push({ field: "script", side: "server" }, { field: "client_script", side: "client" });
  }
  return out.filter(({ field }) => (record.fields.get(field) ?? "").trim().length > 0);
}

export interface PrepareOptions {
  readonly maxPayloadBytes: number;
  /** Skip tokenizing scripts (no script rule will run). */
  readonly scripts: boolean;
  /** Skip the secret scan (SEC005 will not run). */
  readonly secrets: boolean;
}

/**
 * Prepares a row. `finding` must come from `findingUpdate` for the same row.
 * Never throws on payload content. `context` must already fail closed (the
 * engine wraps the caller's checks).
 */
export function prepareRow(
  update: EvaluateUpdate,
  finding: FindingUpdate,
  payloadGranted: boolean,
  context: EvaluateContext,
  options: PrepareOptions
): PreparedRow {
  const fallbackTable = metadataTable(update);
  const base = { update, finding, bytes: 0, records: [], scripts: [], secrets: [] };
  const credential = fallbackTable !== null && context.isCredentialTable(fallbackTable);

  if (!payloadGranted || typeof update.payload !== "string" || update.payload.length === 0) {
    return { ...base, table: fallbackTable, payload: credential ? "credential" : "absent" };
  }
  const read = readXml(update.payload, { maxBytes: options.maxPayloadBytes });
  if (!read.ok) {
    return {
      ...base,
      table: fallbackTable,
      payload: credential ? "credential" : read.code === "too_large" ? "too_large" : "unreadable",
    };
  }
  const unreadable = (table: string | null): PreparedRow => ({
    ...base,
    table,
    payload: credential ? "credential" : "unreadable",
    bytes: read.document.bytes,
  });

  // A payload is <record_update table="…"> around its records; any other root is not read.
  const root = read.document.root;
  if (root.name !== "record_update") return unreadable(fallbackTable);
  const elements = childElements(root);
  const rootTable = getAttribute(root, "table");
  const first = elements[0]?.name;
  // A root table that names another table than the record element would send
  // the record to the wrong script fields.
  if (rootTable !== undefined && first !== undefined && rootTable !== first) return unreadable(fallbackTable);
  const table = isTableName(rootTable) ? rootTable : isTableName(first) ? first : fallbackTable;

  // A credential row: the column, the root, or any record element is a credential table.
  const isCredential =
    credential ||
    (table !== null && context.isCredentialTable(table)) ||
    elements.some((element) => isTableName(element.name) && context.isCredentialTable(element.name));
  if (isCredential) {
    const keep = (table !== null ? CREDENTIAL_ROW_FIELDS.get(table) : undefined) ?? [];
    const records = elements.map((element) => readRecord(element, keep));
    return {
      ...base,
      table,
      payload: "credential",
      bytes: read.document.bytes,
      records: records.every((r) => r !== null) ? (records as PreparedRecord[]) : [],
    };
  }

  const parsed = elements.map((element) => readRecord(element, null));
  if (!parsed.every((r) => r !== null)) return unreadable(table);
  const records = parsed as PreparedRecord[];
  const scripts: PreparedScript[] = [];
  if (options.scripts) {
    records.forEach((record, index) => {
      const recordTable = index === 0 ? table : record.table;
      for (const { field, side } of scriptFields(recordTable, record)) {
        scripts.push({ record: index, field, side, scan: tokenize(record.fields.get(field) ?? "") });
      }
    });
  }
  const secrets: PreparedSecrets[] = [];
  if (options.secrets) {
    for (const record of records) {
      for (const [field, text] of record.fields) {
        if (text.length === 0) continue;
        const scan = scanSecrets(text, { maxMatches: SECRET_MATCHES_PER_FIELD + 1 });
        // A field over the scan cap cannot be over the payload cap, which is lower.
        if (scan.status === "ok" && scan.matches.length > 0) {
          secrets.push({ field, text, matches: scan.matches, truncated: scan.truncated });
        }
      }
    }
  }
  return { ...base, table, payload: "read", bytes: read.document.bytes, records, scripts, secrets };
}
