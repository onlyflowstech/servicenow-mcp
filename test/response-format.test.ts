import { describe, expect, it, vi } from "vitest";
import {
  handler as queryHandler,
  schema as querySchema,
} from "../src/tools/query.js";
import {
  handler as getHandler,
  schema as getSchema,
} from "../src/tools/get.js";
import {
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
} from "../src/tools/result-envelope.js";
import { DEFAULT_FIELDS } from "../src/table-defaults.js";
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

function finalizeGetResult(
  args: Record<string, unknown>,
  result: Awaited<ReturnType<typeof getHandler>>
) {
  const enveloped = envelopeCompatibilityResult("sn_get", args, result);
  if (!enveloped.structuredContent) {
    throw new Error("expected an sn_get structured result");
  }
  const finalized = finalizeEnvelopeResult({
    ...enveloped,
    structuredContent: {
      ...enveloped.structuredContent,
      profile: "test",
    },
  });
  if (!finalized?.structuredContent) {
    throw new Error("expected an sn_get result that fits the requested budget");
  }
  return finalized;
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
    // "all" resolves to the wildcard selection, but the upstream request is
    // bounded: with no dictionary available the cap falls back to the default
    // projection rather than dropping sysparm_fields.
    expect(resolveReadableFields("incident", { fields: "all" })).toEqual(["*"]);
    expect(
      await sysparmFields({ table: "incident", fields: "all", response_format: "concise" })
    ).toBe(resolveReadableFields("incident").join(","));
  });

  it("concise (explicit) uses DEFAULT_FIELDS on a known table", async () => {
    expect(await sysparmFields({ table: "incident", response_format: "concise" })).toBe(
      DEFAULT_FIELDS.incident
    );
  });

  it("omitted response_format defaults to concise (DEFAULT_FIELDS)", async () => {
    expect(await sysparmFields({ table: "incident" })).toBe(DEFAULT_FIELDS.incident);
  });

  it('detailed matches fields="all" and stays bounded', async () => {
    expect(
      await sysparmFields({ table: "incident", response_format: "detailed" })
    ).toBe(resolveReadableFields("incident").join(","));
  });

  it("concise on an unknown table uses the bounded generic default", async () => {
    // A table with no field-policy entry is no longer denied here; its
    // reachability is a tableAccess question. The projection stays bounded.
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(
      querySchema.parse({
        table: "u_custom_widget",
        response_format: "concise",
      }),
      client,
      config
    );
    expect(
      (getWithMeta.mock.calls[0][1] as Record<string, string>).sysparm_fields
    ).toBe("sys_id");
  });
});

describe("response_format precedence (sn_get)", () => {
  async function sysparmFields(args: Record<string, unknown>) {
    const { client, get } = getClient({});
    await getHandler(getSchema.parse({ sys_id: "11111111111111111111111111111111", ...args }), client, config);
    // A wildcard selection first resolves the table's columns, so the record
    // fetch is not necessarily the first call.
    const recordCall = get.mock.calls.find(
      ([path]) => !String(path).startsWith("/api/now/table/sys_db_object") &&
        !String(path).startsWith("/api/now/table/sys_dictionary")
    );
    return (recordCall?.[1] as Record<string, string> | undefined)?.sysparm_fields;
  }

  it("explicit fields wins over response_format=detailed", async () => {
    expect(
      await sysparmFields({ table: "incident", fields: "sys_id,number", response_format: "detailed" })
    ).toBe("sys_id,number");
  });

  it('explicit fields="all" wins over response_format=concise', async () => {
    expect(
      await sysparmFields({ table: "incident", fields: "all", response_format: "concise" })
    ).toBe(resolveReadableFields("incident").join(","));
  });

  it("omitted response_format defaults to concise (DEFAULT_FIELDS)", async () => {
    expect(await sysparmFields({ table: "incident" })).toBe(DEFAULT_FIELDS.incident);
  });

  it("detailed stays bounded", async () => {
    expect(
      await sysparmFields({ table: "incident", response_format: "detailed" })
    ).toBe(resolveReadableFields("incident").join(","));
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
      querySchema.parse({ table: "incident", fields: "sys_id,description", limit: 10, max_response_bytes: 1000 }),
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
      querySchema.parse({ table: "incident", fields: "sys_id,description", limit: 10, offset: 5, max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result);
    const kept = payload.results.length;

    const match = /Dropped (\d+)\/(\d+)/.exec(payload.hint);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(10 - kept);
    expect(Number(match![2])).toBe(10);
    expect(payload.hint).toContain("(50 total)");
    expect(payload.total).toBe(50);
    // Continue only at the authoritative upstream window boundary. Re-fetch
    // the current offset with a narrower response to recover dropped rows.
    expect(payload.hint).toContain("offset=15");
    expect(payload.hint).toContain("limit=10");
    expect(payload.hint).toContain("recover offset=5");
    expect(payload.hint).toContain('fields="');
    expect(payload.hint).toContain("max_response_bytes");
    expect(payload.next_offset).toBe(15);
    expect(payload.has_more).toBe(true);
  });

  it('suggests response_format="concise" when the request was detailed without fields', async () => {
    // The bulk has to live in a field the bounded "detailed" projection keeps,
    // otherwise capping the request removes it and nothing truncates.
    const { client } = metaClient(
      Array.from({ length: 10 }, (_, i) => ({
        sys_id: `sys_${String(i).padStart(3, "0")}`,
        short_description: "x".repeat(300),
      }))
    );
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
      querySchema.parse({ table: "incident", fields: "sys_id,description", limit: 10, max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.hint).toContain('fields="sys_id,number"');
  });

  it("drops everything when even one record cannot fit", async () => {
    const records = [{ sys_id: "big", description: "y".repeat(5000) }];
    const { client } = metaClient(records);
    const result = await queryHandler(
      querySchema.parse({ table: "incident", fields: "sys_id,description", limit: 10, max_response_bytes: 1000 }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.truncated).toBe(true);
    expect(payload.results).toEqual([]);
    expect(payload.record_count).toBe(0);
    expect(payload.hint).toContain("Dropped 1/1");
    expect(textBytes(result)).toBeLessThanOrEqual(1000);
  });

  // Regression (review fix): with keep=0 the old hint said "Fetch the
  // rest with offset=<same offset> and limit=1" -- following it verbatim
  // refetches the identical over-budget record forever. The hint must
  // instead say the record itself exceeds the budget and route to
  // fields/budget/sn_get, never to a same-window refetch.
  it("keep=0 hint never suggests re-fetching the same window", async () => {
    const records = [{ sys_id: "big", description: "y".repeat(5000) }];
    const { client } = metaClient(records, { "X-Total-Count": "9" });
    const result = await queryHandler(
      querySchema.parse({
        table: "incident",
        fields: "sys_id,description",
        limit: 1,
        offset: 4,
        max_response_bytes: 1000,
      }),
      client,
      config
    );
    const payload = parseText(result);
    expect(payload.record_count).toBe(0);
    expect(payload.next_offset).toBe(5);
    expect(payload.has_more).toBe(true);
    expect(payload.hint).not.toContain("Fetch the rest");
    expect(payload.hint).toContain("row too large");
    expect(payload.hint).toContain("recover offset=4");
    expect(payload.hint).toContain("resume offset=5");
    expect(payload.hint).toContain("sn_get");
    expect(payload.hint).toContain("max_response_bytes");
    expect(payload.hint).toContain('fields="');
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
      has_more: false,
      results: [{ sys_id: "a" }],
    });
  });
});

describe("sn_get max_response_bytes truncation", () => {
  it("fits long fields centrally without adding record control keys", async () => {
    const upstream = {
      sys_id: "abc",
      short_description: "ok",
      description: "D".repeat(5000),
    };
    const before = JSON.stringify(upstream);
    const { client } = getClient(upstream);
    const args = getSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111", fields: "sys_id,short_description,description", max_response_bytes: 1000 });
    const raw = await getHandler(
      args,
      client,
      config
    );
    const result = finalizeGetResult(args, raw);
    const envelope = result.structuredContent as {
      data: { record: Record<string, unknown> };
      metadata: Record<string, unknown>;
    };
    expect(JSON.stringify(upstream)).toBe(before);
    expect(envelope.data.record).toMatchObject({
      sys_id: "abc",
      short_description: "ok",
    });
    expect(envelope.data.record.description).toMatch(
      /^D+\.\.\.\[truncated \d+ characters\]$/
    );
    expect(envelope.data.record).not.toHaveProperty("truncated");
    expect(envelope.data.record).not.toHaveProperty("truncated_fields");
    expect(envelope.data.record).not.toHaveProperty("hint");
    expect(envelope.metadata).toMatchObject({
      truncation: { truncated: true, reason: "byte_limit" },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(1000);
  });

  it("fits multiple long fields while preserving the source record", async () => {
    const upstream = {
      sys_id: "abc",
      description: "D".repeat(5000),
      close_notes: "C".repeat(4000),
    };
    const before = JSON.stringify(upstream);
    const { client } = getClient(upstream);
    const args = getSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111", fields: "sys_id,description,close_notes", max_response_bytes: 1000 });
    const raw = await getHandler(
      args,
      client,
      config
    );
    const result = finalizeGetResult(args, raw);
    const envelope = result.structuredContent as {
      data: { record: Record<string, unknown> };
      metadata: Record<string, unknown>;
    };
    expect(JSON.stringify(upstream)).toBe(before);
    expect(envelope.data.record.description).toMatch(/\.\.\.\[truncated \d+ characters\]$/);
    expect(envelope.data.record.close_notes).toMatch(/\.\.\.\[truncated \d+ characters\]$/);
    expect(envelope.metadata).toMatchObject({
      truncation: { truncated: true, reason: "byte_limit" },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(1000);
  });

  it("leaves records under the default budget byte-identical (no guard keys)", async () => {
    const record = { sys_id: "abc", state: "2", description: "short" };
    const { client } = getClient(record);
    const result = await getHandler(
      getSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111", fields: "sys_id,state,description" }),
      client,
      config
    );
    expect(parseText(result)).toEqual(record);
  });

  it("leaves an explicitly-sized but fitting record untouched", async () => {
    const record = { sys_id: "abc", description: "x".repeat(100) };
    const { client } = getClient(record);
    const result = await getHandler(
      getSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111", fields: "sys_id,description", max_response_bytes: 1000 }),
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
    const g = getSchema.parse({ table: "incident", sys_id: "11111111111111111111111111111111" });
    expect(g.response_format).toBe("concise");
    expect(g.max_response_bytes).toBe(100000);
  });

  it("rejects response_format outside the enum on both tools", () => {
    expect(
      querySchema.safeParse({ table: "incident", response_format: "verbose" }).success
    ).toBe(false);
    expect(
      getSchema.safeParse({
        table: "incident",
        sys_id: "11111111111111111111111111111111",
        response_format: "full",
      }).success
    ).toBe(false);
  });

  it("bounds max_response_bytes to [1000, 1000000] integers", () => {
    for (const [schema, base] of [
      [querySchema, { table: "incident" }],
      [
        getSchema,
        { table: "incident", sys_id: "11111111111111111111111111111111" },
      ],
    ] as const) {
      expect(schema.safeParse({ ...base, max_response_bytes: 999 }).success).toBe(false);
      expect(schema.safeParse({ ...base, max_response_bytes: 1000 }).success).toBe(true);
      expect(schema.safeParse({ ...base, max_response_bytes: 1000000 }).success).toBe(true);
      expect(schema.safeParse({ ...base, max_response_bytes: 1000001 }).success).toBe(false);
      expect(schema.safeParse({ ...base, max_response_bytes: 1500.5 }).success).toBe(false);
    }
  });

  it("keeps discovery descriptions on the authoritative Zod schemas", () => {
    for (const schema of [querySchema, getSchema]) {
      expect(schema.shape.response_format.description).toContain("concise");
      expect(schema.shape.response_format.description).toContain("Ignored when fields");
      expect(schema.shape.max_response_bytes.description).toContain("100000");
    }
  });
});
