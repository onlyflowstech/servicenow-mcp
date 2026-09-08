import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type Tool,
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
  productionToolOutputSchemas,
  type ProductionToolName,
} from "../src/tools/result-envelope.js";
import {
  defineContextOnlyToolModule,
  registerServiceNowToolModules,
  registerServiceNowTools,
  toolModules,
  withRequiredProfile,
  type ToolModuleContract,
} from "../src/tools/index.js";

const TOKEN = "snsdk-50-output-token-012345678901234567890123456";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const PROFILE = "representative-production";
const INSTANCE = "https://structured-output.service-now.com";
const SYS_ID = "abcdef0123456789abcdef0123456789";
const CREATED_SYS_ID = "1".repeat(32);
const REPRESENTATIVE_NAMES = [
  "sn_schema",
  "sn_query",
  "sn_get",
  "sn_create",
  "sn_update",
] as const satisfies readonly ProductionToolName[];
type RepresentativeName = (typeof REPRESENTATIVE_NAMES)[number];

const CANARIES: Readonly<Record<RepresentativeName, string>> = Object.freeze({
  sn_schema: "schema-label-structured-canary",
  sn_query: "query-record-structured-canary",
  sn_get: "get-record-structured-canary",
  sn_create: "create-record-structured-canary",
  sn_update: "update-record-structured-canary",
});
const UPSTREAM_PROFILE_SPOOF = "attacker-selected-profile";
const UPSTREAM_SECRET = "SNSDK50_RAW_SENSITIVE_VALUE";

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
  readonly getConfig: ReturnType<typeof vi.fn>;
  readonly getClient: ReturnType<typeof vi.fn>;
  readonly auditWrite: ReturnType<typeof vi.fn>;
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
  readonly modules?: readonly ToolModuleContract[];
} = {}): Promise<Harness> {
  const profile: Profile = {
    instance: INSTANCE,
    username: "structured-output-user",
    credential: "env:SNSDK50_UNRESOLVED_TEST_SECRET",
    authType: "basic",
  };
  const config: ServiceNowConfig = {
    instance: INSTANCE,
    user: "structured-output-user",
    password: "never-resolved-or-returned",
    displayValue: "true",
    relDepth: 3,
  };
  const profileManager = {
    getProfile: vi.fn((name: string) => {
      if (name !== PROFILE) throw new Error("unknown profile");
      return profile;
    }),
    getConfig: vi.fn(() => config),
    getClient: vi.fn(() => {
      if (!options.client) throw new Error("ServiceNow must not be reached");
      return options.client;
    }),
  } as unknown as ProfileManager;
  const getConfig = profileManager.getConfig as ReturnType<typeof vi.fn>;
  const getClient = profileManager.getClient as ReturnType<typeof vi.fn>;
  const auditWrite = vi.fn();
  const runtime = createHttpRuntime({
    host: "127.0.0.1",
    port: 0,
    authenticationProvider: new StaticBearerAuthenticationProvider([
      {
        token: TOKEN,
        ownerId: "snsdk-50-owner",
        clientId: "snsdk-50-client",
      },
    ]),
    createServer: (requestContext) => {
      const executionContext: ExecutionContextDependencies = {
        requestMetadataProvider: requestContext.requestMetadataProvider,
        requestSignal: requestContext.signal,
        effectivePolicyProvider: {
          resolve: () => ({
            id: "snsdk-50-policy",
            revision: "v1",
            tableAccess: {
              readTables: ["incident", "sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice"],
              writeTables: ["incident"],
              targets: [
                {
                  table: "incident",
                  kind: "canonical" as const,
                  tools: [...REPRESENTATIVE_NAMES],
                  closureComplete: true as const,
                  relatedTables: ["incident"],
                },
                {
                  table: "sys_dictionary",
                  kind: "canonical" as const,
                  tools: ["sn_schema"],
                  closureComplete: true as const,
                  relatedTables: ["sys_dictionary"],
                },
                {
                  table: "sys_db_object",
                  kind: "canonical" as const,
                  tools: ["sn_schema"],
                  closureComplete: true as const,
                  relatedTables: ["sys_db_object"],
                },
                {
                  table: "sys_documentation",
                  kind: "canonical" as const,
                  tools: ["sn_schema"],
                  closureComplete: true as const,
                  relatedTables: ["sys_documentation"],
                },
                {
                  table: "sys_choice",
                  kind: "canonical" as const,
                  tools: ["sn_schema"],
                  closureComplete: true as const,
                  relatedTables: ["sys_choice"],
                },
              ],
            },
          }),
        },
        auditSink: { write: auditWrite, writePreContext: () => {} },
      };
      return createMcpServer({
        dependencies: { profileManager, executionContext },
        register: async (surface, dependencies) => {
          if (options.modules) {
            await registerServiceNowToolModules(
              surface,
              dependencies.profileManager,
              dependencies.executionContext,
              options.modules
            );
          } else {
            await registerServiceNowTools(
              surface,
              dependencies.profileManager,
              dependencies.executionContext
            );
          }
        },
      });
    },
  });
  openRuntimes.add(runtime);
  const { url } = await runtime.start();
  return { runtime, url, getConfig, getClient, auditWrite };
}

async function closeHarness(harness: Harness): Promise<void> {
  openRuntimes.delete(harness.runtime);
  await harness.runtime.close({ gracePeriodMs: 100 });
}

function officialClient(url: URL): CrossClient {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: AUTHORIZATION } },
  });
  const client = new Client({ name: "snsdk-50-sdk", version: "1.0.0" });
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
        clientInfo: { name: "snsdk-50-fetch", version: "1.0.0" },
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

function representativeClient(): ServiceNowClient {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/now/table/sys_dictionary") {
      return {
        result: [
          {
            sys_id: "2".repeat(32),
            element: "short_description",
            column_label: CANARIES.sn_schema,
            internal_type: "string",
            max_length: "160",
            mandatory: "true",
            reference: "",
            password: UPSTREAM_SECRET,
            profile: UPSTREAM_PROFILE_SPOOF,
          },
        ],
      };
    }
    return {
      result: {
        sys_id: SYS_ID,
        description: CANARIES.sn_get,
        password: UPSTREAM_SECRET,
        profile: UPSTREAM_PROFILE_SPOOF,
      },
    };
  });
  const getWithMeta = vi.fn(async () => ({
    data: {
      result: [
        {
          sys_id: SYS_ID,
          short_description: CANARIES.sn_query,
          password: UPSTREAM_SECRET,
          profile: UPSTREAM_PROFILE_SPOOF,
        },
      ],
    },
    status: 200,
    headers: new Headers({ "x-total-count": "1" }),
  }));
  const post = vi.fn(async () => ({
    result: {
      sys_id: CREATED_SYS_ID,
      number: "INC0010050",
      short_description: CANARIES.sn_create,
      password: UPSTREAM_SECRET,
      profile: UPSTREAM_PROFILE_SPOOF,
    },
  }));
  const patch = vi.fn(async () => ({
    result: {
      sys_id: SYS_ID,
      close_notes: CANARIES.sn_update,
      access_token: UPSTREAM_SECRET,
      profile: UPSTREAM_PROFILE_SPOOF,
    },
  }));
  return { get, getWithMeta, post, patch } as unknown as ServiceNowClient;
}

async function callRepresentativeTools(client: CrossClient) {
  return {
    sn_schema: await client.callTool("sn_schema", {
      profile: PROFILE,
      table: "incident",
      limit: 10,
    }),
    sn_query: await client.callTool("sn_query", {
      profile: PROFILE,
      table: "incident",
      fields: "sys_id,short_description",
      limit: 10,
    }),
    sn_get: await client.callTool("sn_get", {
      profile: PROFILE,
      table: "incident",
      sys_id: SYS_ID,
      fields: "sys_id,description",
    }),
    sn_create: await client.callTool("sn_create", {
      profile: PROFILE,
      table: "incident",
      fields: { short_description: CANARIES.sn_create },
    }),
    sn_update: await client.callTool("sn_update", {
      profile: PROFILE,
      table: "incident",
      sys_id: SYS_ID,
      fields: { close_notes: CANARIES.sn_update },
    }),
  } satisfies Record<RepresentativeName, CallToolResult>;
}

const VALID_METADATA = Object.freeze({
  kind: "single" as const,
  record_count: 1,
  limits: Object.freeze({ max_records: 1_000, max_bytes: 100_000 }),
  pagination: Object.freeze({ mode: "none" as const }),
  truncation: Object.freeze({ truncated: false }),
});

const INVALID_DATA: Readonly<Record<RepresentativeName, unknown>> = Object.freeze({
  sn_schema: { fields: { incompatible: true } },
  sn_query: { record_count: "one", has_more: false, results: [] },
  sn_get: { record: [] },
  sn_create: { sys_id: "invalid", table: "problem", record: {} },
  sn_update: { record: {} },
});

const VALID_DATA: Readonly<Record<RepresentativeName, unknown>> = Object.freeze({
  sn_schema: { fields: [] },
  sn_query: { record_count: 0, has_more: false, results: [] },
  sn_get: { record: {} },
  sn_create: {
    sys_id: CREATED_SYS_ID,
    table: "incident",
    record: {},
  },
  sn_update: { sys_id: SYS_ID, record: {} },
});

const incompatibleModules = Object.freeze(
  REPRESENTATIVE_NAMES.map((name) => {
    const inputSchema = withRequiredProfile(z.object({}).strict());
    const canary = `SNSDK50_RAW_INCOMPATIBLE_${name}`;
    return defineContextOnlyToolModule({
      runtime: "context-only",
      definition: {
        name,
        description: `SNSDK-50 incompatible ${name} output probe.`,
        annotations: {
          title: "SNSDK-50 incompatible output probe",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      inputSchema,
      outputSchema: productionToolOutputSchemas[name],
      requirements: {
        permissions: ["read"],
        tables: { kind: "none" },
        apis: [],
        fieldPolicies: [],
        capabilities: ["contract:incompatible-output-probe"],
      },
      resolveAccess: (args) => ({
        args: Object.freeze(inputSchema.parse(args)),
        requests: Object.freeze([]),
      }),
      handler: async () => ({
        content: [{ type: "text", text: canary }],
        structuredContent: {
          profile: UPSTREAM_PROFILE_SPOOF,
          data: INVALID_DATA[name],
          metadata: VALID_METADATA,
        },
      }),
    });
  })
);

const spoofingModules = Object.freeze(
  REPRESENTATIVE_NAMES.map((name) => {
    const inputSchema = withRequiredProfile(z.object({}).strict());
    return defineContextOnlyToolModule({
      runtime: "context-only",
      definition: {
        name,
        description: `SNSDK-50 valid ${name} profile-spoof probe.`,
        annotations: {
          title: "SNSDK-50 profile-spoof probe",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      inputSchema,
      outputSchema: productionToolOutputSchemas[name],
      requirements: {
        permissions: ["read"],
        tables: { kind: "none" },
        apis: [],
        fieldPolicies: [],
        capabilities: ["contract:profile-spoof-probe"],
      },
      resolveAccess: (args) => ({
        args: Object.freeze(inputSchema.parse(args)),
        requests: Object.freeze([]),
      }),
      handler: async () => ({
        content: [
          {
            type: "text",
            text: `SNSDK50_RAW_VALID_SPOOF_${name}`,
          },
        ],
        structuredContent: {
          profile: UPSTREAM_PROFILE_SPOOF,
          data: VALID_DATA[name],
          metadata: VALID_METADATA,
        },
      }),
    });
  })
);

describe("SNSDK-50 representative Zod output contracts", () => {
  it("binds all five catalog modules to strict profile-bearing schemas", () => {
    const representatives = toolModules.filter((module) =>
      REPRESENTATIVE_NAMES.includes(
        module.definition.name as RepresentativeName
      )
    );
    expect(representatives).toHaveLength(REPRESENTATIVE_NAMES.length);
    for (const name of REPRESENTATIVE_NAMES) {
      const module = representatives.find(
        (candidate) => candidate.definition.name === name
      );
      expect(module?.outputSchema).toBe(productionToolOutputSchemas[name]);
      expect(module?.outputSchema._def.unknownKeys).toBe("strict");
      expect(Object.keys(module?.outputSchema.shape ?? {}).sort()).toEqual([
        "data",
        "metadata",
        "profile",
      ]);
      expect(
        module?.outputSchema.safeParse({
          profile: PROFILE,
          data: INVALID_DATA[name],
          metadata: VALID_METADATA,
        }).success,
        name
      ).toBe(false);
      expect(
        module?.outputSchema.safeParse({
          profile: PROFILE,
          data: {},
          metadata: VALID_METADATA,
          undeclared: true,
        }).success,
        name
      ).toBe(false);
    }
  });

  it("validates 50,000 representative envelopes without pathological cost", () => {
    // This is a regression gate, not a benchmark. A single wall-clock reading
    // on a shared CI runner measures the runner's load as much as this code:
    // the 1000ms ceiling this replaces failed at 1117ms on a loaded runner
    // while passing locally, which taught nobody anything.
    //
    // Best-of-three discards a GC pause or a scheduling blip in one round,
    // and the ceiling is set to catch an order-of-magnitude regression rather
    // than to police normal variance.
    const ROUNDS = 3;
    const CEILING_MS = 1_500;
    const round = () => {
      const started = performance.now();
      for (let iteration = 0; iteration < 10_000; iteration += 1) {
        for (const name of REPRESENTATIVE_NAMES) {
          const parsed = productionToolOutputSchemas[name].safeParse({
            profile: PROFILE,
            data: VALID_DATA[name],
            metadata: VALID_METADATA,
          });
          if (!parsed.success) throw new Error(`${name} output did not parse`);
        }
      }
      return performance.now() - started;
    };

    const elapsed: number[] = [];
    for (let attempt = 0; attempt < ROUNDS; attempt += 1) elapsed.push(round());
    expect(Math.min(...elapsed)).toBeLessThan(CEILING_MS);
  });
});

describe.each(clients)(
  "SNSDK-50 %s structured representative outputs",
  (_label, createClient) => {
    it("advertises strict profile-bearing output schemas for all representatives", async () => {
      const harness = await createHarness();
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const tools = await client.listTools();
        for (const name of REPRESENTATIVE_NAMES) {
          const output = tools.find((tool) => tool.name === name)?.outputSchema;
          expect(output, name).toMatchObject({
            type: "object",
            additionalProperties: false,
            required: expect.arrayContaining(["data", "metadata", "profile"]),
            properties: {
              data: { type: "object", additionalProperties: false },
              metadata: { type: "object", additionalProperties: false },
              profile: { type: "string", minLength: 1 },
            },
          });
        }
        expect(harness.getConfig).not.toHaveBeenCalled();
        expect(harness.getClient).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await closeHarness(harness);
      }
    });

    it("returns schema-valid trusted profiles with concise non-duplicating text", async () => {
      const harness = await createHarness({ client: representativeClient() });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const results = await callRepresentativeTools(client);
        for (const name of REPRESENTATIVE_NAMES) {
          const result = results[name];
          expect(result.isError, name).toBeUndefined();
          expect(
            productionToolOutputSchemas[name].safeParse(result.structuredContent)
              .success,
            name
          ).toBe(true);
          expect(result.structuredContent).toMatchObject({ profile: PROFILE });
          const content = result.content[0];
          expect(content?.type, name).toBe("text");
          if (content?.type !== "text") throw new Error("Expected text summary");
          expect(content.text, name).toContain(
            `Success for profile ${JSON.stringify(PROFILE)}`
          );
          expect(content.text, name).not.toContain(CANARIES[name]);
          const serialized = JSON.stringify(result);
          expect(serialized.split(CANARIES[name]).length - 1, name).toBe(1);
          // A `profile` column in an upstream record now survives the response
          // projection, because built-in readable lists no longer withhold a
          // granted table's columns. What must still hold is that it cannot
          // forge the envelope's own trust claim: the top-level `profile` is
          // the server's, and the upstream value appears only as record data.
          expect(result.structuredContent?.profile, name).toBe(PROFILE);
          expect(result.structuredContent?.profile, name).not.toBe(
            UPSTREAM_PROFILE_SPOOF
          );
          // The sensitive-name filter is field-level and still removes this.
          expect(serialized, name).not.toContain(UPSTREAM_SECRET);
        }
        expect(results.sn_schema.structuredContent?.data).toMatchObject({
          fields: [{ field: "short_description", label: CANARIES.sn_schema }],
        });
        expect(results.sn_query.structuredContent?.data).toMatchObject({
          results: [{ short_description: CANARIES.sn_query }],
        });
        expect(results.sn_get.structuredContent?.data).toMatchObject({
          record: { description: CANARIES.sn_get },
        });
        expect(results.sn_create.structuredContent?.data).toMatchObject({
          table: "incident",
          record: { short_description: CANARIES.sn_create },
        });
        expect(results.sn_update.structuredContent?.data).toMatchObject({
          sys_id: SYS_ID,
          record: { close_notes: CANARIES.sn_update },
        });
        expect(harness.auditWrite).toHaveBeenCalledTimes(5);
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
        await closeHarness(harness);
      }
    });

    it("overwrites every valid handler profile spoof from trusted context", async () => {
      const harness = await createHarness({ modules: spoofingModules });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        for (const name of REPRESENTATIVE_NAMES) {
          const result = await client.callTool(name, { profile: PROFILE });
          expect(result.isError, name).toBeUndefined();
          expect(result.structuredContent, name).toEqual({
            profile: PROFILE,
            data: VALID_DATA[name],
            metadata: VALID_METADATA,
          });
          expect(
            productionToolOutputSchemas[name].safeParse(result.structuredContent)
              .success,
            name
          ).toBe(true);
          const serialized = JSON.stringify(result);
          expect(serialized, name).not.toContain(UPSTREAM_PROFILE_SPOOF);
          expect(serialized, name).not.toContain(
            `SNSDK50_RAW_VALID_SPOOF_${name}`
          );
          const content = result.content[0];
          expect(content?.type, name).toBe("text");
          if (content?.type !== "text") throw new Error("Expected text summary");
          expect(content.text, name).toContain(
            `Success for profile ${JSON.stringify(PROFILE)}`
          );
        }
        expect(harness.getConfig).not.toHaveBeenCalled();
        expect(harness.getClient).not.toHaveBeenCalled();
        expect(harness.auditWrite).toHaveBeenCalledTimes(5);
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
        await closeHarness(harness);
      }
    });

    it("catches every incompatible representative response without raw leakage", async () => {
      for (const module of incompatibleModules) {
        const harness = await createHarness({ modules: [module] });
        const client = createClient(harness.url);
        const canary = `SNSDK50_RAW_INCOMPATIBLE_${module.definition.name}`;
        try {
          await client.initialize();
          const result = await client.callTool(module.definition.name, {
            profile: PROFILE,
          });
          expect(result.isError, module.definition.name).toBe(true);
          expect(result.structuredContent, module.definition.name).toBeUndefined();
          expect(JSON.stringify(result), module.definition.name).toContain(
            "Error category: internal"
          );
          expect(JSON.stringify(result), module.definition.name).not.toContain(
            canary
          );
          expect(JSON.stringify(result), module.definition.name).not.toContain(
            UPSTREAM_PROFILE_SPOOF
          );
          expect(harness.getConfig).not.toHaveBeenCalled();
          expect(harness.getClient).not.toHaveBeenCalled();
          expect(harness.auditWrite).toHaveBeenCalledWith(
            expect.objectContaining({
              tool: module.definition.name,
              profile: PROFILE,
              instance: INSTANCE,
              correlationId: expect.any(String),
              outcome: "handler_error",
              reason: "handler_returned_error",
              errorCategory: "internal",
              retry: "do_not_retry",
            })
          );
        } finally {
          await client.close();
          await closeHarness(harness);
        }
      }
    });
  }
);
