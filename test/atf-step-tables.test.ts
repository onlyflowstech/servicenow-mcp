/**
 * The ATF record steps (`record_query`, `record_validation`) read the table they
 * name on the server, so authoring one is checked against the profile's read
 * grants (named-only tables included), their conditions against its field
 * policy, and their ACL enforcement cannot be turned off.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import type { FieldPolicyConfigurationInput } from "../src/field-policy.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy, type TableAccessPolicyInput } from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import { STEP_READ_TABLES, prepareSteps } from "../src/tools/atf-step-catalog.js";

const SYS_ID = "a".repeat(32);
const TEST_ID = "b".repeat(32);

const CONFIG: ServiceNowConfig = {
  instance: "https://named-only-test.service-now.com",
  user: "named-only-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};


const NAMED_ONLY = [
  "sys_audit",
  "sys_journal_field",
  "sys_history_line",
  "sys_audit_delete",
  "sys_attachment_doc",
  "sys_email",
] as const;
const STEP_TYPES = ["record_query", "record_validation"] as const;

function target(table: string, tools: readonly string[] = ["sn_atf_author"]) {
  return {
    table,
    kind: "canonical" as const,
    tools: [...tools],
    closureComplete: true as const,
    relatedTables: [table],
  };
}

/** One authoring step of `type` on `table`, with optional input overrides. */
function step(type: (typeof STEP_TYPES)[number], table: string, inputs: Record<string, unknown> = {}) {
  return {
    type,
    inputs:
      type === "record_query"
        ? { table, field_values: "active=true", ...inputs }
        : { table, record_id: SYS_ID, field_values: "active=true", ...inputs },
  };
}

const open: Array<{ client: Client; close: () => Promise<void> }> = [];

async function connect(
  tableAccessInput: TableAccessPolicyInput,
  fieldPolicy?: FieldPolicyConfigurationInput
) {
  const records: ToolAuditRecord[] = [];
  const serviceNowClient = {
    get: vi.fn(async () => ({ result: [{ sys_id: SYS_ID }] })),
    getWithMeta: vi.fn(async () => ({
      data: { result: [{ sys_id: SYS_ID }] },
      status: 200,
      headers: new Headers(),
    })),
    post: vi.fn(async () => ({ result: { sys_id: SYS_ID } })),
    patch: vi.fn(async () => ({ result: { sys_id: SYS_ID } })),
  } as unknown as ServiceNowClient;
  const getClient = vi.fn(() => serviceNowClient);
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: CONFIG.instance,
      username: CONFIG.user,
      credential: "env:NAMED_ONLY_SECRET_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => CONFIG),
    getClient,
  } as unknown as ProfileManager;
  const tableAccess = createTableAccessPolicy(tableAccessInput);
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `named-only-${String(requestId)}`,
        identity: { ownerId: "named-only-owner", clientId: "named-only-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "named-only-tables",
        revision: "named-only",
        tableAccess,
        ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
      }),
    },
    auditSink: {
      write: (record) => records.push(record),
      writePreContext: () => {},
    },
  };
  const server = await createMcpServer({
    dependencies: { profileManager, executionContext },
    register: (surface, dependencies) =>
      registerServiceNowTools(surface, dependencies.profileManager, dependencies.executionContext),
  });
  const client = new Client({ name: "named-only-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({
    client,
    close: async () => {
      await client.close();
      if (server.isConnected()) await server.close();
    },
  });
  return { client, records, getClient, serviceNowClient };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((entry) => entry.close()));
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text response");
  return first.text;
}


const WILDCARD: TableAccessPolicyInput = { readTables: ["*"], writeTables: ["*"], targets: [] };
const WRITES = ["sys_atf_step", "sys_variable_value", "sys_element_mapping"];

/** An explicit profile: the tables sn_atf_author needs, plus `extra` for reads. */
function explicit(extra: readonly string[] = [], extraWrites: readonly string[] = []): TableAccessPolicyInput {
  const reads = [...new Set([...STEP_READ_TABLES, ...extra])];
  const writes = [...new Set([...WRITES, ...extraWrites])];
  return {
    readTables: reads,
    writeTables: writes,
    targets: [...new Set([...reads, ...writes])].map((table) => target(table)),
  };
}

async function addSteps(
  connected: Awaited<ReturnType<typeof connect>>,
  steps: readonly unknown[]
) {
  return connected.client.callTool({
    name: "sn_atf_author",
    arguments: { profile: "atf-step", action: "add_steps", test_sys_id: TEST_ID, steps: [...steps] },
  });
}

/** True when the call got past every policy check (the handler then runs). */
function passedPolicy(
  connected: Awaited<ReturnType<typeof connect>>,
  result?: Awaited<ReturnType<Client["callTool"]>>
): boolean {
  const rejected = connected.records.at(-1)?.outcome === "policy_rejected";
  if (rejected && result !== undefined) throw new Error(`refused: ${text(result)}`);
  return !rejected;
}

describe("a record step's table is checked against the profile's read grants", () => {
  const cases = STEP_TYPES.flatMap((type) => NAMED_ONLY.map((table) => [type, table] as const));

  it.each(cases)("%s on %s is refused under a \"*\" grant, naming the table and the grant", async (type, table) => {
    const connected = await connect(WILDCARD);
    const result = await addSteps(connected, [step(type, table)]);
    expect(result.isError).toBe(true);
    const message = text(result);
    expect(message).toContain("Table access was denied by policy");
    expect(message).toContain("Table access was denied by policy");
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.post).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({
      tool: "sn_atf_author",
      outcome: "policy_rejected",
      reason: "table_access_denied",
    });
  });

  it.each(cases)("%s on %s is allowed once the profile names the table", async (type, table) => {
    const connected = await connect({
      readTables: ["*", table],
      writeTables: ["*"],
      targets: [target(table)],
    });
    const result = await addSteps(connected, [step(type, table)]);
    expect(passedPolicy(connected, result)).toBe(true);
    expect(connected.getClient).toHaveBeenCalled();
  });

  it.each(STEP_TYPES)("%s on an ordinary table works under a \"*\" grant", async (type) => {
    const connected = await connect(WILDCARD);
    const result = await addSteps(connected, [step(type, "incident")]);
    expect(passedPolicy(connected, result)).toBe(true);
  });

  it.each(STEP_TYPES)("%s on a table the profile cannot read is refused; a read grant allows it", async (type) => {
    const denied = await connect(explicit());
    const refused = await addSteps(denied, [step(type, "problem")]);
    expect(refused.isError).toBe(true);
    expect(denied.getClient).not.toHaveBeenCalled();

    const granted = await connect(explicit(["problem"]));
    await addSteps(granted, [step(type, "problem")]);
    expect(passedPolicy(granted)).toBe(true);
  });

  it("is bound to the tool: a grant for sn_query alone does not cover the step", async () => {
    const connected = await connect({
      ...explicit(),
      readTables: [...(explicit().readTables ?? []), "problem"],
      targets: [...(explicit().targets ?? []), target("problem", ["sn_query"])],
    });
    const result = await addSteps(connected, [step("record_query", "problem")]);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Table access was denied by policy");
  });

  it("refuses the whole call when one of several steps names a table that is not granted", async () => {
    const connected = await connect(WILDCARD);
    const result = await addSteps(connected, [
      step("record_query", "incident"),
      step("record_validation", "sys_email"),
    ]);
    expect(result.isError).toBe(true);
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.post).not.toHaveBeenCalled();
  });

  it("normalises the table before the check", async () => {
    const connected = await connect(WILDCARD);
    // A scoped look-alike is a different table, not the named-only one.
    const result = await addSteps(connected, [step("record_query", "x_acme_sys_audit")]);
    expect(passedPolicy(connected, result)).toBe(true);
  });
});

describe("a record step always enforces ACLs", () => {
  it.each(STEP_TYPES)("%s refuses enforce_security false with a fixed message", async (type) => {
    const connected = await connect(WILDCARD);
    const result = await addSteps(connected, [step(type, "incident", { enforce_security: false })]);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      "ATF step denied by policy: record_query and record_validation steps always enforce ACLs. " +
        "Leave enforce_security out, or set it to true."
    );
    expect(text(result)).not.toContain("incident");
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({
      outcome: "policy_rejected",
      reason: "atf_execution_denied",
    });
  });

  it.each(STEP_TYPES)("%s: leaving it out, or true, authors it with enforce_security true", (type) => {
    for (const inputs of [{}, { enforce_security: true }]) {
      const prepared = prepareSteps({ test_sys_id: TEST_ID, steps: [step(type, "incident", inputs)] }, false);
      expect(prepared.args.preparedSteps[0]!.inputs.enforce_security).toBe("true");
    }
  });

  it("leaves enforce_security alone on other steps", () => {
    expect(() =>
      prepareSteps(
        { test_sys_id: TEST_ID, steps: [{ type: "open_new_form", inputs: { table: "incident", view: "", enforce_security: false } }] },
        false
      )
    ).not.toThrow(/denied by policy/u);
  });
});

describe("a record step's conditions are checked against the table's field policy", () => {
  const policy = { fieldPolicy: { incident: { readable: ["sys_id", "number", "state"] } } };

  it.each(STEP_TYPES)("%s refuses a condition on a field the profile may not read", async (type) => {
    const connected = await connect(WILDCARD, policy);
    const result = await addSteps(connected, [step(type, "incident", { field_values: "short_description=secret" })]);
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("Table access was denied");
    expect(text(result)).not.toContain("secret");
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected", reason: "field_access_denied" });
  });

  it.each(STEP_TYPES)("%s accepts readable fields, with OR, EQ, NQ and ORDERBY terms", async (type) => {
    const connected = await connect(WILDCARD, policy);
    const result = await addSteps(connected, [
      step(type, "incident", { field_values: "number=INC0010001^ORstate=2^EQ" }),
    ]);
    expect(passedPolicy(connected, result)).toBe(true);
    const second = await addSteps(connected, [
      step(type, "incident", { field_values: "numberSTARTSWITHINC^NQstateIN1,2^ORDERBYnumber" }),
    ]);
    expect(passedPolicy(connected, second)).toBe(true);
  });

  it.each([
    ["a dot-walk", "caller_id.name=x"],
    ["a dot-walk after OR", "number=1^ORcaller_id.user_name=x"],
    ["a condition that is only a step output", "{{step['" + "c".repeat(32) + "'].conditions}}"],
    ["a term it does not recognise", "=x"],
    ["an empty term", "number=1^^state=2"],
    ["a sensitive-name field", "user_password=x"],
  ])("refuses %s", async (_name, conditions) => {
    const connected = await connect(WILDCARD);
    const result = await addSteps(connected, [step("record_query", "incident", { field_values: conditions })]);
    expect(result.isError).toBe(true);
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected", reason: "field_access_denied" });
  });

  it("uses the table's own entry for each table", async () => {
    const connected = await connect(WILDCARD, {
      fieldPolicy: { change_request: { readable: ["sys_id", "number"] }, problem: { readable: ["sys_id", "state"] } },
    });
    const refused = await addSteps(connected, [step("record_query", "change_request", { field_values: "state=2" })]);
    expect(refused.isError).toBe(true);
    const allowed = await addSteps(connected, [step("record_query", "problem", { field_values: "state=2" })]);
    expect(passedPolicy(connected, allowed)).toBe(true);
  });

  it("applies the entry for a named-only table once the profile names it", async () => {
    const connected = await connect(
      { readTables: ["*", "sys_audit"], writeTables: ["*"], targets: [target("sys_audit")] },
      { fieldPolicy: { sys_audit: { readable: ["sys_id", "fieldname"] } } }
    );
    const hidden = await addSteps(connected, [step("record_query", "sys_audit", { field_values: "newvalue=x" })]);
    expect(hidden.isError).toBe(true);
    const shown = await addSteps(connected, [step("record_query", "sys_audit", { field_values: "fieldname=state" })]);
    expect(passedPolicy(connected, shown)).toBe(true);
  });

  it("checks no conditions when a record_validation step states none", () => {
    expect(() =>
      prepareSteps(
        { test_sys_id: TEST_ID, steps: [{ type: "record_validation", inputs: { table: "incident", record_id: SYS_ID } }] },
        false
      )
    ).not.toThrow();
  });
});

describe("the catalog listing is unchanged", () => {
  it("still lists both steps", async () => {
    const connected = await connect(WILDCARD);
    const result = await connected.client.callTool({
      name: "sn_atf_author",
      arguments: { profile: "atf-step", action: "list_step_types" },
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("record_query");
    expect(text(result)).toContain("record_validation");
  });
});

/** The four UI steps, with the access each needs and the inputs that make a valid step. */
const UI_STEPS = [
  { type: "field_values_validation", access: "read", inputs: (table: string) => ({ table, conditions: "active=true" }) },
  { type: "open_existing_record", access: "read", inputs: (table: string) => ({ table, record_id: SYS_ID }) },
  { type: "open_new_form", access: "write", inputs: (table: string) => ({ table }) },
  { type: "set_field_values", access: "write", inputs: (table: string) => ({ table, field_values: "short_description=x" }) },
] as const;

describe("the UI steps that name a table are checked too", () => {
  const cases = UI_STEPS.flatMap((ui) => NAMED_ONLY.map((table) => [ui.type, table] as const));
  const byType = (type: string) => UI_STEPS.find((ui) => ui.type === type)!;

  it.each(cases)("%s on %s is refused under a \"*\" grant, naming the table and the grant", async (type, table) => {
    const ui = byType(type);
    const connected = await connect(WILDCARD);
    const result = await addSteps(connected, [{ type, inputs: ui.inputs(table) }]);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Table access was denied by policy");
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.post).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected", reason: "table_access_denied" });
  });

  it.each(cases)("%s on %s is allowed once the profile names the table for that operation", async (type, table) => {
    const ui = byType(type);
    const connected = await connect({
      readTables: ["*", table],
      writeTables: ["*", table],
      targets: [target(table)],
    });
    const result = await addSteps(connected, [{ type, inputs: ui.inputs(table) }]);
    expect(passedPolicy(connected, result)).toBe(true);
  });

  it.each(UI_STEPS.filter((ui) => ui.access === "write"))("%s needs a write grant, not only a read grant", async (ui) => {
    const readOnly = await connect(explicit(["sys_properties"]));
    const refused = await addSteps(readOnly, [{ type: ui.type, inputs: ui.inputs("sys_properties") }]);
    expect(refused.isError).toBe(true);
    expect(readOnly.getClient).not.toHaveBeenCalled();

    const granted = await connect(explicit(["sys_properties"], ["sys_properties"]));
    const allowed = await addSteps(granted, [{ type: ui.type, inputs: ui.inputs("sys_properties") }]);
    expect(passedPolicy(granted, allowed)).toBe(true);
  });

  it.each(UI_STEPS.filter((ui) => ui.access === "read"))("%s needs a read grant", async (ui) => {
    const connected = await connect(explicit());
    const refused = await addSteps(connected, [{ type: ui.type, inputs: ui.inputs("problem") }]);
    expect(refused.isError).toBe(true);
    const granted = await connect(explicit(["problem"]));
    const allowed = await addSteps(granted, [{ type: ui.type, inputs: ui.inputs("problem") }]);
    expect(passedPolicy(granted, allowed)).toBe(true);
  });

  it("puts the right operation in the plan for each step", () => {
    for (const ui of UI_STEPS) {
      const plan = prepareSteps({ test_sys_id: TEST_ID, steps: [{ type: ui.type, inputs: ui.inputs("problem") }] }, false);
      expect(plan.requests, ui.type).toContainEqual({ operation: ui.access, table: "problem" });
      const other = ui.access === "read" ? "write" : "read";
      expect(plan.requests, ui.type).not.toContainEqual({ operation: other, table: "problem" });
    }
  });

  it("checks the conditions of field_values_validation like those of a record step", async () => {
    const policy = { fieldPolicy: { incident: { readable: ["sys_id", "number"] } } };
    const connected = await connect(WILDCARD, policy);
    const hidden = await addSteps(connected, [
      { type: "field_values_validation", inputs: { table: "incident", conditions: "short_description=x" } },
    ]);
    expect(hidden.isError).toBe(true);
    expect(connected.records.at(-1)).toMatchObject({ reason: "field_access_denied" });
    const secondField = await addSteps(connected, [
      { type: "field_values_validation", inputs: { table: "incident", conditions: "numberSAMEASshort_description" } },
    ]);
    expect(secondField.isError).toBe(true);
    const shown = await addSteps(connected, [
      { type: "field_values_validation", inputs: { table: "incident", conditions: "number=INC0010001" } },
    ]);
    expect(passedPolicy(connected, shown)).toBe(true);
  });

  it("leaves enforce_security alone: these steps have no such input", () => {
    expect(() =>
      prepareSteps({ test_sys_id: TEST_ID, steps: [{ type: "open_new_form", inputs: { table: "incident" } }] }, false)
    ).not.toThrow();
  });

  it("still plans nothing for the steps that name no table", () => {
    const plan = prepareSteps({ test_sys_id: TEST_ID, steps: [{ type: "submit_form", inputs: {} }] }, false);
    const stepTables = plan.requests.filter((r) => !["sys_atf_test", "sys_atf_step", "sys_atf_step_config", "var_dictionary", "sys_variable_value", "sys_element_mapping"].includes(r.table));
    expect(stepTables).toEqual([]);
  });
});

describe("a condition may use only operators that compare a field with a literal", () => {
  const readable = { fieldPolicy: { incident: { readable: ["sys_id", "number", "state", "sys_created_on"] } } };
  const ALLOWED: ReadonlyArray<readonly [string, string]> = [
    ["=", "number=INC0010001"],
    ["!=", "state!=7"],
    ["<", "state<3"],
    ["<=", "state<=3"],
    [">", "state>3"],
    [">=", "state>=3"],
    ["LIKE", "numberLIKE001"],
    ["NOT LIKE", "numberNOT LIKE001"],
    ["STARTSWITH", "numberSTARTSWITHINC"],
    ["ENDSWITH", "numberENDSWITH01"],
    ["IN", "stateIN1,2,3"],
    ["NOT IN", "stateNOT IN6,7"],
    ["ISEMPTY", "numberISEMPTY"],
    ["ISNOTEMPTY", "numberISNOTEMPTY"],
    ["BETWEEN", "sys_created_onBETWEEN2024-01-01@2024-12-31"],
    ["OR prefix", "number=1^ORstate=2"],
    ["NQ prefix", "number=1^NQstate=2"],
    ["ORDERBY", "number=1^ORDERBYnumber"],
    ["ORDERBYDESC", "number=1^ORDERBYDESCnumber"],
    ["GROUPBY", "number=1^GROUPBYstate"],
    ["EQ", "number=1^EQ"],
  ];
  // A hidden field (short_description) in the second-field position, one per operator form.
  const REFUSED: ReadonlyArray<readonly [string, string]> = [
    ["SAMEAS", "numberSAMEASshort_description"],
    ["NSAMEAS", "numberNSAMEASshort_description"],
    ["GT_FIELD", "stateGT_FIELDshort_description"],
    ["LT_FIELD", "stateLT_FIELDshort_description"],
    ["GT_OR_EQUALS_FIELD", "stateGT_OR_EQUALS_FIELDshort_description"],
    ["LT_OR_EQUALS_FIELD", "stateLT_OR_EQUALS_FIELDshort_description"],
    ["MORETHAN", "sys_created_onMORETHANshort_description@hour@after@1"],
    ["LESSTHAN", "sys_created_onLESSTHANshort_description@hour@ago@1"],
    ["DYNAMIC", "stateDYNAMIC" + "d".repeat(32)],
    ["VALCHANGES", "stateVALCHANGES"],
    ["CHANGESFROM", "stateCHANGESFROM1"],
    ["CHANGESTO", "stateCHANGESTO2"],
    ["ANYTHING", "stateANYTHING"],
    ["INSTANCEOF", "numberINSTANCEOFtask"],
    ["NOT INSTANCEOF", "numberNOT INSTANCEOFtask"],
    ["RELATIVEGT", "sys_created_onRELATIVEGT@hour@ago@1"],
    ["ON (date)", "sys_created_onONThis week@2024-01-01@2024-01-07"],
    ["a lower-case operator", "numberlikeabc"],
    ["no operator", "number"],
    ["a unary operator with a value", "numberISEMPTYshort_description"],
    ["ORDERBY with an operator", "number=1^ORDERBYnumber=short_description"],
    ["RLQUERY", "RLQUERYsys_audit.documentkey,>0,m2m^ENDRLQUERY"],
  ];

  it.each(ALLOWED)("accepts %s", (_name, conditions) => {
    for (const [type, key] of [["record_query", "field_values"], ["record_validation", "field_values"], ["field_values_validation", "conditions"]] as const) {
      const inputs = type === "record_validation" ? { table: "incident", record_id: SYS_ID, [key]: conditions } : { table: "incident", [key]: conditions };
      expect(() => prepareSteps({ test_sys_id: TEST_ID, steps: [{ type, inputs }] }, false), `${type}: ${conditions}`).not.toThrow();
    }
  });

  it.each(REFUSED)("refuses %s", (_name, conditions) => {
    for (const [type, key] of [["record_query", "field_values"], ["record_validation", "field_values"], ["field_values_validation", "conditions"]] as const) {
      const inputs = type === "record_validation" ? { table: "incident", record_id: SYS_ID, [key]: conditions } : { table: "incident", [key]: conditions };
      expect(() => prepareSteps({ test_sys_id: TEST_ID, steps: [{ type, inputs }] }, false), `${type}: ${conditions}`).toThrow();
    }
  });

  it.each(REFUSED)("%s leaves the hidden field untested, through the dispatcher", async (_name, conditions) => {
    const connected = await connect(WILDCARD, readable);
    const result = await addSteps(connected, [step("record_query", "incident", { field_values: conditions })]);
    expect(result.isError).toBe(true);
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected", reason: "field_access_denied" });
    expect(text(result)).not.toContain("short_description");
  });

  it.each(ALLOWED)("%s passes the dispatcher on readable fields", async (_name, conditions) => {
    const connected = await connect(WILDCARD, readable);
    const result = await addSteps(connected, [step("record_query", "incident", { field_values: conditions })]);
    expect(passedPolicy(connected, result)).toBe(true);
  });
});

describe("a condition value may refer only to record-id or sys_id outputs", () => {
  const ref = (output: string, id = "c".repeat(32)) => `{{step['${id}'].${output}}}`;
  const BEARERS = [
    ["record_query", "field_values"],
    ["record_validation", "field_values"],
    ["field_values_validation", "conditions"],
  ] as const;
  const inputsFor = (type: (typeof BEARERS)[number][0], key: string, conditions: string) =>
    type === "record_validation" ? { table: "incident", record_id: SYS_ID, [key]: conditions } : { table: "incident", [key]: conditions };

  it.each(["record_id", "first_record", "sys_id", "user"])("accepts the %s output", (output) => {
    for (const [type, key] of BEARERS) {
      expect(() =>
        prepareSteps({ test_sys_id: TEST_ID, steps: [{ type, inputs: inputsFor(type, key, `caller_id=${ref(output)}^EQ`) }] }, false)
      , `${type} ${output}`).not.toThrow();
    }
  });

  it("accepts several pills, in a list and next to other terms", () => {
    expect(() =>
      prepareSteps({ test_sys_id: TEST_ID, steps: [step("record_query", "incident", {
        field_values: `stateIN${ref("record_id")},${ref("first_record", "d".repeat(32))}^ORcaller_id=${ref("user")}`,
      })] }, false)
    ).not.toThrow();
  });

  it.each([
    ["a table output", `number=${ref("table")}`],
    ["a script output", `number=${ref("script_output")}`],
    ["an output name that only starts with an allowed one", `number=${ref("record_id_list")}`],
    ["a step id that is not a sys_id", `number=${ref("record_id", "c".repeat(31))}`],
    ["a pill that is not a step output", "number={{gs.getUserID()}}"],
    ["an unclosed pill", `number={{step['${"c".repeat(32)}'].record_id`],
    ["a stray closing pair", "number=x}}"],
    ["a good pill beside a bad one", `number=${ref("record_id")}^ORstate=${ref("table")}`],
    ["a pill with a space inside", `number={{ step['${"c".repeat(32)}'].record_id }}`],
  ])("refuses %s", (_name, conditions) => {
    for (const [type, key] of BEARERS) {
      expect(() =>
        prepareSteps({ test_sys_id: TEST_ID, steps: [{ type, inputs: inputsFor(type, key, conditions) }] }, false)
      , `${type}: ${conditions}`).toThrow();
    }
  });

  it("refuses through the dispatcher with the field-policy message, before any write", async () => {
    const connected = await connect(WILDCARD);
    const result = await addSteps(connected, [step("record_query", "incident", { field_values: `number=${ref("table")}` })]);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      "ERROR: Access denied by policy (invalid_field_selection). Correlation ID: named-only-" +
        connected.records.at(-1)!.correlationId!.split("-").at(-1) + "."
    );
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected", reason: "field_access_denied" });
  });
});

describe("set_field_values may set only fields the profile may write", () => {
  const setStep = (table: string, values: string) => ({ type: "set_field_values", inputs: { table, field_values: values } });
  const policy = { fieldPolicy: { incident: { writable: ["short_description", "state"] } } };

  it("accepts writable fields, and a template with EQ", async () => {
    const connected = await connect(WILDCARD, policy);
    const result = await addSteps(connected, [setStep("incident", "short_description=Example^state=2^EQ")]);
    expect(passedPolicy(connected, result)).toBe(true);
  });

  it.each([
    ["a field the profile may not write", "assigned_to=abc"],
    ["one such field among writable ones", "short_description=x^assigned_to=abc"],
    ["a sensitive-name field", "user_password=x"],
    ["a class field, which a wildcard never covers", "sys_class_name=incident"],
    ["a domain field", "sys_domain=global"],
    ["a dot-walked field", "caller_id.name=x"],
    ["a term with no field", "=x"],
    ["a term with no value separator", "short_description"],
  ])("refuses %s", async (_name, values) => {
    const connected = await connect(WILDCARD, policy);
    const result = await addSteps(connected, [setStep("incident", values)]);
    expect(result.isError).toBe(true);
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected", reason: "field_access_denied" });
  });

  it("uses the table's own entry, so a field open on one table is refused on another", async () => {
    const connected = await connect(WILDCARD, {
      fieldPolicy: { incident: { writable: ["state"] }, problem: { writable: ["short_description"] } },
    });
    const refused = await addSteps(connected, [setStep("problem", "state=2")]);
    expect(refused.isError).toBe(true);
    const allowed = await addSteps(connected, [setStep("problem", "short_description=x")]);
    expect(passedPolicy(connected, allowed)).toBe(true);
  });

  it("applies what sn_update applies to a named-only table once the profile names it", async () => {
    const connected = await connect(
      { readTables: ["*"], writeTables: ["*", "sys_audit"], targets: [target("sys_audit")] },
      { fieldPolicy: { sys_audit: { writable: ["reason"] } } }
    );
    const refused = await addSteps(connected, [setStep("sys_audit", "newvalue=x")]);
    expect(refused.isError).toBe(true);
    const allowed = await addSteps(connected, [setStep("sys_audit", "reason=x")]);
    expect(passedPolicy(connected, allowed)).toBe(true);
  });

  it("leaves other steps' inputs alone", () => {
    expect(() =>
      prepareSteps({ test_sys_id: TEST_ID, steps: [{ type: "open_new_form", inputs: { table: "incident" } }] }, false)
    ).not.toThrow();
  });

  describe("a value may hold only the pills a condition value may", () => {
    const ref = (output: string, id = "c".repeat(32)) => `{{step['${id}'].${output}}}`;
    const plan = (values: string) =>
      prepareSteps({ test_sys_id: TEST_ID, steps: [setStep("incident", values)] }, false);

    it.each(["record_id", "first_record", "sys_id", "user"])("accepts the %s output", (output) => {
      expect(() => plan(`caller_id=${ref(output)}^short_description=x^EQ`)).not.toThrow();
    });

    it("accepts several allowed pills", () => {
      expect(() => plan(`caller_id=${ref("user")}^assigned_to=${ref("record_id", "d".repeat(32))}`)).not.toThrow();
    });

    it.each([
      ["a table output", `short_description=${ref("table")}`],
      ["a script output", `short_description=${ref("script_output")}`],
      ["a pill that is not a step output", "short_description={{gs.getUserID()}}"],
      ["an unclosed pill", `short_description={{step['${"c".repeat(32)}'].record_id`],
      ["a stray closing pair", "short_description=x}}"],
      ["a good pill beside a bad one", `caller_id=${ref("user")}^short_description=${ref("table")}`],
    ])("refuses %s", (_name, values) => {
      expect(() => plan(values)).toThrow();
    });

    it("refuses through the dispatcher before any write, with the field-policy message", async () => {
      const connected = await connect(WILDCARD);
      const result = await addSteps(connected, [setStep("incident", `short_description=${ref("table")}`)]);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Access denied by policy (invalid_field_selection)");
      expect(connected.getClient).not.toHaveBeenCalled();
      expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected", reason: "field_access_denied" });
    });
  });
});
