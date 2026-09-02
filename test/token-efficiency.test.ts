import { describe, expect, it, vi } from "vitest";
import { handler as queryHandler, schema as querySchema } from "../src/tools/query.js";
import { handler as getHandler, schema as getSchema } from "../src/tools/get.js";
import { handler as createHandler, schema as createSchema } from "../src/tools/create.js";
import { handler as updateHandler, schema as updateSchema } from "../src/tools/update.js";
import { handler as syslogHandler, schema as syslogSchema } from "../src/tools/syslog.js";
import { DEFAULT_FIELDS, resolveFields } from "../src/table-defaults.js";
import { resolveReadableFields } from "../src/field-policy.js";
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

  it("gives a table without an explicit field policy the bounded generic default", async () => {
    // Field policy no longer denies a table it has no entry for: reachability
    // is decided by the profile `tableAccess` grant. What it still guarantees
    // is that an unspecified read stays a bounded projection.
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(
      querySchema.parse({ table: "u_custom_widget" }),
      client,
      config
    );
    const params = getWithMeta.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_fields).toBe("sys_id");
  });

  it('drops sysparm_fields for fields="all" and keeps it bounded by default', async () => {
    // "all" on a granted table now means every column, so the projection is
    // omitted rather than enumerated. The default read stays bounded.
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(
      querySchema.parse({ table: "incident", fields: "all" }),
      client,
      config
    );
    expect(resolveReadableFields("incident", { fields: "all" })).toEqual(["*"]);
    expect(
      (getWithMeta.mock.calls[0][1] as Record<string, string>).sysparm_fields
    ).toBeUndefined();

    await queryHandler(querySchema.parse({ table: "incident" }), client, config);
    expect(
      (getWithMeta.mock.calls[1][1] as Record<string, string>).sysparm_fields
    ).toBe(resolveReadableFields("incident").join(","));
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

  it("uses the limit+1 sentinel when the total header is absent", async () => {
    const { client, getWithMeta } = metaClient([
      { sys_id: "a" },
      { sys_id: "b" },
      { sys_id: "sentinel" },
    ]);
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 2 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({ sysparm_limit: "3" })
    );
    expect(payload.results).toEqual([{ sys_id: "a" }, { sys_id: "b" }]);
    expect(payload.record_count).toBe(2);
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

  it("advances next_offset by limit, not record_count, when ACLs trim the page", async () => {
    // ServiceNow applies limit/offset BEFORE ACL/domain-separation row
    // stripping: a window of 5 rows can come back with only 3 while
    // X-Total-Count still counts all matches. Advancing by record_count
    // would re-read the tail of the window (duplicates).
    const { client } = metaClient(
      [{ sys_id: "a" }, { sys_id: "b" }, { sys_id: "c" }],
      { "X-Total-Count": "100" }
    );
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 5, offset: 0 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.record_count).toBe(3);
    expect(payload.has_more).toBe(true);
    expect(payload.next_offset).toBe(5);
    expect(payload.hint).toContain("offset=5");
  });

  it("never repeats the current offset when an entire window is ACL-stripped", async () => {
    // Worst case: every row in the window is hidden -> record_count=0 but
    // has_more=true. next_offset === offset would drive an infinite loop.
    const { client } = metaClient([], { "X-Total-Count": "100" });
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 5, offset: 10 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.record_count).toBe(0);
    expect(payload.has_more).toBe(true);
    expect(payload.next_offset).toBe(15);
    expect(payload.next_offset).not.toBe(10);
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

  it.each(["-1", "1.5", "9007199254740992", " ", "1e3", "+3", "01"])(
    "ignores hostile X-Total-Count %j and uses the bounded page fallback",
    async (header) => {
      const { client } = metaClient([{ sys_id: "a" }], {
        "X-Total-Count": header,
      });
      const result = await queryHandler(
        querySchema.parse({ table: "incident", limit: 2, offset: 7 }),
        client,
        config
      );
      const payload = parseText(result);

      expect(payload.record_count).toBe(1);
      expect(payload.total).toBeUndefined();
      expect(payload.has_more).toBe(false);
      expect(payload.next_offset).toBeUndefined();
    }
  );
});

describe("sn_get default field selection", () => {
  function getClient(record: Record<string, unknown> = {}) {
    const get = vi.fn(async () => ({ result: record }));
    return { client: { get } as unknown as ServiceNowClient, get };
  }

  it("applies DEFAULT_FIELDS for a known table", async () => {
    const { client, get } = getClient();
    await getHandler(
      getSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111" }),
      client,
      config
    );
    expect(get).toHaveBeenCalledWith(
      "/api/now/table/incident/11111111111111111111111111111111",
      expect.objectContaining({
        sysparm_fields: DEFAULT_FIELDS.incident,
        sysparm_exclude_reference_link: "true",
      })
    );
  });

  it("gives a table without an explicit field policy the bounded generic default", async () => {
    const { client, get } = getClient();
    await getHandler(
      getSchema.parse({
        table: "u_custom_widget",
        sys_id: "11111111111111111111111111111111",
      }),
      client,
      config
    );
    const params = get.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_fields).toBe("sys_id");
  });

  it('drops sysparm_fields for fields="all"', async () => {
    const { client, get } = getClient();
    await getHandler(
      getSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111", fields: "all" }),
      client,
      config
    );
    const params = get.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_fields).toBeUndefined();
  });

  it("strips empty fields from the record", async () => {
    const { client } = getClient({ sys_id: "abc", state: "2", close_code: "", parent: null });
    const result = await getHandler(
      getSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111" }),
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
        sys_id: "2".repeat(32),
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
    // The write response projection is no longer bounded by a built-in
    // readable list, so a field the fixture returns is carried through.
    expect(parseText(result)).toEqual({
      sys_id: "2".repeat(32),
      number: "INC0010001",
      table: "incident",
      record: {
        short_description: "Server down",
        active: false,
        reopen_count: 0,
      },
    });
  });
});

describe("sn_update response shape", () => {
  it("returns sys_id plus the stripped record without duplicating sys_id", async () => {
    const patch = vi.fn(async () => ({
      result: { sys_id: "1".repeat(32), state: "6", close_notes: "Fixed", comments: "", parent: null },
    }));
    const client = { patch } as unknown as ServiceNowClient;
    const result = await updateHandler(
      updateSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111", fields: { state: "6" } }),
      client,
      config
    );
    expect(parseText(result)).toEqual({
      sys_id: "1".repeat(32),
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

  it("advances next_offset by limit when the page is trimmed below limit", async () => {
    const { client } = metaClient([row, row], { "X-Total-Count": "100" });
    const result = await syslogHandler(
      syslogSchema.parse({ limit: 5, offset: 4 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.record_count).toBe(2);
    expect(payload.has_more).toBe(true);
    expect(payload.next_offset).toBe(9);
    expect(payload.hint).toContain("offset=9");
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
