import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  FlowLogicKind,
  FlowText,
  NormalizedFlowDefinition,
  NormalizedStep,
} from "../src/tools/flow-view-contracts.js";
import { buildFlowGraph, type FlowGraphBuildInput } from "../src/tools/flow-view-graph.js";

const text = (value: string | null): FlowText => ({ text: value });
const sid = (n: number): string => n.toString(16).padStart(32, "0");

type Raw = Partial<NormalizedStep> & { uid: string; logic_kind?: FlowLogicKind; title?: FlowText | string };

function step(raw: Raw): NormalizedStep {
  const { title, ...rest } = raw;
  return {
    parent_uid: null,
    order: null,
    connected_uid: null,
    kind: raw.logic_kind === undefined ? (raw.kind ?? "action") : "logic",
    annotation: text(null),
    inputs: [],
    ...rest,
    title: typeof title === "string" ? text(title) : (title ?? text(raw.uid)),
  };
}

function definition(id: string, steps: readonly Raw[]): NormalizedFlowDefinition {
  return {
    source: "table",
    header: {
      sys_id: id,
      name: text(`Synthetic ${id.slice(-4)}`),
      description: text(null),
      type: "flow",
      active: true,
      status: "published",
      version: "1",
      scope: "global",
    },
    trigger: null,
    steps: steps.map(step),
    label_cache: [],
    variables: [],
    warnings: [],
    limits_hit: [],
    items_dropped: 0,
  };
}

/** Flat top-level steps: If / Else If / Else runs, Try / Catch pairs, orphan branches, ties and null orders. */
function flat(id: string, count: number, prefix: string): NormalizedFlowDefinition {
  const steps: Raw[] = [];
  for (let i = 0; steps.length < count; i += 1) {
    const base = `${prefix}${i}`;
    const order = i % 7 === 0 ? null : i % 5;
    switch (i % 6) {
      case 0:
        steps.push(
          { uid: `${base}i`, order, logic_kind: "if", title: "If", condition: text("c") },
          { uid: `${base}e1`, order, logic_kind: "else_if", connected_uid: `${base}i`, title: "Else If" },
          { uid: `${base}e2`, order, logic_kind: "else", connected_uid: `${base}i`, title: "Else" },
          { uid: `${base}e3`, order: (order ?? 0) + 1, logic_kind: "else_if", connected_uid: `${base}i`, title: "Else If 2" }
        );
        break;
      case 1:
        steps.push(
          { uid: `${base}t`, order, logic_kind: "try", title: "Try" },
          { uid: `${base}c`, order, logic_kind: "catch", connected_uid: `${base}t`, title: "Catch" }
        );
        break;
      case 2:
        // Branch rows without connected_to attach to the nearest preceding head.
        steps.push({ uid: `${base}x`, order, logic_kind: "else", title: "Else" });
        break;
      case 3:
        steps.push({ uid: `${base}l`, order, logic_kind: "for_each", title: "For Each" }, {
          uid: `${base}lc`,
          parent_uid: `${base}l`,
          order: 1,
          title: "Body",
        });
        break;
      default:
        steps.push({ uid: `${base}a`, order, title: "Action" });
    }
  }
  return definition(id, steps.slice(0, count));
}

const OPTIONS: FlowGraphBuildInput["options"] = {
  depth: 3,
  include_inputs: true,
  max_nodes: 300,
  format: "both",
  max_response_bytes: 1_000_000,
};

function fixture(name: string): NormalizedFlowDefinition {
  const raw = JSON.parse(
    readFileSync(new URL(`./fixtures/flow-view/normalized/${name}.json`, import.meta.url), "utf8")
  ) as { header: { sys_id: string }; steps: Array<Raw & { title?: string; condition?: string }> };
  return definition(
    raw.header.sys_id,
    raw.steps.map((s) => ({ ...s, condition: s.condition === undefined ? undefined : text(s.condition as unknown as string) }) as Raw)
  );
}

function withCalls(root: NormalizedFlowDefinition, targets: readonly string[]): NormalizedFlowDefinition {
  return {
    ...root,
    steps: [
      ...root.steps,
      ...targets.map((target, index) =>
        step({
          uid: `call${index}`,
          order: 1_000 + index,
          kind: "subflow",
          title: "Call",
          subflow: { flow_sys_id: target, name: text("Call") },
        })
      ),
    ],
  };
}

/**
 * SHA-256 of each case's graph as built by the quadratic grouping this
 * replaced (feat/flow-view 29be4e7), so the linear grouping is pinned to the
 * same output byte for byte.
 */
const BEFORE: Readonly<Record<string, string>> = {
  "nested-if fixture": "499a7f093cbb840e197248d2d7e97bf85bec6d5063a03cf4ad73c1d015d6204c",
  "top-level-try fixture": "98790ad090704c8e2f666aafd663b3c485eab85971a7737726fe9982e2a00677",
  "parallel fixture": "5009885118379a1b63e9812fe02a63af25b5ff14cb687e67b5f716addeab6d1a",
  "flat 600": "d9d010bcf56743cf503cf7317fc1b1c362b22bddec294af00af7e5a78ad1ae7c",
  "flat 600, max_nodes 50": "bf64bddbbdd43945cebb49e678a25fbaf67a261d91bfb84f0ef9828cfd2a4358",
  "flat with subflows": "be2186e7642cc73f1b6f031a9043edc970587f111b24aaa924f0787094e9e95e",
};

const CASES: ReadonlyArray<[string, () => FlowGraphBuildInput]> = [
  ["nested-if fixture", () => ({ root: fixture("nested-if"), options: OPTIONS })],
  ["top-level-try fixture", () => ({ root: fixture("top-level-try"), options: OPTIONS })],
  ["parallel fixture", () => ({ root: fixture("parallel"), options: OPTIONS })],
  ["flat 600", () => ({ root: flat(sid(1), 600, "r"), options: OPTIONS })],
  ["flat 600, max_nodes 50", () => ({ root: flat(sid(1), 600, "r"), options: { ...OPTIONS, max_nodes: 50 } })],
  [
    "flat with subflows",
    () => {
      const children = [sid(2), sid(3)];
      return {
        root: withCalls(flat(sid(1), 200, "r"), children),
        subflows: new Map(children.map((child, index) => [child, flat(child, 150 + index, `s${index}`)])),
        options: OPTIONS,
      };
    },
  ],
];

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("graph builder sibling grouping", () => {
  it.each(CASES)("builds the same graph as before the linear grouping: %s", (name, input) => {
    expect(digest(buildFlowGraph(input()))).toBe(BEFORE[name]);
  });
});

describe("graph builder scaling", () => {
  it("builds nine 3,000-step flat flows (the loader's row maximum) well under a second", () => {
    const children = Array.from({ length: 8 }, (_, index) => sid(0x100 + index));
    const input: FlowGraphBuildInput = {
      root: withCalls(flat(sid(0xff), 3_000, "r"), children),
      subflows: new Map(children.map((child, index) => [child, flat(child, 3_000, `s${index}`)])),
      options: OPTIONS,
    };
    buildFlowGraph(input); // warm up
    const started = performance.now();
    const graph = buildFlowGraph(input);
    const elapsed = performance.now() - started;
    expect(graph.counts.steps_seen).toBe(9 * 3_000 + 8);
    // The quadratic grouping took 1.4-2.6 s on this shape.
    expect(elapsed).toBeLessThan(1_000);
  });
});
