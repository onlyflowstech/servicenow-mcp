import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import {
  FieldPolicyError,
  fieldPolicyDenialMessage,
  prepareWriteFieldArguments,
  resolveReadableFields,
  resolveWriteResponseFields,
  runWithFieldPolicyConfiguration,
  validateWritableFields,
  type FieldPolicyConfigurationInput,
} from "../src/field-policy.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { atfAuthorToolModule } from "../src/tools/atf-author-module.js";
import { createToolModule } from "../src/tools/create-module.js";
import { registerServiceNowToolModules } from "../src/tools/index.js";
import { filteredWriteRecord } from "../src/tools/record-write-shared.js";
import { updateToolModule } from "../src/tools/update-module.js";
import {
  createMockServiceNowFixture,
  type MockServiceNowStep,
} from "./fixtures/mock-servicenow.js";

const PROFILE = "projection";
const INSTANCE = "https://projection-test.service-now.com";
const SYS_ID = "a".repeat(32);
const OTHER_SYS_ID = "b".repeat(32);
const WRITE_TABLES = ["u_audit", "change_request", "incident", "sc_req_item"];
const ATF_TABLES = ["sys_atf_test", "sys_atf_test_suite", "sys_atf_test_suite_test"];

const openHarnesses: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

/**
 * MCP client harness whose policy provider states a profile field policy the
 * way src/index.ts does: only the keys the profile actually carries.
 */
async function harness(
  fieldPolicy: FieldPolicyConfigurationInput,
  steps: readonly MockServiceNowStep[]
) {
  const fixture = createMockServiceNowFixture(steps);
  const audits: ToolAuditRecord[] = [];
  const managerCalls = { config: 0, client: 0 };
  const profile: Profile = Object.freeze({
    instance: INSTANCE,
    username: "projection-user",
    credential: "env:PROJECTION_TEST_SECRET_IS_NEVER_READ",
    authType: "basic" as const,
  });
  const config: ServiceNowConfig = Object.freeze({
    instance: INSTANCE,
    user: "projection-user",
    password: "unused-test-placeholder",
    displayValue: "true",
    relDepth: 3,
    authType: "basic" as const,
  });
  const manager = {
    getProfile: () => profile,
    getConfig: () => {
      managerCalls.config += 1;
      return config;
    },
    getClient: () => {
      managerCalls.client += 1;
      return fixture.operations as unknown as ServiceNowClient;
    },
  } as unknown as ProfileManager;
  const tableAccess = createTableAccessPolicy({
    readTables: ATF_TABLES,
    writeTables: [...WRITE_TABLES, ...ATF_TABLES],
    targets: [
      ...WRITE_TABLES.map((table) => ({
        table,
        kind: "canonical" as const,
        tools: ["sn_create", "sn_update"],
        closureComplete: true as const,
        relatedTables: [table],
      })),
      ...ATF_TABLES.map((table) => ({
        table,
        kind: "canonical" as const,
        tools: ["sn_atf_author"],
        closureComplete: true as const,
        relatedTables: [table],
      })),
    ],
  });
  const dependencies: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `projection-${String(requestId)}`,
        identity: { ownerId: "projection-owner", clientId: "projection-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "write-response-projection",
        revision: "v1",
        tableAccess,
        fieldPolicy,
      }),
    },
    auditSink: {
      write: (record) => audits.push(record),
      writePreContext: () => {},
    },
  };
  const server = await createMcpServer({
    dependencies: {},
    register: (surface) =>
      registerServiceNowToolModules(surface, manager, dependencies, [
        createToolModule,
        updateToolModule,
        atfAuthorToolModule,
      ]),
  });
  const client = new Client({ name: "write-response-projection", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connected = {
    client,
    fixture,
    audits,
    managerCalls,
    async call(name: string, args: Record<string, unknown>) {
      return client.callTool({ name, arguments: { profile: PROFILE, ...args } });
    },
    async close() {
      try {
        await client.close();
      } finally {
        if (server.isConnected()) await server.close();
      }
    },
  };
  openHarnesses.push(connected);
  return connected;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  if (!first || first.type !== "text" || first.text === undefined) {
    throw new Error("Expected text response");
  }
  return first.text;
}

function structuredData(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return (result.structuredContent as { data?: unknown } | undefined)?.data;
}

describe("write-only field policy (#10)", () => {
  const writeOnly = { fieldPolicy: { u_audit: { readable: [], writable: "*" } } };

  it("lets sn_update succeed and returns { sys_id } only", async () => {
    const connected = await harness(writeOnly, [
      {
        operation: "patch",
        response: {
          result: {
            sys_id: SYS_ID,
            u_note: "must-not-be-returned",
            sys_updated_on: "2026-10-15 00:00:00",
          },
        },
      },
    ]);

    const result = await connected.call("sn_update", {
      table: "u_audit",
      sys_id: SYS_ID,
      fields: { u_note: "appended" },
    });

    expect(result.isError).not.toBe(true);
    expect(structuredData(result)).toEqual({ sys_id: SYS_ID, record: {} });
    expect(JSON.stringify(result)).not.toContain("must-not-be-returned");
    expect(JSON.stringify(result)).not.toContain("sys_updated_on");
    expect(connected.fixture.calls).toEqual([
      {
        operation: "patch",
        path: `/api/now/table/u_audit/${SYS_ID}`,
        body: { u_note: "appended" },
      },
    ]);
  });

  it("lets sn_create succeed with the created sys_id", async () => {
    const connected = await harness(writeOnly, [
      {
        operation: "post",
        response: { result: { sys_id: SYS_ID, u_note: "must-not-be-returned" } },
      },
    ]);

    const result = await connected.call("sn_create", {
      table: "u_audit",
      fields: { u_note: "created" },
    });

    expect(result.isError).not.toBe(true);
    expect(structuredData(result)).toEqual({
      sys_id: SYS_ID,
      table: "u_audit",
      record: {},
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-returned");
  });

  it("keeps reads of a write-only table denied", () => {
    runWithFieldPolicyConfiguration(writeOnly, () => {
      expect(resolveWriteResponseFields("u_audit")).toEqual(["sys_id"]);
      expect(() => resolveReadableFields("u_audit", { fields: "all" })).toThrow(
        FieldPolicyError
      );
      expect(() => resolveReadableFields("u_audit", { fields: "sys_id" })).toThrow(
        FieldPolicyError
      );
    });
  });

  it("still honours the writable set of a write-only table", async () => {
    const connected = await harness(
      { fieldPolicy: { u_audit: { readable: [], writable: ["u_note"] } } },
      []
    );

    const result = await connected.call("sn_update", {
      table: "u_audit",
      sys_id: SYS_ID,
      fields: { u_other: "denied" },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("fieldPolicy.u_audit.writable");
    expect(connected.managerCalls).toEqual({ config: 0, client: 0 });
    expect(connected.audits.at(-1)).toMatchObject({
      tool: "sn_update",
      outcome: "policy_rejected",
      reason: "field_access_denied",
    });
  });
});

describe("the written record keeps its identity (#11)", () => {
  it("lets sn_create return sys_id and number when readable omits both", async () => {
    const connected = await harness(
      { fieldPolicy: { change_request: { readable: ["number"] } } },
      [
        {
          operation: "post",
          response: {
            result: {
              sys_id: SYS_ID,
              number: "CHG0010001",
              short_description: "not readable",
              u_private: "not readable",
            },
          },
        },
      ]
    );

    const result = await connected.call("sn_create", {
      table: "change_request",
      fields: { short_description: "Created" },
    });

    expect(result.isError).not.toBe(true);
    expect(structuredData(result)).toEqual({
      sys_id: SYS_ID,
      number: "CHG0010001",
      table: "change_request",
      record: {},
    });
    expect(JSON.stringify(result)).not.toContain("not readable");
    // Exactly one insert: nothing invites a retry that would duplicate it.
    expect(connected.fixture.calls.map((call) => call.operation)).toEqual(["post"]);
  });

  it("keeps the readable fields alongside the identity", async () => {
    const connected = await harness(
      { fieldPolicy: { change_request: { readable: ["short_description"] } } },
      [
        {
          operation: "post",
          response: {
            result: {
              sys_id: SYS_ID,
              number: "CHG0010002",
              short_description: "Created",
              risk: "not readable",
            },
          },
        },
      ]
    );

    const result = await connected.call("sn_create", {
      table: "change_request",
      fields: { short_description: "Created" },
    });

    expect(result.isError).not.toBe(true);
    expect(structuredData(result)).toEqual({
      sys_id: SYS_ID,
      number: "CHG0010002",
      table: "change_request",
      record: { short_description: "Created" },
    });
  });

  it("still rejects an update whose response names a different record", async () => {
    // The sys_id cross-check in sn_update only runs when sys_id survives the
    // projection. Keeping it unconditionally keeps that check on narrowed
    // profiles too.
    const connected = await harness(
      { fieldPolicy: { change_request: { readable: ["state"] } } },
      [
        {
          operation: "patch",
          response: { result: { sys_id: OTHER_SYS_ID, state: "2" } },
        },
      ]
    );

    const result = await connected.call("sn_update", {
      table: "change_request",
      sys_id: SYS_ID,
      fields: { state: "2" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(OTHER_SYS_ID);
  });

  it("returns created from sn_atf_author create_test with no orphan", async () => {
    const connected = await harness(
      { fieldPolicy: { sys_atf_test: { readable: ["name"] } } },
      [
        {
          operation: "post",
          response: { result: { sys_id: SYS_ID, name: "Example", active: "true" } },
        },
      ]
    );

    const result = await connected.call("sn_atf_author", {
      action: "create_test",
      name: "Example",
    });

    expect(result.isError).not.toBe(true);
    expect(structuredData(result)).toMatchObject({
      action: "create_test",
      outcome: "created",
      results: [{ table: "sys_atf_test", sys_id: SYS_ID }],
      rolled_back: [],
      rollback_failed: [],
      uncertain_insert: false,
    });
    // One insert, no rollback delete, nothing left without a handle.
    expect(connected.fixture.calls.map((call) => call.operation)).toEqual(["post"]);
  });

  it("adds sys_id and number to a narrowed projection and leaves '*' alone", () => {
    const response = {
      result: {
        sys_id: SYS_ID,
        number: "INC0010009",
        short_description: "kept",
        u_hidden: "dropped",
        password: "dropped",
      },
    };

    runWithFieldPolicyConfiguration(
      { fieldPolicy: { incident: { readable: ["short_description"] } } },
      () => {
        const prepared = prepareWriteFieldArguments(
          { table: "incident", fields: { short_description: "kept" } },
          "incident"
        );
        expect(filteredWriteRecord(prepared, response, "do_not_retry")).toEqual({
          sys_id: SYS_ID,
          number: "INC0010009",
          short_description: "kept",
        });
        // Without an issued marker the projection is recomputed the same way.
        expect(
          filteredWriteRecord({ table: "incident" }, response, "do_not_retry")
        ).toEqual({
          sys_id: SYS_ID,
          number: "INC0010009",
          short_description: "kept",
        });
      }
    );

    // An open readable set is unchanged: everything but sensitive names.
    expect(
      filteredWriteRecord({ table: "incident" }, response, "do_not_retry")
    ).toEqual({
      sys_id: SYS_ID,
      number: "INC0010009",
      short_description: "kept",
      u_hidden: "dropped",
    });
  });

  it("omits number for a table that returns none", () => {
    runWithFieldPolicyConfiguration(
      { fieldPolicy: { u_audit: { readable: [] } } },
      () => {
        expect(
          filteredWriteRecord(
            { table: "u_audit" },
            { result: { sys_id: SYS_ID, u_note: "dropped" } },
            "do_not_retry"
          )
        ).toEqual({ sys_id: SYS_ID });
      }
    );
  });
});

describe("dot-walked and variables.* write keys (#12)", () => {
  it.each([
    ["incident", "caller_id.email"],
    ["sc_req_item", "variables.requested_for"],
  ])("explains the denial of %s write key %s", async (table, key) => {
    const connected = await harness({}, []);

    const result = await connected.call("sn_update", {
      table,
      sys_id: SYS_ID,
      fields: { [key]: "x" },
    });

    expect(result.isError).toBe(true);
    const text = responseText(result);
    expect(text).toContain("denied by policy");
    expect(text).toContain("Dot-walked names");
    expect(text).toContain("variables.*");
    expect(text).toContain(`"${table}"`);
    expect(text).not.toContain("invalid_field_selection");
    expect(connected.managerCalls).toEqual({ config: 0, client: 0 });
    expect(connected.audits.at(-1)).toMatchObject({
      tool: "sn_update",
      outcome: "policy_rejected",
      reason: "field_access_denied",
    });
  });

  it("gives the specific reason only to dotted field paths", () => {
    const reasonOf = (fields: Record<string, unknown>) => {
      try {
        validateWritableFields("incident", fields);
      } catch (error) {
        if (error instanceof FieldPolicyError) return error;
      }
      throw new Error("Expected a field policy rejection");
    };

    for (const key of [
      "caller_id.email",
      "u_ref.u_canary_one",
      "Variables.U_Canary_Two",
      "u_a.u_b.u_canary_three",
    ]) {
      const error = reasonOf({ [key]: "x" });
      expect(error.reason, key).toBe("unsupported_field_path");
      expect(error.table).toBe("incident");
      // The key did not pass FIELD_NAME as a whole, so it is not echoed.
      expect(error.field).toBeUndefined();
      expect(fieldPolicyDenialMessage(error).toLowerCase()).not.toContain("canary");
    }
    for (const key of ["bad-field", "caller_id.", ".email", "a..b", "u_*", "x".repeat(2_000)]) {
      expect(reasonOf({ [key]: "x" }).reason, key.slice(0, 20)).toBe(
        "invalid_field_selection"
      );
    }
  });

  it("leaves reads of dotted names unchanged", () => {
    expect(() =>
      resolveReadableFields("incident", { fields: "caller_id.email" })
    ).toThrow(
      expect.objectContaining({ reason: "invalid_field_selection" })
    );
  });
});
