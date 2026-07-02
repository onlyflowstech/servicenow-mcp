import { describe, expect, it, vi } from "vitest";
import { handler as queryHandler, schema as querySchema } from "../src/tools/query.js";
import { handler as getHandler, schema as getSchema } from "../src/tools/get.js";
import { handler as createHandler, schema as createSchema } from "../src/tools/create.js";
import { handler as updateHandler, schema as updateSchema } from "../src/tools/update.js";
import { handler as syslogHandler, schema as syslogSchema } from "../src/tools/syslog.js";
import { DEFAULT_FIELDS, resolveFields } from "../src/table-defaults.js";
import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

/** Fake client for list tools that call getWithMeta. */
function metaClient(records: unknown[], headers: Record<string, string> = {}) {
  const getWithMeta = vi.fn(async () => ({
    data: { result: records },
    status: 200,
    headers: new Headers(headers),
  }));
  return { client: { getWithMeta } as unknown as ServiceNowClient, getWithMeta };
}

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("DEFAULT_FIELDS coverage", () => {
  const requiredTables = [
    "incident",
    "change_request",
    "problem",
    "sc_request",
    "sc_req_item",
    "sc_task",
    "sys_user",
    "sys_user_group",
    "cmdb_ci",
    "cmdb_ci_server",
    "kb_knowledge",
    "task",
  ];

  it("covers every required table", () => {
    for (const table of requiredTables) {
      expect(DEFAULT_FIELDS[table], table).toBeTypeOf("string");
    }
  });

  it("keeps every set at ~8-12 fields including sys_id and a timestamp", () => {
    for (const [table, fields] of Object.entries(DEFAULT_FIELDS)) {
      const list = fields.split(",");
      expect(list.length, table).toBeGreaterThanOrEqual(8);
      expect(list.length, table).toBeLessThanOrEqual(12);
      expect(list, table).toContain("sys_id");
      expect(
        list.includes("sys_updated_on") || list.includes("sys_created_on"),
        table
      ).toBe(true);
      expect(new Set(list).size, table).toBe(list.length);
    }
  });
});

describe("resolveFields", () => {
  it("returns the curated default for a known table when fields is omitted", () => {
    expect(resolveFields("incident")).toBe(DEFAULT_FIELDS.incident);
  });

  it("returns undefined for an unknown table when fields is omitted", () => {
    expect(resolveFields("u_custom_widget")).toBeUndefined();
  });

  it('returns undefined for fields="all" even on known tables', () => {
    expect(resolveFields("incident", "all")).toBeUndefined();
  });

  it("passes explicit fields through", () => {
    expect(resolveFields("incident", "sys_id,number")).toBe("sys_id,number");
  });
});

describe("sn_query default field selection", () => {
  it("applies DEFAULT_FIELDS as sysparm_fields for a known table", async () => {
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(querySchema.parse({ table: "incident" }), client, config);
    expect(getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({ sysparm_fields: DEFAULT_FIELDS.incident })
    );
  });

  it("sends no sysparm_fields for an unknown table", async () => {
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(querySchema.parse({ table: "u_custom_widget" }), client, config);
    const params = getWithMeta.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_fields).toBeUndefined();
  });

  it('sends no sysparm_fields when fields="all" on a known table', async () => {
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(
      querySchema.parse({ table: "incident", fields: "all" }),
      client,
      config
    );
    const params = getWithMeta.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_fields).toBeUndefined();
  });

  it("passes explicit fields through unchanged", async () => {
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(
      querySchema.parse({ table: "incident", fields: "sys_id,number" }),
      client,
      config
    );
    expect(getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({ sysparm_fields: "sys_id,number" })
    );
  });

  it("always excludes reference links", async () => {
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(querySchema.parse({ table: "incident" }), client, config);
    expect(getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({ sysparm_exclude_reference_link: "true" })
    );
  });

  it("strips empty-string and null fields from results", async () => {
    const { client } = metaClient([
      { sys_id: "a1", short_description: "boom", close_notes: "", assigned_to: null, active: false },
    ]);
    const result = await queryHandler(
      querySchema.parse({ table: "incident" }),
      client,
      config
    );
    expect(parseText(result).results).toEqual([
      { sys_id: "a1", short_description: "boom", active: false },
    ]);
  });
});

describe("sn_query pagination metadata", () => {
  it("reports total and next_offset when X-Total-Count says more exist", async () => {
    const { client } = metaClient(
      [{ sys_id: "a" }, { sys_id: "b" }],
      { "X-Total-Count": "10" }
    );
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 2, offset: 3 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.record_count).toBe(2);
    expect(payload.total).toBe(10);
    expect(payload.has_more).toBe(true);
    expect(payload.next_offset).toBe(5);
    expect(payload.hint).toContain("offset=5");
    expect(payload.hint).toContain("sn_query");
  });

  it("reports has_more=false at the exact boundary (offset+count === total)", async () => {
    const { client } = metaClient(
      [{ sys_id: "a" }, { sys_id: "b" }],
      { "X-Total-Count": "10" }
    );
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 2, offset: 8 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.total).toBe(10);
    expect(payload.has_more).toBe(false);
    expect(payload.next_offset).toBeUndefined();
    expect(payload.hint).toBeUndefined();
  });

  it("falls back to record_count === limit when the header is absent", async () => {
    const { client } = metaClient([{ sys_id: "a" }, { sys_id: "b" }]);
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 2 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.total).toBeUndefined();
    expect(payload.has_more).toBe(true);
    expect(payload.next_offset).toBe(2);
  });

  it("reports has_more=false when fewer records than limit and no header", async () => {
    const { client } = metaClient([{ sys_id: "a" }]);
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 2 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.total).toBeUndefined();
    expect(payload.has_more).toBe(false);
    expect(payload.next_offset).toBeUndefined();
  });

  it("handles an empty result set with X-Total-Count: 0", async () => {
    const { client } = metaClient([], { "X-Total-Count": "0" });
    const result = await queryHandler(
      querySchema.parse({ table: "incident" }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.record_count).toBe(0);
    expect(payload.total).toBe(0);
    expect(payload.has_more).toBe(false);
  });
});

describe("sn_get default field selection", () => {
  function getClient(record: Record<string, unknown> = {}) {
    const get = vi.fn(async () => ({ result: record }));
    return { client: { get } as unknown as ServiceNowClient, get };
  }

  it("applies DEFAULT_FIELDS for a known table", async () => {
    const { client, get } = getClient();
    await getHandler(
      getSchema.parse({ table: "incident", sys_id: "abc" }),
      client,
      config
    );
    expect(get).toHaveBeenCalledWith(
      "/api/now/table/incident/abc",
      expect.objectContaining({
        sysparm_fields: DEFAULT_FIELDS.incident,
        sysparm_exclude_reference_link: "true",
      })
    );
  });

  it("sends no sysparm_fields for an unknown table", async () => {
    const { client, get } = getClient();
    await getHandler(
      getSchema.parse({ table: "u_custom_widget", sys_id: "abc" }),
      client,
      config
    );
    const params = get.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_fields).toBeUndefined();
  });

  it('sends no sysparm_fields when fields="all"', async () => {
    const { client, get } = getClient();
    await getHandler(
      getSchema.parse({ table: "incident", sys_id: "abc", fields: "all" }),
      client,
      config
    );
    const params = get.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_fields).toBeUndefined();
  });

  it("strips empty fields from the record", async () => {
    const { client } = getClient({ sys_id: "abc", state: "2", close_code: "", parent: null });
    const result = await getHandler(
      getSchema.parse({ table: "incident", sys_id: "abc" }),
      client,
      config
    );
    expect(parseText(result)).toEqual({ sys_id: "abc", state: "2" });
  });
});

describe("sn_create response shape", () => {
  it("returns sys_id, number, table, and the stripped record without duplication", async () => {
    const post = vi.fn(async () => ({
      result: {
        sys_id: "s1",
        number: "INC0010001",
        short_description: "Server down",
        description: "",
        assigned_to: null,
        active: false,
        reopen_count: 0,
      },
    }));
    const client = { post } as unknown as ServiceNowClient;
    const result = await createHandler(
      createSchema.parse({ table: "incident", fields: { short_description: "Server down" } }),
      client,
      config
    );
    expect(parseText(result)).toEqual({
      sys_id: "s1",
      number: "INC0010001",
      table: "incident",
      record: { short_description: "Server down", active: false, reopen_count: 0 },
    });
  });
});

describe("sn_update response shape", () => {
  it("returns sys_id plus the stripped record without duplicating sys_id", async () => {
    const patch = vi.fn(async () => ({
      result: { sys_id: "s1", state: "6", close_notes: "Fixed", comments: "", parent: null },
    }));
    const client = { patch } as unknown as ServiceNowClient;
    const result = await updateHandler(
      updateSchema.parse({ table: "incident", sys_id: "s1", fields: { state: "6" } }),
      client,
      config
    );
    expect(parseText(result)).toEqual({
      sys_id: "s1",
      record: { state: "6", close_notes: "Fixed" },
    });
  });
});

describe("sn_syslog pagination metadata", () => {
  const row = { sys_id: "l1", sys_created_on: "2026-07-02", level: "error", source: "x", message: "m" };

  it("returns the pagination shape and honors X-Total-Count", async () => {
    const { client, getWithMeta } = metaClient([row, row], { "X-Total-Count": "100" });
    const result = await syslogHandler(
      syslogSchema.parse({ limit: 2, offset: 4 }),
      client,
      config
    );
    expect(getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/syslog",
      expect.objectContaining({ sysparm_offset: "4", sysparm_limit: "2" })
    );
    const payload = parseText(result);
    expect(payload.record_count).toBe(2);
    expect(payload.total).toBe(100);
    expect(payload.has_more).toBe(true);
    expect(payload.next_offset).toBe(6);
    expect(payload.hint).toContain("sn_syslog");
    expect(payload.hint).toContain("offset=6");
    expect(payload.results).toHaveLength(2);
  });

  it("omits sysparm_offset when offset is not given and reports has_more=false on a short page", async () => {
    const { client, getWithMeta } = metaClient([row]);
    const result = await syslogHandler(syslogSchema.parse({}), client, config);
    const params = getWithMeta.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_offset).toBeUndefined();
    const payload = parseText(result);
    expect(payload.record_count).toBe(1);
    expect(payload.has_more).toBe(false);
    expect(payload.next_offset).toBeUndefined();
  });
});
