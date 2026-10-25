import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient, ServiceNowOperations } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import type { FieldPolicyConfigurationInput } from "../src/field-policy.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy, type TableAccessPolicy } from "../src/table-policy.js";
import { createToolError } from "../src/tool-error.js";
import {
  FLOW_TABLE_FIELDS,
  FLOW_VIEW_LIMITS,
  FLOW_VIEW_TABLES,
  flowGraphSchema,
  type FlowGraph,
  type FlowTableName,
  type NormalizedFlowDefinition,
} from "../src/tools/flow-view-contracts.js";
import {
  FlowViewScopeBudget,
  expandFlowViewSubflows,
  flowViewToolModule,
} from "../src/tools/flow-view-module.js";
import type { FlowFieldPlan } from "../src/tools/flow-view-policy.js";
import { registerServiceNowToolModules, toolModules } from "../src/tools/index.js";

// Every response scope the module opens gets a number, so calls can be
// attributed to the scope they ran in. The real scope still runs underneath.
const scopes = vi.hoisted(() => ({ next: 0, storage: undefined as unknown }));
vi.mock("../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client.js")>();
  const { AsyncLocalStorage: Storage } = await import("node:async_hooks");
  const storage = new Storage<number>();
  scopes.storage = storage;
  return {
    ...actual,
    runWithServiceNowRequestSignal: <T>(signal: AbortSignal, operation: () => Promise<T>) => {
      scopes.next += 1;
      const id = scopes.next;
      return actual.runWithServiceNowRequestSignal(signal, () => storage.run(id, operation));
    },
  };
});

const currentScope = (): number | undefined =>
  (scopes.storage as AsyncLocalStorage<number>).getStore();

// ---------------------------------------------------------------------------
// A fake instance answering Table API reads from captures and synthetic rows
// ---------------------------------------------------------------------------

type Cell = { value: string; display_value: string };
type Row = Record<string, Cell>;
type Capture = Record<string, { status?: number; rows: Row[] }>;

interface Call {
  readonly path: string;
  readonly params: Record<string, string>;
  readonly scope: number | undefined;
}

const CAPTURE_DIR = new URL("./fixtures/flow-view/table/brazil-patch0/", import.meta.url);
const capture = (file: string): Capture =>
  JSON.parse(readFileSync(new URL(file, CAPTURE_DIR), "utf8")) as Capture;
const cell = (value: string, display = value): Cell => ({ value, display_value: display });

const F1 = "0b9f68ba4f23807f39c7a909d9f15b96"; // If / Else If / Else, V2
const F2F3P = "6bdd8e9327814c46130b6c048ae31e49"; // calls F3c1 and two uncaptured subflows
const F3C1 = "90735965d2d6818a17eb9d7b315f6fa8"; // V1 storage, calls two uncaptured subflows
const F3C1_SNAPSHOT = "f0d0efdd23d0dfeed03f99ef51c41fd0";
const F3C1_CALLS = ["1b702d7f156f7c4de92826da842e0a37", "4c33710b769905e5ce3dc4ef1f142959"];
const F6B = "5f7c05053df6a0980c5f3aac228bafaf"; // Try / Catch, V2
const F6C = "5fa34352277f5789a6e890db291feacf"; // large V1 flow with values

function unsupported(): never {
  throw new Error("unexpected operation");
}

interface FakeOptions {
  /** snapshot sys_id -> parent flow sys_id */
  readonly snapshots?: Readonly<Record<string, string>>;
  /** Throw this error for any read that names this flow (by flow=/model=/sys_id=). */
  readonly failFlow?: Readonly<Record<string, unknown>>;
  /** Emulate the client's per-scope cumulative JSON budget. */
  readonly scopeBudgetBytes?: number;
}

function fakeInstance(sources: readonly Capture[], options: FakeOptions = {}) {
  const calls: Call[] = [];
  const merged: Record<string, Row[]> = {};
  for (const source of sources) {
    for (const [key, entry] of Object.entries(source)) {
      if (entry.status === 400) continue;
      (merged[key] ??= []).push(...entry.rows);
    }
  }
  const missing = new Set<string>();
  for (const source of sources) {
    for (const [key, entry] of Object.entries(source)) if (entry.status === 400) missing.add(key);
  }
  for (const key of missing) if ((merged[key] ?? []).length > 0) missing.delete(key);
  const labels = new Map<string, string>();
  for (const row of merged.variable_value ?? []) labels.set(row.variable!.value, row.variable!.display_value);
  const usedBytes = new Map<number | undefined, number>();

  const ops = Object.freeze({
    async get(path: string, params: Record<string, string> = {}) {
      calls.push({ path, params: { ...params }, scope: currentScope() });
      const table = path.replace("/api/now/table/", "");
      const query = params.sysparm_query ?? "";
      for (const [flowId, error] of Object.entries(options.failFlow ?? {})) {
        if (query.includes(`flow=${flowId}`) || query.includes(`model=${flowId}`)) throw error;
        if (table === "sys_hub_flow" && query.startsWith(`sys_id=${flowId}`) && !query.includes("typeIN")) throw error;
      }
      const key = table === "sys_hub_flow" ? "flow" : table === "sys_variable_value" ? "variable_value" : table;
      if (missing.has(key)) throw createToolError("upstream", "do_not_retry");
      const ids = new Set((/(?:document_key|sys_id)IN([0-9a-f,]+)/u.exec(query)?.[1] ?? "").split(","));
      let rows: Row[];
      if (table === "sys_hub_flow") {
        const bySysId = /^sys_id=([0-9a-f]{32})/u.exec(query)?.[1];
        const byName = /^name=([^^]*)\^/u.exec(query)?.[1];
        rows = (merged.flow ?? []).filter((row) =>
          bySysId ? row.sys_id!.value === bySysId : row.name!.value.toLowerCase() === byName?.toLowerCase()
        );
      } else if (table === "sys_hub_flow_snapshot") {
        rows = [...ids]
          .filter((id) => options.snapshots && Object.hasOwn(options.snapshots, id))
          .map((id) => ({ sys_id: cell(id), parent_flow: cell(options.snapshots![id]!) }));
      } else if (table === "var_dictionary") {
        rows = [...ids]
          .filter((id) => labels.has(id))
          .map((id) => ({
            sys_id: cell(id),
            element: cell(labels.get(id)!.toLowerCase().replace(/[^a-z0-9]+/gu, "_")),
            internal_type: cell("string"),
          }));
      } else if (table === "sys_variable_value") {
        rows = (merged.variable_value ?? []).filter((row) => ids.has(row.document_key!.value));
      } else {
        const model = /^model=([0-9a-f]{32})/u.exec(query)?.[1];
        const flow = /^flow=([0-9a-f]{32})/u.exec(query)?.[1];
        rows = (merged[table] ?? []).filter((row) => (model ? row.model?.value === model : row.flow?.value === flow));
      }
      const fields = (params.sysparm_fields ?? "").split(",");
      // sysparm_display_value=false returns bare values, as the Table API does.
      const raw = params.sysparm_display_value === "false";
      const projected = rows.map((row) =>
        Object.fromEntries(
          fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, raw ? row[field]!.value : row[field]])
        )
      );
      const offset = Number(params.sysparm_offset ?? "0");
      const result = { result: projected.slice(offset, offset + Number(params.sysparm_limit ?? "10000")) };
      if (options.scopeBudgetBytes !== undefined) {
        const scope = currentScope();
        const total = (usedBytes.get(scope) ?? 0) + Buffer.byteLength(JSON.stringify(result));
        if (total > options.scopeBudgetBytes) {
          throw new RangeError("cumulative upstream response exceeds configured byte limit");
        }
        usedBytes.set(scope, total);
      }
      return result;
    },
    getWithMeta: unsupported,
    post: unsupported,
    patch: unsupported,
    delete: unsupported,
    postBinary: unsupported,
    getRaw: unsupported,
  }) as unknown as ServiceNowOperations;
  return { ops, calls };
}

/** Hand-built flows whose only steps are subflow calls (V2 storage). */
function synthetic(flows: Readonly<Record<string, readonly string[]>>, bigComment = 0, blobChars = 0): {
  capture: Capture;
  snapshots: Record<string, string>;
} {
  const flowRows: Row[] = [];
  const calls: Row[] = [];
  const snapshots: Record<string, string> = {};
  let n = 0;
  for (const [id, targets] of Object.entries(flows)) {
    flowRows.push({
      sys_id: cell(id),
      name: cell(`Synthetic ${id.slice(-4)}`),
      type: cell("subflow", "Subflow"),
      active: cell("true"),
      status: cell("published", "Published"),
      version: cell("1"),
      description: cell(""),
      sys_scope: cell("global", "Global"),
    });
    targets.forEach((target, index) => {
      n += 1;
      const snapshot = `5${target.slice(1, 28)}${n.toString(16).padStart(4, "0")}`;
      snapshots[snapshot] = target;
      calls.push({
        sys_id: cell(`c${n.toString(16).padStart(31, "0")}`),
        flow: cell(id),
        order: cell(String(index + 1)),
        ui_id: cell(`${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`),
        parent_ui_id: cell(""),
        subflow: cell(snapshot, `Call ${target.slice(-4)}`),
        comment: cell("x".repeat(bigComment)),
        ...(blobChars > 0 ? { subflow_inputs: cell(`H4sI${"A".repeat(blobChars)}`) } : {}),
      });
    });
  }
  return {
    capture: { flow: { rows: flowRows }, sys_hub_sub_flow_instance_v2: { rows: calls } },
    snapshots,
  };
}

const sid = (n: number): string => n.toString(16).padStart(32, "0");

// ---------------------------------------------------------------------------
// Dispatcher harness
// ---------------------------------------------------------------------------

const PROFILE = "flow-view-test";
const INSTANCE = "https://flow-view-test.service-now.com";

function flowViewPolicy(tools: readonly string[] = ["sn_flow_view"]): TableAccessPolicy {
  return createTableAccessPolicy({
    readTables: [...FLOW_VIEW_TABLES],
    writeTables: [],
    targets: FLOW_VIEW_TABLES.map((table) => ({
      table,
      kind: "canonical" as const,
      tools,
      closureComplete: true as const,
      relatedTables: [table],
    })),
  });
}

const harnesses: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close();
});

async function harness(
  ops: ServiceNowOperations,
  options: { tableAccess?: TableAccessPolicy; fieldPolicy?: FieldPolicyConfigurationInput } = {}
) {
  const profile: Profile = Object.freeze({
    instance: INSTANCE,
    username: "flow-view-user",
    credential: "env:FLOW_VIEW_TEST_SECRET",
    authType: "basic" as const,
  });
  const config: ServiceNowConfig = Object.freeze({
    instance: INSTANCE,
    user: "flow-view-user",
    password: "flow-view-secret",
    displayValue: "true",
    relDepth: 3,
    authType: "basic" as const,
  });
  const manager = {
    getProfile: () => profile,
    getConfig: () => config,
    getClient: () => ops as unknown as ServiceNowClient,
  } as unknown as ProfileManager;
  const tableAccess = options.tableAccess ?? flowViewPolicy();
  const dependencies: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `flow-view-${String(requestId)}`,
        identity: { ownerId: "flow-view-owner", clientId: "flow-view-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "flow-view-policy",
        revision: "v1",
        tableAccess,
        ...(options.fieldPolicy === undefined ? {} : { fieldPolicy: options.fieldPolicy }),
      }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
  };
  const server = await createMcpServer({
    dependencies: {},
    register: (surface) => registerServiceNowToolModules(surface, manager, dependencies, toolModules),
  });
  const client = new Client({ name: "flow-view-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const handle = {
    client,
    async close() {
      try {
        await client.close();
      } finally {
        if (server.isConnected()) await server.close();
      }
    },
  };
  harnesses.push(handle);
  return handle;
}

async function view(
  ops: ServiceNowOperations,
  args: Record<string, unknown>,
  options: Parameters<typeof harness>[1] = {}
): Promise<CallToolResult> {
  const { client } = await harness(ops, options);
  return (await client.callTool({ name: "sn_flow_view", arguments: { profile: PROFILE, ...args } })) as CallToolResult;
}

function graphOf(result: CallToolResult): FlowGraph {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const envelope = result.structuredContent as { data: unknown; metadata: { limits: { max_bytes: number } } };
  const parsed = flowGraphSchema.safeParse(envelope.data);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5)));
  return envelope.data as FlowGraph;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

const CLOSURE_PATHS = new Set(FLOW_VIEW_TABLES.map((table) => `/api/now/table/${table}`));
const ALL_CALLS: Call[] = [];

function expectTableApiOnly(calls: readonly Call[]): void {
  ALL_CALLS.push(...calls);
  for (const call of calls) {
    expect(CLOSURE_PATHS.has(call.path), call.path).toBe(true);
    expect(call.path).not.toMatch(/processflow|sys_hub_flow_version/u);
    expect(JSON.stringify(call.params)).not.toMatch(/processflow|sys_hub_flow_version/u);
  }
}

// ---------------------------------------------------------------------------
// End to end through the dispatcher
// ---------------------------------------------------------------------------

describe("sn_flow_view end to end", () => {
  it("is registered and discoverable with read-only annotations", async () => {
    const { client } = await harness(fakeInstance([]).ops);
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "sn_flow_view");
    expect(tool).toBeDefined();
    expect(tool!.annotations).toEqual({
      title: "View Flow Designer flow",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual([
      "depth",
      "flow",
      "format",
      "include_inputs",
      "max_nodes",
      "max_response_bytes",
      "profile",
    ]);
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["flow", "profile"]));
    expect(flowViewToolModule.requirements).toMatchObject({
      permissions: ["read"],
      apis: ["table"],
      tables: { kind: "static", names: FLOW_VIEW_TABLES },
    });
  });

  it("renders a captured flow (If / Else If / Else) as graph, Mermaid and outline", async () => {
    const fake = fakeInstance([capture("tables-F1.json")]);
    const result = await view(fake.ops, { flow: F1 });
    const graph = graphOf(result);
    expect(graph.source).toBe("table");
    expect(graph.flows).toHaveLength(1);
    expect(graph.flows[0]!.sys_id).toBe(F1);
    expect(graph.trigger).not.toBeNull();
    expect(graph.nodes.length).toBeGreaterThan(10);

    // Else is a node of its own: the false edge enters it, and it leads into its body.
    const elseNode = graph.nodes.find((node) => node.logic_kind === "else")!;
    expect(elseNode).toBeDefined();
    expect(graph.edges).toContainEqual(expect.objectContaining({ to: elseNode.id, kind: "false" }));
    expect(graph.edges.some((edge) => edge.from === elseNode.id && edge.kind === "next")).toBe(true);

    const text = textOf(result);
    expect(text).toContain("```mermaid\nflowchart TD\n");
    expect(text).toMatch(/-->\|false\|/u);
    expect(text).toContain("Flow outline");
    expect(text).toContain("| Source | table API |");
    expectTableApiOnly(fake.calls);
  });

  it("draws Try / Catch with an error edge into the Catch node", async () => {
    const fake = fakeInstance([capture("tables-F6b.json")]);
    const graph = graphOf(await view(fake.ops, { flow: F6B, format: "mermaid" }));
    const catchNode = graph.nodes.find((node) => node.logic_kind === "catch")!;
    expect(catchNode).toBeDefined();
    expect(graph.edges).toContainEqual(expect.objectContaining({ to: catchNode.id, kind: "error" }));
    expectTableApiOnly(fake.calls);
  });

  it("renders the Catch edge as a labelled Mermaid edge", async () => {
    const fake = fakeInstance([capture("tables-F6b.json")]);
    const text = textOf(await view(fake.ops, { flow: F6B, format: "mermaid" }));
    expect(text).toMatch(/-->\|catch\|/u);
    expect(text).not.toContain("Flow outline");
  });

  it("resolves a flow by exact name", async () => {
    const source = capture("tables-F1.json");
    const name = source.flow!.rows[0]!.name!.value;
    const fake = fakeInstance([source]);
    const graph = graphOf(await view(fake.ops, { flow: name }));
    expect(graph.flows[0]!.sys_id).toBe(F1);
    expect(fake.calls[0]!.params.sysparm_query).toMatch(/^name=/u);
  });

  it("reports a missing flow as not found and an ambiguous name with its candidates", async () => {
    const missing = await view(fakeInstance([]).ops, { flow: sid(1) });
    expect(missing.isError).toBe(true);

    const { capture: twins } = synthetic({ [sid(0xa1)]: [], [sid(0xa2)]: [] });
    for (const row of twins.flow!.rows) row.name = cell("Same name");
    const ambiguous = await view(fakeInstance([twins]).ops, { flow: "Same name" });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain("conflicting resource state");
    expect(textOf(missing)).toContain("not found");
  });

  it("expands a subflow at depth 2, numbered and indented under its call site", async () => {
    const fake = fakeInstance([capture("tables-F2F3p.json"), capture("tables-F3c1.json")], {
      snapshots: { [F3C1_SNAPSHOT]: F3C1 },
    });
    const result = await view(fake.ops, { flow: F2F3P, depth: 2 });
    const graph = graphOf(result);
    expect(graph.flows.map((flow) => flow.sys_id)).toEqual([F2F3P, F3C1]);
    const call = graph.nodes.find((node) => node.kind === "subflow" && node.subflow?.expanded_index === 1)!;
    expect(call).toBeDefined();
    const child = graph.nodes.filter((node) => node.flow_index === 1);
    expect(child.length).toBeGreaterThan(0);
    // Depth is relative to the subflow; the step is prefixed by the call site.
    expect(Math.min(...child.map((node) => node.depth))).toBe(0);
    for (const node of child) expect(node.step.startsWith(`${call.step}.`)).toBe(true);
    // The subflow edge leaves the call site.
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: call.id, kind: "subflow" }));
    // Uncaptured targets are reported, not fatal.
    expect(graph.warnings).toContain("subflow_not_found");

    const outline = textOf(result).split("\n");
    const callLine = outline.findIndex((line) => line.includes(`${call.step}. ↪`));
    expect(callLine).toBeGreaterThan(-1);
    const callIndent = /^ */u.exec(outline[callLine]!)![0].length;
    const firstChild = outline[callLine + 1 + outline.slice(callLine + 1).findIndex((line) => line.includes(`${call.step}.1.`))]!;
    expect(/^ */u.exec(firstChild)![0].length).toBe(callIndent + 4);
    expectTableApiOnly(fake.calls);
  });

  it("does not expand subflows at depth 1", async () => {
    const fake = fakeInstance([capture("tables-F2F3p.json"), capture("tables-F3c1.json")], {
      snapshots: { [F3C1_SNAPSHOT]: F3C1 },
    });
    const graph = graphOf(await view(fake.ops, { flow: F2F3P }));
    expect(graph.flows).toHaveLength(1);
    expect(graph.nodes.filter((node) => node.kind === "subflow").map((node) => node.subflow?.not_expanded)).toContain(
      "depth"
    );
    expect(fake.calls.some((call) => call.params.sysparm_query?.includes(`flow=${F3C1}`))).toBe(false);
  });

  it("marks a subflow cycle and never loads a flow twice", async () => {
    const fake = fakeInstance([capture("tables-F2F3p.json"), capture("tables-F3c1.json")], {
      snapshots: { [F3C1_SNAPSHOT]: F3C1, [F3C1_CALLS[0]!]: F2F3P },
    });
    const graph = graphOf(await view(fake.ops, { flow: F2F3P, depth: 3 }));
    expect(graph.warnings).toContain("subflow_cycle");
    const back = graph.nodes.find((node) => node.flow_index === 1 && node.subflow?.flow_sys_id === F2F3P)!;
    expect(back.subflow!.not_expanded).toBe("cycle");
    const rootLoads = fake.calls.filter(
      (call) =>
        call.path === "/api/now/table/sys_hub_action_instance_v2" &&
        call.params.sysparm_query?.includes(F2F3P) &&
        call.params.sysparm_display_value === "all"
    );
    expect(rootLoads).toHaveLength(1);
  });

  it("runs the root resolve, the root load and each subflow (record and load) in separate scopes", async () => {
    const fake = fakeInstance([capture("tables-F2F3p.json"), capture("tables-F3c1.json")], {
      snapshots: { [F3C1_SNAPSHOT]: F3C1 },
    });
    graphOf(await view(fake.ops, { flow: F2F3P, depth: 2 }));
    const scopeOf = (predicate: (call: Call) => boolean) =>
      new Set(fake.calls.filter(predicate).map((call) => call.scope));
    const rootResolve = new Set([fake.calls[0]!.scope]);
    expect(fake.calls[0]!.params.sysparm_query).toBe(`sys_id=${F2F3P}^typeINflow,subflow`);
    // Selected by sys_id: the pill labels come with the record, not in the load.
    expect(fake.calls[0]!.params.sysparm_fields).toMatch(/,label_cache$/u);
    const rootLoad = scopeOf((call) => /(?:flow|model)=6bdd/u.test(call.params.sysparm_query ?? ""));
    const child = scopeOf(
      (call) =>
        /(?:flow|model)=9073/u.test(call.params.sysparm_query ?? "") ||
        call.params.sysparm_query?.startsWith(`sys_id=${F3C1}^typeIN`) === true
    );
    for (const set of [rootResolve, rootLoad, child]) {
      expect(set.size).toBe(1);
      expect([...set][0]).toBeTypeOf("number");
    }
    const ids = [rootResolve, rootLoad, child].map((set) => [...set][0]);
    expect(new Set(ids).size).toBe(3);
    expect(new Set(fake.calls.map((call) => call.scope)).size).toBe(3);
    expect(fake.calls.filter((call) => call.path.endsWith("/sys_hub_flow") && !/typeIN/u.test(call.params.sysparm_query ?? ""))).toEqual([]);
  });

  it("keeps a subflow that overflows its own scope from affecting the next one", async () => {
    const big = sid(0xb1);
    const small = sid(0xb2);
    const root = sid(0xb0);
    const bigFlow = synthetic({ [big]: Array.from({ length: 400 }, () => sid(0xbf)) }, 3_000);
    const rest = synthetic({ [root]: [big, small], [small]: [] });
    const fake = fakeInstance([rest.capture, bigFlow.capture], {
      snapshots: { ...rest.snapshots },
      scopeBudgetBytes: 1_048_576,
    });
    const graph = graphOf(await view(fake.ops, { flow: root, depth: 2 }));
    const calls = graph.nodes.filter((node) => node.flow_index === 0 && node.kind === "subflow");
    expect(calls.map((node) => node.subflow?.flow_sys_id)).toEqual([big, small]);
    expect(calls[0]!.subflow!.not_expanded).toBe("too_large");
    expect(calls[1]!.subflow!.expanded_index).toBe(1);
    expect(graph.flows.map((flow) => flow.sys_id)).toEqual([root, small]);
    expect(graph.warnings).toContain("subflow_too_large");
    expect(graph.warnings).not.toContain("subflow_not_found");
  });

  it("retries a subflow too large with its input values once without them", async () => {
    const [root, heavy] = [sid(0xb3), sid(0xb4)];
    const heavyFlow = synthetic({ [heavy]: Array.from({ length: 400 }, () => sid(0xbe)) }, 0, 3_000);
    const rest = synthetic({ [root]: [heavy] });
    const fake = fakeInstance([rest.capture, heavyFlow.capture], { snapshots: rest.snapshots, scopeBudgetBytes: 1_048_576 });
    const graph = graphOf(await view(fake.ops, { flow: root, depth: 2 }));
    expect(graph.flows.map((flow) => flow.sys_id)).toEqual([root, heavy]);
    expect(graph.warnings).toContain("inputs_omitted_too_large");
    expect(graph.nodes.filter((node) => node.flow_index === 1).some((node) => node.inputs !== undefined)).toBe(false);
  });

  it("reads a root flow too large with its input values again without them, and says so", async () => {
    const root = sid(0xc1);
    const heavy = synthetic({ [root]: Array.from({ length: 400 }, () => sid(0xce)) }, 0, 3_000);
    const fake = fakeInstance([heavy.capture], { scopeBudgetBytes: 1_048_576 });
    const result = await view(fake.ops, { flow: root });
    const graph = graphOf(result);
    expect(graph.warnings).toContain("inputs_omitted_too_large");
    expect(graph.nodes.length).toBeGreaterThan(100);
    expect(graph.nodes.some((node) => node.inputs !== undefined)).toBe(false);
    expect(textOf(result)).toContain("read as with include_inputs=false");
    // Three scopes: resolve, the load that overflowed, the retry.
    expect(new Set(fake.calls.map((call) => call.scope)).size).toBe(3);
  });

  it("shows only the record of a root flow too large even without input values", async () => {
    const root = sid(0xc0);
    const big = synthetic({ [root]: Array.from({ length: 400 }, () => sid(0xcf)) }, 3_000);
    const fake = fakeInstance([big.capture], { scopeBudgetBytes: 1_048_576 });
    const result = await view(fake.ops, { flow: root });
    const graph = graphOf(result);
    expect(graph.flows.map((flow) => flow.sys_id)).toEqual([root]);
    expect(graph.nodes).toEqual([]);
    expect(graph.warnings).toEqual(expect.arrayContaining(["flow_too_large"]));
    expect(textOf(result)).toContain("too large to read, even without input values");
    const noInputs = graphOf(await view(fakeInstance([big.capture], { scopeBudgetBytes: 1_048_576 }).ops, { flow: root, include_inputs: false }));
    expect(noInputs.warnings).toContain("flow_too_large");
    expect(noInputs.warnings).not.toContain("inputs_omitted_too_large");
  });

  it("denies the call when a closure table's target does not list sn_flow_view", async () => {
    const fake = fakeInstance([capture("tables-F1.json")]);
    const result = await view(fake.ops, { flow: F1 }, { tableAccess: flowViewPolicy(["sn_query"]) });
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("reads no value fields and shows no inputs with include_inputs=false", async () => {
    const fake = fakeInstance([capture("tables-F6c.json")]);
    const graph = graphOf(await view(fake.ops, { flow: F6C, include_inputs: false }));
    expect(graph.nodes.some((node) => node.inputs !== undefined)).toBe(false);
    for (const call of fake.calls) {
      expect(call.path).not.toMatch(/\/(?:var_dictionary|sys_variable_value)$/u);
      const table = call.path.replace("/api/now/table/", "") as FlowTableName;
      const values = new Set(FLOW_TABLE_FIELDS[table].values);
      for (const field of (call.params.sysparm_fields ?? "").split(",")) {
        expect(values.has(field), `${table}.${field}`).toBe(false);
      }
    }
  });

  it.each([10_000, 25_000, 100_000])("fits the whole result into max_response_bytes=%i", async (limit) => {
    const fake = fakeInstance([capture("tables-F6c.json")]);
    const result = await view(fake.ops, { flow: F6C, max_response_bytes: limit });
    graphOf(result);
    const envelope = result.structuredContent as { metadata: { limits: { max_bytes: number } } };
    expect(envelope.metadata.limits.max_bytes).toBe(limit);
    const size = Buffer.byteLength(
      JSON.stringify({ content: result.content, structuredContent: result.structuredContent }),
      "utf8"
    );
    expect(size).toBeLessThanOrEqual(limit);
    expect(textOf(result)).toContain("Flow");
  });

  it("never requests a processflow or flow-version path in any test above", () => {
    expect(ALL_CALLS.length).toBeGreaterThan(50);
    for (const call of ALL_CALLS) {
      expect(call.path.startsWith("/api/now/table/")).toBe(true);
      expect(call.path).not.toMatch(/processflow|sys_hub_flow_version/u);
    }
  });
});

// ---------------------------------------------------------------------------
// Subflow expansion limits (unit)
// ---------------------------------------------------------------------------

const OPEN_PLAN: FlowFieldPlan = (() => {
  const readable = new Map<FlowTableName, ReadonlySet<string>>();
  for (const table of FLOW_VIEW_TABLES) {
    const spec = FLOW_TABLE_FIELDS[table];
    readable.set(table, new Set([...spec.required, ...spec.optional, ...spec.values]));
  }
  return { readable, include_inputs: true };
})();

const OPTIONS = {
  flow: "x",
  depth: 3,
  include_inputs: true,
  format: "both" as const,
  max_nodes: 150,
  max_response_bytes: 100_000,
};

function rootDef(id: string, targets: readonly string[]): NormalizedFlowDefinition {
  return {
    source: "table",
    header: {
      sys_id: id,
      name: { text: "Root" },
      description: { text: null },
      type: "flow",
      active: true,
      status: "published",
      version: "1",
      scope: "global",
    },
    trigger: null,
    steps: targets.map((target, index) => ({
      uid: `u${index}`,
      parent_uid: null,
      order: index,
      connected_uid: null,
      kind: "subflow" as const,
      title: { text: "Call" },
      annotation: { text: null },
      inputs: [],
      subflow: { flow_sys_id: target, name: { text: "Call" } },
    })),
    label_cache: [],
    variables: [],
    warnings: [],
    limits_hit: [],
    items_dropped: 0,
  };
}

describe("subflow expansion limits", () => {
  const signal = new AbortController().signal;

  it("stops at MAX_UPSTREAM_SCOPES and records upstream_scopes", async () => {
    const root = sid(0xd0);
    const children = [sid(0xd1), sid(0xd2), sid(0xd3)];
    const { capture: flows, snapshots } = synthetic({ [root]: children, ...Object.fromEntries(children.map((c) => [c, []])) });
    const fake = fakeInstance([flows], { snapshots });
    // root resolve + root load already spent: 2 of 4, so two subflow loads fit.
    const budget = new FlowViewScopeBudget(4);
    budget.take();
    budget.take();
    const expansion = await expandFlowViewSubflows(fake.ops, OPEN_PLAN, OPTIONS, rootDef(root, children), budget, signal);
    expect(budget.opened).toBe(4);
    expect([...expansion.limits]).toContain("upstream_scopes");
    expect([...expansion.subflows.keys()]).toEqual([sid(0xd1), sid(0xd2)]);
  });

  it("leaves room under MAX_UPSTREAM_SCOPES for retries at the default limits", () => {
    // Root resolve and load, one scope per subflow; the rest serve retries without inputs.
    expect(2 + FLOW_VIEW_LIMITS.MAX_SUBFLOW_EXPANSIONS).toBeLessThan(FLOW_VIEW_LIMITS.MAX_UPSTREAM_SCOPES);
  });

  it("gives remaining scopes to too-large retries in call order", async () => {
    const root = sid(0xd8);
    const heavy = [sid(0xd9), sid(0xda), sid(0xdb)];
    const heavyFlows = synthetic(Object.fromEntries(heavy.map((id) => [id, Array.from({ length: 400 }, () => sid(0xdf))])), 0, 3_000);
    const rest = synthetic({ [root]: heavy });
    const fake = fakeInstance([rest.capture, heavyFlows.capture], { snapshots: rest.snapshots, scopeBudgetBytes: 1_048_576 });
    // 2 spent, 3 loads, 1 left for one retry.
    const budget = new FlowViewScopeBudget(6);
    budget.take();
    budget.take();
    const expansion = await expandFlowViewSubflows(fake.ops, OPEN_PLAN, OPTIONS, rootDef(root, heavy), budget, signal);
    expect(budget.opened).toBe(6);
    expect("unavailable" in expansion.subflows.get(heavy[0]!)!).toBe(false);
    expect(expansion.subflows.get(heavy[1]!)).toEqual({ unavailable: "too_large" });
    expect(expansion.subflows.get(heavy[2]!)).toEqual({ unavailable: "too_large" });
    expect([...expansion.limits]).toContain("upstream_scopes");
    expect([...expansion.warnings]).toEqual(["inputs_omitted_too_large"]);
  });

  it("loads at most MAX_SUBFLOW_EXPANSIONS subflows", async () => {
    const root = sid(0xe0);
    const children = Array.from({ length: 10 }, (_, index) => sid(0xe1 + index));
    const { capture: flows, snapshots } = synthetic({ [root]: children, ...Object.fromEntries(children.map((c) => [c, []])) });
    const fake = fakeInstance([flows], { snapshots });
    const budget = new FlowViewScopeBudget();
    budget.take();
    budget.take();
    const expansion = await expandFlowViewSubflows(fake.ops, OPEN_PLAN, OPTIONS, rootDef(root, children), budget, signal);
    expect(expansion.subflows.size).toBe(FLOW_VIEW_LIMITS.MAX_SUBFLOW_EXPANSIONS);
    expect([...expansion.limits]).toEqual(["max_subflow_expansions"]);
    expect(budget.opened).toBe(2 + FLOW_VIEW_LIMITS.MAX_SUBFLOW_EXPANSIONS);
  });

  it("expands breadth first, one level per depth step, and stops at depth", async () => {
    const [root, a, b, c] = [sid(0xf0), sid(0xf1), sid(0xf2), sid(0xf3)];
    const { capture: flows, snapshots } = synthetic({ [root]: [a], [a]: [b], [b]: [c], [c]: [] });
    const fake = fakeInstance([flows], { snapshots });
    const run = async (depth: number) =>
      [
        ...(
          await expandFlowViewSubflows(fake.ops, OPEN_PLAN, { ...OPTIONS, depth }, rootDef(root, [a]), new FlowViewScopeBudget(), signal)
        ).subflows.keys(),
      ];
    expect(await run(1)).toEqual([]);
    expect(await run(2)).toEqual([a]);
    expect(await run(3)).toEqual([a, b]);
  });

  it("records denied and missing subflows without failing", async () => {
    const [root, denied, gone] = [sid(0x101), sid(0x102), sid(0x103)];
    const { capture: flows, snapshots } = synthetic({ [root]: [denied, gone], [denied]: [] });
    const fake = fakeInstance([flows], {
      snapshots,
      failFlow: { [denied]: createToolError("authorization", "do_not_retry") },
    });
    const expansion = await expandFlowViewSubflows(
      fake.ops,
      OPEN_PLAN,
      OPTIONS,
      rootDef(root, [denied, gone]),
      new FlowViewScopeBudget(),
      signal
    );
    expect(expansion.subflows.get(denied)).toEqual({ unavailable: "denied" });
    expect(expansion.subflows.get(gone)).toEqual({ unavailable: "not_found" });
  });

  it("rethrows a cancellation", async () => {
    const [root, child] = [sid(0x111), sid(0x112)];
    const { capture: flows, snapshots } = synthetic({ [root]: [child], [child]: [] });
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const fake = fakeInstance([flows], { snapshots, failFlow: { [child]: reason } });
    controller.abort(reason);
    await expect(
      expandFlowViewSubflows(fake.ops, OPEN_PLAN, OPTIONS, rootDef(root, [child]), new FlowViewScopeBudget(), controller.signal)
    ).rejects.toBeDefined();
  });

  it("rethrows an authentication failure", async () => {
    const [root, child] = [sid(0x121), sid(0x122)];
    const { capture: flows, snapshots } = synthetic({ [root]: [child], [child]: [] });
    const fake = fakeInstance([flows], {
      snapshots,
      failFlow: { [child]: createToolError("authentication", "do_not_retry") },
    });
    await expect(
      expandFlowViewSubflows(fake.ops, OPEN_PLAN, OPTIONS, rootDef(root, [child]), new FlowViewScopeBudget(), signal)
    ).rejects.toBeDefined();
  });
});
