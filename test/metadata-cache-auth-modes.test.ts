/**
 * Metadata and schema caching end to end, per auth mode.
 *
 * Real profile file -> ProfileManager.getConfig -> ServiceNowClient (real Basic
 * and OAuth client-credentials providers) -> the registered tool dispatcher ->
 * createCachedServiceNowOperations / sn_schema. Only global fetch is stubbed,
 * standing in for the instance.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEncodedQueryAccessPolicy } from "../src/encoded-query-policy.js";
import { STRUCTURAL_UNCACHEABLE_MS } from "../src/metadata-cache.js";
import type {
  EffectivePolicyProvider,
  ExecutionContextDependencies,
} from "../src/execution-context.js";
import { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy, type TableAccessPolicyInput } from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const WATERMARK_QUERY = "ORDERBYDESCsys_updated_on";

interface UpstreamCall {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly kind: "token" | "watermark" | "read";
  readonly scheme: string;
}

interface InstanceState {
  newest: { sys_id: string; sys_updated_on: string };
  count: number;
  /** Status for the next watermark reads, consumed one per read. */
  watermarkStatuses: number[];
}

const DICTIONARY_ROWS = [
  { sys_id: "a".repeat(32), name: "incident", element: "number", column_label: "Number", internal_type: "string", max_length: "40", mandatory: "false", reference: "" },
  { sys_id: "b".repeat(32), name: "incident", element: "short_description", column_label: "Short description", internal_type: "string", max_length: "160", mandatory: "true", reference: "" },
  { sys_id: "c".repeat(32), name: "incident", element: "caller_id", column_label: "Caller", internal_type: "reference", max_length: "32", mandatory: "false", reference: "sys_user" },
];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A stand-in instance per host. Records every request it receives. */
function stubInstances() {
  const calls: UpstreamCall[] = [];
  const states = new Map<string, InstanceState>();
  const state = (host: string): InstanceState => {
    let current = states.get(host);
    if (!current) {
      current = {
        newest: { sys_id: "d".repeat(32), sys_updated_on: "2025-01-15 12:00:00" },
        count: 162_737,
        watermarkStatuses: [],
      };
      states.set(host, current);
    }
    return current;
  };
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const scheme = (headers.get("authorization") ?? "").split(" ")[0] ?? "";
    const params = url.searchParams;
    const instance = state(url.host);

    if (url.pathname === "/oauth_token.do") {
      calls.push({ host: url.host, method, path: url.pathname, kind: "token", scheme });
      return json(200, { access_token: "e2e-access-token", token_type: "Bearer", expires_in: 1800 });
    }
    const isWatermark =
      params.get("sysparm_query") === WATERMARK_QUERY &&
      params.get("sysparm_fields") === "sys_id,sys_updated_on";
    calls.push({ host: url.host, method, path: url.pathname, kind: isWatermark ? "watermark" : "read", scheme });

    if (isWatermark) {
      const status = instance.watermarkStatuses.shift() ?? 200;
      if (status !== 200) return json(status, { error: { message: "denied" } });
      return json(200, { result: [instance.newest] }, {
        "x-total-count": String(instance.count),
        date: "Wed, 15 Jan 2025 13:00:00 GMT",
      });
    }
    if (url.pathname === "/api/now/table/sys_db_object") {
      // incident -> task, by label as the walk reads super_class today.
      const name = /^name=([a-z_]+)/u.exec(params.get("sysparm_query") ?? "")?.[1];
      const parent = name === "incident" ? "Task" : "";
      return json(200, { result: name ? [{ name, super_class: parent }] : [] });
    }
    if (url.pathname === "/api/now/table/sys_documentation" || url.pathname === "/api/now/table/sys_choice") {
      return json(200, { result: [] });
    }
    if (url.pathname === "/api/now/table/sys_dictionary") {
      const query = params.get("sysparm_query") ?? "";
      const allowed = /\^elementIN([^^]+)/u.exec(query)?.[1]?.split(",");
      const rows = DICTIONARY_ROWS.filter((row) => !allowed || allowed.includes(row.element));
      return json(200, { result: rows }, { "x-total-count": String(rows.length) });
    }
    return json(404, { error: { message: "not stubbed" } });
  });
  return { calls, fetchStub, state };
}

function policyProvider(manager: ProfileManager): EffectivePolicyProvider {
  // Mirrors createRestrictedPolicyProvider in src/index.ts.
  return Object.freeze({
    resolve: ({ profile }: { profile: { name: string } }) => {
      const configured = manager.getProfile(profile.name);
      const tableAccess: TableAccessPolicyInput = configured.tableAccess ?? Object.freeze({});
      return Object.freeze({
        id: `restricted-table-policy:${profile.name}`,
        revision: "snsdk-32-v2-profile-scoped",
        tableAccess: createTableAccessPolicy(tableAccess),
        fieldPolicy: {
          ...(configured.fieldPolicy === undefined ? {} : { fieldPolicy: configured.fieldPolicy }),
          ...(configured.readableTableFields === undefined
            ? {}
            : { readableTableFields: configured.readableTableFields }),
        },
        encodedQueryAccess: createEncodedQueryAccessPolicy(),
        atf: manager.getAtfConfig(profile.name),
      });
    },
  });
}

function target(table: string, tools: readonly string[]) {
  return { table, kind: "canonical", tools, closureComplete: true, relatedTables: [table] };
}

const GRANTS = Object.freeze({
  readTables: ["incident", "sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice"],
  writeTables: [],
  targets: [
    target("incident", ["sn_schema"]),
    target("sys_dictionary", ["sn_query", "sn_schema"]),
    target("sys_db_object", ["sn_schema"]),
    target("sys_documentation", ["sn_schema"]),
    target("sys_choice", ["sn_schema"]),
  ],
});
// Any explicit setting turns either cache on under NODE_ENV=test; production
// runs with both on by default, and with this TTL.
const METADATA_CACHE = Object.freeze({ ttlMs: 24 * 60 * 60 * 1000 });
const SCHEMA_CACHE_TTL_MS = 300_000;

const openClients: Client[] = [];
let directory = "";
let credentialSeq = 0;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-cache-auth-modes-"));
  // The caches are process-wide and partitioned by credential identity, so a
  // fresh credential per test is a fresh partition -- as a rotation would be.
  credentialSeq += 1;
  vi.stubEnv("E2E_BASIC_PASSWORD", `e2e-basic-password-${credentialSeq}`);
  vi.stubEnv("E2E_CLIENT_SECRET", `e2e-client-secret-${credentialSeq}`);
  for (const name of ["SN_USER", "SN_PASSWORD", "SN_AUTH_TYPE", "SN_GRANT_TYPE", "SN_CLIENT_ID", "SN_CLIENT_SECRET", "SN_METADATA_CACHE_TTL_MS", "SN_METADATA_CACHE_TABLES", "SN_SCHEMA_CACHE_TTL_MS"]) {
    vi.stubEnv(name, undefined as unknown as string);
  }
});

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function connect(profiles: Record<string, unknown>) {
  const configFilePath = path.join(directory, "config.json");
  fs.writeFileSync(configFilePath, JSON.stringify({ version: 2, profiles }), { mode: 0o600 });
  const manager = new ProfileManager({ configFilePath });
  const executionContext: ExecutionContextDependencies = Object.freeze({
    requestMetadataProvider: {
      resolve: ({ requestId }: { requestId: unknown }) => ({
        correlationId: `e2e-${String(requestId)}`,
        identity: { ownerId: "e2e-owner", clientId: "e2e-client" },
      }),
    },
    effectivePolicyProvider: policyProvider(manager),
    auditSink: { write: () => {}, writePreContext: () => {} },
  });
  const server = await createMcpServer({
    dependencies: { manager, executionContext },
    register: (surface, injected) =>
      registerServiceNowTools(surface, injected.manager, injected.executionContext),
  });
  const client = new Client({ name: "metadata-cache-e2e", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

const PROFILES = {
  basic: {
    instance: "https://e2e-basic.service-now.com",
    authType: "basic",
    username: "integration.user",
    credential: "env:E2E_BASIC_PASSWORD",
    tableAccess: GRANTS,
    metadataCache: METADATA_CACHE,
    schemaCacheTtlMs: SCHEMA_CACHE_TTL_MS,
  },
  clientcreds: {
    instance: "https://e2e-oauth.service-now.com",
    authType: "oauth",
    grantType: "client_credentials",
    clientId: "e2e-client-id",
    clientSecret: "env:E2E_CLIENT_SECRET",
    tableAccess: GRANTS,
    metadataCache: METADATA_CACHE,
    schemaCacheTtlMs: SCHEMA_CACHE_TTL_MS,
  },
} as const;

describe.each([
  ["Basic", "basic", "Basic"],
  ["OAuth client_credentials", "clientcreds", "Bearer"],
] as const)("metadata cache end to end: %s", (_label, profile, scheme) => {
  const host = new URL(PROFILES[profile].instance).host;

  async function query(client: Client) {
    const result = await client.callTool({
      name: "sn_query",
      arguments: { profile, table: "sys_dictionary", fields: "element,name", limit: 5 },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return result;
  }

  it("caches, and an unchanged watermark makes a hit cost one small request", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect(PROFILES);
    const calls = () => upstream.calls.filter((call) => call.host === host);

    const first = await query(client);
    const afterMiss = calls().length;
    const second = await query(client);
    const hit = calls().slice(afterMiss);

    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(calls().filter((call) => call.kind === "read")).toHaveLength(1);
    expect(hit).toEqual([
      { host, method: "GET", path: "/api/now/table/sys_dictionary", kind: "watermark", scheme },
    ]);
  });

  it("passes a table straight through after a refused watermark read, then serves the kept entry", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect(PROFILES);
    const since = (start: number) => upstream.calls.slice(start).filter((call) => call.host === host).map((call) => call.kind);

    // Only Date is faked: transport and client timers stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await query(client);
      await query(client);

      // 403 is not retried by the client and is a structural cause.
      upstream.state(host).watermarkStatuses.push(403);
      let start = upstream.calls.length;
      await query(client);
      expect(since(start)).toEqual(["watermark", "read"]);

      // Remembered: straight through, no watermark request.
      start = upstream.calls.length;
      await query(client);
      expect(since(start)).toEqual(["read"]);

      // After the period the entry kept from the first call serves again.
      vi.setSystemTime(Date.now() + STRUCTURAL_UNCACHEABLE_MS + 1_000);
      start = upstream.calls.length;
      await query(client);
      expect(since(start)).toEqual(["watermark"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes when the watermark moves, including a delete that only changes the count", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect(PROFILES);
    const reads = () => upstream.calls.filter((call) => call.host === host && call.kind === "read");

    await query(client);
    upstream.state(host).count -= 1;
    await query(client);
    expect(reads()).toHaveLength(2);

    upstream.state(host).newest = { sys_id: "e".repeat(32), sys_updated_on: "2025-01-15 12:30:00" };
    await query(client);
    await query(client);
    expect(reads()).toHaveLength(3);
  });

  it("never sends a sys_user or sys_properties request", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect(PROFILES);

    upstream.state(host).watermarkStatuses.push(403);
    for (let call = 0; call < 3; call += 1) await query(client);
    await client.callTool({
      name: "sn_schema",
      arguments: { profile, table: "incident", fields_only: true },
    });

    const paths = new Set(upstream.calls.filter((call) => call.host === host).map((call) => call.path));
    expect(paths.has("/api/now/table/sys_user")).toBe(false);
    expect(paths.has("/api/now/table/sys_properties")).toBe(false);
    // Every request authenticated with the profile's own scheme.
    expect(new Set(upstream.calls.filter((call) => call.kind !== "token").map((call) => call.scheme)))
      .toEqual(new Set([scheme]));
  });
});

describe("sn_schema cache end to end", () => {
  async function fieldNames(client: Client, profile: string, extra: Record<string, unknown> = {}) {
    const result = await client.callTool({
      name: "sn_schema",
      arguments: { profile, table: "incident", fields_only: true, ...extra },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return (result.structuredContent as { data: { fields: string[] } }).data.fields;
  }

  it("reads each table's watermark once in a call that walks the hierarchy", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect({ basic: PROFILES.basic });

    const result = await client.callTool({
      name: "sn_schema",
      arguments: { profile: "basic", table: "incident" },
    });

    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const hierarchyReads = upstream.calls.filter((call) => call.path === "/api/now/table/sys_db_object");
    // Two hops (incident, task), one sys_db_object watermark.
    expect(hierarchyReads.map((call) => call.kind)).toEqual(["watermark", "read", "read"]);
    const watermarks = upstream.calls.filter((call) => call.kind === "watermark").map((call) => call.path);
    expect(watermarks).toEqual(["/api/now/table/sys_db_object", "/api/now/table/sys_dictionary"]);
  });

  it("hits across tool calls, so a repeat costs no upstream request", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect({ basic: PROFILES.basic });

    const first = await fieldNames(client, "basic");
    const before = upstream.calls.length;
    const second = await fieldNames(client, "basic");

    expect(second).toEqual(first);
    expect(upstream.calls.length).toBe(before);
  });

  it("never shares an entry between two profiles whose field policies differ", async () => {
    // Same instance and the same account: only the readable fields differ.
    const shared = {
      instance: "https://e2e-schema.service-now.com",
      authType: "basic",
      username: "integration.user",
      credential: "env:E2E_BASIC_PASSWORD",
      tableAccess: GRANTS,
      metadataCache: METADATA_CACHE,
      schemaCacheTtlMs: SCHEMA_CACHE_TTL_MS,
    };
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect({
      wide: shared,
      narrow: {
        ...shared,
        readableTableFields: [{ table: "incident", fields: ["number"] }],
      },
    });

    const dictionaryReads = () =>
      upstream.calls.filter((call) => call.path === "/api/now/table/sys_dictionary" && call.kind === "read").length;

    const wide = await fieldNames(client, "wide");
    expect(dictionaryReads()).toBe(1);
    const narrow = await fieldNames(client, "narrow");
    // The narrow profile went upstream for its own read. The handler also
    // re-filters by readable fields, so a shared entry would not show in the
    // output alone -- this is what proves the entries are separate.
    expect(dictionaryReads()).toBe(2);
    const wideAgain = await fieldNames(client, "wide");
    expect(dictionaryReads()).toBe(2);

    expect(wide).toEqual(["caller_id", "number", "short_description"]);
    expect(narrow).toEqual(["number"]);
    expect(wideAgain).toEqual(wide);
  });
});
