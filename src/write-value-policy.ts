/**
 * Bounded, code-owned value policy for generic creates and updates.
 *
 * Which tables may be written is decided entirely by the configured
 * `tableAccess` and field policies -- this module never gates on table
 * identity. It only bounds the *values* a write may carry, so a grant the
 * operator issued is the grant that takes effect. The `incident` table keeps
 * a strict typed value map because its ordinary fields are a known, closed
 * set; every other table gets generic bounds.
 */

import { Buffer } from "node:buffer";

import { validateWritableFields } from "./field-policy.js";
import { normalizeServiceNowSysId } from "./servicenow-identifiers.js";
import { normalizeTableName } from "./table-policy.js";

export const INCIDENT_SHORT_DESCRIPTION_MAX_CHARACTERS = 160;
export const INCIDENT_SHORT_DESCRIPTION_MAX_UTF8_BYTES = 640;
export const INCIDENT_LONG_TEXT_MAX_CHARACTERS = 4_000;
export const INCIDENT_LONG_TEXT_MAX_UTF8_BYTES = 16_000;
export const INCIDENT_CHOICE_MAX_CHARACTERS = 80;
export const INCIDENT_CHOICE_MAX_UTF8_BYTES = 320;

type WriteMode = "create" | "update";
type FieldKind =
  | "short_text"
  | "long_text"
  | "reference"
  | "impact_urgency"
  | "priority"
  | "state"
  | "choice";

export type WriteValuePolicyFailureReason =
  | "unsupported_table"
  | "invalid_mode"
  | "missing_short_description"
  | "invalid_value";

/**
 * Generic bounds for tables without a typed value map. Large enough for real
 * script and template bodies; small enough that a single field cannot be used
 * to push an unbounded payload upstream.
 */
export const GENERIC_WRITE_VALUE_MAX_CHARACTERS = 100_000;
export const GENERIC_WRITE_VALUE_MAX_UTF8_BYTES = 400_000;

const FIELD_KINDS: Readonly<Record<string, FieldKind>> = Object.freeze({
  short_description: "short_text",
  description: "long_text",
  caller_id: "reference",
  assignment_group: "reference",
  assigned_to: "reference",
  impact: "impact_urgency",
  urgency: "impact_urgency",
  priority: "priority",
  category: "choice",
  subcategory: "choice",
  state: "state",
  close_code: "choice",
  close_notes: "long_text",
  contact_type: "choice",
});

const UNSAFE_SINGLE_LINE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_MULTILINE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_CHOICE_METACHARACTER = /[\^=,]/u;
const LEADING_JAVASCRIPT = /^javascript:/iu;
const STATE_TOKEN = /^-?[0-9]{1,4}$/u;

const ISSUED_WRITE_VALUE_POLICY_ERRORS = new WeakSet<object>();

/** Normalized table identifiers are the only value ever placed in a message. */
const SAFE_TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;

export class WriteValuePolicyError extends Error {
  readonly reason: WriteValuePolicyFailureReason;
  readonly table?: string;

  constructor(reason: WriteValuePolicyFailureReason, table?: string) {
    super("Write denied by the bounded value policy");
    this.name = "WriteValuePolicyError";
    this.reason = reason;
    if (typeof table === "string" && SAFE_TABLE_NAME.test(table)) {
      this.table = table;
    }
    ISSUED_WRITE_VALUE_POLICY_ERRORS.add(this);
    Object.freeze(this);
  }
}

export function isWriteValuePolicyError(
  error: unknown
): error is WriteValuePolicyError {
  return (
    typeof error === "object" &&
    error !== null &&
    ISSUED_WRITE_VALUE_POLICY_ERRORS.has(error)
  );
}

/**
 * Safe fixed guidance per failure reason. A bounded-value denial is not a
 * table-access denial: it is not fixed in tableAccess.writeTables, so
 * reporting it as a table denial points the operator at a key that cannot
 * change the outcome. Only the already-normalized table identifier is ever
 * interpolated.
 */
export function writeValueDenialMessage(
  error: WriteValuePolicyError,
  tool?: string
): string {
  const subject =
    typeof tool === "string" && tool.trim() !== "" ? tool.trim() : "This tool";
  switch (error.reason) {
    case "unsupported_table":
      return (
        `Write denied by policy: ${subject} received a table name that is not a ` +
        `valid ServiceNow identifier. ` +
        (error.table === undefined
          ? "Pass a table name such as \"incident\"."
          : `Table ${JSON.stringify(error.table)} is not usable.`)
      );
    case "missing_short_description":
      return (
        `Write denied by policy: ${subject} requires a non-empty bounded ` +
        `short_description when creating an incident.`
      );
    case "invalid_value":
      return (
        `Write denied by policy: ${subject} rejected a field value. The field is ` +
        `not writable under the configured field policy for this table, or its ` +
        `value is outside the bounds this code policy enforces. On the incident ` +
        `table only the approved ordinary fields are accepted, and journal fields ` +
        `require the dedicated sn_incident_add_comment and sn_incident_add_work_note ` +
        `tools.`
      );
    case "invalid_mode":
      return `Write denied by policy: ${subject} requested an unsupported write mode.`;
    default:
      return `Write denied by policy: ${subject} denied the write by the bounded value policy.`;
  }
}

/**
 * Normalize a caller-supplied table name into the canonical identifier used
 * for both the policy decision and the upstream request path, so the value
 * evaluated is the value used.
 */
export function normalizeWriteTable(candidate: unknown): string {
  try {
    return normalizeTableName(candidate);
  } catch {
    throw new WriteValuePolicyError("unsupported_table");
  }
}

/**
 * Validate keys through the shared field policy, then validate and
 * canonicalize every value.
 *
 * The table itself is never gated here: whether a table may be written is the
 * configured table policy's decision, evaluated by the dispatcher. Incident
 * keeps its typed value map; every other granted table gets generic bounds.
 */
export function prepareWriteFieldValues(
  mode: WriteMode,
  tableCandidate: unknown,
  fieldsCandidate: unknown
): Readonly<Record<string, string>> {
  if (mode !== "create" && mode !== "update") {
    throw new WriteValuePolicyError("invalid_mode");
  }
  const table = normalizeWriteTable(tableCandidate);
  const approved = validateWritableFields(table, fieldsCandidate);

  if (table !== "incident") {
    const generic: Record<string, string> = {};
    for (const [field, value] of Object.entries(approved)) {
      defineValue(generic, field, genericValue(value));
    }
    return Object.freeze(generic);
  }

  if (mode === "create" && !Object.hasOwn(approved, "short_description")) {
    throw new WriteValuePolicyError("missing_short_description", table);
  }

  const output: Record<string, string> = {};
  for (const [field, value] of Object.entries(approved)) {
    if (!Object.hasOwn(FIELD_KINDS, field)) {
      throw new WriteValuePolicyError("invalid_value", table);
    }
    defineValue(output, field, canonicalValue(FIELD_KINDS[field]!, value));
  }
  return Object.freeze(output);
}

/**
 * Bounded canonicalization for a table with no typed value map. Field
 * *selection* is already the field policy's decision; this only ensures the
 * value is a plain bounded scalar that cannot smuggle control characters or
 * an unbounded payload upstream. An empty string is allowed so a granted
 * field can be cleared.
 */
function genericValue(value: unknown): string {
  try {
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error("invalid numeric primitive");
      return String(value);
    }
    if (typeof value !== "string") throw new Error("value must be a scalar");
    if (!isWellFormedUnicode(value)) throw new Error("value is not Unicode");
    if (UNSAFE_MULTILINE.test(value)) {
      throw new Error("value contains an unsafe control character");
    }
    if ([...value].length > GENERIC_WRITE_VALUE_MAX_CHARACTERS) {
      throw new Error("value exceeds the character limit");
    }
    if (Buffer.byteLength(value, "utf8") > GENERIC_WRITE_VALUE_MAX_UTF8_BYTES) {
      throw new Error("value exceeds the byte limit");
    }
    return value;
  } catch {
    throw new WriteValuePolicyError("invalid_value");
  }
}

function canonicalValue(kind: FieldKind, value: unknown): string {
  try {
    switch (kind) {
      case "short_text":
        return boundedText(value, {
          maximumCharacters: INCIDENT_SHORT_DESCRIPTION_MAX_CHARACTERS,
          maximumBytes: INCIDENT_SHORT_DESCRIPTION_MAX_UTF8_BYTES,
          multiline: false,
          trim: true,
        });
      case "long_text":
        return boundedText(value, {
          maximumCharacters: INCIDENT_LONG_TEXT_MAX_CHARACTERS,
          maximumBytes: INCIDENT_LONG_TEXT_MAX_UTF8_BYTES,
          multiline: true,
          trim: false,
        });
      case "reference":
        return normalizeServiceNowSysId(value);
      case "impact_urgency":
        return boundedInteger(value, 1, 3);
      case "priority":
        return boundedInteger(value, 1, 5);
      case "state": {
        const token = primitiveString(value);
        if (!STATE_TOKEN.test(token)) throw new Error("invalid state token");
        const numeric = Number(token);
        if (!Number.isSafeInteger(numeric) || numeric < -9_999 || numeric > 9_999) {
          throw new Error("state token is out of range");
        }
        return String(numeric);
      }
      case "choice": {
        const choice = boundedText(value, {
          maximumCharacters: INCIDENT_CHOICE_MAX_CHARACTERS,
          maximumBytes: INCIDENT_CHOICE_MAX_UTF8_BYTES,
          multiline: false,
          trim: true,
        });
        if (
          UNSAFE_CHOICE_METACHARACTER.test(choice) ||
          LEADING_JAVASCRIPT.test(choice)
        ) {
          throw new Error("unsafe choice token");
        }
        return choice;
      }
    }
  } catch {
    throw new WriteValuePolicyError("invalid_value", "incident");
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): string {
  const token = primitiveString(value);
  if (!/^[0-9]{1,3}$/u.test(token)) {
    throw new Error("invalid integer token");
  }
  const numeric = Number(token);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error("integer token is out of range");
  }
  return String(numeric);
}

function primitiveString(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("invalid numeric primitive");
    return String(value);
  }
  if (typeof value !== "string") throw new Error("value must be a string or integer");
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("value must not be blank");
  return trimmed;
}

function boundedText(
  value: unknown,
  options: Readonly<{
    maximumCharacters: number;
    maximumBytes: number;
    multiline: boolean;
    trim: boolean;
  }>
): string {
  if (typeof value !== "string") throw new Error("value must be a string");
  const canonical = options.trim ? value.trim() : value;
  if (canonical.trim().length === 0) throw new Error("value must not be blank");
  if (!isWellFormedUnicode(canonical)) throw new Error("value is not Unicode");
  if ((options.multiline ? UNSAFE_MULTILINE : UNSAFE_SINGLE_LINE).test(canonical)) {
    throw new Error("value contains an unsafe control character");
  }
  if ([...canonical].length > options.maximumCharacters) {
    throw new Error("value exceeds the character limit");
  }
  if (Buffer.byteLength(canonical, "utf8") > options.maximumBytes) {
    throw new Error("value exceeds the byte limit");
  }
  return canonical;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function defineValue(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}
