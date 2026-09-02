import { describe, expect, it, vi } from "vitest";

import { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import {
  authorizeRawEncodedRead,
  createEncodedQueryAccessPolicy,
  ENCODED_QUERY_MIGRATION_MESSAGE,
  ENCODED_QUERY_POLICY_ENV,
  EncodedQueryPolicyError,
  encodedQueryAccessPolicyFromEnvironment,
  MAX_ENCODED_QUERY_LENGTH,
  rejectRawEncodedWrite,
  SUPPORTED_ENCODED_QUERY_OPERATORS,
  type EncodedQueryReadRuleInput,
} from "../src/encoded-query-policy.js";
import { handler as batchHandler } from "../src/tools/batch.js";
import { handler as nlHandler, schema as nlSchema } from "../src/tools/nl.js";
import type { ExecutionContext } from "../src/execution-context.js";
import {
  handler as queryHandler,
  schema as querySchema,
} from "../src/tools/query.js";

const RULE: EncodedQueryReadRuleInput = Object.freeze({
  tool: "sn_query",
  table: "incident",
  maxLength: 512,
  maxTerms: 8,
  fields: Object.freeze([
    "active",
    "state",
    "priority",
    "opened_at",
    "short_description",
    "number",
    "assigned_to",
  ]),
  operators: SUPPORTED_ENCODED_QUERY_OPERATORS,
  maxLimit: 100,
  maxOffset: 1_000,
  maxResponseBytes: 100_000,
});

const CONFIG: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};

function policy(overrides: Partial<EncodedQueryReadRuleInput> = {}) {
  return createEncodedQueryAccessPolicy({ rules: [{ ...RULE, ...overrides }] });
}

function authorize(
  query: unknown,
  overrides: Partial<{
    tool: string;
    table: string;
    limit: unknown;
    offset: unknown;
    maxResponseBytes: unknown;
    orderBy: unknown;
    outputFields: unknown;
  }> = {},
  selectedPolicy = policy()
) {
  return authorizeRawEncodedRead(selectedPolicy, {
    tool: overrides.tool ?? "sn_query",
    table: overrides.table ?? "incident",
    query,
    limit: overrides.limit ?? 20,
    offset: overrides.offset ?? 0,
    maxResponseBytes: overrides.maxResponseBytes ?? 100_000,
    orderBy: overrides.orderBy,
    outputFields: overrides.outputFields ?? ["active"],
  });
}

function expectReason(operation: () => unknown, reason: EncodedQueryPolicyError["reason"]) {
  try {
    operation();
    throw new Error("expected encoded-query rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(EncodedQueryPolicyError);
    expect((error as EncodedQueryPolicyError).reason).toBe(reason);
    expect((error as Error).message).toBe(ENCODED_QUERY_MIGRATION_MESSAGE);
  }
}

describe("SNSDK-32 encoded-query policy construction", () => {
  it("issues a deeply immutable deny-all policy by default", () => {
    const denied = createEncodedQueryAccessPolicy();
    expect(denied).toEqual({ rules: [] });
    expect(Object.isFrozen(denied)).toBe(true);
    expect(Object.isFrozen(denied.rules)).toBe(true);
    expectReason(() => authorize("active=true", {}, denied), "read_not_approved");
  });

  it("canonicalizes and deeply freezes an explicit tool/table rule", () => {
    const approved = policy({ table: " INCIDENT " });
    expect(approved.rules[0]).toMatchObject({ tool: "sn_query", table: "incident" });
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.isFrozen(approved.rules)).toBe(true);
    expect(Object.isFrozen(approved.rules[0])).toBe(true);
    expect(Object.isFrozen(approved.rules[0].fields)).toBe(true);
    expect(Object.isFrozen(approved.rules[0].operators)).toBe(true);
  });

  it.each([
    { tool: "sn_aggregate" },
    { tool: "sn_batch" },
    // Formerly rejected because sys_user_password was hard-denied. Table
    // reachability is now a tableAccess question, so the shape check here is
    // exercised with a malformed identifier instead.
    { table: "Bad-Table" },
    { fields: ["password"] },
    { fields: [] },
    { operators: [] },
    { operators: ["DYNAMIC"] },
    { maxLength: 0 },
    { maxLength: MAX_ENCODED_QUERY_LENGTH + 1 },
    { maxTerms: 0 },
    { maxLimit: 0 },
    { maxOffset: -1 },
    { maxResponseBytes: 999 },
  ])("rejects invalid or unsafe rule fragment %#", (fragment) => {
    expect(() => policy(fragment as Partial<EncodedQueryReadRuleInput>)).toThrow(
      TypeError
    );
  });

  it("rejects duplicates and hostile policy shapes without evaluating accessors", () => {
    expect(() => createEncodedQueryAccessPolicy({ rules: [RULE, RULE] })).toThrow(
      TypeError
    );
    const getter = vi.fn(() => [RULE]);
    const accessor = Object.defineProperty({}, "rules", {
      enumerable: true,
      get: getter,
    });
    expect(() => createEncodedQueryAccessPolicy(accessor)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();

    const trap = vi.fn();
    const proxy = new Proxy({ rules: [RULE] }, { get: trap, ownKeys: trap });
    expect(() => createEncodedQueryAccessPolicy(proxy)).toThrow(TypeError);
    expect(trap).not.toHaveBeenCalled();

    expect(() =>
      createEncodedQueryAccessPolicy({
        rules: [{ ...RULE, transport: "stdio" } as never],
      })
    ).toThrow(TypeError);
  });

  it("loads only explicit bounded JSON from environment and otherwise denies all", () => {
    expect(encodedQueryAccessPolicyFromEnvironment({})).toEqual({ rules: [] });
    const loaded = encodedQueryAccessPolicyFromEnvironment({
      [ENCODED_QUERY_POLICY_ENV]: JSON.stringify({ rules: [RULE] }),
    });
    expect(authorize("active=true", {}, loaded)).toEqual({
      query: "active=true",
      outputFields: ["active"],
    });
    for (const raw of ["", "not json", "[]", "null"]) {
      expect(() =>
        encodedQueryAccessPolicyFromEnvironment({
          [ENCODED_QUERY_POLICY_ENV]: raw,
        })
      ).toThrow(TypeError);
    }
  });
});

describe("SNSDK-32 bounded encoded-read parser", () => {
  it.each([
    ["active=true", "="],
    ["state!=7", "!="],
    ["priority>1", ">"],
    ["priority>=1", ">="],
    ["priority<5", "<"],
    ["priority<=5", "<="],
    ["stateIN1,2", "IN"],
    ["stateNOT IN6,7", "NOT IN"],
    ["opened_atBETWEEN2026-01-01@2026-01-31", "BETWEEN"],
    ["short_descriptionLIKEdatabase", "LIKE"],
    ["short_descriptionNOT LIKEtest", "NOT LIKE"],
    ["numberSTARTSWITHINC", "STARTSWITH"],
    ["numberENDSWITH001", "ENDSWITH"],
    ["assigned_toISEMPTY", "ISEMPTY"],
    ["assigned_toISNOTEMPTY", "ISNOTEMPTY"],
  ])("accepts byte-identical approved %s syntax (%s)", (query) => {
    expect(authorize(query)).toEqual({
      query,
      outputFields: ["active"],
    });
  });

  it.each([
    "",
    " active=true",
    "active=true ",
    "active=true^",
    "^active=true",
    "active=true^^state=1",
    "active=true^ORpriority=1",
    "active=true^NQpriority=1",
    "active=true^ORDERBYpriority",
    "active=true^GROUPBYpriority",
    "active=true^EQ",
    "active=true^passwordISNOTEMPTY",
    "activeDYNAMIC90d1921e5f510100a9ad2572f2b477fe",
    "active=javascript:gs.getUserID()",
    "active==true",
    "assigned_toISEMPTYunexpected",
    "stateIN1,,2",
    "opened_atBETWEENlower@middle@upper",
    "active=ok\u0085bad",
    "active=ok\u200bbad",
    "active=ok\ud800bad",
    "active=true%5EORpriority=1",
    "active=true%5eORpriority=1",
    "active=true%255EORpriority=1",
    "active%3DEQtrue",
    "active%253dEQtrue",
    "opened_atBETWEENa%40b",
    "active=true%",
    "active=true%2",
    "active=true%GG",
  ])("rejects unsupported, injected, or malformed syntax %#", (query) => {
    expectReason(() => authorize(query), "invalid_query");
  });

  it("enforces tool/table, query, complexity, pagination, and output bounds", () => {
    expectReason(
      () => authorize("active=true", { tool: "sn_aggregate" }),
      "read_not_approved"
    );
    expectReason(
      () => authorize("active=true", { table: "problem" }),
      "read_not_approved"
    );
    expectReason(
      () => authorize("active=true", { limit: 101 }),
      "query_limit_exceeded"
    );
    expectReason(
      () => authorize("active=true", { offset: 1_001 }),
      "query_limit_exceeded"
    );
    expectReason(
      () => authorize("active=true", { maxResponseBytes: 100_001 }),
      "query_limit_exceeded"
    );
    expectReason(
      () => authorize("active=true", { orderBy: "password" }),
      "invalid_query"
    );
    expectReason(
      () => authorize("active=true", { outputFields: ["description"] }),
      "read_not_approved"
    );
    expectReason(
      () => authorize("active=true^stateIN1,2,3", {}, policy({ maxTerms: 3 })),
      "query_limit_exceeded"
    );
    expectReason(
      () => authorize("short_description=🚨", {}, policy({ maxLength: 20 })),
      "query_limit_exceeded"
    );
  });

  it("does not accept forged frozen policies", () => {
    const forged = Object.freeze({ rules: Object.freeze([RULE]) });
    expectReason(
      () => authorize("active=true", {}, forged as never),
      "read_not_approved"
    );
  });

  it("snapshots an exact non-empty output projection and rejects exotic lists", () => {
    const plan = authorize("active=true", { outputFields: [" ACTIVE "] });
    expect(plan.outputFields).toEqual(["active"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.outputFields)).toBe(true);

    const traps = { get: vi.fn(), ownKeys: vi.fn() };
    const proxy = new Proxy(["active"], traps);
    expectReason(
      () => authorize("active=true", { outputFields: proxy }),
      "invalid_query"
    );
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();

    const getter = vi.fn(() => "active");
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: getter,
    });
    Object.defineProperty(accessor, "length", { value: 1 });
    expectReason(
      () => authorize("active=true", { outputFields: accessor }),
      "invalid_query"
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    "active=true%5EORpriority=1",
    "active=true%255eORpriority=1",
    "active%3dEQtrue",
    "opened_atBETWEENa%2540javascript%253Ag.bad()",
  ])("rejects escaped syntax before a real client can build a URL: %s", async (query) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new ServiceNowClient(CONFIG);
    const selectedPolicy = policy({ fields: ["active", "opened_at"] });
    const context = {
      effectivePolicy: { encodedQueryAccess: selectedPolicy },
    } as ExecutionContext;
    await expect(
      queryHandler(
        querySchema.parse({ table: "incident", query, fields: "active" }),
        client,
        CONFIG,
        context
      )
    ).rejects.toThrow(ENCODED_QUERY_MIGRATION_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps representative maximum-complexity authorization sub-millisecond", () => {
    const selected = policy({ maxTerms: 32, maxLength: 512 });
    const query = Array.from({ length: 32 }, () => "active=true").join("^");
    const iterations = 1_000;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      authorize(query, {}, selected);
    }
    const averageMs = (performance.now() - started) / iterations;
    expect(averageMs).toBeLessThan(1);
  });
});

describe("SNSDK-32 encoded-write prohibition", () => {
  it("allows absence but rejects every supplied selector without echoing it", () => {
    expect(() => rejectRawEncodedWrite(undefined)).not.toThrow();
    const secret = "password=do-not-echo^ORtokenISNOTEMPTY";
    for (const candidate of [secret, "", null, false, { query: secret }]) {
      expectReason(
        () => rejectRawEncodedWrite(candidate),
        "encoded_write_prohibited"
      );
      try {
        rejectRawEncodedWrite(candidate);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  it("blocks a direct batch-handler raw selector before all client access", async () => {
    const get = vi.fn();
    const patch = vi.fn();
    const del = vi.fn();
    const client = { get, patch, delete: del } as unknown as ServiceNowClient;
    await expect(
      batchHandler(
        {
          table: "incident",
          query: "active=true^password=do-not-echo",
          action: "delete",
          limit: 200,
          confirm: true,
        } as never,
        client,
        CONFIG,
        undefined as never
      )
    ).rejects.toThrow(ENCODED_QUERY_MIGRATION_MESSAGE);
    expect(get).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("keeps natural-language bulk composition from selecting or mutating targets", async () => {
    const get = vi.fn();
    const patch = vi.fn();
    const del = vi.fn();
    const client = { get, patch, delete: del } as unknown as ServiceNowClient;
    const result = await nlHandler(
      nlSchema.parse({
        text: "bulk delete all active incidents",
        execute: true,
        confirm: true,
        force: true,
      }),
      client,
      CONFIG,
      undefined as never
    );
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { text: string }).text) as {
      executed: boolean;
      message: string;
    };
    expect(payload.executed).toBe(false);
    expect(payload.message).toContain("sn_batch");
    expect(payload.message).toContain("structured_query");
    expect(get).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
