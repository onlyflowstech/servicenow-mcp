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

import { boundedArray, withStructuralCheck } from "./bounded-input.js";
import { isSensitiveFieldName, queryDeniedForSelection } from "./field-policy.js";
import { escapeQueryValue } from "./utils.js";

export const MAX_STRUCTURED_QUERY_CONDITIONS = 32;
export const MAX_STRUCTURED_QUERY_NESTING = 3;
export const MAX_STRUCTURED_QUERY_VALUE_LENGTH = 512;
export const MAX_STRUCTURED_QUERY_SET_VALUES = 20;
export const MAX_STRUCTURED_QUERY_ORDER_COUNT = 4;
export const MAX_STRUCTURED_QUERY_CLAUSES = 16;
export const MAX_STRUCTURED_QUERY_TERMS = 64;
export const MAX_STRUCTURED_QUERY_BYTES = 8_192;

/** Node bound of the compiler snapshot: every value, the root included. */
export const MAX_STRUCTURED_QUERY_NODES = 2_048;
/**
 * Leaf conditions the schema will look at. Every leaf contributes at least one
 * term to the compiled query, and compilation stops past
 * {@link MAX_STRUCTURED_QUERY_TERMS} terms (and past
 * {@link MAX_STRUCTURED_QUERY_CONDITIONS} leaves), so this bound rejects
 * nothing that could compile.
 */
export const MAX_STRUCTURED_QUERY_LEAVES = MAX_STRUCTURED_QUERY_TERMS;
/**
 * Group conditions the schema will look at. Groups nest at most
 * {@link MAX_STRUCTURED_QUERY_NESTING} levels and every group holds at least
 * one condition, so below the top group each level's groups have disjoint
 * subtrees that each hold a leaf. With at most
 * {@link MAX_STRUCTURED_QUERY_CONDITIONS} leaves, a query that compiles has at
 * most one top group plus that many groups on each lower level.
 */
export const MAX_STRUCTURED_QUERY_GROUPS =
  1 + (MAX_STRUCTURED_QUERY_NESTING - 1) * MAX_STRUCTURED_QUERY_CONDITIONS;

const MAX_SNAPSHOT_OBJECT_KEYS = 8;
const MAX_SNAPSHOT_ARRAY_LENGTH = MAX_STRUCTURED_QUERY_CONDITIONS;
const MAX_SNAPSHOT_DEPTH = 12;
const MAX_SNAPSHOT_NODES = MAX_STRUCTURED_QUERY_NODES;

/** Where a value sits in the structural pass over a structured query. */
const StructuralRole = Object.freeze({
  Other: 0,
  /** The filter itself, or one element of a group's conditions. */
  Condition: 1,
  /** A group's conditions array. */
  Conditions: 2,
});
type StructuralRole = (typeof StructuralRole)[keyof typeof StructuralRole];
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const FIELD_POLICY_WILDCARD = "*";
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

/**
 * The operators each condition type accepts. The schema and the filter error
 * diagnosis both read these lists, so the message can never name an operator
 * the schema rejects, or leave one out.
 */
const EQUALITY_OPERATORS = ["eq", "neq"] as const;
const SET_OPERATORS = ["in", "not_in"] as const;
const SCALAR_RANGE_OPERATORS = ["gt", "gte", "lt", "lte"] as const;
const BETWEEN_OPERATOR = "between";
const TEXT_OPERATORS = ["contains", "not_contains", "starts_with", "ends_with"] as const;
const NULL_OPERATORS = ["is_null", "is_not_null"] as const;
const GROUP_OPERATORS = ["and", "or"] as const;

const equalityConditionSchema = z
  .object({
    type: z.literal("equality"),
    field: fieldNameSchema,
    operator: z.enum(EQUALITY_OPERATORS),
    value: structuredQueryScalarSchema,
  })
  .strict();

const setConditionSchema = z
  .object({
    type: z.literal("set"),
    field: fieldNameSchema,
    operator: z.enum(SET_OPERATORS),
    values: boundedArray(structuredQueryScalarSchema, MAX_STRUCTURED_QUERY_SET_VALUES, {
      min: 1,
    }),
  })
  .strict();

const scalarRangeConditionSchema = z
  .object({
    type: z.literal("range"),
    field: fieldNameSchema,
    operator: z.enum(SCALAR_RANGE_OPERATORS),
    value: structuredQueryScalarSchema,
  })
  .strict();

const betweenRangeConditionSchema = z
  .object({
    type: z.literal("range"),
    field: fieldNameSchema,
    operator: z.literal(BETWEEN_OPERATOR),
    lower: structuredQueryScalarSchema,
    upper: structuredQueryScalarSchema,
  })
  .strict();

const textConditionSchema = z
  .object({
    type: z.literal("text"),
    field: fieldNameSchema,
    operator: z.enum(TEXT_OPERATORS),
    value: stringValueSchema,
  })
  .strict();

const nullConditionSchema = z
  .object({
    type: z.literal("null"),
    field: fieldNameSchema,
    operator: z.enum(NULL_OPERATORS),
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

/**
 * The registry ids below ({@link SCHEMA_IDS}) make the JSON Schema converter
 * publish the leaf union and the filter union once, under `definitions`, and
 * refer to them with `$ref` wherever they recur. Without them every use is
 * written out again, and `tools/list` carries the whole nest of three group
 * levels several times over. The converter runs once per tool, so each tool's
 * `inputSchema` holds the definitions it refers to. An id is registered
 * globally and may belong to one schema instance only. The names carry the
 * module's own prefix because a client may merge `definitions` across tools or
 * servers, where a bare `Filter` could collide with another server's.
 */
const SCHEMA_IDS = Object.freeze({
  condition: "StructuredQueryCondition",
  filter: "StructuredQueryFilter",
});

const structuredLeafConditionSchema = z
  .union([
    equalityConditionSchema,
    setConditionSchema,
    scalarRangeConditionSchema,
    betweenRangeConditionSchema,
    textConditionSchema,
    nullConditionSchema,
  ])
  .meta({ id: SCHEMA_IDS.condition });

function structuredQueryGroupSchema<FilterSchema extends z.ZodType>(
  filterSchema: FilterSchema
) {
  return z
    .object({
      type: z.literal("group"),
      operator: z.enum(GROUP_OPERATORS),
      conditions: boundedArray(filterSchema, MAX_STRUCTURED_QUERY_CONDITIONS, {
        min: 1,
      }),
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

const FILTER_EXAMPLE = "{type:'text', field:'name', operator:'contains', value:'fleet'}";
const GROUP_EXAMPLE = "{type:'group', operator:'and', conditions:[...]}";

/**
 * What a rejected `filter` says. The MCP SDK validates input before any
 * handler runs and reports a union failure as one generic line, so the shape
 * and a working example go here, on the union itself. A custom message adds
 * nothing to the advertised JSON Schema. Fixed text: it never includes any
 * part of the rejected value.
 */
export const STRUCTURED_FILTER_ERROR_MESSAGE =
  `filter must be one condition or group object. Example: ${FILTER_EXAMPLE}. ` +
  `Combine conditions with ${GROUP_EXAMPLE}; groups nest at most ` +
  `${MAX_STRUCTURED_QUERY_NESTING} levels deep. A list is not accepted here.`;

/** The same, for a tool that also reads a list as an implicit AND. */
export const STRUCTURED_FILTER_LIST_ERROR_MESSAGE =
  "filter must be one condition or group object (or a list, treated as AND). " +
  `Example: ${FILTER_EXAMPLE}. Combine with ${GROUP_EXAMPLE}; groups nest at ` +
  `most ${MAX_STRUCTURED_QUERY_NESTING} levels deep and a list of two or more ` +
  "counts as one level.";

export const STRUCTURED_FILTER_EMPTY_LIST_MESSAGE =
  "filter list must hold at least one condition. " +
  `Example: [${FILTER_EXAMPLE}].`;

/**
 * What each leaf condition type needs: its operators and the keys it takes.
 * Only the diagnosis below reads this (the schemas above are the authority),
 * and it is built from the same operator lists.
 */
interface LeafShape {
  readonly operators: readonly string[];
  /** Keys a condition needs, by operator. */
  readonly keys: (operator: string) => readonly string[];
  /** The keys whose value must be one scalar (string, number or boolean). */
  readonly scalarKeys: readonly string[];
  /** The keys whose value must be a string. */
  readonly stringKeys: readonly string[];
}

const LEAF_SHAPES: Readonly<Record<string, LeafShape>> = Object.freeze({
  equality: {
    operators: EQUALITY_OPERATORS,
    keys: () => ["field", "value"],
    scalarKeys: ["value"],
    stringKeys: [],
  },
  set: {
    operators: SET_OPERATORS,
    keys: () => ["field", "values"],
    scalarKeys: [],
    stringKeys: [],
  },
  range: {
    operators: [...SCALAR_RANGE_OPERATORS, BETWEEN_OPERATOR],
    keys: (operator) =>
      operator === BETWEEN_OPERATOR ? ["field", "lower", "upper"] : ["field", "value"],
    scalarKeys: ["value", "lower", "upper"],
    stringKeys: [],
  },
  text: {
    operators: TEXT_OPERATORS,
    keys: () => ["field", "value"],
    scalarKeys: [],
    stringKeys: ["value"],
  },
  null: {
    operators: NULL_OPERATORS,
    keys: () => ["field"],
    scalarKeys: [],
    stringKeys: [],
  },
});

const CONDITION_TYPES = [...Object.keys(LEAF_SHAPES), "group"];

/**
 * A rejected list filter is wrapped into a synthetic AND group before it is
 * diagnosed. These sets let the diagnosis name the caller's own positions
 * (`filter[1]`) instead of positions inside a group the caller never wrote. The path
 * indexes always come from loops over the list, never from caller text.
 */
const listFilterWrappers = new WeakSet<object>();
const listFilterSingles = new WeakSet<object>();

function ownValue(node: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(node, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalarValue(value: unknown): boolean {
  return typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);
}

function joinWords(words: readonly string[]): string {
  return words.length < 2
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

interface DiagnosisSite {
  /** Where the value sits, as `filter`, `filter[1]` or `filter.conditions[1]`. */
  readonly path: string;
  /** Group levels already open above this value. */
  readonly level: number;
  /** The value is the filter itself, so the path adds nothing to the message. */
  readonly topLevel: boolean;
  /** The filter was a list of two or more, so the depth message says how a list counts. */
  readonly listForm: boolean;
}

/**
 * The first thing wrong with a rejected filter, as fixed text and a path, or
 * undefined when the walk finds nothing it can name. Every word comes from
 * the lists above; nothing the caller sent is repeated. A condition type is
 * quoted only after it matched a known type name, and then the known name is
 * what is quoted. Reads own data properties only.
 */
function diagnoseFilter(node: unknown, site: DiagnosisSite): string | undefined {
  const located = (text: string): string =>
    site.topLevel ? text : `${site.path}: ${text}`;
  if (!isPlainRecord(node)) {
    if (site.topLevel) return undefined;
    return located(
      Array.isArray(node)
        ? "a condition must be one object, not a list"
        : "a condition must be an object with a type"
    );
  }
  const type = ownValue(node, "type");
  if (type === "group") return diagnoseGroup(node, site);
  const shape =
    typeof type === "string" && Object.hasOwn(LEAF_SHAPES, type)
      ? LEAF_SHAPES[type]
      : undefined;
  if (shape === undefined) {
    return located(`type must be one of ${CONDITION_TYPES.join(", ")}`);
  }
  const label = `a "${type as string}" condition`;
  const operator = ownValue(node, "operator");
  if (typeof operator !== "string" || !shape.operators.includes(operator)) {
    return located(`${label} needs operator one of ${shape.operators.join(", ")}`);
  }
  const keys = shape.keys(operator);
  if (keys.some((key) => ownValue(node, key) === undefined)) {
    return located(`${label} needs ${joinWords(keys)}`);
  }
  if (keys.includes("values")) {
    const values = ownValue(node, "values");
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > MAX_STRUCTURED_QUERY_SET_VALUES ||
      !values.every(isScalarValue)
    ) {
      return located(
        `${label} needs values as a list of 1 to ${MAX_STRUCTURED_QUERY_SET_VALUES} ` +
          "strings, numbers or booleans"
      );
    }
  }
  for (const key of shape.stringKeys) {
    if (typeof ownValue(node, key) !== "string") {
      return located(`${label} needs ${key} as a string`);
    }
  }
  for (const key of shape.scalarKeys) {
    if (keys.includes(key) && !isScalarValue(ownValue(node, key))) {
      return located(`${label} needs ${key} as a string, number or boolean`);
    }
  }
  const allowed = new Set(["type", "operator", ...keys]);
  if (Object.keys(node).some((key) => !allowed.has(key))) {
    return located(`${label} takes only ${joinWords(["type", "operator", ...keys])}`);
  }
  return undefined;
}

function diagnoseGroup(
  node: Record<string, unknown>,
  site: DiagnosisSite
): string | undefined {
  const located = (text: string): string =>
    site.topLevel ? text : `${site.path}: ${text}`;
  const level = site.level + 1;
  if (level > MAX_STRUCTURED_QUERY_NESTING) {
    return located(
      `groups nest at most ${MAX_STRUCTURED_QUERY_NESTING} levels deep` +
        (site.listForm ? ", and a list of two or more counts as one level" : "")
    );
  }
  const operator = ownValue(node, "operator");
  const conditions = ownValue(node, "conditions");
  if (
    typeof operator !== "string" ||
    !(GROUP_OPERATORS as readonly string[]).includes(operator) ||
    !Array.isArray(conditions) ||
    conditions.length < 1
  ) {
    return located("a group needs operator and or or, and a non-empty conditions list");
  }
  if (Object.keys(node).some((key) => key !== "type" && key !== "operator" && key !== "conditions")) {
    return located("a group takes only type, operator and conditions");
  }
  const synthetic = listFilterWrappers.has(node);
  for (let index = 0; index < conditions.length; index += 1) {
    const problem = diagnoseFilter(conditions[index], {
      path: synthetic ? `${site.path}[${index}]` : `${site.path}.conditions[${index}]`,
      level,
      topLevel: false,
      listForm: site.listForm,
    });
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/**
 * The text for a rejected filter: the first mistake found, in fixed words,
 * with the working example; the shape message when the walk finds none. The
 * walk runs only on a rejected value, after the structural pass has bounded
 * its size, and takes no part in what the schema accepts.
 */
function filterErrorMessage(input: unknown, fallback: string): string {
  try {
    const single = isPlainRecord(input) && listFilterSingles.has(input);
    const listForm = isPlainRecord(input) && listFilterWrappers.has(input);
    const problem = diagnoseFilter(input, {
      path: single ? "filter[0]" : "filter",
      level: 0,
      topLevel: !single,
      listForm,
    });
    return problem === undefined ? fallback : `${problem}. Example: ${FILTER_EXAMPLE}.`;
  } catch {
    return fallback;
  }
}

/**
 * The filter every structured query takes: one condition, or a group nested at
 * most {@link MAX_STRUCTURED_QUERY_NESTING} levels. Both tools publish it by
 * reference. `sn_query` also reads a list of it (see below), `sn_batch` never.
 */
export const structuredQueryFilterSchema: z.ZodType<StructuredQueryFilter> = z
  .union([structuredLeafConditionSchema, structuredQueryGroupLevelThreeSchema], {
    error: (issue) => filterErrorMessage(issue.input, STRUCTURED_FILTER_ERROR_MESSAGE),
  })
  .meta({ id: SCHEMA_IDS.filter });

/** Group levels beneath a node: 0 for a leaf, 1 for a group of leaves, and so on. */
function groupLevels(node: StructuredQueryFilter): number {
  if (node.type !== "group") return 0;
  let deepest = 0;
  for (const child of node.conditions) deepest = Math.max(deepest, groupLevels(child));
  return deepest + 1;
}

/**
 * What a rejected `sn_query` filter says. The list branch and the plain
 * branch each fail with their own issues; when neither survives, the union
 * reports one failure and this puts the walk's message in its place. The
 * caller's own list is wrapped the way a 2+ list is read, and the wrapper is
 * flagged, so the walk names the caller's positions (`filter[1]`) instead of
 * positions inside a group the caller never wrote. An empty list has no
 * meaning and gets its own message.
 */
function listFilterErrorMessage(input: unknown): string {
  if (!Array.isArray(input)) {
    return filterErrorMessage(input, STRUCTURED_FILTER_LIST_ERROR_MESSAGE);
  }
  if (input.length === 0) return STRUCTURED_FILTER_EMPTY_LIST_MESSAGE;
  if (input.length === 1) {
    const only: unknown = input[0];
    if (isPlainRecord(only)) listFilterSingles.add(only);
    return filterErrorMessage(only, STRUCTURED_FILTER_LIST_ERROR_MESSAGE);
  }
  const wrapper = { type: "group", operator: "and", conditions: input };
  listFilterWrappers.add(wrapper);
  return filterErrorMessage(wrapper, STRUCTURED_FILTER_LIST_ERROR_MESSAGE);
}

/**
 * The filter of a tool that only reads: the same filter, or a list of it,
 * read as an implicit AND. One element is that element, two or more become a
 * top-level `and` group, which takes one of the
 * {@link MAX_STRUCTURED_QUERY_NESTING} group levels.
 *
 * The union is the published schema: an array of
 * {@link structuredQueryFilterSchema} (1 to 32) and the filter itself, as
 * `anyOf`. The wrap and the depth check come after it, as a transform, which
 * the converter leaves out. That order matters for messages: a fault inside a
 * list element that is only a check (a bad field name, a control character,
 * an over-long value) leaves the array branch standing, so the union passes
 * that one issue on, with its own fixed text at the caller's list position.
 * A fault that fails every branch (a bad operator, a wrong type) is named by
 * the walk in {@link listFilterErrorMessage}.
 *
 * Each element has already passed the filter schema (up to three levels), so
 * what is left to check for a 2+ list is that no element uses all of them,
 * which would put the wrapper one level too deep. The check reads parsed
 * elements, whose depth the schema has bounded.
 */
const structuredQueryListFilterSchema = z
  .union(
    [
      z
        .array(structuredQueryFilterSchema)
        .min(1, STRUCTURED_FILTER_EMPTY_LIST_MESSAGE)
        .max(MAX_STRUCTURED_QUERY_CONDITIONS),
      structuredQueryFilterSchema,
    ],
    { error: (issue) => listFilterErrorMessage(issue.input) }
  )
  .transform((value, context): StructuredQueryFilter => {
    if (!Array.isArray(value)) return value;
    const [only] = value;
    if (value.length === 1 && only !== undefined) return only;
    if (value.some((element) => groupLevels(element) >= MAX_STRUCTURED_QUERY_NESTING)) {
      context.issues.push({
        code: "custom",
        message: listFilterErrorMessage(value),
        input: value,
      });
      return z.NEVER;
    }
    return { type: "group", operator: "and", conditions: value };
  });

export const structuredQueryOrderSchema = z
  .object({
    field: fieldNameSchema,
    direction: z.enum(["asc", "desc"]).optional().default("asc"),
  })
  .strict();

/**
 * What the advertised `filter` property says, one per tool kind. They are
 * short on purpose: `filter` is advertised once per tool that takes a
 * structured query, and every character is paid for in each `tools/list`.
 * The two are not interchangeable: only the read tool takes a list, so the
 * write tool's text must not offer one.
 *
 * The write tool's example filters on `sys_id`, a field every table has. A
 * field the table lacks is dropped by ServiceNow, which would make the filter
 * match every row, so an example for a destructive tool must not use a field
 * such as `name` that task tables do not have.
 */
export const STRUCTURED_FILTER_DESCRIPTION =
  "One condition or group. Example: " +
  '{type:"equality",field:"sys_id",operator:"eq",value:"<32 hex>"}. ' +
  "A list is not accepted.";

export const STRUCTURED_FILTER_LIST_DESCRIPTION =
  "One condition or group, or a list read as AND. Example: " +
  '[{type:"equality",field:"active",operator:"eq",value:true},' +
  '{type:"text",field:"name",operator:"contains",value:"fleet"}]';

function structuredQueryObjectSchemaFor(
  filter: z.ZodType<StructuredQueryFilter>,
  description: string
) {
  return z
    .object({
      filter: filter.optional().describe(description),
      order_by: boundedArray(structuredQueryOrderSchema, MAX_STRUCTURED_QUERY_ORDER_COUNT, {
        min: 1,
      }).optional(),
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
}

/** Fixed text; it never includes any part of the rejected value. */
export const STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE =
  "structured_query exceeds the structural limits for a query";

/**
 * The schema behind every structured-query argument.
 *
 * Its group and leaf unions are tried in turn for every condition, so the
 * cost of rejecting a value grows with the number of conditions times the
 * number of union branches. A plain structural pass runs first, with the
 * compiler's own snapshot bounds plus a leaf-condition bound, and one fatal
 * issue replaces the union walk for anything outside them. None of these
 * bounds rejects a query the compiler would accept.
 */
export const structuredQuerySchema = withStructuralCheck(
  structuredQueryObjectSchemaFor(structuredQueryFilterSchema, STRUCTURED_FILTER_DESCRIPTION),
  (value) =>
    structuredQueryShapeWithinLimits(value)
      ? undefined
      : STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE
);

/**
 * The same query for a tool that only reads: `filter` may also be a list of
 * conditions, read as an implicit AND. Write tools keep
 * {@link structuredQuerySchema}, whose filter is one object, so a mutation
 * never selects records through a list. The structural pass counts the list's
 * elements as conditions, so its bounds hold for the elements as well.
 */
export const structuredQueryReadSchema = withStructuralCheck(
  structuredQueryObjectSchemaFor(
    structuredQueryListFilterSchema as unknown as z.ZodType<StructuredQueryFilter>,
    STRUCTURED_FILTER_LIST_DESCRIPTION
  ),
  (value) =>
    structuredQueryShapeWithinLimits(value, { allowListFilter: true })
      ? undefined
      : STRUCTURED_QUERY_STRUCTURAL_LIMIT_MESSAGE
);

/**
 * Plain structural pass over an untrusted structured query, before any schema
 * runs. Iterative, stops at the first bound crossed, and reads only own
 * enumerable data.
 *
 * Bounds: {@link MAX_STRUCTURED_QUERY_NODES} values in total (the root
 * included), depth at most {@link MAX_SNAPSHOT_DEPTH}, arrays at most
 * {@link MAX_SNAPSHOT_ARRAY_LENGTH} long, objects with at most
 * {@link MAX_SNAPSHOT_OBJECT_KEYS} keys, at most
 * {@link MAX_STRUCTURED_QUERY_LEAVES} leaf conditions and at most
 * {@link MAX_STRUCTURED_QUERY_GROUPS} group conditions. A condition is a value
 * in a condition position: the `filter` itself, or an element of a group's
 * `conditions`. It is a group when it is an object whose `type` is "group",
 * and a leaf otherwise. With `allowListFilter`, a `filter` that is a list is
 * not itself a condition; its elements are.
 */
export function structuredQueryShapeWithinLimits(
  value: unknown,
  options: { readonly allowListFilter?: boolean } = {}
): boolean {
  const values: unknown[] = [value];
  const depths: number[] = [0];
  const roles: StructuralRole[] = [StructuralRole.Other];
  let nodes = 0;
  let leaves = 0;
  let groups = 0;
  try {
    while (values.length > 0) {
      const node = values.pop();
      const depth = depths.pop() as number;
      const role = roles.pop() as StructuralRole;
      nodes += 1;
      if (nodes > MAX_SNAPSHOT_NODES || depth > MAX_SNAPSHOT_DEPTH) return false;
      const isGroup =
        node !== null &&
        typeof node === "object" &&
        !Array.isArray(node) &&
        Object.hasOwn(node, "type") &&
        (node as { type?: unknown }).type === "group";
      // With a list accepted, the `filter` itself may be a list of conditions:
      // it is not a condition, its elements are.
      const isFilterList =
        options.allowListFilter === true &&
        depth === 1 &&
        role === StructuralRole.Condition &&
        Array.isArray(node);
      if (role === StructuralRole.Condition && !isFilterList) {
        if (isGroup ? ++groups > MAX_STRUCTURED_QUERY_GROUPS : ++leaves > MAX_STRUCTURED_QUERY_LEAVES) {
          return false;
        }
      }
      if (node === null || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        if (node.length > MAX_SNAPSHOT_ARRAY_LENGTH) return false;
        const childRole =
          role === StructuralRole.Conditions || isFilterList
            ? StructuralRole.Condition
            : StructuralRole.Other;
        for (let index = 0; index < node.length; index += 1) {
          values.push(node[index]);
          depths.push(depth + 1);
          roles.push(childRole);
        }
        continue;
      }
      let keys = 0;
      for (const key in node) {
        if (!Object.hasOwn(node, key)) continue;
        if (++keys > MAX_SNAPSHOT_OBJECT_KEYS) return false;
        let childRole: StructuralRole = StructuralRole.Other;
        if (depth === 0 && key === "filter") childRole = StructuralRole.Condition;
        else if (isGroup && role === StructuralRole.Condition && key === "conditions") {
          childRole = StructuralRole.Conditions;
        }
        values.push((node as Record<string, unknown>)[key]);
        depths.push(depth + 1);
        roles.push(childRole);
      }
    }
  } catch {
    return false;
  }
  return true;
}

export type StructuredQueryInput = z.output<typeof structuredQuerySchema>;

export interface StructuredQueryPlan {
  readonly encodedQuery: string;
  readonly referencedFields: readonly string[];
  readonly structuredQuery: Readonly<StructuredQueryInput>;
}

interface CompileState {
  conditionCount: number;
  readonly referencedFields: Set<string>;
  readonly readableFields?: ReadonlySet<string>;
  /** Hidden-typed and row-rule fields of the table (see field-policy). */
  readonly deniedFields: ReadonlySet<string>;
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

  // Read before the snapshot copies the list: the original remembers its table.
  const deniedFields = queryDeniedForSelection(readableFieldsCandidate);
  const readableFields = snapshotReadableFields(readableFieldsCandidate);
  const state: CompileState = {
    conditionCount: 0,
    referencedFields: new Set<string>(),
    readableFields,
    deniedFields,
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
  // A sensitive name is never usable as a filter or ordering field, whatever
  // the readable set says. Response filtering strips the value, but a query
  // that can filter on it still leaks it one comparison at a time through the
  // row count. This check is field-level and independent of table policy.
  // A hidden-typed field, and a value whose secrecy is per row
  // (sys_properties.value), are refused the same way, for the same reason.
  if (isSensitiveFieldName(field) || state.deniedFields.has(field)) {
    throw new StructuredQueryError("unauthorized_field");
  }
  if (state.readableFields && !state.readableFields.has(field)) {
    throw new StructuredQueryError("unauthorized_field");
  }
  state.referencedFields.add(field);
}

function snapshotReadableFields(candidate: unknown): ReadonlySet<string> | undefined {
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
    .array(z.union([fieldNameSchema, z.literal(FIELD_POLICY_WILDCARD)]))
    .min(1)
    .max(MAX_STRUCTURED_QUERY_CONDITIONS)
    .safeParse(snapshot);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new StructuredQueryError("invalid_shape");
  }
  if (parsed.data.length === 1 && parsed.data[0] === FIELD_POLICY_WILDCARD) {
    return undefined;
  }
  if (parsed.data.includes(FIELD_POLICY_WILDCARD)) {
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
