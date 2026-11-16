import { describe, expect, it } from "vitest";

import {
  CHAIN_UNCONFIRMED_WARNING,
  DICTIONARY_UNAVAILABLE_WARNING,
  MAX_HISTORY_DICTIONARY_ROWS,
  WRONG_CLASS_HINT,
} from "../src/tools/history-module.js";
import { HISTORY_LIMITS } from "../src/tools/history-contracts.js";
import { isTailCursor } from "../src/tools/syslog-cursor.js";
import { auditRow, DICTIONARY, flowRow, incidentFixture, journalRow } from "./history-fixtures.js";
import { decodeTailCursor } from "../src/tools/syslog-cursor.js";
import {
  dataOf,
  expectReadsWithin,
  fakeInstance,
  FULL_TABLES,
  harness,
  hiddenTypes,
  ids,
  namedPolicy,
  planFor,
  tableOfCall,
  textOf,
  wildcardPolicy,
  type HistoryFixture,
} from "./history-harness.js";

const FULL = namedPolicy(FULL_TABLES);

async function run(
  fixture: HistoryFixture,
  args: Record<string, unknown>,
  options: Parameters<typeof harness>[1] = { tableAccess: FULL }
) {
  const instance = fakeInstance(fixture);
  const { call } = await harness(instance.ops, options);
  const result = await call(args);
  return { instance, result, call };
}

type Event = Record<string, unknown>;
const eventsOf = (data: Record<string, unknown>) => data.events as Event[];

describe("the record and its class", () => {
  it("reads the incident's history newest first, from all three sources", async () => {
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident });
    const data = dataOf(result);
    expect(data.status).toBe("ok");
    expect(data.record).toEqual({ table: "incident", sys_id: ids.incident });
    expect(data.audit_enabled).toBe(true);
    expect(data.warnings).toBeUndefined();
    expect(data.not_recorded).toEqual(["business_rules", "script_includes"]);
    expect(eventsOf(data).map((event) => [event.time, event.source, event.field ?? null])).toEqual([
      ["2026-01-01 13:00:00", "audit", "u_unlisted"],
      ["2026-01-01 12:00:00", "audit", "u_vault_key"],
      ["2026-01-01 10:30:00", "journal", "comments"],
      ["2026-01-01 10:00:00", "audit", "priority"],
      ["2026-01-01 09:00:00", "flows", null],
    ]);
    expect(eventsOf(data)[3]).toEqual({
      time: "2026-01-01 10:00:00",
      source: "audit",
      field: "priority",
      old: "old 1",
      new: "new 1",
      user: "fake.user.one",
    });
    expect(eventsOf(data)[2]).toEqual({
      time: "2026-01-01 10:30:00",
      source: "journal",
      field: "comments",
      new: "note 1",
      user: "fake.user.two",
    });
    expect(eventsOf(data)[4]).toEqual({
      time: "2026-01-01 09:00:00",
      source: "flows",
      user: "fake.user.three",
      flow: { name: "Fake Flow 1", state: "COMPLETE", test: false },
    });
    expect(data.sources).toEqual({
      audit: { status: "ok", returned: 3, has_more: false },
      journal: { status: "ok", returned: 1, has_more: false },
      flows: { status: "ok", returned: 1, has_more: false },
    });
    expect(data.next_cursor).toBeUndefined();
    expectReadsWithin(instance.calls, planFor({ table: "incident", sys_id: ids.incident }, FULL));
  });

  it("refuses a record whose class is not the table, naming the class, and reads nothing else", async () => {
    const fixture = incidentFixture({ records: { [`task/${ids.incident}`]: "incident" } });
    const tableAccess = namedPolicy(["task", "sys_db_object", "sys_dictionary", "sys_audit", "sys_journal_field", "sys_flow_context"]);
    const { instance, result } = await run(fixture, { table: "task", sys_id: ids.incident }, { tableAccess });
    const data = dataOf(result);
    expect(data).toEqual({ status: "wrong_class", record: { table: "task", sys_id: ids.incident }, hint: WRONG_CLASS_HINT("incident") });
    expect(data.hint).toContain("Call again with table: incident.");
    expect(data.events).toBeUndefined();
    expect(instance.calls.map(tableOfCall)).toEqual(["task"]);
  });

  it("refuses before any read when field policy hides sys_class_name on the table", async () => {
    const fieldPolicy = { fieldPolicy: { incident: { readable: ["sys_id", "number", "priority"] } } };
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident }, { tableAccess: FULL, fieldPolicy });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("denied by policy");
    expect(instance.calls).toEqual([]);
  });

  it("answers not_found alike for a missing record and one the instance refuses", async () => {
    const fixture = incidentFixture({ records: { [`incident/${ids.otherIncident}`]: "forbidden" } });
    const missing = await run(fixture, { table: "incident", sys_id: ids.incident });
    const refused = await run(fixture, { table: "incident", sys_id: ids.otherIncident });
    for (const { result, instance } of [missing, refused]) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/not_found|not found/iu);
      expect(instance.calls.map(tableOfCall)).toEqual(["incident"]);
    }
    expect(textOf(missing.result).replace(/history-\d+/u, "")).toBe(textOf(refused.result).replace(/history-\d+/u, ""));
  });

  it("takes the table as the class when the record has no class column", async () => {
    const fixture: HistoryFixture = {
      records: { [`u_fake_queue/${ids.queueConfig}`]: "" },
      dictionary: DICTIONARY,
      audit: [auditRow(1, "2026-02-01 08:00:00", "work_notes", { tablename: "u_fake_queue", documentkey: ids.queueConfig })],
      journal: [],
      flows: [],
    };
    const tableAccess = namedPolicy(["u_fake_queue", "sys_db_object", "sys_dictionary", "sys_audit", "sys_journal_field", "sys_flow_context"]);
    const { result } = await run(fixture, { table: "u_fake_queue", sys_id: ids.queueConfig }, { tableAccess });
    expect(eventsOf(dataOf(result))).toHaveLength(1);
  });
});

describe("journal fields in the audit log", () => {
  it("drops an audit row for a journal field defined up the chain (incident.work_notes on task)", async () => {
    const { result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident });
    const data = dataOf(result);
    expect(eventsOf(data).some((event) => event.source === "audit" && event.field === "work_notes")).toBe(false);
    expect(JSON.stringify(data)).not.toContain("journal text in the audit log");
    // Dropped by type, not counted: the journal source is where that text lives.
    expect(data.omitted).toEqual({ unreadable: 0, mismatch: 0 });
  });

  it("keeps a non-journal field that happens to be called work_notes, with its values", async () => {
    const fixture: HistoryFixture = {
      records: { [`u_fake_queue/${ids.queueConfig}`]: "u_fake_queue" },
      dictionary: DICTIONARY,
      audit: [auditRow(1, "2026-02-01 08:00:00", "work_notes", { tablename: "u_fake_queue", documentkey: ids.queueConfig })],
      journal: [],
      flows: [],
    };
    const tableAccess = namedPolicy(["u_fake_queue", "sys_db_object", "sys_dictionary", "sys_audit", "sys_journal_field", "sys_flow_context"]);
    const { result } = await run(fixture, { table: "u_fake_queue", sys_id: ids.queueConfig }, { tableAccess });
    expect(eventsOf(dataOf(result))).toEqual([
      { time: "2026-02-01 08:00:00", source: "audit", field: "work_notes", old: "old 1", new: "new 1", user: "fake.user.one" },
    ]);
  });

  it("drops journal audit rows even when the journal source is not granted", async () => {
    const tableAccess = namedPolicy(["incident", "sys_db_object", "sys_dictionary", "sys_audit", "sys_flow_context"]);
    const { result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident }, { tableAccess });
    const data = dataOf(result);
    expect(JSON.stringify(data)).not.toContain("journal text in the audit log");
    expect((data.sources as Record<string, unknown>).journal).toEqual({ status: "not_granted", returned: 0, has_more: false });
  });
});

describe("values by type and table (the shared helper)", () => {
  it("withholds a password2-typed value and a value whose field has no dictionary row", async () => {
    const { result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident });
    const data = dataOf(result);
    const byField = new Map(eventsOf(data).filter((event) => event.source === "audit").map((event) => [event.field, event]));
    expect(byField.get("u_vault_key")).toEqual({
      time: "2026-01-01 12:00:00", source: "audit", field: "u_vault_key", user: "fake.user.one", value_hidden: true,
    });
    expect(byField.get("u_unlisted")).toMatchObject({ value_hidden: true });
    expect(byField.get("u_unlisted")).not.toHaveProperty("old");
    expect(JSON.stringify(data)).not.toContain("fake-cipher");
  });

  it("gives no values at all when the dictionary cannot be read (the unavailable state)", async () => {
    const { result } = await run(incidentFixture({ dictionary: "forbidden" }), { table: "incident", sys_id: ids.incident });
    const data = dataOf(result);
    expect(data.audit_enabled).toBeNull();
    expect(data.warnings).toEqual([DICTIONARY_UNAVAILABLE_WARNING]);
    for (const event of eventsOf(data)) {
      expect(event).not.toHaveProperty("old");
      expect(event).not.toHaveProperty("new");
      if (event.source !== "flows") expect(event.value_hidden).toBe(true);
    }
    // Journal fields cannot be told apart without types, so that audit row stays, with no value.
    expect(eventsOf(data).find((event) => event.field === "work_notes")).toMatchObject({ value_hidden: true });
  });

  it("gives no values, and reads no dictionary, when the profile may not read sys_dictionary", async () => {
    const tableAccess = namedPolicy(["incident", "sys_audit", "sys_journal_field", "sys_flow_context"]);
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident }, { tableAccess });
    const data = dataOf(result);
    expect(data.warnings).toEqual([DICTIONARY_UNAVAILABLE_WARNING]);
    expect(JSON.stringify(eventsOf(data))).not.toMatch(/"(?:old|new)"/u);
    expect(instance.calls.map(tableOfCall)).not.toContain("sys_dictionary");
    expectReadsWithin(instance.calls, planFor({ table: "incident", sys_id: ids.incident }, tableAccess));
  });

  it("treats a full dictionary page as unavailable", async () => {
    const many = Array.from({ length: MAX_HISTORY_DICTIONARY_ROWS }, (_, n) => ({
      name: "incident", element: `u_f${n}`, internal_type: "string", audit: "false",
    }));
    const { result } = await run(incidentFixture({ dictionary: [...DICTIONARY, ...many] }), { table: "incident", sys_id: ids.incident });
    expect(dataOf(result).warnings).toEqual([DICTIONARY_UNAVAILABLE_WARNING]);
  });

  it("withholds every value on a credential table", async () => {
    const fixture: HistoryFixture = {
      records: { [`sys_properties/${ids.property}`]: "" },
      dictionary: DICTIONARY,
      audit: [auditRow(1, "2026-03-01 08:00:00", "value", { tablename: "sys_properties", documentkey: ids.property, oldvalue: "fake-old-secret", newvalue: "fake-new-secret" })],
      journal: [],
      flows: [],
    };
    const tableAccess = namedPolicy(["sys_properties", "sys_db_object", "sys_dictionary", "sys_audit", "sys_journal_field", "sys_flow_context"]);
    const { result } = await run(fixture, { table: "sys_properties", sys_id: ids.property }, { tableAccess });
    const data = dataOf(result);
    expect(eventsOf(data)).toEqual([
      { time: "2026-03-01 08:00:00", source: "audit", field: "value", user: "fake.user.one", value_hidden: true },
    ]);
    expect(JSON.stringify(data)).not.toContain("fake-new-secret");
  });

  it("drops the whole row of a field the call's type scope hides, unnamed", async () => {
    const fieldTypeLoader = hiddenTypes([{ table: "incident", element: "u_sealed", internal_type: "password" }]);
    const fixture = incidentFixture({ audit: [auditRow(1, "2026-01-01 10:00:00", "u_sealed", { newvalue: "fake-hash" })] });
    const { result } = await run(fixture, { table: "incident", sys_id: ids.incident }, { tableAccess: FULL, fieldTypeLoader });
    const data = dataOf(result);
    expect(eventsOf(data).filter((event) => event.source === "audit")).toEqual([]);
    expect(data.omitted).toEqual({ unreadable: 1, mismatch: 0 });
    expect(JSON.stringify(data)).not.toContain("u_sealed");
  });

  it("drops rows for fields field policy hides or names as sensitive, unnamed", async () => {
    const fixture = incidentFixture({
      audit: [
        auditRow(1, "2026-01-01 10:00:00", "priority"),
        auditRow(2, "2026-01-01 10:01:00", "u_api_token", { newvalue: "fake-token" }),
        auditRow(3, "2026-01-01 10:02:00", "state"),
      ],
    });
    const fieldPolicy = { fieldPolicy: { incident: { readable: ["sys_id", "sys_class_name", "priority", "u_api_token"] } } };
    const { result } = await run(fixture, { table: "incident", sys_id: ids.incident, sources: ["audit"] }, { tableAccess: FULL, fieldPolicy });
    const data = dataOf(result);
    expect(eventsOf(data).map((event) => event.field)).toEqual(["priority"]);
    expect(data.omitted).toEqual({ unreadable: 2, mismatch: 0 });
    expect(JSON.stringify(data)).not.toMatch(/u_api_token|fake-token|"state"/u);
  });

  it("cuts a long value at 2,000 characters and says so", async () => {
    const long = "x".repeat(HISTORY_LIMITS.MAX_VALUE_CHARS + 50);
    const fixture = incidentFixture({ audit: [auditRow(1, "2026-01-01 10:00:00", "short_description", { newvalue: long })] });
    const { result } = await run(fixture, { table: "incident", sys_id: ids.incident, sources: ["audit"] });
    const [event] = eventsOf(dataOf(result));
    expect((event!.new as string).length).toBe(HISTORY_LIMITS.MAX_VALUE_CHARS);
    expect(event!.value_truncated).toBe(true);
  });

  it("requests no value column when include_values is false", async () => {
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident, include_values: false });
    for (const event of eventsOf(dataOf(result))) {
      expect(event).not.toHaveProperty("old");
      expect(event).not.toHaveProperty("new");
      expect(event).not.toHaveProperty("value_hidden");
    }
    for (const call of instance.calls) {
      expect(call.params.sysparm_fields ?? "").not.toMatch(/oldvalue|newvalue|(?:^|,)value(?:,|$)/u);
    }
  });
});

describe("the post-filter on record keys", () => {
  it("drops a row about another record even when the instance returns it", async () => {
    const fixture = incidentFixture({
      audit: [
        auditRow(1, "2026-01-01 10:00:00", "priority"),
        auditRow(2, "2026-01-01 10:05:00", "priority", { documentkey: ids.otherIncident, newvalue: "other record" }),
        auditRow(3, "2026-01-01 10:06:00", "priority", { tablename: "task", newvalue: "other class" }),
      ],
      journal: [journalRow(1, "2026-01-01 10:07:00", "comments", { element_id: ids.otherIncident, value: "other note" })],
      flows: [flowRow(1, "2026-01-01 10:08:00", { source_record: ids.otherIncident })],
      ignoreRecordFilter: ["sys_audit", "sys_journal_field", "sys_flow_context"],
    });
    const { result } = await run(fixture, { table: "incident", sys_id: ids.incident });
    const data = dataOf(result);
    expect(eventsOf(data).map((event) => event.time)).toEqual(["2026-01-01 10:00:00"]);
    expect(data.omitted).toEqual({ unreadable: 0, mismatch: 4 });
    expect(JSON.stringify(data)).not.toMatch(/other (?:record|class|note)|Fake Flow/u);
  });
});

describe("sources the profile cannot read", () => {
  it('reports the named-only audit and journal tables as not_granted under "*", without failing', async () => {
    const tableAccess = wildcardPolicy();
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident }, { tableAccess });
    const data = dataOf(result);
    expect(data.sources).toEqual({
      audit: { status: "not_granted", returned: 0, has_more: false },
      journal: { status: "not_granted", returned: 0, has_more: false },
      flows: { status: "ok", returned: 1, has_more: false },
    });
    expect(instance.calls.map(tableOfCall)).not.toContain("sys_audit");
    expect(instance.calls.map(tableOfCall)).not.toContain("sys_journal_field");
    expectReadsWithin(instance.calls, planFor({ table: "incident", sys_id: ids.incident }, tableAccess));
  });

  it("reads the audit and journal tables once they are named", async () => {
    const tableAccess = wildcardPolicy(["sys_audit", "sys_journal_field"]);
    const { result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident }, { tableAccess });
    const sources = dataOf(result).sources as Record<string, { status: string }>;
    expect([sources.audit!.status, sources.journal!.status, sources.flows!.status]).toEqual(["ok", "ok", "ok"]);
  });

  it("reports a target bound to other tools as not_granted", async () => {
    const tableAccess = namedPolicy(FULL_TABLES, { boundTo: { sys_journal_field: ["sn_query"] } });
    const { result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident }, { tableAccess });
    expect((dataOf(result).sources as Record<string, { status: string }>).journal!.status).toBe("not_granted");
  });

  it('reports a source whose key columns a narrowing "*" hides as not_granted, without failing', async () => {
    const fieldPolicy = {
      fieldPolicy: {
        "*": { readable: ["sys_id", "name", "sys_created_on", "sys_class_name", "priority"] },
        sys_flow_context: { readable: ["sys_id", "source_table", "source_record", "sys_created_on", "name", "state"] },
      },
    };
    const args = { table: "incident", sys_id: ids.incident };
    const { instance, result } = await run(incidentFixture(), args, { tableAccess: FULL, fieldPolicy });
    const data = dataOf(result);
    expect(data.sources).toEqual({
      audit: { status: "not_granted", returned: 0, has_more: false },
      journal: { status: "not_granted", returned: 0, has_more: false },
      flows: { status: "ok", returned: 1, has_more: false },
    });
    // The narrowing "*" also hides the dictionary columns: no values, and the
    // flow's user and test flag are simply not requested.
    expect(data.warnings).toEqual([DICTIONARY_UNAVAILABLE_WARNING]);
    expect(eventsOf(data)).toEqual([
      { time: "2026-01-01 09:00:00", source: "flows", flow: { name: "Fake Flow 1", state: "COMPLETE" } },
    ]);
    expectReadsWithin(instance.calls, planFor(args, FULL, fieldPolicy));
    for (const call of instance.calls) expect(call.params.sysparm_fields ?? "").not.toContain("error_message");
  });

  it("fails when a source named in sources is refused", async () => {
    const tableAccess = wildcardPolicy();
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident, sources: ["audit", "flows"] }, { tableAccess });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("denied by policy");
    expect(textOf(result)).toContain("sys_audit");
    expect(instance.calls).toEqual([]);
  });

  it("fails when no source is left", async () => {
    const tableAccess = namedPolicy(["incident", "sys_db_object", "sys_dictionary"]);
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident }, { tableAccess });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("denied by policy");
    expect(instance.calls).toEqual([]);
  });

  it("reports a source the instance refuses as denied, and one it does not have as unavailable", async () => {
    const { result } = await run(incidentFixture({ audit: "forbidden", flows: "missing" }), { table: "incident", sys_id: ids.incident });
    const data = dataOf(result);
    expect(data.sources).toEqual({
      audit: { status: "denied", returned: 0, has_more: false },
      journal: { status: "ok", returned: 1, has_more: false },
      flows: { status: "unavailable", returned: 0, has_more: false },
    });
  });

  it("shows no user names when field policy hides the user columns", async () => {
    const fieldPolicy = {
      fieldPolicy: {
        sys_audit: { readable: ["sys_id", "tablename", "documentkey", "fieldname", "oldvalue", "newvalue", "sys_created_on"] },
      },
    };
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident, sources: ["audit"] }, { tableAccess: FULL, fieldPolicy });
    for (const event of eventsOf(dataOf(result))) expect(event).not.toHaveProperty("user");
    const auditRead = instance.calls.find((call) => tableOfCall(call) === "sys_audit")!;
    expect(auditRead.params.sysparm_fields!.split(",")).not.toContain("user");
  });

  it("says so when field policy hides the audit value columns", async () => {
    const fieldPolicy = {
      fieldPolicy: { sys_audit: { readable: ["sys_id", "tablename", "documentkey", "fieldname", "user", "sys_created_on"] } },
    };
    const { result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident, sources: ["audit"] }, { tableAccess: FULL, fieldPolicy });
    const data = dataOf(result);
    expect(data.warnings).toEqual(["Field policy hides the audit value columns, so no audit values are shown."]);
    for (const event of eventsOf(data)) expect(event.value_hidden).toBe(true);
  });
});

describe("columns that carry other records' content", () => {
  const fixture: HistoryFixture = {
    records: { [`sys_update_xml/${ids.update}`]: "" },
    dictionary: DICTIONARY,
    audit: [
      auditRow(1, "2026-04-01 08:00:00", "payload", { tablename: "sys_update_xml", documentkey: ids.update, newvalue: "<record_update/>" }),
      auditRow(2, "2026-04-01 08:01:00", "name", { tablename: "sys_update_xml", documentkey: ids.update }),
    ],
    journal: [],
    flows: [],
  };
  const tableAccess = namedPolicy(["sys_update_xml", "sys_db_object", "sys_dictionary", "sys_audit", "sys_journal_field", "sys_flow_context"]);
  const opened = { fieldPolicy: { sys_update_xml: { readable: ["sys_id", "sys_class_name", "name", "payload"] } } };

  it("drops their audit rows, even where the profile opened the column", async () => {
    for (const fieldPolicy of [undefined, opened]) {
      const { instance, result } = await run(fixture, { table: "sys_update_xml", sys_id: ids.update }, { tableAccess, ...(fieldPolicy === undefined ? {} : { fieldPolicy }) });
      const data = dataOf(result);
      expect(eventsOf(data).map((event) => event.field)).toEqual(["name"]);
      expect(JSON.stringify(data)).not.toContain("record_update");
      for (const call of instance.calls) expect(call.params.sysparm_fields ?? "").not.toMatch(/payload/u);
    }
  });

  it("refuses them in fields", async () => {
    for (const fieldPolicy of [undefined, opened]) {
      const { instance, result } = await run(fixture, { table: "sys_update_xml", sys_id: ids.update, fields: ["payload"] }, { tableAccess, ...(fieldPolicy === undefined ? {} : { fieldPolicy }) });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("denied by policy");
      expect(instance.calls).toEqual([]);
    }
  });
});

describe("fields, since and until", () => {
  it("narrows the audit and journal reads to the named fields and the window", async () => {
    const { instance, result } = await run(incidentFixture(), {
      table: "incident", sys_id: ids.incident, fields: ["Priority", "comments"], since: "2026-01-01", until: "2026-01-01 10:30:00",
    });
    const data = dataOf(result);
    expect(eventsOf(data).map((event) => event.field ?? event.source)).toEqual(["comments", "priority", "flows"]);
    const audit = instance.calls.find((call) => tableOfCall(call) === "sys_audit")!;
    expect(audit.params.sysparm_query).toBe(
      `tablename=incident^documentkey=${ids.incident}^fieldnameINcomments,priority` +
        "^fieldnameNOT INcomments,comments_and_work_notes,work_notes" +
        "^sys_created_on>=2026-01-01 00:00:00^sys_created_on<=2026-01-01 10:30:00" +
        "^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id"
    );
    const flows = instance.calls.find((call) => tableOfCall(call) === "sys_flow_context")!;
    expect(flows.params.sysparm_query).not.toContain("IN");
  });

  it("refuses a field the profile may not read before any read", async () => {
    const fieldPolicy = { fieldPolicy: { incident: { readable: ["sys_id", "sys_class_name", "priority"] } } };
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident, fields: ["state"] }, { tableAccess: FULL, fieldPolicy });
    expect(result.isError).toBe(true);
    expect(instance.calls).toEqual([]);
  });

  it("refuses a window that ends before it starts", async () => {
    const { instance, result } = await run(incidentFixture(), { table: "incident", sys_id: ids.incident, since: "2026-02-01", until: "2026-01-01" });
    expect(result.isError).toBe(true);
    expect(instance.calls).toEqual([]);
  });
});

describe("max_response_bytes", () => {
  it("keeps the newest events that fit and pages the rest by cursor", async () => {
    const big = "y".repeat(1_900);
    const rows = Array.from({ length: 10 }, (_, n) => auditRow(n + 1, `2026-01-02 10:00:0${n}`, "short_description", { newvalue: big }));
    const fixture = incidentFixture({ audit: rows, journal: [], flows: [] });
    const args = { table: "incident", sys_id: ids.incident, max_response_bytes: 9_000 };
    const instance = fakeInstance(fixture);
    const { call } = await harness(instance.ops, { tableAccess: FULL });
    const seen: string[] = [];
    let cursor: unknown;
    for (let page = 0; page < 10; page += 1) {
      const data = dataOf(await call({ ...args, ...(cursor === undefined ? {} : { cursor }) }));
      expect(JSON.stringify(data).length).toBeLessThan(9_000);
      seen.push(...eventsOf(data).map((event) => event.time as string));
      cursor = data.next_cursor;
      if (cursor === undefined) break;
      expect(data.warnings).toContain("Fewer events than limit fit max_response_bytes; the rest follow with next_cursor.");
    }
    expect(seen).toEqual(rows.map((row) => row.sys_created_on).reverse());
  });

  it("holds a large request to the envelope's limit, with cursors intact", async () => {
    const big = "z".repeat(1_900);
    const rows = Array.from({ length: 200 }, (_, n) =>
      auditRow(n + 1, `2026-01-03 10:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`, "short_description", { oldvalue: big, newvalue: big })
    );
    const { result } = await run(incidentFixture({ audit: rows, journal: [], flows: [] }), {
      table: "incident", sys_id: ids.incident, sources: ["audit"], limit: 200, max_response_bytes: 1_000_000,
    });
    const data = dataOf(result);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(100_000);
    expect(eventsOf(data).length).toBeGreaterThan(10);
    expect(eventsOf(data).length).toBeLessThan(200);
    expect(eventsOf(data).every((event) => event.old === big && event.new === big)).toBe(true);
    expect(isTailCursor((data.next_cursor as Record<string, string>).audit)).toBe(true);
  });
});

describe("an extension chain that cannot be read in full", () => {
  // A custom table extending a credential table. Its own field is a plain
  // string, so only the credential-table rule withholds its value.
  const dictionary = [
    ...DICTIONARY,
    { name: "oauth_entity", element: "", internal_type: "collection", audit: "false" },
    { name: "oauth_entity", element: "sys_id", internal_type: "GUID", audit: "false" },
    { name: "u_fake_client", element: "", internal_type: "collection", audit: "true" },
    { name: "u_fake_client", element: "u_label", internal_type: "string", audit: "false" },
  ];
  const fixture = (parents: Record<string, string[]>): HistoryFixture => ({
    records: { [`u_fake_client/${ids.property}`]: "u_fake_client" },
    parents,
    dictionary,
    audit: [auditRow(1, "2026-03-01 08:00:00", "u_label", { tablename: "u_fake_client", documentkey: ids.property, newvalue: "fake-label-value" })],
    journal: [],
    flows: [],
  });
  const tableAccess = namedPolicy(["u_fake_client", "sys_db_object", "sys_dictionary", "sys_audit", "sys_journal_field", "sys_flow_context"]);
  const args = { table: "u_fake_client", sys_id: ids.property };

  it("withholds values when the chain reaches the credential table", async () => {
    const { result } = await run(fixture({ u_fake_client: ["oauth_entity"] }), args, { tableAccess });
    const data = dataOf(result);
    expect(eventsOf(data)).toEqual([
      { time: "2026-03-01 08:00:00", source: "audit", field: "u_label", user: "fake.user.one", value_hidden: true },
    ]);
    expect(data.warnings).toBeUndefined();
  });

  it("withholds values, with a warning, when the chain stops before the table that defines sys_id", async () => {
    const { result } = await run(fixture({}), args, { tableAccess });
    const data = dataOf(result);
    expect(eventsOf(data)).toEqual([
      { time: "2026-03-01 08:00:00", source: "audit", field: "u_label", user: "fake.user.one", value_hidden: true },
    ]);
    expect(data.warnings).toEqual([CHAIN_UNCONFIRMED_WARNING]);
    expect(JSON.stringify(data)).not.toContain("fake-label-value");
  });
});

describe("journal fields for a profile without the journal source", () => {
  const audit = [
    auditRow(1, "2026-01-01 10:00:00", "priority"),
    auditRow(2, "2026-01-01 11:00:00", "work_notes"),
    auditRow(3, "2026-01-01 12:00:00", "comments"),
    auditRow(4, "2026-01-01 13:00:00", "comments_and_work_notes"),
  ];
  const journalTimes = new Set(audit.slice(1).map((row) => row.sys_created_on));
  const tableAccess = namedPolicy(["incident", "sys_db_object", "sys_dictionary", "sys_audit", "sys_flow_context"]);

  for (const [name, dictionary] of [
    ["with field types", DICTIONARY],
    ["without field types", "forbidden"],
  ] as const) {
    it(`pages straight to the other changes, ${name}`, async () => {
      const instance = fakeInstance(incidentFixture({ audit, journal: [], flows: [], dictionary }));
      const { call } = await harness(instance.ops, { tableAccess });
      const pages: Record<string, unknown>[] = [];
      let cursor: unknown;
      do {
        const data = dataOf(await call({ table: "incident", sys_id: ids.incident, limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
        pages.push(data);
        cursor = data.next_cursor;
      } while (cursor !== undefined && pages.length < 10);
      expect(pages).toHaveLength(1);
      expect(eventsOf(pages[0]!).map((event) => event.field)).toEqual(["priority"]);
      expect((pages[0]!.sources as Record<string, unknown>).audit).toEqual({ status: "ok", returned: 1, has_more: false });
      expect(pages[0]!.omitted).toEqual({ unreadable: 0, mismatch: 0 });
      for (const page of pages) {
        for (const token of Object.values((page.next_cursor ?? {}) as Record<string, string>)) {
          expect(journalTimes.has(decodeTailCursor(token)!.timestamp)).toBe(false);
        }
      }
      const auditRead = instance.calls.find((call) => tableOfCall(call) === "sys_audit")!;
      expect(auditRead.params.sysparm_query).toContain("^fieldnameNOT INcomments,comments_and_work_notes,work_notes");
    });
  }

  it("leaves no journal field out by name when the call reads the journal source and has no types", async () => {
    const instance = fakeInstance(incidentFixture({ audit, dictionary: "forbidden" }));
    const { call } = await harness(instance.ops, { tableAccess: FULL });
    const data = dataOf(await call({ table: "incident", sys_id: ids.incident }));
    expect(eventsOf(data).filter((event) => event.source === "audit").map((event) => event.field)).toEqual([
      "comments_and_work_notes", "comments", "work_notes", "priority",
    ]);
    const auditRead = instance.calls.find((call) => tableOfCall(call) === "sys_audit")!;
    expect(auditRead.params.sysparm_query).not.toContain("NOT IN");
  });

  for (const [name, dictionary] of [
    ["with field types", DICTIONARY],
    ["without field types", "forbidden"],
  ] as const) {
    it(`drops a journal row the instance returns despite the query, ${name}`, async () => {
      const instance = fakeInstance(incidentFixture({ audit, journal: [], flows: [], dictionary, ignoreExclusions: true }));
      const { call } = await harness(instance.ops, { tableAccess });
      const data = dataOf(await call({ table: "incident", sys_id: ids.incident }));
      expect(eventsOf(data).map((event) => event.field)).toEqual(["priority"]);
      expect(data.omitted).toEqual({ unreadable: 0, mismatch: 0 });
    });
  }
});
