/**
 * Field policy for `sn_flow_view`.
 *
 * The Table API loader reads a fixed table closure. Preflight
 * (`flowViewFieldSelection`, called from the `sn_flow_view` access resolver)
 * fixes the readable set per table; the handler recovers it as a
 * FlowFieldPlan. Every graph element is then shown only when every
 * `(table, field)` it comes from is in that set, across V1 and V2 storage, so
 * the same profile shows the same data whichever storage a flow uses.
 *
 * Inputs rule: when `include_inputs` is false (`inputsIncluded(plan)` is
 * false), loaders omit inputs entirely; they never call `policyInput`.
 * `policyInput` still answers `not_requested` as a fail-safe.
 *
 * @module tools/flow-view-policy
 */

import { types as nodeUtilTypes } from "node:util";

import {
  FieldPolicyError,
  isAllFieldSelection,
  isSensitiveFieldName,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import {
  FLOW_ELEMENT_SOURCES,
  FLOW_TABLE_FIELDS,
  FLOW_VALUE_ELEMENT_KEYS,
  FLOW_VIEW_LIMITS,
  FLOW_VIEW_TABLES,
  type FlowElementKey,
  type FlowInputValue,
  type FlowTableName,
  type FlowText,
  type FlowValueElementKey,
  type RedactionReason,
} from "./flow-view-contracts.js";
import { parseBoundedJson } from "./flow-view-gzip.js";

export interface FlowFieldPlan {
  readonly readable: ReadonlyMap<FlowTableName, ReadonlySet<string>>;
  /**
   * Whether inputs were requested. Absent on a hand-built plan, where it is
   * derived: a plan that holds no value field did not request them. Read it
   * through `inputsIncluded`. The readable set alone decides what is shown.
   */
  readonly include_inputs?: boolean;
}

/**
 * Input types whose values are always redacted. `password2` is the
 * confirmed spelling (Brazil capture: `internal_type` and `parameter.type`);
 * the others are kept as a precaution.
 */
export const FLOW_SENSITIVE_INPUT_TYPES: ReadonlySet<string> = Object.freeze(
  new Set(["password", "password2", "masked", "encrypted_text"])
) as ReadonlySet<string>;

const MAX_IDENTIFIER_SOURCE_CHARS = 512;
const MAX_IDENTIFIER_WINDOW_CHARS = 80;
const PAIR_NAME_KEYS = Object.freeze(["name", "label", "element", "field"]);
const PAIR_VALUE_KEYS = Object.freeze([
  "value",
  "displayValue",
  "display_value",
  "defaultValue",
  "default_value",
]);

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function tableSpec(table: unknown) {
  if (typeof table !== "string" || !Object.hasOwn(FLOW_TABLE_FIELDS, table)) {
    throw new FieldPolicyError("unsupported_table");
  }
  return FLOW_TABLE_FIELDS[table as FlowTableName];
}

/**
 * The exact field list to prepare for one closure table.
 *
 * - Every required (structural) field must be readable; the first one that is
 *   not throws an actionable FieldPolicyError naming the table and field.
 * - Optional fields are intersected with the readable set, never a denial.
 * - Value fields are added only with `includeInputs`, then intersected.
 */
export function flowViewFieldSelection(
  table: FlowTableName,
  includeInputs: boolean
): readonly string[] {
  const spec = tableSpec(table);
  const required = resolveReadableFields(table, { fields: spec.required.join(",") });
  const all = resolveReadableFields(table, { fields: "all" });
  const readable = isAllFieldSelection(all) ? undefined : new Set(all);
  const allowed = (field: string) =>
    (readable === undefined || readable.has(field)) && !isSensitiveFieldName(field);
  return Object.freeze([
    ...required,
    ...spec.optional.filter(allowed),
    ...(includeInputs ? spec.values.filter(allowed) : []),
  ]);
}

/**
 * Recover the plan prepared at preflight. Throws when any closure table has
 * no issued marker, or a marker lacks a required field.
 */
export function flowFieldPlanFromArgs(args: Record<string, unknown>): FlowFieldPlan {
  const includeInputs = args.include_inputs !== false;
  const readable = new Map<FlowTableName, ReadonlySet<string>>();
  for (const table of FLOW_VIEW_TABLES) {
    const spec = FLOW_TABLE_FIELDS[table];
    const fields = preparedReadableFields(args, table);
    if (!fields || isAllFieldSelection(fields)) {
      throw new FieldPolicyError("invalid_argument_shape", { table });
    }
    const prepared = new Set(fields);
    for (const field of spec.required) {
      if (!prepared.has(field)) {
        throw new FieldPolicyError("invalid_argument_shape", { table });
      }
    }
    const known = [
      ...spec.required,
      ...spec.optional,
      ...(includeInputs ? spec.values : []),
    ];
    readable.set(table, Object.freeze(new Set(known.filter((field) => prepared.has(field)))));
  }
  return Object.freeze({ readable, include_inputs: includeInputs });
}

function isValueElement(element: unknown): element is FlowValueElementKey {
  return (FLOW_VALUE_ELEMENT_KEYS as readonly unknown[]).includes(element);
}

/** True when every source of the element is in the prepared readable set. */
export function canShow(plan: FlowFieldPlan, element: FlowElementKey): boolean {
  if (typeof element !== "string" || !Object.hasOwn(FLOW_ELEMENT_SOURCES, element)) {
    return false;
  }
  return FLOW_ELEMENT_SOURCES[element].every(
    ([table, field]) => plan.readable.get(table)?.has(field) === true
  );
}

/**
 * The `sysparm_fields` value for one closure table, in FLOW_TABLE_FIELDS
 * order. Never empty: an empty sysparm_fields means "every field".
 */
export function sysparmFieldsFor(plan: FlowFieldPlan, table: FlowTableName): string {
  const spec = tableSpec(table);
  const set = plan.readable.get(table);
  if (!set) throw new FieldPolicyError("unsupported_table", { table });
  const ordered = [...spec.required, ...spec.optional, ...spec.values].filter(
    (field) => set.has(field) && !isSensitiveFieldName(field)
  );
  if (ordered.length === 0) throw new FieldPolicyError("unreadable_field", { table });
  return ordered.join(",");
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Remove C0 (except tab, LF, CR), DEL and C1 controls. */
function stripControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "");
}

/** Remove every C0/C1 control, for single-line identifiers. */
function stripAllControls(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/gu, "");
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function clampChars(maxChars: number): number {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) return 1;
  return Math.min(maxChars, FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS);
}

function scalarText(candidate: unknown): string | null {
  if (typeof candidate === "string") return candidate;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  if (typeof candidate === "boolean") return String(candidate);
  return null;
}

/** Unwrap a scalar or a Table API `{display_value, value}` pair; display value first. */
function contentText(candidate: unknown): string | null {
  const scalar = scalarText(candidate);
  if (scalar !== null) return scalar;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    return null;
  }
  for (const key of ["display_value", "displayValue", "value"]) {
    const text = scalarText(ownData(candidate, key));
    if (text !== null && text.trim() !== "") return text;
  }
  return null;
}

function ownData(candidate: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedText(text: string, max: number): { text: string; original_length?: number } {
  const clean = stripControls(text);
  if (clean.length <= max) return { text: clean };
  return { text: cut(clean, max), original_length: clean.length };
}

/**
 * Project one text element: field policy first, then control stripping and
 * truncation (UTF-16 units; `original_length` set when cut). Empty text is
 * `null`. Text taken from inputs (a value element, such as the trigger's
 * table or condition) is `not_requested` when inputs were not requested.
 */
export function policyText(
  plan: FlowFieldPlan,
  element: FlowElementKey,
  raw: unknown,
  maxChars: number
): FlowText {
  if (isValueElement(element) && !inputsIncluded(plan)) {
    return { text: null, redacted: "not_requested" };
  }
  if (!canShow(plan, element)) return { text: null, redacted: "field_policy" };
  const text = contentText(raw);
  if (text === null || text.trim() === "") return { text: null };
  return boundedText(text, clampChars(maxChars));
}

/**
 * Convert a name or label to a policy identifier, the form
 * `isSensitiveFieldName` understands: camelCase and letter-digit boundaries
 * split, ASCII-folded, lowercased, every other character `_`, runs collapsed,
 * edge underscores trimmed, a leading digit prefixed with `x`.
 *
 * Unlike a single 80-character cut, the result keeps up to the first 512
 * source characters; `isSensitivePolicyName` checks every 80-character
 * window, so a term past position 80 is still found.
 */
export function policyIdentifier(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let text = raw.slice(0, MAX_IDENTIFIER_SOURCE_CHARS).normalize("NFKD").replace(/\p{M}/gu, "");
  text = text
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Za-z])([0-9])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return /^[0-9]/u.test(text) ? `x${text}` : text;
}

/**
 * True when the identifier form of `raw` is sensitive. An identifier that is
 * empty (no ASCII letter or digit) is reported as `emptyResult`.
 */
export function isSensitivePolicyName(raw: unknown, emptyResult: boolean): boolean {
  const identifier = policyIdentifier(raw);
  if (identifier === "") return emptyResult;
  const tokens = identifier.split("_");
  for (let start = 0; start < tokens.length; start += 1) {
    let window = tokens[start]!;
    for (let next = start + 1; next < tokens.length; next += 1) {
      const candidate = `${window}_${tokens[next]}`;
      if (candidate.length > MAX_IDENTIFIER_WINDOW_CHARS) break;
      window = candidate;
    }
    if (/^[0-9]/u.test(window)) window = `x${window}`;
    if (isSensitiveFieldName(cut(window, MAX_IDENTIFIER_WINDOW_CHARS))) return true;
  }
  return false;
}

function isSensitiveType(raw: unknown): boolean {
  const text = scalarText(raw);
  if (text === null) return false;
  const lowered = text.trim().toLowerCase();
  if (FLOW_SENSITIVE_INPUT_TYPES.has(lowered)) return true;
  const identifier = policyIdentifier(text);
  if (FLOW_SENSITIVE_INPUT_TYPES.has(identifier)) return true;
  return isSensitivePolicyName(text, false);
}

/**
 * Whether inputs were requested. When false, loaders omit every input (no
 * `inputs` on steps, nodes or the trigger) instead of listing redacted ones.
 */
export function inputsIncluded(plan: FlowFieldPlan): boolean {
  if (typeof plan.include_inputs === "boolean") return plan.include_inputs;
  for (const table of FLOW_VIEW_TABLES) {
    const set = plan.readable.get(table);
    if (set && FLOW_TABLE_FIELDS[table].values.some((field) => set.has(field))) return true;
  }
  return false;
}

function optionalLine(raw: unknown, max: number): string | null {
  const text = contentText(raw);
  if (text === null) return null;
  const clean = cut(stripAllControls(text).trim(), max);
  return clean === "" ? null : clean;
}

/** An input value that looks like JSON but cannot be scrubbed safely: withheld. */
const UNSCRUBBABLE: unique symbol = Symbol("unscrubbable");

/**
 * Serialize an input value; JSON text and objects pass through
 * scrubNestedKeys. JSON text is parsed only within the decoder's bounds
 * (MAX_DECODED_JSON_DEPTH, MAX_DECODED_JSON_NODES, MAX_GZIP_OUTPUT_BYTES):
 * deeper, larger or longer JSON-looking text cannot be scrubbed, so it is
 * withheld (UNSCRUBBABLE) rather than shown raw, and never parsed or
 * serialized unbounded.
 */
function inputValueText(raw: unknown): string | null | typeof UNSCRUBBABLE {
  if (raw === undefined || raw === null) return null;
  const scalar = scalarText(raw);
  if (scalar !== null) {
    const trimmed = scalar.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      if (scalar.length > FLOW_VIEW_LIMITS.MAX_GZIP_OUTPUT_BYTES) return UNSCRUBBABLE;
      const parsed = parseBoundedJson(scalar);
      if (!parsed.ok) return parsed.reason === "invalid_json" ? scalar : UNSCRUBBABLE;
      const scrubbed = scrubNestedKeys(parsed.value);
      const original = JSON.stringify(parsed.value);
      const cleaned = JSON.stringify(scrubbed);
      return original === cleaned ? scalar : (cleaned ?? null);
    }
    return scalar;
  }
  if (typeof raw !== "object") return null;
  try {
    return JSON.stringify(scrubNestedKeys(raw)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Project one input. The name, label and type are always kept (bounded,
 * controls stripped). The value is redacted, in this order, when inputs were
 * not requested, the element is not showable, the name or label is
 * sensitive, or the type is sensitive. Otherwise the display value is
 * preferred, nested JSON is scrubbed, and the value is cut to
 * MAX_INPUT_VALUE_CHARS with `original_length`.
 */
export function policyInput(
  plan: FlowFieldPlan,
  element: FlowValueElementKey,
  raw: {
    name: unknown;
    label?: unknown;
    type?: unknown;
    value?: unknown;
    displayValue?: unknown;
    script?: boolean;
  }
): FlowInputValue {
  const nameText = scalarText(raw.name) ?? "";
  const output: FlowInputValue = {
    name: cut(stripAllControls(nameText).trim(), FLOW_VIEW_LIMITS.MAX_NAME_CHARS),
    label: optionalLine(raw.label, FLOW_VIEW_LIMITS.MAX_TITLE_CHARS),
    type: optionalLine(raw.type, FLOW_VIEW_LIMITS.MAX_NAME_CHARS),
    value: null,
  };
  if (raw.script === true) output.script = true;

  const redacted = redactionFor(plan, element, nameText, raw.label, raw.type);
  if (redacted) {
    output.redacted = redacted;
    return output;
  }
  const display = inputValueText(raw.displayValue);
  const text =
    display === UNSCRUBBABLE || (display !== null && display.trim() !== "") ? display : inputValueText(raw.value);
  if (text === UNSCRUBBABLE) {
    // Nested JSON past the decoder's bounds: shown as withheld, never raw.
    output.redacted = "limit";
    return output;
  }
  if (text === null) return output;
  const bounded = boundedText(text, FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS);
  output.value = bounded.text;
  if (bounded.original_length !== undefined) output.original_length = bounded.original_length;
  return output;
}

function redactionFor(
  plan: FlowFieldPlan,
  element: FlowValueElementKey,
  name: string,
  label: unknown,
  type: unknown
): RedactionReason | undefined {
  if (!inputsIncluded(plan)) return "not_requested";
  if (!canShow(plan, element)) return "field_policy";
  // A name with no ASCII identifier is unrecognizable: fail closed. A label
  // in a non-Latin script is common (localized), so it does not decide.
  if (isSensitivePolicyName(name, true)) return "sensitive_name";
  if (isSensitivePolicyName(scalarText(label) ?? "", false)) return "sensitive_name";
  if (isSensitiveType(type)) return "sensitive_type";
  return undefined;
}

// ---------------------------------------------------------------------------
// Nested JSON
// ---------------------------------------------------------------------------

interface ScrubState {
  nodes: number;
}

/**
 * Copy a decoded JSON value, dropping sensitive-named keys and the value of
 * any `{name: "<sensitive>", value: …}` pair. Bounded by
 * MAX_DECODED_JSON_DEPTH and MAX_DECODED_JSON_NODES: deeper values become
 * `null`, and entries past the node budget are omitted. Proxies, accessors,
 * non-plain objects and non-JSON values are dropped.
 */
export function scrubNestedKeys(value: unknown): unknown {
  return scrub(value, { nodes: 0 }, 0);
}

function scrub(value: unknown, state: ScrubState, depth: number): unknown {
  state.nodes += 1;
  if (state.nodes > FLOW_VIEW_LIMITS.MAX_DECODED_JSON_NODES) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return undefined;
  if (depth >= FLOW_VIEW_LIMITS.MAX_DECODED_JSON_DEPTH) return null;
  if (nodeUtilTypes.isProxy(value)) return null;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.nodes >= FLOW_VIEW_LIMITS.MAX_DECODED_JSON_NODES) break;
      const item = scrub(ownData(value, String(index)), state, depth + 1);
      output.push(item === undefined ? null : item);
    }
    return output;
  }

  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return null;
  }
  const pairIsSensitive = PAIR_NAME_KEYS.some((key) => {
    const pairName = ownData(value, key);
    return typeof pairName === "string" && isSensitivePolicyName(pairName, false);
  });
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (state.nodes >= FLOW_VIEW_LIMITS.MAX_DECODED_JSON_NODES) break;
    if (isSensitivePolicyName(key, true)) continue;
    if (pairIsSensitive && PAIR_VALUE_KEYS.includes(key)) continue;
    const item = scrub(ownData(value, key), state, depth + 1);
    if (item === undefined) continue;
    Object.defineProperty(output, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}
