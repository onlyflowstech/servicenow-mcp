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
  /** Fields for tables only a "*" grant reaches; absent when none are. */
  other_tables?: { read: boolean; write: boolean; readable: CardFieldSet; writable: CardFieldSet };
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
  let other: PolicyCard["other_tables"];
  runWithFieldPolicyConfiguration(input.fieldPolicy, () => {
    for (const table of ordered.slice(0, MAX_CARD_TABLES)) {
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
      };
    }
  });

  const writeTables = [
    ...rows.filter((row) => row.write).map((row) => row.table),
    ...(other?.write ? ["*"] : []),
  ];
  return {
    profile: input.profile,
    instance: input.instance,
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
    can_read_anything: rows.some((row) => row.read) || other?.read === true,
    can_write_anything: writeTables.length > 0,
  };
}

function renderFields(set: CardFieldSet): string {
  if (set === "*") return "all*";
  if (set.fields.length === 0) return "none";
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

  const lines: string[] = [
    `Policy card: ${card.profile} (${card.instance})`,
    `Auth: ${card.auth_type}${card.grant_type ? ` (${card.grant_type})` : ""}; credentials are never shown`,
  ];
  if (!card.can_write_anything) lines.push("This profile cannot write to any table.");
  if (!card.can_read_anything) lines.push("This profile cannot read any table.");
  lines.push("");
  if (body.length > 0) {
    lines.push(...pad([header, ...body]));
    if (card.tables_more > 0) lines.push(`... and ${card.tables_more} more table(s)`);
  } else {
    lines.push("No tables are granted.");
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
      `WARNING: write access on role/approval tables: ${card.risky_write_tables.join(", ")}`
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
