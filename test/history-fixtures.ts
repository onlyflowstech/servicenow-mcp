/**
 * Synthetic history rows for the `sn_history` tests: an incident (class
 * `incident`, extending `task`), a plain table with a non-journal
 * `work_notes`, and a credential table record. Every value is fake.
 *
 * Not a test file.
 */

import { ids, rowId, type HistoryFixture, type Row } from "./history-harness.js";

export function auditRow(n: number, time: string, field: string, extra: Partial<Row> = {}): Row {
  return {
    sys_id: rowId("a", n),
    tablename: "incident",
    documentkey: ids.incident,
    fieldname: field,
    oldvalue: `old ${n}`,
    newvalue: `new ${n}`,
    user: "fake.user.one",
    sys_created_on: time,
    ...extra,
  };
}

export function journalRow(n: number, time: string, element: string, extra: Partial<Row> = {}): Row {
  return {
    sys_id: rowId("b", n),
    name: "incident",
    element_id: ids.incident,
    element,
    value: `note ${n}`,
    sys_created_by: "fake.user.two",
    sys_created_on: time,
    ...extra,
  };
}

export function flowRow(n: number, time: string, extra: Partial<Row> = {}): Row {
  return {
    sys_id: rowId("c", n),
    source_table: "incident",
    source_record: ids.incident,
    name: `Fake Flow ${n}`,
    state: "COMPLETE",
    is_test_run: "false",
    sys_created_by: "fake.user.three",
    error_message: "never read",
    sys_created_on: time,
    ...extra,
  };
}

/** Dictionary rows: `task` defines the journal fields; `incident` adds its own. */
export const DICTIONARY: Row[] = [
  { name: "task", element: "", internal_type: "collection", audit: "false" },
  { name: "task", element: "sys_id", internal_type: "GUID", audit: "false" },
  { name: "task", element: "work_notes", internal_type: "journal_input", audit: "false" },
  { name: "task", element: "comments", internal_type: "journal_input", audit: "false" },
  { name: "task", element: "comments_and_work_notes", internal_type: "journal_list", audit: "false" },
  { name: "task", element: "short_description", internal_type: "string", audit: "false" },
  { name: "task", element: "priority", internal_type: "integer", audit: "false" },
  { name: "task", element: "state", internal_type: "integer", audit: "false" },
  { name: "task", element: "assigned_to", internal_type: "reference", audit: "false" },
  { name: "incident", element: "", internal_type: "collection", audit: "true" },
  { name: "incident", element: "u_vault_key", internal_type: "password2", audit: "false" },
  { name: "incident", element: "u_sealed", internal_type: "string", audit: "false" },
  { name: "u_fake_queue", element: "", internal_type: "collection", audit: "true" },
  { name: "u_fake_queue", element: "sys_id", internal_type: "GUID", audit: "false" },
  { name: "u_fake_queue", element: "work_notes", internal_type: "string", audit: "false" },
  { name: "sys_properties", element: "", internal_type: "collection", audit: "true" },
  { name: "sys_properties", element: "sys_id", internal_type: "GUID", audit: "false" },
  { name: "sys_properties", element: "value", internal_type: "string", audit: "false" },
  { name: "sys_update_xml", element: "", internal_type: "collection", audit: "true" },
  { name: "sys_update_xml", element: "sys_id", internal_type: "GUID", audit: "false" },
  { name: "sys_update_xml", element: "payload", internal_type: "xml", audit: "false" },
  { name: "sys_update_xml", element: "name", internal_type: "string", audit: "false" },
];

/** One incident with a little of everything. */
export function incidentFixture(overrides: Partial<HistoryFixture> = {}): HistoryFixture {
  return {
    records: { [`incident/${ids.incident}`]: "incident", [`incident/${ids.otherIncident}`]: "incident" },
    parents: { incident: ["task"] },
    dictionary: DICTIONARY,
    audit: [
      auditRow(1, "2026-01-01 10:00:00", "priority"),
      auditRow(2, "2026-01-01 11:00:00", "work_notes", { oldvalue: "", newvalue: "journal text in the audit log" }),
      auditRow(3, "2026-01-01 12:00:00", "u_vault_key", { oldvalue: "fake-cipher-old", newvalue: "fake-cipher-new" }),
      auditRow(4, "2026-01-01 13:00:00", "u_unlisted", { oldvalue: "x", newvalue: "y" }),
    ],
    journal: [journalRow(1, "2026-01-01 10:30:00", "comments")],
    flows: [flowRow(1, "2026-01-01 09:00:00")],
    ...overrides,
  };
}
