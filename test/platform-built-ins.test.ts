/**
 * The platform tables (`sys_update_xml`, `sys_upgrade_history_log`,
 * `scan_finding`, `scan_result`, `scan_check`) are built-in tables whose field
 * policy belongs to the profile. A "*" table grant covers them like any table.
 * Their default projections leave out the columns that carry script, XML or
 * matched code, and a profile's "*" field entry narrows them even when the
 * profile names none of them.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { CREDENTIAL_TABLE_PATTERNS, isCredentialTable } from "../src/credential-tables.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../src/execution-context.js";
import {
  BUILT_IN_TABLE_CLASSES,
  FieldPolicyError,
  filterReadableRecord,
  resolveReadableFields,
  runWithFieldPolicyConfiguration,
  validateFieldPolicyConfiguration,
  validateWritableFields,
  type FieldPolicyConfigurationInput,
} from "../src/field-policy.js";
import {
  fieldTypesFromRows,
  hiddenFieldScope,
  rowValueRule,
  runWithHiddenFieldScope,
  type FieldTypeLoader,
} from "../src/hidden-values.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import {
  NAMED_ONLY_TABLES,
  authorizeTableAccess,
  createTableAccessPolicy,
  type TableAccessPolicyInput,
} from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import { noHiddenFieldTypes } from "./fixtures/field-types.js";

const PLATFORM = [
  "sys_update_xml",
  "sys_upgrade_history_log",
  "scan_finding",
  "scan_result",
  "scan_check",
] as const;
type PlatformTable = (typeof PLATFORM)[number];

/** The columns each table's default projection must leave out. */
const NEVER_DEFAULT: Readonly<Record<PlatformTable, readonly string[]>> = {
  sys_update_xml: ["payload"],
  sys_upgrade_history_log: ["payload", "payload_diff"],
  scan_finding: ["finding_details", "task", "user"],
  scan_result: ["message"],
  scan_check: ["script"],
};

/** Whole-record XML columns: readable only where the table's own entry lists them. */
const EXPLICIT_READ: Readonly<Partial<Record<PlatformTable, readonly string[]>>> = {
  sys_update_xml: ["payload"],
  sys_upgrade_history_log: ["payload", "payload_diff"],
};
const isExplicitRead = (table: PlatformTable, column: string): boolean =>
  EXPLICIT_READ[table]?.includes(column) ?? false;

/** The narrowing probe. It names none of the platform tables. */
const NARROWING = { "*": { readable: ["sys_id", "name", "sys_created_on"] } } as const;

function withFieldPolicy<T>(fieldPolicy: unknown, action: () => T): T {
  return runWithFieldPolicyConfiguration({ fieldPolicy }, action);
}

function reason(action: () => unknown): string {
  try {
    action();
    return "allowed";
  } catch (error) {
    if (error instanceof FieldPolicyError) return error.reason;
    throw error;
  }
}

/** What each platform table resolves to with no field policy at all. */
const builtIn = new Map(PLATFORM.map((table) => [table, resolveReadableFields(table)]));

describe("the platform class", () => {
  it("is exactly the five tables, each a built-in entry in no other class", () => {
    const { builtIn: entries, itsm, system, namedOnly, platform } = BUILT_IN_TABLE_CLASSES;
    expect([...platform].sort()).toEqual([...PLATFORM].sort());
    expect(Object.isFrozen(platform)).toBe(true);
    for (const table of PLATFORM) {
      expect(entries, table).toContain(table);
      expect(itsm, table).not.toContain(table);
      expect(system, table).not.toContain(table);
      expect(namedOnly, table).not.toContain(table);
    }
  });

  it("keeps the class invariant: every built-in entry is in exactly one class", () => {
    const { builtIn: entries, itsm, system, namedOnly, platform } = BUILT_IN_TABLE_CLASSES;
    const classes = [itsm, system, namedOnly, platform];
    for (const table of entries) {
      expect(classes.filter((members) => members.includes(table)), table).toHaveLength(1);
    }
    const classified = classes.flat();
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...entries].sort());
  });

  it("is covered by a \"*\" table grant: none of the five is a named-only table", () => {
    const policy = createTableAccessPolicy({ readTables: ["*"], writeTables: ["*"], targets: [] });
    for (const table of PLATFORM) {
      expect(NAMED_ONLY_TABLES, table).not.toContain(table);
      expect(authorizeTableAccess(policy, { operation: "read", table }, "sn_query"), table).toBe(table);
    }
  });

  it("holds no credential table and no row-value rule, so field types and names decide hiding", () => {
    expect(CREDENTIAL_TABLE_PATTERNS.length).toBeGreaterThan(0);
    for (const table of PLATFORM) {
      expect(isCredentialTable(table), table).toBe(false);
      expect(rowValueRule(table), table).toBeUndefined();
    }
  });
});

describe('a profile\'s "*" field entry covers every built-in class but system', () => {
  // Every class BUILT_IN_TABLE_CLASSES lists, apart from the full list and the
  // system class. A class added later is picked up here without editing the test.
  const classes = Object.entries(BUILT_IN_TABLE_CLASSES).filter(
    ([name]) => name !== "builtIn" && name !== "system"
  );

  it("lists the ITSM, named-only and platform classes, each non-empty", () => {
    expect(classes.map(([name]) => name).sort()).toEqual(["itsm", "namedOnly", "platform"]);
    for (const [name, members] of classes) expect(members.length, name).toBeGreaterThan(0);
  });

  it('{"*": {readable: ["sys_id"]}} narrows every table of every such class', () => {
    const star = { "*": { readable: ["sys_id"] } };
    expect(() => validateFieldPolicyConfiguration({ fieldPolicy: star })).not.toThrow();
    withFieldPolicy(star, () => {
      for (const [name, members] of classes) {
        for (const table of members) {
          const label = `${name}: ${table}`;
          expect(resolveReadableFields(table, { fields: "all" }), label).toEqual(["sys_id"]);
          expect(resolveReadableFields(table), label).toEqual(["sys_id"]);
          expect(reason(() => resolveReadableFields(table, { fields: "sys_created_on" })), label).toBe(
            "unreadable_field"
          );
        }
      }
      // The system tables keep their own open entry.
      for (const table of BUILT_IN_TABLE_CLASSES.system) {
        expect(resolveReadableFields(table, { fields: "all" }), `system: ${table}`).toEqual(["*"]);
      }
    });
  });

  it('{"*": {writable: []}} denies writes on every table of every such class', () => {
    withFieldPolicy({ "*": { writable: [] } }, () => {
      for (const [name, members] of classes) {
        for (const table of members) {
          expect(reason(() => validateWritableFields(table, { u_x: "1" })), `${name}: ${table}`).toBe(
            "non_writable_field"
          );
        }
      }
    });
  });
});

describe("the default projections", () => {
  it("lead with sys_id and leave out every never-default column", () => {
    for (const table of PLATFORM) {
      const defaults = builtIn.get(table)!;
      expect(defaults[0], table).toBe("sys_id");
      expect(defaults.length, table).toBeGreaterThan(1);
      for (const column of NEVER_DEFAULT[table]) {
        expect(defaults, `${table}.${column}`).not.toContain(column);
      }
    }
  });

  it("are open otherwise: a never-default column is readable by name, and fields=all is \"*\"", () => {
    for (const table of PLATFORM) {
      for (const column of NEVER_DEFAULT[table]) {
        // A whole-record XML column needs the table's own entry (below).
        if (isExplicitRead(table, column)) {
          expect(reason(() => resolveReadableFields(table, { fields: column })), `${table}.${column}`).toBe(
            "explicit_read_required"
          );
          continue;
        }
        expect(resolveReadableFields(table, { fields: column }), `${table}.${column}`).toEqual([column]);
      }
      expect(resolveReadableFields(table, { fields: "all" }), table).toEqual(["*"]);
      expect(validateWritableFields(table, { u_anything: "x" }), table).toEqual({ u_anything: "x" });
    }
  });

  it("are unchanged by a field policy that has no \"*\" entry", () => {
    withFieldPolicy({ u_custom: { writable: [] } }, () => {
      for (const table of PLATFORM) {
        expect(resolveReadableFields(table), table).toEqual(builtIn.get(table));
        expect(resolveReadableFields(table, { fields: "all" }), table).toEqual(["*"]);
      }
    });
  });
});

describe('a narrowing "*" field entry the profile writes for no platform table', () => {
  it("names none of the five tables", () => {
    for (const table of PLATFORM) expect(Object.keys(NARROWING), table).not.toContain(table);
    expect(() => validateFieldPolicyConfiguration({ fieldPolicy: NARROWING })).not.toThrow();
  });

  it("denies every never-default column on all five tables (the merge loop covers them)", () => {
    withFieldPolicy(NARROWING, () => {
      for (const table of PLATFORM) {
        for (const column of NEVER_DEFAULT[table]) {
          expect(reason(() => resolveReadableFields(table, { fields: column })), `${table}.${column}`).toBe(
            isExplicitRead(table, column) ? "explicit_read_required" : "unreadable_field"
          );
        }
      }
    });
  });

  it("narrows fields=all and clamps the default projection to the \"*\" readable set", () => {
    withFieldPolicy(NARROWING, () => {
      for (const table of PLATFORM) {
        const all = resolveReadableFields(table, { fields: "all" });
        expect([...all].sort(), table).toEqual([...NARROWING["*"].readable].sort());
        const defaults = resolveReadableFields(table);
        expect(defaults[0], table).toBe("sys_id");
        for (const field of defaults) expect(NARROWING["*"].readable, `${table}.${field}`).toContain(field);
        expect(resolveReadableFields(table, { fields: "sys_id,sys_created_on" }), table).toEqual([
          "sys_id",
          "sys_created_on",
        ]);
      }
    });
  });

  it("drops a never-default column from a returned row", () => {
    withFieldPolicy(NARROWING, () => {
      for (const table of PLATFORM) {
        const row: Record<string, string> = { sys_id: "a".repeat(32), name: "n" };
        for (const column of NEVER_DEFAULT[table]) row[column] = "SECRET-CANARY-VALUE";
        const filtered = filterReadableRecord(row, resolveReadableFields(table, { fields: "all" }));
        expect(JSON.stringify(filtered), table).not.toContain("SECRET-CANARY-VALUE");
      }
    });
  });

  it("applies to the platform tables but not to a system table", () => {
    withFieldPolicy(NARROWING, () => {
      // The system tables keep their own entry under a "*" entry.
      expect(resolveReadableFields("sys_script", { fields: "script" })).toEqual(["script"]);
      expect(reason(() => resolveReadableFields("scan_check", { fields: "script" }))).toBe(
        "unreadable_field"
      );
    });
  });

  it('a narrowing "*" writable entry denies writes on all five', () => {
    withFieldPolicy({ "*": { writable: [] } }, () => {
      for (const table of PLATFORM) {
        expect(reason(() => validateWritableFields(table, { u_x: "1" })), table).toBe("non_writable_field");
      }
    });
  });

  it("a table's own entry still narrows or widens it, key by key", () => {
    withFieldPolicy(
      {
        ...NARROWING,
        sys_update_xml: { readable: ["sys_id", "name", "payload"] },
        scan_check: { writable: ["active"] },
      },
      () => {
        expect(resolveReadableFields("sys_update_xml", { fields: "payload" })).toEqual(["payload"]);
        expect(reason(() => resolveReadableFields("sys_update_xml", { fields: "type" }))).toBe(
          "unreadable_field"
        );
        // Naming scan_check for writes leaves its reads to the "*" entry.
        expect(reason(() => resolveReadableFields("scan_check", { fields: "script" }))).toBe(
          "unreadable_field"
        );
        expect(validateWritableFields("scan_check", { active: "false" })).toEqual({ active: "false" });
        // The tables it does not name stay narrowed.
        expect(reason(() => resolveReadableFields("sys_upgrade_history_log", { fields: "payload" }))).toBe(
          "explicit_read_required"
        );
      }
    );
  });
});

describe("type hiding applies on top", () => {
  const hiddenRows = PLATFORM.map((table) => ({
    table,
    element: "u_signing_key",
    internal_type: "password2",
  }));

  it("refuses and drops a password-typed column on every platform table, with no field policy", () => {
    const types = fieldTypesFromRows(
      hiddenRows,
      Object.fromEntries(PLATFORM.map((table) => [table, { tables: [table], complete: true }]))
    );
    const { scope } = hiddenFieldScope(types, PLATFORM, false);
    expect(scope).toBeDefined();
    runWithHiddenFieldScope(scope!, () => {
      for (const table of PLATFORM) {
        expect(reason(() => resolveReadableFields(table, { fields: "u_signing_key" })), table).not.toBe(
          "allowed"
        );
        const filtered = filterReadableRecord(
          { sys_id: "a".repeat(32), u_signing_key: "SECRET-CANARY-VALUE" },
          resolveReadableFields(table, { fields: "all" })
        );
        expect(JSON.stringify(filtered), table).not.toContain("SECRET-CANARY-VALUE");
      }
    });
  });
});

// Through the dispatcher: a "*" table grant, a narrowing "*" field entry that
// names no platform table, and sn_query against each table.
const SYS_ID = "b".repeat(32);
const CONFIG: ServiceNowConfig = {
  instance: "https://platform-built-ins-test.service-now.com",
  user: "platform-built-ins-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};
const WILDCARD: TableAccessPolicyInput = { readTables: ["*"], targets: [] };

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

async function connect(
  fieldPolicy: FieldPolicyConfigurationInput | undefined,
  fieldTypeLoader: FieldTypeLoader = noHiddenFieldTypes
) {
  const records: ToolAuditRecord[] = [];
  const serviceNowClient = {
    get: vi.fn(async () => ({ result: [{ sys_id: SYS_ID }] })),
    getWithMeta: vi.fn(async () => ({
      data: { result: [{ sys_id: SYS_ID }] },
      status: 200,
      headers: new Headers(),
    })),
  } as unknown as ServiceNowClient;
  const getClient = vi.fn(() => serviceNowClient);
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: CONFIG.instance,
      username: CONFIG.user,
      credential: "env:PLATFORM_BUILT_INS_SECRET_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => CONFIG),
    getClient,
  } as unknown as ProfileManager;
  const tableAccess = createTableAccessPolicy(WILDCARD);
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `platform-built-ins-${String(requestId)}`,
        identity: { ownerId: "platform-built-ins-owner", clientId: "platform-built-ins-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "platform-built-ins",
        revision: "platform-built-ins",
        tableAccess,
        ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
      }),
    },
    fieldTypeLoader,
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
  const client = new Client({ name: "platform-built-ins-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    if (server.isConnected()) await server.close();
  });
  return { client, records, getClient, serviceNowClient };
}

function sentFields(serviceNowClient: ServiceNowClient): string[] {
  const params = vi.mocked(serviceNowClient.getWithMeta).mock.calls.at(-1)?.[1] as
    | Record<string, string>
    | undefined;
  return String(params?.sysparm_fields ?? "").split(",");
}

describe("sn_query under a \"*\" table grant", () => {
  it.each(PLATFORM)("%s: with no field policy, the default read leaves out the never-default columns", async (table) => {
    const connected = await connect(undefined);
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "platform", table },
    });
    expect(result.isError, table).toBeUndefined();
    const sent = sentFields(connected.serviceNowClient);
    expect(sent[0], table).toBe("sys_id");
    for (const column of NEVER_DEFAULT[table]) expect(sent, `${table}.${column}`).not.toContain(column);
  });

  it.each(PLATFORM)('%s: a narrowing "*" field entry refuses each never-default column before any read', async (table) => {
    const connected = await connect({ fieldPolicy: NARROWING });
    for (const column of NEVER_DEFAULT[table]) {
      connected.getClient.mockClear();
      const result = await connected.client.callTool({
        name: "sn_query",
        arguments: { profile: "platform", table, fields: column },
      });
      expect(result.isError, `${table}.${column}`).toBe(true);
      expect(connected.records.at(-1), `${table}.${column}`).toMatchObject({ outcome: "policy_rejected" });
      expect(connected.getClient, `${table}.${column}`).not.toHaveBeenCalled();
    }
    const all = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "platform", table, fields: "all" },
    });
    expect(all.isError, table).toBeUndefined();
    const sent = sentFields(connected.serviceNowClient);
    for (const field of sent) expect(NARROWING["*"].readable, `${table}.${field}`).toContain(field);
  });

  it("refuses a password-typed column on a platform table and keeps it out of fields=all", async () => {
    const loader: FieldTypeLoader = async (_client, tables) =>
      fieldTypesFromRows(
        [{ table: "sys_update_xml", element: "u_signing_key", internal_type: "password2" }],
        Object.fromEntries([...tables].map((table) => [table, { tables: [table], complete: true }]))
      );
    const connected = await connect(undefined, loader);
    const named = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "platform", table: "sys_update_xml", fields: "u_signing_key" },
    });
    expect(named.isError).toBe(true);
    expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected" });
    const all = await connected.client.callTool({
      name: "sn_query",
      arguments: { profile: "platform", table: "sys_update_xml", fields: "all" },
    });
    expect(all.isError).toBeUndefined();
    expect(sentFields(connected.serviceNowClient)).not.toContain("u_signing_key");
  });
});
