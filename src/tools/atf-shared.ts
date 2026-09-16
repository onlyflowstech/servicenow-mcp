import { z } from "zod";
import { filterReadableRecord, prepareAdditionalReadFieldArguments, preparedReadableFields, fieldSelectionToSysparmFields } from "../field-policy.js";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { createToolError } from "../tool-error.js";
import type { AtfRunSummary } from "../atf-result-cache.js";
import type { ServiceNowToolHandlerServices } from "./tool-module.js";
import { escapeQueryValue } from "../utils.js";
import type { AtfExecutionResult } from "./atf-contracts.js";

export const ATF_READ_FIELDS: Record<string, string> = {
  sys_atf_test_suite: "sys_id,name,active,parent",
  sys_atf_test_suite_test: "sys_id,test,test_suite,order",
  sys_atf_test: "sys_id,name,active,sys_scope",
  sys_atf_step: "sys_id,test,step_config,active,order,description",
  sys_atf_step_config: "sys_id,name,step_env",
  sys_atf_test_suite_result: "sys_id,test_suite,parent,status,success,start_time,end_time,run_time,rolled_up_test_success_count,rolled_up_test_failure_count,rolled_up_test_error_count,rolled_up_test_skip_count",
  sys_atf_test_result: "sys_id,test,test_name,parent,status,first_failing_step,start_time,end_time",
  sys_atf_test_result_step: "sys_id,test_result,step,type,status,summary,description",
  v_plugin: "sys_id,id,active",
  sys_properties: "sys_id,name,value",
  sys_scope: "sys_id,name,scope",
  var_dictionary: "sys_id,model_id,element,internal_type,mandatory,order",
  sys_element_mapping: "sys_id,id,table,field,value",
  sys_variable_value: "sys_id,document,document_key,variable,value,order",
};
export const RESULT_TABLES = ["sys_atf_test_suite_result", "sys_atf_test_result", "sys_atf_test_result_step"];
export function prepareAtfReads(args: Record<string, unknown>, tables: readonly string[]): Record<string, unknown> {
  for (const table of tables) args = prepareAdditionalReadFieldArguments(args, table, ATF_READ_FIELDS[table]);
  return args;
}
export function value(candidate: unknown): string {
  if (candidate && typeof candidate === "object" && "value" in candidate) return value(candidate.value);
  return typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean" ? String(candidate) : "";
}
export function display(candidate: unknown): string {
  return candidate && typeof candidate === "object" && "display_value" in candidate ? value(candidate.display_value) : value(candidate);
}
export function record(candidate: unknown): Record<string, unknown> {
  return z.record(z.unknown()).parse(candidate);
}
export async function readAtfRows(services: ServiceNowToolHandlerServices, args: Record<string, unknown>, table: string, query: string, limit = 1000): Promise<Record<string, unknown>[]> {
  const fields = preparedReadableFields(args, table);
  if (!fields) throw new Error("ATF read was not preflighted");
  const response = await services.serviceNow.get<{ result: unknown }>(`/api/now/table/${table}`, {
    sysparm_query: `${query}${query ? "^" : ""}ORDERBYsys_id`, sysparm_fields: fieldSelectionToSysparmFields(fields)!,
    sysparm_display_value: (table === "var_dictionary" || table === "sys_atf_step_config" || table === "sys_atf_test_result_step") ? "all" : "false", sysparm_limit: String(limit + 1),
  });
  const rows = z.array(z.record(z.unknown())).parse(filterReadableRecord(response?.result, fields));
  if (rows.length > limit) throw createToolError("upstream", "retry_after_correction");
  return rows;
}
export async function resolveSuite(services: ServiceNowToolHandlerServices, args: Record<string, unknown>) {
  const rows = await readAtfRows(services, args, "sys_atf_test_suite", args.suite_sys_id ? `sys_id=${id.parse(args.suite_sys_id)}` : `name=${escapeQueryValue(String(args.suite_name))}`, 2);
  if (rows.length !== 1 || value(rows[0].active) !== "true") throw createToolError("not_found", "retry_after_correction");
  return { id: id.parse(value(rows[0].sys_id)), name: value(rows[0].name).slice(0, 100) };
}
const failed = (status: string) => status === "failure" || status === "error";
const passed = (status: string) => status === "success" || status === "success_with_warnings";
export function compareAtfRuns(previous: AtfRunSummary, current: AtfRunSummary, _history: AtfRunSummary[] = [], threshold = 20) {
  if (previous.suiteId !== current.suiteId) throw new Error("Cannot compare different suites");
  const old = new Map(previous.tests.map(test => [test.testId, test.status]));
  const new_failures = current.tests.filter(test => failed(test.status) && !failed(old.get(test.testId) ?? "")).map(test => test.testId);
  const fixed = current.tests.filter(test => passed(test.status) && failed(old.get(test.testId) ?? "")).map(test => test.testId);
  const still_failing = current.tests.filter(test => failed(test.status) && failed(old.get(test.testId) ?? "")).map(test => test.testId);
  return { previous_run: previous.runId, current_run: current.runId, new_failures, fixed, still_failing,
    flaky: [],
    status_changed: current.tests.filter(test => old.has(test.testId) && old.get(test.testId) !== test.status).map(test => test.testId),
    duration_change_ms: current.durationMs - previous.durationMs,
    duration_regression: current.durationMs > previous.durationMs * (1 + threshold / 100),
  };
}
export function progress(candidate: unknown) {
  const row = record(record(candidate).result);
  const status = z.coerce.number().int().min(0).max(4).parse(row.status);
  const links = record(row.links ?? {});
  const progress_id = links.progress ? id.parse(record(links.progress).id) : undefined;
  const result_id = links.results ? id.parse(record(links.results).id) : undefined;
  return { status, progress_id, result_id };
}
export function atfStepLabel(step: Record<string, unknown> | undefined): string {
  return (value(step?.description) || (display(step?.step) !== value(step?.step) ? display(step?.step) : "") || (value(step?.step) ? `Step ${value(step?.step)}` : "Step details unavailable")).slice(0, 1000);
}
export function failureExcerpt(message: string): string {
  if (message.length <= 1000) return message;
  return `${message.slice(0, 450)}\n[… excerpt; retrieve full step details …]\n${message.slice(-450)}`.slice(0, 1000);
}
export async function getAtfExecution(services: ServiceNowToolHandlerServices, args: Record<string, unknown>, resultId: string): Promise<AtfExecutionResult> {
  const result_id = id.parse(resultId);
  const response = record(await services.serviceNow.get(`/api/sn_cicd/testsuite/results/${result_id}`));
  const cicd = record(response.result);
  const output: AtfExecutionResult = { outcome: "completed", result_id, failures: [], warnings: [] };
  // Do not assume the CI/CD id is a table id: verify an actual matching row first.
  const suites = await readAtfRows(services, args, "sys_atf_test_suite_result", `sys_id=${result_id}`, 1);
  if (suites.length !== 1) return { ...output, outcome: "unavailable", warnings: ["CI/CD result has no matching suite-result row; detailed results and caching could not be verified."] };
  const suite = suites[0];
  const suiteId = id.parse(value(suite.test_suite));
  if (args.suite_sys_id && suiteId !== args.suite_sys_id) throw createToolError("upstream", "do_not_retry");
  const resultIds = new Set([result_id]);
  const pending = [result_id];
  while (pending.length) {
    const parent = pending.shift()!;
    const children = await readAtfRows(services, args, "sys_atf_test_suite_result", `parent=${parent}`, 100);
    for (const child of children) {
      const childId = id.parse(value(child.sys_id));
      if (resultIds.has(childId) || resultIds.size >= 100) throw createToolError("upstream", "do_not_retry");
      resultIds.add(childId); pending.push(childId);
    }
  }
  const tests = await readAtfRows(services, args, "sys_atf_test_result", `parentIN${[...resultIds].join(",")}`);
  const failing = tests.filter(test => failed(value(test.status)));
  const failureByTest = new Map<string, string>();
  const failingStepIds = failing.map(test => value(test.first_failing_step)).filter(Boolean).map(candidate => id.parse(candidate));
  const stepRows = failingStepIds.length ? await readAtfRows(services, args, "sys_atf_test_result_step", `sys_idIN${[...new Set(failingStepIds)].join(",")}^type=step_result`) : [];
  for (const test of failing) {
    const testResult = id.parse(value(test.sys_id));
    const step = stepRows.find(row => value(row.sys_id) === value(test.first_failing_step) && value(row.test_result) === testResult);
    const rawMessage = value(step?.summary);
    const message = failureExcerpt(rawMessage);
    const testId = id.parse(value(test.test));
    failureByTest.set(testId, message.slice(0, 500));
    output.failures.push({ test_id: testId, test_name: value(test.test_name).slice(0, 100), step: atfStepLabel(step), message, message_truncated: rawMessage.length > 1000, test_result_id: testResult, ...(step ? { step_result_id: id.parse(value(step.sys_id)) } : {}), ...(value(step?.step) ? { step_id: id.parse(value(step?.step)) } : {}) });
  }
  const instant = (raw: unknown) => {
    const text = value(raw); const date = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
    if (!Number.isFinite(date.getTime())) throw createToolError("upstream", "do_not_retry");
    return date.toISOString();
  };
  const startedAt = instant(suite.start_time);
  const finishedAt = value(suite.end_time) ? instant(suite.end_time) : undefined;
  const statuses = ["pending", "running", "success", "failure", "error", "skipped", "canceled", "success_with_warnings"] as const;
  const run: AtfRunSummary = { runId: result_id, suiteId, startedAt, ...(finishedAt ? { finishedAt } : {}),
    status: z.enum(statuses).parse(value(suite.status) === "started" ? "running" : value(suite.status) === "completed" ? value(suite.success) === "true" ? "success" : "failure" : value(suite.status)), durationMs: finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : 0,
    counts: { passed: 0, failed: 0, errors: 0, skipped: 0 },
    tests: tests.map(test => { const testId = id.parse(value(test.test)); return { testId, status: z.enum(statuses).parse(["waiting", "paused"].includes(value(test.status)) ? "pending" : value(test.status)), ...(failureByTest.has(testId) ? { firstFailure: failureByTest.get(testId)! } : {}) }; }),
  };
  for (const [key, field] of Object.entries({ passed: "success", failed: "failure", errors: "error", skipped: "skip" })) {
    const tableCount = value(suite[`rolled_up_test_${field}_count`]);
    // CI/CD and Table API deliberately use separate field names.
    const apiCount = value(cicd[`rolledup_test_${field}_count`]);
    run.counts[key as keyof typeof run.counts] = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()).parse(tableCount || apiCount);
  }
  if (Object.values(run.counts).reduce((sum, count) => sum + count, 0) !== tests.length) output.warnings.push("Visible test details differ from roll-up counts; comparisons include only visible tests.");
  output.run = run; output.suite_id = suiteId; output.suite_name = value(cicd.test_suite_name).slice(0, 100);
  if (output.failures.length > 0 && failingStepIds.length !== failing.length) output.warnings.push("Some failing tests have no readable first-failing-step reference.");
  if (!finishedAt) output.outcome = "running";
  if (finishedAt && services.atfResults) {
    const history = await services.atfResults.history(suiteId);
    const previous = history.find(entry => entry.runId !== run.runId && entry.startedAt <= run.startedAt);
    if (previous) output.comparison = compareAtfRuns(previous, run, history);
    await services.atfResults.put(run);
  }
  const testsOffset = Number(args.tests_offset ?? 0), testsLimit = Number(args.tests_limit ?? 200);
  const failuresOffset = Number(args.failures_offset ?? 0), failuresLimit = Number(args.failures_limit ?? 10);
  output.pagination = { tests_total: run.tests.length, tests_offset: testsOffset,
    ...(testsOffset + testsLimit < run.tests.length ? { tests_next_offset: testsOffset + testsLimit } : {}),
    failures_total: output.failures.length, failures_offset: failuresOffset,
    ...(failuresOffset + failuresLimit < output.failures.length ? { failures_next_offset: failuresOffset + failuresLimit } : {}),
  };
  if (output.pagination.tests_next_offset !== undefined) output.warnings.push("More test summaries are available: call sn_atf_results get with tests_offset set to pagination.tests_next_offset.");
  if (output.pagination.failures_next_offset !== undefined) output.warnings.push("More failures are available: call sn_atf_results get with failures_offset set to pagination.failures_next_offset.");
  if (output.failures.some(failure => failure.message_truncated)) output.warnings.push("Failure messages contain excerpts. Use sn_atf_results action=step with step_result_id to read complete summary/output in chunks.");
  return { ...output, run: { ...run, tests: run.tests.slice(testsOffset, testsOffset + testsLimit).map(test => ({ testId: test.testId, status: test.status })) }, failures: output.failures.slice(failuresOffset, failuresOffset + failuresLimit) };
}
