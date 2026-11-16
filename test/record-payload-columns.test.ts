/**
 * Record payload columns (per table: `payload` and `payload_diff` on the
 * update, upgrade, metadata, archive and delete tables; the queue, change-log,
 * flow snapshot and certificate columns) are read and written only where the
 * profile's own field-policy entry for the table lists them. No wildcard
 * covers them: not the open default, a "*" field entry, or "*" on the table.
 * Numbered rotation shards of the queue tables are covered by name.
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
  EXPLICIT_READ_FIELD_NAMES,
  ROTATION_SHARD_BASE_NAMES,
  FieldPolicyError,
  fieldPolicyDenialMessage,
  filterAggregateResult,
  filterReadableRecord,
  queryDeniedFields,
  readableSelectionForTable,
  resolveReadableFields,
  runWithFieldPolicyConfiguration,
  validateFieldPolicyConfiguration,
  validateWritableFields,
  type FieldPolicyConfigurationInput,
} from "../src/field-policy.js";
import {
  fieldTypesFromRows,
  hiddenFieldScope,
  runWithHiddenFieldScope,
} from "../src/hidden-values.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import { noHiddenFieldTypes } from "./fixtures/field-types.js";

const XML_PAIR = ["payload", "payload_diff"] as const;
/** Each table and its payload columns, as the policy lists them. */
const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  sys_update_xml: XML_PAIR,
  sys_update_version: XML_PAIR,
  sys_update_preview_xml: XML_PAIR,
  sys_update_diff: XML_PAIR,
  sys_sync_preview_remote: XML_PAIR,
  sys_upgrade_history_log: XML_PAIR,
  sys_metadata_link: XML_PAIR,
  sys_metadata_delete: XML_PAIR,
  sys_audit_delete: XML_PAIR,
  sys_archive_log: XML_PAIR,
  clone_preserved_data: XML_PAIR,
  ecc_queue: ["payload"],
  sys_replication_queue: ["payload", "payload_short"],
  data_replication_queue: ["payload"],
  cdc_queue_ih: ["payload", "previous_payload"],
  cdc_queue_par: ["payload", "previous_payload"],
  cdc_queue_uxa_user_props: ["payload", "previous_payload"],
  sys_rt_change_log: ["payload"],
  sys_hub_snapshot: ["payload"],
  sys_hub_snapshot_chunk: ["data"],
  sys_hub_flow_version: ["payload"],
  sn_disco_certmgmt_certificate_ca_credentials: ["encoded_keystore"],
};
/** One numbered shard per rotation base, and the base it belongs to. */
const SHARDS: Readonly<Record<string, string>> = {
  ecc_queue0003: "ecc_queue",
  sys_replication_queue5: "sys_replication_queue",
  data_replication_queue0006: "data_replication_queue",
  cdc_queue_ih0000: "cdc_queue_ih",
  cdc_queue_par0009: "cdc_queue_par",
  cdc_queue_uxa_user_props0006: "cdc_queue_uxa_user_props",
};
const columnsOf = (table: string): readonly string[] => TABLE_COLUMNS[SHARDS[table] ?? table] ?? [];
const TABLES = [...Object.keys(TABLE_COLUMNS), ...Object.keys(SHARDS)];
const PAIRS = TABLES.flatMap((table) => columnsOf(table).map((column) => [table, column] as const));
/** The tables a "*" table grant reaches (sys_audit_delete must be named). */
const STAR_TABLES = TABLES.filter((table) => table !== "sys_audit_delete");

const SYS_ID = "d".repeat(32);
const MARKER = "PAYLOAD-COLUMN-MARKER-41c2";
const CONTENT =
  '<?xml version="1.0" encoding="UTF-8"?><record_update table="u_example_widget">' +
  `<u_example_widget action="INSERT_OR_UPDATE"><short_description>${MARKER}</short_description>` +
  `<sys_id>${SYS_ID}</sys_id></u_example_widget></record_update>`;

/** A row of `table` carrying the marker in each of its payload columns. */
function rowFor(table: string): Record<string, string> {
  const row: Record<string, string> = { sys_id: SYS_ID, name: "u_example_widget_" + SYS_ID };
  for (const column of columnsOf(table)) row[column] = CONTENT;
  return row;
}

function withFieldPolicy<T>(configuration: FieldPolicyConfigurationInput, action: () => T): T {
  return runWithFieldPolicyConfiguration(configuration, action);
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

describe("the record payload column list", () => {
  it("is each listed table's own columns", () => {
    expect(EXPLICIT_READ_FIELD_NAMES).toEqual(TABLE_COLUMNS);
    expect(Object.isFrozen(EXPLICIT_READ_FIELD_NAMES)).toBe(true);
    expect([...ROTATION_SHARD_BASE_NAMES].sort()).toEqual([...new Set(Object.values(SHARDS))].sort());
  });
});

describe("rotation shards", () => {
  it.each(Object.entries(SHARDS))("%s takes the columns of %s", (shard, base) => {
    for (const column of TABLE_COLUMNS[base]!) {
      expect(reason(() => resolveReadableFields(shard, { fields: column })), `${shard}.${column}`).toBe(
        "explicit_read_required"
      );
      expect(reason(() => validateWritableFields(shard, { [column]: "x" })), `${shard}.${column}`).toBe(
        "explicit_field_required"
      );
    }
  });

  it.each([
    "ecc_queue_0001",
    "ecc_queue_example",
    "xecc_queue0001",
    "ecc_queue0001a",
    "ecc_queuex",
    "u_ecc_queue0001",
    "sys_update_xml0001",
    "sys_hub_snapshot01",
    "cdc_queue0001",
    "cdc_queue",
    "cdc_queue_state_ih",
    "cdc_queue_state_par0001",
    "u_cdc_queue_example",
  ])("%s is not covered: its payload column follows the ordinary rules", (table) => {
    expect(resolveReadableFields(table, { fields: "payload" })).toEqual(["payload"]);
    expect(validateWritableFields(table, { payload: "x" })).toEqual({ payload: "x" });
  });

  it.each(["cdc_queue_example_consumer", "cdc_queue_example_consumer0001", "cdc_queue_x", "cdc_queue_statement"])(
    "%s, a change-data-capture queue, has the CDC queue columns",
    (table) => {
      for (const column of ["payload", "previous_payload"]) {
        expect(reason(() => resolveReadableFields(table, { fields: column })), `${table}.${column}`).toBe(
          "explicit_read_required"
        );
        expect(reason(() => validateWritableFields(table, { [column]: "x" })), `${table}.${column}`).toBe(
          "explicit_field_required"
        );
      }
      expect(resolveReadableFields(table, { fields: "name" })).toEqual(["name"]);
      withFieldPolicy({ fieldPolicy: { [table]: { readable: ["sys_id", "payload"] } } }, () => {
        expect(resolveReadableFields(table, { fields: "payload" })).toEqual(["payload"]);
        expect(reason(() => resolveReadableFields(table, { fields: "previous_payload" }))).toBe(
          "explicit_read_required"
        );
      });
    }
  );

  it("naming the base table does not open a shard, and naming a shard opens only that shard", () => {
    withFieldPolicy({ fieldPolicy: { ecc_queue: { readable: ["sys_id", "payload"] } } }, () => {
      expect(resolveReadableFields("ecc_queue", { fields: "payload" })).toEqual(["payload"]);
      expect(reason(() => resolveReadableFields("ecc_queue0003", { fields: "payload" }))).toBe(
        "explicit_read_required"
      );
    });
    withFieldPolicy({ fieldPolicy: { ecc_queue0003: { readable: ["sys_id", "payload"] } } }, () => {
      expect(resolveReadableFields("ecc_queue0003", { fields: "payload" })).toEqual(["payload"]);
      expect(reason(() => resolveReadableFields("ecc_queue0004", { fields: "payload" }))).toBe(
        "explicit_read_required"
      );
      expect(reason(() => resolveReadableFields("ecc_queue", { fields: "payload" }))).toBe(
        "explicit_read_required"
      );
    });
  });
});


describe("with no field policy", () => {
  it.each(PAIRS)("%s.%s is refused by name, with the key that opens it", (table, column) => {
    try {
      resolveReadableFields(table, { fields: `sys_id,${column}` });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FieldPolicyError);
      expect((error as FieldPolicyError).reason).toBe("explicit_read_required");
      const message = fieldPolicyDenialMessage(error as FieldPolicyError);
      expect(message).toContain("denied by policy");
      expect(message).toContain(`fieldPolicy.${table}.readable`);
    }
  });

  it.each(PAIRS)("%s.%s is refused to filter, order, group or aggregate", (table, column) => {
    expect(reason(() => resolveReadableFields(table, { fields: column, purpose: "query" }))).toBe(
      "explicit_read_required"
    );
    expect(queryDeniedFields(table).has(column)).toBe(true);
  });

  it.each(PAIRS)("%s.%s is left out of fields=all, detailed and default reads", (table, column) => {
    for (const selection of [
      resolveReadableFields(table, { fields: "all" }),
      resolveReadableFields(table, { responseFormat: "detailed" }),
      resolveReadableFields(table),
    ]) {
      expect(selection).not.toContain(column);
      expect(JSON.stringify(filterReadableRecord(rowFor(table), selection))).not.toContain(MARKER);
    }
  });

  it.each(PAIRS)("%s.%s is left out of a caller-built projection", (table, column) => {
    const selection = readableSelectionForTable(table, ["sys_id", "name", column]);
    expect(selection).not.toContain(column);
    expect(JSON.stringify(filterReadableRecord(rowFor(table), selection))).not.toContain(MARKER);
  });

  it.each(PAIRS)("%s.%s is dropped from an aggregate grouped on it", (table, column) => {
    const stats = { result: [{ stats: { count: "1" }, groupby_fields: [{ field: column, value: MARKER }] }] };
    const filtered = filterAggregateResult(stats, resolveReadableFields(table, { fields: "all" }));
    expect(JSON.stringify(filtered)).not.toContain(MARKER);
  });

  it.each(PAIRS)("%s.%s is refused as a write key, with the key that opens it", (table, column) => {
    try {
      validateWritableFields(table, { [column]: "x" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FieldPolicyError);
      expect((error as FieldPolicyError).reason).toBe("explicit_field_required");
      const message = fieldPolicyDenialMessage(error as FieldPolicyError);
      expect(message).toContain("holds record payloads");
      expect(message).toContain(`fieldPolicy.${table}.writable`);
    }
    expect(validateWritableFields(table, { name: "x" })).toEqual({ name: "x" });
  });

  it.each(TABLES)("%s: a projection built outside the policy is held to the call's tables", (table) => {
    const { scope } = hiddenFieldScope(fieldTypesFromRows([], { [table]: [table] }), [table], false);
    runWithHiddenFieldScope(scope!, () => {
      const filtered = filterReadableRecord(rowFor(table), ["*"]);
      expect(JSON.stringify(filtered)).not.toContain(MARKER);
      expect(filtered).toMatchObject({ sys_id: SYS_ID });
    });
  });

  it("leaves a same-named column on another table alone", () => {
    for (const table of ["u_example_widget", "sys_update_set", "sys_hub_flow"]) {
      expect(resolveReadableFields(table, { fields: "payload" }), table).toEqual(["payload"]);
      expect(validateWritableFields(table, { payload: "x" }), table).toEqual({ payload: "x" });
    }
  });
});

describe("only the table's own entry opens a column", () => {
  it.each(PAIRS)("%s.%s: listed in its own readable, it reads, filters and is returned", (table, column) => {
    const configuration = { fieldPolicy: { [table]: { readable: ["sys_id", "name", column] } } };
    expect(() => validateFieldPolicyConfiguration(configuration)).not.toThrow();
    withFieldPolicy(configuration, () => {
      expect(resolveReadableFields(table, { fields: column })).toEqual([column]);
      expect(resolveReadableFields(table, { fields: column, purpose: "query" })).toEqual([column]);
      expect(resolveReadableFields(table, { fields: "all" })).toContain(column);
      expect(
        JSON.stringify(filterReadableRecord(rowFor(table), resolveReadableFields(table, { fields: column })))
      ).toContain(MARKER);
      expect(queryDeniedFields(table).has(column)).toBe(false);
      // Reading it does not open writing it.
      expect(reason(() => validateWritableFields(table, { [column]: "<x/>" }))).toBe("explicit_field_required");
    });
  });

  it.each(PAIRS)("%s.%s: listed in its own writable, it is written", (table, column) => {
    withFieldPolicy({ fieldPolicy: { [table]: { writable: ["name", column] } } }, () => {
      expect(validateWritableFields(table, { [column]: "<x/>" })).toEqual({ [column]: "<x/>" });
      // Writing it does not open reading it.
      expect(reason(() => resolveReadableFields(table, { fields: column }))).toBe("explicit_read_required");
    });
  });

  it("the list forms (readableTableFields, writableTableFields) open them too", () => {
    withFieldPolicy(
      {
        readableTableFields: [{ table: "sys_update_xml", fields: ["sys_id", "payload"] }],
        writableTableFields: [{ table: "sys_update_xml", fields: ["payload"] }],
      },
      () => {
        expect(resolveReadableFields("sys_update_xml", { fields: "payload" })).toEqual(["payload"]);
        expect(validateWritableFields("sys_update_xml", { payload: "<x/>" })).toEqual({ payload: "<x/>" });
      }
    );
  });

  it.each([
    ['own "*"', { sys_update_xml: { readable: "*", writable: "*" } }],
    ['own ["*"]', { sys_update_xml: { readable: ["*"], writable: ["*"] } }],
    ['a "*" entry listing it', { "*": { readable: ["sys_id", "payload"], writable: ["payload"] } }],
    ['a "*" entry of "*"', { "*": { readable: "*", writable: "*" } }],
    ["defaults alone", { sys_update_xml: { defaults: ["sys_id", "name"] } }],
  ])("%s never opens it", (_label, fieldPolicy) => {
    withFieldPolicy({ fieldPolicy }, () => {
      expect(reason(() => resolveReadableFields("sys_update_xml", { fields: "payload" }))).toBe(
        "explicit_read_required"
      );
      expect(resolveReadableFields("sys_update_xml", { fields: "all" })).not.toContain("payload");
      expect(reason(() => validateWritableFields("sys_update_xml", { payload: "<x/>" }))).toBe(
        "explicit_field_required"
      );
    });
  });

  it("opens only the table and the column it names", () => {
    // sys_hub_snapshot_chunk's column is `data`: a `payload` column there is ordinary.
    expect(resolveReadableFields("sys_hub_snapshot_chunk", { fields: "payload" })).toEqual(["payload"]);
    withFieldPolicy({ fieldPolicy: { sys_upgrade_history_log: { readable: ["sys_id", "payload"] } } }, () => {
      expect(resolveReadableFields("sys_upgrade_history_log", { fields: "payload" })).toEqual(["payload"]);
      expect(reason(() => resolveReadableFields("sys_upgrade_history_log", { fields: "payload_diff" }))).toBe(
        "explicit_read_required"
      );
      for (const table of TABLES.filter((name) => name !== "sys_upgrade_history_log")) {
        expect(reason(() => resolveReadableFields(table, { fields: columnsOf(table)[0]! })), table).toBe(
          "explicit_read_required"
        );
      }
    });
  });

  it('leaves a narrowing "*" entry as it was for the other columns', () => {
    withFieldPolicy({ fieldPolicy: { "*": { readable: ["sys_id", "name", "sys_created_on"] } } }, () => {
      expect(reason(() => resolveReadableFields("sys_update_xml", { fields: "type" }))).toBe("unreadable_field");
      expect(resolveReadableFields("sys_update_xml", { fields: "name" })).toEqual(["name"]);
      expect(reason(() => resolveReadableFields("sys_update_xml", { fields: "payload" }))).toBe(
        "explicit_read_required"
      );
    });
  });
});

// Through the dispatcher: a "*" grant for reads and writes, no field policy.
const CONFIG: ServiceNowConfig = {
  instance: "https://record-xml-test.service-now.com",
  user: "record-xml-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

async function connect(fieldPolicy?: FieldPolicyConfigurationInput) {
  const records: ToolAuditRecord[] = [];
  // `/api/now/(table|stats)/<table>[/<sys_id>]`.
  const tableOf = (path: string) => /^\/api\/now\/(?:table|stats)\/([a-z0-9_]+)/u.exec(path)?.[1] ?? "";
  const answer = (path: string) => {
    const table = tableOf(path);
    if (path.startsWith("/api/now/stats/")) {
      const field = columnsOf(table)[0] ?? "payload";
      return { result: [{ stats: { count: "1" }, groupby_fields: [{ field, value: MARKER }] }] };
    }
    return /^\/api\/now\/table\/[a-z0-9_]+\/[0-9a-f]{32}$/u.test(path)
      ? { result: rowFor(table) }
      : { result: [rowFor(table)] };
  };
  const serviceNowClient = {
    get: vi.fn(async (path: string) => answer(path)),
    getWithMeta: vi.fn(async (path: string) => ({ data: answer(path), status: 200, headers: new Headers() })),
    post: vi.fn(async (path: string) => ({ result: rowFor(tableOf(path)) })),
    patch: vi.fn(async (path: string) => ({ result: rowFor(tableOf(path)) })),
    put: vi.fn(async (path: string) => ({ result: rowFor(tableOf(path)) })),
  } as unknown as ServiceNowClient;
  const getClient = vi.fn(() => serviceNowClient);
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: CONFIG.instance,
      username: CONFIG.user,
      credential: "env:RECORD_XML_PLACEHOLDER_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => CONFIG),
    getClient,
  } as unknown as ProfileManager;
  const tableAccess = createTableAccessPolicy({ readTables: ["*"], writeTables: ["*"], targets: [] });
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `record-xml-${String(requestId)}`,
        identity: { ownerId: "record-xml-owner", clientId: "record-xml-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "record-xml",
        revision: "record-xml",
        tableAccess,
        ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
      }),
    },
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
  const client = new Client({ name: "record-xml-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    if (server.isConnected()) await server.close();
  });
  return { client, records, getClient, serviceNowClient };
}

type Connected = Awaited<ReturnType<typeof connect>>;

function call(connected: Connected, name: string, args: Record<string, unknown>) {
  return connected.client.callTool({ name, arguments: { profile: "record-xml", ...args } });
}

/** Refused by policy before any instance request. */
async function expectRefused(connected: Connected, name: string, args: Record<string, unknown>) {
  connected.getClient.mockClear();
  const result = await call(connected, name, args);
  const label = `${name} ${JSON.stringify(args)}`;
  expect(result.isError, label).toBe(true);
  expect(connected.records.at(-1), label).toMatchObject({ outcome: "policy_rejected" });
  expect(connected.getClient, label).not.toHaveBeenCalled();
}

/** Served, with the column's content nowhere in the result. */
async function expectServedWithout(connected: Connected, name: string, args: Record<string, unknown>) {
  const result = await call(connected, name, args);
  const label = `${name} ${JSON.stringify(args)}`;
  expect(result.isError, label).toBeFalsy();
  expect(JSON.stringify(result), label).not.toContain(MARKER);
}

describe('the generic tools under a "*" grant with no field policy', () => {
  it.each(STAR_TABLES)("%s: each column is refused as a field, filter, order, group or aggregate field", async (table) => {
    const connected = await connect();
    for (const column of columnsOf(table)) {
      await expectRefused(connected, "sn_query", { table, fields: `sys_id,${column}` });
      await expectRefused(connected, "sn_get", { table, sys_id: SYS_ID, fields: column });
      await expectRefused(connected, "sn_query", {
        table,
        structured_query: { filter: { type: "text", field: column, operator: "contains", value: "example" } },
      });
      await expectRefused(connected, "sn_query", { table, orderby: column });
      await expectRefused(connected, "sn_query", { table, orderby: `-${column}` });
      await expectRefused(connected, "sn_aggregate", { table, type: "COUNT", group_by: column });
      await expectRefused(connected, "sn_aggregate", { table, type: "MAX", field: column });
    }
  });

  it.each(STAR_TABLES)("%s: fields=all, detailed and default reads return neither column", async (table) => {
    const connected = await connect();
    await expectServedWithout(connected, "sn_query", { table, fields: "all" });
    await expectServedWithout(connected, "sn_query", { table, response_format: "detailed" });
    await expectServedWithout(connected, "sn_query", { table });
    await expectServedWithout(connected, "sn_get", { table, sys_id: SYS_ID, fields: "all" });
    await expectServedWithout(connected, "sn_get", { table, sys_id: SYS_ID, response_format: "detailed" });
    await expectServedWithout(connected, "sn_aggregate", { table, type: "COUNT", group_by: "name" });
  });

  it.each(STAR_TABLES)("%s: a write of either column is refused, and another write's echo omits them", async (table) => {
    const connected = await connect();
    for (const column of columnsOf(table)) {
      await expectRefused(connected, "sn_update", { table, sys_id: SYS_ID, fields: { [column]: "x" } });
    }
    await expectServedWithout(connected, "sn_update", { table, sys_id: SYS_ID, fields: { name: "renamed" } });
  });
});

describe("the generic tools once the table's own entry lists the column", () => {
  it.each(STAR_TABLES)("%s: sn_query returns it and may filter on it", async (table) => {
    const column = columnsOf(table)[0]!;
    const connected = await connect({ fieldPolicy: { [table]: { readable: ["sys_id", "name", column] } } });
    const named = await call(connected, "sn_query", { table, fields: `sys_id,${column}` });
    expect(named.isError).toBeFalsy();
    expect(JSON.stringify(named)).toContain(MARKER);
    const filtered = await call(connected, "sn_query", {
      table,
      fields: "sys_id",
      structured_query: { filter: { type: "text", field: column, operator: "contains", value: "example" } },
    });
    expect(filtered.isError).toBeFalsy();
  });

  it("sn_update writes it once the own entry lists it in writable", async () => {
    const connected = await connect({ fieldPolicy: { sys_update_xml: { writable: ["name", "payload"] } } });
    const written = await call(connected, "sn_update", {
      table: "sys_update_xml",
      sys_id: SYS_ID,
      fields: { payload: "<x/>" },
    });
    expect(written.isError).toBeFalsy();
  });

  it('a "*" field entry that lists the column still does not open it', async () => {
    const connected = await connect({ fieldPolicy: { "*": { readable: ["sys_id", "name", "payload"] } } });
    await expectRefused(connected, "sn_query", { table: "sys_update_xml", fields: "payload" });
    await expectServedWithout(connected, "sn_query", { table: "sys_update_xml", fields: "all" });
  });
});
