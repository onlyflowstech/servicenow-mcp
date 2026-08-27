import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import {
  SAFE_DEFAULT_FIELDS,
  resolveReadableFields,
} from "../src/field-policy.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const CONFIG: ServiceNowConfig = {
  instance: "https://field-policy-test.service-now.com",
  user: "field-policy-test-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};

const openHarnesses: Array<Awaited<ReturnType<typeof createHarness>>> = [];

async function createHarness() {
  const serviceNowClient = {
    getWithMeta: vi.fn(async () => ({
      data: {
        result: [
          {
            sys_id: "1".repeat(32),
            number: "INC0010001",
            short_description: {
              value: "Disk unavailable",
              access_token: "must-not-leave-the-server",
              nested: {
                client_secret: "must-not-leave-the-server",
                safe: "kept",
              },
            },
            comments: "must-not-leave-the-server",
            u_unapproved: "must-not-leave-the-server",
          },
        ],
      },
      status: 200,
      headers: new Headers({ "x-total-count": "1" }),
    })),
    get: vi.fn(async (path: string) => {
      if (path === "/api/now/table/sys_dictionary") {
        return {
          result: [
            {
              element: "number",
              column_label: "Number",
              internal_type: "string",
              max_length: "40",
              mandatory: "false",
              reference: "",
            },
            {
              element: "description",
              column_label: "Description",
              internal_type: "string",
              max_length: "4000",
              mandatory: "false",
              reference: "",
            },
            {
              element: "comments",
              column_label: "Additional comments",
              internal_type: "journal_input",
              max_length: "0",
              mandatory: "false",
              reference: "",
            },
            {
              element: "client_secret",
              column_label: "Secret",
              internal_type: "string",
              max_length: "255",
              mandatory: "false",
              reference: "",
            },
          ],
        };
      }
      if (path === "/api/now/table/incident") {
        return {
          result: [
            {
              sys_id: "1".repeat(32),
              password: "must-not-leave-the-server",
            },
          ],
        };
      }
      if (path === "/api/now/stats/incident") {
        return {
          result: [
            {
              groupby_fields: [
                { field: "priority", value: "1", display_value: "Critical" },
                { field: "password", value: "secret" },
              ],
              stats: { count: "1", client_secret: "secret" },
              u_unapproved: "secret",
            },
          ],
        };
      }
      return {
        result: {
          sys_id: "1".repeat(32),
          number: "INC0010001",
          short_description: "Disk unavailable",
          password: "must-not-leave-the-server",
          u_unapproved: "must-not-leave-the-server",
        },
      };
    }),
    post: vi.fn(async () => ({
      result: {
        sys_id: "2".repeat(32),
        number: "INC0010002",
        short_description: "Created",
        comments: "must-not-leave-the-server",
        password: "must-not-leave-the-server",
      },
    })),
    patch: vi.fn(async () => ({
      result: {
        sys_id: "1".repeat(32),
        number: "INC0010001",
        state: "2",
        work_notes: "must-not-leave-the-server",
        access_token: "must-not-leave-the-server",
      },
    })),
  } as unknown as ServiceNowClient;

  const getProfile = vi.fn(() => ({
    instance: CONFIG.instance,
    username: CONFIG.user,
    credential: "env:FIELD_POLICY_TEST_SECRET_IS_NEVER_READ",
    authType: "basic" as const,
  }));
  const getConfig = vi.fn(() => CONFIG);
  const getClient = vi.fn(() => serviceNowClient);
  const profileManager = {
    getProfile,
    getConfig,
    getClient,
  } as unknown as ProfileManager;

  const tableAccess = createTableAccessPolicy({
    readTables: ["incident", "sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice", "u_unclassified"],
    writeTables: ["incident"],
    targets: [
      {
        table: "incident",
        kind: "canonical",
        tools: [
          "sn_query",
          "sn_get",
          "sn_schema",
          "sn_create",
          "sn_update",
          "sn_batch",
          "sn_aggregate",
        ],
        closureComplete: true,
        relatedTables: ["incident"],
      },
      {
        table: "sys_dictionary",
        kind: "canonical",
        tools: ["sn_schema"],
        closureComplete: true,
        relatedTables: ["sys_dictionary"],
      },
      {
        table: "sys_db_object",
        kind: "canonical",
        tools: ["sn_schema"],
        closureComplete: true,
        relatedTables: ["sys_db_object"],
      },
      {
        table: "sys_documentation",
        kind: "canonical",
        tools: ["sn_schema"],
        closureComplete: true,
        relatedTables: ["sys_documentation"],
      },
      {
        table: "sys_choice",
        kind: "canonical",
        tools: ["sn_schema"],
        closureComplete: true,
        relatedTables: ["sys_choice"],
      },
      {
        table: "u_unclassified",
        kind: "canonical",
        tools: ["sn_query"],
        closureComplete: true,
        relatedTables: ["u_unclassified"],
      },
    ],
  });
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `field-${String(requestId)}`,
        identity: { ownerId: "field-owner", clientId: "field-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "field-policy-integration",
        revision: "snsdk-30",
        tableAccess,
      }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
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
  const client = new Client({
    name: "snsdk-30-field-policy-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    serviceNowClient,
    getConfig,
    getClient,
  };
}

async function harness() {
  const connected = await createHarness();
  openHarnesses.push(connected);
  return connected;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    openHarnesses.splice(0).map(async ({ client, server }) => {
      await client.close();
      if (server.isConnected()) await server.close();
    })
  );
});

function responseData(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null) {
    throw new Error("Expected structured response");
  }
  const data = Reflect.get(structured, "data");
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }
  for (const wrapper of ["record", "result", "fields", "health", "request"] as const) {
    if (Object.hasOwn(data, wrapper)) return Reflect.get(data, wrapper);
  }
  return data;
}

describe("SNSDK-30 registered-tool field boundary", () => {
  it("requests safe defaults and filters unexpected direct/nested response fields", async () => {
    const connected = await harness();
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "field", table: "incident" },
    });

    expect(result.isError).toBeUndefined();
    expect(connected.serviceNowClient.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({
        sysparm_fields: SAFE_DEFAULT_FIELDS.incident.join(","),
      })
    );
    expect(responseData(result)).toMatchObject({
      results: [
        {
          sys_id: "1".repeat(32),
          number: "INC0010001",
          short_description: {
            value: "Disk unavailable",
            nested: { safe: "kept" },
          },
        },
      ],
    });
    expect(JSON.stringify(responseData(result))).not.toMatch(
      /access_token|client_secret|comments|u_unapproved/u
    );
  });

  it("maps detailed/all to finite approved fields instead of omitting sysparm_fields", async () => {
    const connected = await harness();
    const detailed = resolveReadableFields("incident", { fields: "all" }).join(",");

    await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "field",
        table: "incident",
        response_format: "detailed",
      },
    });
    await connected.client.callTool({
      name: "sn_get",
      arguments: {
        profile: "field",
        table: "incident",
        sys_id: "1".repeat(32),
        fields: "all",
      },
    });

    expect(connected.serviceNowClient.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({ sysparm_fields: detailed })
    );
    expect(connected.serviceNowClient.get).toHaveBeenCalledWith(
      `/api/now/table/incident/${"1".repeat(32)}`,
      expect.objectContaining({ sysparm_fields: detailed })
    );
  });

  it("rejects sensitive fields and unsupported table policies before client creation", async () => {
    const connected = await harness();
    const sensitive = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "field",
        table: "incident",
        fields: "sys_id,password",
      },
    });
    const unsupported = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "field", table: "u_unclassified" },
    });

    expect(sensitive.isError).toBe(true);
    expect(unsupported.isError).toBe(true);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
  });


  it("allows wildcard table access to reach custom tables when generic field policy is configured", async () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        "*": { defaults: ["sys_id"], readable: "*", writable: "*" },
      })
    );
    const connected = await harness();
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "field",
        table: "u_unclassified",
        fields: "sys_id,u_public",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(connected.serviceNowClient.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/u_unclassified",
      expect.objectContaining({ sysparm_fields: "sys_id,u_public" })
    );
  });

  it("filters metadata enumeration to the target table readable set", async () => {
    const connected = await harness();
    const result = await connected.client.callTool({
      name: "sn_schema",
      arguments: { profile: "field", table: "incident", fields_only: true },
    });

    expect(result.isError).toBeUndefined();
    expect(responseData(result)).toEqual(["description", "number"]);
    expect(JSON.stringify(responseData(result))).not.toMatch(/comments|client_secret/u);
  });

  it("rejects non-writable and journal fields before a write client exists", async () => {
    const connected = await harness();
    const create = await connected.client.callTool({
      name: "sn_create",
      arguments: {
        profile: "field",
        table: "incident",
        fields: { sys_id: "1".repeat(32) },
      },
    });
    const update = await connected.client.callTool({
      name: "sn_update",
      arguments: {
        profile: "field",
        table: "incident",
        sys_id: "1".repeat(32),
        fields: { work_notes: "not allowed through generic update" },
      },
    });

    expect(create.isError).toBe(true);
    expect(update.isError).toBe(true);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.post).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });

  it("normalizes approved writes and filters unexpected write responses", async () => {
    const connected = await harness();
    const created = await connected.client.callTool({
      name: "sn_create",
      arguments: {
        profile: "field",
        table: "incident",
        fields: { " Short_Description ": "Created" },
      },
    });
    const updated = await connected.client.callTool({
      name: "sn_update",
      arguments: {
        profile: "field",
        table: "incident",
        sys_id: "1".repeat(32),
        fields: { state: "2" },
      },
    });

    expect(created.isError).toBeUndefined();
    expect(updated.isError).toBeUndefined();
    expect(connected.serviceNowClient.post).toHaveBeenCalledWith(
      "/api/now/table/incident",
      { short_description: "Created" }
    );
    expect(connected.serviceNowClient.patch).toHaveBeenCalledWith(
      `/api/now/table/incident/${"1".repeat(32)}`,
      { state: "2" }
    );
    expect(JSON.stringify(responseData(created))).not.toMatch(/comments|password/u);
    expect(JSON.stringify(responseData(updated))).not.toMatch(/work_notes|access_token/u);
  });

  it("rejects batch journals and aggregate sensitive fields before client creation", async () => {
    const connected = await harness();
    const batch = await connected.client.callTool({
      name: "sn_batch",
      arguments: {
        profile: "field",
        table: "incident",
        structured_query: {
          filter: { type: "equality", field: "active", operator: "eq", value: true },
        },
        action: "update",
        confirm: true,
        fields: { work_notes: "must be denied" },
      },
    });
    const aggregate = await connected.client.callTool({
      name: "sn_aggregate",
      arguments: {
        profile: "field",
        table: "incident",
        type: "COUNT",
        group_by: "password",
      },
    });

    expect(batch.isError).toBe(true);
    expect(aggregate.isError).toBe(true);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.get).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });

  it("uses the validated REST batch payload and filters aggregate raw output", async () => {
    const connected = await harness();
    vi.mocked(connected.serviceNowClient.post).mockResolvedValueOnce({
      result: { responses: [{ status_code: 200 }] },
    });
    const batch = await connected.client.callTool({
      name: "sn_batch",
      arguments: {
        profile: "field",
        table: "incident",
        structured_query: {
          filter: { type: "equality", field: "active", operator: "eq", value: true },
        },
        action: "update",
        confirm: true,
        fields: { " State ": "2" },
      },
    });
    const aggregate = await connected.client.callTool({
      name: "sn_aggregate",
      arguments: {
        profile: "field",
        table: "incident",
        type: "COUNT",
        group_by: "priority",
      },
    });

    expect(batch.isError).toBeUndefined();
    expect(connected.serviceNowClient.post).toHaveBeenCalledWith(
      "/api/now/v1/batch",
      expect.objectContaining({
        rest_requests: [
          {
            id: "1",
            method: "PATCH",
            url: `/api/now/table/incident/${"1".repeat(32)}`,
            body: { state: "2" },
          },
        ],
      })
    );
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
    expect(aggregate.isError).toBeUndefined();
    expect(responseData(aggregate)).toEqual([
      {
        groupby_fields: [
          { field: "priority", value: "1", display_value: "Critical" },
        ],
        stats: { count: "1" },
      },
    ]);
    expect(JSON.stringify(responseData(aggregate))).not.toMatch(
      /password|client_secret|u_unapproved/u
    );
  });
});
