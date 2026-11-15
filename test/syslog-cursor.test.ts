import { afterEach, describe, expect, it } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { handler, schema } from "../src/tools/syslog.js";
import {
  decodeTailCursor,
  encodeTailCursor,
  hashTailFilters,
  MAX_CURSOR_LENGTH,
} from "../src/tools/syslog-cursor.js";
import { callError, closeHarnesses, harness, type Harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

/**
 * A synthetic syslog. `upstream` answers a Table API read the way the
 * instance reads the three query shapes sn_syslog sends: AND of conditions,
 * with `^OR<cond>` joining the condition before it, `>=`/`>`/`=` compared as
 * text (stored UTC timestamps and hex ids order correctly as text), `LIKE`
 * as a substring test, and ORDERBY / ORDERBYDESC on the named fields.
 */
interface Row {
  sys_id: string;
  sys_created_on: string;
  level: string;
  source: string;
  message: string;
}

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

function id(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function stamp(seconds: number): string {
  const date = new Date(Date.UTC(2026, 10, 15, 12, 0, 0) + seconds * 1000);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function row(n: number, seconds: number, extra: Partial<Row> = {}): Row {
  return {
    sys_id: id(n),
    sys_created_on: stamp(seconds),
    level: "0",
    source: "synthetic",
    message: `entry ${n}`,
    ...extra,
  };
}

function evaluate(rows: readonly Row[], params: Record<string, string>): Row[] {
  const groups: string[][] = [];
  const order: Array<{ field: keyof Row; desc: boolean }> = [];
  for (const token of (params.sysparm_query ?? "").split("^")) {
    if (token.startsWith("ORDERBYDESC")) {
      order.push({ field: token.slice(11) as keyof Row, desc: true });
    } else if (token.startsWith("ORDERBY")) {
      order.push({ field: token.slice(7) as keyof Row, desc: false });
    } else if (token.startsWith("OR")) {
      groups[groups.length - 1]!.push(token.slice(2));
    } else {
      groups.push([token]);
    }
  }
  const holds = (candidate: Row, condition: string): boolean => {
    const match = /^([a-z_]+)(>=|>|=|LIKE)(.*)$/u.exec(condition);
    if (!match) throw new Error(`unreadable condition: ${condition}`);
    const [, field, operator, value] = match as unknown as [string, keyof Row, string, string];
    if (value.startsWith("javascript:")) return true;
    const actual = candidate[field];
    switch (operator) {
      case ">=":
        return actual >= value;
      case ">":
        return actual > value;
      case "=":
        return actual === value;
      default:
        return actual.includes(value);
    }
  };
  const matched = rows.filter((candidate) =>
    groups.every((group) => group.some((condition) => holds(candidate, condition)))
  );
  matched.sort((left, right) => {
    for (const { field, desc } of order) {
      if (left[field] < right[field]) return desc ? 1 : -1;
      if (left[field] > right[field]) return desc ? -1 : 1;
    }
    return 0;
  });
  return matched.slice(0, Number(params.sysparm_limit ?? "1000"));
}

function simulation(initial: readonly Row[] = []) {
  const rows: Row[] = [...initial];
  const reads: Array<{ path: string; params: Record<string, string> }> = [];
  const upstream = async (path: string, params: Record<string, string> | undefined) => {
    reads.push({ path, params: { ...(params ?? {}) } });
    return {
      data: { result: evaluate(rows, params ?? {}) },
      status: 200,
      headers: new Headers(),
    };
  };
  return { rows, reads, upstream };
}

function directClient(simulated: ReturnType<typeof simulation>) {
  return {
    getWithMeta: async (path: string, params?: Record<string, string>) =>
      simulated.upstream(path, params),
  } as unknown as ServiceNowClient;
}

interface Page {
  record_count: number;
  has_more: boolean;
  cursor?: string;
  hint?: string;
  total?: number;
  next_offset?: number;
  results: Array<{ sys_id: string; timestamp: string }>;
}

async function direct(
  simulated: ReturnType<typeof simulation>,
  args: Record<string, unknown>
): Promise<Page> {
  const result = await handler(schema.parse(args), directClient(simulated), config, {} as never);
  return JSON.parse(result.content[0]!.text) as Page;
}

const ids = (page: Page): string[] => page.results.map((entry) => entry.sys_id);

describe("sn_syslog tail: the first call and the follow-ups", () => {
  it("returns the newest entries oldest first with a cursor, then only entries created after it", async () => {
    const log = simulation(Array.from({ length: 10 }, (_, n) => row(n + 1, n)));
    const first = await direct(log, { tail: true, limit: 4 });
    expect(ids(first)).toEqual([id(7), id(8), id(9), id(10)]);
    expect(first.has_more).toBe(false);
    expect(first.cursor).toBeDefined();
    expect(first.total).toBeUndefined();
    expect(first.next_offset).toBeUndefined();

    // Nothing new yet: no rows, and the same position comes back (re-issued, not echoed).
    const quiet = await direct(log, { after_cursor: first.cursor });
    expect(quiet.results).toEqual([]);
    expect(quiet.has_more).toBe(false);
    expect(decodeTailCursor(quiet.cursor)).toEqual(decodeTailCursor(first.cursor));

    log.rows.push(row(11, 10), row(12, 11));
    const second = await direct(log, { after_cursor: quiet.cursor });
    expect(ids(second)).toEqual([id(11), id(12)]);
    const third = await direct(log, { after_cursor: second.cursor });
    expect(third.results).toEqual([]);
    expect(ids(await direct(log, { after_cursor: third.cursor }))).toEqual([]);
  });

  it("has no cursor when the window holds nothing, and says to call again", async () => {
    const empty = await direct(simulation(), { tail: true });
    expect(empty.results).toEqual([]);
    expect(empty.cursor).toBeUndefined();
    expect(empty.hint).toContain("tail=true");
  });

  it("never skips or repeats an entry when many share one second", async () => {
    // 60 entries in one second, then 20 in the next, ids shuffled so that
    // creation order and id order disagree.
    const sameSecond = Array.from({ length: 60 }, (_, n) => row(((n * 37) % 61) + 1, 5));
    const nextSecond = Array.from({ length: 20 }, (_, n) => row(100 + ((n * 11) % 23), 6));
    const log = simulation([row(500, 4), ...sameSecond, ...nextSecond]);
    const everything = [...log.rows]
      .sort((a, b) =>
        a.sys_created_on === b.sys_created_on
          ? a.sys_id.localeCompare(b.sys_id)
          : a.sys_created_on.localeCompare(b.sys_created_on)
      )
      .map((entry) => entry.sys_id);

    // Start the tail at the one entry before the burst, then read the rest 7 at a time.
    const start = await direct(log, { tail: true, limit: 1, since: 60 });
    // The newest is in the last second; rewind to the entry before the burst.
    const origin = encodeTailCursor({
      timestamp: stamp(4),
      sysId: id(500),
      filter: hashTailFilters({}),
    });
    expect(start.cursor).toBeDefined();
    const seen: string[] = [];
    let cursor: string | undefined = origin;
    let pages = 0;
    do {
      const page: Page = await direct(log, { after_cursor: cursor, limit: 7 });
      seen.push(...ids(page));
      expect(page.record_count).toBe(page.results.length);
      expect(page.record_count).toBeLessThanOrEqual(7);
      cursor = page.cursor;
      pages += 1;
      if (!page.has_more) break;
    } while (pages < 50);
    expect(seen).toEqual(everything.slice(1));
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBe(Math.ceil(80 / 7));
  });

  it("delivers a row that arrives in the cursor's own second with a later id", async () => {
    const log = simulation([row(1, 0), row(5, 0)]);
    const first = await direct(log, { tail: true });
    expect(ids(first)).toEqual([id(1), id(5)]);
    log.rows.push(row(9, 0));
    expect(ids(await direct(log, { after_cursor: first.cursor }))).toEqual([id(9)]);
  });

  it("reports has_more and continues from the last row returned", async () => {
    const log = simulation(Array.from({ length: 10 }, (_, n) => row(n + 1, n)));
    const origin = encodeTailCursor({
      timestamp: stamp(-1),
      sysId: id(0),
      filter: hashTailFilters({}),
    });
    const first = await direct(log, { after_cursor: origin, limit: 4 });
    expect(ids(first)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(first.has_more).toBe(true);
    expect(first.hint).toContain("after_cursor");
    expect(first.next_offset).toBeUndefined();
    const second = await direct(log, { after_cursor: first.cursor, limit: 4 });
    expect(ids(second)).toEqual([id(5), id(6), id(7), id(8)]);
    expect(second.has_more).toBe(true);
    const third = await direct(log, { after_cursor: second.cursor, limit: 4 });
    expect(ids(third)).toEqual([id(9), id(10)]);
    expect(third.has_more).toBe(false);
  });

  it("is exact at the limit: a full page with nothing behind it is not has_more", async () => {
    const log = simulation(Array.from({ length: 4 }, (_, n) => row(n + 1, n)));
    const origin = encodeTailCursor({
      timestamp: stamp(-1),
      sysId: id(0),
      filter: hashTailFilters({}),
    });
    const page = await direct(log, { after_cursor: origin, limit: 4 });
    expect(page.record_count).toBe(4);
    expect(page.has_more).toBe(false);
  });
});

describe("sn_syslog tail: what is sent upstream", () => {
  it("sends the cursor position as a UTC literal, with no time-zone formatting", async () => {
    const log = simulation([row(1, 0)]);
    const cursor = encodeTailCursor({
      timestamp: "2026-11-15 12:00:07",
      sysId: id(3),
      filter: hashTailFilters({ level: "2", source: "mid" }),
    });
    await direct(log, { after_cursor: cursor, level: "error", source: "mid", limit: 5 });
    expect(log.reads).toHaveLength(1);
    expect(log.reads[0]!.path).toBe("/api/now/table/syslog");
    expect(log.reads[0]!.params).toEqual({
      sysparm_query:
        "level=2^sourceLIKEmid^sys_created_on>=2026-11-15 12:00:07" +
        `^sys_created_on>2026-11-15 12:00:07^ORsys_id>${id(3)}` +
        "^ORDERBYsys_created_on^ORDERBYsys_id",
      sysparm_limit: "6",
      sysparm_display_value: "false",
      sysparm_no_count: "true",
      sysparm_fields: "sys_id,level,source,message,sys_created_on",
    });
    expect(log.reads[0]!.params.sysparm_query).not.toMatch(/dateGenerate|gs\.(?!minutesAgoStart)|T\d\d:/u);
  });

  it("starts a tail with the same window and newest-first order as a read, and no count", async () => {
    const log = simulation([row(1, 0)]);
    await direct(log, { tail: true, since: 15, limit: 3, message: "boom" });
    expect(log.reads[0]!.params.sysparm_query).toBe(
      "messageLIKEboom^sys_created_on>=javascript:gs.minutesAgoStart(15)" +
        "^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id"
    );
    expect(log.reads[0]!.params.sysparm_limit).toBe("3");
    expect(log.reads[0]!.params.sysparm_no_count).toBe("true");
  });

  it("leaves a read without a cursor exactly as it was", async () => {
    const log = simulation([row(1, 0), row(2, 1)]);
    const page = await direct(log, { limit: 10, offset: 0, since: 30 });
    expect(log.reads[0]!.params).toEqual({
      sysparm_query:
        "sys_created_on>=javascript:gs.minutesAgoStart(30)^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id",
      sysparm_limit: "10",
      sysparm_fields: "sys_id,level,source,message,sys_created_on",
      sysparm_offset: "0",
    });
    expect(ids(page)).toEqual([id(2), id(1)]);
    expect(page.cursor).toBeUndefined();
  });
});

describe("sn_syslog tail: strict cursor handling", () => {
  const good = encodeTailCursor({
    timestamp: "2026-11-15 12:00:07",
    sysId: id(3),
    filter: hashTailFilters({}),
  });

  it("issues a compact, URL-safe cursor and reads it back", () => {
    expect(good).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(good.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
    expect(decodeTailCursor(good)).toEqual({
      timestamp: "2026-11-15 12:00:07",
      sysId: id(3),
      filter: hashTailFilters({}),
    });
  });

  const bytes = (text: string) => Buffer.from(text, "utf8").toString("base64url");
  const tampered: Array<[string, unknown]> = [
    ["a changed character", `${good.slice(0, 20)}${good[20] === "A" ? "B" : "A"}${good.slice(21)}`],
    ["a truncated token", good.slice(0, -4)],
    ["padding", `${good}=`],
    ["an empty string", ""],
    ["whitespace", ` ${good}`],
    ["plain text", "2026-11-15 12:00:07"],
    ["injected query syntax", bytes("1|20261115120007|^ORDERBYDESCsys_id|00000000|000000")],
    ["a wrong version", bytes("2|20261115120007|" + id(3) + "|00000000|000000")],
    ["a wrong checksum", bytes("1|20261115120007|" + id(3) + `|${hashTailFilters({})}|000000`)],
    ["a number", 7],
    ["an object", { cursor: good }],
  ];
  it.each(tampered)("refuses %s", (_name, value) => {
    expect(decodeTailCursor(value)).toBeUndefined();
    expect(schema.safeParse({ after_cursor: value }).success).toBe(false);
  });

  it("refuses an impossible date even with a matching checksum", () => {
    expect(() =>
      encodeTailCursor({ timestamp: "2026-02-30 12:00:00", sysId: id(3), filter: hashTailFilters({}) })
    ).toThrow();
  });

  it.each([MAX_CURSOR_LENGTH + 1, 1000, 100_000])("refuses an oversized cursor (%i characters)", (length) => {
    const parsed = schema.safeParse({ after_cursor: "A".repeat(length) });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain("AAAA");
  });

  it("refuses offset together with a tail, and keeps it for a plain read", async () => {
    const log = simulation([row(1, 0)]);
    for (const args of [{ tail: true, offset: 5 }, { after_cursor: good, offset: 0 }]) {
      await expect(direct(log, args)).rejects.toThrow(/offset cannot be used with tail/u);
    }
    expect(log.reads).toHaveLength(0);
    expect(schema.safeParse({ offset: 5 }).success).toBe(true);
  });

  it("rejects a bad cursor at the handler too, with a fixed message that never echoes it", async () => {
    const log = simulation([row(1, 0)]);
    const hostile = `${good.slice(0, 30)}!secret-looking-text`;
    const result = await handler(
      { ...schema.parse({}), after_cursor: hostile } as never,
      directClient(log),
      config,
      {} as never
    ).catch((error: unknown) => error as Error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("after_cursor cannot be used");
    expect((result as Error).message).not.toContain("secret-looking-text");
    expect((result as Error).message).not.toContain(hostile);
    expect(log.reads).toHaveLength(0);
  });

  it("binds a cursor to its filters: a different level, source or message is refused", async () => {
    const log = simulation([row(1, 0, { level: "2", source: "mid", message: "disk full" })]);
    const started = await direct(log, { tail: true, level: "error", source: "mid" });
    expect(started.cursor).toBeDefined();
    log.reads.length = 0;
    for (const changed of [
      {},
      { level: "warning", source: "mid" },
      { level: "error" },
      { level: "error", source: "mid", message: "full" },
      { level: "error", source: "other" },
    ]) {
      await expect(direct(log, { after_cursor: started.cursor, ...changed })).rejects.toThrow(
        /after_cursor cannot be used/u
      );
    }
    expect(log.reads).toHaveLength(0);
    // The same filters work, in either spelling of the level, and since does not matter.
    for (const same of [{ level: "error" }, { level: "2" }, { level: "error", since: 5 }]) {
      const page = await direct(log, { after_cursor: started.cursor, source: "mid", ...same });
      expect(page.results).toEqual([]);
    }
  });
});

describe("sn_syslog tail through the server", () => {
  const grant = (table: string) => ({
    readTables: [table],
    targets: [
      {
        table,
        kind: "canonical" as const,
        tools: ["sn_syslog"],
        closureComplete: true,
        relatedTables: [table],
      },
    ],
  });
  const readOnly = { tableAccess: grant("syslog") };

  async function call(connected: Harness, args: Record<string, unknown>) {
    const result = await connected.client.callTool({
      name: "sn_syslog",
      arguments: { profile: "p", ...args },
    });
    expect(result.isError).toBeUndefined();
    return result.structuredContent as {
      data: Page;
      metadata: {
        pagination: { mode: string; next_offset?: number };
        truncation: { truncated: boolean; dropped_records?: number };
        record_count: number;
        cache?: string;
      };
    };
  }

  it("lists the two new inputs and the cursor in the output schema", async () => {
    const connected = await harness([], readOnly);
    const { tools } = await connected.client.listTools();
    const tool = tools.find((candidate) => candidate.name === "sn_syslog")!;
    const properties = tool.inputSchema.properties as Record<string, { type?: string; maxLength?: number }>;
    expect(properties.tail?.type).toBe("boolean");
    expect(properties.after_cursor?.type).toBe("string");
    expect(properties.after_cursor?.maxLength).toBe(MAX_CURSOR_LENGTH);
    const data = (tool.outputSchema as { properties: { data: { properties: Record<string, unknown> } } })
      .properties.data.properties;
    expect(Object.keys(data)).toContain("cursor");
  });

  it("tails over the MCP boundary and carries no offset for the next page", async () => {
    const log = simulation(Array.from({ length: 12 }, (_, n) => row(n + 1, n)));
    const connected = await harness([], { ...readOnly, upstream: log.upstream });
    const first = await call(connected, { tail: true, limit: 3 });
    expect(ids(first.data)).toEqual([id(10), id(11), id(12)]);
    expect(first.metadata.pagination).toEqual({ mode: "none" });
    expect(first.data.next_offset).toBeUndefined();
    log.rows.push(...Array.from({ length: 5 }, (_, n) => row(20 + n, 20 + n)));
    const second = await call(connected, { after_cursor: first.data.cursor, limit: 3 });
    expect(ids(second.data)).toEqual([id(20), id(21), id(22)]);
    expect(second.data.has_more).toBe(true);
    expect(second.metadata.pagination).toEqual({ mode: "none" });
    expect(second.data.next_offset).toBeUndefined();
    const third = await call(connected, { after_cursor: second.data.cursor, limit: 3 });
    expect(ids(third.data)).toEqual([id(23), id(24)]);
    expect(third.data.has_more).toBe(false);
  });

  it("rejects a tampered, oversized or mismatched cursor with a fixed message and no echo", async () => {
    const log = simulation([row(1, 0)]);
    const connected = await harness([], { ...readOnly, upstream: log.upstream });
    const first = await call(connected, { tail: true });
    const secret = "zzSECRETzz";
    const bad = [
      `${first.data.cursor!.slice(0, 40)}${secret}`,
      "A".repeat(5000 + secret.length),
      `${secret}`,
    ];
    for (const value of bad) {
      const message = await callError(connected, "sn_syslog", { after_cursor: value });
      expect(message).not.toContain(secret);
      expect(message).not.toContain(value.slice(0, 40));
      expect(message.length).toBeLessThan(600);
    }
    const mismatch = await callError(connected, "sn_syslog", {
      after_cursor: first.data.cursor,
      level: "error",
    });
    expect(mismatch).toContain("after_cursor cannot be used");
    expect(mismatch).not.toContain(first.data.cursor!);
    const offset = await callError(connected, "sn_syslog", { tail: true, offset: 3 });
    expect(offset).toContain("offset cannot be used with tail or after_cursor");
  });

  it("never reads or writes the metadata cache, even when syslog is a cached table", async () => {
    const log = simulation([row(1, 0), row(2, 1)]);
    const connected = await harness([], {
      ...readOnly,
      instance: "https://syslog-cursor-cache.service-now.com",
      metadataCache: { tables: ["syslog"], smallReadBytes: 0 },
      upstream: log.upstream,
    });
    const first = await call(connected, { tail: true });
    log.rows.push(row(3, 2));
    const second = await call(connected, { after_cursor: first.data.cursor });
    expect(ids(second.data)).toEqual([id(3)]);
    const third = await call(connected, { after_cursor: second.data.cursor });
    expect(third.data.results).toEqual([]);
    // One read per call: no watermark read, and the repeat saw the new row.
    expect(log.reads).toHaveLength(3);
    expect(log.reads.every((read) => read.params.sysparm_query?.includes("ORDERBY"))).toBe(true);
    expect(log.reads.some((read) => read.params.sysparm_query === "ORDERBYDESCsys_updated_on")).toBe(false);
    for (const page of [first, second, third]) expect(page.metadata.cache).toBeUndefined();
    // Asked twice with the same cursor, the answer follows the log.
    const again = await call(connected, { after_cursor: first.data.cursor });
    expect(ids(again.data)).toEqual([id(3)]);
    log.rows.push(row(4, 3));
    expect(ids((await call(connected, { after_cursor: first.data.cursor })).data)).toEqual([id(3), id(4)]);
  });

  it("applies the same table and field policy as a read", async () => {
    const log = simulation([row(1, 0)]);
    // Not granted: refused before any read.
    const denied = await harness([], { tableAccess: grant("incident"), upstream: log.upstream });
    expect(await callError(denied, "sn_syslog", { tail: true })).toMatch(/denied|not allow|policy/iu);
    expect(log.reads).toHaveLength(0);

    // `fields` narrows the rows but a tail still carries its position.
    const narrowed = await harness([], { ...readOnly, upstream: log.upstream });
    const page = await call(narrowed, { tail: true, fields: "message" });
    expect(page.data.results[0]?.sys_id).toBe(id(1));
    expect(log.reads.at(-1)!.params.sysparm_fields?.split(",").sort()).toEqual(
      ["message", "sys_created_on", "sys_id"]
    );

    // A policy that does not let the profile read the position fields refuses a tail,
    // and still serves a plain read.
    const withheld = await harness([], {
      ...readOnly,
      upstream: log.upstream,
      fieldPolicy: { syslog: { readable: ["level", "source", "message"] } },
    });
    const refusal = await callError(withheld, "sn_syslog", { tail: true });
    expect(refusal).toContain("fieldPolicy.syslog.readable");
    const plain = await withheld.client.callTool({
      name: "sn_syslog",
      arguments: { profile: "p", fields: "message" },
    });
    expect(plain.isError).toBeUndefined();
  });

  it("keeps the cursor in step when the response limit drops rows, and loses nothing", async () => {
    const wide = "x".repeat(299);
    const log = simulation(Array.from({ length: 700 }, (_, n) => row(n + 1, n, { message: wide })));
    const connected = await harness([], { ...readOnly, upstream: log.upstream });
    const start = encodeTailCursor({
      timestamp: stamp(-1),
      sysId: id(0),
      filter: hashTailFilters({}),
    });
    const seen: string[] = [];
    let cursor: string | undefined = start;
    let fitted = 0;
    for (let turn = 0; turn < 20; turn += 1) {
      const page = await call(connected, { after_cursor: cursor, limit: 1000 });
      if (page.metadata.truncation.truncated) {
        fitted += 1;
        expect(page.data.has_more).toBe(true);
        expect(page.metadata.truncation.dropped_records).toBeGreaterThan(0);
        expect(page.data.record_count).toBe(page.data.results.length);
      }
      seen.push(...ids(page.data));
      // The cursor is the last row actually returned.
      if (page.data.results.length > 0) {
        expect(decodeTailCursor(page.data.cursor)?.sysId).toBe(page.data.results.at(-1)!.sys_id);
      }
      cursor = page.data.cursor;
      if (!page.data.has_more) break;
    }
    expect(fitted).toBeGreaterThan(0);
    expect(seen).toEqual(Array.from({ length: 700 }, (_, n) => id(n + 1)));
  });

  it("drops the cursor when not one row fits, and says what to change", async () => {
    const log = simulation([row(1, 0, { source: "s".repeat(120_000) }), row(2, 1)]);
    const connected = await harness([], { ...readOnly, upstream: log.upstream });
    const start = encodeTailCursor({
      timestamp: stamp(-1),
      sysId: id(0),
      filter: hashTailFilters({}),
    });
    const page = await call(connected, { after_cursor: start, limit: 5 });
    expect(page.data.results).toEqual([]);
    expect(page.data.has_more).toBe(true);
    expect(page.data.cursor).toBeUndefined();
    expect(page.data.hint).toContain("lower limit");
  });
});

describe("sn_syslog tail: the cursor module", () => {
  it("is deterministic and binds every part", () => {
    const base = { timestamp: "2026-11-15 12:00:07", sysId: id(3), filter: hashTailFilters({}) };
    expect(encodeTailCursor(base)).toBe(encodeTailCursor({ ...base }));
    expect(encodeTailCursor(base)).not.toBe(encodeTailCursor({ ...base, sysId: id(4) }));
    expect(encodeTailCursor(base)).not.toBe(encodeTailCursor({ ...base, timestamp: "2026-11-15 12:00:08" }));
    expect(hashTailFilters({ level: "2" })).not.toBe(hashTailFilters({ level: "1" }));
    expect(hashTailFilters({ source: "a" })).not.toBe(hashTailFilters({ message: "a" }));
  });
});

