/**
 * The map output of `sn_relationships`: the CIs a call lists and the
 * relationships among them, as structured `nodes` and `edges` and as a
 * Mermaid diagram.
 *
 * Every name and class here was read from `cmdb_ci` under the profile's field
 * policy by the handler; this module only lays them out. Instance text enters
 * the diagram solely through `encodeMermaidLabel`, inside constant shape
 * delimiters, with renderer-allocated node ids, and the finished source is
 * issued by `markdown.ts` only after it passes the closed line grammar there.
 * That grammar has no edge labels from instance text, so a diagram edge shows
 * the direction (parent to child) and the relationship type is in `edges`.
 *
 * @module tools/relationships-map
 */

import { serializedBytes } from "../utils.js";
import { encodeMermaidLabel } from "./flow-view-mermaid.js";
import {
  MAX_MERMAID_EDGES,
  MAX_MERMAID_NODES,
  MAX_MERMAID_SOURCE_LENGTH,
  MERMAID_HEADER,
  issueMermaidDiagram,
} from "./markdown.js";

/** One CI of a map. `name` and `class` are left out when the profile cannot read them. */
export interface MapNode {
  readonly sys_id: string;
  readonly name?: string;
  readonly class?: string;
  readonly depth: number;
}

/** One relationship between two CIs of a map; `sys_id` is the relationship row's. */
export interface MapEdge {
  readonly sys_id?: string;
  readonly parent: string;
  readonly child: string;
  readonly type: string;
}

export interface MapDiagram {
  readonly format: "mermaid";
  /** Absent when the diagram could not be issued. */
  readonly source?: string;
  /** CIs of the map the diagram collapses into one "more" node. */
  readonly omitted_nodes?: number;
  readonly note?: string;
}

export interface RelationshipMap {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly diagram: MapDiagram;
  /** Listed CIs left out of `nodes` to keep the map within its byte budget. */
  readonly omitted_nodes: number;
}

const SYS_ID = /^[0-9a-f]{32}$/u;

function nodeLabel(node: MapNode): string {
  const name = node.name ?? node.sys_id;
  return encodeMermaidLabel(node.class === undefined ? name : `${name} (${node.class})`);
}

function edgesAmong(
  nodes: readonly MapNode[],
  edges: readonly MapEdge[]
): MapEdge[] {
  const present = new Set(nodes.map((node) => node.sys_id));
  return edges.filter((edge) => present.has(edge.parent) && present.has(edge.child));
}

interface Composed {
  readonly source: string;
  readonly edges: number;
}

/**
 * Mermaid source for the first `kept` nodes (ids `n1`, `n2`, ... by position,
 * the first being the start CI) and the edges among them. When nodes are left
 * out, one constant `nMore` node is joined to the first.
 */
function compose(
  nodes: readonly MapNode[],
  edges: readonly MapEdge[],
  kept: number
): Composed {
  const ids = new Map<string, string>();
  const lines = [MERMAID_HEADER];
  for (let index = 0; index < kept; index += 1) {
    const node = nodes[index]!;
    const id = `n${index + 1}`;
    ids.set(node.sys_id, id);
    const label = nodeLabel(node);
    lines.push(index === 0 ? `${id}(["${label}"])` : `${id}["${label}"]`);
  }
  const omitted = nodes.length - kept;
  if (omitted > 0) {
    lines.push(
      `nMore(("${encodeMermaidLabel(`… ${omitted} more CIs (see nodes)`)}"))`
    );
  }
  let count = 0;
  for (const edge of edges) {
    const from = ids.get(edge.parent);
    const to = ids.get(edge.child);
    if (from === undefined || to === undefined) continue;
    lines.push(`${from} --> ${to}`);
    count += 1;
  }
  if (omitted > 0 && kept > 0) {
    lines.push("n1 --> nMore");
    count += 1;
  }
  return { source: lines.join("\n"), edges: count };
}

function fits(composed: Composed, kept: number, total: number): boolean {
  const nodeCount = kept + (kept < total ? 1 : 0);
  return (
    nodeCount <= MAX_MERMAID_NODES &&
    composed.edges <= MAX_MERMAID_EDGES &&
    composed.source.length <= MAX_MERMAID_SOURCE_LENGTH
  );
}

/**
 * The diagram for `nodes` and `edges`. The largest prefix of the nodes (the
 * start CI and the CIs nearest it first) that fits the 150-node, 300-edge and
 * 20,000-character caps is drawn, and the rest collapse into one node. Fewer
 * nodes never add lines or edges, so the prefix is found by binary search.
 */
export function buildRelationshipDiagram(
  nodes: readonly MapNode[],
  edges: readonly MapEdge[]
): MapDiagram {
  if (nodes.length === 0) return { format: "mermaid", note: "No CIs to draw." };
  const total = nodes.length;
  let best = compose(nodes, edges, total);
  let kept = total;
  if (!fits(best, total, total)) {
    let low = 1;
    let high = Math.min(total - 1, MAX_MERMAID_NODES - 1);
    kept = 1;
    best = compose(nodes, edges, 1);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = compose(nodes, edges, middle);
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
  if (diagram === undefined) {
    return { format: "mermaid", note: "The diagram could not be built; nodes and edges describe the same graph." };
  }
  return {
    format: "mermaid",
    source: diagram.source,
    ...(kept < total ? { omitted_nodes: total - kept } : {}),
  };
}

function sizeOf(parts: { nodes: unknown; edges: unknown; diagram: unknown }): number {
  return serializedBytes(parts);
}

/**
 * The map of `start` and the CIs `listed` after it, with the relationships
 * among them (each relationship once, by its row's sys_id). When the whole map
 * would take more than `byteBudget` bytes, the nearest CIs that fit are kept,
 * and `omitted_nodes` says how many were left out.
 */
export function buildRelationshipMap(
  start: MapNode,
  listed: readonly MapNode[],
  edges: readonly MapEdge[],
  byteBudget: number
): RelationshipMap {
  const all = [start, ...listed].filter(
    (node, index, nodes) =>
      SYS_ID.test(node.sys_id) &&
      nodes.findIndex((other) => other.sys_id === node.sys_id) === index
  );
  const assemble = (kept: number) => {
    const nodes = all.slice(0, kept);
    const among = edgesAmong(nodes, edges);
    const diagram = buildRelationshipDiagram(nodes, among);
    return { nodes, edges: among, diagram };
  };
  let kept = all.length;
  let best = assemble(kept);
  if (sizeOf(best) > byteBudget) {
    let low = 1;
    let high = all.length - 1;
    kept = 1;
    best = assemble(1);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = assemble(middle);
      if (sizeOf(candidate) <= byteBudget) {
        kept = middle;
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
  }
  return {
    nodes: best.nodes,
    edges: best.edges,
    diagram: best.diagram,
    omitted_nodes: all.length - kept,
  };
}
