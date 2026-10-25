/**
 * Contracts for `sn_flow_view`: limits, the graph model returned in
 * `structuredContent.data`, the loader-to-builder intermediate, the table
 * closure the Table API loader reads, and the element-to-source map that
 * drives field policy.
 *
 * The Table API is the only source. Flow Designer's internal ProcessFlow API
 * is never called: its flow GET writes a Workflow Studio history row.
 *
 * Every other flow-view module codes against the exact names in this file.
 * Nothing here performs I/O.
 *
 * zod: only APIs that behave the same in zod 3 and zod 4 are used
 * (`z.object().strict()`, `.max()`, `.min()`, `.int()`, `z.enum`,
 * `z.string().regex()`, `z.array().max()`, `z.union`, `z.literal`,
 * `.optional()`, `.nullable()`). Raw upstream schemas use the default
 * (strip) object mode so unknown keys never cross the projection.
 *
 * @module tools/flow-view-contracts
 */

import { z } from "zod";

import { serviceNowSysIdSchema } from "../servicenow-identifiers.js";

// ---------------------------------------------------------------------------
// 1.1 Limits
// ---------------------------------------------------------------------------

export const FLOW_VIEW_LIMITS = Object.freeze({
  DEFAULT_MAX_NODES: 150, MIN_MAX_NODES: 10, MAX_MAX_NODES: 300,
  DEFAULT_DEPTH: 1, MAX_DEPTH: 3,            // 1 = this flow only (jsn semantics)
  MAX_NESTING: 16,                           // logic-block nesting levels
  MAX_SUBFLOW_EXPANSIONS: 8,                 // distinct subflows loaded per call
  MAX_UPSTREAM_SCOPES: 12,                   // 1 MiB budget scopes opened per call
  MAX_ROWS_PER_TABLE: 500,                   // sysparm_limit = 501 (sentinel)
  MAX_SYS_ID_IN_CHUNK: 100,
  MAX_INPUTS_PER_NODE: 40,
  MAX_INPUT_VALUE_CHARS: 2_000,              // structuredContent
  MAX_TITLE_CHARS: 200, MAX_NAME_CHARS: 100,
  MAX_PILLS: 200, MAX_PILL_LABEL_CHARS: 160,
  MAX_EDGES: 600, MAX_WARNINGS: 20,
  MAX_GZIP_BASE64_CHARS: 1_000_000,
  MAX_GZIP_OUTPUT_BYTES: 262_144,            // per blob (zlib maxOutputLength)
  MAX_GZIP_OUTPUT_BYTES_PER_LOAD: 2_097_152, // cumulative per flow load
  MAX_DECODED_JSON_DEPTH: 24, MAX_DECODED_JSON_NODES: 20_000,
  DEFAULT_MAX_RESPONSE_BYTES: 100_000, MIN_MAX_RESPONSE_BYTES: 10_000, MAX_MAX_RESPONSE_BYTES: 1_000_000,
  STRUCTURED_SHARE: 0.55,                    // structuredContent target share of max_response_bytes
  MERMAID_MAX_NODES: 150, MERMAID_MAX_EDGES: 300, MERMAID_MAX_CHARS: 20_000, MERMAID_MAX_LABEL_CHARS: 80,
  OUTLINE_MAX_LINES: 800, OUTLINE_MAX_CHARS: 40_000, OUTLINE_MAX_VALUE_CHARS: 300,
});

const L = FLOW_VIEW_LIMITS;

/**
 * Bounds the graph schema needs that §1.1 does not name. Derived from
 * FLOW_VIEW_LIMITS so the two cannot drift.
 */
export const FLOW_GRAPH_SCHEMA_BOUNDS = Object.freeze({
  /** Root plus every expanded subflow. */
  MAX_FLOWS: 1 + L.MAX_SUBFLOW_EXPANSIONS,
  /** `max_nodes` plus the trigger node and one `more` node. */
  MAX_NODES: L.MAX_MAX_NODES + 2,
  /** Variables, inputs and outputs of every loaded flow. */
  MAX_VARIABLES: L.MAX_ROWS_PER_TABLE * 3 * (1 + L.MAX_SUBFLOW_EXPANSIONS),
  /** Largest FlowText; titles and names are capped lower by their producer. */
  MAX_TEXT_CHARS: L.MAX_INPUT_VALUE_CHARS,
  /** status, version, scope. */
  MAX_SHORT_CHARS: 200,
  MAX_PILL_TOKEN_CHARS: 512,
  /** Outline number such as "3.2.1", across nested subflows. */
  MAX_STEP_CHARS: 160,
  /** Logic nesting within a flow, repeated for each expanded subflow level. */
  MAX_NODE_DEPTH: (L.MAX_NESTING + 1) * L.MAX_DEPTH,
  MAX_COUNT: 1_000_000,
  MAX_ORIGINAL_LENGTH: 1_000_000_000,
});

const B = FLOW_GRAPH_SCHEMA_BOUNDS;

// ---------------------------------------------------------------------------
// 1.2 Output types (structuredContent.data)
// ---------------------------------------------------------------------------

/**
 * The only source in v1. Flow Designer's internal ProcessFlow API is never
 * called: its flow GET writes a Workflow Studio history row.
 */
export type FlowSourceName = "table";
export type RedactionReason = "field_policy" | "sensitive_name" | "sensitive_type"
  | "not_requested" | "decode_failed" | "limit";
export type FlowNodeKind = "trigger" | "action" | "logic" | "subflow" | "more";
/** Normalized logic kinds; see FLOW_LOGIC_TYPE_KINDS for the instance type codes. */
export type FlowLogicKind = "if" | "else_if" | "else" | "for_each" | "do_until" | "parallel" | "try" | "catch"
  | "wait" | "set_flow_variables" | "assign_subflow_outputs" | "end_flow" | "go_back_to"
  | "skip_iteration" | "exit_loop" | "decision" | "other"
  | "parallel_branch" | "top_level_try" | "top_level_catch" | "decision_branch"
  | "append_flow_variables" | "get_flow_outputs" | "dynamic_flow" | "call_workflow"
  | "placeholder" | "update_flow_template";
export type FlowEdgeKind = "next" | "true" | "false" | "loop_body" | "loop_back" | "parallel" | "error" | "subflow";
export type FlowLimitHit = "max_nodes" | "max_nesting" | "max_depth" | "max_subflow_expansions"
  | "upstream_scopes" | "rows_per_table" | "inputs_per_node" | "input_value_chars" | "pills"
  | "edges" | "response_bytes";
export type FlowWarningCode = "subflow_cycle" | "subflow_not_found"
  | "subflow_denied" | "orphan_steps" | "unknown_logic_type" | "items_dropped_invalid"
  | "gzip_decode_failed" | "label_cache_unavailable" | "flow_version_unknown"
  | "subflow_too_large" | "inputs_omitted_too_large" | "flow_too_large" | "input_values_incomplete";

/** Raw instance text after policy, redaction, pill relabelling and truncation. NOT markdown-escaped. */
export interface FlowText { text: string | null; redacted?: RedactionReason; original_length?: number }
export interface FlowRecordRef { table: FlowTableName; sys_id: string /* ^[0-9a-f]{32}$ */ }

export interface FlowHeader {
  index: number;                 // 0 = root; 1..n = expanded subflows
  source: FlowSourceName;        // always "table" in v1
  sys_id: string;
  name: FlowText; description: FlowText;
  type: "flow" | "subflow" | null; active: boolean | null;
  status: string | null; version: string | null; scope: string | null;
  called_from?: string;          // node id of the first call site
}
export interface FlowInputValue {
  name: string;                  // internal name, ≤ MAX_NAME_CHARS, control chars stripped
  label: string | null; type: string | null;
  value: string | null;          // display value preferred, pills relabelled
  redacted?: RedactionReason; original_length?: number;
  script?: boolean;              // scripted ("f(x)") input
  pills?: number[];              // indices into FlowGraph.pills
}
export interface FlowTrigger {
  node_id: "n0"; type: FlowText; table: FlowText; condition: FlowText; schedule: FlowText;
  inputs?: FlowInputValue[];
}
export interface FlowNode {
  id: string;                    // "n1".."n9999", generated; never instance data
  flow_index: number; kind: FlowNodeKind; logic_kind?: FlowLogicKind;
  step: string;                  // outline number "3.2.1"
  depth: number; parent?: string; order: number | null;
  title: FlowText; annotation: FlowText; condition?: FlowText;
  inputs?: FlowInputValue[];
  subflow?: { flow_sys_id: string | null; name: FlowText; expanded_index?: number;
              not_expanded?: "depth" | "cycle" | "limit" | "denied" | "not_found" | "too_large" };
  ref?: FlowRecordRef;
  omitted_steps?: number;        // only for kind "more"
}
export interface FlowEdge { from: string; to: string; kind: FlowEdgeKind }
export interface FlowPill { token: string; label: string | null }
export interface FlowVariableDef { scope: "input" | "output" | "variable"; flow_index: number;
  name: string; label: string | null; type: string | null }

export interface FlowGraph {
  schema_version: 1;
  source: FlowSourceName;                       // always "table" in v1
  flows: FlowHeader[]; trigger: FlowTrigger | null;
  nodes: FlowNode[]; edges: FlowEdge[]; pills: FlowPill[]; variables: FlowVariableDef[];
  options: { depth: number; include_inputs: boolean; max_nodes: number; format: "both" | "mermaid" | "outline" };
  limits_hit: FlowLimitHit[]; warnings: FlowWarningCode[];
  counts: { steps_seen: number; nodes_returned: number; inputs_redacted: number;
            inputs_truncated: number; items_dropped: number };
}

// Value lists for the unions above, checked exhaustive at compile time.
type Exhaustive<T, A extends readonly T[]> = [Exclude<T, A[number]>] extends [never] ? unknown : never;
function enumValues<T>() {
  return <const A extends readonly [T, ...T[]]>(values: A & Exhaustive<T, A>): A =>
    Object.freeze(values) as A;
}

export const FLOW_SOURCE_NAMES = enumValues<FlowSourceName>()(["table"]);
export const REDACTION_REASONS = enumValues<RedactionReason>()([
  "field_policy", "sensitive_name", "sensitive_type", "not_requested", "decode_failed", "limit",
]);
export const FLOW_NODE_KINDS = enumValues<FlowNodeKind>()(["trigger", "action", "logic", "subflow", "more"]);
export const FLOW_LOGIC_KINDS = enumValues<FlowLogicKind>()([
  "if", "else_if", "else", "for_each", "do_until", "parallel", "try", "catch",
  "wait", "set_flow_variables", "assign_subflow_outputs", "end_flow", "go_back_to",
  "skip_iteration", "exit_loop", "decision", "other",
  "parallel_branch", "top_level_try", "top_level_catch", "decision_branch",
  "append_flow_variables", "get_flow_outputs", "dynamic_flow", "call_workflow",
  "placeholder", "update_flow_template",
]);

/**
 * `sys_hub_flow_logic_definition.type` code to logic kind, for every
 * definition on the Brazil patch 0 capture. Anything else is `other` with the
 * `unknown_logic_type` warning.
 *
 * END is the step Flow Designer shows as "End Flow": the capture has it as
 * the last child of a branch (If, Else If, Parallel Branch), so it ends the
 * flow rather than closing its parent block.
 */
export const FLOW_LOGIC_TYPE_KINDS: Readonly<Record<string, FlowLogicKind>> = Object.freeze({
  IF: "if",
  ELSEIF: "else_if",
  ELSE: "else",
  FOREACH: "for_each",
  DOUNTIL: "do_until",
  PARALLEL: "parallel",
  PARALLELBLOCK: "parallel_branch",
  TRY: "try",
  CATCH: "catch",
  TOP_LEVEL_TRY: "top_level_try",
  TOP_LEVEL_CATCH: "top_level_catch",
  TIMER: "wait",
  SETFLOWVARIABLES: "set_flow_variables",
  APPENDFLOWVARIABLES: "append_flow_variables",
  ASSIGNSUBFLOWOUTPUTS: "assign_subflow_outputs",
  GETFLOWOUTPUTS: "get_flow_outputs",
  END: "end_flow",
  GOBACKTO: "go_back_to",
  CONTINUE: "skip_iteration",
  BREAK: "exit_loop",
  DECISION: "decision",
  DECISIONBLOCK: "decision_branch",
  RUNDYNAMICFLOW: "dynamic_flow",
  RUNWORKFLOW: "call_workflow",
  PLACEHOLDER: "placeholder",
  UPDATEFLOWTEMPLATE: "update_flow_template",
});

/**
 * English `sys_hub_flow_logic_definition.name` (the display value of
 * `logic_definition` on the step tables) to logic kind, lowercased. The name
 * is translated, so a non-English session falls back to `other`.
 */
export const FLOW_LOGIC_NAME_KINDS: Readonly<Record<string, FlowLogicKind>> = Object.freeze({
  "if": "if",
  "else if": "else_if",
  "else": "else",
  "for each": "for_each",
  "do the following until": "do_until",
  "do the following in parallel": "parallel",
  "parallel branch": "parallel_branch",
  "try": "try",
  "catch": "catch",
  "top level try": "top_level_try",
  "top level catch": "top_level_catch",
  "wait for a duration of time": "wait",
  "set flow variables": "set_flow_variables",
  "append to flow variables": "append_flow_variables",
  "assign subflow outputs": "assign_subflow_outputs",
  "get flow outputs": "get_flow_outputs",
  "end": "end_flow",
  "go back to": "go_back_to",
  "skip iteration": "skip_iteration",
  "exit loop": "exit_loop",
  "make a decision": "decision",
  "decision": "decision_branch",
  "dynamic flow": "dynamic_flow",
  "call a workflow": "call_workflow",
  "placeholder": "placeholder",
  "update flow template": "update_flow_template",
});

/** Map a logic definition display name to its kind; unknown names are `other`. */
export function flowLogicKindFromName(name: unknown): FlowLogicKind {
  if (typeof name !== "string") return "other";
  const key = name.trim().replace(/\s+/gu, " ").toLowerCase();
  return Object.hasOwn(FLOW_LOGIC_NAME_KINDS, key) ? FLOW_LOGIC_NAME_KINDS[key]! : "other";
}
export const FLOW_EDGE_KINDS = enumValues<FlowEdgeKind>()([
  "next", "true", "false", "loop_body", "loop_back", "parallel", "error", "subflow",
]);
export const FLOW_LIMIT_HITS = enumValues<FlowLimitHit>()([
  "max_nodes", "max_nesting", "max_depth", "max_subflow_expansions",
  "upstream_scopes", "rows_per_table", "inputs_per_node", "input_value_chars", "pills",
  "edges", "response_bytes",
]);
export const FLOW_WARNING_CODES = enumValues<FlowWarningCode>()([
  "subflow_cycle", "subflow_not_found",
  "subflow_denied", "orphan_steps", "unknown_logic_type", "items_dropped_invalid",
  "gzip_decode_failed", "label_cache_unavailable", "flow_version_unknown",
  "subflow_too_large", "inputs_omitted_too_large", "flow_too_large", "input_values_incomplete",
]);
export const FLOW_VIEW_FORMATS = Object.freeze(["both", "mermaid", "outline"] as const);

/**
 * Keys the result-envelope adapter inspects on `data` (`collectionArray`,
 * `nestedObjectField`, `synchronize*`). FlowGraph must use none of them at
 * its top level, so the envelope keeps it a `"single"` result untouched.
 */
export const FLOW_GRAPH_RESERVED_ENVELOPE_KEYS = Object.freeze([
  "results", "runs", "failures", "execution", "relationships", "fields", "result", "request",
  "limit", "offset", "has_more", "next_offset", "truncated", "dropped_records", "record_count", "meta",
] as const);

// ---------------------------------------------------------------------------
// 3.1 Table closure and per-table fields
// ---------------------------------------------------------------------------

export interface FlowTableFieldSpec {
  /** Structural; an unreadable one denies the whole call at preflight. */
  readonly required: readonly string[];
  /** Content; intersected with the readable set, never a denial. */
  readonly optional: readonly string[];
  /**
   * Input values and the definitions that type them; requested only with
   * `include_inputs`, then intersected.
   */
  readonly values: readonly string[];
}

// ===========================================================================
// Table and column names, confirmed against sys_dictionary on Brazil patch 0
// (flow capture, scratchpad/reports/flow-capture.md §4). FLOW_VIEW_TABLES
// and FLOW_TABLE_FIELDS are the only places these names live;
// FLOW_ELEMENT_SOURCES must reference only fields declared here, and a test
// checks every field against the captured schema.
//
// Never add the Workflow Studio history (version) table: its rows come from
// Flow Designer's internal API, which this tool does not call.
// ===========================================================================

export const FLOW_VIEW_TABLES = Object.freeze([
  "sys_hub_flow",
  "sys_hub_flow_snapshot",
  "sys_hub_trigger_instance",
  "sys_hub_trigger_instance_v2",
  "sys_hub_action_instance",
  "sys_hub_action_instance_v2",
  "sys_hub_flow_logic",
  "sys_hub_flow_logic_instance_v2",
  "sys_hub_sub_flow_instance",
  "sys_hub_sub_flow_instance_v2",
  "sys_hub_flow_variable",
  "sys_hub_flow_input",
  "sys_hub_flow_output",
  "sys_variable_value",
  "var_dictionary",
] as const);

export type FlowTableName = (typeof FLOW_VIEW_TABLES)[number];

/** Columns of sys_hub_flow_component, shared by every action, logic and subflow table. */
const STEP_STRUCTURE = Object.freeze(["sys_id", "flow", "order", "ui_id", "parent_ui_id"] as const);
/** Logic rows also carry the head a branch belongs to (Else, Else If, Catch). */
const LOGIC_STRUCTURE = Object.freeze([...STEP_STRUCTURE, "logic_definition", "connected_to"] as const);
const SUBFLOW_STRUCTURE = Object.freeze([...STEP_STRUCTURE, "subflow"] as const);

function spec(
  required: readonly string[],
  optional: readonly string[],
  values: readonly string[] = []
): FlowTableFieldSpec {
  return Object.freeze({
    required: Object.freeze([...required]),
    optional: Object.freeze([...optional]),
    values: Object.freeze([...values]),
  });
}

/**
 * Flow variables, inputs and outputs extend var_dictionary: `element` is the
 * name (`name` is a generated `var__m_…` table name), `internal_type` the type.
 * `default_value` is never read.
 */
const FLOW_IO_FIELDS = spec(["sys_id", "model", "element"], ["label", "internal_type", "order"]);

export const FLOW_TABLE_FIELDS: Readonly<Record<FlowTableName, FlowTableFieldSpec>> = Object.freeze({
  sys_hub_flow: spec(
    ["sys_id", "name", "type"],
    ["active", "status", "version", "description", "sys_scope", "label_cache"]
  ),
  // `subflow` on the subflow tables references a snapshot; parent_flow is the flow.
  sys_hub_flow_snapshot: spec(["sys_id", "parent_flow"], ["name"]),
  // Triggers are not flow components: no order, ui_id or active. V1 trigger
  // values are in sys_variable_value (the glide_var column reads empty).
  sys_hub_trigger_instance: spec(["sys_id", "flow"], ["name", "trigger_type", "trigger_definition"]),
  sys_hub_trigger_instance_v2: spec(
    ["sys_id", "flow"],
    ["name", "trigger_type", "trigger_definition"],
    ["trigger_inputs"]
  ),
  // V1 action, logic and subflow values are in sys_variable_value; their
  // glide_var columns (action_inputs, inputs, subflow_instance_inputs) read empty.
  sys_hub_action_instance: spec(STEP_STRUCTURE, ["action_type", "comment"]),
  sys_hub_action_instance_v2: spec(STEP_STRUCTURE, ["action_type", "comment"], ["values"]),
  sys_hub_flow_logic: spec(LOGIC_STRUCTURE, ["comment"]),
  sys_hub_flow_logic_instance_v2: spec(LOGIC_STRUCTURE, ["comment"], ["values"]),
  sys_hub_sub_flow_instance: spec(SUBFLOW_STRUCTURE, ["comment"]),
  sys_hub_sub_flow_instance_v2: spec(SUBFLOW_STRUCTURE, ["comment"], ["subflow_inputs"]),
  sys_hub_flow_variable: FLOW_IO_FIELDS,
  sys_hub_flow_input: FLOW_IO_FIELDS,
  sys_hub_flow_output: FLOW_IO_FIELDS,
  // `document` is the step table, `document_key` the step row, `variable`
  // the var_dictionary row that defines the input.
  sys_variable_value: spec(["sys_id", "document", "document_key", "variable"], ["order"], ["value"]),
  // V1 input name and type, read by sys_id from sys_variable_value.variable
  // (whose display value is the label). Both are sys_dictionary columns.
  // Without internal_type a V1 password2 value could not be recognized.
  var_dictionary: spec(["sys_id"], [], ["element", "internal_type"]),
});

// ===========================================================================
// end of the table and column block
// ===========================================================================

// ---------------------------------------------------------------------------
// 3.2 Element-to-source map
// ---------------------------------------------------------------------------

export type FlowValueElementKey =
  | "trigger_inputs"
  | "action_inputs"
  | "logic_inputs"
  | "subflow_inputs";

export type FlowElementKey =
  | "flow_name"
  | "flow_description"
  | "flow_status"
  | "flow_active"
  | "flow_version"
  | "flow_type"
  | "flow_scope"
  | "pill_labels"
  | "trigger_type"
  | "trigger_name"
  | "step_structure"
  | "action_title"
  | "logic_title"
  | "subflow_title"
  | "action_annotation"
  | "logic_annotation"
  | "subflow_annotation"
  | "flow_variables"
  | "flow_inputs"
  | "flow_outputs"
  | FlowValueElementKey;

export type FlowFieldSource = readonly [FlowTableName, string];

function sources(...entries: FlowFieldSource[]): readonly FlowFieldSource[] {
  return Object.freeze(entries.map((entry) => Object.freeze([...entry]) as unknown as FlowFieldSource));
}

function stepStructure(): FlowFieldSource[] {
  const tables = [
    "sys_hub_action_instance",
    "sys_hub_action_instance_v2",
    "sys_hub_flow_logic",
    "sys_hub_flow_logic_instance_v2",
    "sys_hub_sub_flow_instance",
    "sys_hub_sub_flow_instance_v2",
  ] as const;
  const shared = tables.flatMap((table) =>
    (["ui_id", "parent_ui_id", "order"] as const).map(
      (field) => [table, field] as FlowFieldSource
    )
  );
  return [
    ...shared,
    ["sys_hub_flow_logic", "connected_to"],
    ["sys_hub_flow_logic_instance_v2", "connected_to"],
  ];
}

/** V1 values: the value itself plus the definition that names and types it. */
const V1_VALUE_SOURCES: readonly FlowFieldSource[] = Object.freeze([
  ["sys_variable_value", "value"],
  ["var_dictionary", "element"],
  ["var_dictionary", "internal_type"],
]);

function ioSources(table: "sys_hub_flow_variable" | "sys_hub_flow_input" | "sys_hub_flow_output") {
  return sources([table, "element"], [table, "label"], [table, "internal_type"]);
}

/**
 * Every graph element and the `(table, field)` pairs it is read from, across
 * V1 and V2 storage. An element is shown only when every pair is readable.
 */
export const FLOW_ELEMENT_SOURCES: Readonly<Record<FlowElementKey, readonly FlowFieldSource[]>> = Object.freeze({
  flow_name: sources(["sys_hub_flow", "name"]),
  flow_description: sources(["sys_hub_flow", "description"]),
  flow_status: sources(["sys_hub_flow", "status"]),
  flow_active: sources(["sys_hub_flow", "active"]),
  flow_version: sources(["sys_hub_flow", "version"]),
  flow_type: sources(["sys_hub_flow", "type"]),
  flow_scope: sources(["sys_hub_flow", "sys_scope"]),
  pill_labels: sources(["sys_hub_flow", "label_cache"]),
  trigger_type: sources(
    ["sys_hub_trigger_instance", "trigger_type"],
    ["sys_hub_trigger_instance_v2", "trigger_type"]
  ),
  trigger_name: sources(
    ["sys_hub_trigger_instance", "name"],
    ["sys_hub_trigger_instance_v2", "name"]
  ),
  trigger_inputs: sources(["sys_hub_trigger_instance_v2", "trigger_inputs"], ...V1_VALUE_SOURCES),
  step_structure: sources(...stepStructure()),
  action_title: sources(
    ["sys_hub_action_instance", "action_type"],
    ["sys_hub_action_instance_v2", "action_type"]
  ),
  logic_title: sources(
    ["sys_hub_flow_logic", "logic_definition"],
    ["sys_hub_flow_logic_instance_v2", "logic_definition"]
  ),
  subflow_title: sources(
    ["sys_hub_sub_flow_instance", "subflow"],
    ["sys_hub_sub_flow_instance_v2", "subflow"]
  ),
  action_annotation: sources(
    ["sys_hub_action_instance", "comment"],
    ["sys_hub_action_instance_v2", "comment"]
  ),
  logic_annotation: sources(
    ["sys_hub_flow_logic", "comment"],
    ["sys_hub_flow_logic_instance_v2", "comment"]
  ),
  subflow_annotation: sources(
    ["sys_hub_sub_flow_instance", "comment"],
    ["sys_hub_sub_flow_instance_v2", "comment"]
  ),
  action_inputs: sources(["sys_hub_action_instance_v2", "values"], ...V1_VALUE_SOURCES),
  logic_inputs: sources(["sys_hub_flow_logic_instance_v2", "values"], ...V1_VALUE_SOURCES),
  subflow_inputs: sources(["sys_hub_sub_flow_instance_v2", "subflow_inputs"], ...V1_VALUE_SOURCES),
  flow_variables: ioSources("sys_hub_flow_variable"),
  flow_inputs: ioSources("sys_hub_flow_input"),
  flow_outputs: ioSources("sys_hub_flow_output"),
});

export const FLOW_VALUE_ELEMENT_KEYS = enumValues<FlowValueElementKey>()([
  "trigger_inputs", "action_inputs", "logic_inputs", "subflow_inputs",
]);

// ---------------------------------------------------------------------------
// 1.3 Loader-to-builder intermediate (source-neutral; already policy-projected)
// ---------------------------------------------------------------------------

export interface NormalizedStep {
  uid: string; parent_uid: string | null; order: number | null;
  /**
   * `connected_to` of a logic row: the uid of the head If or Try that an
   * Else, Else If or Catch belongs to (never the previous branch). Null for
   * every other step.
   */
  connected_uid: string | null;
  kind: "action" | "logic" | "subflow"; logic_kind?: FlowLogicKind;
  title: FlowText; annotation: FlowText; condition?: FlowText;
  /** Always empty when `include_inputs` is false: inputs are omitted, never redacted. */
  inputs: FlowInputValue[];
  subflow?: { flow_sys_id: string | null; name: FlowText };
  ref?: FlowRecordRef;
}
export interface NormalizedFlowDefinition {
  source: FlowSourceName;
  header: Omit<FlowHeader, "index" | "called_from" | "source">;
  trigger: Omit<FlowTrigger, "node_id"> | null;
  steps: NormalizedStep[];                              // flat; nesting via parent_uid
  label_cache: readonly (readonly [string, string])[]; // pill token -> label (policy-checked)
  variables: Omit<FlowVariableDef, "flow_index">[];
  warnings: FlowWarningCode[]; limits_hit: FlowLimitHit[]; items_dropped: number;
}
export interface FlowViewOptions { depth: number; include_inputs: boolean; max_nodes: number;
  format: "both" | "mermaid" | "outline"; max_response_bytes: number }

// ---------------------------------------------------------------------------
// Canonical arguments
// ---------------------------------------------------------------------------

/** Tool arguments with every default applied; what the handler receives. */
export interface CanonicalFlowViewArgs extends FlowViewOptions {
  /** Trimmed; 32 lowercase hex characters selects by sys_id, anything else is an exact name. */
  flow: string;
}

export const FLOW_VIEW_MAX_FLOW_SELECTOR_CHARS = 100;

const canonicalArgsSchema = z.object({
  flow: z.string().max(10_000),
  depth: z.number().int().min(1).max(L.MAX_DEPTH).optional(),
  include_inputs: z.boolean().optional(),
  format: z.enum(FLOW_VIEW_FORMATS).optional(),
  max_nodes: z.number().int().min(L.MIN_MAX_NODES).max(L.MAX_MAX_NODES).optional(),
  max_response_bytes: z
    .number()
    .int()
    .min(L.MIN_MAX_RESPONSE_BYTES)
    .max(L.MAX_MAX_RESPONSE_BYTES)
    .optional(),
});

/** Raised when arguments that passed the input schema still fail canonicalization. */
export class FlowViewArgumentError extends Error {
  constructor() {
    super("Invalid sn_flow_view arguments");
    this.name = "FlowViewArgumentError";
  }
}

/**
 * Apply the documented defaults and re-validate every bound. Defense in
 * depth behind the input schema; never echoes argument values.
 */
export function canonicalFlowViewArgs(args: Readonly<Record<string, unknown>>): CanonicalFlowViewArgs {
  const parsed = canonicalArgsSchema.safeParse(args);
  if (!parsed.success) throw new FlowViewArgumentError();
  const flow = parsed.data.flow.trim();
  if (flow.length === 0 || flow.length > FLOW_VIEW_MAX_FLOW_SELECTOR_CHARS) {
    throw new FlowViewArgumentError();
  }
  return Object.freeze({
    flow: /^[0-9a-fA-F]{32}$/u.test(flow) ? flow.toLowerCase() : flow,
    depth: parsed.data.depth ?? L.DEFAULT_DEPTH,
    include_inputs: parsed.data.include_inputs ?? true,
    format: parsed.data.format ?? "both",
    max_nodes: parsed.data.max_nodes ?? L.DEFAULT_MAX_NODES,
    max_response_bytes: parsed.data.max_response_bytes ?? L.DEFAULT_MAX_RESPONSE_BYTES,
  });
}

// ---------------------------------------------------------------------------
// flowGraphSchema (strict, bounded)
// ---------------------------------------------------------------------------

const nodeIdSchema = z.string().max(5).regex(/^n\d{1,4}$/u);
const nonNegativeInt = (max: number) => z.number().int().min(0).max(max);
const redactionSchema = z.enum(REDACTION_REASONS);
const originalLengthSchema = nonNegativeInt(B.MAX_ORIGINAL_LENGTH);

export const flowTextSchema = z
  .object({
    text: z.string().max(B.MAX_TEXT_CHARS).nullable(),
    redacted: redactionSchema.optional(),
    original_length: originalLengthSchema.optional(),
  })
  .strict();

export const flowRecordRefSchema = z
  .object({ table: z.enum(FLOW_VIEW_TABLES), sys_id: serviceNowSysIdSchema })
  .strict();

export const flowInputValueSchema = z
  .object({
    name: z.string().max(L.MAX_NAME_CHARS),
    label: z.string().max(L.MAX_TITLE_CHARS).nullable(),
    type: z.string().max(L.MAX_NAME_CHARS).nullable(),
    value: z.string().max(L.MAX_INPUT_VALUE_CHARS).nullable(),
    redacted: redactionSchema.optional(),
    original_length: originalLengthSchema.optional(),
    script: z.boolean().optional(),
    pills: z.array(nonNegativeInt(L.MAX_PILLS - 1)).max(L.MAX_PILLS).optional(),
  })
  .strict();

const inputsSchema = z.array(flowInputValueSchema).max(L.MAX_INPUTS_PER_NODE);
const shortTextSchema = z.string().max(B.MAX_SHORT_CHARS).nullable();

export const flowHeaderSchema = z
  .object({
    index: nonNegativeInt(L.MAX_SUBFLOW_EXPANSIONS),
    source: z.enum(FLOW_SOURCE_NAMES),
    sys_id: serviceNowSysIdSchema,
    name: flowTextSchema,
    description: flowTextSchema,
    type: z.enum(["flow", "subflow"]).nullable(),
    active: z.boolean().nullable(),
    status: shortTextSchema,
    version: shortTextSchema,
    scope: shortTextSchema,
    called_from: nodeIdSchema.optional(),
  })
  .strict();

export const flowTriggerSchema = z
  .object({
    node_id: z.literal("n0"),
    type: flowTextSchema,
    table: flowTextSchema,
    condition: flowTextSchema,
    schedule: flowTextSchema,
    inputs: inputsSchema.optional(),
  })
  .strict();

export const flowNodeSchema = z
  .object({
    id: nodeIdSchema,
    flow_index: nonNegativeInt(L.MAX_SUBFLOW_EXPANSIONS),
    kind: z.enum(FLOW_NODE_KINDS),
    logic_kind: z.enum(FLOW_LOGIC_KINDS).optional(),
    step: z.string().max(B.MAX_STEP_CHARS).regex(/^[0-9.]*$/u),
    depth: nonNegativeInt(B.MAX_NODE_DEPTH),
    parent: nodeIdSchema.optional(),
    order: z.number().nullable(),
    title: flowTextSchema,
    annotation: flowTextSchema,
    condition: flowTextSchema.optional(),
    inputs: inputsSchema.optional(),
    subflow: z
      .object({
        flow_sys_id: serviceNowSysIdSchema.nullable(),
        name: flowTextSchema,
        expanded_index: z.number().int().min(1).max(L.MAX_SUBFLOW_EXPANSIONS).optional(),
        not_expanded: z.enum(["depth", "cycle", "limit", "denied", "not_found", "too_large"]).optional(),
      })
      .strict()
      .optional(),
    ref: flowRecordRefSchema.optional(),
    omitted_steps: nonNegativeInt(B.MAX_COUNT).optional(),
  })
  .strict();

export const flowEdgeSchema = z
  .object({ from: nodeIdSchema, to: nodeIdSchema, kind: z.enum(FLOW_EDGE_KINDS) })
  .strict();

export const flowPillSchema = z
  .object({
    token: z.string().max(B.MAX_PILL_TOKEN_CHARS),
    label: z.string().max(L.MAX_PILL_LABEL_CHARS).nullable(),
  })
  .strict();

export const flowVariableDefSchema = z
  .object({
    scope: z.enum(["input", "output", "variable"]),
    flow_index: nonNegativeInt(L.MAX_SUBFLOW_EXPANSIONS),
    name: z.string().max(L.MAX_NAME_CHARS),
    label: z.string().max(L.MAX_TITLE_CHARS).nullable(),
    type: z.string().max(L.MAX_NAME_CHARS).nullable(),
  })
  .strict();

export const flowGraphSchema = z
  .object({
    schema_version: z.literal(1),
    source: z.enum(FLOW_SOURCE_NAMES),
    flows: z.array(flowHeaderSchema).max(B.MAX_FLOWS),
    trigger: flowTriggerSchema.nullable(),
    nodes: z.array(flowNodeSchema).max(B.MAX_NODES),
    edges: z.array(flowEdgeSchema).max(L.MAX_EDGES),
    pills: z.array(flowPillSchema).max(L.MAX_PILLS),
    variables: z.array(flowVariableDefSchema).max(B.MAX_VARIABLES),
    options: z
      .object({
        depth: z.number().int().min(1).max(L.MAX_DEPTH),
        include_inputs: z.boolean(),
        max_nodes: z.number().int().min(L.MIN_MAX_NODES).max(L.MAX_MAX_NODES),
        format: z.enum(FLOW_VIEW_FORMATS),
      })
      .strict(),
    limits_hit: z.array(z.enum(FLOW_LIMIT_HITS)).max(FLOW_LIMIT_HITS.length),
    warnings: z.array(z.enum(FLOW_WARNING_CODES)).max(L.MAX_WARNINGS),
    counts: z
      .object({
        steps_seen: nonNegativeInt(B.MAX_COUNT),
        nodes_returned: nonNegativeInt(B.MAX_COUNT),
        inputs_redacted: nonNegativeInt(B.MAX_COUNT),
        inputs_truncated: nonNegativeInt(B.MAX_COUNT),
        items_dropped: nonNegativeInt(B.MAX_COUNT),
      })
      .strict(),
  })
  .strict();

type MutuallyAssignable<A, Bt> = [A] extends [Bt] ? ([Bt] extends [A] ? true : false) : false;
/**
 * Compile-time proof that flowGraphSchema and the FlowGraph interfaces
 * describe the same shape. A drift on either side fails `tsc`.
 */
export const FLOW_GRAPH_SCHEMA_MATCHES_CONTRACT: MutuallyAssignable<
  FlowGraph,
  z.infer<typeof flowGraphSchema>
> = true;

// ---------------------------------------------------------------------------
// 2.2 Raw Table API shapes (shared by the Table loader and the gzip decoder)
// ---------------------------------------------------------------------------
//
// Default (strip) objects: only the listed keys survive a successful parse.
// Content fields accept any JSON scalar or `{value, display_value}` object
// and are projected and bounded by flow-view-policy (`policyText`,
// `policyInput`), never used raw.

/** Upper bound on any raw string kept by these schemas (upstream budget is 1 MiB). */
export const FLOW_RAW_MAX_TEXT_CHARS = 1_048_576;
/** Upper bound on raw arrays before per-node limits apply. */
export const FLOW_RAW_MAX_ITEMS = 10_000;

/** `ui_id`, `parent_ui_id` and `connected_to` values (UUIDs on Brazil). */
export const rawFlowUidSchema = z.string().regex(/^[0-9a-f-]{8,64}$/iu);

const rawScalarSchema = z
  .union([z.string().max(FLOW_RAW_MAX_TEXT_CHARS), z.number(), z.boolean()])
  .nullable();

/** A content value: a scalar, or a Table API `{value, display_value}` pair. */
export const rawFlowContentSchema = z.union([
  rawScalarSchema,
  z.object({
    value: rawScalarSchema.optional(),
    display_value: rawScalarSchema.optional(),
  }),
]);

/**
 * One input from a decoded V2 blob (`values`, `trigger_inputs`,
 * `subflow_inputs`). The type is `parameter.type` (for example `password2`);
 * flow-variable entries also carry `label` and `internalType` directly.
 */
export const rawFlowInputSchema = z.object({
  name: z.string().min(1).max(FLOW_RAW_MAX_TEXT_CHARS),
  value: z.unknown().optional(),
  displayValue: z.unknown().optional(),
  label: rawScalarSchema.optional(),
  internalType: rawScalarSchema.optional(),
  parameter: z
    .object({ label: rawScalarSchema.optional(), type: rawScalarSchema.optional() })
    .nullable()
    .optional(),
  scriptActive: z.boolean().optional(),
});

/**
 * A decoded action `values`, `trigger_inputs` or `subflow_inputs` blob: an
 * array of inputs. Entries are validated one at a time with
 * rawFlowInputSchema, so a bad input drops only itself.
 */
export const rawFlowInputListSchema = z.array(z.unknown()).max(FLOW_RAW_MAX_ITEMS);

/**
 * A decoded logic `values` blob: an object whose `inputs` (conditions, For
 * Each items, …) and `variables` (Set Flow Variables) are input arrays.
 */
export const rawFlowLogicValuesSchema = z.object({
  inputs: rawFlowInputListSchema.optional(),
  variables: rawFlowInputListSchema.optional(),
});

/** One entry of the `sys_hub_flow.label_cache` JSON array (plain JSON, not gzip). */
export const rawLabelCacheEntrySchema = z.object({
  name: z.string().min(1).max(FLOW_RAW_MAX_TEXT_CHARS),
  label: rawScalarSchema.optional(),
});

