/**
 * Test-worker coverage on top of `field-types-cause.test.ts`: what the
 * dispatcher does for the causes and the memo rules that file does not reach.
 *
 * - every chain gap, the view lookup and the other error classes (a hibernating
 *   instance, an HTML page, a 404): text, no "Access denied by policy", no
 *   values, the table never read, and the audit outcome and reason;
 * - the sys_db_object retry (none on a 429, a 4xx or a refusal; one shared by
 *   the table read and a view's joined-table read; none for the view read);
 * - the memo: a chain-read blip, a 429, a missing table, and a view-read
 *   failure are read again on the next call; a full page and an incomplete
 *   chain are kept 30 s with their cause; a success for an hour, not longer;
 * - the opt-in is the only fallback, for every cause, and hides by name;
 * - `field_types_ms` on a memo hit and on a tool that makes no lookup.
 *
 * Every test runs the real dispatcher (in-process MCP server and client) over
 * a scripted double of the ServiceNow client. Synthetic data only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// The retry's pause is a real timer in production; here it only honours the signal.
vi.mock("../src/client.js", async (original) => {
  const actual = await original<typeof import("../src/client.js")>();
  return { ...actual, pauseUnlessServiceNowRequestCancelled: async () => {} };
});

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies, ToolAuditRecord } from "../src/execution-context.js";
import { MAX_HIDDEN_DICTIONARY_ROWS } from "../src/hidden-values.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import {
  createHtmlResponseError,
  createInstanceHibernatingError,
  createInvalidResponseError,
  createRedirectedError,
  createToolError,
  recordTrustedHttpStatus,
  type ToolErrorCategory,
} from "../src/tool-error.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import type { ToolModuleLogger } from "../src/tools/tool-module.js";
import { echoFields } from "./fixtures/echo-fields.js";
import { fieldTypeAnswer, type FieldTypeFixture } from "./fixtures/field-types.js";

const SECRET = "SECRET-MARKER-5e7a";
const SYS_ID = "c".repeat(32);

const LEVELS = Array.from({ length: 11 }, (_, index) => `u_vault_level_${index + 1}`);
const BASE: FieldTypeFixture = {
  dictionary: [
    { name: "u_vault", element: "key", internal_type: "password2" },
    { name: "sys_user", element: "user_password", internal_type: "password" },
  ],
  parents: { u_vault_child: ["u_vault"] },
  absent: ["u_ghost"],
  views: { u_vault_view: [{ table: "u_vault", prefix: "v" }] },
};
const absentViews = [...BASE.absent, "u_vault_view"];

const OPT_OUT = 'set "fieldTypes": { "dictionary": "not_required" } on this profile to hide fields by name only.';
const GRANT_CHAIN = `Grant the integration user read access to sys_db_object, or ${OPT_OUT}`;
const ALONE = `Set ${OPT_OUT.slice(4)}`;

function http(status: number): Error {
  const category: ToolErrorCategory =
    status === 401 ? "authentication" : status === 403 ? "authorization" : status === 429 ? "rate_limit" : status === 404 ? "not_found" : "upstream";
  const retry = status === 429 ? "retry_later" : status === 401 || status === 403 ? "retry_after_correction" : "do_not_retry";
  return recordTrustedHttpStatus(createToolError(category, retry), status);
}
const timeout = () => createToolError("timeout", "retry_if_safe_and_idempotent");

type Step = "ok" | Error | { readonly rows: readonly unknown[] };

interface Options {
  readonly fixture?: FieldTypeFixture;
  readonly dictionary?: readonly Step[];
  readonly chains?: readonly Step[];
  readonly views?: readonly Step[];
  readonly dictionaryMode?: "required" | "not_required";
}

interface Harness {
  readonly reads: { path: string; params: Record<string, string> }[];
  readonly audits: ToolAuditRecord[];
  readonly warnings: string[];
  count(table: string): number;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; structured: unknown }>;
}

const open: Array<() => Promise<void>> = [];
let counter = 0;

afterEach(async () => {
  vi.useRealTimers();
  for (const close of open.splice(0)) await close();
});

async function harness(options: Options = {}): Promise<Harness> {
  counter += 1;
  const config: ServiceNowConfig = {
    instance: `https://field-types-gaps-${counter}.service-now.com`,
    user: "field-types-user",
    password: "unused-test-placeholder",
    displayValue: "true",
    relDepth: 3,
    metadataCache: { smallReadBytes: 0 },
  };
  const reads: Harness["reads"] = [];
  const audits: ToolAuditRecord[] = [];
  const warnings: string[] = [];
  const fixture = options.fixture ?? BASE;
  const seen = { sys_dictionary: 0, sys_db_object: 0, sys_db_view_table: 0 };
  const script = {
    sys_dictionary: options.dictionary,
    sys_db_object: options.chains,
    sys_db_view_table: options.views,
  } as const;

  const getWithMeta = vi.fn(async (path: string, params: Record<string, string> = {}) => {
    reads.push({ path, params });
    const table = /\/api\/now\/table\/(sys_dictionary|sys_db_object|sys_db_view_table)$/u.exec(path)?.[1] as keyof typeof seen | undefined;
    if (table !== undefined && fieldTypeAnswer(path, params, fixture) !== undefined) {
      const steps = script[table];
      const outcome: Step = steps === undefined || steps.length === 0 ? "ok" : steps[Math.min(seen[table], steps.length - 1)]!;
      seen[table] += 1;
      if (outcome instanceof Error) throw outcome;
      if (outcome !== "ok") return { data: { result: outcome.rows }, status: 200, headers: new Headers() };
    }
    const typed = fieldTypeAnswer(path, params, fixture);
    if (typed) return typed;
    const row = { sys_id: SYS_ID, name: "vault-one", key: SECRET, user_password: SECRET, password: SECRET };
    const single = /^\/api\/now\/table\/[a-z_]+\/[0-9a-f]{32}$/u.test(path);
    return { data: { result: single ? echoFields(row, params) : [echoFields(row, params)] }, status: 200, headers: new Headers() };
  });
  const serviceNowClient = {
    getWithMeta,
    get: vi.fn(async (path: string, params: Record<string, string> = {}) => (await getWithMeta(path, params)).data),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ServiceNowClient;
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: config.instance,
      username: config.user,
      credential: "env:FIELD_TYPES_GAPS_SECRET_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => config),
    getClient: vi.fn(() => serviceNowClient),
  } as unknown as ProfileManager;
  const tables = ["u_vault", "u_vault_child", "u_vault_view", "u_ghost", "incident"];
  const tableAccess = createTableAccessPolicy({
    readTables: tables,
    writeTables: [],
    targets: tables.map((table) => ({
      table,
      kind: "canonical" as const,
      tools: ["sn_query", "sn_get"],
      closureComplete: true,
      relatedTables: [table],
    })),
  });
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `gaps-${String(requestId)}`,
        identity: { ownerId: "owner", clientId: "client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "gaps",
        revision: "test",
        tableAccess,
        ...(options.dictionaryMode === undefined ? {} : { fieldTypes: { dictionary: options.dictionaryMode } }),
      }),
    },
    auditSink: { write: (record) => audits.push(record), writePreContext: () => {} },
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
  const client = new Client({ name: "gaps-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    if (server.isConnected()) await server.close();
  });
  return {
    reads,
    audits,
    warnings,
    count: (table) => reads.filter((read) => read.path === `/api/now/table/${table}`).length,
    async call(name, args) {
      const response = await client.callTool({ name, arguments: { profile: "p", ...args } });
      const text = (response.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");
      return { text, isError: response.isError === true, structured: response.structuredContent ?? null };
    },
  };
}

const QUERY = { table: "u_vault", fields: "name" };
const CHILD = { table: "u_vault_child", fields: "name" };

/** A refusal that is no policy denial: the text, no secret, the table never read, a handler error in the audit. */
function expectRefusal(h: Harness, result: { text: string; isError: boolean }, table: string, text: string) {
  expect(result.isError, result.text).toBe(true);
  expect(result.text).toContain(text);
  expect(result.text).not.toContain("Access denied by policy");
  expect(result.text).not.toContain(SECRET);
  expect(h.reads.filter((read) => read.path === `/api/now/table/${table}`)).toHaveLength(0);
  expect(h.audits.at(-1)).toMatchObject({ outcome: "handler_error", reason: "field_types_unavailable" });
}

describe("each chain gap, on the dispatcher", () => {
  const chainText = (clause: string, remedy: string) =>
    `Field types for "u_vault_child" could not be confirmed: ${clause}. No values were returned. ${remedy}`;
  const gaps: Array<{ label: string; fixture: FieldTypeFixture; text: string }> = [
    {
      label: "a parent whose name did not come back",
      fixture: { ...BASE, hiddenRows: ["u_vault"] },
      text: chainText("the parent table of \"u_vault_child\" could not be read (the instance did not return its name to the integration user)", GRANT_CHAIN),
    },
    {
      label: "a row with no parent link",
      fixture: { ...BASE, withoutParentLinks: ["u_vault_child"] },
      text: chainText('the sys_db_object row of "u_vault_child" does not name a valid parent', ALONE),
    },
    {
      label: "a chain longer than 12 tables",
      fixture: { ...BASE, parents: { u_vault_child: [...LEVELS, "u_vault"] } },
      text: chainText("its table hierarchy is more than 12 tables deep", ALONE),
    },
  ];
  for (const { label, fixture, text } of gaps) {
    it(`for ${label}: the gap, no values, no read of the table, and a handler error in the audit`, async () => {
      const h = await harness({ fixture });
      for (const tool of [
        ["sn_query", CHILD],
        ["sn_get", { table: "u_vault_child", sys_id: SYS_ID, fields: "name" }],
      ] as const) {
        expectRefusal(h, await h.call(tool[0], tool[1]), "u_vault_child", text);
      }
    });
  }

  it("names a gap by where it is, not by a table the caller did not ask about", async () => {
    // The parent table u_vault was never asked for, and its name is not in a text that is not about it.
    const h = await harness({ fixture: { ...BASE, withoutParentLinks: ["u_vault_child"] } });
    const result = await h.call("sn_query", CHILD);
    expect(result.text).not.toContain('"u_vault"');
  });
});

describe("other classes of failure, on the dispatcher", () => {
  const cases: Array<{ label: string; failure: Error; text: string }> = [
    {
      label: "a hibernating instance (not retried)",
      failure: createInstanceHibernatingError("field-types-gaps.service-now.com"),
      text: "Field types are temporarily unavailable: the sys_dictionary request could not reach the instance. No values were returned. Retry the call.",
    },
    {
      label: "an HTML page where JSON was due",
      failure: createHtmlResponseError(),
      text: "Field types could not be read: the sys_dictionary read failed. No values were returned.",
    },
    {
      label: "a body that is not JSON",
      failure: createInvalidResponseError(),
      text: "Field types could not be read: the sys_dictionary read failed. No values were returned.",
    },
    {
      label: "a redirect",
      failure: createRedirectedError(),
      text: "Field types could not be read: the sys_dictionary read failed. No values were returned.",
    },
    {
      label: "a 404",
      failure: http(404),
      text: "Field types could not be read: the sys_dictionary read failed (HTTP 404). No values were returned.",
    },
    {
      label: "a 599",
      failure: http(599),
      text: "the sys_dictionary request returned HTTP 599 after retrying. No values were returned. Retry the call.",
    },
    {
      label: "an error nothing here issued",
      failure: Object.assign(new Error("Forbidden: password=hunter2"), { status: 403, category: "authorization" }),
      text: "Field types could not be read: the sys_dictionary read failed. No values were returned.",
    },
  ];
  for (const { label, failure, text } of cases) {
    it(`for ${label}: the cause, in no other words than the fixed ones`, async () => {
      const h = await harness({ dictionary: [failure] });
      const result = await h.call("sn_query", QUERY);
      expectRefusal(h, result, "u_vault", text);
      expect(result.text).not.toContain("hunter2");
    });
  }

  it("does not retry a hibernating instance, an HTML page or a redirect", async () => {
    for (const failure of [createInstanceHibernatingError(), createHtmlResponseError(), createRedirectedError(), createInvalidResponseError()]) {
      const h = await harness({ dictionary: [failure, "ok"] });
      await h.call("sn_query", QUERY);
      expect(h.count("sys_dictionary")).toBe(1);
    }
  });
});

describe("the sys_db_object retry", () => {
  it("makes no second read for a 429, a 4xx or a refusal", async () => {
    for (const failure of [http(429), http(400), http(404), http(401), http(403)]) {
      const h = await harness({ chains: [failure, "ok"] });
      const result = await h.call("sn_query", QUERY);
      expect(result.isError).toBe(true);
      expect(h.count("sys_db_object")).toBe(1);
    }
  });

  it("makes one extra read of sys_db_object for a timeout or a 500, and uses the answer", async () => {
    for (const failure of [timeout(), http(500)]) {
      const h = await harness({ chains: [failure, "ok"] });
      const result = await h.call("sn_query", QUERY);
      expect(result.isError, result.text).toBe(false);
      expect(h.count("sys_db_object")).toBe(2);
    }
  });

  it("shares one retry between the tables' read and a view's joined-table read", async () => {
    // First read of [u_vault_view] fails once and is retried; the joined read of [u_vault] fails too, and is not retried again.
    const h = await harness({ fixture: { ...BASE, absent: absentViews }, chains: [http(500), "ok", http(500)] });
    const result = await h.call("sn_query", { table: "u_vault_view", fields: "name" });
    expect(result.isError).toBe(true);
    expect(h.count("sys_db_object")).toBe(3);
    expect(result.text).not.toContain("Access denied by policy");
    expect(result.text).toContain("HTTP 500");
    expect(result.text).not.toContain(SECRET);
    expect(h.reads.filter((read) => read.path === "/api/now/table/u_vault_view")).toHaveLength(0);
  });

  it("does not retry the view lookup, and says which read failed", async () => {
    const h = await harness({ fixture: { ...BASE, absent: [...absentViews] }, views: [http(503), "ok"] });
    const result = await h.call("sn_query", { table: "u_vault_view", fields: "name" });
    expect(h.count("sys_db_view_table")).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("Access denied by policy");
    expect(result.text).toContain("sys_db_view_table");
    expect(h.audits.at(-1)).toMatchObject({ outcome: "handler_error", reason: "field_types_unavailable" });
  });

  it("resolves a database view, with the one chain read of its joined table", async () => {
    const h = await harness({ fixture: { ...BASE, absent: absentViews } });
    const result = await h.call("sn_query", { table: "u_vault_view", fields: "name" });
    expect(result.isError, result.text).toBe(false);
    expect(h.count("sys_db_object")).toBe(2);
    expect(h.count("sys_db_view_table")).toBe(1);
  });
});

describe("what is remembered, beyond the dictionary", () => {
  it("does not remember a blip on sys_db_object: the next call reads it again", async () => {
    const h = await harness({ chains: [http(500), http(500), "ok"] });
    expect((await h.call("sn_query", QUERY)).isError).toBe(true);
    expect(h.count("sys_db_object")).toBe(2);
    const second = await h.call("sn_query", QUERY);
    expect(second.isError, second.text).toBe(false);
    expect(h.count("sys_db_object")).toBe(3);
  });

  it("does not remember a 429, a 404 or a refused sys_db_object read", async () => {
    for (const failure of [http(429), http(404), http(403)]) {
      const h = await harness({ chains: [failure, "ok"] });
      expect((await h.call("sn_query", QUERY)).isError).toBe(true);
      const again = await h.call("sn_query", QUERY);
      expect(again.isError, again.text).toBe(false);
      expect(h.count("sys_db_object")).toBe(2);
    }
  });

  it("does not remember a 429 or a hibernating instance on the dictionary", async () => {
    for (const failure of [http(429), createInstanceHibernatingError()]) {
      const h = await harness({ dictionary: [failure, "ok"] });
      expect((await h.call("sn_query", QUERY)).isError).toBe(true);
      expect((await h.call("sn_query", QUERY)).isError).toBe(false);
      expect(h.count("sys_dictionary")).toBe(2);
    }
  });

  it("does not remember that a table does not exist", async () => {
    const h = await harness();
    const ghost = { table: "u_ghost", fields: "name" };
    await h.call("sn_query", ghost);
    const before = h.count("sys_db_object");
    const again = await h.call("sn_query", ghost);
    expect(again.text).toContain('Table "u_ghost" does not exist');
    expect(h.count("sys_db_object")).toBe(before + 1);
  });

  it("does not remember a failed view lookup", async () => {
    const h = await harness({ fixture: { ...BASE, absent: absentViews }, views: [http(503), "ok"] });
    const view = { table: "u_vault_view", fields: "name" };
    expect((await h.call("sn_query", view)).isError).toBe(true);
    const again = await h.call("sn_query", view);
    expect(again.isError, again.text).toBe(false);
    expect(h.count("sys_db_view_table")).toBe(2);
  });

  describe("a full dictionary page, 30 seconds, with its cause", () => {
    const fullPage = {
      rows: Array.from({ length: MAX_HIDDEN_DICTIONARY_ROWS }, (_, n) => ({ name: "u_vault", element: `f${n}`, internal_type: "password" })),
    };
    const expected = "Field types could not be read in full: sys_dictionary has more password-type fields than one read returns";

    it("is read once in the window, names its cause on a memo hit, and is read again after it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
      const h = await harness({ dictionary: [fullPage, "ok"] });
      for (let call = 0; call < 3; call += 1) {
        const result = await h.call("sn_query", QUERY);
        expect(result.isError).toBe(true);
        expect(result.text).toContain(expected);
        expect(result.text).not.toContain("Access denied by policy");
      }
      expect(h.count("sys_dictionary")).toBe(1);
      vi.setSystemTime(new Date("2026-11-24T12:00:31Z"));
      expect((await h.call("sn_query", QUERY)).isError).toBe(false);
      expect(h.count("sys_dictionary")).toBe(2);
    });
  });

  describe("an incomplete chain, 30 seconds, with its cause", () => {
    it("names the gap on a memo hit, and reads again after the window", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
      const h = await harness({ fixture: { ...BASE, hiddenRows: ["u_vault"] } });
      const clause = "the parent table of \"u_vault_child\" could not be read";
      for (let call = 0; call < 3; call += 1) expect((await h.call("sn_query", CHILD)).text).toContain(clause);
      expect(h.count("sys_db_object")).toBe(1);
      // Another tool, another table of the same chain: the memo answers without a read.
      expect((await h.call("sn_get", { table: "u_vault_child", sys_id: SYS_ID, fields: "name" })).text).toContain(clause);
      expect(h.count("sys_db_object")).toBe(1);
      vi.setSystemTime(new Date("2026-11-24T12:00:31Z"));
      expect((await h.call("sn_query", CHILD)).text).toContain(clause);
      expect(h.count("sys_db_object")).toBe(2);
    });

    it("is refused with the same values withheld on the memo hit as on the first read", async () => {
      const h = await harness({ fixture: { ...BASE, hiddenRows: ["u_vault"] } });
      for (let call = 0; call < 2; call += 1) {
        const result = await h.call("sn_query", CHILD);
        expectRefusal(h, result, "u_vault_child", "could not be confirmed");
      }
    });
  });

  describe("a success, for the hour", () => {
    it("is read once in 59 minutes and again after 61", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
      const h = await harness();
      expect((await h.call("sn_query", QUERY)).isError).toBe(false);
      expect(h.count("sys_dictionary")).toBe(1);
      expect(h.count("sys_db_object")).toBe(1);
      vi.setSystemTime(new Date("2026-11-24T12:59:00Z"));
      expect((await h.call("sn_query", QUERY)).isError).toBe(false);
      expect(h.count("sys_dictionary")).toBe(1);
      expect(h.count("sys_db_object")).toBe(1);
      vi.setSystemTime(new Date("2026-11-24T13:01:00Z"));
      expect((await h.call("sn_query", QUERY)).isError).toBe(false);
      expect(h.count("sys_dictionary")).toBe(2);
      expect(h.count("sys_db_object")).toBe(2);
    });
  });
});

describe("the opt-in is the only fallback, and is unchanged for every cause", () => {
  const causes: Array<[string, Options]> = [
    ["a full page", { dictionary: [{ rows: Array.from({ length: MAX_HIDDEN_DICTIONARY_ROWS }, (_, n) => ({ name: "u_vault", element: `f${n}`, internal_type: "password" })) }] }],
    ["a timeout", { dictionary: [timeout()] }],
    ["a hibernating instance", { dictionary: [createInstanceHibernatingError()] }],
    ["an HTML page", { dictionary: [createHtmlResponseError()] }],
    ["a 429 on sys_db_object", { chains: [http(429)] }],
    ["a 403 on sys_db_object", { chains: [http(403)] }],
    ["an incomplete chain", { fixture: { ...BASE, hiddenRows: ["u_vault"] } }],
    ["a chain with no parent link", { fixture: { ...BASE, withoutParentLinks: ["u_vault_child"] } }],
    ["a chain too long", { fixture: { ...BASE, parents: { u_vault_child: [...LEVELS, "u_vault"] } } }],
    ["a failed view lookup", { fixture: { ...BASE, absent: absentViews }, views: [http(503)] }],
  ];
  for (const [label, options] of causes) {
    it(`hides by name only, warns, and never refuses, for ${label}`, async () => {
      const h = await harness({ ...options, dictionaryMode: "not_required" });
      const table = label === "a failed view lookup" ? "u_vault_view" : label.includes("chain") && !label.includes("sys_db_object") ? "u_vault_child" : "u_vault";
      const result = await h.call("sn_query", { table, fields: "name" });
      expect(result.isError, result.text).toBe(false);
      expect(h.warnings).toContain("field_types.names_only");
      expect(result.text).not.toContain("Access denied by policy");
      expect(h.audits.at(-1)?.outcome).not.toBe("handler_error");
      // Names-only hiding is what is left: a field with a credential's name is still refused, by that rule.
      const named = await h.call("sn_query", { table, fields: "name,user_password" });
      expect(named.isError).toBe(true);
      expect(named.text).toContain("denied by name as sensitive");
      expect(named.text).not.toContain(SECRET);
    });
  }

  it("makes the same reads as the required profile would, once, for a refusal", async () => {
    const required = await harness({ dictionary: [http(403)] });
    const optional = await harness({ dictionary: [http(403)], dictionaryMode: "not_required" });
    await required.call("sn_query", QUERY);
    await optional.call("sn_query", QUERY);
    expect(optional.count("sys_dictionary")).toBe(required.count("sys_dictionary"));
  });
});

describe("metadata.timing.field_types_ms, beyond the lookup", () => {
  const timingOf = (result: { structured: unknown }) =>
    ((result.structured as { metadata?: { timing?: Record<string, number> } }).metadata?.timing ?? {}) as Record<string, number>;

  it("is present on a memo hit, with no lookup read behind it", async () => {
    const h = await harness();
    await h.call("sn_query", QUERY);
    const before = h.reads.length;
    const timing = timingOf(await h.call("sn_query", QUERY));
    expect(Number.isInteger(timing.field_types_ms)).toBe(true);
    expect(timing.field_types_ms).toBeLessThanOrEqual(timing.total_ms!);
    expect(h.reads.slice(before).filter((read) => /sys_dictionary|sys_db_object/u.test(read.path))).toHaveLength(0);
  });
});
