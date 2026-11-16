/**
 * A dispatcher harness for `sn_history` that does not touch the production
 * catalog: the module under test is registered on its own, behind the real
 * dispatcher, with a fake instance that answers from fixture rows and records
 * every operation attempt.
 *
 * The fake evaluates the subset of encoded queries the tool sends (equality,
 * IN, ordering comparisons, `^OR`, ORDERBY/ORDERBYDESC and the limit), so
 * paging is exercised against the same query text the tool sends upstream.
 *
 * Not a test file. Synthetic data only.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect } from "vitest";

import type { ServiceNowClient, ServiceNowOperations } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import { runWithFieldPolicyConfiguration, type FieldPolicyConfigurationInput } from "../src/field-policy.js";
import { fieldTypesFromRows, type DictionaryRow, type FieldTypeLoader } from "../src/hidden-values.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy, type TableAccessPolicy } from "../src/table-policy.js";
import { createToolError } from "../src/tool-error.js";
import { resolveHistoryAccess, historyToolModule } from "../src/tools/history-module.js";
import { registerServiceNowToolModules } from "../src/tools/index.js";

export const PROFILE = "history-test";
const INSTANCE = "https://history-test.service-now.com";

/** Fake identifiers: obviously synthetic, 32 hex characters. */
export const ids = {
  incident: "1ac1de0000000000000000000000000a",
  otherIncident: "1ac1de0000000000000000000000000b",
  task: "7a5c000000000000000000000000000c",
  property: "9e0e000000000000000000000000000d",
  queueConfig: "5e9c000000000000000000000000000e",
  update: "0d0d000000000000000000000000000f",
} as const;

/** The row id of fixture row `n` of a source (distinct per source and row). */
export function rowId(prefix: "a" | "b" | "c", n: number): string {
  return `${prefix}${String(n).padStart(31, "0")}`;
}

export type Row = Record<string, string>;
type Failure = "forbidden" | "missing";

export interface HistoryFixture {
  /** `table/sys_id` -> the record's class ("" for a table that is not extended). */
  readonly records: Readonly<Record<string, string | Failure>>;
  /** Class -> its parents, nearest first. */
  readonly parents?: Readonly<Record<string, readonly string[]>>;
  /** Dictionary rows: `{name, element, internal_type, audit?}`; an empty element is the collection row. */
  readonly dictionary?: readonly Row[] | Failure;
  readonly audit?: readonly Row[] | Failure;
  readonly journal?: readonly Row[] | Failure;
  readonly flows?: readonly Row[] | Failure;
  /** Sources whose rows are returned whatever the record filter says (a misbehaving instance). */
  readonly ignoreRecordFilter?: readonly ("sys_audit" | "sys_journal_field" | "sys_flow_context")[];
  /** `NOT IN` clauses are ignored (a misbehaving instance). */
  readonly ignoreExclusions?: boolean;
}

export interface RecordedCall {
  readonly operation: string;
  readonly path: string;
  readonly params: Record<string, string>;
}

export interface FakeInstance {
  readonly ops: ServiceNowOperations;
  readonly calls: RecordedCall[];
}

const SOURCE_TABLES = {
  sys_audit: "audit",
  sys_journal_field: "journal",
  sys_flow_context: "flows",
} as const;

/** The fake instance. Writes are recorded and refused. */
export function fakeInstance(fixture: HistoryFixture): FakeInstance {
  const calls: RecordedCall[] = [];
  const answer = (path: string, params: Record<string, string> = {}): unknown => {
    const single = /^\/api\/now\/table\/([a-z][a-z0-9_]*)\/([0-9a-f]{32})$/u.exec(path);
    if (single !== null) {
      const entry = fixture.records[`${single[1]}/${single[2]}`];
      if (entry === undefined) throw createToolError("not_found", "do_not_retry");
      if (entry === "forbidden") throw createToolError("authorization", "retry_after_correction");
      if (entry === "missing") throw createToolError("upstream", "do_not_retry");
      return { result: { sys_id: single[2], sys_class_name: entry } };
    }
    const table = /^\/api\/now\/table\/([a-z][a-z0-9_]*)$/u.exec(path)?.[1];
    const query = params.sysparm_query ?? "";
    if (table === "sys_db_object") {
      const root = /^name=([a-z0-9_]+)$/u.exec(query)?.[1];
      if (root === undefined) return { result: [] };
      const row: Row = { name: root };
      (fixture.parents?.[root] ?? []).forEach((parent, index) => {
        row[`${"super_class.".repeat(index + 1)}name`] = parent;
      });
      return { result: [row] };
    }
    if (table === "sys_dictionary") {
      if (fixture.dictionary === "forbidden") throw createToolError("authorization", "retry_after_correction");
      const names = /^nameIN([a-z0-9_,]+)\^/u.exec(query)?.[1]?.split(",");
      if (names === undefined) return { result: [] };
      return { result: project((fixture.dictionary as Row[] | undefined ?? []).filter((row) => names.includes(row.name!)), params) };
    }
    if (table !== undefined && Object.hasOwn(SOURCE_TABLES, table)) {
      const rows = fixture[SOURCE_TABLES[table as keyof typeof SOURCE_TABLES]];
      if (rows === "forbidden") throw createToolError("authorization", "retry_after_correction");
      if (rows === "missing") throw createToolError("upstream", "do_not_retry");
      const loose = fixture.ignoreRecordFilter?.includes(table as keyof typeof SOURCE_TABLES) ?? false;
      return {
        result: project(evaluate(rows ?? [], query, Number(params.sysparm_limit ?? "10000"), loose, fixture.ignoreExclusions === true), params),
      };
    }
    return { result: [] };
  };
  const record = (operation: string, path: string, params: Record<string, string> = {}) =>
    calls.push({ operation, path, params: { ...params } });
  const refuse = (operation: string) => async (path: string) => {
    record(operation, path);
    throw new Error(`refused: ${operation} ${path}`);
  };
  const ops = Object.freeze({
    get: async (path: string, params?: Record<string, string>) => {
      record("get", path, params);
      return answer(path, params);
    },
    getWithMeta: async (path: string, params?: Record<string, string>) => {
      record("getWithMeta", path, params);
      return { data: answer(path, params), status: 200, headers: new Headers() };
    },
    getRaw: refuse("getRaw"),
    post: refuse("post"),
    patch: refuse("patch"),
    delete: refuse("delete"),
    postBinary: refuse("postBinary"),
  }) as unknown as ServiceNowOperations;
  return { ops, calls };
}

/** Only the requested fields, as the Table API returns them. */
function project(rows: readonly Row[], params: Record<string, string>): Row[] {
  const fields = params.sysparm_fields?.split(",");
  if (fields === undefined) return rows.map((row) => ({ ...row }));
  return rows.map((row) => Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]!])));
}

const RECORD_KEYS = new Set(["tablename", "documentkey", "name", "element_id", "source_table", "source_record"]);

/** The subset of encoded queries the tool sends. */
function evaluate(rows: readonly Row[], query: string, limit: number, loose: boolean, ignoreExclusions = false): Row[] {
  const clauses = query.split("^");
  const order = clauses.filter((clause) => clause.startsWith("ORDERBY"));
  const groups: string[][] = [];
  for (const clause of clauses.filter((entry) => !entry.startsWith("ORDERBY"))) {
    if (clause.startsWith("OR") && groups.length > 0) groups[groups.length - 1]!.push(clause.slice(2));
    else groups.push([clause]);
  }
  const kept = rows.filter((row) =>
    groups.every((group) =>
      group.some((clause) => {
        const match = /^([a-z_]+)(NOT IN|IN|<=|>=|<|>|=)(.*)$/u.exec(clause);
        if (match === null) throw new Error(`fake instance cannot read clause ${JSON.stringify(clause)}`);
        const [, field, operator, value] = match as unknown as [string, string, string, string];
        if (loose && RECORD_KEYS.has(field)) return true;
        const actual = row[field] ?? "";
        switch (operator) {
          case "IN":
            return value.split(",").includes(actual);
          case "NOT IN":
            return ignoreExclusions || !value.split(",").includes(actual);
          case "<=":
            return actual <= value;
          case ">=":
            return actual >= value;
          case "<":
            return actual < value;
          case ">":
            return actual > value;
          default:
            return actual === value;
        }
      })
    )
  );
  kept.sort((a, b) => {
    for (const entry of order) {
      const descending = entry.startsWith("ORDERBYDESC");
      const field = entry.slice(descending ? "ORDERBYDESC".length : "ORDERBY".length);
      const left = a[field] ?? "";
      const right = b[field] ?? "";
      if (left !== right) return (left < right ? -1 : 1) * (descending ? -1 : 1);
    }
    return 0;
  });
  return kept.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** Every table named, each bound to sn_history (and to `otherTools` where given). */
export function namedPolicy(
  tables: readonly string[],
  options: { readonly boundTo?: Readonly<Record<string, readonly string[]>> } = {}
): TableAccessPolicy {
  return createTableAccessPolicy({
    readTables: [...tables],
    writeTables: [],
    targets: tables.map((table) => ({
      table,
      kind: "canonical" as const,
      tools: [...(options.boundTo?.[table] ?? ["sn_history"])],
      closureComplete: true as const,
      relatedTables: [table],
    })),
  });
}

/** `"*"` plus the named tables (`"*"` never reaches the named-only audit and journal tables). */
export function wildcardPolicy(named: readonly string[] = []): TableAccessPolicy {
  return createTableAccessPolicy({ readTables: ["*", ...named], writeTables: [] });
}

export const FULL_TABLES = [
  "incident",
  "sys_db_object",
  "sys_dictionary",
  "sys_audit",
  "sys_journal_field",
  "sys_flow_context",
] as const;

/** A dispatcher type lookup that finds the given hidden-typed fields and nothing else. */
export function hiddenTypes(rows: readonly DictionaryRow[] = []): FieldTypeLoader {
  return async (_client, tables) => fieldTypesFromRows(rows, Object.fromEntries([...tables].map((table) => [table, [table]])));
}

// ---------------------------------------------------------------------------
// The plan and the reads
// ---------------------------------------------------------------------------

/** The tables the dispatcher authorizes for a call: the module's own resolver, run as the dispatcher runs it. */
export function planFor(
  args: Record<string, unknown>,
  tableAccess: TableAccessPolicy,
  fieldPolicy?: FieldPolicyConfigurationInput
): string[] {
  return runWithFieldPolicyConfiguration(fieldPolicy, () =>
    resolveHistoryAccess({ profile: PROFILE, ...args }, tableAccess).requests.map((request) => request.table)
  );
}

/** The table a recorded read addressed, or undefined for any other path. */
export function tableOfCall(call: RecordedCall): string | undefined {
  return /^\/api\/now\/table\/([a-z][a-z0-9_]*)(?:\/[0-9a-f]{32})?$/u.exec(call.path)?.[1];
}

const KNOWN_PARAMS = new Set([
  "sysparm_query",
  "sysparm_fields",
  "sysparm_limit",
  "sysparm_display_value",
  "sysparm_exclude_reference_link",
]);
const MIRRORS = ["sys_history_line", "sys_audit_delete", "sys_email"];

/**
 * Every call was a read of a table in the plan, with known parameters only and
 * raw values, and none of them reached the history mirrors.
 */
export function expectReadsWithin(calls: readonly RecordedCall[], plan: readonly string[]): void {
  for (const call of calls) {
    const label = `${call.operation} ${call.path}`;
    expect(["get", "getWithMeta"], `${label}: not a read`).toContain(call.operation);
    const table = tableOfCall(call);
    expect(table, `${label}: not a Table API read`).toBeDefined();
    expect(plan, `${label}: outside the plan`).toContain(table);
    expect(MIRRORS, label).not.toContain(table);
    for (const [name, value] of Object.entries(call.params)) {
      expect(KNOWN_PARAMS.has(name), `${label}: unclassified parameter ${name}`).toBe(true);
      if (name === "sysparm_display_value") expect(value, label).toBe("false");
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const open: Array<{ close(): Promise<void> }> = [];
let realFetch: typeof globalThis.fetch | undefined;

afterEach(async () => {
  try {
    while (open.length > 0) await open.pop()!.close();
  } finally {
    if (realFetch !== undefined) {
      globalThis.fetch = realFetch;
      realFetch = undefined;
    }
  }
});

export async function harness(
  ops: ServiceNowOperations,
  options: {
    readonly tableAccess: TableAccessPolicy;
    readonly fieldPolicy?: FieldPolicyConfigurationInput;
    /** The dispatcher's type lookup; by default it finds no hidden-typed field. */
    readonly fieldTypeLoader?: FieldTypeLoader;
  }
) {
  if (realFetch === undefined) {
    realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("fetch is not allowed in a history test: read through the call's services");
    }) as typeof globalThis.fetch;
  }
  const profile: Profile = Object.freeze({
    instance: INSTANCE,
    username: "history-user",
    credential: "env:HISTORY_TEST_SECRET",
    authType: "basic" as const,
  });
  const config: ServiceNowConfig = Object.freeze({
    instance: INSTANCE,
    user: "history-user",
    password: "history-test-secret",
    displayValue: "true",
    relDepth: 3,
    authType: "basic" as const,
  });
  const manager = {
    getProfile: () => profile,
    getConfig: () => config,
    getClient: () => ops as unknown as ServiceNowClient,
  } as unknown as ProfileManager;
  const dependencies: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `history-${String(requestId)}`,
        identity: { ownerId: "history-owner", clientId: "history-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "history-policy",
        revision: "v1",
        tableAccess: options.tableAccess,
        ...(options.fieldPolicy === undefined ? {} : { fieldPolicy: options.fieldPolicy }),
      }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
    // Stands in for the dispatcher's own type lookup (outside the tool's
    // plan), so the fake sees only the tool's reads.
    fieldTypeLoader: options.fieldTypeLoader ?? hiddenTypes(),
  };
  const server = await createMcpServer({
    dependencies: {},
    register: (surface) => registerServiceNowToolModules(surface, manager, dependencies, [historyToolModule]),
  });
  const client = new Client({ name: "history-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({
    async close() {
      try {
        await client.close();
      } finally {
        if (server.isConnected()) await server.close();
      }
    },
  });
  return {
    client,
    call: async (args: Record<string, unknown>): Promise<CallToolResult> =>
      (await client.callTool({ name: "sn_history", arguments: { profile: PROFILE, ...args } })) as CallToolResult,
  };
}

/** The `data` of a successful result. */
export function dataOf(result: CallToolResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}
