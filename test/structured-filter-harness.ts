/**
 * In-process MCP server with sn_query and sn_batch registered, for tests that
 * must see exactly what a client sees: input validation runs in the MCP SDK
 * before any handler, so a schema message can only be checked end to end.
 * Synthetic fixtures only; the ServiceNow client is a stub.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const CONFIG: ServiceNowConfig = {
  instance: "https://structured-filter.service-now.com",
  user: "structured-filter-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};

export const ACTIVE = { type: "equality", field: "active", operator: "eq", value: true } as const;
export const NAMED = { type: "text", field: "name", operator: "contains", value: "fleet" } as const;
export const PRIORITY = { type: "range", field: "priority", operator: "lte", value: 2 } as const;

export function group(operator: "and" | "or", ...conditions: unknown[]) {
  return { type: "group", operator, conditions };
}

/** A group nested `levels` deep around one leaf. */
export function nested(levels: number): unknown {
  let node: unknown = ACTIVE;
  for (let level = 0; level < levels; level += 1) node = group("and", node, NAMED);
  return node;
}

export interface Harness {
  readonly client: Client;
  readonly server: { isConnected(): boolean; close(): Promise<void> };
  readonly getWithMeta: ReturnType<typeof vi.fn>;
  readonly post: ReturnType<typeof vi.fn>;
}

const open: Harness[] = [];

export async function harness(
  records: readonly unknown[] = [{ sys_id: "1".repeat(32), name: "FleetUtil" }]
): Promise<Harness> {
  const getWithMeta = vi.fn(async () => ({
    data: { result: records },
    status: 200,
    headers: new Headers(),
  }));
  const post = vi.fn(async () => ({ serviced_requests: [], unserviced_requests: [] }));
  const serviceNowClient = {
    getWithMeta,
    post,
    get: vi.fn(async () => ({ result: [] })),
  } as unknown as ServiceNowClient;
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: CONFIG.instance,
      username: CONFIG.user,
      credential: "env:STRUCTURED_FILTER_TEST_SECRET_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => CONFIG),
    getClient: vi.fn(() => serviceNowClient),
  } as unknown as ProfileManager;
  const tableAccess = createTableAccessPolicy({
    readTables: ["incident", "sys_script_include", "sys_user", "u_widget"],
    writeTables: ["incident"],
    targets: [
      {
        table: "incident",
        kind: "canonical",
        tools: ["sn_query", "sn_batch"],
        closureComplete: true,
        relatedTables: ["incident"],
      },
      ...["sys_script_include", "sys_user", "u_widget"].map((table) => ({
        table,
        kind: "canonical" as const,
        tools: ["sn_query"],
        closureComplete: true,
        relatedTables: [table],
      })),
    ],
  });
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `structured-filter-${String(requestId)}`,
        identity: { ownerId: "owner", clientId: "client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({ id: "structured-filter", revision: "test", tableAccess }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
  };
  const server = await createMcpServer({
    dependencies: { profileManager, executionContext },
    register: (surface, dependencies) =>
      registerServiceNowTools(surface, dependencies.profileManager, dependencies.executionContext),
  });
  const client = new Client({ name: "structured-filter-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connected: Harness = { client, server, getWithMeta, post };
  open.push(connected);
  return connected;
}

/** Close every harness opened since the last call; use from `afterEach`. */
export async function closeHarnesses(): Promise<void> {
  await Promise.all(
    open.splice(0).map(async ({ client, server }) => {
      await client.close();
      if (server.isConnected()) await server.close();
    })
  );
}

/** The failure text a client sees, whether it arrives as a throw or an error result. */
export async function callError(
  connected: Harness,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    const result = await connected.client.callTool({ name, arguments: { profile: "p", ...args } });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    if (result.isError) return text;
    throw new Error(`expected a rejection, got: ${text.slice(0, 80)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("expected a rejection")) throw error;
    return error instanceof Error ? error.message : String(error);
  }
}

/** The `sysparm_query` of the most recent upstream read. */
export function lastQuery(connected: Harness): string {
  const call = connected.getWithMeta.mock.calls.at(-1) as unknown as [string, Record<string, string>];
  return call[1].sysparm_query ?? "";
}
