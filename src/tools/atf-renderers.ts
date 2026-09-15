import { registerEnvelopeTextRenderer } from "./result-envelope.js";
import { headline, renderMarkdown, table, text, recordLink, formatDuration } from "./markdown.js";
import type { z } from "zod";
import type { atfComparisonSchema } from "./atf-contracts.js";
import type { AtfExecutionResult } from "./atf-contracts.js";
import type { AtfRunSummary } from "../atf-result-cache.js";
let registered = false;
function execution(data: AtfExecutionResult, origin = "") {
  const run = data.run;
  return renderMarkdown(
    headline(`Suite ${data.suite_name ?? data.suite_id ?? ""}: ${run?.status ?? data.outcome}`, { status: run?.status === "success" ? "pass" : data.outcome !== "completed" || run?.status === "success_with_warnings" ? "warn" : "fail" }),
    run ? text(`${run.counts.passed} passed, ${run.counts.failed} failed, ${run.counts.errors} errors, ${run.counts.skipped} skipped in ${formatDuration(run.durationMs)}`) : null,
    data.result_id ? recordLink(origin, "sys_atf_test_suite_result", data.result_id, "Open suite result") : null,
    data.progress_id ? text(`Progress ID: ${data.progress_id}`) : null,
    data.failures.length ? table(["Test", "Step", "Failure (untrusted)"], data.failures.map(row => [row.test_name, row.step, row.message])) : null,
    data.comparison ? text(`${data.comparison.new_failures.length} new failures; ${data.comparison.fixed.length} fixed; ${data.comparison.still_failing.length} still failing`) : null,
    ...data.warnings.map(warning => text(warning)),
  );
}
export function registerAtfRenderers(): void {
  if (registered) return; registered = true;
  registerEnvelopeTextRenderer("sn_atf", (envelope, context) => {
    const data = envelope.data as { action: string; result: { message?: string } };
    return data.action === "run" || data.action === "run-suite" ? renderMarkdown(text(data.result.message)) : context.summary;
  });
  registerEnvelopeTextRenderer("sn_atf_run", (envelope, context) => execution(envelope.data as AtfExecutionResult, context.instanceOrigin));
  registerEnvelopeTextRenderer("sn_atf_results", (envelope, context) => {
    const data = envelope.data as { execution?: AtfExecutionResult; runs?: AtfRunSummary[]; message?: string; comparison?: z.infer<typeof atfComparisonSchema> };
    if (data.execution) return execution(data.execution, context.instanceOrigin);
    if (data.runs) return renderMarkdown(headline("ATF history"), table(["Run", "Started", "Status", "Duration"], data.runs.map(run => [run.runId, run.startedAt, run.status, formatDuration(run.durationMs)])), text(data.message ?? context.summary));
    const comparison = data.comparison;
    return renderMarkdown(headline("ATF comparison"), text(data.message),
      comparison ? text(`Runs ${comparison.previous_run} → ${comparison.current_run}`) : null,
      comparison ? table(["Change", "Test IDs"], [
        ["New failures", comparison.new_failures.join(", ") || "None"],
        ["Fixed", comparison.fixed.join(", ") || "None"],
        ["Still failing", comparison.still_failing.join(", ") || "None"],
        ["Intermittent", comparison.flaky.join(", ") || "None"],
      ]) : null,
      comparison ? text(`Duration change: ${comparison.duration_change_ms} ms${comparison.duration_regression ? " (regression)" : ""}`) : null);

  });
  registerEnvelopeTextRenderer("sn_atf_readiness", envelope => {
    const data = envelope.data as { verdict: string; checks: { check: string; status: string; message: string }[] };
    return renderMarkdown(headline(`ATF readiness: ${data.verdict}`), table(["Check", "Status", "Action"], data.checks.map(check => [check.check, check.status, check.message])));
  });
}
