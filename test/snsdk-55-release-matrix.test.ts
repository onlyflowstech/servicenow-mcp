import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import { StaticBearerAuthenticationProvider } from "../src/http-auth.js";
import { createHttpRuntime } from "../src/http-runtime.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import {
  REGISTERED_TOOL_COUNT,
  registerServiceNowTools,
  toolModules,
} from "../src/tools/index.js";

const TOKEN = "snsdk-55-release-matrix-token-01234567890123456789";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const SYS_ID = "5".repeat(32);
const INCIDENT_POLICY = createTableAccessPolicy({
  readTables: ["incident"],
  writeTables: ["incident"],
  targets: [
    {
      table: "incident",
      kind: "canonical",
      tools: ["sn_query", "sn_incident_add_comment"],
      closureComplete: true,
      relatedTables: ["incident"],
    },
  ],
});

const PROFILES = Object.freeze({
  alpha: Object.freeze({
    instance: "https://alpha.service-now.com",
    username: "alpha-user",
    credential: "env:SNSDK_55_ALPHA_UNRESOLVED",
    authType: "basic" as const,
  }),
  beta: Object.freeze({
    instance: "https://beta.service-now.com",
    username: "beta-user",
    credential: "env:SNSDK_55_BETA_UNRESOLVED",
    authType: "basic" as const,
  }),
});

const CONFIGS = Object.freeze({
  alpha: Object.freeze({
    instance: PROFILES.alpha.instance,
    user: "alpha-user",
    password: "SNSDK_55_ALPHA_PASSWORD_CANARY",
    displayValue: "true",
    relDepth: 3,
  }),
  beta: Object.freeze({
    instance: PROFILES.beta.instance,
    user: "beta-user",
    password: "SNSDK_55_BETA_PASSWORD_CANARY",
    displayValue: "true",
    relDepth: 3,
  }),
} satisfies Record<string, Readonly<ServiceNowConfig>>);

interface ProtocolClient {
  initialize(): Promise<void>;
  listTools(): Promise<readonly Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function officialClient(url: URL): ProtocolClient {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: AUTHORIZATION } },
  });
  const client = new Client({
    name: "snsdk-55-official-sdk",
    version: "1.0.0",
  });
  return {
    async initialize() {
      await client.connect(transport);
    },
    async listTools() {
      return (await client.listTools()).tools;
    },
    async callTool(name, args) {
      return client.callTool({ name, arguments: args });
    },
    async close() {
      await client.close();
    },
  };
}

function fetchClient(url: URL): ProtocolClient {
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
  const request = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    const body = (await response.json()) as JsonRpcResponse;
    if (response.status !== 200 || body.error) {
      throw new Error(`independent JSON-RPC request failed (${response.status})`);
    }
    return body.result;
  };
  return {
    async initialize() {
      const initialized = (await request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "snsdk-55-fetch", version: "1.0.0" },
      })) as { readonly protocolVersion: string };
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
        throw new Error(`independent initialization failed (${response.status})`);
      }
    },
    async listTools() {
      return ((await request("tools/list", {})) as { readonly tools: Tool[] }).tools;
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

function canonicalManifest(tools: readonly Tool[]) {
  return tools
    .map((tool) =>
      canonicalize({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      })
    )
    .sort((left, right) =>
      String((left as { name: unknown }).name).localeCompare(
        String((right as { name: unknown }).name)
      )
    );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("SNSDK-55 cross-client release matrix", () => {
  it("blocks release on the documented deterministic protocol evidence", () => {
    const packageJson = JSON.parse(readRepositoryFile("package.json")) as {
      readonly scripts: Record<string, string>;
      readonly files: readonly string[];
    };
    const protocolScript = packageJson.scripts["test:protocol"];
    for (const file of [
      "test/snsdk-55-release-matrix.test.ts",
      "test/http-cross-client.test.ts",
      "test/http-compatibility.test.ts",
      "test/http-request-policy.test.ts",
      "test/http-runtime.test.ts",
      "test/http-entrypoint.test.ts",
      "test/http-health.test.ts",
      "test/http-auth.test.ts",
      "test/container-artifact.test.ts",
    ]) {
      expect(protocolScript).toContain(file);
    }
    expect(packageJson.files).toContain("docs/CROSS-CLIENT-RELEASE-MATRIX.md");

    const matrix = readRepositoryFile("docs/CROSS-CLIENT-RELEASE-MATRIX.md");
    for (const contract of [
      "Exact discovery parity",
      "Profile boundary",
      "Selected-instance isolation",
      "Representative read and controlled write",
      "Authentication and negotiation",
      "Malformed and batch requests",
      "Cancellation and deadlines",
      "Concurrency, admission, and rate limits",
      "Drain and shutdown",
    ]) {
      expect(matrix).toContain(contract);
    }
    expect(matrix).toContain("separate, optional provider integration check");
    expect(matrix).toMatch(/no stdio\s+transport/u);

    const ci = readRepositoryFile(".github/workflows/ci.yml");
    expect(ci).toMatch(/run:\s+npm run test:unit/u);
    expect(ci).toMatch(/run:\s+npm run test:protocol/u);

    const existingCoverage = {
      "test/http-cross-client.test.ts": [
        "identical complete discovery documents",
        "rejects missing and unknown profiles",
        "rejects JSON-RPC batches",
        "drains an accepted %s invocation",
      ],
      "test/http-request-policy.test.ts": [
        "supported JSON media type",
        "stalled authentication provider",
        "cleans up an aborted body",
      ],
      "test/http-runtime.test.ts": [
        "releases concurrency admission exactly once",
        "cancels a hung tool",
        "forces sockets and resolves at the deadline",
      ],
      "test/http-entrypoint.test.ts": [
        "bounded %s shutdown",
        "operator-configured %s rate limits",
      ],
      "test/http-health.test.ts": ["flips readiness synchronously"],
      "test/http-auth.test.ts": ["authenticates explicitly configured clients"],
    } as const;
    for (const [file, evidence] of Object.entries(existingCoverage)) {
      const source = readRepositoryFile(file);
      for (const marker of evidence) expect(source, `${file}: ${marker}`).toContain(marker);
    }

    const containerValidator = readRepositoryFile("scripts/container-validate.mjs");
    expect(containerValidator).toContain("normalizeToolManifest");
    expect(containerValidator).toContain("inputSchema: tool.inputSchema");
    expect(containerValidator).toContain("outputSchema: tool.outputSchema");
    expect(containerValidator).toContain("annotations: tool.annotations");
    expect(containerValidator).toContain("verifyProfileCalls");
  });

  it("keeps two clients and two selected instances isolated on one /mcp runtime", async () => {
    const auditRecords: ToolAuditRecord[] = [];
    const preContextAudit = vi.fn();
    const getProfile = vi.fn((name: string): Profile => {
      if (!Object.hasOwn(PROFILES, name)) throw new Error("unknown profile");
      return PROFILES[name as keyof typeof PROFILES];
    });
    const getConfig = vi.fn((name: string): Readonly<ServiceNowConfig> => {
      if (!Object.hasOwn(CONFIGS, name)) throw new Error("unknown profile");
      return CONFIGS[name as keyof typeof CONFIGS];
    });
    const operations = Object.fromEntries(
      (Object.keys(PROFILES) as Array<keyof typeof PROFILES>).map((name) => [
        name,
        {
          getWithMeta: vi.fn(async () => ({
            data: {
              result: [
                {
                  sys_id: SYS_ID,
                  number: `${name.toUpperCase()}-READ`,
                  short_description: `${name} selected instance`,
                },
              ],
            },
            status: 200,
            headers: new Headers({ "x-total-count": "1" }),
          })),
          patch: vi.fn(async () => ({ result: { sys_id: SYS_ID } })),
        },
      ])
    ) as Record<
      keyof typeof PROFILES,
      {
        readonly getWithMeta: ReturnType<typeof vi.fn>;
        readonly patch: ReturnType<typeof vi.fn>;
      }
    >;
    const getClient = vi.fn(
      (name: string, config: Readonly<ServiceNowConfig>): ServiceNowClient => {
        if (!Object.hasOwn(operations, name)) throw new Error("unknown profile");
        expect(config).toBe(CONFIGS[name as keyof typeof CONFIGS]);
        return operations[name as keyof typeof operations] as unknown as ServiceNowClient;
      }
    );
    const profileManager = {
      getProfile,
      getConfig,
      getClient,
    } as unknown as ProfileManager;
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: new StaticBearerAuthenticationProvider([
        {
          token: TOKEN,
          ownerId: "snsdk-55-owner",
          clientId: "snsdk-55-client",
        },
      ]),
      createServer: (requestContext) => {
        const executionContext: ExecutionContextDependencies = {
          requestMetadataProvider: requestContext.requestMetadataProvider,
          requestSignal: requestContext.signal,
          effectivePolicyProvider: {
            resolve: () => ({
              id: "snsdk-55-release-policy",
              revision: "1",
              tableAccess: INCIDENT_POLICY,
            }),
          },
          auditSink: {
            write: (record) => auditRecords.push(record),
            writePreContext: preContextAudit,
          },
        };
        return createMcpServer({
          dependencies: { profileManager, executionContext },
          register: (surface, dependencies) =>
            registerServiceNowTools(
              surface,
              dependencies.profileManager,
              dependencies.executionContext
            ),
        });
      },
    });
    const { url } = await runtime.start();
    const official = officialClient(url);
    const independent = fetchClient(url);

    try {
      expect(url.pathname).toBe("/mcp");
      await official.initialize();
      await independent.initialize();

      const [officialTools, independentTools] = await Promise.all([
        official.listTools(),
        independent.listTools(),
      ]);
      const expectedNames = toolModules
        .map((module) => module.definition.name)
        .sort();
      for (const tools of [officialTools, independentTools]) {
        expect(tools).toHaveLength(20);
        expect(tools).toHaveLength(REGISTERED_TOOL_COUNT);
        expect(tools.map((tool) => tool.name).sort()).toEqual(expectedNames);
        for (const tool of tools) {
          expect(tool.inputSchema.required, tool.name).toContain("profile");
          expect(tool.inputSchema.properties?.profile, tool.name).toMatchObject({
            type: "string",
            minLength: 1,
          });
          expect(tool.outputSchema, tool.name).toBeDefined();
          expect(tool.annotations, tool.name).toBeDefined();
        }
      }
      expect(canonicalManifest(officialTools)).toEqual(
        canonicalManifest(independentTools)
      );

      for (const client of [official, independent]) {
        const missing = await client.callTool("sn_profile", {});
        const unknown = await client.callTool("sn_profile", {
          profile: "unknown-release-profile",
        });
        expect(missing.isError).toBe(true);
        expect(missing.structuredContent).toBeUndefined();
        expect(unknown.isError).toBe(true);
        expect(unknown.structuredContent).toBeUndefined();
      }
      expect(getConfig).not.toHaveBeenCalled();
      expect(getClient).not.toHaveBeenCalled();

      const [officialProfile, independentProfile] = await Promise.all([
        official.callTool("sn_profile", { profile: "alpha" }),
        independent.callTool("sn_profile", { profile: "beta" }),
      ]);
      expect(structured(officialProfile)).toMatchObject({
        profile: "alpha",
        data: { name: "alpha", instance: PROFILES.alpha.instance },
      });
      expect(structured(independentProfile)).toMatchObject({
        profile: "beta",
        data: { name: "beta", instance: PROFILES.beta.instance },
      });
      expect(getConfig).not.toHaveBeenCalled();
      expect(getClient).not.toHaveBeenCalled();

      const officialRead = await official.callTool("sn_query", {
        profile: "alpha",
        table: "incident",
        fields: "sys_id,number,short_description",
        limit: 1,
      });
      const independentWrite = await independent.callTool(
        "sn_incident_add_comment",
        {
          profile: "alpha",
          sys_id: SYS_ID,
          content: "FETCH_ALPHA_JOURNAL_CANARY",
        }
      );
      const independentRead = await independent.callTool("sn_query", {
        profile: "beta",
        table: "incident",
        fields: "sys_id,number,short_description",
        limit: 1,
      });
      const officialWrite = await official.callTool("sn_incident_add_comment", {
        profile: "beta",
        sys_id: SYS_ID,
        content: "SDK_BETA_JOURNAL_CANARY",
      });

      expect(structured(officialRead)).toMatchObject({
        profile: "alpha",
        data: { results: [{ number: "ALPHA-READ" }] },
      });
      expect(structured(independentRead)).toMatchObject({
        profile: "beta",
        data: { results: [{ number: "BETA-READ" }] },
      });
      expect(structured(independentWrite)).toMatchObject({
        profile: "alpha",
        data: { status: "appended", journal_field: "comments" },
      });
      expect(structured(officialWrite)).toMatchObject({
        profile: "beta",
        data: { status: "appended", journal_field: "comments" },
      });
      expect(operations.alpha.getWithMeta).toHaveBeenCalledTimes(1);
      expect(operations.alpha.patch).toHaveBeenCalledWith(
        `/api/now/table/incident/${SYS_ID}`,
        { comments: "FETCH_ALPHA_JOURNAL_CANARY" }
      );
      expect(operations.beta.getWithMeta).toHaveBeenCalledTimes(1);
      expect(operations.beta.patch).toHaveBeenCalledWith(
        `/api/now/table/incident/${SYS_ID}`,
        { comments: "SDK_BETA_JOURNAL_CANARY" }
      );

      const successful = auditRecords.filter(
        (record) => record.outcome === "success"
      );
      expect(successful.filter((record) => record.profile === "alpha")).toHaveLength(3);
      expect(successful.filter((record) => record.profile === "beta")).toHaveLength(3);
      expect(successful).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: "sn_query",
            profile: "alpha",
            instance: PROFILES.alpha.instance,
          }),
          expect.objectContaining({
            tool: "sn_incident_add_comment",
            profile: "beta",
            instance: PROFILES.beta.instance,
          }),
        ])
      );

      const serializedEvidence = JSON.stringify({
        officialProfile,
        independentProfile,
        officialRead,
        independentRead,
        officialWrite,
        independentWrite,
        auditRecords,
      });
      for (const secret of [
        TOKEN,
        CONFIGS.alpha.password,
        CONFIGS.beta.password,
        "FETCH_ALPHA_JOURNAL_CANARY",
        "SDK_BETA_JOURNAL_CANARY",
      ]) {
        expect(serializedEvidence).not.toContain(secret);
      }
    } finally {
      await official.close().catch(() => {});
      await independent.close().catch(() => {});
      await runtime.close({ gracePeriodMs: 100 }).catch(() => {});
    }
  }, 15_000);
});
