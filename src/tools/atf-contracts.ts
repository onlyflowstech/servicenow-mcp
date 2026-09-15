import { z } from "zod";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { atfRunSummarySchema } from "../atf-result-cache.js";
const name = z.string().max(100);
export const atfComparisonSchema = z.object({
  previous_run: id, current_run: id,
  new_failures: z.array(id), fixed: z.array(id), still_failing: z.array(id), flaky: z.array(id),
  duration_change_ms: z.number(), duration_regression: z.boolean(),
}).strict();
export const atfExecutionResultSchema = z.object({
  outcome: z.enum(["running", "completed", "unavailable"]),
  progress_id: id.optional(), result_id: id.optional(), suite_id: id.optional(), suite_name: name.optional(),
  run: atfRunSummarySchema.optional(),
  failures: z.array(z.object({ test_id: id, test_name: name, step: z.string().max(1000), message: z.string().max(500) }).strict()),
  comparison: atfComparisonSchema.optional(), warnings: z.array(z.string().max(1000)),
}).strict();
export const atfResultsSchema = z.object({
  action: z.enum(["get", "history", "compare"]),
  execution: atfExecutionResultSchema.optional(),
  runs: z.array(atfRunSummarySchema).optional(), comparison: atfComparisonSchema.optional(),
  message: z.string().optional(),
}).strict();
export const atfReadinessSchema = z.object({
  verdict: z.enum(["ready", "blocked", "unverified"]),
  checks: z.array(z.object({ check: z.string(), status: z.enum(["pass", "fail", "warn"]), message: z.string() }).strict()),
}).strict();
export type AtfExecutionResult = z.infer<typeof atfExecutionResultSchema>;
