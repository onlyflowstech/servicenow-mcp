import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import {
  MAX_FIELDS_PER_OPERATION,
  fieldSelectionToSysparmFields,
  resolveReadableFields,
} from "../src/field-policy.js";
import { StaticBearerAuthenticationProvider } from "../src/http-auth.js";
import {
  MCP_LIVENESS_PATH,
  MCP_READINESS_PATH,
  createHttpRuntime,
  type HttpRuntime,
} from "../src/http-runtime.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import {
  createCommonToolError,
  createToolError,
} from "../src/tool-error.js";
import {
  REGISTERED_TOOL_COUNT,
  defineContextOnlyToolModule,
  defineServiceNowToolModule,
  registerServiceNowToolModules,
  registerServiceNowTools,
  withRequiredProfile,
  withResolvedProfileOutput,
  type ToolModuleContract,
} from "../src/tools/index.js";
import { VERSION } from "../src/version.js";

const TOKEN = "snsdk-27-cross-client-token-012345678901234567890123";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const PROFILE_NAME = "secondary";
const INSTANCE = "https://example.service-now.com";
// An open readable set enumerates every column, so no `elementIN` clause is
// emitted. An operator-narrowed readable set still produces one.
const SCHEMA_DICTIONARY_QUERY =
  "name=incident^internal_type!=collection" +
  (fieldSelectionToSysparmFields(resolveReadableFields("incident", { fields: "all" }))
    ? `^elementIN${resolveReadableFields("incident", { fields: "all" }).join(",")}`
    : "") +
  "^ORDERBYelement^ORDERBYsys_id";

const expectedInputs: Record<string, readonly string[]> = {
  sn_aggregate: ["display_value", "field", "group_by", "limit", "offset", "profile", "table", "type"],
  sn_atf: ["action", "execution_id", "fields", "limit", "offset", "profile", "suite_name", "suite_sys_id", "test_sys_id", "timeout", "wait"],
  sn_attach: ["action", "attachment_sys_id", "content_base64", "content_type", "file_name", "limit", "offset", "profile", "sys_id", "table"],
  sn_batch: ["action", "confirm", "fields", "limit", "profile", "structured_query", "table"],
  sn_codesearch: ["field", "limit", "offset", "profile", "search_term", "table"],
  sn_create: ["fields", "profile", "table"],
  sn_delete: ["confirm", "profile", "sys_id", "table"],
  sn_discover: ["active", "limit", "offset", "profile", "query", "type"],
  sn_get: ["display_value", "fields", "force_recache", "identifier", "max_response_bytes", "profile", "response_format", "sys_id", "table"],
  sn_health: ["check", "profile"],
  sn_incident_add_comment: ["content", "profile", "sys_id"],
  sn_incident_add_work_note: ["content", "profile", "sys_id"],
  sn_nl: ["confirm", "execute", "force", "profile", "text"],
  sn_profile: ["profile"],
  sn_query: ["display_value", "fields", "force_recache", "limit", "max_response_bytes", "offset", "orderby", "profile", "query", "response_format", "structured_query", "table"],
  sn_relationships: ["ci_name", "class", "depth", "direction", "impact", "limit", "offset", "profile", "sys_id", "type"],
  sn_schema: ["fields_only", "force_recache", "limit", "offset", "profile", "table"],
  sn_syslog: ["fields", "level", "limit", "message", "offset", "profile", "since", "source"],
  sn_update: ["fields", "profile", "sys_id", "table"],
};

const expectedRequired: Record<string, readonly string[]> = {
  sn_aggregate: ["profile", "table", "type"],
  sn_atf: ["action", "profile"],
  sn_attach: ["action", "profile"],
  sn_batch: ["action", "profile", "structured_query", "table"],
  sn_codesearch: ["profile", "search_term"],
  sn_create: ["fields", "profile", "table"],
  sn_delete: ["confirm", "profile", "sys_id", "table"],
  sn_discover: ["profile", "type"],
  sn_get: ["profile", "table"],
  sn_health: ["profile"],
  sn_incident_add_comment: ["content", "profile", "sys_id"],
  sn_incident_add_work_note: ["content", "profile", "sys_id"],
  sn_nl: ["profile", "text"],
  sn_profile: ["profile"],
  sn_query: ["profile", "table"],
  sn_relationships: ["profile"],
  sn_schema: ["profile", "table"],
  sn_syslog: ["profile"],
  sn_update: ["fields", "profile", "sys_id", "table"],
};

const validProfileBoundaryArguments: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = Object.freeze({
  sn_aggregate: { table: "incident", type: "COUNT" },
  sn_atf: { action: "list" },
  sn_attach: { action: "list" },
  sn_batch: {
    table: "incident",
    structured_query: {
      filter: { type: "equality", field: "active", operator: "eq", value: true },
    },
    action: "update",
  },
  sn_codesearch: { search_term: "GlideRecord" },
  sn_create: { table: "incident", fields: {} },
  sn_delete: {
    table: "incident",
    sys_id: "11111111111111111111111111111111",
    confirm: false,
  },
  sn_discover: { type: "tables" },
  sn_get: {
    table: "incident",
    sys_id: "11111111111111111111111111111111",
  },
  sn_health: {},
  sn_incident_add_comment: {
    sys_id: "11111111111111111111111111111111",
    content: "contract comment",
  },
  sn_incident_add_work_note: {
    sys_id: "11111111111111111111111111111111",
    content: "contract work note",
  },
  sn_nl: { text: "show active incidents" },
  sn_profile: {},
  sn_query: { table: "incident" },
  sn_relationships: {},
  sn_schema: { table: "incident" },
  sn_syslog: {},
  sn_update: {
    table: "incident",
    sys_id: "11111111111111111111111111111111",
    fields: {},
  },
});

type CompleteAnnotations = Required<NonNullable<Tool["annotations"]>>;

const expectedAnnotations: Record<string, CompleteAnnotations> = {
  sn_aggregate: { title: "Aggregate records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_atf: { title: "Run ATF tests", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  sn_attach: { title: "Manage attachments", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  sn_batch: { title: "Bulk update/delete records", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  sn_codesearch: { title: "Search code artifacts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_create: { title: "Create record", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  sn_delete: { title: "Delete record", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  sn_discover: { title: "Discover tables, apps, and plugins", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_get: { title: "Get record", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_health: { title: "Check instance health", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_incident_add_comment: { title: "Add incident comment", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  sn_incident_add_work_note: { title: "Add incident work note", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  sn_nl: { title: "Natural language interface", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  sn_profile: { title: "Inspect instance profile", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  sn_query: { title: "Query records", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_relationships: { title: "Traverse CI relationships", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_schema: { title: "Get table schema", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_syslog: { title: "Query system logs", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sn_update: { title: "Update record", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface CrossClient {
  readonly name: string;
  initialize(): Promise<{
    readonly protocolVersion: string;
    readonly serverInfo: { readonly name: string; readonly version: string };
    readonly capabilities: Record<string, unknown>;
  }>;
  listTools(): Promise<readonly Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

interface Harness {
  readonly runtime: HttpRuntime;
  readonly url: URL;
  readonly createServer: ReturnType<typeof vi.fn>;
  readonly getProfile: ReturnType<typeof vi.fn>;
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

async function createHarness(
  options: {
    readonly readinessCheck?: () => boolean;
    readonly modules?: readonly ToolModuleContract[];
    readonly config?: ServiceNowConfig;
    readonly client?: ServiceNowClient;
    readonly readTables?: readonly string[];
    readonly writeTables?: readonly string[];
    readonly targetTools?: readonly string[];
  } = {}
): Promise<Harness> {
  const profile: Profile = {
    instance: INSTANCE,
    username: "cross-client-test",
    credential: "env:UNRESOLVED_TEST_ONLY_SECRET",
    authType: "basic",
  };
  const config: ServiceNowConfig = options.config ?? {
    instance: INSTANCE,
    user: "cross-client-test",
    password: "never-resolved-or-used",
    displayValue: "true",
    relDepth: 3,
  };
  const getProfile = vi.fn((name: string) => {
    if (name !== PROFILE_NAME) throw new Error("unknown profile");
    return profile;
  });
  const getConfig = vi.fn(() => config);
  const getClient = vi.fn(() => {
    if (options.client) return options.client;
    throw new Error("cross-client contract must not reach ServiceNow");
  });
  const profileManager = {
    getProfile,
    getConfig,
    getClient,
  } as unknown as ProfileManager;
  const auditWrite = vi.fn();
  const createServer = vi.fn((requestContext) => {
    const executionContext: ExecutionContextDependencies = {
      requestMetadataProvider: requestContext.requestMetadataProvider,
      requestSignal: requestContext.signal,
      effectivePolicyProvider: {
        resolve: () => ({
          id: "cross-client-policy",
          revision: "snsdk-27",
          tableAccess: {
            readTables: options.readTables ?? [],
            writeTables: options.writeTables ?? [],
            targets: [
              ...new Set([
                ...(options.readTables ?? []),
                ...(options.writeTables ?? []),
              ]),
            ].map((table) => ({
              table,
              kind: "canonical" as const,
              tools: options.targetTools ?? ["sn_schema"],
              closureComplete: true as const,
              relatedTables: [table],
            })),
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
  });
  const runtime = createHttpRuntime({
    host: "127.0.0.1",
    port: 0,
    authenticationProvider: bearerProvider(),
    createServer,
    ...options,
  });
  openRuntimes.add(runtime);
  const { url } = await runtime.start();
  return {
    runtime,
    url,
    createServer,
    getProfile,
    getConfig,
    getClient,
    auditWrite,
  };
}

function bearerProvider(): StaticBearerAuthenticationProvider {
  return new StaticBearerAuthenticationProvider([
    {
      token: TOKEN,
      ownerId: "cross-client-owner",
      clientId: "cross-client-client",
    },
  ]);
}

function officialClient(url: URL, authorization = AUTHORIZATION): CrossClient {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization } },
  });
  const client = new Client({
    name: "snsdk-27-official-sdk-client",
    version: "1.0.0",
  });

  return {
    name: "official MCP SDK",
    async initialize() {
      await client.connect(transport);
      openOfficialClients.add(client);
      const serverInfo = client.getServerVersion();
      const capabilities = client.getServerCapabilities();
      const protocolVersion = transport.protocolVersion;
      if (!serverInfo || !capabilities || !protocolVersion) {
        throw new Error("initialize result unavailable");
      }
      return {
        protocolVersion,
        serverInfo,
        capabilities: capabilities as Record<string, unknown>,
      };
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

function fetchJsonRpcClient(url: URL, authorization = AUTHORIZATION): CrossClient {
  let requestId = 0;
  let protocolVersion: string | undefined;

  async function request(method: string, params: Record<string, unknown>) {
    const response = await fetch(url, {
      method: "POST",
      headers: mcpHeaders(authorization, protocolVersion),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    const body = (await response.json()) as JsonRpcResponse;
    if (response.status !== 200 || body.error) {
      throw new Error(`JSON-RPC request failed (${response.status})`);
    }
    return body.result;
  }

  return {
    name: "independent Fetch JSON-RPC",
    async initialize() {
      const result = (await request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "snsdk-27-fetch-client", version: "1.0.0" },
      })) as {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: Record<string, unknown>;
      };
      protocolVersion = result.protocolVersion;
      const initialized = await fetch(url, {
        method: "POST",
        headers: mcpHeaders(authorization, protocolVersion),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      if (initialized.status !== 202) {
        throw new Error(`initialized notification failed (${initialized.status})`);
      }
      return result;
    },
    async listTools() {
      const result = (await request("tools/list", {})) as { tools: Tool[] };
      return result.tools;
    },
    async callTool(name, args) {
      return (await request("tools/call", { name, arguments: args })) as CallToolResult;
    },
    async close() {},
  };
}

function mcpHeaders(
  authorization = AUTHORIZATION,
  protocolVersion?: string
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization,
    "content-type": "application/json",
    ...(protocolVersion === undefined
      ? {}
      : { "mcp-protocol-version": protocolVersion }),
  };
}

function assertExactDiscovery(tools: readonly Tool[]): void {
  expect(tools).toHaveLength(REGISTERED_TOOL_COUNT);
  const names = tools.map((tool) => tool.name);
  expect(new Set(names).size).toBe(REGISTERED_TOOL_COUNT);
  expect([...names].sort()).toEqual(Object.keys(expectedInputs).sort());

  for (const tool of tools) {
    expect(tool.inputSchema.type, tool.name).toBe("object");
    expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort(), tool.name).toEqual(
      expectedInputs[tool.name]
    );
    expect([...(tool.inputSchema.required ?? [])].sort(), tool.name).toEqual(
      expectedRequired[tool.name]
    );
    expect(tool.inputSchema.properties?.profile, tool.name).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(tool.outputSchema, tool.name).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["data", "metadata", "profile"]),
      properties: {
        profile: { type: "string", minLength: 1 },
        metadata: { type: "object", additionalProperties: false },
      },
    });
    expect(tool.annotations, tool.name).toEqual(expectedAnnotations[tool.name]);
  }
}

const clientFactories = [
  ["official MCP SDK", officialClient],
  ["independent Fetch JSON-RPC", fetchJsonRpcClient],
] as const;

const probeAnnotations = Object.freeze({
  title: "SNSDK-45 contract probe",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const outputProbeInput = withRequiredProfile(
  z.object({
    case: z.enum([
      "missing",
      "mistyped",
      "undeclared",
      "top_level_meta",
      "top_level_extra",
      "content_extra",
      "non_text_content",
      "multiple_content",
      "false_error",
      "spoofed_profile",
      "valid",
    ]),
  })
);
const outputProbeOutput = withResolvedProfileOutput(
  z.object({ count: z.number().int().nonnegative() })
);

const outputProbeModule = defineContextOnlyToolModule({
  runtime: "context-only",
  definition: {
    name: "sn_output_contract_probe",
    description: "Adversarial structured-output contract fixture.",
    annotations: probeAnnotations,
  },
  inputSchema: outputProbeInput,
  outputSchema: outputProbeOutput,
  requirements: {
    permissions: ["read"],
    tables: { kind: "none" },
    apis: [],
    fieldPolicies: [],
    capabilities: ["contract:output-probe"],
  },
  resolveAccess: (args) => ({
    args: Object.freeze(outputProbeInput.parse(args)),
    requests: Object.freeze([]),
  }),
  handler: async (args) => {
    const valid = {
      content: [{ type: "text" as const, text: "output contract probe" }],
      structuredContent: { count: 1 },
    };
    if (args.case === "top_level_meta") {
      return {
        ...valid,
        _meta: { credential: "RAW_TOP_LEVEL_META_SECRET" },
      } as CallToolResult;
    }
    if (args.case === "top_level_extra") {
      return {
        ...valid,
        credential: "RAW_TOP_LEVEL_EXTRA_SECRET",
      } as CallToolResult;
    }
    if (args.case === "content_extra") {
      return {
        ...valid,
        content: [
          {
            type: "text",
            text: "output contract probe",
            credential: "RAW_CONTENT_EXTRA_SECRET",
          },
        ],
      } as CallToolResult;
    }
    if (args.case === "non_text_content") {
      return {
        ...valid,
        content: [
          {
            type: "image",
            data: "RAW_NON_TEXT_CONTENT_SECRET",
            mimeType: "image/png",
          },
        ],
      } as CallToolResult;
    }
    if (args.case === "multiple_content") {
      return {
        ...valid,
        content: [
          { type: "text", text: "output contract probe" },
          { type: "text", text: "RAW_MULTIPLE_CONTENT_SECRET" },
        ],
      } as CallToolResult;
    }
    if (args.case === "false_error") {
      return { ...valid, isError: false } as CallToolResult;
    }
    const structuredContent =
      args.case === "missing"
        ? {}
        : args.case === "mistyped"
          ? { count: "1" }
          : args.case === "undeclared"
            ? { count: 1, credential: "must-never-cross-output-boundary" }
            : args.case === "spoofed_profile"
              ? { count: 1, profile: "attacker-selected-profile" }
            : { count: 1 };
    return { ...valid, structuredContent };
  },
});

const taxonomyProbeInput = withRequiredProfile(
  z.object({ case: z.enum(["unanimous", "mixed"]) })
);
const taxonomyProbeOutput = withResolvedProfileOutput(
  z.object({ unreachable: z.boolean() })
);
const taxonomyProbeModule = defineContextOnlyToolModule({
  runtime: "context-only",
  definition: {
    name: "sn_error_taxonomy_probe",
    description: "Aggregate error taxonomy fixture.",
    annotations: probeAnnotations,
  },
  inputSchema: taxonomyProbeInput,
  outputSchema: taxonomyProbeOutput,
  requirements: {
    permissions: ["read"],
    tables: { kind: "none" },
    apis: [],
    fieldPolicies: [],
    capabilities: ["contract:error-taxonomy-probe"],
  },
  resolveAccess: (args) => ({
    args: Object.freeze(taxonomyProbeInput.parse(args)),
    requests: Object.freeze([]),
  }),
  handler: async (args) => {
    throw createCommonToolError(
      args.case === "unanimous"
        ? [
            createToolError("authorization", "retry_after_correction"),
            createToolError("authorization", "retry_after_correction"),
          ]
        : [
            createToolError("authorization", "retry_after_correction"),
            new Error("RAW_MIXED_TAXONOMY_SECRET"),
          ]
    );
  },
});

const leakProbeInput = withRequiredProfile(z.object({}));
const leakProbeOutput = withResolvedProfileOutput(
  z.object({
    leaked: z.boolean(),
    facade_keys: z.array(z.string()),
    prototype_is_null: z.boolean(),
  })
);

const leakProbeModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition: {
    name: "sn_credential_leak_probe",
    description: "Adversarial handler-service reflection fixture.",
    annotations: probeAnnotations,
  },
  inputSchema: leakProbeInput,
  outputSchema: leakProbeOutput,
  requirements: {
    permissions: ["read"],
    tables: { kind: "none" },
    apis: [],
    fieldPolicies: [],
    capabilities: ["contract:credential-leak-probe"],
  },
  resolveAccess: (args) => ({
    args: Object.freeze(leakProbeInput.parse(args)),
    requests: Object.freeze([]),
  }),
  handler: async (_args, services) => {
    const facade = services.serviceNow as unknown as Record<PropertyKey, unknown>;
    const candidates = [
      services,
      facade,
      Reflect.get(services, "client"),
      Reflect.get(facade, "config"),
      Reflect.get(facade, "auth"),
      Object.getPrototypeOf(facade),
    ];
    const reflected = candidates.flatMap((candidate) => {
      if ((typeof candidate !== "object" || candidate === null) &&
          typeof candidate !== "function") return [candidate];
      return Reflect.ownKeys(candidate).flatMap((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        return [String(key), descriptor && "value" in descriptor ? descriptor.value : undefined];
      });
    });
    const serialized = JSON.stringify(reflected);
    const secrets = [
      "cross-client-password-secret",
      "cross-client-api-key-secret",
      "cross-client-client-secret",
      "env:CROSS_CLIENT_CREDENTIAL_REFERENCE",
    ];
    return {
      content: [{ type: "text", text: "credential reflection probe" }],
      structuredContent: {
        leaked: secrets.some((secret) => serialized.includes(secret)),
        facade_keys: Reflect.ownKeys(facade).map(String).sort(),
        prototype_is_null: Object.getPrototypeOf(facade) === null,
      },
    };
  },
});

describe.each(clientFactories)("SNSDK-27 %s contract", (_label, createClient) => {
  it("initializes and discovers the exact 19-tool schema and annotation contract", async () => {
    const harness = await createHarness();
    const client = createClient(harness.url);
    try {
      const initialized = await client.initialize();
      expect(initialized.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      expect(initialized.serverInfo).toEqual({
        name: "@onlyflows/servicenow-mcp",
        version: VERSION,
      });
      expect(initialized.capabilities).toHaveProperty("tools");
      assertExactDiscovery(await client.listTools());
    } finally {
      await client.close();
    }
  });

  it("returns a representative structured profile result without credentials", async () => {
    const harness = await createHarness();
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const result = await client.callTool("sn_profile", { profile: PROFILE_NAME });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        profile: PROFILE_NAME,
        data: {
          name: PROFILE_NAME,
          instance: INSTANCE,
          auth_type: "basic",
        },
        metadata: {
          kind: "single",
          pagination: { mode: "none" },
        },
      });
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain(`Success for profile ${JSON.stringify(PROFILE_NAME)}`);
      expect(text).not.toContain("credential");
      expect(text).not.toContain("password");
      expect(harness.getProfile).toHaveBeenCalledWith(PROFILE_NAME);
      expect(harness.getConfig).not.toHaveBeenCalled();
      expect(harness.getClient).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("appends both incident journal fields through exact non-secret results", async () => {
    const patch = vi.fn(async () => ({
      result: {
        sys_id: "1".repeat(32),
        comments: "upstream-must-not-return",
        work_notes: "upstream-must-not-return",
      },
    }));
    const harness = await createHarness({
      client: { patch } as unknown as ServiceNowClient,
      writeTables: ["incident"],
      targetTools: [
        "sn_incident_add_comment",
        "sn_incident_add_work_note",
      ],
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      for (const [name, field] of [
        ["sn_incident_add_comment", "comments"],
        ["sn_incident_add_work_note", "work_notes"],
      ] as const) {
        const canary = `${name}-secret-journal-canary`;
        const result = await client.callTool(name, {
          profile: PROFILE_NAME,
          sys_id: "1".repeat(32),
          content: canary,
        });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          profile: PROFILE_NAME,
          data: {
            status: "appended",
            sys_id: "1".repeat(32),
            journal_field: field,
          },
          metadata: { kind: "operation" },
        });
        expect(JSON.stringify(result)).not.toContain(canary);
        expect(JSON.stringify(result)).not.toContain("upstream-must-not-return");
      }
      expect(patch).toHaveBeenNthCalledWith(
        1,
        `/api/now/table/incident/${"1".repeat(32)}`,
        { comments: "sn_incident_add_comment-secret-journal-canary" }
      );
      expect(patch).toHaveBeenNthCalledWith(
        2,
        `/api/now/table/incident/${"1".repeat(32)}`,
        { work_notes: "sn_incident_add_work_note-secret-journal-canary" }
      );
    } finally {
      await client.close();
    }
  });

  it("rejects generic journal updates with exact migration guidance before clients", async () => {
    const patch = vi.fn();
    const harness = await createHarness({
      client: { patch } as unknown as ServiceNowClient,
      writeTables: ["incident"],
      targetTools: ["sn_update"],
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      for (const [field, dedicatedTool] of [
        ["comments", "sn_incident_add_comment"],
        ["work_notes", "sn_incident_add_work_note"],
      ] as const) {
        const canary = `${field}-must-not-return`;
        const result = await client.callTool("sn_update", {
          profile: PROFILE_NAME,
          table: "incident",
          sys_id: "1".repeat(32),
          fields: { [field]: canary },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(dedicatedTool);
        expect(JSON.stringify(result)).not.toContain(canary);
      }
      expect(harness.getProfile).toHaveBeenCalledTimes(2);
      expect(harness.getConfig).not.toHaveBeenCalled();
      expect(harness.getClient).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("invokes the bounded sn_schema module with identical production semantics", async () => {
    const get = vi.fn(async () => ({
      result: [
        {
          sys_id: "2".repeat(32),
          element: "short_description",
          column_label: "Short description",
          internal_type: "string",
          max_length: "160",
          mandatory: "false",
          reference: "",
        },
        {
          sys_id: "1".repeat(32),
          element: "number",
          column_label: "Number",
          internal_type: "string",
          max_length: "40",
          mandatory: "true",
          reference: "",
        },
      ],
    }));
    const harness = await createHarness({
      client: { get } as unknown as ServiceNowClient,
      readTables: ["incident", "sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice"],
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const result = await client.callTool("sn_schema", {
        profile: PROFILE_NAME,
        table: "incident",
        limit: 2,
        offset: 0,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        profile: PROFILE_NAME,
        data: {
          fields: [
            { field: "number", label: "Number" },
            { field: "short_description", label: "Short description" },
          ],
        },
        metadata: {
          kind: "collection",
          record_count: 2,
          pagination: {
            mode: "offset",
            limit: 2,
            offset: 0,
            returned: 2,
            has_more: false,
            order_by: ["field", "sys_id"],
          },
        },
      });
      expect(get).toHaveBeenCalledWith("/api/now/table/sys_dictionary", {
        sysparm_query: SCHEMA_DICTIONARY_QUERY.replace("name=incident", "nameINincident"),
        sysparm_fields:
          "sys_id,name,element,column_label,internal_type,max_length,mandatory,reference",
        sysparm_limit: String(MAX_FIELDS_PER_OPERATION + 1),
        sysparm_offset: "0",
        sysparm_display_value: "true",
      });
    } finally {
      await client.close();
    }
  });

  it("fails a schema resource-cap violation through the shared safe boundary", async () => {
    const get = vi.fn(async () => ({
      result: Array.from(
        { length: MAX_FIELDS_PER_OPERATION + 1 },
        (_, index) => ({
          sys_id: String(index).padStart(32, "0"),
          element: "number",
          column_label: "secret-upstream-cap-probe",
          internal_type: "string",
          max_length: "40",
          mandatory: "false",
          reference: "",
        })
      ),
    }));
    const harness = await createHarness({
      client: { get } as unknown as ServiceNowClient,
      readTables: ["incident", "sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice"],
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const result = await client.callTool("sn_schema", {
        profile: PROFILE_NAME,
        table: "incident",
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain("Error category: internal");
      expect(JSON.stringify(result)).not.toContain("authorized field bound");
      expect(JSON.stringify(result)).not.toContain("secret-upstream-cap-probe");
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  });

  it("rejects missing and unknown profiles before credential or client execution", async () => {
    const harness = await createHarness();
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const missing = await client.callTool("sn_profile", {});
      expect(missing.isError).toBe(true);
      expect(harness.getProfile).not.toHaveBeenCalled();
      expect(harness.getConfig).not.toHaveBeenCalled();
      expect(harness.getClient).not.toHaveBeenCalled();

      const unknown = await client.callTool("sn_profile", {
        profile: "unknown-profile",
      });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown)).toContain("Unknown profile");
      expect(harness.getProfile).toHaveBeenCalledOnce();
      expect(harness.getProfile).toHaveBeenCalledWith("unknown-profile");
      expect(harness.getConfig).not.toHaveBeenCalled();
      expect(harness.getClient).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("enforces every tool profile boundary before credentials, client, or handler", async () => {
    const harness = await createHarness();
    const client = createClient(harness.url);
    try {
      await client.initialize();
      expect(Object.keys(validProfileBoundaryArguments).sort()).toEqual(
        Object.keys(expectedInputs).sort()
      );

      for (const [name, baseArguments] of Object.entries(
        validProfileBoundaryArguments
      )) {
        for (const profileCase of [
          { label: "missing" },
          { label: "empty", value: "" },
          { label: "whitespace", value: "   " },
          { label: "malformed", value: { name: PROFILE_NAME } },
        ]) {
          const args =
            profileCase.label === "missing"
              ? { ...baseArguments }
              : { ...baseArguments, profile: profileCase.value };
          const result = await client.callTool(name, args);
          expect(result.isError, `${name}: ${profileCase.label}`).toBe(true);
        }
      }

      expect(harness.getProfile).not.toHaveBeenCalled();
      expect(harness.getConfig).not.toHaveBeenCalled();
      expect(harness.getClient).not.toHaveBeenCalled();

      for (const [name, baseArguments] of Object.entries(
        validProfileBoundaryArguments
      )) {
        const result = await client.callTool(name, {
          ...baseArguments,
          profile: "unknown-profile",
        });
        expect(result.isError, name).toBe(true);
        expect(JSON.stringify(result), name).toContain("Unknown profile");
      }

      expect(harness.getProfile).toHaveBeenCalledTimes(
        Object.keys(validProfileBoundaryArguments).length
      );
      expect(harness.getConfig).not.toHaveBeenCalled();
      expect(harness.getClient).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  }, _label === "official MCP SDK" ? 10_000 : 5_000);
});

describe.each(clientFactories)(
  "SNSDK-47 %s sn_query behavior",
  (_label, createClient) => {
    it("executes a structured deterministic page with the exact safe envelope", async () => {
      const getWithMeta = vi.fn(async () => ({
        data: {
          result: [
            {
              sys_id: "1".repeat(32),
              number: "INC0010001",
              priority: "1",
              password: "must-not-cross",
            },
          ],
        },
        status: 200,
        headers: new Headers({ "x-total-count": "2" }),
      }));
      const harness = await createHarness({
        client: { getWithMeta } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_query"],
      });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const result = await client.callTool("sn_query", {
          profile: PROFILE_NAME,
          table: "incident",
          fields: "sys_id,number,priority",
          limit: 1,
          offset: 0,
          structured_query: {
            filter: {
              type: "equality",
              field: "priority",
              operator: "eq",
              value: "1",
            },
            order_by: [{ field: "number", direction: "asc" }],
          },
        });

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          profile: PROFILE_NAME,
          data: {
            record_count: 1,
            total: 2,
            has_more: true,
            next_offset: 1,
            results: [
              {
                sys_id: "1".repeat(32),
                number: "INC0010001",
                priority: "1",
              },
            ],
          },
          metadata: {
            kind: "collection",
            record_count: 1,
            pagination: {
              mode: "offset",
              limit: 1,
              offset: 0,
              returned: 1,
              has_more: true,
              next_offset: 1,
              order_by: ["number", "sys_id"],
            },
            truncation: { truncated: false },
          },
        });
        expect(JSON.stringify(result)).not.toContain("password");
        expect(getWithMeta).toHaveBeenCalledWith("/api/now/table/incident", {
          sysparm_exclude_reference_link: "true",
          sysparm_limit: "2",
          sysparm_query: "priority=1^ORDERBYnumber^ORDERBYsys_id",
          sysparm_fields: "sys_id,number,priority",
          sysparm_offset: "0",
          sysparm_display_value: "true",
          sysparm_no_count: "true",
        });
      } finally {
        await client.close();
      }
    });

    it("preserves recovery and post-window resume when handler fitting keeps zero rows", async () => {
      const records = [
        {
          sys_id: "1".repeat(32),
          description: "whole-record-canary-" + "x".repeat(5_000),
        },
      ];
      const before = JSON.stringify(records);
      const getWithMeta = vi.fn(async () => ({
        data: { result: records },
        status: 200,
        headers: new Headers({ "x-total-count": "100" }),
      }));
      const harness = await createHarness({
        client: { getWithMeta } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_query"],
      });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const result = await client.callTool("sn_query", {
          profile: PROFILE_NAME,
          table: "incident",
          fields: "sys_id,description",
          limit: 1,
          offset: 41,
          max_response_bytes: 1_000,
        });

        expect(result.isError).toBeUndefined();
        expect(JSON.stringify(records)).toBe(before);
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
          1_000
        );
        expect(result.structuredContent).toMatchObject({
          profile: PROFILE_NAME,
          data: {
            record_count: 0,
            total: 100,
            has_more: true,
            next_offset: 42,
            truncated: true,
            dropped_records: 1,
            results: [],
          },
          metadata: {
            record_count: 0,
            pagination: {
              mode: "offset",
              limit: 1,
              offset: 41,
              returned: 0,
              has_more: true,
              next_offset: 42,
              recovery: "adjust_request_and_retry_same_offset",
            },
            truncation: {
              truncated: true,
              reason: "byte_limit",
              dropped_records: 1,
            },
          },
        });
        const summary = result.content[0];
        expect(summary?.type).toBe("text");
        if (summary?.type !== "text") throw new TypeError("expected text summary");
        expect(summary.text).toContain("retry offset 41");
        expect(summary.text).toContain("offset 42 only to resume");
        expect(JSON.stringify(result)).not.toContain("whole-record-canary");
        expect(getWithMeta).toHaveBeenCalledWith(
          "/api/now/table/incident",
          expect.objectContaining({
            sysparm_limit: "2",
            sysparm_offset: "41",
          })
        );
      } finally {
        await client.close();
      }
    });

    it("rejects unauthorized and malformed legacy sort fields before secrets or upstream access", async () => {
      const getWithMeta = vi.fn();
      const harness = await createHarness({
        client: { getWithMeta } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_query"],
      });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const deniedResults = await Promise.all(
          [
            "password",
            "-",
            "priority^ORDERBYpassword",
            "priority,number",
          ].map((orderby) =>
            client.callTool("sn_query", {
              profile: PROFILE_NAME,
              table: "incident",
              orderby,
            })
          )
        );

        for (const result of deniedResults) {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toBeUndefined();
        }
        expect(JSON.stringify(deniedResults)).not.toMatch(
          /password|priority\^ORDERBYpassword|priority,number/u
        );
        expect(harness.getConfig).not.toHaveBeenCalled();
        expect(harness.getClient).not.toHaveBeenCalled();
        expect(getWithMeta).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    });

    it("canonicalizes approved legacy ascending and descending sorts before execution", async () => {
      const getWithMeta = vi.fn(async () => ({
        data: { result: [{ sys_id: "1".repeat(32), priority: "1" }] },
        status: 200,
        headers: new Headers(),
      }));
      const harness = await createHarness({
        client: { getWithMeta } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_query"],
      });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const ascending = await client.callTool("sn_query", {
          profile: PROFILE_NAME,
          table: "incident",
          orderby: " PRIORITY ",
        });
        const descending = await client.callTool("sn_query", {
          profile: PROFILE_NAME,
          table: "incident",
          orderby: " -Priority ",
        });

        expect(ascending.isError).toBeUndefined();
        expect(descending.isError).toBeUndefined();
        expect(getWithMeta).toHaveBeenNthCalledWith(
          1,
          "/api/now/table/incident",
          expect.objectContaining({
            sysparm_query: "ORDERBYpriority^ORDERBYsys_id",
          })
        );
        expect(getWithMeta).toHaveBeenNthCalledWith(
          2,
          "/api/now/table/incident",
          expect.objectContaining({
            sysparm_query: "ORDERBYDESCpriority^ORDERBYsys_id",
          })
        );
      } finally {
        await client.close();
      }
    });

    it("fails unsafe table, field, operator, and raw modes before client creation", async () => {
      const getWithMeta = vi.fn();
      const harness = await createHarness({
        client: { getWithMeta } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_query"],
      });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const result = await client.callTool("sn_query", {
          profile: PROFILE_NAME,
          table: "incident",
          query: "active=true^password=raw-secret-must-not-cross",
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(JSON.stringify(result)).toContain("Use structured_query");
        expect(JSON.stringify(result)).not.toContain("raw-secret-must-not-cross");

        const deniedTable = await client.callTool("sn_query", {
          profile: PROFILE_NAME,
          table: "problem",
          structured_query: {
            filter: {
              type: "equality",
              field: "active",
              operator: "eq",
              value: true,
            },
          },
        });
        const deniedField = await client.callTool("sn_query", {
          profile: PROFILE_NAME,
          table: "incident",
          fields: "sys_id,password",
        });
        const deniedOperator = await client.callTool("sn_query", {
          profile: PROFILE_NAME,
          table: "incident",
          structured_query: {
            filter: {
              type: "text",
              field: "short_description",
              operator: "javascript",
              value: "unsafe-operator-secret",
            },
          },
        });
        for (const denied of [deniedTable, deniedField, deniedOperator]) {
          expect(denied.isError).toBe(true);
          expect(denied.structuredContent).toBeUndefined();
        }
        expect(JSON.stringify([deniedTable, deniedField, deniedOperator])).not.toMatch(
          /password|unsafe-operator-secret/u
        );
        expect(harness.getConfig).not.toHaveBeenCalled();
        expect(harness.getClient).not.toHaveBeenCalled();
        expect(getWithMeta).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    });
  }
);

describe.each(clientFactories)(
  "SNSDK-48 %s sn_get identifier behavior",
  (_label, createClient) => {
    it("gets one record by canonical sys_id with an exact filtered envelope", async () => {
      const sysId = "a".repeat(32);
      const get = vi.fn(async () => ({
        result: {
          sys_id: sysId,
          number: "INC0012345",
          short_description: "Database down",
          password: "upstream-secret-must-not-cross",
        },
      }));
      const harness = await createHarness({
        client: { get } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_get"],
      });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const result = await client.callTool("sn_get", {
          profile: PROFILE_NAME,
          table: " INCIDENT ",
          sys_id: sysId.toUpperCase(),
          fields: "sys_id,number,short_description",
        });

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          profile: PROFILE_NAME,
          data: {
            record: {
              sys_id: sysId,
              number: "INC0012345",
              short_description: "Database down",
            },
          },
          metadata: {
            kind: "single",
            record_count: 1,
            pagination: { mode: "none" },
            truncation: { truncated: false },
          },
        });
        expect(JSON.stringify(result)).not.toContain("upstream-secret-must-not-cross");
        expect(get).toHaveBeenCalledWith(`/api/now/table/incident/${sysId}`, {
          sysparm_exclude_reference_link: "true",
          sysparm_fields: "sys_id,number,short_description",
          sysparm_display_value: "true",
        });
        expect(harness.auditWrite).toHaveBeenCalledWith(
          expect.objectContaining({
            tool: "sn_get",
            profile: PROFILE_NAME,
            instance: INSTANCE,
            outcome: "success",
            reason: null,
          })
        );
      } finally {
        await client.close();
      }
    });

    it("resolves one approved identifier through exact equality and limit two", async () => {
      const get = vi.fn(async () => ({
        result: [
          {
            sys_id: "b".repeat(32),
            number: "INC0012345",
            short_description: "Database down",
            password: "identifier-upstream-secret-must-not-cross",
          },
        ],
      }));
      const harness = await createHarness({
        client: { get } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_get"],
      });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const result = await client.callTool("sn_get", {
          profile: PROFILE_NAME,
          table: "incident",
          identifier: { field: " NUMBER ", value: " INC0012345 " },
          fields: "number,short_description",
        });

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
          profile: PROFILE_NAME,
          data: {
            record: {
              number: "INC0012345",
              short_description: "Database down",
            },
          },
          metadata: {
            kind: "single",
            record_count: 1,
            pagination: { mode: "none" },
          },
        });
        expect(JSON.stringify(result)).not.toMatch(/password|identifier-upstream-secret/u);
        expect(get).toHaveBeenCalledWith("/api/now/table/incident", {
          sysparm_exclude_reference_link: "true",
          sysparm_limit: "2",
          sysparm_query: "number=INC0012345^ORDERBYsys_id",
          sysparm_fields: "number,short_description,sys_id",
          sysparm_display_value: "true",
        });
      } finally {
        await client.close();
      }
    });

    it("normalizes no-match and ambiguous identifiers without returning or auditing values", async () => {
      const get = vi.fn(async (_path: string, params?: Record<string, string>) => ({
        result: params?.sysparm_query?.includes("NOTFOUND")
          ? []
          : [{ sys_id: "1".repeat(32) }, { sys_id: "2".repeat(32) }],
      }));
      const harness = await createHarness({
        client: { get } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_get"],
      });
      const client = createClient(harness.url);
      const notFoundValue = "NOTFOUND-SECRET-VALUE";
      const ambiguousValue = "AMBIGUOUS-SECRET-VALUE";
      try {
        await client.initialize();
        const notFound = await client.callTool("sn_get", {
          profile: PROFILE_NAME,
          table: "incident",
          identifier: { field: "number", value: notFoundValue },
        });
        const ambiguous = await client.callTool("sn_get", {
          profile: PROFILE_NAME,
          table: "incident",
          identifier: { field: "number", value: ambiguousValue },
        });

        expect(notFound.isError).toBe(true);
        expect(JSON.stringify(notFound)).toContain("Error category: not_found");
        expect(JSON.stringify(notFound)).toContain(
          "Retry unchanged is not recommended."
        );
        expect(ambiguous.isError).toBe(true);
        expect(JSON.stringify(ambiguous)).toContain("Error category: conflict");
        expect(JSON.stringify(ambiguous)).toContain(
          "Retry after correcting the request or configuration."
        );
        expect(JSON.stringify([notFound, ambiguous])).not.toMatch(
          /NOTFOUND-SECRET-VALUE|AMBIGUOUS-SECRET-VALUE/u
        );
        expect(JSON.stringify(get.mock.calls)).toContain(notFoundValue);
        expect(JSON.stringify(get.mock.calls)).toContain(ambiguousValue);
        expect(harness.auditWrite).toHaveBeenCalledTimes(2);
        expect(harness.auditWrite).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            tool: "sn_get",
            outcome: "handler_error",
            reason: "handler_threw",
            errorCategory: "not_found",
            retry: "do_not_retry",
          })
        );
        expect(harness.auditWrite).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            tool: "sn_get",
            outcome: "handler_error",
            reason: "handler_threw",
            errorCategory: "conflict",
            retry: "retry_after_correction",
          })
        );
        expect(JSON.stringify(harness.auditWrite.mock.calls)).not.toMatch(
          /NOTFOUND-SECRET-VALUE|AMBIGUOUS-SECRET-VALUE/u
        );
      } finally {
        await client.close();
      }
    });

    it("rejects malformed and unsupported selectors before configuration or client work", async () => {
      const get = vi.fn();
      const harness = await createHarness({
        client: { get } as unknown as ServiceNowClient,
        readTables: ["incident"],
        targetTools: ["sn_get"],
      });
      const client = createClient(harness.url);
      try {
        await client.initialize();
        const denials = await Promise.all([
          client.callTool("sn_get", {
            profile: PROFILE_NAME,
            table: "incident",
          }),
          client.callTool("sn_get", {
            profile: PROFILE_NAME,
            table: "incident",
            sys_id: "1".repeat(32),
            identifier: { field: "number", value: "BOTH-SELECTOR-CANARY" },
          }),
          client.callTool("sn_get", {
            profile: PROFILE_NAME,
            table: "incident",
            identifier: {
              field: "short_description",
              value: "UNAUTHORIZED-FIELD-CANARY",
            },
          }),
          client.callTool("sn_get", {
            profile: PROFILE_NAME,
            table: "syslog",
            identifier: { field: "source", value: "UNSUPPORTED-TABLE-CANARY" },
          }),
          ...["constructor", "toString", "__proto__"].map((table) =>
            client.callTool("sn_get", {
              profile: PROFILE_NAME,
              table,
              identifier: { field: "name", value: "INHERITED-KEY-CANARY" },
            })
          ),
          client.callTool("sn_get", {
            profile: PROFILE_NAME,
            table: "incident",
            identifier: { field: "number", value: "INJECTION^ORactive=true" },
          }),
        ]);

        for (const denial of denials) {
          expect(denial.isError).toBe(true);
          expect(denial.structuredContent).toBeUndefined();
        }
        expect(JSON.stringify(denials)).not.toMatch(
          /BOTH-SELECTOR-CANARY|UNAUTHORIZED-FIELD-CANARY|UNSUPPORTED-TABLE-CANARY|INHERITED-KEY-CANARY|INJECTION/u
        );
        expect(harness.getConfig).not.toHaveBeenCalled();
        expect(harness.getClient).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
        expect(harness.auditWrite).toHaveBeenCalledTimes(7);
        // These selectors are all denied by the table boundary now: field
        // policy no longer denies a table it has no entry for, and none of
        // them names a sensitive field. Every one is still a policy rejection
        // recorded before credential or upstream work.
        expect(
          harness.auditWrite.mock.calls.filter(
            ([record]) => record.reason === "field_access_denied"
          )
        ).toHaveLength(0);
        for (const [record] of harness.auditWrite.mock.calls) {
          expect(record).toMatchObject({
            tool: "sn_get",
            profile: PROFILE_NAME,
            instance: INSTANCE,
            outcome: "policy_rejected",
          });
          expect(["table_access_denied", "field_access_denied"]).toContain(
            record.reason
          );
        }
        expect(JSON.stringify(harness.auditWrite.mock.calls)).not.toMatch(
          /CANARY|INJECTION|password|credential/u
        );
      } finally {
        await client.close();
      }
    });
  }
);

describe.each(clientFactories)("SNSDK-45 %s module isolation", (_label, createClient) => {
  it("rejects invalid structured, top-level, and content output without leaks", async () => {
    const harness = await createHarness({ modules: [outputProbeModule] });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const discovered = await client.listTools();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].outputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: expect.arrayContaining(["count", "profile"]),
      });

      for (const outputCase of [
        "missing",
        "mistyped",
        "undeclared",
        "top_level_meta",
        "top_level_extra",
        "content_extra",
        "non_text_content",
        "multiple_content",
        "false_error",
      ] as const) {
        const result = await client.callTool("sn_output_contract_probe", {
          profile: PROFILE_NAME,
          case: outputCase,
        });
        expect(result.isError, outputCase).toBe(true);
        expect(result.structuredContent, outputCase).toBeUndefined();
        expect(JSON.stringify(result), outputCase).toContain(
          "Error category: internal"
        );
        expect(JSON.stringify(result), outputCase).not.toContain(
          "must-never-cross-output-boundary"
        );
        expect(JSON.stringify(result), outputCase).not.toMatch(
          /RAW_(?:TOP_LEVEL|CONTENT|NON_TEXT|MULTIPLE)/u
        );
      }

      const valid = await client.callTool("sn_output_contract_probe", {
        profile: PROFILE_NAME,
        case: "valid",
      });
      expect(valid.isError).toBeUndefined();
      expect(valid.structuredContent).toEqual({
        count: 1,
        profile: PROFILE_NAME,
      });

      const spoofed = await client.callTool("sn_output_contract_probe", {
        profile: PROFILE_NAME,
        case: "spoofed_profile",
      });
      expect(spoofed.isError).toBeUndefined();
      expect(spoofed.structuredContent).toEqual({
        count: 1,
        profile: PROFILE_NAME,
      });
      expect(JSON.stringify(spoofed)).not.toContain("attacker-selected-profile");
    } finally {
      await client.close();
    }
  });

  it("preserves unanimous aggregate taxonomy and fails mixed taxonomy closed", async () => {
    const harness = await createHarness({ modules: [taxonomyProbeModule] });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const unanimous = await client.callTool("sn_error_taxonomy_probe", {
        profile: PROFILE_NAME,
        case: "unanimous",
      });
      expect(unanimous.isError).toBe(true);
      expect(unanimous.structuredContent).toBeUndefined();
      expect(JSON.stringify(unanimous)).toContain(
        "Error category: authorization"
      );

      const mixed = await client.callTool("sn_error_taxonomy_probe", {
        profile: PROFILE_NAME,
        case: "mixed",
      });
      expect(mixed.isError).toBe(true);
      expect(mixed.structuredContent).toBeUndefined();
      expect(JSON.stringify(mixed)).toContain("Error category: internal");
      expect(JSON.stringify(mixed)).not.toContain("RAW_MIXED_TAXONOMY_SECRET");
    } finally {
      await client.close();
    }
  });

  it("cannot reflect credentials or the raw client from handler services", async () => {
    const secretConfig: ServiceNowConfig = {
      instance: INSTANCE,
      user: "cross-client-secret-user",
      password: "cross-client-password-secret",
      clientSecret: "cross-client-client-secret",
      apiKey: "cross-client-api-key-secret",
      authType: "basic",
      displayValue: "true",
      relDepth: 3,
    };
    const rawClient = new ServiceNowClient(secretConfig);
    const harness = await createHarness({
      modules: [leakProbeModule],
      config: secretConfig,
      client: rawClient,
    });
    const client = createClient(harness.url);
    try {
      await client.initialize();
      const result = await client.callTool("sn_credential_leak_probe", {
        profile: PROFILE_NAME,
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        leaked: false,
        facade_keys: [
          "delete",
          "get",
          "getRaw",
          "getWithMeta",
          "patch",
          "post",
          "postBinary",
        ],
        profile: PROFILE_NAME,
        prototype_is_null: true,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secretConfig.password);
      expect(serialized).not.toContain(secretConfig.clientSecret);
      expect(serialized).not.toContain(secretConfig.apiKey);
      expect(Reflect.ownKeys(rawClient)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("SNSDK-27 cross-client equivalence", () => {
  it("returns identical complete discovery documents to both client implementations", async () => {
    const harness = await createHarness();
    const official = officialClient(harness.url);
    const independent = fetchJsonRpcClient(harness.url);
    try {
      await Promise.all([official.initialize(), independent.initialize()]);
      const [officialTools, independentTools] = await Promise.all([
        official.listTools(),
        independent.listTools(),
      ]);

      assertExactDiscovery(officialTools);
      expect(independentTools).toEqual(officialTools);
    } finally {
      await Promise.all([official.close(), independent.close()]);
    }
  });

  it("keeps spoofed-profile success and invalid-output failure in client parity", async () => {
    const harness = await createHarness({ modules: [outputProbeModule] });
    const official = officialClient(harness.url);
    const independent = fetchJsonRpcClient(harness.url);
    try {
      await Promise.all([official.initialize(), independent.initialize()]);
      const [officialSpoofed, independentSpoofed] = await Promise.all([
        official.callTool("sn_output_contract_probe", {
          profile: PROFILE_NAME,
          case: "spoofed_profile",
        }),
        independent.callTool("sn_output_contract_probe", {
          profile: PROFILE_NAME,
          case: "spoofed_profile",
        }),
      ]);
      expect(officialSpoofed).toEqual(independentSpoofed);
      expect(officialSpoofed.structuredContent).toEqual({
        count: 1,
        profile: PROFILE_NAME,
      });
      expect(JSON.stringify(officialSpoofed)).not.toContain(
        "attacker-selected-profile"
      );

      const [officialInvalid, independentInvalid] = await Promise.all([
        official.callTool("sn_output_contract_probe", {
          profile: PROFILE_NAME,
          case: "undeclared",
        }),
        independent.callTool("sn_output_contract_probe", {
          profile: PROFILE_NAME,
          case: "undeclared",
        }),
      ]);
      for (const result of [officialInvalid, independentInvalid]) {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(JSON.stringify(result)).toContain("Error category: internal");
        expect(JSON.stringify(result)).not.toContain(
          "must-never-cross-output-boundary"
        );
      }
    } finally {
      await Promise.all([official.close(), independent.close()]);
    }
  });
});

describe("SNSDK-27 authentication and malformed protocol", () => {
  it("rejects the official SDK client before constructing an MCP server", async () => {
    const harness = await createHarness();
    const client = officialClient(harness.url, "Bearer invalid-cross-client-token");

    try {
      await expect(client.initialize()).rejects.toThrow();
      expect(harness.createServer).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("returns a provider-neutral 401 to independent Fetch before server construction", async () => {
    const harness = await createHarness();
    const response = await fetch(harness.url, {
      method: "POST",
      headers: mcpHeaders("Bearer invalid-cross-client-token"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "rejected-fetch-client", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(harness.createServer).not.toHaveBeenCalled();
  });

  it("maps malformed JSON and unsupported protocol versions without execution", async () => {
    const harness = await createHarness();
    const malformed = await fetch(harness.url, {
      method: "POST",
      headers: mcpHeaders(),
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });

    const unsupportedVersion = await fetch(harness.url, {
      method: "POST",
      headers: mcpHeaders(AUTHORIZATION, "1900-01-01"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(unsupportedVersion.status).toBe(400);
    expect(await unsupportedVersion.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600 },
    });
    expect(harness.getProfile).not.toHaveBeenCalled();
    expect(harness.getConfig).not.toHaveBeenCalled();
    expect(harness.getClient).not.toHaveBeenCalled();
  });

  it("rejects JSON-RPC batches before server or tool dispatch", async () => {
    const harness = await createHarness();
    const response = await fetch(harness.url, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "sn_profile", arguments: { profile: PROFILE_NAME } },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "sn_profile", arguments: { profile: PROFILE_NAME } },
        },
      ]),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600 },
    });
    expect(harness.createServer).not.toHaveBeenCalled();
    expect(harness.getProfile).not.toHaveBeenCalled();
  });
});

describe("SNSDK-27 health and lifecycle transitions", () => {
  it("reports live independently and readiness across dependency transitions", async () => {
    let dependenciesReady = false;
    const harness = await createHarness({ readinessCheck: () => dependenciesReady });
    const liveUrl = new URL(MCP_LIVENESS_PATH, harness.url);
    const readyUrl = new URL(MCP_READINESS_PATH, harness.url);

    expect(harness.runtime.isReady()).toBe(false);
    const live = await fetch(liveUrl);
    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(await live.json()).toEqual({ status: "live" });

    const unavailable = await fetch(readyUrl);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(await unavailable.json()).toEqual({ status: "not_ready" });

    dependenciesReady = true;
    expect(harness.runtime.isReady()).toBe(true);
    const ready = await fetch(readyUrl);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });

    const closing = harness.runtime.close({ gracePeriodMs: 100 });
    expect(harness.runtime.isReady()).toBe(false);
    await closing;
    expect(harness.runtime.isReady()).toBe(false);
    expect(harness.createServer).not.toHaveBeenCalled();
  });

  it.each(clientFactories)("drains an accepted %s invocation during shutdown", async (
    _label,
    createClient
  ) => {
    const entered = deferred();
    const release = deferred();
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: bearerProvider(),
      readinessCheck: () => true,
      createServer: () =>
        createMcpServer({
          dependencies: {},
          register: (surface) => {
            surface.registerTool("sn_shutdown_probe", {}, async () => {
              entered.resolve();
              await release.promise;
              return { content: [{ type: "text", text: "drained" }] };
            });
          },
        }),
    });
    openRuntimes.add(runtime);
    const { url } = await runtime.start();
    const client = createClient(url);

    try {
      await client.initialize();
      const call = client.callTool("sn_shutdown_probe", {});
      await entered.promise;
      const closing = runtime.close({ gracePeriodMs: 1_000 });
      expect(runtime.isReady()).toBe(false);
      release.resolve();

      await expect(call).resolves.toMatchObject({
        content: [{ type: "text", text: "drained" }],
      });
      await expect(closing).resolves.toBeUndefined();
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      release.resolve();
      await client.close();
    }
  });
});

describe("SNSDK-27 dependency boundary", () => {
  it("keeps non-browser clients compatible while rejecting an unconfigured browser Origin", async () => {
    const harness = await createHarness();
    const response = await fetch(harness.url, {
      method: "POST",
      headers: {
        ...mcpHeaders(),
        origin: "https://unconfigured-client.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "rejected-browser-client", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Forbidden." },
    });
    expect(harness.createServer).not.toHaveBeenCalled();
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
