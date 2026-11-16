/**
 * The recording-client test: the handler is not held to its plan at run
 * time, so every upstream read it makes, in every scenario below, is checked
 * against the plan the dispatcher authorized for that call.
 */

import { describe, expect, it } from "vitest";

import { runWithFieldPolicyConfiguration } from "../src/field-policy.js";
import { createTableAccessPolicy, type TableAccessPolicy } from "../src/table-policy.js";
import { canonicalHistoryArgs } from "../src/tools/history-contracts.js";
import { historyAccessPlan } from "../src/tools/history-module.js";
import { auditRow, incidentFixture } from "./history-fixtures.js";
import {
  dataOf,
  expectReadsWithin,
  fakeInstance,
  FULL_TABLES,
  harness,
  ids,
  namedPolicy,
  planFor,
  tableOfCall,
  wildcardPolicy,
  type HistoryFixture,
} from "./history-harness.js";

const BASE = { table: "incident", sys_id: ids.incident } as const;

interface Scenario {
  readonly name: string;
  readonly tableAccess: TableAccessPolicy;
  readonly fieldPolicy?: { fieldPolicy: unknown };
  readonly fixture?: HistoryFixture;
  readonly args?: Record<string, unknown>;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "every table named", tableAccess: namedPolicy(FULL_TABLES) },
  { name: '"*" alone', tableAccess: wildcardPolicy() },
  { name: '"*" with the named-only tables', tableAccess: wildcardPolicy(["sys_audit", "sys_journal_field"]) },
  { name: "no dictionary grant", tableAccess: namedPolicy(["incident", "sys_audit", "sys_journal_field", "sys_flow_context"]) },
  { name: "dictionary refused upstream", tableAccess: namedPolicy(FULL_TABLES), fixture: incidentFixture({ dictionary: "forbidden" }) },
  { name: "audit only", tableAccess: namedPolicy(FULL_TABLES), args: { sources: ["audit"] } },
  { name: "fields and a window", tableAccess: namedPolicy(FULL_TABLES), args: { fields: ["priority"], since: "2026-01-01", until: "2026-12-31" } },
  { name: "no values", tableAccess: namedPolicy(FULL_TABLES), args: { include_values: false } },
  {
    name: 'a narrowing "*" field entry',
    tableAccess: namedPolicy(FULL_TABLES),
    fieldPolicy: { fieldPolicy: { "*": { readable: ["sys_id", "name", "sys_created_on", "sys_class_name", "source_table", "source_record"] } } },
  },
  {
    name: "the wrong class",
    tableAccess: namedPolicy(["task", ...FULL_TABLES]),
    fixture: incidentFixture({ records: { [`task/${ids.incident}`]: "incident" } }),
    args: { table: "task" },
  },
  {
    name: "a source refused upstream and one missing",
    tableAccess: namedPolicy(FULL_TABLES),
    fixture: incidentFixture({ journal: "forbidden", flows: "missing" }),
  },
];

describe("every upstream read is in the resolved access plan", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const instance = fakeInstance(scenario.fixture ?? incidentFixture());
      const { call } = await harness(instance.ops, {
        tableAccess: scenario.tableAccess,
        ...(scenario.fieldPolicy === undefined ? {} : { fieldPolicy: scenario.fieldPolicy }),
      });
      const args = { ...BASE, ...scenario.args };
      const result = await call(args);
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(instance.calls.length).toBeGreaterThan(0);
      expectReadsWithin(instance.calls, planFor(args, scenario.tableAccess, scenario.fieldPolicy));
    });
  }

  it("on every page of a paged history", async () => {
    const audit = Array.from({ length: 12 }, (_, n) => auditRow(n + 1, `2026-06-01 09:00:${String(n).padStart(2, "0")}`, "priority"));
    const instance = fakeInstance(incidentFixture({ audit }));
    const tableAccess = namedPolicy(FULL_TABLES);
    const { call } = await harness(instance.ops, { tableAccess });
    let cursor: unknown;
    let pages = 0;
    do {
      const data = dataOf(await call({ ...BASE, limit: 4, ...(cursor === undefined ? {} : { cursor }) }));
      cursor = data.next_cursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBeGreaterThan(2);
    expectReadsWithin(instance.calls, planFor(BASE, tableAccess));
  });
});

describe("the plan", () => {
  const plan = (args: Record<string, unknown>, tableAccess: TableAccessPolicy, fieldPolicy?: unknown) =>
    runWithFieldPolicyConfiguration(fieldPolicy === undefined ? undefined : { fieldPolicy }, () =>
      historyAccessPlan(canonicalHistoryArgs({ ...BASE, ...args }), tableAccess)
    );

  it("reads the record's table, the chain and dictionary, and each granted source", () => {
    expect(plan({}, namedPolicy(FULL_TABLES)).requests.map((request) => request.table)).toEqual([
      "incident", "sys_db_object", "sys_dictionary", "sys_audit", "sys_journal_field", "sys_flow_context",
    ]);
  });

  it('leaves out a source "*" does not reach, and the dictionary when it is not granted', () => {
    const narrowed = plan({}, createTableAccessPolicy({
      readTables: ["incident", "sys_flow_context"],
      writeTables: [],
      targets: ["incident", "sys_flow_context"].map((table) => ({
        table, kind: "canonical" as const, tools: ["sn_history"], closureComplete: true as const, relatedTables: [table],
      })),
    }));
    expect(narrowed.requests.map((request) => request.table)).toEqual(["incident", "sys_flow_context"]);
    expect(narrowed.dictionary).toBe(false);
    expect(narrowed.sources.map((source) => [source.source, source.granted])).toEqual([
      ["audit", false], ["journal", false], ["flows", true],
    ]);
  });

  it("requests only the columns field policy lets the profile read", () => {
    const sources = plan({}, namedPolicy(FULL_TABLES), {
      sys_audit: { readable: ["sys_id", "tablename", "documentkey", "fieldname", "sys_created_on"] },
      sys_flow_context: { readable: ["sys_id", "source_table", "source_record", "sys_created_on", "state"] },
    }).sources;
    expect(sources.find((source) => source.source === "audit")!.fields).toEqual([
      "sys_id", "tablename", "documentkey", "fieldname", "sys_created_on",
    ]);
    expect(sources.find((source) => source.source === "audit")!.valuesHidden).toBe(true);
    expect(sources.find((source) => source.source === "flows")!.fields).toEqual([
      "sys_id", "source_table", "source_record", "sys_created_on", "state",
    ]);
  });

  it("never plans a read the dispatcher would not authorize", async () => {
    const instance = fakeInstance(incidentFixture());
    const tableAccess = wildcardPolicy();
    const { call } = await harness(instance.ops, { tableAccess });
    dataOf(await call(BASE));
    expect(instance.calls.map(tableOfCall).sort()).toEqual(["incident", "sys_db_object", "sys_dictionary", "sys_flow_context"]);
  });
});
