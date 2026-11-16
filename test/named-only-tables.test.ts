/**
 * The named-only tables (`sys_audit`, `sys_journal_field`, `sys_history_line`,
 * `sys_audit_delete`, `sys_attachment_doc`, `sys_email`) are granted by name
 * only: a "*" table grant covers every other table, but never these, for any
 * read path or for writes. A profile that names them reaches them, and the
 * field policy applies to them, a profile's "*" field entry included.
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
import {
  BUILT_IN_TABLE_CLASSES,
  resolveReadableFields,
  type FieldPolicyConfigurationInput,
} from "../src/field-policy.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import {
  NAMED_ONLY_TABLES,
  TablePolicyError,
  WRITE_NAMED_ONLY_TABLES,
  authorizeTableAccess,
  createTableAccessPolicy,
  type TableAccessPolicyInput,
} from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";
import { noHiddenFieldTypes } from "./fixtures/field-types.js";

const NAMED_ONLY = [
  "sys_audit",
  "sys_journal_field",
  "sys_history_line",
  "sys_audit_delete",
  "sys_attachment_doc",
  "sys_email",
] as const;

/** The columns each table's default projection must leave out. */
const VALUE_COLUMNS: Readonly<Record<(typeof NAMED_ONLY)[number], readonly string[]>> = {
  sys_audit: ["oldvalue", "newvalue"],
  sys_journal_field: ["value"],
  sys_history_line: ["old", "new", "old_value", "new_value"],
  sys_audit_delete: ["payload"],
  sys_attachment_doc: ["data"],
  sys_email: [
    "body",
    "body_text",
    "subject",
    "recipients",
    "copied",
    "blind_copied",
    "reply_to",
    "headers",
    "error_string",
  ],
};
const SYS_ID = "a".repeat(32);

const CONFIG: ServiceNowConfig = {
  instance: "https://named-only-test.service-now.com",
  user: "named-only-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};

const READ_TOOLS = [
  "sn_query",
  "sn_get",
  "sn_aggregate",
  "sn_schema",
  "sn_batch",
] as const;

function target(table: string, tools: readonly string[] = READ_TOOLS) {
  return {
    table,
    kind: "canonical" as const,
    tools: [...tools],
    closureComplete: true as const,
    relatedTables: [table],
  };
}

function argumentsFor(tool: (typeof READ_TOOLS)[number], table: string) {
  switch (tool) {
    case "sn_query":
      return { table };
    case "sn_get":
      return { table, sys_id: SYS_ID };
    case "sn_aggregate":
      return { table, type: "COUNT" };
    case "sn_schema":
      return { table };
    case "sn_batch":
      return {
        table,
        action: "update",
        structured_query: {
          filter: { type: "equality", field: "sys_id", operator: "eq", value: SYS_ID },
        },
        fields: { description: "probe" },
        confirm: false,
      };
  }
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

const WILDCARD: TableAccessPolicyInput = { readTables: ["*"], targets: [] };

describe("the named-only table list", () => {
  it("is exactly these six tables, each a built-in named-only table, none a system table", () => {
    expect([...NAMED_ONLY_TABLES]).toEqual([...NAMED_ONLY]);
    expect(Object.isFrozen(NAMED_ONLY_TABLES)).toBe(true);
    expect([...BUILT_IN_TABLE_CLASSES.namedOnly].sort()).toEqual([...NAMED_ONLY].sort());
    for (const table of NAMED_ONLY_TABLES) {
      expect(BUILT_IN_TABLE_CLASSES.builtIn, table).toContain(table);
      expect(BUILT_IN_TABLE_CLASSES.system, table).not.toContain(table);
      expect(BUILT_IN_TABLE_CLASSES.itsm, table).not.toContain(table);
    }
  });

  it("leaves the 23 system tables and the ITSM tables as they were", () => {
    const earlier = BUILT_IN_TABLE_CLASSES.system;
    expect(earlier).toHaveLength(23);
    const policy = createTableAccessPolicy({
      readTables: ["*"],
      writeTables: ["*"],
      targets: [],
    });
    for (const table of [...earlier, ...BUILT_IN_TABLE_CLASSES.itsm]) {
      for (const operation of ["read", "write"] as const) {
        // Writes to the ATF step tables are covered by "*" for sn_atf_author only.
        if (operation === "write" && Object.hasOwn(WRITE_NAMED_ONLY_TABLES, table)) continue;
        expect(
          authorizeTableAccess(policy, { operation, table }, "sn_query"),
          `${operation} ${table}`
        ).toBe(table);
      }
    }
  });
});

describe('a "*" table grant does not reach the named-only tables', () => {
  it.each(NAMED_ONLY)("denies read of %s under readTables [*]", (table) => {
    const policy = createTableAccessPolicy(WILDCARD);
    expect(() => authorizeTableAccess(policy, { operation: "read", table }, "sn_query")).toThrow(
      TablePolicyError
    );
    // Other tables stay covered.
    expect(authorizeTableAccess(policy, { operation: "read", table: "incident" }, "sn_query")).toBe(
      "incident"
    );
    expect(
      authorizeTableAccess(policy, { operation: "read", table: "x_acme_widget" }, "sn_query")
    ).toBe("x_acme_widget");
  });

  it.each(NAMED_ONLY)("denies write of %s under writeTables [*]", (table) => {
    const policy = createTableAccessPolicy({ writeTables: ["*"], targets: [] });
    expect(() => authorizeTableAccess(policy, { operation: "write", table }, "sn_update")).toThrow(
      TablePolicyError
    );
  });

  it("is not defeated by case or padding in the requested name", () => {
    const policy = createTableAccessPolicy(WILDCARD);
    for (const table of [" SYS_AUDIT ", "Sys_Journal_Field"]) {
      expect(() =>
        authorizeTableAccess(policy, { operation: "read", table }, "sn_query")
      ).toThrow(TablePolicyError);
    }
  });

  it("gives the usual fixed denial, which echoes neither the table nor the profile's grants", () => {
    const policy = createTableAccessPolicy({
      readTables: ["*", "u_secret_thing"],
      targets: [target("u_secret_thing", ["sn_query"])],
    });
    for (const operation of ["read"] as const) {
      let denial: unknown;
      try {
        authorizeTableAccess(policy, { operation, table: "sys_audit" }, "sn_query");
      } catch (error) {
        denial = error;
      }
      expect(denial).toBeInstanceOf(TablePolicyError);
      expect((denial as Error).message).toBe("Table access denied by policy");
    }
  });

  it("refuses a related-table declaration that only a wildcard would cover", () => {
    expect(() =>
      createTableAccessPolicy({
        readTables: ["*"],
        targets: [
          {
            table: "incident",
            kind: "view",
            tools: ["sn_query"],
            closureComplete: true,
            relatedTables: ["incident", "sys_audit"],
          },
        ],
      })
    ).toThrow(TypeError);
  });
});

describe("a profile that names the tables reaches them", () => {
  it("grants a table named beside a wildcard, only for the tools its target allows", () => {
    const policy = createTableAccessPolicy({
      readTables: ["*", "sys_audit"],
      targets: [target("sys_audit", ["sn_query"])],
    });
    expect(authorizeTableAccess(policy, { operation: "read", table: "sys_audit" }, "sn_query")).toBe(
      "sys_audit"
    );
    expect(() =>
      authorizeTableAccess(policy, { operation: "read", table: "sys_audit" }, "sn_get")
    ).toThrow(TablePolicyError);
    // The other named-only table was not named.
    expect(() =>
      authorizeTableAccess(policy, { operation: "read", table: "sys_journal_field" }, "sn_query")
    ).toThrow(TablePolicyError);
  });

  it("grants a table named with no wildcard", () => {
    const policy = createTableAccessPolicy({
      readTables: [...NAMED_ONLY],
      targets: NAMED_ONLY.map((table) => target(table, ["sn_query"])),
    });
    for (const table of NAMED_ONLY) {
      expect(authorizeTableAccess(policy, { operation: "read", table }, "sn_query")).toBe(table);
    }
  });

  it("grants a named table beside a wildcard that has no targets at all", () => {
    const policy = createTableAccessPolicy({ readTables: ["*", "sys_audit"] });
    expect(authorizeTableAccess(policy, { operation: "read", table: "sys_audit" }, "sn_get")).toBe(
      "sys_audit"
    );
  });
});

describe("every read path refuses the tables under a wildcard grant", () => {
  const cases = NAMED_ONLY.flatMap((table) => READ_TOOLS.map((tool) => [tool, table] as const));

  it.each(cases)("%s on %s is denied before any client work", async (tool, table) => {
    const connected = await connect(WILDCARD);
    const result = await connected.client.callTool({
      name: tool,
      arguments: { profile: "named-only", ...argumentsFor(tool, table) },
    });
    expect(result.isError).toBe(true);
    const message = text(result);
    expect(message).toContain("Table access was denied by policy");
    expect(message).toContain("Table access was denied by policy");
    expect(message).not.toContain(table);
    expect(connected.getClient).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.getWithMeta).not.toHaveBeenCalled();
    expect(connected.serviceNowClient.get).not.toHaveBeenCalled();
    expect(connected.records.at(-1)).toMatchObject({
      tool,
      outcome: "policy_rejected",
      reason: "table_access_denied",
    });
  });

  it.each(NAMED_ONLY)("sn_attach on %s is denied", async (table) => {
    const connected = await connect({ readTables: ["*"], targets: [] });
    const result = await connected.client.callTool({
      name: "sn_attach",
      arguments: { profile: "named-only", action: "list", table, sys_id: SYS_ID },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Table access was denied by policy");
    expect(connected.getClient).not.toHaveBeenCalled();
  });

  it.each(NAMED_ONLY)("sn_codesearch does not search %s at all (not applicable)", async (table) => {
    const connected = await connect(WILDCARD);
    const result = await connected.client.callTool({
      name: "sn_codesearch",
      arguments: { profile: "named-only", search_term: "x", table },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Table access was denied by policy");
    expect(connected.getClient).not.toHaveBeenCalled();
  });

  it("denies the same tables for a write under a write wildcard", async () => {
    const connected = await connect({ writeTables: ["*"], targets: [] });
    for (const table of NAMED_ONLY) {
      const result = await connected.client.callTool({
        name: "sn_update",
        arguments: {
          profile: "named-only",
          table,
          sys_id: SYS_ID,
          fields: { description: "x" },
        },
      });
      expect(result.isError, table).toBe(true);
      expect(text(result), table).toContain("Table access was denied by policy");
    }
    expect(connected.getClient).not.toHaveBeenCalled();
  });

  it("keeps the other system tables and ordinary tables readable under the wildcard", async () => {
    const connected = await connect(WILDCARD);
    for (const table of ["incident", "sys_user", "sys_script_include", "x_acme_widget"]) {
      connected.getClient.mockClear();
      const result = await connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "named-only", table },
      });
      expect(result.isError, table).toBeUndefined();
      expect(connected.getClient, table).toHaveBeenCalled();
    }
  });
});

describe("every read path reaches the tables when the profile names them", () => {
  const named: TableAccessPolicyInput = {
    readTables: ["*", ...NAMED_ONLY],
    targets: NAMED_ONLY.map((table) => target(table)),
  };
  const cases = NAMED_ONLY.flatMap((table) => READ_TOOLS.map((tool) => [tool, table] as const));

  it.each(cases)("%s on %s is not refused by the table policy", async (tool, table) => {
    const connected = await connect(named);
    const result = await connected.client.callTool({
      name: tool,
      arguments: { profile: "named-only", ...argumentsFor(tool, table) },
    });
    expect(connected.records.at(-1)?.outcome, text(result)).not.toBe("policy_rejected");
    expect(connected.getClient).toHaveBeenCalled();
  });

  it("reaches only the table it names", async () => {
    const connected = await connect({
      readTables: ["*", "sys_audit"],
      targets: [target("sys_audit")],
    });
    const named1 = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "named-only", table: "sys_audit" },
    });
    expect(connected.records.at(-1)?.outcome, text(named1)).not.toBe("policy_rejected");
    const other = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "named-only", table: "sys_journal_field" },
    });
    expect(other.isError).toBe(true);
    expect(text(other)).toContain("Table access was denied by policy");
  });
});

describe("the field policy applies to the tables when they are named", () => {
  const named: TableAccessPolicyInput = {
    readTables: [...NAMED_ONLY],
    targets: NAMED_ONLY.map((table) => target(table)),
  };

  it("projects the identifying columns by default and leaves the value columns to be asked for", () => {
    expect(resolveReadableFields("sys_audit")).toEqual([
      "sys_id",
      "tablename",
      "documentkey",
      "fieldname",
      "user",
      "sys_created_on",
    ]);
    for (const table of NAMED_ONLY) {
      const defaults = resolveReadableFields(table);
      expect(defaults[0], table).toBe("sys_id");
      for (const column of VALUE_COLUMNS[table]) {
        expect(defaults, `${table}.${column}`).not.toContain(column);
      }
      expect(resolveReadableFields(table, { fields: "all" }), table).toEqual(["*"]);
    }
  });

  it("denies a field a named entry leaves out, and allows one it lists", async () => {
    const fieldPolicy = {
      fieldPolicy: Object.fromEntries(
        NAMED_ONLY.map((table) => [table, { readable: ["sys_id", "sys_created_on"] }])
      ),
    } satisfies FieldPolicyConfigurationInput;
    const connected = await connect(named, fieldPolicy);
    for (const table of NAMED_ONLY) {
      const hidden = VALUE_COLUMNS[table][0]!;
      const denied = await connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "named-only", table, fields: hidden },
      });
      expect(denied.isError, table).toBe(true);
      expect(text(denied), table).not.toContain("Table access was denied");
      expect(connected.records.at(-1), table).toMatchObject({ outcome: "policy_rejected" });
      connected.getClient.mockClear();
      const allowed = await connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "named-only", table, fields: "sys_created_on" },
      });
      expect(allowed.isError, table).toBeUndefined();
      expect(connected.getClient, table).toHaveBeenCalled();
    }
  });

  it("lets a named entry widen what a narrowing \"*\" entry left out", async () => {
    const connected = await connect(named, {
      fieldPolicy: {
        "*": { readable: ["sys_id"] },
        sys_audit: { readable: ["sys_id", "fieldname", "newvalue"] },
      },
    });
    const widened = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "named-only", table: "sys_audit", fields: "fieldname,newvalue" },
    });
    expect(widened.isError).toBeUndefined();
    const stillNarrow = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "named-only", table: "sys_email", fields: "body" },
    });
    expect(stillNarrow.isError).toBe(true);
  });

  // A profile's narrowing "*" field entry applies to these tables, as it does
  // to the ITSM tables: naming one in tableAccess does not open its value columns.
  describe('a narrowing "*" field entry applies once the table is named', () => {
    const star = { fieldPolicy: { "*": { readable: ["sys_id", "sys_created_on"] } } };

    it.each(NAMED_ONLY)("%s: no value column is readable, by name or with fields=all", async (table) => {
      const connected = await connect(named, star);
      for (const column of VALUE_COLUMNS[table]) {
        connected.getClient.mockClear();
        const result = await connected.client.callTool({
          name: "sn_query",
          arguments: { profile: "named-only", table, fields: column },
        });
        expect(result.isError, `${table}.${column}`).toBe(true);
        expect(connected.records.at(-1), `${table}.${column}`).toMatchObject({
          outcome: "policy_rejected",
        });
        expect(connected.getClient, `${table}.${column}`).not.toHaveBeenCalled();
      }
      const all = await connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "named-only", table, fields: "all" },
      });
      expect(all.isError, table).toBeUndefined();
      const requested = vi.mocked(connected.serviceNowClient.getWithMeta).mock.calls.at(-1)?.[1] as
        | Record<string, string>
        | undefined;
      const sent = String(requested?.sysparm_fields ?? "").split(",");
      for (const column of VALUE_COLUMNS[table]) expect(sent, `${table}.${column}`).not.toContain(column);
    });

    it("leaves a table the profile did not narrow, and the system tables, as before", async () => {
      const connected = await connect(
        { readTables: ["*", "sys_audit"], targets: [target("sys_audit")] },
        star
      );
      // A system table is never narrowed by "*": sys_user still reads any field.
      const system = await connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "named-only", table: "sys_user", fields: "user_name" },
      });
      expect(system.isError).toBeUndefined();
      // A custom table is narrowed.
      const custom = await connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "named-only", table: "x_acme_widget", fields: "name" },
      });
      expect(custom.isError).toBe(true);
    });
  });
});

describe("a related table that only a wildcard would cover", () => {
  const view = (related: string) => ({
    readTables: ["*"],
    targets: [
      {
        table: "incident",
        kind: "view" as const,
        tools: ["sn_query"],
        closureComplete: true as const,
        relatedTables: ["incident", related],
      },
    ],
  });

  it.each(NAMED_ONLY)("names %s and says it must be granted by name", (table) => {
    expect(() => createTableAccessPolicy(view(table))).toThrow(
      `table access target backing tables require the same operation permission: ` +
        `"${table}" must be granted by name, because a "*" grant does not cover it`
    );
  });

  it("loads once the table is named", () => {
    expect(() =>
      createTableAccessPolicy({
        ...view("sys_email"),
        readTables: ["*", "sys_email"],
      })
    ).not.toThrow();
  });

  it("keeps the fixed message when the missing table is an ordinary one", () => {
    expect(() =>
      createTableAccessPolicy({
        readTables: ["incident"],
        targets: [
          {
            table: "incident",
            kind: "view",
            tools: ["sn_query"],
            closureComplete: true,
            relatedTables: ["incident", "problem"],
          },
        ],
      })
    ).toThrow(/^table access target backing tables require the same operation permission$/u);
  });

  it("names only the table, never the rest of the grants", () => {
    try {
      createTableAccessPolicy({
        readTables: ["*", "u_secret_thing"],
        targets: [
          {
            table: "incident",
            kind: "view",
            tools: ["sn_query"],
            closureComplete: true,
            relatedTables: ["incident", "sys_audit_delete"],
          },
        ],
      });
      throw new Error("expected a load failure");
    } catch (error) {
      expect((error as Error).message).toContain("sys_audit_delete");
      expect((error as Error).message).not.toContain("u_secret_thing");
    }
  });
});

describe("sn_attach is unaffected", () => {
  it("never plans a read of sys_attachment_doc: it uses the Attachment API", () => {
    for (const action of ["list", "download"] as const) {
      const plan = resolveToolTableAccess("sn_attach", {
        action,
        table: "incident",
        sys_id: SYS_ID,
        attachment_sys_id: SYS_ID,
      });
      expect(plan.requests.map((r) => `${r.operation}:${r.table}`).sort(), action).toEqual([
        "read:incident",
        "read:sys_attachment",
      ]);
    }
    const upload = resolveToolTableAccess("sn_attach", {
      action: "upload",
      table: "incident",
      sys_id: SYS_ID,
      file_name: "a.txt",
      content: "eA==",
    });
    expect(upload.requests.map((r) => `${r.operation}:${r.table}`).sort()).toEqual([
      "write:incident",
      "write:sys_attachment",
    ]);
  });

  it("lists attachments on an ordinary table under a bare wildcard grant", async () => {
    const connected = await connect({ readTables: ["*"], targets: [] });
    const result = await connected.client.callTool({
      name: "sn_attach",
      arguments: { profile: "named-only", action: "list", table: "incident", sys_id: SYS_ID },
    });
    expect(connected.records.at(-1)?.outcome, text(result)).not.toBe("policy_rejected");
    expect(vi.mocked(connected.serviceNowClient.get).mock.calls.map((call) => call[0])).toContain(
      "/api/now/attachment"
    );
    for (const call of vi.mocked(connected.serviceNowClient.get).mock.calls) {
      expect(String(call[0])).not.toContain("sys_attachment_doc");
    }
  });
});
