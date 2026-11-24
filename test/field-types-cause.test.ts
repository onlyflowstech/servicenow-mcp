/**
 * The dispatcher says why field types could not be read, and what it does
 * about it: one retry of a blip, a refusal worded from its cause, an audit
 * outcome that is a policy rejection only for a policy cause, and nothing
 * remembered that a retry could change. Values stay withheld in every case.
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
  return {
    ...actual,
    pauseUnlessServiceNowRequestCancelled: async (_ms: number, signal?: AbortSignal) => {
      void signal;
    },
  };
});

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies, ToolAuditRecord } from "../src/execution-context.js";
import { fieldPolicyDenialMessage, FieldPolicyError } from "../src/field-policy.js";
import { FIELD_TYPES_UNAVAILABLE_MESSAGE, MAX_HIDDEN_DICTIONARY_ROWS } from "../src/hidden-values.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { createToolError, recordTrustedHttpStatus, type ToolErrorCategory } from "../src/tool-error.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import type { ToolModuleLogger } from "../src/tools/tool-module.js";
import { echoFields } from "./fixtures/echo-fields.js";
import { fieldTypeAnswer, type FieldTypeFixture } from "./fixtures/field-types.js";

const SECRET = "SECRET-MARKER-9c1d";
const SYS_ID = "b".repeat(32);

const FIXTURE: FieldTypeFixture = {
  dictionary: [
    { name: "u_vault", element: "key", internal_type: "password2" },
    { name: "sys_user", element: "user_password", internal_type: "password" },
  ],
  parents: {},
  absent: ["u_ghost"],
  views: {},
};

const OPT_OUT = 'set "fieldTypes": { "dictionary": "not_required" } on this profile to hide fields by name only.';
const GRANT = `Grant the integration user read access to sys_dictionary and sys_db_object, or ${OPT_OUT}`;

/** An error as the client issues it for an HTTP status. */
function http(status: number): Error {
  const category: ToolErrorCategory =
    status === 401 ? "authentication" : status === 403 ? "authorization" : status === 429 ? "rate_limit" : "upstream";
  const retry = status === 429 ? "retry_later" : status === 401 || status === 403 ? "retry_after_correction" : "do_not_retry";
  return recordTrustedHttpStatus(createToolError(category, retry), status);
}
const timeout = () => createToolError("timeout", "retry_if_safe_and_idempotent");
const network = () => createToolError("upstream", "retry_if_safe_and_idempotent");

/** One scripted answer to a metadata read: the fixture's, an error to throw, or rows to return. */
type Step = "ok" | Error | { readonly rows: readonly unknown[] } | { readonly status: number };

interface Options {
  readonly fixture?: FieldTypeFixture;
  /** Steps for the sys_dictionary reads, in order; the last repeats. */
  readonly dictionary?: readonly Step[];
  /** Steps for the sys_db_object reads, in order; the last repeats. */
  readonly chains?: readonly Step[];
  readonly dictionaryMode?: "required" | "not_required";
  /** Holds every lookup read open this long (before it answers or fails). */
  readonly lookupDelayMs?: number;
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
  for (const close of open.splice(0)) await close();
});

async function harness(options: Options = {}): Promise<Harness> {
  counter += 1;
  const config: ServiceNowConfig = {
    instance: `https://field-types-cause-${counter}.service-now.com`,
    user: "field-types-user",
    password: "unused-test-placeholder",
    displayValue: "true",
    relDepth: 3,
    metadataCache: { smallReadBytes: 0 },
  };
  const reads: Harness["reads"] = [];
  const audits: ToolAuditRecord[] = [];
  const warnings: string[] = [];
  const fixture = options.fixture ?? FIXTURE;
  const seen = { sys_dictionary: 0, sys_db_object: 0 };
  const step = (steps: readonly Step[] | undefined, index: number): Step =>
    steps === undefined || steps.length === 0 ? "ok" : steps[Math.min(index, steps.length - 1)]!;

  const getWithMeta = vi.fn(async (path: string, params: Record<string, string> = {}) => {
    reads.push({ path, params });
    const table = /\/api\/now\/table\/(sys_dictionary|sys_db_object)$/u.exec(path)?.[1] as keyof typeof seen | undefined;
    if (table !== undefined && fieldTypeAnswer(path, params, fixture) !== undefined) {
      if (options.lookupDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.lookupDelayMs));
      const outcome = step(table === "sys_dictionary" ? options.dictionary : options.chains, seen[table]);
      seen[table] += 1;
      if (outcome instanceof Error) throw outcome;
      if (outcome !== "ok" && "rows" in outcome) {
        return { data: { result: outcome.rows }, status: 200, headers: new Headers() };
      }
      if (outcome !== "ok" && "status" in outcome) {
        return { data: { result: [] }, status: outcome.status, headers: new Headers() };
      }
    }
    const typed = fieldTypeAnswer(path, params, fixture);
    if (typed) return typed;
    const row = { sys_id: SYS_ID, name: "vault-one", key: SECRET };
    const single = /^\/api\/now\/table\/[a-z_]+\/[0-9a-f]{32}$/u.test(path);
    return {
      data: { result: single ? echoFields(row, params) : [echoFields(row, params)] },
      status: 200,
      headers: new Headers(),
    };
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
      credential: "env:FIELD_TYPES_CAUSE_SECRET_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => config),
    getClient: vi.fn(() => serviceNowClient),
  } as unknown as ProfileManager;
  const tables = ["u_vault", "u_ghost", "incident"];
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
        correlationId: `cause-${String(requestId)}`,
        identity: { ownerId: "owner", clientId: "client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "cause",
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
  const client = new Client({ name: "cause-client", version: "1.0.0" });
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
const refusedWith = (result: { text: string; isError: boolean }, expected: string) => {
  expect(result.isError, result.text).toBe(true);
  expect(result.text).toContain(expected);
  expect(result.text).not.toContain("Access denied by policy");
  expect(result.text).not.toContain(SECRET);
};
const lastAudit = (h: Harness) => h.audits.at(-1)!;

describe("a refusal says why, and is not a policy denial", () => {
  const cases: Array<{ label: string; options: Options; text: string; category?: string }> = [
    {
      label: "a 403 on sys_dictionary",
      options: { dictionary: [http(403)] },
      text: `Field types could not be read: the instance refused the sys_dictionary read (HTTP 403), so password-type fields can't be told apart and no values are returned. ${GRANT}`,
    },
    {
      label: "a 401 on sys_dictionary",
      options: { dictionary: [http(401)] },
      text: "the instance refused the sys_dictionary read (HTTP 401)",
    },
    {
      label: "a 200 with no sys_dictionary rows",
      options: { dictionary: [{ rows: [] }] },
      text: "the instance returned no sys_dictionary rows to the integration user (HTTP 200)",
    },
    {
      label: "a full page of sys_dictionary rows",
      options: {
        dictionary: [{ rows: Array.from({ length: MAX_HIDDEN_DICTIONARY_ROWS }, (_, n) => ({ name: "u_vault", element: `f${n}`, internal_type: "password" })) }],
      },
      text: "Field types could not be read in full: sys_dictionary has more password-type fields than one read returns, so no values are returned.",
    },
    {
      label: "a 400 on sys_dictionary",
      options: { dictionary: [http(400)] },
      text: "Field types could not be read: the sys_dictionary read failed (HTTP 400). No values were returned.",
    },
    {
      label: "a 500 that the retry did not recover",
      options: { dictionary: [http(500)] },
      text: "Field types are temporarily unavailable: the sys_dictionary request returned HTTP 500 after retrying. No values were returned. Retry the call.",
    },
    {
      label: "a 503 that the retry did not recover",
      options: { dictionary: [http(503)] },
      text: "the sys_dictionary request returned HTTP 503 after retrying. No values were returned. Retry the call.",
    },
    {
      label: "a timeout that the retry did not recover",
      options: { dictionary: [timeout()] },
      text: "Field types are temporarily unavailable: the sys_dictionary request timed out after retrying. No values were returned. Retry the call.",
    },
    {
      label: "a network failure that the retry did not recover",
      options: { dictionary: [network()] },
      text: "the sys_dictionary request could not reach the instance after retrying. No values were returned. Retry the call.",
    },
    {
      label: "a 429 (not retried here)",
      options: { dictionary: [http(429)] },
      text: "Field types are temporarily unavailable: the sys_dictionary request returned HTTP 429. No values were returned. Retry the call.",
    },
    {
      label: "a 403 on sys_db_object",
      options: { chains: [http(403)] },
      text: `Field types could not be read: the instance refused the sys_db_object read (HTTP 403), so password-type fields can't be told apart and no values are returned. Grant the integration user read access to sys_dictionary and sys_db_object, or ${OPT_OUT}`,
    },
    {
      label: "a sys_db_object read that showed no rows at all, its own included",
      options: { fixture: { ...FIXTURE, absent: ["u_vault", "sys_db_object"] } },
      text: "Field types could not be read: the instance returned no sys_db_object rows to the integration user (HTTP 200), so password-type fields can't be told apart and no values are returned.",
    },
    {
      label: "a 503 on sys_db_object that the retry did not recover",
      options: { chains: [http(503)] },
      text: "Field types are temporarily unavailable: the sys_db_object request returned HTTP 503 after retrying. No values were returned. Retry the call.",
    },
  ];

  for (const { label, options, text } of cases) {
    it(`for ${label}: no values, the cause, and a handler error in the audit`, async () => {
      const h = await harness(options);
      const result = await h.call("sn_query", QUERY);
      refusedWith(result, text);
      // No record was read.
      expect(h.reads.filter((read) => read.path === "/api/now/table/u_vault")).toHaveLength(0);
      expect(lastAudit(h)).toMatchObject({ outcome: "handler_error", reason: "field_types_unavailable" });
    });
  }

  it("for a table that does not exist: says so, when the instance showed sys_db_object's rows", async () => {
    const h = await harness();
    const result = await h.call("sn_query", { table: "u_ghost", fields: "name" });
    refusedWith(result, 'Table "u_ghost" does not exist on this instance: sys_db_object has no row for it. Check the table name.');
    expect(h.reads.filter((read) => read.path === "/api/now/table/u_ghost")).toHaveLength(0);
    expect(lastAudit(h)).toMatchObject({ outcome: "handler_error", reason: "field_types_unavailable" });
  });

  it("names the dictionary's failure, not a missing table, when the dictionary could not be read at all", async () => {
    // Without the dictionary nothing resolves; whether a table is there is not asked (a view lookup would cost another read).
    const h = await harness({ dictionary: [http(403)] });
    const result = await h.call("sn_query", { table: "u_ghost", fields: "name" });
    refusedWith(result, "the instance refused the sys_dictionary read (HTTP 403)");
  });

  it("falls back to the cause-less sentence, which is not a policy denial either", () => {
    expect(FIELD_TYPES_UNAVAILABLE_MESSAGE).toBe("Field types could not be read from the instance, so no values are returned.");
  });

  it("keeps 'Access denied by policy' for a table outside the call's plan", () => {
    const text = fieldPolicyDenialMessage(new FieldPolicyError("field_types_unavailable", { table: "u_ghost" }));
    expect(text).toBe("Access denied by policy: \"u_ghost\" is not part of this call's plan, so its field types were not read.");
    expect(fieldPolicyDenialMessage(new FieldPolicyError("field_types_unavailable"))).toBe(
      "Access denied by policy: a requested table is not part of this call's plan, so its field types were not read."
    );
    // A table name that is not one is never echoed.
    expect(fieldPolicyDenialMessage(new FieldPolicyError("field_types_unavailable", { table: "x\"; drop" }))).not.toContain("drop");
  });
});

describe("one retry of a blip", () => {
  it("recovers a timeout and a 500 on the dictionary, with one extra read", async () => {
    for (const failure of [timeout(), http(500), http(501), http(505)]) {
      const h = await harness({ dictionary: [failure, "ok"] });
      const result = await h.call("sn_query", QUERY);
      expect(result.isError, result.text).toBe(false);
      expect(h.count("sys_dictionary")).toBe(2);
      expect(h.count("sys_db_object")).toBe(1);
      expect(result.text).not.toContain(SECRET);
    }
  });

  it("leaves a 502, 503, 504 and a network failure to the client: no extra read here, and the text says they were retried", async () => {
    for (const failure of [http(502), http(503), http(504), network()]) {
      const h = await harness({ dictionary: [failure, "ok"] });
      const result = await h.call("sn_query", QUERY);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("after retrying");
      expect(h.count("sys_dictionary")).toBe(1);
    }
  });

  it("recovers a blip on sys_db_object with one extra read, shared by every table the lookup reads", async () => {
    const h = await harness({ chains: [http(500), "ok"] });
    const result = await h.call("sn_query", QUERY);
    expect(result.isError, result.text).toBe(false);
    expect(h.count("sys_db_object")).toBe(2);
    expect(h.count("sys_dictionary")).toBe(1);
  });

  it("makes at most one extra read of a kind, and none for a 429, a 4xx or a refusal", async () => {
    const twice = await harness({ dictionary: [http(500)] });
    await twice.call("sn_query", QUERY);
    expect(twice.count("sys_dictionary")).toBe(2);
    for (const failure of [http(429), http(400), http(401), http(403), http(502), http(503), http(504), network()]) {
      const h = await harness({ dictionary: [failure] });
      await h.call("sn_query", QUERY);
      expect(h.count("sys_dictionary")).toBe(1);
    }
  });
});

describe("what is remembered", () => {
  it("does not remember a blip: the next call reads again, and succeeds when the instance is back", async () => {
    const h = await harness({ dictionary: [http(500), http(500), "ok"] });
    const first = await h.call("sn_query", QUERY);
    expect(first.isError).toBe(true);
    expect(h.count("sys_dictionary")).toBe(2);
    const second = await h.call("sn_query", QUERY);
    expect(second.isError, second.text).toBe(false);
    expect(h.count("sys_dictionary")).toBe(3);
  });

  it("does not remember a failed read either (a 400)", async () => {
    const h = await harness({ dictionary: [http(400), "ok"] });
    expect((await h.call("sn_query", QUERY)).isError).toBe(true);
    expect((await h.call("sn_query", QUERY)).isError).toBe(false);
    expect(h.count("sys_dictionary")).toBe(2);
  });

  describe("a refusal and a full page, for 30 seconds, with the cause", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is read once within the window, names its cause on every call, and is read again after it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
      const h = await harness({ dictionary: [http(403), "ok"] });
      const expected = "the instance refused the sys_dictionary read (HTTP 403)";
      for (let call = 0; call < 3; call += 1) refusedWith(await h.call("sn_query", QUERY), expected);
      expect(h.count("sys_dictionary")).toBe(1);
      vi.setSystemTime(new Date("2026-11-24T12:00:29Z"));
      refusedWith(await h.call("sn_query", QUERY), expected);
      expect(h.count("sys_dictionary")).toBe(1);
      vi.setSystemTime(new Date("2026-11-24T12:00:31Z"));
      const again = await h.call("sn_query", QUERY);
      expect(again.isError, again.text).toBe(false);
      expect(h.count("sys_dictionary")).toBe(2);
    });

    it("remembers a 200 with no rows with its own cause", async () => {
      const h = await harness({ dictionary: [{ rows: [] }, "ok"] });
      for (let call = 0; call < 2; call += 1) {
        refusedWith(await h.call("sn_query", QUERY), "the instance returned no sys_dictionary rows to the integration user (HTTP 200)");
      }
      expect(h.count("sys_dictionary")).toBe(1);
    });
  });

  it("remembers a success for the hour: a later call makes no lookup read", async () => {
    const h = await harness();
    expect((await h.call("sn_query", QUERY)).isError).toBe(false);
    const before = h.reads.length;
    expect((await h.call("sn_query", QUERY)).isError).toBe(false);
    const lookups = h.reads.slice(before).filter((read) => /sys_dictionary|sys_db_object/u.test(read.path));
    expect(lookups).toHaveLength(0);
  });
});

describe("the opt-out is the only fallback, and is unchanged for every cause", () => {
  const causes: Array<[string, Options]> = [
    ["a refusal", { dictionary: [http(403)] }],
    ["a blip", { dictionary: [http(503)] }],
    ["a 400", { dictionary: [http(400)] }],
    ["no rows", { dictionary: [{ rows: [] }] }],
    ["a failed chain read", { chains: [http(500)] }],
  ];
  for (const [label, options] of causes) {
    it(`hides by name only, and warns, for ${label}`, async () => {
      const h = await harness({ ...options, dictionaryMode: "not_required" });
      const result = await h.call("sn_query", { table: "u_vault", fields: "name,key" });
      expect(result.isError, result.text).toBe(false);
      expect(h.warnings).toContain("field_types.names_only");
    });
  }

  it("does not refuse a table that does not exist either: names-only hiding, then the table read answers", async () => {
    const h = await harness({ dictionaryMode: "not_required" });
    const result = await h.call("sn_query", { table: "u_ghost", fields: "name" });
    expect(result.text).not.toContain("does not exist on this instance");
    expect(h.warnings).toContain("field_types.names_only");
  });
});

describe("metadata.timing.field_types_ms", () => {
  const timingOf = (result: { structured: unknown }) =>
    ((result.structured as { metadata?: { timing?: Record<string, number> } }).metadata?.timing ?? {}) as Record<string, number>;

  it("is present on a successful read, and the lookup's own reads are not in upstream_ms", async () => {
    const h = await harness();
    const result = await h.call("sn_query", QUERY);
    const timing = timingOf(result);
    expect(Number.isInteger(timing.field_types_ms)).toBe(true);
    expect(timing.field_types_ms).toBeGreaterThanOrEqual(0);
    expect(timing.field_types_ms).toBeLessThanOrEqual(timing.total_ms!);
  });

  it("covers the whole lookup, retry included, and not the tool's own read", async () => {
    // Each lookup read takes 30 ms; the dictionary's retry makes it two in a row.
    const h = await harness({ dictionary: [http(500), "ok"], lookupDelayMs: 30 });
    const timing = timingOf(await h.call("sn_query", QUERY));
    expect(h.count("sys_dictionary")).toBe(2);
    expect(timing.field_types_ms).toBeGreaterThanOrEqual(55);
    expect(timing.field_types_ms).toBeLessThanOrEqual(timing.total_ms!);
    expect(timing.upstream_ms).toBeLessThan(timing.field_types_ms!);
  });
});
