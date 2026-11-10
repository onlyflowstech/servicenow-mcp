/**
 * Mermaid flowchart for `sn_flow_view` (design section 4.1, rules E1-E7).
 *
 * The graph handed to the renderer is untrusted JSON: titles, conditions and
 * flow names are instance text, and even generated node ids are only data by
 * the time they arrive here. The diagram is therefore assembled from
 * constants and renderer-allocated ids alone; instance text enters only as an
 * encoded label (`encodeMermaidLabel`) inside a constant shape delimiter, and
 * the finished source is issued by `markdown.ts` only after it passes the
 * closed line grammar there. Input values never appear in the diagram.
 *
 * @module tools/flow-view-mermaid
 */

import { FLOW_VIEW_LIMITS, type FlowGraph } from "./flow-view-contracts.js";
import {
  MAX_MERMAID_EDGES,
  MAX_MERMAID_NODES,
  MAX_MERMAID_SOURCE_LENGTH,
  MERMAID_HEADER,
  issueMermaidDiagram,
  type MermaidDiagram,
} from "./markdown.js";

export const MERMAID_MAX_LABEL_CHARS: number = FLOW_VIEW_LIMITS.MERMAID_MAX_LABEL_CHARS;

// E3 step 3: line breaks (CR, LF, NEL, LS, PS) and tab become a space. This
// runs before step 2's stripping, which would otherwise delete CR/LF/tab as
// C0 controls and glue the words on either side together.
const LINE_BREAKS_AND_TABS = /[\r\n\t\u0085\u2028\u2029]/gu;
// E3 step 2: C0/C1 controls and DEL; bidi controls U+061C, U+200E, U+200F,
// U+202A-202E, U+2066-2069; invisibles U+00AD, U+200B-200D, U+2060-2064,
// U+FEFF; tag characters U+E0000-E007F.
const STRIPPED_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
// With the `u` flag this matches only unpaired surrogates.
const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;
const WHITESPACE_RUNS = /\s+/gu;
const LABEL_SAFE_CHARACTER = /^[A-Za-z0-9 ,.:_()/+=?-]$/u;
// E3 step 5: characters that could become live after Mermaid decodes
// entities (htmlLabels / loose security) are replaced by look-alikes, which
// step 6 then entity-encodes like any other non-ASCII character.
const SUBSTITUTES: ReadonlyMap<string, string> = new Map([
  ["<", "\u2039"],
  [">", "\u203A"],
  ["&", "\uFF06"],
  ['"', "\u201D"],
  ["`", "\u02CB"],
]);
// Labels are capped at 80 code points, so only a bounded prefix of the raw
// value is examined; a cut there is marked like any other truncation.
const MAX_EXAMINED_CODE_UNITS = 4_096;
const TRUNCATION_MARKER = "…";
const UNNAMED = "(unnamed)";

function labelSource(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

/**
 * Encode any value as a Mermaid label body (without its quotes). The result
 * always matches `MERMAID_LABEL_PATTERN`: only `[A-Za-z0-9 ,.:_()/+=?-]` and
 * decimal entity codes `#<n>;`, never `#60;`, `#62;`, `#38;`, `#34;` or `#96;`.
 */
export function encodeMermaidLabel(
  raw: unknown,
  max = MERMAID_MAX_LABEL_CHARS
): string {
  const limit = Number.isFinite(max)
    ? Math.min(Math.max(Math.floor(max), 1), MERMAID_MAX_LABEL_CHARS * 4)
    : MERMAID_MAX_LABEL_CHARS;
  const source = labelSource(raw);
  let cut = source.length > MAX_EXAMINED_CODE_UNITS;
  const flat = (cut ? source.slice(0, MAX_EXAMINED_CODE_UNITS) : source)
    .normalize("NFKC")
    .replace(LINE_BREAKS_AND_TABS, " ")
    .replace(STRIPPED_CHARACTERS, "")
    .replace(LONE_SURROGATES, "")
    .replace(WHITESPACE_RUNS, " ")
    .trim();
  let characters = Array.from(flat);
  if (characters.length > limit) {
    characters = characters.slice(0, limit);
    cut = true;
  }
  if (cut) characters.push(TRUNCATION_MARKER);
  let encoded = "";
  for (const character of characters) {
    const substituted = SUBSTITUTES.get(character) ?? character;
    encoded += LABEL_SAFE_CHARACTER.test(substituted)
      ? substituted
      : `#${substituted.codePointAt(0) ?? 0};`;
  }
  return encoded.trim() === "" ? UNNAMED : encoded;
}

type Shape = readonly [open: string, close: string];

// E4: shape delimiters are constants keyed by kind.
const SHAPES = Object.freeze({
  stadium: ["([", "])"],
  rectangle: ["[", "]"],
  diamond: ["{", "}"],
  hexagon: ["{{", "}}"],
  subroutine: ["[[", "]]"],
  circle: ["((", "))"],
} satisfies Record<string, Shape>);

const LOGIC_SHAPES: Readonly<Record<string, Shape>> = Object.freeze({
  if: SHAPES.diamond,
  else_if: SHAPES.diamond,
  decision: SHAPES.diamond,
  for_each: SHAPES.hexagon,
  do_until: SHAPES.hexagon,
  end_flow: SHAPES.circle,
});

const CONDITION_LOGIC = new Set(["if", "else_if", "decision"]);

// E5: edge text comes from the edge kind alone.
const EDGE_SYNTAX: Readonly<Record<string, string>> = Object.freeze({
  next: "-->",
  true: "-->|true|",
  false: "-->|false|",
  loop_body: "-->|each|",
  loop_back: "-.->|repeat|",
  parallel: "-->|branch|",
  error: "-->|catch|",
  subflow: "-->|calls|",
});

interface DiagramNode {
  readonly key: string | undefined;
  readonly flow: number;
  readonly shape: Shape;
  readonly label: string;
}

interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly syntax: string;
}

/** A diagram issued for a flow graph, with what it shows and leaves out. */
export interface FlowMermaid {
  readonly diagram: MermaidDiagram;
  readonly nodes: number;
  readonly edges: number;
  readonly omitted: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function own(table: Readonly<Record<string, unknown>>, key: unknown): boolean {
  return typeof key === "string" && Object.hasOwn(table, key);
}

/** Text of a `FlowText`, or a constant placeholder when it has none. */
function flowText(value: unknown): string | undefined {
  const text = record(value);
  if (!text) return undefined;
  if (typeof text.text === "string" && text.text.trim() !== "") return text.text;
  return text.redacted === undefined ? undefined : "(redacted)";
}

function nodeShape(node: Record<string, unknown>): Shape {
  switch (node.kind) {
    case "trigger":
      return SHAPES.stadium;
    case "subflow":
      return SHAPES.subroutine;
    case "more":
      return SHAPES.circle;
    case "logic":
      return own(LOGIC_SHAPES, node.logic_kind)
        ? LOGIC_SHAPES[node.logic_kind as string]!
        : SHAPES.rectangle;
    default:
      return SHAPES.rectangle;
  }
}

function nodeLabel(node: Record<string, unknown>): string {
  if (node.kind === "more") {
    const omitted = node.omitted_steps;
    return (
      flowText(node.title) ??
      (Number.isSafeInteger(omitted) && (omitted as number) >= 0
        ? `… ${String(omitted)} more steps`
        : "… more steps")
    );
  }
  const subflow = record(node.subflow);
  const title =
    flowText(node.title) ?? (subflow ? flowText(subflow.name) : undefined) ?? UNNAMED;
  if (node.kind === "logic" && CONDITION_LOGIC.has(node.logic_kind as string)) {
    const condition = flowText(node.condition);
    if (condition !== undefined) return `${title}: ${condition}`;
  }
  return title;
}

function flowIndex(value: unknown, flows: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < flows
    ? (value as number)
    : 0;
}

/** Walk-ordered diagram nodes: the trigger first, then graph nodes. */
function collectNodes(graph: Record<string, unknown>): DiagramNode[] {
  const flowCount = array(graph.flows).length;
  const nodes: DiagramNode[] = [];
  const trigger = record(graph.trigger);
  if (trigger) {
    const type = flowText(trigger.type);
    nodes.push({
      key: "n0",
      flow: 0,
      shape: SHAPES.stadium,
      label: encodeMermaidLabel(type === undefined ? "Trigger" : `Trigger: ${type}`),
    });
  }
  for (const entry of array(graph.nodes)) {
    const node = record(entry);
    if (!node) continue;
    nodes.push({
      key: typeof node.id === "string" ? node.id : undefined,
      flow: flowIndex(node.flow_index, flowCount),
      shape: nodeShape(node),
      label: encodeMermaidLabel(nodeLabel(node)),
    });
  }
  return nodes;
}

function subgraphTitle(graph: Record<string, unknown>, index: number): string {
  for (const entry of array(graph.flows)) {
    const flow = record(entry);
    if (flow && flow.index === index) {
      return encodeMermaidLabel(flowText(flow.name) ?? "Subflow");
    }
  }
  return encodeMermaidLabel("Subflow");
}

function nodeLine(indent: string, id: string, node: DiagramNode): string {
  return `${indent}${id}${node.shape[0]}"${node.label}"${node.shape[1]}`;
}

/**
 * Mermaid source for the first `kept` nodes (E2 ids are allocated here from
 * walk order), the edges among them, and, when nodes are left out, a single
 * constant `nMore` node joined to the last one kept.
 */
function composeSource(
  graph: Record<string, unknown>,
  nodes: readonly DiagramNode[],
  rawEdges: readonly DiagramEdge[],
  kept: number
): { source: string; edges: number } {
  const ids = new Map<string, string>();
  const allocated: string[] = [];
  for (let index = 0; index < kept; index += 1) {
    const id = `n${index + 1}`;
    allocated.push(id);
    const key = nodes[index]!.key;
    if (key !== undefined && !ids.has(key)) ids.set(key, id);
  }
  const lines = [MERMAID_HEADER];
  const subflows: number[] = [];
  for (let index = 0; index < kept; index += 1) {
    const node = nodes[index]!;
    if (node.flow === 0) lines.push(nodeLine("", allocated[index]!, node));
    else if (!subflows.includes(node.flow)) subflows.push(node.flow);
  }
  subflows.forEach((flow, position) => {
    lines.push(`subgraph sg${position + 1} ["${subgraphTitle(graph, flow)}"]`);
    for (let index = 0; index < kept; index += 1) {
      const node = nodes[index]!;
      if (node.flow === flow) lines.push(nodeLine("    ", allocated[index]!, node));
    }
    lines.push("end");
  });
  const omitted = nodes.length - kept;
  if (omitted > 0) {
    lines.push(
      `nMore(("${encodeMermaidLabel(`… ${omitted} more steps (see outline)`)}"))`
    );
  }
  let edgeCount = 0;
  for (const edge of rawEdges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from === undefined || to === undefined) continue;
    lines.push(`${from} ${edge.syntax} ${to}`);
    edgeCount += 1;
  }
  if (omitted > 0 && kept > 0) {
    lines.push(`${allocated[kept - 1]!} --> nMore`);
    edgeCount += 1;
  }
  return { source: lines.join("\n"), edges: edgeCount };
}

function collectEdges(graph: Record<string, unknown>): DiagramEdge[] {
  const edges: DiagramEdge[] = [];
  for (const entry of array(graph.edges)) {
    const edge = record(entry);
    if (
      !edge ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      !own(EDGE_SYNTAX, edge.kind)
    ) {
      continue;
    }
    edges.push({ from: edge.from, to: edge.to, syntax: EDGE_SYNTAX[edge.kind as string]! });
  }
  return edges;
}

function fits(candidate: { source: string; edges: number }, kept: number, total: number): boolean {
  const nodeCount = kept + (kept < total ? 1 : 0);
  return (
    nodeCount <= MAX_MERMAID_NODES &&
    candidate.edges <= MAX_MERMAID_EDGES &&
    candidate.source.length <= MAX_MERMAID_SOURCE_LENGTH
  );
}

/**
 * Build and issue the Mermaid diagram for a flow graph (E1-E7). Nodes are
 * kept in walk order while the 150-node, 300-edge and 20,000-character caps
 * hold; the rest collapse into one `nMore` node. Returns undefined when the
 * result does not pass the line grammar, so the caller drops only the diagram.
 */
export function buildFlowMermaid(graph: FlowGraph | unknown): FlowMermaid | undefined {
  const root = record(graph);
  if (!root) return undefined;
  const nodes = collectNodes(root);
  const edges = collectEdges(root);
  if (nodes.length === 0) {
    const diagram = issueMermaidDiagram(
      `${MERMAID_HEADER}\nn1(("${encodeMermaidLabel("(no steps)")}"))`
    );
    return diagram && Object.freeze({ diagram, nodes: 1, edges: 0, omitted: 0 });
  }
  const total = nodes.length;
  let best = composeSource(root, nodes, edges, total);
  let kept = total;
  if (!fits(best, total, total)) {
    // Fewer kept nodes never adds lines or edges, so the largest fitting
    // prefix is found by binary search; zero kept (only nMore) always fits.
    let low = 0;
    let high = Math.min(total - 1, MAX_MERMAID_NODES - 1);
    kept = 0;
    best = composeSource(root, nodes, edges, 0);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = composeSource(root, nodes, edges, middle);
      if (fits(candidate, middle, total)) {
        kept = middle;
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
  }
  const diagram = issueMermaidDiagram(best.source);
  if (!diagram) return undefined;
  return Object.freeze({
    diagram,
    nodes: kept + (kept < total ? 1 : 0),
    edges: best.edges,
    omitted: total - kept,
  });
}
