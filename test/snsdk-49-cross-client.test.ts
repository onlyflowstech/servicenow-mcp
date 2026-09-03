import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { ENCODED_QUERY_MIGRATION_MESSAGE } from "../src/encoded-query-policy.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import { StaticBearerAuthenticationProvider } from "../src/http-auth.js";
import { createHttpRuntime, type HttpRuntime } from "../src/http-runtime.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createToolError } from "../src/tool-error.js";
import {
  REGISTERED_TOOL_COUNT,
  registerServiceNowTools,
} from "../src/tools/index.js";

const TOKEN = "snsdk-49-cross-client-token-012345678901234567890123";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const PROFILE = "incident-writer";
const INSTANCE = "https://incident-write.service-now.com";
const SYS_ID = "ABCDEF0123456789ABCDEF0123456789";
const CANONICAL_SYS_ID = SYS_ID.toLowerCase();

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface CrossClient {
  initialize(): Promise<void>;
  listTools(): Promise<readonly Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

interface Harness {
  readonly runtime: HttpRuntime;
  readonly url: URL;
  readonly getProfile: ReturnType<typeof vi.fn>;
  readonly getConfig: ReturnType<typeof vi.fn>;
  readonly getClient: ReturnType<typeof vi.fn>;
  readonly auditWrite: ReturnType<typeof vi.fn>;
  readonly auditPreWrite: ReturnType<typeof vi.fn>;
}

const openRuntimes = new Set<HttpRuntime>();
const openOfficialClients = new Set<Client>();

afterEach(async () => {
  await Promise.all(
    [...openOfficialClients].map(async (client) => {
      await client.close().catch(() => {});
      openOfficialClients.delete(client);
    })
  );
  await Promise.all(
    [...openRuntimes].map(async (runtime) => {
      await runtime.close({ gracePeriodMs: 100 }).catch(() => {});
      openRuntimes.delete(runtime);
    })
  );
});

async function createHarness(options: {
  readonly client?: ServiceNowClient;
  readonly writeTables?: readonly string[];
  readonly targetTools?: readonly string[];
} = {}): Promise<Harness> {
  const profile: Profile = {
    instance: INSTANCE,
    username: "incident-writer",
    credential: "env:SNSDK49_UNRESOLVED_TEST_SECRET",
    authType: "basic",
  };
  const config: ServiceNowConfig = {
    instance: INSTANCE,
    user: "incident-writer",
    password: "never-resolved-or-returned",
    displayValue: "true",
    relDepth: 3,
  };
  const getProfile = vi.fn((name: string) => {
    if (name !== PROFILE) throw new Error("unknown profile");
    return profile;
  });
  const getConfig = vi.fn(() => config);
  const getClient = vi.fn(() => {
    if (!options.client) throw new Error("ServiceNow must not be reached");
    return options.client;
  });
  const profileManager = {
    getProfile,
    getConfig,
    getClient,
  } as unknown as ProfileManager;
  const auditWrite = vi.fn();
  const auditPreWrite = vi.fn();
  const runtime = createHttpRuntime({
    host: "127.0.0.1",
    port: 0,
    authenticationProvider: new StaticBearerAuthenticationProvider([
      {
        token: TOKEN,
        ownerId: "snsdk-49-owner",
        clientId: "snsdk-49-client",
      },
    ]),
    createServer: (requestContext) => {
      const executionContext: ExecutionContextDependencies = {
        requestMetadataProvider: requestContext.requestMetadataProvider,
        requestSignal: requestContext.signal,
        effectivePolicyProvider: {
          resolve: () => ({
            id: "snsdk-49-policy",
            revision: "v1",
            tableAccess: {
              readTables: [],
              writeTables: options.writeTables ?? [],
              targets: (options.writeTables ?? []).map((table) => ({
                table,
                kind: "canonical" as const,
                tools: options.targetTools ?? ["sn_create", "sn_update"],
                closureComplete: true as const,
                relatedTables: [table],
              })),
            },
          }),
        },
        auditSink: { write: auditWrite, writePreContext: auditPreWrite },
      };
      return createMcpServer({
        dependencies: { profileManager, executionContext },
        register: async (surface, dependencies) =>
          registerServiceNowTools(
            surface,
            dependencies.profileManager,
            dependencies.executionContext
          ),
      });
    },
  });
  openRuntimes.add(runtime);
  const { url } = await runtime.start();
  return {
    runtime,
    url,
    getProfile,
    getConfig,
    getClient,
    auditWrite,
    auditPreWrite,
  };
}

function officialClient(url: URL): CrossClient {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: AUTHORIZATION } },
  });
  const client = new Client({ name: "snsdk-49-sdk", version: "1.0.0" });
  return {
    async initialize() {
      await client.connect(transport);
      openOfficialClients.add(client);
    },
    async listTools() {
      return (await client.listTools()).tools;
    },
    async callTool(name, args) {
      return client.callTool({ name, arguments: args });
    },
    async close() {
      openOfficialClients.delete(client);
      await client.close();
    },
  };
}

function fetchClient(url: URL): CrossClient {
  let requestId = 0;
  let protocolVersion: string | undefined;
  const headers = () => ({
    accept: "application/json, text/event-stream",
    authorization: AUTHORIZATION,
    "content-type": "application/json",
    ...(protocolVersion === undefined
      ? {}
      : { "mcp-protocol-version": protocolVersion }),
  });
  async function request(method: string, params: Record<string, unknown>) {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    const body = (await response.json()) as JsonRpcResponse;
    if (response.status !== 200 || body.error) {
      throw new Error(`JSON-RPC request failed (${response.status})`);
    }
    return body.result;
  }
  return {
    async initialize() {
      const initialized = (await request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "snsdk-49-fetch", version: "1.0.0" },
      })) as { protocolVersion: string };
      protocolVersion = initialized.protocolVersion;
      const response = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      if (response.status !== 202) {
        throw new Error(`initialized notification failed (${response.status})`);
      }
    },
    async listTools() {
      const result = (await request("tools/list", {})) as { tools: Tool[] };
      return result.tools;
    },
    async callTool(name, args) {
      return (await request("tools/call", {
        name,
        arguments: args,
      })) as CallToolResult;
    },
    async close() {},
  };
}

const clients = [
  ["official MCP SDK", officialClient],
  ["independent Fetch JSON-RPC", fetchClient],
] as const;

describe.each(clients)("SNSDK-49 %s incident writes", (_label, createClient) => {
  it("preserves full tool discovery and the exact create/update contracts", async () => {
    const harness = await createHarness();
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const tools = await client.listTools();
      expect(tools).toHaveLength(REGISTERED_TOOL_COUNT);
      const create = tools.find(({ name }) => name === "sn_create");
      const update = tools.find(({ name }) => name === "sn_update");
      expect(create).toMatchObject({
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["table", "fields", "profile"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      });
      expect(Object.keys(create?.inputSchema.properties ?? {}).sort()).toEqual([
        "fields",
        "profile",
        "table",
      ]);
      expect(update).toMatchObject({
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["table", "sys_id", "fields", "profile"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      });
      expect(Object.keys(update?.inputSchema.properties ?? {}).sort()).toEqual([
        "fields",
        "profile",
        "sys_id",
        "table",
      ]);
      for (const tool of [create, update]) {
        expect(tool?.outputSchema).toMatchObject({
          type: "object",
          additionalProperties: false,
          required: expect.arrayContaining(["data", "metadata", "profile"]),
        });
      }
    } finally {
      await client.close();
    }
  });

  it("executes exact canonical POST/PATCH requests with filtered profile envelopes", async () => {
    const post = vi.fn(async () => ({
      result: {
        sys_id: CANONICAL_SYS_ID,
        number: "INC0010049",
        short_description: "Database unavailable",
        urgency: "2",
        password: "create-upstream-secret",
      },
    }));
    const patch = vi.fn(async () => ({
      result: {
        sys_id: SYS_ID,
        state: "6",
        close_notes: "Resolved",
        access_token: "update-upstream-secret",
      },
    }));
    const harness = await createHarness({
      client: { post, patch } as unknown as ServiceNowClient,
      writeTables: ["incident"],
      targetTools: ["sn_create", "sn_update"],
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const created = await client.callTool("sn_create", {
        profile: PROFILE,
        table: " INCIDENT ",
        fields: {
          short_description: "  Database unavailable  ",
          urgency: 2,
        },
      });
      const updated = await client.callTool("sn_update", {
        profile: PROFILE,
        table: "incident",
        sys_id: SYS_ID,
        fields: { state: "06", close_notes: "Resolved" },
      });

      expect(post).toHaveBeenCalledWith("/api/now/table/incident", {
        short_description: "Database unavailable",
        urgency: "2",
      });
      expect(patch).toHaveBeenCalledWith(
        `/api/now/table/incident/${CANONICAL_SYS_ID}`,
        { state: "6", close_notes: "Resolved" }
      );
      expect(created.structuredContent).toMatchObject({
        profile: PROFILE,
        data: {
          sys_id: CANONICAL_SYS_ID,
          number: "INC0010049",
          table: "incident",
          record: {
            short_description: "Database unavailable",
            urgency: "2",
          },
        },
        metadata: { kind: "operation", record_count: 1 },
      });
      expect(updated.structuredContent).toMatchObject({
        profile: PROFILE,
        data: {
          sys_id: CANONICAL_SYS_ID,
          record: { state: "6", close_notes: "Resolved" },
        },
        metadata: { kind: "operation", record_count: 1 },
      });
      expect(JSON.stringify([created, updated])).not.toMatch(
        /upstream-secret|password|access_token/u
      );
      expect(harness.auditWrite).toHaveBeenCalledTimes(2);
      for (const [audit] of harness.auditWrite.mock.calls) {
        expect(audit).toMatchObject({
          profile: PROFILE,
          instance: INSTANCE,
          outcome: "success",
          reason: null,
        });
      }
    } finally {
      await client.close();
    }
  });

  it("rejects invalid tables and values before configuration, clients, or writes", async () => {
    const post = vi.fn();
    const patch = vi.fn();
    const harness = await createHarness({
      client: { post, patch } as unknown as ServiceNowClient,
      writeTables: ["incident"],
      targetTools: ["sn_create", "sn_update"],
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const denials = await Promise.all([
        client.callTool("sn_create", {
          profile: PROFILE,
          table: "problem",
          fields: { short_description: "safe" },
        }),
        client.callTool("sn_create", {
          profile: PROFILE,
          table: "incident",
          fields: { description: "missing short description" },
        }),
        client.callTool("sn_create", {
          profile: PROFILE,
          table: "incident",
          fields: { short_description: "   " },
        }),
        client.callTool("sn_create", {
          profile: PROFILE,
          table: "incident",
          fields: { short_description: "x".repeat(161) },
        }),
        client.callTool("sn_create", {
          profile: PROFILE,
          table: "incident",
          fields: { short_description: "line\u0000control-canary" },
        }),
        client.callTool("sn_create", {
          profile: PROFILE,
          table: "incident",
          fields: {
            short_description: "safe",
            category: "x^ORactive=true-hostile-canary",
          },
        }),
        client.callTool("sn_create", {
          profile: PROFILE,
          table: "incident",
          fields: {
            short_description: "safe",
            caller_id: "invalid-reference-canary",
          },
        }),
        client.callTool("sn_update", {
          profile: PROFILE,
          table: "incident",
          sys_id: CANONICAL_SYS_ID,
          fields: {},
        }),
      ]);
      for (const denial of denials) {
        expect(denial.isError).toBe(true);
        expect(denial.structuredContent).toBeUndefined();
        expect(JSON.stringify(denial)).toContain("denied by policy");
      }
      expect(JSON.stringify(denials)).not.toMatch(
        /control-canary|hostile-canary|invalid-reference-canary/u
      );
      expect(harness.getConfig).not.toHaveBeenCalled();
      expect(harness.getClient).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
      expect(harness.auditWrite).toHaveBeenCalledTimes(8);
      // One field-policy denial remains -- a sensitive field name, which is
      // the only field-level denial the built-ins still impose. The rest are
      // table denials. Every one is a policy rejection recorded before any
      // credential or upstream access.
      expect(
        harness.auditWrite.mock.calls.filter(
          ([audit]) => audit.reason === "field_access_denied"
        )
      ).toHaveLength(1);
      for (const [audit] of harness.auditWrite.mock.calls) {
        expect(audit).toMatchObject({
          outcome: "policy_rejected",
        });
        expect(["table_access_denied", "field_access_denied"]).toContain(
          audit.reason
        );
      }
    } finally {
      await client.close();
    }
  });

  it("rejects raw/multi-target selectors and journals without echoing values", async () => {
    const post = vi.fn();
    const patch = vi.fn();
    const harness = await createHarness({
      client: { post, patch } as unknown as ServiceNowClient,
      writeTables: ["incident"],
      targetTools: ["sn_create", "sn_update"],
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const rawCanary = "active=true^password=raw-query-secret";
      const raw = await client.callTool("sn_create", {
        profile: PROFILE,
        table: "incident",
        fields: { short_description: "safe" },
        query: rawCanary,
      });
      const multi = await client.callTool("sn_update", {
        profile: PROFILE,
        table: "incident",
        sys_id: CANONICAL_SYS_ID,
        sys_ids: [CANONICAL_SYS_ID],
        fields: { state: "6" },
      });
      const journalCanary = "journal-secret-must-not-return";
      const journal = await client.callTool("sn_update", {
        profile: PROFILE,
        table: "incident",
        sys_id: CANONICAL_SYS_ID,
        fields: { comments: journalCanary },
      });

      for (const denial of [raw, multi, journal]) {
        expect(denial.isError).toBe(true);
        expect(denial.structuredContent).toBeUndefined();
      }
      expect(JSON.stringify([raw, multi])).toContain(
        ENCODED_QUERY_MIGRATION_MESSAGE
      );
      expect(JSON.stringify(journal)).toContain("sn_incident_add_comment");
      expect(JSON.stringify([raw, multi, journal])).not.toMatch(
        /raw-query-secret|journal-secret-must-not-return/u
      );
      expect(harness.getConfig).not.toHaveBeenCalled();
      expect(harness.getClient).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
      // The SDK rejects strict-schema extras before the registered callback;
      // only the schema-valid journal request reaches profile/policy preflight.
      expect(harness.auditPreWrite).not.toHaveBeenCalled();
      expect(harness.getProfile).toHaveBeenCalledTimes(1);
      expect(harness.auditWrite).toHaveBeenCalledTimes(1);
      expect(harness.auditWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "sn_update",
          outcome: "policy_rejected",
          reason: "journal_update_denied",
        })
      );
      expect(JSON.stringify(harness.auditWrite.mock.calls)).not.toContain(
        journalCanary
      );
    } finally {
      await client.close();
    }
  });

  it("enforces exact configured table/tool grants and safe upstream taxonomy", async () => {
    const deniedPost = vi.fn();
    const deniedHarness = await createHarness({
      client: { post: deniedPost } as unknown as ServiceNowClient,
      writeTables: ["incident"],
      targetTools: ["sn_update"],
    });
    const deniedClient = createClient(deniedHarness.url);
    try {
      await deniedClient.initialize();
      const denied = await deniedClient.callTool("sn_create", {
        profile: PROFILE,
        table: "incident",
        fields: { short_description: "grant-isolation-canary" },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain("grant-isolation-canary");
      expect(deniedHarness.getConfig).not.toHaveBeenCalled();
      expect(deniedHarness.getClient).not.toHaveBeenCalled();
      expect(deniedPost).not.toHaveBeenCalled();
      expect(deniedHarness.auditWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "sn_create",
          outcome: "policy_rejected",
          reason: "table_access_denied",
        })
      );
    } finally {
      await deniedClient.close();
    }

    const post = vi.fn(async () => ({ result: {} }));
    const patch = vi.fn(async () => ({
      result: { sys_id: "1".repeat(32), state: "6" },
    }));
    const upstreamHarness = await createHarness({
      client: { post, patch } as unknown as ServiceNowClient,
      writeTables: ["incident"],
      targetTools: ["sn_create", "sn_update"],
    });
    const upstreamClient = createClient(upstreamHarness.url);
    try {
      await upstreamClient.initialize();
      const createFailure = await upstreamClient.callTool("sn_create", {
        profile: PROFILE,
        table: "incident",
        fields: { short_description: "safe" },
      });
      const updateFailure = await upstreamClient.callTool("sn_update", {
        profile: PROFILE,
        table: "incident",
        sys_id: CANONICAL_SYS_ID,
        fields: { state: "6" },
      });
      for (const failure of [createFailure, updateFailure]) {
        expect(failure.isError).toBe(true);
        expect(failure.structuredContent).toBeUndefined();
        expect(JSON.stringify(failure)).toContain("Error category: upstream");
      }
      expect(JSON.stringify(createFailure)).toContain(
        "Retry unchanged is not recommended"
      );
      expect(JSON.stringify(updateFailure)).toContain(
        "Retry only if the operation is safe and idempotent"
      );
      expect(upstreamHarness.auditWrite).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          tool: "sn_create",
          outcome: "handler_error",
          errorCategory: "upstream",
          retry: "do_not_retry",
        })
      );
      expect(upstreamHarness.auditWrite).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          tool: "sn_update",
          outcome: "handler_error",
          errorCategory: "upstream",
          retry: "retry_if_safe_and_idempotent",
        })
      );
    } finally {
      await upstreamClient.close();
    }
  });

  it("normalizes create and update ACL failures with safe audited taxonomy", async () => {
    const createCanary = "create-acl-body-must-not-return";
    const updateCanary = "update-acl-body-must-not-return";
    const post = vi.fn(async () => {
      throw createToolError("authorization", "retry_after_correction");
    });
    const patch = vi.fn(async () => {
      throw createToolError("authorization", "retry_after_correction");
    });
    const harness = await createHarness({
      client: { post, patch } as unknown as ServiceNowClient,
      writeTables: ["incident"],
      targetTools: ["sn_create", "sn_update"],
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const createFailure = await client.callTool("sn_create", {
        profile: PROFILE,
        table: "incident",
        fields: { short_description: createCanary },
      });
      const updateFailure = await client.callTool("sn_update", {
        profile: PROFILE,
        table: "incident",
        sys_id: SYS_ID,
        fields: { close_notes: updateCanary },
      });

      expect(post).toHaveBeenCalledWith("/api/now/table/incident", {
        short_description: createCanary,
      });
      expect(patch).toHaveBeenCalledWith(
        `/api/now/table/incident/${CANONICAL_SYS_ID}`,
        { close_notes: updateCanary }
      );
      for (const failure of [createFailure, updateFailure]) {
        expect(failure.isError).toBe(true);
        expect(failure.structuredContent).toBeUndefined();
        expect(JSON.stringify(failure)).toContain("ServiceNow access was denied.");
        expect(JSON.stringify(failure)).toContain("Error category: authorization");
        expect(JSON.stringify(failure)).toContain(
          "Retry after correcting the request or configuration."
        );
      }
      expect(JSON.stringify([createFailure, updateFailure])).not.toMatch(
        /create-acl-body-must-not-return|update-acl-body-must-not-return/u
      );
      expect(harness.auditWrite).toHaveBeenCalledTimes(2);
      expect(harness.auditWrite).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          tool: "sn_create",
          profile: PROFILE,
          instance: INSTANCE,
          correlationId: expect.any(String),
          outcome: "handler_error",
          reason: "handler_threw",
          errorCategory: "authorization",
          retry: "retry_after_correction",
          retryAfterSeconds: null,
        })
      );
      expect(harness.auditWrite).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          tool: "sn_update",
          profile: PROFILE,
          instance: INSTANCE,
          correlationId: expect.any(String),
          outcome: "handler_error",
          reason: "handler_threw",
          errorCategory: "authorization",
          retry: "retry_after_correction",
          retryAfterSeconds: null,
        })
      );
      expect(JSON.stringify(harness.auditWrite.mock.calls)).not.toMatch(
        /create-acl-body-must-not-return|update-acl-body-must-not-return/u
      );
    } finally {
      await client.close();
    }
  });
});
