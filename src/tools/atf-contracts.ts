import { z } from "zod";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { atfRunSummarySchema } from "../atf-result-cache.js";
const name = z.string().max(100);
export const atfComparisonSchema = z.object({
  previous_run: id, current_run: id,
  new_failures: z.array(id), fixed: z.array(id), still_failing: z.array(id), flaky: z.array(id).describe("Deprecated; empty because status history alone cannot establish flakiness"),
  status_changed: z.array(id),
  duration_change_ms: z.number(), duration_regression: z.boolean(),
}).strict();
/** The sentence that points at a failure's full step output; the id is each failure's `step_result_id`. */
export const ATF_STEP_DETAIL_ADVICE =
  "Full details of a failed step: sn_atf_results action=step step_result_id=<failures[].step_result_id> (output_field=summary or output).";
/** What the author tool says after an insert whose outcome it could not confirm. */
export const ATF_UNCERTAIN_INSERT_ADVICE = "The last insert may have succeeded without a usable response; inspect the instance before retrying.";
/** The record `result_id` names; the text links to it. */
export const ATF_SUITE_RESULT_TABLE = "sys_atf_test_suite_result";
/**
 * The run of one execution result. A result row can have an empty suite
 * reference, so the suite is optional here; cached history always
 * has one.
 */
export const atfExecutionRunSchema = atfRunSummarySchema.extend({ suiteId: id.optional() });
export type AtfExecutionRun = z.infer<typeof atfExecutionRunSchema>;
export const atfExecutionResultSchema = z.object({
  outcome: z.enum(["running", "completed", "unavailable"]),
  progress_id: id.optional(), result_id: id.optional(), suite_id: id.optional(), suite_name: name.optional(),
  result_ref: z.object({ table: z.literal(ATF_SUITE_RESULT_TABLE), sys_id: id }).strict().optional(),
  advice: z.array(z.string().max(500)).max(5).optional(),
  run: atfExecutionRunSchema.optional(),
  failures: z.array(z.object({ test_id: id, test_name: name, step: z.string().max(1000), message: z.string().max(1000), message_truncated: z.boolean(), test_result_id: id, step_result_id: id.optional(), step_id: id.optional() }).strict()),
  pagination: z.object({ tests_total: z.number().int(), tests_offset: z.number().int(), tests_next_offset: z.number().int().optional(), failures_total: z.number().int(), failures_offset: z.number().int(), failures_next_offset: z.number().int().optional() }).strict().optional(),
  comparison: atfComparisonSchema.optional(), warnings: z.array(z.string().max(1000)),
}).strict();
export const atfResultsSchema = z.object({
  action: z.enum(["get", "step", "history", "compare"]),
  step_detail: z.object({ step_result_id: id, test_result_id: id, step_id: id.optional(), step: z.string().max(1000), status: z.string().max(100), field: z.enum(["summary", "output"]), text: z.string().max(8000), offset: z.number().int(), total_characters: z.number().int(), next_offset: z.number().int().optional() }).strict().optional(),
  execution: atfExecutionResultSchema.optional(),
  runs: z.array(atfRunSummarySchema).optional(), comparison: atfComparisonSchema.optional(),
  message: z.string().optional(),
}).strict();
export const atfReadinessSchema = z.object({
  verdict: z.enum(["ready", "blocked", "unverified"]),
  checks: z.array(z.object({ check: z.string(), status: z.enum(["pass", "fail", "warn"]), message: z.string() }).strict()),
}).strict();
export type AtfExecutionResult = z.infer<typeof atfExecutionResultSchema>;
/**
 * What the text of an execution result adds to its fields, as fields: the
 * record behind the "Open suite result" link (table and sys_id, never the
 * instance address) and the pointer to a failed step's full output.
 */
export function withAtfExecutionExtras(execution: AtfExecutionResult): AtfExecutionResult {
  const output: AtfExecutionResult = { ...execution };
  delete output.result_ref;
  delete output.advice;
  if (execution.result_id !== undefined) output.result_ref = { table: ATF_SUITE_RESULT_TABLE, sys_id: execution.result_id };
  if (execution.failures.some(failure => failure.step_result_id !== undefined)) output.advice = [ATF_STEP_DETAIL_ADVICE];
  return output;
}
