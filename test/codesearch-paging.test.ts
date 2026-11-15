import { describe, expect, it } from "vitest";

import { ServiceNowResponseTooLargeError } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { handler, schema } from "../src/tools/codesearch.js";
import {
  RESPONSE_CAP_BYTES,
  fakeInstance,
  scriptWith,
  sysId,
  type FakeRow,
} from "./code-search-fake.js";

/**
 * The shape of a code search over a large instance, against a fake Table API
 * that enforces the 1 MiB response cap. The handler is called directly, the way
 * the dispatcher does after its access preflight.
 */

const CONFIG = { instance: "https://codesearch-paging.service-now.com" } as unknown as ServiceNowConfig;
const TERM = "needle";

type Row = { table: string; sys_id: string; name: string; snippet: string; line?: number; note?: string };

async function run(
  fake: ReturnType<typeof fakeInstance>,
  args: Record<string, unknown> = {}
): Promise<{ rows: Row[]; warnings: string[] }> {
  const result = await handler(
    schema.parse({ search_term: TERM, ...args }),
    fake as never,
    CONFIG as never,
    undefined as never
  );
  const parsed = JSON.parse((result.content[0] as { text: string }).text) as
    | Row[]
    | { results: Row[]; warnings: string[] };
  return Array.isArray(parsed) ? { rows: parsed, warnings: [] } : { rows: parsed.results, warnings: parsed.warnings };
}

function rows(table: string, count: number, bodySize: (index: number) => number, salt = 0): FakeRow[] {
  return Array.from({ length: count }, (_, index) => ({
    sys_id: sysId(index, salt),
    name: `${table}-${String(index).padStart(4, "0")}`,
    script: scriptWith(TERM, bodySize(index)),
    operation_script: scriptWith(TERM, bodySize(index)),
  }));
}

describe("the fake instance", () => {
  it("refuses the read the full-body search used to make at limit 300", async () => {
    const size = (index: number) => (index % 100 === 0 ? 56_000 : index % 10 === 0 ? 16_000 : 1_700);
    const fake = fakeInstance({ sys_script_include: rows("si", 700, size) });
    await expect(
      fake.get("/api/now/table/sys_script_include", {
        sysparm_query: "scriptLIKEneedle^ORDERBYsys_id",
        sysparm_fields: "sys_id,name,script",
        sysparm_limit: "301",
      })
    ).rejects.toBeInstanceOf(ServiceNowResponseTooLargeError);
    expect(fake.reads[0]!.tooLarge).toBe(true);
  });
});

describe("one table, one page", () => {
  it("is a single request that carries the scripts, at the default limit", async () => {
    const fake = fakeInstance({ sys_script_include: rows("si", 30, () => 400) });
    const { rows: found } = await run(fake, { table: "sys_script_include" });
    expect(fake.reads).toHaveLength(1);
    expect(fake.reads[0]!.params).toMatchObject({
      sysparm_fields: "sys_id,name,script",
      sysparm_limit: "21",
      sysparm_offset: "0",
      sysparm_query: "scriptLIKEneedle^ORDERBYsys_id",
    });
    // One more row than the page, to tell the caller whether there is a next.
    expect(found).toHaveLength(21);
    expect(found.slice(0, 20).every((row) => row.snippet.includes(TERM) && row.line === 1)).toBe(true);
  });

  it("falls back to finding the rows first when the page with its scripts passes the cap", async () => {
    // 21 matches of tens of kilobytes each: more than one response holds.
    const fake = fakeInstance({ sys_script_include: rows("si", 30, () => 52_000) });
    const { rows: found, warnings } = await run(fake, { table: "sys_script_include" });
    expect(warnings).toEqual([]);
    expect(found).toHaveLength(21);
    expect(found.slice(0, 20).every((row) => row.snippet.includes(TERM))).toBe(true);
    expect(fake.reads[0]!.tooLarge).toBe(true);
    expect(fake.finds().map((read) => read.params.sysparm_fields)).toEqual(["sys_id,name,script", "sys_id,name"]);
    expect(fake.reads.filter((read) => read.tooLarge)).toHaveLength(1);
  });

  it("lets the instance apply the offset", async () => {
    const fake = fakeInstance({ sys_script_include: rows("si", 100, () => 100) });
    const { rows: found } = await run(fake, { table: "sys_script_include", offset: 40, limit: 10 });
    expect(fake.reads).toHaveLength(1);
    expect(fake.reads[0]!.params).toMatchObject({ sysparm_offset: "40", sysparm_limit: "11" });
    expect(found.map((row) => row.name)[0]).toBe("si-0040");
    expect(found).toHaveLength(11);
  });
});

describe("a page too big to read its scripts with the rows", () => {
  it("finds the rows without scripts, then reads scripts for the rows it returns, in batches", async () => {
    const fake = fakeInstance({ sys_script_include: rows("si", 400, () => 2_000) });
    const { rows: found } = await run(fake, { table: "sys_script_include", limit: 120 });
    expect(fake.finds()).toHaveLength(1);
    expect(fake.finds()[0]!.params.sysparm_fields).toBe("sys_id,name");
    expect(fake.finds()[0]!.params.sysparm_limit).toBe("121");
    // The 120 returned rows, in batches of 50; not the row that only says "more".
    const batches = fake.bodies().map((read) => read.params.sysparm_query!.split("IN")[1]!.split(",").length);
    expect(batches.sort((a, b) => b - a)).toEqual([50, 50, 20]);
    expect(found).toHaveLength(121);
    expect(found.slice(0, 120).every((row) => row.snippet.includes(TERM))).toBe(true);
    expect(found[120]!.snippet).toBe("");
    expect(fake.peak()).toBeLessThanOrEqual(4);
  });

  it("returns 150 and 300 script includes of realistic sizes, where the full-body read passed the cap", async () => {
    // Median 1.7 KB, a tail to 56 KB, about 6 KB on average, as measured.
    const size = (index: number) => (index % 100 === 0 ? 56_000 : index % 10 === 0 ? 16_000 : 1_700);
    const instance = { sys_script_include: rows("si", 700, size) };
    for (const limit of [150, 300]) {
      const fake = fakeInstance(instance);
      const { rows: found, warnings } = await run(fake, { table: "sys_script_include", limit });
      expect(found.slice(0, limit).filter((row) => row.snippet.includes(TERM))).toHaveLength(limit);
      expect(warnings).toEqual([]);
      expect(fake.reads.some((read) => read.tooLarge), `limit ${limit}`).toBe(false);
      // What the old read asked for in one response, which cannot pass the cap.
      const oldBytes = instance.sys_script_include
        .slice(0, limit + 1)
        .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
      if (limit === 300) expect(oldBytes).toBeGreaterThan(RESPONSE_CAP_BYTES);
    }
  });

  it("halves a batch that passes the cap, and marks a script too large to read alone", async () => {
    const data = rows("si", 60, () => 3_000);
    data[7] = { ...data[7]!, script: scriptWith(TERM, 1_300_000) };
    const fake = fakeInstance({ sys_script_include: data });
    const { rows: found } = await run(fake, { table: "sys_script_include", limit: 60 });
    expect(fake.reads.some((read) => read.tooLarge)).toBe(true);
    const marked = found.filter((row) => row.note !== undefined);
    expect(marked.map((row) => row.name)).toEqual(["si-0007"]);
    expect(marked[0]).toMatchObject({ snippet: "", note: "script too large to preview" });
    const others = found.slice(0, 60).filter((row) => row.name !== "si-0007");
    expect(others.every((row) => row.snippet.includes(TERM))).toBe(true);
    expect(others).toHaveLength(59);
  });

  it("keeps the rows and says so when a script read fails for another reason", async () => {
    const fake = fakeInstance(
      { sys_script_include: rows("si", 80, () => 200) },
      { failBodies: new Error("RAW_UPSTREAM_DETAIL") }
    );
    const { rows: found, warnings } = await run(fake, { table: "sys_script_include", limit: 60 });
    expect(found).toHaveLength(61);
    expect(found.every((row) => row.snippet === "")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sys_script_include: snippets unavailable for some results.");
    expect(warnings[0]).not.toContain("RAW_UPSTREAM_DETAIL");
  });

  it("fails with the too-large message when the rows alone pass the cap", async () => {
    const huge = Array.from({ length: 3 }, (_, index) => ({
      sys_id: sysId(index),
      name: "n".repeat(2_000_000),
      script: TERM,
    }));
    const fake = fakeInstance({ sys_script_include: huge });
    await expect(run(fake, { table: "sys_script_include", limit: 60 })).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && error.message.includes("Error category: too_large.")
    );
  });
});

describe("a search across tables", () => {
  const order = ["sys_script_include", "sys_script", "sys_ui_script", "sys_script_client", "sys_ws_operation"];

  function fiveTables(counts: Record<string, number>) {
    return Object.fromEntries(
      order.map((table, salt) => [table, rows(table, counts[table] ?? 0, () => 150, salt)])
    );
  }

  it("takes turns through the tables, script includes first, each in sys_id order", async () => {
    const fake = fakeInstance(fiveTables(Object.fromEntries(order.map((table) => [table, 30]))));
    const { rows: found } = await run(fake);
    expect(found.slice(0, 20).map((row) => `${row.table}:${row.name.slice(-4)}`)).toEqual(
      [0, 1, 2, 3].flatMap((round) => order.map((table) => `${table}:${String(round).padStart(4, "0")}`))
    );
    expect(found).toHaveLength(21);
  });

  it("puts script includes on the first page when business rules have far more matches", async () => {
    const fake = fakeInstance(fiveTables({ sys_script: 400, sys_script_include: 40, sys_ui_script: 3 }));
    const { rows: found } = await run(fake);
    const tables = new Set(found.slice(0, 20).map((row) => row.table));
    expect(tables.has("sys_script_include")).toBe(true);
    expect(tables.has("sys_ui_script")).toBe(true);
    // Before this, every row of the first page was a business rule.
    expect(found.slice(0, 20).filter((row) => row.table === "sys_script_include").length).toBeGreaterThanOrEqual(8);
  });

  it("gives the other tables the room a table with few matches leaves", async () => {
    const fake = fakeInstance(fiveTables({ sys_script_include: 5, sys_script: 2 }));
    const { rows: found } = await run(fake, { limit: 20 });
    expect(found.map((row) => `${row.table}:${row.name.slice(-1)}`)).toEqual([
      "sys_script_include:0",
      "sys_script:0",
      "sys_script_include:1",
      "sys_script:1",
      "sys_script_include:2",
      "sys_script_include:3",
      "sys_script_include:4",
    ]);
  });

  it("tiles the combined order with pages, with no row repeated or skipped", async () => {
    const counts = { sys_script_include: 23, sys_script: 11, sys_ui_script: 0, sys_script_client: 7, sys_ws_operation: 40 };
    const whole = (await run(fakeInstance(fiveTables(counts)), { limit: 200 })).rows.slice(0, 81);
    expect(whole).toHaveLength(81);
    const paged: Row[] = [];
    for (let offset = 0; offset < 81; offset += 9) {
      const fake = fakeInstance(fiveTables(counts));
      paged.push(...(await run(fake, { limit: 9, offset })).rows.slice(0, 9));
    }
    expect(paged.map((row) => `${row.table}:${row.sys_id}`)).toEqual(
      whole.map((row) => `${row.table}:${row.sys_id}`)
    );
    expect(new Set(paged.map((row) => `${row.table}:${row.sys_id}`)).size).toBe(81);
  });

  it("is the same whichever read finishes first", async () => {
    const counts = Object.fromEntries(order.map((table) => [table, 12]));
    const forward = await run(fakeInstance(fiveTables(counts), { delayMs: { sys_script_include: 40, sys_ws_operation: 1 } }));
    const reverse = await run(fakeInstance(fiveTables(counts), { delayMs: { sys_script_include: 1, sys_ws_operation: 40 } }));
    expect(reverse.rows).toEqual(forward.rows);
  });

  it("reads each table from the start, as far as the page reaches, without scripts", async () => {
    const counts = Object.fromEntries(order.map((table) => [table, 60]));
    const fake = fakeInstance(fiveTables(counts));
    const { rows: found } = await run(fake, { limit: 10, offset: 30 });
    expect(fake.finds()).toHaveLength(6);
    for (const read of fake.finds()) {
      const module = read.table === "sys_module";
      expect(read.params).toMatchObject({
        sysparm_offset: "0",
        sysparm_limit: "41",
        sysparm_fields: module ? "sys_id,path" : "sys_id,name",
      });
      expect(read.params.sysparm_query).toMatch(/^(script|operation_script|content)LIKEneedle\^ORDERBYsys_id$/u);
    }
    // Scripts for the ten rows of the page only.
    const ids = fake.bodies().flatMap((read) => read.params.sysparm_query!.split("IN")[1]!.split(","));
    expect(ids).toHaveLength(10);
    expect(found).toHaveLength(11);
    expect(found.slice(0, 10).every((row) => row.snippet.includes(TERM))).toBe(true);
  });

  it("does not trip the response cap at limit 300 where five tables of scripts did", async () => {
    const size = (index: number) => (index % 100 === 0 ? 56_000 : index % 10 === 0 ? 16_000 : 1_700);
    const data = Object.fromEntries(order.map((table, salt) => [table, rows(table, 400, size, salt)]));
    const fake = fakeInstance(data);
    const { rows: found, warnings } = await run(fake, { limit: 300 });
    expect(warnings).toEqual([]);
    expect(found.slice(0, 300).every((row) => row.snippet.includes(TERM))).toBe(true);
    expect(fake.reads.some((read) => read.tooLarge)).toBe(false);
  });

  it("reports a table that fails and returns the rest, and fails when all fail", async () => {
    const counts = Object.fromEntries(order.map((table) => [table, 5]));
    const some = await run(
      fakeInstance(fiveTables(counts), { fail: { sys_script: new ServiceNowResponseTooLargeError("x") } })
    );
    expect(some.warnings).toHaveLength(1);
    expect(some.warnings[0]).toMatch(/^sys_script: .*Error category: too_large\./u);
    expect(new Set(some.rows.map((row) => row.table))).toEqual(new Set(order.filter((t) => t !== "sys_script")));

    const all = Object.fromEntries(
      [...order, "sys_module"].map((table) => [table, new ServiceNowResponseTooLargeError("x")])
    );
    await expect(run(fakeInstance(fiveTables(counts), { fail: all }))).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && error.message.includes("Error category: too_large.")
    );
  });
});
