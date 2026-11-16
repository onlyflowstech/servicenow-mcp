/**
 * Read and write tools hide fields by dictionary type, not only by name.
 *
 * Every test runs the real dispatcher (in-process MCP server and client) over
 * a recording double of the ServiceNow client. The fixture dictionary types
 * fields whose names the sensitive-name check misses as `password` or
 * `password2`, and every row the double returns carries a marker string in
 * those fields, in each display shape the Table API uses: a plain value,
 * `{value, display_value, link}`, and the `sysparm_display_value=all` pair.
 * A `password2` display value can be the decrypted text, so the whole field
 * must go, never just its `value`. Synthetic data only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { isCredentialTable } from "../src/credential-tables.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import {
  fieldPolicyDenialMessage,
  FieldPolicyError,
  isSensitiveFieldName,
} from "../src/field-policy.js";
import {
  classifyField,
  FIELD_TYPES_UNAVAILABLE_MESSAGE,
  fieldTypesFromRows,
  hiddenTypedFields,
  loadFieldTypes,
  rowValueHidden,
  rowValueRule,
  runWithHiddenFieldScope,
  validateFieldTypesConfig,
  withoutFields,
} from "../src/hidden-values.js";
import { createCachedServiceNowOperations } from "../src/metadata-cache.js";
import { buildPolicyCard, renderPolicyCard } from "../src/policy-card.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { createEncodedQueryAccessPolicy } from "../src/encoded-query-policy.js";
import { createAtfExecutionPolicy } from "../src/atf-policy.js";
import { prepareSteps } from "../src/tools/atf-step-catalog.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import type { ToolModuleLogger } from "../src/tools/tool-module.js";
import { fieldTypeAnswer, type FieldTypeFixture } from "./fixtures/field-types.js";

/** A row with every field the request names present; a value already there wins. */
function echoFields(row: Record<string, unknown>, params: Record<string, string>): Record<string, unknown> {
  const echoed: Record<string, unknown> = {};
  for (const field of (params.sysparm_fields ?? "").split(",").filter(Boolean)) echoed[field] = "1";
  return { ...echoed, ...row };
}

/** The name shapes the sensitive-name check misses. */
const MISSED = [
  "temppassword",
  "clientstate",
  "key",
  "passphrase",
  "otp",
  "answer",
  "secure_value",
  "shared_key",
] as const;

const SECRET = "SECRET-MARKER-7f3a";
const SYS_ID = "a".repeat(32);

const FIXTURE: FieldTypeFixture = {
  dictionary: [
    ...MISSED.map((element, index) => ({
      name: "u_vault",
      element,
      internal_type: index % 3 === 0 ? "password" : "password2",
    })),
    { name: "u_vault_child", element: "child_secret", internal_type: "password2" },
    { name: "sys_user", element: "user_password", internal_type: "password" },
  ],
  parents: { u_vault_child: ["u_vault"] },
  absent: ["u_vault_view", "u_ghost"],
  views: { u_vault_view: [{ table: "u_vault", prefix: "v" }] },
};

const TABLES = ["u_vault", "u_vault_child", "u_vault_view", "u_ghost", "sys_properties", "incident"];

/** Display shapes of one value, keyed by the field that carries it. */
function shaped(field: string, index: number): unknown {
  const secret = `${SECRET}-${field}`;
  switch (index % 3) {
    case 0:
      return secret;
    case 1:
      return { value: secret, display_value: secret, link: `https://x/${secret}` };
    default:
      return { display_value: secret, value: secret };
  }
}

/** A u_vault row: ordinary fields plus every hidden-typed field, in all shapes. */
function vaultRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    sys_id: SYS_ID,
    name: "vault-one",
    short_description: "ordinary",
    ...extra,
  };
  MISSED.forEach((field, index) => {
    row[field] = shaped(field, index);
  });
  // A camel-cased key for a lower-case element is the same field.
  row.clientState = shaped("clientState", 1);
  return row;
}

interface Recorded {
  readonly path: string;
  readonly params: Record<string, string>;
}

interface HarnessOptions {
  readonly fieldTypes?: FieldTypeFixture | "unavailable";
  readonly dictionary?: "required" | "not_required";
  readonly rows?: (path: string, params: Record<string, string>) => unknown[];
  readonly writeResult?: Record<string, unknown>;
  readonly metadataCache?: NonNullable<ServiceNowConfig["metadataCache"]>;
  readonly instance?: string;
}

interface Harness {
  readonly client: Client;
  readonly reads: Recorded[];
  readonly writes: { method: string; path: string; body: unknown }[];
  readonly warnings: string[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; data: unknown }>;
}

const open: Array<{ client: Client; close: () => Promise<void> }> = [];
let instanceCounter = 0;

afterEach(async () => {
  for (const entry of open.splice(0)) await entry.close();
});

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  instanceCounter += 1;
  const config: ServiceNowConfig = {
    instance: options.instance ?? `https://field-types-${instanceCounter}.service-now.com`,
    user: "field-types-user",
    password: "unused-test-placeholder",
    displayValue: "true",
    relDepth: 3,
    // The type step runs on cached operations, which every production call
    // has; a test turns the cache on to get them.
    metadataCache: options.metadataCache ?? { smallReadBytes: 0 },
  };
  const reads: Recorded[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  const warnings: string[] = [];
  const fixture = options.fieldTypes ?? FIXTURE;
  const getWithMeta = vi.fn(async (path: string, params: Record<string, string> = {}) => {
    reads.push({ path, params });
    if (fixture === "unavailable" && /sys_dictionary|sys_db_object|sys_db_view_table/u.test(path)) {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    const typed = fixture === "unavailable" ? undefined : fieldTypeAnswer(path, params, fixture);
    if (typed) return typed;
    const rows = (options.rows?.(path, params) ?? [vaultRow()]).map((row) =>
      echoFields(row as Record<string, unknown>, params)
    );
    // A read by sys_id answers one record, as the Table API does.
    const single = /^\/api\/now\/table\/[a-z_]+\/[0-9a-f]{32}$/u.test(path);
    return {
      data: { result: single ? rows[0] : rows },
      status: 200,
      headers: new Headers(),
    };
  });
  const result = (method: string) =>
    vi.fn(async (path: string, body?: unknown) => {
      writes.push({ method, path, body });
      return { result: options.writeResult ?? vaultRow() };
    });
  const serviceNowClient = {
    getWithMeta,
    get: vi.fn(async (path: string, params: Record<string, string> = {}) => (await getWithMeta(path, params)).data),
    post: result("post"),
    patch: result("patch"),
    put: result("put"),
    delete: vi.fn(async () => ({ status: 204 })),
  } as unknown as ServiceNowClient;
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: config.instance,
      username: config.user,
      credential: "env:FIELD_TYPES_TEST_SECRET_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => config),
    getClient: vi.fn(() => serviceNowClient),
  } as unknown as ProfileManager;
  const tableAccess = createTableAccessPolicy({
    readTables: TABLES,
    writeTables: ["u_vault", "sys_properties"],
    targets: TABLES.map((table) => ({
      table,
      kind: "canonical" as const,
      tools: ["sn_query", "sn_get", "sn_aggregate", "sn_create", "sn_update", "sn_batch"],
      closureComplete: true,
      relatedTables: [table],
    })),
  });
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `field-types-${String(requestId)}`,
        identity: { ownerId: "owner", clientId: "client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "field-types",
        revision: "test",
        tableAccess,
        ...(options.dictionary === undefined ? {} : { fieldTypes: { dictionary: options.dictionary } }),
      }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
  };
  const logger: ToolModuleLogger = {
    write: (entry) => {
      if (entry.level === "warn") warnings.push(entry.event);
    },
  };
  const server = await createMcpServer({
    dependencies: { profileManager, executionContext },
    register: (surface, dependencies) =>
      registerServiceNowTools(surface, dependencies.profileManager, dependencies.executionContext, logger),
  });
  const client = new Client({ name: "field-types-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({
    client,
    close: async () => {
      await client.close();
      if (server.isConnected()) await server.close();
    },
  });
  return {
    client,
    reads,
    writes,
    warnings,
    async call(name, args) {
      const response = await client.callTool({ name, arguments: { profile: "p", ...args } });
      const text = (response.content as Array<{ type: string; text?: string }>)
        .map((part) => part.text ?? "")
        .join("\n");
      return {
        text: `${text}\n${JSON.stringify(response.structuredContent ?? null)}`,
        isError: response.isError === true,
        data: (response.structuredContent as { data?: unknown } | undefined)?.data,
      };
    },
  };
}

/** Reads of the record tables, not the field-type lookup. */
function tableReads(h: Harness, table: string): Recorded[] {
  return h.reads.filter((read) => read.path.startsWith(`/api/now/table/${table}`));
}

const SENSITIVE_MESSAGE = fieldPolicyDenialMessage(new FieldPolicyError("sensitive_field"));

function expectNoSecret(text: string, extra: readonly string[] = []): void {
  expect(text).not.toContain(SECRET);
  for (const field of [...MISSED, "clientState", ...extra]) {
    expect(text).not.toMatch(new RegExp(`"${field}"\\s*:`, "u"));
  }
}

describe("fixture", () => {
  it("uses names the sensitive-name check misses", () => {
    for (const field of MISSED) expect(isSensitiveFieldName(field), field).toBe(false);
  });
});

describe("sn_query", () => {
  it("refuses a hidden-typed field by name, with the sensitive-name message, before any table read", async () => {
    const h = await harness();
    for (const field of MISSED) {
      const result = await h.call("sn_query", { table: "u_vault", fields: `name,${field}` });
      expect(result.isError, field).toBe(true);
      expect(result.text).toContain(SENSITIVE_MESSAGE);
      // Oracle-free: the field is not named, and the text equals a name denial.
      expect(result.text).not.toContain(`"${field}"`);
    }
    expect(tableReads(h, "u_vault")).toHaveLength(0);
  });

  it("drops hidden-typed fields from fields=all, never asking for them, in every display shape", async () => {
    const h = await harness({
      rows: (path) =>
        path === "/api/now/table/sys_dictionary"
          ? [...MISSED, "name", "short_description", "sys_id"].map((element) => ({ element }))
          : [vaultRow()],
    });
    const result = await h.call("sn_query", { table: "u_vault", fields: "all" });
    expect(result.isError, result.text).toBe(false);
    expectNoSecret(result.text);
    expect(result.text).toContain("vault-one");
    const read = tableReads(h, "u_vault").at(-1)!;
    const requested = read.params.sysparm_fields!.split(",");
    for (const field of MISSED) expect(requested).not.toContain(field);
  });

  it("drops them from the detailed and default projections", async () => {
    const h = await harness();
    for (const args of [{ response_format: "detailed" }, {}]) {
      const result = await h.call("sn_query", { table: "u_vault", ...args });
      expect(result.isError, result.text).toBe(false);
      expectNoSecret(result.text);
    }
  });

  it("drops inherited fields on a child table and view columns on a database view", async () => {
    const h = await harness({
      rows: () => [vaultRow({ child_secret: shaped("child_secret", 1), v_key: shaped("v_key", 2) })],
    });
    const child = await h.call("sn_query", { table: "u_vault_child", fields: "child_secret" });
    expect(child.text).toContain(SENSITIVE_MESSAGE);
    const inherited = await h.call("sn_query", { table: "u_vault_child", fields: "key" });
    expect(inherited.text).toContain(SENSITIVE_MESSAGE);
    const view = await h.call("sn_query", { table: "u_vault_view", fields: "v_key" });
    expect(view.text).toContain(SENSITIVE_MESSAGE);
    const viewAll = await h.call("sn_query", { table: "u_vault_view", response_format: "detailed" });
    expect(viewAll.isError, viewAll.text).toBe(false);
    expect(viewAll.text).not.toContain(`${SECRET}-v_key`);
    const childAll = await h.call("sn_query", { table: "u_vault_child", response_format: "detailed" });
    expect(childAll.isError, childAll.text).toBe(false);
    expectNoSecret(childAll.text, ["child_secret"]);
  });

  it("refuses a hidden-typed field as an order, filter or structured order field", async () => {
    const h = await harness();
    for (const args of [
      { orderby: "-passphrase" },
      { structured_query: { filter: { type: "text", field: "otp", operator: "starts_with", value: "1" } } },
      { structured_query: { order_by: [{ field: "shared_key", direction: "asc" }] } },
    ]) {
      const result = await h.call("sn_query", { table: "u_vault", fields: "name", ...args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(tableReads(h, "u_vault")).toHaveLength(0);
  });
});

describe("sn_get", () => {
  it("refuses a hidden field and drops every hidden field from the record", async () => {
    const h = await harness();
    const denied = await h.call("sn_get", { table: "u_vault", sys_id: SYS_ID, fields: "answer" });
    expect(denied.text).toContain(SENSITIVE_MESSAGE);
    for (const args of [{}, { fields: "all" }, { response_format: "detailed" }]) {
      const result = await h.call("sn_get", { table: "u_vault", sys_id: SYS_ID, ...args });
      expect(result.isError, result.text).toBe(false);
      expectNoSecret(result.text);
    }
  });
});

describe("sn_aggregate", () => {
  it("refuses a hidden field as the aggregate field or the group-by field", async () => {
    const h = await harness();
    const max = await h.call("sn_aggregate", { table: "u_vault", type: "MAX", field: "otp" });
    expect(max.text).toContain(SENSITIVE_MESSAGE);
    const grouped = await h.call("sn_aggregate", { table: "u_vault", type: "COUNT", group_by: "secure_value" });
    expect(grouped.text).toContain(SENSITIVE_MESSAGE);
    expect(h.reads.some((read) => read.path.startsWith("/api/now/stats/"))).toBe(false);
  });
});

describe("writes", () => {
  it("refuses a hidden-typed write key on sn_create, sn_update and sn_batch", async () => {
    const h = await harness();
    const create = await h.call("sn_create", { table: "u_vault", fields: { name: "x", key: "y" } });
    expect(create.text).toContain(SENSITIVE_MESSAGE);
    const update = await h.call("sn_update", { table: "u_vault", sys_id: SYS_ID, fields: { passphrase: "y" } });
    expect(update.text).toContain(SENSITIVE_MESSAGE);
    const batch = await h.call("sn_batch", {
      table: "u_vault",
      action: "update",
      structured_query: { filter: { type: "equality", field: "name", operator: "eq", value: "x" } },
      fields: { answer: "y" },
    });
    expect(batch.text).toContain(SENSITIVE_MESSAGE);
    expect(h.writes).toHaveLength(0);
  });

  it("drops hidden-typed fields from the record sn_create and sn_update return", async () => {
    const h = await harness();
    const create = await h.call("sn_create", { table: "u_vault", fields: { name: "x" } });
    expect(create.isError, create.text).toBe(false);
    expectNoSecret(create.text);
    const update = await h.call("sn_update", { table: "u_vault", sys_id: SYS_ID, fields: { name: "x" } });
    expect(update.isError, update.text).toBe(false);
    expectNoSecret(update.text);
  });

  it("keeps hidden fields out of an sn_batch dry run and refuses them as its filter", async () => {
    const h = await harness();
    const dry = await h.call("sn_batch", {
      table: "u_vault",
      action: "delete",
      structured_query: { filter: { type: "equality", field: "name", operator: "eq", value: "vault-one" } },
    });
    expect(dry.isError, dry.text).toBe(false);
    expectNoSecret(dry.text);
    for (const read of tableReads(h, "u_vault")) {
      for (const field of MISSED) expect(read.params.sysparm_fields ?? "").not.toContain(field);
    }
    const filtered = await h.call("sn_batch", {
      table: "u_vault",
      action: "delete",
      structured_query: { filter: { type: "equality", field: "key", operator: "eq", value: "1" } },
    });
    expect(filtered.isError).toBe(true);
  });
});

describe("sys_properties", () => {
  const properties = [
    { sys_id: "1".repeat(32), name: "p.plain", value: `${SECRET}-plain-ok`, type: "string" },
    { sys_id: "2".repeat(32), name: "p.secret2", value: `${SECRET}-p2`, type: "password2" },
    { sys_id: "3".repeat(32), name: "p.secret", value: `${SECRET}-p1`, type: { value: "password", display_value: "password" } },
    { sys_id: "4".repeat(32), name: "p.untyped", value: `${SECRET}-untyped` },
    { sys_id: "5".repeat(32), name: "p.unknown", value: `${SECRET}-unknown`, type: "Password (2 Way Encrypted)" },
    { sys_id: "6".repeat(32), name: "p.flag", value: { value: "true", display_value: "true" }, type: { value: "true|false", display_value: "true | false" } },
  ];

  it("always fetches type and shows value only for a known non-secret type", async () => {
    const h = await harness({ rows: () => properties.map((row) => ({ ...row })) });
    const result = await h.call("sn_query", { table: "sys_properties", fields: "name,value" });
    expect(result.isError, result.text).toBe(false);
    const read = tableReads(h, "sys_properties").at(-1)!;
    expect(read.params.sysparm_fields!.split(",")).toEqual(expect.arrayContaining(["name", "value", "type"]));
    expect(result.text).toContain(`${SECRET}-plain-ok`);
    for (const hidden of ["p2", "p1", "untyped", "unknown"]) {
      expect(result.text).not.toContain(`${SECRET}-${hidden}`);
    }
    const rows = (result.data as { results: Record<string, unknown>[] }).results;
    expect(rows.find((row) => row.name === "p.flag")?.value).toBeDefined();
    // The type was fetched for the rule, not asked for: it is not returned.
    for (const row of rows) expect(row).not.toHaveProperty("type");
  });

  it("applies the rule to a detailed read and to the write echo", async () => {
    const h = await harness({
      rows: () => properties.map((row) => ({ ...row })),
      writeResult: { ...properties[1]! },
    });
    const detailed = await h.call("sn_query", { table: "sys_properties", response_format: "detailed" });
    expect(detailed.isError, detailed.text).toBe(false);
    expect(detailed.text).not.toContain(`${SECRET}-p2`);
    const update = await h.call("sn_update", { table: "sys_properties", sys_id: "2".repeat(32), fields: { description: "d" } });
    expect(update.isError, update.text).toBe(false);
    expect(update.text).not.toContain(`${SECRET}-p2`);
  });

  it("refuses value as a filter, order, aggregate or group-by field", async () => {
    const h = await harness({ rows: () => properties.map((row) => ({ ...row })) });
    for (const [tool, args] of [
      ["sn_query", { orderby: "value", fields: "name" }],
      ["sn_query", { fields: "name", structured_query: { filter: { type: "text", field: "value", operator: "starts_with", value: "a" } } }],
      ["sn_aggregate", { type: "COUNT", group_by: "value" }],
      ["sn_aggregate", { type: "MAX", field: "value" }],
    ] as const) {
      const result = await h.call(tool, { table: "sys_properties", ...args });
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

describe("unavailable field types", () => {
  it("refuses every field-policy tool with the fixed message and reads no record", async () => {
    const h = await harness({ fieldTypes: "unavailable" });
    for (const [tool, args] of [
      ["sn_query", { table: "incident", fields: "number" }],
      ["sn_get", { table: "incident", sys_id: SYS_ID }],
      ["sn_aggregate", { table: "incident", type: "COUNT" }],
      ["sn_create", { table: "u_vault", fields: { name: "x" } }],
      ["sn_update", { table: "u_vault", sys_id: SYS_ID, fields: { name: "x" } }],
    ] as const) {
      const result = await h.call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.text).toContain(FIELD_TYPES_UNAVAILABLE_MESSAGE);
    }
    expect(FIELD_TYPES_UNAVAILABLE_MESSAGE).toContain("sys_dictionary");
    expect(tableReads(h, "incident")).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it("refuses a table whose chain cannot be resolved", async () => {
    const h = await harness({ rows: () => [] });
    const result = await h.call("sn_query", { table: "u_ghost", fields: "name" });
    expect(result.text).toContain(FIELD_TYPES_UNAVAILABLE_MESSAGE);
  });

  it("falls back to name-only hiding under the opt-out, and warns", async () => {
    const h = await harness({ fieldTypes: "unavailable", dictionary: "not_required" });
    const result = await h.call("sn_query", { table: "u_vault", fields: "name,key" });
    expect(result.isError, result.text).toBe(false);
    // Name-only: the type-hidden `key` is returned, a sensitive name is not.
    expect(result.text).toContain(`${SECRET}-key`);
    const named = await h.call("sn_query", { table: "u_vault", fields: "api_key" });
    expect(named.text).toContain(SENSITIVE_MESSAGE);
    expect(h.warnings).toContain("field_types.names_only");
  });

  it("still hides by type under the opt-out when the types can be read", async () => {
    const h = await harness({ dictionary: "not_required" });
    const result = await h.call("sn_query", { table: "u_vault", fields: "key" });
    expect(result.text).toContain(SENSITIVE_MESSAGE);
    expect(h.warnings).toHaveLength(0);
  });
});

describe("cost", () => {
  it("reads the dictionary once per cache lifetime; a warm call makes no extra request", async () => {
    const h = await harness({ metadataCache: { ttlMs: 200, smallReadBytes: 0 } });
    const lookups = () =>
      h.reads.filter((read) => /sys_dictionary|sys_db_object|sys_db_view_table/u.test(read.path));
    await h.call("sn_query", { table: "u_vault", fields: "name" });
    expect(lookups().map((read) => read.path)).toEqual([
      "/api/now/table/sys_dictionary",
      "/api/now/table/sys_db_object",
    ]);
    // No watermark: the memo is the cache for these reads.
    expect(lookups().some((read) => read.params.sysparm_query === "ORDERBYDESCsys_updated_on")).toBe(false);
    for (let index = 0; index < 3; index += 1) {
      await h.call("sn_query", { table: "u_vault", fields: "name" });
    }
    expect(lookups()).toHaveLength(2);
    // A new table costs one chain read; the dictionary stays memoized.
    await h.call("sn_query", { table: "incident", fields: "number" });
    expect(lookups()).toHaveLength(3);
    // After the profile's cache TTL the lookup runs again.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await h.call("sn_query", { table: "u_vault", fields: "name" });
    expect(lookups()).toHaveLength(5);
  });

  it("keeps the lookup out of the call's reported cache outcome", async () => {
    const h = await harness();
    const result = await h.call("sn_query", { table: "u_vault", fields: "name" });
    expect(result.text).not.toContain('"cache"');
  });
});

describe("hidden-values helper contract", () => {
  const ops = (answer: (path: string, params: Record<string, string>) => unknown) =>
    createCachedServiceNowOperations(
      {
        getWithMeta: async (path: string, params: Record<string, string> = {}) => {
          const data = answer(path, params);
          if (data instanceof Error) throw data;
          return { data, status: 200, headers: new Headers() };
        },
        get: async () => null,
        post: async () => null,
        patch: async () => null,
        delete: async () => ({ status: 204 }),
        postBinary: async () => null,
        getRaw: async () => {
          throw new Error("unused");
        },
      } as never,
      `hidden-values-${Math.random()}`,
      { smallReadBytes: 0 }
    );

  it("returns an explicit unavailable state, never an empty map", async () => {
    for (const answer of [
      () => new Error("403"),
      () => ({ result: [] }),
      () => ({ result: "nope" }),
      () => ({ result: Array.from({ length: 10_000 }, () => ({ name: "t", element: "e", internal_type: "password" })) }),
    ]) {
      const types = await loadFieldTypes(ops((path) => (path.includes("sys_dictionary") ? answer() : { result: [] })), ["incident"]);
      expect(types.state).toBe("unavailable");
      expect(hiddenTypedFields(types, "incident")).toBeUndefined();
      expect(classifyField(types, "incident", "number")).toBe("unknown_type");
    }
  });

  it("resolves dot-walks on the table they end at, and an unresolved hop as unknown", async () => {
    const types = await loadFieldTypes(
      ops((path, params) => fieldTypeAnswer(path, params, FIXTURE)?.data ?? { result: [] }),
      ["incident", "u_vault", "sys_user", "sys_properties"]
    );
    const references: Record<string, string> = { "incident.vault": "u_vault", "incident.caller_id": "sys_user", "incident.prop": "sys_properties" };
    const referenceTarget = (table: string, field: string) => references[`${table}.${field}`];
    expect(classifyField(types, "incident", "vault.key", { referenceTarget })).toBe("type");
    expect(classifyField(types, "incident", "caller_id.user_password", { referenceTarget })).toBe("type");
    expect(classifyField(types, "incident", "vault.name", { referenceTarget })).toBe("visible");
    expect(classifyField(types, "incident", "prop.value", { referenceTarget })).toBe("credential_table");
    expect(classifyField(types, "incident", "nowhere.key", { referenceTarget })).toBe("unknown_type");
    expect(classifyField(types, "incident", "vault.key")).toBe("unknown_type");
    expect(isCredentialTable("sys_auth_profile_basic")).toBe(true);
  });

  it("resolves a database view to its joined table's fields", async () => {
    const types = await loadFieldTypes(
      ops((path, params) => fieldTypeAnswer(path, params, FIXTURE)?.data ?? { result: [] }),
      ["u_vault_view", "u_ghost"]
    );
    expect([...hiddenTypedFields(types, "u_vault_view")!]).toEqual(expect.arrayContaining(MISSED.map((field) => `v_${field}`)));
    expect(hiddenTypedFields(types, "u_ghost")).toBeUndefined();
  });

  it("takes types a caller already read; complete rows make a missing field unknown", () => {
    const rows = [
      { table: "task", element: "number", internal_type: "string" },
      { table: "incident", element: "otp", internal_type: "password" },
    ];
    const types = fieldTypesFromRows(rows, { incident: ["incident", "task"] }, { complete: true });
    expect(classifyField(types, "incident", "otp")).toBe("type");
    expect(classifyField(types, "incident", "number")).toBe("visible");
    expect(classifyField(types, "incident", "mystery")).toBe("unknown_type");
  });

  it("removes a whole field in every display shape", () => {
    const record = { a: "x", Key: "s", b: { value: "s", display_value: "s", link: "l" }, c: { display_value: "s", value: "s" } };
    expect(withoutFields(record, new Set(["key", "b", "c"]))).toEqual({ a: "x" });
  });

  it("hides a sys_properties value unless its type is known and not secret", () => {
    const rule = rowValueRule("sys_properties")!;
    expect(rowValueHidden(rule, { type: "string" })).toBe(false);
    expect(rowValueHidden(rule, { type: { value: "true|false", display_value: "true | false" } })).toBe(false);
    for (const type of ["password", "password2", "", undefined, "Password2", { display_value: "" }]) {
      expect(rowValueHidden(rule, { type }), JSON.stringify(type)).toBe(true);
    }
  });
});

describe("profile opt-out", () => {
  it("validates fieldTypes and flags the opt-out on the policy card", () => {
    expect(validateFieldTypesConfig({ dictionary: "not_required" })).toEqual({ dictionary: "not_required" });
    expect(() => validateFieldTypesConfig({ dictionary: "off" })).toThrow(/fieldTypes.dictionary/u);
    expect(() => validateFieldTypesConfig({ other: true })).toThrow(/fieldTypes supports only/u);
    const input = {
      profile: "p",
      instance: "https://card.service-now.com",
      authType: "basic" as const,
      tableAccess: createTableAccessPolicy({
        readTables: ["incident"],
        targets: [{ table: "incident", kind: "canonical", tools: ["sn_query"], closureComplete: true, relatedTables: ["incident"] }],
      }),
      encodedQueryAccess: createEncodedQueryAccessPolicy(),
      atf: createAtfExecutionPolicy(undefined),
    };
    const required = buildPolicyCard(input);
    expect(required.field_types).toEqual({ dictionary: "required" });
    expect(renderPolicyCard(required)).not.toContain("field types not required");
    const optedOut = buildPolicyCard({ ...input, fieldTypes: { dictionary: "not_required" } });
    expect(optedOut.field_types).toEqual({ dictionary: "not_required" });
    expect(renderPolicyCard(optedOut)).toContain("WARNING: field types not required");
  });
});

describe("ATF step conditions", () => {
  // The dispatcher prepares sn_atf_author's plan again inside the call's
  // hidden-field scope; this is that second preparation.
  const scope = {
    tables: new Map<string, ReadonlySet<string>>([
      ["u_vault", new Set(MISSED)],
      ["sys_properties", new Set<string>()],
      ...["sys_atf_step", "sys_variable_value", "sys_element_mapping", "sys_atf_step_config", "sys_atf_test"].map(
        (table) => [table, new Set<string>()] as [string, ReadonlySet<string>]
      ),
    ]),
    unresolved: "names_only" as const,
  };
  const prepare = (type: string, inputs: Record<string, unknown>) =>
    runWithHiddenFieldScope(scope, () =>
      prepareSteps({ test_sys_id: "b".repeat(32), steps: [{ type, inputs }] }, false)
    );

  it("refuses a password-typed field, or sys_properties.value, as a condition or an assignment", () => {
    expect(() => prepare("record_query", { table: "u_vault", field_values: "name=x" })).not.toThrow();
    for (const conditions of ["key=abc", "nameSTARTSWITHa^ORDERBYotp", "answerISNOTEMPTY"]) {
      expect(() => prepare("record_query", { table: "u_vault", field_values: conditions }), conditions).toThrow(
        FieldPolicyError
      );
      expect(() => prepare("field_values_validation", { table: "u_vault", conditions }), conditions).toThrow(
        FieldPolicyError
      );
    }
    expect(() => prepare("record_query", { table: "sys_properties", field_values: "valueSTARTSWITHa" })).toThrow(
      FieldPolicyError
    );
    expect(() => prepare("set_field_values", { table: "u_vault", field_values: "passphrase=x" })).toThrow(
      FieldPolicyError
    );
  });
});
