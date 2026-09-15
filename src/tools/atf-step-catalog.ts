import { z } from "zod";
import definitions from "./atf-step-definitions.json";
import { AtfPolicyError } from "../atf-policy.js";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { prepareWriteFieldArguments } from "../field-policy.js";
import { prepareWriteFieldValues } from "../write-value-policy.js";
import { createToolError } from "../tool-error.js";
import type { ServiceNowToolHandlerServices } from "./tool-module.js";
import { prepareAtfReads, readAtfRows, value, display } from "./atf-shared.js";
import { filteredWriteRecord, requiredCreatedSysId } from "./record-write-shared.js";

interface Input { element: string; internal_type: string; mandatory: boolean; order: number; variable: string; default?: string; choices?: string[]; sdk_constant: boolean }
interface Definition { step_config: string; name: string; step_env: string; executes_user_code: boolean; inputs: Input[] }
const catalog: Record<string, Definition> = definitions;
const reference = z.union([id, z.string().regex(/^\{\{step\['[a-f0-9]{32}'\]\.[a-z][a-z0-9_]*\}\}$/u)]);
function inputSchema(input: Input): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (input.internal_type) {
    case "table_name": schema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u); break;
    case "reference": case "document_id": schema = reference; break;
    case "boolean": schema = z.boolean(); break;
    case "integer": schema = z.number().int().min(-2147483648).max(2147483647); break;
    case "simple_name_values": schema = z.literal(""); break; // Encoding not yet verified; only empty values are supported.
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
        type: input.internal_type === "boolean" ? "boolean" : input.internal_type === "integer" ? "integer" : "string",
        ...(input.choices ? { enum: input.choices } : input.internal_type === "simple_name_values" ? { enum: [""] } : {}),
        description: input.internal_type === "simple_name_values" ? "Only empty input is supported until encoding is verified" : input.internal_type,
      }])), required: definition.inputs.filter(input => input.mandatory && input.default === undefined).map(input => input.element),
    },
  }));
}
export const stepRequestSchema = z.object({ type: z.string().min(1).max(80), inputs: z.record(z.unknown()) }).strict();
export interface PreparedStep { type: string; definition: Definition; inputs: Record<string, string>; order: number }
export const STEP_READ_TABLES = ["sys_atf_step_config", "var_dictionary", "sys_variable_value"];
export function prepareSteps(args: Record<string, unknown>, allowScripts: boolean) {
  const testId = id.parse(args.test_sys_id);
  const requests = z.array(stepRequestSchema).min(1).max(50).parse(args.steps);
  const steps: PreparedStep[] = requests.map((request, index) => {
    if (!Object.hasOwn(catalog, request.type)) throw new Error("Unknown ATF step type");
    const definition = catalog[request.type];
    if (definition.executes_user_code && !allowScripts) throw new AtfPolicyError("script_steps_not_enabled");
    const values = z.object(Object.fromEntries(definition.inputs.map(input => [input.element, inputSchema(input)]))).strict().parse(request.inputs);
    const inputs = Object.fromEntries(definition.inputs.map(input => [input.element, values[input.element] === undefined ? "" : String(values[input.element])]));
    if (definition.inputs.some(input => input.internal_type !== "script" && /javascript\s*:/iu.test(inputs[input.element]))) throw new Error("Script expressions are not allowed in ordinary step inputs");
    if (request.type === "rest_send_request_inbound" && (!inputs.end_point.startsWith("/api/") || inputs.end_point.includes("\\") || inputs.end_point.includes("#"))) throw new Error("Inbound REST endpoints must be instance-relative /api/ paths");
    const order = Number(args.start_order ?? 100) + index;
    const fields = { test: testId, step_config: definition.step_config, order, active: true, description: definition.name };
    prepareWriteFieldValues("create", "sys_atf_step", prepareWriteFieldArguments({ fields }, "sys_atf_step").fields);
    for (const input of definition.inputs) {
      const fields = { document: "sys_atf_step", document_key: "0".repeat(32), variable: input.variable, order: input.order, value: inputs[input.element] };
      prepareWriteFieldValues("create", "sys_variable_value", prepareWriteFieldArguments({ fields }, "sys_variable_value").fields);
    }
    return { type: request.type, definition, inputs, order };
  });
  return { args: { ...prepareAtfReads(args, STEP_READ_TABLES), preparedSteps: steps }, requests: [
    ...STEP_READ_TABLES.map(table => ({ operation: "read" as const, table })),
    ...["sys_atf_step", "sys_variable_value"].map(table => ({ operation: "write" as const, table })),
  ] };
}
export async function authorSteps(args: Record<string, unknown>, services: ServiceNowToolHandlerServices) {
  const steps = args.preparedSteps as PreparedStep[];
  const created: { table: string; sys_id: string }[] = [];
  const results: { table: string; sys_id: string }[] = [];
  let uncertain = false;
  const writeFields = (table: string, fields: Record<string, unknown>) => prepareWriteFieldValues("create", table, prepareWriteFieldArguments({ fields }, table).fields);
  try {
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
    for (const step of steps) {
      const fields = writeFields("sys_atf_step", { test: id.parse(args.test_sys_id), step_config: step.definition.step_config, order: step.order, active: true, description: step.definition.name });
      uncertain = true;
      const response = await services.serviceNow.post("/api/now/table/sys_atf_step", fields);
      const stepId = requiredCreatedSysId(filteredWriteRecord(prepareWriteFieldArguments({ fields }, "sys_atf_step"), response, "do_not_retry"));
      created.push({ table: "sys_atf_step", sys_id: stepId }); results.push({ table: "sys_atf_step", sys_id: stepId }); uncertain = false;
      // Some instances auto-create input rows; update those, insert missing ones.
      // Every document_key is an ID confirmed created by this invocation.
      const existing = await readAtfRows(services, args, "sys_variable_value", `document=sys_atf_step^document_key=${stepId}`, 100);
      const knownIds = new Set(variables.get(step.definition.step_config)!.values());
      if (existing.some(row => value(row.document) !== "sys_atf_step" || value(row.document_key) !== stepId || !knownIds.has(value(row.variable))) || new Set(existing.map(row => value(row.variable))).size !== existing.length) throw new Error("Unexpected step input rows");
      for (const row of existing) created.push({ table: "sys_variable_value", sys_id: id.parse(value(row.sys_id)) });
      for (const input of step.definition.inputs) {
        const variable = variables.get(step.definition.step_config)!.get(input.element)!;
        const fields = writeFields("sys_variable_value", { document: "sys_atf_step", document_key: stepId, variable, order: input.order, value: step.inputs[input.element] });
        const old = existing.find(row => value(row.variable) === variable);
        if (old) await services.serviceNow.patch(`/api/now/table/sys_variable_value/${id.parse(value(old.sys_id))}`, fields);
        else {
          uncertain = true;
          const response = await services.serviceNow.post("/api/now/table/sys_variable_value", fields);
          const sys_id = requiredCreatedSysId(filteredWriteRecord(prepareWriteFieldArguments({ fields }, "sys_variable_value"), response, "do_not_retry"));
          created.push({ table: "sys_variable_value", sys_id }); uncertain = false;
        }
      }
      const saved = await readAtfRows(services, args, "sys_variable_value", `document=sys_atf_step^document_key=${stepId}`, 100);
      if (saved.length !== step.definition.inputs.length || step.definition.inputs.some(input => {
        const matches = saved.filter(row => value(row.variable) === variables.get(step.definition.step_config)!.get(input.element));
        return matches.length !== 1 || value(matches[0].value) !== step.inputs[input.element] || value(matches[0].document_key) !== stepId || value(matches[0].document) !== "sys_atf_step";
      })) throw createToolError("upstream", "do_not_retry");
    }
    return { outcome: "created", results, rolled_back: [], rollback_failed: [], uncertain_insert: false };
  } catch {
    const rolled_back: string[] = [], rollback_failed: string[] = [];
    for (const row of created.reverse()) {
      try { await services.serviceNow.delete(`/api/now/table/${row.table}/${row.sys_id}`); rolled_back.push(row.sys_id); }
      catch { rollback_failed.push(row.sys_id); }
    }
    return { outcome: "failed", results: [], rolled_back, rollback_failed, uncertain_insert: uncertain };
  }
}
