/**
 * Default-deny policy and bounded parser for legacy raw encoded reads.
 *
 * Raw encoded queries are never a write selector. The only compatibility
 * surface is an explicitly issued policy rule for `sn_query` and one table;
 * every accepted query is parsed against finite field/operator/complexity and
 * response bounds before any ServiceNow client can be reached.
 *
 * @module encoded-query-policy
 */

import { Buffer } from "node:buffer";
import { types as nodeUtilTypes } from "node:util";

import { resolveReadableFields } from "./field-policy.js";
import { normalizeTableName } from "./table-policy.js";

export const MAX_ENCODED_QUERY_POLICY_RULES = 16;
export const MAX_ENCODED_QUERY_POLICY_FIELDS = 32;
export const MAX_ENCODED_QUERY_LENGTH = 8_192;
export const MAX_ENCODED_QUERY_TERMS = 32;
export const MAX_ENCODED_QUERY_SET_VALUES = 20;
export const MAX_ENCODED_QUERY_OFFSET = 1_000_000;
export const ENCODED_QUERY_POLICY_ENV = "SN_ENCODED_QUERY_READ_POLICY";

export const ENCODED_QUERY_MIGRATION_MESSAGE =
  "Raw encoded query denied by policy. Use structured_query with policy-authorized filters.";

export const SUPPORTED_ENCODED_QUERY_OPERATORS = Object.freeze([
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "IN",
  "NOT IN",
  "BETWEEN",
  "LIKE",
  "NOT LIKE",
  "STARTSWITH",
  "ENDSWITH",
  "ISEMPTY",
  "ISNOTEMPTY",
] as const);

export type EncodedQueryOperator =
  (typeof SUPPORTED_ENCODED_QUERY_OPERATORS)[number];

export interface EncodedQueryReadRuleInput {
  readonly tool: "sn_query";
  readonly table: string;
  readonly maxLength: number;
  /** Complexity budget: conditions plus additional IN/BETWEEN values. */
  readonly maxTerms: number;
  readonly fields: readonly string[];
  readonly operators: readonly EncodedQueryOperator[];
  readonly maxLimit: number;
  readonly maxOffset: number;
  readonly maxResponseBytes: number;
}

export interface EncodedQueryAccessPolicyInput {
  readonly rules?: readonly EncodedQueryReadRuleInput[];
}

export interface EncodedQueryReadRule extends EncodedQueryReadRuleInput {
  readonly fields: readonly string[];
  readonly operators: readonly EncodedQueryOperator[];
}

export interface EncodedQueryAccessPolicy {
  readonly rules: readonly EncodedQueryReadRule[];
}

export type EncodedQueryPolicyFailureReason =
  | "encoded_write_prohibited"
  | "read_not_approved"
  | "invalid_query"
  | "query_limit_exceeded";

const ISSUED_ENCODED_QUERY_POLICY_ERRORS = new WeakSet<object>();

export class EncodedQueryPolicyError extends Error {
  constructor(readonly reason: EncodedQueryPolicyFailureReason) {
    super(ENCODED_QUERY_MIGRATION_MESSAGE);
    this.name = "EncodedQueryPolicyError";
    ISSUED_ENCODED_QUERY_POLICY_ERRORS.add(this);
    Object.freeze(this);
  }
}

export interface RawEncodedReadRequest {
  readonly tool: string;
  readonly table: string;
  readonly query: unknown;
  readonly limit: unknown;
  readonly offset: unknown;
  readonly maxResponseBytes: unknown;
  readonly orderBy?: unknown;
  /** Exact post-field-policy output projection for request and response use. */
  readonly outputFields: unknown;
}

export interface AuthorizedRawEncodedReadPlan {
  readonly query: string;
  readonly outputFields: readonly string[];
}

const ISSUED_ENCODED_QUERY_POLICIES = new WeakSet<object>();
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const FORBIDDEN_UNICODE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const OPERATOR_PATTERN =
  /^(?<field>[a-z][a-z0-9_]{0,79})(?<operator>ISNOTEMPTY|ISEMPTY|STARTSWITH|ENDSWITH|NOT LIKE|NOT IN|BETWEEN|>=|<=|!=|LIKE|IN|=|>|<)(?<value>.*)$/u;
const LOGICAL_OR_CONTROL_PREFIX = /^(?:OR|NQ|ORDERBY|GROUPBY|EQ)/u;
const JAVASCRIPT_VALUE = /javascript\s*:/iu;
const PERCENT_ENCODING = /%/u;
const MAX_POLICY_ENVIRONMENT_BYTES = 32_768;

/** Build a validated immutable policy. Omission is an issued deny-all policy. */
export function createEncodedQueryAccessPolicy(
  input: EncodedQueryAccessPolicyInput = {}
): EncodedQueryAccessPolicy {
  try {
    const policyObject = plainObject(input, ["rules"]);
    const rulesCandidate = dataValue(policyObject, "rules") ?? [];
    const ruleValues = plainArray(
      rulesCandidate,
      MAX_ENCODED_QUERY_POLICY_RULES,
      "encoded-query rules"
    );
    const seen = new Set<string>();
    const rules = ruleValues.map((candidate) => {
      const rule = normalizeRule(candidate);
      const key = `${rule.tool}:${rule.table}`;
      if (seen.has(key)) {
        throw new TypeError("encoded-query policy has duplicate rules");
      }
      seen.add(key);
      return rule;
    });
    const policy = Object.freeze({ rules: Object.freeze(rules) });
    ISSUED_ENCODED_QUERY_POLICIES.add(policy);
    return policy;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("encoded-query policy is invalid");
  }
}

/** Load the explicit JSON policy from environment; absence remains deny-all. */
export function encodedQueryAccessPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): EncodedQueryAccessPolicy {
  const raw = environment[ENCODED_QUERY_POLICY_ENV];
  if (raw === undefined) return createEncodedQueryAccessPolicy();
  if (
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > MAX_POLICY_ENVIRONMENT_BYTES
  ) {
    throw new TypeError("encoded-query policy environment value is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("encoded-query policy environment value is invalid");
  }
  return createEncodedQueryAccessPolicy(parsed as EncodedQueryAccessPolicyInput);
}

/** Validate one raw read and return its byte-identical approved query. */
export function authorizeRawEncodedRead(
  policy: unknown,
  request: RawEncodedReadRequest
): AuthorizedRawEncodedReadPlan {
  try {
    if (!isIssuedPolicy(policy)) {
      throw new EncodedQueryPolicyError("read_not_approved");
    }
    const tool = request.tool;
    const table = normalizeTableName(request.table);
    if (tool !== "sn_query") {
      throw new EncodedQueryPolicyError("read_not_approved");
    }
    const rule = policy.rules.find(
      (candidate) => candidate.tool === tool && candidate.table === table
    );
    if (!rule) throw new EncodedQueryPolicyError("read_not_approved");
    enforceResultBounds(rule, request);
    validateOrderBy(rule, request.orderBy);
    const outputFields = validateOutputFields(rule, request.outputFields);
    const query = parseEncodedQuery(request.query, rule);
    return Object.freeze({ query, outputFields });
  } catch (error) {
    if (error instanceof EncodedQueryPolicyError) throw error;
    throw new EncodedQueryPolicyError("invalid_query");
  }
}

/** Deterministically reject raw input on every write path. */
export function rejectRawEncodedWrite(query: unknown): void {
  if (query !== undefined) {
    throw new EncodedQueryPolicyError("encoded_write_prohibited");
  }
}

export function isEncodedQueryPolicyError(
  error: unknown
): error is EncodedQueryPolicyError {
  return (
    (typeof error === "object" || typeof error === "function") &&
    error !== null &&
    ISSUED_ENCODED_QUERY_POLICY_ERRORS.has(error)
  );
}

function normalizeRule(candidate: unknown): EncodedQueryReadRule {
  const rule = plainObject(candidate, [
    "tool",
    "table",
    "maxLength",
    "maxTerms",
    "fields",
    "operators",
    "maxLimit",
    "maxOffset",
    "maxResponseBytes",
  ]);
  const tool = dataValue(rule, "tool");
  if (tool !== "sn_query") {
    throw new TypeError("encoded-query policy tool is not approved");
  }
  const table = normalizeTableName(dataValue(rule, "table"));
  const maxLength = boundedInteger(
    dataValue(rule, "maxLength"),
    1,
    MAX_ENCODED_QUERY_LENGTH
  );
  const maxTerms = boundedInteger(
    dataValue(rule, "maxTerms"),
    1,
    MAX_ENCODED_QUERY_TERMS
  );
  const fields = uniqueStrings(
    dataValue(rule, "fields"),
    MAX_ENCODED_QUERY_POLICY_FIELDS,
    (field) => FIELD_NAME.test(field)
  );
  const readableFields = resolveReadableFields(table, { fields: fields.join(",") });
  const operators = uniqueStrings(
    dataValue(rule, "operators"),
    SUPPORTED_ENCODED_QUERY_OPERATORS.length,
    (operator): operator is EncodedQueryOperator =>
      SUPPORTED_ENCODED_QUERY_OPERATORS.includes(
        operator as EncodedQueryOperator
      )
  ) as readonly EncodedQueryOperator[];
  const maxLimit = boundedInteger(dataValue(rule, "maxLimit"), 1, 1_000);
  const maxOffset = boundedInteger(
    dataValue(rule, "maxOffset"),
    0,
    MAX_ENCODED_QUERY_OFFSET
  );
  const maxResponseBytes = boundedInteger(
    dataValue(rule, "maxResponseBytes"),
    1_000,
    1_000_000
  );
  return Object.freeze({
    tool,
    table,
    maxLength,
    maxTerms,
    fields: Object.freeze([...readableFields]),
    operators: Object.freeze([...operators]),
    maxLimit,
    maxOffset,
    maxResponseBytes,
  });
}

function enforceResultBounds(
  rule: EncodedQueryReadRule,
  request: RawEncodedReadRequest
): void {
  const limit = boundedInteger(request.limit, 1, 1_000);
  const offset = boundedInteger(request.offset, 0, MAX_ENCODED_QUERY_OFFSET);
  const maxResponseBytes = boundedInteger(
    request.maxResponseBytes,
    1_000,
    1_000_000
  );
  if (
    limit > rule.maxLimit ||
    offset > rule.maxOffset ||
    maxResponseBytes > rule.maxResponseBytes
  ) {
    throw new EncodedQueryPolicyError("query_limit_exceeded");
  }
}

function validateOrderBy(
  rule: EncodedQueryReadRule,
  orderByCandidate: unknown
): void {
  if (orderByCandidate === undefined) return;
  if (typeof orderByCandidate !== "string" || orderByCandidate.length === 0) {
    throw new EncodedQueryPolicyError("invalid_query");
  }
  const field = orderByCandidate.startsWith("-")
    ? orderByCandidate.slice(1)
    : orderByCandidate;
  if (!FIELD_NAME.test(field) || !rule.fields.includes(field)) {
    throw new EncodedQueryPolicyError("invalid_query");
  }
}

function validateOutputFields(
  rule: EncodedQueryReadRule,
  fieldsCandidate: unknown
): readonly string[] {
  const candidates = plainArray(
    fieldsCandidate,
    MAX_ENCODED_QUERY_POLICY_FIELDS,
    "encoded-query output fields"
  );
  if (candidates.length === 0) {
    throw new EncodedQueryPolicyError("read_not_approved");
  }
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      throw new EncodedQueryPolicyError("invalid_query");
    }
    const field = candidate.trim().toLowerCase();
    if (
      !FIELD_NAME.test(field) ||
      seen.has(field) ||
      !rule.fields.includes(field)
    ) {
      throw new EncodedQueryPolicyError("read_not_approved");
    }
    seen.add(field);
    fields.push(field);
  }
  return Object.freeze(fields);
}

function parseEncodedQuery(queryCandidate: unknown, rule: EncodedQueryReadRule): string {
  if (
    typeof queryCandidate !== "string" ||
    queryCandidate.length === 0 ||
    queryCandidate !== queryCandidate.trim()
  ) {
    throw new EncodedQueryPolicyError("invalid_query");
  }
  if (
    queryCandidate.length > rule.maxLength ||
    Buffer.byteLength(queryCandidate, "utf8") > rule.maxLength
  ) {
    throw new EncodedQueryPolicyError("query_limit_exceeded");
  }
  if (!isWellFormedUnicode(queryCandidate) || FORBIDDEN_UNICODE.test(queryCandidate)) {
    throw new EncodedQueryPolicyError("invalid_query");
  }
  if (PERCENT_ENCODING.test(queryCandidate) || JAVASCRIPT_VALUE.test(queryCandidate)) {
    throw new EncodedQueryPolicyError("invalid_query");
  }
  const terms = queryCandidate.split("^");
  if (terms.length === 0 || terms.some((term) => term.length === 0)) {
    throw new EncodedQueryPolicyError("invalid_query");
  }
  let complexity = terms.length;
  for (const term of terms) {
    if (LOGICAL_OR_CONTROL_PREFIX.test(term)) {
      throw new EncodedQueryPolicyError("invalid_query");
    }
    const match = OPERATOR_PATTERN.exec(term);
    const field = match?.groups?.field;
    const operator = match?.groups?.operator as EncodedQueryOperator | undefined;
    const value = match?.groups?.value;
    if (
      field === undefined ||
      operator === undefined ||
      value === undefined ||
      !rule.fields.includes(field) ||
      !rule.operators.includes(operator)
    ) {
      throw new EncodedQueryPolicyError("invalid_query");
    }
    complexity += validateOperatorValue(operator, value);
    if (complexity > rule.maxTerms) {
      throw new EncodedQueryPolicyError("query_limit_exceeded");
    }
  }
  return queryCandidate;
}

function validateOperatorValue(operator: EncodedQueryOperator, value: string): number {
  if (operator === "ISEMPTY" || operator === "ISNOTEMPTY") {
    if (value.length !== 0) throw new EncodedQueryPolicyError("invalid_query");
    return 0;
  }
  if (value.length === 0 || /^[<>=!]/u.test(value)) {
    throw new EncodedQueryPolicyError("invalid_query");
  }
  if (operator === "IN" || operator === "NOT IN") {
    const values = value.split(",");
    if (values.length > MAX_ENCODED_QUERY_SET_VALUES) {
      throw new EncodedQueryPolicyError("query_limit_exceeded");
    }
    if (values.length === 0 || values.some((candidate) => candidate.length === 0)) {
      throw new EncodedQueryPolicyError("invalid_query");
    }
    return values.length - 1;
  }
  if (operator === "BETWEEN") {
    const values = value.split("@");
    if (values.length !== 2 || values.some((candidate) => candidate.length === 0)) {
      throw new EncodedQueryPolicyError("invalid_query");
    }
    return 1;
  }
  return 0;
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

function isIssuedPolicy(candidate: unknown): candidate is EncodedQueryAccessPolicy {
  try {
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      !nodeUtilTypes.isProxy(candidate) &&
      Object.isFrozen(candidate) &&
      ISSUED_ENCODED_QUERY_POLICIES.has(candidate)
    );
  } catch {
    return false;
  }
}

function plainObject(
  candidate: unknown,
  allowedKeys: readonly string[]
): object {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate) ||
    Array.isArray(candidate)
  ) {
    throw new TypeError("encoded-query policy object is invalid");
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("encoded-query policy object is invalid");
  }
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length > allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  ) {
    throw new TypeError("encoded-query policy object is invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("encoded-query policy object is invalid");
    }
  }
  return candidate;
}

function plainArray(
  candidate: unknown,
  maximum: number,
  label: string
): readonly unknown[] {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate) ||
    !Array.isArray(candidate)
  ) {
    throw new TypeError(`${label} must be an array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
  const length = lengthDescriptor?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum
  ) {
    throw new TypeError(`${label} exceeds its bound`);
  }
  const keys = Reflect.ownKeys(candidate);
  if (keys.length !== length + 1) throw new TypeError(`${label} is sparse or exotic`);
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} is sparse or exotic`);
    }
    output.push(descriptor.value);
  }
  return output;
}

function dataValue(candidate: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function uniqueStrings<T extends string = string>(
  candidate: unknown,
  maximum: number,
  validate: (value: string) => boolean
): readonly T[] {
  const values = plainArray(candidate, maximum, "encoded-query policy list");
  if (values.length === 0) throw new TypeError("encoded-query policy list is empty");
  const output: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !validate(value) || seen.has(value)) {
      throw new TypeError("encoded-query policy list is invalid");
    }
    seen.add(value);
    output.push(value as T);
  }
  return Object.freeze(output);
}

function boundedInteger(candidate: unknown, minimum: number, maximum: number): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new TypeError("encoded-query policy bound is invalid");
  }
  return candidate;
}
