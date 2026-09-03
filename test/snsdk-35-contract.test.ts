import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const PROFILE = "journal";
const INSTANCE = "https://journal.service-now.com";
const SYS_ID = "1234567890abcdef1234567890abcdef";
const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function harness(options: {
  readonly authorizeJournals?: boolean;
  readonly patch?: ReturnType<typeof vi.fn>;
} = {}) {
  const records: ToolAuditRecord[] = [];
  const profile: Profile = {
    instance: INSTANCE,
    username: "journal-user",
    credential: "env:SN_JOURNAL_TEST_SECRET",
  };
  const config: ServiceNowConfig = {
    instance: INSTANCE,
    user: "journal-user",
    password: "resolved-only-in-test",
    displayValue: "true",
    relDepth: 3,
  };
  const patch = options.patch ?? vi.fn(async () => ({ result: { sys_id: SYS_ID } }));
  const getProfile = vi.fn((name: string) => {
    if (name !== PROFILE) throw new Error("unknown profile");
    return profile;
  });
  const getConfig = vi.fn(() => config);
  const getClient = vi.fn(() => ({ patch }) as unknown as ServiceNowClient);
  const manager = { getProfile, getConfig, getClient } as unknown as ProfileManager;
  const dependencies: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `snsdk-35-${String(requestId)}`,
        identity: { ownerId: "journal-owner", clientId: "journal-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "journal-policy",
        revision: "v1",
        tableAccess: options.authorizeJournals
          ? {
              readTables: [],
              writeTables: ["incident"],
              targets: [
                {
                  table: "incident",
                  kind: "canonical" as const,
                  tools: [
                    "sn_update",
                    "sn_incident_add_comment",
                    "sn_incident_add_work_note",
                  ],
                  closureComplete: true as const,
                  relatedTables: ["incident"],
                },
              ],
            }
          : { readTables: [], writeTables: [], targets: [] },
      }),
    },
    auditSink: { write: (record) => records.push(record), writePreContext: () => {} },
  };
  const server = await createMcpServer({
    dependencies: {},
    register: (surface) => registerServiceNowTools(surface, manager, dependencies),
  });
  const client = new Client({ name: "snsdk-35-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return { client, server, patch, getProfile, getConfig, getClient, records };
}

describe("SNSDK-35 registered append-only incident journals", () => {
  it.each([
    ["sn_incident_add_comment", "comments"],
    ["sn_incident_add_work_note", "work_notes"],
  ] as const)("authorizes and audits %s without returning content", async (name, field) => {
    const canary = `${name}-must-not-return-or-audit`;
    const connected = await harness({ authorizeJournals: true });

    const result = await connected.client.callTool({
      name,
      arguments: { profile: PROFILE, sys_id: SYS_ID, content: canary },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      profile: PROFILE,
      data: {
        status: "appended",
        sys_id: SYS_ID,
        journal_field: field,
      },
      metadata: { kind: "operation", record_count: 1 },
    });
    expect(connected.patch).toHaveBeenCalledWith(
      `/api/now/table/incident/${SYS_ID}`,
      { [field]: canary }
    );
    expect(connected.records).toHaveLength(1);
    expect(connected.records[0]).toMatchObject({
      tool: name,
      profile: PROFILE,
      instance: INSTANCE,
      outcome: "success",
      reason: null,
    });
    expect(JSON.stringify({ result, audits: connected.records })).not.toContain(canary);
  });

  it("appends the same work note twice because the operation is non-idempotent", async () => {
    const connected = await harness({ authorizeJournals: true });
    const arguments_ = { profile: PROFILE, sys_id: SYS_ID, content: "append twice" };

    const first = await connected.client.callTool({
      name: "sn_incident_add_work_note",
      arguments: arguments_,
    });
    const second = await connected.client.callTool({
      name: "sn_incident_add_work_note",
      arguments: arguments_,
    });

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(connected.patch).toHaveBeenCalledTimes(2);
    expect(connected.records.map(({ outcome }) => outcome)).toEqual([
      "success",
      "success",
    ]);
  });

  it("requires an exact incident write/tool grant before secrets or clients", async () => {
    const connected = await harness();
    const result = await connected.client.callTool({
      name: "sn_incident_add_comment",
      arguments: { profile: PROFILE, sys_id: SYS_ID, content: "denied" },
    });

    expect(result.isError).toBe(true);
    expect(connected.getProfile).toHaveBeenCalledWith(PROFILE);
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.patch).not.toHaveBeenCalled();
    expect(connected.records[0]).toMatchObject({
      tool: "sn_incident_add_comment",
      profile: PROFILE,
      outcome: "policy_rejected",
      reason: "table_access_denied",
    });
  });

  it.each([
    ["comments", "sn_incident_add_comment"],
    ["work_notes", "sn_incident_add_work_note"],
  ] as const)(
    "rejects generic %s updates with safe exact migration guidance before secrets",
    async (field, dedicatedTool) => {
      const canary = `${field}-migration-canary`;
      const connected = await harness({ authorizeJournals: true });
      const result = await connected.client.callTool({
        name: "sn_update",
        arguments: {
          profile: PROFILE,
          table: "incident",
          sys_id: SYS_ID,
          fields: { [field]: canary },
        },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(dedicatedTool);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(connected.getConfig).not.toHaveBeenCalled();
      expect(connected.getClient).not.toHaveBeenCalled();
      expect(connected.patch).not.toHaveBeenCalled();
      expect(connected.records[0]).toMatchObject({
        tool: "sn_update",
        profile: PROFILE,
        outcome: "policy_rejected",
        reason: "journal_update_denied",
      });
    }
  );

  it("rejects invalid identity/content and extra mutation selectors before profile lookup", async () => {
    const connected = await harness({ authorizeJournals: true });
    for (const arguments_ of [
      { profile: PROFILE, sys_id: "not-an-id", content: "valid" },
      { profile: PROFILE, sys_id: SYS_ID, content: " \r\n\t " },
      { profile: PROFILE, sys_id: SYS_ID, content: "unsafe\u0000content" },
      { profile: PROFILE, sys_id: SYS_ID, content: "valid", table: "problem" },
      { profile: PROFILE, sys_id: SYS_ID, content: "valid", query: "active=true" },
    ]) {
      const result = await connected.client.callTool({
        name: "sn_incident_add_comment",
        arguments: arguments_,
      });
      expect(result.isError).toBe(true);
    }
    expect(connected.getProfile).not.toHaveBeenCalled();
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.patch).not.toHaveBeenCalled();
  });

  it("normalizes upstream failures without exposing journal or exception canaries", async () => {
    const journalCanary = "journal-content-must-not-return";
    const exceptionCanary = "upstream-exception-must-not-return";
    const connected = await harness({
      authorizeJournals: true,
      patch: vi.fn(async () => {
        throw new Error(exceptionCanary);
      }),
    });

    const result = await connected.client.callTool({
      name: "sn_incident_add_comment",
      arguments: { profile: PROFILE, sys_id: SYS_ID, content: journalCanary },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(journalCanary);
    expect(JSON.stringify(result)).not.toContain(exceptionCanary);
    expect(connected.records[0]).toMatchObject({
      tool: "sn_incident_add_comment",
      profile: PROFILE,
      outcome: "handler_error",
      reason: "handler_threw",
    });
    expect(JSON.stringify(connected.records)).not.toContain(exceptionCanary);
  });
});
