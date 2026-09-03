import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { TablePolicyError } from "../src/table-policy.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";
import { allToolModules } from "../src/tools/catalog.js";
import {
  isProductionToolName,
  productionToolOutputSchemas,
} from "../src/tools/result-envelope.js";
import { definition, handler, schema } from "../src/tools/script.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

function fakeProfileManager(): ProfileManager {
  return {
    getProfile: vi.fn(
      (): Profile => ({
        instance: config.instance,
        username: config.user,
        credential: "env:DO_NOT_RESOLVE",
        authType: "basic",
        description: "non-secret test profile",
      })
    ),
    getConfig: vi.fn(() => config),
    getClient: vi.fn(
      () =>
        new Proxy({} as ServiceNowClient, {
          get() {
            throw new Error("an unregistered tool must never reach the client");
          },
        })
    ),
  } as unknown as ProfileManager;
}

const contextDependencies: ExecutionContextDependencies = {
  requestMetadataProvider: {
    resolve: ({ requestId }) => ({
      correlationId: `test-${String(requestId)}`,
      identity: { ownerId: "test-owner", clientId: "test-client" },
    }),
  },
  effectivePolicyProvider: {
    resolve: () => ({
      id: "test-policy",
      revision: "test-revision",
      tableAccess: {
        readTables: Object.freeze([]),
        writeTables: Object.freeze([]),
        targets: Object.freeze([]),
      },
    }),
  },
  auditSink: { write: () => {}, writePreContext: () => {} },
};

const openHarnesses: Array<{ client: Client; server: Awaited<ReturnType<typeof createMcpServer>> }> =
  [];

async function harness() {
  const server = await createMcpServer({
    dependencies: { profileManager: fakeProfileManager(), contextDependencies },
    register: (surface, dependencies) =>
      registerServiceNowTools(
        surface,
        dependencies.profileManager,
        dependencies.contextDependencies
      ),
  });
  const client = new Client({ name: "sn-script-unregistered-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connected = { client, server };
  openHarnesses.push(connected);
  return connected;
}

afterEach(async () => {
  await Promise.all(
    openHarnesses.splice(0).map(async ({ client, server }) => {
      await client.close();
      if (server.isConnected()) await server.close();
    })
  );
});

/**
 * `sn_script` is future work (SNS-39) that 2.0 deliberately does not publish.
 * These tests pin it as unregistered so it cannot be re-exposed by accident.
 */
describe("sn_script is not exposed", () => {
  it("is absent from the published tool catalog", () => {
    const names = allToolModules.map((module) => module.definition.name);
    expect(names).not.toContain("sn_script");
  });

  it("is absent from tools/list", async () => {
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("sn_script");
  });

  it("answers tools/call with the standard MCP unknown-tool error", async () => {
    const { client } = await harness();
    const result = await client.callTool({
      name: "sn_script",
      arguments: { profile: "secondary", code: "gs.info('x')", confirm: false },
    });

    // The SDK rejects the call as JSON-RPC InvalidParams (-32602) before any
    // handler, profile resolution, or client construction can run.
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("MCP error -32602: Tool sn_script not found");
    expect(result.structuredContent).toBeUndefined();
  });

  it("carries no result-envelope contract", () => {
    expect(isProductionToolName("sn_script")).toBe(false);
    expect(Object.keys(productionToolOutputSchemas)).not.toContain("sn_script");
  });

  it("carries no table-access classification", () => {
    expect(() => resolveToolTableAccess("sn_script", {})).toThrow(TablePolicyError);
  });
});

/**
 * The module stays in the tree as future work. Keep its honesty guarantees
 * covered so the stub cannot silently gain real behaviour while unregistered.
 */
describe("sn_script module remains an honest stub", () => {
  it("advertises the unsupported status in the tool description", () => {
    expect(definition.name).toBe("sn_script");
    expect(definition.description).toContain("NOT YET SUPPORTED");
    expect(definition.description).toContain("SNS-39");
  });

  it("returns isError with alternatives and never touches the client", async () => {
    const client = new Proxy({} as ServiceNowClient, {
      get() {
        throw new Error("sn_script must not call the ServiceNow client");
      },
    });
    const result = await handler(
      schema.parse({ code: "gs.print('hi');" }),
      client,
      config
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not yet supported");
    expect(result.content[0].text).toContain("no script was executed");
    expect(result.content[0].text).toContain("sn_query");
    expect(result.content[0].text).toContain("sn_batch");
  });
});
