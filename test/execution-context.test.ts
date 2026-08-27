import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import {
  createAuditRecord,
  createExecutionContext,
  createPreContextAuditRecord,
  emitAudit,
  emitPreContextAudit,
  requestCancellationAuditReason,
  type ExecutionContextDependencies,
  type PreContextAuditRecord,
  type RequestMetadata,
  type ToolAuditRecord,
} from "../src/execution-context.js";
import { createHttpRequestSignalController } from "../src/http-request-signal.js";
import type { Profile, ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createToolError } from "../src/tool-error.js";
import {
  defineServiceNowToolModule,
  enrichSuccessfulResult,
  profileTools,
  registerServiceNowToolModules,
  registerServiceNowTools,
  tools,
  withRequiredProfile,
  withResolvedProfileOutput,
  type ToolModuleContract,
} from "../src/tools/index.js";

const TEST_TABLE_ACCESS = Object.freeze({
  readTables: Object.freeze(["incident"]),
  writeTables: Object.freeze(["incident"]),
  targets: Object.freeze([
    Object.freeze({
      table: "incident",
      kind: "canonical" as const,
      tools: Object.freeze(["sn_query", "sn_script"]),
      closureComplete: true as const,
      relatedTables: Object.freeze(["incident"]),
    }),
  ]),
});

interface FakeManagerOptions {
  readonly profiles?: Record<string, Profile>;
  readonly clients?: Record<string, ServiceNowClient>;
  readonly configs?: Record<string, ServiceNowConfig>;
}

function serviceNowConfig(instance: string, marker = "test"): ServiceNowConfig {
  return {
    instance,
    user: `${marker}-user`,
    password: `${marker}-placeholder-not-a-real-secret`,
    displayValue: "true",
    relDepth: 3,
  };
}

function validProfile(instance: string): Profile {
  return {
    instance,
    username: "test-user",
    credential: "env:TEST_CREDENTIAL_IS_NEVER_RESOLVED",
    authType: "basic",
  };
}

function queryClient(marker: string, delayMs = 0): ServiceNowClient {
  return {
    getWithMeta: vi.fn(async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        data: {
          result: [
            {
              short_description: marker,
              marker: "unapproved-upstream-field",
            },
          ],
        },
        status: 200,
        headers: new Headers(),
      };
    }),
  } as unknown as ServiceNowClient;
}

function fakeProfileManager(options: FakeManagerOptions = {}) {
  const profiles = options.profiles ?? {
    alpha: validProfile("https://alpha.service-now.com"),
  };
  const configs = options.configs ?? Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => [
      name,
      serviceNowConfig(new URL(profile.instance).origin, name),
    ])
  );
  const clients = options.clients ?? Object.fromEntries(
    Object.keys(profiles).map((name) => [name, queryClient(name)])
  );

  const getProfile = vi.fn((name: string): Profile => {
    if (!name || !Object.hasOwn(profiles, name)) throw new Error("not found");
    return profiles[name];
  });
  const getConfig = vi.fn((name: string): ServiceNowConfig => {
    if (!name || !Object.hasOwn(configs, name)) throw new Error("not found");
    return configs[name];
  });
  const getClient = vi.fn((
    name: string,
    resolvedConfig?: Readonly<ServiceNowConfig>
  ): ServiceNowClient => {
    if (!name || !Object.hasOwn(clients, name)) throw new Error("not found");
    if (resolvedConfig !== undefined && resolvedConfig !== configs[name]) {
      throw new Error("config revision changed");
    }
    return clients[name];
  });

  return {
    manager: { getProfile, getConfig, getClient } as unknown as ProfileManager,
    getProfile,
    getConfig,
    getClient,
  };
}

function testDependencies(overrides: Partial<ExecutionContextDependencies> = {}) {
  const records: ToolAuditRecord[] = [];
  const preContextRecords: PreContextAuditRecord[] = [];
  const dependencies: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `corr-${String(requestId)}`,
        identity: { ownerId: "owner-one", clientId: "client-one" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "restricted-policy",
        revision: "test-v1",
        tableAccess: TEST_TABLE_ACCESS,
      }),
    },
    auditSink: {
      write: (record) => {
        records.push(record);
      },
      writePreContext: (record) => {
        preContextRecords.push(record);
      },
    },
    ...overrides,
  };
  return { dependencies, records, preContextRecords };
}

const openHarnesses: Array<{
  client: Client;
  server: Awaited<ReturnType<typeof createMcpServer>>;
}> = [];

async function harness(
  profileManager: ProfileManager,
  dependencies: ExecutionContextDependencies,
  modules?: readonly ToolModuleContract[]
) {
  const server = await createMcpServer({
    dependencies: { profileManager, executionContext: dependencies },
    register: (surface, injected) =>
      modules
        ? registerServiceNowToolModules(
            surface,
            injected.profileManager,
            injected.executionContext,
            modules
          )
        : registerServiceNowTools(
            surface,
            injected.profileManager,
            injected.executionContext
          ),
  });
  const client = new Client({ name: "snsdk-19-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connected = { client, server };
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

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text result");
  return block.text;
}

function expectCompleteAudit(record: ToolAuditRecord): void {
  expect(record.tool).toMatch(/^sn_/);
  expect(record).toHaveProperty("reason");
  expect(record.correlationId).toMatch(/^[^\s]+$/);
  expect(record.identity).toEqual({
    ownerId: expect.any(String),
    clientId: expect.any(String),
  });
  expect(Object.isFrozen(record)).toBe(true);
  expect(Object.isFrozen(record.identity)).toBe(true);
}

describe("immutable execution context", () => {
  it("constructs a deep immutable context only from resolved profile metadata", async () => {
    const request = {
      correlationId: "corr-immutable",
      identity: { ownerId: "owner-one", clientId: "client-one" },
    };
    const profile = {
      name: "alpha",
      instance: "https://alpha.service-now.com/",
    };
    const selectedPolicy = {
      id: "restricted-policy",
      revision: "v1",
      tableAccess: TEST_TABLE_ACCESS,
    };
    let providerInput:
      | Parameters<ExecutionContextDependencies["effectivePolicyProvider"]["resolve"]>[0]
      | undefined;

    const context = await createExecutionContext(
      request,
      profile,
      "sn_query",
      {
        resolve: (input) => {
          providerInput = input;
          return selectedPolicy;
        },
      }
    );

    request.identity.ownerId = "mutated-owner";
    profile.name = "mutated-profile";
    selectedPolicy.id = "mutated-policy";

    expect(context).toEqual({
      correlationId: "corr-immutable",
      identity: { ownerId: "owner-one", clientId: "client-one" },
      profile: { name: "alpha", instance: "https://alpha.service-now.com" },
      effectivePolicy: {
        id: "restricted-policy",
        revision: "v1",
        tableAccess: TEST_TABLE_ACCESS,
        encodedQueryAccess: { rules: [] },
      },
      signal: context.signal,
    });
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.signal.aborted).toBe(false);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.identity)).toBe(true);
    expect(Object.isFrozen(context.profile)).toBe(true);
    expect(Object.isFrozen(context.effectivePolicy)).toBe(true);
    expect(Object.isFrozen(providerInput?.request)).toBe(true);
    expect(Object.isFrozen(providerInput?.profile)).toBe(true);
    expect(Reflect.set(context.profile, "name", "bravo")).toBe(false);
    expect(context.profile.name).toBe("alpha");
  });

  it("creates complete immutable audit records without unresolved profile claims", () => {
    const record = createAuditRecord({
      outcome: "profile_rejected",
      reason: "unknown_profile",
      tool: "sn_query",
      request: {
        correlationId: "corr-rejected",
        identity: { ownerId: "owner-one", clientId: "client-one" },
      },
    });

    expect(record).toEqual({
      outcome: "profile_rejected",
      reason: "unknown_profile",
      tool: "sn_query",
      profile: null,
      instance: null,
      correlationId: "corr-rejected",
      identity: { ownerId: "owner-one", clientId: "client-one" },
    });
    expectCompleteAudit(record);
    expect(Reflect.set(record.identity, "clientId", "other-client")).toBe(false);
  });

  it("issues exact cancellation audit records and safely classifies request signals", () => {
    const deadlineController = createHttpRequestSignalController();
    const deadline = new Error("secret deadline detail");
    deadline.name = "HttpRequestDeadlineError";
    deadlineController.abort("deadline", deadline);
    const cancellationController = createHttpRequestSignalController();
    cancellationController.abort(
      "client_disconnected",
      new Error("secret cancellation detail")
    );
    const forgedController = new AbortController();
    const forgedDeadline = new Error("forged secret deadline text");
    forgedDeadline.name = "HttpRequestDeadlineError";
    forgedController.abort(forgedDeadline);

    expect(requestCancellationAuditReason(new AbortController().signal)).toBeUndefined();
    expect(requestCancellationAuditReason(deadlineController.signal)).toBe(
      "request_deadline_exceeded"
    );
    expect(requestCancellationAuditReason(cancellationController.signal)).toBe(
      "request_cancelled"
    );
    expect(requestCancellationAuditReason(forgedController.signal)).toBeUndefined();

    const record = createAuditRecord({
      outcome: "cancelled",
      reason: "request_deadline_exceeded",
      tool: "sn_query",
      request: {
        correlationId: "corr-deadline",
        identity: { ownerId: "owner-one", clientId: "client-one" },
      },
      profile: { name: "alpha", instance: "https://alpha.service-now.com" },
    });
    expect(record).toMatchObject({
      outcome: "cancelled",
      reason: "request_deadline_exceeded",
      profile: "alpha",
      instance: "https://alpha.service-now.com",
    });
    expect(JSON.stringify(record)).not.toContain("secret deadline detail");
    expectCompleteAudit(record);
  });

  it("enforces the exact audit outcome/reason/profile map for JavaScript callers", () => {
    const request = {
      correlationId: "corr-invariant",
      identity: { ownerId: "owner-one", clientId: "client-one" },
    };
    const contradictions = [
      {
        outcome: "context_rejected",
        reason: "request_metadata_unavailable",
        tool: "sn_query",
        request,
        profile: { name: "alpha", instance: "https://alpha.service-now.com" },
      },
      {
        outcome: "profile_rejected",
        reason: "unknown_profile",
        tool: "sn_query",
        request,
        profile: { name: "alpha", instance: "https://alpha.service-now.com" },
      },
      {
        outcome: "handler_error",
        reason: "invalid_profile",
        tool: "sn_query",
        request,
        profile: { name: "alpha", instance: "https://alpha.service-now.com" },
      },
      {
        outcome: "client_rejected",
        reason: "handler_threw",
        tool: "sn_query",
        request,
        profile: { name: "alpha", instance: "https://alpha.service-now.com" },
      },
      {
        outcome: "cancelled",
        reason: "handler_threw",
        tool: "sn_query",
        request,
        profile: { name: "alpha", instance: "https://alpha.service-now.com" },
      },
      {
        outcome: "success",
        reason: "handler_returned_error",
        tool: "sn_query",
        request,
        profile: { name: "alpha", instance: "https://alpha.service-now.com" },
      },
    ];
    for (const contradiction of contradictions) {
      expect(() =>
        Reflect.apply(createAuditRecord, undefined, [contradiction])
      ).toThrow(/outcome, reason, and profile are inconsistent/);
    }
  });

  it("drops branded forged audit records at the exported emit boundary", () => {
    const legitimate = createAuditRecord({
      outcome: "handler_error",
      reason: "handler_threw",
      tool: "sn_query",
      request: {
        correlationId: "corr-legitimate",
        identity: { ownerId: "owner-one", clientId: "client-one" },
      },
      profile: { name: "alpha", instance: "https://alpha.service-now.com" },
    });
    const [brand] = Object.getOwnPropertySymbols(legitimate);
    if (!brand) throw new Error("Expected private audit brand");
    const write = vi.fn();
    const sink = { write, writePreContext: vi.fn() };
    emitAudit(sink, legitimate);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(legitimate);
    write.mockClear();

    const forged = {
      outcome: "handler_error",
      reason: "unknown_profile",
      tool: "sn_query",
      profile: null,
      instance: null,
      correlationId: "corr-forged",
      identity: legitimate.identity,
    };
    Object.defineProperty(forged, brand, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.freeze(forged);
    expect(() => Reflect.apply(emitAudit, undefined, [sink, forged])).not.toThrow();
    expect(write).not.toHaveBeenCalled();

    const exactLookingForgery = {
      outcome: "handler_error",
      reason: "handler_threw",
      tool: "sn_query",
      profile: "alpha",
      instance: "https://alpha.service-now.com",
      correlationId: "corr-exact-forgery",
      identity: legitimate.identity,
    };
    Object.defineProperty(exactLookingForgery, brand, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.freeze(exactLookingForgery);
    expect(() =>
      Reflect.apply(emitAudit, undefined, [sink, exactLookingForgery])
    ).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("silently drops hostile proxies at both audit emission boundaries", () => {
    const hostile = new Proxy(
      {},
      {
        isExtensible() {
          throw new Error("hostile proxy trap");
        },
      }
    );
    const write = vi.fn();
    const writePreContext = vi.fn();
    const sink = { write, writePreContext };

    expect(() => Reflect.apply(emitAudit, undefined, [sink, hostile])).not.toThrow();
    expect(() =>
      Reflect.apply(emitPreContextAudit, undefined, [sink, hostile])
    ).not.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(writePreContext).not.toHaveBeenCalled();
  });

  it("snapshots time-varying tool-audit getters exactly once before issuing", () => {
    const reads: Record<string, number> = {};
    const changing = <T>(name: string, first: T, later: T) => () => {
      reads[name] = (reads[name] ?? 0) + 1;
      return reads[name] === 1 ? first : later;
    };
    const identity = Object.defineProperties({}, {
      ownerId: { get: changing("ownerId", "owner-one", "owner-leaked") },
      clientId: { get: changing("clientId", "client-one", "client-leaked") },
    });
    const request = Object.defineProperties({}, {
      correlationId: {
        get: changing("correlationId", "corr-snapshot", "corr-leaked"),
      },
      identity: {
        get: changing("identity", identity, {
          ownerId: "owner-second",
          clientId: "client-second",
        }),
      },
    });
    const input = Object.defineProperties({}, {
      outcome: {
        get: changing("outcome", "profile_rejected", "handler_error"),
      },
      reason: {
        get: changing("reason", "unknown_profile", "handler_threw"),
      },
      profile: {
        get: changing("profile", undefined, {
          name: "alpha",
          instance: "https://alpha.service-now.com",
        }),
      },
      tool: { get: changing("tool", "sn_query", "tool-leaked") },
      request: {
        get: changing("request", request, {
          correlationId: "corr-second",
          identity: { ownerId: "owner-second", clientId: "client-second" },
        }),
      },
    });

    const record = Reflect.apply(createAuditRecord, undefined, [input]);

    expect(record).toMatchObject({
      outcome: "profile_rejected",
      reason: "unknown_profile",
      tool: "sn_query",
      profile: null,
      instance: null,
      correlationId: "corr-snapshot",
      identity: { ownerId: "owner-one", clientId: "client-one" },
    });
    expect(reads).toEqual({
      outcome: 1,
      reason: 1,
      profile: 1,
      tool: 1,
      request: 1,
      correlationId: 1,
      identity: 1,
      ownerId: 1,
      clientId: 1,
    });
    const write = vi.fn();
    emitAudit({ write, writePreContext: vi.fn() }, record);
    expect(write).toHaveBeenCalledWith(record);
  });

  it("snapshots resolved profile Proxy fields once before validation", () => {
    const reads = { name: 0, instance: 0 };
    const profile = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "name") {
            reads.name += 1;
            return reads.name === 1 ? "QA West 東京" : "changed-profile";
          }
          if (property === "instance") {
            reads.instance += 1;
            return reads.instance === 1
              ? "https://qa-west.service-now.com"
              : "https://changed.service-now.com";
          }
          return undefined;
        },
      }
    );
    const input = {
      outcome: "handler_error",
      reason: "handler_threw",
      profile,
      tool: "sn_query",
      request: {
        correlationId: "corr-profile-proxy",
        identity: { ownerId: "owner-one", clientId: "client-one" },
      },
    };

    const record = Reflect.apply(createAuditRecord, undefined, [input]);

    expect(record).toMatchObject({
      outcome: "handler_error",
      reason: "handler_threw",
      profile: "QA West 東京",
      instance: "https://qa-west.service-now.com",
    });
    expect(reads).toEqual({ name: 1, instance: 1 });
  });

  it("snapshots time-varying pre-context getters exactly once before issuing", () => {
    const reads: Record<string, number> = {};
    const changing = <T>(name: string, first: T, later: T) => () => {
      reads[name] = (reads[name] ?? 0) + 1;
      return reads[name] === 1 ? first : later;
    };
    const input = Object.defineProperties({}, {
      reason: {
        get: changing(
          "reason",
          "request_metadata_unavailable",
          "unknown_profile"
        ),
      },
      tool: { get: changing("tool", "sn_query", "tool-leaked") },
      request: {
        get: changing("request", {
          correlationId: "corr-pre-context",
          identity: { ownerId: "unavailable-owner", clientId: "unavailable-client" },
        }, {
          correlationId: "corr-second",
          identity: { ownerId: "owner-second", clientId: "client-second" },
        }),
      },
    });

    const record = Reflect.apply(createPreContextAuditRecord, undefined, [input]);

    expect(record).toMatchObject({
      scope: "pre_context",
      outcome: "context_rejected",
      reason: "request_metadata_unavailable",
      tool: "sn_query",
      correlationId: "corr-pre-context",
      identity: { ownerId: "unavailable-owner", clientId: "unavailable-client" },
    });
    expect(reads).toEqual({ reason: 1, tool: 1, request: 1 });
    const writePreContext = vi.fn();
    emitPreContextAudit({ write: vi.fn(), writePreContext }, record);
    expect(writePreContext).toHaveBeenCalledWith(record);
  });

  it("supports existing profile names and bounded opaque provider identifiers", async () => {
    const context = await createExecutionContext(
      {
        correlationId: "corr-provider-ids",
        identity: { ownerId: "owner-one", clientId: "client-one" },
      },
      {
        name: "  QA West 東京  ",
        instance: "https://qa-west.service-now.com",
      },
      "sn_query",
      {
        resolve: () => ({
          id: "policy key+=東京",
          revision: "release 1+candidate=二",
          tableAccess: TEST_TABLE_ACCESS,
        }),
      }
    );

    expect(context.profile.name).toBe("QA West 東京");
    expect(context.effectivePolicy).toEqual({
      id: "policy key+=東京",
      revision: "release 1+candidate=二",
      tableAccess: TEST_TABLE_ACCESS,
      encodedQueryAccess: { rules: [] },
    });
  });

  it("declares an explicit typed context parameter on every handler", () => {
    expect(tools).toHaveLength(17);
    for (const tool of tools) {
      expect(tool.handler.length, tool.definition.name).toBe(4);
    }
    expect(profileTools).toHaveLength(1);
    expect(profileTools[0].handler.length).toBe(2);
  });
});

describe("registry context and audit boundary", () => {
  it("does not resolve a profile, policy, config, or client for SDK-rejected selectors", async () => {
    const fake = fakeProfileManager();
    const policy = vi.fn(() => ({
      id: "restricted-policy",
      revision: "v1",
      tableAccess: TEST_TABLE_ACCESS,
    }));
    const { dependencies, records } = testDependencies({
      effectivePolicyProvider: { resolve: policy },
    });
    const { client } = await harness(fake.manager, dependencies);

    for (const args of [
      { table: "incident" },
      { table: "incident", profile: "" },
      { table: "incident", profile: "   " },
      { table: "incident", profile: { name: "alpha" } },
    ]) {
      const result = await client.callTool({ name: "sn_query", arguments: args });
      expect(result.isError).toBe(true);
    }

    expect(fake.getProfile).not.toHaveBeenCalled();
    expect(fake.getConfig).not.toHaveBeenCalled();
    expect(fake.getClient).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
    // The high-level SDK rejects these before invoking the registered callback;
    // transport/schema-rejection auditing is therefore owned by SNSDK-26/27.
    expect(records).toEqual([]);
  });

  it("rejects unknown and invalid profiles before context/client with profile=null audits", async () => {
    const fake = fakeProfileManager({
      profiles: {
        invalid: {
          instance: "https://invalid.service-now.com",
          authType: "oauth",
        },
      },
    });
    const policy = vi.fn(() => ({
      id: "restricted-policy",
      revision: "v1",
      tableAccess: TEST_TABLE_ACCESS,
    }));
    const { dependencies, records } = testDependencies({
      effectivePolicyProvider: { resolve: policy },
    });
    const { client } = await harness(fake.manager, dependencies);

    const unknown = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "unknown" },
    });
    const invalid = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "invalid" },
    });

    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(
      /^ERROR: Unknown profile "unknown"\.\nCorrelation ID: corr-\d+\.$/
    );
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toMatch(
      /^ERROR: Profile "invalid" is invalid or incomplete\.\nCorrelation ID: corr-\d+\.$/
    );
    expect(policy).not.toHaveBeenCalled();
    expect(fake.getConfig).not.toHaveBeenCalled();
    expect(fake.getClient).not.toHaveBeenCalled();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({
        outcome: "profile_rejected",
        tool: "sn_query",
        profile: null,
        instance: null,
        identity: { ownerId: "owner-one", clientId: "client-one" },
      });
      expectCompleteAudit(record);
    }
    expect(records.map(({ reason }) => reason)).toEqual([
      "unknown_profile",
      "invalid_profile",
    ]);
  });

  it("preserves successful text/structured fields and adds the canonical profile", async () => {
    const original: CallToolResult = {
      content: [{ type: "text", text: "unchanged" }],
      structuredContent: { record_count: 1 },
    };
    expect(enrichSuccessfulResult(original, "alpha")).toEqual({
      content: [{ type: "text", text: "unchanged" }],
      structuredContent: { record_count: 1, profile: "alpha" },
    });
    expect(original.structuredContent).toEqual({ record_count: 1 });

    const fake = fakeProfileManager();
    const { dependencies, records } = testDependencies();
    const { client } = await harness(fake.manager, dependencies);
    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "  alpha  " },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      profile: "alpha",
      data: {
        results: [{ short_description: "alpha" }],
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("marker");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "success",
      reason: null,
      tool: "sn_query",
      profile: "alpha",
      instance: "https://alpha.service-now.com",
      identity: { ownerId: "owner-one", clientId: "client-one" },
    });
    expectCompleteAudit(records[0]);
  });

  it("times each tool from callback entry through its issued audit record", async () => {
    const finish = vi.fn();
    const begin = vi.fn(() => ({ finish }));
    const { dependencies, records } = testDependencies({
      toolAuditObserver: { begin },
    });
    const fake = fakeProfileManager();
    const { client } = await harness(fake.manager, dependencies);

    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });

    expect(result.isError).toBeUndefined();
    expect(begin).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(records[0]);
    expect(records[0]).toMatchObject({
      tool: "sn_query",
      outcome: "success",
      reason: null,
    });
  });

  it("preserves configured profile names containing spaces and Unicode", async () => {
    const profileName = "QA West 東京";
    const fake = fakeProfileManager({
      profiles: {
        [profileName]: validProfile("https://qa-west.service-now.com"),
      },
    });
    const { dependencies, records } = testDependencies();
    const { client } = await harness(fake.manager, dependencies);

    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: `  ${profileName}  ` },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ profile: profileName });
    expect(fake.getProfile).toHaveBeenCalledWith(profileName);
    expect(fake.getConfig).toHaveBeenCalledWith(profileName);
    expect(fake.getClient).toHaveBeenCalledWith(
      profileName,
      fake.getConfig.mock.results[0].value
    );
    expect(records[0]).toMatchObject({
      outcome: "success",
      reason: null,
      profile: profileName,
      instance: "https://qa-west.service-now.com",
    });
  });

  it("fails safely and audits when request metadata or policy resolution rejects", async () => {
    const policy = vi.fn(() => ({
      id: "must-not-run",
      revision: "v1",
      tableAccess: TEST_TABLE_ACCESS,
    }));
    const metadataFailure = testDependencies({
      requestMetadataProvider: {
        resolve: () => {
          throw new Error("secret metadata provider detail");
        },
      },
      effectivePolicyProvider: { resolve: policy },
    });
    const metadataManager = fakeProfileManager();
    const metadataHarness = await harness(
      metadataManager.manager,
      metadataFailure.dependencies
    );
    const metadataResults = await Promise.all([
      metadataHarness.client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "alpha" },
      }),
      metadataHarness.client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "unknown" },
      }),
      metadataHarness.client.callTool({
        name: "sn_profile",
        arguments: { profile: "alpha" },
      }),
      metadataHarness.client.callTool({
        name: "sn_profile",
        arguments: { profile: "unknown" },
      }),
    ]);

    for (const metadataResult of metadataResults) {
      expect(metadataResult.isError).toBe(true);
      expect(text(metadataResult)).toMatch(
        /^ERROR: Request metadata could not be initialized\. Correlation ID: [0-9a-f-]+\.$/
      );
      expect(text(metadataResult)).not.toContain("secret metadata provider detail");
    }
    const normalizedMessages = metadataResults.map((result) =>
      text(result).replace(/[0-9a-f-]{36}/, "<correlation-id>")
    );
    expect(new Set(normalizedMessages).size).toBe(1);
    expect(metadataManager.getProfile).not.toHaveBeenCalled();
    expect(metadataManager.getConfig).not.toHaveBeenCalled();
    expect(metadataManager.getClient).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
    expect(metadataFailure.records).toEqual([]);
    expect(metadataFailure.preContextRecords).toHaveLength(4);
    for (const record of metadataFailure.preContextRecords) {
      expect(record).toMatchObject({
        scope: "pre_context",
        outcome: "context_rejected",
        reason: "request_metadata_unavailable",
        identity: {
          ownerId: "unavailable-owner",
          clientId: "unavailable-client",
        },
      });
      expect("profile" in record).toBe(false);
      expect("instance" in record).toBe(false);
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.identity)).toBe(true);
    }
    expect(metadataFailure.preContextRecords.map(({ tool }) => tool).sort()).toEqual([
      "sn_profile",
      "sn_profile",
      "sn_query",
      "sn_query",
    ]);

    const policyFailure = testDependencies({
      effectivePolicyProvider: {
        resolve: () => {
          const spoof = new Error("secret policy provider deadline detail");
          spoof.name = "HttpRequestDeadlineError";
          throw spoof;
        },
      },
    });
    const policyManager = fakeProfileManager();
    const policyHarness = await harness(policyManager.manager, policyFailure.dependencies);
    const policyResult = await policyHarness.client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });

    expect(policyResult.isError).toBe(true);
    expect(text(policyResult)).toMatch(
      /^ERROR: Request context could not be initialized\. Correlation ID: corr-\d+\.$/
    );
    expect(text(policyResult)).not.toContain("secret policy provider detail");
    expect(policyManager.getConfig).not.toHaveBeenCalled();
    expect(policyManager.getClient).not.toHaveBeenCalled();
    expect(policyFailure.records).toHaveLength(1);
    expect(policyFailure.records[0]).toMatchObject({
      outcome: "context_rejected",
      reason: "policy_context_unavailable",
      profile: "alpha",
      instance: "https://alpha.service-now.com",
    });
  });

  it.each(["resolves", "rejects"] as const)(
    "prefers issued cancellation when async request metadata %s after abort",
    async (terminal) => {
      const controller = createHttpRequestSignalController();
      let enteredResolve = (): void => {};
      let metadataResolve = (_value: unknown): void => {};
      let metadataReject = (_reason?: unknown): void => {};
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const metadata = new Promise<unknown>((resolve, reject) => {
        metadataResolve = resolve;
        metadataReject = reject;
      });
      const audit = testDependencies({
        requestSignal: controller.signal,
        requestMetadataProvider: {
          resolve: () => {
            enteredResolve();
            return metadata as ReturnType<
              ExecutionContextDependencies["requestMetadataProvider"]["resolve"]
            >;
          },
        },
      });
      const fake = fakeProfileManager();
      const connected = await harness(fake.manager, audit.dependencies);
      const invocation = connected.client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "alpha" },
      });
      await entered;

      controller.abort("deadline", new Error("runtime deadline"));
      if (terminal === "resolves") {
        metadataResolve({
          correlationId: "metadata-cancelled",
          identity: { ownerId: "owner-one", clientId: "client-one" },
        });
      } else {
        metadataReject(new Error("provider failed after cancellation"));
      }
      const result = await invocation;

      expect(result.isError).toBe(true);
      expect(fake.getProfile).not.toHaveBeenCalled();
      expect(audit.records).toEqual([]);
      expect(audit.preContextRecords).toHaveLength(1);
      expect(audit.preContextRecords[0]).toMatchObject({
        scope: "pre_context",
        outcome: "cancelled",
        reason: "request_deadline_exceeded",
      });
      expect("profile" in audit.preContextRecords[0]).toBe(false);
    }
  );

  it("isolates throwing request-metadata getters before profile access", async () => {
    const hostileMetadata = Object.defineProperties({}, {
      correlationId: {
        get() {
          throw new Error("RAW_GETTER_SECRET");
        },
      },
      identity: {
        value: { ownerId: "owner-one", clientId: "client-one" },
      },
    });
    const failure = testDependencies({
      requestMetadataProvider: {
        resolve: () => hostileMetadata as unknown as RequestMetadata,
      },
    });
    const fake = fakeProfileManager();
    const { client } = await harness(fake.manager, failure.dependencies);

    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(
      /^ERROR: Request metadata could not be initialized\. Correlation ID: [0-9a-f-]+\.$/
    );
    expect(JSON.stringify(result)).not.toContain("RAW_GETTER_SECRET");
    expect(fake.getProfile).not.toHaveBeenCalled();
    expect(fake.getConfig).not.toHaveBeenCalled();
    expect(fake.getClient).not.toHaveBeenCalled();
    expect(failure.records).toEqual([]);
    expect(failure.preContextRecords).toHaveLength(1);
  });

  it("audits client initialization and handler errors with safe correlation", async () => {
    const fake = fakeProfileManager();
    fake.getConfig.mockImplementation(() => {
      throw new Error("env:TOP_SECRET could not be read");
    });
    const clientFailure = testDependencies();
    const clientHarness = await harness(fake.manager, clientFailure.dependencies);
    const clientResult = await clientHarness.client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });

    expect(clientResult.isError).toBe(true);
    expect(text(clientResult)).toMatch(
      /^ERROR: ServiceNow authentication could not be completed\. Error category: authentication\. Retry after correcting the request or configuration\.\nCorrelation ID: corr-\d+\.$/
    );
    expect(text(clientResult)).not.toContain("TOP_SECRET");
    expect(clientFailure.records[0]).toMatchObject({
      outcome: "client_rejected",
      reason: "client_initialization_failed",
      profile: "alpha",
      errorCategory: "authentication",
      retry: "retry_after_correction",
      retryAfterSeconds: null,
    });

    const handlerManager = fakeProfileManager();
    const handlerFailure = testDependencies();
    const handlerHarness = await harness(
      handlerManager.manager,
      handlerFailure.dependencies
    );
    const handlerResult = await handlerHarness.client.callTool({
      name: "sn_script",
      arguments: {
        profile: "alpha",
        code: "gs.info('test')",
        confirm: false,
      },
    });

    expect(handlerResult.isError).toBe(true);
    expect(text(handlerResult)).toMatch(/\nCorrelation ID: corr-\d+\.$/);
    expect(handlerResult.structuredContent).toBeUndefined();
    expect(handlerFailure.records[0]).toMatchObject({
      outcome: "handler_error",
      reason: "handler_returned_error",
      tool: "sn_script",
      profile: "alpha",
      errorCategory: "internal",
      retry: "do_not_retry",
      retryAfterSeconds: null,
    });
  });

  it("makes protected credential resolution existence-equivalent to HTTP 401", async () => {
    const resolutionManager = fakeProfileManager();
    resolutionManager.getConfig.mockImplementation(() => {
      throw new Error("env:PROTECTED_REFERENCE does not exist");
    });
    const resolutionAudit = testDependencies();
    const resolutionHarness = await harness(
      resolutionManager.manager,
      resolutionAudit.dependencies
    );
    const resolutionFailure = await resolutionHarness.client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });

    const authenticationError = createToolError(
      "authentication",
      "retry_after_correction"
    );
    const authenticationManager = fakeProfileManager({
      clients: {
        alpha: {
          getWithMeta: vi.fn(async () => {
            throw authenticationError;
          }),
        } as unknown as ServiceNowClient,
      },
    });
    const authenticationAudit = testDependencies();
    const authenticationHarness = await harness(
      authenticationManager.manager,
      authenticationAudit.dependencies
    );
    const authenticationFailure = await authenticationHarness.client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });

    expect(text(resolutionFailure)).toBe(text(authenticationFailure));
    expect(JSON.stringify([resolutionFailure, authenticationFailure])).not.toMatch(
      /PROTECTED_REFERENCE|does not exist/u
    );
    expect(resolutionAudit.records[0]).toMatchObject({
      outcome: "client_rejected",
      errorCategory: "authentication",
      retry: "retry_after_correction",
    });
    expect(authenticationAudit.records[0]).toMatchObject({
      outcome: "handler_error",
      errorCategory: "authentication",
      retry: "retry_after_correction",
    });
  });

  it("rejects malformed and hostile handler results with one correlated audit", async () => {
    const proxyGet = vi.fn((property: string | symbol) => {
      // Async return-value assimilation performs the unavoidable `then` read.
      // The guarded boundary must not perform any additional Proxy reads.
      if (property === "then") return undefined;
      throw new Error("RAW_PROXY_GET_SECRET");
    });
    const getter = vi.fn(() => {
      throw new Error("RAW_RESULT_GETTER_SECRET");
    });
    const resultProbe = defineServiceNowToolModule({
      runtime: "servicenow",
      definition: {
        name: "sn_handler_result_probe",
        description: "Adversarial handler result probe.",
        annotations: {
          title: "Handler result probe",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      inputSchema: withRequiredProfile(
        z.object({
          case: z.enum(["null", "proxy", "getter", "error", "oversized"]),
        })
      ),
      outputSchema: withResolvedProfileOutput(z.object({ value: z.string() })),
      requirements: {
        permissions: ["read"],
        tables: { kind: "none" },
        apis: [],
        fieldPolicies: [],
        capabilities: ["probe:handler-result"],
      },
      resolveAccess: (args) => ({ args, requests: [] }),
      handler: async (args): Promise<CallToolResult> => {
        switch (args.case) {
          case "null":
            return null as unknown as CallToolResult;
          case "proxy":
            return new Proxy({}, { get: (_target, property) => proxyGet(property) }) as CallToolResult;
          case "getter":
            return Object.defineProperty({}, "content", {
              enumerable: true,
              get: getter,
            }) as CallToolResult;
          case "error":
            return {
              content: [
                { type: "text", text: "RAW_HANDLER_ERROR_SECRET query=secret" },
              ],
              isError: true,
            };
          case "oversized":
            return {
              content: [{ type: "text", text: "x".repeat(15 * 1024 * 1024) }],
              structuredContent: { value: "oversized" },
            };
        }
      },
    });
    const fake = fakeProfileManager();
    const audit = testDependencies();
    const connected = await harness(fake.manager, audit.dependencies, [resultProbe]);

    for (const outputCase of [
      "null",
      "proxy",
      "getter",
      "error",
      "oversized",
    ] as const) {
      const result = await connected.client.callTool({
        name: "sn_handler_result_probe",
        arguments: { profile: "alpha", case: outputCase },
      });
      expect(result.isError, outputCase).toBe(true);
      expect(text(result), outputCase).toMatch(
        /^ERROR: The operation failed unexpectedly\. Error category: internal\. Retry unchanged is not recommended\.\nCorrelation ID: corr-\d+\.$/
      );
      expect(result.structuredContent, outputCase).toBeUndefined();
    }

    expect(proxyGet).toHaveBeenCalled();
    expect(proxyGet.mock.calls.every(([property]) => property === "then")).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(5);
    expect(
      audit.records.every(
        (record) =>
          record.outcome === "handler_error" &&
          record.reason === "handler_returned_error" &&
          record.errorCategory === "internal" &&
          record.retry === "do_not_retry"
      )
    ).toBe(true);
    expect(JSON.stringify(audit.records)).not.toMatch(
      /RAW_|query=secret|oversized/u
    );
  });

  it.each([
    ["request cancellation", "client_disconnected", "request_cancelled"],
    ["request deadline", "deadline", "request_deadline_exceeded"],
  ] as const)(
    "audits %s separately from a generic handler failure",
    async (_label, abortKind, expectedReason) => {
      const controller = createHttpRequestSignalController();
      let enteredResolve = (): void => {};
      let operationReject = (_reason?: unknown): void => {};
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const client = {
        getWithMeta: vi.fn(
          () =>
            new Promise<never>((_resolve, reject) => {
              operationReject = reject;
              enteredResolve();
            })
        ),
      } as unknown as ServiceNowClient;
      const fake = fakeProfileManager({ clients: { alpha: client } });
      const audit = testDependencies({ requestSignal: controller.signal });
      const connected = await harness(fake.manager, audit.dependencies);
      const invocation = connected.client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "alpha" },
      });
      await entered;

      const reason = new Error("secret cancellation detail");
      reason.name = "handler-controlled-spoofed-name";
      controller.abort(abortKind, reason);
      operationReject(reason);
      const result = await invocation;

      expect(result.isError).toBe(true);
      expect(audit.records).toHaveLength(1);
      expect(audit.records[0]).toMatchObject({
        outcome: "cancelled",
        reason: expectedReason,
        tool: "sn_query",
        profile: "alpha",
      });
      expect(JSON.stringify({ result, records: audit.records })).not.toContain(
        "secret cancellation detail"
      );
    }
  );

  it("classifies a direct handler throw only from issued signal provenance", async () => {
    const controller = createHttpRequestSignalController();
    let enteredResolve = (): void => {};
    let handlerReject = (_reason?: unknown): void => {};
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const throwingModule = defineServiceNowToolModule({
      runtime: "servicenow",
      definition: {
        name: "sn_cancellation_throw_probe",
        description: "Cancellation throw probe.",
        annotations: {
          title: "Cancellation throw probe",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      inputSchema: withRequiredProfile(z.object({})),
      outputSchema: withResolvedProfileOutput(z.object({ value: z.string() })),
      requirements: {
        permissions: ["read"],
        tables: { kind: "none" },
        apis: [],
        fieldPolicies: [],
        capabilities: ["probe:cancellation"],
      },
      resolveAccess: (args) => ({ args, requests: [] }),
      handler: () =>
        new Promise<never>((_resolve, reject) => {
          handlerReject = reject;
          enteredResolve();
        }),
    });
    const fake = fakeProfileManager();
    const audit = testDependencies({ requestSignal: controller.signal });
    const connected = await harness(fake.manager, audit.dependencies, [
      throwingModule,
    ]);
    const invocation = connected.client.callTool({
      name: "sn_cancellation_throw_probe",
      arguments: { profile: "alpha" },
    });
    await entered;

    controller.abort("deadline", new Error("runtime-owned deadline"));
    const spoof = new Error("handler forged cancellation text");
    spoof.name = "HttpRequestCancellationError";
    handlerReject(spoof);
    const result = await invocation;

    expect(result.isError).toBe(true);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      outcome: "cancelled",
      reason: "request_deadline_exceeded",
      tool: "sn_cancellation_throw_probe",
    });
    expect(JSON.stringify({ result, records: audit.records })).not.toContain(
      "handler forged cancellation text"
    );
  });

  it.each([
    ["before context resolution", false],
    ["during context resolution", true],
  ] as const)(
    "audits an issued deadline %s instead of a policy failure",
    async (_label, abortDuringResolution) => {
      const controller = createHttpRequestSignalController();
      let policyEnteredResolve = (): void => {};
      let policyResolve = (_value: unknown): void => {};
      const policyEntered = new Promise<void>((resolve) => {
        policyEnteredResolve = resolve;
      });
      const policyResult = new Promise<unknown>((resolve) => {
        policyResolve = resolve;
      });
      const audit = testDependencies({
        requestSignal: controller.signal,
        effectivePolicyProvider: {
          resolve: () => {
            policyEnteredResolve();
            return policyResult as ReturnType<
              ExecutionContextDependencies["effectivePolicyProvider"]["resolve"]
            >;
          },
        },
      });
      const fake = fakeProfileManager();
      const connected = await harness(fake.manager, audit.dependencies);
      const deadline = new Error("runtime deadline detail");
      if (!abortDuringResolution) controller.abort("deadline", deadline);
      const invocation = connected.client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "alpha" },
      });
      if (abortDuringResolution) {
        await policyEntered;
        controller.abort("deadline", deadline);
        policyResolve({
          id: "late-policy",
          revision: "v1",
          tableAccess: TEST_TABLE_ACCESS,
        });
      }
      const result = await invocation;

      expect(result.isError).toBe(true);
      expect(fake.getClient).not.toHaveBeenCalled();
      if (abortDuringResolution) {
        expect(audit.records).toHaveLength(1);
        expect(audit.records[0]).toMatchObject({
          outcome: "cancelled",
          reason: "request_deadline_exceeded",
          profile: "alpha",
        });
      } else {
        expect(fake.getProfile).not.toHaveBeenCalled();
        expect(audit.records).toEqual([]);
        expect(audit.preContextRecords[0]).toMatchObject({
          outcome: "cancelled",
          reason: "request_deadline_exceeded",
        });
      }
    }
  );

  it("drops a valid handler return after authoritative cancellation", async () => {
    const controller = createHttpRequestSignalController();
    let enteredResolve = (): void => {};
    let operationResolve = (_value: unknown): void => {};
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const client = {
      getWithMeta: vi.fn(
        () =>
          new Promise((resolve) => {
            operationResolve = resolve;
            enteredResolve();
          })
      ),
    } as unknown as ServiceNowClient;
    const fake = fakeProfileManager({ clients: { alpha: client } });
    const audit = testDependencies({ requestSignal: controller.signal });
    const connected = await harness(fake.manager, audit.dependencies);
    const invocation = connected.client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });
    await entered;

    controller.abort("client_disconnected", new Error("client left"));
    operationResolve({
      data: { result: [{ short_description: "must-be-dropped" }] },
      status: 200,
      headers: new Headers(),
    });
    const result = await invocation;

    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("must-be-dropped");
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      outcome: "cancelled",
      reason: "request_cancelled",
      profile: "alpha",
    });
  });

  it("does not inspect a hostile late handler result after authoritative cancellation", async () => {
    const controller = createHttpRequestSignalController();
    const contentGetter = vi.fn(() => {
      throw new Error("RAW_LATE_RESULT_SECRET");
    });
    let enteredResolve = (): void => {};
    let handlerResolve = (_value: CallToolResult): void => {};
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const resultProbe = defineServiceNowToolModule({
      runtime: "servicenow",
      definition: {
        name: "sn_cancelled_result_probe",
        description: "Cancellation-first result probe.",
        annotations: {
          title: "Cancellation-first result probe",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      inputSchema: withRequiredProfile(z.object({})),
      outputSchema: withResolvedProfileOutput(z.object({ value: z.string() })),
      requirements: {
        permissions: ["read"],
        tables: { kind: "none" },
        apis: [],
        fieldPolicies: [],
        capabilities: ["probe:cancellation-first-result"],
      },
      resolveAccess: (args) => ({ args, requests: [] }),
      handler: async () =>
        new Promise<CallToolResult>((resolve) => {
          handlerResolve = resolve;
          enteredResolve();
        }),
    });
    const fake = fakeProfileManager();
    const audit = testDependencies({ requestSignal: controller.signal });
    const connected = await harness(fake.manager, audit.dependencies, [resultProbe]);
    const invocation = connected.client.callTool({
      name: "sn_cancelled_result_probe",
      arguments: { profile: "alpha" },
    });
    await entered;

    controller.abort("client_disconnected", new Error("client left"));
    handlerResolve(
      Object.defineProperty({}, "content", {
        enumerable: true,
        get: contentGetter,
      }) as CallToolResult
    );
    const result = await invocation;

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/was cancelled/u);
    expect(contentGetter).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      outcome: "cancelled",
      reason: "request_cancelled",
      profile: "alpha",
    });
    expect(JSON.stringify(audit.records)).not.toContain("RAW_LATE_RESULT_SECRET");
  });

  it.each(["HttpRequestDeadlineError", "HttpRequestCancellationError"])(
    "keeps non-aborted handler errors named %s classified as handler errors",
    async (errorName) => {
      const client = {
        getWithMeta: vi.fn(async () => {
          const spoof = new Error("spoofed cancellation and deadline text");
          spoof.name = errorName;
          throw spoof;
        }),
      } as unknown as ServiceNowClient;
      const fake = fakeProfileManager({ clients: { alpha: client } });
      const audit = testDependencies();
      const connected = await harness(fake.manager, audit.dependencies);
      const result = await connected.client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "alpha" },
      });

      expect(result.isError).toBe(true);
      expect(audit.records).toHaveLength(1);
      expect(audit.records[0]).toMatchObject({
        outcome: "handler_error",
        reason: "handler_threw",
        profile: "alpha",
        errorCategory: "internal",
        retry: "do_not_retry",
        retryAfterSeconds: null,
      });
      expect(JSON.stringify({ result, records: audit.records })).not.toContain(
        "spoofed cancellation and deadline text"
      );
    }
  );

  it("rejects profile/config drift with a bounded audit reason before client access", async () => {
    const fake = fakeProfileManager({
      configs: {
        alpha: serviceNowConfig("https://other.service-now.com", "other"),
      },
    });
    const { dependencies, records } = testDependencies();
    const { client } = await harness(fake.manager, dependencies);

    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });

    expect(result.isError).toBe(true);
    expect(fake.getClient).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "client_rejected",
      reason: "profile_binding_changed",
      profile: "alpha",
      instance: "https://alpha.service-now.com",
    });
  });

  it("does not expose hostile upstream exceptions through the official SDK", async () => {
    const hostileClient = {
      getWithMeta: vi.fn(async () => {
        throw {
          message:
            "Authorization: Bearer RAW_SECRET_TOKEN " +
            "https://host.invalid/api?secret=RAW_QUERY_SECRET",
          detail: "RAW_DETAIL_SECRET",
          cause: new Error("RAW_CAUSE_SECRET"),
          headers: { Authorization: "Bearer RAW_HEADER_SECRET" },
          body: { access_token: "RAW_BODY_SECRET" },
        };
      }),
    } as unknown as ServiceNowClient;
    const fake = fakeProfileManager({
      clients: { alpha: hostileClient },
    });
    const { dependencies, records } = testDependencies();
    const { client } = await harness(fake.manager, dependencies);

    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });
    const serialized = JSON.stringify({ result, records });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(
      /^ERROR: The operation failed unexpectedly\. Error category: internal\. Retry unchanged is not recommended\.\nCorrelation ID: corr-\d+\.$/
    );
    expect(result.structuredContent).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "handler_error",
      reason: "handler_threw",
      tool: "sn_query",
      profile: "alpha",
      errorCategory: "internal",
      retry: "do_not_retry",
      retryAfterSeconds: null,
    });
    for (const probe of [
      "RAW_SECRET_TOKEN",
      "RAW_QUERY_SECRET",
      "RAW_DETAIL_SECRET",
      "RAW_CAUSE_SECRET",
      "RAW_HEADER_SECRET",
      "RAW_BODY_SECRET",
      "host.invalid",
      "Authorization",
      "Bearer",
    ]) {
      expect(serialized).not.toContain(probe);
    }
  });

  it("isolates audit sink failures and prevents audit-record mutation", async () => {
    let observed: ToolAuditRecord | undefined;
    const { dependencies } = testDependencies({
      auditSink: {
        write: (record) => {
          observed = record;
          expect(Reflect.set(record.identity, "ownerId", "mutated")).toBe(false);
          throw new Error("audit destination unavailable");
        },
        writePreContext: () => {},
      },
    });
    const fake = fakeProfileManager();
    const { client } = await harness(fake.manager, dependencies);

    const result = await client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ profile: "alpha" });
    expect(observed?.identity.ownerId).toBe("owner-one");
    if (!observed) throw new Error("Expected audit attempt");
    expectCompleteAudit(observed);
  });

  it("does not await a never-settling audit sink after handler success", async () => {
    const neverSettles = new Promise<void>(() => {});
    const { dependencies } = testDependencies({
      auditSink: {
        write: () => neverSettles,
        writePreContext: () => {},
      },
    });
    const fake = fakeProfileManager();
    const { client } = await harness(fake.manager, dependencies);

    const completion = client.callTool({
      name: "sn_query",
      arguments: { table: "incident", profile: "alpha" },
    });
    const result = await Promise.race([
      completion,
      new Promise<"audit-blocked">((resolve) =>
        setTimeout(() => resolve("audit-blocked"), 100)
      ),
    ]);

    expect(result).not.toBe("audit-blocked");
    if (result === "audit-blocked") throw new Error("audit blocked the response");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ profile: "alpha" });
    expect(fake.getClient).toHaveBeenCalledWith(
      "alpha",
      fake.getConfig.mock.results[0].value
    );
  });

  it("suppresses delayed audit-sink rejection without delaying success", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { dependencies } = testDependencies({
        auditSink: {
          write: () =>
            new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error("delayed audit failure")), 5);
            }),
          writePreContext: () => {},
        },
      });
      const fake = fakeProfileManager();
      const { client } = await harness(fake.manager, dependencies);

      const result = await client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "alpha" },
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ profile: "alpha" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("suppresses rejected tool-observer completion without delaying success", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const finish = vi.fn(() => Promise.reject(new Error("observer failure")));
      const { dependencies } = testDependencies({
        toolAuditObserver: { begin: () => ({ finish }) },
      });
      const fake = fakeProfileManager();
      const { client } = await harness(fake.manager, dependencies);

      const result = await client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "alpha" },
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ profile: "alpha" });
      expect(finish).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("keeps interleaved profiles, clients, results, contexts, and audits isolated", async () => {
    const profiles = {
      alpha: validProfile("https://alpha.service-now.com"),
      bravo: validProfile("https://bravo.service-now.com"),
    };
    const configs = {
      alpha: serviceNowConfig("https://alpha.service-now.com", "alpha"),
      bravo: serviceNowConfig("https://bravo.service-now.com", "bravo"),
    };
    const alphaClient = queryClient("alpha-result", 15);
    const bravoClient = queryClient("bravo-result", 0);
    const fake = fakeProfileManager({
      profiles,
      configs,
      clients: { alpha: alphaClient, bravo: bravoClient },
    });
    const policyCalls: Array<{ profile: string; correlationId: string }> = [];
    const { dependencies, records } = testDependencies({
      effectivePolicyProvider: {
        resolve: async ({ request, profile }) => {
          policyCalls.push({
            profile: profile.name,
            correlationId: request.correlationId,
          });
          if (profile.name === "alpha") await Promise.resolve();
          return {
            id: `restricted-${profile.name}`,
            revision: "test-v1",
            tableAccess: TEST_TABLE_ACCESS,
          };
        },
      },
    });
    const { client } = await harness(fake.manager, dependencies);

    const [alphaResult, bravoResult] = await Promise.all([
      client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "alpha" },
      }),
      client.callTool({
        name: "sn_query",
        arguments: { table: "incident", profile: "bravo" },
      }),
    ]);

    expect(alphaResult.structuredContent).toMatchObject({
      profile: "alpha",
      data: { results: [{ short_description: "alpha-result" }] },
    });
    expect(bravoResult.structuredContent).toMatchObject({
      profile: "bravo",
      data: { results: [{ short_description: "bravo-result" }] },
    });
    expect(fake.getConfig.mock.calls.map(([name]) => name).sort()).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(fake.getClient.mock.calls.map(([name]) => name).sort()).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(policyCalls.map(({ profile }) => profile).sort()).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(new Set(policyCalls.map(({ correlationId }) => correlationId)).size).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.map(({ profile }) => profile).sort()).toEqual(["alpha", "bravo"]);
    expect(records.map(({ instance }) => instance).sort()).toEqual([
      "https://alpha.service-now.com",
      "https://bravo.service-now.com",
    ]);
    expect(new Set(records.map(({ correlationId }) => correlationId)).size).toBe(2);
  });
});
