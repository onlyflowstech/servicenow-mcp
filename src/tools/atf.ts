import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_atf",
  description:
    "Automated Test Framework — list, run, and get results for ATF tests and test suites.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "suites", "run", "run-suite", "results"],
        description: "ATF operation: list tests, list suites, run a test, run a suite, or get results",
      },
      test_sys_id: {
        type: "string",
        description: "Test sys_id (required for run)",
      },
      suite_sys_id: {
        type: "string",
        description: "Suite sys_id (required for run-suite)",
      },
      suite_name: {
        type: "string",
        description: "Filter tests by suite name (for list action)",
      },
      execution_id: {
        type: "string",
        description: "Execution/result sys_id (required for results action)",
      },
      query: {
        type: "string",
        description: "ServiceNow encoded query filter",
      },
      fields: {
        type: "string",
        description: "Comma-separated fields to return",
      },
      limit: {
        type: "number",
        description: "Max results (default 20)",
      },
      wait: {
        type: "boolean",
        description: "Wait for test/suite completion (default true)",
      },
      timeout: {
        type: "number",
        description: "Max wait time in seconds (default 120 for tests, 300 for suites)",
      },
    },
    required: ["action"],
  },
};

export const schema = z.object({
  action: z.enum(["list", "suites", "run", "run-suite", "results"]),
  test_sys_id: z.string().optional(),
  suite_sys_id: z.string().optional(),
  suite_name: z.string().optional(),
  execution_id: z.string().optional(),
  query: z.string().optional(),
  fields: z.string().optional(),
  limit: z.number().optional().default(20),
  wait: z.boolean().optional().default(true),
  timeout: z.number().optional(),
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    switch (args.action) {
      // ── list tests ──
      case "list": {
        const fields =
          args.fields || "sys_id,name,description,active,sys_updated_on";
        let query = args.query || "";

        // If suite_name given, resolve suite and filter tests
        if (args.suite_name) {
          const suiteResp = await client.get(
            "/api/now/table/sys_atf_test_suite",
            {
              sysparm_query: `name=${args.suite_name}`,
              sysparm_fields: "sys_id,name",
              sysparm_limit: "1",
            }
          );
          const suiteId = suiteResp.result?.[0]?.sys_id;
          if (!suiteId) return err(`Suite not found: ${args.suite_name}`);

          // Get test IDs from M2M table
          const m2mResp = await client.get(
            "/api/now/table/sys_atf_test_suite_test",
            {
              sysparm_query: `test_suite=${suiteId}`,
              sysparm_fields: "test",
              sysparm_limit: "500",
            }
          );
          const testIds = (m2mResp.result || [])
            .map((r: Record<string, string>) => r.test)
            .filter(Boolean)
            .join(",");
          if (!testIds)
            return ok({ record_count: 0, results: [] });

          const suiteFilter = `sys_idIN${testIds}`;
          query = query ? `${suiteFilter}^${query}` : suiteFilter;
        }

        const resp = await client.get("/api/now/table/sys_atf_test", {
          sysparm_limit: String(args.limit),
          sysparm_fields: fields,
          ...(query ? { sysparm_query: query } : {}),
        });
        const results = resp.result || [];
        return ok({ record_count: results.length, results });
      }

      // ── list suites ──
      case "suites": {
        const fields = args.fields || "sys_id,name,description,active";
        const resp = await client.get("/api/now/table/sys_atf_test_suite", {
          sysparm_limit: String(args.limit),
          sysparm_fields: fields,
          ...(args.query ? { sysparm_query: args.query } : {}),
        });
        const results = resp.result || [];
        return ok({ record_count: results.length, results });
      }

      // ── run single test ──
      case "run": {
        if (!args.test_sys_id) return err("test_sys_id is required for run");

        const timeout = args.timeout ?? 120;
        let runResp: any;

        // Try sn_atf REST API first
        try {
          runResp = await client.post("/api/sn_atf/rest/test", {
            test_id: args.test_sys_id,
          });
        } catch {
          // Fallback: try /api/now/atf/test/{id}/run
          try {
            runResp = await client.post(
              `/api/now/atf/test/${args.test_sys_id}/run`
            );
          } catch {
            // Last fallback: schedule via Table API
            try {
              runResp = await client.post(
                "/api/now/table/sys_atf_test_result",
                {
                  test: args.test_sys_id,
                  status: "scheduled",
                }
              );
            } catch (e) {
              return err(
                "All ATF execution methods failed. Ensure ATF plugin is active and user has atf_admin role."
              );
            }
          }
        }

        const resultId =
          runResp?.result?.sys_id || runResp?.result?.result_id;
        const trackerId =
          runResp?.result?.tracker_id || runResp?.result?.progress_id;

        if (!args.wait) {
          return ok(runResp?.result || runResp);
        }

        // Poll for completion
        return await pollTestResult(
          client,
          args.test_sys_id,
          resultId,
          trackerId,
          timeout
        );
      }

      // ── run suite ──
      case "run-suite": {
        if (!args.suite_sys_id)
          return err("suite_sys_id is required for run-suite");

        const timeout = args.timeout ?? 300;
        let runResp: any;

        try {
          runResp = await client.post("/api/sn_atf/rest/suite", {
            suite_id: args.suite_sys_id,
          });
        } catch {
          try {
            runResp = await client.post(
              `/api/now/atf/suite/${args.suite_sys_id}/run`
            );
          } catch {
            return err(
              "Suite execution failed. Ensure ATF plugin is active and user has atf_admin role."
            );
          }
        }

        if (!args.wait) {
          return ok(runResp?.result || runResp);
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
                `/api/now/table/sys_execution_tracker/${trackerId}`,
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
        const resultsResp = await client.get(
          "/api/now/table/sys_atf_test_result",
          {
            sysparm_query: `test_suite=${args.suite_sys_id}^ORDERBYDESCsys_created_on`,
            sysparm_fields:
              "sys_id,test,status,output,duration,start_time,end_time",
            sysparm_display_value: "true",
            sysparm_limit: "200",
          }
        );

        const testResults = resultsResp.result || [];
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

        return ok({
          suite_sys_id: args.suite_sys_id,
          summary: {
            total: testResults.length,
            passed,
            failed,
            skipped,
          },
          results: testResults,
        });
      }

      // ── results ──
      case "results": {
        if (!args.execution_id) return err("execution_id is required for results");

        const fields =
          args.fields ||
          "sys_id,test,status,output,duration,start_time,end_time";

        // Try direct get first
        try {
          const resp = await client.get(
            `/api/now/table/sys_atf_test_result/${args.execution_id}`,
            {
              sysparm_fields: fields,
              sysparm_display_value: "true",
            }
          );
          if (resp.result?.sys_id) {
            return ok(resp.result);
          }
        } catch {
          // Not found by direct ID — try query
        }

        const query = `execution=${args.execution_id}^ORparent=${args.execution_id}^ORtest_suite=${args.execution_id}`;
        const resp = await client.get("/api/now/table/sys_atf_test_result", {
          sysparm_query: query,
          sysparm_fields: fields,
          sysparm_display_value: "true",
          sysparm_limit: String(args.limit),
        });
        const results = resp.result || [];
        return ok({ record_count: results.length, results });
      }

      default:
        return err(`Unknown ATF action: ${args.action}`);
    }
  } catch (error) {
    return err(formatError(error));
  }
}

async function pollTestResult(
  client: ServiceNowClient,
  testId: string,
  resultId: string | undefined,
  trackerId: string | undefined,
  timeout: number
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
          `/api/now/table/sys_atf_test_result/${currentResultId}`,
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
          `/api/now/table/sys_execution_tracker/${trackerId}`,
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
          sysparm_query: `test=${testId}^ORDERBYDESCsys_created_on`,
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
        `/api/now/table/sys_atf_test_result/${currentResultId}`,
        {
          sysparm_fields:
            "sys_id,test,status,output,duration,start_time,end_time",
          sysparm_display_value: "true",
        }
      );
      return ok(resp.result);
    } catch {
      return ok({ status: "timeout", message: `Timed out after ${timeout}s` });
    }
  }

  return ok({ status: "timeout", message: `Timed out after ${timeout}s` });
}
