import { describe, expect, it } from "vitest";

import {
  canonicalHistoryArgs,
  historyDataSchema,
  historyInputSchema,
  HISTORY_DESCRIPTION,
  HISTORY_FIXED_TABLES,
  HISTORY_LIMITS,
  HISTORY_SOURCE_SPECS,
  HISTORY_UNTRUSTED_SENTENCE,
} from "../src/tools/history-contracts.js";
import { historyToolModule } from "../src/tools/history-module.js";
import { encodeTailCursor } from "../src/tools/syslog-cursor.js";
import { fakeInstance, FULL_TABLES, harness, ids, namedPolicy, rowId } from "./history-harness.js";

const BASE = { table: "incident", sys_id: ids.incident };
const parse = (args: Record<string, unknown>) => historyInputSchema.safeParse(args).success;

describe("input schema", () => {
  it("accepts the smallest call and refuses unknown keys", () => {
    expect(parse(BASE)).toBe(true);
    expect(parse({ ...BASE, query: "active=true" })).toBe(false);
    expect(parse({ ...BASE, offset: 10 })).toBe(false);
    expect(parse({ ...BASE, cursor: { audit: undefined, other: "x" } })).toBe(false);
    expect(parse({ table: "incident" })).toBe(false);
    expect(parse({ sys_id: ids.incident })).toBe(false);
  });

  it("takes an exact 32-hex sys_id and a table name only", () => {
    for (const sysId of ["", "abc", `${ids.incident}0`, `${ids.incident.slice(1)}g`, `${ids.incident}^ORactive=true`]) {
      expect(parse({ ...BASE, sys_id: sysId }), sysId).toBe(false);
    }
    expect(canonicalHistoryArgs({ ...BASE, sys_id: ids.incident.toUpperCase() }).sys_id).toBe(ids.incident);
    for (const table of ["", "1incident", "incident,sys_user", "incident^", "sys audit", "a".repeat(81)]) {
      expect(parse({ ...BASE, table }), table).toBe(false);
    }
    expect(canonicalHistoryArgs({ ...BASE, table: " Incident " }).table).toBe("incident");
  });

  it("takes sources from the three names, and up to 20 field names", () => {
    expect(parse({ ...BASE, sources: [] })).toBe(false);
    expect(parse({ ...BASE, sources: ["history_line"] })).toBe(false);
    expect(parse({ ...BASE, sources: ["audit", "journal", "flows", "audit"] })).toBe(false);
    expect(canonicalHistoryArgs({ ...BASE, sources: ["flows", "audit", "flows"] }).sources).toEqual(["audit", "flows"]);
    expect(parse({ ...BASE, fields: [] })).toBe(false);
    expect(parse({ ...BASE, fields: Array.from({ length: HISTORY_LIMITS.MAX_FIELDS + 1 }, (_, n) => `f${n}`) })).toBe(false);
    for (const field of ["caller_id.name", "priority^ORactive=true", "", "1x", "a,b"]) {
      expect(parse({ ...BASE, fields: [field] }), field).toBe(false);
    }
    expect(canonicalHistoryArgs({ ...BASE, fields: ["State", "priority", "state"] }).fields).toEqual(["priority", "state"]);
  });

  it("takes since and until as UTC dates or times, completing a date to the whole day", () => {
    for (const value of ["2026-02-30", "2026-01-01T10:00:00Z", "2026-01-01 10:00", "yesterday", "2026-01-01 10:00:00^ORactive=true"]) {
      expect(parse({ ...BASE, since: value }), value).toBe(false);
    }
    const args = canonicalHistoryArgs({ ...BASE, since: "2026-01-01", until: "2026-01-02" });
    expect([args.since, args.until]).toEqual(["2026-01-01 00:00:00", "2026-01-02 23:59:59"]);
    expect(canonicalHistoryArgs({ ...BASE, until: "2026-01-02 08:30:00" }).until).toBe("2026-01-02 08:30:00");
  });

  it("bounds limit and max_response_bytes, and applies the defaults", () => {
    for (const limit of [0, 201, 1.5, -1]) expect(parse({ ...BASE, limit }), String(limit)).toBe(false);
    expect(parse({ ...BASE, max_response_bytes: 999 })).toBe(false);
    expect(parse({ ...BASE, max_response_bytes: 1_000_001 })).toBe(false);
    expect(canonicalHistoryArgs(BASE)).toEqual({
      ...BASE,
      include_values: true,
      limit: HISTORY_LIMITS.DEFAULT_LIMIT,
      max_response_bytes: HISTORY_LIMITS.DEFAULT_MAX_RESPONSE_BYTES,
    });
  });

  it("takes only cursors this tool could have returned", () => {
    const cursor = encodeTailCursor({ timestamp: "2026-01-01 10:00:00", sysId: rowId("a", 1), filter: "0a1b2c3d" });
    expect(parse({ ...BASE, cursor: { audit: cursor } })).toBe(true);
    expect(parse({ ...BASE, cursor: {} })).toBe(true);
    expect(parse({ ...BASE, cursor: { audit: "x" } })).toBe(false);
    expect(parse({ ...BASE, cursor: cursor })).toBe(false);
    expect(canonicalHistoryArgs({ ...BASE, cursor: { flows: cursor } }).cursor).toEqual({
      flows: { timestamp: "2026-01-01 10:00:00", sysId: rowId("a", 1), filter: "0a1b2c3d" },
    });
  });
});

describe("description and listing", () => {
  it("carries the untrusted-data sentence and says what the property names do not", () => {
    expect(HISTORY_DESCRIPTION).toContain(HISTORY_UNTRUSTED_SENTENCE);
    expect(HISTORY_UNTRUSTED_SENTENCE).toContain("untrusted instance data");
    for (const phrase of ["audit, journal, flows", "YYYY-MM-DD[ hh:mm:ss]", "next_cursor", "record's class", "Business rules and script includes"]) {
      expect(HISTORY_DESCRIPTION, phrase).toContain(phrase);
    }
  });

  it("is listed read-only, with the description", async () => {
    const { client } = await harness(fakeInstance({ records: {} }).ops, { tableAccess: namedPolicy(FULL_TABLES) });
    const tool = (await client.listTools()).tools[0]!;
    expect(tool.name).toBe("sn_history");
    expect(tool.description).toBe(HISTORY_DESCRIPTION);
    expect(tool.annotations).toEqual({
      title: "View record history",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe("model-visible size", () => {
  // Measured as test/filter-examples.test.ts measures it: what a model reads
  // (name, description, input schema) as listed, with the shared profile
  // selector included, and without the output schema.
  const BUDGET = 1_500;

  it("keeps the schema and description at or under 1,500 characters", async () => {
    const { client } = await harness(fakeInstance({ records: {} }).ops, { tableAccess: namedPolicy(FULL_TABLES) });
    const tool = (await client.listTools()).tools[0]!;
    const size = JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length;
    // Recorded, so a change here is made on purpose: every client pays for the entry on every session.
    expect(size).toBe(1_281);
    expect(size).toBeLessThanOrEqual(BUDGET);
    // The whole entry, output schema and shared result envelope included.
    expect(JSON.stringify(tool).length).toBe(5_374);
  });
});

describe("declared tables", () => {
  it("names the sources, the dictionary and the chain, and never a history mirror or another record store", () => {
    expect([...HISTORY_FIXED_TABLES].sort()).toEqual(
      ["sys_audit", "sys_db_object", "sys_dictionary", "sys_flow_context", "sys_journal_field"].sort()
    );
    expect(historyToolModule.requirements.tables).toMatchObject({ kind: "dynamic", names: HISTORY_FIXED_TABLES });
    for (const mirror of ["sys_history_line", "sys_history_set", "sys_audit_delete", "sys_email", "sys_attachment_doc"]) {
      expect(HISTORY_FIXED_TABLES).not.toContain(mirror);
    }
  });

  it("never asks a source for a column that carries content or errors", () => {
    for (const spec of Object.values(HISTORY_SOURCE_SPECS)) {
      const columns = [...spec.keys, spec.user, ...spec.values, ...spec.extras];
      for (const column of ["error_message", "payload", "payload_diff", "reason", "display_value"]) {
        expect(columns, `${spec.table}.${column}`).not.toContain(column);
      }
    }
  });
});

describe("output data schema", () => {
  it("is strict and bounds what a result may hold", () => {
    const ok = { status: "ok", record: BASE, events: [] };
    expect(historyDataSchema.safeParse(ok).success).toBe(true);
    expect(historyDataSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(historyDataSchema.safeParse({ ...ok, record: { ...BASE, sys_id: "x" } }).success).toBe(false);
    const event = { time: "2026-01-01 10:00:00", source: "audit" };
    expect(historyDataSchema.safeParse({ ...ok, events: [event] }).success).toBe(true);
    expect(historyDataSchema.safeParse({ ...ok, events: [{ ...event, error_message: "x" }] }).success).toBe(false);
    expect(historyDataSchema.safeParse({ ...ok, events: [{ ...event, new: "x".repeat(2_001) }] }).success).toBe(false);
    expect(historyDataSchema.safeParse({ ...ok, events: Array.from({ length: 201 }, () => event) }).success).toBe(false);
    expect(historyDataSchema.safeParse({ ...ok, sources: { history_line: { status: "ok", returned: 0, has_more: false } } }).success).toBe(false);
    expect(historyDataSchema.safeParse({ ...ok, sources: { audit: { status: "maybe", returned: 0, has_more: false } } }).success).toBe(false);
  });
});
