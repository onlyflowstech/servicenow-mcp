import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import type { EncodedQueryAccessPolicyInput } from "../src/encoded-query-policy.js";
import { resolveReadableFields } from "../src/field-policy.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import {
  createTableAccessPolicy,
  type TableAccessPolicyInput,
} from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const CONFIG: ServiceNowConfig = {
  instance: "https://policy-test.service-now.com",
  user: "policy-test-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};

const openHarnesses: Array<Awaited<ReturnType<typeof createHarness>>> = [];

async function createHarness(
  policyInput: TableAccessPolicyInput,
  encodedQueryAccess?: EncodedQueryAccessPolicyInput
) {
  const records: ToolAuditRecord[] = [];
  const serviceNowClient = {
    get: vi.fn(async () => ({ result: [{ name: "buildname", value: "test" }] })),
    getWithMeta: vi.fn(async () => ({
      data: { result: [{ sys_id: "allowed-record" }] },
      status: 200,
      headers: new Headers(),
    })),
  } as unknown as ServiceNowClient;
  const getProfile = vi.fn(() => ({
    instance: CONFIG.instance,
    username: CONFIG.user,
    credential: "env:POLICY_TEST_SECRET_IS_NEVER_READ",
    authType: "basic" as const,
  }));
  const getConfig = vi.fn(() => CONFIG);
  const getClient = vi.fn(() => serviceNowClient);
  const profileManager = {
    getProfile,
    getConfig,
    getClient,
  } as unknown as ProfileManager;
  const configuredTables = [
    ...(policyInput.readTables ?? []),
    ...(policyInput.writeTables ?? []),
  ];
  const tableAccess = createTableAccessPolicy({
    ...policyInput,
    targets:
      policyInput.targets ??
      [...new Set(configuredTables)].map((table) => ({
        table,
        kind: "canonical",
        tools: ["sn_query", "sn_update", "sn_batch", "sn_nl"],
        closureComplete: true,
        relatedTables: [table],
      })),
  });
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `policy-${String(requestId)}`,
        identity: { ownerId: "policy-owner", clientId: "policy-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "integration-table-policy",
        revision: "snsdk-29",
        tableAccess,
        ...(encodedQueryAccess === undefined ? {} : { encodedQueryAccess }),
      }),
    },
    auditSink: {
      write: (record) => records.push(record),
      writePreContext: () => {},
    },
  };
  const server = await createMcpServer({
    dependencies: { profileManager, executionContext },
    register: (surface, dependencies) =>
      registerServiceNowTools(
        surface,
        dependencies.profileManager,
        dependencies.executionContext
      ),
  });
  const client = new Client({ name: "snsdk-29-policy-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    records,
    serviceNowClient,
    getConfig,
    getClient,
  };
}

async function harness(
  policyInput: TableAccessPolicyInput,
  encodedQueryAccess?: EncodedQueryAccessPolicyInput
) {
  const connected = await createHarness(policyInput, encodedQueryAccess);
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

function responseText(
  result: Awaited<ReturnType<Client["callTool"]>>
): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text response");
  return first.text;
}

describe("SNSDK-29 registry enforcement", () => {
  it("separates a field denial from a table denial on a granted table", async () => {
    // The trap this guards: an operator grants the table, the write still
    // fails, and the fix lives in a different configuration key. Reporting a
    // field denial as "table access denied" points them at the wrong one.
    // Field policy only denies where an operator narrowed, so the narrowing is
    // part of the setup: this test is about how the denial is *classified*.
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ incident: { writable: ["state"] } })
    );
    const connected = await harness({
      readTables: ["incident"],
      writeTables: ["incident"],
    });

    const denied = await connected.client.callTool({
      name: "sn_update",
      arguments: {
        profile: "policy",
        table: "incident",
        sys_id: "a".repeat(32),
        fields: { sys_created_by: "not-writable" },
      },
    });

    expect(denied.isError).toBe(true);
    const text = responseText(denied);
    expect(text).toContain('field "sys_created_by"');
    expect(text).toContain('"incident"');
    expect(text).toContain("fieldPolicy.incident.writable");
    expect(text).not.toMatch(/^ERROR: Table access was denied by policy\./u);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_update",
      outcome: "policy_rejected",
      reason: "field_access_denied",
      profile: "policy",
    });

    // A genuine table denial keeps the table classification and message.
    const tableDenied = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "policy", table: "problem" },
    });
    expect(tableDenied.isError).toBe(true);
    expect(responseText(tableDenied)).toMatch(
      /^ERROR: Table access was denied by policy\./u
    );
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_query",
      outcome: "policy_rejected",
      reason: "table_access_denied",
    });
  });

  it("denies an unlisted table before config, client, or handler access", async () => {
    const connected = await harness({ readTables: ["incident"] });

    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "policy", table: "problem" },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toMatch(
      /^ERROR: Table access was denied by policy\. Correlation ID: policy-\d+\.$/u
    );
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
    expect(connected.records).toHaveLength(1);
    expect(connected.records[0]).toMatchObject({
      tool: "sn_query",
      outcome: "policy_rejected",
      reason: "table_access_denied",
      profile: "policy",
    });
  });

  it("does not infer write permission from an allowed read", async () => {
    const connected = await harness({ readTables: ["incident"] });
    const readResult = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "policy", table: " INCIDENT " },
    });
    expect(readResult.isError).toBeUndefined();
    expect(connected.serviceNowClient.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.any(Object)
    );

    connected.getConfig.mockClear();
    connected.getClient.mockClear();
    vi.mocked(connected.serviceNowClient.getWithMeta).mockClear();
    const writeResult = await connected.client.callTool({
      name: "sn_update",
      arguments: {
        profile: "policy",
        table: "incident",
        sys_id: "11111111111111111111111111111111",
        fields: { state: "2" },
      },
    });

    expect(writeResult.isError).toBe(true);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_update",
      outcome: "policy_rejected",
      reason: "table_access_denied",
    });
  });

  it("authorizes the complete batch plan before any partial read", async () => {
    const connected = await harness({ readTables: ["incident"] });
    const result = await connected.client.callTool({
      name: "sn_batch",
      arguments: {
        profile: "policy",
        table: "incident",
        structured_query: {
          filter: { type: "equality", field: "active", operator: "eq", value: true },
        },
        action: "update",
        confirm: true,
        fields: { state: "2" },
      },
    });

    expect(result.isError).toBe(true);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
    expect(connected.records[0]).toMatchObject({
      tool: "sn_batch",
      outcome: "policy_rejected",
      reason: "table_access_denied",
    });
  });

  it("fails closed for a composed tool without a typed preflight plan", async () => {
    const connected = await harness({
      readTables: ["incident"],
      writeTables: ["incident"],
    });
    const result = await connected.client.callTool({
      name: "sn_nl",
      arguments: { profile: "policy", text: "show active incidents" },
    });

    expect(result.isError).toBe(true);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records[0]).toMatchObject({
      tool: "sn_nl",
      outcome: "policy_rejected",
      reason: "table_access_denied",
    });
  });

  it("keeps an internal health-table grant unavailable to generic query", async () => {
    const connected = await harness({
      readTables: ["sys_properties"],
      targets: [
        {
          table: "sys_properties",
          kind: "canonical",
          tools: ["sn_health"],
          closureComplete: true,
          relatedTables: ["sys_properties"],
        },
      ],
    });
    const health = await connected.client.callTool({
      name: "sn_health",
      arguments: { profile: "policy", check: "version" },
    });
    expect(health.isError).toBeUndefined();

    connected.getConfig.mockClear();
    connected.getClient.mockClear();
    const query = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "policy", table: "sys_properties" },
    });
    expect(query.isError).toBe(true);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    // Now that field policy no longer denies a table it has no entry for, this
    // reaches the table boundary and exercises the per-tool binding it was
    // always meant to prove.
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_query",
      outcome: "policy_rejected",
      reason: "table_access_denied",
    });
  });
});

describe("SNSDK-32 registry encoded-query enforcement", () => {
  const approvedReadRule = {
    tool: "sn_query" as const,
    table: "incident",
    maxLength: 128,
    maxTerms: 4,
    fields: ["active", "priority"],
    operators: ["=" as const],
    maxLimit: 20,
    maxOffset: 100,
    maxResponseBytes: 100_000,
  };

  it("denies raw reads by default before config/client and never echoes values", async () => {
    const connected = await harness({ readTables: ["incident"] });
    const secret = "active=true^password=do-not-echo";
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "policy", table: "incident", query: secret },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("Use structured_query");
    expect(responseText(result)).not.toContain(secret);
    expect(responseText(result)).not.toContain("do-not-echo");
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
    expect(connected.records[0]).toMatchObject({
      tool: "sn_query",
      outcome: "policy_rejected",
      reason: "encoded_query_denied",
      profile: "policy",
    });
  });

  it("permits only a parsed bounded query for the exact approved tool/table", async () => {
    const connected = await harness(
      { readTables: ["incident"] },
      { rules: [approvedReadRule] }
    );
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "policy",
        table: "incident",
        query: "active=true^priority=1",
        fields: "active",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(connected.serviceNowClient.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({
        sysparm_query: "active=true^priority=1^ORDERBYsys_id",
        sysparm_fields: "active",
      })
    );
  });

  it("uses the exact authorized projection for the upstream request and response", async () => {
    const connected = await harness(
      { readTables: ["incident"] },
      { rules: [approvedReadRule] }
    );
    vi.mocked(connected.serviceNowClient.getWithMeta).mockResolvedValueOnce({
      data: {
        result: [
          {
            active: true,
            priority: "1",
            short_description: "must not cross the projection boundary",
          },
        ],
      },
      status: 200,
      headers: new Headers(),
    });

    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "policy",
        table: "incident",
        query: "active=true",
        fields: "active",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(connected.serviceNowClient.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({
        sysparm_query: "active=true^ORDERBYsys_id",
        sysparm_fields: "active",
      })
    );
    expect(result.structuredContent).toMatchObject({
      data: { results: [{ active: true }] },
    });
    expect(responseText(result)).not.toContain("short_description");
    expect(responseText(result)).not.toContain("must not cross");
  });

  it.each([
    ["implicit concise defaults", {}],
    ["implicit detailed fields", { response_format: "detailed" }],
    ["all readable fields", { fields: "all" }],
    ["an explicit out-of-rule field", { fields: "short_description" }],
  ])("rejects %s unless every resulting output field is approved", async (_label, selection) => {
    const connected = await harness(
      { readTables: ["incident"] },
      { rules: [approvedReadRule] }
    );
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "policy",
        table: "incident",
        query: "active=true",
        ...selection,
      },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("Use structured_query");
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
  });

  it.each([
    ["implicit concise defaults", {}, resolveReadableFields("incident")],
    [
      "an explicit bounded projection",
      { fields: "sys_id,active" },
      ["sys_id", "active"] as readonly string[],
    ],
  ])("permits %s only when its complete projection is approved", async (_label, selection, fields) => {
    const connected = await harness(
      { readTables: ["incident"] },
      {
        rules: [
          {
            ...approvedReadRule,
            fields,
          },
        ],
      }
    );
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "policy",
        table: "incident",
        query: "active=true",
        ...selection,
      },
    });

    expect(result.isError).toBeUndefined();
    expect(connected.serviceNowClient.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({
        sysparm_query: "active=true^ORDERBYsys_id",
        sysparm_fields: fields.join(","),
      })
    );
  });

  it.each([
    "active=true%5EORpriority=1",
    "active=true%5eORpriority=1",
    "active=true%255EORpriority=1",
    "active%3DEQtrue",
    "active%253dEQtrue",
    "active=true%",
    "active=true%2",
    "active=true%GG",
  ])("rejects escaped or malformed syntax before registry client access: %s", async (query) => {
    const connected = await harness(
      { readTables: ["incident"] },
      { rules: [approvedReadRule] }
    );
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "policy",
        table: "incident",
        query,
        fields: "active",
      },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("Use structured_query");
    expect(responseText(result)).not.toContain(query);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong table",
      "sn_query",
      { table: "problem", query: "priority=1", fields: "priority" },
    ],
    [
      "unapproved tool",
      "sn_aggregate",
      { table: "incident", type: "COUNT", query: "active=true" },
    ],
    [
      "unsupported OR",
      "sn_query",
      { table: "incident", query: "active=true^ORpriority=1", fields: "active" },
    ],
    [
      "excessive result limit",
      "sn_query",
      { table: "incident", query: "active=true", fields: "active", limit: 21 },
    ],
  ])("denies %s despite another exact approval", async (_label, name, args) => {
    const connected = await harness(
      { readTables: ["incident", "problem"] },
      { rules: [approvedReadRule] }
    );
    const result = await connected.client.callTool({
      name,
      arguments: { profile: "policy", ...args },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("Use structured_query");
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
  });

  it.each([
    ["sn_create", { table: "incident", fields: { short_description: "x" } }],
    [
      "sn_update",
      { table: "incident", sys_id: "1".repeat(32), fields: { state: "2" } },
    ],
    ["sn_delete", { table: "incident", sys_id: "1".repeat(32), confirm: true }],
    ["sn_batch", { table: "incident", action: "delete" }],
  ])("rejects raw selector injection into %s at the SDK boundary", async (name, args) => {
    const connected = await harness({
      readTables: ["incident"],
      writeTables: ["incident"],
    });
    const secret = "active=true^token=do-not-echo";
    const result = await connected.client.callTool({
      name,
      arguments: { profile: "policy", ...args, query: secret },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("Use structured_query");
    expect(responseText(result)).not.toContain(secret);
    expect(responseText(result)).not.toContain("do-not-echo");
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
  });
});
