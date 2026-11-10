import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_MERMAID_EDGES,
  MAX_MERMAID_NODES,
  MAX_MERMAID_SOURCE_LENGTH,
} from "../src/tools/markdown.js";
import {
  FLOW_VIEW_LIMITS,
  flowGraphSchema,
  type FlowGraph,
  type FlowLogicKind,
  type FlowText,
  type NormalizedFlowDefinition,
  type NormalizedStep,
} from "../src/tools/flow-view-contracts.js";
import { buildFlowGraph, type FlowGraphBuildInput } from "../src/tools/flow-view-graph.js";
import { buildFlowMermaid } from "../src/tools/flow-view-mermaid.js";
import { flowOutlineLines } from "../src/tools/flow-view-renderers.js";

// The graph builder's output, fed straight into the renderers.

const text = (value: string | null | undefined): FlowText => ({ text: value ?? null });

interface RawStep {
  uid: string;
  parent_uid?: string | null;
  order?: number | null;
  connected_uid?: string | null;
  kind?: NormalizedStep["kind"];
  logic_kind?: string;
  title?: string;
  condition?: string;
  subflow?: { flow_sys_id: string | null; name?: string };
}

function definition(
  steps: readonly RawStep[],
  header: { sys_id: string; name: string; type?: "flow" | "subflow" }
): NormalizedFlowDefinition {
  return {
    source: "table",
    header: {
      sys_id: header.sys_id,
      name: text(header.name),
      description: text(null),
      type: header.type ?? "flow",
      active: true,
      status: "published",
      version: "1",
      scope: "global",
    },
    trigger: null,
    steps: steps.map((raw) => ({
      uid: raw.uid,
      parent_uid: raw.parent_uid ?? null,
      order: raw.order ?? null,
      connected_uid: raw.connected_uid ?? null,
      kind: raw.kind ?? (raw.logic_kind === undefined ? "action" : "logic"),
      ...(raw.logic_kind === undefined ? {} : { logic_kind: raw.logic_kind as FlowLogicKind }),
      title: text(raw.title ?? raw.uid),
      annotation: text(null),
      ...(raw.condition === undefined ? {} : { condition: text(raw.condition) }),
      inputs: [],
      ...(raw.subflow
        ? { subflow: { flow_sys_id: raw.subflow.flow_sys_id, name: text(raw.subflow.name ?? "Subflow") } }
        : {}),
    })),
    label_cache: [],
    variables: [],
    warnings: [],
    limits_hit: [],
    items_dropped: 0,
  };
}

function fixture(name: string): NormalizedFlowDefinition {
  const raw = JSON.parse(
    readFileSync(new URL(`./fixtures/flow-view/normalized/${name}.json`, import.meta.url), "utf8")
  ) as { header: { sys_id: string; name: string; type?: "flow" | "subflow" }; steps: RawStep[] };
  return definition(raw.steps, raw.header);
}

const OPTIONS: FlowGraphBuildInput["options"] = {
  depth: 1,
  include_inputs: true,
  max_nodes: 150,
  format: "both",
  max_response_bytes: 1_000_000,
};

function build(input: Omit<FlowGraphBuildInput, "options"> & { options?: Partial<FlowGraphBuildInput["options"]> }): FlowGraph {
  const graph = buildFlowGraph({ ...input, options: { ...OPTIONS, ...input.options } });
  expect(flowGraphSchema.safeParse(graph).success).toBe(true);
  return graph;
}

/** Mermaid node id (renderer-allocated) for each line label, and the edges between them. */
function parseMermaid(source: string) {
  const ids = new Map<string, string>();
  const edges: Array<{ from: string; to: string; label: string }> = [];
  for (const line of source.split("\n")) {
    const node = /^\s*(n\d+|nMore)[[({]+"([^"]*)"/u.exec(line);
    if (node) ids.set(node[2]!, node[1]!);
    const edge = /^(n\d+|nMore) -(?:->|\.->)(?:\|([a-z]+)\|)? (n\d+|nMore)$/u.exec(line);
    if (edge) edges.push({ from: edge[1]!, to: edge[3]!, label: edge[2] ?? "" });
  }
  return { ids, edges };
}

function indentOf(line: string): number {
  return /^ */u.exec(line)![0].length;
}

describe("graph builder output through the renderers", () => {
  it("draws within the contract's Mermaid caps", () => {
    expect([MAX_MERMAID_NODES, MAX_MERMAID_EDGES, MAX_MERMAID_SOURCE_LENGTH]).toEqual([
      FLOW_VIEW_LIMITS.MERMAID_MAX_NODES,
      FLOW_VIEW_LIMITS.MERMAID_MAX_EDGES,
      FLOW_VIEW_LIMITS.MERMAID_MAX_CHARS,
    ]);
  });

  it("routes the false edge into the Else node and on to its body", () => {
    const graph = build({ root: fixture("top-level-try") });
    const mermaid = buildFlowMermaid(graph)!;
    expect(mermaid).toBeDefined();
    const { ids, edges } = parseMermaid(mermaid.diagram.source);
    const ifId = ids.get("If: is group")!;
    const elseId = ids.get("Else")!;
    const elseBody = ids.get("Add User Role")!;
    expect(edges).toContainEqual({ from: ifId, to: elseId, label: "false" });
    expect(edges).toContainEqual({ from: ifId, to: ids.get("Add Group Role")!, label: "true" });
    expect(edges).toContainEqual({ from: elseId, to: elseBody, label: "" });
  });

  it("routes the error edge into the Catch node and on to its body", () => {
    const graph = build({ root: fixture("top-level-try") });
    const { ids, edges } = parseMermaid(buildFlowMermaid(graph)!.diagram.source);
    const tryId = ids.get("Top Level Try")!;
    const catchId = ids.get("Top Level Catch")!;
    expect(edges).toContainEqual({ from: tryId, to: catchId, label: "catch" });
    expect(edges).toContainEqual({ from: catchId, to: ids.get("Log Error")!, label: "" });
  });

  it("puts Else at its If's level in the outline, with its body one level deeper", () => {
    const graph = build({ root: fixture("top-level-try") });
    const lines = flowOutlineLines(graph);
    const ifLine = lines.find((line) => /\bIf$/u.test(line))!;
    const elseLine = lines.find((line) => /\bElse$/u.test(line))!;
    const body = lines.find((line) => line.endsWith("Add User Role"))!;
    expect(indentOf(elseLine)).toBe(indentOf(ifLine));
    expect(indentOf(body)).toBe(indentOf(elseLine) + 4);
  });

  it("indents an expanded subflow once under its call site, with relative depth", () => {
    const callee = "3333333333333333333333333333cccc";
    const root = fixture("top-level-try");
    const child = definition(
      [
        { uid: "c1", order: 1, logic_kind: "if", title: "If", condition: "ready" },
        { uid: "c2", parent_uid: "c1", order: 1, title: "Child Action" },
      ],
      { sys_id: callee, name: "Fixture Notify Subflow", type: "subflow" }
    );
    const graph = build({ root, subflows: new Map([[callee, child]]), options: { depth: 2 } });
    const call = graph.nodes.find((node) => node.kind === "subflow")!;
    const childNodes = graph.nodes.filter((node) => node.flow_index === 1);
    expect(childNodes.map((node) => [node.step, node.depth])).toEqual([
      [`${call.step}.1`, 0],
      [`${call.step}.1.1`, 1],
    ]);

    const lines = flowOutlineLines(graph);
    const callLine = lines.find((line) => line.includes(`${call.step}. ↪`))!;
    const first = lines.find((line) => line.trimStart().startsWith(`${call.step}.1. `))!;
    const nested = lines.find((line) => line.trimStart().startsWith(`${call.step}.1.1. `))!;
    expect(indentOf(first)).toBe(indentOf(callLine) + 4);
    expect(indentOf(nested)).toBe(indentOf(callLine) + 8);

    const { ids, edges } = parseMermaid(buildFlowMermaid(graph)!.diagram.source);
    expect(edges).toContainEqual({ from: ids.get("Notify")!, to: ids.get("If: ready")!, label: "calls" });
    expect(buildFlowMermaid(graph)!.diagram.source).toContain('subgraph sg1 ["Fixture Notify Subflow"]');
  });

  it("numbers steps nested deeper than 24 levels across subflows", () => {
    // MAX_NESTING levels in each of three flows give steps of more than 24 segments.
    const chain = (prefix: string, callTo?: string): RawStep[] => {
      const steps: RawStep[] = Array.from({ length: 16 }, (_, index) => ({
        uid: `${prefix}${index}`,
        parent_uid: index === 0 ? null : `${prefix}${index - 1}`,
        order: 1,
        logic_kind: "for_each",
        title: `${prefix} level ${index}`,
      }));
      if (callTo) {
        steps.push({
          uid: `${prefix}call`,
          parent_uid: `${prefix}15`,
          order: 1,
          kind: "subflow",
          title: `${prefix} call`,
          subflow: { flow_sys_id: callTo, name: "Next" },
        });
      }
      return steps;
    };
    const [a, b] = ["a".repeat(32), "b".repeat(32)];
    const graph = build({
      root: definition(chain("r", a), { sys_id: "f".repeat(32), name: "Root" }),
      subflows: new Map([
        [a, definition(chain("s", b), { sys_id: a, name: "A", type: "subflow" })],
        [b, definition(chain("t"), { sys_id: b, name: "B", type: "subflow" })],
      ]),
      options: { depth: 3 },
    });
    const deepest = graph.nodes.reduce((max, node) => Math.max(max, node.step.split(".").length), 0);
    expect(deepest).toBeGreaterThan(24);
    const lines = flowOutlineLines(graph);
    expect(lines.some((line) => line.trimStart().startsWith("- "))).toBe(false);
    expect(lines.some((line) => line.includes("t level 15") && /\d+(?:\.\d+){24,}\. /u.test(line))).toBe(true);
  });
});
