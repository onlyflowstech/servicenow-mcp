/**
 * Bounded, policy-authorized ServiceNow structured-query compiler.
 *
 * The public schema is reusable by read tools. Compilation snapshots hostile
 * input without evaluating accessors, validates every referenced field against
 * the caller-provided SNSDK-30 readable-field set, and emits only fixed
 * ServiceNow operators plus neutralized values.
 *
 * @module structured-query
 */

import { Buffer } from "node:buffer";
import { types as nodeUtilTypes } from "node:util";

import { z } from "zod";

import { escapeQueryValue } from "./utils.js";

export const MAX_STRUCTURED_QUERY_CONDITIONS = 32;
export const MAX_STRUCTURED_QUERY_NESTING = 3;
export const MAX_STRUCTURED_QUERY_VALUE_LENGTH = 512;
export const MAX_STRUCTURED_QUERY_SET_VALUES = 20;
export const MAX_STRUCTURED_QUERY_ORDER_COUNT = 4;
export const MAX_STRUCTURED_QUERY_CLAUSES = 16;
export const MAX_STRUCTURED_QUERY_TERMS = 64;
export const MAX_STRUCTURED_QUERY_BYTES = 8_192;

const MAX_SNAPSHOT_OBJECT_KEYS = 8;
const MAX_SNAPSHOT_ARRAY_LENGTH = MAX_STRUCTURED_QUERY_CONDITIONS;
const MAX_SNAPSHOT_DEPTH = 12;
const MAX_SNAPSHOT_NODES = 2_048;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const FORBIDDEN_UNICODE_CATEGORY = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export type StructuredQueryFailureReason =
  | "invalid_shape"
  | "limit_exceeded"
  | "unauthorized_field"
  | "expansion_limit";

export class StructuredQueryError extends Error {
  constructor(readonly reason: StructuredQueryFailureReason) {
    super("Structured query denied by policy");
    this.name = "StructuredQueryError";
    Object.freeze(this);
  }
}

const fieldNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(FIELD_NAME, "field must be a canonical ServiceNow field name");

const stringValueSchema = z
  .string()
  .min(1)
  .max(MAX_STRUCTURED_QUERY_VALUE_LENGTH)
  .refine(isWellFormedUnicode, {
    message: "query values must contain well-formed Unicode",
  })
  .refine((value) => !FORBIDDEN_UNICODE_CATEGORY.test(value), {
    message: "query values must not contain control or separator characters",
  });

export const structuredQueryScalarSchema = z.union([
  stringValueSchema,
  z.number().finite(),
  z.boolean(),
]);

export type StructuredQueryScalar = z.output<typeof structuredQueryScalarSchema>;

const equalityConditionSchema = z
  .object({
    type: z.literal("equality"),
    field: fieldNameSchema,
    operator: z.enum(["eq", "neq"]),
    value: structuredQueryScalarSchema,
  })
  .strict();

const setConditionSchema = z
  .object({
    type: z.literal("set"),
    field: fieldNameSchema,
    operator: z.enum(["in", "not_in"]),
    values: z
      .array(structuredQueryScalarSchema)
      .min(1)
      .max(MAX_STRUCTURED_QUERY_SET_VALUES),
  })
  .strict();

const scalarRangeConditionSchema = z
  .object({
    type: z.literal("range"),
    field: fieldNameSchema,
    operator: z.enum(["gt", "gte", "lt", "lte"]),
    value: structuredQueryScalarSchema,
  })
  .strict();

const betweenRangeConditionSchema = z
  .object({
    type: z.literal("range"),
    field: fieldNameSchema,
    operator: z.literal("between"),
    lower: structuredQueryScalarSchema,
    upper: structuredQueryScalarSchema,
  })
  .strict();

const textConditionSchema = z
  .object({
    type: z.literal("text"),
    field: fieldNameSchema,
    operator: z.enum(["contains", "not_contains", "starts_with", "ends_with"]),
    value: stringValueSchema,
  })
  .strict();

const nullConditionSchema = z
  .object({
    type: z.literal("null"),
    field: fieldNameSchema,
    operator: z.enum(["is_null", "is_not_null"]),
  })
  .strict();

export type StructuredLeafCondition =
  | z.output<typeof equalityConditionSchema>
  | z.output<typeof setConditionSchema>
  | z.output<typeof scalarRangeConditionSchema>
  | z.output<typeof betweenRangeConditionSchema>
  | z.output<typeof textConditionSchema>
  | z.output<typeof nullConditionSchema>;

export interface StructuredQueryGroup {
  readonly type: "group";
  readonly operator: "and" | "or";
  readonly conditions: readonly StructuredQueryFilter[];
}

export type StructuredQueryFilter = StructuredLeafCondition | StructuredQueryGroup;

const structuredLeafConditionSchema = z.union([
  equalityConditionSchema,
  setConditionSchema,
  scalarRangeConditionSchema,
  betweenRangeConditionSchema,
  textConditionSchema,
  nullConditionSchema,
]);

function structuredQueryGroupSchema<FilterSchema extends z.ZodTypeAny>(
  filterSchema: FilterSchema
) {
  return z
    .object({
      type: z.literal("group"),
      operator: z.enum(["and", "or"]),
      conditions: z
        .array(filterSchema)
        .min(1)
        .max(MAX_STRUCTURED_QUERY_CONDITIONS),
    })
    .strict();
}

// Statically compose the exact three group levels admitted by policy. Keeping
// the registered schema finite makes hostile over-depth input a bounded Zod
// rejection instead of recursive parsing work.
const structuredQueryGroupLevelOneSchema = structuredQueryGroupSchema(
  structuredLeafConditionSchema
);
const structuredQueryFilterLevelOneSchema = z.union([
  structuredLeafConditionSchema,
  structuredQueryGroupLevelOneSchema,
]);
const structuredQueryGroupLevelTwoSchema = structuredQueryGroupSchema(
  structuredQueryFilterLevelOneSchema
);
const structuredQueryFilterLevelTwoSchema = z.union([
  structuredLeafConditionSchema,
  structuredQueryGroupLevelTwoSchema,
]);
const structuredQueryGroupLevelThreeSchema = structuredQueryGroupSchema(
  structuredQueryFilterLevelTwoSchema
);

export const structuredQueryFilterSchema: z.ZodType<StructuredQueryFilter> = z.union([
  structuredLeafConditionSchema,
  structuredQueryGroupLevelThreeSchema,
]);

export const structuredQueryOrderSchema = z
  .object({
    field: fieldNameSchema,
    direction: z.enum(["asc", "desc"]).optional().default("asc"),
  })
  .strict();

export const structuredQuerySchema = z
  .object({
    filter: structuredQueryFilterSchema.optional(),
    order_by: z
      .array(structuredQueryOrderSchema)
      .min(1)
      .max(MAX_STRUCTURED_QUERY_ORDER_COUNT)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.filter === undefined && value.order_by === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "structured_query requires filter or order_by",
      });
    }
  });

export type StructuredQueryInput = z.output<typeof structuredQuerySchema>;

export interface StructuredQueryPlan {
  readonly encodedQuery: string;
  readonly referencedFields: readonly string[];
  readonly structuredQuery: Readonly<StructuredQueryInput>;
}

interface CompileState {
  conditionCount: number;
  readonly referencedFields: Set<string>;
  readonly readableFields: ReadonlySet<string>;
}

interface SnapshotState {
  nodes: number;
  readonly seen: WeakSet<object>;
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

/** Compile one structured filter/order tree against an approved readable set. */
export function compileStructuredQuery(
  candidate: unknown,
  readableFieldsCandidate: unknown
): StructuredQueryPlan {
  const snapshot = snapshotStructuredValue(candidate, snapshotState(), 0);
  const parsed = structuredQuerySchema.safeParse(snapshot);
  if (!parsed.success) throw new StructuredQueryError("invalid_shape");

  const readableFields = snapshotReadableFields(readableFieldsCandidate);
  const state: CompileState = {
    conditionCount: 0,
    referencedFields: new Set<string>(),
    readableFields,
  };

  const clauses = parsed.data.filter
    ? compileFilter(parsed.data.filter, state, 0)
    : [];
  const conditionQuery = clauses
    .map((terms) => terms.join("^"))
    .join("^NQ");

  const seenOrderFields = new Set<string>();
  const orderTokens = (parsed.data.order_by ?? []).map((order) => {
    authorizeField(order.field, state);
    if (seenOrderFields.has(order.field)) {
      throw new StructuredQueryError("invalid_shape");
    }
    seenOrderFields.add(order.field);
    return `${order.direction === "desc" ? "ORDERBYDESC" : "ORDERBY"}${order.field}`;
  });

  const encodedQuery = [conditionQuery, ...orderTokens].filter(Boolean).join("^");
  if (
    encodedQuery.length > MAX_STRUCTURED_QUERY_BYTES ||
    Buffer.byteLength(encodedQuery, "utf8") > MAX_STRUCTURED_QUERY_BYTES
  ) {
    throw new StructuredQueryError("limit_exceeded");
  }

  const canonical = deepFreezeStructuredQuery(parsed.data);
  return Object.freeze({
    encodedQuery,
    referencedFields: Object.freeze([...state.referencedFields]),
    structuredQuery: canonical,
  });
}

function compileFilter(
  filter: StructuredQueryFilter,
  state: CompileState,
  groupDepth: number
): string[][] {
  if (filter.type !== "group") {
    state.conditionCount += 1;
    if (state.conditionCount > MAX_STRUCTURED_QUERY_CONDITIONS) {
      throw new StructuredQueryError("limit_exceeded");
    }
    authorizeField(filter.field, state);
    return [[compileLeaf(filter)]];
  }

  if (groupDepth >= MAX_STRUCTURED_QUERY_NESTING) {
    throw new StructuredQueryError("limit_exceeded");
  }
  const children = filter.conditions.map((condition) =>
    compileFilter(condition, state, groupDepth + 1)
  );
  if (filter.operator === "or") {
    return enforceExpansionBounds(children.flat());
  }

  let product: string[][] = [[]];
  for (const child of children) {
    const next: string[][] = [];
    for (const left of product) {
      for (const right of child) {
        next.push([...left, ...right]);
        enforceExpansionBounds(next);
      }
    }
    product = next;
  }
  return enforceExpansionBounds(product);
}

function enforceExpansionBounds(clauses: string[][]): string[][] {
  if (clauses.length > MAX_STRUCTURED_QUERY_CLAUSES) {
    throw new StructuredQueryError("expansion_limit");
  }
  const terms = clauses.reduce((total, clause) => total + clause.length, 0);
  if (terms > MAX_STRUCTURED_QUERY_TERMS) {
    throw new StructuredQueryError("expansion_limit");
  }
  return clauses;
}

function compileLeaf(condition: StructuredLeafCondition): string {
  switch (condition.type) {
    case "equality":
      return `${condition.field}${condition.operator === "eq" ? "=" : "!="}${escapeScalar(condition.value)}`;
    case "set":
      return `${condition.field}${condition.operator === "in" ? "IN" : "NOT IN"}${condition.values
        .map((value) => escapeScalar(value, /,/gu))
        .join(",")}`;
    case "range":
      if (condition.operator === "between") {
        return `${condition.field}BETWEEN${escapeScalar(condition.lower, /@/gu)}@${escapeScalar(condition.upper, /@/gu)}`;
      }
      return `${condition.field}${rangeOperator(condition.operator)}${escapeScalar(condition.value)}`;
    case "text":
      return `${condition.field}${textOperator(condition.operator)}${escapeScalar(condition.value)}`;
    case "null":
      return `${condition.field}${condition.operator === "is_null" ? "ISEMPTY" : "ISNOTEMPTY"}`;
  }
}

function rangeOperator(
  operator: "gt" | "gte" | "lt" | "lte"
): ">" | ">=" | "<" | "<=" {
  switch (operator) {
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
  }
}

function textOperator(
  operator: "contains" | "not_contains" | "starts_with" | "ends_with"
): "LIKE" | "NOT LIKE" | "STARTSWITH" | "ENDSWITH" {
  switch (operator) {
    case "contains":
      return "LIKE";
    case "not_contains":
      return "NOT LIKE";
    case "starts_with":
      return "STARTSWITH";
    case "ends_with":
      return "ENDSWITH";
  }
}

function escapeScalar(
  value: StructuredQueryScalar,
  additionalSeparator?: RegExp
): string {
  const raw = typeof value === "string" ? value : String(value);
  const escaped = escapeQueryValue(
    additionalSeparator ? raw.replace(additionalSeparator, "") : raw
  );
  if (!escaped) throw new StructuredQueryError("invalid_shape");
  return escaped;
}

function authorizeField(field: string, state: CompileState): void {
  if (!state.readableFields.has(field)) {
    throw new StructuredQueryError("unauthorized_field");
  }
  state.referencedFields.add(field);
}

function snapshotReadableFields(candidate: unknown): ReadonlySet<string> {
  let isPlainArray = false;
  try {
    isPlainArray =
      typeof candidate === "object" &&
      candidate !== null &&
      !nodeUtilTypes.isProxy(candidate) &&
      Array.isArray(candidate);
  } catch {
    isPlainArray = false;
  }
  if (!isPlainArray) {
    throw new StructuredQueryError("invalid_shape");
  }
  const snapshot = snapshotStructuredValue(candidate, snapshotState(), 0);
  const parsed = z
    .array(fieldNameSchema)
    .min(1)
    .max(MAX_STRUCTURED_QUERY_CONDITIONS)
    .safeParse(snapshot);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new StructuredQueryError("invalid_shape");
  }
  return new Set(parsed.data);
}

function snapshotState(): SnapshotState {
  return { nodes: 0, seen: new WeakSet<object>() };
}

function snapshotStructuredValue(
  candidate: unknown,
  state: SnapshotState,
  depth: number
): unknown {
  state.nodes += 1;
  if (depth > MAX_SNAPSHOT_DEPTH || state.nodes > MAX_SNAPSHOT_NODES) {
    throw new StructuredQueryError("limit_exceeded");
  }
  if (
    candidate === null ||
    candidate === undefined ||
    typeof candidate === "boolean" ||
    (typeof candidate === "number" && Number.isFinite(candidate))
  ) {
    return candidate;
  }
  if (typeof candidate === "string") {
    if (candidate.length > MAX_STRUCTURED_QUERY_VALUE_LENGTH) {
      throw new StructuredQueryError("limit_exceeded");
    }
    return candidate;
  }
  if (
    typeof candidate !== "object" ||
    nodeUtilTypes.isProxy(candidate) ||
    state.seen.has(candidate)
  ) {
    throw new StructuredQueryError("invalid_shape");
  }

  state.seen.add(candidate);
  try {
    if (Array.isArray(candidate)) {
      return snapshotArray(candidate, state, depth);
    }
    return snapshotObject(candidate, state, depth);
  } finally {
    state.seen.delete(candidate);
  }
}

function snapshotArray(
  candidate: unknown[],
  state: SnapshotState,
  depth: number
): readonly unknown[] {
  const keys = safeOwnKeys(candidate, MAX_SNAPSHOT_ARRAY_LENGTH + 1);
  const lengthDescriptor = safeDataDescriptor(candidate, "length");
  const length = lengthDescriptor?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_SNAPSHOT_ARRAY_LENGTH ||
    keys.length !== length + 1
  ) {
    throw new StructuredQueryError("limit_exceeded");
  }
  const allowed = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new StructuredQueryError("invalid_shape");
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = safeDataDescriptor(candidate, String(index));
    if (!descriptor || !descriptor.enumerable) {
      throw new StructuredQueryError("invalid_shape");
    }
    output.push(snapshotStructuredValue(descriptor.value, state, depth + 1));
  }
  return Object.freeze(output);
}

function snapshotObject(
  candidate: object,
  state: SnapshotState,
  depth: number
): Readonly<Record<string, unknown>> {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(candidate);
  } catch {
    throw new StructuredQueryError("invalid_shape");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StructuredQueryError("invalid_shape");
  }
  const keys = safeOwnKeys(candidate, MAX_SNAPSHOT_OBJECT_KEYS);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new StructuredQueryError("invalid_shape");
    }
    const descriptor = safeDataDescriptor(candidate, key);
    if (!descriptor || !descriptor.enumerable) {
      throw new StructuredQueryError("invalid_shape");
    }
    Object.defineProperty(output, key, {
      value: snapshotStructuredValue(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(output);
}

function safeOwnKeys(candidate: object, maximum: number): PropertyKey[] {
  try {
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > maximum) {
      throw new StructuredQueryError("limit_exceeded");
    }
    return keys;
  } catch (error) {
    if (error instanceof StructuredQueryError) throw error;
    throw new StructuredQueryError("invalid_shape");
  }
}

function safeDataDescriptor(
  candidate: object,
  key: PropertyKey
): (PropertyDescriptor & { value: unknown }) | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor && "value" in descriptor
      ? (descriptor as PropertyDescriptor & { value: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

function deepFreezeStructuredQuery(
  query: StructuredQueryInput
): Readonly<StructuredQueryInput> {
  if (query.filter) deepFreezeFilter(query.filter);
  if (query.order_by) {
    for (const order of query.order_by) Object.freeze(order);
    Object.freeze(query.order_by);
  }
  return Object.freeze(query);
}

function deepFreezeFilter(filter: StructuredQueryFilter): void {
  if (filter.type === "group") {
    for (const child of filter.conditions) deepFreezeFilter(child);
    Object.freeze(filter.conditions);
  } else if (filter.type === "set") {
    Object.freeze(filter.values);
  }
  Object.freeze(filter);
}
