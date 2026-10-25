import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import { createCachedServiceNowOperations } from "../src/metadata-cache.js";
import { createToolError } from "../src/tool-error.js";
import {
  FLOW_TABLE_FIELDS,
  FLOW_VIEW_LIMITS,
  FLOW_VIEW_TABLES,
  flowHeaderSchema,
  flowInputValueSchema,
  flowLogicKindFromName,
  flowTextSchema,
  flowVariableDefSchema,
  type FlowTableName,
  type NormalizedFlowDefinition,
  type NormalizedStep,
} from "../src/tools/flow-view-contracts.js";
import type { FlowFieldPlan } from "../src/tools/flow-view-policy.js";
import {
  FLOW_NAME_LOOKUP_LIMIT,
  loadFlowFromTables,
  parseFlowOrder,
  resolveFlowRecord,
  resolveSubflowTarget,
  type FlowHeaderRecord,
} from "../src/tools/flow-view-table.js";
import { createMockServiceNowFixture, type MockServiceNowStep } from "./fixtures/mock-servicenow.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

type Cell = { value: string; display_value: string };
type Row = Record<string, Cell>;
type Capture = Record<string, { status?: number; rows: Row[] }>;

const CAPTURE_DIR = new URL("./fixtures/flow-view/table/brazil-patch0/", import.meta.url);
const ADVERSARIAL_DIR = new URL("./fixtures/flow-view/table/adversarial/", import.meta.url);
const CAPTURE_FILES = readdirSync(CAPTURE_DIR).filter((file) => file.startsWith("tables-")).sort();

function capture(file: string): Capture {
  return JSON.parse(readFileSync(new URL(file, CAPTURE_DIR), "utf8")) as Capture;
}

function adversarial<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, ADVERSARIAL_DIR), "utf8")) as T;
}

const BLOBS = adversarial<Record<string, string>>("blobs.json");

function cell(value: string, display = value): Cell {
  return { value, display_value: display };
}

function gz(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");
}

function decode(blob: string): unknown {
  return JSON.parse(gunzipSync(Buffer.from(blob, "base64")).toString("utf8"));
}

/** A plan in which every closure field is readable, minus `omit`. */
function planFor(options: { include_inputs?: boolean; omit?: readonly (readonly [FlowTableName, string])[] } = {}): FlowFieldPlan {
  const include = options.include_inputs ?? true;
  const readable = new Map<FlowTableName, ReadonlySet<string>>();
  for (const table of FLOW_VIEW_TABLES) {
    const spec = FLOW_TABLE_FIELDS[table];
    const fields = new Set([...spec.required, ...spec.optional, ...(include ? spec.values : [])]);
    for (const [omitTable, field] of options.omit ?? []) if (omitTable === table) fields.delete(field);
    readable.set(table, fields);
  }
  return { readable, include_inputs: include };
}

const OPEN = planFor();
const NO_INPUTS = planFor({ include_inputs: false });

const READ_PARAMS = { sysparm_display_value: "all", sysparm_exclude_reference_link: "true" } as const;
const FIELDS = {
  header: "sys_id,name,type,active,status,version,description,sys_scope",
  trigger: "sys_id,flow,name,trigger_type,trigger_definition",
  action: "sys_id,flow,order,ui_id,parent_ui_id,action_type,comment",
  logic: "sys_id,flow,order,ui_id,parent_ui_id,logic_definition,connected_to,comment",
  subflow: "sys_id,flow,order,ui_id,parent_ui_id,subflow,comment",
  io: "sys_id,model,element,label,internal_type,order",
  value: "sys_id,document,document_key,variable,order,value",
  dictionary: "sys_id,element,internal_type",
} as const;

interface Call {
  path: string;
  params: Record<string, string>;
  /** Size of the JSON response returned. */
  bytes?: number;
}

function unsupported(): never {
  throw new Error("unexpected operation");
}

/** Lowercase snake form of a label, used to synthesize var_dictionary elements. */
function elementOf(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
}

const MISSING_TABLE = createToolError("upstream", "do_not_retry");

/**
 * A fake instance answering Table API reads from a capture. It filters by the
 * query the loader sends, projects `sysparm_fields`, applies `sysparm_limit`
 * and records every call. Snapshots and var_dictionary rows are synthesized.
 */
function fakeInstance(
  source: Capture,
  options: {
    snapshots?: Readonly<Record<string, string>>;
    types?: Readonly<Record<string, string>>;
    errors?: Readonly<Record<string, unknown>>;
  } = {}
) {
  const calls: Call[] = [];
  const labels = new Map<string, string>();
  for (const row of source.variable_value?.rows ?? []) labels.set(row.variable!.value, row.variable!.display_value);
  const flowRows = source.flow?.rows ?? [];
  const ops = Object.freeze({
    async get(path: string, params: Record<string, string> = {}) {
      const call: Call = { path, params: { ...params } };
      calls.push(call);
      const table = path.replace("/api/now/table/", "");
      if (options.errors && Object.hasOwn(options.errors, table)) throw options.errors[table];
      const key = table === "sys_hub_flow" ? "flow" : table === "sys_variable_value" ? "variable_value" : table;
      if (source[key]?.status === 400) throw MISSING_TABLE;
      const query = params.sysparm_query ?? "";
      const ids = new Set((/(?:document_key|sys_id)IN([0-9a-f,]+)/u.exec(query)?.[1] ?? "").split(","));
      let rows: Row[];
      if (table === "sys_hub_flow") {
        const bySysId = /^sys_id=([0-9a-f]{32})/u.exec(query)?.[1];
        const byName = /^name=([^^]*)\^/u.exec(query)?.[1];
        rows = flowRows.filter((row) =>
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
            element: cell(elementOf(labels.get(id)!)),
            internal_type: cell(options.types?.[id] ?? "string"),
          }));
      } else if (table === "sys_variable_value") {
        rows = (source.variable_value?.rows ?? []).filter((row) => ids.has(row.document_key!.value));
      } else {
        const model = /^model=([0-9a-f]{32})/u.exec(query)?.[1];
        const flow = /^flow=([0-9a-f]{32})/u.exec(query)?.[1];
        rows = (source[table]?.rows ?? []).filter((row) =>
          model ? row.model?.value === model : row.flow?.value === flow
        );
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
      const response = { result: projected.slice(offset, offset + Number(params.sysparm_limit ?? "10000")) };
      call.bytes = Buffer.byteLength(JSON.stringify(response));
      return response;
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

function flowIdOf(source: Capture): string {
  return source.flow!.rows[0]!.sys_id!.value;
}

async function headerOf(source: Capture, plan = OPEN): Promise<FlowHeaderRecord> {
  const { ops } = fakeInstance(source);
  const resolution = await resolveFlowRecord(ops, plan, { sys_id: flowIdOf(source) });
  if (resolution.status !== "found") throw new Error("fixture flow not found");
  return resolution.header;
}

/** Map every snapshot a capture's subflow rows reference to a fake parent flow. */
function snapshotsOf(source: Capture): Record<string, string> {
  const output: Record<string, string> = {};
  for (const table of ["sys_hub_sub_flow_instance", "sys_hub_sub_flow_instance_v2"]) {
    for (const row of source[table]?.rows ?? []) {
      output[row.subflow!.value] = `e${row.subflow!.value.slice(1)}`;
    }
  }
  return output;
}

async function load(
  file: string,
  plan = OPEN,
  options: Parameters<typeof fakeInstance>[1] = {}
): Promise<{ definition: NormalizedFlowDefinition; calls: Call[]; source: Capture }> {
  const source = capture(file);
  const header = await headerOf(source, plan);
  const fake = fakeInstance(source, { snapshots: snapshotsOf(source), ...options });
  const definition = await loadFlowFromTables(fake.ops, header, plan, {
    include_inputs: plan.include_inputs !== false,
  });
  return { definition, calls: fake.calls, source };
}

function stepsByKind(definition: NormalizedFlowDefinition, kind: NormalizedStep["kind"]) {
  return definition.steps.filter((step) => step.kind === kind);
}

function rowsOf(source: Capture, ...tables: string[]): Row[] {
  return tables.flatMap((table) => source[table]?.rows ?? []);
}

/** Rows of a hand-built flow, for the FIFO and limit tests. */
const FLOW = "f0000000000000000000000000000001";
function hid(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(31, "0")}`;
}
function huid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
function actionRow(n: number, extra: Row = {}): Row {
  return {
    sys_id: cell(hid("a", n)),
    flow: cell(FLOW, "Synthetic flow"),
    order: cell(String(n)),
    ui_id: cell(huid(n)),
    parent_ui_id: cell(""),
    action_type: cell(hid("b", n), `Synthetic action ${n}`),
    comment: cell(""),
    ...extra,
  };
}
function logicRow(n: number, name: string, extra: Row = {}): Row {
  return {
    sys_id: cell(hid("a", n)),
    flow: cell(FLOW, "Synthetic flow"),
    order: cell(String(n)),
    ui_id: cell(huid(n)),
    parent_ui_id: cell(""),
    logic_definition: cell(hid("d", n), name),
    connected_to: cell(""),
    comment: cell(""),
    ...extra,
  };
}
const HAND_HEADER: FlowHeaderRecord = {
  sys_id: FLOW,
  name: { text: "Synthetic flow" },
  description: { text: null },
  type: "flow",
  active: true,
  status: "draft",
  version: null,
  scope: "global",
};

/** A capture of a hand-built flow: only the given step tables have rows. */
function handCapture(tables: Readonly<Record<string, Row[]>>, variableValues: Row[] = []): Capture {
  const output: Capture = {
    flow: {
      rows: [
        {
          sys_id: cell(FLOW),
          name: cell("Synthetic flow"),
          type: cell("flow"),
          active: cell("true"),
          status: cell("draft"),
          version: cell(""),
          description: cell(""),
          sys_scope: cell("global"),
          label_cache: cell(""),
        },
      ],
    },
    variable_value: { rows: variableValues },
  };
  for (const [table, rows] of Object.entries(tables)) output[table] = { status: 200, rows };
  return output;
}

function expectValidDefinition(definition: NormalizedFlowDefinition) {
  expect(flowHeaderSchema.safeParse({ ...definition.header, index: 0, source: "table" }).success).toBe(true);
  for (const step of definition.steps) {
    expect(flowTextSchema.safeParse(step.title).success).toBe(true);
    expect(flowTextSchema.safeParse(step.annotation).success).toBe(true);
    if (step.condition) expect(flowTextSchema.safeParse(step.condition).success).toBe(true);
    expect(step.inputs.length).toBeLessThanOrEqual(FLOW_VIEW_LIMITS.MAX_INPUTS_PER_NODE);
    for (const input of step.inputs) expect(flowInputValueSchema.safeParse(input).success).toBe(true);
  }
  if (definition.trigger) {
    for (const key of ["type", "table", "condition", "schedule"] as const) {
      expect(flowTextSchema.safeParse(definition.trigger[key]).success).toBe(true);
    }
    for (const input of definition.trigger.inputs ?? []) {
      expect(flowInputValueSchema.safeParse(input).success).toBe(true);
    }
  }
  for (const variable of definition.variables) {
    expect(flowVariableDefSchema.safeParse({ ...variable, flow_index: 0 }).success).toBe(true);
  }
  for (const [token, label] of definition.label_cache) {
    expect(token.length).toBeLessThanOrEqual(512);
    expect(label.length).toBeLessThanOrEqual(FLOW_VIEW_LIMITS.MAX_PILL_LABEL_CHARS);
  }
}

/** The structural invariants the graph builder relies on. */
function expectForest(definition: NormalizedFlowDefinition) {
  const byUid = new Map(definition.steps.map((step) => [step.uid, step]));
  expect(byUid.size).toBe(definition.steps.length);
  for (const step of definition.steps) {
    if (step.parent_uid !== null) expect(byUid.has(step.parent_uid), step.uid).toBe(true);
    if (["else", "else_if", "catch"].includes(step.logic_kind ?? "")) {
      if (step.connected_uid !== null) {
        const head = byUid.get(step.connected_uid)!;
        expect(["if", "try"]).toContain(head.logic_kind);
        expect(step.parent_uid).toBe(head.parent_uid);
      }
    } else {
      expect(step.connected_uid).toBeNull();
    }
    if (step.logic_kind === "top_level_try" || step.logic_kind === "top_level_catch") {
      expect(step.parent_uid).toBeNull();
    }
    // No cycles: walking up always ends at a root.
    const seen = new Set<string>();
    let current: NormalizedStep | undefined = step;
    while (current && current.parent_uid !== null) {
      expect(seen.has(current.uid)).toBe(false);
      seen.add(current.uid);
      current = byUid.get(current.parent_uid);
    }
  }
}

// ---------------------------------------------------------------------------
// parseFlowOrder
// ---------------------------------------------------------------------------

describe("parseFlowOrder", () => {
  it("parses V2 integers, V1 zero and V1 arrow paths", () => {
    expect(parseFlowOrder("3")).toBe(3);
    expect(parseFlowOrder("0")).toBe(0);
    expect(parseFlowOrder(7)).toBe(7);
    expect(parseFlowOrder("100")).toBe(100);
    expect(parseFlowOrder("2➛3")).toBe(3);
    expect(parseFlowOrder("7➛8")).toBe(8);
    expect(parseFlowOrder(" 5 ➛ 6 ")).toBe(6);
    expect(parseFlowOrder("1➛2➛13")).toBe(13);
    expect(parseFlowOrder("1.5")).toBe(1.5);
    expect(parseFlowOrder("-1")).toBe(-1);
  });

  it("returns null for anything else instead of dropping the step", () => {
    for (const raw of ["", "   ", "abc", "2➛", "➛3", "2->3", "1e9", "NaN", "9".repeat(65), null, undefined, {}]) {
      expect(parseFlowOrder(raw), String(raw)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveFlowRecord
// ---------------------------------------------------------------------------

describe("resolveFlowRecord", () => {
  const F6A = capture("tables-F6a.json");
  const flowId = flowIdOf(F6A);

  it("resolves by sys_id with the exact read parameters and a projected header", async () => {
    const fixture = createMockServiceNowFixture([
      { operation: "get", response: { result: F6A.flow!.rows } },
    ]);
    const resolution = await resolveFlowRecord(fixture.operations, OPEN, { sys_id: flowId.toUpperCase() });
    fixture.assertConsumed();
    expect(fixture.calls).toEqual([
      {
        operation: "get",
        path: "/api/now/table/sys_hub_flow",
        params: {
          sysparm_query: `sys_id=${flowId}^typeINflow,subflow`,
          sysparm_fields: FIELDS.header,
          ...READ_PARAMS,
          sysparm_limit: "2",
        },
      },
    ]);
    const row = F6A.flow!.rows[0]!;
    expect(resolution).toEqual({
      status: "found",
      header: {
        sys_id: flowId,
        name: { text: row.name!.value },
        description: { text: row.description!.value },
        type: "flow",
        active: true,
        status: "published",
        version: null,
        scope: row.sys_scope!.display_value,
      },
    });
    if (resolution.status === "found") {
      expect(flowHeaderSchema.safeParse({ ...resolution.header, index: 0, source: "table" }).success).toBe(true);
    }
  });

  it("never requests label_cache while resolving", async () => {
    const { ops, calls } = fakeInstance(F6A);
    await resolveFlowRecord(ops, OPEN, { sys_id: flowId });
    await resolveFlowRecord(ops, OPEN, { name: F6A.flow!.rows[0]!.name!.value });
    for (const call of calls) expect(call.params.sysparm_fields).not.toContain("label_cache");
  });

  it("returns not_found for an invalid sys_id without reading", async () => {
    const fixture = createMockServiceNowFixture([]);
    expect(await resolveFlowRecord(fixture.operations, OPEN, { sys_id: "not-a-sys-id" })).toEqual({
      status: "not_found",
    });
    expect(await resolveFlowRecord(fixture.operations, OPEN, { name: "   " })).toEqual({ status: "not_found" });
    expect(await resolveFlowRecord(fixture.operations, OPEN, { name: "x".repeat(101) })).toEqual({
      status: "not_found",
    });
    expect(fixture.calls).toEqual([]);
  });

  it("drops rows whose sys_id or type do not match", async () => {
    const row = F6A.flow!.rows[0]!;
    const fixture = createMockServiceNowFixture([
      { operation: "get", response: { result: [{ ...row, sys_id: cell(hid("c", 1)) }] } },
      { operation: "get", response: { result: [{ ...row, type: cell("action") }] } },
    ]);
    expect(await resolveFlowRecord(fixture.operations, OPEN, { sys_id: flowId })).toEqual({ status: "not_found" });
    expect(await resolveFlowRecord(fixture.operations, OPEN, { sys_id: flowId })).toEqual({ status: "not_found" });
  });

  it("escapes the name, asks for six rows and post-filters exactly (case-sensitive)", async () => {
    const row = F6A.flow!.rows[0]!;
    const named = (name: string, n: number) => ({ ...row, sys_id: cell(hid("c", n)), name: cell(name) });
    const fixture = createMockServiceNowFixture([
      { operation: "get", response: { result: [named("route incident", 1), named("Route incident", 2)] } },
      { operation: "get", response: { result: [named("AORactive=false", 3)] } },
      { operation: "get", response: { result: [named("payload", 4)] } },
    ]);
    expect(await resolveFlowRecord(fixture.operations, OPEN, { name: "Route incident" })).toMatchObject({
      status: "found",
      header: { sys_id: hid("c", 2), name: { text: "Route incident" } },
    });
    // `^` is stripped from the query, and the exact post-filter rejects the stripped match.
    expect(await resolveFlowRecord(fixture.operations, OPEN, { name: "A^ORactive=false" })).toEqual({
      status: "not_found",
    });
    expect(await resolveFlowRecord(fixture.operations, OPEN, { name: "javascript:payload" })).toEqual({
      status: "not_found",
    });
    expect(fixture.calls.map((call) => call.params)).toEqual([
      {
        sysparm_query: "name=Route incident^typeINflow,subflow^ORDERBYsys_id",
        sysparm_fields: FIELDS.header,
        ...READ_PARAMS,
        sysparm_limit: String(FLOW_NAME_LOOKUP_LIMIT),
      },
      {
        sysparm_query: "name=AORactive=false^typeINflow,subflow^ORDERBYsys_id",
        sysparm_fields: FIELDS.header,
        ...READ_PARAMS,
        sysparm_limit: "6",
      },
      {
        sysparm_query: "name=payload^typeINflow,subflow^ORDERBYsys_id",
        sysparm_fields: FIELDS.header,
        ...READ_PARAMS,
        sysparm_limit: "6",
      },
    ]);
  });

  it("reports an ambiguous name with at most five candidates", async () => {
    const row = F6A.flow!.rows[0]!;
    const rows = Array.from({ length: 6 }, (_, index) => ({ ...row, sys_id: cell(hid("c", index + 1)), name: cell("Same") }));
    const fixture = createMockServiceNowFixture([
      { operation: "get", response: { result: rows } },
      { operation: "get", response: { result: rows.slice(0, 2) } },
      { operation: "get", response: { result: [] } },
    ]);
    expect(await resolveFlowRecord(fixture.operations, OPEN, { name: "Same" })).toEqual({
      status: "ambiguous",
      candidates: [1, 2, 3, 4, 5].map((n) => hid("c", n)),
    });
    expect(await resolveFlowRecord(fixture.operations, OPEN, { name: "Same" })).toEqual({
      status: "ambiguous",
      candidates: [hid("c", 1), hid("c", 2)],
    });
    expect(await resolveFlowRecord(fixture.operations, OPEN, { name: "Same" })).toEqual({ status: "not_found" });
  });

  it("projects the header through field policy", async () => {
    const plan = planFor({
      omit: [
        ["sys_hub_flow", "description"],
        ["sys_hub_flow", "status"],
        ["sys_hub_flow", "active"],
        ["sys_hub_flow", "sys_scope"],
      ],
    });
    const { ops, calls } = fakeInstance(F6A);
    const resolution = await resolveFlowRecord(ops, plan, { sys_id: flowId });
    expect(calls[0]!.params.sysparm_fields).toBe("sys_id,name,type,version");
    expect(resolution).toMatchObject({
      status: "found",
      header: {
        description: { text: null, redacted: "field_policy" },
        status: null,
        active: null,
        scope: null,
        type: "flow",
      },
    });
  });

  it("bypasses the metadata cache", async () => {
    const { ops, calls } = fakeInstance(F6A);
    const cached = createCachedServiceNowOperations(ops, "flow-view-table-test", { tables: ["sys_hub*"] });
    expect(cached).not.toBe(ops);
    const resolution = await resolveFlowRecord(cached, OPEN, { sys_id: flowId });
    expect(resolution.status).toBe("found");
    // A cached read would have gone through getWithMeta (and a watermark read).
    expect(calls).toHaveLength(1);
    if (resolution.status !== "found") return;
    const before = calls.length;
    const definition = await loadFlowFromTables(cached, resolution.header, OPEN, { include_inputs: true });
    expect(definition.steps.length).toBeGreaterThan(0);
    expect(calls.length - before).toBeGreaterThan(10);
    expect(calls.every((call) => call.path.startsWith("/api/now/table/"))).toBe(true);
    const snapshotCall = calls.find((call) => call.path.endsWith("/sys_hub_flow_snapshot"));
    expect(snapshotCall).toBeDefined();
    expect(await resolveSubflowTarget(cached, OPEN, hid("5", 1))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSubflowTarget
// ---------------------------------------------------------------------------

describe("resolveSubflowTarget", () => {
  const snapshot = hid("5", 1);
  const parent = hid("6", 1);

  it("follows the snapshot's parent_flow", async () => {
    const fixture = createMockServiceNowFixture([
      { operation: "get", response: { result: [{ sys_id: cell(snapshot), parent_flow: cell(parent, "Synthetic") }] } },
    ]);
    expect(await resolveSubflowTarget(fixture.operations, OPEN, snapshot.toUpperCase())).toBe(parent);
    expect(fixture.calls[0]).toEqual({
      operation: "get",
      path: "/api/now/table/sys_hub_flow_snapshot",
      params: {
        sysparm_query: `sys_idIN${snapshot}^ORDERBYsys_id`,
        sysparm_fields: "sys_id,parent_flow",
        ...READ_PARAMS,
        sysparm_limit: "501",
      },
    });
  });

  it("returns null for a bad reference, a missing snapshot or a bad parent", async () => {
    const fixture = createMockServiceNowFixture([
      { operation: "get", response: { result: [] } },
      { operation: "get", response: { result: [{ sys_id: cell(snapshot), parent_flow: cell("") }] } },
      { operation: "get", response: { result: [{ sys_id: cell(hid("5", 2)), parent_flow: cell(parent) }] } },
    ]);
    expect(await resolveSubflowTarget(fixture.operations, OPEN, "nope")).toBeNull();
    expect(await resolveSubflowTarget(fixture.operations, OPEN, snapshot)).toBeNull();
    expect(await resolveSubflowTarget(fixture.operations, OPEN, snapshot)).toBeNull();
    expect(await resolveSubflowTarget(fixture.operations, OPEN, snapshot)).toBeNull();
    fixture.assertConsumed();
  });

  it("does not read when the snapshot's parent_flow is not readable", async () => {
    const fixture = createMockServiceNowFixture([]);
    const plan = planFor({ omit: [["sys_hub_flow_snapshot", "parent_flow"]] });
    expect(await resolveSubflowTarget(fixture.operations, plan, snapshot)).toBeNull();
    expect(fixture.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadFlowFromTables: reads
// ---------------------------------------------------------------------------

describe("loadFlowFromTables reads", () => {
  it("reads in the fixed sequential order with the exact parameters (F6a, V1)", async () => {
    const { calls, source, definition } = await load("tables-F6a.json");
    const flowId = flowIdOf(source);
    const steps = (`flow=${flowId}^ORDERBYorder^ORDERBYsys_id`);
    const snapshot = source.sys_hub_sub_flow_instance!.rows[0]!.subflow!.value;
    // Document keys in read order: the trigger, then V1 actions, logic, subflows.
    const documents = [
      source.sys_hub_trigger_instance!.rows[0]!.sys_id!.value,
      ...rowsOf(source, "sys_hub_action_instance", "sys_hub_flow_logic", "sys_hub_sub_flow_instance").map(
        (row) => row.sys_id!.value
      ),
    ];
    expect(new Set(documents)).toEqual(
      new Set([source.sys_hub_trigger_instance!.rows[0]!.sys_id!.value, ...definition.steps.map((step) => step.ref!.sys_id)])
    );
    const variables = [...new Set(source.variable_value!.rows.map((row) => row.variable!.value))];
    const read = (table: string, query: string, fields: string, limit = "501", raw = false) => ({
      path: `/api/now/table/${table}`,
      params: {
        sysparm_query: query,
        sysparm_fields: fields,
        ...READ_PARAMS,
        ...(raw ? { sysparm_display_value: "false" } : {}),
        sysparm_limit: limit,
      },
    });
    // Wave 1 (issued together, in this order), then wave 2. Blob columns are
    // never in the structural reads; F6a has no V2 rows, so no blob reads.
    expect(calls.map(({ path, params }) => ({ path, params }))).toEqual([
      read("sys_hub_flow", `sys_id=${flowId}`, "sys_id,label_cache", "2", true),
      read("sys_hub_trigger_instance", `flow=${flowId}^ORDERBYsys_id`, FIELDS.trigger),
      read("sys_hub_trigger_instance_v2", `flow=${flowId}^ORDERBYsys_id`, FIELDS.trigger),
      read("sys_hub_action_instance", steps, FIELDS.action),
      read("sys_hub_action_instance_v2", steps, FIELDS.action),
      read("sys_hub_flow_logic", steps, FIELDS.logic),
      read("sys_hub_flow_logic_instance_v2", steps, FIELDS.logic),
      read("sys_hub_sub_flow_instance", steps, FIELDS.subflow),
      read("sys_hub_sub_flow_instance_v2", steps, FIELDS.subflow),
      read("sys_hub_flow_variable", `model=${flowId}^ORDERBYorder^ORDERBYsys_id`, FIELDS.io),
      read("sys_hub_flow_input", `model=${flowId}^ORDERBYorder^ORDERBYsys_id`, FIELDS.io),
      read("sys_hub_flow_output", `model=${flowId}^ORDERBYorder^ORDERBYsys_id`, FIELDS.io),
      read("sys_hub_flow_snapshot", `sys_idIN${snapshot}^ORDERBYsys_id`, "sys_id,parent_flow"),
      read("sys_variable_value", `document_keyIN${documents.join(",")}^ORDERBYorder^ORDERBYsys_id`, FIELDS.value),
      read("var_dictionary", `sys_idIN${variables.join(",")}^ORDERBYsys_id`, FIELDS.dictionary),
    ]);
  });

  it("consumes a FIFO mock exactly, skipping reads with nothing to look up", async () => {
    const empty: MockServiceNowStep = { operation: "get", response: { result: [] } };
    const blob = gz([{ name: "short_description", value: "Synthetic", displayValue: "Synthetic" }]);
    const fixture = createMockServiceNowFixture([
      { operation: "get", response: { result: [{ sys_id: FLOW, label_cache: "[]" }] } },
      empty, // trigger v1
      empty, // trigger v2
      empty, // action v1
      { operation: "get", response: { result: [actionRow(1)] } },
      empty, // logic v1
      empty, // logic v2
      empty, // subflow v1
      empty, // subflow v2
      empty, // variables
      empty, // inputs
      empty, // outputs
      // Wave 2: the raw value column of the one non-empty V2 table.
      { operation: "get", response: { result: [{ sys_id: hid("a", 1), values: blob }] } },
    ]);
    const definition = await loadFlowFromTables(fixture.operations, HAND_HEADER, OPEN, { include_inputs: true });
    fixture.assertConsumed();
    expect(definition.steps).toHaveLength(1);
    expect(definition.steps[0]!.inputs).toEqual([
      { name: "short_description", label: null, type: null, value: "Synthetic" },
    ]);
  });

  it("does no value reads and omits every input when include_inputs is false", async () => {
    for (const file of ["tables-F6a.json", "tables-F1.json"]) {
      const { definition, calls } = await load(file, NO_INPUTS);
      const tables = calls.map((call) => call.path.replace("/api/now/table/", ""));
      expect(tables).not.toContain("sys_variable_value");
      expect(tables).not.toContain("var_dictionary");
      expect(tables.filter((table) => table === "sys_hub_flow")).toEqual([]);
      for (const call of calls) {
        expect(call.params.sysparm_fields).not.toMatch(/(?:^|,)(?:values|trigger_inputs|subflow_inputs|value|label_cache)(?:,|$)/u);
      }
      for (const step of definition.steps) {
        expect(step.inputs).toEqual([]);
        if (step.condition) expect(step.condition).toEqual({ text: null, redacted: "not_requested" });
      }
      expect(definition.label_cache).toEqual([]);
      if (definition.trigger) {
        expect(definition.trigger.inputs).toBeUndefined();
        expect(definition.trigger.table).toEqual({ text: null, redacted: "not_requested" });
      }
    }
  });

  it("treats inputs as excluded when either the plan or the options exclude them", async () => {
    const { definition, calls } = await (async () => {
      const source = capture("tables-F6a.json");
      const fake = fakeInstance(source, { snapshots: snapshotsOf(source) });
      const header = await headerOf(source);
      return {
        definition: await loadFlowFromTables(fake.ops, header, OPEN, { include_inputs: false }),
        calls: fake.calls,
      };
    })();
    expect(calls.some((call) => call.path.endsWith("/sys_variable_value"))).toBe(false);
    expect(calls.some((call) => /(?:^|,)values(?:,|$)/u.test(call.params.sysparm_fields ?? ""))).toBe(false);
    expect(definition.steps.every((step) => step.inputs.length === 0)).toBe(true);
  });

  it("treats a missing _v2 table (HTTP 400) as zero rows", async () => {
    const source = capture("tables-F6a.json");
    for (const table of ["sys_hub_trigger_instance_v2", "sys_hub_action_instance_v2", "sys_hub_flow_logic_instance_v2", "sys_hub_sub_flow_instance_v2"]) {
      source[table] = { status: 400, rows: [] };
    }
    const header = await headerOf(source);
    const fake = fakeInstance(source, { snapshots: snapshotsOf(source) });
    const definition = await loadFlowFromTables(fake.ops, header, OPEN, { include_inputs: true });
    expect(definition.steps).toHaveLength(10);
    expect(definition.warnings).toEqual([]);
  });

  it("propagates every other upstream error, and a 400 on a V1 table", async () => {
    const source = capture("tables-F6a.json");
    const header = await headerOf(source);
    for (const [table, error] of [
      ["sys_hub_action_instance", MISSING_TABLE],
      ["sys_hub_action_instance_v2", createToolError("authorization", "retry_after_correction")],
      ["sys_hub_flow_logic_instance_v2", createToolError("upstream", "retry_if_safe_and_idempotent")],
      ["sys_variable_value", createToolError("timeout", "retry_if_safe_and_idempotent")],
      ["sys_hub_flow_input", new RangeError("budget")],
    ] as const) {
      const fake = fakeInstance(source, { snapshots: snapshotsOf(source), errors: { [table]: error } });
      await expect(loadFlowFromTables(fake.ops, header, OPEN, { include_inputs: true }), table).rejects.toBe(error);
    }
  });

  it("rejects a malformed response and an invalid header sys_id", async () => {
    const fixture = createMockServiceNowFixture([{ operation: "get", response: { result: "nope" } }]);
    await expect(
      loadFlowFromTables(fixture.operations, HAND_HEADER, NO_INPUTS, { include_inputs: false })
    ).rejects.toThrow(/ServiceNow could not complete the request/u);
    await expect(
      loadFlowFromTables(createMockServiceNowFixture([]).operations, { ...HAND_HEADER, sys_id: "x" }, OPEN, {
        include_inputs: true,
      })
    ).rejects.toThrow(/unexpectedly/u);
  });

  it("keeps 500 rows of a table that returns the 501st sentinel row", async () => {
    const spec = adversarial<{ flow: string; count: number; template: Row }>("oversized.json");
    expect(spec.flow).toBe(FLOW);
    const rows = Array.from({ length: spec.count }, (_, index) => ({
      ...spec.template,
      sys_id: cell(hid("a", index + 1)),
      ui_id: cell(huid(index + 1)),
    }));
    const fake = fakeInstance(handCapture({ sys_hub_action_instance: rows }));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, NO_INPUTS, { include_inputs: false });
    const actionCall = fake.calls.find((call) => call.path.endsWith("/sys_hub_action_instance"))!;
    expect(actionCall.params.sysparm_limit).toBe("501");
    expect(definition.steps).toHaveLength(FLOW_VIEW_LIMITS.MAX_ROWS_PER_TABLE);
    expect(definition.limits_hit).toEqual(["rows_per_table"]);
    const exact = await loadFlowFromTables(
      fakeInstance(handCapture({ sys_hub_action_instance: rows.slice(0, 500) })).ops,
      HAND_HEADER,
      NO_INPUTS,
      { include_inputs: false }
    );
    expect(exact.steps).toHaveLength(500);
    expect(exact.limits_hit).toEqual([]);
  });

  it("chunks sys_variable_value and var_dictionary reads at 100 ids", async () => {
    const actions = Array.from({ length: 150 }, (_, index) => actionRow(index + 1));
    const values = actions.map((row, index) => ({
      sys_id: cell(hid("9", index + 1)),
      document: cell("sys_hub_action_instance"),
      document_key: cell(row.sys_id!.value),
      variable: cell(hid("7", index + 1), `Field ${index + 1}`),
      order: cell("1"),
      value: cell(`value ${index + 1}`),
    }));
    const fake = fakeInstance(handCapture({ sys_hub_action_instance: actions }, values));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    const valueCalls = fake.calls.filter((call) => call.path.endsWith("/sys_variable_value"));
    const dictionaryCalls = fake.calls.filter((call) => call.path.endsWith("/var_dictionary"));
    const idCount = (call: Call) => /IN([0-9a-f,]+)\^/u.exec(call.params.sysparm_query!)![1]!.split(",").length;
    expect(valueCalls.map(idCount)).toEqual([100, 50]);
    expect(dictionaryCalls.map(idCount)).toEqual([100, 50]);
    expect(definition.steps.every((step) => step.inputs.length === 1)).toBe(true);
    expect(definition.steps[149]!.inputs).toEqual([
      { name: "field_150", label: "Field 150", type: "string", value: "value 150" },
    ]);
  });

  it("pages sys_variable_value past the row cap instead of losing values", async () => {
    const actions = Array.from({ length: 30 }, (_, index) => actionRow(index + 1));
    const values = actions.flatMap((row, step) =>
      Array.from({ length: 25 }, (_, n) => ({
        sys_id: cell(hid("9", step * 100 + n + 1)),
        document: cell("sys_hub_action_instance"),
        document_key: cell(row.sys_id!.value),
        variable: cell(hid("7", n + 1), `Field ${n + 1}`),
        order: cell(String(n + 1)),
        value: cell(`value ${step}.${n}`),
      }))
    );
    const fake = fakeInstance(handCapture({ sys_hub_action_instance: actions }, values));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    const valueCalls = fake.calls.filter((call) => call.path.endsWith("/sys_variable_value"));
    // 750 rows: a full page with its sentinel, then the rest from offset 500.
    expect(valueCalls.map((call) => call.params.sysparm_offset)).toEqual([undefined, "500"]);
    expect(definition.steps.every((step) => step.inputs.length === 25)).toBe(true);
    expect(definition.warnings).not.toContain("input_values_incomplete");
    expect(definition.limits_hit).not.toContain("rows_per_table");
  });

  it("warns when a V1 chunk holds more values than its steps can show", async () => {
    // 10 steps x 60 values: more than 10 x MAX_INPUTS_PER_NODE (400) fit one page.
    const actions = Array.from({ length: 10 }, (_, index) => actionRow(index + 1));
    const values = actions.flatMap((row, step) =>
      Array.from({ length: 60 }, (_, n) => ({
        sys_id: cell(hid("9", step * 100 + n + 1)),
        document: cell("sys_hub_action_instance"),
        document_key: cell(row.sys_id!.value),
        variable: cell(hid("7", n + 1), `Field ${n + 1}`),
        order: cell(String(n + 1)),
        value: cell(`value ${step}.${n}`),
      }))
    );
    const fake = fakeInstance(handCapture({ sys_hub_action_instance: actions }, values));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    expect(fake.calls.filter((call) => call.path.endsWith("/sys_variable_value"))).toHaveLength(1);
    expect(definition.warnings).toContain("input_values_incomplete");
    expect(definition.limits_hit).toContain("rows_per_table");
  });

  /** V1 action steps with `perStep` stored values of `chars` characters each. */
  function v1Flow(steps: number, perStep: number, chars: number) {
    const actions = Array.from({ length: steps }, (_, index) => actionRow(index + 1));
    const values = actions.flatMap((row, step) =>
      Array.from({ length: perStep }, (_, n) => ({
        sys_id: cell(hid("9", step * 100 + n + 1)),
        document: cell("sys_hub_action_instance"),
        document_key: cell(row.sys_id!.value),
        variable: cell(hid("7", n + 1), `Field ${n + 1}`),
        order: cell(String(n + 1)),
        value: cell("w".repeat(chars)),
      }))
    );
    return handCapture({ sys_hub_action_instance: actions }, values);
  }
  const loadBytes = (calls: readonly Call[]) => calls.reduce((sum, call) => sum + (call.bytes ?? 0), 0);

  it("stops V1 value reads across chunks before they would overflow the scope, keeping what was read", async () => {
    // 200 steps x 10 values of 400 characters: each 500-row page is ~0.5 MB.
    const fake = fakeInstance(v1Flow(200, 10, 400));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    const valueCalls = fake.calls.filter((call) => call.path.endsWith("/sys_variable_value"));
    // The second chunk's first page would pass the scope's share: not read.
    expect(valueCalls).toHaveLength(1);
    expect(definition.warnings).toContain("input_values_incomplete");
    expect(definition.limits_hit).toContain("rows_per_table");
    const withInputs = definition.steps.filter((step) => step.inputs.length > 0);
    expect(withInputs.length).toBe(50);
    expect(withInputs.every((step) => step.inputs.length === 10)).toBe(true);
    expect(loadBytes(fake.calls)).toBeLessThan(1_048_576);
  });

  it("keeps many V1 steps' values within the scope instead of losing them all (500 steps x 5 values)", async () => {
    const fake = fakeInstance(v1Flow(500, 5, 60));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    const valueCalls = fake.calls.filter((call) => call.path.endsWith("/sys_variable_value"));
    // Five 100-step chunks; reads stop before the scope would overflow.
    expect(valueCalls.length).toBeGreaterThan(1);
    expect(valueCalls.length).toBeLessThan(5);
    expect(definition.warnings).toContain("input_values_incomplete");
    const withInputs = definition.steps.filter((step) => step.inputs.length > 0);
    expect(withInputs.length).toBe(valueCalls.length * 100);
    expect(withInputs.every((step) => step.inputs.length === 5)).toBe(true);
    expect(loadBytes(fake.calls)).toBeLessThan(1_048_576);
  });

  it("pages V1 values while the scope has room (30 steps x 60 values)", async () => {
    const fake = fakeInstance(v1Flow(30, 60, 60));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    const valueCalls = fake.calls.filter((call) => call.path.endsWith("/sys_variable_value"));
    // 1,800 rows; three pages cover the 40 values a step can show for 25 steps.
    expect(valueCalls.map((call) => call.params.sysparm_offset)).toEqual([undefined, "500", "1000"]);
    const withInputs = definition.steps.filter((step) => step.inputs.length > 0);
    expect(withInputs.length).toBe(25);
    expect(withInputs.every((step) => step.inputs.length === FLOW_VIEW_LIMITS.MAX_INPUTS_PER_NODE)).toBe(true);
    expect(definition.warnings).toContain("input_values_incomplete");
    expect(loadBytes(fake.calls)).toBeLessThan(1_048_576);
  });

  it("reads V2 value blobs raw, in a separate read, and only for tables with rows", async () => {
    const { calls, definition } = await load("tables-F1.json");
    const raw = calls.filter((call) => call.params.sysparm_display_value === "false");
    expect(raw.map((call) => [call.path.replace("/api/now/table/", ""), call.params.sysparm_fields])).toEqual([
      ["sys_hub_flow", "sys_id,label_cache"],
      ["sys_hub_trigger_instance_v2", "sys_id,trigger_inputs"],
      ["sys_hub_action_instance_v2", "sys_id,values"],
      ["sys_hub_flow_logic_instance_v2", "sys_id,values"],
    ]);
    for (const call of calls.filter((candidate) => candidate.params.sysparm_display_value === "all")) {
      expect(call.params.sysparm_fields).not.toMatch(/(?:^|,)(?:values|trigger_inputs|subflow_inputs|label_cache)(?:,|$)/u);
    }
    expect(definition.steps.some((step) => step.inputs.length > 0)).toBe(true);
    expect(definition.trigger!.inputs!.length).toBeGreaterThan(0);
  });

  it("skips the label read when the header read already carried label_cache", async () => {
    const source = capture("tables-F1.json");
    const { ops } = fakeInstance(source);
    const resolution = await resolveFlowRecord(ops, OPEN, { sys_id: flowIdOf(source) }, { withLabelCache: { include_inputs: true } });
    if (resolution.status !== "found") throw new Error("not found");
    expect(resolution.label_cache).toBe(source.flow!.rows[0]!.label_cache!.value);
    const fake = fakeInstance(source);
    const withLabels = await loadFlowFromTables(fake.ops, resolution.header, OPEN, {
      include_inputs: true,
      label_cache: resolution.label_cache!,
    });
    expect(fake.calls.some((call) => call.path.endsWith("/sys_hub_flow"))).toBe(false);
    const separate = await load("tables-F1.json");
    expect(withLabels.label_cache).toEqual(separate.definition.label_cache);
    // A name lookup never asks for it.
    const byName = await resolveFlowRecord(ops, OPEN, { name: source.flow!.rows[0]!.name!.value }, {
      withLabelCache: { include_inputs: true },
    });
    expect(byName).not.toHaveProperty("label_cache");
  });

  it("post-filters V1 values by document table and key", async () => {
    const action = actionRow(1);
    const value = (n: number, extra: Row) => ({
      sys_id: cell(hid("9", n)),
      document: cell("sys_hub_action_instance"),
      document_key: cell(action.sys_id!.value),
      variable: cell(hid("7", n), `Field ${n}`),
      order: cell(String(n)),
      value: cell(`value ${n}`),
      ...extra,
    });
    const values = [
      value(1, {}),
      value(2, { document: cell("sys_hub_flow_logic") }),
      value(3, { document_key: cell(hid("a", 99)) }),
      value(4, { variable: cell("bad") }),
    ];
    const fixture = createMockServiceNowFixture([
      ...Array.from({ length: 2 }, (): MockServiceNowStep => ({ operation: "get", response: { result: [] } })),
      // The server returned a row of another flow too: post-filtered and counted.
      { operation: "get", response: { result: [action, actionRow(2, { flow: cell(hid("f", 2)) })] } },
      ...Array.from({ length: 8 }, (): MockServiceNowStep => ({ operation: "get", response: { result: [] } })),
      { operation: "get", response: { result: values } },
      {
        operation: "get",
        response: { result: [{ sys_id: cell(hid("7", 1)), element: cell("field_1"), internal_type: cell("string") }] },
      },
    ]);
    const plan = planFor({ omit: [["sys_hub_flow", "label_cache"]] });
    const definition = await loadFlowFromTables(fixture.operations, HAND_HEADER, plan, { include_inputs: true });
    fixture.assertConsumed();
    expect(definition.steps).toHaveLength(1);
    expect(definition.steps[0]!.inputs).toEqual([{ name: "field_1", label: "Field 1", type: "string", value: "value 1" }]);
    expect(definition.items_dropped).toBe(4);
    expect(definition.warnings).toEqual(expect.arrayContaining(["label_cache_unavailable", "items_dropped_invalid"]));
  });
});

// ---------------------------------------------------------------------------
// loadFlowFromTables: the captured flows
// ---------------------------------------------------------------------------

describe("loadFlowFromTables on the Brazil captures", () => {
  it.each(CAPTURE_FILES)("%s loads into a valid, policy-projected forest", async (file) => {
    const { definition, source, calls } = await load(file);
    // Table API GETs on the closure only: never ProcessFlow, never the history table.
    const closure = new Set<string>(FLOW_VIEW_TABLES);
    for (const call of calls) {
      const match = /^\/api\/now\/table\/([a-z0-9_]+)$/u.exec(call.path);
      expect(match && closure.has(match[1]!), call.path).toBe(true);
      expect(call.path).not.toMatch(/processflow|sys_hub_flow_version/u);
    }
    expect(definition.source).toBe("table");
    expect(definition.warnings).toEqual([]);
    expect(definition.items_dropped).toBe(0);
    expect(definition.limits_hit).toEqual([]);
    expectValidDefinition(definition);
    expectForest(definition);
    const uids = new Set(
      rowsOf(
        source,
        "sys_hub_action_instance",
        "sys_hub_action_instance_v2",
        "sys_hub_flow_logic",
        "sys_hub_flow_logic_instance_v2",
        "sys_hub_sub_flow_instance",
        "sys_hub_sub_flow_instance_v2"
      ).map((row) => row.ui_id!.value)
    );
    expect(definition.steps.map((step) => step.uid).sort()).toEqual([...uids].sort());
    for (const step of definition.steps) {
      expect(step.logic_kind).not.toBe("other");
      expect(step.ref).toBeDefined();
    }
  });

  it("keeps every captured parent, and pairs every branch through connected_to", async () => {
    let paired = 0;
    for (const file of CAPTURE_FILES) {
      const { definition, source } = await load(file);
      const byUid = new Map(definition.steps.map((step) => [step.uid, step]));
      for (const row of rowsOf(source, "sys_hub_flow_logic", "sys_hub_flow_logic_instance_v2", "sys_hub_action_instance", "sys_hub_action_instance_v2", "sys_hub_sub_flow_instance", "sys_hub_sub_flow_instance_v2")) {
        const step = byUid.get(row.ui_id!.value)!;
        expect(step.parent_uid ?? "").toBe(row.parent_ui_id!.value);
        const kind = row.logic_definition ? flowLogicKindFromName(row.logic_definition.display_value) : undefined;
        if (kind === "else" || kind === "else_if" || kind === "catch") {
          expect(step.connected_uid).toBe(row.connected_to!.value);
          paired += 1;
        }
      }
    }
    expect(paired).toBeGreaterThan(10);
  });

  it("parses V1 arrow orders and order 0 instead of dropping them", async () => {
    const f6a = await load("tables-F6a.json");
    const orders = new Map(
      rowsOf(f6a.source, "sys_hub_action_instance", "sys_hub_sub_flow_instance").map((row) => [row.ui_id!.value, row.order!.value])
    );
    const arrow = f6a.definition.steps.filter((step) => orders.get(step.uid)?.includes("➛"));
    expect(arrow.map((step) => [orders.get(step.uid), step.order])).toEqual(
      expect.arrayContaining([
        ["2➛3", 3],
        ["7➛8", 8],
      ])
    );
    const f5 = await load("tables-F5.json");
    const first = f5.definition.steps[0]!;
    expect(first.order).toBe(0);
    expect(first.logic_kind).toBe("top_level_try");
    expect(f5.definition.steps.every((step) => step.order !== null)).toBe(true);
  });

  it("models Parallel, Top Level Try/Catch and End as captured", async () => {
    const f6a = (await load("tables-F6a.json")).definition;
    const parallel = f6a.steps.find((step) => step.logic_kind === "parallel")!;
    expect(parallel.parent_uid).toBeNull();
    const branches = f6a.steps.filter((step) => step.logic_kind === "parallel_branch");
    expect(branches).toHaveLength(2);
    for (const branch of branches) expect(branch.parent_uid).toBe(parallel.uid);
    // End rows are children of the block they close (each Parallel Branch here).
    const ends = f6a.steps.filter((step) => step.logic_kind === "end_flow");
    expect(ends.map((end) => end.parent_uid).sort()).toEqual(branches.map((branch) => branch.uid).sort());

    const f5 = (await load("tables-F5.json")).definition;
    const roots = f5.steps.filter((step) => step.parent_uid === null).map((step) => step.logic_kind);
    expect(roots).toEqual(["top_level_try", "top_level_catch"]);
    const tryUid = f5.steps[0]!.uid;
    const elseInTry = f5.steps.find((step) => step.logic_kind === "else" && step.parent_uid === tryUid)!;
    expect(f5.steps.find((step) => step.uid === elseInTry.connected_uid)!.logic_kind).toBe("if");

    const f1 = (await load("tables-F1.json")).definition;
    // Consecutive Else Ifs point at the head If, never at the previous branch.
    const f1ByUid = new Map(f1.steps.map((step) => [step.uid, step]));
    const elseIfs = f1.steps.filter((step) => step.logic_kind === "else_if");
    expect(elseIfs.length).toBeGreaterThanOrEqual(5);
    for (const step of elseIfs) expect(f1ByUid.get(step.connected_uid!)!.logic_kind).toBe("if");
    const perHead = new Map<string, number>();
    for (const step of elseIfs) perHead.set(step.connected_uid!, (perHead.get(step.connected_uid!) ?? 0) + 1);
    expect(Math.max(...perHead.values())).toBe(2);
  });

  it("prefers the V2 copy of a step stored in both V1 and V2 (F4)", async () => {
    const { definition, calls } = await load("tables-F4.json");
    expect(stepsByKind(definition, "action")).toHaveLength(5);
    expect(stepsByKind(definition, "logic")).toHaveLength(15);
    expect(stepsByKind(definition, "subflow")).toHaveLength(1);
    for (const step of definition.steps) expect(step.ref!.table.endsWith("_v2")).toBe(true);
    // Every V1 row was superseded, so no V1 value read happens.
    expect(calls.some((call) => call.path.endsWith("/sys_variable_value"))).toBe(false);
  });

  it("never shows a password2 value and types flow I/O from internal_type (F4)", async () => {
    const { definition } = await load("tables-F4.json");
    const inputs = [...definition.steps.flatMap((step) => step.inputs)];
    const passwords = inputs.filter((input) => input.type === "password2");
    expect(passwords.length).toBeGreaterThan(0);
    for (const input of passwords) {
      expect(input.value).toBeNull();
      expect(["sensitive_type", "sensitive_name"]).toContain(input.redacted);
    }
    expect(JSON.stringify(definition)).not.toContain("********");
    const flowInputs = definition.variables.filter((variable) => variable.scope === "input");
    expect(flowInputs.map((variable) => variable.type)).toEqual(["reference", "password2", "password2"]);
    expect(definition.variables.filter((variable) => variable.scope === "output")).toHaveLength(2);
  });

  it("decodes V2 logic values into inputs and a condition, and V2 trigger_inputs (F1)", async () => {
    const { definition, source } = await load("tables-F1.json");
    const logicRows = source.sys_hub_flow_logic_instance_v2!.rows;
    const withLabel = logicRows.find((row) => {
      const decoded = decode(row.values!.value) as { inputs?: { name: string; displayValue?: string }[] };
      return decoded.inputs?.some((input) => input.name === "condition_name" && input.displayValue);
    })!;
    const label = (decode(withLabel.values!.value) as { inputs: { name: string; displayValue: string }[] }).inputs.find(
      (input) => input.name === "condition_name"
    )!.displayValue;
    const step = definition.steps.find((candidate) => candidate.uid === withLabel.ui_id!.value)!;
    expect(["if", "else_if"]).toContain(step.logic_kind);
    expect(step.condition).toEqual({ text: label });
    expect(step.inputs.map((input) => input.name)).toEqual(["condition_name", "condition"]);

    const trigger = source.sys_hub_trigger_instance_v2!.rows[0]!;
    const table = (decode(trigger.trigger_inputs!.value) as { name: string; displayValue: string }[]).find(
      (input) => input.name === "table"
    )!;
    expect(definition.trigger).toMatchObject({
      type: { text: trigger.trigger_type!.display_value },
      table: { text: table.displayValue },
      schedule: { text: null },
    });
    expect(definition.trigger!.inputs!.length).toBeGreaterThan(1);
  });

  it("reads V1 values from sys_variable_value, typed by var_dictionary (F6a)", async () => {
    const { definition, source } = await load("tables-F6a.json");
    const triggerId = source.sys_hub_trigger_instance!.rows[0]!.sys_id!.value;
    const triggerValues = source.variable_value!.rows.filter((row) => row.document_key!.value === triggerId);
    const tableValue = triggerValues.find((row) => row.variable!.display_value === "Table")!.value!.value;
    const condition = triggerValues.find((row) => row.variable!.display_value === "Condition")!.value!.value;
    expect(definition.trigger).toMatchObject({ table: { text: tableValue }, condition: { text: condition } });
    expect(definition.trigger!.inputs).toHaveLength(triggerValues.length);
    const action = definition.steps.find((step) => step.order === 3)!;
    expect(action.inputs.map((input) => input.label)).toEqual(["Table", expect.any(String)]);
    expect(action.inputs[0]).toMatchObject({ name: "table", type: "string" });
  });

  it("redacts a V1 password2 value by its var_dictionary type", async () => {
    const source = capture("tables-F6a.json");
    const variable = source.variable_value!.rows.find((row) => row.variable!.display_value === "Condition")!.variable!.value;
    const header = await headerOf(source);
    const fake = fakeInstance(source, { snapshots: snapshotsOf(source), types: { [variable]: "password2" } });
    const definition = await loadFlowFromTables(fake.ops, header, OPEN, { include_inputs: true });
    expect(definition.trigger!.condition).toEqual({ text: null, redacted: "sensitive_type" });
    expect(definition.trigger!.inputs!.find((input) => input.name === "condition")).toMatchObject({
      value: null,
      type: "password2",
      redacted: "sensitive_type",
    });
  });

  it("resolves subflow call targets through the snapshot's parent_flow", async () => {
    const { definition, source } = await load("tables-F2F3p.json");
    const snapshots = snapshotsOf(source);
    const calls = stepsByKind(definition, "subflow");
    expect(calls.length).toBeGreaterThan(0);
    for (const step of calls) {
      const row = rowsOf(source, "sys_hub_sub_flow_instance", "sys_hub_sub_flow_instance_v2").find(
        (candidate) => candidate.ui_id!.value === step.uid
      )!;
      expect(step.subflow).toEqual({ flow_sys_id: snapshots[row.subflow!.value], name: step.title });
      expect(step.title.text).toBe(row.subflow!.display_value);
    }
    // An unknown snapshot leaves the target unresolved.
    const missing = await load("tables-F2F3p.json", OPEN, { snapshots: {} });
    for (const step of stepsByKind(missing.definition, "subflow")) expect(step.subflow!.flow_sys_id).toBeNull();
  });

  it("returns the policy-checked label_cache as token/label pairs", async () => {
    const { definition, source } = await load("tables-F6a.json");
    const entries = JSON.parse(source.flow!.rows[0]!.label_cache!.value) as { name: string; label: string }[];
    expect(definition.label_cache).toEqual(entries.map((entry) => [entry.name, entry.label]));
    const hidden = await load("tables-F6a.json", planFor({ omit: [["sys_hub_flow", "label_cache"]] }));
    expect(hidden.definition.label_cache).toEqual([]);
    expect(hidden.definition.warnings).toEqual(["label_cache_unavailable"]);
    expect(hidden.calls.some((call) => call.params.sysparm_fields === "sys_id,label_cache")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadFlowFromTables: policy
// ---------------------------------------------------------------------------

describe("loadFlowFromTables policy", () => {
  it("hides an annotation on every storage when one source is unreadable", async () => {
    const { definition, source, calls } = await load(
      "tables-F5.json",
      planFor({ omit: [["sys_hub_flow_logic_instance_v2", "comment"]] })
    );
    const commented = source.sys_hub_flow_logic!.rows.find((row) => row.comment!.value !== "")!;
    const step = definition.steps.find((candidate) => candidate.uid === commented.ui_id!.value)!;
    expect(step.annotation).toEqual({ text: null, redacted: "field_policy" });
    expect(calls.find((call) => call.path.endsWith("/sys_hub_flow_logic_instance_v2"))!.params.sysparm_fields).toBe(
      FIELDS.logic.replace(",comment", "")
    );
    const open = await load("tables-F5.json");
    expect(open.definition.steps.find((candidate) => candidate.uid === commented.ui_id!.value)!.annotation).toEqual({
      text: commented.comment!.value,
    });
  });

  it("redacts every input of an element whose value source is unreadable", async () => {
    const plan = planFor({ omit: [["sys_variable_value", "value"]] });
    const v1 = await load("tables-F6a.json", plan);
    expect(v1.calls.find((call) => call.path.endsWith("/sys_variable_value"))!.params.sysparm_fields).toBe(
      "sys_id,document,document_key,variable,order"
    );
    const inputs = v1.definition.steps.flatMap((step) => step.inputs);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input).toMatchObject({ value: null, redacted: "field_policy" });
    // The intersection rule: V2 inputs hide too, since V1 values share the element.
    const v2 = await load("tables-F1.json", plan);
    const v2Inputs = v2.definition.steps.flatMap((step) => step.inputs);
    expect(v2Inputs.length).toBeGreaterThan(0);
    for (const input of v2Inputs) expect(input).toMatchObject({ value: null, redacted: "field_policy" });
  });

  it("does not read var_dictionary when element is unreadable, and fails closed on names", async () => {
    const plan = planFor({ omit: [["var_dictionary", "element"]] });
    const { definition, calls } = await load("tables-F6a.json", plan);
    expect(calls.some((call) => call.path.endsWith("/var_dictionary"))).toBe(false);
    for (const input of definition.steps.flatMap((step) => step.inputs)) {
      expect(input.value).toBeNull();
      expect(input.redacted).toBeDefined();
    }
  });

  it("skips a flow I/O table whose element is not showable", async () => {
    const { definition, calls } = await load("tables-F4.json", planFor({ omit: [["sys_hub_flow_input", "label"]] }));
    expect(calls.some((call) => call.path.endsWith("/sys_hub_flow_input"))).toBe(false);
    expect(definition.variables.map((variable) => variable.scope)).toEqual(["output", "output"]);
  });

  it("redacts sensitive names inside decoded blobs and strips unknown keys", async () => {
    const fake = fakeInstance(
      handCapture({ sys_hub_action_instance_v2: [actionRow(1, { values: cell(BLOBS.inputs_with_extras!) })] })
    );
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    expect(definition.steps[0]!.inputs).toEqual([
      { name: "short_description", label: "Label short_description", type: "string", value: "Synthetic value" },
      { name: "api_key", label: "Label api_key", type: "string", value: null, redacted: "sensitive_name" },
    ]);
    expect(definition.items_dropped).toBe(1);
    expect(definition.warnings).toContain("items_dropped_invalid");
    expect(JSON.stringify(definition)).not.toMatch(/security|canRead|synthetic-secret-value/u);
  });
});

// ---------------------------------------------------------------------------
// loadFlowFromTables: gzip and adversarial structure
// ---------------------------------------------------------------------------

describe("loadFlowFromTables bounded decoding", () => {
  it("marks undecodable blobs decode_failed and never throws", async () => {
    const rows = [
      actionRow(1, { values: cell(BLOBS.bomb_8mib!) }),
      actionRow(2, { values: cell(BLOBS.invalid_base64_alphabet!) }),
      actionRow(3, { values: cell(BLOBS.not_gzip_plain_json!) }),
      actionRow(4, { values: cell(BLOBS.non_json!) }),
      actionRow(5, { values: cell(BLOBS.depth_25!) }),
      actionRow(6, { values: cell(gz({ not: "a list" })) }),
      actionRow(7, { values: cell("") }),
    ];
    const logic = [
      logicRow(10, "If", { values: cell(BLOBS.logic_values_wrong_shape!) }),
      logicRow(11, "If", { values: cell(BLOBS.logic_values!) }),
    ];
    const fake = fakeInstance(handCapture({ sys_hub_action_instance_v2: rows, sys_hub_flow_logic_instance_v2: logic }));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    const failed = { name: "values", label: null, type: null, value: null, redacted: "decode_failed" };
    expect(definition.steps.slice(0, 6).map((step) => step.inputs)).toEqual(Array.from({ length: 6 }, () => [failed]));
    expect(definition.steps[6]!.inputs).toEqual([]);
    expect(definition.steps[7]!.inputs).toEqual([failed]);
    expect(definition.steps[7]!.condition).toEqual({ text: null });
    // Logic values decode to {inputs, variables}; a repeated variable is listed once.
    expect(definition.steps[8]!.inputs.map((input) => input.name)).toEqual(["condition_name", "condition", "flag"]);
    expect(definition.steps[8]!.condition).toEqual({ text: "Synthetic condition label" });
    expect(definition.warnings).toEqual(["gzip_decode_failed"]);
  });

  it("shares one decompression budget across every blob of a load", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => actionRow(index + 1, { values: cell(BLOBS.near_blob_cap!) }));
    const fake = fakeInstance(handCapture({ sys_hub_action_instance_v2: rows }));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    const decoded = definition.steps.filter((step) => step.inputs[0]?.redacted !== "decode_failed");
    expect(decoded).toHaveLength(Math.floor(FLOW_VIEW_LIMITS.MAX_GZIP_OUTPUT_BYTES_PER_LOAD / 200_004));
    // The decoded blobs hold a bare string, not inputs: each entry is dropped.
    expect(decoded.every((step) => step.inputs.length === 0)).toBe(true);
    expect(definition.items_dropped).toBe(decoded.length);
    expect([...definition.warnings].sort()).toEqual(["gzip_decode_failed", "items_dropped_invalid"]);
    // A new load has a new budget.
    const again = await loadFlowFromTables(fakeInstance(handCapture({ sys_hub_action_instance_v2: rows.slice(0, 1) })).ops, HAND_HEADER, OPEN, {
      include_inputs: true,
    });
    expect(again.warnings).toEqual(["items_dropped_invalid"]);
  });

  it("caps inputs per node", async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ name: `field_${index}`, value: String(index) }));
    const fake = fakeInstance(handCapture({ sys_hub_action_instance_v2: [actionRow(1, { values: cell(gz(many)) })] }));
    const definition = await loadFlowFromTables(fake.ops, HAND_HEADER, OPEN, { include_inputs: true });
    expect(definition.steps[0]!.inputs).toHaveLength(FLOW_VIEW_LIMITS.MAX_INPUTS_PER_NODE);
    expect(definition.limits_hit).toEqual(["inputs_per_node"]);
  });
});

describe("loadFlowFromTables adversarial structure", () => {
  async function loadStructure(plan = OPEN) {
    const source = adversarial<Capture>("structure.json");
    const fake = fakeInstance(source);
    const header = await headerOf(source, plan);
    const definition = await loadFlowFromTables(fake.ops, header, plan, { include_inputs: plan.include_inputs !== false });
    const byUid = new Map(definition.steps.map((step) => [step.uid, step]));
    return { definition, byUid, calls: fake.calls };
  }

  it("survives missing _v2 tables, dangling parents, cycles and unknown logic", async () => {
    const { definition, byUid } = await loadStructure();
    expectValidDefinition(definition);
    expectForest(definition);
    // Four malformed action rows dropped: bad ui_id, bad sys_id, duplicate uid, bad parent.
    // (The other flow's row is filtered by the fake instance's query, as the server would.)
    expect(definition.items_dropped).toBe(4);
    expect(definition.steps).toHaveLength(2 + 10);
    expect([...definition.warnings].sort()).toEqual(
      ["items_dropped_invalid", "label_cache_unavailable", "orphan_steps", "unknown_logic_type"].sort()
    );
    // Dangling parent becomes a root.
    expect(byUid.get(huid(2))!.parent_uid).toBeNull();
    // Unknown logic type.
    expect(byUid.get(huid(10))).toMatchObject({ logic_kind: "other", title: { text: "Teleport to Mars" } });
    // The 11 <-> 12 cycle is broken at exactly one link.
    const cycle = [byUid.get(huid(11))!, byUid.get(huid(12))!];
    expect(cycle.filter((step) => step.parent_uid === null)).toHaveLength(1);
    // Branch pairing.
    expect(byUid.get(huid(13))).toMatchObject({ connected_uid: null, parent_uid: null });
    expect(byUid.get(huid(15))).toMatchObject({ logic_kind: "else_if", connected_uid: huid(14), parent_uid: null });
    expect(byUid.get(huid(16))).toMatchObject({ connected_uid: null });
    expect(byUid.get(huid(17))).toMatchObject({ logic_kind: "top_level_try", parent_uid: null });
    expect(byUid.get(huid(18))).toMatchObject({ logic_kind: "end_flow", connected_uid: null, parent_uid: huid(14) });
    expect(byUid.get(huid(19))).toMatchObject({ logic_kind: "catch", connected_uid: null, parent_uid: huid(14), order: 19 });
    expect(definition.label_cache).toEqual([]);
  });

  it("sorts steps by order, then uid", async () => {
    const { definition } = await loadStructure(NO_INPUTS);
    const orders = definition.steps.map((step) => step.order ?? Number.POSITIVE_INFINITY);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("drops invalid label_cache entries and keeps valid ones", async () => {
    const entries = [
      { name: "abc.field", label: "Field" },
      { name: "", label: "empty token" },
      { label: "no token" },
      { name: "x".repeat(513), label: "long token" },
      { name: "abc.field", label: "duplicate" },
      { name: "abc.blank", label: "" },
      { name: "abc.ctl", label: "Line\u0000\nbreak" },
    ];
    const source = handCapture({});
    source.flow!.rows[0]!.label_cache = cell(JSON.stringify(entries));
    const definition = await loadFlowFromTables(fakeInstance(source).ops, HAND_HEADER, OPEN, { include_inputs: true });
    expect(definition.label_cache).toEqual([
      ["abc.field", "Field"],
      ["abc.ctl", "Linebreak"],
    ]);
    expect(definition.items_dropped).toBe(3);
    for (const garbage of ["null", "{}", "[1,2]".replace("1", "[".repeat(30))]) {
      source.flow!.rows[0]!.label_cache = cell(garbage);
      const result = await loadFlowFromTables(fakeInstance(source).ops, HAND_HEADER, OPEN, { include_inputs: true });
      expect(result.label_cache).toEqual([]);
      expect(result.warnings).toContain("label_cache_unavailable");
    }
  });
});
