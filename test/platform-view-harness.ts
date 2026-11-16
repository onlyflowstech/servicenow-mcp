/**
 * A dispatcher harness for `sn_platform_view` that does not touch the
 * production catalog: the module under test is registered on its own, behind
 * the real dispatcher, with a fake instance that records every upstream read.
 *
 * Not a test file: a view's tests use it to hold its handler to its plan.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect } from "vitest";

import type { ServiceNowClient, ServiceNowOperations } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy, type TableAccessPolicy } from "../src/table-policy.js";
import { registerServiceNowToolModules } from "../src/tools/index.js";
import { platformViewReadTables, type PlatformView } from "../src/tools/platform-view-contracts.js";
import { platformViewToolModule } from "../src/tools/platform-view-module.js";
import type { ToolModuleContract } from "../src/tools/tool-module.js";
import { noHiddenFieldTypes } from "./fixtures/field-types.js";

export const PROFILE = "platform-view-test";
const INSTANCE = "https://platform-view-test.service-now.com";

/** A read-only policy over exactly these tables. */
export function readPolicy(tables: readonly string[]): TableAccessPolicy {
  return createTableAccessPolicy({
    readTables: [...tables],
    writeTables: [],
    targets: tables.map((table) => ({
      table,
      kind: "canonical" as const,
      tools: ["sn_platform_view"],
      closureComplete: true as const,
      relatedTables: [table],
    })),
  });
}

/** Every operation the client exposes. Only the first three can be a read. */
export type RecordedOperation = "get" | "getWithMeta" | "getRaw" | "post" | "patch" | "delete" | "postBinary";
const READ_OPERATIONS: readonly RecordedOperation[] = ["get", "getWithMeta", "getRaw"];

export interface RecordedCall {
  readonly operation: RecordedOperation;
  readonly path: string;
  readonly params: Record<string, string>;
}

export interface RecordingInstance {
  readonly ops: ServiceNowOperations;
  /** Every attempt, in order, including each one the fake refused. */
  readonly calls: RecordedCall[];
  /**
   * How many of `calls` `expectReadsWithin` has judged. A call made after the
   * last check is never judged, so closing with more calls than this fails.
   */
  judged: number;
}

const instances: RecordingInstance[] = [];

/**
 * A fake instance that records EVERY operation attempt, whatever its method.
 * A read (`get`, `getWithMeta`, `getRaw`) is answered with no rows; a write is
 * recorded and then refused. Neither is judged here: `expectReadsWithin` judges
 * the whole record against the call's plan, so a handler that swallows the
 * refusal's exception still fails the test. An instance that made calls and was
 * never judged in full fails when the harnesses close.
 */
export function recordingInstance(): RecordingInstance {
  const calls: RecordedCall[] = [];
  const record = (operation: RecordedOperation, path: string, params: Record<string, string> = {}) => {
    calls.push({ operation, path, params: { ...params } });
  };
  const refuse = (operation: RecordedOperation) => async (path: string, ...rest: unknown[]) => {
    const params = rest.find((value): value is Record<string, string> => typeof value === "object" && value !== null && !Buffer.isBuffer(value));
    record(operation, path, operation === "post" || operation === "postBinary" ? params : undefined);
    throw new Error(`refused: ${operation} ${path}`);
  };
  const ops = Object.freeze({
    get: async (path: string, params?: Record<string, string>) => {
      record("get", path, params);
      return { result: [] };
    },
    getWithMeta: async (path: string, params?: Record<string, string>) => {
      record("getWithMeta", path, params);
      return { data: { result: [] }, status: 200, headers: new Headers() };
    },
    getRaw: async (path: string) => {
      record("getRaw", path);
      return { data: Buffer.alloc(0), contentType: "application/json" };
    },
    post: refuse("post"),
    patch: refuse("patch"),
    delete: refuse("delete"),
    postBinary: refuse("postBinary"),
  }) as unknown as ServiceNowOperations;
  const instance: RecordingInstance = { ops, calls, judged: 0 };
  instances.push(instance);
  return instance;
}

/** The table a recorded read addressed, or undefined for any other path. */
export function tableOfCall(call: RecordedCall): string | undefined {
  return /^\/api\/now\/(?:table|stats)\/([a-z][a-z0-9_]*)(?:\/[0-9a-f]{32})?$/u.exec(call.path)?.[1];
}

/**
 * A dot-walk a view declares: reading `field.x` on `from` reads `target`, which
 * must also be in the plan. Only one hop is ever allowed.
 */
export interface DeclaredDotWalk {
  readonly from: string;
  readonly field: string;
  readonly target: string;
}

/**
 * Parameters a read may carry; any other is refused, so a new one is a decision.
 * Left out on purpose: `sysparm_view` (a UI view can dot-walk), `sysparm_query_no_domain`
 * (reads across domains) and `sysparm_having` (its fields are not parsed here).
 */
const KNOWN_PARAMS = new Set([
  "sysparm_query", "sysparm_fields", "sysparm_limit", "sysparm_offset", "sysparm_display_value",
  "sysparm_exclude_reference_link", "sysparm_count", "sysparm_group_by", "sysparm_sum_fields",
  "sysparm_avg_fields", "sysparm_min_fields", "sysparm_max_fields", "sysparm_orderby",
  "sysparm_suppress_pagination_header", "sysparm_no_count",
]);
/** Parameters that name fields as a comma list. */
const FIELD_LIST_PARAMS = [
  "sysparm_fields", "sysparm_group_by", "sysparm_sum_fields", "sysparm_avg_fields", "sysparm_min_fields",
  "sysparm_max_fields", "sysparm_orderby",
];
const BOOLEAN_PARAMS = [
  "sysparm_exclude_reference_link", "sysparm_count", "sysparm_suppress_pagination_header", "sysparm_no_count",
];

/** A field: one name, or one dot-walk hop. More hops are judged separately. */
const FIELD = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/u;
/** The operators of the encoded-query policy (`SUPPORTED_ENCODED_QUERY_OPERATORS`). */
const OPERATORS = "ISNOTEMPTY|ISEMPTY|STARTSWITH|ENDSWITH|NOT LIKE|NOT IN|BETWEEN|INSTANCEOF|>=|<=|!=|LIKE|IN|=|>|<";
const CONDITION = new RegExp(`^(?:OR|NQ)?([a-z0-9_]+(?:\\.[a-z0-9_]+)?)(?:${OPERATORS})(.*)$`, "u");
const SORT_OR_GROUP = /^(?:ORDERBYDESC|ORDERBY|GROUPBY)([a-z0-9_]+(?:\.[a-z0-9_]+)?)$/u;
/** Query constructs that read another table or run script, wherever they appear. */
const FORBIDDEN_QUERY = /SUBQUERY|RLQUERY|DYNAMIC|JOIN|javascript:/iu;

/**
 * The fields a `sysparm_query` mentions. Every `^` clause must be a condition
 * (an optional OR or NQ, a lowercase field, an allowed operator, a value), an
 * ORDERBY, ORDERBYDESC or GROUPBY of a field, or the bare EQ terminator. Any
 * other clause fails: nothing is skipped.
 */
export function queryFields(query: string): string[] {
  const forbidden = FORBIDDEN_QUERY.exec(query);
  if (forbidden !== null) throw new Error(`query contains ${forbidden[0]}`);
  const fields: string[] = [];
  for (const clause of query.split("^")) {
    if (clause === "EQ") continue;
    const condition = CONDITION.exec(clause);
    if (condition !== null) {
      fields.push(condition[1]!);
      continue;
    }
    const sort = SORT_OR_GROUP.exec(clause);
    if (sort !== null) {
      fields.push(sort[1]!);
      continue;
    }
    throw new Error(`unparseable query clause ${JSON.stringify(clause)}`);
  }
  return fields;
}

/** Every field name a call's parameters mention, including the ones in the query. */
export function fieldsOfCall(call: RecordedCall): string[] {
  const fields: string[] = [];
  for (const name of FIELD_LIST_PARAMS) {
    if (call.params[name] === undefined) continue;
    for (const entry of call.params[name]!.split(",")) {
      const field = (name === "sysparm_orderby" ? entry.trim().replace(/^-/u, "") : entry.trim());
      if (!FIELD.test(field)) throw new Error(`${name} has an entry that is not a field name: ${JSON.stringify(entry)}`);
      fields.push(field);
    }
  }
  if (call.params.sysparm_query !== undefined) fields.push(...queryFields(call.params.sysparm_query));
  return fields;
}

/**
 * Judge a whole record against a call's plan, and fail on the first violation:
 * an operation that is not a read (the fake refused it), a path that is not a
 * Table or Stats API read of one table (a single record by sys_id is fine), a
 * table outside the plan, an unknown parameter, or a dot-walked field that the
 * view has not declared with its target table in the plan.
 */
export function expectReadsWithin(
  source: RecordingInstance | readonly RecordedCall[],
  plan: readonly string[],
  dotWalks: readonly DeclaredDotWalk[] = []
): void {
  const calls = Array.isArray(source) ? (source as readonly RecordedCall[]) : (source as RecordingInstance).calls;
  if (!Array.isArray(source)) (source as RecordingInstance).judged = calls.length;
  for (const call of calls) {
    const label = `${call.operation} ${call.path}`;
    expect(READ_OPERATIONS, `${label}: not a read operation (the harness refused it)`).toContain(call.operation);
    const table = tableOfCall(call);
    expect(table, `${label} is not a Table or Stats API read`).toBeDefined();
    expect(plan, `${label} is outside the plan`).toContain(table);
    for (const [name, value] of Object.entries(call.params)) {
      expect(KNOWN_PARAMS.has(name), `${label}: unclassified parameter ${name}`).toBe(true);
      if (name === "sysparm_display_value") {
        expect(["true", "false", "all"], `${label}: sysparm_display_value=${value}`).toContain(value);
      }
      if (BOOLEAN_PARAMS.includes(name)) expect(["true", "false"], `${label}: ${name}=${value}`).toContain(value);
      if (name === "sysparm_limit" || name === "sysparm_offset") expect(value, `${label}: ${name}`).toMatch(/^\d{1,7}$/u);
    }
    let fields: string[];
    try {
      fields = fieldsOfCall(call);
    } catch (error) {
      throw new Error(`${label}: ${(error as Error).message}`);
    }
    for (const field of fields) {
      if (!field.includes(".")) continue;
      const [head, ...rest] = field.split(".");
      const declared = dotWalks.find((walk) => walk.from === table && walk.field === head);
      expect(rest.length, `${label}: dot-walk ${field} is more than one hop`).toBe(1);
      expect(declared, `${label}: dot-walk ${field} is not declared by the view`).toBeDefined();
      expect(plan, `${label}: dot-walk ${field} reads ${declared?.target}, outside the plan`).toContain(declared?.target);
    }
  }
}

/** The plan the dispatcher declares for a call. */
export function planFor(view: PlatformView, args: Record<string, unknown> = {}): readonly string[] {
  return platformViewReadTables(view, args);
}

const open: Array<{ close(): Promise<void> }> = [];
let realFetch: typeof globalThis.fetch | undefined;

/**
 * Closes every harness and fails when a recording instance made calls that no
 * test checked. Registered below for every test file that imports this module.
 */
export async function closeHarnesses(): Promise<void> {
  try {
    while (open.length > 0) await open.pop()!.close();
  } finally {
    if (realFetch !== undefined) {
      globalThis.fetch = realFetch;
      realFetch = undefined;
    }
  }
  const unjudged = instances.splice(0).filter((instance) => instance.calls.length > instance.judged);
  if (unjudged.length > 0) {
    throw new Error(
      `${unjudged.length} recording instance(s) made calls that no test judged with expectReadsWithin ` +
        "(none, or some made after the last check)"
    );
  }
}

afterEach(closeHarnesses);

export async function harness(
  ops: ServiceNowOperations,
  options: { tableAccess?: TableAccessPolicy; modules?: readonly ToolModuleContract[] } = {}
) {
  // A handler gets its reads from the call's services. A direct `fetch` would
  // bypass the recording client, so it throws for as long as a harness is open.
  if (realFetch === undefined) {
    realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("fetch is not allowed in a platform view test: read through the call's services");
    }) as typeof globalThis.fetch;
  }
  const profile: Profile = Object.freeze({
    instance: INSTANCE,
    username: "platform-view-user",
    credential: "env:PLATFORM_VIEW_TEST_SECRET",
    authType: "basic" as const,
  });
  const config: ServiceNowConfig = Object.freeze({
    instance: INSTANCE,
    user: "platform-view-user",
    password: "platform-view-secret",
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
        correlationId: `platform-view-${String(requestId)}`,
        identity: { ownerId: "platform-view-owner", clientId: "platform-view-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "platform-view-policy",
        revision: "v1",
        tableAccess: options.tableAccess ?? readPolicy([]),
      }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
    // Stands in for the dispatcher's field-type lookup (sys_dictionary and
    // sys_db_object, outside a view's plan), so the recording client sees only
    // the view's own reads and judges every one of them as before. The type
    // step still runs; the stand-in finds no hidden-typed field.
    fieldTypeLoader: noHiddenFieldTypes,
  };
  const server = await createMcpServer({
    dependencies: {},
    register: (surface) =>
      registerServiceNowToolModules(surface, manager, dependencies, options.modules ?? [platformViewToolModule]),
  });
  const client = new Client({ name: "platform-view-test", version: "1.0.0" });
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
      (await client.callTool({ name: "sn_platform_view", arguments: { profile: PROFILE, ...args } })) as CallToolResult,
  };
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}
