import { describe, expect, it, vi } from "vitest";
import {
  handler as queryHandler,
  schema as querySchema,
  definition as queryDefinition,
} from "../src/tools/query.js";
import {
  handler as getHandler,
  schema as getSchema,
  definition as getDefinition,
} from "../src/tools/get.js";
import { DEFAULT_FIELDS } from "../src/table-defaults.js";
import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

/** Fake client for sn_query (getWithMeta). */
function metaClient(records: unknown[], headers: Record<string, string> = {}) {
  const getWithMeta = vi.fn(async () => ({
    data: { result: records },
    status: 200,
    headers: new Headers(headers),
  }));
  return { client: { getWithMeta } as unknown as ServiceNowClient, getWithMeta };
}

/** Fake client for sn_get (get). */
function getClient(record: Record<string, unknown>) {
  const get = vi.fn(async () => ({ result: record }));
  return { client: { get } as unknown as ServiceNowClient, get };
}

function parseText(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function textBytes(result: { content: Array<{ type: string; text: string }> }) {
  return Buffer.byteLength(result.content[0].text, "utf8");
}

describe("response_format precedence (sn_query)", () => {
  async function sysparmFields(args: Record<string, unknown>) {
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(querySchema.parse(args), client, config);
    return (getWithMeta.mock.calls[0][1] as Record<string, string>).sysparm_fields;
  }

  it("explicit fields wins over response_format=detailed", async () => {
    expect(
      await sysparmFields({ table: "incident", fields: "sys_id,number", response_format: "detailed" })
    ).toBe("sys_id,number");
  });

  it('explicit fields="all" wins over response_format=concise', async () => {
    expect(
      await sysparmFields({ table: "incident", fields: "all", response_format: "concise" })
    ).toBeUndefined();
  });

  it("concise (explicit) uses DEFAULT_FIELDS on a known table", async () => {
    expect(await sysparmFields({ table: "incident", response_format: "concise" })).toBe(
      DEFAULT_FIELDS.incident
    );
  });

  it("omitted response_format defaults to concise (DEFAULT_FIELDS)", async () => {
    expect(await sysparmFields({ table: "incident" })).toBe(DEFAULT_FIELDS.incident);
  });

  it('detailed requests the full record (same as fields="all")', async () => {
    expect(
      await sysparmFields({ table: "incident", response_format: "detailed" })
    ).toBeUndefined();
  });

  it("concise on an unknown table still sends no sysparm_fields", async () => {
    expect(
      await sysparmFields({ table: "u_custom_widget", response_format: "concise" })
    ).toBeUndefined();
  });
});

describe("response_format precedence (sn_get)", () => {
  async function sysparmFields(args: Record<string, unknown>) {
    const { client, get } = getClient({});
    await getHandler(getSchema.parse({ sys_id: "abc", ...args }), client, config);
    return (get.mock.calls[0][1] as Record<string, string>).sysparm_fields;
  }

  it("explicit fields wins over response_format=detailed", async () => {
    expect(
      await sysparmFields({ table: "incident", fields: "sys_id,number", response_format: "detailed" })
    ).toBe("sys_id,number");
  });

  it('explicit fields="all" wins over response_format=concise', async () => {
    expect(
      await sysparmFields({ table: "incident", fields: "all", response_format: "concise" })
    ).toBeUndefined();
  });

  it("omitted response_format defaults to concise (DEFAULT_FIELDS)", async () => {
    expect(await sysparmFields({ table: "incident" })).toBe(DEFAULT_FIELDS.incident);
  });

  it("detailed requests the full record", async () => {
    expect(
      await sysparmFields({ table: "incident", response_format: "detailed" })
    ).toBeUndefined();
  });
});

describe("sn_query max_response_bytes truncation", () => {
  /** 10 records of ~330 serialized bytes each (~3.3 KB total). */
  function bigRecords(count = 10) {
    return Array.from({ length: count }, (_, i) => ({
      sys_id: `sys_${String(i).padStart(3, "0")}`,
      description: "x".repeat(300),
    }));
  }

  it("drops whole records from the tail, never mangling JSON", async () => {
    const records = bigRecords();
    const { client } = metaClient(records);
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 10, max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result); // JSON.parse succeeding = not mangled
    expect(payload.truncated).toBe(true);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results.length).toBeLessThan(10);
    // Every kept record is a whole, untouched record from the head.
    expect(payload.results).toEqual(records.slice(0, payload.results.length));
    expect(payload.record_count).toBe(payload.results.length);
    expect(textBytes(result)).toBeLessThanOrEqual(1000);
  });

  it("reports dropped count, total available, and follow-up args in the hint", async () => {
    const { client } = metaClient(bigRecords(), { "X-Total-Count": "50" });
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 10, offset: 5, max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result);
    const kept = payload.results.length;

    const match = /dropped (\d+) of (\d+) fetched records/.exec(payload.hint);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(10 - kept);
    expect(Number(match![2])).toBe(10);
    expect(payload.hint).toContain("(50 total match)");
    expect(payload.total).toBe(50);
    // Exact follow-up args: next offset, smaller limit, and a shrink option.
    expect(payload.hint).toContain(`offset=${5 + kept}`);
    expect(payload.hint).toContain(`limit=${kept}`);
    expect(payload.hint).toContain('fields="');
    expect(payload.hint).toContain("max_response_bytes");
    expect(payload.next_offset).toBe(5 + kept);
    expect(payload.has_more).toBe(true);
  });

  it('suggests response_format="concise" when the request was detailed without fields', async () => {
    const { client } = metaClient(bigRecords());
    const result = await queryHandler(
      querySchema.parse({
        table: "incident",
        limit: 10,
        response_format: "detailed",
        max_response_bytes: 1000,
      }),
      client,
      config
    );
    expect(parseText(result).hint).toContain('response_format="concise"');
  });

  it("suggests a narrower fields list when already concise", async () => {
    const { client } = metaClient(bigRecords());
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 10, max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.hint).toContain('fields="sys_id,number,short_description"');
  });

  it("drops everything when even one record cannot fit", async () => {
    const records = [{ sys_id: "big", description: "y".repeat(5000) }];
    const { client } = metaClient(records);
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 10, max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.truncated).toBe(true);
    expect(payload.results).toEqual([]);
    expect(payload.record_count).toBe(0);
    expect(payload.hint).toContain("dropped 1 of 1 fetched records");
    expect(textBytes(result)).toBeLessThanOrEqual(1000);
  });

  it("leaves responses under the default budget byte-identical (no guard keys)", async () => {
    const { client } = metaClient(
      [{ sys_id: "a" }, { sys_id: "b" }],
      { "X-Total-Count": "10" }
    );
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 2, offset: 3 }),
      client,
      config
    );
    // Exactly the pre-guard payload: same keys, no truncated flag.
    expect(parseText(result)).toEqual({
      record_count: 2,
      total: 10,
      has_more: true,
      next_offset: 5,
      hint: "More records available. Call sn_query again with offset=5.",
      results: [{ sys_id: "a" }, { sys_id: "b" }],
    });
  });

  it("leaves an explicitly-sized but fitting response untouched", async () => {
    const { client } = metaClient([{ sys_id: "a" }]);
    const result = await queryHandler(
      querySchema.parse({ table: "incident", limit: 1, max_response_bytes: 1000 }),
      client,
      config
    );
    expect(parseText(result)).toEqual({
      record_count: 1,
      has_more: true,
      next_offset: 1,
      hint: "More records available. Call sn_query again with offset=1.",
      results: [{ sys_id: "a" }],
    });
  });
});

describe("sn_get max_response_bytes truncation", () => {
  it("shortens the longest field value with a per-field marker", async () => {
    const { client } = getClient({
      sys_id: "abc",
      short_description: "ok",
      description: "D".repeat(5000),
    });
    const result = await getHandler(
      getSchema.parse({ table: "incident", sys_id: "abc", max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.truncated).toBe(true);
    expect(payload.truncated_fields).toEqual(["description"]);
    expect(payload.description).toMatch(/^D+\.\.\.\[truncated \d+ of 5000 chars\]$/);
    expect(payload.description.length).toBeLessThan(5000);
    // Small fields survive untouched.
    expect(payload.sys_id).toBe("abc");
    expect(payload.short_description).toBe("ok");
    expect(payload.hint).toContain('fields="description"');
    expect(payload.hint).toContain("max_response_bytes");
    expect(textBytes(result)).toBeLessThanOrEqual(1000);
  });

  it("truncates multiple fields largest-first when one is not enough", async () => {
    const { client } = getClient({
      sys_id: "abc",
      description: "D".repeat(5000),
      comments: "C".repeat(4000),
    });
    const result = await getHandler(
      getSchema.parse({ table: "incident", sys_id: "abc", max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.truncated_fields).toEqual(["description", "comments"]);
    expect(payload.description).toMatch(/\.\.\.\[truncated \d+ of 5000 chars\]$/);
    expect(payload.comments).toMatch(/\.\.\.\[truncated \d+ of 4000 chars\]$/);
    // Each keeps at least the guaranteed prefix.
    expect(payload.description.length).toBeGreaterThanOrEqual(200);
    expect(payload.comments.length).toBeGreaterThanOrEqual(200);
    expect(textBytes(result)).toBeLessThanOrEqual(1000);
  });

  it("leaves records under the default budget byte-identical (no guard keys)", async () => {
    const record = { sys_id: "abc", state: "2", description: "short" };
    const { client } = getClient(record);
    const result = await getHandler(
      getSchema.parse({ table: "incident", sys_id: "abc" }),
      client,
      config
    );
    expect(parseText(result)).toEqual(record);
  });

  it("leaves an explicitly-sized but fitting record untouched", async () => {
    const record = { sys_id: "abc", description: "x".repeat(100) };
    const { client } = getClient(record);
    const result = await getHandler(
      getSchema.parse({ table: "incident", sys_id: "abc", max_response_bytes: 1000 }),
      client,
      config
    );
    expect(parseText(result)).toEqual(record);
  });
});

describe("new param validation and JSON-schema/zod sync", () => {
  it("applies defaults: concise + 100000 bytes on both tools", () => {
    const q = querySchema.parse({ table: "incident" });
    expect(q.response_format).toBe("concise");
    expect(q.max_response_bytes).toBe(100000);
    const g = getSchema.parse({ table: "incident", sys_id: "abc" });
    expect(g.response_format).toBe("concise");
    expect(g.max_response_bytes).toBe(100000);
  });

  it("rejects response_format outside the enum on both tools", () => {
    expect(
      querySchema.safeParse({ table: "incident", response_format: "verbose" }).success
    ).toBe(false);
    expect(
      getSchema.safeParse({ table: "incident", sys_id: "a", response_format: "full" }).success
    ).toBe(false);
  });

  it("bounds max_response_bytes to [1000, 1000000] integers", () => {
    for (const schema of [querySchema, getSchema]) {
      const base = { table: "incident", sys_id: "a" };
      expect(schema.safeParse({ ...base, max_response_bytes: 999 }).success).toBe(false);
      expect(schema.safeParse({ ...base, max_response_bytes: 1000 }).success).toBe(true);
      expect(schema.safeParse({ ...base, max_response_bytes: 1000000 }).success).toBe(true);
      expect(schema.safeParse({ ...base, max_response_bytes: 1000001 }).success).toBe(false);
      expect(schema.safeParse({ ...base, max_response_bytes: 1500.5 }).success).toBe(false);
    }
  });

  it("keeps the hand-written JSON schema in sync with zod", () => {
    for (const definition of [queryDefinition, getDefinition]) {
      const props = definition.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.response_format.enum).toEqual(["concise", "detailed"]);
      expect(props.response_format.type).toBe("string");
      expect(props.max_response_bytes.type).toBe("integer");
      expect(props.max_response_bytes.minimum).toBe(1000);
      expect(props.max_response_bytes.maximum).toBe(1000000);
      // Descriptions state the defaults and the precedence rule.
      expect(String(props.response_format.description)).toContain("concise");
      expect(String(props.response_format.description)).toContain("Ignored when fields");
      expect(String(props.max_response_bytes.description)).toContain("100000");
    }
  });
});
