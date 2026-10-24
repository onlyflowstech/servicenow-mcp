/**
 * Governance quick wins: the policy card (sn_profile and the card builder) and
 * the sn_batch dry run that shows its work.
 *
 * The card tests compare what the card says with what the enforcing code does
 * for the same policy, so a drift between the two fails here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAtfExecutionPolicy } from "../src/atf-policy.js";
import { createEncodedQueryAccessPolicy } from "../src/encoded-query-policy.js";
import type { ExecutionContextDependencies } from "../src/execution-context.js";
import {
  BUILT_IN_TABLE_CLASSES,
  isAllFieldSelection,
  resolveReadableFields,
  runWithFieldPolicyConfiguration,
  validateWritableFields,
  type FieldPolicyConfigurationInput,
} from "../src/field-policy.js";
import {
  buildPolicyCard,
  renderPolicyCard,
  type CardTableRow,
  type PolicyCard,
} from "../src/policy-card.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import {
  authorizeTableAccess,
  createTableAccessPolicy,
  type TableAccessPolicyInput,
} from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const INSTANCE = "https://card.service-now.com";

function target(table: string, tools: readonly string[]) {
  return {
    table,
    kind: "canonical" as const,
    tools,
    closureComplete: true as const,
    relatedTables: [table],
  };
}

function card(
  tableAccess: TableAccessPolicyInput,
  fieldPolicy?: FieldPolicyConfigurationInput
): PolicyCard {
  return buildPolicyCard({
    profile: "p",
    instance: INSTANCE,
    authType: "basic",
    tableAccess: createTableAccessPolicy(tableAccess),
    ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
    encodedQueryAccess: createEncodedQueryAccessPolicy(),
    atf: createAtfExecutionPolicy(undefined),
  });
}

/** True when the enforcing resolver lets `field` be read on `table`. */
function enforcedReadable(
  fieldPolicy: FieldPolicyConfigurationInput | undefined,
  table: string,
  field: string
): boolean {
  return runWithFieldPolicyConfiguration(fieldPolicy, () => {
    try {
      const selection = resolveReadableFields(table, { fields: field });
      return selection.includes(field);
    } catch {
      return false;
    }
  });
}

function enforcedWritable(
  fieldPolicy: FieldPolicyConfigurationInput | undefined,
  table: string,
  field: string
): boolean {
  return runWithFieldPolicyConfiguration(fieldPolicy, () => {
    try {
      validateWritableFields(table, { [field]: "x" });
      return true;
    } catch {
      return false;
    }
  });
}

/** Whether the card says `field` is usable, per its own field set. */
function cardAllows(
  set: CardTableRow["readable"],
  field: string
): boolean {
  if (set === "*") return true;
  return set.fields.includes(field);
}

const PROBE_FIELDS = [
  "short_description",
  "state",
  "priority",
  "assigned_to",
  "comments",
  "u_custom",
];

describe("policy card matches the enforced policy", () => {
  const shapes: ReadonlyArray<{
    name: string;
    tableAccess: TableAccessPolicyInput;
    fieldPolicy?: FieldPolicyConfigurationInput;
  }> = [
    {
      name: "read-only ITSM",
      tableAccess: {
        readTables: ["incident", "problem"],
        targets: [
          target("incident", ["sn_query", "sn_get"]),
          target("problem", ["sn_query"]),
        ],
      },
    },
    {
      name: "narrow writable list on incident",
      tableAccess: {
        readTables: ["incident"],
        writeTables: ["incident"],
        targets: [target("incident", ["sn_query", "sn_update", "sn_create"])],
      },
      fieldPolicy: {
        fieldPolicy: {
          incident: {
            readable: ["sys_id", "number", "short_description", "state"],
            writable: ["short_description", "state"],
          },
        },
      },
    },
    {
      name: '"*" field entry narrows ITSM and custom tables but not system tables',
      tableAccess: {
        readTables: ["incident", "x_acme_widget", "sys_user"],
        writeTables: ["incident", "x_acme_widget", "sys_user"],
        targets: [
          target("incident", ["sn_query", "sn_update"]),
          target("x_acme_widget", ["sn_query", "sn_update"]),
          target("sys_user", ["sn_query", "sn_update"]),
        ],
      },
      fieldPolicy: {
        fieldPolicy: {
          "*": { readable: ["sys_id", "number", "short_description"], writable: ["short_description"] },
        },
      },
    },
    {
      name: "wildcard table grants",
      tableAccess: { readTables: ["*"], writeTables: ["*"], targets: [] },
      fieldPolicy: { fieldPolicy: { "*": { readable: ["sys_id", "number"] } } },
    },
  ];

  it.each(shapes)("$name: read, write, and fields agree with enforcement", (shape) => {
    const policy = createTableAccessPolicy(shape.tableAccess);
    const result = card(shape.tableAccess, shape.fieldPolicy);

    for (const row of result.tables) {
      const tools = policy.targets.find((entry) => entry.table === row.table)?.tools ?? [];
      const enforcedRead = tools.some((tool) => {
        try {
          authorizeTableAccess(policy, { operation: "read", table: row.table }, tool);
          return true;
        } catch {
          return false;
        }
      });
      const enforcedWrite = tools.some((tool) => {
        try {
          authorizeTableAccess(policy, { operation: "write", table: row.table }, tool);
          return true;
        } catch {
          return false;
        }
      });
      expect(row.read, `${row.table} read`).toBe(enforcedRead);
      expect(row.write, `${row.table} write`).toBe(enforcedWrite);
      for (const field of PROBE_FIELDS) {
        if (row.read) {
          expect(
            cardAllows(row.readable, field),
            `${row.table}.${field} readable`
          ).toBe(enforcedReadable(shape.fieldPolicy, row.table, field));
        }
        if (row.write) {
          expect(
            cardAllows(row.writable, field),
            `${row.table}.${field} writable`
          ).toBe(enforcedWritable(shape.fieldPolicy, row.table, field));
        }
      }
    }

    if (result.other_tables) {
      expect(result.other_tables.read).toBe(
        shape.tableAccess.readTables?.includes("*") === true
      );
      for (const field of ["number", "short_description"]) {
        expect(cardAllows(result.other_tables.readable, field)).toBe(
          enforcedReadable(shape.fieldPolicy, "x_unlisted_probe_table", field)
        );
      }
    } else {
      expect(shape.tableAccess.readTables).not.toContain("*");
    }
  });

  it("states that a read-only profile cannot write anything", () => {
    const result = card(shapes[0]!.tableAccess);
    expect(result.can_write_anything).toBe(false);
    expect(result.can_read_anything).toBe(true);
    const text = renderPolicyCard(result);
    expect(text).toContain("This profile cannot write to any table.");
    expect(text).toContain("incident");
  });

  it('a "*" field entry covers custom tables and never the system tables', () => {
    const shape = shapes[2]!;
    const result = card(shape.tableAccess, shape.fieldPolicy);
    const byTable = new Map(result.tables.map((row) => [row.table, row]));
    // Custom table: narrowed by the "*" entry.
    expect(byTable.get("x_acme_widget")!.readable).toEqual({
      fields: ["number", "short_description", "sys_id"],
      more: 0,
    });
    expect(byTable.get("x_acme_widget")!.writable).toEqual({
      fields: ["short_description"],
      more: 0,
    });
    // System table: untouched by the "*" entry.
    expect(BUILT_IN_TABLE_CLASSES.system).toContain("sys_user");
    expect(byTable.get("sys_user")!.class).toBe("system");
    expect(byTable.get("sys_user")!.readable).toBe("*");
    expect(byTable.get("sys_user")!.writable).toBe("*");
    expect(renderPolicyCard(result)).toContain("never the 23 system tables");
    expect(BUILT_IN_TABLE_CLASSES.system).toHaveLength(23);
  });

  it("reports class and domain fields only where the profile lists them", () => {
    const access: TableAccessPolicyInput = {
      readTables: ["incident", "problem"],
      writeTables: ["incident", "problem"],
      targets: [
        target("incident", ["sn_query", "sn_update"]),
        target("problem", ["sn_query", "sn_update"]),
      ],
    };
    const fieldPolicy = {
      fieldPolicy: { incident: { writable: ["short_description", "sys_class_name"] } },
    };
    const result = card(access, fieldPolicy);
    const incident = result.tables.find((row) => row.table === "incident")!;
    const problem = result.tables.find((row) => row.table === "problem")!;
    expect(incident.explicit_writable).toEqual(["sys_class_name"]);
    expect(problem.explicit_writable).toEqual([]);
    expect(problem.writable).toBe("*");
    // And enforcement agrees: a wildcard never covers them.
    expect(enforcedWritable(fieldPolicy, "incident", "sys_class_name")).toBe(true);
    expect(enforcedWritable(fieldPolicy, "problem", "sys_class_name")).toBe(false);
    expect(renderPolicyCard(result)).toContain("[+sys_class_name]");
  });

  it("flags write access on role and approval tables without hiding the grant", () => {
    const result = card({
      readTables: ["sys_user_has_role"],
      writeTables: ["sys_user_has_role", "sysapproval_approver", "incident"],
      targets: [
        target("sys_user_has_role", ["sn_query", "sn_create"]),
        target("sysapproval_approver", ["sn_update"]),
        target("incident", ["sn_update"]),
      ],
    });
    expect(result.risky_write_tables).toEqual(["sys_user_has_role", "sysapproval_approver"]);
    expect(result.tables.find((row) => row.table === "sys_user_has_role")!.write).toBe(true);
    expect(renderPolicyCard(result)).toContain("WARNING: write access on role/approval tables");
  });

  it("flags the write wildcard", () => {
    const result = card({ readTables: ["*"], writeTables: ["*"], targets: [] });
    expect(result.write_all_tables).toBe(true);
    expect(result.risky_write_tables).toContain("sys_user_has_role");
  });

  it("reports auth type and batch limits and carries no credential material", () => {
    const text = renderPolicyCard(
      buildPolicyCard({
        profile: "p",
        instance: INSTANCE,
        authType: "oauth",
        grantType: "client_credentials",
        tableAccess: createTableAccessPolicy({ readTables: ["incident"], targets: [target("incident", ["sn_query"])] }),
        encodedQueryAccess: createEncodedQueryAccessPolicy(),
        atf: createAtfExecutionPolicy({ execute: true }),
      })
    );
    expect(text).toContain("Auth: oauth (client_credentials)");
    expect(text).toContain("default 200, max 10000 records per run");
    expect(text).toContain("ATF: execute on; script steps off");
    expect(text).toContain("Raw encoded read queries: denied");
    expect(isAllFieldSelection(["*"])).toBe(true);
  });
});

// ── dispatcher harness: sn_profile and sn_batch ─────────────────────────────

const PROFILE = "card-profile";
const SECRET_REF = "CARD_TEST_SECRET_REFERENCE_NAME";
const SECRET_USER = "card-test-user-canary";
const SYS_ID_A = "a".repeat(32);
const open: Client[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(open.splice(0).map((client) => client.close()));
});

async function connect(options: {
  tableAccess: TableAccessPolicyInput;
  fieldPolicy?: FieldPolicyConfigurationInput;
  get?: (path: string, params: Record<string, string>) => Promise<unknown>;
}) {
  const get = vi.fn(
    options.get ??
      (async () => ({ result: [{ sys_id: SYS_ID_A, number: "INC0010001" }] }))
  );
  const serviceNow = {
    get,
    getWithMeta: vi.fn(async () => ({ data: { result: [] }, status: 200, headers: new Headers() })),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ result: {} })),
    delete: vi.fn(async () => ({ status: 204 })),
  };
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: INSTANCE,
      username: SECRET_USER,
      credential: `env:${SECRET_REF}`,
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => ({
      instance: INSTANCE,
      user: SECRET_USER,
      password: "unused-test-placeholder",
      displayValue: "true",
      relDepth: 3,
    })),
    getClient: vi.fn(() => serviceNow),
  } as unknown as ProfileManager;
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `card-${String(requestId)}`,
        identity: { ownerId: "card-owner", clientId: "card-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "card",
        revision: "quick-wins",
        tableAccess: createTableAccessPolicy(options.tableAccess),
        ...(options.fieldPolicy === undefined ? {} : { fieldPolicy: options.fieldPolicy }),
      }),
    },
    auditSink: { write: () => {}, writePreContext: () => {} },
  };
  const server = await createMcpServer({
    dependencies: { profileManager, executionContext },
    register: (surface, dependencies) =>
      registerServiceNowTools(surface, dependencies.profileManager, dependencies.executionContext),
  });
  const client = new Client({ name: "card-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(client);
  return { client, get };
}

function dataOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const structured = result.structuredContent as { data: Record<string, unknown> } | undefined;
  if (!structured) throw new Error(JSON.stringify(result.content));
  return structured.data;
}

describe("sn_profile policy card", () => {
  const access: TableAccessPolicyInput = {
    readTables: ["incident"],
    writeTables: ["incident"],
    targets: [target("incident", ["sn_query", "sn_update"])],
  };

  it("returns the effective policy and the same card as text", async () => {
    const { client } = await connect({
      tableAccess: access,
      fieldPolicy: { fieldPolicy: { incident: { writable: ["short_description"] } } },
    });
    const result = await client.callTool({ name: "sn_profile", arguments: { profile: PROFILE } });
    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    expect(data).toMatchObject({ name: PROFILE, instance: INSTANCE, auth_type: "basic" });
    const policy = data.policy as PolicyCard;
    expect(policy.tables).toHaveLength(1);
    expect(policy.tables[0]).toMatchObject({
      table: "incident",
      read: true,
      write: true,
      tools: ["sn_query", "sn_update"],
      writable: { fields: ["short_description"], more: 0 },
    });
    expect(data.policy_card).toBe(renderPolicyCard(policy));
    expect(String(data.policy_card)).toContain("TABLE");
  });

  it("never carries a secret, key, or credential reference", async () => {
    const { client } = await connect({ tableAccess: access });
    const result = await client.callTool({ name: "sn_profile", arguments: { profile: PROFILE } });
    const everything = JSON.stringify(result);
    expect(everything).not.toContain(SECRET_REF);
    expect(everything).not.toContain(SECRET_USER);
    expect(everything).not.toContain("unused-test-placeholder");
    expect(everything).not.toMatch(/secret_ref|apiKey|clientSecret|encrypted/iu);
  });

  it("stays within its byte budget for 100 tables of 80 long field names, and says it truncated", async () => {
    const tables = Array.from({ length: 100 }, (_, t) => `x_big_table_${String(t).padStart(3, "0")}`);
    const names = Array.from(
      { length: 80 },
      (_, f) => `u_${String(f).padStart(2, "0")}_${"a".repeat(75)}`
    );
    expect(names[0]!.length).toBe(80);
    const { client } = await connect({
      tableAccess: {
        readTables: tables,
        writeTables: tables,
        targets: tables.map((table) => target(table, ["sn_query", "sn_update"])),
      },
      fieldPolicy: {
        fieldPolicy: Object.fromEntries(
          tables.map((table) => [table, { readable: names, writable: names }])
        ),
      },
    });
    const result = await client.callTool({ name: "sn_profile", arguments: { profile: PROFILE } });
    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    const policy = data.policy as PolicyCard;
    expect(policy.truncated?.hint).toContain("policy show --json");
    expect(policy.truncated?.field_lists_narrowed).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(policy))).toBeLessThanOrEqual(40_000);
    expect(JSON.stringify(result).length).toBeLessThan(100_000);
    // Field lists are cut with a count of what was left out, never silently.
    const first = policy.tables[0]!;
    expect(first.readable).not.toBe("*");
    if (first.readable !== "*") expect(first.readable.more).toBeGreaterThan(0);
    // The text is kept only when it fits whole; if present it carries the marker.
    if (data.policy_card !== undefined) {
      expect(String(data.policy_card)).toContain("TRUNCATED");
    }
  });

  it("says so when the profile cannot write", async () => {
    const { client } = await connect({
      tableAccess: { readTables: ["incident"], targets: [target("incident", ["sn_query"])] },
    });
    const data = dataOf(
      await client.callTool({ name: "sn_profile", arguments: { profile: PROFILE } })
    );
    expect(data.policy_card).toContain("This profile cannot write to any table.");
  });
});

describe("sn_batch dry run shows its work", () => {
  const FULL: TableAccessPolicyInput = { readTables: ["*"], writeTables: ["*"], targets: [] };
  const args = (extra: Record<string, unknown> = {}) => ({
    profile: PROFILE,
    table: "incident",
    action: "update",
    structured_query: {
      filter: { type: "equality", field: "active", operator: "eq", value: true },
    },
    fields: { state: "7", close_notes: "bulk" },
    ...extra,
  });
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => (index + 1).toString(16).padStart(32, "0"));

  it("returns a sample of at most 5, the field names, and the re-query note", async () => {
    const all = ids(12);
    const { client, get } = await connect({
      tableAccess: FULL,
      get: async (_path, params) =>
        params.sysparm_query?.startsWith("sys_idIN")
          ? { result: params.sysparm_query.slice(8).split(",").map((sysId, i) => ({ sys_id: sysId, number: `INC00${i}` })) }
          : { result: all.map((sysId) => ({ sys_id: sysId })) },
    });
    const result = await client.callTool({ name: "sn_batch", arguments: args() });
    const data = dataOf(result);

    expect(data).toMatchObject({ matched: 12, dry_run: true });
    expect(data.sample).toEqual(
      all.slice(0, 5).map((sys_id, i) => ({ sys_id, display: `INC00${i}` }))
    );
    expect(data.fields_to_write).toEqual(["state", "close_notes"]);
    expect(String(data.note)).toContain("confirm");
    expect(String(data.note)).toContain("different");
    // Field names only: the values the caller sent are not echoed back.
    expect(JSON.stringify(data)).not.toContain("bulk");

    // The lookup, plus exactly one bounded sample read of the sys_ids it found.
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]![1]).toEqual({
      sysparm_fields: "sys_id,number",
      sysparm_limit: "5",
      sysparm_query: `sys_idIN${all.slice(0, 5).join(",")}`,
    });
  });

  it("asks only for fields the profile may read, and picks the display from them", async () => {
    const { client, get } = await connect({
      tableAccess: FULL,
      fieldPolicy: {
        fieldPolicy: { incident: { readable: ["sys_id", "short_description", "state", "active"] } },
      },
      get: async (_path, params) =>
        params.sysparm_query?.startsWith("sys_idIN")
          ? { result: [{ sys_id: SYS_ID_A, short_description: "Printer on fire", number: "INC1", state: "1" }] }
          : { result: [{ sys_id: SYS_ID_A }] },
    });
    const data = dataOf(await client.callTool({ name: "sn_batch", arguments: args() }));
    // number is not readable on this profile: neither requested nor shown.
    expect(get.mock.calls[1]![1]).toMatchObject({ sysparm_fields: "sys_id,short_description" });
    expect(data.sample).toEqual([{ sys_id: SYS_ID_A, display: "Printer on fire" }]);
    expect(JSON.stringify(data)).not.toContain("INC1");
  });

  it("shows sys_id only when no display field is readable", async () => {
    const { client, get } = await connect({
      tableAccess: FULL,
      fieldPolicy: { fieldPolicy: { incident: { readable: ["sys_id", "state", "active"] } } },
      get: async () => ({ result: [{ sys_id: SYS_ID_A, number: "INC1", state: "1" }] }),
    });
    const data = dataOf(await client.callTool({ name: "sn_batch", arguments: args() }));
    expect(get.mock.calls[1]![1]).toMatchObject({ sysparm_fields: "sys_id" });
    expect(data.sample).toEqual([{ sys_id: SYS_ID_A }]);
  });

  it("makes no sample read when nothing matched, and none on delete lists field names", async () => {
    const empty = await connect({ tableAccess: FULL, get: async () => ({ result: [] }) });
    const none = dataOf(await empty.client.callTool({ name: "sn_batch", arguments: args() }));
    expect(none).toMatchObject({ matched: 0, dry_run: true });
    expect(none).not.toHaveProperty("sample");
    expect(empty.get).toHaveBeenCalledTimes(1);

    const del = await connect({ tableAccess: FULL });
    const removed = dataOf(
      await del.client.callTool({
        name: "sn_batch",
        arguments: args({ action: "delete", fields: undefined }),
      })
    );
    expect(removed).toMatchObject({ action: "delete", dry_run: true });
    expect(removed).not.toHaveProperty("fields_to_write");
    expect(String(removed.note)).toContain("confirm");
  });

  it("still returns the count when the sample read fails", async () => {
    let calls = 0;
    const { client } = await connect({
      tableAccess: FULL,
      get: async () => {
        calls += 1;
        if (calls > 1) throw new Error("upstream down");
        return { result: [{ sys_id: SYS_ID_A }] };
      },
    });
    const result = await client.callTool({ name: "sn_batch", arguments: args() });
    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    expect(data).toMatchObject({ matched: 1, dry_run: true });
    expect(data).not.toHaveProperty("sample");
  });

  it("bounds a long display value", async () => {
    const { client } = await connect({
      tableAccess: FULL,
      get: async (_path, params) =>
        params.sysparm_query?.startsWith("sys_idIN")
          ? { result: [{ sys_id: SYS_ID_A, number: "N".repeat(5000) }] }
          : { result: [{ sys_id: SYS_ID_A }] },
    });
    const data = dataOf(await client.callTool({ name: "sn_batch", arguments: args() }));
    const [row] = data.sample as Array<{ display: string }>;
    expect(row!.display.length).toBeLessThanOrEqual(121);
  });
});
