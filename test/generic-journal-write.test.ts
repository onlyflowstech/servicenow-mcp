/**
 * Journal fields (comments, work_notes) through the generic write tools, the
 * sn_batch value policy, and the documented REST Batch API exchange.
 *
 * Everything runs against mocked ServiceNow operations through the real MCP
 * dispatcher; no request leaves the process.
 */

import { Buffer } from "node:buffer";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import type { FieldPolicyConfigurationInput } from "../src/field-policy.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { createToolError } from "../src/tool-error.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const PROFILE = "journal-write";
const CONFIG: ServiceNowConfig = {
  instance: "https://generic-journal.service-now.com",
  user: "generic-journal-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};
const SYS_ID = "1".repeat(32);
const BATCH_PATH = "/api/now/v1/batch";

interface RestBatchRequest {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{ name: string; value: string }>;
  readonly exclude_response_headers: boolean;
  readonly body?: string;
}

interface RestBatchPayload {
  readonly batch_request_id: string;
  readonly rest_requests: readonly RestBatchRequest[];
}

const openHarnesses: Array<Awaited<ReturnType<typeof createHarness>>> = [];

afterEach(async () => {
  await Promise.all(
    openHarnesses.splice(0).map(async ({ client, server }) => {
      await client.close();
      if (server.isConnected()) await server.close();
    })
  );
});

function sysIdFor(index: number): string {
  return (index + 1).toString(16).padStart(32, "a");
}

/** A batch response that services every request with one status. */
function servicedResponse(payload: RestBatchPayload, statusCode = 200) {
  return {
    batch_request_id: payload.batch_request_id,
    serviced_requests: payload.rest_requests.map(({ id }) => ({
      id,
      status_code: statusCode,
      status_text: statusCode === 200 ? "OK" : "Error",
      body: Buffer.from(JSON.stringify({ result: { sys_id: SYS_ID } })).toString(
        "base64"
      ),
      execution_time: 5,
    })),
    unserviced_requests: [],
  };
}

function decodedBody(request: RestBatchRequest): Record<string, unknown> {
  if (request.body === undefined) throw new Error("request has no body");
  return JSON.parse(Buffer.from(request.body, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function createHarness(
  options: {
    readonly fieldPolicy?: FieldPolicyConfigurationInput;
    readonly matched?: number;
  } = {}
) {
  const records: ToolAuditRecord[] = [];
  const matched = options.matched ?? 2;
  const serviceNowClient = {
    get: vi.fn(async () => ({
      result: Array.from({ length: matched }, (_, index) => ({
        sys_id: sysIdFor(index),
      })),
    })),
    getWithMeta: vi.fn(async () => ({
      data: { result: [] },
      status: 200,
      headers: new Headers(),
    })),
    post: vi.fn(async (path: string, body: unknown) =>
      path === BATCH_PATH
        ? servicedResponse(body as RestBatchPayload)
        : { result: { sys_id: SYS_ID, number: "CHG0000001" } }
    ),
    patch: vi.fn(async () => ({ result: { sys_id: SYS_ID } })),
    delete: vi.fn(async () => ({ status: 204 })),
  };
  const getProfile = vi.fn(() => ({
    instance: CONFIG.instance,
    username: CONFIG.user,
    credential: "env:GENERIC_JOURNAL_TEST_SECRET_IS_NEVER_READ",
    authType: "basic" as const,
  }));
  const getConfig = vi.fn(() => CONFIG);
  const getClient = vi.fn(() => serviceNowClient as unknown as ServiceNowClient);
  const profileManager = {
    getProfile,
    getConfig,
    getClient,
  } as unknown as ProfileManager;
  // A "full write" profile: every table, every tool, no field narrowing
  // unless the test supplies one.
  const tableAccess = createTableAccessPolicy({
    readTables: ["*"],
    writeTables: ["*"],
    targets: [],
  });
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `journal-${String(requestId)}`,
        identity: { ownerId: "journal-owner", clientId: "journal-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "generic-journal-write",
        revision: "task-a",
        tableAccess,
        ...(options.fieldPolicy === undefined
          ? {}
          : { fieldPolicy: options.fieldPolicy }),
      }),
    },
    auditSink: {
      write: (record) => records.push(record),
      writePreContext: () => {},
    },
  };
  const server = await createMcpServer({
    dependencies: { profileManager, executionContext },
    register: (surface, dependencies) =>
      registerServiceNowTools(
        surface,
        dependencies.profileManager,
        dependencies.executionContext
      ),
  });
  const client = new Client({ name: "generic-journal-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, records, serviceNowClient, getConfig, getClient };
}

async function harness(options?: Parameters<typeof createHarness>[0]) {
  const connected = await createHarness(options);
  openHarnesses.push(connected);
  return connected;
}

type Harness = Awaited<ReturnType<typeof harness>>;

function callTool(connected: Harness, name: string, args: Record<string, unknown>) {
  return connected.client.callTool({
    name,
    arguments: { profile: PROFILE, ...args },
  });
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.[0]?.type === "text" ? (content[0].text ?? "") : "";
}

function responseData(
  result: Awaited<ReturnType<Client["callTool"]>>
): Record<string, unknown> {
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null) {
    throw new Error(`Expected structured response: ${responseText(result)}`);
  }
  return Reflect.get(structured, "data") as Record<string, unknown>;
}

function batchPayloads(connected: Harness): RestBatchPayload[] {
  return connected.serviceNowClient.post.mock.calls
    .filter(([path]) => path === BATCH_PATH)
    .map(([, payload]) => payload as RestBatchPayload);
}

function batchArguments(
  fields: Record<string, unknown>,
  table = "incident"
): Record<string, unknown> {
  return {
    table,
    action: "update",
    structured_query: {
      filter: { type: "equality", field: "active", operator: "eq", value: true },
    },
    fields,
    confirm: true,
  };
}

describe("generic journal writes through sn_create and sn_update", () => {
  it.each([
    ["incident", "comments"],
    ["incident", "work_notes"],
    ["change_request", "work_notes"],
    ["u_custom", "comments"],
  ] as const)("sn_update on %s PATCHes %s as sent", async (table, field) => {
    const connected = await harness();
    const result = await callTool(connected, "sn_update", {
      table,
      sys_id: SYS_ID,
      fields: { [field]: "Called the customer back." },
    });

    expect(result.isError).toBeUndefined();
    expect(connected.serviceNowClient.patch).toHaveBeenCalledTimes(1);
    expect(connected.serviceNowClient.patch).toHaveBeenCalledWith(
      `/api/now/table/${table}/${SYS_ID}`,
      { [field]: "Called the customer back." }
    );
  });

  it("sn_create on change_request POSTs the journal field with the record", async () => {
    const connected = await harness();
    const result = await callTool(connected, "sn_create", {
      table: "change_request",
      fields: { short_description: "Patch window", comments: "Approved by CAB" },
    });

    expect(result.isError).toBeUndefined();
    expect(connected.serviceNowClient.post).toHaveBeenCalledWith(
      "/api/now/table/change_request",
      { short_description: "Patch window", comments: "Approved by CAB" }
    );
  });

  it("lets a narrowed field policy deny a journal field by configuration", async () => {
    const connected = await harness({
      fieldPolicy: { fieldPolicy: { incident: { writable: ["short_description"] } } },
    });
    const result = await callTool(connected, "sn_update", {
      table: "incident",
      sys_id: SYS_ID,
      fields: { comments: "journal-canary" },
    });

    expect(result.isError).toBe(true);
    const text = responseText(result);
    expect(text).toContain('field "comments" is not writable on "incident"');
    expect(text).toContain("fieldPolicy.incident.writable");
    expect(text).not.toContain("journal-canary");
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_update",
      outcome: "policy_rejected",
      reason: "field_access_denied",
    });
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });

  it("denies journal content outside the journal bounds as a value denial", async () => {
    const connected = await harness();
    const result = await callTool(connected, "sn_update", {
      table: "problem",
      sys_id: SYS_ID,
      fields: { work_notes: "x".repeat(8_001) },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain('rejected a field value for "work_notes"');
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_update",
      outcome: "policy_rejected",
      reason: "write_value_denied",
    });
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });
});

describe("Security finding B-2: dedicated journal tools follow the field policy", () => {
  it("denies the journal tool whose field the writable set excludes", async () => {
    const connected = await harness({
      fieldPolicy: {
        fieldPolicy: {
          incident: { writable: ["state", "assigned_to", "work_notes"] },
        },
      },
    });

    const comment = await callTool(connected, "sn_incident_add_comment", {
      sys_id: SYS_ID,
      content: "comment-canary",
    });
    expect(comment.isError).toBe(true);
    const text = responseText(comment);
    expect(text).toContain('field "comments" is not writable on "incident"');
    expect(text).toContain("fieldPolicy.incident.writable");
    expect(text).not.toContain("comment-canary");
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_incident_add_comment",
      outcome: "policy_rejected",
      reason: "field_access_denied",
    });
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();

    const workNote = await callTool(connected, "sn_incident_add_work_note", {
      sys_id: SYS_ID,
      content: "Internal note",
    });
    expect(workNote.isError).toBeUndefined();
    expect(connected.serviceNowClient.patch).toHaveBeenCalledWith(
      `/api/now/table/incident/${SYS_ID}`,
      { work_notes: "Internal note" }
    );

    // Both routes to the same field agree.
    const genericComment = await callTool(connected, "sn_update", {
      table: "incident",
      sys_id: SYS_ID,
      fields: { comments: "comment-canary" },
    });
    expect(genericComment.isError).toBe(true);
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_update",
      reason: "field_access_denied",
    });
    const genericWorkNote = await callTool(connected, "sn_update", {
      table: "incident",
      sys_id: SYS_ID,
      fields: { work_notes: "Internal note" },
    });
    expect(genericWorkNote.isError).toBeUndefined();
    expect(connected.serviceNowClient.patch).toHaveBeenCalledTimes(2);
  });

  it("allows both journal tools when no field policy narrows incident", async () => {
    const connected = await harness();
    for (const [tool, field] of [
      ["sn_incident_add_comment", "comments"],
      ["sn_incident_add_work_note", "work_notes"],
    ] as const) {
      const result = await callTool(connected, tool, {
        sys_id: SYS_ID,
        content: `${field} entry`,
      });
      expect(result.isError).toBeUndefined();
      expect(connected.serviceNowClient.patch).toHaveBeenLastCalledWith(
        `/api/now/table/incident/${SYS_ID}`,
        { [field]: `${field} entry` }
      );
    }
    expect(connected.serviceNowClient.patch).toHaveBeenCalledTimes(2);
  });
});

describe("sn_batch value policy", () => {
  it("sends work_notes exactly once per record across chunks, never replayed", async () => {
    const connected = await harness({ matched: 60 });
    const result = await callTool(
      connected,
      "sn_batch",
      batchArguments({ work_notes: "Bulk triage note" })
    );

    expect(result.isError).toBeUndefined();
    expect(responseData(result)).toEqual({
      action: "update",
      table: "incident",
      matched: 60,
      processed: 60,
      failed: 0,
    });
    const requests = batchPayloads(connected).flatMap(
      ({ rest_requests }) => rest_requests
    );
    // Two batches of at most 50, one request per record.
    expect(batchPayloads(connected).map(({ rest_requests }) => rest_requests.length)).toEqual([
      50, 10,
    ]);
    expect(new Set(requests.map(({ url }) => url)).size).toBe(60);
    for (const request of requests) {
      expect(decodedBody(request)).toEqual({ work_notes: "Bulk triage note" });
    }
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });

  it("accepts a custom incident field and canonicalizes generic shapes", async () => {
    const connected = await harness({ matched: 1 });
    const result = await callTool(
      connected,
      "sn_batch",
      batchArguments({
        u_custom: "v",
        watch_list: [SYS_ID, sysIdFor(1)],
        u_amount: 12.5,
        u_flag: null,
      })
    );

    expect(result.isError).toBeUndefined();
    const [request] = batchPayloads(connected)[0]!.rest_requests;
    expect(decodedBody(request!)).toEqual({
      u_custom: "v",
      watch_list: `${SYS_ID},${sysIdFor(1)}`,
      u_amount: "12.5",
      u_flag: "",
    });
  });

  it("denies an unsafe value before configuration or client construction", async () => {
    const connected = await harness();
    const result = await callTool(
      connected,
      "sn_batch",
      batchArguments({ u_x: "a\u0000" }, "change_request")
    );

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain('rejected a field value for "u_x"');
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_batch",
      outcome: "policy_rejected",
      reason: "write_value_denied",
    });
    expect(connected.getConfig).not.toHaveBeenCalled();
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.get).not.toHaveBeenCalled();
  });

  it("denies unsafe journal content in a dry run too", async () => {
    const connected = await harness();
    const result = await callTool(connected, "sn_batch", {
      ...batchArguments({ comments: "   " }),
      confirm: false,
    });

    expect(result.isError).toBe(true);
    expect(connected.records.at(-1)).toMatchObject({
      reason: "write_value_denied",
    });
    expect(connected.getClient).not.toHaveBeenCalled();
  });
});

describe("sn_batch REST Batch API exchange", () => {
  it("sends the documented request shape", async () => {
    const connected = await harness({ matched: 1 });
    await callTool(connected, "sn_batch", batchArguments({ state: "2" }));

    const [payload] = batchPayloads(connected);
    expect(payload!.batch_request_id).toMatch(/^sn_batch_\d+_0$/u);
    expect(payload!.rest_requests).toEqual([
      {
        id: "1",
        method: "PATCH",
        url: `/api/now/table/incident/${sysIdFor(0)}?sysparm_fields=sys_id`,
        headers: [
          { name: "Content-Type", value: "application/json" },
          { name: "Accept", value: "application/json" },
        ],
        exclude_response_headers: true,
        body: Buffer.from(JSON.stringify({ state: "2" }), "utf8").toString("base64"),
      },
    ]);
  });

  it("sends deletes without a body and counts 204 as processed", async () => {
    const connected = await harness({ matched: 2 });
    connected.serviceNowClient.post.mockImplementationOnce(
      async (_path: string, body: unknown) =>
        servicedResponse(body as RestBatchPayload, 204)
    );
    const result = await callTool(connected, "sn_batch", {
      table: "incident",
      action: "delete",
      structured_query: {
        filter: { type: "equality", field: "active", operator: "eq", value: false },
      },
      confirm: true,
    });

    expect(responseData(result)).toMatchObject({ processed: 2, failed: 0 });
    const [first] = batchPayloads(connected)[0]!.rest_requests;
    expect(first).toEqual({
      id: "1",
      method: "DELETE",
      url: `/api/now/table/incident/${sysIdFor(0)}`,
      headers: [{ name: "Accept", value: "application/json" }],
      exclude_response_headers: true,
    });
    expect(connected.serviceNowClient.delete).not.toHaveBeenCalled();
  });

  it("parses serviced_requests per id with no serial replay", async () => {
    const connected = await harness({ matched: 3 });
    connected.serviceNowClient.post.mockResolvedValueOnce({
      batch_request_id: "x",
      serviced_requests: [
        { id: "3", status_code: 403, status_text: "Forbidden" },
        { id: "1", status_code: 200, status_text: "OK" },
        { id: "2", status_code: "200", status_text: "OK" },
        // An id that was never sent is ignored.
        { id: "99", status_code: 200 },
      ],
      unserviced_requests: [],
    });
    const result = await callTool(connected, "sn_batch", batchArguments({ state: "2" }));

    expect(responseData(result)).toEqual({
      action: "update",
      table: "incident",
      matched: 3,
      processed: 2,
      failed: 1,
    });
    expect(connected.serviceNowClient.post).toHaveBeenCalledTimes(1);
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });

  it.each([
    ["an undocumented wrapper", { result: { responses: [{ status_code: 200 }] } }],
    ["no body", null],
    ["a non-array serviced list", { serviced_requests: "ok" }],
  ])("does not replay a 2xx batch response with %s", async (_label, body) => {
    const connected = await harness({ matched: 2 });
    connected.serviceNowClient.post.mockResolvedValueOnce(body as never);
    const result = await callTool(
      connected,
      "sn_batch",
      batchArguments({ work_notes: "Must never be posted twice" })
    );

    expect(result.isError).toBeUndefined();
    const data = responseData(result);
    expect(data).toMatchObject({ matched: 2, processed: 0, failed: 0 });
    expect(data.message).toContain("did not confirm the outcome for 2 record(s)");
    expect(data.message).toContain("not retried");
    expect(connected.serviceNowClient.post).toHaveBeenCalledTimes(1);
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });

  it("reports ids missing or repeated in the response as unconfirmed", async () => {
    const connected = await harness({ matched: 3 });
    connected.serviceNowClient.post.mockResolvedValueOnce({
      serviced_requests: [
        { id: "1", status_code: 200 },
        { id: "2", status_code: 200 },
        { id: "2", status_code: 500 },
      ],
      unserviced_requests: [],
    });
    const result = await callTool(connected, "sn_batch", batchArguments({ state: "2" }));

    const data = responseData(result);
    expect(data).toMatchObject({ processed: 1, failed: 0 });
    expect(data.message).toContain("did not confirm the outcome for 2 record(s)");
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });

  it("counts unserviced_requests as failed without replaying them", async () => {
    const connected = await harness({ matched: 3 });
    connected.serviceNowClient.post.mockResolvedValueOnce({
      serviced_requests: [{ id: "1", status_code: 200 }],
      unserviced_requests: ["2", "3"],
    });
    const result = await callTool(connected, "sn_batch", batchArguments({ state: "2" }));

    const data = responseData(result);
    expect(data).toMatchObject({ processed: 1, failed: 2 });
    expect(data.message).toContain("did not process 2 record(s)");
    expect(data.message).not.toContain("did not confirm");
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404],
    ["authorization", 403],
    ["authentication", 401],
    ["rate_limit", 429],
  ] as const)(
    "falls back to serial calls when the batch request is refused (%s)",
    async (category) => {
      const connected = await harness({ matched: 2 });
      connected.serviceNowClient.post.mockRejectedValueOnce(
        createToolError(category, "do_not_retry")
      );
      const result = await callTool(
        connected,
        "sn_batch",
        batchArguments({ work_notes: "Serial note", u_amount: 1.5 })
      );

      expect(responseData(result)).toMatchObject({ processed: 2, failed: 0 });
      expect(connected.serviceNowClient.patch).toHaveBeenCalledTimes(2);
      for (const index of [0, 1]) {
        expect(connected.serviceNowClient.patch).toHaveBeenCalledWith(
          `/api/now/table/incident/${sysIdFor(index)}`,
          { work_notes: "Serial note", u_amount: "1.5" }
        );
      }
    }
  );

  it.each([
    ["timeout", createToolError("timeout", "do_not_retry")],
    ["upstream", createToolError("upstream", "do_not_retry")],
    ["an unreadable response", new RangeError("cumulative upstream byte limit")],
  ])(
    "never replays serially after an ambiguous batch failure (%s)",
    async (_label, failure) => {
      const connected = await harness({ matched: 2 });
      connected.serviceNowClient.post.mockRejectedValueOnce(failure);
      const result = await callTool(
        connected,
        "sn_batch",
        batchArguments({ work_notes: "Must never be posted twice" })
      );

      expect(result.isError).toBeUndefined();
      const data = responseData(result);
      expect(data).toMatchObject({ processed: 0, failed: 0 });
      expect(data.message).toContain("did not confirm the outcome for 2 record(s)");
      expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
    }
  );

  it("falls back only for the records after a confirmed batch", async () => {
    const connected = await harness({ matched: 60 });
    connected.serviceNowClient.post
      .mockImplementationOnce(async (_path: string, body: unknown) =>
        servicedResponse(body as RestBatchPayload)
      )
      .mockRejectedValueOnce(createToolError("rate_limit", "retry_later"));
    const result = await callTool(
      connected,
      "sn_batch",
      batchArguments({ work_notes: "Once only" })
    );

    expect(responseData(result)).toMatchObject({ processed: 60, failed: 0 });
    // The first 50 were confirmed by the batch; only the last 10 go serial.
    expect(connected.serviceNowClient.patch).toHaveBeenCalledTimes(10);
    const serialPaths = connected.serviceNowClient.patch.mock.calls.map(
      ([path]) => path
    );
    expect(serialPaths).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `/api/now/table/incident/${sysIdFor(50 + index)}`
      )
    );
  });

  it("stops after an unconfirmed batch and does not send the rest", async () => {
    const connected = await harness({ matched: 60 });
    connected.serviceNowClient.post.mockResolvedValueOnce({ unexpected: true });
    const result = await callTool(
      connected,
      "sn_batch",
      batchArguments({ work_notes: "Once only" })
    );

    const data = responseData(result);
    expect(data).toMatchObject({ matched: 60, processed: 0, failed: 10 });
    expect(data.message).toContain("did not confirm the outcome for 50 record(s)");
    expect(data.message).toContain("remaining 10 record(s) were not sent");
    expect(connected.serviceNowClient.post).toHaveBeenCalledTimes(1);
    expect(connected.serviceNowClient.patch).not.toHaveBeenCalled();
  });
});
