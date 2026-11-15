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
function explicit(extra: readonly string[] = []): TableAccessPolicyInput {
  const reads = [...new Set([...STEP_READ_TABLES, ...extra])];
  return {
    readTables: reads,
    writeTables: WRITES,
    targets: [...new Set([...reads, ...WRITES])].map((table) => target(table)),
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
    expect(message).toContain(`a "*" grant does not cover "${table}"`);
    expect(message).toContain(`--read ${table} --tools sn_atf_author`);
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
    expect(text(refused)).toContain('no read grant on "problem" that allows sn_atf_author');
    expect(text(refused)).toContain("--read problem --tools sn_atf_author");
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
    expect(text(result)).toContain('"problem" is granted to this profile, but not for sn_atf_author');
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

  it("does not govern the steps that run through the UI as the impersonated user", async () => {
    const connected = await connect(explicit());
    await addSteps(connected, [
      { type: "open_existing_record", inputs: { table: "sys_audit", record_id: SYS_ID } },
    ]);
    // Documented scope: only the two server-side record steps are checked here.
    expect(passedPolicy(connected)).toBe(true);
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
