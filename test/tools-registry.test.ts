import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { MAX_STRUCTURED_QUERY_NESTING } from "../src/structured-query.js";
import {
  REGISTERED_TOOL_COUNT,
  registerServiceNowTools,
} from "../src/tools/index.js";
import { DEFAULT_FIELDS } from "../src/table-defaults.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

function nestedStructuredFilter(groupDepth: number): unknown {
  let nested: unknown = {
    type: "equality",
    field: "active",
    operator: "eq",
    value: true,
  };
  for (let depth = 0; depth < groupDepth; depth += 1) {
    nested = { type: "group", operator: "and", conditions: [nested] };
  }
  return nested;
}

const TEST_TABLE_ACCESS = Object.freeze({
  readTables: Object.freeze(["incident"]),
  writeTables: Object.freeze(["incident"]),
  targets: Object.freeze([
    Object.freeze({
      table: "incident",
      kind: "canonical" as const,
      tools: Object.freeze([
        "sn_query",
        "sn_get",
        "sn_create",
        "sn_update",
        "sn_incident_add_comment",
        "sn_incident_add_work_note",
        "sn_delete",
        "sn_batch",
      ]),
      closureComplete: true as const,
      relatedTables: Object.freeze(["incident"]),
    }),
  ]),
});

interface HarnessOptions {
  configuredProfiles?: string[];
  profile?: Profile;
  client?: ServiceNowClient;
}

function createProfileManager(options: HarnessOptions = {}) {
  const events: string[] = [];
  const configuredProfiles = options.configuredProfiles ?? ["secondary"];
  const fakeClient = {
    getWithMeta: vi.fn(async () => ({
      data: { result: [{ sys_id: "abc123" }] },
      status: 200,
      headers: new Headers(),
    })),
  };
  const getProfile = vi.fn((name: string): Profile => {
    events.push(`profile:${String(name)}`);
    if (!name || !configuredProfiles.includes(name)) {
      throw new Error(
        `Profile ${JSON.stringify(name)} not found. Available profiles: secret-profile-name`
      );
    }
    return options.profile ?? {
      instance: config.instance,
      username: config.user,
      credential: "env:DO_NOT_RESOLVE",
      authType: "basic",
      description: "non-secret test profile",
    };
  });
  const getConfig = vi.fn((name: string) => {
    events.push(`config:${String(name)}`);
    return config;
  });
  const getClient = vi.fn((name: string, resolvedConfig?: ServiceNowConfig) => {
    events.push(`client:${String(name)}`);
    if (resolvedConfig !== undefined) {
      expect(resolvedConfig).toBe(config);
    }
    return options.client ?? (fakeClient as unknown as ServiceNowClient);
  });
  return {
    manager: {
      getProfile,
      getConfig,
      getClient,
    } as unknown as ProfileManager,
    events,
    fakeClient,
    getProfile,
    getConfig,
    getClient,
  };
}

type FakeProfileManager = ReturnType<typeof createProfileManager>;

async function createHarness(
  profileManager: ProfileManager,
  requestSignal?: AbortSignal
) {
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
        tableAccess: TEST_TABLE_ACCESS,
      }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
    ...(requestSignal === undefined ? {} : { requestSignal }),
  };
  const server = await createMcpServer({
    dependencies: { profileManager, contextDependencies },
    register: (surface, dependencies) =>
      registerServiceNowTools(
        surface,
        dependencies.profileManager,
        dependencies.contextDependencies
      ),
  });
  const client = new Client({ name: "snsdk-17-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

const openHarnesses: Array<Awaited<ReturnType<typeof createHarness>>> = [];

async function harness(fake: FakeProfileManager) {
  const connected = await createHarness(fake.manager);
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
  vi.unstubAllGlobals();
});

describe("high-level tool discovery", () => {
  const expectedInputs: Record<string, string[]> = {
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

  const expectedAnnotations: Record<
    string,
    {
      title: string;
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    }
  > = {
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

  it("publishes 19 unique sn_* tools from Zod with required profile", async () => {
    const fake = createProfileManager();
    const { client } = await harness(fake);
    const discovered = (await client.listTools()).tools;

    expect(discovered).toHaveLength(REGISTERED_TOOL_COUNT);
    const names = discovered.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(Object.keys(expectedInputs).sort());

    for (const tool of discovered) {
      expect(tool.name).toMatch(/^sn_[a-z_]+$/);
      expect(tool.description).toBeTypeOf("string");
      expect(tool.description?.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toHaveProperty("profile");
      expect(tool.inputSchema.required, tool.name).toContain("profile");
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort(), tool.name).toEqual(
        expectedInputs[tool.name]
      );
      for (const property of Object.values(tool.inputSchema.properties ?? {})) {
        expect(property, tool.name).toHaveProperty("description");
        expect(Reflect.get(property, "description"), tool.name).toBeTypeOf("string");
      }
      const profileSchema = tool.inputSchema.properties?.profile;
      expect(profileSchema, tool.name).toMatchObject({
        type: "string",
        minLength: 1,
      });
    }
  });

  it("preserves complete annotations and makes sn_profile read-only", async () => {
    const fake = createProfileManager();
    const { client } = await harness(fake);
    const discovered = (await client.listTools()).tools;

    for (const tool of discovered) {
      expect(tool.annotations, tool.name).toEqual(expectedAnnotations[tool.name]);
    }

    const profile = discovered.find((tool) => tool.name === "sn_profile");
    expect(profile?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(Object.keys(profile?.inputSchema.properties ?? {})).toEqual(["profile"]);
  });

  it("has no hand-authored JSON input schemas or low-level tool handlers", () => {
    for (const moduleName of [
      "aggregate", "atf", "attach", "batch", "codesearch", "create",
      "delete", "discover", "get", "health", "nl", "profile", "query",
      "relationships", "schema", "script", "syslog", "update",
    ]) {
      const source = readFileSync(
        new URL(`../src/tools/${moduleName}.ts`, import.meta.url),
        "utf8"
      );
      expect(source, moduleName).not.toContain("inputSchema:");
    }
    const entrypoint = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(entrypoint).not.toContain("setRequestHandler");
    expect(entrypoint).not.toContain("ListToolsRequestSchema");
    expect(entrypoint).not.toContain("CallToolRequestSchema");
  });

  it("interoperates with an independent raw JSON-RPC discovery client", async () => {
    const fake = createProfileManager();
    const contextDependencies: ExecutionContextDependencies = {
      requestMetadataProvider: {
        resolve: ({ requestId }) => ({
          correlationId: `test-${String(requestId)}`,
          identity: { ownerId: "test-owner", clientId: "raw-client" },
        }),
      },
      effectivePolicyProvider: {
        resolve: () => ({
          id: "test-policy",
          revision: "test-revision",
          tableAccess: TEST_TABLE_ACCESS,
        }),
      },
      auditSink: {
        write: (_record: ToolAuditRecord) => {},
        writePreContext: () => {},
      },
    };
    const server = await createMcpServer({
      dependencies: { profileManager: fake.manager, contextDependencies },
      register: (surface, dependencies) =>
        registerServiceNowTools(
          surface,
          dependencies.profileManager,
          dependencies.contextDependencies
        ),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const receiveNext = (): Promise<JSONRPCMessage> =>
      new Promise((resolve) => {
        clientTransport.onmessage = resolve;
      });

    try {
      await server.connect(serverTransport);
      await clientTransport.start();

      const initializeResponse = receiveNext();
      await clientTransport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "raw-json-rpc-contract-client", version: "1.0.0" },
        },
      });
      const initialized = await initializeResponse;
      expect(initialized).toHaveProperty("result.protocolVersion");

      await clientTransport.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      const listResponse = receiveNext();
      await clientTransport.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const listed = await listResponse;
      expect(listed).toHaveProperty("result.tools");
      const result = "result" in listed ? listed.result : undefined;
      const listedTools =
        typeof result === "object" && result !== null && "tools" in result
          ? result.tools
          : undefined;
      expect(Array.isArray(listedTools)).toBe(true);
      expect(listedTools).toHaveLength(REGISTERED_TOOL_COUNT);
    } finally {
      await clientTransport.close();
      if (server.isConnected()) await server.close();
    }
  });
});

describe("structured query registry boundary", () => {
  it("accepts the exact three-group policy maximum through registered MCP", async () => {
    const fake = createProfileManager();
    const { client } = await harness(fake);
    const started = performance.now();
    const result = await client.callTool({
      name: "sn_query",
      arguments: {
        profile: "secondary",
        table: "incident",
        structured_query: {
          filter: nestedStructuredFilter(MAX_STRUCTURED_QUERY_NESTING),
        },
      },
    });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.isError).toBeUndefined();
    expect(fake.events).toEqual([
      "profile:secondary",
      "config:secondary",
      "client:secondary",
    ]);
    expect(fake.getConfig).toHaveBeenCalledTimes(1);
    expect(fake.getClient).toHaveBeenCalledWith("secondary", config);
    expect(fake.fakeClient.getWithMeta).toHaveBeenCalledOnce();
  });

  it.each([
    ["boundary plus one", MAX_STRUCTURED_QUERY_NESTING + 1],
    ["depth 1000", 1_000],
    ["depth 2000", 2_000],
  ])("rejects %s as input validation before callbacks", async (_label, depth) => {
    const fake = createProfileManager();
    const { client } = await harness(fake);
    const started = performance.now();
    const result = await client.callTool({
      name: "sn_query",
      arguments: {
        profile: "secondary",
        table: "incident",
        structured_query: { filter: nestedStructuredFilter(depth) },
      },
    });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Input validation error: Invalid arguments for tool sn_query:"
    );
    expect(fake.events).toEqual([]);
    expect(fake.getProfile).not.toHaveBeenCalled();
    expect(fake.getConfig).not.toHaveBeenCalled();
    expect(fake.getClient).not.toHaveBeenCalled();
    expect(fake.fakeClient.getWithMeta).not.toHaveBeenCalled();
  });
});

describe("profile validation boundary", () => {
  const validArguments: Record<string, Record<string, unknown>> = {
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
    sn_delete: { table: "incident", sys_id: "11111111111111111111111111111111", confirm: false },
    sn_discover: { type: "tables" },
    sn_get: { table: "incident", sys_id: "11111111111111111111111111111111" },
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
    sn_update: { table: "incident", sys_id: "11111111111111111111111111111111", fields: {} },
  };

  it("rejects every missing/empty/whitespace/malformed profile before lookup", async () => {
    const fake = createProfileManager();
    const { client } = await harness(fake);

    for (const [name, baseArguments] of Object.entries(validArguments)) {
      for (const profileCase of [
        { label: "missing" },
        { label: "empty", value: "" },
        { label: "whitespace", value: "   " },
        { label: "wrong type", value: { name: "secondary" } },
      ]) {
        const args =
          profileCase.label === "missing"
            ? baseArguments
            : { ...baseArguments, profile: profileCase.value };
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, `${name}: ${profileCase.label}`).toBe(true);
        expect(result.content[0], `${name}: ${profileCase.label}`).toMatchObject({
          type: "text",
        });
      }
    }

    expect(fake.getProfile).not.toHaveBeenCalled();
    expect(fake.getConfig).not.toHaveBeenCalled();
    expect(fake.getClient).not.toHaveBeenCalled();
    expect(fake.fakeClient.getWithMeta).not.toHaveBeenCalled();
  });

  it("rejects unknown profiles safely before credentials/client/handler for all tools", async () => {
    const fake = createProfileManager();
    const { client } = await harness(fake);
    const unknownNames = [
      "unknown",
      "toString",
      "constructor",
      "__proto__",
      "valueOf",
      "hasOwnProperty",
    ];

    for (const [name, baseArguments] of Object.entries(validArguments)) {
      for (const unknownName of unknownNames) {
        const result = await client.callTool({
          name,
          arguments: { ...baseArguments, profile: unknownName },
        });
        expect(result.isError, `${name}: ${unknownName}`).toBe(true);
        expect(result.content[0], `${name}: ${unknownName}`).toMatchObject({
          type: "text",
        });
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain(
          `ERROR: Unknown profile ${JSON.stringify(unknownName)}.`
        );
        expect(text).toMatch(/\nCorrelation ID: test-\d+\.$/);
        expect(JSON.stringify(result), name).not.toContain("secret-profile-name");
        expect(JSON.stringify(result), name).not.toContain("DO_NOT_RESOLVE");
      }
    }

    expect(fake.events).toEqual(
      Object.keys(validArguments).flatMap(() =>
        unknownNames.map((unknownName) => `profile:${unknownName}`)
      )
    );
    expect(fake.getConfig).not.toHaveBeenCalled();
    expect(fake.getClient).not.toHaveBeenCalled();
    expect(fake.fakeClient.getWithMeta).not.toHaveBeenCalled();
  });

  it.each([
    ["empty instance", { instance: "", username: "tester", credential: "env:PW" }],
    [
      "URL credentials and query",
      {
        instance: "https://user:password@dev.service-now.com/?token=plaintext-token",
        username: "tester",
        credential: "env:PW",
      },
    ],
    [
      "incomplete OAuth",
      { instance: "https://dev.service-now.com", authType: "oauth" },
    ],
  ] satisfies Array<[string, Profile]>) (
    "rejects an invalid configured profile (%s) before config/client/handler",
    async (_label, invalidProfile) => {
      const fake = createProfileManager({ profile: invalidProfile });
      const { client } = await harness(fake);

      const result = await client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "secondary" },
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(
        /^ERROR: Profile "secondary" is invalid or incomplete\.\nCorrelation ID: test-\d+\.$/
      );
      expect(JSON.stringify(result)).not.toContain("password");
      expect(JSON.stringify(result)).not.toContain("plaintext-token");
      expect(fake.events).toEqual(["profile:secondary"]);
      expect(fake.getConfig).not.toHaveBeenCalled();
      expect(fake.getClient).not.toHaveBeenCalled();
      expect(fake.fakeClient.getWithMeta).not.toHaveBeenCalled();
    }
  );

  it("accepts valid structured sources without resolving them in sn_profile", async () => {
    const reference = {
      type: "secret_ref" as const,
      provider: "testvault",
      reference: "opaque/reference/not-for-output",
    };
    const fake = createProfileManager({
      profile: {
        instance: "https://dev.service-now.com",
        username: "tester",
        credential: reference,
      },
    });
    const { client } = await harness(fake);

    const result = await client.callTool({
      name: "sn_profile",
      arguments: { profile: "secondary" },
    });

    expect(result.isError).toBeUndefined();
    expect(fake.events).toEqual(["profile:secondary"]);
    expect(fake.getConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(reference.reference);
  });

  it("rejects profile and credential proxies/accessors without executing traps", async () => {
    const credentialGetter = vi.fn(() => "env:SN_SHOULD_NOT_RUN");
    const accessorProfile = Object.defineProperty(
      {
        instance: "https://dev.service-now.com",
        username: "tester",
      },
      "credential",
      { enumerable: true, get: credentialGetter }
    ) as Profile;
    const accessorFake = createProfileManager({ profile: accessorProfile });
    const accessorHarness = await harness(accessorFake);
    const accessorResult = await accessorHarness.client.callTool({
      name: "sn_profile",
      arguments: { profile: "secondary" },
    });
    expect(accessorResult.isError).toBe(true);
    expect(credentialGetter).not.toHaveBeenCalled();

    const proxyGet = vi.fn();
    const proxyOwnKeys = vi.fn();
    const proxyProfile = new Proxy(
      {
        instance: "https://dev.service-now.com",
        username: "tester",
        credential: "env:SN_TEST",
      },
      { get: proxyGet, ownKeys: proxyOwnKeys }
    ) as Profile;
    const proxyFake = createProfileManager({ profile: proxyProfile });
    const proxyHarness = await harness(proxyFake);
    const proxyResult = await proxyHarness.client.callTool({
      name: "sn_profile",
      arguments: { profile: "secondary" },
    });
    expect(proxyResult.isError).toBe(true);
    expect(proxyGet).not.toHaveBeenCalled();
    expect(proxyOwnKeys).not.toHaveBeenCalled();
  });

  it("sanitizes credential initialization failures before client or handler", async () => {
    const fake = createProfileManager();
    fake.getConfig.mockImplementationOnce(() => {
      fake.events.push("config:secondary");
      throw new Error('credential references environment variable "TOP_SECRET"');
    });
    const { client } = await harness(fake);

    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "secondary" },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /^ERROR: ServiceNow authentication could not be completed\. Error category: authentication\. Retry after correcting the request or configuration\.\nCorrelation ID: test-\d+\.$/
    );
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET");
    expect(fake.events).toEqual(["profile:secondary", "config:secondary"]);
    expect(fake.getClient).not.toHaveBeenCalled();
    expect(fake.fakeClient.getWithMeta).not.toHaveBeenCalled();
  });

  it("resolves the explicit profile before config/client and invokes a fake client", async () => {
    const fake = createProfileManager();
    const { client } = await harness(fake);

    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "  secondary  " },
    });

    expect(result.isError).toBeUndefined();
    expect(fake.events).toEqual([
      "profile:secondary",
      "config:secondary",
      "client:secondary",
    ]);
    expect(fake.fakeClient.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      {
        sysparm_exclude_reference_link: "true",
        sysparm_fields: DEFAULT_FIELDS.incident,
        sysparm_limit: "21",
        sysparm_query: "ORDERBYsys_id",
        sysparm_display_value: "true",
        sysparm_no_count: "true",
      }
    );
    expect((result.content[0] as { text: string }).text).toContain(
      'Success for profile "secondary"'
    );
    expect(result.structuredContent).toMatchObject({
      profile: "secondary",
      data: {
      record_count: 1,
      has_more: false,
      results: [{ sys_id: "abc123" }],
      },
      metadata: {
        kind: "collection",
        record_count: 1,
        pagination: { mode: "offset", has_more: false },
        truncation: { truncated: false },
      },
    });
  });

  it("propagates the authoritative execution-context signal into a cached client", async () => {
    const upstreamAborted = vi.fn();
    const fetchEntered = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            fetchEntered();
            init.signal?.addEventListener(
              "abort",
              () => {
                upstreamAborted();
                reject(init.signal?.reason ?? new Error("aborted"));
              },
              { once: true }
            );
          })
      )
    );
    const controller = new AbortController();
    const cachedClient = new ServiceNowClient(config);
    const fake = createProfileManager({ client: cachedClient });
    const connected = await createHarness(fake.manager, controller.signal);
    openHarnesses.push(connected);
    const call = connected.client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "secondary" },
    });
    await vi.waitFor(() => expect(fetchEntered).toHaveBeenCalledOnce());

    controller.abort();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(upstreamAborted).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(config.password);
  });

  it("keeps sn_profile existence-only and emits no credential fields", async () => {
    const fake = createProfileManager();
    const { client } = await harness(fake);

    const result = await client.callTool({
      name: "sn_profile",
      arguments: { profile: "secondary" },
    });

    expect(result.isError).toBeUndefined();
    expect(fake.events).toEqual(["profile:secondary"]);
    expect(fake.getConfig).not.toHaveBeenCalled();
    expect(fake.getClient).not.toHaveBeenCalled();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Success for profile "secondary"');
    expect(text).not.toContain("credential");
    expect(text).not.toContain("password");
    expect(result.structuredContent).toMatchObject({
      profile: "secondary",
      data: {
        name: "secondary",
        instance: config.instance,
        auth_type: "basic",
      },
      metadata: {
        kind: "single",
        pagination: { mode: "none" },
      },
    });
  });
});
