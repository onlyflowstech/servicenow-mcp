import { z } from "zod";
import { value } from "./atf-shared.js";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  authorizeRawEncodedRead,
  ENCODED_QUERY_MIGRATION_MESSAGE,
} from "../encoded-query-policy.js";
import {
  fieldSelectionToSysparmFields,
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { ok, err, escapeQueryValue } from "../utils.js";
import {
  normalizeServiceNowSysId,
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";

export const definition = {
  name: "sn_atf",
  description:
    "Automated Test Framework — list tests/suites and read legacy results. Run actions return migration guidance for sn_atf_run.",
  annotations: {
    title: "Run ATF tests",
    // run/run-suite EXECUTE tests on the instance and create test-result
    // records (list/suites/results are reads), so this is not read-only;
    // ATF runs roll themselves back, so nothing is destroyed.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const schema = z.object({
  action: z.enum(["list", "suites", "run", "run-suite", "results"]).describe("ATF operation: list tests, list suites, run a test, run a suite, or get results"),
  test_sys_id: serviceNowSysIdSchema.optional().describe("32-hex test sys_id (required for run)"),
  suite_sys_id: serviceNowSysIdSchema.optional().describe("32-hex suite sys_id (required for run-suite)"),
  suite_name: z.string().optional().describe("Filter tests by suite name (for list action)"),
  execution_id: serviceNowSysIdSchema.optional().describe("32-hex execution/result sys_id (required for results action)"),
  fields: z.string().optional().describe("Comma-separated fields to return"),
  limit: z.number().int().min(1).max(1000).optional().default(20).describe("Max results (default 20, max 1000)"),
  offset: z.number().int().min(0).max(10000).optional().default(0).describe("Deterministic result offset (default 0)"),
  wait: z.boolean().optional().default(true).describe("Wait for test/suite completion (default true)"),
  timeout: z.number().optional().describe("Max wait time in seconds (default 120 for tests, 300 for suites)"),
}).strict(ENCODED_QUERY_MIGRATION_MESSAGE);

function pagedResult(
  records: readonly unknown[],
  offset: number,
  limit: number
): Record<string, unknown> {
  const results = records.slice(0, limit);
  const hasMore = records.length > limit;
  return {
    record_count: results.length,
    limit,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + limit } : {}),
    results,
  };
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  try {
    const rawQuery = (args as unknown as Readonly<Record<string, unknown>>).query;
    if (rawQuery !== undefined) {
      const targetTable =
        args.action === "suites"
          ? "sys_atf_test_suite"
          : args.action === "results"
            ? "sys_atf_test_result"
            : "sys_atf_test";
      authorizeRawEncodedRead(_context?.effectivePolicy.encodedQueryAccess, {
        tool: "sn_atf",
        table: targetTable,
        query: rawQuery,
        limit: args.limit,
        offset: args.offset,
        maxResponseBytes: 100_000,
        outputFields: [],
      });
    }
    switch (args.action) {
      // ── list tests ──
      case "list": {
        const readableFields =
          preparedReadableFields(args, "sys_atf_test") ??
          resolveReadableFields("sys_atf_test", { fields: args.fields });
        const fields = fieldSelectionToSysparmFields(readableFields);
        let query = "";

        // If suite_name given, resolve suite and filter tests
        if (args.suite_name) {
          const suiteResp = await client.get(
            "/api/now/table/sys_atf_test_suite",
            {
              sysparm_query: `name=${escapeQueryValue(args.suite_name)}^ORDERBYsys_id`,
              sysparm_fields: "sys_id,name",
              sysparm_limit: "1",
            }
          );
          const suiteFields =
            preparedReadableFields(args, "sys_atf_test_suite") ??
            resolveReadableFields("sys_atf_test_suite", {
              fields: "sys_id,name",
            });
          const filteredSuites = filterReadableRecord(
            suiteResp.result || [],
            suiteFields
          );
          const suiteRecord = Array.isArray(filteredSuites)
            ? filteredSuites[0]
            : undefined;
          const suiteId =
            typeof suiteRecord === "object" &&
            suiteRecord !== null &&
            !Array.isArray(suiteRecord)
              ? (suiteRecord as Record<string, unknown>).sys_id
              : undefined;
          if (typeof suiteId !== "string" || !suiteId) {
            return err(`Suite not found: ${args.suite_name}`);
          }

          // Get test IDs from M2M table
          const m2mResp = await client.get(
            "/api/now/table/sys_atf_test_suite_test",
            {
              sysparm_query: `test_suite=${escapeQueryValue(suiteId)}^ORDERBYtest`,
              sysparm_fields: "test",
              sysparm_limit: "500",
            }
          );
          const m2mFields =
            preparedReadableFields(args, "sys_atf_test_suite_test") ??
            resolveReadableFields("sys_atf_test_suite_test", { fields: "test" });
          const filteredM2m = filterReadableRecord(
            m2mResp.result || [],
            m2mFields
          );
          const testIds = (Array.isArray(filteredM2m) ? filteredM2m : [])
            .map((r) =>
              typeof r === "object" && r !== null && !Array.isArray(r)
                ? (r as Record<string, unknown>).test
                : undefined
            )
            .map(value)
            .filter(Boolean)
            .map(candidate => serviceNowSysIdSchema.parse(candidate))
            .join(",");
          if (!testIds)
            return ok({ record_count: 0, results: [] });

          const suiteFilter = `sys_idIN${testIds}`;
          query = query ? `${suiteFilter}^${query}` : suiteFilter;
        }

        const resp = await client.get("/api/now/table/sys_atf_test", {
          sysparm_limit: String(args.limit + 1),
          sysparm_offset: String(args.offset),
          ...(fields ? { sysparm_fields: fields } : {}),
          sysparm_query: query ? `${query}^ORDERBYsys_id` : "ORDERBYsys_id",
        });
        const filtered = filterReadableRecord(resp.result || [], readableFields);
        const results = Array.isArray(filtered) ? filtered : [];
        return ok(pagedResult(results, args.offset, args.limit));
      }

      // ── list suites ──
      case "suites": {
        const readableFields =
          preparedReadableFields(args, "sys_atf_test_suite") ??
          resolveReadableFields("sys_atf_test_suite", { fields: args.fields });
        const fields = fieldSelectionToSysparmFields(readableFields);
        const resp = await client.get("/api/now/table/sys_atf_test_suite", {
          sysparm_limit: String(args.limit + 1),
          sysparm_offset: String(args.offset),
          ...(fields ? { sysparm_fields: fields } : {}),
          sysparm_query: "ORDERBYsys_id",
        });
        const filtered = filterReadableRecord(resp.result || [], readableFields);
        const results = Array.isArray(filtered) ? filtered : [];
        return ok(pagedResult(results, args.offset, args.limit));
      }

      case "run":
      case "run-suite":
        return ok({ status: "migration_required", message: "Use sn_atf_run with a suite_sys_id or suite_name and a profile with atf.execute=true. Single-test runs are no longer supported; add the test to a suite." });

      // ── results ──
      case "results": {
        if (!args.execution_id) return err("execution_id is required for results");

        const readableFields =
          preparedReadableFields(args, "sys_atf_test_result") ??
          resolveReadableFields("sys_atf_test_result", { fields: args.fields });
        const fields = fieldSelectionToSysparmFields(readableFields);

        // Try direct get first
        try {
          const resp = await client.get(
            `/api/now/table/sys_atf_test_result/${serviceNowSysIdPathSegment(args.execution_id)}`,
            {
              ...(fields ? { sysparm_fields: fields } : {}),
              sysparm_display_value: "true",
            }
          );
          const filtered = filterReadableRecord(resp.result, readableFields);
          if (
            typeof filtered === "object" &&
            filtered !== null &&
            !Array.isArray(filtered) &&
            (filtered as Record<string, unknown>).sys_id
          ) {
            return ok(filtered);
          }
        } catch {
          // Not found by direct ID — try query
        }

        const executionId = escapeQueryValue(args.execution_id);
        const safeExecutionId = normalizeServiceNowSysId(executionId);
        const query = `execution=${safeExecutionId}^ORparent=${safeExecutionId}^ORtest_suite=${safeExecutionId}`;
        const resp = await client.get("/api/now/table/sys_atf_test_result", {
          sysparm_query: `${query}^ORDERBYsys_id`,
          ...(fields ? { sysparm_fields: fields } : {}),
          sysparm_display_value: "true",
          sysparm_limit: String(args.limit + 1),
          sysparm_offset: String(args.offset),
        });
        const filtered = filterReadableRecord(resp.result || [], readableFields);
        const results = Array.isArray(filtered) ? filtered : [];
        return ok(pagedResult(results, args.offset, args.limit));
      }

      default:
        return err(`Unknown ATF action: ${args.action}`);
    }
  } catch (error) {
    throw error;
  }
}
