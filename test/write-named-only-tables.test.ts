/**
 * `sys_atf_step`, `sys_variable_value` and `sys_element_mapping` hold what `sn_atf_author` checks when
 * it adds a step, so a "*" write grant covers them for that tool only. The
 * generic write tools reach them when the profile names the table for write.
 * Reads are unchanged.
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
import {
  WRITE_NAMED_ONLY_TABLES,
  TablePolicyError,
  authorizeTableAccess,
  createTableAccessPolicy,
  tablePolicyDenialMessage,
  type TableAccessPolicyInput,
} from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import { noHiddenFieldTypes } from "./fixtures/field-types.js";

const SYS_ID = "a".repeat(32);

const CONFIG: ServiceNowConfig = {
  instance: "https://named-only-test.service-now.com",
  user: "named-only-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};


const LISTED = ["sys_atf_step", "sys_variable_value", "sys_element_mapping"] as const;
const UNLISTED_ATF = ["sys_atf_test", "sys_atf_test_suite", "sys_atf_test_suite_test"] as const;

function target(table: string, tools: readonly string[]) {
  return {
    table,
    kind: "canonical" as const,
    tools: [...tools],
    closureComplete: true as const,
    relatedTables: [table],
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
    // Stands in for the field-type lookup this double does not serve.
    fieldTypeLoader: noHiddenFieldTypes,
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



/** The generic write tools, each with arguments for `table`. */
const WRITE_TOOLS = {
  sn_create: (table: string) => ({ table, fields: { description: "x" } }),
  sn_update: (table: string) => ({ table, sys_id: SYS_ID, fields: { description: "x" } }),
  sn_delete: (table: string) => ({ table, sys_id: SYS_ID, confirm: true }),
  sn_batch: (table: string) => ({
    table,
    action: "update",
    confirm: true,
    fields: { description: "x" },
    structured_query: { filter: { type: "equality", field: "sys_id", operator: "eq", value: SYS_ID } },
  }),
} as const;
type WriteTool = keyof typeof WRITE_TOOLS;
const cases = (Object.keys(WRITE_TOOLS) as WriteTool[]).flatMap((tool) => LISTED.map((table) => [tool, table] as const));

const WILD_WRITE: TableAccessPolicyInput = { readTables: ["*"], writeTables: ["*"], targets: [] };

describe("the write-named tables under a \"*\" write grant", () => {
  it("are exactly the three ATF step tables, each open to sn_atf_author alone", () => {
    expect(Object.keys(WRITE_NAMED_ONLY_TABLES).sort()).toEqual([...LISTED].sort());
    for (const table of LISTED) expect(WRITE_NAMED_ONLY_TABLES[table]).toEqual(["sn_atf_author"]);
    expect(Object.isFrozen(WRITE_NAMED_ONLY_TABLES)).toBe(true);
  });

  it.each(cases)("%s on %s is refused, naming the table and the grant", async (tool, table) => {
    const connected = await connect(WILD_WRITE);
    const result = await connected.client.callTool({
      name: tool,
      arguments: { profile: "write-named", ...WRITE_TOOLS[tool](table) },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`a "*" grant does not cover "${table}"`);
    expect(text(result)).toContain(`--write ${table} --tools ${tool}`);
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({ tool, outcome: "policy_rejected", reason: "table_access_denied" });
  });

  it.each(cases)("%s on %s is allowed once the profile names the table for write", async (tool, table) => {
    const connected = await connect({ readTables: ["*"], writeTables: ["*", table], targets: [] });
    const result = await connected.client.callTool({
      name: tool,
      arguments: { profile: "write-named", ...WRITE_TOOLS[tool](table) },
    });
    expect(connected.records.at(-1)?.outcome, text(result)).not.toBe("policy_rejected");
    expect(connected.getClient).toHaveBeenCalled();
  });

  it.each(cases)("%s on %s: naming it for a different tool binds the tool", async (tool, table) => {
    const connected = await connect({
      readTables: ["*"],
      writeTables: ["*", table],
      targets: [target(table, ["sn_atf_author"])],
    });
    const result = await connected.client.callTool({
      name: tool,
      arguments: { profile: "write-named", ...WRITE_TOOLS[tool](table) },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`"${table}" is granted to this profile, but not for ${tool}`);
  });

  it.each(LISTED)("an attachment upload to a record of %s is refused under \"*\"", async (table) => {
    const connected = await connect(WILD_WRITE);
    const result = await connected.client.callTool({
      name: "sn_attach",
      arguments: { profile: "write-named", action: "upload", table, sys_id: SYS_ID, file_name: "a.txt", content_type: "text/plain", content_base64: "eA==" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`a "*" grant does not cover "${table}"`);
    expect(connected.getClient).not.toHaveBeenCalled();
  });

  it.each(LISTED)("sn_atf_author keeps its planned writes to %s under \"*\"", (table) => {
    const policy = createTableAccessPolicy(WILD_WRITE);
    expect(authorizeTableAccess(policy, { operation: "write", table }, "sn_atf_author")).toBe(table);
    // Any other tool name is refused, whatever it is called.
    for (const tool of ["sn_update", "sn_atf_author_x", "sn_atf_run"]) {
      expect(() => authorizeTableAccess(policy, { operation: "write", table }, tool), `${tool} ${table}`).toThrow(
        TablePolicyError
      );
    }
  });

  it("sn_atf_author adds steps under a bare \"*\" write grant", async () => {
    const connected = await connect(WILD_WRITE);
    const result = await connected.client.callTool({
      name: "sn_atf_author",
      arguments: {
        profile: "write-named",
        action: "add_steps",
        test_sys_id: "b".repeat(32),
        steps: [{ type: "record_query", inputs: { table: "incident", field_values: "active=true" } }],
      },
    });
    expect(connected.records.at(-1)?.outcome, text(result)).not.toBe("policy_rejected");
  });

  it.each(LISTED)("reads of %s are unchanged under a \"*\" read grant", async (table) => {
    const connected = await connect({ readTables: ["*"], writeTables: [], targets: [] });
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "write-named", table },
    });
    expect(connected.records.at(-1)?.outcome, text(result)).not.toBe("policy_rejected");
  });

  it.each(UNLISTED_ATF)("%s stays covered by a \"*\" write grant: nothing sn_atf_author checks is stored in it", async (table) => {
    const connected = await connect(WILD_WRITE);
    const result = await connected.client.callTool({
      name: "sn_update",
      arguments: { profile: "write-named", ...WRITE_TOOLS.sn_update(table) },
    });
    expect(connected.records.at(-1)?.outcome, text(result)).not.toBe("policy_rejected");
  });

  it("leaves the other tables and the other write tools as they were under \"*\"", () => {
    const policy = createTableAccessPolicy(WILD_WRITE);
    for (const table of ["incident", "sys_user", "sys_script_include", "sys_atf_agent", "x_acme_widget"]) {
      expect(authorizeTableAccess(policy, { operation: "write", table }, "sn_update"), table).toBe(table);
    }
  });

  it("uses the same denial shape as the named-only tables, with --write", () => {
    const policy = createTableAccessPolicy(WILD_WRITE);
    let denial: unknown;
    try {
      authorizeTableAccess(policy, { operation: "write", table: "sys_atf_step" }, "sn_update");
    } catch (error) {
      denial = error;
    }
    expect(denial).toBeInstanceOf(TablePolicyError);
    expect(tablePolicyDenialMessage(denial as TablePolicyError)).toBe(
      'Table access was denied by policy: a "*" grant does not cover "sys_atf_step". ' +
        'This profile has no write grant on "sys_atf_step" that allows sn_update. To allow it, run: ' +
        "servicenow-mcp-setup grant --profile <profile> --write sys_atf_step --tools sn_update, then restart the MCP client."
    );
  });

  it("refuses a related-table declaration that only a \"*\" write grant would cover, naming the table", () => {
    expect(() =>
      createTableAccessPolicy({
        writeTables: ["*"],
        targets: [
          { table: "incident", kind: "view", tools: ["sn_update"], closureComplete: true, relatedTables: ["incident", "sys_variable_value"] },
        ],
      })
    ).toThrow('"sys_variable_value" must be granted by name');
    // The same declaration is fine for reads.
    expect(() =>
      createTableAccessPolicy({
        readTables: ["*"],
        targets: [
          { table: "incident", kind: "view", tools: ["sn_query"], closureComplete: true, relatedTables: ["incident", "sys_variable_value"] },
        ],
      })
    ).not.toThrow();
  });
});
