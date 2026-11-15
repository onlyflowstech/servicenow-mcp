/**
 * A filter or order on a field the table does not have is refused.
 *
 * ServiceNow drops a condition on a column it does not know, so without this a
 * misspelt field returns unrelated rows. The check asks for the filter's own
 * fields on the read that is made anyway and refuses when no returned row
 * carries one. These tests run the real tools against a stand-in table that
 * answers like ServiceNow: it ignores the query, and returns only the columns
 * it has among those asked for.
 */
import { afterEach, describe, expect, it } from "vitest";

import { SUPPORTED_ENCODED_QUERY_OPERATORS } from "../src/encoded-query-policy.js";
import { ServiceNowResponseTooLargeError } from "../src/client.js";
import { createUnknownFilterFieldError } from "../src/tool-error.js";
import {
  echoFilterFields,
  firstMissingFilterField,
} from "../src/unknown-filter-fields.js";
import {
  closeHarnesses,
  harness,
  type Harness,
} from "./structured-filter-harness.js";

afterEach(closeHarnesses);

const SYS_ID_1 = "1".repeat(32);
const SYS_ID_2 = "2".repeat(32);
const SYS_ID_3 = "3".repeat(32);

type Row = Record<string, unknown>;

/**
 * A table. `rows` hold every stored value; `columns` are the ones this user can
 * see. A column that is not in `columns` (it does not exist, or an ACL hides
 * it) is left out of the row even when asked for. Like ServiceNow it never
 * rejects a condition it does not know, so every row comes back.
 */
function table(columns: readonly string[], rows: readonly Row[]) {
  return (params: Record<string, string> | undefined): Row[] => {
    const asked = params?.sysparm_fields?.split(",");
    const limit = Number(params?.sysparm_limit ?? rows.length);
    return rows.slice(0, limit).map((row) => {
      const out: Row = {};
      for (const column of asked ?? columns) {
        if (columns.includes(column)) out[column] = row[column] ?? "";
      }
      return out;
    });
  };
}

const INCIDENT_COLUMNS = ["sys_id", "number", "short_description", "active", "state", "priority"] as const;
const INCIDENT_ROWS: Row[] = [
  { sys_id: SYS_ID_1, number: "INC1", short_description: "one", active: "true", state: "1", priority: "2" },
  { sys_id: SYS_ID_2, number: "INC2", short_description: "two", active: "true", state: "2", priority: "3" },
  { sys_id: SYS_ID_3, number: "INC3", short_description: "three", active: "false", state: "7", priority: "4" },
];

const ACTIVE = { type: "equality", field: "active", operator: "eq", value: true } as const;
const NONSENSE = { type: "text", field: "zzz_not_a_field", operator: "contains", value: "qq" } as const;
const group = (operator: "and" | "or", ...conditions: unknown[]) => ({ type: "group", operator, conditions });

/** A read harness whose upstream is `answer`; every request is recorded. */
async function readHarness(answer: (params: Record<string, string> | undefined) => unknown[]) {
  const connected = await harness([], {
    upstream: async (_path, params) => ({
      data: { result: answer(params) },
      status: 200,
      headers: new Headers(),
    }),
  });
  return connected;
}

async function query(connected: Harness, args: Record<string, unknown>) {
  const result = await connected.client.callTool({
    name: "sn_query",
    arguments: { profile: "p", table: "incident", ...args },
  });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  const data = (result.structuredContent as { data?: { results?: Row[]; record_count?: number } } | undefined)?.data;
  return { result, text, data };
}

const sentFields = (connected: Harness, call = 0) =>
  (connected.getWithMeta.mock.calls[call] as unknown as [string, Record<string, string>])[1].sysparm_fields;

const MISSING = /not found on the table, or is not readable by this user/u;

describe("sn_query refuses a filter on a field the table does not have", () => {
  it("refuses a misspelt field, names it, and returns no rows", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result, text } = await query(connected, {
      fields: "sys_id,number",
      structured_query: { filter: NONSENSE },
    });
    expect(result.isError).toBe(true);
    expect(text).toMatch(MISSING);
    expect(text).toContain('"zzz_not_a_field"');
    expect(text).not.toContain("INC1");
    expect(result.structuredContent).toBeUndefined();
  });

  it("sends one upstream request, extended by the filter's field only", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    await query(connected, { fields: "sys_id,number", structured_query: { filter: NONSENSE } });
    expect(connected.getWithMeta).toHaveBeenCalledTimes(1);
    expect(connected.get).not.toHaveBeenCalled();
    expect(sentFields(connected)).toBe("sys_id,number,zzz_not_a_field");
  });

  it("a real field works with one request, and the extra column is not in the result", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result, data, text } = await query(connected, {
      fields: "sys_id,number",
      structured_query: { filter: ACTIVE },
    });
    expect(result.isError).toBeUndefined();
    expect(connected.getWithMeta).toHaveBeenCalledTimes(1);
    expect(connected.get).not.toHaveBeenCalled();
    expect(sentFields(connected)).toBe("sys_id,number,active");
    expect(data?.record_count).toBe(3);
    for (const row of data?.results ?? []) {
      expect(Object.keys(row).sort()).toEqual(["number", "sys_id"]);
    }
    expect(text).not.toContain('"active"');
  });

  it("adds nothing when the caller already selects the filter's field", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result, data } = await query(connected, {
      fields: "sys_id,active",
      structured_query: { filter: ACTIVE },
    });
    expect(result.isError).toBeUndefined();
    expect(sentFields(connected)).toBe("sys_id,active");
    expect(data?.results?.[0]).toEqual({ sys_id: SYS_ID_1, active: "true" });
  });

  it("asks for each filter field once, in order, with the order field after the filter", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    await query(connected, {
      fields: "sys_id",
      structured_query: {
        filter: group("and", ACTIVE, { type: "equality", field: "active", operator: "eq", value: false }),
        order_by: [{ field: "priority", direction: "asc" }],
      },
    });
    expect(sentFields(connected)).toBe("sys_id,active,priority");
  });

  it("does not extend a read that asks for every column", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    // The default selection is a finite list, so name the wildcard explicitly.
    const { result } = await query(connected, {
      fields: "all",
      structured_query: { filter: ACTIVE },
    });
    expect(result.isError).toBeUndefined();
    expect(connected.getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("is a refusal with a field the user cannot see, in the same words", async () => {
    // `state` exists but an ACL hides it from this user: it is left out of the row.
    const connected = await readHarness(
      table(INCIDENT_COLUMNS.filter((column) => column !== "state"), INCIDENT_ROWS)
    );
    const { result, text } = await query(connected, {
      fields: "sys_id",
      structured_query: { filter: { type: "equality", field: "state", operator: "eq", value: "1" } },
    });
    expect(result.isError).toBe(true);
    expect(text).toMatch(MISSING);
    expect(text).toContain('"state"');
  });

  it("refuses an unknown field in an order_by", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result, text } = await query(connected, {
      fields: "sys_id",
      structured_query: {
        filter: ACTIVE,
        order_by: [{ field: "zzz_sort_key", direction: "desc" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(text).toContain('"zzz_sort_key"');
  });

  it("refuses an unknown field in a list filter (implicit AND)", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result, text } = await query(connected, {
      fields: "sys_id",
      structured_query: { filter: [ACTIVE, NONSENSE] },
    });
    expect(result.isError).toBe(true);
    expect(text).toContain('"zzz_not_a_field"');
  });

  it("refuses an unknown field inside nested groups and an OR group", async () => {
    const nested = group("and", ACTIVE, group("or", { ...ACTIVE, field: "state" }, group("and", ACTIVE, NONSENSE)));
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result, text } = await query(connected, { fields: "sys_id", structured_query: { filter: nested } });
    expect(result.isError).toBe(true);
    expect(text).toContain('"zzz_not_a_field"');
    expect(sentFields(connected)).toBe("sys_id,active,state,zzz_not_a_field");
  });

  it("names the first missing field when several are", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { text } = await query(connected, {
      fields: "sys_id",
      structured_query: {
        filter: [ACTIVE, { ...NONSENSE, field: "zzz_first" }, { ...NONSENSE, field: "zzz_second" }],
      },
    });
    expect(text).toContain('"zzz_first"');
    expect(text).not.toContain("zzz_second");
  });

  it("accepts a nested filter whose every field exists", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result, data } = await query(connected, {
      fields: "sys_id",
      structured_query: {
        filter: group("and", ACTIVE, group("or", { ...ACTIVE, field: "state" }, { ...ACTIVE, field: "priority" })),
        order_by: [{ field: "number", direction: "asc" }],
      },
    });
    expect(result.isError).toBeUndefined();
    expect(data?.record_count).toBe(3);
    expect(sentFields(connected)).toBe("sys_id,active,state,priority,number");
  });

  it("returns an empty page for zero rows without refusing: there is nothing to check", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, []));
    const { result, data } = await query(connected, {
      fields: "sys_id",
      structured_query: { filter: NONSENSE },
    });
    expect(result.isError).toBeUndefined();
    expect(data?.record_count).toBe(0);
    expect(connected.getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("does not take a field with an empty value for a missing one", async () => {
    // ServiceNow returns an existing column as "" when it has no value.
    const connected = await readHarness(
      table(INCIDENT_COLUMNS, [{ sys_id: SYS_ID_1, active: "true" }])
    );
    const { result } = await query(connected, {
      fields: "sys_id",
      structured_query: { filter: { type: "null", field: "short_description", operator: "is_null" } },
    });
    expect(result.isError).toBeUndefined();
  });

  it("counts a field as present when any returned row carries it, not only the first", async () => {
    // A field-level rule that depends on the record can hide a real column on
    // some rows: here only the third row shows `state`.
    const connected = await readHarness((params) => {
      const rows = table(INCIDENT_COLUMNS, INCIDENT_ROWS)(params);
      delete rows[0]!.state;
      delete rows[1]!.state;
      return rows;
    });
    const { result } = await query(connected, {
      fields: "sys_id",
      structured_query: { filter: { type: "equality", field: "state", operator: "eq", value: "7" } },
    });
    expect(result.isError).toBeUndefined();
  });

  it("also checks the page after the first (offset), using the same request", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result } = await query(connected, {
      fields: "sys_id",
      offset: 1,
      limit: 1,
      structured_query: { filter: NONSENSE },
    });
    expect(result.isError).toBe(true);
    expect(connected.getWithMeta).toHaveBeenCalledTimes(1);
  });

  it("checks the sentinel row too, so a one-row page still reveals the field", async () => {
    // limit 1 asks upstream for two rows; the field is only on the second.
    const connected = await readHarness((params) => {
      const rows = table(INCIDENT_COLUMNS, INCIDENT_ROWS)(params);
      delete rows[0]!.state;
      return rows;
    });
    const { result } = await query(connected, {
      fields: "sys_id",
      limit: 1,
      structured_query: { filter: { type: "equality", field: "state", operator: "eq", value: "2" } },
    });
    expect(result.isError).toBeUndefined();
  });

  it("does not echo a field name that is not canonical", () => {
    const error = createUnknownFilterFieldError('x"; drop <b>' + "a".repeat(500));
    expect(error.message).toContain("A filter or order field was not found");
    expect(error.message).not.toContain("drop");
    expect(createUnknownFilterFieldError("a".repeat(81)).message).not.toContain("aaaa");
    expect(createUnknownFilterFieldError("Caller_ID").message).toContain("A filter or order field");
    expect(createUnknownFilterFieldError("caller_id.name").message).toContain('"caller_id.name"');
  });

  it("answers a size failure on the extended read with a fixed message", async () => {
    const connected = await harness([], {
      upstream: async () => {
        throw new ServiceNowResponseTooLargeError("cumulative upstream response exceeds configured byte limit");
      },
    });
    const extended = await query(connected, { fields: "sys_id", structured_query: { filter: ACTIVE } });
    expect(extended.result.isError).toBe(true);
    expect(extended.text).toContain("too large once the fields used by the filter were included");
    const plain = await query(connected, { fields: "sys_id,active", structured_query: { filter: ACTIVE } });
    expect(plain.result.isError).toBe(true);
    expect(plain.text).not.toContain("once the fields used by the filter");
  });

  it("leaves a raw encoded query alone: nothing is added and nothing is checked", async () => {
    const connected = await harness([], {
      encodedQueryAccess: {
        rules: [
          {
            tool: "sn_query",
            table: "sys_script_include",
            maxLength: 512,
            maxTerms: 8,
            fields: ["sys_id", "name"],
            operators: SUPPORTED_ENCODED_QUERY_OPERATORS,
            maxLimit: 100,
            maxOffset: 1_000,
            maxResponseBytes: 5000,
          },
        ],
      },
      // No row carries `name`, which the query filters on.
      upstream: async () => ({
        data: { result: [{ sys_id: SYS_ID_1 }] },
        status: 200,
        headers: new Headers(),
      }),
    });
    const result = await connected.client.callTool({
      name: "sn_query",
      arguments: {
        profile: "p",
        table: "sys_script_include",
        query: "nameSTARTSWITHInclude",
        fields: "sys_id,name",
        max_response_bytes: 5000,
      },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(sentFields(connected)).toBe("sys_id,name");
  });

  it("still rejects a dot-walked name in structured_query, as before", async () => {
    const connected = await readHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const { result, text } = await query(connected, {
      fields: "sys_id",
      structured_query: {
        filter: { type: "text", field: "caller_id.name", operator: "contains", value: "a" },
      },
    });
    expect(result.isError).toBe(true);
    expect(text).not.toMatch(MISSING);
    expect(connected.getWithMeta).not.toHaveBeenCalled();
  });
});

describe("the helper", () => {
  it("keeps the caller's selection first and adds only what is missing", () => {
    expect(echoFilterFields("sys_id,number", ["number", "active", "active", "state"])).toEqual({
      sysparmFields: "sys_id,number,active,state",
      probe: ["number", "active", "state"],
      extended: true,
    });
    expect(echoFilterFields("sys_id,active", ["active"])).toMatchObject({
      sysparmFields: "sys_id,active",
      extended: false,
    });
  });

  it("looks for a dot-walked field under its dotted key", () => {
    const echo = echoFilterFields("sys_id", ["caller_id.name", "active"]);
    expect(echo.sysparmFields).toBe("sys_id,caller_id.name,active");
    expect(firstMissingFilterField([{ sys_id: "1", "caller_id.name": "Ada", active: "true" }], echo.probe)).toBeUndefined();
    expect(firstMissingFilterField([{ sys_id: "1", caller_id: "x", active: "true" }], echo.probe)).toBe("caller_id.name");
    // Display values keep the same key.
    expect(
      firstMissingFilterField([{ "caller_id.name": { value: "a", display_value: "A" }, active: "true" }], echo.probe)
    ).toBeUndefined();
  });

  it("cannot check a dot-walked field on a read of every column, and skips it", () => {
    const echo = echoFilterFields(undefined, ["caller_id.name", "active"]);
    expect(echo.sysparmFields).toBeUndefined();
    expect(echo.probe).toEqual(["active"]);
    expect(echo.extended).toBe(false);
  });

  it("ignores a name that is not canonical and an inherited property", () => {
    expect(echoFilterFields("sys_id", ["Bad Name", "__proto__", "toString", "a-b"]).probe).toEqual([]);
    // A row never gets a field from its prototype.
    expect(firstMissingFilterField([{}], ["constructor"])).toBe("constructor");
    expect(firstMissingFilterField([Object.create({ state: "1" })], ["state"])).toBe("state");
  });

  it("has nothing to check without rows, without fields, or when the rows are not records", () => {
    expect(firstMissingFilterField([], ["a"])).toBeUndefined();
    expect(firstMissingFilterField(undefined, ["a"])).toBeUndefined();
    expect(firstMissingFilterField({ result: [] }, ["a"])).toBeUndefined();
    expect(firstMissingFilterField([{ sys_id: "1" }], [])).toBeUndefined();
    expect(firstMissingFilterField([null, "x", 3], ["a"])).toBe("a");
  });
});

/** An sn_batch harness: lookups and sample reads answer from `answer`. */
async function batchHarness(answer: (params: Record<string, string> | undefined) => unknown[]) {
  const connected = await harness();
  connected.get.mockImplementation(async (_path: string, params?: Record<string, string>) => ({
    result: answer(params),
  }));
  return connected;
}

const batch = (connected: Harness, extra: Record<string, unknown> = {}) =>
  connected.client.callTool({
    name: "sn_batch",
    arguments: {
      profile: "p",
      table: "incident",
      action: "update",
      fields: { state: "7" },
      structured_query: { filter: ACTIVE },
      ...extra,
    },
  });

/** No write method was called: assert on every one the harness exposes. */
function expectNoWrites(connected: Harness) {
  expect(connected.patch).not.toHaveBeenCalled();
  expect(connected.put).not.toHaveBeenCalled();
  expect(connected.delete).not.toHaveBeenCalled();
  expect(connected.post).not.toHaveBeenCalled();
}

const textOf = (result: Awaited<ReturnType<typeof batch>>) =>
  (result.content as Array<{ text?: string }>)[0]?.text ?? "";

describe("sn_batch refuses an unknown filter field before it touches anything", () => {
  const nonsense = { structured_query: { filter: NONSENSE } };

  it.each([
    ["update", "dry run", { action: "update", confirm: false }],
    ["update", "confirmed", { action: "update", confirm: true }],
    ["delete", "dry run", { action: "delete", fields: undefined, confirm: false }],
    ["delete", "confirmed", { action: "delete", fields: undefined, confirm: true }],
  ] as const)("%s, %s: no write call, no sample read, one lookup", async (_action, _mode, extra) => {
    const connected = await batchHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const result = await batch(connected, { ...nonsense, ...extra });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(MISSING);
    expect(textOf(result)).toContain('"zzz_not_a_field"');
    expectNoWrites(connected);
    // The lookup only: no sample of rows chosen by an ignored condition.
    expect(connected.get).toHaveBeenCalledTimes(1);
    expect(connected.getWithMeta).not.toHaveBeenCalled();
    expect(connected.get.mock.calls[0]![1]).toMatchObject({
      sysparm_fields: "sys_id,zzz_not_a_field",
    });
  });

  it("refuses an unknown field nested in groups and in an OR", async () => {
    const connected = await batchHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const result = await batch(connected, {
      confirm: true,
      structured_query: { filter: group("and", ACTIVE, group("or", { ...ACTIVE, field: "state" }, NONSENSE)) },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"zzz_not_a_field"');
    expectNoWrites(connected);
  });

  it("refuses an unknown order_by field", async () => {
    const connected = await batchHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const result = await batch(connected, {
      confirm: true,
      structured_query: { filter: ACTIVE, order_by: [{ field: "zzz_sort_key", direction: "asc" }] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"zzz_sort_key"');
    expectNoWrites(connected);
  });

  it("reports a field the user cannot see with the same words", async () => {
    const connected = await batchHarness(
      table(INCIDENT_COLUMNS.filter((column) => column !== "state"), INCIDENT_ROWS)
    );
    const result = await batch(connected, {
      confirm: true,
      structured_query: { filter: { type: "equality", field: "state", operator: "eq", value: "1" } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(MISSING);
    expectNoWrites(connected);
  });

  it("with no rows there is nothing to check, and nothing to write", async () => {
    const connected = await batchHarness(table(INCIDENT_COLUMNS, []));
    const result = await batch(connected, { ...nonsense, confirm: true });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { data: Row }).data).toMatchObject({ matched: 0, processed: 0 });
    expectNoWrites(connected);
    expect(connected.get).toHaveBeenCalledTimes(1);
  });

  it("a dry run with no rows reports zero matches and reads no sample", async () => {
    const connected = await batchHarness(table(INCIDENT_COLUMNS, []));
    const result = await batch(connected, { ...nonsense, confirm: false });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { data: Row }).data).toMatchObject({ matched: 0, dry_run: true });
    expect(connected.get).toHaveBeenCalledTimes(1);
    expectNoWrites(connected);
  });

  it("a real field costs no extra request: one lookup, plus the one sample on a dry run", async () => {
    const dry = await batchHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const preview = await batch(dry, { confirm: false });
    expect(preview.isError).toBeUndefined();
    expect((preview.structuredContent as { data: Row }).data).toMatchObject({ matched: 3, dry_run: true });
    expect(dry.get).toHaveBeenCalledTimes(2);
    expect(dry.get.mock.calls[0]![1]).toMatchObject({ sysparm_fields: "sys_id,active", sysparm_limit: "200" });
    expectNoWrites(dry);

    const live = await batchHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const run = await batch(live, { confirm: true });
    expect(run.isError, textOf(run)).toBeUndefined();
    expect(live.get).toHaveBeenCalledTimes(1);
    expect(live.getWithMeta).not.toHaveBeenCalled();
    // The three records go out in the one REST batch request.
    expect(live.post).toHaveBeenCalledTimes(1);
    expect(live.patch).not.toHaveBeenCalled();
    expect(live.put).not.toHaveBeenCalled();
    expect(live.delete).not.toHaveBeenCalled();
  });

  it("targets only the sys_ids, whatever else the lookup returned", async () => {
    const connected = await batchHarness(table(INCIDENT_COLUMNS, INCIDENT_ROWS));
    const result = await batch(connected, { confirm: false });
    const sample = ((result.structuredContent as { data: { sample?: Row[] } }).data.sample ?? []) as Row[];
    for (const row of sample) expect(Object.keys(row).sort()).toEqual(["display", "sys_id"]);
    expect(JSON.stringify(result.structuredContent)).not.toContain("priority");
  });

  it("answers a size failure on the extended lookup with a fixed message and no write", async () => {
    const connected = await harness();
    connected.get.mockRejectedValue(
      new ServiceNowResponseTooLargeError("cumulative upstream response exceeds configured byte limit")
    );
    const result = await batch(connected, { confirm: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too large once the fields used by the filter were included");
    expectNoWrites(connected);
  });
});
