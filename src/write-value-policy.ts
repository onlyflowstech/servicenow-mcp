/**
 * Bounded, code-owned value policy for generic creates and updates.
 *
 * Which tables and fields may be written is decided entirely by the
 * configured `tableAccess` and field policies -- this module never gates on
 * table or field identity. It only bounds the *values* a write may carry, so
 * a grant the operator issued is the grant that takes effect.
 *
 * - Journal fields (`comments`, `work_notes`) get the journal bounds on every
 *   table. A Table API write to a journal field appends an entry; it cannot
 *   rewrite earlier entries.
 * - On `incident`, the fields with a known type keep typed checks. Every other
 *   incident field gets the generic bounds.
 * - Every other table gets the generic bounds.
 */

import { Buffer } from "node:buffer";

import { validateWritableFields } from "./field-policy.js";
import { incidentJournalContentSchema } from "./incident-journal-policy.js";
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

/**
 * Typed checks for the incident fields whose type is known. This is not an
 * allowlist: an incident field outside the map gets the generic bounds.
 */
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

/** Journal fields share these names on incident and every other task table. */
const JOURNAL_FIELDS: ReadonlySet<string> = new Set(["comments", "work_notes"]);

/** The read shape of a field when display values are requested ("all"). */
const VALUE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "value",
  "display_value",
  "link",
]);

const UNSAFE_SINGLE_LINE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_MULTILINE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_CHOICE_METACHARACTER = /[\^=,]/u;
const LEADING_JAVASCRIPT = /^javascript:/iu;
const STATE_TOKEN = /^-?[0-9]{1,4}$/u;

const ISSUED_WRITE_VALUE_POLICY_ERRORS = new WeakSet<object>();

/**
 * Normalized table and field identifiers are the only values ever placed in a
 * message. A field value never is.
 */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,79}$/u;

export class WriteValuePolicyError extends Error {
  readonly reason: WriteValuePolicyFailureReason;
  readonly table?: string;
  readonly field?: string;

  constructor(
    reason: WriteValuePolicyFailureReason,
    table?: string,
    field?: string
  ) {
    super("Write denied by the bounded value policy");
    this.name = "WriteValuePolicyError";
    this.reason = reason;
    if (typeof table === "string" && SAFE_IDENTIFIER.test(table)) {
      this.table = table;
    }
    if (typeof field === "string" && SAFE_IDENTIFIER.test(field)) {
      this.field = field;
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
 * change the outcome. Only already-normalized table and field identifiers
 * are ever interpolated.
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
        `Write denied by policy: ${subject} rejected a field value` +
        (error.field === undefined
          ? ". "
          : ` for "${error.field}"` +
            (error.table === undefined ? ". " : ` on "${error.table}". `)) +
        `The configured field policy allows the field; the value is outside the ` +
        `bounds this code policy enforces. A value must be a string, a finite ` +
        `number, a boolean, null or "" to clear the field, an array of ` +
        `comma-free scalars, or a {value} object, with no control characters. ` +
        `Journal fields (comments, work_notes) take 1-8000 characters of ` +
        `non-blank text. On incident, reference fields take a 32-character ` +
        `sys_id and choice values cannot contain ^, = or ,.`
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
 * Neither the table nor the field is gated here: whether either may be
 * written is the configured table and field policies' decision, evaluated
 * before this runs. Journal fields get the journal bounds on every table,
 * incident fields with a known type keep their typed checks, and every other
 * field gets the generic bounds.
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

  if (
    table === "incident" &&
    mode === "create" &&
    !Object.hasOwn(approved, "short_description")
  ) {
    throw new WriteValuePolicyError("missing_short_description", table);
  }

  const output: Record<string, string> = {};
  for (const [field, value] of Object.entries(approved)) {
    defineValue(output, field, fieldValue(table, field, value));
  }
  return Object.freeze(output);
}

function fieldValue(table: string, field: string, value: unknown): string {
  if (JOURNAL_FIELDS.has(field)) return journalValue(table, field, value);
  if (table === "incident" && Object.hasOwn(FIELD_KINDS, field)) {
    return canonicalValue(FIELD_KINDS[field]!, field, value);
  }
  return genericValue(table, field, value);
}

/**
 * A journal value is one entry to append. It gets the same bounds as the
 * dedicated incident journal tools, on every table.
 */
function journalValue(table: string, field: string, value: unknown): string {
  const parsed = incidentJournalContentSchema.safeParse(value);
  if (!parsed.success) {
    throw new WriteValuePolicyError("invalid_value", table, field);
  }
  return parsed.data;
}

/**
 * Bounded canonicalization for a field with no typed check. Field
 * *selection* is already the field policy's decision; this only ensures the
 * value has a shape the Table API accepts as a field value and cannot smuggle
 * control characters or an unbounded payload upstream.
 *
 * - `null` and `""` clear the field.
 * - A number must be a safe integer or a finite decimal without an exponent.
 * - An array is a list value (glide_list): its scalar elements are joined
 *   with commas, so no element may itself contain a comma.
 * - A `{value, display_value?, link?}` object, the read shape when display
 *   values are requested, is written as its `value`.
 */
function genericValue(table: string, field: string, value: unknown): string {
  try {
    if (value === null) return "";
    if (Array.isArray(value)) return genericList(value);
    return genericScalar(unwrapValueObject(value));
  } catch {
    throw new WriteValuePolicyError("invalid_value", table, field);
  }
}

function genericScalar(value: unknown): string {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value !== "string") throw new Error("value must be a scalar");
  return boundedGenericText(value);
}

function genericList(values: readonly unknown[]): string {
  const tokens = values.map((element) => {
    if (
      typeof element !== "string" &&
      typeof element !== "number" &&
      typeof element !== "boolean"
    ) {
      throw new Error("list element must be a scalar");
    }
    const token = genericScalar(element);
    if (token.trim().length === 0 || token.includes(",")) {
      throw new Error("list element must be non-blank and comma-free");
    }
    return token;
  });
  return boundedGenericText(tokens.join(","));
}

function canonicalNumber(value: number): string {
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) throw new Error("unsafe integer");
    return String(value);
  }
  if (!Number.isFinite(value)) throw new Error("number must be finite");
  const token = String(value);
  // String() switches to exponent form for very large or very small numbers,
  // and ServiceNow does not read that form as a decimal.
  if (/e/iu.test(token)) throw new Error("number has no plain decimal form");
  return token;
}

function boundedGenericText(value: string): string {
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
}

/**
 * Unwrap `{value, display_value?, link?}` to its `value`. Any other object is
 * rejected, and every member must be a string. Non-objects pass through.
 */
function unwrapValueObject(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (
    !Object.hasOwn(record, "value") ||
    keys.some((key) => !VALUE_OBJECT_KEYS.has(key)) ||
    keys.some((key) => typeof record[key] !== "string")
  ) {
    throw new Error("unsupported object value");
  }
  return record.value;
}

function canonicalValue(kind: FieldKind, field: string, value: unknown): string {
  try {
    // null clears a field, and the {value} read shape writes its value. The
    // kind's own check then decides whether that value is acceptable.
    const candidate = value === null ? "" : unwrapValueObject(value);
    switch (kind) {
      case "short_text":
        // short_description stays required: it can never be cleared.
        return boundedText(candidate, {
          maximumCharacters: INCIDENT_SHORT_DESCRIPTION_MAX_CHARACTERS,
          maximumBytes: INCIDENT_SHORT_DESCRIPTION_MAX_UTF8_BYTES,
          multiline: false,
          trim: true,
          allowEmpty: false,
        });
      case "long_text":
        return boundedText(candidate, {
          maximumCharacters: INCIDENT_LONG_TEXT_MAX_CHARACTERS,
          maximumBytes: INCIDENT_LONG_TEXT_MAX_UTF8_BYTES,
          multiline: true,
          trim: false,
          allowEmpty: true,
        });
      case "reference":
        // "" clears the reference; any other value must be a sys_id.
        return candidate === "" ? "" : normalizeServiceNowSysId(candidate);
      case "impact_urgency":
        return boundedInteger(candidate, 1, 3);
      case "priority":
        return boundedInteger(candidate, 1, 5);
      case "state": {
        const token = primitiveString(candidate);
        if (!STATE_TOKEN.test(token)) throw new Error("invalid state token");
        const numeric = Number(token);
        if (!Number.isSafeInteger(numeric) || numeric < -9_999 || numeric > 9_999) {
          throw new Error("state token is out of range");
        }
        return String(numeric);
      }
      case "choice": {
        const choice = boundedText(candidate, {
          maximumCharacters: INCIDENT_CHOICE_MAX_CHARACTERS,
          maximumBytes: INCIDENT_CHOICE_MAX_UTF8_BYTES,
          multiline: false,
          trim: true,
          allowEmpty: true,
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
    throw new WriteValuePolicyError("invalid_value", "incident", field);
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
    /** Accept exactly "" so the field can be cleared. Whitespace stays blank. */
    allowEmpty: boolean;
  }>
): string {
  if (typeof value !== "string") throw new Error("value must be a string");
  if (options.allowEmpty && value === "") return "";
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
