import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { isSensitiveFieldName } from "../src/field-policy.js";
import * as contracts from "../src/tools/flow-view-contracts.js";
import {
  FLOW_ELEMENT_SOURCES,
  FLOW_GRAPH_RESERVED_ENVELOPE_KEYS,
  FLOW_GRAPH_SCHEMA_BOUNDS,
  FLOW_LIMIT_HITS,
  FLOW_LOGIC_KINDS,
  FLOW_LOGIC_NAME_KINDS,
  FLOW_LOGIC_TYPE_KINDS,
  FLOW_SOURCE_NAMES,
  FLOW_TABLE_FIELDS,
  FLOW_VALUE_ELEMENT_KEYS,
  FLOW_VIEW_LIMITS,
  FLOW_VIEW_TABLES,
  FLOW_WARNING_CODES,
  FlowViewArgumentError,
  canonicalFlowViewArgs,
  flowGraphSchema,
  flowLogicKindFromName,
  rawFlowContentSchema,
  rawFlowInputListSchema,
  rawFlowInputSchema,
  rawFlowLogicValuesSchema,
  rawFlowUidSchema,
  rawLabelCacheEntrySchema,
  type FlowGraph,
  type FlowNode,
  type FlowTableName,
} from "../src/tools/flow-view-contracts.js";
import { envelopeCompatibilityResult } from "../src/tools/result-envelope.js";

const FLOW_ID = "0123456789abcdef0123456789abcdef";
const SUBFLOW_ID = "fedcba9876543210fedcba9876543210";
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;

// Sanitized Table API capture (Brazil patch 0), read with display_value=all.
const FIXTURES = new URL("./fixtures/flow-view/table/brazil-patch0/", import.meta.url);
type Cell = { value: string; display_value: string };
type Row = Record<string, Cell>;
type Capture = Record<string, { rows: Row[] }>;
const CAPTURES: ReadonlyMap<string, Capture> = new Map(
  readdirSync(FIXTURES)
    .filter((file) => file.startsWith("tables-"))
    .map((file) => [file, JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as Capture])
);
const SCHEMA = JSON.parse(readFileSync(new URL("schema-columns.json", FIXTURES), "utf8")) as Record<
  string,
  { chain: string[]; cols: string[] }
>;
const LOGIC_TABLES = ["sys_hub_flow_logic", "sys_hub_flow_logic_instance_v2"] as const;

function rowsOf(table: string): Row[] {
  return [...CAPTURES.values()].flatMap((capture) => capture[table]?.rows ?? []);
}

function decode(blob: string): unknown {
  return JSON.parse(gunzipSync(Buffer.from(blob, "base64")).toString("utf8"));
}

function text(value: string | null) {
  return { text: value };
}

function node(index: number, overrides: Partial<FlowNode> = {}): FlowNode {
  return {
    id: `n${index}`,
    flow_index: 0,
    kind: "action",
    step: String(index),
    depth: 0,
    order: index * 100,
    title: text(`Step ${index}`),
    annotation: text(null),
    ...overrides,
  };
}

function sampleGraph(): FlowGraph {
  return {
    schema_version: 1,
    source: "table",
    flows: [
      {
        index: 0,
        source: "table",
        sys_id: FLOW_ID,
        name: text("Route incident"),
        description: { text: null, redacted: "field_policy" },
        type: "flow",
        active: true,
        status: "published",
        version: "3",
        scope: "global",
      },
      {
        index: 1,
        source: "table",
        sys_id: SUBFLOW_ID,
        name: text("Notify"),
        description: text(null),
        type: "subflow",
        active: null,
        status: null,
        version: null,
        scope: null,
        called_from: "n2",
      },
    ],
    trigger: {
      node_id: "n0",
      type: text("record_create"),
      table: text("incident"),
      condition: text("priority=1"),
      schedule: text(null),
      inputs: [{ name: "table", label: "Table", type: "table_name", value: "incident" }],
    },
    nodes: [
      node(1, { kind: "logic", logic_kind: "if", condition: text("Priority is 1") }),
      node(2, {
        kind: "subflow",
        step: "1.1",
        depth: 1,
        parent: "n1",
        subflow: { flow_sys_id: SUBFLOW_ID, name: text("Notify"), expanded_index: 1 },
        ref: { table: "sys_hub_sub_flow_instance_v2", sys_id: FLOW_ID },
        inputs: [
          {
            name: "api_key",
            label: "API Key",
            type: "string",
            value: null,
            redacted: "sensitive_name",
          },
          {
            name: "message",
            label: "Message",
            type: "string",
            value: "Hello {{label}}",
            pills: [0],
            original_length: 2_400,
          },
        ],
      }),
      node(3, { kind: "logic", logic_kind: "top_level_try", order: null }),
      node(4, { kind: "more", omitted_steps: 12, order: null }),
    ],
    edges: [
      { from: "n0", to: "n1", kind: "next" },
      { from: "n1", to: "n2", kind: "true" },
    ],
    pills: [{ token: "{{trigger.current.number}}", label: "Trigger > Number" }],
    variables: [
      { scope: "input", flow_index: 1, name: "message", label: "Message", type: "string" },
    ],
    options: { depth: 2, include_inputs: true, max_nodes: 150, format: "both" },
    limits_hit: ["max_nodes"],
    warnings: ["orphan_steps"],
    counts: {
      steps_seen: 15,
      nodes_returned: 5,
      inputs_redacted: 1,
      inputs_truncated: 1,
      items_dropped: 0,
    },
  };
}

function parses(candidate: unknown): boolean {
  return flowGraphSchema.safeParse(candidate).success;
}

describe("sn_flow_view limits", () => {
  it("freezes the design limits", () => {
    expect(Object.isFrozen(FLOW_VIEW_LIMITS)).toBe(true);
    expect(FLOW_VIEW_LIMITS).toMatchObject({
      DEFAULT_MAX_NODES: 150,
      MIN_MAX_NODES: 10,
      MAX_MAX_NODES: 300,
      DEFAULT_DEPTH: 1,
      MAX_DEPTH: 3,
      MAX_SUBFLOW_EXPANSIONS: 8,
      MAX_UPSTREAM_SCOPES: 12,
      MAX_ROWS_PER_TABLE: 500,
      MAX_INPUTS_PER_NODE: 40,
      MAX_INPUT_VALUE_CHARS: 2_000,
      MAX_EDGES: 600,
      MAX_WARNINGS: 20,
      DEFAULT_MAX_RESPONSE_BYTES: 100_000,
      STRUCTURED_SHARE: 0.55,
    });
    expect(Object.isFrozen(FLOW_GRAPH_SCHEMA_BOUNDS)).toBe(true);
    expect(FLOW_GRAPH_SCHEMA_BOUNDS.MAX_FLOWS).toBe(9);
    expect(FLOW_GRAPH_SCHEMA_BOUNDS.MAX_NODES).toBe(302);
  });
});

describe("Table API only", () => {
  it("has a single source and no ProcessFlow surface", () => {
    expect(FLOW_SOURCE_NAMES).toEqual(["table"]);
    const exported = Object.keys(contracts).join(" ").toLowerCase();
    expect(exported).not.toMatch(/processflow|fallback|source_request/u);
    expect(FLOW_WARNING_CODES).not.toContain("processflow_fallback" as never);
    expect(FLOW_VIEW_TABLES).not.toContain("sys_hub_flow_version" as never);
  });

  it("rejects a graph that still claims ProcessFlow or fallback detail", () => {
    expect(parses({ ...sampleGraph(), source: "processflow" })).toBe(false);
    expect(parses({ ...sampleGraph(), source_detail: { requested: "auto" } })).toBe(false);
  });
});

describe("flowGraphSchema", () => {
  it("accepts a complete graph and keeps it unchanged", () => {
    const graph = sampleGraph();
    const parsed = flowGraphSchema.safeParse(graph);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(graph);
  });

  it("never uses a key the result-envelope adapter inspects", () => {
    const keys = Object.keys(flowGraphSchema.shape);
    for (const reserved of FLOW_GRAPH_RESERVED_ENVELOPE_KEYS) {
      expect(keys).not.toContain(reserved);
    }
    expect(FLOW_GRAPH_RESERVED_ENVELOPE_KEYS).toEqual([
      "results", "runs", "failures", "execution", "relationships", "fields", "result", "request",
      "limit", "offset", "has_more", "next_offset", "truncated", "dropped_records", "record_count", "meta",
    ]);
  });

  it("stays a single, untouched result through the envelope adapter", () => {
    const graph = sampleGraph();
    // sn_atf_readiness passes data through unchanged, as sn_flow_view will.
    const adapted = envelopeCompatibilityResult("sn_atf_readiness", {}, {
      content: [{ type: "text", text: JSON.stringify(graph) }],
    });
    const structured = adapted.structuredContent as {
      data: unknown;
      metadata: { kind: string };
    };
    expect(structured.metadata.kind).toBe("single");
    expect(structured.data).toEqual(graph);
  });

  it("rejects unknown keys at every level", () => {
    const root = { ...sampleGraph(), extra: true };
    expect(parses(root)).toBe(false);

    const nodeExtra = sampleGraph();
    (nodeExtra.nodes[0] as unknown as Record<string, unknown>).html = "<b>";
    expect(parses(nodeExtra)).toBe(false);

    const textExtra = sampleGraph();
    (textExtra.flows[0]!.name as unknown as Record<string, unknown>).raw = "x";
    expect(parses(textExtra)).toBe(false);

    const inputExtra = sampleGraph();
    (inputExtra.trigger!.inputs![0] as unknown as Record<string, unknown>).secret = "x";
    expect(parses(inputExtra)).toBe(false);

    const countsExtra = sampleGraph();
    (countsExtra.counts as unknown as Record<string, unknown>).limit = 1;
    expect(parses(countsExtra)).toBe(false);
  });

  it("enforces generated node ids and sys_ids", () => {
    for (const id of ["n", "n12345", "x1", "n1 ", "<n1>", "1"]) {
      const graph = sampleGraph();
      graph.nodes[0]!.id = id;
      expect(parses(graph)).toBe(false);
    }
    const edge = sampleGraph();
    edge.edges[0]!.to = "click";
    expect(parses(edge)).toBe(false);

    const header = sampleGraph();
    header.flows[0]!.sys_id = "not-a-sys-id";
    expect(parses(header)).toBe(false);

    const ref = sampleGraph();
    ref.nodes[1]!.ref = { table: "incident" as never, sys_id: FLOW_ID };
    expect(parses(ref)).toBe(false);

    const trigger = sampleGraph();
    (trigger.trigger as unknown as Record<string, unknown>).node_id = "n1";
    expect(parses(trigger)).toBe(false);

    const step = sampleGraph();
    step.nodes[0]!.step = "1.2]";
    expect(parses(step)).toBe(false);
  });

  it("bounds every array and string", () => {
    const tooManyNodes = sampleGraph();
    tooManyNodes.nodes = Array.from({ length: FLOW_GRAPH_SCHEMA_BOUNDS.MAX_NODES + 1 }, (_, index) =>
      node(index + 1)
    );
    expect(parses(tooManyNodes)).toBe(false);
    tooManyNodes.nodes.pop();
    expect(parses(tooManyNodes)).toBe(true);

    const tooManyEdges = sampleGraph();
    tooManyEdges.edges = Array.from({ length: FLOW_VIEW_LIMITS.MAX_EDGES + 1 }, () => ({
      from: "n1",
      to: "n2",
      kind: "next" as const,
    }));
    expect(parses(tooManyEdges)).toBe(false);

    const tooManyPills = sampleGraph();
    tooManyPills.pills = Array.from({ length: FLOW_VIEW_LIMITS.MAX_PILLS + 1 }, () => ({
      token: "{{a}}",
      label: null,
    }));
    expect(parses(tooManyPills)).toBe(false);

    const tooManyWarnings = sampleGraph();
    tooManyWarnings.warnings = Array.from(
      { length: FLOW_VIEW_LIMITS.MAX_WARNINGS + 1 },
      () => "orphan_steps" as const
    );
    expect(parses(tooManyWarnings)).toBe(false);

    const tooManyInputs = sampleGraph();
    tooManyInputs.nodes[0]!.inputs = Array.from(
      { length: FLOW_VIEW_LIMITS.MAX_INPUTS_PER_NODE + 1 },
      () => ({ name: "a", label: null, type: null, value: null })
    );
    expect(parses(tooManyInputs)).toBe(false);

    const longValue = sampleGraph();
    longValue.trigger!.inputs![0]!.value = "x".repeat(FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS + 1);
    expect(parses(longValue)).toBe(false);

    const longName = sampleGraph();
    longName.trigger!.inputs![0]!.name = "x".repeat(FLOW_VIEW_LIMITS.MAX_NAME_CHARS + 1);
    expect(parses(longName)).toBe(false);

    const longText = sampleGraph();
    longText.nodes[0]!.title = text("x".repeat(FLOW_GRAPH_SCHEMA_BOUNDS.MAX_TEXT_CHARS + 1));
    expect(parses(longText)).toBe(false);

    const badPill = sampleGraph();
    badPill.nodes[1]!.inputs![1]!.pills = [FLOW_VIEW_LIMITS.MAX_PILLS];
    expect(parses(badPill)).toBe(false);

    const tooManyFlows = sampleGraph();
    tooManyFlows.flows = Array.from({ length: FLOW_GRAPH_SCHEMA_BOUNDS.MAX_FLOWS + 1 }, () =>
      sampleGraph().flows[0]!
    );
    expect(parses(tooManyFlows)).toBe(false);

    const badOptions = sampleGraph();
    badOptions.options.max_nodes = FLOW_VIEW_LIMITS.MAX_MAX_NODES + 1;
    expect(parses(badOptions)).toBe(false);

    const negative = sampleGraph();
    negative.counts.items_dropped = -1;
    expect(parses(negative)).toBe(false);
  });

  it("accepts only the closed vocabularies", () => {
    const warning = sampleGraph();
    (warning.warnings as string[]).push("see https://evil.example");
    expect(parses(warning)).toBe(false);

    const limit = sampleGraph();
    (limit.limits_hit as string[]).push("other");
    expect(parses(limit)).toBe(false);

    const redaction = sampleGraph();
    (redaction.flows[0]!.description as { redacted: string }).redacted = "because";
    expect(parses(redaction)).toBe(false);

    const logic = sampleGraph();
    (logic.nodes[0] as { logic_kind: string }).logic_kind = "end";
    expect(parses(logic)).toBe(false);

    expect(FLOW_LIMIT_HITS).toHaveLength(11);
    expect(FLOW_WARNING_CODES).toHaveLength(13);
    expect(Object.isFrozen(FLOW_LIMIT_HITS)).toBe(true);
  });
});

describe("flow table closure", () => {
  it("names 15 distinct tables with a field spec each", () => {
    expect(FLOW_VIEW_TABLES).toHaveLength(15);
    expect(new Set(FLOW_VIEW_TABLES).size).toBe(15);
    expect(Object.keys(FLOW_TABLE_FIELDS).sort()).toEqual([...FLOW_VIEW_TABLES].sort());
    expect(Object.isFrozen(FLOW_VIEW_TABLES)).toBe(true);
    expect(Object.isFrozen(FLOW_TABLE_FIELDS)).toBe(true);
  });

  it("declares valid, non-sensitive, non-overlapping field names", () => {
    for (const table of FLOW_VIEW_TABLES) {
      const spec = FLOW_TABLE_FIELDS[table];
      expect(Object.isFrozen(spec.required)).toBe(true);
      expect(spec.required).toContain("sys_id");
      const all = [...spec.required, ...spec.optional, ...spec.values];
      expect(new Set(all).size).toBe(all.length);
      for (const field of all) {
        expect(field).toMatch(FIELD_NAME);
        expect(isSensitiveFieldName(field)).toBe(false);
      }
    }
  });

  it("declares only columns that exist on Brazil patch 0", () => {
    for (const table of FLOW_VIEW_TABLES) {
      // var_dictionary was not captured on its own; flow inputs extend it.
      const captured = table === "var_dictionary" ? "sys_hub_flow_input" : table;
      if (table === "var_dictionary") {
        expect(SCHEMA[captured]!.chain).toContain("var_dictionary");
      }
      const columns = new Set(SCHEMA[captured]!.cols);
      const spec = FLOW_TABLE_FIELDS[table];
      for (const field of [...spec.required, ...spec.optional, ...spec.values]) {
        expect(columns.has(field), `${table}.${field}`).toBe(true);
      }
    }
  });

  it("applies the capture's corrections", () => {
    for (const table of ["sys_hub_flow_variable", "sys_hub_flow_input", "sys_hub_flow_output"] as const) {
      expect(FLOW_TABLE_FIELDS[table].optional).toContain("internal_type");
      expect(FLOW_TABLE_FIELDS[table].required).toContain("element");
      expect([...FLOW_TABLE_FIELDS[table].required, ...FLOW_TABLE_FIELDS[table].optional]).not.toContain(
        "type"
      );
    }
    for (const table of ["sys_hub_trigger_instance", "sys_hub_trigger_instance_v2"] as const) {
      expect(FLOW_TABLE_FIELDS[table].optional).not.toContain("active");
    }
    expect(FLOW_TABLE_FIELDS.sys_hub_trigger_instance_v2.values).toEqual(["trigger_inputs"]);
    expect(FLOW_TABLE_FIELDS.sys_hub_sub_flow_instance_v2.values).toEqual(["subflow_inputs"]);
    // V1 glide_var columns read empty; V1 values come from sys_variable_value.
    expect(FLOW_TABLE_FIELDS.sys_hub_flow_logic.values).toEqual([]);
    expect(FLOW_TABLE_FIELDS.sys_hub_action_instance.values).toEqual([]);
    for (const table of LOGIC_TABLES) {
      expect(FLOW_TABLE_FIELDS[table].required).toContain("connected_to");
    }
    expect(FLOW_TABLE_FIELDS.sys_hub_flow.optional).toContain("label_cache");
    expect(FLOW_TABLE_FIELDS.var_dictionary.values).toEqual(["element", "internal_type"]);
  });

  it("maps every element only to declared fields, values only to value fields", () => {
    const valueKeys = new Set<string>(FLOW_VALUE_ELEMENT_KEYS);
    for (const [element, pairs] of Object.entries(FLOW_ELEMENT_SOURCES)) {
      expect(pairs.length).toBeGreaterThan(0);
      for (const [table, field] of pairs) {
        const spec = FLOW_TABLE_FIELDS[table];
        expect(spec, `${element} -> ${table}`).toBeDefined();
        if (valueKeys.has(element)) {
          expect(spec.values, `${element} -> ${table}.${field}`).toContain(field);
        } else {
          expect([...spec.required, ...spec.optional], `${element} -> ${table}.${field}`).toContain(
            field
          );
        }
      }
    }
    expect(FLOW_ELEMENT_SOURCES.action_annotation).toEqual([
      ["sys_hub_action_instance", "comment"],
      ["sys_hub_action_instance_v2", "comment"],
    ]);
    // Every input element needs its V2 blob and the V1 value with its typing.
    for (const [element, blob] of [
      ["trigger_inputs", ["sys_hub_trigger_instance_v2", "trigger_inputs"]],
      ["action_inputs", ["sys_hub_action_instance_v2", "values"]],
      ["logic_inputs", ["sys_hub_flow_logic_instance_v2", "values"]],
      ["subflow_inputs", ["sys_hub_sub_flow_instance_v2", "subflow_inputs"]],
    ] as const) {
      expect(FLOW_ELEMENT_SOURCES[element]).toEqual([
        blob,
        ["sys_variable_value", "value"],
        ["var_dictionary", "element"],
        ["var_dictionary", "internal_type"],
      ]);
    }
    expect(FLOW_ELEMENT_SOURCES.flow_inputs).toEqual([
      ["sys_hub_flow_input", "element"],
      ["sys_hub_flow_input", "label"],
      ["sys_hub_flow_input", "internal_type"],
    ]);
  });

  it("fixture rows carry every declared field of their table", () => {
    for (const [file, capture] of CAPTURES) {
      for (const table of FLOW_VIEW_TABLES) {
        for (const row of capture[table]?.rows ?? []) {
          const spec = FLOW_TABLE_FIELDS[table];
          for (const field of [...spec.required, ...spec.optional, ...spec.values]) {
            expect(Object.hasOwn(row, field), `${file} ${table}.${field}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("logic kinds", () => {
  it("maps every captured type code and name to a valid, non-other kind", () => {
    const kinds = new Set<string>(FLOW_LOGIC_KINDS);
    expect(Object.keys(FLOW_LOGIC_TYPE_KINDS)).toHaveLength(26);
    for (const kind of [...Object.values(FLOW_LOGIC_TYPE_KINDS), ...Object.values(FLOW_LOGIC_NAME_KINDS)]) {
      expect(kinds.has(kind)).toBe(true);
      expect(kind).not.toBe("other");
    }
    expect(new Set(Object.values(FLOW_LOGIC_NAME_KINDS))).toEqual(
      new Set(Object.values(FLOW_LOGIC_TYPE_KINDS))
    );
    expect(FLOW_LOGIC_TYPE_KINDS).toMatchObject({
      PARALLELBLOCK: "parallel_branch",
      TOP_LEVEL_TRY: "top_level_try",
      TOP_LEVEL_CATCH: "top_level_catch",
      END: "end_flow",
      DECISION: "decision",
      DECISIONBLOCK: "decision_branch",
    });
  });

  it("recognizes every logic definition in the fixtures", () => {
    const names = new Set(
      LOGIC_TABLES.flatMap((table) => rowsOf(table).map((row) => row.logic_definition!.display_value))
    );
    expect(names.size).toBeGreaterThanOrEqual(16);
    for (const name of names) {
      expect(flowLogicKindFromName(name), name).not.toBe("other");
    }
    expect(flowLogicKindFromName("  Top   level TRY ")).toBe("top_level_try");
    expect(flowLogicKindFromName("Si")).toBe("other");
    expect(flowLogicKindFromName("toString")).toBe("other");
    expect(flowLogicKindFromName(undefined)).toBe("other");
  });

  it("pairs Else, Else If and Catch with their head through connected_to", () => {
    let paired = 0;
    for (const capture of CAPTURES.values()) {
      for (const table of LOGIC_TABLES) {
        const rows = capture[table]?.rows ?? [];
        const byUid = new Map(rows.map((row) => [row.ui_id!.value, row]));
        for (const row of rows) {
          const kind = flowLogicKindFromName(row.logic_definition!.display_value);
          if (!["else", "else_if", "catch"].includes(kind)) continue;
          const head = byUid.get(row.connected_to!.value);
          expect(head, `${kind} without head`).toBeDefined();
          expect(["if", "try"]).toContain(flowLogicKindFromName(head!.logic_definition!.display_value));
          expect(head!.parent_ui_id!.value).toBe(row.parent_ui_id!.value);
          paired += 1;
        }
      }
    }
    expect(paired).toBeGreaterThan(10);
  });
});

describe("canonicalFlowViewArgs", () => {
  it("applies every default", () => {
    expect(canonicalFlowViewArgs({ profile: "dev", flow: "  Route incident " })).toEqual({
      flow: "Route incident",
      depth: 1,
      include_inputs: true,
      format: "both",
      max_nodes: 150,
      max_response_bytes: 100_000,
    });
  });

  it("keeps explicit values and lowercases a sys_id", () => {
    const canonical = canonicalFlowViewArgs({
      flow: FLOW_ID.toUpperCase(),
      depth: 3,
      include_inputs: false,
      format: "outline",
      max_nodes: 10,
      max_response_bytes: 1_000_000,
    });
    expect(canonical).toEqual({
      flow: FLOW_ID,
      depth: 3,
      include_inputs: false,
      format: "outline",
      max_nodes: 10,
      max_response_bytes: 1_000_000,
    });
    expect(Object.isFrozen(canonical)).toBe(true);
  });

  it("rejects out-of-range or malformed values", () => {
    for (const args of [
      {},
      { flow: "" },
      { flow: "   " },
      { flow: "x".repeat(101) },
      { flow: 7 },
      { flow: "a", depth: 0 },
      { flow: "a", depth: 4 },
      { flow: "a", depth: 1.5 },
      { flow: "a", include_inputs: "yes" },
      { flow: "a", format: "html" },
      { flow: "a", max_nodes: 9 },
      { flow: "a", max_nodes: 301 },
      { flow: "a", max_response_bytes: 9_999 },
      { flow: "a", max_response_bytes: 1_000_001 },
    ]) {
      expect(() => canonicalFlowViewArgs(args), JSON.stringify(args)).toThrow(
        FlowViewArgumentError
      );
    }
  });
});

describe("raw Table API schemas against the capture", () => {
  it("accepts every ui_id, parent_ui_id and connected_to", () => {
    let checked = 0;
    for (const table of [
      "sys_hub_action_instance",
      "sys_hub_action_instance_v2",
      ...LOGIC_TABLES,
      "sys_hub_sub_flow_instance",
      "sys_hub_sub_flow_instance_v2",
    ]) {
      for (const row of rowsOf(table)) {
        expect(rawFlowUidSchema.safeParse(row.ui_id!.value).success).toBe(true);
        for (const field of ["parent_ui_id", "connected_to"]) {
          const value = row[field]?.value;
          if (value) expect(rawFlowUidSchema.safeParse(value).success, `${table}.${field}`).toBe(true);
        }
        expect(rawFlowContentSchema.safeParse(row.comment).success).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(rawFlowUidSchema.safeParse("../x").success).toBe(false);
  });

  it("parses every decoded V2 blob and keeps only listed input keys", () => {
    let inputs = 0;
    const arrays: [FlowTableName, string][] = [
      ["sys_hub_action_instance_v2", "values"],
      ["sys_hub_trigger_instance_v2", "trigger_inputs"],
      ["sys_hub_sub_flow_instance_v2", "subflow_inputs"],
    ];
    const entries: unknown[] = [];
    for (const [table, field] of arrays) {
      for (const row of rowsOf(table)) {
        if (!row[field]!.value) continue;
        const list = rawFlowInputListSchema.parse(decode(row[field]!.value));
        entries.push(...list);
      }
    }
    for (const row of rowsOf("sys_hub_flow_logic_instance_v2")) {
      if (!row.values!.value) continue;
      const logic = rawFlowLogicValuesSchema.parse(decode(row.values!.value));
      entries.push(...(logic.inputs ?? []), ...(logic.variables ?? []));
    }
    for (const entry of entries) {
      const parsed = rawFlowInputSchema.safeParse(entry);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      inputs += 1;
      expect(Object.keys(parsed.data)).not.toContain("children");
      expect(Object.keys(parsed.data)).not.toContain("actionInstanceSysId");
      if (parsed.data.parameter) {
        expect(Object.keys(parsed.data.parameter).every((key) => ["label", "type"].includes(key))).toBe(
          true
        );
      }
    }
    expect(inputs).toBeGreaterThan(100);
    expect(rawFlowInputSchema.safeParse({ value: "x" }).success).toBe(false);
  });

  it("parses the sys_hub_flow label_cache as plain JSON", () => {
    let entries = 0;
    for (const row of rowsOf("flow")) {
      const cache = row.label_cache?.value;
      if (!cache) continue;
      const parsed = JSON.parse(cache) as unknown[];
      for (const entry of parsed) {
        expect(rawLabelCacheEntrySchema.safeParse(entry).success).toBe(true);
        entries += 1;
      }
    }
    expect(entries).toBeGreaterThan(0);
  });
});
