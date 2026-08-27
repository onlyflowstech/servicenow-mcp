import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import { StaticBearerAuthenticationProvider } from "../src/http-auth.js";
import { createHttpRuntime, type HttpRuntime } from "../src/http-runtime.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import {
  defineServiceNowToolModule,
  registerServiceNowToolModules,
  withRequiredProfile,
  withResolvedProfileOutput,
} from "../src/tools/index.js";

const TOKEN = "snsdk-36-profile-token-012345678901234567890123";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const ALPHA = "alpha";
const BETA = "beta";
const ALPHA_INSTANCE = "https://alpha.service-now.com";
const BETA_INSTANCE = "https://beta.service-now.com";
const RAW_QUERY = "short_descriptionLIKEprofile=beta^active=true";

const inputSchema = withRequiredProfile(
  z.object({ query: z.string().min(1) }).strict()
);
const outputSchema = withResolvedProfileOutput(
  z.object({ instance: z.string(), query: z.string() })
);

const profileRoutingProbe = defineServiceNowToolModule({
  runtime: "servicenow",
  definition: {
    name: "sn_snsdk_36_profile_probe",
    description: "Verify request-local profile routing is independent of query text.",
    annotations: {
      title: "SNSDK-36 profile routing probe",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  inputSchema,
  outputSchema,
  requirements: {
    permissions: ["read"],
    tables: { kind: "none" },
    apis: [],
    fieldPolicies: [],
    capabilities: ["snsdk-36:profile-routing"],
  },
  resolveAccess: (candidate) => ({
    args: Object.freeze(inputSchema.parse(candidate)),
    requests: Object.freeze([]),
  }),
  handler: async (args, services) => ({
    content: [{ type: "text", text: "SNSDK-36 profile routing probe" }],
    structuredContent: {
      instance: services.settings.instance,
      query: args.query,
    },
  }),
});

interface RoutingHarness {
  readonly runtime: HttpRuntime;
  readonly url: URL;
  readonly getProfile: ReturnType<typeof vi.fn>;
  readonly getConfig: ReturnType<typeof vi.fn>;
  readonly getClient: ReturnType<typeof vi.fn>;
}

interface RoutingClient {
  initialize(): Promise<void>;
  call(args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

const runtimes = new Set<HttpRuntime>();
const sdkClients = new Set<Client>();

afterEach(async () => {
  await Promise.all(
    [...sdkClients].map(async (client) => {
      sdkClients.delete(client);
      await client.close().catch(() => {});
    })
  );
  await Promise.all(
    [...runtimes].map(async (runtime) => {
      runtimes.delete(runtime);
      await runtime.close({ gracePeriodMs: 100 }).catch(() => {});
    })
  );
});

function configFor(name: string): ServiceNowConfig {
  const instance = name === ALPHA ? ALPHA_INSTANCE : BETA_INSTANCE;
  return {
    instance,
    user: `${name}-user`,
    password: `${name}-resolved-only-in-test`,
    displayValue: "true",
    relDepth: 3,
  };
}

async function createHarness(): Promise<RoutingHarness> {
  const profiles: Readonly<Record<string, Profile>> = Object.freeze({
    [ALPHA]: Object.freeze({
      instance: ALPHA_INSTANCE,
      username: "alpha-user",
      credential: "env:SN_ALPHA_TEST_SECRET",
    }),
    [BETA]: Object.freeze({
      instance: BETA_INSTANCE,
      username: "beta-user",
      credential: "env:SN_BETA_TEST_SECRET",
    }),
  });
  const getProfile = vi.fn((name: string) => {
    const profile = profiles[name];
    if (!profile) throw new Error("unknown profile");
    return profile;
  });
  const getConfig = vi.fn((name: string) => configFor(name));
  const getClient = vi.fn(
    (_name: string, _config: Readonly<ServiceNowConfig>) =>
      Object.create(null) as ServiceNowClient
  );
  const manager = { getProfile, getConfig, getClient } as unknown as ProfileManager;
  const createServer = (requestContext: {
    readonly requestMetadataProvider: ExecutionContextDependencies["requestMetadataProvider"];
    readonly signal: ExecutionContextDependencies["requestSignal"];
  }) =>
    createMcpServer({
      dependencies: {
        manager,
        dependencies: {
          requestMetadataProvider: requestContext.requestMetadataProvider,
          requestSignal: requestContext.signal,
          effectivePolicyProvider: {
            resolve: () => ({
              id: "snsdk-36-policy",
              revision: "v1",
              tableAccess: {
                readTables: [],
                writeTables: [],
                targets: [],
              },
            }),
          },
          auditSink: { write: () => {}, writePreContext: () => {} },
        },
      },
      register: (surface, dependencies) =>
        registerServiceNowToolModules(
          surface,
          dependencies.manager,
          dependencies.dependencies,
          [profileRoutingProbe]
        ),
    });
  const runtime = createHttpRuntime({
    host: "127.0.0.1",
    port: 0,
    authenticationProvider: new StaticBearerAuthenticationProvider([
      {
        token: TOKEN,
        ownerId: "snsdk-36-owner",
        clientId: "snsdk-36-client",
      },
    ]),
    createServer,
  });
  runtimes.add(runtime);
  const { url } = await runtime.start();
  return { runtime, url, getProfile, getConfig, getClient };
}

function headers(protocolVersion?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization: AUTHORIZATION,
    "content-type": "application/json",
    ...(protocolVersion === undefined
      ? {}
      : { "mcp-protocol-version": protocolVersion }),
  };
}

function officialClient(url: URL): RoutingClient {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: AUTHORIZATION } },
  });
  const client = new Client({ name: "snsdk-36-sdk", version: "1.0.0" });
  return {
    async initialize() {
      await client.connect(transport);
      sdkClients.add(client);
    },
    call: (args) =>
      client.callTool({
        name: profileRoutingProbe.definition.name,
        arguments: args,
      }),
    async close() {
      sdkClients.delete(client);
      await client.close();
    },
  };
}

function fetchJsonRpcClient(url: URL): RoutingClient {
  let requestId = 0;
  let protocolVersion: string | undefined;
  async function request(method: string, params: Record<string, unknown>) {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(protocolVersion),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    const body = (await response.json()) as {
      readonly result?: unknown;
      readonly error?: unknown;
    };
    if (response.status !== 200 || body.error) {
      throw new Error(`JSON-RPC request failed (${response.status})`);
    }
    return body.result;
  }
  return {
    async initialize() {
      const result = (await request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "snsdk-36-fetch", version: "1.0.0" },
      })) as { protocolVersion: string };
      protocolVersion = result.protocolVersion;
      const response = await fetch(url, {
        method: "POST",
        headers: headers(protocolVersion),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      if (response.status !== 202) {
        throw new Error(`initialized notification failed (${response.status})`);
      }
    },
    call: async (args) =>
      (await request("tools/call", {
        name: profileRoutingProbe.definition.name,
        arguments: args,
      })) as CallToolResult,
    async close() {},
  };
}

const clientFactories = [
  ["official MCP SDK", officialClient],
  ["independent Fetch JSON-RPC", fetchJsonRpcClient],
] as const;

describe.each(clientFactories)("SNSDK-36 %s profile routing", (_name, factory) => {
  it("uses only the explicit selector when raw query text names another profile", async () => {
    const harness = await createHarness();
    const client = factory(harness.url);
    await client.initialize();

    const result = await client.call({ profile: ALPHA, query: RAW_QUERY });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      instance: ALPHA_INSTANCE,
      profile: ALPHA,
      query: RAW_QUERY,
    });
    expect(harness.getProfile).toHaveBeenCalledTimes(1);
    expect(harness.getProfile).toHaveBeenCalledWith(ALPHA);
    expect(harness.getConfig).toHaveBeenCalledTimes(1);
    expect(harness.getConfig).toHaveBeenCalledWith(ALPHA);
    expect(harness.getClient).toHaveBeenCalledTimes(1);
    expect(harness.getClient).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ instance: ALPHA_INSTANCE })
    );

    await client.close();
  });

  it("rejects query-text routing with no secret or client work when profile is omitted", async () => {
    const harness = await createHarness();
    const client = factory(harness.url);
    await client.initialize();

    const result = await client.call({ query: RAW_QUERY });

    expect(result.isError).toBe(true);
    expect(harness.getProfile).not.toHaveBeenCalled();
    expect(harness.getConfig).not.toHaveBeenCalled();
    expect(harness.getClient).not.toHaveBeenCalled();

    await client.close();
  });
});
