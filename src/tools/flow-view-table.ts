/**
 * Table API loader for `sn_flow_view`, the only flow source.
 *
 * Reads the `sys_hub_*` closure of one flow through `/api/now/table/<table>`
 * GETs only, sequentially and in a fixed order, and returns a
 * NormalizedFlowDefinition whose every value has already passed the
 * flow-view field policy. Flow Designer's internal ProcessFlow API is never
 * called: its flow GET writes a Workflow Studio history row.
 *
 * Reads for one flow load (each: `sysparm_exclude_reference_link=true`,
 * `sysparm_limit=501` sentinel; `sysparm_display_value=all` unless noted).
 * Independent reads are issued together and the client bounds how many run
 * at once; results are always processed in this fixed order:
 *   wave 1, together:
 *     0. `sys_hub_flow` label_cache, raw (only with inputs, and only when the
 *        caller did not already read it with the header)
 *     1. trigger V1, trigger V2
 *     2. action V1, action V2; logic V1, logic V2; subflow V1, subflow V2
 *     3. flow variables, inputs, outputs (`model=<flow>`)
 *   wave 2, together, each only when there is something to look up:
 *     4. `sys_hub_flow_snapshot` by `sys_idIN` for subflow call targets
 *     5. the compressed value column of each non-empty V2 table, raw
 *        (`sysparm_display_value=false`: its display value is the same
 *        blob, which would double the bytes)
 *     6. `sys_variable_value` by `document_keyIN<≤100 ids>` (V1 values),
 *        paged with `sysparm_offset`, then `var_dictionary` by
 *        `sys_idIN<≤100 ids>` (V1 input names and types)
 * Reads 0, 5 and 6 happen only with `include_inputs`. A missing `_v2` table
 * (HTTP 400) reads as zero rows.
 *
 * @module tools/flow-view-table
 */

import type { ServiceNowOperations } from "../client.js";
import { filterReadableRecord, isSensitiveFieldName } from "../field-policy.js";
import { uncachedOperations } from "../metadata-cache.js";
import { serviceNowSysIdSchema } from "../servicenow-identifiers.js";
import { createToolError, trustedToolErrorDescriptor } from "../tool-error.js";
import { escapeQueryValue } from "../utils.js";
import {
  FLOW_GRAPH_SCHEMA_BOUNDS,
  FLOW_TABLE_FIELDS,
  FLOW_VIEW_LIMITS,
  FLOW_VIEW_MAX_FLOW_SELECTOR_CHARS,
  flowLogicKindFromName,
  rawFlowContentSchema,
  rawFlowInputListSchema,
  rawFlowInputSchema,
  rawFlowLogicValuesSchema,
  rawFlowUidSchema,
  rawLabelCacheEntrySchema,
  type FlowElementKey,
  type FlowInputValue,
  type FlowLimitHit,
  type FlowLogicKind,
  type FlowTableName,
  type FlowText,
  type FlowTrigger,
  type FlowValueElementKey,
  type FlowVariableDef,
  type FlowWarningCode,
  type NormalizedFlowDefinition,
  type NormalizedStep,
} from "./flow-view-contracts.js";
import {
  canShow,
  inputsIncluded,
  policyInput,
  policyText,
  sysparmFieldsFor,
  type FlowFieldPlan,
} from "./flow-view-policy.js";
import {
  createDecompressionBudget,
  decodeCompressedJson,
  parseBoundedJson,
  type DecompressionBudget,
} from "./flow-view-gzip.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FlowHeaderRecord = NormalizedFlowDefinition["header"];

export type FlowRecordResolution =
  | {
      status: "found";
      header: FlowHeaderRecord;
      /**
       * Raw `label_cache` text, present only when it was requested with
       * `withLabelCache` (by-sys_id lookups with inputs on and pill labels
       * readable); pass it on to `loadFlowFromTables` to skip that read.
       */
      label_cache?: string;
    }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: string[] /* ≤ 5 sys_ids */ };

export type FlowRecordSelector = { sys_id: string } | { name: string };

export interface TableLoadOptions {
  include_inputs: boolean;
  /** `label_cache` already read with the header (see `resolveFlowRecord`). */
  label_cache?: string;
}

export interface FlowRecordOptions {
  /**
   * Read `label_cache` in the same by-sys_id request, saving the loader one
   * read. Honoured only for a sys_id selector, with inputs on and pill labels
   * readable; a name lookup can match up to six rows, so it never asks.
   */
  withLabelCache?: { include_inputs: boolean };
}

/** Rows kept per table read; one more is requested as the overflow sentinel. */
export const FLOW_TABLE_ROW_LIMIT = FLOW_VIEW_LIMITS.MAX_ROWS_PER_TABLE;
/** Exact-name lookups request this many rows (5 candidates + 1). */
export const FLOW_NAME_LOOKUP_LIMIT = 6;
/** Most sys_ids reported for an ambiguous name. */
export const FLOW_AMBIGUOUS_CANDIDATES = 5;
/** Entries kept from one flow's label_cache. */
export const FLOW_LABEL_CACHE_MAX_ENTRIES = 1_000;
/** Longest label_cache JSON text parsed (plain JSON, not gzip). */
export const FLOW_LABEL_CACHE_MAX_CHARS = FLOW_VIEW_LIMITS.MAX_GZIP_OUTPUT_BYTES;
/**
 * Of a load's 1 MiB response scope, the most that its wave-1 reads plus its
 * V1 value reads may use; the rest is left for the `var_dictionary` reads
 * that follow and for estimate error. V1 value reads (every page of every
 * chunk after the first) stop when the next one, assumed as large as the
 * last, would pass it, and report `input_values_incomplete`. A flow with
 * very many V1 values then keeps the values it read instead of overflowing
 * its scope and losing all of them to the retry without inputs.
 */
const V1_VALUE_SCOPE_BYTES = 896 * 1024;

/** Name of the input that marks a blob that could not be decoded. */
const DECODE_FAILED_NAMES = Object.freeze({
  values: "values",
  trigger_inputs: "trigger_inputs",
  subflow_inputs: "subflow_inputs",
} as const);

/**
 * Resolve the `sys_hub_flow` record for a selector.
 *
 * - `sys_id`: `sys_id=<hex>^typeINflow,subflow`.
 * - `name`: `name=<escaped>^typeINflow,subflow^ORDERBYsys_id` with
 *   `sysparm_limit=6`, then an exact, case-sensitive post-filter. A name that
 *   contains `^` cannot match (`escapeQueryValue` strips it, and the
 *   post-filter compares the original text).
 *
 * The header is policy-projected. `label_cache` is requested only with
 * `withLabelCache` on a sys_id selector.
 */
export async function resolveFlowRecord(
  ops: ServiceNowOperations,
  plan: FlowFieldPlan,
  selector: FlowRecordSelector,
  options: FlowRecordOptions = {}
): Promise<FlowRecordResolution> {
  const reader = uncachedOperations(ops);
  let fields = fieldsFor(plan, "sys_hub_flow", { exclude: ["label_cache"] });
  let withLabels = false;
  let matches: Row[];
  if (isSysIdSelector(selector)) {
    const id = sysIdOf(selector.sys_id);
    if (id === null) return { status: "not_found" };
    withLabels =
      options.withLabelCache?.include_inputs === true &&
      inputsIncluded(plan) &&
      canShow(plan, "pill_labels");
    if (withLabels) fields = `${fields},label_cache`;
    const { rows } = await readTable(reader, "sys_hub_flow", `sys_id=${id}^typeINflow,subflow`, fields, {
      maxRows: 1,
    });
    matches = rows.filter((row) => sysIdOf(scalar(row.sys_id)) === id && isFlowType(row));
  } else {
    const name = typeof selector.name === "string" ? selector.name : "";
    if (name.trim() === "" || name.length > FLOW_VIEW_MAX_FLOW_SELECTOR_CHARS) {
      return { status: "not_found" };
    }
    const { rows } = await readTable(
      reader,
      "sys_hub_flow",
      `name=${escapeQueryValue(name)}^typeINflow,subflow^ORDERBYsys_id`,
      fields,
      { maxRows: FLOW_NAME_LOOKUP_LIMIT - 1 }
    );
    matches = rows.filter(
      (row) => scalar(row.name) === name && isFlowType(row) && sysIdOf(scalar(row.sys_id)) !== null
    );
  }
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) {
    const candidates = matches
      .map((row) => sysIdOf(scalar(row.sys_id)))
      .filter((id): id is string => id !== null);
    return { status: "ambiguous", candidates: [...new Set(candidates)].slice(0, FLOW_AMBIGUOUS_CANDIDATES) };
  }
  const row = matches[0]!;
  const header = headerFrom(plan, row, sysIdOf(scalar(row.sys_id))!);
  return withLabels ? { status: "found", header, label_cache: scalar(row.label_cache) } : { status: "found", header };
}

/**
 * The flow a subflow call targets. `sys_hub_sub_flow_instance(_v2).subflow`
 * references a `sys_hub_flow_snapshot` row; its `parent_flow` is the flow.
 * Returns null when the reference is not a sys_id, the snapshot is not
 * readable or not found, or its parent is not a sys_id.
 */
export async function resolveSubflowTarget(
  ops: ServiceNowOperations,
  plan: FlowFieldPlan,
  ref: string
): Promise<string | null> {
  const id = sysIdOf(ref);
  if (id === null) return null;
  const targets = await resolveSubflowTargets(uncachedOperations(ops), plan, [id]);
  return targets.get(id) ?? null;
}

/**
 * Load one flow's definition from the Table API. Every value is projected
 * through the flow-view policy before it is returned. Decoding failures
 * never throw; they mark the affected inputs `decode_failed`. Upstream
 * errors (other than a missing `_v2` table) and cancellations propagate.
 */
export async function loadFlowFromTables(
  ops: ServiceNowOperations,
  header: FlowHeaderRecord,
  plan: FlowFieldPlan,
  options: TableLoadOptions
): Promise<NormalizedFlowDefinition> {
  const flowId = sysIdOf(header?.sys_id);
  if (flowId === null) throw createToolError("internal", "do_not_retry");
  const reader = uncachedOperations(ops);
  const load: LoadState = {
    plan,
    reader,
    flowId,
    includeInputs: options?.include_inputs === true && inputsIncluded(plan),
    budget: createDecompressionBudget(),
    warnings: new Set(),
    limits: new Set(),
    dropped: 0,
    blobs: new Map(),
    readBytes: 0,
  };
  const knownLabels = typeof options?.label_cache === "string" ? options.label_cache : undefined;

  // Wave 1: every read that depends only on the flow id, issued together.
  const triggerTables = ["sys_hub_trigger_instance", "sys_hub_trigger_instance_v2"] as const;
  const [labelText, triggerReads, stepReads, variableReads] = await Promise.all([
    load.includeInputs && knownLabels === undefined ? readLabelCacheText(load) : Promise.resolve(knownLabels),
    Promise.all(triggerTables.map((table) => readTriggerTable(load, table))),
    Promise.all(
      STEP_SPECS.map((spec) =>
        readTable(
          reader,
          spec.table,
          `flow=${flowId}^ORDERBYorder^ORDERBYsys_id`,
          fieldsFor(plan, spec.table, { values: false }),
          { missingIsEmpty: spec.v2 }
        )
      )
    ),
    readVariableTables(load),
  ]);

  load.readBytes =
    Buffer.byteLength(labelText ?? "") +
    [...triggerReads, ...stepReads, ...variableReads].reduce((sum, read) => sum + (read?.bytes ?? 0), 0);

  // 0. Pill labels.
  const labelCache = load.includeInputs ? parseLabelCache(load, labelText) : [];

  // 1. Trigger.
  const triggerRows = collectTriggerRows(load, triggerTables, triggerReads);

  // 2. Steps.
  const steps = new Map<string, RawStep>();
  STEP_SPECS.forEach((spec, index) => {
    const { rows, truncated } = stepReads[index]!;
    if (truncated) load.limits.add("rows_per_table");
    for (const row of rows) addStep(load, steps, spec, row);
  });
  normalizeStructure(load, steps);

  // 3. Flow variables, inputs and outputs.
  const variables = collectVariables(load, variableReads);

  // Trigger choice: V2 over V1, first row of each.
  const trigger = triggerRows.v2[0] ?? triggerRows.v1[0];

  // Wave 2: lookups keyed by what wave 1 returned, issued together.
  const snapshotIds = [...steps.values()]
    .map((step) => (step.spec.kind === "subflow" ? sysIdOf(scalar(step.row.subflow)) : null))
    .filter((id): id is string => id !== null);
  const v1Documents = [
    ...(trigger && !trigger.v2 ? [{ table: trigger.table, sysId: trigger.sysId }] : []),
    ...[...steps.values()].filter((step) => !step.spec.v2).map((step) => ({ table: step.spec.table, sysId: step.sysId })),
  ];
  const blobTables = load.includeInputs ? blobReadsFor(load, triggerRows, steps) : [];
  const [targets, blobReads, v1Values] = await Promise.all([
    snapshotIds.length > 0 ? resolveSubflowTargets(reader, plan, snapshotIds) : Promise.resolve(new Map<string, string>()),
    Promise.all(blobTables.map((blob) => readBlobColumn(load, blob))),
    load.includeInputs ? readV1Values(load, v1Documents) : Promise.resolve(new Map<string, RawInput[]>()),
  ]);
  blobTables.forEach((blob, index) => {
    const { rows, truncated } = blobReads[index]!;
    if (truncated) load.limits.add("rows_per_table");
    for (const row of rows) {
      const sysId = sysIdOf(scalar(row.sys_id));
      if (sysId !== null) load.blobs.set(`${blob.table}:${sysId}`, scalar(row[blob.column]));
    }
  });

  // Blobs decode in display order (trigger, then steps by order), sharing one budget.
  const normalizedTrigger = trigger ? assembleTrigger(load, trigger, v1Values) : null;
  const normalizedSteps = assembleSteps(load, steps, targets, v1Values);

  return {
    source: "table",
    header,
    trigger: normalizedTrigger,
    steps: normalizedSteps,
    label_cache: labelCache,
    variables,
    warnings: [...load.warnings].slice(0, FLOW_VIEW_LIMITS.MAX_WARNINGS),
    limits_hit: [...load.limits],
    items_dropped: load.dropped,
  };
}

/**
 * Parse a step `order`. V2 orders are integers; V1 orders can be arrow paths
 * such as `2➛3` (the parent's order, then the step's own), whose last number
 * orders the step. Anything else is null; the step is kept.
 */
export function parseFlowOrder(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (text === "" || text.length > MAX_ORDER_CHARS) return null;
  if (/^-?\d{1,15}(?:\.\d{1,6})?$/u.test(text)) return Number(text);
  const path = /^\d{1,15}(?:\s*➛\s*\d{1,15})+$/u;
  if (!path.test(text)) return null;
  const parts = text.split("➛");
  return Number(parts[parts.length - 1]!.trim());
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const TABLE_PATH = "/api/now/table/";
const MAX_ORDER_CHARS = 64;
const SHORT_TEXT_CHARS = FLOW_GRAPH_SCHEMA_BOUNDS.MAX_SHORT_CHARS;
const CONDITION_KINDS: ReadonlySet<FlowLogicKind> = new Set(["if", "else_if", "do_until"]);
const BRANCH_KINDS: ReadonlySet<FlowLogicKind> = new Set(["else", "else_if", "catch"]);
const BRANCH_HEAD_KINDS: ReadonlySet<FlowLogicKind> = new Set(["if", "try"]);
const ROOT_KINDS: ReadonlySet<FlowLogicKind> = new Set(["top_level_try", "top_level_catch"]);
const TRIGGER_TABLE_INPUTS = Object.freeze(["table"]);
const TRIGGER_CONDITION_INPUTS = Object.freeze(["condition"]);
/** Best effort: no scheduled trigger was captured. */
const TRIGGER_SCHEDULE_INPUTS = Object.freeze(["schedule", "run_in", "repeat", "run_at", "run_time", "time"]);
const LOGIC_CONDITION_INPUTS = Object.freeze(["condition_name", "condition"]);

type StepTable =
  | "sys_hub_action_instance"
  | "sys_hub_action_instance_v2"
  | "sys_hub_flow_logic"
  | "sys_hub_flow_logic_instance_v2"
  | "sys_hub_sub_flow_instance"
  | "sys_hub_sub_flow_instance_v2";

type TriggerTable = "sys_hub_trigger_instance" | "sys_hub_trigger_instance_v2";

interface StepSpec {
  readonly table: StepTable;
  readonly kind: NormalizedStep["kind"];
  readonly v2: boolean;
  readonly valueColumn: "values" | "subflow_inputs" | null;
  readonly valueShape: "list" | "logic";
  readonly inputs: FlowValueElementKey;
  readonly title: FlowElementKey;
  readonly annotation: FlowElementKey;
}

function stepSpec(
  table: StepTable,
  kind: StepSpec["kind"],
  v2: boolean,
  valueColumn: StepSpec["valueColumn"]
): StepSpec {
  const names = {
    action: ["action_inputs", "action_title", "action_annotation"],
    logic: ["logic_inputs", "logic_title", "logic_annotation"],
    subflow: ["subflow_inputs", "subflow_title", "subflow_annotation"],
  } as const;
  const [inputs, title, annotation] = names[kind];
  return Object.freeze({
    table,
    kind,
    v2,
    valueColumn,
    valueShape: kind === "logic" ? "logic" : "list",
    inputs,
    title,
    annotation,
  });
}

/** Fixed read order: action, logic, subflow; V1 before V2. */
const STEP_SPECS: readonly StepSpec[] = Object.freeze([
  stepSpec("sys_hub_action_instance", "action", false, null),
  stepSpec("sys_hub_action_instance_v2", "action", true, "values"),
  stepSpec("sys_hub_flow_logic", "logic", false, null),
  stepSpec("sys_hub_flow_logic_instance_v2", "logic", true, "values"),
  stepSpec("sys_hub_sub_flow_instance", "subflow", false, null),
  stepSpec("sys_hub_sub_flow_instance_v2", "subflow", true, "subflow_inputs"),
]);

interface LoadState {
  readonly plan: FlowFieldPlan;
  readonly reader: ServiceNowOperations;
  readonly flowId: string;
  readonly includeInputs: boolean;
  readonly budget: DecompressionBudget;
  readonly warnings: Set<FlowWarningCode>;
  readonly limits: Set<FlowLimitHit>;
  dropped: number;
  /** Raw V2 value blobs by `<table>:<sys_id>`, read without display values. */
  readonly blobs: Map<string, string>;
  /**
   * Estimated response bytes of this load's wave-1 reads, then of its V1
   * value reads (JSON of each response's rows); see V1_VALUE_SCOPE_BYTES.
   * Concurrent wave-2 reads are not counted, so the result stays
   * deterministic.
   */
  readBytes: number;
}

interface RawStep {
  readonly spec: StepSpec;
  readonly row: Row;
  readonly sysId: string;
  readonly uid: string;
  parentUid: string | null;
  connectedUid: string | null;
  readonly order: number | null;
  readonly logicKind: FlowLogicKind | undefined;
}

interface TriggerRow {
  readonly table: TriggerTable;
  readonly v2: boolean;
  readonly row: Row;
  readonly sysId: string;
}

/** One V1 value with its definition, ready for policyInput. */
interface RawInput {
  readonly name: unknown;
  readonly label: unknown;
  readonly type: unknown;
  readonly value: unknown;
  readonly displayValue: unknown;
  readonly script?: boolean;
}

function isSysIdSelector(selector: FlowRecordSelector): selector is { sys_id: string } {
  return typeof selector === "object" && selector !== null && Object.hasOwn(selector, "sys_id");
}

function ownData(candidate: unknown, key: string): unknown {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function scalarText(candidate: unknown): string | null {
  if (typeof candidate === "string") return candidate;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  if (typeof candidate === "boolean") return String(candidate);
  return null;
}

/** The internal value of a cell: `value` of a `{value, display_value}` pair, or the scalar. */
function scalar(cell: unknown): string {
  const direct = scalarText(cell);
  if (direct !== null) return direct;
  return scalarText(ownData(cell, "value")) ?? "";
}

/** The display value of a cell, falling back to its value. */
function display(cell: unknown): string {
  const direct = scalarText(cell);
  if (direct !== null) return direct;
  const shown = scalarText(ownData(cell, "display_value"));
  return shown !== null && shown !== "" ? shown : scalar(cell);
}

/** The display value of a cell only; null when it is empty. */
function displayOnly(cell: unknown): string | null {
  const shown = scalarText(cell) ?? scalarText(ownData(cell, "display_value"));
  return shown === null || shown.trim() === "" ? null : shown;
}

/** A content cell, validated by the shared raw schema; null when it does not parse. */
function content(cell: unknown): unknown {
  const parsed = rawFlowContentSchema.safeParse(cell === undefined ? null : cell);
  return parsed.success ? parsed.data : null;
}

function sysIdOf(candidate: unknown): string | null {
  const parsed = serviceNowSysIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function uidOf(candidate: string): string | null {
  const parsed = rawFlowUidSchema.safeParse(candidate);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

function isFlowType(row: Row): boolean {
  const type = scalar(row.type);
  return type === "flow" || type === "subflow";
}

/** Control-free, trimmed, cut single line; null when empty. */
function line(text: string | null, max: number): string | null {
  if (text === null) return null;
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/gu, "").trim();
  if (clean === "") return null;
  if (clean.length <= max) return clean;
  const last = clean.charCodeAt(max - 1);
  return clean.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * `sysparm_fields` for one table: the prepared readable set (via
 * sysparmFieldsFor), minus value fields when inputs are not requested, or the
 * subset of `only` that is readable.
 */
function fieldsFor(
  plan: FlowFieldPlan,
  table: FlowTableName,
  options: { values?: boolean; exclude?: readonly string[]; only?: readonly string[] } = {}
): string {
  const spec = FLOW_TABLE_FIELDS[table];
  const readable = plan.readable.get(table);
  if (options.only) {
    const fields = options.only.filter((field) => readable?.has(field) === true && !isSensitiveFieldName(field));
    if (fields.length !== options.only.length) throw createToolError("internal", "do_not_retry");
    return fields.join(",");
  }
  const excluded = new Set([...(options.exclude ?? []), ...(options.values === false ? spec.values : [])]);
  const fields = sysparmFieldsFor(plan, table)
    .split(",")
    .filter((field) => !excluded.has(field));
  if (fields.length === 0) throw createToolError("internal", "do_not_retry");
  return fields.join(",");
}

/**
 * A trusted upstream rejection that is neither a 5xx nor one of the mapped
 * 4xx statuses: what the Table API returns (HTTP 400) for a table that does
 * not exist. The client exposes only the category, so this is the narrowest
 * test available without the status. An error with a `reason` (a 200 body
 * that is not JSON, an HTML page, a redirect, a hibernating instance) is a
 * bad response, not a missing table: it fails the call instead of silently
 * dropping that table's steps.
 */
function isMissingTableError(error: unknown): boolean {
  const descriptor = trustedToolErrorDescriptor(error);
  return (
    descriptor?.category === "upstream" &&
    descriptor.retry === "do_not_retry" &&
    descriptor.reason === undefined
  );
}

interface ReadResult {
  rows: Row[];
  truncated: boolean;
  /** Estimated response size: the JSON of the response's result rows. */
  bytes: number;
}

/**
 * One Table API read. Requests `maxRows + 1` rows: an extra row means the
 * table has more than the bound, reported as `truncated` (the extra row is
 * discarded). Rows pass `filterReadableRecord` against the requested fields.
 */
async function readTable(
  reader: ServiceNowOperations,
  table: FlowTableName,
  query: string,
  fields: string,
  options: { maxRows?: number; missingIsEmpty?: boolean; raw?: boolean; offset?: number } = {}
): Promise<ReadResult> {
  const maxRows = options.maxRows ?? FLOW_TABLE_ROW_LIMIT;
  let response: unknown;
  try {
    response = await reader.get(`${TABLE_PATH}${table}`, {
      sysparm_query: query,
      sysparm_fields: fields,
      sysparm_display_value: options.raw === true ? "false" : "all",
      sysparm_exclude_reference_link: "true",
      sysparm_limit: String(maxRows + 1),
      ...(options.offset !== undefined && options.offset > 0 ? { sysparm_offset: String(options.offset) } : {}),
    });
  } catch (error) {
    if (options.missingIsEmpty === true && isMissingTableError(error)) {
      return { rows: [], truncated: false, bytes: 0 };
    }
    throw error;
  }
  const result = ownData(response, "result");
  if (!Array.isArray(result)) throw createToolError("upstream", "do_not_retry");
  const bytes = Buffer.byteLength(JSON.stringify(result));
  const filtered = filterReadableRecord(result, fields.split(","));
  if (!Array.isArray(filtered)) throw createToolError("upstream", "do_not_retry");
  const rows = filtered.filter(
    (row): row is Row => typeof row === "object" && row !== null && !Array.isArray(row)
  );
  return rows.length > maxRows
    ? { rows: rows.slice(0, maxRows), truncated: true, bytes }
    : { rows, truncated: false, bytes };
}

/**
 * Sort clause for a table whose `order` column is optional: by `order` only
 * when the profile may read it, so a hidden column cannot leak through the
 * order of the results; by `sys_id` alone otherwise.
 */
function orderBy(plan: FlowFieldPlan, table: FlowTableName): string {
  return plan.readable.get(table)?.has("order") === true ? "ORDERBYorder^ORDERBYsys_id" : "ORDERBYsys_id";
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function drop(load: LoadState): null {
  load.dropped += 1;
  load.warnings.add("items_dropped_invalid");
  return null;
}

// --- Header ----------------------------------------------------------------

function shortText(plan: FlowFieldPlan, element: FlowElementKey, raw: unknown): string | null {
  return line(policyText(plan, element, raw, SHORT_TEXT_CHARS).text, SHORT_TEXT_CHARS);
}

function headerFrom(plan: FlowFieldPlan, row: Row, sysId: string): FlowHeaderRecord {
  const type = scalar(row.type);
  const active = scalar(row.active);
  return {
    sys_id: sysId,
    name: policyText(plan, "flow_name", content(row.name), FLOW_VIEW_LIMITS.MAX_TITLE_CHARS),
    description: policyText(
      plan,
      "flow_description",
      content(row.description),
      FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS
    ),
    type: canShow(plan, "flow_type") && (type === "flow" || type === "subflow") ? type : null,
    active: canShow(plan, "flow_active") ? (active === "true" ? true : active === "false" ? false : null) : null,
    status: shortText(plan, "flow_status", scalar(row.status)),
    version: shortText(plan, "flow_version", scalar(row.version)),
    scope: shortText(plan, "flow_scope", content(row.sys_scope)),
  };
}

// --- Label cache -------------------------------------------------------------

/** The raw `label_cache` text; undefined when pill labels are not readable. */
async function readLabelCacheText(load: LoadState): Promise<string | undefined> {
  if (!canShow(load.plan, "pill_labels")) return undefined;
  const { rows } = await readTable(
    load.reader,
    "sys_hub_flow",
    `sys_id=${load.flowId}`,
    fieldsFor(load.plan, "sys_hub_flow", { only: ["sys_id", "label_cache"] }),
    // The display value of label_cache is the same JSON text.
    { maxRows: 1, raw: true }
  );
  const row = rows.find((candidate) => sysIdOf(scalar(candidate.sys_id)) === load.flowId);
  return row ? scalar(row.label_cache) : "";
}

function parseLabelCache(load: LoadState, text: string | undefined): (readonly [string, string])[] {
  const { plan } = load;
  if (text === undefined || !canShow(plan, "pill_labels")) {
    load.warnings.add("label_cache_unavailable");
    return [];
  }
  if (text.trim() === "") return [];
  const parsed = text.length > FLOW_LABEL_CACHE_MAX_CHARS ? null : parseBoundedJson(text);
  if (!parsed?.ok || !Array.isArray(parsed.value)) {
    load.warnings.add("label_cache_unavailable");
    return [];
  }
  const output: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.value) {
    const item = rawLabelCacheEntrySchema.safeParse(entry);
    if (!item.success) {
      drop(load);
      continue;
    }
    const token = line(item.data.name, Number.MAX_SAFE_INTEGER);
    if (token === null || token.length > FLOW_GRAPH_SCHEMA_BOUNDS.MAX_PILL_TOKEN_CHARS) {
      drop(load);
      continue;
    }
    if (seen.has(token)) continue;
    const label = line(
      policyText(plan, "pill_labels", item.data.label ?? null, FLOW_VIEW_LIMITS.MAX_PILL_LABEL_CHARS).text,
      FLOW_VIEW_LIMITS.MAX_PILL_LABEL_CHARS
    );
    if (label === null) continue;
    if (output.length >= FLOW_LABEL_CACHE_MAX_ENTRIES) {
      load.limits.add("pills");
      break;
    }
    seen.add(token);
    output.push(Object.freeze([token, label] as const));
  }
  return output;
}

// --- Triggers ----------------------------------------------------------------

function readTriggerTable(load: LoadState, table: TriggerTable): Promise<ReadResult> {
  return readTable(
    load.reader,
    table,
    `flow=${load.flowId}^ORDERBYsys_id`,
    fieldsFor(load.plan, table, { values: false }),
    { missingIsEmpty: table.endsWith("_v2") }
  );
}

function collectTriggerRows(
  load: LoadState,
  tables: readonly [TriggerTable, TriggerTable],
  reads: readonly ReadResult[]
): { v1: TriggerRow[]; v2: TriggerRow[] } {
  const output: { v1: TriggerRow[]; v2: TriggerRow[] } = { v1: [], v2: [] };
  for (const [index, table] of tables.entries()) {
    const v2 = table.endsWith("_v2");
    const { rows, truncated } = reads[index]!;
    if (truncated) load.limits.add("rows_per_table");
    for (const row of rows) {
      const sysId = sysIdOf(scalar(row.sys_id));
      if (sysId === null || sysIdOf(scalar(row.flow)) !== load.flowId) {
        drop(load);
        continue;
      }
      (v2 ? output.v2 : output.v1).push({ table, v2, row, sysId });
    }
  }
  return output;
}

function assembleTrigger(
  load: LoadState,
  trigger: TriggerRow,
  v1Values: ReadonlyMap<string, RawInput[]>
): Omit<FlowTrigger, "node_id"> {
  const { plan } = load;
  const output: Omit<FlowTrigger, "node_id"> = {
    type: policyText(plan, "trigger_type", content(trigger.row.trigger_type), FLOW_VIEW_LIMITS.MAX_TITLE_CHARS),
    table: notRequested(),
    condition: notRequested(),
    schedule: notRequested(),
  };
  if (!load.includeInputs) return output;
  const inputs = trigger.v2
    ? decodeInputs(load, load.blobs.get(`${trigger.table}:${trigger.sysId}`), "list", "trigger_inputs", "trigger_inputs")
    : projectV1(load, "trigger_inputs", v1Values.get(trigger.sysId) ?? []);
  output.inputs = inputs;
  output.table = fromInputs(plan, "trigger_inputs", inputs, TRIGGER_TABLE_INPUTS, FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS);
  output.condition = fromInputs(
    plan,
    "trigger_inputs",
    inputs,
    TRIGGER_CONDITION_INPUTS,
    FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS
  );
  output.schedule = fromInputs(
    plan,
    "trigger_inputs",
    inputs,
    TRIGGER_SCHEDULE_INPUTS,
    FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS
  );
  return output;
}

/** The FlowText for a value element when inputs were not requested. */
function notRequested(): FlowText {
  return { text: null, redacted: "not_requested" };
}

/**
 * Text derived from an already-projected input, carrying its redaction. The
 * first named input with a value wins; a redacted one is reported as such.
 */
function fromInputs(
  plan: FlowFieldPlan,
  element: FlowValueElementKey,
  inputs: readonly FlowInputValue[],
  names: readonly string[],
  maxChars: number
): FlowText {
  for (const name of names) {
    const input = inputs.find((candidate) => candidate.name === name);
    if (!input) continue;
    if (input.redacted) return { text: null, redacted: input.redacted };
    const text = line(input.value, Number.MAX_SAFE_INTEGER);
    if (text === null) continue;
    if (text.length <= maxChars && input.original_length === undefined) return { text };
    return { text: line(text, maxChars)!, original_length: input.original_length ?? text.length };
  }
  return canShow(plan, element) ? { text: null } : { text: null, redacted: "field_policy" };
}

// --- Compressed value columns --------------------------------------------------

interface BlobRead {
  readonly table: TriggerTable | StepTable;
  readonly column: "trigger_inputs" | "values" | "subflow_inputs";
  readonly query: string;
}

/**
 * One raw read per V2 table that returned rows and whose value column is
 * readable. The structural reads leave the column out, because with
 * `sysparm_display_value=all` it would come back twice.
 */
function blobReadsFor(
  load: LoadState,
  triggers: { v2: readonly TriggerRow[] },
  steps: ReadonlyMap<string, RawStep>
): BlobRead[] {
  const readable = (table: FlowTableName, column: string) => load.plan.readable.get(table)?.has(column) === true;
  const output: BlobRead[] = [];
  if (triggers.v2.length > 0 && readable("sys_hub_trigger_instance_v2", "trigger_inputs")) {
    output.push({
      table: "sys_hub_trigger_instance_v2",
      column: "trigger_inputs",
      query: `flow=${load.flowId}^ORDERBYsys_id`,
    });
  }
  const kept = new Set([...steps.values()].map((step) => step.spec.table));
  for (const spec of STEP_SPECS) {
    if (spec.valueColumn === null || !kept.has(spec.table) || !readable(spec.table, spec.valueColumn)) continue;
    output.push({
      table: spec.table,
      column: spec.valueColumn,
      query: `flow=${load.flowId}^ORDERBYorder^ORDERBYsys_id`,
    });
  }
  return output;
}

function readBlobColumn(load: LoadState, blob: BlobRead): Promise<ReadResult> {
  return readTable(
    load.reader,
    blob.table,
    blob.query,
    fieldsFor(load.plan, blob.table, { only: ["sys_id", blob.column] }),
    { raw: true }
  );
}

// --- Steps -------------------------------------------------------------------

function addStep(load: LoadState, steps: Map<string, RawStep>, spec: StepSpec, row: Row): void {
  const sysId = sysIdOf(scalar(row.sys_id));
  const uid = uidOf(scalar(row.ui_id));
  if (sysId === null || uid === null || sysIdOf(scalar(row.flow)) !== load.flowId) {
    drop(load);
    return;
  }
  const parentText = scalar(row.parent_ui_id).trim();
  const parentUid = parentText === "" ? null : uidOf(parentText);
  if (parentText !== "" && parentUid === null) {
    drop(load);
    return;
  }
  let logicKind: FlowLogicKind | undefined;
  let connectedUid: string | null = null;
  if (spec.kind === "logic") {
    logicKind = canShow(load.plan, "logic_title") ? flowLogicKindFromName(display(row.logic_definition)) : "other";
    if (logicKind === "other") load.warnings.add("unknown_logic_type");
    const connectedText = scalar(row.connected_to).trim();
    connectedUid = connectedText === "" ? null : uidOf(connectedText);
  }
  const step: RawStep = {
    spec,
    row,
    sysId,
    uid,
    parentUid,
    connectedUid,
    order: parseFlowOrder(scalar(row.order)),
    logicKind,
  };
  const existing = steps.get(uid);
  if (!existing) {
    steps.set(uid, step);
    return;
  }
  // The same step stored in both V1 and V2 tables: V2 is the current copy.
  if (!existing.spec.v2 && spec.v2 && existing.spec.kind === spec.kind) {
    steps.set(uid, step);
    return;
  }
  drop(load);
}

/**
 * Apply the capture's structural rules, then make the parent links a forest:
 * - Top Level Try and Top Level Catch are roots.
 * - Else, Else If and Catch pair with their head If or Try through
 *   `connected_to` and take the head's parent.
 * - Every other step has no `connected_uid`.
 * - A parent that is not a loaded step, or a parent cycle, makes the step a
 *   root with the `orphan_steps` warning.
 */
function normalizeStructure(load: LoadState, steps: Map<string, RawStep>): void {
  for (const step of steps.values()) {
    const kind = step.logicKind;
    if (kind !== undefined && ROOT_KINDS.has(kind)) step.parentUid = null;
    if (kind === undefined || !BRANCH_KINDS.has(kind)) {
      step.connectedUid = null;
      continue;
    }
    const head = step.connectedUid === null ? undefined : steps.get(step.connectedUid);
    if (!head || head.logicKind === undefined || !BRANCH_HEAD_KINDS.has(head.logicKind)) {
      if (step.connectedUid !== null) load.warnings.add("orphan_steps");
      step.connectedUid = null;
      continue;
    }
    step.parentUid = head.parentUid;
  }
  for (const step of steps.values()) {
    if (step.parentUid !== null && (step.parentUid === step.uid || !steps.has(step.parentUid))) {
      step.parentUid = null;
      load.warnings.add("orphan_steps");
    }
  }
  const status = new Map<string, 1 | 2>();
  for (const start of steps.values()) {
    const path: RawStep[] = [];
    let current: RawStep | undefined = start;
    while (current && !status.has(current.uid)) {
      status.set(current.uid, 1);
      path.push(current);
      current = current.parentUid === null ? undefined : steps.get(current.parentUid);
    }
    if (current && status.get(current.uid) === 1) {
      path[path.length - 1]!.parentUid = null;
      load.warnings.add("orphan_steps");
    }
    for (const node of path) status.set(node.uid, 2);
  }
  // A branch whose head lost its parent above no longer shares it: unpair it
  // rather than move it (moving could close a new cycle).
  for (const step of steps.values()) {
    if (step.connectedUid === null) continue;
    if (steps.get(step.connectedUid)?.parentUid !== step.parentUid) {
      step.connectedUid = null;
      load.warnings.add("orphan_steps");
    }
  }
}

function compareSteps(left: RawStep, right: RawStep): number {
  const a = left.order ?? Number.POSITIVE_INFINITY;
  const b = right.order ?? Number.POSITIVE_INFINITY;
  if (a !== b) return a < b ? -1 : 1;
  return left.uid < right.uid ? -1 : left.uid > right.uid ? 1 : 0;
}

function assembleSteps(
  load: LoadState,
  steps: ReadonlyMap<string, RawStep>,
  targets: ReadonlyMap<string, string>,
  v1Values: ReadonlyMap<string, RawInput[]>
): NormalizedStep[] {
  const { plan } = load;
  return [...steps.values()].sort(compareSteps).map((raw) => {
    const { spec, row } = raw;
    const titleCell = spec.kind === "action" ? row.action_type : spec.kind === "logic" ? row.logic_definition : row.subflow;
    const title = policyText(plan, spec.title, content(titleCell), FLOW_VIEW_LIMITS.MAX_TITLE_CHARS);
    const step: NormalizedStep = {
      uid: raw.uid,
      parent_uid: raw.parentUid,
      order: raw.order,
      connected_uid: raw.connectedUid,
      kind: spec.kind,
      title,
      annotation: policyText(plan, spec.annotation, content(row.comment), FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS),
      inputs: [],
      ref: { table: spec.table, sys_id: raw.sysId },
    };
    if (raw.logicKind !== undefined) step.logic_kind = raw.logicKind;
    if (load.includeInputs) {
      step.inputs =
        spec.valueColumn !== null
          ? decodeInputs(load, load.blobs.get(`${spec.table}:${raw.sysId}`), spec.valueShape, spec.inputs, spec.valueColumn)
          : projectV1(load, spec.inputs, v1Values.get(raw.sysId) ?? []);
    }
    if (raw.logicKind !== undefined && CONDITION_KINDS.has(raw.logicKind)) {
      step.condition = load.includeInputs
        ? fromInputs(plan, spec.inputs, step.inputs, LOGIC_CONDITION_INPUTS, FLOW_VIEW_LIMITS.MAX_TITLE_CHARS)
        : notRequested();
    }
    if (spec.kind === "subflow") {
      const snapshot = sysIdOf(scalar(row.subflow));
      step.subflow = {
        flow_sys_id: canShow(plan, "subflow_title") && snapshot !== null ? targets.get(snapshot) ?? null : null,
        name: title,
      };
    }
    return step;
  });
}

// --- Inputs ------------------------------------------------------------------

function decodeFailed(column: keyof typeof DECODE_FAILED_NAMES): FlowInputValue {
  return { name: DECODE_FAILED_NAMES[column], label: null, type: null, value: null, redacted: "decode_failed" };
}

/** Decode one V2 blob and project its inputs; failures become one `decode_failed` input. */
function decodeInputs(
  load: LoadState,
  cell: unknown,
  shape: "list" | "logic",
  element: FlowValueElementKey,
  column: keyof typeof DECODE_FAILED_NAMES
): FlowInputValue[] {
  const blob = scalar(cell);
  if (blob.trim() === "") return [];
  const decoded = decodeCompressedJson(blob, load.budget);
  if (!decoded.ok) {
    load.warnings.add("gzip_decode_failed");
    return [decodeFailed(column)];
  }
  let entries: unknown[];
  if (shape === "logic") {
    const parsed = rawFlowLogicValuesSchema.safeParse(decoded.value);
    if (!parsed.success) {
      load.warnings.add("gzip_decode_failed");
      return [decodeFailed(column)];
    }
    entries = [...(parsed.data.inputs ?? []), ...(parsed.data.variables ?? [])];
  } else {
    const parsed = rawFlowInputListSchema.safeParse(decoded.value);
    if (!parsed.success) {
      load.warnings.add("gzip_decode_failed");
      return [decodeFailed(column)];
    }
    entries = parsed.data;
  }
  const raws: RawInput[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = rawFlowInputSchema.safeParse(entry);
    if (!parsed.success) {
      drop(load);
      continue;
    }
    const input = parsed.data;
    // Logic `variables` repeat the `inputs` entry of the same name (Set Flow Variables).
    if (seen.has(input.name)) continue;
    seen.add(input.name);
    raws.push({
      name: input.name,
      label: input.parameter?.label ?? input.label ?? null,
      type: input.parameter?.type ?? input.internalType ?? null,
      value: input.value,
      displayValue: input.displayValue,
      ...(input.scriptActive === true ? { script: true } : {}),
    });
  }
  return projectInputs(load, element, raws);
}

function projectV1(load: LoadState, element: FlowValueElementKey, raws: readonly RawInput[]): FlowInputValue[] {
  return projectInputs(load, element, raws);
}

function projectInputs(
  load: LoadState,
  element: FlowValueElementKey,
  raws: readonly RawInput[]
): FlowInputValue[] {
  const output: FlowInputValue[] = [];
  for (const raw of raws) {
    if (output.length >= FLOW_VIEW_LIMITS.MAX_INPUTS_PER_NODE) {
      load.limits.add("inputs_per_node");
      break;
    }
    output.push(
      policyInput(load.plan, element, {
        name: raw.name,
        label: raw.label,
        type: raw.type,
        value: raw.value,
        displayValue: raw.displayValue,
        ...(raw.script === true ? { script: true } : {}),
      })
    );
  }
  return output;
}

/**
 * V1 values: `sys_variable_value` rows of the kept V1 rows (chunks of 100
 * document keys), then the `var_dictionary` rows that name and type them.
 * Returns the values of each V1 row by its sys_id, in instance order.
 */
async function readV1Values(
  load: LoadState,
  documents: readonly { table: string; sysId: string }[]
): Promise<Map<string, RawInput[]>> {
  const output = new Map<string, RawInput[]>();
  if (documents.length === 0) return output;
  const tableOf = new Map(documents.map((document) => [document.sysId, document.table]));
  const fields = fieldsFor(load.plan, "sys_variable_value", { values: true });
  const values: { key: string; variable: string; row: Row }[] = [];
  let lastReadBytes: number | undefined;
  let budgetSpent = false;
  for (const chunk of chunks([...tableOf.keys()], FLOW_VIEW_LIMITS.MAX_SYS_ID_IN_CHUNK)) {
    if (budgetSpent) break;
    const keys = new Set(chunk);
    const rows: Row[] = [];
    // Page past the row cap, up to what MAX_INPUTS_PER_NODE values per step
    // can use, and while the scope allows; anything beyond that is
    // reported, never dropped silently.
    const pages = Math.max(1, Math.ceil((chunk.length * FLOW_VIEW_LIMITS.MAX_INPUTS_PER_NODE) / FLOW_TABLE_ROW_LIMIT));
    for (let page = 0; page < pages; page += 1) {
      if (lastReadBytes !== undefined && load.readBytes + lastReadBytes > V1_VALUE_SCOPE_BYTES) {
        load.limits.add("rows_per_table");
        load.warnings.add("input_values_incomplete");
        budgetSpent = true;
        break;
      }
      const read = await readTable(
        load.reader,
        "sys_variable_value",
        `document_keyIN${chunk.join(",")}^${orderBy(load.plan, "sys_variable_value")}`,
        fields,
        { offset: page * FLOW_TABLE_ROW_LIMIT }
      );
      rows.push(...read.rows);
      load.readBytes += read.bytes;
      lastReadBytes = read.bytes;
      if (!read.truncated) break;
      if (page === pages - 1) {
        load.limits.add("rows_per_table");
        load.warnings.add("input_values_incomplete");
      }
    }
    for (const row of rows) {
      const key = sysIdOf(scalar(row.document_key));
      const variable = sysIdOf(scalar(row.variable));
      if (
        sysIdOf(scalar(row.sys_id)) === null ||
        key === null ||
        variable === null ||
        !keys.has(key) ||
        tableOf.get(key) !== scalar(row.document)
      ) {
        drop(load);
        continue;
      }
      values.push({ key, variable, row });
    }
  }
  const definitions = await readDefinitions(load, [...new Set(values.map((value) => value.variable))]);
  for (const { key, variable, row } of values) {
    const definition = definitions.get(variable);
    const list = output.get(key) ?? [];
    list.push({
      // Without a readable definition the name is unknown: policyInput fails closed.
      name: definition?.element ?? "",
      label: displayOnly(row.variable),
      type: definition?.type ?? null,
      value: scalar(row.value),
      displayValue: display(row.value),
    });
    output.set(key, list);
  }
  return output;
}

async function readDefinitions(
  load: LoadState,
  ids: readonly string[]
): Promise<Map<string, { element: string; type: string | null }>> {
  const output = new Map<string, { element: string; type: string | null }>();
  const readable = load.plan.readable.get("var_dictionary");
  if (ids.length === 0 || !readable?.has("element")) return output;
  const fields = fieldsFor(load.plan, "var_dictionary", { values: true });
  for (const chunk of chunks(ids, FLOW_VIEW_LIMITS.MAX_SYS_ID_IN_CHUNK)) {
    const wanted = new Set(chunk);
    const { rows, truncated } = await readTable(
      load.reader,
      "var_dictionary",
      `sys_idIN${chunk.join(",")}^ORDERBYsys_id`,
      fields
    );
    if (truncated) load.limits.add("rows_per_table");
    for (const row of rows) {
      const id = sysIdOf(scalar(row.sys_id));
      if (id === null || !wanted.has(id)) {
        drop(load);
        continue;
      }
      const element = scalar(row.element);
      if (element.trim() === "") continue;
      const type = scalar(row.internal_type);
      output.set(id, { element, type: type === "" ? null : type });
    }
  }
  return output;
}

// --- Subflow targets ---------------------------------------------------------

async function resolveSubflowTargets(
  reader: ServiceNowOperations,
  plan: FlowFieldPlan,
  refs: readonly string[]
): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const readable = plan.readable.get("sys_hub_flow_snapshot");
  if (!canShow(plan, "subflow_title") || !readable?.has("sys_id") || !readable.has("parent_flow")) {
    return output;
  }
  const ids = [...new Set(refs.map((ref) => sysIdOf(ref)).filter((id): id is string => id !== null))];
  const fields = fieldsFor(plan, "sys_hub_flow_snapshot", { only: ["sys_id", "parent_flow"] });
  for (const chunk of chunks(ids, FLOW_VIEW_LIMITS.MAX_SYS_ID_IN_CHUNK)) {
    const wanted = new Set(chunk);
    const { rows } = await readTable(reader, "sys_hub_flow_snapshot", `sys_idIN${chunk.join(",")}^ORDERBYsys_id`, fields);
    for (const row of rows) {
      const id = sysIdOf(scalar(row.sys_id));
      const parent = sysIdOf(scalar(row.parent_flow));
      if (id !== null && parent !== null && wanted.has(id)) output.set(id, parent);
    }
  }
  return output;
}

// --- Variables ---------------------------------------------------------------

const VARIABLE_TABLES = Object.freeze([
  ["sys_hub_flow_variable", "variable", "flow_variables"],
  ["sys_hub_flow_input", "input", "flow_inputs"],
  ["sys_hub_flow_output", "output", "flow_outputs"],
] as const);

/** The variable, input and output reads whose element is showable; null where skipped. */
function readVariableTables(load: LoadState): Promise<(ReadResult | null)[]> {
  return Promise.all(
    VARIABLE_TABLES.map(([table, , element]) =>
      canShow(load.plan, element)
        ? readTable(load.reader, table, `model=${load.flowId}^${orderBy(load.plan, table)}`, fieldsFor(load.plan, table))
        : Promise.resolve(null)
    )
  );
}

function collectVariables(
  load: LoadState,
  reads: readonly (ReadResult | null)[]
): Omit<FlowVariableDef, "flow_index">[] {
  const output: Omit<FlowVariableDef, "flow_index">[] = [];
  for (const [index, [, scope, element]] of VARIABLE_TABLES.entries()) {
    const read = reads[index];
    if (!read) continue;
    const { rows, truncated } = read;
    if (truncated) load.limits.add("rows_per_table");
    for (const row of rows) {
      if (sysIdOf(scalar(row.sys_id)) === null || sysIdOf(scalar(row.model)) !== load.flowId) {
        drop(load);
        continue;
      }
      const name = line(policyText(load.plan, element, scalar(row.element), FLOW_VIEW_LIMITS.MAX_NAME_CHARS).text, FLOW_VIEW_LIMITS.MAX_NAME_CHARS);
      if (name === null) {
        drop(load);
        continue;
      }
      output.push({
        scope,
        name,
        label: line(policyText(load.plan, element, content(row.label), FLOW_VIEW_LIMITS.MAX_TITLE_CHARS).text, FLOW_VIEW_LIMITS.MAX_TITLE_CHARS),
        type: line(policyText(load.plan, element, scalar(row.internal_type), FLOW_VIEW_LIMITS.MAX_NAME_CHARS).text, FLOW_VIEW_LIMITS.MAX_NAME_CHARS),
      });
    }
  }
  return output;
}
