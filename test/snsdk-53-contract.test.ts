import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ServiceNowClient } from "../src/client.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import {
  createHttpObservability,
  createJsonLinesEventSink,
} from "../src/http-observability.js";
import { runProfileAdmin, type ProfileAdminIO } from "../src/profile-admin.js";
import {
  type ProfileEncryptionKeyProvider,
  type SecretResolver,
} from "../src/profile-credentials.js";
import { ProfileManager, type Profile } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import {
  REGISTERED_TOOL_COUNT,
  defineContextOnlyToolModule,
  defineServiceNowToolModule,
  registerServiceNowToolModules,
  toolModules,
  withRequiredProfile,
  withResolvedProfileOutput,
  type ToolModuleContract,
} from "../src/tools/index.js";
import {
  SNSDK53_CONFIG,
  SNSDK53_PROFILE,
  SNSDK53_PROFILE_NAME,
  SNSDK53_SECRET_PROBES,
  SNSDK53_TABLE_ACCESS,
  createCountingServiceNowOperations,
} from "./snsdk-53-fixtures.js";

const EMPTY_REQUESTS = Object.freeze([]);
const openHarnesses: Array<Awaited<ReturnType<typeof createHarness>>> = [];

interface ProbeState {
  readonly handlerCalls: string[];
  readonly accessCalls: string[];
}

interface ManagerState {
  readonly manager: ProfileManager;
  readonly profileCalls: string[];
  readonly secretCalls: string[];
  readonly clientCalls: string[];
  readonly serviceNowCalls: string[];
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

function createProbeCatalog(state: ProbeState): readonly ToolModuleContract[] {
  return Object.freeze(
    toolModules.map((productionModule) => {
      const name = productionModule.definition.name;
      const inputSchema = withRequiredProfile(z.object({}));
      const outputSchema = withResolvedProfileOutput(
        z.object({ marker: z.string() })
      );
      const definition = {
        name,
        description: `SNSDK-53 shared-wrapper probe for ${name}.`,
        annotations: {
          title: `SNSDK-53 ${name}`,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      };
      const requirements = {
        permissions: ["read" as const],
        tables: { kind: "none" as const },
        apis: [],
        fieldPolicies: [],
        capabilities: [`snsdk-53:${name}`],
      };
      const resolveAccess = (candidate: unknown) => {
        state.accessCalls.push(name);
        return {
          args: Object.freeze(inputSchema.parse(candidate)),
          requests: EMPTY_REQUESTS,
        };
      };
      const result = () => ({
        content: [{ type: "text" as const, text: `success:${name}` }],
        structuredContent: { marker: name },
      });

      return productionModule.runtime === "context-only"
        ? defineContextOnlyToolModule({
            runtime: "context-only",
            definition,
            inputSchema,
            outputSchema,
            requirements,
            resolveAccess,
            handler: async () => {
              state.handlerCalls.push(name);
              return result();
            },
          })
        : defineServiceNowToolModule({
            runtime: "servicenow",
            definition,
            inputSchema,
            outputSchema,
            requirements,
            resolveAccess,
            handler: async () => {
              state.handlerCalls.push(name);
              return result();
            },
          });
    })
  );
}

function createManager(
  profiles: Readonly<Record<string, Profile>> = Object.freeze({
    [SNSDK53_PROFILE_NAME]: SNSDK53_PROFILE,
    default: Object.freeze({
      ...SNSDK53_PROFILE,
      instance: "https://default.service-now.com",
    }),
  })
): ManagerState {
  const profileCalls: string[] = [];
  const secretCalls: string[] = [];
  const clientCalls: string[] = [];
  const { calls: serviceNowCalls, operations } =
    createCountingServiceNowOperations();
  const manager = {
    getProfile(name: string): Profile {
      profileCalls.push(name);
      if (!Object.hasOwn(profiles, name)) throw new Error("unknown profile");
      return profiles[name];
    },
    getConfig(name: string) {
      secretCalls.push(name);
      return SNSDK53_CONFIG;
    },
    getClient(name: string) {
      clientCalls.push(name);
      return operations as unknown as ServiceNowClient;
    },
  } as unknown as ProfileManager;
  return {
    manager,
    profileCalls,
    secretCalls,
    clientCalls,
    serviceNowCalls,
  };
}

function createDependencies(
  records: ToolAuditRecord[],
  toolAuditObserver?: ExecutionContextDependencies["toolAuditObserver"]
): ExecutionContextDependencies {
  return {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `snsdk-53-${String(requestId)}`,
        identity: { ownerId: "test-owner", clientId: "test-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "snsdk-53-policy",
        revision: "v1",
        tableAccess: SNSDK53_TABLE_ACCESS,
      }),
    },
    auditSink: {
      write: (record) => records.push(record),
      writePreContext: () => {},
    },
    ...(toolAuditObserver === undefined ? {} : { toolAuditObserver }),
  };
}

async function createHarness(options: {
  readonly manager?: ManagerState;
  readonly modules?: readonly ToolModuleContract[];
  readonly records?: ToolAuditRecord[];
  readonly toolAuditObserver?: ExecutionContextDependencies["toolAuditObserver"];
} = {}) {
  const state: ProbeState = { handlerCalls: [], accessCalls: [] };
  const manager = options.manager ?? createManager();
  const records = options.records ?? [];
  const modules = options.modules ?? createProbeCatalog(state);
  const dependencies = createDependencies(records, options.toolAuditObserver);
  const server = await createMcpServer({
    dependencies: { manager: manager.manager, dependencies },
    register: (surface, injected) =>
      registerServiceNowToolModules(
        surface,
        injected.manager,
        injected.dependencies,
        modules
      ),
  });
  const client = new Client({ name: "snsdk-53-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, state, manager, records };
}

async function harness(
  options: Parameters<typeof createHarness>[0] = {}
) {
  const connected = await createHarness(options);
  openHarnesses.push(connected);
  return connected;
}

describe("SNSDK-53 catalog-wide profile and audit contract", () => {
  it("rejects every selector failure before handler, secret, client, or ServiceNow access", async () => {
    const started = performance.now();
    const connected = await harness();
    const names = toolModules.map(({ definition }) => definition.name);
    expect(names).toHaveLength(REGISTERED_TOOL_COUNT);
    expect(new Set(names).size).toBe(REGISTERED_TOOL_COUNT);

    for (const name of names) {
      for (const selector of [
        { label: "omitted" },
        { label: "empty", value: "" },
        { label: "whitespace", value: "   " },
        { label: "null", value: null },
        { label: "array", value: [SNSDK53_PROFILE_NAME] },
        { label: "object", value: { name: SNSDK53_PROFILE_NAME } },
        { label: "number", value: 1 },
      ]) {
        const args =
          selector.label === "omitted" ? {} : { profile: selector.value };
        const result = await connected.client.callTool({ name, arguments: args });
        expect(result.isError, `${name}:${selector.label}`).toBe(true);
      }
      const unknown = await connected.client.callTool({
        name,
        arguments: { profile: "unknown" },
      });
      expect(unknown.isError, `${name}:unknown`).toBe(true);
    }

    expect(connected.manager.profileCalls).toEqual(
      names.map(() => "unknown")
    );
    expect(connected.manager.secretCalls).toEqual([]);
    expect(connected.manager.clientCalls).toEqual([]);
    expect(connected.manager.serviceNowCalls).toEqual([]);
    expect(connected.state.accessCalls).toEqual([]);
    expect(connected.state.handlerCalls).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("adds the resolved profile to every successful result and audit", async () => {
    const fetchProbe = vi.fn(() => {
      throw new Error("unmocked network access");
    });
    vi.stubGlobal("fetch", fetchProbe);
    const started = performance.now();
    const connected = await harness();
    const names = toolModules.map(({ definition }) => definition.name);

    for (const name of names) {
      const result = await connected.client.callTool({
        name,
        arguments: { profile: `  ${SNSDK53_PROFILE_NAME}  ` },
      });
      expect(result.isError, name).toBeUndefined();
      expect(result.structuredContent, name).toEqual({
        marker: name,
        profile: SNSDK53_PROFILE_NAME,
      });
    }

    expect(connected.state.handlerCalls).toEqual(names);
    expect(connected.state.accessCalls).toEqual(names);
    expect(connected.manager.serviceNowCalls).toEqual([]);
    expect(fetchProbe).not.toHaveBeenCalled();
    expect(connected.records).toHaveLength(names.length);
    expect(
      connected.records.map(({ tool, profile, outcome, reason }) => ({
        tool,
        profile,
        outcome,
        reason,
      }))
    ).toEqual(
      names.map((tool) => ({
        tool,
        profile: SNSDK53_PROFILE_NAME,
        outcome: "success",
        reason: null,
      }))
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("does not reuse a successful, configured default, or previous selector", async () => {
    const connected = await harness();
    const name = toolModules[0].definition.name;

    const success = await connected.client.callTool({
      name,
      arguments: { profile: SNSDK53_PROFILE_NAME },
    });
    const omitted = await connected.client.callTool({ name, arguments: {} });
    const unknown = await connected.client.callTool({
      name,
      arguments: { profile: "unknown" },
    });

    expect(success.isError).toBeUndefined();
    expect(omitted.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    expect(connected.state.handlerCalls).toEqual([name]);
    expect(connected.manager.profileCalls).toEqual([
      SNSDK53_PROFILE_NAME,
      "unknown",
    ]);
    expect(connected.manager.profileCalls).not.toContain("default");
    expect(connected.manager.secretCalls).toEqual([SNSDK53_PROFILE_NAME]);
    expect(connected.manager.clientCalls).toEqual([SNSDK53_PROFILE_NAME]);
    expect(connected.manager.serviceNowCalls).toEqual([]);
  });
});

describe("SNSDK-53 exhaustive profile schema", () => {
  it.each([
    ["basic missing username", { instance: "https://dev.service-now.com", credential: "env:SN_TEST" }],
    ["basic empty username", { instance: "https://dev.service-now.com", username: " ", credential: "env:SN_TEST" }],
    ["basic missing credential", { instance: "https://dev.service-now.com", username: "user" }],
    ["basic malformed credential", { instance: "https://dev.service-now.com", username: "user", credential: "env:" }],
    ["OAuth missing client id", { instance: "https://dev.service-now.com", authType: "oauth", clientSecret: "env:SN_TEST" }],
    ["OAuth empty client id", { instance: "https://dev.service-now.com", authType: "oauth", clientId: " ", clientSecret: "env:SN_TEST" }],
    ["OAuth missing client secret", { instance: "https://dev.service-now.com", authType: "oauth", clientId: "client" }],
    ["OAuth malformed client secret", { instance: "https://dev.service-now.com", authType: "oauth", clientId: "client", clientSecret: "plain-text" }],
    ["OAuth invalid grant", { instance: "https://dev.service-now.com", authType: "oauth", clientId: "client", clientSecret: "env:SN_TEST", grantType: "device_code" }],
    ["OAuth password missing username", { instance: "https://dev.service-now.com", authType: "oauth", clientId: "client", clientSecret: "env:SN_TEST", grantType: "password", credential: "env:SN_TEST" }],
    ["OAuth password missing credential", { instance: "https://dev.service-now.com", authType: "oauth", clientId: "client", clientSecret: "env:SN_TEST", grantType: "password", username: "user" }],
    ["API key missing", { instance: "https://dev.service-now.com", authType: "apikey" }],
    ["API key malformed", { instance: "https://dev.service-now.com", authType: "apikey", apiKey: "plain-text" }],
    ["API key empty header", { instance: "https://dev.service-now.com", authType: "apikey", apiKey: "env:SN_TEST", apiKeyHeader: " " }],
    ["API key non-string header", { instance: "https://dev.service-now.com", authType: "apikey", apiKey: "env:SN_TEST", apiKeyHeader: 1 }],
    ["zero timeout", { ...SNSDK53_PROFILE, timeoutMs: 0 }],
    ["negative timeout", { ...SNSDK53_PROFILE, timeoutMs: -1 }],
    ["fractional timeout", { ...SNSDK53_PROFILE, timeoutMs: 1.5 }],
    ["infinite timeout", { ...SNSDK53_PROFILE, timeoutMs: Number.POSITIVE_INFINITY }],
    ["string timeout", { ...SNSDK53_PROFILE, timeoutMs: "1000" }],
    ["unknown auth type", { ...SNSDK53_PROFILE, authType: "digest" }],
    ["non-string instance", { ...SNSDK53_PROFILE, instance: 53 }],
    ["credential-bearing instance", { ...SNSDK53_PROFILE, instance: "https://user:secret@dev.service-now.com" }],
  ] satisfies Array<[string, Record<string, unknown>]>) (
    "rejects %s before access, secrets, client, or handler",
    async (_label, invalidProfile) => {
      const state: ProbeState = { handlerCalls: [], accessCalls: [] };
      const modules = createProbeCatalog(state).slice(0, 1);
      const manager = createManager(
        Object.freeze({ invalid: Object.freeze(invalidProfile) as Profile })
      );
      const connected = await harness({ manager, modules });
      const result = await connected.client.callTool({
        name: modules[0].definition.name,
        arguments: { profile: "invalid" },
      });

      expect(result.isError).toBe(true);
      expect(manager.profileCalls).toEqual(["invalid"]);
      expect(manager.secretCalls).toEqual([]);
      expect(manager.clientCalls).toEqual([]);
      expect(manager.serviceNowCalls).toEqual([]);
      expect(state.accessCalls).toEqual([]);
      expect(state.handlerCalls).toEqual([]);
    }
  );

  it.each([
    ["basic", SNSDK53_PROFILE],
    [
      "OAuth client credentials",
      {
        instance: "https://alpha.service-now.com",
        authType: "oauth",
        clientId: "client",
        clientSecret: "env:SN_TEST",
      },
    ],
    [
      "OAuth password grant",
      {
        instance: "https://alpha.service-now.com",
        username: "user",
        credential: "env:SN_TEST",
        authType: "oauth",
        clientId: "client",
        clientSecret: "env:SN_TEST",
        grantType: "password",
        timeoutMs: 1,
      },
    ],
    [
      "API key",
      {
        instance: "https://alpha.service-now.com",
        authType: "apikey",
        apiKey: "env:SN_TEST",
        apiKeyHeader: "x-custom-key",
      },
    ],
  ] satisfies Array<[string, Profile]>) (
    "accepts a complete %s profile schema",
    async (_label, profile) => {
      const state: ProbeState = { handlerCalls: [], accessCalls: [] };
      const modules = createProbeCatalog(state).slice(0, 1);
      const manager = createManager(Object.freeze({ valid: Object.freeze(profile) }));
      const connected = await harness({ manager, modules });
      const result = await connected.client.callTool({
        name: modules[0].definition.name,
        arguments: { profile: "valid" },
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ profile: "valid" });
      expect(state.accessCalls).toEqual([modules[0].definition.name]);
      expect(state.handlerCalls).toEqual([modules[0].definition.name]);
      expect(manager.secretCalls).toEqual(["valid"]);
      expect(manager.clientCalls).toEqual(["valid"]);
      expect(manager.serviceNowCalls).toEqual([]);
    }
  );
});

describe("SNSDK-53 integrated secret-output canary", () => {
  it("keeps plaintext, key, ciphertext, and opaque reference out of CLI, logs, results, and audits", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "snsdk-53-canary-"));
    const configPath = path.join(directory, "config.json");
    const key = Buffer.alloc(32, 0x5a);
    const keyText = key.toString("base64");
    const keyProvider: ProfileEncryptionKeyProvider = {
      getKey: () => Buffer.from(key),
    };
    const resolver: SecretResolver = {
      provider: "testvault",
      resolve: () => SNSDK53_SECRET_PROBES.plaintext,
    };
    const manager = new ProfileManager({
      configFilePath: configPath,
      encryptionKeyProvider: keyProvider,
      secretResolvers: [resolver],
    });
    const output: string[] = [];
    const protectedValues = [
      SNSDK53_SECRET_PROBES.plaintext,
      SNSDK53_SECRET_PROBES.reference,
    ];
    const io: ProfileAdminIO = {
      async readSensitive() {
        const value = protectedValues.shift();
        if (!value) throw new Error("missing protected SNSDK-53 input");
        return value;
      },
      write: (value) => output.push(value),
    };

    try {
      await runProfileAdmin(
        [
          "create", "--name", SNSDK53_PROFILE_NAME,
          "--instance", "https://alpha.service-now.com",
          "--auth-type", "basic", "--username", "alpha-user",
          "--source", "encrypted",
        ],
        { manager, keyProvider, io }
      );
      const encryptedRaw = fs.readFileSync(configPath, "utf8");
      const ciphertext = JSON.parse(encryptedRaw).profiles.alpha.credential.ciphertext as string;
      expect(encryptedRaw).not.toContain(SNSDK53_SECRET_PROBES.plaintext);
      expect(encryptedRaw).not.toContain(keyText);

      await runProfileAdmin(
        ["inspect", "--name", SNSDK53_PROFILE_NAME],
        { manager, keyProvider, io }
      );
      await runProfileAdmin(
        [
          "rotate", "--name", SNSDK53_PROFILE_NAME,
          "--field", "credential", "--source", "reference",
          "--provider", "testvault",
        ],
        { manager, keyProvider, io }
      );
      const referenceRaw = fs.readFileSync(configPath, "utf8");
      expect(referenceRaw).not.toContain(SNSDK53_SECRET_PROBES.plaintext);
      expect(referenceRaw).not.toContain(keyText);
      expect(referenceRaw).not.toContain(ciphertext);
      expect(referenceRaw).toContain(SNSDK53_SECRET_PROBES.reference);

      const lines: string[] = [];
      const observability = createHttpObservability({
        sink: createJsonLinesEventSink((line) => lines.push(line)),
        clock: { now: () => 53 },
      });
      const records: ToolAuditRecord[] = [];
      const state: ProbeState = { handlerCalls: [], accessCalls: [] };
      const profileModule = createProbeCatalog(state).find(
        ({ runtime }) => runtime === "context-only"
      );
      if (!profileModule) throw new Error("missing SNSDK-53 profile probe");
      const connected = await harness({
        manager: {
          manager,
          profileCalls: [],
          secretCalls: [],
          clientCalls: [],
          serviceNowCalls: [],
        },
        modules: [profileModule],
        records,
        toolAuditObserver: { begin: () => observability.beginTool() },
      });
      const result = await connected.client.callTool({
        name: profileModule.definition.name,
        arguments: { profile: SNSDK53_PROFILE_NAME },
      });
      expect(result.isError).toBeUndefined();

      const exposed = JSON.stringify({
        cli: output,
        logs: lines,
        result,
        audits: records,
      });
      for (const canary of [
        SNSDK53_SECRET_PROBES.plaintext,
        keyText,
        ciphertext,
        SNSDK53_SECRET_PROBES.reference,
      ]) {
        expect(exposed).not.toContain(canary);
      }
    } finally {
      key.fill(0);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
