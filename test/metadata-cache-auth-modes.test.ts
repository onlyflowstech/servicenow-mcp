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
  /** sysparm_fields of a read, when it had one. */
  readonly fields?: string;
}

interface InstanceState {
  newest: { sys_id: string; sys_updated_on: string };
  count: number;
  /** Status for the next watermark reads, consumed one per read. */
  watermarkStatuses: number[];
  /** Status for the next PATCH requests, consumed one per request. */
  patchStatuses: number[];
}

function column(name: string, element: string, index: number) {
  return {
    sys_id: index.toString(16).padStart(32, "0"),
    name,
    element,
    column_label: element,
    internal_type: "string",
    max_length: "40",
    mandatory: "false",
    reference: "",
  };
}

const DICTIONARY_ROWS = [
  { sys_id: "a".repeat(32), name: "incident", element: "number", column_label: "Number", internal_type: "string", max_length: "40", mandatory: "false", reference: "" },
  { sys_id: "b".repeat(32), name: "incident", element: "short_description", column_label: "Short description", internal_type: "string", max_length: "160", mandatory: "true", reference: "" },
  { sys_id: "c".repeat(32), name: "incident", element: "caller_id", column_label: "Caller", internal_type: "reference", max_length: "32", mandatory: "false", reference: "sys_user" },
  ...[
    ["cmdb_ci_linux_server", "kernel_release"],
    ["cmdb_ci_server", "classification"],
    ["cmdb_ci_computer", "cpu_count"],
    ["cmdb_ci_hardware", "serial_number"],
    ["cmdb_ci", "name"],
    ["cmdb_ci", "ip_address"],
    ["cmdb", "sys_class_name"],
  ].map(([table, element], index) => column(table!, element!, 0x100 + index)),
  // A custom table and a system table, each with a sensitive column. u_x also
  // carries the four fields a write must list explicitly; reads are open.
  ...[
    ["u_x", "u_note"],
    ["u_x", "sys_class_name"],
    ["u_x", "sys_class_path"],
    ["u_x", "sys_domain"],
    ["u_x", "sys_domain_path"],
    ["u_x", "password"],
    ["sys_user", "user_name"],
    ["sys_user", "email"],
    ["sys_user", "password"],
  ].map(([table, element], index) => column(table!, element!, 0x200 + index)),
];

/** Ancestors by table name, nearest first. Labels differ from names. */
const CHAINS: Readonly<Record<string, readonly { name: string; label: string }[]>> = {
  incident: [{ name: "task", label: "Task" }],
  task: [],
  cmdb_ci_linux_server: [
    { name: "cmdb_ci_server", label: "Server" },
    { name: "cmdb_ci_computer", label: "Computer" },
    { name: "cmdb_ci_hardware", label: "Hardware" },
    { name: "cmdb_ci", label: "Configuration Item" },
    { name: "cmdb", label: "Base Configuration Item" },
  ],
};
const CMDB_COLUMNS = ["classification", "cpu_count", "ip_address", "kernel_release", "name", "serial_number", "sys_class_name"];
/** Record tables the stub answers with an empty list. */
const DATA_TABLE_PATHS = new Set(
  ["cmdb_ci_linux_server", "incident", "u_x", "sys_user"].map((table) => `/api/now/table/${table}`)
);

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
        patchStatuses: [],
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
    const fields = params.get("sysparm_fields") ?? undefined;
    calls.push({
      host: url.host,
      method,
      path: url.pathname,
      kind: isWatermark ? "watermark" : "read",
      scheme,
      ...(isWatermark || fields === undefined ? {} : { fields }),
    });

    if (isWatermark) {
      const status = instance.watermarkStatuses.shift() ?? 200;
      if (status !== 200) return json(status, { error: { message: "denied" } });
      return json(200, { result: [instance.newest] }, {
        "x-total-count": String(instance.count),
        date: "Wed, 15 Jan 2025 13:00:00 GMT",
      });
    }
    if (method === "PATCH") {
      const status = instance.patchStatuses.shift() ?? 200;
      if (status !== 200) return json(status, { error: { message: "upstream" } });
      return json(200, { result: { sys_id: url.pathname.split("/").at(-1) } });
    }
    if (url.pathname === "/api/now/table/sys_db_object") {
      // Answers the dot-walked super_class(.super_class)*.name fields by name.
      // super_class itself is the label, which the walk must not follow.
      const name = /^name=([a-z_]+)/u.exec(params.get("sysparm_query") ?? "")?.[1] ?? "";
      const ancestors = CHAINS[name];
      if (ancestors === undefined) return json(200, { result: [] });
      const row: Record<string, string> = { name, super_class: ancestors[0]?.label ?? "" };
      for (const field of (fields ?? "").split(",")) {
        const depth = field.split("super_class.").length - 1;
        if (depth > 0) row[field] = ancestors[depth - 1]?.name ?? "";
      }
      return json(200, { result: [row] });
    }
    if (url.pathname === "/api/now/table/sys_documentation" || url.pathname === "/api/now/table/sys_choice") {
      return json(200, { result: [] });
    }
    if (url.pathname === "/api/now/table/sys_dictionary") {
      const query = params.get("sysparm_query") ?? "";
      const tables = /^name(?:=|IN)([^^]+)/u.exec(query)?.[1]?.split(",");
      const allowed = /\^elementIN([^^]+)/u.exec(query)?.[1]?.split(",");
      const rows = DICTIONARY_ROWS.filter((row) =>
        (!tables || tables.includes(row.name)) && (!allowed || allowed.includes(row.element))
      );
      return json(200, { result: rows }, { "x-total-count": String(rows.length) });
    }
    if (DATA_TABLE_PATHS.has(url.pathname)) {
      return json(200, { result: [] }, { "x-total-count": "0" });
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
  readTables: ["incident", "cmdb_ci_linux_server", "sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice"],
  writeTables: [],
  targets: [
    target("incident", ["sn_schema"]),
    target("cmdb_ci_linux_server", ["sn_query", "sn_schema"]),
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

  it("returns fields from all six levels of a CMDB chain, one watermark per table", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect({ basic: PROFILES.basic });

    const fields = await fieldNames(client, "basic", { table: "cmdb_ci_linux_server", fields_only: true });
    // fields_only reads the table's own dictionary only; the full schema walks.
    expect(fields).toEqual(["kernel_release"]);
    const full = await client.callTool({
      name: "sn_schema",
      arguments: { profile: "basic", table: "cmdb_ci_linux_server", limit: 100 },
    });

    expect(full.isError, JSON.stringify(full.content)).toBeFalsy();
    const rows = (full.structuredContent as { data: { fields: { field: string; inherited_from?: string }[] } }).data.fields;
    expect(rows.map((row) => row.field)).toEqual(CMDB_COLUMNS);
    expect(rows.find((row) => row.field === "sys_class_name")?.inherited_from).toBe("cmdb");
    // The walk is one sys_db_object read; the call read each table's watermark once.
    const fullCall = upstream.calls.slice(upstream.calls.findIndex((call) => call.path === "/api/now/table/sys_db_object") - 1);
    expect(fullCall.filter((call) => call.path === "/api/now/table/sys_db_object").map((call) => call.kind))
      .toEqual(["watermark", "read"]);
    const watermarks = fullCall.filter((call) => call.kind === "watermark").map((call) => call.path);
    expect(watermarks).toEqual(["/api/now/table/sys_db_object", "/api/now/table/sys_dictionary"]);
  });

  it("requests inherited columns for fields:all only as far as the profile's policy allows", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect({
      wide: { ...PROFILES.basic },
      narrow: {
        ...PROFILES.basic,
        readableTableFields: [{ table: "cmdb_ci_linux_server", fields: ["sys_id", "name"] }],
      },
    });
    const queryFields = async (profile: string) => {
      const start = upstream.calls.length;
      const result = await client.callTool({
        name: "sn_query",
        arguments: { profile, table: "cmdb_ci_linux_server", fields: "all", limit: 1 },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const calls = upstream.calls.slice(start);
      const read = calls.find((call) => call.path === "/api/now/table/cmdb_ci_linux_server");
      return {
        fields: read?.fields?.split(",").sort() ?? [],
        walked: calls.some((call) => call.path === "/api/now/table/sys_db_object"),
      };
    };

    const wide = await queryFields("wide");
    expect(wide.walked).toBe(true);
    // Every level contributes: the table's own column and each ancestor's.
    for (const field of CMDB_COLUMNS) expect(wide.fields).toContain(field);

    const narrow = await queryFields("narrow");
    expect(narrow.walked).toBe(false);
    expect(narrow.fields).toEqual(["name", "sys_id"]);
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

  it("misses after the profile's secret is rotated", async () => {
    // Same profile, instance and policy. The new secret is a new credential
    // identity, which ServiceNow may map to a different run-as user.
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect({ basic: PROFILES.basic });
    const dictionaryReads = () =>
      upstream.calls.filter((call) => call.path === "/api/now/table/sys_dictionary" && call.kind === "read").length;

    await fieldNames(client, "basic");
    await fieldNames(client, "basic");
    expect(dictionaryReads()).toBe(1);

    vi.stubEnv("E2E_BASIC_PASSWORD", `rotated-${credentialSeq}`);
    await fieldNames(client, "basic");
    expect(dictionaryReads()).toBe(2);
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

/**
 * The field-write branch's field policy through this branch's caches: a
 * profile "*" entry covers ITSM and custom tables but not the 23 system tables
 * (A3), the four explicit-listing fields stay readable, sensitive names never
 * appear, and journal writes are not re-sent through the cached wrapper.
 * Profiles load through ProfileManager, so the policy is validated, frozen and
 * served from the load-time policy-map cache, as in production.
 */
describe("field policy through the metadata and schema caches", () => {
  const FIELD_POLICY_GRANTS = Object.freeze({
    readTables: ["incident", "u_x", "sys_user", "sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice"],
    writeTables: ["incident"],
    targets: [
      target("incident", ["sn_query", "sn_schema", "sn_update"]),
      target("u_x", ["sn_query", "sn_schema"]),
      target("sys_user", ["sn_query", "sn_schema"]),
      target("sys_dictionary", ["sn_query", "sn_schema"]),
      target("sys_db_object", ["sn_query", "sn_schema"]),
      target("sys_documentation", ["sn_schema"]),
      target("sys_choice", ["sn_schema"]),
    ],
  });
  // Same instance and account for both profiles: only the field policy differs.
  const SHARED = Object.freeze({
    instance: "https://e2e-field-policy.service-now.com",
    authType: "basic",
    username: "integration.user",
    credential: "env:E2E_BASIC_PASSWORD",
    tableAccess: FIELD_POLICY_GRANTS,
    metadataCache: METADATA_CACHE,
    schemaCacheTtlMs: SCHEMA_CACHE_TTL_MS,
  });
  const STAR_READABLE = ["sys_id", "number", "u_note"];
  const PROFILES_BY_POLICY = {
    wide: SHARED,
    star: { ...SHARED, fieldPolicy: { "*": { readable: STAR_READABLE } } },
  };
  const host = new URL(SHARED.instance).host;

  async function schemaFields(
    client: Client,
    upstream: ReturnType<typeof stubInstances>,
    profile: string,
    table: string
  ) {
    const start = upstream.calls.length;
    const result = await client.callTool({
      name: "sn_schema",
      arguments: { profile, table, fields_only: true },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return {
      fields: (result.structuredContent as { data: { fields: string[] } }).data.fields,
      upstream: upstream.calls.length - start,
    };
  }

  it('narrows sn_schema by a "*" entry on ITSM and custom tables, never on a system table, with one entry per profile', async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect(PROFILES_BY_POLICY);
    const expected: Record<string, Record<string, string[]>> = {
      wide: {
        incident: ["caller_id", "number", "short_description"],
        // Explicit listing is a write rule; reads stay open. password never shows.
        u_x: ["sys_class_name", "sys_class_path", "sys_domain", "sys_domain_path", "u_note"],
        sys_user: ["email", "user_name"],
      },
      star: {
        incident: ["number"],
        u_x: ["u_note"],
        // A system table: the "*" entry never covers it.
        sys_user: ["email", "user_name"],
      },
    };

    for (const profile of ["wide", "star"]) {
      for (const table of ["incident", "u_x", "sys_user"]) {
        const first = await schemaFields(client, upstream, profile, table);
        expect(first.fields, `${profile} ${table}`).toEqual(expected[profile]![table]);
        // Its own schema entry: the first call goes upstream, even where the
        // other profile already cached an identical-looking result.
        expect(first.upstream, `${profile} ${table}`).toBeGreaterThan(0);
        const repeat = await schemaFields(client, upstream, profile, table);
        expect(repeat).toEqual({ fields: first.fields, upstream: 0 });
      }
    }
    expect(upstream.calls.every((call) => call.host === host || call.kind === "token")).toBe(true);
  });

  it('walks fields:"all" only where the readable set is a wildcard, and never requests a sensitive name', async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect(PROFILES_BY_POLICY);
    const queryAll = async (profile: string, table: string) => {
      const start = upstream.calls.length;
      const result = await client.callTool({
        name: "sn_query",
        arguments: { profile, table, fields: "all", limit: 1 },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const calls = upstream.calls.slice(start);
      const read = calls.find((call) => call.path === `/api/now/table/${table}`);
      return {
        fields: read?.fields?.split(",").sort() ?? [],
        walked: calls.some((call) => call.path === "/api/now/table/sys_db_object"),
      };
    };

    const wideCustom = await queryAll("wide", "u_x");
    expect(wideCustom.walked).toBe(true);
    for (const field of ["sys_class_name", "sys_class_path", "sys_domain", "sys_domain_path", "u_note"]) {
      expect(wideCustom.fields).toContain(field);
    }
    expect(wideCustom.fields).not.toContain("password");

    // The "*" entry narrows the custom table and incident: no walk, exactly
    // the readable set.
    for (const table of ["u_x", "incident"]) {
      const narrowed = await queryAll("star", table);
      expect(narrowed.walked, table).toBe(false);
      expect(narrowed.fields, table).toEqual([...STAR_READABLE].sort());
    }

    // sys_user is a system table, so the "*" entry leaves it open: it walks,
    // over the dictionary rows the wide profile's call already cached, and
    // still drops password.
    const starSystem = await queryAll("star", "sys_user");
    expect(starSystem.walked).toBe(true);
    expect(starSystem.fields).toEqual(expect.arrayContaining(["email", "user_name"]));
    expect(starSystem.fields).not.toContain("password");
  });

  it("sends a journal PATCH once through the cached wrapper, while a watermark GET still retries", async () => {
    const upstream = stubInstances();
    vi.stubGlobal("fetch", upstream.fetchStub);
    const client = await connect({ wide: SHARED });
    const sysId = "f".repeat(32);

    // A 502 after a journal PATCH may follow an applied entry: never re-sent.
    upstream.state(host).patchStatuses.push(502, 502);
    const journal = await client.callTool({
      name: "sn_update",
      arguments: { profile: "wide", table: "incident", sys_id: sysId, fields: { comments: "Customer update" } },
    });
    expect(journal.isError).toBe(true);
    expect(upstream.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);

    // A watermark GET is idempotent: the client still retries its 502, and
    // the read then caches as usual.
    const query = async () => {
      const result = await client.callTool({
        name: "sn_query",
        arguments: { profile: "wide", table: "sys_dictionary", fields: "element,name", limit: 5 },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    };
    upstream.state(host).watermarkStatuses.push(502);
    let start = upstream.calls.length;
    await query();
    expect(upstream.calls.slice(start).map((call) => call.kind)).toEqual(["watermark", "watermark", "read"]);
    start = upstream.calls.length;
    await query();
    expect(upstream.calls.slice(start).map((call) => call.kind)).toEqual(["watermark"]);
  });
});
