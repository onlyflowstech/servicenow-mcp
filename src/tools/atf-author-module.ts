import { stepRequestSchema, prepareSteps, authorSteps, stepTypes, STEP_READ_TABLES } from "./atf-step-catalog.js";
import type { ResolvedEffectivePolicyReference } from "../execution-context.js";
/** ATF authoring with instance metadata verification before step writes. */
import { z } from "zod";
import { prepareWriteFieldArguments, withFieldPolicyArgumentValues } from "../field-policy.js";
import { normalizeWriteTable, prepareWriteFieldValues } from "../write-value-policy.js";
import { serviceNowSysIdSchema } from "../servicenow-identifiers.js";
import { ok } from "../utils.js";
import { filteredWriteRecord, requiredCreatedSysId } from "./record-write-shared.js";
import { defineServiceNowToolModule, withRequiredProfile } from "./tool-module.js";
import { envelopeCompatibilityResult, productionToolOutputSchemas, registerEnvelopeTextRenderer } from "./result-envelope.js";
import { headline, recordLink, renderMarkdown, table, text } from "./markdown.js";

const schema = z.object({
  action: z.enum(["create_test", "create_suite", "add_tests_to_suite", "add_steps", "list_step_types"]).describe("Create tests/suites, add memberships or typed steps, or list supported step types"),
  test_sys_id: serviceNowSysIdSchema.optional().describe("Test sys_id for add_steps"),
  steps: z.array(stepRequestSchema).min(1).max(50).optional().describe("Ordered typed steps with validated inputs for add_steps"),
  name: z.string().trim().min(1).max(100).optional().describe("Name required for create_test and create_suite"),
  description: z.string().max(1000).optional().describe("Description for a new test or suite"),
  active: z.boolean().optional().describe("Whether the new test or suite is active (default true)"),
  application_scope: serviceNowSysIdSchema.optional().describe("Optional application scope sys_id for creation"),
  suite_sys_id: serviceNowSysIdSchema.optional().describe("Suite sys_id required for add_tests_to_suite"),
  test_sys_ids: z.array(serviceNowSysIdSchema).min(1).max(100).optional().describe("Unique test sys_ids to add, in execution order (maximum 100)"),
  start_order: z.number().int().min(0).max(1000000).optional().describe("First membership order (default 100); existing memberships are unchanged"),
}).strict();
export const atfAuthorInputSchema = withRequiredProfile(schema);
interface Write { table: string; fields: Record<string, unknown>; prepared: Record<string, unknown> }

export function resolveAtfAuthorAccess(candidate: unknown, policy?: ResolvedEffectivePolicyReference) {
  const args = atfAuthorInputSchema.parse(candidate) as z.infer<typeof schema> & { profile: string };
  if (args.action === "list_step_types") return { args: { ...args, step_types: stepTypes(policy?.atf.allowScriptSteps === true) }, requests: [] };
  if (args.action === "add_steps") return prepareSteps(args, policy?.atf.allowScriptSteps === true);
  if (args.steps !== undefined || args.test_sys_id !== undefined) throw new Error("Step fields require add_steps");
  let tableName: string;
  let rows: Record<string, unknown>[];
  if (args.action === "add_tests_to_suite") {
    if (!args.suite_sys_id || !args.test_sys_ids) throw new Error("suite_sys_id and test_sys_ids are required");
    if (args.name !== undefined || args.description !== undefined || args.active !== undefined || args.application_scope !== undefined) {
      throw new Error("Creation fields are not accepted when adding tests");
    }
    if (new Set(args.test_sys_ids).size !== args.test_sys_ids.length) throw new Error("test_sys_ids must be unique");
    tableName = "sys_atf_test_suite_test";
    rows = args.test_sys_ids.map((test, index) => ({ test, test_suite: args.suite_sys_id, order: (args.start_order ?? 100) + index }));
  } else {
    if (!args.name) throw new Error("name is required");
    if (args.suite_sys_id !== undefined || args.test_sys_ids !== undefined || args.start_order !== undefined) {
      throw new Error("Membership fields are not accepted when creating a test or suite");
    }
    tableName = args.action === "create_test" ? "sys_atf_test" : "sys_atf_test_suite";
    rows = [{ name: args.name, active: args.active ?? true,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.application_scope === undefined ? {} : { sys_scope: args.application_scope }),
    }];
  }
  const target = normalizeWriteTable(tableName);
  // Prepare every row under the coordinator's field-policy context before any I/O.
  const writes: Write[] = rows.map(fields => {
    let prepared = prepareWriteFieldArguments({ ...args, fields }, target);
    const values = prepareWriteFieldValues("create", target, prepared.fields);
    prepared = withFieldPolicyArgumentValues(prepared, { table: target, fields: values });
    return { table: target, fields: values, prepared };
  });
  return {
    args: { ...args, writes },
    requests: [{ operation: "write" as const, table: target }],
  };
}

registerEnvelopeTextRenderer("sn_atf_author", (envelope, context) => {
  if ((envelope.data as { action: string }).action === "list_step_types") return renderMarkdown(headline("ATF step catalog"), table(["Type", "Name"], ((envelope.data as { step_types: {type: string; name: string}[] }).step_types).map(step => [step.type, step.name])));
  const data = envelope.data as { outcome: "created" | "failed"; results: { table: string; sys_id: string }[]; rolled_back: string[]; rollback_failed: string[]; uncertain_insert: boolean };
  if (data.outcome === "failed") return renderMarkdown(
    headline("ATF authoring failed", { status: "fail" }),
    text(`Rolled back: ${data.rolled_back.join(", ") || "none"}.`, 4000),
    text(`Rollback failed for: ${data.rollback_failed.join(", ") || "none"}.`, 4000),
    data.uncertain_insert ? text("The last insert may have succeeded without a usable response; inspect the instance before retrying.") : null,
  );
  return renderMarkdown(headline("ATF records created", { status: "pass" }),
    table(["Table", "Record"], data.results.map(row => [row.table,
      recordLink(context.instanceOrigin ?? "", row.table, row.sys_id, row.sys_id)])),
    text(context.summary));
});

export const atfAuthorToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition: {
    name: "sn_atf_author",
    description: "Create ATF tests and suites, or add tests to a suite. Requires explicit table write grants. Rolls back confirmed inserts on failure; reports incomplete or uncertain writes. Supports a runtime-verified step catalog; script steps require atf.allowScriptSteps. Does not execute tests.",
    annotations: { title: "Author ATF tests and suites", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  inputSchema: atfAuthorInputSchema,
  outputSchema: productionToolOutputSchemas.sn_atf_author,
  requirements: {
    permissions: ["read", "write"],
    tables: { kind: "static", names: ["sys_atf_test", "sys_atf_test_suite", "sys_atf_test_suite_test", "sys_atf_step", ...STEP_READ_TABLES] },
    apis: ["table"], fieldPolicies: ["read", "write"], capabilities: ["atf:author"],
  },
  resolveAccess: (args, policy) => resolveAtfAuthorAccess(args, policy),
  handler: async (args, services) => {
    if (args.action === "list_step_types") return envelopeCompatibilityResult("sn_atf_author", args, ok({ action: args.action, outcome: "catalog", results: [], rolled_back: [], rollback_failed: [], uncertain_insert: false, step_types: args.step_types }));
    if (args.action === "add_steps") return envelopeCompatibilityResult("sn_atf_author", args, ok({ action: args.action, ...await authorSteps(args, services) }));
    const writes = (args as unknown as { writes: Write[] }).writes;
    const created: { table: string; sys_id: string }[] = [];
    let uncertain = false;
    try {
      for (const write of writes) {
        uncertain = true;
        const response = await services.serviceNow.post(`/api/now/table/${write.table}`, write.fields);
        const record = filteredWriteRecord(write.prepared, response, "do_not_retry");
        const sys_id = requiredCreatedSysId(record);
        created.push({ table: write.table, sys_id });
        uncertain = false;
      }
      return envelopeCompatibilityResult("sn_atf_author", args, ok({ action: args.action, outcome: "created", results: created, rolled_back: [], rollback_failed: [], uncertain_insert: false }));
    } catch {
      const rolledBack: string[] = [];
      const remaining: string[] = [];
      for (const record of [...created].reverse()) {
        try {
          await services.serviceNow.delete(`/api/now/table/${record.table}/${record.sys_id}`);
          rolledBack.push(record.sys_id);
        } catch { remaining.push(record.sys_id); }
      }
      // A failed authoring attempt is a structured domain outcome so the
      // coordinator preserves the rollback report instead of sanitizing it
      // as an untrusted handler error.
      return envelopeCompatibilityResult("sn_atf_author", args, ok({
        action: args.action, outcome: "failed", results: [], rolled_back: rolledBack,
        rollback_failed: remaining, uncertain_insert: uncertain,
      }));
    }
  },
});
