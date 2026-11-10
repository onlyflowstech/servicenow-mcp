import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FLOW_GRAPH_SCHEMA_BOUNDS,
  FLOW_VIEW_LIMITS,
  flowGraphSchema,
  type FlowGraph,
  type FlowInputValue,
  type FlowLogicKind,
  type FlowText,
  type NormalizedFlowDefinition,
  type NormalizedStep,
} from "../src/tools/flow-view-contracts.js";
import {
  FLOW_GRAPH_BUDGET_STEPS,
  buildFlowGraph,
  fitFlowGraphToBudget,
  subflowCallTargets,
  type FlowGraphBuildInput,
  type FlowSubflowUnavailable,
} from "../src/tools/flow-view-graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sid = (n: number): string => n.toString(16).padStart(32, "0");
const ROOT_ID = sid(0xa);
const FIXTURE_CALLEE = "3333333333333333333333333333cccc";
const text = (value: string | null | undefined): FlowText => ({ text: value ?? null });

interface RawInput {
  name: string;
  value?: string | null;
  label?: string | null;
  type?: string | null;
  redacted?: FlowInputValue["redacted"];
  script?: boolean;
  original_length?: number;
}
interface RawStep {
  uid: string;
  parent_uid?: string | null;
  order?: number | null;
  connected_uid?: string | null;
  kind?: "action" | "logic" | "subflow";
  logic_kind?: string;
  title?: string;
  condition?: string;
  inputs?: RawInput[];
  subflow?: { flow_sys_id: string | null; name?: string };
}
interface RawDef {
  header?: { sys_id?: string; name?: string; type?: string; active?: boolean; status?: string; version?: string; scope?: string };
  trigger?: { type?: string; table?: string; condition?: string; schedule?: string; inputs?: RawInput[] } | null;
  steps: RawStep[];
  label_cache?: Array<[string, string]>;
  variables?: NormalizedFlowDefinition["variables"];
  warnings?: NormalizedFlowDefinition["warnings"];
  limits_hit?: NormalizedFlowDefinition["limits_hit"];
  items_dropped?: number;
}

function input(raw: RawInput): FlowInputValue {
  const out: FlowInputValue = { name: raw.name, label: raw.label ?? null, type: raw.type ?? null, value: raw.value ?? null };
  if (raw.redacted) out.redacted = raw.redacted;
  if (raw.script) out.script = true;
  if (raw.original_length !== undefined) out.original_length = raw.original_length;
  return out;
}

function toStep(raw: RawStep): NormalizedStep {
  const kind = raw.kind ?? (raw.logic_kind !== undefined ? "logic" : "action");
  const step: NormalizedStep = {
    uid: raw.uid,
    parent_uid: raw.parent_uid ?? null,
    order: raw.order ?? null,
    connected_uid: raw.connected_uid ?? null,
    kind,
    title: text(raw.title ?? raw.uid),
    annotation: text(null),
    inputs: (raw.inputs ?? []).map(input),
  };
  if (raw.logic_kind !== undefined) step.logic_kind = raw.logic_kind as FlowLogicKind;
  if (raw.condition !== undefined) step.condition = text(raw.condition);
  if (raw.subflow) step.subflow = { flow_sys_id: raw.subflow.flow_sys_id, name: text(raw.subflow.name ?? "Subflow") };
  return step;
}

function def(raw: RawDef): NormalizedFlowDefinition {
  const h = raw.header ?? {};
  const trigger = raw.trigger;
  return {
    source: "table",
    header: {
      sys_id: h.sys_id ?? ROOT_ID,
      name: text(h.name ?? "Test flow"),
      description: text(null),
      type: (h.type as "flow" | "subflow" | undefined) ?? "flow",
      active: h.active ?? true,
      status: h.status ?? "Published",
      version: h.version ?? "1",
      scope: h.scope ?? "global",
    },
    trigger: trigger
      ? {
          type: text(trigger.type ?? "Created"),
          table: text(trigger.table ?? "incident"),
          condition: text(trigger.condition ?? null),
          schedule: text(trigger.schedule ?? null),
          ...(trigger.inputs ? { inputs: trigger.inputs.map(input) } : {}),
        }
      : null,
    steps: raw.steps.map(toStep),
    label_cache: raw.label_cache ?? [],
    variables: raw.variables ?? [],
    warnings: raw.warnings ?? [],
    limits_hit: raw.limits_hit ?? [],
    items_dropped: raw.items_dropped ?? 0,
  };
}

const FIXTURE_DIR = new URL("./fixtures/flow-view/normalized/", import.meta.url);
function fixture(name: string): NormalizedFlowDefinition {
  const json = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as RawDef & {
    header: Record<string, string | boolean>;
  };
  return def(json as RawDef);
}

const OPTIONS: FlowGraphBuildInput["options"] = {
  depth: 1, include_inputs: true, max_nodes: 150, format: "both", max_response_bytes: 1_000_000,
};

function build(
  root: NormalizedFlowDefinition,
  options: Partial<FlowGraphBuildInput["options"]> = {},
  subflows?: Map<string, NormalizedFlowDefinition | FlowSubflowUnavailable>,
  extra: Partial<FlowGraphBuildInput> = {}
): FlowGraph {
  const graph = buildFlowGraph({ root, ...(subflows ? { subflows } : {}), options: { ...OPTIONS, ...options }, ...extra });
  expectValid(graph);
  return graph;
}

function expectValid(graph: FlowGraph): void {
  const parsed = flowGraphSchema.safeParse(graph);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5)));
}

/** "from>to:kind" using outline step numbers (and TRIG for the trigger). */
function edgesOf(graph: FlowGraph): string[] {
  const label = new Map<string, string>([["n0", "TRIG"]]);
  for (const node of graph.nodes) label.set(node.id, node.kind === "more" ? "MORE" : node.step);
  return graph.edges.map((e) => `${label.get(e.from)}>${label.get(e.to)}:${e.kind}`);
}
const sorted = (xs: string[]): string[] => [...xs].sort();
const bytes = (x: unknown): number => Buffer.byteLength(JSON.stringify(x));
const clone = <T,>(x: T): T => structuredClone(x);

function chain(count: number, extra: (i: number) => Partial<RawStep> = () => ({})): RawStep[] {
  return Array.from({ length: count }, (_, i) => ({ uid: `s${i + 1}`, order: i + 1, title: `A${i + 1}`, ...extra(i) }));
}

// ---------------------------------------------------------------------------
// IDs and numbering
// ---------------------------------------------------------------------------

describe("buildFlowGraph ids, numbering and basics", () => {
  it("generates n1.. ids in walk order and never uses instance data", () => {
    const evil = 'n99"]; click x';
    const graph = build(def({
      trigger: {},
      steps: [
        { uid: evil, order: 1, title: "A" },
        { uid: "b", order: 2, kind: "logic", logic_kind: "for_each", title: "Loop" },
        { uid: "c", parent_uid: "b", order: 1, title: "Inner" },
      ],
    }));
    expect(graph.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(graph.trigger?.node_id).toBe("n0");
    expect(JSON.stringify(graph)).not.toContain("click x");
    expect(graph.nodes[2]!.parent).toBe("n2");
    expect(graph.schema_version).toBe(1);
    expect(graph.source).toBe("table");
  });

  it("numbers steps like 3.2.1 and gives depth relative to the flow", () => {
    const graph = build(def({
      steps: [
        { uid: "a", order: 1, title: "A" },
        { uid: "b", order: 2, title: "B" },
        { uid: "c", order: 3, kind: "logic", logic_kind: "for_each", title: "C" },
        { uid: "d", parent_uid: "c", order: 1, title: "D" },
        { uid: "e", parent_uid: "c", order: 2, kind: "logic", logic_kind: "for_each", title: "E" },
        { uid: "f", parent_uid: "e", order: 1, title: "F" },
      ],
    }));
    expect(graph.nodes.map((n) => [n.step, n.depth])).toEqual([
      ["1", 0], ["2", 0], ["3", 0], ["3.1", 1], ["3.2", 1], ["3.2.1", 2],
    ]);
  });

  it("sorts siblings by order (nulls last) and breaks ties by input position", () => {
    const graph = build(def({
      steps: [
        { uid: "z", order: null, title: "Z" },
        { uid: "b", order: 2, title: "B" },
        { uid: "a", order: 1, title: "A" },
        { uid: "b2", order: 2, title: "B2" },
      ],
    }));
    expect(graph.nodes.map((n) => n.title.text)).toEqual(["A", "B", "B2", "Z"]);
  });

  it("chains actions with next edges and connects the trigger", () => {
    const graph = build(def({ trigger: {}, steps: chain(3) }));
    expect(edgesOf(graph)).toEqual(["TRIG>1:next", "1>2:next", "2>3:next"]);
  });

  it("copies the header, variables and counts; empty flows are valid", () => {
    const graph = build(def({
      header: { name: "Flow X", status: "Draft", version: "7" },
      variables: [{ scope: "input", name: "who", label: "Who", type: "string" }],
      steps: [],
      trigger: {},
    }));
    expect(graph.flows[0]).toMatchObject({ index: 0, source: "table", sys_id: ROOT_ID, status: "Draft", version: "7" });
    expect(graph.variables).toEqual([{ scope: "input", flow_index: 0, name: "who", label: "Who", type: "string" }]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.counts).toEqual({ steps_seen: 0, nodes_returned: 0, inputs_redacted: 0, inputs_truncated: 0, items_dropped: 0 });
  });

  it("is deterministic", () => {
    const root = fixture("nested-if");
    expect(JSON.stringify(build(root))).toBe(JSON.stringify(build(root)));
  });

  it("omits inputs entirely when include_inputs is false", () => {
    const graph = build(fixture("nested-if"), { include_inputs: false });
    expect(graph.nodes.some((n) => n.inputs !== undefined)).toBe(false);
    expect(graph.pills).toEqual([]);
    expect(graph.options.include_inputs).toBe(false);
  });

  it("passes loader warnings, limits and dropped counts through", () => {
    const graph = build(
      def({ steps: chain(1), warnings: ["gzip_decode_failed"], limits_hit: ["rows_per_table"], items_dropped: 3 }),
      {},
      undefined,
      { limits_hit: ["upstream_scopes"], warnings: ["label_cache_unavailable"] }
    );
    expect(graph.warnings).toEqual(["gzip_decode_failed", "label_cache_unavailable"]);
    expect(graph.limits_hit).toEqual(["upstream_scopes", "rows_per_table"]);
    expect(graph.counts.items_dropped).toBe(3);
  });

  it("drops invalid and duplicate steps with a warning", () => {
    const root = def({ steps: chain(2) });
    root.steps.push(toStep({ uid: "s1", title: "dup" }), { ...toStep({ uid: "x" }), uid: "" });
    const graph = build(root);
    expect(graph.nodes.map((n) => n.title.text)).toEqual(["A1", "A2"]);
    expect(graph.warnings).toContain("items_dropped_invalid");
    expect(graph.counts.items_dropped).toBe(2);
  });

  it("clamps oversized loader text defensively", () => {
    const root = def({ steps: [{ uid: "a", title: "t".repeat(500) }] });
    const graph = build(root);
    expect(graph.nodes[0]!.title.text).toHaveLength(FLOW_VIEW_LIMITS.MAX_TITLE_CHARS);
    expect(graph.nodes[0]!.title.original_length).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Branching
// ---------------------------------------------------------------------------

describe("If / Else If / Else", () => {
  it("builds the capture F1 shape: nested same-named If, End rows, shared parents", () => {
    const graph = build(fixture("nested-if"));
    expect(graph.nodes.map((n) => [n.step, n.logic_kind ?? n.kind, n.depth])).toEqual([
      ["1", "action", 0],
      ["2", "if", 0],
      ["2.1", "if", 1],
      ["2.1.1", "set_flow_variables", 2],
      ["2.1.2", "end_flow", 2],
      ["2.2", "else_if", 1],
      ["2.2.1", "action", 2],
      ["2.2.2", "end_flow", 2],
      ["2.3", "else_if", 1],
      ["2.3.1", "action", 2],
      ["2.4", "else", 1],
      ["2.4.1", "action", 2],
      ["3", "action", 0],
    ]);
    expect(sorted(edgesOf(graph))).toEqual(sorted([
      "TRIG>1:next",
      "1>2:next",
      "2>2.1:true",
      "2.1>2.1.1:true",
      "2.1.1>2.1.2:next",
      "2.1>2.2:false",
      "2.2>2.2.1:true",
      "2.2.1>2.2.2:next",
      "2.2>2.3:false",
      "2.3>2.3.1:true",
      "2.3>2.4:false",
      "2.4>2.4.1:next",
      // branch ends join at the node after the outer If; End rows do not
      "2.3.1>3:next",
      "2.4.1>3:next",
      // the outer If has no Else, so its false edge also goes there
      "2>3:false",
    ]));
  });

  it("gives Else If and Else the head's parent, not the head", () => {
    const graph = build(fixture("nested-if"));
    const byStep = new Map(graph.nodes.map((n) => [n.step, n]));
    const head = byStep.get("2.1")!;
    for (const step of ["2.2", "2.3", "2.4"]) expect(byStep.get(step)!.parent).toBe(head.parent);
    expect(byStep.get("2.1.1")!.parent).toBe(head.id);
    expect(byStep.get("2.2.1")!.parent).toBe(byStep.get("2.2")!.id);
  });

  it("uses connected_uid, not adjacency, and orders branches by order with Else last", () => {
    const graph = build(def({
      steps: [
        { uid: "if1", order: 1, logic_kind: "if", title: "IF1" },
        { uid: "if2", order: 2, logic_kind: "if", title: "IF2" },
        // all point at IF1 even though IF2 sits between them
        { uid: "el", order: 5, connected_uid: "if1", logic_kind: "else", title: "ELSE" },
        { uid: "ei2", order: 4, connected_uid: "if1", logic_kind: "else_if", title: "EI2" },
        { uid: "ei1", order: 3, connected_uid: "if1", logic_kind: "else_if", title: "EI1" },
        { uid: "x", parent_uid: "if1", order: 1, title: "X" },
        { uid: "after", order: 6, title: "AFTER" },
      ],
    }));
    expect(graph.nodes.map((n) => n.title.text)).toEqual(["IF1", "X", "EI1", "EI2", "ELSE", "IF2", "AFTER"]);
    // Step numbers: IF1=1 body=1.1 EI1=2 EI2=3 ELSE=4 IF2=5 AFTER=6.
    expect(graph.nodes.map((n) => n.step)).toEqual(["1", "1.1", "2", "3", "4", "5", "6"]);
    expect(sorted(edgesOf(graph))).toEqual(sorted([
      "1>1.1:true", "1>2:false", "2>3:false", "3>4:false",
      "1.1>5:next", "4>5:next", "5>6:false", "5>6:true", "2>5:true", "3>5:true",
    ]));
  });

  it("falls back to adjacency when connected_uid is missing or dangling", () => {
    const graph = build(def({
      steps: [
        { uid: "a", order: 1, logic_kind: "if", title: "A" },
        { uid: "b", order: 2, logic_kind: "else", title: "B", connected_uid: "gone" },
        { uid: "c", order: 3, logic_kind: "if", title: "C" },
        { uid: "d", order: 4, logic_kind: "else", title: "D" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>2:false", "1>3:true", "2>3:next", "3>4:false"]));
  });

  it("treats an Else with nothing to attach to as a plain step and warns", () => {
    const graph = build(def({ steps: [{ uid: "a", order: 1, logic_kind: "else", title: "A" }, { uid: "b", order: 2, title: "B" }] }));
    expect(edgesOf(graph)).toEqual(["1>2:next"]);
    expect(graph.warnings).toContain("orphan_steps");
  });

  it("ignores a connected_uid that points at the wrong family", () => {
    const graph = build(def({
      steps: [
        { uid: "t", order: 1, logic_kind: "try", title: "T" },
        { uid: "i", order: 2, logic_kind: "if", title: "I" },
        { uid: "e", order: 3, logic_kind: "else", connected_uid: "t", title: "E" },
      ],
    }));
    // E attaches to the If by adjacency, not to the Try.
    expect(edgesOf(graph)).toContain("2>3:false");
    expect(edgesOf(graph).some((e) => e.endsWith(":error"))).toBe(false);
  });

  it("joins an If without Else to the next node with a false edge, and handles empty branches", () => {
    const graph = build(def({
      steps: [
        { uid: "i", order: 1, logic_kind: "if", title: "I" },
        { uid: "n", order: 2, title: "N" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(["1>2:false", "1>2:true"]);
  });

  it("leaves a trailing If without Else dangling (nothing to join to)", () => {
    const graph = build(def({
      steps: [{ uid: "i", order: 1, logic_kind: "if", title: "I" }, { uid: "b", parent_uid: "i", order: 1, title: "B" }],
    }));
    expect(edgesOf(graph)).toEqual(["1>1.1:true"]);
  });

  it("joins every branch of a complete If/Else to the node after the group", () => {
    const graph = build(def({
      steps: [
        { uid: "i", order: 1, logic_kind: "if", title: "I" },
        { uid: "a", parent_uid: "i", order: 1, title: "A" },
        { uid: "e", parent_uid: null, order: 2, connected_uid: "i", logic_kind: "else", title: "E" },
        { uid: "b", parent_uid: "e", order: 1, title: "B" },
        { uid: "z", order: 3, title: "Z" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>1.1:true", "1>2:false", "2>2.1:next", "1.1>3:next", "2.1>3:next"]));
  });
});

// ---------------------------------------------------------------------------
// Loops, parallel, try/catch, terminals
// ---------------------------------------------------------------------------

describe("loops", () => {
  it("builds For Each with loop_body, loop_back and next", () => {
    const graph = build(def({
      steps: [
        { uid: "l", order: 1, logic_kind: "for_each", title: "L" },
        { uid: "a", parent_uid: "l", order: 1, title: "A" },
        { uid: "b", parent_uid: "l", order: 2, title: "B" },
        { uid: "z", order: 2, title: "Z" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>1.1:loop_body", "1.1>1.2:next", "1.2>1:loop_back", "1>2:next"]));
  });

  it("builds Do Until the same way and survives an empty body", () => {
    const graph = build(def({
      steps: [
        { uid: "d", order: 1, logic_kind: "do_until", title: "D" },
        { uid: "a", parent_uid: "d", order: 1, title: "A" },
        { uid: "e", order: 2, logic_kind: "for_each", title: "E" },
        { uid: "z", order: 3, title: "Z" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>1.1:loop_body", "1.1>1:loop_back", "1>2:next", "2>3:next"]));
  });

  it("sends every open end of the body back to the loop (If without Else at the end)", () => {
    const graph = build(def({
      steps: [
        { uid: "l", order: 1, logic_kind: "for_each", title: "L" },
        { uid: "i", parent_uid: "l", order: 1, logic_kind: "if", title: "I" },
        { uid: "a", parent_uid: "i", order: 1, title: "A" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(sorted([
      "1>1.1:loop_body", "1.1>1.1.1:true", "1.1.1>1:loop_back", "1.1>1:loop_back",
    ]));
  });

  it("treats Skip Iteration and Exit Loop as terminal inside a loop", () => {
    const graph = build(def({
      steps: [
        { uid: "l", order: 1, logic_kind: "for_each", title: "L" },
        { uid: "a", parent_uid: "l", order: 1, title: "A" },
        { uid: "s", parent_uid: "l", order: 2, logic_kind: "skip_iteration", title: "S" },
        { uid: "b", parent_uid: "l", order: 3, title: "B" },
        { uid: "z", order: 2, title: "Z" },
      ],
    }));
    const edges = edgesOf(graph);
    expect(edges).toContain("1.1>1.2:next");
    expect(edges.filter((e) => e.startsWith("1.2>"))).toEqual([]);
    expect(edges.filter((e) => e.endsWith(">1.3:next"))).toEqual([]);
    expect(edges).toContain("1.3>1:loop_back");

    const exit = build(def({
      steps: [
        { uid: "l", order: 1, logic_kind: "do_until", title: "L" },
        { uid: "x", parent_uid: "l", order: 1, logic_kind: "exit_loop", title: "X" },
      ],
    }));
    expect(edgesOf(exit)).toEqual(["1>1.1:loop_body"]);
  });
});

describe("parallel", () => {
  it("fans out one parallel edge per branch and joins branch ends (capture F6a)", () => {
    const graph = build(fixture("parallel"));
    expect(graph.nodes.map((n) => [n.step, n.logic_kind ?? n.kind])).toEqual([
      ["1", "action"], ["2", "parallel"], ["2.1", "parallel_branch"], ["2.1.1", "action"], ["2.1.2", "end_flow"],
      ["2.2", "parallel_branch"], ["2.2.1", "action"], ["3", "action"],
    ]);
    expect(sorted(edgesOf(graph))).toEqual(sorted([
      "TRIG>1:next", "1>2:next", "2>2.1:parallel", "2>2.2:parallel",
      "2.1>2.1.1:next", "2.1.1>2.1.2:next", "2.2>2.2.1:next", "2.2.1>3:next",
    ]));
  });

  it("treats a non-branch child of Parallel as its own branch", () => {
    const graph = build(def({
      steps: [
        { uid: "p", order: 1, logic_kind: "parallel", title: "P" },
        { uid: "a", parent_uid: "p", order: 1, title: "A" },
        { uid: "b", parent_uid: "p", order: 2, title: "B" },
        { uid: "z", order: 2, title: "Z" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>1.1:parallel", "1>1.2:parallel", "1.1>2:next", "1.2>2:next"]));
  });

  it("continues past an empty Parallel", () => {
    const graph = build(def({ steps: [{ uid: "p", order: 1, logic_kind: "parallel" }, { uid: "z", order: 2 }] }));
    expect(edgesOf(graph)).toEqual(["1>2:next"]);
  });
});

describe("try / catch", () => {
  it("connects Try to its body, to Catch with an error edge, and joins both ends", () => {
    const graph = build(def({
      steps: [
        { uid: "t", order: 1, logic_kind: "try", title: "T" },
        { uid: "a", parent_uid: "t", order: 1, title: "A" },
        { uid: "c", order: 2, connected_uid: "t", logic_kind: "catch", title: "C" },
        { uid: "b", parent_uid: "c", order: 1, title: "B" },
        { uid: "z", order: 3, title: "Z" },
      ],
    }));
    expect(graph.nodes.map((n) => [n.step, n.logic_kind ?? n.kind])).toEqual([
      ["1", "try"], ["1.1", "action"], ["2", "catch"], ["2.1", "action"], ["3", "action"],
    ]);
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>1.1:next", "1>2:error", "2>2.1:next", "1.1>3:next", "2.1>3:next"]));
  });

  it("handles a Try nested in an If branch (capture F6b)", () => {
    const graph = build(def({
      steps: [
        { uid: "i", order: 1, logic_kind: "if", title: "I" },
        { uid: "ei", order: 2, connected_uid: "i", logic_kind: "else_if", title: "EI" },
        { uid: "t", parent_uid: "ei", order: 1, logic_kind: "try", title: "T" },
        { uid: "a", parent_uid: "t", order: 1, title: "A" },
        { uid: "c", parent_uid: "ei", order: 2, connected_uid: "t", logic_kind: "catch", title: "C" },
        { uid: "x", parent_uid: "c", order: 1, title: "X" },
      ],
    }));
    expect(graph.nodes.map((n) => n.step)).toEqual(["1", "2", "2.1", "2.1.1", "2.2", "2.2.1"]);
    expect(edgesOf(graph)).toEqual(expect.arrayContaining(["2.1>2.1.1:next", "2.1>2.2:error", "2>2.1:true", "1>2:false"]));
  });

  it("treats Top Level Try / Catch as roots (capture F5)", () => {
    const graph = build(fixture("top-level-try"));
    expect(graph.nodes.map((n) => [n.step, n.logic_kind ?? n.kind, n.depth])).toEqual([
      ["1", "top_level_try", 0],
      ["1.1", "for_each", 1],
      ["1.1.1", "if", 2],
      ["1.1.1.1", "action", 3],
      ["1.1.2", "else", 2],
      ["1.1.2.1", "action", 3],
      ["1.2", "subflow", 1],
      ["1.3", "assign_subflow_outputs", 1],
      ["2", "top_level_catch", 0],
      ["2.1", "action", 1],
    ]);
    expect(graph.nodes.filter((n) => n.depth === 0).every((n) => n.parent === undefined)).toBe(true);
    expect(sorted(edgesOf(graph))).toEqual(sorted([
      "1>1.1:next", "1.1>1.1.1:loop_body", "1.1.1>1.1.1.1:true", "1.1.1>1.1.2:false", "1.1.2>1.1.2.1:next",
      "1.1.1.1>1.1:loop_back", "1.1.2.1>1.1:loop_back", "1.1>1.2:next", "1.2>1.3:next", "1>2:error", "2>2.1:next",
    ]));
    // depth 1: the subflow call is reported, not expanded
    expect(graph.nodes.find((n) => n.step === "1.2")!.subflow).toMatchObject({
      flow_sys_id: FIXTURE_CALLEE, not_expanded: "depth",
    });
    expect(graph.limits_hit).toContain("max_depth");
  });

  it("attaches a Top Level Catch by adjacency when connected_uid is missing", () => {
    const graph = build(def({
      steps: [
        { uid: "t", order: 0, logic_kind: "top_level_try", title: "T" },
        { uid: "a", parent_uid: "t", order: 1, title: "A" },
        { uid: "c", order: 1, logic_kind: "top_level_catch", title: "C" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>1.1:next", "1>2:error"]));
  });
});

describe("terminal steps", () => {
  it("End Flow has no outgoing edge and its successors get no incoming edge", () => {
    const graph = build(def({
      steps: [
        { uid: "a", order: 1, title: "A" },
        { uid: "e", order: 2, logic_kind: "end_flow", title: "E" },
        { uid: "b", order: 3, title: "B" },
      ],
    }));
    expect(edgesOf(graph)).toEqual(["1>2:next"]);
  });

  it("does not join a terminal branch to the node after the group", () => {
    const graph = build(def({
      steps: [
        { uid: "i", order: 1, logic_kind: "if", title: "I" },
        { uid: "e", parent_uid: "i", order: 1, logic_kind: "end_flow", title: "E" },
        { uid: "el", order: 2, connected_uid: "i", logic_kind: "else", title: "EL" },
        { uid: "a", parent_uid: "el", order: 1, title: "A" },
        { uid: "z", order: 3, title: "Z" },
      ],
    }));
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>1.1:true", "1>2:false", "2>2.1:next", "2.1>3:next"]));
  });

  it("keeps other leaf logic (wait, set flow variables, go back to) sequential", () => {
    const graph = build(def({
      steps: [
        { uid: "w", order: 1, logic_kind: "wait" },
        { uid: "s", order: 2, logic_kind: "set_flow_variables" },
        { uid: "g", order: 3, logic_kind: "go_back_to" },
        { uid: "z", order: 4 },
      ],
    }));
    expect(edgesOf(graph)).toEqual(["1>2:next", "2>3:next", "3>4:next"]);
  });
});

// ---------------------------------------------------------------------------
// Unexpected input
// ---------------------------------------------------------------------------

describe("unexpected input", () => {
  it("maps unknown logic to other with a warning, as a sequential container", () => {
    const graph = build(def({
      steps: [
        { uid: "a", order: 1, kind: "logic", logic_kind: "frobnicate", title: "A" },
        { uid: "b", parent_uid: "a", order: 1, title: "B" },
        { uid: "c", order: 2, kind: "logic", title: "C" },
        { uid: "d", order: 3, kind: "logic", logic_kind: "other", title: "D" },
        { uid: "e", order: 4, title: "E" },
      ],
    }));
    expect(graph.nodes.map((n) => n.logic_kind)).toEqual(["other", undefined, "other", "other", undefined]);
    expect(graph.warnings).toContain("unknown_logic_type");
    expect(edgesOf(graph)).toEqual(["1>1.1:next", "1.1>2:next", "2>3:next", "3>4:next"]);
  });

  it("does not warn for known logic kinds", () => {
    expect(build(fixture("nested-if")).warnings).toEqual([]);
  });

  it("attaches orphans (unknown parent) to the root after the real roots, with a warning", () => {
    const graph = build(def({
      steps: [
        { uid: "a", order: 1, title: "A" },
        { uid: "o", parent_uid: "missing", order: 1, title: "O" },
        { uid: "oc", parent_uid: "o", order: 1, title: "OC" },
        { uid: "b", order: 2, title: "B" },
      ],
    }));
    expect(graph.nodes.map((n) => [n.step, n.title.text, n.depth])).toEqual([
      ["1", "A", 0], ["2", "B", 0], ["3", "O", 0], ["3.1", "OC", 1],
    ]);
    expect(graph.warnings).toContain("orphan_steps");
    expect(graph.nodes[2]!.parent).toBeUndefined();
    expect(sorted(edgesOf(graph))).toEqual(sorted(["1>2:next", "2>3:next", "3>3.1:next"]));
  });

  it("recovers steps trapped in a parent cycle", () => {
    const graph = build(def({
      steps: [
        { uid: "a", parent_uid: "b", order: 1, title: "A" },
        { uid: "b", parent_uid: "a", order: 2, title: "B" },
        { uid: "r", order: 1, title: "R" },
      ],
    }));
    expect(graph.nodes).toHaveLength(3);
    expect(graph.warnings).toContain("orphan_steps");
    expect(new Set(graph.nodes.map((n) => n.title.text))).toEqual(new Set(["A", "B", "R"]));
  });

  it("survives a self-parented step", () => {
    const graph = build(def({ steps: [{ uid: "a", parent_uid: "a", order: 1 }] }));
    expect(graph.nodes).toHaveLength(1);
    expect(graph.warnings).toContain("orphan_steps");
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe("limits", () => {
  const nested = (levels: number): RawStep[] =>
    Array.from({ length: levels }, (_, i) => ({
      uid: `l${i}`, parent_uid: i === 0 ? null : `l${i - 1}`, order: 1, logic_kind: "for_each", title: `L${i}`,
    }));

  it("allows MAX_NESTING levels and stops descending past them", () => {
    const ok = build(def({ steps: nested(FLOW_VIEW_LIMITS.MAX_NESTING + 1) }));
    expect(Math.max(...ok.nodes.map((n) => n.depth))).toBe(FLOW_VIEW_LIMITS.MAX_NESTING);
    expect(ok.limits_hit).not.toContain("max_nesting");

    const deep = build(def({ steps: nested(FLOW_VIEW_LIMITS.MAX_NESTING + 5) }));
    expect(deep.nodes).toHaveLength(FLOW_VIEW_LIMITS.MAX_NESTING + 1);
    expect(deep.limits_hit).toContain("max_nesting");
    expect(deep.counts.steps_seen).toBe(FLOW_VIEW_LIMITS.MAX_NESTING + 5);
    expect(deep.nodes.at(-1)!.depth).toBeLessThanOrEqual(FLOW_GRAPH_SCHEMA_BOUNDS.MAX_NODE_DEPTH);
  });

  it("counts the trigger against max_nodes and adds a single more node", () => {
    const root = def({ trigger: {}, steps: chain(40) });
    const graph = build(root, { max_nodes: 10 });
    expect(graph.nodes).toHaveLength(10); // 9 steps + more
    expect(graph.nodes.filter((n) => n.kind === "more")).toHaveLength(1);
    const more = graph.nodes.at(-1)!;
    expect(more).toMatchObject({ id: "n10", kind: "more", omitted_steps: 31, depth: 0, flow_index: 0 });
    expect(graph.counts).toMatchObject({ steps_seen: 40, nodes_returned: 9 });
    expect(graph.limits_hit).toContain("max_nodes");
    expect(edgesOf(graph)).toEqual([
      "TRIG>1:next", "1>2:next", "2>3:next", "3>4:next", "4>5:next", "5>6:next", "6>7:next", "7>8:next", "8>9:next",
      "9>MORE:next",
    ]);
    const withoutTrigger = build(def({ steps: chain(40) }), { max_nodes: 10 });
    expect(withoutTrigger.nodes).toHaveLength(11); // 10 steps + more
  });

  it("stays within the schema bound at max_nodes 300", () => {
    const graph = build(def({ trigger: {}, steps: chain(400) }), { max_nodes: 300 });
    expect(graph.nodes.length).toBeLessThanOrEqual(FLOW_GRAPH_SCHEMA_BOUNDS.MAX_NODES);
    expect(graph.nodes).toHaveLength(300); // 299 steps + more
    expect(graph.edges.length).toBeLessThanOrEqual(FLOW_VIEW_LIMITS.MAX_EDGES);
  });

  it("redirects edges into dropped nodes to more and drops edges between dropped nodes", () => {
    const steps: RawStep[] = [
      { uid: "i", order: 1, logic_kind: "if", title: "I" },
      ...chain(12, (i) => ({ uid: `b${i}`, parent_uid: "i", order: i + 1 })),
      { uid: "z", order: 2, title: "Z" },
    ];
    const graph = build(def({ steps }), { max_nodes: 10 });
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    expect(edgesOf(graph).filter((e) => e.endsWith(">MORE:false") || e.endsWith(">MORE:next")).length).toBeGreaterThan(0);
    expect(graph.nodes.every((n) => n.parent === undefined || ids.has(n.parent))).toBe(true);
  });

  it("caps inputs per node and long input values", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `i${i}`, value: "v" }));
    const graph = build(def({
      steps: [{ uid: "a", inputs: [...many, { name: "big", value: "x" }] }, { uid: "b", inputs: [{ name: "big", value: "y".repeat(5000) }] }],
    }));
    expect(graph.nodes[0]!.inputs).toHaveLength(FLOW_VIEW_LIMITS.MAX_INPUTS_PER_NODE);
    expect(graph.limits_hit).toContain("inputs_per_node");
    const big = graph.nodes[1]!.inputs![0]!;
    expect(big.value).toHaveLength(FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS);
    expect(big.original_length).toBe(5000);
    expect(graph.limits_hit).toContain("input_value_chars");
    expect(graph.counts.inputs_truncated).toBe(1);
  });

  it("counts policy redactions", () => {
    const graph = build(def({
      steps: [{ uid: "a", inputs: [
        { name: "pw", value: null, redacted: "sensitive_type" },
        { name: "x", value: null, redacted: "field_policy" },
        { name: "ok", value: "fine" },
      ] }],
    }));
    expect(graph.counts.inputs_redacted).toBe(2);
    expect(graph.nodes[0]!.inputs![0]).toMatchObject({ value: null, redacted: "sensitive_type" });
  });
});

// ---------------------------------------------------------------------------
// Pills
// ---------------------------------------------------------------------------

describe("pills", () => {
  it("extracts pills, relabels them from the label cache, and leaves values untouched", () => {
    const uuid = "e29d6c3a-1111-4a9f-8f00-000000000001";
    const graph = build(def({
      label_cache: [
        [`${uuid}.number`, "Trigger > Number"],
        [`step[${uuid}].record`, "1 - Update Record > Record"],
        ["Created_1.current", "Trigger - Record Created > Fixture Record"],
      ],
      steps: [
        {
          uid: "a", order: 1,
          inputs: [
            { name: "one", value: `hello {{${uuid}.number}} and {{step[${uuid}].record}}` },
            { name: "two", value: "{{Created_1.current}}" },
            { name: "three", value: "{{unknown.var}} then {{Created_1.current}}" },
            { name: "plain", value: "no pills { here }" },
          ],
        },
      ],
    }));
    const inputs = graph.nodes[0]!.inputs!;
    expect(graph.pills).toEqual([
      { token: `{{${uuid}.number}}`, label: "Trigger > Number" },
      { token: `{{step[${uuid}].record}}`, label: "1 - Update Record > Record" },
      { token: "{{Created_1.current}}", label: "Trigger - Record Created > Fixture Record" },
      { token: "{{unknown.var}}", label: null },
    ]);
    expect(inputs[0]!.pills).toEqual([0, 1]);
    expect(inputs[1]!.pills).toEqual([2]);
    expect(inputs[2]!.pills).toEqual([3, 2]);
    expect(inputs[3]!.pills).toBeUndefined();
    expect(inputs[0]!.value).toContain(`{{${uuid}.number}}`);
  });

  it("falls back to a lowercased label_cache name (capture F1)", () => {
    const graph = build(fixture("nested-if"));
    const pillTokens = graph.pills.map((p) => [p.token, p.label]);
    expect(pillTokens).toContainEqual(["{{flow_variable.isFixtureFlagSet}}", "Flow Variables > isFixtureFlagSet"]);
    expect(pillTokens).toContainEqual(["{{Created_1.current}}", "Trigger - Record Created > Fixture Record"]);
  });

  it("skips scripts and redacted values, and extracts from trigger inputs first", () => {
    const graph = build(def({
      label_cache: [["a.b", "A > B"]],
      trigger: { inputs: [{ name: "t", value: "{{a.b}}" }] },
      steps: [{ uid: "s", inputs: [
        { name: "script", value: "var x = '{{a.b}}';", script: true },
        { name: "red", value: null, redacted: "field_policy" },
      ] }],
    }));
    expect(graph.pills).toEqual([{ token: "{{a.b}}", label: "A > B" }]);
    expect(graph.trigger!.inputs![0]!.pills).toEqual([0]);
    expect(graph.nodes[0]!.inputs!.every((i) => i.pills === undefined)).toBe(true);
  });

  it("caps pills at MAX_PILLS and clamps long labels", () => {
    const steps: RawStep[] = Array.from({ length: 7 }, (_, n) => ({
      uid: `s${n}`, order: n + 1,
      inputs: Array.from({ length: 40 }, (_, i) => ({ name: `i${i}`, value: `{{p${n}_${i}}}` })),
    }));
    const graph = build(def({ steps, label_cache: [["p0_0", "L".repeat(400)]] }));
    expect(graph.pills).toHaveLength(FLOW_VIEW_LIMITS.MAX_PILLS);
    expect(graph.limits_hit).toContain("pills");
    expect(graph.pills[0]!.label).toHaveLength(FLOW_VIEW_LIMITS.MAX_PILL_LABEL_CHARS);
  });

  it("uses each flow's own label cache for expanded subflows", () => {
    const root = def({
      label_cache: [["x.y", "Root label"]],
      steps: [
        { uid: "a", order: 1, inputs: [{ name: "v", value: "{{x.y}}" }] },
        { uid: "c", order: 2, kind: "subflow", subflow: { flow_sys_id: sid(0xb) } },
      ],
    });
    const child = def({
      header: { sys_id: sid(0xb), type: "subflow" },
      label_cache: [["x.y", "Child label"]],
      steps: [{ uid: "k", order: 1, inputs: [{ name: "v", value: "{{x.y}}" }] }],
    });
    const graph = build(root, { depth: 2 }, new Map([[sid(0xb), child]]));
    expect(graph.pills).toEqual([
      { token: "{{x.y}}", label: "Root label" },
      { token: "{{x.y}}", label: "Child label" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Subflows
// ---------------------------------------------------------------------------

describe("subflows", () => {
  const A = sid(0xa);
  const B = sid(0xb);
  const C = sid(0xc);
  const call = (uid: string, order: number, target: string | null, parent: string | null = null): RawStep => ({
    uid, order, parent_uid: parent, kind: "subflow", title: `call ${uid}`, subflow: { flow_sys_id: target, name: "Sub" },
  });
  const flowB = (steps: RawStep[]): NormalizedFlowDefinition =>
    def({ header: { sys_id: B, name: "B", type: "subflow" }, variables: [{ scope: "output", name: "out", label: null, type: null }], steps });

  it("lists distinct call targets", () => {
    expect(subflowCallTargets(def({ steps: [call("a", 1, B), call("b", 2, B), call("c", 3, C), call("d", 4, null)] }))).toEqual([B, C]);
  });

  it("does not expand at depth 1 (max_depth)", () => {
    const graph = build(def({ steps: [call("a", 1, B)] }), { depth: 1 }, new Map([[B, flowB([{ uid: "k" }])]]));
    expect(graph.flows).toHaveLength(1);
    expect(graph.nodes[0]!.subflow).toMatchObject({ flow_sys_id: B, not_expanded: "depth" });
    expect(graph.limits_hit).toContain("max_depth");
  });

  it("merges an expanded subflow: flow_index, relative depth, prefixed steps, subflow edge", () => {
    const root = def({
      steps: [
        { uid: "a", order: 1, title: "A" },
        call("c", 2, B),
        { uid: "z", order: 3, title: "Z" },
      ],
    });
    const body = flowB([
      { uid: "k1", order: 1, logic_kind: "for_each", title: "K1" },
      { uid: "k2", parent_uid: "k1", order: 1, title: "K2" },
    ]);
    const graph = build(root, { depth: 2 }, new Map([[B, body]]));
    expect(graph.flows.map((f) => [f.index, f.sys_id, f.called_from])).toEqual([[0, A, undefined], [1, B, "n2"]]);
    expect(graph.nodes.map((n) => [n.id, n.flow_index, n.step, n.depth])).toEqual([
      ["n1", 0, "1", 0], ["n2", 0, "2", 0], ["n3", 0, "3", 0],
      ["n4", 1, "2.1", 0], ["n5", 1, "2.1.1", 1],
    ]);
    expect(graph.nodes[1]!.subflow).toMatchObject({ flow_sys_id: B, expanded_index: 1 });
    expect(graph.nodes[1]!.subflow!.not_expanded).toBeUndefined();
    expect(sorted(edgesOf(graph))).toEqual(sorted([
      "1>2:next", "2>3:next", "2>2.1:subflow", "2.1>2.1.1:loop_body", "2.1.1>2.1:loop_back",
    ]));
    expect(graph.variables).toEqual([{ scope: "output", flow_index: 1, name: "out", label: null, type: null }]);
    expect(graph.counts.steps_seen).toBe(5);
  });

  it("expands nested subflows only up to depth, reporting max_depth beyond", () => {
    const root = def({ steps: [call("a", 1, B)] });
    const b = flowB([call("b1", 1, C)]);
    const c = def({ header: { sys_id: C, type: "subflow" }, steps: [{ uid: "c1" }] });
    const subflows = new Map([[B, b], [C, c]]);
    const two = build(root, { depth: 2 }, subflows);
    expect(two.flows).toHaveLength(2);
    expect(two.nodes.find((n) => n.step === "1.1")!.subflow).toMatchObject({ not_expanded: "depth" });
    const three = build(root, { depth: 3 }, subflows);
    expect(three.flows).toHaveLength(3);
    expect(three.nodes.find((n) => n.step === "1.1.1")).toMatchObject({ flow_index: 2, depth: 0 });
    expect(three.limits_hit).not.toContain("max_depth");
  });

  it("detects a cycle through the root and through an ancestor", () => {
    const root = def({ steps: [call("a", 1, B)] });
    const b = flowB([call("back", 1, A)]);
    const graph = build(root, { depth: 3 }, new Map([[B, b]]));
    expect(graph.nodes.find((n) => n.step === "1.1")!.subflow).toMatchObject({ flow_sys_id: A, not_expanded: "cycle" });
    expect(graph.warnings).toContain("subflow_cycle");
    expect(graph.flows).toHaveLength(2);

    const self = build(def({ steps: [call("s", 1, A)] }), { depth: 3 });
    expect(self.nodes[0]!.subflow).toMatchObject({ not_expanded: "cycle" });
    expect(self.warnings).toContain("subflow_cycle");

    const c = def({ header: { sys_id: C }, steps: [call("x", 1, B)] });
    const viaC = build(def({ steps: [call("a", 1, B)] }), { depth: 3 }, new Map([[B, flowB([call("b", 1, C)])], [C, c]]));
    expect(viaC.nodes.find((n) => n.step === "1.1.1")!.subflow).toMatchObject({ flow_sys_id: B, not_expanded: "cycle" });
  });

  it("expands a second call site once and points it at the same flow", () => {
    const root = def({ steps: [call("a", 1, B), { uid: "m", order: 2 }, call("b", 3, B)] });
    const graph = build(root, { depth: 2 }, new Map([[B, flowB([{ uid: "k" }])]]));
    expect(graph.flows).toHaveLength(2);
    expect(graph.flows[1]!.called_from).toBe("n1");
    const second = graph.nodes.find((n) => n.step === "3")!;
    expect(second.subflow).toMatchObject({ flow_sys_id: B, expanded_index: 1 });
    expect(second.subflow!.not_expanded).toBeUndefined();
    expect(graph.nodes.filter((n) => n.flow_index === 1)).toHaveLength(1);
    expect(edgesOf(graph).filter((e) => e.endsWith(":subflow"))).toEqual(["1>1.1:subflow"]);
    expect(graph.limits_hit).not.toContain("max_depth");
  });

  it("reports denied, not found, unresolved, and unloaded targets", () => {
    const root = def({ steps: [call("a", 1, B), call("b", 2, C), call("c", 3, null), call("d", 4, sid(0xd))] });
    const graph = build(root, { depth: 2 }, new Map<string, NormalizedFlowDefinition | FlowSubflowUnavailable>([
      [B, { unavailable: "denied" }],
      [C, { unavailable: "not_found" }],
    ]));
    expect(graph.nodes.map((n) => n.subflow!.not_expanded)).toEqual(["denied", "not_found", "not_found", "limit"]);
    expect(graph.warnings).toEqual(expect.arrayContaining(["subflow_denied", "subflow_not_found"]));
    expect(graph.flows).toHaveLength(1);
  });

  it("stops at MAX_SUBFLOW_EXPANSIONS", () => {
    const targets = Array.from({ length: 10 }, (_, i) => sid(0x100 + i));
    const root = def({ steps: targets.map((t, i) => call(`c${i}`, i + 1, t)) });
    const subflows = new Map(targets.map((t) => [t, def({ header: { sys_id: t }, steps: [{ uid: "k" }] })] as const));
    const graph = build(root, { depth: 2 }, subflows);
    expect(graph.flows).toHaveLength(1 + FLOW_VIEW_LIMITS.MAX_SUBFLOW_EXPANSIONS);
    expect(graph.nodes.filter((n) => n.subflow?.not_expanded === "limit")).toHaveLength(2);
    expect(graph.limits_hit).toContain("max_subflow_expansions");
  });

  it("merges loader warnings and drop counts of expanded flows only", () => {
    const b = def({ header: { sys_id: B }, steps: [{ uid: "k" }], warnings: ["gzip_decode_failed"], items_dropped: 2, limits_hit: ["rows_per_table"] });
    const unloaded = build(def({ steps: [call("a", 1, B)] }), { depth: 1 }, new Map([[B, b]]));
    expect(unloaded.warnings).toEqual([]);
    const loaded = build(def({ steps: [call("a", 1, B)] }), { depth: 2 }, new Map([[B, b]]));
    expect(loaded.warnings).toEqual(["gzip_decode_failed"]);
    expect(loaded.limits_hit).toContain("rows_per_table");
    expect(loaded.counts.items_dropped).toBe(2);
  });

  it("keeps root nodes before subflow nodes when max_nodes truncates", () => {
    const root = def({ steps: [call("a", 1, B), ...chain(20, (i) => ({ uid: `r${i}`, order: i + 2 }))] });
    const body = flowB(chain(30, (i) => ({ uid: `k${i}` })));
    const graph = build(root, { depth: 2, max_nodes: 10 }, new Map([[B, body]]));
    expect(graph.nodes.every((n) => n.flow_index === 0)).toBe(true);
    expect(graph.flows[1]!.called_from).toBe("n1");
    expect(graph.nodes.at(-1)!.kind).toBe("more");
  });

  it("drops called_from when the call-site node is truncated away", () => {
    const root = def({ steps: [...chain(12, (i) => ({ uid: `r${i}` })), call("late", 13, B)] });
    const graph = build(root, { depth: 2, max_nodes: 10 }, new Map([[B, flowB([{ uid: "k" }])]]));
    expect(graph.flows).toHaveLength(2);
    expect(graph.flows[1]!.called_from).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Budget ladder
// ---------------------------------------------------------------------------

describe("byte-fitting ladder", () => {
  const big = (n: number, k: string) => `${k}${"x".repeat(n - k.length)}`;
  function bigRoot(nodes = 12, inputs = 3): NormalizedFlowDefinition {
    return def({
      trigger: { inputs: [{ name: "t", value: big(2000, "trigger") }] },
      steps: chain(nodes, (i) => ({
        inputs: Array.from({ length: inputs }, (_, j) => ({ name: `in${j}`, label: `Input ${j}`, value: big(2000, `v${i}_${j}_`) })),
      })),
    });
  }
  const unbounded = (): FlowGraph => build(bigRoot(), { max_response_bytes: 1_000_000 });

  /** Independent statement of what steps 1-3 do. */
  function manual(graph: FlowGraph, step: 1 | 2 | 3): FlowGraph {
    const g = clone(graph);
    g.limits_hit = [...g.limits_hit, "response_bytes"];
    const inputs = [...(g.trigger?.inputs ?? []), ...g.nodes.flatMap((n) => n.inputs ?? [])];
    for (const i of inputs) {
      for (const cap of step >= 2 ? [500, 120] : [500]) {
        if (i.value !== null && i.value.length > cap) {
          i.original_length = Math.max(i.original_length ?? 0, i.value.length);
          i.value = i.value.slice(0, cap);
        }
      }
      if (step === 3) {
        i.value = null;
        i.redacted = "limit";
      }
    }
    g.counts.inputs_truncated = inputs.filter((i) => i.redacted === "limit" || (i.original_length !== undefined && !i.redacted)).length;
    return g;
  }

  it("leaves a graph that fits untouched and does not record response_bytes", () => {
    const graph = unbounded();
    const copy = clone(graph);
    expect(fitFlowGraphToBudget(graph, bytes(graph))).toBe(FLOW_GRAPH_BUDGET_STEPS.FITS);
    expect(graph).toEqual(copy);
    expect(graph.limits_hit).not.toContain("response_bytes");
  });

  it.each([1, 2, 3] as const)("step %i fits exactly at its byte boundary and not one byte below", (step) => {
    const base = unbounded();
    const target = bytes(manual(base, step));
    const fits = clone(base);
    expect(fitFlowGraphToBudget(fits, target)).toBe(step);
    expect(bytes(fits)).toBe(target);
    expect(fits).toEqual(manual(base, step));
    expect(fits.limits_hit).toContain("response_bytes");
    expectValid(fits);

    const below = clone(base);
    expect(fitFlowGraphToBudget(below, target - 1)).toBeGreaterThan(step);
    expect(bytes(below)).toBeLessThanOrEqual(target - 1);
  });

  it("step 1 keeps 500 characters and records the original length; step 3 keeps names", () => {
    const g1 = clone(unbounded());
    fitFlowGraphToBudget(g1, bytes(manual(g1, 1)));
    const first = g1.nodes[0]!.inputs![0]!;
    expect(first.value).toHaveLength(500);
    expect(first.original_length).toBe(2000);
    const g3 = clone(unbounded());
    fitFlowGraphToBudget(g3, bytes(manual(g3, 3)));
    expect(g3.nodes[0]!.inputs![0]).toMatchObject({ name: "in0", label: "Input 0", value: null, redacted: "limit" });
    expect(g3.counts.inputs_redacted).toBe(0); // "limit" is not a policy redaction
    expect(g3.counts.inputs_truncated).toBe(37);
  });

  it("step 4 halves the nodes, adds one more node, and rewires edges", () => {
    const base = unbounded();
    const target = bytes(manual(base, 3)) - 1;
    const graph = clone(base);
    expect(fitFlowGraphToBudget(graph, target)).toBe(FLOW_GRAPH_BUDGET_STEPS.NODES_HALVED);
    expect(graph.nodes).toHaveLength(7);
    expect(graph.nodes.at(-1)).toMatchObject({ id: "n7", kind: "more", omitted_steps: 6 });
    expect(graph.limits_hit).toEqual(expect.arrayContaining(["max_nodes", "response_bytes"]));
    expect(edgesOf(graph)).toEqual(["TRIG>1:next", "1>2:next", "2>3:next", "3>4:next", "4>5:next", "5>6:next", "6>MORE:next"]);
    expect(graph.counts.nodes_returned).toBe(6);
    expect(bytes(graph)).toBeLessThanOrEqual(target);
    expectValid(graph);
  });

  it("step 4 accumulates onto an existing more node", () => {
    const graph = build(bigRoot(40, 1), { max_nodes: 20, max_response_bytes: 1_000_000 });
    expect(graph.nodes.at(-1)!.omitted_steps).toBe(21);
    const target = Math.floor(bytes(manual(graph, 3)) * 0.6);
    fitFlowGraphToBudget(graph, target);
    const more = graph.nodes.filter((n) => n.kind === "more");
    expect(more).toHaveLength(1);
    expect(more[0]!.omitted_steps).toBe(40 - (graph.nodes.length - 1));
    expectValid(graph);
  });

  it("step 5 drops pills and variables once halving cannot help", () => {
    const labels: Array<[string, string]> = Array.from({ length: 150 }, (_, i) => [`p${i}`, "L".repeat(160)]);
    const root = def({
      label_cache: labels,
      variables: Array.from({ length: 50 }, (_, i) => ({ scope: "variable" as const, name: `v${i}`, label: "l".repeat(100), type: "string" })),
      steps: [{ uid: "a", inputs: Array.from({ length: 40 }, (_, i) => ({ name: `i${i}`, value: `{{p${i}}}{{p${i + 40}}}{{p${i + 80}}}` })) }],
    });
    const graph = build(root, { max_response_bytes: 1_000_000 });
    expect(graph.pills.length).toBeGreaterThan(100);
    const target = 4_000;
    expect(fitFlowGraphToBudget(graph, target)).toBe(FLOW_GRAPH_BUDGET_STEPS.PILLS_VARIABLES_DROPPED);
    expect(graph.pills).toEqual([]);
    expect(graph.variables).toEqual([]);
    expect(graph.nodes).toHaveLength(1); // only the more node
    expect(graph.nodes[0]!.kind).toBe("more");
    expect(bytes(graph)).toBeLessThanOrEqual(target);
    expectValid(graph);
  });

  it("falls back to repeated halving when even that is not enough", () => {
    const root = def({ steps: chain(3, () => ({ title: "t".repeat(200) })) });
    const probe = build(root);
    const floor = clone(probe);
    fitFlowGraphToBudget(floor, 0);
    expect(floor.nodes.map((n) => n.kind)).toEqual(["more"]);
    const target = bytes(floor) + 100;
    const graph = clone(probe);
    expect(fitFlowGraphToBudget(graph, target)).toBe(FLOW_GRAPH_BUDGET_STEPS.NODES_HALVED_REPEATEDLY);
    expect(graph.nodes.map((n) => n.kind)).toEqual(["more"]);
    expect(graph.nodes[0]!.omitted_steps).toBe(3);
    expect(bytes(graph)).toBeLessThanOrEqual(target);
  });

  it("buildFlowGraph targets 55 percent of max_response_bytes", () => {
    for (const max of [10_000, 20_000, 60_000]) {
      const graph = build(bigRoot(30, 4), { max_response_bytes: max });
      expect(bytes(graph)).toBeLessThanOrEqual(Math.floor(max * FLOW_VIEW_LIMITS.STRUCTURED_SHARE));
      expect(graph.limits_hit).toContain("response_bytes");
    }
    const roomy = build(bigRoot(3, 1), { max_response_bytes: 1_000_000 });
    expect(roomy.limits_hit).not.toContain("response_bytes");
    expect(roomy.nodes[0]!.inputs![0]!.value).toHaveLength(2000);
  });

  it("is deterministic under the ladder", () => {
    const a = build(bigRoot(30, 4), { max_response_bytes: 15_000 });
    const b = build(bigRoot(30, 4), { max_response_bytes: 15_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Schema validation across shapes
// ---------------------------------------------------------------------------

describe("flowGraphSchema validation", () => {
  it.each(["nested-if", "top-level-try", "parallel"])("fixture %s validates, with and without inputs", (name) => {
    for (const include_inputs of [true, false]) {
      const graph = build(fixture(name), { include_inputs, depth: 3 });
      expect(flowGraphSchema.safeParse(graph).success).toBe(true);
    }
  });

  it("validates a fully loaded multi-flow graph", () => {
    const root = fixture("top-level-try");
    const callee = def({
      header: { sys_id: FIXTURE_CALLEE, name: "Fixture Notify Subflow", type: "subflow" },
      steps: [{ uid: "n1", order: 1, title: "Notify", inputs: [{ name: "to", value: "{{subflow.role}}" }] }],
      label_cache: [["subflow.role", "Role"]],
    });
    const graph = build(root, { depth: 2 }, new Map([[FIXTURE_CALLEE, callee]]));
    expect(graph.flows).toHaveLength(2);
    expect(graph.nodes.find((n) => n.step === "1.2.1")).toMatchObject({ flow_index: 1, depth: 0 });
    expect(edgesOf(graph)).toContain("1.2>1.2.1:subflow");
  });

  it("never uses an envelope-reserved key at the top level", () => {
    const keys = Object.keys(build(fixture("parallel")));
    for (const reserved of ["results", "runs", "failures", "execution", "relationships", "fields", "result", "request", "limit", "offset", "has_more", "next_offset", "truncated", "dropped_records", "record_count", "meta"]) {
      expect(keys).not.toContain(reserved);
    }
  });
});
