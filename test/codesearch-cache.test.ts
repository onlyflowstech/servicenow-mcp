import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { createCachedServiceNowOperations } from "../src/metadata-cache.js";
import { handler, schema } from "../src/tools/codesearch.js";
import { fakeInstance, scriptWith, sysId } from "./code-search-fake.js";

/**
 * A code search reads in two stages (the rows, then the scripts of the rows it
 * returns), so the cache sees two kinds of read per table. It still reads each
 * table's watermark once per call, keeps each identity's entries to itself, and
 * leaves a small response to the one-request memo.
 */

const CONFIG = { instance: "https://codesearch-cache.service-now.com" } as unknown as ServiceNowConfig;
const TABLES = ["sys_script_include", "sys_script", "sys_ui_script", "sys_script_client", "sys_ws_operation"];
let counter = 0;

function world(bodySize: number, rowsPerTable = 8) {
  const scope = `https://codesearch-cache-${(counter += 1)}.service-now.com`;
  const fake = fakeInstance(
    Object.fromEntries(
      TABLES.map((table, salt) => [
        table,
        Array.from({ length: rowsPerTable }, (_, index) => ({
          sys_id: sysId(index, salt),
          name: `${table}-${index}`,
          script: scriptWith("needle", bodySize),
          operation_script: scriptWith("needle", bodySize),
        })),
      ])
    )
  );
  const watermarks: string[] = [];
  const base = {
    get: fake.get,
    getWithMeta: vi.fn(async (path: string, params: Record<string, string> = {}) => {
      const table = /\/api\/now\/table\/([a-z_]+)/u.exec(path)![1]!;
      if (params.sysparm_query === "ORDERBYDESCsys_updated_on") {
        watermarks.push(table);
        return {
          data: { result: [{ sys_id: `${table}-newest`, sys_updated_on: "2026-11-01 08:00:00" }] },
          status: 200,
          headers: new Headers({
            "x-total-count": String(rowsPerTable),
            date: "Sun, 15 Nov 2026 12:00:00 GMT",
          }),
        };
      }
      return { data: await fake.get(path, params), status: 200, headers: new Headers() };
    }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postBinary: vi.fn(),
    getRaw: vi.fn(),
  } as unknown as ServiceNowOperations;
  /** A fresh wrapper per call, as the dispatcher builds one per tool call. */
  const search = async (identity = "a", smallReadBytes = 0, args: Record<string, unknown> = {}) => {
    const wrapper = createCachedServiceNowOperations(base, `${scope}|${identity}`, { smallReadBytes });
    const result = await handler(
      schema.parse({ search_term: "needle", limit: 20, ...args }),
      wrapper as never,
      CONFIG as never,
      undefined as never
    );
    return JSON.parse((result.content[0] as { text: string }).text) as unknown;
  };
  return { fake, watermarks, search };
}

describe("a code search through the cache", () => {
  it("serves a repeated search from cache, rows and scripts both, for one watermark read per table", async () => {
    const { fake, watermarks, search } = world(1_500);
    const cold = await search();
    // Rows (five tables) and scripts (the tables the page reached), once each.
    const coldReads = fake.reads.length;
    expect(fake.finds()).toHaveLength(5);
    expect(fake.bodies().length).toBeGreaterThan(0);
    // The watermark is read once per table per call, not once per read.
    expect(watermarks.slice().sort()).toEqual([...TABLES].sort());

    watermarks.length = 0;
    const warm = await search();
    expect(warm).toEqual(cold);
    expect(fake.reads).toHaveLength(coldReads);
    expect(watermarks.slice().sort()).toEqual([...TABLES].sort());
  });

  it("keeps each credential identity's cached search to itself", async () => {
    const { fake, search } = world(1_500);
    await search("identity-a");
    const afterFirst = fake.reads.length;
    await search("identity-b");
    // The second identity reads from the instance: nothing of the first is shared.
    expect(fake.reads.length).toBe(afterFirst * 2);
    await search("identity-a");
    expect(fake.reads.length).toBe(afterFirst * 2);
  });

  it("leaves a small response to the one-request memo, with no watermark on the next call", async () => {
    // Bodies of 100 characters keep every response under the default 32 KiB.
    const { fake, watermarks, search } = world(100);
    await search("small", 32 * 1024);
    expect(watermarks.length).toBeGreaterThan(0);
    watermarks.length = 0;
    const before = fake.reads.length;
    await search("small", 32 * 1024);
    // Every read goes straight through, one request each, and none asks for a watermark.
    expect(watermarks).toEqual([]);
    expect(fake.reads.length).toBe(before * 2);
  });

  it("reads a single table's page, scripts included, as one cached request", async () => {
    const { fake, watermarks, search } = world(1_500);
    await search("single", 0, { table: "sys_script_include" });
    expect(fake.reads).toHaveLength(1);
    expect(watermarks).toEqual(["sys_script_include"]);
    await search("single", 0, { table: "sys_script_include" });
    expect(fake.reads).toHaveLength(1);
    expect(watermarks).toEqual(["sys_script_include", "sys_script_include"]);
  });
});
