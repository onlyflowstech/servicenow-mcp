import { describe, expect, it } from "vitest";

import type {
  FlowEdge,
  FlowGraph,
  FlowNode,
  FlowText,
} from "../src/tools/flow-view-contracts.js";
import {
  MERMAID_MAX_LABEL_CHARS,
  buildFlowMermaid,
  encodeMermaidLabel,
} from "../src/tools/flow-view-mermaid.js";
import {
  MAX_MERMAID_EDGES,
  MAX_MERMAID_NODES,
  MAX_MERMAID_SOURCE_LENGTH,
  MERMAID_LABEL_PATTERN,
  isMermaidDiagram,
  isValidMermaidSource,
} from "../src/tools/markdown.js";

// The invariant from the design, written out independently of the module.
const LABEL_INVARIANT = /^(?:[A-Za-z0-9 ,.:_()/+=?-]|#[0-9]{1,7};)*$/u;
// Entity codes for characters that step 5 must have substituted first.
const FORBIDDEN_ENTITIES = /#(?:60|62|38|34|96);/u;
// The closed line grammar, also written out independently.
const L = String.raw`"(?:[A-Za-z0-9 ,.:_()/+=?-]|#[0-9]{1,7};)*"`;
const ID = String.raw`n(?:[1-9][0-9]{0,3}|More)`;
const LINE_GRAMMAR: readonly RegExp[] = [
  /^flowchart TD$/u,
  new RegExp(
    String.raw`^(?: {4})?${ID}(?:\(\[${L}\]\)|\[${L}\]|\{${L}\}|\{\{${L}\}\}|\[\[${L}\]\]|\(\(${L}\)\))$`,
    "u"
  ),
  new RegExp(
    String.raw`^${ID} (?:-->|-\.->)(?:\|(?:true|false|each|repeat|branch|catch|calls)\|)? ${ID}$`,
    "u"
  ),
  new RegExp(String.raw`^subgraph sg[1-9][0-9]{0,3} \[${L}\]$`, "u"),
  /^end$/u,
];

function ft(text: string | null, redacted?: FlowText["redacted"]): FlowText {
  return redacted === undefined ? { text } : { text, redacted };
}

function node(id: string, overrides: Partial<FlowNode> = {}): FlowNode {
  return {
    id,
    flow_index: 0,
    kind: "action",
    step: "1",
    depth: 0,
    order: 100,
    title: ft(`Step ${id}`),
    annotation: ft(null),
    ...overrides,
  };
}

function graph(nodes: FlowNode[], edges: FlowEdge[] = [], overrides: Partial<FlowGraph> = {}): FlowGraph {
  return {
    schema_version: 1,
    source: "processflow",
    source_detail: { requested: "auto" },
    flows: [
      {
        index: 0,
        source: "processflow",
        sys_id: "0123456789abcdef0123456789abcdef",
        name: ft("Root flow"),
        description: ft(null),
        type: "flow",
        active: true,
        status: "published",
        version: "3",
        scope: "global",
      },
    ],
    trigger: null,
    nodes,
    edges,
    pills: [],
    variables: [],
    options: { depth: 1, include_inputs: true, max_nodes: 150, format: "both" },
    limits_hit: [],
    warnings: [],
    counts: {
      steps_seen: nodes.length,
      nodes_returned: nodes.length,
      inputs_redacted: 0,
      inputs_truncated: 0,
      items_dropped: 0,
    },
    ...overrides,
  };
}

function chain(count: number, title: (index: number) => string = (index) => `Step ${index}`): FlowGraph {
  const nodes = Array.from({ length: count }, (_, index) =>
    node(`n${index + 1}`, { title: ft(title(index + 1)), step: String(index + 1) })
  );
  const edges = nodes.slice(1).map((entry, index) => ({
    from: nodes[index]!.id,
    to: entry.id,
    kind: "next" as const,
  }));
  return graph(nodes, edges);
}

function expectInvariant(label: string): void {
  expect(label).toMatch(LABEL_INVARIANT);
  expect(label).toMatch(MERMAID_LABEL_PATTERN);
  expect(label).not.toMatch(FORBIDDEN_ENTITIES);
}

function expectClosedGrammar(source: string): void {
  const lines = source.split("\n");
  expect(lines[0]).toBe("flowchart TD");
  for (const line of lines) {
    expect(LINE_GRAMMAR.some((pattern) => pattern.test(line)), line).toBe(true);
  }
  expect(isValidMermaidSource(source)).toBe(true);
  // The skeleton, with every quoted label removed, carries no directive,
  // comment, style, click, or shape syntax.
  const skeleton = source.replace(/"[^"]*"/gu, '""');
  expect(skeleton).not.toMatch(/\bcall(?:back)?\b/u);
  for (const forbidden of [
    "%%",
    "---",
    "click",
    "href",
    "style",
    "classDef",
    "class ",
    "linkStyle",
    ":::",
    "@{",
    "accTitle",
    "accDescr",
    "`",
    "<",
    "&",
  ]) {
    expect(skeleton).not.toContain(forbidden);
  }
}

const ADVERSARIAL_LABELS: readonly string[] = [
  '"]',
  '"] --> n2["pwned',
  "-->",
  "n1 --> n2",
  "%%{init: {'theme':'dark','securityLevel':'loose'}}%%",
  "%% comment",
  'click n1 href "javascript:alert(1)"',
  'click n1 call alert("x")',
  "A:::cls",
  ":::cls",
  "n1@{ shape: rect, label: \"x\" }",
  "@{",
  "`backtick` and ``double``",
  "```mermaid\nflowchart TD\n```",
  "````",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "&lt;script&gt;",
  "&#60;b&#62;",
  "#35;",
  "#60;script#62;",
  "line one\nline two\r\nline three\rfour",
  "a\u2028b\u2029c\u0085d",
  "tab\there",
  "bidi\u202Eevil\u202C\u2066x\u2069\u200E\u200F\u061C",
  "zero\u200Bwidth\u200C\u200D\u2060\u2061\u2064\uFEFF\u00ADsoft",
  "tag\u{E0041}\u{E007F}chars",
  "\uFF1Cscript\uFF1E full-width",
  "\uFF02\uFF3D\uFF5B\uFF5C",
  "end",
  "subgraph",
  "subgraph sg1 [x]",
  "flowchart TD",
  "style n1 fill:#f00",
  "classDef evil fill:#f00",
  "linkStyle 0 stroke:red",
  "accTitle: x",
  "---\ntitle: x\n---",
  "[x](javascript:alert(1))",
  "{{double}} [[sub]] ((circle))",
  "|pipe| ; # % * ~ \\ ' ! @ $ ^",
  "\u0000\u0001\u001B[31m\u007F\u009B",
  "\uD800 lone \uDC00 surrogates",
  "\u{1F600} emoji \u{10FFFF}",
  "x".repeat(10_000),
  '"'.repeat(10_000),
  "<".repeat(10_000),
  "\u200B".repeat(10_000) + "visible",
];

describe("encodeMermaidLabel", () => {
  it("keeps every adversarial label inside the label invariant", () => {
    for (const raw of ADVERSARIAL_LABELS) {
      const encoded = encodeMermaidLabel(raw);
      expectInvariant(encoded);
      // Outside entity codes, no quote, bracket, pipe, percent, hash or
      // semicolon survives.
      expect(encoded.replace(/#[0-9]{1,7};/gu, "")).not.toMatch(/["`<>&[\]{}|%;@#]/u);
    }
  });

  it("encodes quote, bracket and arrow breakouts", () => {
    expect(encodeMermaidLabel('"]')).toBe("#8221;#93;");
    expect(encodeMermaidLabel("-->")).toBe("--#8250;");
    expect(encodeMermaidLabel("@{")).toBe("#64;#123;");
    expect(encodeMermaidLabel(":::cls")).toBe(":::cls");
    expect(encodeMermaidLabel("%%{init: x}%%")).toBe("#37;#37;#123;init: x#125;#37;#37;");
  });

  it("substitutes characters that could turn live after entity decoding", () => {
    expect(encodeMermaidLabel("<script>")).toBe("#8249;script#8250;");
    expect(encodeMermaidLabel("&lt;")).toBe("#65286;lt#59;");
    expect(encodeMermaidLabel('"x"')).toBe("#8221;x#8221;");
    expect(encodeMermaidLabel("`x`")).toBe("#715;x#715;");
    expect(encodeMermaidLabel("```")).toBe("#715;#715;#715;");
  });

  it("encodes entity look-alikes so they cannot decode to their target", () => {
    expect(encodeMermaidLabel("#35;")).toBe("#35;35#59;");
    expect(encodeMermaidLabel("#60;")).toBe("#35;60#59;");
  });

  it("applies NFKC before substituting, so full-width forms are caught", () => {
    expect(encodeMermaidLabel("\uFF1Cb\uFF1E")).toBe("#8249;b#8250;");
    expect(encodeMermaidLabel("\uFF02")).toBe("#8221;");
  });

  it("turns line breaks and tabs into single spaces", () => {
    expect(encodeMermaidLabel("a\nb\r\nc\rd\te")).toBe("a b c d e");
    expect(encodeMermaidLabel("a\u2028b\u2029c\u0085d")).toBe("a b c d");
    expect(encodeMermaidLabel("  lots   of\n\n space  ")).toBe("lots of space");
  });

  it("strips controls, bidi controls, invisibles and tag characters", () => {
    expect(encodeMermaidLabel("a\u0000b\u001Bc\u007Fd\u009Be")).toBe("abcde");
    expect(encodeMermaidLabel("a\u202Eb\u2066c\u2069d\u200Ee\u200Ff\u061Cg")).toBe("abcdefg");
    expect(encodeMermaidLabel("a\u200Bb\u200Cc\u200Dd\u2060e\u2064f\uFEFFg\u00ADh")).toBe("abcdefgh");
    expect(encodeMermaidLabel("a\u{E0041}b\u{E007F}c")).toBe("abc");
    expect(encodeMermaidLabel("a\uD800b\uDC00c")).toBe("abc");
  });

  it("truncates by code point and marks the cut", () => {
    expect(encodeMermaidLabel("x".repeat(10_000))).toBe(`${"x".repeat(80)}#8230;`);
    expect(encodeMermaidLabel("\u{1F600}".repeat(100))).toBe(`${"#128512;".repeat(80)}#8230;`);
    expect(encodeMermaidLabel('"'.repeat(10_000))).toBe(`${"#8221;".repeat(80)}#8230;`);
    expect(encodeMermaidLabel("abcdef", 3)).toBe("abc#8230;");
    expect(encodeMermaidLabel("x".repeat(80))).toBe("x".repeat(80));
    expect(MERMAID_MAX_LABEL_CHARS).toBe(80);
    // A cut in the examined prefix is marked even if what remains is short.
    expect(encodeMermaidLabel(`${"\u200B".repeat(10_000)}visible`)).toBe("#8230;");
  });

  it("names empty labels and ignores non-text values", () => {
    for (const raw of ["", "   ", "\u200B\u200D", "\n\t", null, undefined, {}, [], Symbol("x")]) {
      expect(encodeMermaidLabel(raw)).toBe("(unnamed)");
    }
    expect(encodeMermaidLabel(42)).toBe("42");
    expect(encodeMermaidLabel(true)).toBe("true");
  });

  it("keeps Mermaid keywords as inert text", () => {
    expect(encodeMermaidLabel("end")).toBe("end");
    expect(encodeMermaidLabel("subgraph")).toBe("subgraph");
  });

  it("holds the invariant over a seeded random corpus", () => {
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pool = [
      ..."\"'`<>&[]{}()|%#;:@!$^*~\\/-=+?.,_ \n\r\t",
      "\u2028",
      "\u202E",
      "\u200B",
      "\uFEFF",
      "\uFF1C",
      "\uFF02",
      "\uD800",
      "\u{1F600}",
      "-->",
      "%%",
      ":::",
      "click",
    ];
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      let raw = "";
      const length = Math.floor(random() * 120);
      for (let index = 0; index < length; index += 1) {
        raw +=
          random() < 0.8
            ? pool[Math.floor(random() * pool.length)]!
            : String.fromCodePoint(Math.floor(random() * 0x10ffff) & ~0x800);
      }
      expectInvariant(encodeMermaidLabel(raw));
    }
  });
});

describe("buildFlowMermaid", () => {
  it("draws every adversarial title inside the closed grammar", () => {
    const nodes = ADVERSARIAL_LABELS.map((label, index) =>
      node(`n${index + 1}`, { title: ft(label), step: String(index + 1) })
    );
    const edges = nodes.slice(1).map((entry, index) => ({
      from: nodes[index]!.id,
      to: entry.id,
      kind: "next" as const,
    }));
    const built = buildFlowMermaid(graph(nodes, edges));
    expect(built).toBeDefined();
    expectClosedGrammar(built!.diagram.source);
    expect(isMermaidDiagram(built!.diagram)).toBe(true);
    expect(Object.isFrozen(built!.diagram)).toBe(true);
    expect(built!.nodes).toBe(nodes.length);
    expect(built!.edges).toBe(edges.length);
    const id = (label: string): string => `n${ADVERSARIAL_LABELS.indexOf(label) + 1}`;
    expect(built!.diagram.source).toContain(`${id("end")}["end"]`);
    expect(built!.diagram.source).toContain(`${id("subgraph")}["subgraph"]`);
  });

  it("allocates its own ids and never reuses node id text", () => {
    const nodes = [
      node('n1"]; click n1 href "javascript:alert(1)', { title: ft("first") }),
      node("x --> y", { title: ft("second") }),
      node("n9999", { title: ft("third") }),
    ];
    const edges: FlowEdge[] = [
      { from: nodes[0]!.id, to: nodes[1]!.id, kind: "true" },
      { from: nodes[1]!.id, to: nodes[2]!.id, kind: "false" },
      { from: "missing", to: nodes[2]!.id, kind: "next" },
    ];
    const source = buildFlowMermaid(graph(nodes, edges))!.diagram.source;
    expectClosedGrammar(source);
    expect(source).toBe(
      [
        "flowchart TD",
        'n1["first"]',
        'n2["second"]',
        'n3["third"]',
        "n1 -->|true| n2",
        "n2 -->|false| n3",
      ].join("\n")
    );
  });

  it("uses constant shapes by kind and puts conditions only in diamonds", () => {
    const nodes: FlowNode[] = [
      node("a", { kind: "logic", logic_kind: "if", title: ft("If"), condition: ft("priority = 1") }),
      node("b", { kind: "logic", logic_kind: "else_if", title: ft("Else If"), condition: ft("x") }),
      node("c", { kind: "logic", logic_kind: "decision", title: ft("Decide") }),
      node("d", { kind: "logic", logic_kind: "for_each", title: ft("For Each"), condition: ft("hidden") }),
      node("e", { kind: "logic", logic_kind: "do_until", title: ft("Do Until") }),
      node("f", { kind: "subflow", title: ft("Call sub") }),
      node("g", { kind: "logic", logic_kind: "end_flow", title: ft("End Flow") }),
      node("h", { kind: "more", title: ft(null), omitted_steps: 7 }),
      node("i", { kind: "logic", logic_kind: "parallel", title: ft("Parallel") }),
      node("j", { kind: "logic", logic_kind: "else", title: ft(null, "field_policy") }),
      node("k", { kind: "action", title: ft(null) }),
      node("l", { kind: "bogus" as FlowNode["kind"], logic_kind: "if", title: ft("Odd") }),
    ];
    const source = buildFlowMermaid(
      graph(nodes, [], {
        trigger: {
          node_id: "n0",
          type: ft("Record created"),
          table: ft("incident_secret_table"),
          condition: ft("secret_condition=1"),
          schedule: ft(null),
        },
      })
    )!.diagram.source;
    expectClosedGrammar(source);
    expect(source.split("\n").slice(1, 14)).toEqual([
      'n1(["Trigger: Record created"])',
      'n2{"If: priority = 1"}',
      'n3{"Else If: x"}',
      'n4{"Decide"}',
      'n5{{"For Each"}}',
      'n6{{"Do Until"}}',
      'n7[["Call sub"]]',
      'n8(("End Flow"))',
      // NFKC turns the ellipsis in constant text into three periods.
      'n9(("... 7 more steps"))',
      'n10["Parallel"]',
      'n11["(redacted)"]',
      'n12["(unnamed)"]',
      'n13["Odd"]',
    ]);
    expect(source).not.toContain("hidden");
    expect(source).not.toContain("incident_secret_table");
    expect(source).not.toContain("secret_condition");
  });

  it("labels edges only from their kind and drops unknown kinds", () => {
    const nodes = Array.from({ length: 9 }, (_, index) => node(`n${index + 1}`));
    const kinds = ["next", "true", "false", "loop_body", "loop_back", "parallel", "error", "subflow"];
    const edges = kinds.map((kind, index) => ({
      from: nodes[index]!.id,
      to: nodes[index + 1]!.id,
      kind: kind as FlowEdge["kind"],
    }));
    edges.push({ from: "n1", to: "n2", kind: '|click| n1 href "x"' as FlowEdge["kind"] });
    edges.push({ from: "n1", to: "n2", kind: "toString" as FlowEdge["kind"] });
    const source = buildFlowMermaid(graph(nodes, edges))!.diagram.source;
    expectClosedGrammar(source);
    expect(source.split("\n").filter((line) => line.includes("->"))).toEqual([
      "n1 --> n2",
      "n2 -->|true| n3",
      "n3 -->|false| n4",
      "n4 -->|each| n5",
      "n5 -.->|repeat| n6",
      "n6 -->|branch| n7",
      "n7 -->|catch| n8",
      "n8 -->|calls| n9",
    ]);
  });

  it("never draws input values", () => {
    const secret = "SECRET-INPUT-VALUE-1234";
    const nodes = [
      node("n1", {
        title: ft("Update record"),
        inputs: [{ name: "short_description", label: "Short description", type: "string", value: secret }],
      }),
    ];
    const source = buildFlowMermaid(
      graph(nodes, [], {
        trigger: {
          node_id: "n0",
          type: ft("Created"),
          table: ft("incident"),
          condition: ft(null),
          schedule: ft(null),
          inputs: [{ name: "table", label: null, type: null, value: secret }],
        },
      })
    )!.diagram.source;
    expect(source).not.toContain(secret);
    expect(source).not.toContain("Short description");
  });

  it("puts expanded subflows in flat subgraphs titled by flow name", () => {
    const base = graph([], []);
    const nodes = [
      node("n1", { title: ft("Before") }),
      node("n2", { kind: "subflow", title: ft("Call child"), subflow: { flow_sys_id: null, name: ft("Child"), expanded_index: 1 } }),
      node("n3", { flow_index: 1, title: ft("Inside child") }),
      node("n4", { flow_index: 2, title: ft("Grandchild step") }),
      node("n5", { flow_index: 99, title: ft("Unknown flow index") }),
    ];
    const source = buildFlowMermaid({
      ...base,
      flows: [
        base.flows[0]!,
        { ...base.flows[0]!, index: 1, name: ft('end"] click') },
        { ...base.flows[0]!, index: 2, name: ft("subgraph") },
      ],
      nodes,
      edges: [
        { from: "n1", to: "n2", kind: "next" },
        { from: "n2", to: "n3", kind: "subflow" },
        { from: "n3", to: "n4", kind: "subflow" },
      ],
    })!.diagram.source;
    expectClosedGrammar(source);
    expect(source).toBe(
      [
        "flowchart TD",
        'n1["Before"]',
        'n2[["Call child"]]',
        'n5["Unknown flow index"]',
        'subgraph sg1 ["end#8221;#93; click"]',
        '    n3["Inside child"]',
        "end",
        'subgraph sg2 ["subgraph"]',
        '    n4["Grandchild step"]',
        "end",
        "n1 --> n2",
        "n2 -->|calls| n3",
        "n3 -->|calls| n4",
      ].join("\n")
    );
  });

  it("collapses past 150 nodes into one nMore node joined to the last kept", () => {
    const built = buildFlowMermaid(chain(400))!;
    const source = built.diagram.source;
    expectClosedGrammar(source);
    const lines = source.split("\n");
    const nodeLines = lines.filter((line) => /^ *n(?:\d+|More)[[({]/u.test(line));
    expect(nodeLines).toHaveLength(MAX_MERMAID_NODES);
    expect(built.nodes).toBe(MAX_MERMAID_NODES);
    expect(built.omitted).toBe(251);
    expect(source).toContain('nMore(("... 251 more steps (see outline)"))');
    expect(lines.at(-1)).toBe("n149 --> nMore");
    expect(source).not.toContain("n150[");
  });

  it("does not collapse at exactly 150 nodes", () => {
    const built = buildFlowMermaid(chain(150))!;
    expect(built.omitted).toBe(0);
    expect(built.nodes).toBe(150);
    expect(built.diagram.source).not.toContain("nMore");
  });

  it("collapses when edges exceed 300", () => {
    const base = chain(40);
    const edges: FlowEdge[] = [];
    for (const from of base.nodes) {
      for (const to of base.nodes.slice(0, 10)) edges.push({ from: from.id, to: to.id, kind: "next" });
    }
    const built = buildFlowMermaid({ ...base, edges })!;
    expectClosedGrammar(built.diagram.source);
    expect(built.edges).toBeLessThanOrEqual(MAX_MERMAID_EDGES);
    expect(built.omitted).toBeGreaterThan(0);
    expect(built.diagram.source).toContain("--> nMore");
  });

  it("collapses to stay within 20,000 characters", () => {
    const built = buildFlowMermaid(chain(150, () => '"'.repeat(200)))!;
    const source = built.diagram.source;
    expectClosedGrammar(source);
    expect(source.length).toBeLessThanOrEqual(MAX_MERMAID_SOURCE_LENGTH);
    expect(built.omitted).toBeGreaterThan(0);
    expect(source).toContain("nMore");
  });

  it("draws a constant node for an empty graph and rejects non-objects", () => {
    expect(buildFlowMermaid(graph([]))!.diagram.source).toBe(
      'flowchart TD\nn1(("(no steps)"))'
    );
    for (const value of [null, undefined, "flowchart TD", 42, []]) {
      expect(buildFlowMermaid(value)).toBeUndefined();
    }
  });

  it("tolerates malformed graph members without leaving the grammar", () => {
    const source = buildFlowMermaid({
      nodes: [null, 5, "x", { id: 7, kind: "action", title: { text: ["array"] } }, { title: "plain" }],
      edges: [null, { from: 1, to: 2, kind: "next" }],
      flows: "nope",
      trigger: { type: { text: 'Trig"ger' } },
    })!.diagram.source;
    expectClosedGrammar(source);
    expect(source).toBe(
      ["flowchart TD", 'n1(["Trigger: Trig#8221;ger"])', 'n2["(unnamed)"]', 'n3["(unnamed)"]'].join("\n")
    );
  });
});
