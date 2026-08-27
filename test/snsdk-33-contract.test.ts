import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import {
  ATTACHMENT_RESULT_BYTE_LIMIT,
  DEFAULT_RESULT_RECORD_LIMIT,
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
  productionToolOutputSchemas,
  resultPaginationSchema,
  type ProductionToolName,
} from "../src/tools/result-envelope.js";
import {
  enrichSuccessfulResult,
  registerServiceNowTools,
  toolModules,
} from "../src/tools/index.js";
import {
  handler as aggregateHandler,
  schema as aggregateSchema,
} from "../src/tools/aggregate.js";
import { handler as atfHandler, schema as atfSchema } from "../src/tools/atf.js";
import { schema as attachSchema } from "../src/tools/attach.js";
import {
  handler as codeSearchHandler,
  schema as codeSearchSchema,
} from "../src/tools/codesearch.js";
import {
  handler as discoverHandler,
  schema as discoverSchema,
} from "../src/tools/discover.js";
import { schema as relationshipSchema } from "../src/tools/relationships.js";
import { schema as querySchema } from "../src/tools/query.js";
import { schema as syslogSchema } from "../src/tools/syslog.js";

const PROFILE = "production-east";

const REGISTERED_QUERY_CONFIG: ServiceNowConfig = {
  instance: "https://snsdk-33-test.service-now.com",
  user: "snsdk-33-test-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};

const REGISTERED_QUERY_TABLE_ACCESS = createTableAccessPolicy({
  readTables: ["incident"],
  writeTables: [],
  targets: [
    {
      table: "incident",
      kind: "canonical",
      tools: ["sn_query"],
      closureComplete: true,
      relatedTables: ["incident"],
    },
  ],
});

async function callRegisteredQuery(records: Array<Record<string, unknown>>) {
  const getWithMeta = vi.fn(async () => ({
    data: { result: records },
    status: 200,
    headers: new Headers({ "x-total-count": "100" }),
  }));
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: REGISTERED_QUERY_CONFIG.instance,
      username: REGISTERED_QUERY_CONFIG.user,
      credential: "env:SNSDK_33_TEST_SECRET_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => REGISTERED_QUERY_CONFIG),
    getClient: vi.fn(() => ({ getWithMeta }) as unknown as ServiceNowClient),
  } as unknown as ProfileManager;
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `snsdk-33-${String(requestId)}`,
        identity: { ownerId: "snsdk-33-owner", clientId: "snsdk-33-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "snsdk-33-policy",
        revision: "registered-envelope-regression",
        tableAccess: REGISTERED_QUERY_TABLE_ACCESS,
      }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
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
  const client = new Client({
    name: "snsdk-33-registered-wrapper-client",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "sn_query",
      arguments: {
        profile: PROFILE,
        table: "incident",
        fields: "sys_id,description",
        limit: 1,
        offset: 41,
        max_response_bytes: 1_000,
      },
    });
    return { getWithMeta, result };
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function finalized(
  name: ProductionToolName,
  args: Readonly<Record<string, unknown>>,
  data: unknown
) {
  const adapted = envelopeCompatibilityResult(name, args, textResult(data));
  const enriched = enrichSuccessfulResult(adapted, PROFILE);
  const result = finalizeEnvelopeResult(enriched);
  expect(result).toBeDefined();
  return result!;
}

describe("SNSDK-33 strict production envelopes", () => {
  it("publishes the exact shared envelope on all 20 production modules", () => {
    expect(toolModules).toHaveLength(20);
    for (const module of toolModules) {
      const shape = module.outputSchema.shape;
      expect(Object.keys(shape).sort(), module.definition.name).toEqual([
        "data",
        "metadata",
        "profile",
      ]);
      expect(module.outputSchema._def.unknownKeys, module.definition.name).toBe(
        "strict"
      );
      expect(
        module.outputSchema.safeParse({
          profile: PROFILE,
          data: {},
          metadata: {},
          undeclared: true,
        }).success,
        module.definition.name
      ).toBe(false);
    }
  });

  it("keeps canonical profile and replaces handler text with a derived summary", () => {
    const result = finalized(
      "sn_get",
      { max_response_bytes: 100_000 },
      { sys_id: "1".repeat(32), profile: "attacker-selected-profile" }
    );
    expect(result.structuredContent).toMatchObject({
      profile: PROFILE,
      data: { record: { profile: "attacker-selected-profile" } },
      metadata: {
        kind: "single",
        pagination: { mode: "none" },
      },
    });
    const text = result.content[0];
    expect(text.type).toBe("text");
    if (text.type !== "text") throw new TypeError("expected text summary");
    expect(text.text).toContain(`profile ${JSON.stringify(PROFILE)}`);
    expect(text.text).not.toContain("attacker-selected-profile");
  });

  it("enforces the exact final MCP byte cap and reports byte truncation", () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      sys_id: String(index).padStart(32, "0"),
      description: "x".repeat(300),
    }));
    const result = finalized(
      "sn_query",
      { limit: 20, offset: 7, max_response_bytes: 1_000 },
      {
        record_count: results.length,
        has_more: false,
        results,
      }
    );
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      1_000
    );
    expect(result.structuredContent).toMatchObject({
      profile: PROFILE,
      metadata: {
        truncation: { truncated: true, reason: "byte_limit" },
        pagination: {
          mode: "offset",
          has_more: false,
          offset: 7,
          recovery: "adjust_request_and_retry_same_offset",
        },
      },
    });
    expect(
      productionToolOutputSchemas.sn_query.safeParse(result.structuredContent)
        .success
    ).toBe(true);
  });

  it("caps collection records before return with deterministic continuation", () => {
    const records = Array.from(
      { length: DEFAULT_RESULT_RECORD_LIMIT + 25 },
      (_, index) => ({ field: `field_${index}` })
    );
    const result = finalized("sn_schema", { offset: 10 }, records);
    const structured = productionToolOutputSchemas.sn_schema.parse(
      result.structuredContent
    );
    expect(structured.data.fields).toHaveLength(DEFAULT_RESULT_RECORD_LIMIT);
    expect(structured.metadata.record_count).toBe(DEFAULT_RESULT_RECORD_LIMIT);
    expect(structured.metadata.pagination.next_offset).toBe(1_010);
    expect(structured.metadata.pagination.order_by).toEqual(["field", "sys_id"]);
    expect(structured.metadata.truncation).toMatchObject({
      reason: "record_limit",
      dropped_records: 25,
    });
  });

  it("uses the distinct attachment base64 response budget", () => {
    const result = finalized(
      "sn_attach",
      { action: "download" },
      {
        status: "downloaded",
        size_bytes: 3,
        file_name: "a.txt",
        content_type: "text/plain",
        content_base64: "YWJj",
      }
    );
    expect(result.structuredContent).toMatchObject({
      metadata: { limits: { max_bytes: ATTACHMENT_RESULT_BYTE_LIMIT } },
    });
  });

  it("preserves tool-reported collection totals while counting returned rows", () => {
    const result = finalized(
      "sn_relationships",
      { limit: 2, offset: 3 },
      {
        root: { sys_id: "0".repeat(32) },
        relationships: [{ sys_id: "1" }, { sys_id: "2" }],
        meta: { total: 27, has_more: true, next_offset: 5 },
      }
    );
    const structured = productionToolOutputSchemas.sn_relationships.parse(
      result.structuredContent
    );
    expect(structured.data.meta.total).toBe(27);
    expect(structured.metadata.record_count).toBe(2);
    expect(structured.metadata.pagination.order_by).toEqual([
      "depth_first",
      "relationship_sys_id",
    ]);
  });

  it("rejects non-monotonic and unused cursor continuation contracts", () => {
    const base = {
      mode: "offset" as const,
      limit: 10,
      offset: 20,
      returned: 0,
      order_by: ["sys_id"],
    };
    expect(
      resultPaginationSchema.safeParse({
        ...base,
        has_more: true,
        next_offset: 20,
      }).success
    ).toBe(false);
    expect(
      resultPaginationSchema.safeParse({ ...base, has_more: true }).success
    ).toBe(false);
    expect(
      resultPaginationSchema.safeParse({
        ...base,
        has_more: false,
        next_offset: 30,
      }).success
    ).toBe(false);
    expect(
      resultPaginationSchema.safeParse({ mode: "cursor", cursor: "unused" })
        .success
    ).toBe(false);
    expect(
      resultPaginationSchema.safeParse({
        ...base,
        has_more: true,
        next_offset: 30,
        recovery: "adjust_request_and_retry_same_offset",
      }).success
    ).toBe(true);
  });

  it("normalizes a legacy zero-record truncation to explicit same-offset recovery", () => {
    const result = finalized(
      "sn_query",
      { limit: 1, offset: 9, max_response_bytes: 1_000 },
      {
        record_count: 0,
        has_more: true,
        next_offset: 9,
        truncated: true,
        dropped_records: 1,
        results: [],
      }
    );
    const structured = productionToolOutputSchemas.sn_query.parse(
      result.structuredContent
    );
    expect(structured.data).toMatchObject({
      record_count: 0,
      has_more: false,
      truncated: true,
      dropped_records: 1,
      results: [],
    });
    expect(structured.data).not.toHaveProperty("next_offset");
    expect(structured.metadata.pagination).toMatchObject({
      mode: "offset",
      offset: 9,
      returned: 0,
      has_more: false,
      recovery: "adjust_request_and_retry_same_offset",
    });
  });

  it("preserves authoritative upstream continuation through side-effect-free byte fitting", () => {
    const data = {
      record_count: 4,
      has_more: true,
      next_offset: 30,
      truncated: true,
      dropped_records: 3,
      results: Array.from({ length: 4 }, (_, index) => ({
        sys_id: String(index).padStart(32, "0"),
        description: "x".repeat(800),
      })),
    };
    const adapted = envelopeCompatibilityResult(
      "sn_query",
      { limit: 20, offset: 10, max_response_bytes: 1_000 },
      textResult(data)
    );
    const enriched = enrichSuccessfulResult(adapted, PROFILE);
    const before = JSON.stringify(enriched.structuredContent);
    const result = finalizeEnvelopeResult(enriched);
    expect(result).toBeDefined();
    expect(JSON.stringify(enriched.structuredContent)).toBe(before);

    const structured = productionToolOutputSchemas.sn_query.parse(
      result?.structuredContent
    );
    const returned = structured.data.results.length;
    expect(returned).toBeLessThan(4);
    expect(structured.metadata.pagination).toMatchObject({
      mode: "offset",
      offset: 10,
      returned,
      has_more: true,
      next_offset: 30,
      recovery: "adjust_request_and_retry_same_offset",
    });
    expect(structured.data).toMatchObject({
      record_count: returned,
      has_more: true,
      next_offset: 30,
      truncated: true,
      dropped_records: 3 + 4 - returned,
    });
    expect(structured.metadata.truncation.dropped_records).toBe(
      3 + 4 - returned
    );
  });

  it("fits a maximum-size collection within a bounded finalization budget", () => {
    const data = {
      record_count: 1_000,
      has_more: false,
      results: Array.from({ length: 1_000 }, (_, index) => ({
        sys_id: String(index).padStart(32, "0"),
        value: "x".repeat(500),
      })),
    };
    const adapted = envelopeCompatibilityResult(
      "sn_query",
      { limit: 1_000, max_response_bytes: 1_000 },
      textResult(data)
    );
    const enriched = enrichSuccessfulResult(adapted, PROFILE);
    const started = performance.now();
    const result = finalizeEnvelopeResult(enriched);
    const elapsed = performance.now() - started;

    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(250);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      1_000
    );
  });

  it("keeps byte-limit continuation monotonic for an unrepresentable record", () => {
    const data = {
      record_count: 1,
      has_more: false,
      results: [{ values: Array.from({ length: 2_000 }, (_, index) => index) }],
    };
    const before = JSON.stringify(data);
    const result = finalized(
      "sn_query",
      { limit: 1, offset: 41, max_response_bytes: 1_000 },
      data
    );
    expect(JSON.stringify(data)).toBe(before);
    const structured = productionToolOutputSchemas.sn_query.parse(
      result.structuredContent
    );
    expect(structured.data.results).toEqual([]);
    expect(structured.metadata.pagination).toMatchObject({
      mode: "offset",
      offset: 41,
      returned: 0,
      has_more: false,
      recovery: "adjust_request_and_retry_same_offset",
    });
    expect(structured.metadata.truncation).toMatchObject({
      truncated: true,
      reason: "byte_limit",
      dropped_records: 1,
    });
  });

  it("drops an intact row only for production-wrapper envelope overhead and exposes recovery plus resume", async () => {
    const description = "whole-record-canary-" + "x".repeat(580);
    const records = [{ sys_id: "1".repeat(32), description }];
    const before = JSON.stringify(records);
    const { getWithMeta, result } = await callRegisteredQuery(records);

    expect(getWithMeta).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(records)).toBe(before);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      1_000
    );

    const structured = productionToolOutputSchemas.sn_query.parse(
      result.structuredContent
    );
    expect(structured.data.results).toEqual([]);
    expect(structured.data).toMatchObject({
      record_count: 0,
      has_more: true,
      next_offset: 42,
    });
    // The legacy handler did not truncate; only the registered production
    // wrapper needed to remove the row to fit its envelope overhead.
    expect(structured.data).not.toHaveProperty("truncated");
    expect(structured.data).not.toHaveProperty("dropped_records");
    expect(structured.metadata.pagination).toMatchObject({
      mode: "offset",
      limit: 1,
      offset: 41,
      returned: 0,
      has_more: true,
      next_offset: 42,
      recovery: "adjust_request_and_retry_same_offset",
    });
    expect(structured.metadata.truncation).toEqual({
      truncated: true,
      reason: "byte_limit",
      dropped_records: 1,
    });

    const summary = result.content[0];
    expect(summary?.type).toBe("text");
    if (summary?.type !== "text") throw new TypeError("expected text summary");
    expect(summary.text).toContain("retry offset 41");
    expect(summary.text).toContain("offset 42 only to resume");
    expect(summary.text).not.toContain("No automatic continuation");
    expect(JSON.stringify(result)).not.toContain("...[truncated");
  });
});

describe("SNSDK-33 bounded collection inputs", () => {
  it.each([
    ["ATF", atfSchema, { action: "list" }],
    ["code search", codeSearchSchema, { search_term: "needle" }],
    ["discover", discoverSchema, { type: "tables" }],
    ["attachments", attachSchema, { action: "list" }],
    ["aggregate", aggregateSchema, { table: "incident", type: "COUNT" }],
    ["relationships", relationshipSchema, { sys_id: "1".repeat(32) }],
  ])("rejects non-integer, zero, and excessive %s limits", (_label, schema, base) => {
    expect(schema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, limit: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, limit: 10_001 }).success).toBe(false);
  });

  it("caps query and syslog offsets at the advertised bound", () => {
    expect(
      querySchema.safeParse({ table: "incident", offset: 10_000 }).success
    ).toBe(true);
    expect(
      querySchema.safeParse({ table: "incident", offset: 10_001 }).success
    ).toBe(false);
    expect(syslogSchema.safeParse({ offset: 10_000 }).success).toBe(true);
    expect(syslogSchema.safeParse({ offset: 10_001 }).success).toBe(false);
  });

  it("uses stable upstream aggregate ordering with a sentinel group", async () => {
    const get = vi.fn(async () => ({
      result: [
        {
          groupby_fields: [
            { field: "priority", value: "1", display_value: "Critical" },
          ],
          stats: { count: "4" },
        },
        {
          groupby_fields: [
            { field: "priority", value: "2", display_value: "High" },
          ],
          stats: { count: "3" },
        },
        {
          groupby_fields: [
            { field: "priority", value: "3", display_value: "Moderate" },
          ],
          stats: { count: "2" },
        },
      ],
    }));
    const args = aggregateSchema.parse({
      table: "incident",
      type: "COUNT",
      group_by: "priority",
      limit: 2,
      offset: 3,
    });
    const legacy = await aggregateHandler(
      args,
      { get } as never,
      {} as never,
      {} as never
    );
    expect(get).toHaveBeenCalledWith("/api/now/stats/incident", {
      sysparm_count: "true",
      sysparm_group_by: "priority",
      sysparm_limit: "3",
      sysparm_offset: "3",
      sysparm_order_by: "priority",
    });

    const structured = productionToolOutputSchemas.sn_aggregate.parse(
      finalizeEnvelopeResult(
        enrichSuccessfulResult(
          envelopeCompatibilityResult("sn_aggregate", args, legacy),
          PROFILE
        )
      )?.structuredContent
    );
    expect(structured.data.result).toHaveLength(2);
    expect(structured.metadata.pagination).toMatchObject({
      offset: 3,
      returned: 2,
      has_more: true,
      next_offset: 5,
      order_by: ["priority"],
    });
  });

  it("uses the effective 200 run-suite limit and a +1 continuation probe", async () => {
    const suiteId = "a".repeat(32);
    const post = vi.fn(async () => ({ result: {} }));
    const get = vi.fn(async () => ({
      result: Array.from({ length: 201 }, (_, index) => ({
        sys_id: String(index).padStart(32, "0"),
        test: `test-${index}`,
        status: index % 2 === 0 ? "Passed" : "Failed",
      })),
    }));
    const args = atfSchema.parse({
      action: "run-suite",
      suite_sys_id: suiteId,
      limit: 500,
      offset: 7,
      timeout: 0,
    });
    const legacy = await atfHandler(
      args,
      { get, post } as never,
      {} as never,
      {} as never
    );
    expect(post).toHaveBeenCalledWith("/api/sn_atf/rest/suite", {
      suite_id: suiteId,
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]).toMatchObject({
      sysparm_limit: "201",
      sysparm_offset: "7",
      sysparm_query: `test_suite=${suiteId}^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id`,
    });

    const structured = productionToolOutputSchemas.sn_atf.parse(
      finalizeEnvelopeResult(
        enrichSuccessfulResult(
          envelopeCompatibilityResult("sn_atf", args, legacy),
          PROFILE
        )
      )?.structuredContent
    );
    expect(structured.data.result).toMatchObject({
      record_count: 200,
      limit: 200,
      offset: 7,
      has_more: true,
      next_offset: 207,
      summary: { total: 200, passed: 100, failed: 100, skipped: 0 },
    });
    expect(structured.metadata.pagination).toMatchObject({
      limit: 200,
      offset: 7,
      returned: 200,
      has_more: true,
      next_offset: 207,
      order_by: ["-sys_created_on", "-sys_id"],
    });
  });

  it("pages code search across table boundaries without skipping records", async () => {
    const get = vi.fn(async (path: string) => ({
      result: [
        {
          sys_id: `${path.split("/").at(-1)}-id`,
          name: path.split("/").at(-1),
          script: "needle",
          operation_script: "needle",
        },
      ],
    }));
    const args = codeSearchSchema.parse({
      search_term: "needle",
      limit: 2,
      offset: 2,
    });
    const legacy = await codeSearchHandler(
      args,
      { get } as never,
      {} as never,
      {} as never
    );
    const adapted = envelopeCompatibilityResult("sn_codesearch", args, legacy);
    const result = finalizeEnvelopeResult(enrichSuccessfulResult(adapted, PROFILE));
    const structured = productionToolOutputSchemas.sn_codesearch.parse(
      result?.structuredContent
    );

    expect(structured.data.results.map((entry) => (entry as { table: string }).table)).toEqual([
      "sys_script_include",
      "sys_ui_script",
    ]);
    expect(structured.metadata.pagination).toMatchObject({
      offset: 2,
      returned: 2,
      has_more: true,
      next_offset: 4,
    });
    expect(get).toHaveBeenCalledTimes(5);
    for (const call of get.mock.calls) {
      expect(call[1]).toMatchObject({ sysparm_limit: "5", sysparm_offset: "0" });
    }
  });

  it("pages discovered apps over the combined stable source order", async () => {
    const get = vi.fn(async (path: string) => ({
      result: Array.from({ length: 3 }, (_, index) => ({
        sys_id: `${index + 1}`.padStart(32, path.endsWith("sys_app") ? "a" : "b"),
        name: `app-${index + 1}`,
      })),
    }));
    const args = discoverSchema.parse({ type: "apps", limit: 2, offset: 2 });
    const legacy = await discoverHandler(
      args,
      { get } as never,
      {} as never,
      {} as never
    );
    const adapted = envelopeCompatibilityResult("sn_discover", args, legacy);
    const result = finalizeEnvelopeResult(enrichSuccessfulResult(adapted, PROFILE));
    const structured = productionToolOutputSchemas.sn_discover.parse(
      result?.structuredContent
    );
    const records = structured.data.results as Array<{
      source: string;
      sys_id: string;
    }>;

    expect(records.map(({ source }) => source)).toEqual(["scoped", "store"]);
    expect(structured.metadata.pagination).toMatchObject({
      offset: 2,
      returned: 2,
      has_more: true,
      next_offset: 4,
    });
    expect(get).toHaveBeenCalledTimes(2);
    for (const call of get.mock.calls) {
      expect(call[1]).toMatchObject({ sysparm_limit: "5", sysparm_offset: "0" });
    }
  });
});
