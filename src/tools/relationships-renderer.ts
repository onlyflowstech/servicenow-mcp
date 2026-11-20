/**
 * The readable text of an `sn_relationships` result that carries a map.
 *
 * A result without a map keeps the dispatcher's one-line summary, so this
 * renderer returns nothing for it. With a map the text is the Mermaid diagram,
 * issued again here from the structured source so it passes the line grammar
 * in `markdown.ts`, a short summary and the warnings. Names are instance text:
 * they appear only inside the diagram (encoded labels) and as escaped inline
 * text; the trusted parts hold counts and fixed words.
 *
 * `relationshipsTextRenderer` is registered in `catalog.ts`.
 *
 * @module tools/relationships-renderer
 */

import { envelopeTextFits } from "./envelope-text-fit.js";
import {
  bulletList,
  headline,
  issueMermaidDiagram,
  mermaidBlock,
  renderMarkdown,
  text,
  type MarkdownFragment,
} from "./markdown.js";
import type { EnvelopeTextRenderer } from "./result-envelope.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function plural(amount: number, singular: string, many = `${singular}s`): string {
  return `${amount} ${amount === 1 ? singular : many}`;
}

/** The text of a result with a map, with or without its diagram; undefined for any other result. */
export function renderRelationshipsText(
  data: unknown,
  options: { readonly diagram?: boolean } = {}
): string | undefined {
  const record = asRecord(data);
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) return undefined;
  const root = asRecord(record.root);
  const meta = asRecord(record.meta);
  const diagram = asRecord(record.diagram);
  const title = typeof root.name === "string" && root.name !== "" ? root.name : String(root.sys_id ?? "CI");
  const blocks: (MarkdownFragment | undefined)[] = [
    headline(text(`Relationships of ${title}`, 200), {
      status: "pass",
      detail: text(
        `${plural(record.nodes.length, "CI")}, ${plural(record.edges.length, "relationship")}, ` +
          `${String(meta.direction ?? "both")} to depth ${String(meta.depth ?? "?")}`
      ),
    }),
  ];
  const notes: string[] = [];
  const issued =
    options.diagram !== false && typeof diagram.source === "string"
      ? issueMermaidDiagram(diagram.source)
      : undefined;
  if (issued) {
    blocks.push(mermaidBlock(issued));
    notes.push("Arrows point from parent to child; the relationship types are in edges.");
  } else if (typeof diagram.source === "string") {
    notes.push("The diagram is in structuredContent; it was left out of this text to fit the response budget.");
  }
  const omitted = count(diagram.omitted_nodes);
  if (omitted !== undefined && omitted > 0) {
    notes.push(`The diagram draws the nearest CIs and collapses ${plural(omitted, "other")} into one node.`);
  }
  if (typeof diagram.note === "string") notes.push(diagram.note);
  if (meta.has_more === true) {
    notes.push(`More CIs: repeat the call with offset ${String(meta.next_offset ?? "")}.`);
  }
  for (const warning of Array.isArray(record.warnings) ? record.warnings : []) {
    if (typeof warning === "string") notes.push(warning);
  }
  if (notes.length > 0) blocks.push(bulletList(notes));
  return renderMarkdown(...blocks);
}

/** The text with its diagram when that fits beside the result, else without it, else the summary. */
export const relationshipsTextRenderer: EnvelopeTextRenderer = (envelope) => {
  const full = renderRelationshipsText(envelope.data);
  if (full === undefined) return "";
  const fits = envelopeTextFits(envelope);
  if (fits(full)) return full;
  const bare = renderRelationshipsText(envelope.data, { diagram: false });
  return bare !== undefined && fits(bare) ? bare : "";
};
