import { ATF_STEP_REFERENCE } from "../atf-form.js";
import { z } from "zod";
import { runWithServiceNowRequestSignal } from "../client.js";
import definitions from "./atf-step-definitions.json";
import { AtfPolicyError } from "../atf-policy.js";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { prepareWriteFieldArguments } from "../field-policy.js";
import { prepareWriteFieldValues } from "../write-value-policy.js";
import { createToolError, trustedToolErrorDescriptor } from "../tool-error.js";
import type { ServiceNowToolHandlerServices } from "./tool-module.js";
import { prepareAtfReads, readAtfRows, value, display } from "./atf-shared.js";
import { filteredWriteRecord, requiredCreatedSysId } from "./record-write-shared.js";

interface Input { element: string; internal_type: string; mandatory: boolean; order: number; variable: string; default?: string; choices?: string[]; sdk_constant: boolean }
interface Definition { step_config: string; name: string; step_env: string; executes_user_code: boolean; inputs: Input[] }
const catalog: Record<string, Definition> = definitions;
const reference = z.union([id, z.string().regex(ATF_STEP_REFERENCE)]);
function inputSchema(input: Input): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (input.internal_type) {
    case "table_name": schema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u); break;
    case "reference": case "document_id": schema = reference; break;
    case "boolean": schema = z.boolean(); break;
    case "integer": schema = z.number().int().min(-2147483648).max(2147483647); break;
    case "simple_name_values": schema = z.union([z.literal(""), z.record(z.string().min(1).max(128).regex(/^[^\r\n]+$/), z.string().max(2000)).refine(value => Object.keys(value).length <= 50)]); break;
    case "choice": schema = input.choices?.length ? z.enum(input.choices as [string, ...string[]]) : input.element === "jasmine_version" ? z.string().regex(/^\d+\.\d+$/u) : z.literal(input.default ?? ""); break;
    default: schema = z.string().max(input.internal_type === "script" ? 100000 : 4000);
  }
  if (input.mandatory && schema instanceof z.ZodString) schema = schema.min(1);
  if (input.default !== undefined) {
    const fallback = input.internal_type === "boolean" ? input.default === "true" || input.default === "1" : input.internal_type === "integer" ? Number(input.default) : input.default;
    schema = schema.default(fallback);
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
        description: input.internal_type === "simple_name_values" ? "A name-to-string map, or an empty string" : input.internal_type,
      }])), required: definition.inputs.filter(input => input.mandatory && input.default === undefined).map(input => input.element),
    },
  }));
}
export const stepRequestSchema = z.object({ type: z.string().min(1).max(80), inputs: z.record(z.unknown()) }).strict();
export interface PreparedStep { type: string; definition: Definition; inputs: Record<string, string>; order: number }
export const STEP_READ_TABLES = ["sys_atf_test", "sys_atf_step", "sys_atf_step_config", "var_dictionary", "sys_variable_value", "sys_element_mapping"];
export function prepareSteps(args: Record<string, unknown>, allowScripts: boolean) {
  const testId = id.parse(args.test_sys_id);
  const requests = z.array(stepRequestSchema).min(1).max(50).parse(args.steps);
  const steps: PreparedStep[] = requests.map((request, index) => {
    if (!Object.hasOwn(catalog, request.type)) throw new Error("Unknown ATF step type");
    const definition = catalog[request.type];
    if (definition.executes_user_code && !allowScripts) throw new AtfPolicyError("script_steps_not_enabled");
    const values = z.object(Object.fromEntries(definition.inputs.map(input => [input.element, inputSchema(input)]))).strict().parse(request.inputs);
    const inputs = Object.fromEntries(definition.inputs.map(input => [input.element, values[input.element] === undefined ? "" : typeof values[input.element] === "object" ? JSON.stringify(values[input.element]) : String(values[input.element])]));
    if (definition.inputs.some(input => input.internal_type !== "script" && /javascript\s*:/iu.test(inputs[input.element]))) throw new Error("Script expressions are not allowed in ordinary step inputs");
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
  return { args: { ...prepareAtfReads(args, STEP_READ_TABLES), preparedSteps: steps }, requests: [
    ...STEP_READ_TABLES.map(table => ({ operation: "read" as const, table })),
    ...["sys_atf_step", "sys_variable_value", "sys_element_mapping"].map(table => ({ operation: "write" as const, table })),
  ] };
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
