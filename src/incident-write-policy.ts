/** Bounded, code-owned value policy for ordinary incident creates and updates. */

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

type IncidentWriteMode = "create" | "update";
type FieldKind =
  | "short_text"
  | "long_text"
  | "reference"
  | "impact_urgency"
  | "priority"
  | "state"
  | "choice";

export type IncidentWritePolicyFailureReason =
  | "unsupported_table"
  | "invalid_mode"
  | "missing_short_description"
  | "invalid_value";

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

export class IncidentWritePolicyError extends Error {
  constructor(readonly reason: IncidentWritePolicyFailureReason) {
    super("Incident write denied by policy");
    this.name = "IncidentWritePolicyError";
    Object.freeze(this);
  }
}

/**
 * Validate keys through the shared field policy, then validate and canonicalize
 * every ordinary incident value. No runtime configuration can extend this map.
 */
export function prepareIncidentWriteFields(
  mode: IncidentWriteMode,
  tableCandidate: unknown,
  fieldsCandidate: unknown
): Readonly<Record<string, string>> {
  if (mode !== "create" && mode !== "update") {
    throw new IncidentWritePolicyError("invalid_mode");
  }
  let table: string;
  try {
    table = normalizeTableName(tableCandidate);
  } catch {
    throw new IncidentWritePolicyError("unsupported_table");
  }
  if (table !== "incident") {
    throw new IncidentWritePolicyError("unsupported_table");
  }

  const approved = validateWritableFields(table, fieldsCandidate);
  if (mode === "create" && !Object.hasOwn(approved, "short_description")) {
    throw new IncidentWritePolicyError("missing_short_description");
  }

  const output: Record<string, string> = {};
  for (const [field, value] of Object.entries(approved)) {
    if (!Object.hasOwn(FIELD_KINDS, field)) {
      throw new IncidentWritePolicyError("invalid_value");
    }
    defineValue(output, field, canonicalValue(FIELD_KINDS[field]!, value));
  }
  return Object.freeze(output);
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
    throw new IncidentWritePolicyError("invalid_value");
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
