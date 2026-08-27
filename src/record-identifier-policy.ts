/** Least-privilege policy for human-readable single-record identifiers. */

import { Buffer } from "node:buffer";
import { types as nodeUtilTypes } from "node:util";

import { z } from "zod";

import { resolveReadableFields } from "./field-policy.js";
import { normalizeServiceNowSysId } from "./servicenow-identifiers.js";
import { normalizeTableName } from "./table-policy.js";

const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const FORBIDDEN_VALUE_CODE_POINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const LEADING_JAVASCRIPT = /^\s*javascript:/iu;

export const MAX_RECORD_IDENTIFIER_VALUE_BYTES = 512;
export const MAX_RECORD_IDENTIFIER_VALUE_CHARS = 256;

/**
 * Code-owned allowlist. Adding a pair is a security-policy change and requires
 * the field to remain readable under the shared field policy.
 */
const IDENTIFIER_POLICY_DEFINITION = Object.freeze({
  incident: Object.freeze(["number"]),
  change_request: Object.freeze(["number"]),
  problem: Object.freeze(["number"]),
  sc_request: Object.freeze(["number"]),
  sc_req_item: Object.freeze(["number"]),
  sc_task: Object.freeze(["number"]),
  task: Object.freeze(["number"]),
  kb_knowledge: Object.freeze(["number"]),
  sys_user: Object.freeze(["user_name"]),
  sys_user_group: Object.freeze(["name"]),
  cmdb_ci: Object.freeze(["name"]),
  cmdb_ci_server: Object.freeze(["name", "host_name"]),
  cmdb_ci_computer: Object.freeze(["name", "host_name", "serial_number"]),
} as const);

export const recordIdentifierSchema = z
  .object({
    field: z
      .string()
      .trim()
      .toLowerCase()
      .regex(FIELD_NAME, "identifier field must be canonical"),
    value: z
      .string()
      .trim()
      .min(1, "identifier value must not be empty")
      .max(MAX_RECORD_IDENTIFIER_VALUE_CHARS)
      .refine(isWellFormedUnicode, "identifier value must be well-formed Unicode")
      .refine(
        (value) => !FORBIDDEN_VALUE_CODE_POINT.test(value),
        "identifier value contains forbidden characters"
      )
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_RECORD_IDENTIFIER_VALUE_BYTES,
        "identifier value exceeds the byte limit"
      )
      .refine(
        (value) => !value.includes("^") && !LEADING_JAVASCRIPT.test(value),
        "identifier value is not safe for exact lookup"
      ),
  })
  .strict();

export type RecordIdentifierInput = z.output<typeof recordIdentifierSchema>;

export type RecordLookupSelector =
  | Readonly<{ kind: "sys_id"; sysId: string }>
  | Readonly<{
      kind: "identifier";
      field: string;
      value: string;
    }>;

export type RecordIdentifierPolicyFailureReason =
  | "invalid_selector"
  | "unsupported_table"
  | "unauthorized_field"
  | "invalid_value";

export class RecordIdentifierPolicyError extends Error {
  constructor(readonly reason: RecordIdentifierPolicyFailureReason) {
    super("Record identifier denied by policy");
    this.name = "RecordIdentifierPolicyError";
    Object.freeze(this);
  }
}

/** Return the immutable configured table/field pairs for tests and docs. */
export function configuredRecordIdentifierFields(
  tableCandidate: unknown
): readonly string[] {
  let table: string;
  try {
    table = normalizeTableName(tableCandidate);
  } catch {
    throw new RecordIdentifierPolicyError("unsupported_table");
  }
  if (!Object.hasOwn(IDENTIFIER_POLICY_DEFINITION, table)) {
    throw new RecordIdentifierPolicyError("unsupported_table");
  }
  const fields = Reflect.get(
    IDENTIFIER_POLICY_DEFINITION,
    table
  ) as readonly string[];
  return fields;
}

/**
 * Canonicalize exactly one selector and authorize a human-readable pair.
 * This function never performs ServiceNow or credential work.
 */
export function resolveRecordLookupSelector(
  tableCandidate: unknown,
  selectorCandidate: Readonly<{
    readonly sys_id?: unknown;
    readonly identifier?: unknown;
  }>
): RecordLookupSelector {
  const table = canonicalTable(tableCandidate);
  const selector = plainSelector(selectorCandidate);
  const hasSysId = selector.sys_id !== undefined;
  const hasIdentifier = selector.identifier !== undefined;
  if (hasSysId === hasIdentifier) {
    throw new RecordIdentifierPolicyError("invalid_selector");
  }
  if (hasSysId) {
    try {
      return Object.freeze({
        kind: "sys_id",
        sysId: normalizeServiceNowSysId(selector.sys_id),
      });
    } catch {
      throw new RecordIdentifierPolicyError("invalid_selector");
    }
  }

  const identifier = parsedIdentifier(selector.identifier);
  const configured = configuredRecordIdentifierFields(table);
  if (!configured.includes(identifier.field)) {
    throw new RecordIdentifierPolicyError("unauthorized_field");
  }
  try {
    const readable = resolveReadableFields(table, { fields: identifier.field });
    if (readable.length !== 1 || readable[0] !== identifier.field) {
      throw new Error("identifier field is not readable");
    }
  } catch {
    throw new RecordIdentifierPolicyError("unauthorized_field");
  }
  return Object.freeze({
    kind: "identifier",
    field: identifier.field,
    value: identifier.value,
  });
}

function canonicalTable(candidate: unknown): string {
  try {
    return normalizeTableName(candidate);
  } catch {
    throw new RecordIdentifierPolicyError("unsupported_table");
  }
}

function plainSelector(candidate: unknown): Readonly<{
  readonly sys_id?: unknown;
  readonly identifier?: unknown;
}> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate) ||
    Array.isArray(candidate)
  ) {
    throw new RecordIdentifierPolicyError("invalid_selector");
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RecordIdentifierPolicyError("invalid_selector");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !["sys_id", "identifier"].includes(key)) {
      throw new RecordIdentifierPolicyError("invalid_selector");
    }
    if (!("value" in descriptors[key]!)) {
      throw new RecordIdentifierPolicyError("invalid_selector");
    }
  }
  return Object.freeze({
    ...(descriptors.sys_id && "value" in descriptors.sys_id
      ? { sys_id: descriptors.sys_id.value }
      : {}),
    ...(descriptors.identifier && "value" in descriptors.identifier
      ? { identifier: descriptors.identifier.value }
      : {}),
  });
}

function parsedIdentifier(candidate: unknown): RecordIdentifierInput {
  try {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      nodeUtilTypes.isProxy(candidate) ||
      Array.isArray(candidate)
    ) {
      throw new Error("identifier must be a plain object");
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("identifier must be a plain object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    if (
      Reflect.ownKeys(descriptors).length !== 2 ||
      !("value" in (descriptors.field ?? {})) ||
      !("value" in (descriptors.value ?? {}))
    ) {
      throw new Error("identifier must contain field and value data properties");
    }
    const snapshot = Object.freeze({
      field: descriptors.field.value,
      value: descriptors.value.value,
    });
    return Object.freeze(recordIdentifierSchema.parse(snapshot));
  } catch {
    throw new RecordIdentifierPolicyError("invalid_value");
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
