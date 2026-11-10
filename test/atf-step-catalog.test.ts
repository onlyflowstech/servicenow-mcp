import { describe, expect, it } from "vitest";
import definitions from "../src/tools/atf-step-definitions.json";
import fixtureDefinitions from "./fixtures/atf/step-catalog.json";
import { prepareSteps, authorSteps, stepTypes } from "../src/tools/atf-step-catalog.js";
import { atfAuthorToolModule } from "../src/tools/atf-author-module.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import type { ServiceNowToolHandlerServices } from "../src/tools/tool-module.js";
import type { ResolvedEffectivePolicyReference } from "../src/execution-context.js";
import { createMockServiceNowFixture, type MockServiceNowStep } from "./fixtures/mock-servicenow.js";
const id = (n: number) => n.toString(16).padStart(32, "0");
const read = (result: unknown): MockServiceNowStep => ({ operation: "get", response: { result } });
const policy = { atf: { execute: false, allowScriptSteps: true }, tableAccess: createTableAccessPolicy({ readTables: ["*"], writeTables: ["*"] }) } as ResolvedEffectivePolicyReference;

describe("verified ATF step catalog", () => {
  it("rejects script steps by default and advertises the grant-dependent catalog", () => {
    expect(stepTypes(false).some(step => step.script)).toBe(false);
    expect(stepTypes(true).some(step => step.script)).toBe(true);
    expect(() => prepareSteps({ test_sys_id: id(1), steps: [{ type: "run_server_side_script", inputs: { jasmine_version: "3.1", script: "gs.info('test');" } }] }, false)).toThrow();
  });
  it("rejects unknown fields, script expressions and unverified nonempty encodings", () => {
    for (const request of [
      { type: "impersonate", inputs: { user: id(2), extra: "no" } },
      { type: "missing", inputs: {} },
      { type: "rest_send_request_inbound", inputs: { end_point: "/api/now/table/incident", headers: "x=y" } },
      { type: "record_query", inputs: { table: "incident", field_values: "sys_id=javascript:gs.getUserID()^EQ" } },
      { type: "rest_send_request_inbound", inputs: { end_point: "https://other.example/api/now/table/incident" } },
    ]) expect(() => prepareSteps({ test_sys_id: id(1), steps: [request] }, true)).toThrow();
  });
  it.each(Object.keys(definitions))("round-trips %s using the S0 catalog fixture", async type => {
    const def = definitions[type as keyof typeof definitions];
    const source = fixtureDefinitions.catalog[type as keyof typeof fixtureDefinitions.catalog];
    const typedInputs: Record<string, unknown> = { ...source.example_values };
    for (const input of def.inputs) {
      if (input.internal_type === "integer" && typedInputs[input.element] !== undefined) typedInputs[input.element] = Number(typedInputs[input.element]);
      if (input.internal_type === "boolean" && typedInputs[input.element] !== undefined) typedInputs[input.element] = ["true", "1", true].includes(typedInputs[input.element] as string);
      if (input.mandatory && input.internal_type === "document_id" && typedInputs[input.element] === undefined) typedInputs[input.element] = id(99);
    }
    for (const [key,value] of Object.entries(typedInputs)) if (typeof value === "string" && value.startsWith("{{step[")) typedInputs[key]=id(99);
    const requested = { profile: "pdi", action: "add_steps", test_sys_id: id(1), steps: [{ type, inputs: typedInputs }] };
    const prepared = prepareSteps(requested, true).args;
    const step = prepared.preparedSteps[0];
    const inputRows = def.inputs.map((input, index) => ({ sys_id: id(100 + index), document: "sys_atf_step", document_key: id(2), variable: input.variable, value: input.internal_type === "boolean" ? (step.inputs[input.element] === "true" ? "1" : "0") : step.inputs[input.element], order: String(input.order) }));
    const fixture = createMockServiceNowFixture([
      read([{sys_id:id(1),sys_scope:"global"}]),
      read([{ sys_id: def.step_config, name: def.name, step_env: { value: "raw", display_value: def.step_env } }]),
      read(def.inputs.map(input => ({ sys_id: input.variable, model_id: def.step_config, element: input.element, internal_type: { value: input.internal_type, display_value: "label" }, mandatory: String(input.mandatory), order: String(input.order) }))),
      { operation: "post", response: { result: { sys_id: id(2) } } }, read([]),
      { operation: "saveAtfStepInputs", response: undefined }, read(inputRows),
    ]);
    const services = { serviceNow: fixture.operations, policy } as ServiceNowToolHandlerServices;
    const result = await authorSteps(prepared, services);
    expect(result).toMatchObject({ outcome: "created", results: [{ table: "sys_atf_step", sys_id: id(2) }] });
    expect(fixture.calls.find(call => call.operation === "saveAtfStepInputs")?.body).toMatchObject({ stepId:id(2), testId:id(1), scope:"global", inputs:step.inputs });
    expect(fixture.calls.some(call => ["post", "patch"].includes(call.operation) && call.path.includes("sys_variable_value"))).toBe(false);
    fixture.assertConsumed();
  });
  it("saves through the parent form without writing the variable table", async () => {
    const def = definitions.impersonate; const input = def.inputs[0];
    const prepared = prepareSteps({ test_sys_id: id(1), steps: [{ type: "impersonate", inputs: { user: id(3) } }] }, false).args;
    const existing = { sys_id: id(4), document: "sys_atf_step", document_key: id(2), variable: input.variable, value: "" };
    const fixture = createMockServiceNowFixture([
      read([{sys_id:id(1),sys_scope:"global"}]),
      read([{ sys_id: def.step_config, name: def.name, step_env: def.step_env }]),
      read([{ sys_id: input.variable, element: input.element, internal_type: input.internal_type, mandatory: String(input.mandatory), order: input.order }]),
      { operation: "post", response: { result: { sys_id: id(2) } } }, read([]),
      { operation: "saveAtfStepInputs", response: undefined }, read([{ ...existing, value: id(3) }]),
    ]);
    expect(await authorSteps(prepared, { serviceNow: fixture.operations } as ServiceNowToolHandlerServices)).toMatchObject({ outcome: "created" });
    expect(fixture.calls.filter(call => call.operation === "post")).toHaveLength(1);
    expect(fixture.calls.find(call => call.operation === "saveAtfStepInputs")?.path).toBe("/sys_atf_step.do");
  });
  it("rejects metadata mismatches before writes and rolls back a failed input write", async () => {
    const def = definitions.impersonate, input = def.inputs[0];
    const args = { test_sys_id: id(1), steps: [{ type: "impersonate", inputs: { user: id(3) } }] };
    const wrong = createMockServiceNowFixture([read([{sys_id:id(1),sys_scope:"global"}]), read([{ name: "different", step_env: def.step_env }])]);
    expect(await authorSteps(prepareSteps(args, false).args, { serviceNow: wrong.operations } as ServiceNowToolHandlerServices)).toMatchObject({ outcome: "failed", uncertain_insert: false });
    expect(wrong.calls).toHaveLength(2);
    const fixture = createMockServiceNowFixture([
      read([{sys_id:id(1),sys_scope:"global"}]),
      read([{ name: def.name, step_env: def.step_env }]),
      read([{ sys_id: input.variable, element: input.element, internal_type: input.internal_type, mandatory: String(input.mandatory), order: input.order }]),
      { operation: "post", response: { result: { sys_id: id(2) } } }, read([]), { operation: "saveAtfStepInputs", error: new Error("failed") }, { operation: "delete", response: { status: 204 } }, read([]), read([]),
    ]);
    expect(await authorSteps(prepareSteps(args, false).args, { serviceNow: fixture.operations } as ServiceNowToolHandlerServices)).toMatchObject({ outcome: "failed", rolled_back: [id(2)], uncertain_insert: false });
    expect(fixture.calls.find(call => call.operation === "delete")?.path).toBe(`/api/now/table/sys_atf_step/${id(2)}`);
  });
  it.each(["valid", "wrong_test", "later_source", "missing_output", "bad_mapping"])("verifies reference ownership and stored mapping: %s", async scenario => {
    const def=definitions.record_validation;
    const pill=`{{step['${id(7)}'].first_record}}`;
    const prepared=prepareSteps({test_sys_id:id(1),start_order:200,steps:[{type:"record_validation",inputs:{table:"sys_atf_test",record_id:pill,field_values:"active=true"}}]},false);
    expect(prepared.requests).toContainEqual({operation:"write",table:"sys_element_mapping"});
    const values=prepared.args.preparedSteps[0].inputs;
    const source={sys_id:id(7),test:scenario==="wrong_test"?id(9):id(1),order:scenario==="later_source"?300:100,active:"true",step_config:definitions.record_query.step_config};
    const calls:MockServiceNowStep[]=[read([{sys_id:id(1),sys_scope:"global"}]),read([{name:def.name,step_env:def.step_env}]),read(def.inputs.map(input=>({sys_id:input.variable,element:input.element,internal_type:input.internal_type,mandatory:String(input.mandatory),order:input.order}))),read([source])];
    if(!["wrong_test","later_source"].includes(scenario)) calls.push(read(scenario==="missing_output"?[]:[{element:"first_record"}]));
    if(["valid","bad_mapping"].includes(scenario)) {
      calls.push({operation:"post",response:{result:{sys_id:id(2)}}},read([]),{operation:"saveAtfStepInputs",response:undefined},read(def.inputs.map((input,index)=>({sys_id:id(100+index),variable:input.variable,document:"sys_atf_step",document_key:id(2),value:input.element==="record_id"?"":values[input.element]}))),read([{sys_id:id(50),id:id(2),table:`var__m_atf_input_variable_${def.step_config}`,field:"record_id",value:scenario==="valid"?pill:"wrong"}]));
      if(scenario==="bad_mapping") calls.push({operation:"delete",response:{}},read([]),read([{sys_id:id(50),id:id(2),table:`var__m_atf_input_variable_${def.step_config}`}]),{operation:"delete",response:{}},read([]));
    }
    const fixture=createMockServiceNowFixture(calls);
    const result=await authorSteps(prepared.args,{serviceNow:fixture.operations} as ServiceNowToolHandlerServices);
    expect(result.outcome).toBe(scenario==="valid"?"created":"failed");
    if(["wrong_test","later_source","missing_output"].includes(scenario)) expect(fixture.calls.some(call=>call.operation==="post")).toBe(false);
    fixture.assertConsumed();
  });
  it("lists a read-only catalog action without instance writes", async () => {
    const access = atfAuthorToolModule.resolveAccess({ profile: "pdi", action: "list_step_types" }, policy);
    expect(access.requests).toEqual([]);
    const result = await atfAuthorToolModule.invoke(access.args, {} as ServiceNowToolHandlerServices);
    expect(result.structuredContent).toMatchObject({ data: { outcome: "catalog", step_types: expect.any(Array) } });
  });
});
