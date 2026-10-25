/**
 * Graph builder for `sn_flow_view`: turns the loader's source-neutral
 * `NormalizedFlowDefinition` (plus already-loaded subflows) into the
 * `FlowGraph` the renderers consume.
 *
 * Pure and synchronous. No I/O, no policy decisions: every text and input it
 * receives was already projected through field policy, so this module only
 * shapes, bounds and links.
 *
 * Conventions (documented for Task E and Task F):
 * - Node ids are generated, `n1..`, in walk order. The trigger is `n0`.
 * - `nodes` is ordered root flow first (pre-order), then each expanded flow in
 *   expansion order (breadth first), each again in pre-order.
 * - `FlowNode.depth` is relative to the node's OWN flow (0 = top level of that
 *   flow). The renderer indents an expanded subflow one level below its call
 *   site. `FlowNode.step` is the full outline path: a subflow body is
 *   numbered under its call site ("3" calls a subflow, whose steps are
 *   "3.1", "3.2", ...), so steps are unique across the whole graph.
 *
 * @module tools/flow-view-graph
 */

import {
  FLOW_GRAPH_SCHEMA_BOUNDS,
  FLOW_LIMIT_HITS,
  FLOW_LOGIC_KINDS,
  FLOW_VIEW_LIMITS,
  FLOW_VIEW_TABLES,
  FLOW_WARNING_CODES,
  REDACTION_REASONS,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowGraph,
  type FlowHeader,
  type FlowInputValue,
  type FlowLimitHit,
  type FlowLogicKind,
  type FlowNode,
  type FlowPill,
  type FlowRecordRef,
  type FlowText,
  type FlowTrigger,
  type FlowVariableDef,
  type FlowViewOptions,
  type FlowWarningCode,
  type NormalizedFlowDefinition,
  type NormalizedStep,
  type RedactionReason,
} from "./flow-view-contracts.js";

const L = FLOW_VIEW_LIMITS;
const B = FLOW_GRAPH_SCHEMA_BOUNDS;

const SYS_ID = /^[0-9a-f]{32}$/u;
const PILL = /\{\{([^{}]{1,500})\}\}/gu;
const LOGIC_KIND_SET: ReadonlySet<string> = new Set(FLOW_LOGIC_KINDS);
const REDACTION_SET: ReadonlySet<string> = new Set(REDACTION_REASONS);
const TABLE_SET: ReadonlySet<string> = new Set(FLOW_VIEW_TABLES);
const TERMINAL_KINDS: ReadonlySet<FlowLogicKind> = new Set(["end_flow", "exit_loop", "skip_iteration"]);

/** Ladder step indices reported by {@link fitFlowGraphToBudget}. */
export const FLOW_GRAPH_BUDGET_STEPS = Object.freeze({
  FITS: 0,
  VALUES_500: 1,
  VALUES_120: 2,
  INPUTS_DROPPED: 3,
  TEXTS_CUT: 4,
  NODES_HALVED: 5,
  PILLS_VARIABLES_DROPPED: 6,
  NODES_HALVED_REPEATEDLY: 7,
} as const);

/** Descriptions, annotations and conditions are cut to this many units by the ladder. */
export const FLOW_GRAPH_LADDER_TEXT_CHARS = 200;

/** A subflow the module could not load. */
export interface FlowSubflowUnavailable {
  /**
   * `too_large`: its load did not fit one response scope, even without
   * inputs. `timeout`: a read timed out.
   */
  unavailable: "denied" | "not_found" | "too_large" | "timeout";
}

export interface FlowGraphBuildInput {
  root: NormalizedFlowDefinition;
  /**
   * Loaded subflows keyed by `flow_sys_id`. A call site whose target is
   * absent is reported as `not_expanded: "limit"`.
   */
  subflows?: ReadonlyMap<string, NormalizedFlowDefinition | FlowSubflowUnavailable>;
  options: Pick<FlowViewOptions, "depth" | "include_inputs" | "max_nodes" | "format" | "max_response_bytes">;
  /** Limits and warnings the module itself observed (for example `upstream_scopes`). */
  limits_hit?: readonly FlowLimitHit[];
  warnings?: readonly FlowWarningCode[];
}

/** Distinct, valid subflow targets called by a flow, in step order. */
export function subflowCallTargets(def: NormalizedFlowDefinition): string[] {
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (step.kind !== "subflow") continue;
    const id = step.subflow?.flow_sys_id;
    if (typeof id === "string" && SYS_ID.test(id)) seen.add(id);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function cleanText(raw: FlowText | undefined | null, max: number): FlowText {
  const out: FlowText = { text: null };
  if (!raw || typeof raw !== "object") return out;
  const original = typeof raw.original_length === "number" && Number.isInteger(raw.original_length) &&
    raw.original_length >= 0 ? raw.original_length : undefined;
  if (typeof raw.text === "string") {
    if (raw.text.length > max) {
      out.text = cutUnits(raw.text, max);
      out.original_length = Math.max(original ?? 0, raw.text.length);
    } else {
      out.text = raw.text;
      if (original !== undefined) out.original_length = original;
    }
  } else if (original !== undefined) {
    out.original_length = original;
  }
  if (typeof raw.redacted === "string" && REDACTION_SET.has(raw.redacted)) {
    out.redacted = raw.redacted as RedactionReason;
  }
  return out;
}

function shortString(value: unknown, max: number): string | null {
  return typeof value === "string" ? cutUnits(value, max) : null;
}

function finiteOrder(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validRef(ref: FlowRecordRef | undefined): FlowRecordRef | undefined {
  if (!ref || typeof ref !== "object") return undefined;
  if (!TABLE_SET.has(ref.table) || typeof ref.sys_id !== "string" || !SYS_ID.test(ref.sys_id)) return undefined;
  return { table: ref.table, sys_id: ref.sys_id };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Per-flow preparation
// ---------------------------------------------------------------------------

type BranchFamily = "if" | "try" | "top_level_try";

function headFamily(kind: FlowLogicKind | null): BranchFamily | null {
  if (kind === "if") return "if";
  if (kind === "try") return "try";
  if (kind === "top_level_try") return "top_level_try";
  return null;
}

function branchFamily(kind: FlowLogicKind | null): BranchFamily | null {
  if (kind === "else_if" || kind === "else") return "if";
  if (kind === "catch") return "try";
  if (kind === "top_level_catch") return "top_level_try";
  return null;
}

interface FlowCtx {
  index: number;
  level: number;
  path: readonly string[];
  prefix: string;
  steps: NormalizedStep[];
  position: Map<NormalizedStep, number>;
  byUid: Map<string, NormalizedStep>;
  children: Map<string, NormalizedStep[]>;
  roots: NormalizedStep[];
  /** Orphans and cycle heads, appended after the real roots. */
  promoted: NormalizedStep[];
  visited: Set<string>;
  kinds: Map<NormalizedStep, FlowLogicKind | null>;
}

interface Entry { step: NormalizedStep; num: string }
interface Group { head: Entry; branches: Entry[] }
interface Exit { from: string; kind: FlowEdgeKind }
interface Seq { entry: string; exits: Exit[] }

interface Pending {
  ctx: FlowCtx;
  def: NormalizedFlowDefinition;
  callId: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

class GraphBuilder {
  readonly nodes: FlowNode[] = [];
  readonly sources: NormalizedStep[] = [];
  readonly flowDefs: NormalizedFlowDefinition[] = [];
  readonly headers: FlowHeader[] = [];
  readonly edges: FlowEdge[] = [];
  readonly limits = new Set<FlowLimitHit>();
  readonly warnings = new Set<FlowWarningCode>();
  private readonly edgeKeys = new Set<string>();
  private readonly expanded = new Map<string, number>();
  private readonly queue: Pending[] = [];
  stepsSeen = 0;
  itemsDropped = 0;
  rootEntry: string | undefined;

  constructor(private readonly input: FlowGraphBuildInput) {}

  build(): void {
    const { root } = this.input;
    this.registerFlow(root, undefined);
    const rootCtx = this.prepare(root, 0, 1, [root.header.sys_id], "");
    this.rootEntry = this.walkFlow(rootCtx);
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      const entry = this.walkFlow(next.ctx);
      if (entry !== undefined) this.edge(next.callId, entry, "subflow");
    }
  }

  // -- flows ---------------------------------------------------------------

  private registerFlow(def: NormalizedFlowDefinition, callId: string | undefined): number {
    const index = this.headers.length;
    const h = def.header;
    const header: FlowHeader = {
      index,
      source: "table",
      sys_id: h.sys_id,
      name: cleanText(h.name, L.MAX_TITLE_CHARS),
      description: cleanText(h.description, B.MAX_TEXT_CHARS),
      type: h.type === "flow" || h.type === "subflow" ? h.type : null,
      active: typeof h.active === "boolean" ? h.active : null,
      status: shortString(h.status, B.MAX_SHORT_CHARS),
      version: shortString(h.version, B.MAX_SHORT_CHARS),
      scope: shortString(h.scope, B.MAX_SHORT_CHARS),
    };
    if (callId !== undefined) header.called_from = callId;
    this.headers.push(header);
    this.flowDefs.push(def);
    this.expanded.set(h.sys_id, index);
    for (const w of def.warnings) this.warnings.add(w);
    for (const l of def.limits_hit) this.limits.add(l);
    this.itemsDropped += Math.max(0, def.items_dropped | 0);
    this.stepsSeen += def.steps.length;
    return index;
  }

  /** Validate steps, then compute roots (including orphans) for one flow. */
  private prepare(
    def: NormalizedFlowDefinition,
    index: number,
    level: number,
    path: readonly string[],
    prefix: string
  ): FlowCtx {
    const steps: NormalizedStep[] = [];
    const byUid = new Map<string, NormalizedStep>();
    const position = new Map<NormalizedStep, number>();
    const kinds = new Map<NormalizedStep, FlowLogicKind | null>();
    for (const step of def.steps) {
      const valid =
        step && typeof step.uid === "string" && step.uid !== "" &&
        (step.kind === "action" || step.kind === "logic" || step.kind === "subflow") &&
        !byUid.has(step.uid);
      if (!valid) {
        this.itemsDropped += 1;
        this.warnings.add("items_dropped_invalid");
        continue;
      }
      position.set(step, steps.length);
      steps.push(step);
      byUid.set(step.uid, step);
      kinds.set(step, this.logicKindOf(step));
    }

    const ctx: FlowCtx = {
      index, level, path, prefix, steps, position, byUid, kinds,
      children: new Map(), roots: [], promoted: [], visited: new Set(),
    };

    const top: NormalizedStep[] = [];
    const unknownParent: NormalizedStep[] = [];
    for (const step of steps) {
      const parent = step.parent_uid;
      if (parent === null || parent === undefined || parent === "") top.push(step);
      else if (!byUid.has(parent)) unknownParent.push(step);
      else {
        const list = ctx.children.get(parent);
        if (list) list.push(step);
        else ctx.children.set(parent, [step]);
      }
    }

    // Reachability from real roots, then from orphans, then from cycle heads.
    const reached = new Set<string>();
    const mark = (start: NormalizedStep): void => {
      const stack = [start];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (reached.has(cur.uid)) continue;
        reached.add(cur.uid);
        for (const kid of ctx.children.get(cur.uid) ?? []) stack.push(kid);
      }
    };
    for (const step of top) mark(step);
    const promoted: NormalizedStep[] = [];
    for (const step of this.sortSteps(ctx, unknownParent)) {
      if (!reached.has(step.uid)) {
        promoted.push(step);
        mark(step);
      }
    }
    for (const step of this.sortSteps(ctx, steps)) {
      if (!reached.has(step.uid)) {
        promoted.push(step);
        mark(step);
      }
    }
    if (promoted.length > 0) this.warnings.add("orphan_steps");
    ctx.roots = top;
    ctx.promoted = promoted;
    return ctx;
  }

  private logicKindOf(step: NormalizedStep): FlowLogicKind | null {
    if (step.kind !== "logic") return null;
    const kind = step.logic_kind;
    if (typeof kind === "string" && LOGIC_KIND_SET.has(kind) && kind !== "other") return kind;
    this.warnings.add("unknown_logic_type");
    return "other";
  }

  private sortSteps(ctx: FlowCtx, list: readonly NormalizedStep[]): NormalizedStep[] {
    return [...list].sort((a, b) => {
      const oa = finiteOrder(a.order);
      const ob = finiteOrder(b.order);
      if (oa !== ob) {
        if (oa === null) return 1;
        if (ob === null) return -1;
        if (oa !== ob) return oa - ob;
      }
      return (ctx.position.get(a) ?? 0) - (ctx.position.get(b) ?? 0);
    });
  }

  // -- walking -------------------------------------------------------------

  private walkFlow(ctx: FlowCtx): string | undefined {
    const seq = this.sequence(ctx.roots, ctx, 0, undefined, ctx.prefix, ctx.promoted);
    return seq?.entry;
  }

  private edge(from: string, to: string, kind: FlowEdgeKind): void {
    const key = `${from}>${to}:${kind}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ from, to, kind });
  }

  private arrange(
    list: readonly NormalizedStep[],
    ctx: FlowCtx,
    prefix: string,
    tail: readonly NormalizedStep[] = []
  ): Group[] {
    const live = list.filter((step) => !ctx.visited.has(step.uid));
    const liveTail = tail.filter((step) => !ctx.visited.has(step.uid));
    const sorted = [...this.sortSteps(ctx, live), ...this.sortSteps(ctx, liveTail)];
    const inList = new Map<string, NormalizedStep>();
    for (const step of sorted) inList.set(step.uid, step);

    const branchHead = new Map<NormalizedStep, NormalizedStep>();
    // Branches of each head, in `sorted` order; built once so grouping is linear.
    const branchesOf = new Map<NormalizedStep, NormalizedStep[]>();
    const lastHead = new Map<BranchFamily, NormalizedStep>();
    for (const step of sorted) {
      const kind = ctx.kinds.get(step) ?? null;
      const family = branchFamily(kind);
      if (family) {
        let head = step.connected_uid ? inList.get(step.connected_uid) : undefined;
        if (head && (head === step || headFamily(ctx.kinds.get(head) ?? null) !== family)) head = undefined;
        head ??= lastHead.get(family);
        if (head) {
          branchHead.set(step, head);
          const branches = branchesOf.get(head);
          if (branches) branches.push(step);
          else branchesOf.set(head, [step]);
        } else {
          this.warnings.add("orphan_steps");
        }
      }
      const own = headFamily(kind);
      if (own) lastHead.set(own, step);
    }

    const groups: Group[] = [];
    let counter = 0;
    const entry = (step: NormalizedStep): Entry => {
      counter += 1;
      return { step, num: prefix === "" ? String(counter) : `${prefix}.${counter}` };
    };
    for (const step of sorted) {
      if (branchHead.has(step)) continue;
      const head = entry(step);
      const attached = [...(branchesOf.get(step) ?? [])];
      // else_if branches first, the else last; each ordered by `order`.
      const rank = (s: NormalizedStep): number => (ctx.kinds.get(s) === "else" ? 1 : 0);
      attached.sort((a, b) => rank(a) - rank(b));
      groups.push({ head, branches: attached.map(entry) });
    }
    return groups;
  }

  private sequence(
    list: readonly NormalizedStep[],
    ctx: FlowCtx,
    depth: number,
    parent: string | undefined,
    prefix: string,
    tail: readonly NormalizedStep[] = []
  ): Seq | undefined {
    const groups = this.arrange(list, ctx, prefix, tail);
    let first: string | undefined;
    let open: Exit[] = [];
    for (const group of groups) {
      const result = this.group(group, ctx, depth, parent);
      if (first === undefined) first = result.entry;
      for (const exit of open) this.edge(exit.from, result.entry, exit.kind);
      open = result.exits;
    }
    return first === undefined ? undefined : { entry: first, exits: open };
  }

  private makeNode(entry: Entry, ctx: FlowCtx, depth: number, parent: string | undefined): string {
    const step = entry.step;
    ctx.visited.add(step.uid);
    const id = `n${this.nodes.length + 1}`;
    const node: FlowNode = {
      id,
      flow_index: ctx.index,
      kind: step.kind,
      step: entry.num,
      depth,
      order: finiteOrder(step.order),
      title: cleanText(step.title, L.MAX_TITLE_CHARS),
      annotation: cleanText(step.annotation, B.MAX_TEXT_CHARS),
    };
    if (step.kind === "logic") node.logic_kind = ctx.kinds.get(step) ?? "other";
    if (parent !== undefined) node.parent = parent;
    if (step.condition) node.condition = cleanText(step.condition, B.MAX_TEXT_CHARS);
    const ref = validRef(step.ref);
    if (ref) node.ref = ref;
    this.nodes.push(node);
    this.sources.push(step);
    return id;
  }

  private kids(step: NormalizedStep, ctx: FlowCtx): NormalizedStep[] {
    return (ctx.children.get(step.uid) ?? []).filter((kid) => !ctx.visited.has(kid.uid));
  }

  /** Walk the children of `owner` one level deeper; undefined when empty or too deep. */
  private childSequence(
    owner: string,
    ownerDepth: number,
    ownerNum: string,
    children: readonly NormalizedStep[],
    ctx: FlowCtx
  ): Seq | undefined {
    if (children.length === 0) return undefined;
    if (ownerDepth + 1 > L.MAX_NESTING) {
      this.limits.add("max_nesting");
      return undefined;
    }
    return this.sequence(children, ctx, ownerDepth + 1, owner, ownerNum);
  }

  /** Body of a block: edge of `kind` to its first child, or the owner is the open end. */
  private body(
    owner: string,
    ownerDepth: number,
    ownerNum: string,
    step: NormalizedStep,
    kind: FlowEdgeKind,
    ctx: FlowCtx
  ): Exit[] {
    const seq = this.childSequence(owner, ownerDepth, ownerNum, this.kids(step, ctx), ctx);
    if (!seq) return [{ from: owner, kind }];
    this.edge(owner, seq.entry, kind);
    return seq.exits;
  }

  private group(group: Group, ctx: FlowCtx, depth: number, parent: string | undefined): Seq {
    const { head } = group;
    const kind = ctx.kinds.get(head.step) ?? null;
    switch (kind) {
      case "if":
        return this.ifGroup(group, ctx, depth, parent);
      case "try":
      case "top_level_try":
        return this.tryGroup(group, ctx, depth, parent);
      case "for_each":
      case "do_until":
        return this.loop(head, ctx, depth, parent);
      case "parallel":
        return this.fanOut(head, ctx, depth, parent, "parallel");
      case "decision":
        return this.fanOut(head, ctx, depth, parent, "next");
      default:
        return this.plain(head, ctx, depth, parent, kind);
    }
  }

  private ifGroup(group: Group, ctx: FlowCtx, depth: number, parent: string | undefined): Seq {
    const head = group.head;
    const id = this.makeNode(head, ctx, depth, parent);
    const exits = this.body(id, depth, head.num, head.step, "true", ctx);
    let lastCondition = id;
    let hasElse = false;
    for (const branch of group.branches) {
      const branchId = this.makeNode(branch, ctx, depth, parent);
      this.edge(lastCondition, branchId, "false");
      if (ctx.kinds.get(branch.step) === "else_if") {
        exits.push(...this.body(branchId, depth, branch.num, branch.step, "true", ctx));
        lastCondition = branchId;
      } else {
        hasElse = true;
        exits.push(...this.body(branchId, depth, branch.num, branch.step, "next", ctx));
      }
    }
    if (!hasElse) exits.push({ from: lastCondition, kind: "false" });
    return { entry: id, exits };
  }

  private tryGroup(group: Group, ctx: FlowCtx, depth: number, parent: string | undefined): Seq {
    const head = group.head;
    const id = this.makeNode(head, ctx, depth, parent);
    const exits = this.body(id, depth, head.num, head.step, "next", ctx);
    for (const branch of group.branches) {
      const catchId = this.makeNode(branch, ctx, depth, parent);
      this.edge(id, catchId, "error");
      exits.push(...this.body(catchId, depth, branch.num, branch.step, "next", ctx));
    }
    return { entry: id, exits };
  }

  private loop(head: Entry, ctx: FlowCtx, depth: number, parent: string | undefined): Seq {
    const id = this.makeNode(head, ctx, depth, parent);
    const seq = this.childSequence(id, depth, head.num, this.kids(head.step, ctx), ctx);
    if (seq) {
      this.edge(id, seq.entry, "loop_body");
      for (const exit of seq.exits) this.edge(exit.from, id, "loop_back");
    }
    return { entry: id, exits: [{ from: id, kind: "next" }] };
  }

  /** Parallel and Decision: every child starts its own branch; all branches join after. */
  private fanOut(
    head: Entry,
    ctx: FlowCtx,
    depth: number,
    parent: string | undefined,
    edgeKind: FlowEdgeKind
  ): Seq {
    const id = this.makeNode(head, ctx, depth, parent);
    const children = this.kids(head.step, ctx);
    if (children.length === 0) return { entry: id, exits: [{ from: id, kind: "next" }] };
    if (depth + 1 > L.MAX_NESTING) {
      this.limits.add("max_nesting");
      return { entry: id, exits: [{ from: id, kind: "next" }] };
    }
    const exits: Exit[] = [];
    const groups = this.arrange(children, ctx, head.num);
    for (const group of groups) {
      for (const entry of [group.head, ...group.branches]) {
        const branchKind = ctx.kinds.get(entry.step) ?? null;
        const isBranch = branchKind === "parallel_branch" || branchKind === "decision_branch";
        if (isBranch) {
          const branchId = this.makeNode(entry, ctx, depth + 1, id);
          this.edge(id, branchId, edgeKind);
          exits.push(...this.body(branchId, depth + 1, entry.num, entry.step, "next", ctx));
        } else {
          const single = this.group({ head: entry, branches: [] }, ctx, depth + 1, id);
          this.edge(id, single.entry, edgeKind);
          exits.push(...single.exits);
        }
      }
    }
    return { entry: id, exits };
  }

  /** Leaf steps and unknown containers (sequential). */
  private plain(
    head: Entry,
    ctx: FlowCtx,
    depth: number,
    parent: string | undefined,
    kind: FlowLogicKind | null
  ): Seq {
    const step = head.step;
    const id = this.makeNode(head, ctx, depth, parent);
    if (step.kind === "subflow") this.subflowCall(id, step, ctx);
    const terminal = kind !== null && TERMINAL_KINDS.has(kind);
    const inner = this.body(id, depth, head.num, step, "next", ctx);
    return { entry: id, exits: terminal ? [] : inner };
  }

  // -- subflows ------------------------------------------------------------

  private subflowCall(id: string, step: NormalizedStep, ctx: FlowCtx): void {
    const node = this.nodes[this.nodes.length - 1]!;
    const raw = step.subflow?.flow_sys_id;
    const target = typeof raw === "string" && SYS_ID.test(raw) ? raw : null;
    const info: NonNullable<FlowNode["subflow"]> = {
      flow_sys_id: target,
      name: cleanText(step.subflow?.name, L.MAX_TITLE_CHARS),
    };
    node.subflow = info;

    if (target === null) {
      info.not_expanded = "not_found";
      this.warnings.add("subflow_not_found");
      return;
    }
    if (ctx.path.includes(target)) {
      info.not_expanded = "cycle";
      this.warnings.add("subflow_cycle");
      return;
    }
    const existing = this.expanded.get(target);
    if (existing !== undefined) {
      info.expanded_index = existing;
      return;
    }
    if (ctx.level >= this.input.options.depth) {
      info.not_expanded = "depth";
      this.limits.add("max_depth");
      return;
    }
    const loaded = this.input.subflows?.get(target);
    if (loaded !== undefined && "unavailable" in loaded) {
      info.not_expanded = loaded.unavailable;
      this.warnings.add(
        loaded.unavailable === "denied"
          ? "subflow_denied"
          : loaded.unavailable === "too_large"
            ? "subflow_too_large"
            : loaded.unavailable === "timeout"
              ? "subflow_timeout"
              : "subflow_not_found"
      );
      return;
    }
    if (loaded === undefined) {
      info.not_expanded = "limit";
      return;
    }
    if (this.headers.length - 1 >= L.MAX_SUBFLOW_EXPANSIONS) {
      info.not_expanded = "limit";
      this.limits.add("max_subflow_expansions");
      return;
    }
    const index = this.registerFlow(loaded, id);
    info.expanded_index = index;
    const prefix = node.step;
    this.queue.push({
      ctx: this.prepare(loaded, index, ctx.level + 1, [...ctx.path, target], prefix),
      def: loaded,
      callId: id,
    });
  }
}

// ---------------------------------------------------------------------------
// Inputs, pills, variables
// ---------------------------------------------------------------------------

class PillTable {
  readonly pills: FlowPill[] = [];
  private readonly index = new Map<string, number>();
  hitLimit = false;

  register(token: string, label: string | null): number | undefined {
    const key = `${token}\u0000${label ?? ""}`;
    const known = this.index.get(key);
    if (known !== undefined) return known;
    if (this.pills.length >= L.MAX_PILLS) {
      this.hitLimit = true;
      return undefined;
    }
    this.pills.push({ token, label });
    this.index.set(key, this.pills.length - 1);
    return this.pills.length - 1;
  }
}

function labelLookup(cache: NormalizedFlowDefinition["label_cache"]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const lower = new Map<string, string>();
  for (const pair of cache ?? []) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
    if (!map.has(pair[0])) map.set(pair[0], pair[1]);
    const key = pair[0].toLowerCase();
    if (!lower.has(key)) lower.set(key, pair[1]);
  }
  // Exact names win; the lowercased spelling is a fallback.
  const merged = new Map(lower);
  for (const [k, v] of map) merged.set(k, v);
  return merged;
}

interface InputContext {
  labels: ReadonlyMap<string, string>;
  pills: PillTable;
  limits: Set<FlowLimitHit>;
}

function projectInputs(inputs: readonly FlowInputValue[] | undefined, ic: InputContext): FlowInputValue[] | undefined {
  if (!Array.isArray(inputs) || inputs.length === 0) return undefined;
  if (inputs.length > L.MAX_INPUTS_PER_NODE) ic.limits.add("inputs_per_node");
  const out: FlowInputValue[] = [];
  for (const raw of inputs.slice(0, L.MAX_INPUTS_PER_NODE)) {
    if (!raw || typeof raw !== "object") continue;
    const input: FlowInputValue = {
      name: cutUnits(typeof raw.name === "string" ? raw.name : "", L.MAX_NAME_CHARS),
      label: shortString(raw.label, L.MAX_TITLE_CHARS),
      type: shortString(raw.type, L.MAX_NAME_CHARS),
      value: null,
    };
    if (typeof raw.value === "string") {
      if (raw.value.length > L.MAX_INPUT_VALUE_CHARS) {
        input.value = cutUnits(raw.value, L.MAX_INPUT_VALUE_CHARS);
        const original = typeof raw.original_length === "number" ? raw.original_length : 0;
        input.original_length = Math.max(original, raw.value.length);
        ic.limits.add("input_value_chars");
      } else {
        input.value = raw.value;
        if (typeof raw.original_length === "number" && Number.isInteger(raw.original_length) &&
          raw.original_length >= 0) {
          input.original_length = raw.original_length;
        }
      }
    } else if (typeof raw.original_length === "number" && Number.isInteger(raw.original_length) &&
      raw.original_length >= 0) {
      input.original_length = raw.original_length;
    }
    if (typeof raw.redacted === "string" && REDACTION_SET.has(raw.redacted)) {
      input.redacted = raw.redacted;
    }
    if (raw.script === true) input.script = true;
    if (input.value !== null && input.redacted === undefined && input.script !== true) {
      const indices = extractPills(input.value, ic);
      if (indices.length > 0) input.pills = indices;
    }
    out.push(input);
  }
  return out.length > 0 ? out : undefined;
}

function extractPills(value: string, ic: InputContext): number[] {
  const indices: number[] = [];
  for (const match of value.matchAll(PILL)) {
    const token = match[0];
    const inner = match[1]!.trim();
    if (inner === "" || token.length > B.MAX_PILL_TOKEN_CHARS) continue;
    const found = ic.labels.get(inner) ?? ic.labels.get(inner.toLowerCase());
    const label = found === undefined ? null : cutUnits(found, L.MAX_PILL_LABEL_CHARS);
    const index = ic.pills.register(token, label);
    if (index !== undefined && !indices.includes(index)) indices.push(index);
  }
  if (ic.pills.hitLimit) ic.limits.add("pills");
  return indices;
}

// ---------------------------------------------------------------------------
// Truncation and the byte-fitting ladder
// ---------------------------------------------------------------------------

function sortedLimits(limits: Iterable<FlowLimitHit>): FlowLimitHit[] {
  const set = new Set(limits);
  return FLOW_LIMIT_HITS.filter((hit) => set.has(hit));
}

function sortedWarnings(warnings: Iterable<FlowWarningCode>): FlowWarningCode[] {
  const set = new Set(warnings);
  return FLOW_WARNING_CODES.filter((code) => set.has(code)).slice(0, L.MAX_WARNINGS);
}

function allInputs(graph: FlowGraph): FlowInputValue[] {
  const out: FlowInputValue[] = [...(graph.trigger?.inputs ?? [])];
  for (const node of graph.nodes) out.push(...(node.inputs ?? []));
  return out;
}

function recount(graph: FlowGraph): void {
  const inputs = allInputs(graph);
  graph.counts.nodes_returned = graph.nodes.filter((node) => node.kind !== "more").length;
  graph.counts.inputs_redacted = inputs.filter((i) => i.redacted !== undefined && i.redacted !== "limit").length;
  graph.counts.inputs_truncated = inputs.filter(
    (i) => i.redacted === "limit" || (i.original_length !== undefined && i.redacted === undefined)
  ).length;
}

/**
 * Keep the first `keep` step nodes (pre-order prefix, so parents survive),
 * drop the rest and stand a single `more` node in for them. Edges into dropped
 * nodes are redirected to `more`; edges out of dropped nodes disappear.
 */
function truncateSteps(graph: FlowGraph, keep: number): void {
  const steps = graph.nodes.filter((node) => node.kind !== "more");
  const oldMore = graph.nodes.find((node) => node.kind === "more");
  if (keep >= steps.length && !oldMore) return;
  const kept = steps.slice(0, keep);
  const keptIds = new Set(kept.map((node) => node.id));
  const removed = steps.length - kept.length;
  const omitted = (oldMore?.omitted_steps ?? 0) + removed;
  const moreId = `n${kept.length + 1}`;
  const live = (id: string): boolean => id === "n0" || keptIds.has(id);

  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: FlowEdge): void => {
    const key = `${edge.from}>${edge.to}:${edge.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  let pointsAtMore = false;
  for (const edge of graph.edges) {
    if (!live(edge.from)) continue;
    if (live(edge.to)) push(edge);
    else {
      pointsAtMore = true;
      push({ from: edge.from, to: moreId, kind: edge.kind });
    }
  }
  if (!pointsAtMore) {
    const tail = kept.length > 0 ? kept[kept.length - 1]!.id : graph.trigger ? "n0" : undefined;
    if (tail !== undefined) push({ from: tail, to: moreId, kind: "next" });
  }

  const more: FlowNode = {
    id: moreId,
    flow_index: 0,
    kind: "more",
    step: "",
    depth: 0,
    order: null,
    title: { text: null },
    annotation: { text: null },
    omitted_steps: omitted,
  };
  graph.nodes = [...kept, more];
  graph.edges = edges;
  for (const flow of graph.flows) {
    if (flow.called_from !== undefined && !keptIds.has(flow.called_from)) delete flow.called_from;
  }
  graph.limits_hit = sortedLimits([...graph.limits_hit, "max_nodes"]);
  recount(graph);
}

function cutValues(graph: FlowGraph, max: number): void {
  for (const input of allInputs(graph)) {
    if (input.value !== null && input.value.length > max) {
      input.original_length = Math.max(input.original_length ?? 0, input.value.length);
      input.value = cutUnits(input.value, max);
    }
  }
}

function dropInputValues(graph: FlowGraph): void {
  for (const input of allInputs(graph)) {
    if (input.redacted === undefined) input.redacted = "limit";
    input.value = null;
    delete input.pills;
    delete input.script;
  }
}

function dropPillsAndVariables(graph: FlowGraph): void {
  for (const input of allInputs(graph)) delete input.pills;
  graph.pills = [];
  graph.variables = [];
}

/** Cut a long FlowText in place, recording its original length. */
function cutText(text: FlowText | undefined, max: number): void {
  if (!text || text.text === null || text.text.length <= max) return;
  text.original_length = Math.max(text.original_length ?? 0, text.text.length);
  text.text = cutUnits(text.text, max);
}

function cutLongTexts(graph: FlowGraph): void {
  for (const flow of graph.flows) cutText(flow.description, FLOW_GRAPH_LADDER_TEXT_CHARS);
  if (graph.trigger) cutText(graph.trigger.condition, FLOW_GRAPH_LADDER_TEXT_CHARS);
  for (const node of graph.nodes) {
    cutText(node.annotation, FLOW_GRAPH_LADDER_TEXT_CHARS);
    cutText(node.condition, FLOW_GRAPH_LADDER_TEXT_CHARS);
  }
}

/**
 * A cheap lower bound on the serialized size: every UTF-16 unit of an input
 * value is at least one UTF-8 byte. When it alone passes the target, the
 * graph cannot fit and is not serialized to find out.
 */
function inputValueUnits(graph: FlowGraph): number {
  let units = 0;
  for (const input of allInputs(graph)) units += input.value?.length ?? 0;
  return units;
}

function stepCount(graph: FlowGraph): number {
  return graph.nodes.filter((node) => node.kind !== "more").length;
}

/**
 * Reduce `graph` in place until `Buffer.byteLength(JSON.stringify(graph))` is
 * at most `targetBytes`, applying the ladder of the design (section 2.3) in
 * order and stopping at the first step that fits:
 *
 * 1. input values cut to 500 characters;
 * 2. input values cut to 120 characters;
 * 3. input values dropped (names kept, `redacted: "limit"`);
 * 4. flow descriptions, step annotations and conditions cut to 200 units
 *    (`original_length` set);
 * 5. step nodes halved, with a single `more` node;
 * 6. pills and variables dropped;
 * 7. (fallback) step nodes halved again until the graph fits or none remain.
 *
 * A measurement whose outcome is already known (the input values alone are
 * larger than the target) is skipped, so a graph of very large values is not
 * serialized whole; the result is the same.
 *
 * `response_bytes` is added to `limits_hit` whenever any step runs.
 * Returns the step that made it fit (0 = already fit); when even the empty
 * skeleton is larger than the target the last step is returned.
 */
export function fitFlowGraphToBudget(graph: FlowGraph, targetBytes: number): number {
  const fits = (): boolean => inputValueUnits(graph) <= targetBytes && byteLength(graph) <= targetBytes;
  if (fits()) return FLOW_GRAPH_BUDGET_STEPS.FITS;
  graph.limits_hit = sortedLimits([...graph.limits_hit, "response_bytes"]);
  const halve = (): void => {
    const steps = stepCount(graph);
    truncateSteps(graph, Math.floor(steps / 2));
  };
  const ladder: Array<() => void> = [
    () => cutValues(graph, 500),
    () => cutValues(graph, 120),
    () => dropInputValues(graph),
    () => cutLongTexts(graph),
    halve,
    () => dropPillsAndVariables(graph),
  ];
  for (let i = 0; i < ladder.length; i += 1) {
    ladder[i]!();
    recount(graph);
    if (fits()) return i + 1;
  }
  while (stepCount(graph) > 0) {
    halve();
    if (fits()) break;
  }
  return FLOW_GRAPH_BUDGET_STEPS.NODES_HALVED_REPEATEDLY;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the `FlowGraph` for one root flow and the subflows already loaded for
 * it. Deterministic: the same input always gives the same graph, byte for byte.
 */
export function buildFlowGraph(input: FlowGraphBuildInput): FlowGraph {
  const { options } = input;
  const builder = new GraphBuilder(input);
  builder.build();
  for (const hit of input.limits_hit ?? []) builder.limits.add(hit);
  for (const code of input.warnings ?? []) builder.warnings.add(code);

  const trigger = buildTrigger(input.root);
  const nodes = builder.nodes;

  // Inputs and pills run over every node so pill indices follow walk order;
  // truncation below only removes a suffix.
  const pills = new PillTable();
  const labelMaps = builder.flowDefs.map((def) => labelLookup(def.label_cache));
  if (trigger && options.include_inputs) {
    const ic: InputContext = { labels: labelMaps[0]!, pills, limits: builder.limits };
    const projected = projectInputs(input.root.trigger?.inputs, ic);
    if (projected) trigger.inputs = projected;
  }

  const capacity = Math.max(0, options.max_nodes - (trigger ? 1 : 0));
  const keepCount = Math.min(nodes.length, capacity);
  if (options.include_inputs) {
    for (let i = 0; i < keepCount; i += 1) {
      const node = nodes[i]!;
      const ic: InputContext = { labels: labelMaps[node.flow_index]!, pills, limits: builder.limits };
      const projected = projectInputs(builder.sources[i]!.inputs, ic);
      if (projected) node.inputs = projected;
    }
  }

  const variables: FlowVariableDef[] = [];
  builder.flowDefs.forEach((def, flowIndex) => {
    for (const v of def.variables ?? []) {
      if (variables.length >= B.MAX_VARIABLES) break;
      if (!v || (v.scope !== "input" && v.scope !== "output" && v.scope !== "variable")) continue;
      variables.push({
        scope: v.scope,
        flow_index: flowIndex,
        name: cutUnits(typeof v.name === "string" ? v.name : "", L.MAX_NAME_CHARS),
        label: shortString(v.label, L.MAX_TITLE_CHARS),
        type: shortString(v.type, L.MAX_NAME_CHARS),
      });
    }
  });

  const edges = [...builder.edges];
  if (trigger && builder.rootEntry !== undefined) {
    edges.unshift({ from: "n0", to: builder.rootEntry, kind: "next" });
  }

  const graph: FlowGraph = {
    schema_version: 1,
    source: "table",
    flows: builder.headers,
    trigger,
    nodes,
    edges,
    pills: pills.pills,
    variables,
    options: {
      depth: options.depth,
      include_inputs: options.include_inputs,
      max_nodes: options.max_nodes,
      format: options.format,
    },
    limits_hit: [],
    warnings: [],
    counts: {
      steps_seen: builder.stepsSeen,
      nodes_returned: 0,
      inputs_redacted: 0,
      inputs_truncated: 0,
      items_dropped: builder.itemsDropped,
    },
  };

  if (nodes.length > capacity) {
    builder.limits.add("max_nodes");
    graph.limits_hit = sortedLimits(builder.limits);
    truncateSteps(graph, capacity);
  }
  if (graph.edges.length > L.MAX_EDGES) {
    graph.edges = graph.edges.slice(0, L.MAX_EDGES);
    builder.limits.add("edges");
  }
  graph.limits_hit = sortedLimits([...builder.limits, ...graph.limits_hit]);
  graph.warnings = sortedWarnings(builder.warnings);
  // Flow headers keep a call site only while that node survives.
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const flow of graph.flows) {
    if (flow.called_from !== undefined && !ids.has(flow.called_from)) delete flow.called_from;
  }
  recount(graph);

  fitFlowGraphToBudget(graph, Math.floor(options.max_response_bytes * L.STRUCTURED_SHARE));
  return graph;
}

function buildTrigger(root: NormalizedFlowDefinition): FlowTrigger | null {
  const t = root.trigger;
  if (!t) return null;
  return {
    node_id: "n0",
    type: cleanText(t.type, L.MAX_TITLE_CHARS),
    table: cleanText(t.table, L.MAX_TITLE_CHARS),
    condition: cleanText(t.condition, B.MAX_TEXT_CHARS),
    schedule: cleanText(t.schedule, L.MAX_TITLE_CHARS),
  };
}
