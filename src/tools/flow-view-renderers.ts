/**
 * Text renderer for `sn_flow_view` (design sections 4.2 and 4.3).
 *
 * The renderer receives a deeply frozen JSON copy of the finalized envelope;
 * every value in `data` is untrusted. Text is composed only from `markdown.ts`
 * fragments: an escaped headline and summary table, an issued Mermaid
 * diagram, and a jsn-style outline inside one `untrustedBlock` fence. The
 * result is fitted exactly to the envelope's byte limit by a fixed ladder, so
 * the coordinator never has to fall back to the one-line summary because the
 * text overflowed.
 *
 * @module tools/flow-view-renderers
 */

import {
  FLOW_GRAPH_SCHEMA_BOUNDS,
  FLOW_LIMIT_HITS,
  FLOW_SOURCE_NAMES,
  FLOW_VIEW_LIMITS,
  FLOW_WARNING_CODES,
  REDACTION_REASONS as CONTRACT_REDACTION_REASONS,
  type FlowGraph,
  type FlowWarningCode,
} from "./flow-view-contracts.js";
import { buildFlowMermaid } from "./flow-view-mermaid.js";
import {
  bulletList,
  headline,
  mermaidBlock,
  recordLink,
  renderMarkdown,
  table,
  text,
  untrustedBlock,
  type MarkdownFragment,
} from "./markdown.js";
import {
  DEFAULT_RESULT_BYTE_LIMIT,
  registerEnvelopeTextRenderer,
  type EnvelopeTextRenderContext,
  type ProductionToolName,
  type RenderableEnvelope,
} from "./result-envelope.js";

export const FLOW_VIEW_TOOL = "sn_flow_view" satisfies ProductionToolName;

export const OUTLINE_MAX_LINES = FLOW_VIEW_LIMITS.OUTLINE_MAX_LINES;
export const OUTLINE_MAX_CHARS = FLOW_VIEW_LIMITS.OUTLINE_MAX_CHARS;
export const OUTLINE_MAX_VALUE_CHARS = FLOW_VIEW_LIMITS.OUTLINE_MAX_VALUE_CHARS;
/** The structuredContent cap on one input value. */
const STRUCTURED_VALUE_CHARS = FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS;
/** Bytes kept free under `metadata.limits.max_bytes` (section 4.3). */
export const RESPONSE_BYTE_MARGIN = 512;

const INDENT = "    ";
const MAX_SPLIT_LINES = 20;
const MAX_INDENT_LEVELS = 24;
const MAX_PILL_REPLACEMENTS = 50;
const MAX_OUTLINE_NAME_CHARS = 100;
// Room left under OUTLINE_MAX_CHARS for the closing truncation line.
const OUTLINE_RESERVE_CHARS = 200;
// The graph builder prefixes an expanded subflow's steps with its call site
// ("2.1.3"), so a step may have as many segments as the schema's step bound
// allows; the length check keeps the match linear.
const STEP_NUMBER = /^\d{1,4}(?:\.\d{1,4})*$/u;
const MAX_STEP_CHARS = FLOW_GRAPH_SCHEMA_BOUNDS.MAX_STEP_CHARS;
const SYS_ID = /^[0-9a-f]{32}$/u;

const LINE_BREAKS = /\r\n?|[\n\u0085\u2028\u2029]/gu;
const FLATTENED = /[\r\n\t\u0085\u2028\u2029]/gu;
const STRIPPED_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;

const REDACTION_REASONS: ReadonlySet<string> = new Set(CONTRACT_REDACTION_REASONS);
const SOURCES: ReadonlySet<string> = new Set(FLOW_SOURCE_NAMES);
const LIMITS: ReadonlySet<string> = new Set(FLOW_LIMIT_HITS);
const NOT_EXPANDED = new Set(["depth", "cycle", "limit", "denied", "not_found", "too_large", "timeout"]);
const WARNING_TEXT: Readonly<Record<FlowWarningCode, string>> = Object.freeze({
  subflow_cycle: "A subflow call cycle was found and not expanded again.",
  subflow_not_found: "A called subflow could not be found.",
  subflow_denied: "A called subflow was not expanded because policy denies it.",
  orphan_steps: "Some steps had an unknown parent and are shown at the top level.",
  unknown_logic_type: "Some flow logic types are not recognized and are drawn as plain steps.",
  items_dropped_invalid: "Some items failed validation and were dropped.",
  gzip_decode_failed: "Some compressed input values could not be decoded.",
  label_cache_unavailable: "Data pill labels were unavailable; raw pill tokens are shown.",
  flow_version_unknown: "The flow version could not be determined.",
  subflow_too_large: "A called subflow was too large to read and was not expanded.",
  inputs_omitted_too_large:
    "Input values were left out of a flow too large to read with them; it was read as with include_inputs=false.",
  flow_too_large: "The flow is too large to read, even without input values; only its record is shown.",
  input_values_incomplete: "Some older (V1) steps store more values than were read; their inputs may be incomplete.",
  subflow_timeout: "A called subflow was not expanded because reading it timed out; retrying may help.",
});

const KNOWN_WARNINGS: ReadonlySet<string> = new Set(FLOW_WARNING_CODES);

type Format = "both" | "mermaid" | "outline";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function truncateCodePoints(value: string, max: number): string {
  const characters = Array.from(value.slice(0, (max + 1) * 2));
  return characters.length <= max ? value : `${characters.slice(0, max).join("")}…`;
}

/** One line of inert outline text: no breaks, controls, bidi or invisibles. */
function outlineText(raw: unknown, max: number = OUTLINE_MAX_VALUE_CHARS): string {
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : "";
  // Bound the work before flattening; the cut is visible after truncation.
  const examined = value.length > max * 4 ? `${value.slice(0, max * 4)}…` : value;
  const flat = examined
    .replace(FLATTENED, " ")
    .replace(STRIPPED_CHARACTERS, "")
    .replace(LONE_SURROGATES, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  return truncateCodePoints(flat, max);
}

function redactedMarker(reason: unknown): string {
  return `[redacted: ${REDACTION_REASONS.has(reason as string) ? (reason as string) : "unknown"}]`;
}

/** Display text for a `FlowText`: its text, a redaction marker, or `(not set)`. */
function flowTextValue(value: unknown, max: number = OUTLINE_MAX_VALUE_CHARS): string {
  const flowText = record(value);
  if (flowText && typeof flowText.text === "string" && flowText.text.trim() !== "") {
    return outlineText(flowText.text, max);
  }
  if (flowText && flowText.redacted !== undefined) return redactedMarker(flowText.redacted);
  return "(not set)";
}

function hasFlowText(value: unknown): boolean {
  const flowText = record(value);
  return (
    flowText !== undefined &&
    ((typeof flowText.text === "string" && flowText.text.trim() !== "") ||
      flowText.redacted !== undefined)
  );
}

/** Bounded outline collector: at most OUTLINE_MAX_LINES lines and OUTLINE_MAX_CHARS. */
class OutlineWriter {
  readonly lines: string[] = [];
  private characters = 0;
  private full = false;

  push(level: number, line: string): void {
    if (this.full) return;
    const indented = `${INDENT.repeat(Math.min(Math.max(level, 0), MAX_INDENT_LEVELS))}${line}`;
    if (
      this.lines.length >= OUTLINE_MAX_LINES - 1 ||
      this.characters + indented.length + 1 > OUTLINE_MAX_CHARS - OUTLINE_RESERVE_CHARS
    ) {
      this.full = true;
      return;
    }
    this.lines.push(indented);
    this.characters += indented.length + 1;
  }

  finish(): string[] {
    if (this.full) {
      this.lines.push(
        `… outline stops at ${OUTLINE_MAX_LINES} lines or ${OUTLINE_MAX_CHARS.toLocaleString("en-US")} characters; the full graph is in structuredContent`
      );
    }
    if (this.lines.length === 0) this.lines.push("(no steps)");
    return this.lines;
  }
}

function relabelPills(value: string, input: Record<string, unknown>, pills: readonly unknown[]): string {
  let result = value.slice(0, STRUCTURED_VALUE_CHARS);
  for (const index of array(input.pills).slice(0, MAX_PILL_REPLACEMENTS)) {
    if (!Number.isSafeInteger(index)) continue;
    const pill = record(pills[index as number]);
    if (!pill || typeof pill.token !== "string" || pill.token === "") continue;
    if (typeof pill.label !== "string" || pill.label.trim() === "") continue;
    const token = pill.token.startsWith("{{") ? pill.token : `{{${pill.token}}}`;
    const label = `{{${pill.label}}}`;
    if (token === label) continue;
    result = result.split(token).join(label).slice(0, STRUCTURED_VALUE_CHARS);
  }
  return result;
}

function writeSplitValue(writer: OutlineWriter, level: number, name: string, value: string): void {
  const capped = truncateCodePoints(value, OUTLINE_MAX_VALUE_CHARS);
  if (!capped.includes("^")) {
    writer.push(level, `${name}: ${outlineText(capped)}`);
    return;
  }
  const parts = capped.split("^").map((part) => outlineText(part)).filter((part) => part !== "");
  writer.push(level, `${name}:`);
  for (const part of parts.slice(0, MAX_SPLIT_LINES)) writer.push(level + 1, part);
  if (parts.length > MAX_SPLIT_LINES) {
    writer.push(level + 1, `… ${parts.length - MAX_SPLIT_LINES} more`);
  }
}

function writeInput(
  writer: OutlineWriter,
  level: number,
  entry: unknown,
  pills: readonly unknown[]
): void {
  const input = record(entry);
  if (!input) return;
  const name =
    outlineText(
      typeof input.label === "string" && input.label.trim() !== "" ? input.label : input.name,
      MAX_OUTLINE_NAME_CHARS
    ) || "(input)";
  if (input.redacted !== undefined) {
    writer.push(level, `${name}: ${redactedMarker(input.redacted)}`);
    return;
  }
  if (typeof input.value !== "string") {
    writer.push(level, `${name}: (not set)`);
    return;
  }
  const originalLength = count(input.original_length);
  if (input.script === true) {
    const value = input.value.slice(0, STRUCTURED_VALUE_CHARS);
    const lines = value.split(LINE_BREAKS);
    const firstLine = outlineText(lines.find((line) => line.trim() !== "") ?? "");
    const characters = originalLength ?? Array.from(value).length;
    const truncated =
      originalLength !== undefined
        ? `; truncated in structuredContent at ${STRUCTURED_VALUE_CHARS.toLocaleString("en-US")}`
        : "";
    writer.push(
      level,
      `${name}: ${firstLine === "" ? "" : `${firstLine} `}[script: ${lines.length} lines, ${characters} chars${truncated}]`
    );
    return;
  }
  const value = relabelPills(input.value, input, pills);
  if (value.trim() === "") {
    writer.push(level, `${name}: (not set)`);
    return;
  }
  writeSplitValue(writer, level, name, value);
}

function writeInputs(
  writer: OutlineWriter,
  level: number,
  inputs: unknown,
  pills: readonly unknown[]
): void {
  for (const input of array(inputs)) writeInput(writer, level, input, pills);
}

function flowIndexOf(value: unknown, flowCount: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < flowCount
    ? (value as number)
    : 0;
}

interface OutlineContext {
  readonly writer: OutlineWriter;
  readonly nodesByFlow: ReadonlyMap<number, readonly Record<string, unknown>[]>;
  readonly flowNames: ReadonlyMap<number, unknown>;
  readonly pills: readonly unknown[];
  readonly expanded: Set<number>;
}

function writeNode(context: OutlineContext, base: number, node: Record<string, unknown>): void {
  const { writer, pills } = context;
  const depth = count(node.depth) ?? 0;
  const level = base + Math.min(depth, MAX_INDENT_LEVELS);
  const step =
    typeof node.step === "string" && node.step.length <= MAX_STEP_CHARS && STEP_NUMBER.test(node.step)
      ? `${node.step}.`
      : "-";
  const title = hasFlowText(node.title) ? flowTextValue(node.title) : "(unnamed)";
  if (node.kind === "more") {
    const omitted = count(node.omitted_steps);
    writer.push(
      level,
      `${step} … ${omitted === undefined ? "more" : String(omitted)} more steps not shown`
    );
    return;
  }
  if (node.kind === "subflow") {
    const subflow = record(node.subflow) ?? {};
    const name = hasFlowText(node.title) ? title : flowTextValue(subflow.name);
    const target = count(subflow.expanded_index);
    const reason = NOT_EXPANDED.has(subflow.not_expanded as string)
      ? ` (not expanded: ${subflow.not_expanded as string})`
      : "";
    const expandable =
      target !== undefined && target > 0 && context.nodesByFlow.has(target);
    const again = expandable && context.expanded.has(target) ? " (expanded above)" : "";
    writer.push(level, `${step} ↪ ${name}${reason}${again}`);
    if (hasFlowText(node.annotation)) {
      writer.push(level + 1, `Note: ${flowTextValue(node.annotation)}`);
    }
    writeInputs(writer, level + 1, node.inputs, pills);
    if (expandable && !context.expanded.has(target)) writeFlow(context, target, level + 1);
    return;
  }
  writer.push(level, `${step} ${title}`);
  if (node.condition !== undefined && hasFlowText(node.condition)) {
    const condition = record(node.condition);
    if (condition && typeof condition.text === "string" && condition.text.trim() !== "") {
      writeSplitValue(writer, level + 1, "Condition", condition.text);
    } else {
      writer.push(level + 1, `Condition: ${flowTextValue(node.condition)}`);
    }
  }
  if (hasFlowText(node.annotation)) {
    writer.push(level + 1, `Note: ${flowTextValue(node.annotation)}`);
  }
  writeInputs(writer, level + 1, node.inputs, pills);
}

function writeFlow(context: OutlineContext, index: number, base: number): void {
  context.expanded.add(index);
  for (const node of context.nodesByFlow.get(index) ?? []) writeNode(context, base, node);
}

function writeTrigger(writer: OutlineWriter, trigger: Record<string, unknown>, pills: readonly unknown[]): void {
  writer.push(0, `Trigger: ${flowTextValue(trigger.type)}`);
  if (hasFlowText(trigger.table)) writer.push(1, `Table: ${flowTextValue(trigger.table)}`);
  if (hasFlowText(trigger.condition)) {
    const condition = record(trigger.condition);
    if (condition && typeof condition.text === "string" && condition.text.trim() !== "") {
      writeSplitValue(writer, 1, "Condition", condition.text);
    } else {
      writer.push(1, `Condition: ${flowTextValue(trigger.condition)}`);
    }
  }
  if (hasFlowText(trigger.schedule)) writer.push(1, `Schedule: ${flowTextValue(trigger.schedule)}`);
  writeInputs(writer, 1, trigger.inputs, pills);
}

/** The jsn-style outline lines for a graph, bounded by the OUTLINE_* caps. */
export function flowOutlineLines(graph: FlowGraph | unknown): string[] {
  const root = record(graph) ?? {};
  const writer = new OutlineWriter();
  const flows = array(root.flows);
  const flowNames = new Map<number, unknown>();
  for (const entry of flows) {
    const flow = record(entry);
    const index = flow ? count(flow.index) : undefined;
    if (flow && index !== undefined && !flowNames.has(index)) flowNames.set(index, flow.name);
  }
  const nodesByFlow = new Map<number, Record<string, unknown>[]>();
  for (const entry of array(root.nodes)) {
    const node = record(entry);
    if (!node) continue;
    const index = flowIndexOf(node.flow_index, flows.length);
    const list = nodesByFlow.get(index) ?? [];
    list.push(node);
    nodesByFlow.set(index, list);
  }
  const pills = array(root.pills);
  const trigger = record(root.trigger);
  if (trigger) writeTrigger(writer, trigger, pills);
  const context: OutlineContext = {
    writer,
    nodesByFlow,
    flowNames,
    pills,
    expanded: new Set<number>(),
  };
  writeFlow(context, 0, 0);
  // Subflows the graph carries without a call site still get listed.
  for (const index of [...nodesByFlow.keys()].sort((a, b) => a - b)) {
    if (context.expanded.has(index)) continue;
    writer.push(0, `↪ Subflow: ${flowTextValue(flowNames.get(index))}`);
    writeFlow(context, index, 1);
  }
  return writer.finish();
}

function graphFormat(root: Record<string, unknown>): Format {
  const format = record(root.options)?.format;
  return format === "mermaid" || format === "outline" ? format : "both";
}

function rootFlow(root: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const entry of array(root.flows)) {
    const flow = record(entry);
    if (flow && flow.index === 0) return flow;
  }
  return record(array(root.flows)[0]);
}

function summaryTable(root: Record<string, unknown>): MarkdownFragment {
  const counts = record(root.counts) ?? {};
  const source = SOURCES.has(root.source as string) ? `${root.source as string} API` : "unknown";
  const rows: string[][] = [["Source", source]];
  const trigger = record(root.trigger);
  rows.push(["Trigger", trigger ? flowTextValue(trigger.type, 120) : "none"]);
  const returned = count(counts.nodes_returned);
  const seen = count(counts.steps_seen);
  rows.push([
    "Steps",
    returned === undefined ? "unknown" : seen === undefined ? String(returned) : `${returned} shown of ${seen}`,
  ]);
  const subflows = Math.max(array(root.flows).length - 1, 0);
  if (subflows > 0) rows.push(["Subflows expanded", String(subflows)]);
  const redacted = count(counts.inputs_redacted);
  const truncated = count(counts.inputs_truncated);
  if ((redacted ?? 0) > 0 || (truncated ?? 0) > 0) {
    rows.push(["Inputs", `${redacted ?? 0} redacted, ${truncated ?? 0} truncated`]);
  }
  const limits = [
    ...new Set(array(root.limits_hit).filter((limit): limit is string => LIMITS.has(limit as string))),
  ];
  rows.push(["Limits hit", limits.length === 0 ? "none" : limits.join(", ")]);
  return table(["Property", "Value"], rows, { maxCellLength: 200 });
}

function warningList(root: Record<string, unknown>): MarkdownFragment | undefined {
  const warnings = [
    ...new Set(
      array(root.warnings).filter(
        (warning): warning is FlowWarningCode =>
          typeof warning === "string" && KNOWN_WARNINGS.has(warning) && Object.hasOwn(WARNING_TEXT, warning)
      )
    ),
  ];
  return warnings.length === 0 ? undefined : bulletList(warnings.map((warning) => WARNING_TEXT[warning]!));
}

/** Everything the ladder composes; built once per render. */
export interface FlowViewTextParts {
  readonly header: readonly MarkdownFragment[];
  /** Present when the format asks for a diagram and it passed the grammar. */
  readonly mermaid?: MarkdownFragment;
  /** Present when the format asks for an outline. */
  readonly outline?: readonly string[];
  readonly footer: readonly MarkdownFragment[];
}

/** Headline, record link, summary table, diagram, outline and warnings for a graph. */
export function buildFlowViewTextParts(
  graph: FlowGraph | unknown,
  instanceOrigin?: string
): FlowViewTextParts {
  const root = record(graph) ?? {};
  const format = graphFormat(root);
  const flow = rootFlow(root) ?? {};
  const name = hasFlowText(flow.name) ? flowTextValue(flow.name, 200) : "(unnamed)";
  const kind = flow.type === "subflow" ? "Subflow" : "Flow";
  const state = [
    flow.active === true ? "active" : flow.active === false ? "inactive" : undefined,
    typeof flow.status === "string" ? outlineText(flow.status, 40) : undefined,
    typeof flow.version === "string" ? `version ${outlineText(flow.version, 40)}` : undefined,
  ].filter((part): part is string => part !== undefined && part !== "" && part !== "version ");
  const header: MarkdownFragment[] = [
    headline(text(`${kind}: ${name}`, 220), state.length === 0 ? {} : { detail: text(state.join(", "), 120) }),
  ];
  if (
    instanceOrigin !== undefined &&
    typeof flow.sys_id === "string" &&
    SYS_ID.test(flow.sys_id)
  ) {
    header.push(recordLink(instanceOrigin, "sys_hub_flow", flow.sys_id, "Open the flow record"));
  }
  header.push(summaryTable(root));
  let mermaid: MarkdownFragment | undefined;
  if (format !== "outline") {
    const built = buildFlowMermaid(root);
    if (built) mermaid = mermaidBlock(built.diagram);
  }
  const warnings = warningList(root);
  return Object.freeze({
    header: Object.freeze(header),
    ...(mermaid === undefined ? {} : { mermaid }),
    ...(format === "mermaid" ? {} : { outline: Object.freeze(flowOutlineLines(root)) }),
    footer: Object.freeze(warnings === undefined ? [] : [warnings]),
  });
}

export interface FlowViewTextChoice {
  readonly mermaid: boolean;
  /** Outline lines to show; fewer than all adds a cut line, 0 drops the outline. */
  readonly outlineLines: number;
}

/** The renderer text for one ladder choice. */
export function composeFlowViewText(parts: FlowViewTextParts, choice: FlowViewTextChoice): string {
  const outline = parts.outline ?? [];
  const shown = Math.min(Math.max(Math.floor(choice.outlineLines), 0), outline.length);
  const showMermaid = choice.mermaid && parts.mermaid !== undefined;
  const omitted = [
    parts.mermaid !== undefined && !showMermaid ? "the diagram" : undefined,
    outline.length > 0 && shown === 0 ? "the outline" : undefined,
  ].filter((part): part is string => part !== undefined);
  let outlineBlock: MarkdownFragment | undefined;
  if (shown > 0) {
    const lines = outline.slice(0, shown);
    if (shown < outline.length) {
      lines.push(
        `… outline cut to fit the response budget: ${shown} of ${outline.length} lines shown; the full graph is in structuredContent`
      );
    }
    outlineBlock = untrustedBlock("Flow outline", lines.join("\n"), OUTLINE_MAX_CHARS);
  }
  return renderMarkdown(
    ...parts.header,
    showMermaid ? parts.mermaid : undefined,
    outlineBlock,
    omitted.length === 0
      ? undefined
      : text(`Omitted to fit the response budget: ${omitted.join(" and ")}. The full graph is in structuredContent.`),
    ...parts.footer
  );
}

export type FlowViewLadderStep = 1 | 2 | 3 | 4;

export interface FittedFlowViewText {
  readonly text: string;
  readonly step: FlowViewLadderStep;
  readonly outline_lines: number;
}

function largestFitting(
  low: number,
  high: number,
  attempt: (lines: number) => string,
  fits: (text: string) => boolean
): { lines: number; text: string } | undefined {
  let best: { lines: number; text: string } | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = attempt(middle);
    if (fits(candidate)) {
      best = { lines: middle, text: candidate };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Descend the section 4.3 ladder and return the first text that fits:
 * (1) header + diagram + full outline; (2) header + diagram + outline cut to
 * fit; (3) header + outline only (cut to fit if needed); (4) header + summary
 * table. Undefined when even step 4 does not fit.
 */
export function fitFlowViewText(
  parts: FlowViewTextParts,
  fits: (text: string) => boolean
): FittedFlowViewText | undefined {
  const total = parts.outline?.length ?? 0;
  const hasMermaid = parts.mermaid !== undefined;
  const full = composeFlowViewText(parts, { mermaid: hasMermaid, outlineLines: total });
  if (fits(full)) return Object.freeze({ text: full, step: 1, outline_lines: total });
  if (hasMermaid && total > 1) {
    const cut = largestFitting(
      1,
      total - 1,
      (lines) => composeFlowViewText(parts, { mermaid: true, outlineLines: lines }),
      fits
    );
    if (cut) return Object.freeze({ text: cut.text, step: 2, outline_lines: cut.lines });
  }
  if (total > 0) {
    const outlineOnly = largestFitting(
      1,
      hasMermaid ? total : total - 1,
      (lines) => composeFlowViewText(parts, { mermaid: false, outlineLines: lines }),
      fits
    );
    if (outlineOnly) {
      return Object.freeze({ text: outlineOnly.text, step: 3, outline_lines: outlineOnly.lines });
    }
  }
  const summary = composeFlowViewText(parts, { mermaid: false, outlineLines: 0 });
  return fits(summary) ? Object.freeze({ text: summary, step: 4, outline_lines: 0 }) : undefined;
}

/**
 * Exact serialized size of the final result for `text`, measured as
 * `{ content: [{ type: "text", text }], structuredContent: envelope }`.
 */
export function flowViewResultBytes(envelope: unknown, rendered: string): number {
  return Buffer.byteLength(
    JSON.stringify({ content: [{ type: "text", text: rendered }], structuredContent: envelope }),
    "utf8"
  );
}

function maxBytes(envelope: RenderableEnvelope): number {
  const limit = record(record(envelope.metadata)?.limits)?.max_bytes;
  return Number.isSafeInteger(limit) && (limit as number) > 0
    ? (limit as number)
    : DEFAULT_RESULT_BYTE_LIMIT;
}

/** The `sn_flow_view` envelope text renderer. */
export function renderFlowView(
  envelope: RenderableEnvelope,
  context: EnvelopeTextRenderContext
): string {
  const graph = record(envelope.data);
  if (!graph) return context.summary;
  const budget = maxBytes(envelope) - RESPONSE_BYTE_MARGIN;
  // The text is the only part that varies, so the rest is measured once:
  // the empty string serializes as `""`, two bytes, in the same position.
  const fixed = flowViewResultBytes(envelope, "") - 2;
  const fits = (candidate: string): boolean =>
    fixed + Buffer.byteLength(JSON.stringify(candidate), "utf8") <= budget;
  const fitted = fitFlowViewText(buildFlowViewTextParts(graph, context.instanceOrigin), fits);
  return fitted?.text ?? context.summary;
}

let registered = false;

/**
 * Register the `sn_flow_view` text renderer with the result envelope, once.
 * `flow-view-module.ts` calls this at module load.
 */
export function registerFlowViewRenderer(): void {
  if (registered) return;
  registerEnvelopeTextRenderer(FLOW_VIEW_TOOL, renderFlowView);
  registered = true;
}
