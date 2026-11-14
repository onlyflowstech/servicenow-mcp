import { describe, expect, it, vi } from "vitest";
import type { ServiceNowOperations } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import {
  DEFAULT_METADATA_CACHE_TABLES,
  createCachedServiceNowOperations,
  createMetadataCacheConfig,
} from "../src/metadata-cache.js";
import {
  handler as codesearchHandler,
  schema as codesearchSchema,
} from "../src/tools/codesearch.js";
import { handler as queryHandler, schema as querySchema } from "../src/tools/query.js";

/**
 * The five code tables are cached like the other system-level metadata tables:
 * a repeated sn_codesearch or sn_query read is served from the per-identity
 * cache while the table's watermark is unchanged, and refetched when it moves.
 * Every row here is a synthetic placeholder; no real script text is involved.
 */

const CODE_TABLES = [
  "sys_script",
  "sys_script_include",
  "sys_ui_script",
  "sys_script_client",
  "sys_ws_operation",
] as const;

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

interface FakeTable {
  newest: { sys_id: string; sys_updated_on: string };
  count: number;
  /** Rows the full (non-watermark) read returns. */
  rows: Array<Record<string, unknown>>;
}

/**
 * Upstream double that tells a watermark read (newest row + X-Total-Count)
 * from a full read, per table, and records each separately.
 */
let scopeCounter = 0;

function upstream() {
  // The cache is process-global and keyed by scope, so each test gets its own.
  const instance = `https://code-cache-${(scopeCounter += 1)}.service-now.com`;
  const tables = new Map<string, FakeTable>();
  const tableFor = (name: string): FakeTable => {
    let table = tables.get(name);
    if (table === undefined) {
      table = {
        newest: { sys_id: `${name}-newest`, sys_updated_on: "2026-11-01 08:00:00" },
        count: 3,
        rows: [{ sys_id: `${name}-row`, name: `${name} fixture`, script: "needle", operation_script: "needle" }],
      };
      tables.set(name, table);
    }
    return table;
  };
  const watermarkReads: string[] = [];
  const fullReads: Array<{ table: string; params: Record<string, string> }> = [];
  const getWithMeta = vi.fn(async (path: string, params: Record<string, string> = {}) => {
    const name = /\/api\/now\/table\/([a-z_]+)/u.exec(path)![1];
    const table = tableFor(name);
    if (params.sysparm_query === "ORDERBYDESCsys_updated_on") {
      watermarkReads.push(name);
      return {
        data: { result: [{ ...table.newest }] },
        status: 200,
        headers: new Headers({
          "x-total-count": String(table.count),
          date: "Sun, 15 Nov 2026 12:00:00 GMT",
        }),
      };
    }
    fullReads.push({ table: name, params });
    return {
      data: { result: table.rows.map((row) => ({ ...row })) },
      status: 200,
      headers: new Headers({ "x-total-count": String(table.rows.length) }),
    };
  });
  const base = {
    get: vi.fn(),
    getWithMeta,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    postBinary: vi.fn(),
    getRaw: vi.fn(),
  } as unknown as ServiceNowOperations;
  /** A fresh wrapper per call, as the dispatcher builds one per tool call. */
  const call = (identity = "identity-a") =>
    createCachedServiceNowOperations(base, `${instance}|${identity}`, {}) as unknown as Parameters<
      typeof codesearchHandler
    >[1];
  return { call, tableFor, watermarkReads, fullReads };
}

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("code tables in the default metadata cache", () => {
  it.each(CODE_TABLES)("lists %s explicitly", (table) => {
    expect(DEFAULT_METADATA_CACHE_TABLES).toContain(table);
    expect(createMetadataCacheConfig(undefined).tables).toContain(table);
  });

  it("does not widen the cache to the tables that merely share a prefix", async () => {
    const { call, fullReads } = upstream();
    // sys_script_* siblings that are not code tables stay uncached.
    for (const table of ["sys_script_email", "sys_script_fix", "sys_scripted_widget"]) {
      await call("identity-prefix").get(
        `/api/now/table/${table}`,
        { sysparm_fields: "sys_id" }
      );
      await call("identity-prefix").get(
        `/api/now/table/${table}`,
        { sysparm_fields: "sys_id" }
      );
    }
    expect(fullReads.map((read) => read.table)).toEqual([
      "sys_script_email",
      "sys_script_email",
      "sys_script_fix",
      "sys_script_fix",
      "sys_scripted_widget",
      "sys_scripted_widget",
    ]);
  });
});

describe("sn_codesearch through the cache", () => {
  it("serves a repeated single-table search from cache, with one watermark read per call", async () => {
    const { call, fullReads, watermarkReads } = upstream();
    const args = codesearchSchema.parse({
      search_term: "needle",
      table: "sys_script_include",
    });

    const cold = await codesearchHandler(args, call(), config, undefined as never);
    const warm = await codesearchHandler(args, call(), config, undefined as never);

    expect(parseText(warm)).toEqual(parseText(cold));
    expect(parseText(cold)).toHaveLength(1);
    // The search itself reached the instance once; the second call paid only
    // the watermark read that proves the entry is still current.
    expect(fullReads).toHaveLength(1);
    expect(fullReads[0].params.sysparm_query).toBe("scriptLIKEneedle");
    expect(watermarkReads).toEqual(["sys_script_include", "sys_script_include"]);
  });

  it("serves a repeated search across all five code tables from cache", async () => {
    const { call, fullReads, watermarkReads } = upstream();
    const args = codesearchSchema.parse({ search_term: "needle" });

    await codesearchHandler(args, call(), config, undefined as never);
    expect(fullReads.map((read) => read.table).sort()).toEqual([...CODE_TABLES].sort());

    await codesearchHandler(args, call(), config, undefined as never);
    // No further search request: only the five watermark reads per call.
    expect(fullReads).toHaveLength(CODE_TABLES.length);
    expect(watermarkReads).toHaveLength(CODE_TABLES.length * 2);
  });

  it("refetches only the table whose watermark moved", async () => {
    const { call, tableFor, fullReads } = upstream();
    const args = codesearchSchema.parse({ search_term: "needle" });
    await codesearchHandler(args, call(), config, undefined as never);
    fullReads.length = 0;

    // A script include is saved: its newest row changes.
    const edited = tableFor("sys_script_include");
    edited.newest = { sys_id: "sys_script_include-edited", sys_updated_on: "2026-11-02 09:30:00" };
    edited.rows = [{ sys_id: "sys_script_include-edited", name: "edited fixture", script: "needle" }];

    const result = parseText(await codesearchHandler(args, call(), config, undefined as never));

    expect(fullReads.map((read) => read.table)).toEqual(["sys_script_include"]);
    expect(
      result.find((row: { table: string }) => row.table === "sys_script_include").sys_id
    ).toBe("sys_script_include-edited");
  });

  it("refetches when a row is inserted or deleted (the count moves)", async () => {
    const { call, tableFor, fullReads } = upstream();
    const args = codesearchSchema.parse({ search_term: "needle", table: "sys_script" });
    await codesearchHandler(args, call(), config, undefined as never);
    expect(fullReads).toHaveLength(1);

    tableFor("sys_script").count = 2;
    await codesearchHandler(args, call(), config, undefined as never);
    expect(fullReads).toHaveLength(2);
    // Stable again: served from the refreshed entry.
    await codesearchHandler(args, call(), config, undefined as never);
    expect(fullReads).toHaveLength(2);
  });

  it("keeps each credential identity's cached search to itself", async () => {
    const { call, fullReads } = upstream();
    const args = codesearchSchema.parse({ search_term: "needle", table: "sys_script" });

    await codesearchHandler(args, call("identity-a"), config, undefined as never);
    await codesearchHandler(args, call("identity-b"), config, undefined as never);

    expect(fullReads).toHaveLength(2);
  });

  it("keys the cache on the search term", async () => {
    const { call, fullReads } = upstream();
    const first = codesearchSchema.parse({ search_term: "needle", table: "sys_script" });
    const second = codesearchSchema.parse({ search_term: "haystack", table: "sys_script" });

    await codesearchHandler(first, call(), config, undefined as never);
    await codesearchHandler(second, call(), config, undefined as never);

    expect(fullReads.map((read) => read.params.sysparm_query)).toEqual([
      "scriptLIKEneedle",
      "scriptLIKEhaystack",
    ]);
  });
});

describe("sn_query on a code table through the cache", () => {
  it("serves a repeated page from cache and refetches when the watermark moves", async () => {
    const { call, tableFor, fullReads, watermarkReads } = upstream();
    const args = querySchema.parse({
      table: "sys_script_include",
      fields: "sys_id,name",
      limit: 20,
    });

    await queryHandler(args, call(), config);
    await queryHandler(args, call(), config);
    expect(fullReads).toHaveLength(1);
    expect(fullReads[0].params.sysparm_no_count).toBe("true");
    expect(watermarkReads).toHaveLength(2);

    tableFor("sys_script_include").newest = {
      sys_id: "sys_script_include-moved",
      sys_updated_on: "2026-11-03 10:00:00",
    };
    await queryHandler(args, call(), config);
    expect(fullReads).toHaveLength(2);
  });

  it("caches each page separately and still pages correctly from cache", async () => {
    const { call, tableFor, fullReads } = upstream();
    const table = tableFor("sys_script_include");
    table.rows = Array.from({ length: 5 }, (_, index) => ({
      sys_id: `row-${index}`,
      name: `fixture ${index}`,
    }));
    // The upstream double ignores offset, so every page is the same five rows;
    // what matters here is the sentinel logic on a cached response.
    const first = querySchema.parse({ table: "sys_script_include", fields: "sys_id,name", limit: 2 });

    const cold = parseText(await queryHandler(first, call(), config));
    const warm = parseText(await queryHandler(first, call(), config));

    expect(fullReads).toHaveLength(1);
    expect(warm).toEqual(cold);
    expect(warm.has_more).toBe(true);
    expect(warm.next_offset).toBe(2);
    expect(warm.total).toBeUndefined();
  });
});
