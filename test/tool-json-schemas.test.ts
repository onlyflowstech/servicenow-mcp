import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionContextDependencies } from "../src/execution-context.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { REGISTERED_TOOL_COUNT, registerServiceNowTools } from "../src/tools/index.js";

/**
 * The JSON Schema every registered tool sends clients in tools/list, input and
 * output, pinned in a reviewed file. The schemas are generated from zod by the
 * SDK, so a zod or SDK upgrade can change what clients receive without any
 * source change here; this snapshot makes that drift a visible diff. Regenerate
 * with `npx vitest run test/tool-json-schemas.test.ts -u` only after reviewing
 * the change, and say in the commit why clients may receive the new schema.
 */
const SNAPSHOT = "./fixtures/tool-json-schemas.json";

const contextDependencies: ExecutionContextDependencies = {
  requestMetadataProvider: {
    resolve: ({ requestId }) => ({
      correlationId: `schema-snapshot-${String(requestId)}`,
      identity: { ownerId: "schema-snapshot", clientId: "schema-snapshot" },
    }),
  },
  effectivePolicyProvider: {
    resolve: () => ({
      id: "schema-snapshot-policy",
      revision: "schema-snapshot",
      tableAccess: { readTables: [], writeTables: [], targets: [] },
    }),
  },
  auditSink: { write: () => {}, writePreContext: () => {} },
};

// tools/list never resolves a profile, so no profile manager method is reached.
const profileManager = {} as ProfileManager;

const open: Array<{ client: Client; close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map(({ close }) => close()));
});

async function listTools() {
  const server = await createMcpServer({
    dependencies: { profileManager, contextDependencies },
    register: (surface, dependencies) =>
      registerServiceNowTools(
        surface,
        dependencies.profileManager,
        dependencies.contextDependencies
      ),
  });
  const client = new Client({ name: "tool-json-schema-snapshot", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({
    client,
    close: async () => {
      await client.close();
      if (server.isConnected()) await server.close();
    },
  });
  return (await client.listTools()).tools;
}

describe("tool JSON Schemas sent to clients", () => {
  it("match the reviewed snapshot for every registered tool", async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(REGISTERED_TOOL_COUNT);

    const schemas = Object.fromEntries(
      [...tools]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tool) => [
          tool.name,
          {
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          },
        ])
    );

    await expect(`${JSON.stringify(schemas, null, 2)}\n`).toMatchFileSnapshot(SNAPSHOT);
  });
});
