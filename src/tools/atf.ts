import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  authorizeRawEncodedRead,
  ENCODED_QUERY_MIGRATION_MESSAGE,
} from "../encoded-query-policy.js";
import {
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { ok, err, escapeQueryValue, formatError, withWarnings } from "../utils.js";
import {
  normalizeServiceNowSysId,
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";
import { trustedToolErrorDescriptor } from "../tool-error.js";

export const definition = {
  name: "sn_atf",
  description:
    "Automated Test Framework — list, run, and get results for ATF tests and test suites.",
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

interface AtfRunResult {
  readonly sys_id?: string;
  readonly result_id?: string;
  readonly tracker_id?: string;
  readonly progress_id?: string;
  readonly [key: string]: unknown;
}

interface AtfRunResponse {
  readonly result?: AtfRunResult;
}

/** A trusted not-found proves this invocation endpoint did not execute. */
function isSafeEndpointFallback(error: unknown): boolean {
  const descriptor = trustedToolErrorDescriptor(error);
  return (
    descriptor?.category === "not_found" &&
    descriptor.retry === "do_not_retry"
  );
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
        const fields = readableFields.join(",");
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
            .filter(Boolean)
            .join(",");
          if (!testIds)
            return ok({ record_count: 0, results: [] });

          const suiteFilter = `sys_idIN${testIds}`;
          query = query ? `${suiteFilter}^${query}` : suiteFilter;
        }

        const resp = await client.get("/api/now/table/sys_atf_test", {
          sysparm_limit: String(args.limit + 1),
          sysparm_offset: String(args.offset),
          sysparm_fields: fields,
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
        const fields = readableFields.join(",");
        const resp = await client.get("/api/now/table/sys_atf_test_suite", {
          sysparm_limit: String(args.limit + 1),
          sysparm_offset: String(args.offset),
          sysparm_fields: fields,
          sysparm_query: "ORDERBYsys_id",
        });
        const filtered = filterReadableRecord(resp.result || [], readableFields);
        const results = Array.isArray(filtered) ? filtered : [];
        return ok(pagedResult(results, args.offset, args.limit));
      }

      // ── run single test ──
      case "run": {
        if (!args.test_sys_id) return err("test_sys_id is required for run");

        const timeout = args.timeout ?? 120;
        // Each fallback strategy that fails is recorded so the caller can
        // see which execution paths were tried and why they failed.
        const warnings: string[] = [];
        let runResp: AtfRunResponse | null;

        // Try sn_atf REST API first
        try {
          runResp = await client.post<AtfRunResponse>("/api/sn_atf/rest/test", {
            test_id: args.test_sys_id,
          });
        } catch (error) {
          if (!isSafeEndpointFallback(error)) throw error;
          warnings.push(`POST /api/sn_atf/rest/test: ${formatError(error)}`);
          // Fallback: try /api/now/atf/test/{id}/run
          try {
            runResp = await client.post<AtfRunResponse>(
              `/api/now/atf/test/${serviceNowSysIdPathSegment(args.test_sys_id)}/run`
            );
          } catch (error2) {
            if (!isSafeEndpointFallback(error2)) throw error2;
            warnings.push(
              `POST /api/now/atf/test/{id}/run: ${formatError(error2)}`
            );
            // Last fallback: schedule via Table API
            try {
              runResp = await client.post<AtfRunResponse>(
                "/api/now/table/sys_atf_test_result",
                {
                  test: args.test_sys_id,
                  status: "scheduled",
                }
              );
            } catch (error3) {
              throw error3;
            }
          }
        }

        const resultId =
          runResp?.result?.sys_id || runResp?.result?.result_id;
        const trackerId =
          runResp?.result?.tracker_id || runResp?.result?.progress_id;

        if (!args.wait) {
          return ok(withWarnings(runResp?.result || runResp, warnings));
        }

        // Poll for completion
        return await pollTestResult(
          client,
          args.test_sys_id,
          resultId,
          trackerId,
          timeout,
          warnings
        );
      }

      // ── run suite ──
      case "run-suite": {
        if (!args.suite_sys_id)
          return err("suite_sys_id is required for run-suite");

        const timeout = args.timeout ?? 300;
        // Record failed fallback strategies (same pattern as "run").
        const warnings: string[] = [];
        let runResp: AtfRunResponse | null;

        try {
          runResp = await client.post<AtfRunResponse>("/api/sn_atf/rest/suite", {
            suite_id: args.suite_sys_id,
          });
        } catch (error) {
          if (!isSafeEndpointFallback(error)) throw error;
          warnings.push(`POST /api/sn_atf/rest/suite: ${formatError(error)}`);
          try {
            runResp = await client.post<AtfRunResponse>(
              `/api/now/atf/suite/${serviceNowSysIdPathSegment(args.suite_sys_id)}/run`
            );
          } catch (error2) {
            throw error2;
          }
        }

        if (!args.wait) {
          return ok(withWarnings(runResp?.result || runResp, warnings));
        }

        // Poll tracker
        const trackerId =
          runResp?.result?.tracker_id || runResp?.result?.progress_id;
        let elapsed = 0;
        const pollInterval = 5;

        while (elapsed < timeout) {
          await sleep(pollInterval * 1000);
          elapsed += pollInterval;

          if (trackerId) {
            try {
              const trackerResp = await client.get(
                `/api/now/table/sys_execution_tracker/${serviceNowSysIdPathSegment(trackerId)}`,
                {
                  sysparm_fields: "state,result,message,completion_percent",
                  sysparm_display_value: "true",
                }
              );
              const state = trackerResp.result?.state;
              if (
                state === "Successful" ||
                state === "Failed" ||
                state === "Cancelled"
              ) {
                break;
              }
            } catch {
              // continue polling
            }
          }
        }

        // Fetch suite results
        const effectiveLimit = Math.min(args.limit, 200);
        const resultsResp = await client.get(
          "/api/now/table/sys_atf_test_result",
          {
            sysparm_query: `test_suite=${escapeQueryValue(args.suite_sys_id)}^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id`,
            sysparm_fields:
              "sys_id,test,status,output,duration,start_time,end_time",
            sysparm_display_value: "true",
            sysparm_limit: String(effectiveLimit + 1),
            sysparm_offset: String(args.offset),
          }
        );

        const rawTestResults = Array.isArray(resultsResp.result)
          ? resultsResp.result
          : [];
        const page = pagedResult(
          rawTestResults,
          args.offset,
          effectiveLimit
        );
        const testResults = page.results as Array<Record<string, string>>;
        const passed = testResults.filter(
          (r: Record<string, string>) =>
            r.status === "Success" || r.status === "Pass" || r.status === "Passed"
        ).length;
        const failed = testResults.filter(
          (r: Record<string, string>) =>
            r.status === "Failure" ||
            r.status === "Fail" ||
            r.status === "Failed" ||
            r.status === "Error"
        ).length;
        const skipped = testResults.filter(
          (r: Record<string, string>) =>
            r.status === "Skipped" || r.status === "Cancelled"
        ).length;

        return ok(
          withWarnings(
            {
              suite_sys_id: args.suite_sys_id,
              record_count: page.record_count,
              limit: page.limit,
              offset: page.offset,
              has_more: page.has_more,
              ...(page.next_offset === undefined
                ? {}
                : { next_offset: page.next_offset }),
              summary: {
                total: testResults.length,
                passed,
                failed,
                skipped,
              },
              results: testResults,
            },
            warnings
          )
        );
      }

      // ── results ──
      case "results": {
        if (!args.execution_id) return err("execution_id is required for results");

        const readableFields =
          preparedReadableFields(args, "sys_atf_test_result") ??
          resolveReadableFields("sys_atf_test_result", { fields: args.fields });
        const fields = readableFields.join(",");

        // Try direct get first
        try {
          const resp = await client.get(
            `/api/now/table/sys_atf_test_result/${serviceNowSysIdPathSegment(args.execution_id)}`,
            {
              sysparm_fields: fields,
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
          sysparm_fields: fields,
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

async function pollTestResult(
  client: ServiceNowOperations,
  testId: string,
  resultId: string | undefined,
  trackerId: string | undefined,
  timeout: number,
  warnings: string[]
) {
  let elapsed = 0;
  const pollInterval = 5;
  let status = "";
  let currentResultId = resultId;

  while (elapsed < timeout) {
    await sleep(pollInterval * 1000);
    elapsed += pollInterval;

    if (currentResultId) {
      try {
        const resp = await client.get(
          `/api/now/table/sys_atf_test_result/${serviceNowSysIdPathSegment(currentResultId)}`,
          {
            sysparm_fields:
              "sys_id,test,status,output,duration,start_time,end_time",
            sysparm_display_value: "true",
          }
        );
        status = resp.result?.status || "";
      } catch {
        // continue
      }
    } else if (trackerId) {
      try {
        const resp = await client.get(
          `/api/now/table/sys_execution_tracker/${serviceNowSysIdPathSegment(trackerId)}`,
          {
            sysparm_fields: "state,result,message",
            sysparm_display_value: "true",
          }
        );
        const state = resp.result?.state;
        if (
          state === "Successful" ||
          state === "Failed" ||
          state === "Cancelled"
        ) {
          status = "complete";
        }
      } catch {
        // continue
      }
    } else {
      // Poll by test sys_id
      try {
        const resp = await client.get("/api/now/table/sys_atf_test_result", {
          sysparm_query: `test=${escapeQueryValue(normalizeServiceNowSysId(testId))}^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id`,
          sysparm_fields:
            "sys_id,test,status,output,duration,start_time,end_time",
          sysparm_display_value: "true",
          sysparm_limit: "1",
        });
        if (resp.result?.[0]) {
          status = resp.result[0].status || "";
          currentResultId = resp.result[0].sys_id;
        }
      } catch {
        // continue
      }
    }

    const sl = status.toLowerCase();
    if (
      [
        "success",
        "pass",
        "passed",
        "failure",
        "fail",
        "failed",
        "error",
        "complete",
        "skipped",
        "cancelled",
      ].includes(sl)
    ) {
      break;
    }
  }

  // Fetch final result
  if (currentResultId) {
    try {
      const resp = await client.get(
        `/api/now/table/sys_atf_test_result/${serviceNowSysIdPathSegment(currentResultId)}`,
        {
          sysparm_fields:
            "sys_id,test,status,output,duration,start_time,end_time",
          sysparm_display_value: "true",
        }
      );
      return ok(withWarnings(resp.result, warnings));
    } catch {
      return ok(
        withWarnings(
          { status: "timeout", message: `Timed out after ${timeout}s` },
          warnings
        )
      );
    }
  }

  return ok(
    withWarnings(
      { status: "timeout", message: `Timed out after ${timeout}s` },
      warnings
    )
  );
}
