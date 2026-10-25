/**
 * The policy card: one compact view of what a profile may do.
 *
 * The card is derived from the same resolved policy objects the request path
 * enforces: table access goes through authorizeTableAccess, and field sets
 * come from the field-policy resolver run in the profile's own field-policy
 * scope. Nothing here keeps a second copy of a rule. It reads policy and
 * auth type only, so it cannot print a secret, a key, or a credential
 * reference: the input type has no place to carry one.
 *
 * @module policy-card
 */

import type { AtfExecutionPolicy } from "./atf-policy.js";
import { BATCH_LIMITS } from "./batch-limits.js";
import type { AuthType, GrantType } from "./config.js";
import type { EncodedQueryAccessPolicy } from "./encoded-query-policy.js";
import {
  BUILT_IN_TABLE_CLASSES,
  EXPLICIT_WRITE_FIELD_NAMES,
  describeFieldPolicy,
  runWithFieldPolicyConfiguration,
  type FieldPolicyConfigurationInput,
} from "./field-policy.js";
import { riskyWriteTables } from "./risky-grants.js";
import { authorizeTableAccess, type TableAccessPolicy } from "./table-policy.js";

/** Rows and listed field names are capped so the card stays small. */
const MAX_CARD_TABLES = 100;
const MAX_LISTED_FIELDS = 40;
const MAX_RENDERED_FIELDS = 8;
/** A table name no policy names, standing for "every other table". */
const UNLISTED_PROBE_TABLE = "x_unlisted_probe_table";

export interface PolicyCardInput {
  readonly profile: string;
  readonly instance: string;
  readonly authType: AuthType;
  readonly grantType?: GrantType;
  readonly tableAccess: TableAccessPolicy;
  readonly fieldPolicy?: FieldPolicyConfigurationInput;
  readonly encodedQueryAccess: EncodedQueryAccessPolicy;
  readonly atf: AtfExecutionPolicy;
}

/** Either every field not blocked by name, or an explicit, capped list. */
export type CardFieldSet = "*" | { fields: string[]; more: number };

export interface CardTableRow {
  table: string;
  class: "itsm" | "system" | "other";
  read: boolean;
  write: boolean;
  /** Tools the table's target permits; "any" when only a "*" grant reaches it. */
  tools: string[];
  readable: CardFieldSet;
  writable: CardFieldSet;
  /** class/domain fields this profile lists by name as writable. */
  explicit_writable: string[];
}

export interface PolicyCard {
  profile: string;
  instance: string;
  auth_type: AuthType;
  grant_type?: GrantType;
  read_all_tables: boolean;
  write_all_tables: boolean;
  tables: CardTableRow[];
  tables_more: number;
  /** Set when the card was cut to fit a byte budget; never a silent cut. */
  truncated?: {
    tables_omitted: number;
    field_lists_narrowed: boolean;
    /** The text card was left out because it did not fit; `policy` is complete as shown. */
    text_omitted?: true;
    hint: string;
  };
  /** Fields for tables only a "*" grant reaches; absent when none are. */
  other_tables?: {
    read: boolean;
    write: boolean;
    readable: CardFieldSet;
    writable: CardFieldSet;
    /**
     * The row above describes custom and ITSM tables. A "*" field entry never
     * reaches the system tables, which keep their own access: the ones listed
     * in `fully_writable` and `fully_readable` stay open to every field (bar
     * the sensitive-name blocklist) for that operation, each judged on its
     * own: narrowing only a table's readable fields leaves it fully writable.
     * A list is empty when the profile has no wildcard grant for the operation.
     */
    system_tables: {
      star_field_entry_applies: false;
      fully_readable: string[];
      fully_writable: string[];
      read_narrowed: string[];
      write_narrowed: string[];
    };
  };
  explicit_write_fields: string[];
  risky_write_tables: string[];
  raw_encoded_reads: { allowed: boolean; rules: number };
  atf: { execute: boolean; script_steps: boolean };
  batch: {
    dry_run_by_default: true;
    structured_filter_required: true;
    default_limit: number;
    max_limit: number;
    rest_batch_chunk: number;
    dry_run_sample: number;
  };
  can_read_anything: boolean;
  can_write_anything: boolean;
}

function fieldSet(set: readonly string[] | "*"): CardFieldSet {
  if (set === "*") return "*";
  const fields = [...set].sort();
  return {
    fields: fields.slice(0, MAX_LISTED_FIELDS),
    more: Math.max(0, fields.length - MAX_LISTED_FIELDS),
  };
}

/**
 * How the system tables stand under the current field-policy scope, read and
 * write judged separately so the card never claims narrower access than the
 * enforcing resolver gives.
 */
function systemTableAccess(
  read: boolean,
  write: boolean
): NonNullable<PolicyCard["other_tables"]>["system_tables"] {
  const out = {
    star_field_entry_applies: false as const,
    fully_readable: [] as string[],
    fully_writable: [] as string[],
    read_narrowed: [] as string[],
    write_narrowed: [] as string[],
  };
  for (const table of [...BUILT_IN_TABLE_CLASSES.system].sort()) {
    const fields = describeFieldPolicy(table);
    if (read) (fields.readable === "*" ? out.fully_readable : out.read_narrowed).push(table);
    if (write) (fields.writable === "*" ? out.fully_writable : out.write_narrowed).push(table);
  }
  return out;
}

function classOf(table: string): CardTableRow["class"] {
  if (BUILT_IN_TABLE_CLASSES.system.includes(table)) return "system";
  if (BUILT_IN_TABLE_CLASSES.itsm.includes(table)) return "itsm";
  return "other";
}

/** True when the real table policy lets `tool` perform `operation` on `table`. */
function allowed(
  policy: TableAccessPolicy,
  operation: "read" | "write",
  table: string,
  tool: string
): boolean {
  try {
    authorizeTableAccess(policy, { operation, table }, tool);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bare origin of a configured instance URL. Credentials, path and query
 * are dropped, so a URL written as https://user:pw@host/... cannot leak.
 */
export function safeInstanceOrigin(instance: string): string {
  try {
    const url = new URL(instance);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : "(invalid instance URL)";
  } catch {
    return "(invalid instance URL)";
  }
}

export function buildPolicyCard(input: PolicyCardInput): PolicyCard {
  const policy = input.tableAccess;
  const named = new Set<string>();
  for (const table of [
    ...policy.readTables,
    ...policy.writeTables,
    ...policy.targets.map((target) => target.table),
  ]) {
    if (table !== "*") named.add(table);
  }
  const ordered = [...named].sort();

  const rows: CardTableRow[] = [];
  const writeGranted: string[] = [];
  let anyRead = false;
  let other: PolicyCard["other_tables"];
  runWithFieldPolicyConfiguration(input.fieldPolicy, () => {
    // Read, write and risky-table facts cover every named table; only the
    // rows shown (and their field lists, the costly part) are capped.
    for (const [index, table] of ordered.entries()) {
      const target = policy.targets.find((entry) => entry.table === table);
      const tools = target
        ? [...target.tools].sort()
        : ["sn_query", "sn_update"].filter(
            (tool) => allowed(policy, "read", table, tool) || allowed(policy, "write", table, tool)
          );
      const read = (target ? target.tools : ["sn_query"]).some((tool) =>
        allowed(policy, "read", table, tool)
      );
      const write = (target ? target.tools : ["sn_update"]).some((tool) =>
        allowed(policy, "write", table, tool)
      );
      if (read) anyRead = true;
      if (write) writeGranted.push(table);
      if (index >= MAX_CARD_TABLES) continue;
      const fields = describeFieldPolicy(table);
      rows.push({
        table,
        class: classOf(table),
        read,
        write,
        tools: target ? tools : tools.length > 0 ? ["any"] : [],
        readable: fieldSet(fields.readable),
        writable: fieldSet(fields.writable),
        explicit_writable: [...fields.explicitWritable],
      });
    }
    const otherRead = allowed(policy, "read", UNLISTED_PROBE_TABLE, "sn_query");
    const otherWrite = allowed(policy, "write", UNLISTED_PROBE_TABLE, "sn_update");
    if (otherRead || otherWrite) {
      const fields = describeFieldPolicy(UNLISTED_PROBE_TABLE);
      other = {
        read: otherRead,
        write: otherWrite,
        readable: fieldSet(fields.readable),
        writable: fieldSet(fields.writable),
        system_tables: systemTableAccess(otherRead, otherWrite),
      };
    }
  });

  const writeTables = [...writeGranted, ...(other?.write ? ["*"] : [])];
  return {
    profile: input.profile,
    instance: safeInstanceOrigin(input.instance),
    auth_type: input.authType,
    ...(input.grantType === undefined ? {} : { grant_type: input.grantType }),
    read_all_tables: other?.read === true,
    write_all_tables: other?.write === true,
    tables: rows,
    tables_more: Math.max(0, ordered.length - MAX_CARD_TABLES),
    ...(other === undefined ? {} : { other_tables: other }),
    explicit_write_fields: [...EXPLICIT_WRITE_FIELD_NAMES],
    risky_write_tables: [...riskyWriteTables(writeTables)],
    raw_encoded_reads: {
      allowed: input.encodedQueryAccess.rules.length > 0,
      rules: input.encodedQueryAccess.rules.length,
    },
    atf: { execute: input.atf.execute, script_steps: input.atf.allowScriptSteps },
    batch: {
      dry_run_by_default: true,
      structured_filter_required: true,
      default_limit: BATCH_LIMITS.defaultLimit,
      max_limit: BATCH_LIMITS.maxLimit,
      rest_batch_chunk: BATCH_LIMITS.restBatchChunkSize,
      dry_run_sample: BATCH_LIMITS.dryRunSampleSize,
    },
    can_read_anything: anyRead || other?.read === true,
    can_write_anything: writeTables.length > 0,
  };
}

function renderFields(set: CardFieldSet): string {
  if (set === "*") return "all*";
  if (set.fields.length === 0) return set.more > 0 ? `(${set.more} fields, omitted)` : "none";
  const shown = set.fields.slice(0, MAX_RENDERED_FIELDS).join(",");
  const hidden = set.fields.length - MAX_RENDERED_FIELDS + set.more;
  return hidden > 0 ? `${shown} +${hidden}` : shown;
}

function pad(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length))
  );
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ")
  );
}

/** Plain-text rendering: one table plus the rules that explain it. */
export function renderPolicyCard(card: PolicyCard): string {
  const header = ["TABLE", "READ", "WRITE", "TOOLS", "READABLE FIELDS", "WRITABLE FIELDS"];
  const body: string[][] = card.tables.map((row) => [
    row.table,
    row.read ? "yes" : "no",
    row.write ? "yes" : "no",
    row.tools.length > 0 ? row.tools.join(",") : "-",
    row.read ? renderFields(row.readable) : "-",
    row.write
      ? renderFields(row.writable) +
        (row.explicit_writable.length > 0 ? ` [+${row.explicit_writable.join(",")}]` : "")
      : "-",
  ]);
  if (card.other_tables) {
    body.push([
      "(any other table)",
      card.other_tables.read ? "yes" : "no",
      card.other_tables.write ? "yes" : "no",
      "any",
      card.other_tables.read ? renderFields(card.other_tables.readable) : "-",
      card.other_tables.write ? renderFields(card.other_tables.writable) : "-",
    ]);
  }

  const system = card.other_tables?.system_tables;
  const lines: string[] = [
    `Policy card: ${card.profile} (${card.instance})`,
    `Auth: ${card.auth_type}${card.grant_type ? ` (${card.grant_type})` : ""}; credentials are never shown`,
  ];
  if (!card.can_write_anything) lines.push("This profile cannot write to any table.");
  if (!card.can_read_anything) lines.push("This profile cannot read any table.");
  lines.push("");
  if (body.length > 0) {
    lines.push(...pad([header, ...body]));
    const more = card.truncated?.tables_omitted ?? card.tables_more;
    if (more > 0) lines.push(`... and ${more} more table(s)`);
    if (card.truncated) lines.push(`TRUNCATED: ${card.truncated.hint}`);
  } else {
    lines.push("No tables are granted.");
  }
  if (system && (system.fully_writable.length > 0 || system.fully_readable.length > 0)) {
    lines.push(
      "",
      `NOTE: the "(any other table)" row does not apply to the ${BUILT_IN_TABLE_CLASSES.system.length} system tables.`
    );
    if (system.fully_writable.length > 0) {
      lines.push(
        `  ${system.fully_writable.length} stay fully writable (every field): ${system.fully_writable.join(", ")}`
      );
    }
    if (system.fully_readable.length > 0) {
      lines.push(
        `  ${system.fully_readable.length} stay fully readable (every field): ${system.fully_readable.join(", ")}`
      );
    }
  }
  lines.push(
    "",
    "Fields: all* = every field except sensitive-name fields (password, token, secret,",
    "  key, ...), which are never readable or writable.",
    'A "*" field-policy entry covers ITSM and custom tables, never the 23 system tables;',
    "  a system table is narrowed only by naming it.",
    `Explicit-listing fields (${card.explicit_write_fields.join(", ")}): writable only where`,
    "  a profile lists them by name; a writable wildcard never covers them. A listed one is",
    "  shown in [+...] after the writable fields."
  );
  if (card.risky_write_tables.length > 0) {
    lines.push(
      "",
      `WARNING: write access on privilege-sensitive tables: ${card.risky_write_tables.join(", ")}`
    );
  }
  lines.push(
    "",
    `Raw encoded read queries: ${
      card.raw_encoded_reads.allowed
        ? `allowed by ${card.raw_encoded_reads.rules} rule(s)`
        : "denied (structured filters only)"
    }`,
    `ATF: execute ${card.atf.execute ? "on" : "off"}; script steps ${card.atf.script_steps ? "on" : "off"}`,
    `Batch: dry run by default; structured filter required; default ${card.batch.default_limit}, ` +
      `max ${card.batch.max_limit} records per run; ${card.batch.rest_batch_chunk} per REST batch; ` +
      `dry run previews ${card.batch.dry_run_sample}`
  );
  return `${lines.join("\n")}\n`;
}


/** Byte budgets for the sn_profile response; both sit far below the 100 KB result limit. */
export const POLICY_DATA_BUDGET_BYTES = 40_000;
export const POLICY_TEXT_BUDGET_BYTES = 24_000;
const NARROWED_FIELDS = 6;

function truncationHint(profile: string): string {
  return (
    "Truncated to fit the response budget. For a fuller view run " +
    `\`servicenow-mcp-setup policy show --profile ${profile} --json\`; ` +
    `it lists at most ${MAX_CARD_TABLES} tables and ${MAX_LISTED_FIELDS} field names per list.`
  );
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function narrow(set: CardFieldSet): CardFieldSet {
  if (set === "*" || set.fields.length <= NARROWED_FIELDS) return set;
  return {
    fields: set.fields.slice(0, NARROWED_FIELDS),
    more: set.more + set.fields.length - NARROWED_FIELDS,
  };
}

function emptied(set: CardFieldSet): CardFieldSet {
  return set === "*" ? set : { fields: [], more: set.more + set.fields.length };
}

function hasLongList(card: PolicyCard): boolean {
  return card.tables.some((row) =>
    [row.readable, row.writable].some(
      (set) => set !== "*" && set.fields.length > NARROWED_FIELDS
    )
  );
}

/**
 * Fit a card to a byte budget by data, not by count: first narrow every
 * per-table field list, then drop the lists, then drop table rows. Whatever
 * was cut is recorded in `truncated`; a card within budget is returned as is.
 */
export function budgetPolicyCard(
  card: PolicyCard,
  maxBytes: number = POLICY_DATA_BUDGET_BYTES,
  textOmitted = false
): PolicyCard {
  // The marker is part of the card, so it counts against the budget. A card
  // that gets one only because its text was dropped is measured with it.
  const marked = (rows: PolicyCard["tables"], narrowed: boolean): PolicyCard => ({
    ...card,
    tables: rows,
    truncated: {
      tables_omitted: card.tables.length - rows.length + card.tables_more,
      field_lists_narrowed: narrowed,
      ...(textOmitted ? { text_omitted: true as const } : {}),
      hint: truncationHint(card.profile),
    },
  });
  if (!textOmitted && jsonBytes(card) <= maxBytes) return card;
  if (textOmitted && jsonBytes(marked(card.tables, false)) <= maxBytes) {
    return marked(card.tables, false);
  }
  const narrowedAny = hasLongList(card);
  let rows = card.tables.map((row) => ({
    ...row,
    readable: narrow(row.readable),
    writable: narrow(row.writable),
  }));
  const build = (): PolicyCard => marked(rows, narrowedAny);
  if (jsonBytes(build()) > maxBytes) {
    rows = rows.map((row) => ({
      ...row,
      readable: emptied(row.readable),
      writable: emptied(row.writable),
    }));
  }
  while (rows.length > 0 && jsonBytes(build()) > maxBytes) {
    rows = rows.slice(0, Math.floor(rows.length / 2));
  }
  return build();
}

export interface PolicyCardResponse {
  readonly card: PolicyCard;
  /** Absent when it did not fit whole; `card.truncated.text_omitted` says so. */
  readonly text?: string;
}

/** Budget the data and the text; every cut is marked in `card.truncated`. */
export function fitPolicyCard(full: PolicyCard): PolicyCardResponse {
  const card = budgetPolicyCard(full);
  const text = renderPolicyCard(card);
  if (Buffer.byteLength(text, "utf8") <= POLICY_TEXT_BUDGET_BYTES) return { card, text };
  // Re-budget from the full card with the marker counted, so the data card
  // stays within its budget with the marker included.
  return { card: budgetPolicyCard(full, POLICY_DATA_BUDGET_BYTES, true) };
}

// ── memoization ────────────────────────────────────────────────────

/**
 * A validated profile's policy cannot change while it is loaded: its parts are
 * deep-frozen snapshots, replaced wholesale when the profile is reloaded. The
 * built response is therefore cached on the identity of the three field-policy
 * parts (as the field-policy cache is) plus a content key for the rest, which
 * the dispatcher rebuilds on every call. Parts that are not deep-frozen are
 * never cached, so an entry can never describe content that changed later.
 */
const ABSENT_PART: object = Object.freeze({});
const VERIFIED_FROZEN = new WeakSet<object>();
const MAX_ENTRIES_PER_PARTS = 8;
type Entries = Map<string, PolicyCardResponse>;
const CACHE = new WeakMap<object, WeakMap<object, WeakMap<object, Entries>>>();

function deepFrozen(candidate: unknown, depth: number): boolean {
  if (typeof candidate !== "object" || candidate === null) return true;
  if (VERIFIED_FROZEN.has(candidate)) return true;
  if (depth > 8 || !Object.isFrozen(candidate)) return false;
  if (!Object.values(candidate).every((value) => deepFrozen(value, depth + 1))) return false;
  VERIFIED_FROZEN.add(candidate);
  return true;
}

function contentKey(input: PolicyCardInput): string {
  return JSON.stringify([
    input.profile,
    input.instance,
    input.authType,
    input.grantType ?? null,
    input.tableAccess.readTables,
    input.tableAccess.writeTables,
    input.tableAccess.targets,
    input.encodedQueryAccess.rules.length,
    input.atf.execute,
    input.atf.allowScriptSteps,
  ]);
}

/** The budgeted card and text for sn_profile; built once per loaded profile. */
export function policyCardResponse(input: PolicyCardInput): PolicyCardResponse {
  const parts = [
    input.fieldPolicy?.fieldPolicy,
    input.fieldPolicy?.readableTableFields,
    input.fieldPolicy?.writableTableFields,
  ].map((part) => (part === undefined ? ABSENT_PART : part));
  const cacheable = parts.every(
    (part) => typeof part === "object" && part !== null && deepFrozen(part, 0)
  );
  if (!cacheable) return fitPolicyCard(buildPolicyCard(input));
  const [a, b, c] = parts as [object, object, object];
  let second = CACHE.get(a);
  if (!second) CACHE.set(a, (second = new WeakMap()));
  let third = second.get(b);
  if (!third) second.set(b, (third = new WeakMap()));
  let entries = third.get(c);
  if (!entries) third.set(c, (entries = new Map()));
  const key = contentKey(input);
  const hit = entries.get(key);
  if (hit) return hit;
  const built = fitPolicyCard(buildPolicyCard(input));
  if (entries.size >= MAX_ENTRIES_PER_PARTS) entries.clear();
  entries.set(key, built);
  return built;
}
