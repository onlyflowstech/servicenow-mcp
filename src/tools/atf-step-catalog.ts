import { ATF_STEP_REFERENCE } from "../atf-form.js";
import { z } from "zod";
import { boundedArray, boundedRecord } from "../bounded-input.js";
import { runWithServiceNowRequestSignal } from "../client.js";
import definitions from "./atf-step-definitions.json";
import { AtfPolicyError } from "../atf-policy.js";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { currentFieldPolicyConfiguration, FieldPolicyError, prepareWriteFieldArguments, resolveReadableFields, typeHiddenFieldNames, validateWritableFields } from "../field-policy.js";
import { currentHiddenFieldScope } from "../hidden-values.js";
import { normalizeTableName, type TableAccessRequest } from "../table-policy.js";
import { prepareWriteFieldValues } from "../write-value-policy.js";
import { createToolError, trustedToolErrorDescriptor } from "../tool-error.js";
import type { ServiceNowToolHandlerServices } from "./tool-module.js";
import { prepareAtfReads, readAtfRows, value, display } from "./atf-shared.js";
import { filteredWriteRecord, requiredCreatedSysId } from "./record-write-shared.js";

interface Input { element: string; internal_type: string; mandatory: boolean; order: number; variable: string; default?: string; choices?: string[]; sdk_constant: boolean }
interface Definition { step_config: string; name: string; step_env: string; executes_user_code: boolean; inputs: Input[] }
const catalog: Record<string, Definition> = definitions;
/** Steps one add_steps call may carry. */
export const MAX_ATF_AUTHOR_STEPS = 50;
/** Entries in one name-to-value map input. */
const MAX_NAME_VALUE_ENTRIES = 50;
const reference = z.union([id, z.string().regex(ATF_STEP_REFERENCE)]);
function inputSchema(input: Input): z.ZodType {
  let schema: z.ZodType;
  switch (input.internal_type) {
    case "table_name": schema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u); break;
    case "reference": case "document_id": schema = reference; break;
    case "boolean": schema = z.boolean(); break;
    case "integer": schema = z.number().int().min(-2147483648).max(2147483647); break;
    case "simple_name_values": schema = z.union([z.literal(""), boundedRecord(z.record(z.string().min(1).max(128).regex(/^[^\r\n]+$/), z.string().max(2000)).refine(value => Object.keys(value).length <= MAX_NAME_VALUE_ENTRIES), MAX_NAME_VALUE_ENTRIES, `Expected at most ${MAX_NAME_VALUE_ENTRIES} entries`)]); break;
    case "choice": schema = input.choices?.length ? z.enum(input.choices as [string, ...string[]]) : input.element === "jasmine_version" ? z.string().regex(/^\d+\.\d+$/u) : z.literal(input.default ?? ""); break;
    default: schema = z.string().max(input.internal_type === "script" ? 100000 : 4000);
  }
  if (input.mandatory && schema instanceof z.ZodString) schema = schema.min(1);
  if (input.default !== undefined) {
    const fallback = input.internal_type === "boolean" ? input.default === "true" || input.default === "1" : input.internal_type === "integer" ? Number(input.default) : input.default;
    // prefault, not default: zod 4 returns a default without validating it,
    // and a catalog default must still pass the input schema, as in zod 3.
    schema = schema.prefault(fallback);
  } else if (!input.mandatory) schema = schema.optional();
  return schema;
}
export function stepTypes(allowScripts: boolean) {
  return Object.entries(catalog).filter(([, definition]) => allowScripts || !definition.executes_user_code).map(([type, definition]) => ({
    type, name: definition.name, environment: definition.step_env, script: definition.executes_user_code,
    input_schema: { type: "object", additionalProperties: false,
      properties: Object.fromEntries(definition.inputs.map(input => [input.element, {
        type: input.internal_type === "simple_name_values" ? ["object", "string"] : input.internal_type === "boolean" ? "boolean" : input.internal_type === "integer" ? "integer" : "string",
        ...(input.choices ? { enum: input.choices } : input.internal_type === "simple_name_values" ? { additionalProperties: { type: "string" }, maxProperties: 50 } : {}),
        description: type === "rest_assert_json_payload_element" && input.element === "element_name" ? "Slash-separated element path, e.g. result/number (not JSONPath dot notation)" : input.internal_type === "simple_name_values" ? "A name-to-string map, or an empty string" : input.internal_type,
      }])), required: definition.inputs.filter(input => input.mandatory && input.default === undefined).map(input => input.element),
    },
  }));
}
export const stepRequestSchema = z.object({ type: z.string().min(1).max(80), inputs: z.record(z.string(), z.unknown()) }).strict();
export interface PreparedStep { type: string; definition: Definition; inputs: Record<string, string>; order: number }
export const STEP_READ_TABLES = ["sys_atf_test", "sys_atf_step", "sys_atf_step_config", "var_dictionary", "sys_variable_value", "sys_element_mapping"];
/**
 * What a step type does with the table it names, so the profile's grants can
 * decide it before anything is written. `read` steps look at records of the
 * table, `write` steps create or change them through a form. Every type listed
 * here has its table added to the access plan with that operation, and its
 * conditions (when it has any) checked against the table's field policy.
 *
 * `aclSetting` names an input whose explicit `false` is refused: the two server
 * steps always enforce ACLs. A step type that is not listed names no table, or
 * none the server's grants are meant to decide.
 */
interface StepTableRule {
  readonly access: "read" | "write";
  readonly table: string;
  readonly conditions?: string;
  /** An input of `field=value` terms to set; each field must be writable on the table. */
  readonly assignments?: string;
  readonly aclSetting?: string;
}
const STEP_TABLE_RULES: Readonly<Record<string, StepTableRule>> = Object.freeze({
  record_query: { access: "read", table: "table", conditions: "field_values", aclSetting: "enforce_security" },
  record_validation: { access: "read", table: "table", conditions: "field_values", aclSetting: "enforce_security" },
  field_values_validation: { access: "read", table: "table", conditions: "conditions" },
  open_existing_record: { access: "read", table: "table" },
  open_new_form: { access: "write", table: "table" },
  set_field_values: { access: "write", table: "table", assignments: "field_values" },
});
/** Operators a condition may use, longest first so a prefix never shadows its longer form. */
const CONDITION_OPERATORS = ["NOT LIKE", "NOT IN", "ISNOTEMPTY", "ISEMPTY", "STARTSWITH", "ENDSWITH", "BETWEEN", "LIKE", "IN", "!=", "<=", ">=", "=", "<", ">"] as const;
const UNARY_CONDITION_OPERATORS: ReadonlySet<string> = new Set(["ISNOTEMPTY", "ISEMPTY"]);
const CONDITION_TERM = /^(?<prefix>ORDERBYDESC|ORDERBY|GROUPBY|NQ|OR)?(?<field>[a-z][a-z0-9_.]*)(?<rest>.*)$/su;
/**
 * The only step outputs a condition value may refer to: a record id or a sys_id
 * (record_id, first_record, sys_id, and user, the sys_id of the impersonated
 * user). Another output (a table name, text) could carry a `^`, an operator or a
 * field name into the condition, so any other pill is refused.
 */
const ALLOWED_CONDITION_PILL = /\{\{step\['[a-f0-9]{32}'\]\.(?:record_id|first_record|sys_id|user)\}\}/gu;
/** Refuse a value that holds a pill other than an allowed one, or a stray brace pair. */
function checkConditionValue(value: string): void {
  if (/\{\{|\}\}/u.test(value.replace(ALLOWED_CONDITION_PILL, ""))) {
    throw new FieldPolicyError("invalid_field_selection");
  }
}
/**
 * Check every term of a condition string against the table's field policy.
 *
 * A condition on a field the profile may not read would report that field's
 * value as a pass or a fail, so it is refused like a read of it. Only the
 * operators that compare a field with a literal are allowed: an operator that
 * takes a second field (SAMEAS, GT_FIELD, MORETHAN and the like) or a dynamic
 * value (DYNAMIC, VALCHANGES, CHANGESFROM) would test a field this check does
 * not see, so it is refused with the rest. No date operator is allowed: the ones
 * that take no field argument need a script value, which is refused anyway, and
 * a plain date comparison is `<`, `>` or BETWEEN. A dot-walk, a pasted step
 * output standing for the whole condition, and a term this check does not
 * recognise are refused too: none can be checked against one table.
 */
function checkConditionFields(table: string, conditions: string): void {
  if (conditions === "") return;
  for (const term of conditions.split("^")) {
    if (term === "EQ" || term === "NQ") continue;
    const groups = CONDITION_TERM.exec(term)?.groups;
    const field = groups?.field;
    if (groups === undefined || field === undefined || field.includes(".")) {
      throw new FieldPolicyError("invalid_field_selection");
    }
    const rest = groups.rest ?? "";
    const ordering = groups.prefix === "ORDERBY" || groups.prefix === "ORDERBYDESC" || groups.prefix === "GROUPBY";
    if (ordering ? rest !== "" : !conditionOperatorAllowed(rest)) {
      throw new FieldPolicyError("invalid_field_selection");
    }
    // A condition filters, so a field refused as a filter is refused here: a
    // password-typed field, and a value whose secrecy is per row.
    resolveReadableFields(table, { fields: field, purpose: "query" });
    checkConditionValue(rest);
  }
}
/**
 * Check the fields a set_field_values step sets against the table's writable
 * fields, the policy sn_update applies, so a step cannot set a field an update
 * would refuse. The terms are `field=value`; any other shape is refused, and a
 * value may hold only the pills a condition value may.
 */
function checkAssignedFields(table: string, assignments: string): void {
  const fields: Record<string, string> = {};
  for (const term of assignments.split("^")) {
    if (term === "EQ") continue;
    const match = /^(?<field>[a-z][a-z0-9_]*)=/su.exec(term);
    const field = match?.groups?.field;
    if (match === null || field === undefined) throw new FieldPolicyError("invalid_field_selection");
    // The values obey the same pill limit as a condition's.
    checkConditionValue(term.slice(match[0].length));
    fields[field] = "";
  }
  validateWritableFields(table, fields);
}
/** True when `rest` (an operator and its value) uses an allowed operator with a literal value. */
function conditionOperatorAllowed(rest: string): boolean {
  const operator = CONDITION_OPERATORS.find(candidate => rest.startsWith(candidate));
  if (operator === undefined) return false;
  const value = rest.slice(operator.length);
  if (UNARY_CONDITION_OPERATORS.has(operator)) return value === "";
  // "IN" must not be the start of INSTANCEOF, which takes a class, not a list.
  if ((operator === "IN" || operator === "NOT IN") && /^STANCEOF/u.test(value)) return false;
  return true;
}
/**
 * The checks that depend on a step's type and inputs. Returns the table access
 * the step needs, for the plan. Further per-step checks belong here.
 */
function checkStepTable(type: string, inputs: Record<string, string>): TableAccessRequest[] {
  const rule = Object.hasOwn(STEP_TABLE_RULES, type) ? STEP_TABLE_RULES[type] : undefined;
  if (rule === undefined) return [];
  // An explicit false is refused, not rewritten: the author learns why. Left
  // out, the catalog default (true) applies.
  if (rule.aclSetting !== undefined && inputs[rule.aclSetting] === "false") throw new AtfPolicyError("acl_enforcement_required");
  const table = normalizeTableName(inputs[rule.table]);
  if (rule.conditions !== undefined) checkConditionFields(table, inputs[rule.conditions] ?? "");
  if (rule.assignments !== undefined) checkAssignedFields(table, inputs[rule.assignments] ?? "");
  return [{ operation: rule.access, table }];
}
/** The fields each step write sets, whatever the step: fixed names. */
const STEP_WRITE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sys_atf_step: ["test", "sys_scope", "step_config", "order", "active", "description"],
  sys_variable_value: ["document", "document_key", "variable", "order", "value"],
  sys_element_mapping: ["id", "table", "field", "value"],
});
/** Steps parsed by a call's first preparation, by the call's own arguments. */
const PARSED_STEP_RUNS = new WeakMap<
  object,
  { readonly allowScripts: boolean; readonly policy: object | undefined; readonly steps: PreparedStep[] }
>();
/**
 * Prepare an add_steps call. `reuseKey` is the call's own argument object:
 * the dispatcher prepares a plan twice, the second time inside the call's
 * hidden-field scope, and the second preparation reuses the first one's parsed
 * steps. Parsing and the value checks cannot change between the two; the
 * checks that depend on field types (conditions, assignments and the step
 * writes' own fields) run again. Reuse needs the same argument object, script
 * grant and field-policy configuration, inside a hidden-field scope; anything
 * else prepares from scratch.
 */
export function prepareSteps(args: Record<string, unknown>, allowScripts: boolean, reuseKey?: object) {
  const policy = currentFieldPolicyConfiguration();
  const reused = reuseKey === undefined ? undefined : PARSED_STEP_RUNS.get(reuseKey);
  if (
    reused !== undefined &&
    reused.allowScripts === allowScripts &&
    reused.policy === policy &&
    currentHiddenFieldScope() !== undefined
  ) {
    const stepAccess: TableAccessRequest[] = [];
    for (const step of reused.steps) stepAccess.push(...checkStepTable(step.type, step.inputs));
    for (const [table, fields] of Object.entries(STEP_WRITE_FIELDS)) {
      const hidden = typeHiddenFieldNames(table);
      if (fields.some(field => hidden.has(field))) throw new FieldPolicyError("sensitive_field", { table });
    }
    return plannedSteps(args, reused.steps, stepAccess);
  }
  const testId = id.parse(args.test_sys_id);
  const requests = boundedArray(stepRequestSchema, MAX_ATF_AUTHOR_STEPS, { min: 1 }).parse(args.steps);
  const stepAccess: TableAccessRequest[] = [];
  const steps: PreparedStep[] = requests.map((request, index) => {
    if (!Object.hasOwn(catalog, request.type)) throw new Error("Unknown ATF step type");
    const definition = catalog[request.type];
    if (definition.executes_user_code && !allowScripts) throw new AtfPolicyError("script_steps_not_enabled");
    const values = z.object(Object.fromEntries(definition.inputs.map(input => [input.element, inputSchema(input)]))).strict().parse(request.inputs);
    const inputs = Object.fromEntries(definition.inputs.map(input => [input.element, values[input.element] === undefined ? "" : typeof values[input.element] === "object" ? JSON.stringify(values[input.element]) : String(values[input.element])]));
    if (definition.inputs.some(input => input.internal_type !== "script" && /javascript\s*:/iu.test(inputs[input.element]))) throw new Error("Script expressions are not allowed in ordinary step inputs");
    stepAccess.push(...checkStepTable(request.type, inputs));
    if (request.type === "rest_send_request_inbound" && (!inputs.end_point.startsWith("/api/") || inputs.end_point.includes("\\") || inputs.end_point.includes("#"))) throw new Error("Inbound REST endpoints must be instance-relative /api/ paths");
    const order = Number(args.start_order ?? 100) + index;
    const fields = { test: testId, sys_scope: "global", step_config: definition.step_config, order, active: true, description: definition.name };
    prepareWriteFieldValues("create", "sys_atf_step", prepareWriteFieldArguments({ fields }, "sys_atf_step").fields);
    for (const input of definition.inputs) {
      const fields = { document: "sys_atf_step", document_key: "0".repeat(32), variable: input.variable, order: input.order, value: inputs[input.element] };
      prepareWriteFieldValues("create", "sys_variable_value", prepareWriteFieldArguments({ fields }, "sys_variable_value").fields);
    }
    for (const [field, value] of Object.entries(inputs)) {
      if (ATF_STEP_REFERENCE.test(value)) {
        const fields = { id: "0".repeat(32), table: `var__m_atf_input_variable_${definition.step_config}`, field, value };
        prepareWriteFieldValues("create", "sys_element_mapping", prepareWriteFieldArguments({ fields }, "sys_element_mapping").fields);
      }
    }
    return { type: request.type, definition, inputs, order };
  });
  if (reuseKey !== undefined) PARSED_STEP_RUNS.set(reuseKey, { allowScripts, policy, steps });
  return plannedSteps(args, steps, stepAccess);
}
function plannedSteps(args: Record<string, unknown>, steps: PreparedStep[], stepAccess: readonly TableAccessRequest[]) {
  // Each table-taking step needs the table it names (read, or write for a form
  // that creates records), so the profile's grants (a named-only table included)
  // decide it before anything is written.
  const planned = new Map<string, TableAccessRequest>();
  for (const request of [
    ...STEP_READ_TABLES.map(table => ({ operation: "read" as const, table })),
    ...stepAccess,
    ...["sys_atf_step", "sys_variable_value", "sys_element_mapping"].map(table => ({ operation: "write" as const, table })),
  ]) planned.set(`${request.operation}:${request.table}`, request);
  return { args: { ...prepareAtfReads(args, STEP_READ_TABLES), preparedSteps: steps }, requests: [...planned.values()] };
}
function inputMatches(input: Input, actual: string, expected: string): boolean {
  if (input.internal_type === "boolean") return (actual === "1" ? "true" : actual === "0" ? "false" : actual) === expected;
  return actual === expected;
}
export async function authorSteps(args: Record<string, unknown>, services: ServiceNowToolHandlerServices) {
  const steps = args.preparedSteps as PreparedStep[];
  const created: { table: string; sys_id: string }[] = [];
  const results: { table: string; sys_id: string }[] = [];
  let uncertain = false;
  let stage = "metadata verification";
  const writeFields = (table: string, fields: Record<string, unknown>) => prepareWriteFieldValues("create", table, prepareWriteFieldArguments({ fields }, table).fields);
  try {
    if (!services.serviceNow.saveAtfStepInputs) throw new Error("Native ATF form transport is unavailable");
    const tests = await readAtfRows(services, args, "sys_atf_test", `sys_id=${id.parse(args.test_sys_id)}`, 1);
    if (tests.length !== 1) throw new Error("Test is unavailable");
    const scope = z.union([id, z.literal("global")]).parse(value(tests[0].sys_scope));
    const variables = new Map<string, Map<string, string>>();
    // Resolve and verify every config/input definition before the first insert.
    for (const step of steps) {
      const definition = step.definition;
      if (variables.has(definition.step_config)) continue;
      const configs = await readAtfRows(services, args, "sys_atf_step_config", `sys_id=${definition.step_config}`, 1);
      if (configs.length !== 1 || value(configs[0].name) !== definition.name || display(configs[0].step_env) !== definition.step_env) throw new Error("Step configuration does not match the catalog");
      const rows = await readAtfRows(services, args, "var_dictionary", `sys_class_name=atf_input_variable^model_id=${definition.step_config}`, 100);
      if (rows.length !== definition.inputs.length) throw new Error("Step input definitions do not match the catalog");
      const resolved = new Map<string, string>();
      for (const input of definition.inputs) {
        const matches = rows.filter(row => value(row.element) === input.element);
        const row = matches[0];
        const internalType = row?.internal_type;
        const type = value(internalType);
        if (matches.length !== 1 || type !== input.internal_type || value(row.mandatory) !== String(input.mandatory) || Number(value(row.order)) !== input.order) throw new Error("Input definition differs from the verified catalog");
        const variableId = id.parse(value(row.sys_id));
        if (input.sdk_constant && variableId !== input.variable) throw new Error("Input constant differs from the verified catalog");
        resolved.set(input.element, variableId);
      }
      variables.set(definition.step_config, resolved);
    }
    // References must resolve to an earlier step in this test and a real output.
    for (const step of steps) for (const input of Object.values(step.inputs)) {
      if (!ATF_STEP_REFERENCE.test(input)) continue;
      const [, sourceId, output] = /^\{\{step\['([a-f0-9]{32})'\]\.([a-z][a-z0-9_]*)\}\}$/u.exec(input)!;
      const sources = await readAtfRows(services, args, "sys_atf_step", `sys_id=${sourceId}^test=${id.parse(args.test_sys_id)}`, 1);
      if (sources.length !== 1 || value(sources[0].test) !== args.test_sys_id || Number(value(sources[0].order)) >= step.order || value(sources[0].active) !== "true") throw new Error("Reference source is not an earlier active step in this test");
      const outputs = await readAtfRows(services, args, "var_dictionary", `sys_class_name=atf_output_variable^model_id=${id.parse(value(sources[0].step_config))}^element=${output}`, 1);
      if (outputs.length !== 1 || value(outputs[0].element) !== output) throw new Error("Reference output is unavailable");
    }
    for (const step of steps) {
      const fields = writeFields("sys_atf_step", { test: id.parse(args.test_sys_id), sys_scope: scope, step_config: step.definition.step_config, order: step.order, active: true, description: step.definition.name });
      stage = "step creation";
      uncertain = true;
      const response = await services.serviceNow.post("/api/now/table/sys_atf_step", fields);
      const stepId = requiredCreatedSysId(filteredWriteRecord(prepareWriteFieldArguments({ fields }, "sys_atf_step"), response, "do_not_retry"));
      created.push({ table: "sys_atf_step", sys_id: stepId }); results.push({ table: "sys_atf_step", sys_id: stepId }); uncertain = false;
      const existing = await readAtfRows(services, args, "sys_variable_value", `document=sys_atf_step^document_key=${stepId}`, 100);
      const changes = Object.fromEntries(step.definition.inputs.filter(input => {
        const rows = existing.filter(row => value(row.variable) === variables.get(step.definition.step_config)!.get(input.element));
        return rows.length !== 1 || !inputMatches(input, value(rows[0].value), step.inputs[input.element]);
      }).map(input => [input.element, step.inputs[input.element]]));
      stage = "native input form save";
      if (Object.keys(changes).length) await services.serviceNow.saveAtfStepInputs({ stepId, testId: id.parse(args.test_sys_id), configId: step.definition.step_config, scope, inputs: changes });
      stage = "stored input verification";
      const saved = await readAtfRows(services, args, "sys_variable_value", `document=sys_atf_step^document_key=${stepId}`, 100);
      const mapped = Object.entries(step.inputs).filter(([, value]) => ATF_STEP_REFERENCE.test(value));
      const mappings = mapped.length ? await readAtfRows(services, args, "sys_element_mapping", `id=${stepId}^table=var__m_atf_input_variable_${step.definition.step_config}`, 100) : [];
      if (mapped.some(([field, expected]) => {
        const rows = mappings.filter(row => value(row.field) === field);
        return rows.length !== 1 || value(rows[0].value) !== expected || value(rows[0].id) !== stepId || value(rows[0].table) !== `var__m_atf_input_variable_${step.definition.step_config}`;
      })) throw createToolError("upstream", "do_not_retry");
      if (saved.length !== step.definition.inputs.length || step.definition.inputs.some(input => {
        const matches = saved.filter(row => value(row.variable) === variables.get(step.definition.step_config)!.get(input.element));
        return matches.length !== 1 || !inputMatches(input, value(matches[0].value), ATF_STEP_REFERENCE.test(step.inputs[input.element]) ? "" : step.inputs[input.element]) || value(matches[0].document_key) !== stepId || value(matches[0].document) !== "sys_atf_step";
      })) throw createToolError("upstream", "do_not_retry");
    }
    return { outcome: "created", results, rolled_back: [], rollback_failed: [], uncertain_insert: false };
  } catch (error) {
    const message = trustedToolErrorDescriptor(error)?.category === "authorization" ? `ServiceNow denied ${stage}. Check the authoring user permissions.` : `ATF authoring stopped during ${stage}; the instance contract or stored values could not be verified.`;
    const rolled_back: string[] = [], rollback_failed: string[] = [];
    await runWithServiceNowRequestSignal(AbortSignal.timeout(10000), async () => {
    for (const row of created.reverse()) {
      try {
        await services.serviceNow.delete(`/api/now/table/${row.table}/${row.sys_id}`);
        const remaining = await readAtfRows(services, args, "sys_variable_value", `document=sys_atf_step^document_key=${row.sys_id}`, 100);
        if (remaining.length) rollback_failed.push(...remaining.map(input => id.parse(value(input.sys_id))));
        const mappings = await readAtfRows(services, args, "sys_element_mapping", `id=${row.sys_id}`, 100);
        for (const mapping of mappings) {
          const mappingId = id.parse(value(mapping.sys_id));
          if (value(mapping.id) !== row.sys_id || !/^var__m_atf_input_variable_[a-f0-9]{32}$/u.test(value(mapping.table))) { rollback_failed.push(mappingId); continue; }
          try { await services.serviceNow.delete(`/api/now/table/sys_element_mapping/${mappingId}`); }
          catch { rollback_failed.push(mappingId); }
        }
        if (mappings.length) {
          const leftover = await readAtfRows(services, args, "sys_element_mapping", `id=${row.sys_id}`, 100);
          rollback_failed.push(...leftover.map(mapping => id.parse(value(mapping.sys_id))));
        }
        rolled_back.push(row.sys_id);
      }
      catch { rollback_failed.push(row.sys_id); }
    }
    });
    return { outcome: "failed", results: [], rolled_back, rollback_failed, uncertain_insert: uncertain, message };
  }
}
