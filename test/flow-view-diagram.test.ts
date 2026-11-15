import { describe, expect, it } from "vitest";

import { enrichSuccessfulResult } from "../src/tools/index.js";
import {
  FLOW_DIAGRAM_OMITTED_NOTE,
  FLOW_VIEW_LIMITS,
  FLOW_WARNING_CODES,
  FLOW_WARNING_TEXT,
  flowGraphSchema,
  type FlowGraph,
  type FlowText,
  type NormalizedFlowDefinition,
} from "../src/tools/flow-view-contracts.js";
import { buildFlowGraph } from "../src/tools/flow-view-graph.js";
import { buildFlowMermaid } from "../src/tools/flow-view-mermaid.js";
import "../src/tools/flow-view-module.js";
import { isValidMermaidSource } from "../src/tools/markdown.js";
import {
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
  productionToolOutputSchemas,
} from "../src/tools/result-envelope.js";

const text = (value: string | null): FlowText => ({ text: value });
const ROOT = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://diagram-test.service-now.com";

/** A flat flow whose step titles are as long as a title may usefully be. */
function flow(steps: number, long: boolean): NormalizedFlowDefinition {
  return {
    source: "table",
    header: {
      sys_id: ROOT,
      name: text("Big flow"),
      description: text(null),
      type: "flow",
      active: true,
      status: "published",
      version: "1",
      scope: "global",
    },
    trigger: null,
    steps: Array.from({ length: steps }, (_, index) => ({
      uid: `a${index}`,
      parent_uid: null,
      order: index,
      connected_uid: null,
      kind: "action" as const,
      annotation: text(long ? "note ".repeat(20) : null),
      inputs: [],
      title: text(long ? `Step ${index} ${"abcdefghij ".repeat(8)}` : `Step ${index}`),
    })),
    label_cache: [],
    variables: [],
    warnings: [],
    limits_hit: [],
    items_dropped: 0,
  };
}

function build(
  steps: number,
  long: boolean,
  maxResponseBytes: number,
  format: "both" | "mermaid" | "outline" = "both"
): FlowGraph {
  return buildFlowGraph({
    root: flow(steps, long),
    options: { depth: 1, include_inputs: true, max_nodes: Math.min(steps, 300), format, max_response_bytes: maxResponseBytes },
  });
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const withoutDiagram = (graph: FlowGraph): FlowGraph => {
  const copy = { ...graph };
  delete copy.diagram;
  return copy;
};

describe("the flow graph's diagram", () => {
  it("is the diagram the text draws, and parses", () => {
    const graph = build(40, false, 100_000);
    expect(graph.diagram).toEqual({
      format: "mermaid",
      source: buildFlowMermaid(graph)!.diagram.source,
    });
    expect(isValidMermaidSource(graph.diagram?.source)).toBe(true);
    expect(flowGraphSchema.safeParse(graph).success).toBe(true);
  });

  it("is left out when the format is outline", () => {
    expect(build(40, false, 100_000, "outline").diagram).toBeUndefined();
    expect(build(40, false, 100_000, "mermaid").diagram?.source).toBeDefined();
  });

  it("names the root flow record by table and sys_id, never by address", () => {
    const graph = build(5, false, 100_000);
    expect(graph.ref).toEqual({ table: "sys_hub_flow", sys_id: ROOT });
    expect(JSON.stringify(graph)).not.toMatch(/https?:|service-now/u);
  });

  it("explains every warning code with the sentence the text uses", () => {
    expect(Object.keys(FLOW_WARNING_TEXT).sort()).toEqual([...FLOW_WARNING_CODES].sort());
    const root = flow(3, false);
    const graph = buildFlowGraph({
      root: { ...root, warnings: ["subflow_cycle", "flow_version_unknown"] },
      options: { depth: 1, include_inputs: true, max_nodes: 10, format: "both", max_response_bytes: 100_000 },
    });
    expect(graph.warning_details).toEqual(graph.warnings.map((code) => ({ code, message: FLOW_WARNING_TEXT[code] })));
    expect(graph.warning_details?.map((detail) => detail.code)).toEqual(["subflow_cycle", "flow_version_unknown"]);
    expect(build(3, false, 100_000).warning_details).toBeUndefined();
  });
});

describe("the diagram and the response budget", () => {
  const target = (maxResponseBytes: number): number => Math.floor(maxResponseBytes * FLOW_VIEW_LIMITS.STRUCTURED_SHARE);

  it("is dropped whole, with a note, when the graph and the diagram do not fit together", () => {
    // Long titles: the graph fits the budget on its own, the diagram on top does not.
    const whole = build(150, true, 1_000_000);
    expect(whole.diagram?.source?.length).toBeGreaterThan(15_000);
    expect(whole.diagram!.source!.length).toBeLessThanOrEqual(FLOW_VIEW_LIMITS.MERMAID_MAX_CHARS);
    const limit = 100_000;
    const graph = build(150, true, limit);
    expect(bytes(withoutDiagram(graph))).toBeLessThanOrEqual(target(limit));
    expect(bytes(whole)).toBeGreaterThan(target(limit));
    expect(graph.diagram).toEqual({ format: "mermaid", note: FLOW_DIAGRAM_OMITTED_NOTE });
    // Nothing else was given up for it: the diagram is derived from what stayed.
    expect(graph.nodes).toEqual(whole.nodes);
    expect(graph.edges).toEqual(whole.edges);
    expect(graph.limits_hit).toEqual(whole.limits_hit);
    expect(flowGraphSchema.safeParse(graph).success).toBe(true);
  });

  it("is kept whenever the graph and the diagram fit together", () => {
    for (const limit of [100_000, 400_000]) {
      const graph = build(60, false, limit);
      expect(graph.diagram?.source, String(limit)).toBeDefined();
      expect(bytes(graph), String(limit)).toBeLessThanOrEqual(target(limit));
    }
    // At the smallest budget the graph is cut first; what is left is drawn or noted, never half drawn.
    const small = build(60, false, FLOW_VIEW_LIMITS.MIN_MAX_RESPONSE_BYTES);
    if (small.diagram?.source === undefined) expect(small.diagram?.note).toBe(FLOW_DIAGRAM_OMITTED_NOTE);
    else expect(isValidMermaidSource(small.diagram.source)).toBe(true);
  });

  it("is drawn from the nodes that survived the budget, not from the ones that were cut", () => {
    const graph = build(150, false, 20_000);
    expect(graph.limits_hit).toContain("response_bytes");
    expect(graph.nodes.length).toBeLessThan(150);
    expect(graph.diagram?.source).toBe(buildFlowMermaid(graph)!.diagram.source);
  });

  /** A finalized call whose handler returned `graph`, under `maxResponseBytes`. */
  function finalized(graph: FlowGraph, maxResponseBytes: number) {
    const args = { max_response_bytes: maxResponseBytes };
    const handler = { content: [{ type: "text" as const, text: JSON.stringify(graph) }] };
    const enriched = enrichSuccessfulResult(envelopeCompatibilityResult("sn_flow_view", args, handler), "p");
    return finalizeEnvelopeResult(enriched, "sn_flow_view", { instanceOrigin: ORIGIN });
  }

  it("is dropped by the envelope's own fit before any text is cut, rather than failing the call", () => {
    const graph = build(150, true, 1_000_000);
    expect(graph.diagram?.source).toBeDefined();
    const total = bytes(graph);
    // Room for the graph and a summary, not for the diagram as well.
    const limit = total - Math.floor(graph.diagram!.source!.length / 2);
    const result = finalized(graph, limit);
    expect(result).toBeDefined();
    const data = (result!.structuredContent as { data: FlowGraph; metadata: { truncation: unknown } }).data;
    expect(data.diagram).toEqual({ format: "mermaid", note: FLOW_DIAGRAM_OMITTED_NOTE });
    // Whole nodes, titles and annotations: only the diagram's source went.
    expect(withoutDiagram(data)).toEqual(withoutDiagram(graph));
    expect((result!.structuredContent as { metadata: { truncation: unknown } }).metadata.truncation).toMatchObject({
      truncated: true,
      reason: "byte_limit",
    });
    expect(bytes(result)).toBeLessThanOrEqual(limit);
    expect(productionToolOutputSchemas.sn_flow_view.safeParse(result!.structuredContent).success).toBe(true);
  });

  it("is untouched by the envelope's fit when everything fits", () => {
    const graph = build(40, false, 100_000);
    const result = finalized(graph, 100_000);
    expect((result!.structuredContent as { data: FlowGraph }).data.diagram).toEqual(graph.diagram);
  });

  it("is never shortened mid-source: the source is whole or gone", () => {
    const graph = build(150, true, 1_000_000);
    for (const limit of [30_000, 60_000, 90_000, 120_000]) {
      const result = finalized(graph, limit);
      if (result === undefined) continue;
      const diagram = (result.structuredContent as { data: FlowGraph }).data.diagram;
      if (diagram?.source !== undefined) expect(isValidMermaidSource(diagram.source), String(limit)).toBe(true);
      else expect(diagram?.note).toBe(FLOW_DIAGRAM_OMITTED_NOTE);
    }
  });
});
