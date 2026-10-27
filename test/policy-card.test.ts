/**
 * Governance quick wins: the policy card (sn_profile and the card builder) and
 * the sn_batch dry run that shows its work.
 *
 * The card tests compare what the card says with what the enforcing code does
 * for the same policy, so a drift between the two fails here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

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
  budgetPolicyCard,
  buildPolicyCard,
  fitPolicyCard,
  policyCardResponse,
  renderPolicyCard,
  type CardTableRow,
  type PolicyCard,
} from "../src/policy-card.js";
import { ProfileManager as RealProfileManager, type ProfileManager } from "../src/profile-manager.js";
import { ServiceNowClient } from "../src/client.js";
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

  it("flags write access on privilege-sensitive tables without hiding the grant", () => {
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
    expect(renderPolicyCard(result)).toContain("WARNING: write access on privilege-sensitive tables");
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
  client?: unknown;
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
    getClient: vi.fn(() => options.client ?? serviceNow),
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

describe("sn_profile policy card", { timeout: 15_000 }, () => {
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
    expect(policy.truncated?.hint).toContain(`policy show --profile ${PROFILE} --json`);
    expect(policy.truncated?.hint).not.toMatch(/full detail/u);
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

// ── budget markers, memoization, deadline ───────────────────────────────────

function bigShape(tables: number, fields: number, nameLength: number) {
  const tableNames = Array.from(
    { length: tables },
    (_, t) => `x_big_table_${String(t).padStart(3, "0")}`
  );
  const names = Array.from({ length: fields }, (_, f) => {
    const prefix = `u_${String(f).padStart(2, "0")}_`;
    return prefix + "a".repeat(nameLength - prefix.length);
  });
  return {
    tableAccess: {
      readTables: tableNames,
      writeTables: tableNames,
      targets: tableNames.map((table) => target(table, ["sn_query", "sn_update"])),
    } satisfies TableAccessPolicyInput,
    fieldPolicy: {
      fieldPolicy: Object.fromEntries(
        tableNames.map((table) => [table, { readable: names, writable: names }])
      ),
    },
  };
}

function cardInput(shape: ReturnType<typeof bigShape>) {
  return {
    profile: PROFILE,
    instance: INSTANCE,
    authType: "basic" as const,
    tableAccess: createTableAccessPolicy(shape.tableAccess),
    fieldPolicy: shape.fieldPolicy,
    encodedQueryAccess: createEncodedQueryAccessPolicy(),
    atf: createAtfExecutionPolicy(undefined),
  };
}

describe("a dropped text card is always marked", { timeout: 15_000 }, () => {
  it("17 tables x 8 fields x 80 chars: data fits, text does not, and text_omitted says so", () => {
    const { card, text } = fitPolicyCard(buildPolicyCard(cardInput(bigShape(17, 8, 80))));
    expect(text).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(40_000);
    expect(card.truncated).toMatchObject({
      text_omitted: true,
      tables_omitted: 0,
      field_lists_narrowed: false,
    });
    expect(card.truncated?.hint).toContain(`policy show --profile ${PROFILE} --json`);
    expect(card.tables).toHaveLength(17);
  });

  it("when the data is also truncated, text_omitted is added to that marker", async () => {
    const shape = bigShape(30, 80, 80);
    const { card, text } = fitPolicyCard(buildPolicyCard(cardInput(shape)));
    expect(text).toBeUndefined();
    expect(card.truncated).toMatchObject({ text_omitted: true, field_lists_narrowed: true });

    const { client } = await connect({
      tableAccess: shape.tableAccess,
      fieldPolicy: shape.fieldPolicy,
    });
    const data = dataOf(
      await client.callTool({ name: "sn_profile", arguments: { profile: PROFILE } })
    );
    expect(data).not.toHaveProperty("policy_card");
    expect((data.policy as PolicyCard).truncated).toMatchObject({
      text_omitted: true,
      field_lists_narrowed: true,
    });
  });

  it("a text that fits is kept and the card is unmarked", () => {
    const { card, text } = fitPolicyCard(buildPolicyCard(cardInput(bigShape(3, 4, 20))));
    expect(card.truncated).toBeUndefined();
    expect(text).toContain("TABLE");
  });

  it("the text counts the rows the budget dropped", () => {
    const full = buildPolicyCard(cardInput(bigShape(100, 80, 80)));
    const budgeted = budgetPolicyCard(full, 20_000);
    expect(budgeted.truncated!.tables_omitted).toBeGreaterThan(0);
    expect(renderPolicyCard(budgeted)).toContain(
      `... and ${budgeted.truncated!.tables_omitted} more table(s)`
    );
  });
});

describe("the policy card is built once per loaded profile", { timeout: 15_000 }, () => {
  it("a second call is served from memory in under 1 ms, with fresh table policies", () => {
    const shape = bigShape(100, 40, 80);
    const frozen = JSON.parse(JSON.stringify(shape.fieldPolicy)) as object;
    const deepFreeze = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    };
    deepFreeze(frozen);
    const input = () => ({ ...cardInput(shape), fieldPolicy: frozen });
    const first = policyCardResponse(input());
    // Fresh table policies are built outside the timing, as the dispatcher
    // builds them outside the handler; the best of ten calls resists GC and
    // scheduler noise when the whole suite runs in parallel.
    const inputs = Array.from({ length: 10 }, input);
    let elapsed = Infinity;
    let second = first;
    for (const next of inputs) {
      const start = performance.now();
      second = policyCardResponse(next);
      elapsed = Math.min(elapsed, performance.now() - start);
    }
    expect(second).toBe(first);
    expect(elapsed).toBeLessThan(1);
  });

  it("does not cache field policy that is not frozen", () => {
    const shape = bigShape(2, 2, 20);
    const first = policyCardResponse(cardInput(shape));
    const second = policyCardResponse(cardInput(shape));
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("rebuilds after the profile is reloaded with addProfile", () => {
    const directory = mkdtempSync(join(tmpdir(), "card-memo-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const manager = new RealProfileManager({
      configFilePath: join(directory, "config.json"),
    });
    const base = {
      instance: INSTANCE,
      authType: "basic" as const,
      username: "u",
      credential: "env:SN_CARD_MEMO_SECRET",
      tableAccess: {
        readTables: ["incident"],
        writeTables: ["incident"],
        targets: [target("incident", ["sn_query", "sn_update"])],
      },
    };
    const build = () => {
      const profile = manager.getProfile("p");
      return policyCardResponse({
        profile: "p",
        instance: profile.instance,
        authType: "basic",
        tableAccess: createTableAccessPolicy(profile.tableAccess!),
        fieldPolicy: {
          ...(profile.fieldPolicy === undefined ? {} : { fieldPolicy: profile.fieldPolicy }),
        },
        encodedQueryAccess: createEncodedQueryAccessPolicy(),
        atf: createAtfExecutionPolicy(undefined),
      });
    };
    manager.addProfile("p", {
      ...base,
      fieldPolicy: { incident: { writable: ["short_description"] } },
    });
    const first = build();
    expect(build()).toBe(first);

    manager.addProfile("p", {
      ...base,
      fieldPolicy: { incident: { writable: ["short_description", "state"] } },
    });
    const reloaded = build();
    expect(reloaded).not.toBe(first);
    expect(reloaded.card.tables[0]!.writable).toEqual({
      fields: ["short_description", "state"],
      more: 0,
    });
  });
});

describe("sn_batch dry-run sample deadline", () => {
  it("a hung sample read costs the preview at about 5 s, never the dry run", async () => {
    const sysId = "a".repeat(32);
    const aborted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const query = new URL(String(url)).searchParams.get("sysparm_query") ?? "";
        if (!query.startsWith("sys_idIN")) {
          return new Response(JSON.stringify({ result: [{ sys_id: sysId }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted.push("sample");
              reject(init.signal!.reason);
            },
            { once: true }
          );
        });
      })
    );
    const { client } = await connect({
      tableAccess: { readTables: ["*"], writeTables: ["*"], targets: [] },
      client: new ServiceNowClient(
        { instance: INSTANCE, user: "u", password: "p", displayValue: "true", relDepth: 3 },
        { sleep: async () => {} }
      ),
    });
    const start = performance.now();
    const result = await client.callTool(
      {
        name: "sn_batch",
        arguments: {
          profile: PROFILE,
          table: "incident",
          action: "update",
          structured_query: {
            filter: { type: "equality", field: "active", operator: "eq", value: true },
          },
          fields: { state: "7" },
        },
      },
      undefined,
      { timeout: 30_000 }
    );
    const elapsed = performance.now() - start;
    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    expect(data).toMatchObject({ matched: 1, dry_run: true });
    expect(data).not.toHaveProperty("sample");
    expect(aborted).toEqual(["sample"]);
    expect(elapsed).toBeGreaterThan(4_900);
    expect(elapsed).toBeLessThan(7_000);
  }, 20_000);
});

describe("the budgets hold with the truncation marker included", { timeout: 15_000 }, () => {
  it.each([
    [26, 8],
    [17, 8],
    [20, 8],
    [24, 8],
    [25, 8],
    [27, 8],
    [30, 8],
    [30, 80],
    [60, 8],
    [100, 8],
    [100, 80],
  ])("%i tables x %i fields x 80 chars: data <= 40,000 B and text <= 24,000 B", (tables, fields) => {
    const { card, text } = fitPolicyCard(buildPolicyCard(cardInput(bigShape(tables, fields, 80))));
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(40_000);
    if (text === undefined) {
      expect(card.truncated?.text_omitted).toBe(true);
    } else {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24_000);
    }
  });
});

// ── security review fixes ───────────────────────────────────────────────────

describe("write and risky facts cover every named table, not only the rows shown", () => {
  const readOnly = Array.from({ length: 120 }, (_, i) => `a_tbl_${String(i).padStart(3, "0")}`);
  const lateAccess: TableAccessPolicyInput = {
    readTables: [...readOnly, "sys_user_has_role"],
    writeTables: ["sys_user_has_role"],
    targets: [
      ...readOnly.map((table) => target(table, ["sn_query"])),
      target("sys_user_has_role", ["sn_query", "sn_create"]),
    ],
  };

  it("buildPolicyCard sees a write grant that sorts after the 100th row", () => {
    const result = card(lateAccess);
    expect(result.tables).toHaveLength(100);
    expect(result.tables_more).toBe(21);
    expect(result.tables.some((row) => row.table === "sys_user_has_role")).toBe(false);
    expect(result.can_write_anything).toBe(true);
    expect(result.risky_write_tables).toEqual(["sys_user_has_role"]);
    const text = renderPolicyCard(result);
    expect(text).not.toContain("cannot write");
    expect(text).toContain("WARNING: write access on privilege-sensitive tables: sys_user_has_role");
  });

  it("sn_profile reports it through the dispatcher", async () => {
    const { client } = await connect({ tableAccess: lateAccess });
    const data = dataOf(
      await client.callTool({ name: "sn_profile", arguments: { profile: PROFILE } })
    );
    const policy = data.policy as PolicyCard;
    expect(policy.can_write_anything).toBe(true);
    expect(policy.risky_write_tables).toEqual(["sys_user_has_role"]);
    expect(String(data.policy_card)).not.toContain("cannot write");
  });
});

describe("a wildcard profile states what the system tables keep", () => {
  const wildcard: TableAccessPolicyInput = { readTables: ["*"], writeTables: ["*"], targets: [] };
  const star = { fieldPolicy: { "*": { readable: ["sys_id", "number"], writable: ["short_description"] } } };

  it("lists the system tables that stay fully open, in data and in text", () => {
    const result = card(wildcard, star);
    const other = result.other_tables!;
    expect(other.writable).toEqual({ fields: ["short_description"], more: 0 });
    expect(other.system_tables.star_field_entry_applies).toBe(false);
    expect(other.system_tables.fully_writable).toContain("sys_script");
    expect(other.system_tables.fully_writable).toContain("sys_user");
    expect(
      other.system_tables.fully_writable.length + other.system_tables.write_narrowed.length
    ).toBe(BUILT_IN_TABLE_CLASSES.system.length);
    const text = renderPolicyCard(result);
    expect(text).toContain("does not apply to the 23 system tables");
    expect(text).toContain("stay fully writable (every field)");
  });

  it("matches enforcement: a script write passes on sys_script and not on a custom table", () => {
    expect(enforcedWritable(star, "sys_script", "script")).toBe(true);
    expect(enforcedWritable(star, "x_custom", "script")).toBe(false);
  });

  // The card must never claim narrower access than enforcement gives, for
  // reads and writes separately, in both field-policy formats.
  const shapes: ReadonlyArray<[string, FieldPolicyConfigurationInput | undefined]> = [
    ["no field policy", undefined],
    ["star narrows both", star],
    ["star narrows reads only", { fieldPolicy: { "*": { readable: ["sys_id"] } } }],
    ["star narrows writes only", { fieldPolicy: { "*": { writable: ["short_description"] } } }],
    ["sys_script narrows reads only", { fieldPolicy: { sys_script: { readable: ["sys_id", "name"] } } }],
    ["sys_script narrows writes only", { fieldPolicy: { sys_script: { writable: ["name"] } } }],
    [
      "list format: sys_db_object reads only",
      { readableTableFields: [{ table: "sys_db_object", fields: ["sys_id", "name"] }] },
    ],
    [
      "list format: sys_app writes only",
      { writableTableFields: [{ table: "sys_app", fields: ["name"] }] },
    ],
    [
      "mixed, several system tables",
      {
        fieldPolicy: {
          "*": { readable: ["sys_id"], writable: ["short_description"] },
          sys_user: { readable: ["sys_id", "email"] },
          syslog: { writable: ["message"] },
          sys_atf_test: { readable: ["sys_id"], writable: ["name"] },
        },
      },
    ],
  ];

  it.each(shapes)("sweep (%s): card system_tables equals enforcement, reads and writes apart", (_name, policy) => {
    const system = card(wildcard, policy).other_tables!.system_tables;
    for (const table of BUILT_IN_TABLE_CLASSES.system) {
      const read = enforcedReadable(policy, table, "script");
      const write = enforcedWritable(policy, table, "script");
      expect(system.fully_readable.includes(table), `${table} read`).toBe(read);
      expect(system.read_narrowed.includes(table), `${table} read narrowed`).toBe(!read);
      expect(system.fully_writable.includes(table), `${table} write`).toBe(write);
      expect(system.write_narrowed.includes(table), `${table} write narrowed`).toBe(!write);
    }
  });

  it.each([
    ["fieldPolicy format", { fieldPolicy: { sys_script: { readable: ["sys_id", "name"] } } }],
    [
      "readableTableFields format",
      { readableTableFields: [{ table: "sys_script", fields: ["sys_id", "name"] }] },
    ],
  ] as const)("narrowing only the reads of sys_script still reports it fully writable (%s)", (_name, policy) => {
    const result = card(wildcard, policy);
    const system = result.other_tables!.system_tables;
    expect(enforcedWritable(policy, "sys_script", "script")).toBe(true);
    expect(system.read_narrowed).toContain("sys_script");
    expect(system.fully_writable).toContain("sys_script");
    expect(system.write_narrowed).not.toContain("sys_script");
    const note = renderPolicyCard(result)
      .split("\n")
      .find((line) => line.includes("stay fully writable"))!;
    expect(note).toContain("sys_script");
  });

  it("a system table the profile names is reported as narrowed for the operation it narrows", () => {
    const named = { fieldPolicy: { "*": { readable: ["sys_id"] }, sys_user: { readable: ["sys_id"], writable: ["email"] } } };
    const system = card(wildcard, named).other_tables!.system_tables;
    expect(system.read_narrowed).toContain("sys_user");
    expect(system.write_narrowed).toContain("sys_user");
    expect(system.fully_writable).not.toContain("sys_user");
  });

  it("lists nothing for an operation the profile has no wildcard grant for", () => {
    const readOnly = card({ readTables: ["*"], targets: [] }).other_tables!.system_tables;
    expect(readOnly.fully_writable).toEqual([]);
    expect(readOnly.write_narrowed).toEqual([]);
    expect(readOnly.fully_readable).toContain("sys_script");
  });
});

describe("the instance in the card is a bare origin", () => {
  it("drops credentials, path and query", () => {
    const result = buildPolicyCard({
      ...cardInput(bigShape(1, 1, 20)),
      instance: "https://admin:canary-pw-123@dev1.service-now.com/path?token=canary-tok",
    });
    expect(result.instance).toBe("https://dev1.service-now.com");
    const everything = JSON.stringify(result) + renderPolicyCard(result);
    expect(everything).not.toContain("canary");
  });

  it("does not echo an unparseable instance", () => {
    const result = buildPolicyCard({ ...cardInput(bigShape(1, 1, 20)), instance: "not a url canary-pw" });
    expect(result.instance).toBe("(invalid instance URL)");
    expect(JSON.stringify(result)).not.toContain("canary");
  });
});

describe("the dry-run sample comes only from the matched set", () => {
  it("drops foreign, duplicate and malformed sys_ids from the answer", async () => {
    const asked = ["1", "2"].map((n) => n.repeat(32));
    const foreign = "f".repeat(32);
    const { client } = await connect({
      tableAccess: { readTables: ["*"], writeTables: ["*"], targets: [] },
      get: async (_path, params) =>
        params.sysparm_query?.startsWith("sys_idIN")
          ? {
              result: [
                { sys_id: foreign, number: "INC-FOREIGN" },
                { sys_id: asked[0], number: "INC1" },
                { sys_id: asked[0], number: "INC1-dup" },
                { sys_id: "x^ORactive=true", number: "INC-BAD" },
                { sys_id: asked[1], number: "INC2" },
              ],
            }
          : { result: asked.map((sys_id) => ({ sys_id })) },
    });
    const data = dataOf(
      await client.callTool({
        name: "sn_batch",
        arguments: {
          profile: PROFILE,
          table: "incident",
          action: "update",
          structured_query: {
            filter: { type: "equality", field: "active", operator: "eq", value: true },
          },
          fields: { state: "7" },
        },
      })
    );
    expect(data.sample).toEqual([
      { sys_id: asked[0], display: "INC1" },
      { sys_id: asked[1], display: "INC2" },
    ]);
    expect(JSON.stringify(data)).not.toMatch(/FOREIGN|dup|BAD/u);
  });
});

describe("the memoized card is keyed by more than the field policy", () => {
  it("two profiles sharing one frozen field policy get their own cards", () => {
    const shared = Object.freeze({
      incident: Object.freeze({ writable: Object.freeze(["short_description"]) }),
    });
    const input = (profile: string, tables: TableAccessPolicyInput) => ({
      profile,
      instance: INSTANCE,
      authType: "basic" as const,
      tableAccess: createTableAccessPolicy(tables),
      fieldPolicy: Object.freeze({ fieldPolicy: shared }),
      encodedQueryAccess: createEncodedQueryAccessPolicy(),
      atf: createAtfExecutionPolicy(undefined),
    });
    const readOnly = policyCardResponse(
      input("ro", { readTables: ["incident"], targets: [target("incident", ["sn_query"])] })
    );
    const writer = policyCardResponse(
      input("rw", {
        readTables: ["incident"],
        writeTables: ["incident"],
        targets: [target("incident", ["sn_query", "sn_update"])],
      })
    );
    expect(readOnly.card.profile).toBe("ro");
    expect(readOnly.card.can_write_anything).toBe(false);
    expect(writer.card.profile).toBe("rw");
    expect(writer.card.can_write_anything).toBe(true);
    expect(writer).not.toBe(readOnly);
  });
});
