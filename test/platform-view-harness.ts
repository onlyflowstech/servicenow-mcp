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
import { expect } from "vitest";

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

export interface RecordedCall {
  readonly path: string;
  readonly params: Record<string, string>;
}

/** A fake instance: every read is recorded and answered with no rows. */
export function recordingInstance() {
  const calls: RecordedCall[] = [];
  const refuse = (): never => {
    throw new Error("unexpected operation");
  };
  const answer = async (path: string, params: Record<string, string> = {}) => {
    calls.push({ path, params: { ...params } });
    return { result: [] };
  };
  const ops = Object.freeze({
    get: answer,
    getWithMeta: refuse,
    post: refuse,
    patch: refuse,
    delete: refuse,
    postBinary: refuse,
    getRaw: refuse,
  }) as unknown as ServiceNowOperations;
  return { ops, calls };
}

/** The table a recorded read addressed, or undefined for any other path. */
export function tableOfCall(call: RecordedCall): string | undefined {
  return /^\/api\/now\/(?:table|stats)\/([a-z][a-z0-9_]*)$/u.exec(call.path)?.[1];
}

/** Every recorded read is a Table or Stats API read of a table in `plan`. */
export function expectReadsWithin(calls: readonly RecordedCall[], plan: readonly string[]): void {
  for (const call of calls) {
    const table = tableOfCall(call);
    expect(table, `${call.path} is not a Table or Stats API read`).toBeDefined();
    expect(plan, `${call.path} is outside the plan`).toContain(table);
  }
}

/** The plan the dispatcher declares for a call. */
export function planFor(view: PlatformView, args: Record<string, unknown> = {}): readonly string[] {
  return platformViewReadTables(view, args);
}

const open: Array<{ close(): Promise<void> }> = [];
export async function closeHarnesses(): Promise<void> {
  while (open.length > 0) await open.pop()!.close();
}

export async function harness(
  ops: ServiceNowOperations,
  options: { tableAccess?: TableAccessPolicy; modules?: readonly ToolModuleContract[] } = {}
) {
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
