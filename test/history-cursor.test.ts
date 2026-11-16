import { describe, expect, it } from "vitest";

import { historyCursorFilter, HISTORY_SOURCE_SPECS } from "../src/tools/history-contracts.js";
import { INVALID_CURSOR_HINT, sourceQuery } from "../src/tools/history-module.js";
import { decodeTailCursor, encodeTailCursor } from "../src/tools/syslog-cursor.js";
import { auditRow, flowRow, incidentFixture, journalRow } from "./history-fixtures.js";
import {
  dataOf,
  expectReadsWithin,
  fakeInstance,
  FULL_TABLES,
  harness,
  ids,
  namedPolicy,
  planFor,
  rowId,
  tableOfCall,
  type HistoryFixture,
} from "./history-harness.js";

const FULL = namedPolicy(FULL_TABLES);
const BASE = { table: "incident", sys_id: ids.incident } as const;

type Event = Record<string, unknown>;

/**
 * Many rows, several in the same second and across sources, and some that
 * every page must step over (a journal field in the audit log, a field policy
 * would hide by name).
 */
function busyFixture(): HistoryFixture {
  const audit = [];
  for (let n = 1; n <= 23; n += 1) {
    const second = String(Math.floor(n / 3)).padStart(2, "0");
    const field = n % 7 === 0 ? "work_notes" : n % 5 === 0 ? "u_secret_answer" : "priority";
    audit.push(auditRow(n, `2026-05-01 10:00:${second}`, field));
  }
  const journal = Array.from({ length: 9 }, (_, n) =>
    journalRow(n + 1, `2026-05-01 10:00:${String(Math.floor((n + 1) / 2)).padStart(2, "0")}`, "comments")
  );
  const flows = Array.from({ length: 4 }, (_, n) => flowRow(n + 1, `2026-05-01 10:00:0${n * 2}`));
  return incidentFixture({ audit, journal, flows });
}

/** Every event the full history holds, in order: the oracle for the paging test. */
function key(event: Event): string {
  return `${event.time}|${event.source}|${event.field ?? ""}|${event.new ?? (event.flow as Event | undefined)?.name ?? ""}`;
}

describe("paging by cursor", () => {
  it("returns every event exactly once, newest first, across pages of any size", async () => {
    const fixture = busyFixture();
    const instance = fakeInstance(fixture);
    const { call } = await harness(instance.ops, { tableAccess: FULL });
    const whole = dataOf(await call({ ...BASE, limit: 200 }));
    const expected = (whole.events as Event[]).map(key);
    expect(expected.length).toBeGreaterThan(20);
    expect(whole.next_cursor).toBeUndefined();

    for (const limit of [1, 2, 3, 5, 7]) {
      const seen: string[] = [];
      let cursor: unknown;
      let pages = 0;
      let unreadable = 0;
      do {
        const data = dataOf(await call({ ...BASE, limit, ...(cursor === undefined ? {} : { cursor }) }));
        const events = data.events as Event[];
        expect(events.length).toBeLessThanOrEqual(limit);
        seen.push(...events.map(key));
        unreadable += (data.omitted as { unreadable: number }).unreadable;
        cursor = data.next_cursor;
        pages += 1;
        expect(pages, `limit ${limit}: the pages do not end`).toBeLessThan(100);
      } while (cursor !== undefined);
      expect(seen, `limit ${limit}`).toEqual(expected);
      // Each row a policy hides is stepped over once, on exactly one page.
      expect(unreadable, `limit ${limit}`).toBe((whole.omitted as { unreadable: number }).unreadable);
    }
    expectReadsWithin(instance.calls, planFor(BASE, FULL));
  });

  it("reads, on a later page, only the sources its cursor names", async () => {
    const fixture = incidentFixture({
      audit: [auditRow(1, "2026-01-01 10:00:00", "priority"), auditRow(2, "2026-01-01 11:00:00", "priority")],
      journal: [journalRow(1, "2026-01-01 08:00:00", "comments")],
      flows: [],
    });
    const instance = fakeInstance(fixture);
    const { call } = await harness(instance.ops, { tableAccess: FULL });
    const first = dataOf(await call({ ...BASE, limit: 1 }));
    expect(Object.keys(first.next_cursor as object).sort()).toEqual(["audit", "journal"]);
    instance.calls.length = 0;
    const second = dataOf(await call({ ...BASE, limit: 1, cursor: first.next_cursor }));
    expect(second.sources).toMatchObject({ flows: { status: "done", returned: 0, has_more: false } });
    expect(instance.calls.map(tableOfCall)).not.toContain("sys_flow_context");
  });

  it("puts the position before the record filter, so both branches of the OR keep it", () => {
    const position = { timestamp: "2026-05-01 10:00:03", sysId: rowId("a", 9) };
    const args = { ...BASE, include_values: true, limit: 50, max_response_bytes: 100_000, fields: ["priority"] };
    expect(sourceQuery(HISTORY_SOURCE_SPECS.audit, "incident", args, position)).toBe(
      `sys_created_on<=2026-05-01 10:00:03^sys_created_on<2026-05-01 10:00:03^ORsys_id<${rowId("a", 9)}` +
        `^tablename=incident^documentkey=${ids.incident}^fieldnameINpriority` +
        "^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id"
    );
    expect(sourceQuery(HISTORY_SOURCE_SPECS.audit, "incident", args, position)).not.toContain("^NQ");
  });
});

describe("a cursor is bound to its record, source and filters", () => {
  async function firstCursor(args: Record<string, unknown>) {
    const instance = fakeInstance(busyFixture());
    const { call } = await harness(instance.ops, { tableAccess: FULL });
    const data = dataOf(await call({ ...args, limit: 1 }));
    return { call, instance, cursor: data.next_cursor as Record<string, string> };
  }

  it("is refused for another record, before any read", async () => {
    const { call, instance, cursor } = await firstCursor(BASE);
    instance.calls.length = 0;
    const data = dataOf(await call({ table: "incident", sys_id: ids.otherIncident, cursor }));
    expect(data).toEqual({ status: "invalid_cursor", record: { table: "incident", sys_id: ids.otherIncident }, hint: INVALID_CURSOR_HINT });
    expect(instance.calls).toEqual([]);
  });

  it("is refused for another source", async () => {
    const { call, cursor } = await firstCursor(BASE);
    const data = dataOf(await call({ ...BASE, cursor: { journal: cursor.audit } }));
    expect(data.status).toBe("invalid_cursor");
  });

  it("is refused for other filters", async () => {
    const { call, cursor } = await firstCursor(BASE);
    for (const changed of [
      { fields: ["priority"] },
      { since: "2026-01-01" },
      { until: "2026-12-31" },
      { sources: ["audit", "journal", "flows"] },
    ]) {
      const data = dataOf(await call({ ...BASE, ...changed, cursor }));
      expect(data.status, JSON.stringify(changed)).toBe("invalid_cursor");
    }
  });

  it("is refused when it is not a cursor at all, by the schema", async () => {
    const instance = fakeInstance(busyFixture());
    const { call } = await harness(instance.ops, { tableAccess: FULL });
    const forged = encodeTailCursor({ timestamp: "2026-05-01 10:00:00", sysId: rowId("a", 1), filter: "00000000" });
    for (const cursor of [{ audit: "not-a-cursor" }, { audit: `${forged}x` }, { audit: forged.slice(0, -2) }, { other: forged }]) {
      const result = await call({ ...BASE, cursor });
      expect(result.isError, JSON.stringify(cursor)).toBe(true);
    }
    expect(instance.calls).toEqual([]);
  });

  it("carries the filter the contracts compute", async () => {
    const { cursor } = await firstCursor(BASE);
    const decoded = decodeTailCursor(cursor.audit)!;
    expect(decoded.filter).toBe(historyCursorFilter({ sys_id: ids.incident }, "incident", "audit"));
    expect(decoded.filter).not.toBe(historyCursorFilter({ sys_id: ids.incident }, "incident", "journal"));
    expect(decoded.filter).not.toBe(historyCursorFilter({ sys_id: ids.otherIncident }, "incident", "audit"));
  });
});
