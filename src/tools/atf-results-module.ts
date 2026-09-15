import { z } from "zod";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { ok } from "../utils.js";
import { defineServiceNowToolModule, withRequiredProfile } from "./tool-module.js";
import { envelopeCompatibilityResult, productionToolOutputSchemas } from "./result-envelope.js";
import { RESULT_TABLES, prepareAtfReads, progress, getAtfExecution, compareAtfRuns } from "./atf-shared.js";

const schema = withRequiredProfile(z.object({
  action: z.enum(["get", "history", "compare"]).describe("Fetch current results, read cached history, or compare cached runs"),
  limit: z.number().int().min(1).max(100).default(10).describe("Maximum cached runs to display in history (default 10)"),
  result_id: id.optional().describe("CI/CD result ID for get, or current cached run ID for compare"),
  progress_id: id.optional().describe("CI/CD progress ID for get while awaiting a result"),
  suite_sys_id: id.optional().describe("Suite ID required for history or compare unless selecting test history"),
  test_sys_id: id.optional().describe("Test ID for history across cached suites"),
  previous_result_id: id.optional().describe("Previous cached run ID for compare"),
  regression_percent: z.number().min(0).max(10000).default(20).describe("Duration regression threshold, percent (default 20)"),
}).strict());
export const atfResultsToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition: { name: "sn_atf_results", description: "Get ATF suite results or inspect cached history/comparisons. History and compare need no ServiceNow network requests. Results may include untrusted failure text.",
    annotations: { title: "Read ATF results", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  inputSchema: schema, outputSchema: productionToolOutputSchemas.sn_atf_results,
  requirements: { permissions: ["read"], tables: { kind: "static", names: RESULT_TABLES }, apis: ["cicd", "table"], fieldPolicies: ["read"], capabilities: ["atf:results"] },
  resolveAccess: candidate => {
    const args = schema.parse(candidate);
    if (args.action === "get" ? Boolean(args.result_id) === Boolean(args.progress_id) : !args.suite_sys_id && !(args.action === "history" && args.test_sys_id)) throw new Error("Missing or ambiguous result selector");
    if (args.suite_sys_id && args.test_sys_id || args.action !== "history" && args.test_sys_id || args.action !== "get" && args.progress_id || args.action === "history" && (args.result_id || args.previous_result_id)) throw new Error("Selectors do not match the requested action");
    return { args: prepareAtfReads(args, RESULT_TABLES), requests: RESULT_TABLES.map(table => ({ operation: "read" as const, table })) };
  },
  handler: async (args, services) => {
    const finish = (data: Record<string, unknown>) => envelopeCompatibilityResult("sn_atf_results", args, ok({ action: args.action, ...data }));
    if (args.action === "get") {
      let resultId = args.result_id as string | undefined;
      if (args.progress_id) {
        const state = progress(await services.serviceNow.get(`/api/sn_cicd/progress/${id.parse(args.progress_id)}`));
        resultId = state.result_id;
        if (!resultId) return finish({ execution: { outcome: state.status < 2 ? "running" : "unavailable", progress_id: args.progress_id, failures: [], warnings: state.status < 2 ? [] : ["Execution ended without a results link."] } });
      }
      return finish({ execution: await getAtfExecution(services, args, id.parse(resultId)) });
    }
    if (!services.atfResults) throw new Error("ATF cache service is unavailable");
    const runs = args.test_sys_id ? await services.atfResults.testHistory(String(args.test_sys_id)) : await services.atfResults.history(String(args.suite_sys_id));
    if (args.action === "history") return finish({ runs: runs.slice(0, Number(args.limit)).map(run => ({ ...run, tests: [] })), message: runs.length ? "History shows run summaries; use get for per-test detail." : "No cached runs. Run sn_atf_run first." });
    const current = args.result_id ? runs.find(run => run.runId === args.result_id) : runs[0];
    const previous = args.previous_result_id ? runs.find(run => run.runId === args.previous_result_id) : runs.find(run => run.runId !== current?.runId && run.startedAt <= (current?.startedAt ?? ""));
    if (!current || !previous) return finish({ message: "Two matching cached runs are required. Run sn_atf_run first." });
    return finish({ comparison: compareAtfRuns(previous, current, runs, Number(args.regression_percent)) });
  },
});
