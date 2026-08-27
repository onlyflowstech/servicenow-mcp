import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTableAccessPolicy } from "../src/table-policy.js";
import { createToolError } from "../src/tool-error.js";
import {
  SNSDK54_FAILURE_CANARIES,
  SNSDK54_PROFILE_NAME,
  SNSDK54_REFERENCE_TOOLS,
  SNSDK54_SYS_ID,
  createMockServiceNowFixture,
  createMockServiceNowHarness,
} from "./fixtures/mock-servicenow.js";

const openHarnesses: Array<
  Awaited<ReturnType<typeof createMockServiceNowHarness>>
> = [];

afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map(({ close }) => close()));
});

async function harness(
  options: Parameters<typeof createMockServiceNowHarness>[0] = {}
) {
  const connected = await createMockServiceNowHarness(options);
  openHarnesses.push(connected);
  return connected;
}

function serializedPublicEvidence(
  result: Awaited<ReturnType<typeof callTool>>,
  audits: readonly unknown[]
): string {
  return JSON.stringify({ result, audits });
}

async function callTool(
  connected: Awaited<ReturnType<typeof createMockServiceNowHarness>>,
  name: string,
  arguments_: Record<string, unknown>
) {
  return connected.client.callTool({ name, arguments: arguments_ });
}

describe("SNSDK-54 reusable mocked ServiceNow fixture", () => {
  it("documents reuse rules, the reference matrix, and the mocked/live boundary", () => {
    const documentation = readFileSync(
      new URL("../docs/MOCKED-SERVICENOW-TESTING.md", import.meta.url),
      "utf8"
    );

    expect(documentation).toContain("createMockServiceNowFixture");
    expect(documentation).toContain("createMockServiceNowHarness");
    expect(documentation).toContain("assertConsumed()");
    for (const name of SNSDK54_REFERENCE_TOOLS) {
      expect(documentation, name).toContain(name);
    }
    expect(documentation).toMatch(/does \*\*not\*\* prove network reachability/u);
    expect(documentation).toMatch(/disposable authorized instance/u);
  });

  it("records immutable exact calls and fails deterministically on exhaustion", async () => {
    const body = { state: "2", nested: { safe: true } };
    const fixture = createMockServiceNowFixture([
      { operation: "patch", response: { result: { sys_id: SNSDK54_SYS_ID } } },
    ]);

    await fixture.operations.patch(
      `/api/now/table/incident/${SNSDK54_SYS_ID}`,
      body
    );
    body.state = "3";

    expect(fixture.calls).toEqual([
      {
        operation: "patch",
        path: `/api/now/table/incident/${SNSDK54_SYS_ID}`,
        body: { state: "2", nested: { safe: true } },
      },
    ]);
    expect(Object.isFrozen(fixture.calls)).toBe(true);
    expect(Object.isFrozen(fixture.calls[0])).toBe(true);
    expect(Object.isFrozen(fixture.calls[0]?.body)).toBe(true);
    expect(fixture.pendingCount()).toBe(0);
    fixture.assertConsumed();

    await expect(
      fixture.operations.get("/api/now/table/incident")
    ).rejects.toThrow("Mock ServiceNow fixture was exhausted");
  });

  it("records an own __proto__ field without mutating the ledger prototype", async () => {
    const path = "/api/now/table/incident/prototype-test";
    const body = JSON.parse(
      '{"state":"2","__proto__":{"polluted":true}}'
    ) as Record<string, unknown>;
    const protoValue = body["__proto__"] as { polluted: boolean };
    const fixture = createMockServiceNowFixture([
      { operation: "patch", response: { result: {} } },
    ]);

    await expect(fixture.operations.patch(path, body)).resolves.toEqual({ result: {} });
    protoValue.polluted = false;

    const calls = fixture.calls;
    const capturedBody = calls[0]?.body as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation).toBe("patch");
    expect(calls[0]?.path).toBe(path);
    expect(Reflect.ownKeys(capturedBody)).toEqual(["state", "__proto__"]);
    expect(Object.hasOwn(capturedBody, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(capturedBody)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(capturedBody, "__proto__")).toMatchObject({
      value: { polluted: true },
      enumerable: true,
      configurable: false,
      writable: false,
    });
    expect(Object.isFrozen(calls)).toBe(true);
    expect(Object.isFrozen(calls[0])).toBe(true);
    expect(Object.isFrozen(capturedBody)).toBe(true);
    expect(Object.isFrozen(capturedBody.__proto__)).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    fixture.assertConsumed();
  });

  it("rejects mismatches, proxies, and accessors without invoking traps", async () => {
    const mismatch = createMockServiceNowFixture([
      { operation: "get", response: { result: [] } },
    ]);
    await expect(
      mismatch.operations.patch("/api/now/table/incident", {})
    ).rejects.toThrow("expected get; received patch");

    const trap = vi.fn(() => {
      throw new Error("fixture-trap-must-not-run");
    });
    const proxyBody = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap });
    const accessorBody = Object.defineProperty({}, "token", {
      enumerable: true,
      get: trap,
    });
    const proxyFixture = createMockServiceNowFixture([
      { operation: "patch", response: { result: {} } },
    ]);
    const accessorFixture = createMockServiceNowFixture([
      { operation: "patch", response: { result: {} } },
    ]);
    const binaryFixture = createMockServiceNowFixture([
      { operation: "postBinary", response: { result: {} } },
    ]);
    const binaryProxy = new Proxy(Buffer.from("binary"), {
      get: trap,
      getPrototypeOf: trap,
    });

    await expect(
      proxyFixture.operations.patch("/api/now/table/incident", proxyBody)
    ).rejects.toThrow("must not contain proxies");
    await expect(
      accessorFixture.operations.patch("/api/now/table/incident", accessorBody)
    ).rejects.toThrow("enumerable data properties");
    await expect(
      binaryFixture.operations.postBinary(
        "/api/now/attachment/file",
        binaryProxy,
        "application/octet-stream"
      )
    ).rejects.toThrow("must not contain proxies");
    expect(trap).not.toHaveBeenCalled();
    expect(proxyFixture.pendingCount()).toBe(1);
    expect(accessorFixture.pendingCount()).toBe(1);
    expect(binaryFixture.pendingCount()).toBe(1);

    const proxyStep = new Proxy(
      { operation: "get", response: null } as const,
      { getPrototypeOf: trap, ownKeys: trap }
    );
    expect(() => createMockServiceNowFixture([proxyStep])).toThrow(
      "step must be a plain object"
    );
    expect(trap).not.toHaveBeenCalled();
  });
});

describe("SNSDK-54 reference tool behavior matrix", () => {
  it("discovers exact schemas and explicit annotations for every reference tool", async () => {
    const connected = await harness();
    const discovery = await connected.client.listTools();
    const expectedAnnotations = {
      sn_query: {
        title: "Query records",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      sn_get: {
        title: "Get record",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      sn_create: {
        title: "Create record",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      sn_update: {
        title: "Update record",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      sn_incident_add_comment: {
        title: "Add incident comment",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      sn_incident_add_work_note: {
        title: "Add incident work note",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    } as const;

    for (const name of SNSDK54_REFERENCE_TOOLS) {
      const tool = discovery.tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations, name).toEqual(expectedAnnotations[name]);
      expect(tool?.inputSchema, name).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: expect.arrayContaining(["profile"]),
        properties: { profile: { type: "string" } },
      });
      expect(tool?.outputSchema, name).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: expect.arrayContaining(["profile", "data", "metadata"]),
        properties: {
          profile: { type: "string" },
          data: { type: "object" },
          metadata: { type: "object" },
        },
      });
    }
    expect(connected.managerCalls).toEqual({ profile: [], config: [], client: [] });
    expect(connected.fixture.calls).toEqual([]);
  });

  it("covers sn_query success and empty results with exact calls and filtering", async () => {
    const connected = await harness({
      steps: [
        {
          operation: "getWithMeta",
          response: {
            data: {
              result: [
                {
                  sys_id: SNSDK54_SYS_ID,
                  number: "INC0010054",
                  short_description: {
                    value: "Database unavailable",
                    access_token: SNSDK54_FAILURE_CANARIES.token,
                    nested: { safe: "kept" },
                  },
                  password: SNSDK54_FAILURE_CANARIES.credential,
                },
              ],
            },
            status: 200,
            headers: new Headers({ "x-total-count": "1" }),
          },
        },
        {
          operation: "getWithMeta",
          response: {
            data: { result: [] },
            status: 200,
            headers: new Headers({ "x-total-count": "0" }),
          },
        },
      ],
    });
    const arguments_ = {
      profile: SNSDK54_PROFILE_NAME,
      table: "incident",
      fields: "sys_id,number,short_description",
      limit: 2,
      offset: 0,
    };

    const success = await callTool(connected, "sn_query", arguments_);
    const empty = await callTool(connected, "sn_query", arguments_);

    expect(success.isError).toBeUndefined();
    expect(success.structuredContent).toMatchObject({
      profile: SNSDK54_PROFILE_NAME,
      data: {
        record_count: 1,
        total: 1,
        has_more: false,
        results: [
          {
            sys_id: SNSDK54_SYS_ID,
            number: "INC0010054",
            short_description: {
              value: "Database unavailable",
              nested: { safe: "kept" },
            },
          },
        ],
      },
      metadata: {
        kind: "collection",
        record_count: 1,
        pagination: {
          mode: "offset",
          limit: 2,
          offset: 0,
          returned: 1,
          has_more: false,
          order_by: ["sys_id"],
        },
        truncation: { truncated: false },
      },
    });
    expect(empty.isError).toBeUndefined();
    expect(empty.structuredContent).toMatchObject({
      profile: SNSDK54_PROFILE_NAME,
      data: {
        record_count: 0,
        total: 0,
        has_more: false,
        results: [],
      },
      metadata: { kind: "collection", record_count: 0 },
    });
    expect(connected.fixture.calls).toEqual([
      {
        operation: "getWithMeta",
        path: "/api/now/table/incident",
        params: {
          sysparm_exclude_reference_link: "true",
          sysparm_limit: "3",
          sysparm_query: "ORDERBYsys_id",
          sysparm_fields: "sys_id,number,short_description",
          sysparm_offset: "0",
          sysparm_display_value: "true",
          sysparm_no_count: "true",
        },
      },
      {
        operation: "getWithMeta",
        path: "/api/now/table/incident",
        params: {
          sysparm_exclude_reference_link: "true",
          sysparm_limit: "3",
          sysparm_query: "ORDERBYsys_id",
          sysparm_fields: "sys_id,number,short_description",
          sysparm_offset: "0",
          sysparm_display_value: "true",
          sysparm_no_count: "true",
        },
      },
    ]);
    connected.fixture.assertConsumed();
    expect(connected.audits).toHaveLength(2);
    expect(connected.audits).toEqual([
      expect.objectContaining({
        tool: "sn_query",
        profile: SNSDK54_PROFILE_NAME,
        outcome: "success",
        reason: null,
        correlationId: expect.stringMatching(/^snsdk-54-/u),
      }),
      expect.objectContaining({
        tool: "sn_query",
        profile: SNSDK54_PROFILE_NAME,
        outcome: "success",
        reason: null,
        correlationId: expect.stringMatching(/^snsdk-54-/u),
      }),
    ]);
    expect(new Set(connected.audits.map(({ correlationId }) => correlationId)).size).toBe(2);
    expect(serializedPublicEvidence(success, connected.audits)).not.toMatch(
      /access_token|password|snsdk54-(?:token|credential)-must-not-leak/u
    );
  });

  it("covers sn_get success, not-found, and ambiguity without selector leakage", async () => {
    const connected = await harness({
      steps: [
        {
          operation: "get",
          response: {
            result: {
              sys_id: SNSDK54_SYS_ID,
              number: "INC0010054",
              short_description: "Database unavailable",
              password: SNSDK54_FAILURE_CANARIES.credential,
            },
          },
        },
        { operation: "get", response: { result: [] } },
        {
          operation: "get",
          response: {
            result: [
              { sys_id: "1".repeat(32) },
              { sys_id: "2".repeat(32) },
            ],
          },
        },
      ],
    });

    const success = await callTool(connected, "sn_get", {
      profile: SNSDK54_PROFILE_NAME,
      table: "incident",
      sys_id: SNSDK54_SYS_ID,
      fields: "sys_id,number,short_description",
    });
    const identifierArguments = {
      profile: SNSDK54_PROFILE_NAME,
      table: "incident",
      identifier: {
        field: "number",
        value: SNSDK54_FAILURE_CANARIES.selector,
      },
      fields: "sys_id,number",
    };
    const notFound = await callTool(connected, "sn_get", identifierArguments);
    const ambiguous = await callTool(connected, "sn_get", identifierArguments);

    expect(success.isError).toBeUndefined();
    expect(success.structuredContent).toMatchObject({
      profile: SNSDK54_PROFILE_NAME,
      data: {
        record: {
          sys_id: SNSDK54_SYS_ID,
          number: "INC0010054",
          short_description: "Database unavailable",
        },
      },
      metadata: {
        kind: "single",
        record_count: 1,
        pagination: { mode: "none" },
        truncation: { truncated: false },
      },
    });
    expect(notFound.isError).toBe(true);
    expect(JSON.stringify(notFound)).toMatch(/Error category: not_found.*Correlation ID:/su);
    expect(ambiguous.isError).toBe(true);
    expect(JSON.stringify(ambiguous)).toMatch(/Error category: conflict.*Correlation ID:/su);
    expect(connected.fixture.calls).toEqual([
      {
        operation: "get",
        path: `/api/now/table/incident/${SNSDK54_SYS_ID}`,
        params: {
          sysparm_exclude_reference_link: "true",
          sysparm_fields: "sys_id,number,short_description",
          sysparm_display_value: "true",
        },
      },
      {
        operation: "get",
        path: "/api/now/table/incident",
        params: {
          sysparm_exclude_reference_link: "true",
          sysparm_limit: "2",
          sysparm_query: `number=${SNSDK54_FAILURE_CANARIES.selector}^ORDERBYsys_id`,
          sysparm_fields: "sys_id,number",
          sysparm_display_value: "true",
        },
      },
      {
        operation: "get",
        path: "/api/now/table/incident",
        params: {
          sysparm_exclude_reference_link: "true",
          sysparm_limit: "2",
          sysparm_query: `number=${SNSDK54_FAILURE_CANARIES.selector}^ORDERBYsys_id`,
          sysparm_fields: "sys_id,number",
          sysparm_display_value: "true",
        },
      },
    ]);
    connected.fixture.assertConsumed();
    expect(connected.audits).toEqual([
      expect.objectContaining({ tool: "sn_get", outcome: "success", reason: null }),
      expect.objectContaining({
        tool: "sn_get",
        outcome: "handler_error",
        reason: "handler_threw",
        errorCategory: "not_found",
        retry: "do_not_retry",
      }),
      expect.objectContaining({
        tool: "sn_get",
        outcome: "handler_error",
        reason: "handler_threw",
        errorCategory: "conflict",
        retry: "retry_after_correction",
      }),
    ]);
    expect(serializedPublicEvidence(notFound, connected.audits)).not.toContain(
      SNSDK54_FAILURE_CANARIES.selector
    );
    expect(serializedPublicEvidence(success, connected.audits)).not.toContain(
      SNSDK54_FAILURE_CANARIES.credential
    );
  });

  it("denies policy/validation failures before configuration, client, or upstream access", async () => {
    const deniedPolicy = createTableAccessPolicy({
      readTables: [],
      writeTables: [],
      targets: [],
    });
    const denied = await harness({ tableAccess: deniedPolicy });
    const policyResult = await callTool(denied, "sn_query", {
      profile: SNSDK54_PROFILE_NAME,
      table: "incident",
    });

    expect(policyResult.isError).toBe(true);
    expect(JSON.stringify(policyResult)).toMatch(
      /Table access was denied by policy.*Correlation ID:/su
    );
    expect(denied.managerCalls.profile).toEqual([SNSDK54_PROFILE_NAME]);
    expect(denied.managerCalls.config).toEqual([]);
    expect(denied.managerCalls.client).toEqual([]);
    expect(denied.fixture.calls).toEqual([]);
    expect(denied.audits).toEqual([
      expect.objectContaining({
        tool: "sn_query",
        outcome: "policy_rejected",
        reason: "table_access_denied",
      }),
    ]);

    const validation = await harness();
    const sensitive = await callTool(validation, "sn_query", {
      profile: SNSDK54_PROFILE_NAME,
      table: "incident",
      fields: "sys_id,password",
    });
    const invalidShape = await callTool(validation, "sn_get", {
      profile: SNSDK54_PROFILE_NAME,
      table: "incident",
      sys_id: SNSDK54_SYS_ID,
      unknown: SNSDK54_FAILURE_CANARIES.token,
    });

    expect(sensitive.isError).toBe(true);
    expect(invalidShape.isError).toBe(true);
    expect(validation.managerCalls.config).toEqual([]);
    expect(validation.managerCalls.client).toEqual([]);
    expect(validation.fixture.calls).toEqual([]);
    expect(serializedPublicEvidence(sensitive, validation.audits)).not.toContain(
      SNSDK54_FAILURE_CANARIES.credential
    );
    expect(serializedPublicEvidence(invalidShape, validation.audits)).not.toContain(
      SNSDK54_FAILURE_CANARIES.token
    );
  });

  it("uses exact controlled incident create/update targets and allowed fields", async () => {
    const upperSysId = SNSDK54_SYS_ID.toUpperCase();
    const connected = await harness({
      steps: [
        {
          operation: "post",
          response: {
            result: {
              sys_id: SNSDK54_SYS_ID,
              number: "INC0010054",
              short_description: "Database unavailable",
              urgency: "2",
              password: SNSDK54_FAILURE_CANARIES.credential,
              comments: SNSDK54_FAILURE_CANARIES.journal,
            },
          },
        },
        {
          operation: "patch",
          response: {
            result: {
              sys_id: upperSysId,
              state: "6",
              close_notes: "Resolved",
              access_token: SNSDK54_FAILURE_CANARIES.token,
            },
          },
        },
      ],
    });

    const created = await callTool(connected, "sn_create", {
      profile: SNSDK54_PROFILE_NAME,
      table: " INCIDENT ",
      fields: {
        short_description: "  Database unavailable  ",
        urgency: 2,
      },
    });
    const updated = await callTool(connected, "sn_update", {
      profile: SNSDK54_PROFILE_NAME,
      table: "incident",
      sys_id: upperSysId,
      fields: { state: "06", close_notes: "Resolved" },
    });

    expect(created.isError).toBeUndefined();
    expect(updated.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({
      profile: SNSDK54_PROFILE_NAME,
      data: {
        sys_id: SNSDK54_SYS_ID,
        number: "INC0010054",
        table: "incident",
        record: {
          short_description: "Database unavailable",
          urgency: "2",
        },
      },
      metadata: {
        kind: "operation",
        record_count: 1,
        pagination: { mode: "none" },
        truncation: { truncated: false },
      },
    });
    expect(updated.structuredContent).toMatchObject({
      profile: SNSDK54_PROFILE_NAME,
      data: {
        sys_id: SNSDK54_SYS_ID,
        record: { state: "6", close_notes: "Resolved" },
      },
      metadata: {
        kind: "operation",
        record_count: 1,
        pagination: { mode: "none" },
        truncation: { truncated: false },
      },
    });
    expect(connected.fixture.calls).toEqual([
      {
        operation: "post",
        path: "/api/now/table/incident",
        body: {
          short_description: "Database unavailable",
          urgency: "2",
        },
      },
      {
        operation: "patch",
        path: `/api/now/table/incident/${SNSDK54_SYS_ID}`,
        body: { state: "6", close_notes: "Resolved" },
      },
    ]);
    connected.fixture.assertConsumed();
    expect(connected.audits).toEqual([
      expect.objectContaining({
        tool: "sn_create",
        profile: SNSDK54_PROFILE_NAME,
        outcome: "success",
        reason: null,
        correlationId: expect.stringMatching(/^snsdk-54-/u),
      }),
      expect.objectContaining({
        tool: "sn_update",
        profile: SNSDK54_PROFILE_NAME,
        outcome: "success",
        reason: null,
        correlationId: expect.stringMatching(/^snsdk-54-/u),
      }),
    ]);
    const evidence = JSON.stringify({ created, updated, audits: connected.audits });
    for (const canary of [
      SNSDK54_FAILURE_CANARIES.credential,
      SNSDK54_FAILURE_CANARIES.token,
      SNSDK54_FAILURE_CANARIES.journal,
    ]) {
      expect(evidence).not.toContain(canary);
    }
  });

  it("rejects unsafe controlled writes before configuration, client, or ServiceNow", async () => {
    const connected = await harness();
    const denials = await Promise.all([
      callTool(connected, "sn_create", {
        profile: SNSDK54_PROFILE_NAME,
        table: "incident",
        fields: { description: "missing required short description" },
      }),
      callTool(connected, "sn_create", {
        profile: SNSDK54_PROFILE_NAME,
        table: "incident",
        fields: {
          short_description: "safe",
          password: SNSDK54_FAILURE_CANARIES.token,
        },
      }),
      callTool(connected, "sn_update", {
        profile: SNSDK54_PROFILE_NAME,
        table: "incident",
        sys_id: SNSDK54_SYS_ID,
        fields: { urgency: 4 },
      }),
      callTool(connected, "sn_update", {
        profile: SNSDK54_PROFILE_NAME,
        table: "incident",
        sys_id: SNSDK54_SYS_ID,
        fields: { comments: SNSDK54_FAILURE_CANARIES.journal },
      }),
    ]);

    for (const denial of denials) {
      expect(denial.isError).toBe(true);
      expect(denial.structuredContent).toBeUndefined();
    }
    expect(connected.managerCalls.config).toEqual([]);
    expect(connected.managerCalls.client).toEqual([]);
    expect(connected.fixture.calls).toEqual([]);
    expect(connected.audits).toHaveLength(4);
    expect(connected.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "sn_create",
          outcome: "policy_rejected",
          reason: "table_access_denied",
        }),
        expect.objectContaining({
          tool: "sn_update",
          outcome: "policy_rejected",
          reason: "table_access_denied",
        }),
        expect.objectContaining({
          tool: "sn_update",
          outcome: "policy_rejected",
          reason: "journal_update_denied",
        }),
      ])
    );
    expect(
      connected.audits.filter(
        ({ tool, outcome, reason }) =>
          tool === "sn_create" &&
          outcome === "policy_rejected" &&
          reason === "table_access_denied"
      )
    ).toHaveLength(2);
    for (const denial of denials) {
      const evidence = serializedPublicEvidence(denial, connected.audits);
      expect(evidence).not.toContain(SNSDK54_FAILURE_CANARIES.token);
      expect(evidence).not.toContain(SNSDK54_FAILURE_CANARIES.journal);
      expect(evidence).not.toContain(SNSDK54_FAILURE_CANARIES.credential);
    }
  });

  it.each([
    {
      label: "ACL authorization",
      tool: "sn_query",
      operation: "getWithMeta" as const,
      error: createToolError("authorization", "retry_after_correction"),
      category: "authorization",
      retry: "retry_after_correction",
      retryAfterSeconds: null,
      arguments: { table: "incident" },
    },
    {
      label: "timeout",
      tool: "sn_get",
      operation: "get" as const,
      error: createToolError("timeout", "retry_if_safe_and_idempotent"),
      category: "timeout",
      retry: "retry_if_safe_and_idempotent",
      retryAfterSeconds: null,
      arguments: { table: "incident", sys_id: SNSDK54_SYS_ID },
    },
    {
      label: "rate limit",
      tool: "sn_get",
      operation: "get" as const,
      error: createToolError("rate_limit", "retry_later", 17),
      category: "rate_limit",
      retry: "retry_later",
      retryAfterSeconds: 17,
      arguments: { table: "incident", sys_id: SNSDK54_SYS_ID },
    },
    {
      label: "upstream",
      tool: "sn_incident_add_work_note",
      operation: "patch" as const,
      error: createToolError("upstream", "retry_if_safe_and_idempotent"),
      category: "upstream",
      retry: "retry_if_safe_and_idempotent",
      retryAfterSeconds: null,
      arguments: {
        sys_id: SNSDK54_SYS_ID,
        content: SNSDK54_FAILURE_CANARIES.journal,
      },
    },
  ])(
    "normalizes $label failures with correlation and safe audit metadata",
    async ({ tool, operation, error, category, retry, retryAfterSeconds, arguments: args }) => {
      const connected = await harness({ steps: [{ operation, error }] });
      const result = await callTool(connected, tool, {
        profile: SNSDK54_PROFILE_NAME,
        ...args,
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(`Error category: ${category}`);
      expect(JSON.stringify(result)).toMatch(/Correlation ID: snsdk-54-/u);
      if (retryAfterSeconds !== null) {
        expect(JSON.stringify(result)).toContain(
          `Retry after ${retryAfterSeconds} seconds`
        );
      }
      expect(connected.audits).toEqual([
        expect.objectContaining({
          tool,
          profile: SNSDK54_PROFILE_NAME,
          outcome: "handler_error",
          reason: "handler_threw",
          errorCategory: category,
          retry,
          retryAfterSeconds,
          correlationId: expect.stringMatching(/^snsdk-54-/u),
        }),
      ]);
      connected.fixture.assertConsumed();
      const evidence = serializedPublicEvidence(result, connected.audits);
      for (const canary of Object.values(SNSDK54_FAILURE_CANARIES)) {
        expect(evidence).not.toContain(canary);
      }
    }
  );

  it("maps hostile unissued errors to internal without leaking their body or token", async () => {
    const hostileError = Object.assign(
      new Error(SNSDK54_FAILURE_CANARIES.upstreamBody),
      {
        response: {
          body: SNSDK54_FAILURE_CANARIES.upstreamBody,
          authorization: SNSDK54_FAILURE_CANARIES.token,
        },
      }
    );
    const connected = await harness({
      steps: [{ operation: "getWithMeta", error: hostileError }],
    });
    const result = await callTool(connected, "sn_query", {
      profile: SNSDK54_PROFILE_NAME,
      table: "incident",
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Error category: internal");
    expect(connected.audits).toEqual([
      expect.objectContaining({
        tool: "sn_query",
        outcome: "handler_error",
        errorCategory: "internal",
        retry: "do_not_retry",
        retryAfterSeconds: null,
      }),
    ]);
    const evidence = serializedPublicEvidence(result, connected.audits);
    expect(evidence).not.toContain(SNSDK54_FAILURE_CANARIES.upstreamBody);
    expect(evidence).not.toContain(SNSDK54_FAILURE_CANARIES.token);
    expect(evidence).not.toContain(SNSDK54_FAILURE_CANARIES.credential);
  });

  it("asserts exact append-only incident journal targets and omits content", async () => {
    const connected = await harness({
      steps: [
        { operation: "patch", response: { result: { sys_id: SNSDK54_SYS_ID } } },
        { operation: "patch", response: { result: { sys_id: SNSDK54_SYS_ID } } },
      ],
    });
    const comment = `${SNSDK54_FAILURE_CANARIES.journal}-comment`;
    const workNote = `${SNSDK54_FAILURE_CANARIES.journal}-work-note`;
    const commentResult = await callTool(connected, "sn_incident_add_comment", {
      profile: SNSDK54_PROFILE_NAME,
      sys_id: SNSDK54_SYS_ID,
      content: comment,
    });
    const workNoteResult = await callTool(
      connected,
      "sn_incident_add_work_note",
      {
        profile: SNSDK54_PROFILE_NAME,
        sys_id: SNSDK54_SYS_ID,
        content: workNote,
      }
    );

    expect(commentResult.isError).toBeUndefined();
    expect(workNoteResult.isError).toBeUndefined();
    expect(commentResult.structuredContent).toMatchObject({
      profile: SNSDK54_PROFILE_NAME,
      data: {
        status: "appended",
        sys_id: SNSDK54_SYS_ID,
        journal_field: "comments",
      },
      metadata: { kind: "operation", record_count: 1 },
    });
    expect(workNoteResult.structuredContent).toMatchObject({
      profile: SNSDK54_PROFILE_NAME,
      data: {
        status: "appended",
        sys_id: SNSDK54_SYS_ID,
        journal_field: "work_notes",
      },
      metadata: { kind: "operation", record_count: 1 },
    });
    expect(connected.fixture.calls).toEqual([
      {
        operation: "patch",
        path: `/api/now/table/incident/${SNSDK54_SYS_ID}`,
        body: { comments: comment },
      },
      {
        operation: "patch",
        path: `/api/now/table/incident/${SNSDK54_SYS_ID}`,
        body: { work_notes: workNote },
      },
    ]);
    connected.fixture.assertConsumed();
    expect(serializedPublicEvidence(commentResult, connected.audits)).not.toContain(
      comment
    );
    expect(serializedPublicEvidence(workNoteResult, connected.audits)).not.toContain(
      workNote
    );
  });
});
