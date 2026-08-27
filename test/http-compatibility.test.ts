import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import { StaticBearerAuthenticationProvider } from "../src/http-auth.js";
import { createHttpRuntime, type HttpRuntime } from "../src/http-runtime.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const TOKEN = "snsdk-contract-token-32-characters-minimum";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const DENY_ALL_TABLE_ACCESS = Object.freeze({
  readTables: Object.freeze([]),
  writeTables: Object.freeze([]),
});
const EXPECTED_TOOL_NAMES = [
  "sn_aggregate",
  "sn_atf",
  "sn_attach",
  "sn_batch",
  "sn_codesearch",
  "sn_create",
  "sn_delete",
  "sn_discover",
  "sn_get",
  "sn_health",
  "sn_incident_add_comment",
  "sn_incident_add_work_note",
  "sn_nl",
  "sn_profile",
  "sn_query",
  "sn_relationships",
  "sn_schema",
  "sn_script",
  "sn_syslog",
  "sn_update",
] as const;

function createProfileManager(profileOverride?: Profile) {
  const profile: Profile = profileOverride ?? {
    instance: "https://example.service-now.com",
    username: "contract-test",
    credential: "env:UNRESOLVED_CONTRACT_SECRET",
    authType: "basic",
  };
  const config: ServiceNowConfig = {
    instance: profile.instance,
    user: profile.username ?? "",
    password: "never-used",
    displayValue: "true",
    relDepth: 3,
  };
  const getProfile = vi.fn((name: string) => {
      if (name !== "secondary") throw new Error("unknown profile");
      return profile;
    });
  const getConfig = vi.fn(() => config);
  const getClient = vi.fn(() => {
      throw new Error("HTTP compatibility calls must not initialize ServiceNow");
    });
  return {
    manager: { getProfile, getConfig, getClient } as unknown as ProfileManager,
    getProfile,
    getConfig,
    getClient,
  };
}

async function createHarness(profileOverride?: Profile) {
  const profileManager = createProfileManager(profileOverride);
  const runtime = createHttpRuntime({
    host: "127.0.0.1",
    port: 0,
    authenticationProvider: new StaticBearerAuthenticationProvider([
      {
        token: TOKEN,
        ownerId: "contract-owner",
        clientId: "contract-client",
      },
    ]),
    createServer: (requestContext) => {
      const executionContext: ExecutionContextDependencies = {
        requestMetadataProvider: requestContext.requestMetadataProvider,
        requestSignal: requestContext.signal,
        effectivePolicyProvider: {
          resolve: () => ({
            id: "contract-policy",
            revision: "snsdk-20",
            tableAccess: DENY_ALL_TABLE_ACCESS,
          }),
        },
        auditSink: { write: () => {}, writePreContext: () => {} },
      };
      return createMcpServer({
        dependencies: { profileManager: profileManager.manager, executionContext },
        register: (surface, dependencies) =>
          registerServiceNowTools(
            surface,
            dependencies.profileManager,
            dependencies.executionContext
          ),
      });
    },
  });
  const address = await runtime.start();
  return { address, profileManager, runtime };
}

const openRuntimes: HttpRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    openRuntimes.splice(0).map((runtime) => runtime.close({ gracePeriodMs: 100 }))
  );
});

describe("HTTP compatibility matrix", () => {
  it("initializes, discovers, and invokes with the official MCP HTTP client", async () => {
    const harness = await createHarness();
    openRuntimes.push(harness.runtime);
    const transport = new StreamableHTTPClientTransport(harness.address.url, {
      requestInit: { headers: { authorization: AUTHORIZATION } },
    });
    const client = new Client({
      name: "official-sdk-http-contract-client",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
      const discovered = await client.listTools();
      expect(discovered.tools.map((tool) => tool.name).sort()).toEqual(
        [...EXPECTED_TOOL_NAMES]
      );
      for (const tool of discovered.tools) {
        expect(tool.inputSchema.required, tool.name).toContain("profile");
        expect(tool.inputSchema.properties?.profile, tool.name).toMatchObject({
          type: "string",
          minLength: 1,
        });
      }

      const query = discovered.tools.find((tool) => tool.name === "sn_query");
      expect(Object.keys(query?.inputSchema.properties ?? {}).sort()).toEqual([
        "display_value",
        "fields",
        "limit",
        "max_response_bytes",
        "offset",
        "orderby",
        "profile",
        "query",
        "response_format",
        "structured_query",
        "table",
      ]);
      expect(query?.annotations).toEqual({
        title: "Query records",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      const deleteTool = discovered.tools.find((tool) => tool.name === "sn_delete");
      expect(Object.keys(deleteTool?.inputSchema.properties ?? {}).sort()).toEqual([
        "confirm",
        "profile",
        "sys_id",
        "table",
      ]);
      expect(deleteTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      });

      const missingProfile = await client.callTool({
        name: "sn_query",
        arguments: { table: "incident" },
      });
      expect(missingProfile.isError).toBe(true);
      expect(harness.profileManager.getProfile).not.toHaveBeenCalled();
      expect(harness.profileManager.getConfig).not.toHaveBeenCalled();
      expect(harness.profileManager.getClient).not.toHaveBeenCalled();

      const result = await client.callTool({
        name: "sn_profile",
        arguments: { profile: "secondary" },
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        profile: "secondary",
        data: { name: "secondary", auth_type: "basic" },
        metadata: { kind: "single", pagination: { mode: "none" } },
      });
      expect(harness.profileManager.getProfile).toHaveBeenCalledWith("secondary");
      expect(harness.profileManager.getClient).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("initializes and discovers with an independent fetch JSON-RPC client", async () => {
    const harness = await createHarness();
    openRuntimes.push(harness.runtime);
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: AUTHORIZATION,
      "content-type": "application/json",
    };

    const initialized = await postJsonRpc(harness.address.url, headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "fetch-http-contract-client", version: "1.0.0" },
      },
    });
    const protocolVersion = initialized.result?.protocolVersion;
    expect(protocolVersion).toBeTypeOf("string");

    const notification = await fetch(harness.address.url, {
      method: "POST",
      headers: {
        ...headers,
        "mcp-protocol-version": String(protocolVersion),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect(notification.status).toBe(202);

    const discovered = await postJsonRpc(
      harness.address.url,
      { ...headers, "mcp-protocol-version": String(protocolVersion) },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    );
    const tools = discovered.result?.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(
      (tools as Array<{ name: string }>).map((tool) => tool.name).sort()
    ).toEqual([...EXPECTED_TOOL_NAMES]);
  });

  it("fails closed when a configured profile has a hostile secret-bearing getter", async () => {
    const secret = "Bearer should-never-cross-the-http-boundary";
    const hostileProfile = new Proxy<Profile>(
      {
        instance: "https://example.service-now.com",
        username: "contract-test",
        credential: "env:UNRESOLVED_CONTRACT_SECRET",
        authType: "basic",
      },
      {
        get(target, property, receiver) {
          if (property === "description") throw new Error(secret);
          return Reflect.get(target, property, receiver);
        },
      }
    );
    const harness = await createHarness(hostileProfile);
    openRuntimes.push(harness.runtime);
    const client = new Client({
      name: "hostile-profile-http-contract-client",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(harness.address.url, {
      requestInit: { headers: { authorization: AUTHORIZATION } },
    });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "sn_profile",
        arguments: { profile: "secondary" },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        'Profile \\"secondary\\" is invalid or incomplete.'
      );
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(harness.profileManager.getConfig).not.toHaveBeenCalled();
      expect(harness.profileManager.getClient).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});

async function postJsonRpc(
  url: URL,
  headers: Record<string, string>,
  message: Record<string, unknown>
): Promise<{ result?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
}
