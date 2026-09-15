import { z } from "zod";
import { requireAtfExecution } from "../atf-policy.js";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { runWithServiceNowRequestSignal } from "../client.js";
import { trustedToolErrorDescriptor } from "../tool-error.js";
import { ok } from "../utils.js";
import { defineServiceNowToolModule, withRequiredProfile } from "./tool-module.js";
import { envelopeCompatibilityResult, productionToolOutputSchemas } from "./result-envelope.js";
import { RESULT_TABLES, prepareAtfReads, resolveSuite, progress, getAtfExecution } from "./atf-shared.js";
import type { AtfExecutionResult } from "./atf-contracts.js";
import { registerAtfRenderers } from "./atf-renderers.js";

const schema = withRequiredProfile(z.object({
  suite_sys_id: id.optional().describe("Suite sys_id; supply exactly one suite selector"),
  suite_name: z.string().trim().min(1).max(100).optional().describe("Exact unique active suite name"),
  wait: z.boolean().default(true).describe("Wait for completion (default true)"),
  timeout: z.number().int().min(1).max(3600).default(300).describe("Maximum wait in seconds after submission"),
  browser_name: z.string().min(1).max(80).optional().describe("Optional client-runner browser name"),
}).strict());
export function waitForAtfPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
const tables = ["sys_atf_test_suite", ...RESULT_TABLES];
registerAtfRenderers();
export const atfRunToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition: { name: "sn_atf_run", description: "Run an ATF suite through CI/CD with explicit atf.execute permission. Returns progress/result IDs, readable failures and cached comparison. Use sn_atf_readiness first.",
    annotations: { title: "Run an ATF suite", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  inputSchema: schema, outputSchema: productionToolOutputSchemas.sn_atf_run,
  requirements: { permissions: ["read", "write"], tables: { kind: "static", names: tables }, apis: ["cicd", "table"], fieldPolicies: ["read"], capabilities: ["atf:execute"] },
  resolveAccess: (candidate, policy) => {
    const args = schema.parse(candidate);
    if (Boolean(args.suite_sys_id) === Boolean(args.suite_name)) throw new Error("Supply exactly one suite selector");
    requireAtfExecution(policy);
    return { args: prepareAtfReads(args, tables), requests: tables.map(table => ({ operation: "read" as const, table })) };
  },
  handler: async (args, services) => {
    const suite = await resolveSuite(services, args);
    let output: AtfExecutionResult = { outcome: "unavailable", suite_id: suite.id, suite_name: suite.name, failures: [], warnings: [] };
    try {
      const submitted = progress(await services.serviceNow.post("/api/sn_cicd/testsuite/run", {}, {
        test_suite_sys_id: suite.id, ...(args.browser_name ? { browser_name: String(args.browser_name) } : {}),
      }));
      output = { ...output, outcome: "running", progress_id: submitted.progress_id, result_id: submitted.result_id };
      if (!submitted.progress_id && !submitted.result_id) throw new Error("No result locator returned");
      if (!args.wait) return envelopeCompatibilityResult("sn_atf_run", args, ok(output));
      const deadline = new AbortController();
      const timeoutTimer = setTimeout(() => deadline.abort(new Error("ATF wait timed out")), Number(args.timeout) * 1000);
      const signal = AbortSignal.any([deadline.signal, services.context.signal]);
      try {
        output = await runWithServiceNowRequestSignal(signal, async () => {
          let state = submitted;
          let interval = 5000;
          while (state.status < 2) {
            await waitForAtfPoll(interval, signal);
            state = progress(await services.serviceNow.get(`/api/sn_cicd/progress/${id.parse(output.progress_id)}`));
            output.result_id = state.result_id ?? output.result_id;
            interval = Math.min(15000, interval + 2500);
          }
          if (!output.result_id) return { ...output, outcome: "unavailable" as const, warnings: ["Execution ended without a result ID. Inspect the progress record before retrying."] };
          return { ...await getAtfExecution(services, { ...args, suite_sys_id: suite.id }, output.result_id), progress_id: output.progress_id };
        });
      } catch (error) {
        if (services.context.signal.aborted) throw error;
        output.warnings.push(deadline.signal.aborted ? "Wait timed out; the suite may still be running. Follow the progress ID with sn_atf_results get." : "Could not retrieve final results. Follow the returned IDs with sn_atf_results get; do not resubmit the suite.");
      } finally { clearTimeout(timeoutTimer); }
    } catch (error) {
      if (services.context.signal.aborted) throw error;
      const category = trustedToolErrorDescriptor(error)?.category;
      output.warnings.push(category === "authorization" ? "CI/CD access denied. Check the CI/CD role and sn_atf_readiness before retrying." : "Submission or response could not be verified. The suite may have started; inspect the instance before retrying.");
    }
    return envelopeCompatibilityResult("sn_atf_run", args, ok(output));
  },
});
