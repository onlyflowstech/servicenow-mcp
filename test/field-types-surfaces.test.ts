/**
 * Test-worker coverage of the causes on the two `sn_platform_view` surfaces
 * that read field types through the real plan-bounded loader: the payload
 * view's hint and the `evaluate` view's warnings. Each cause is driven from
 * a failing read, not from a hand-made loader result, and every text is
 * checked for what it must not carry: a table name (the tables come from the
 * payload and from update rows, which are untrusted), a value, or "Access
 * denied by policy" (this server's own policy is not what refused).
 * Synthetic data only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", async (original) => ({
  ...(await original<typeof import("../src/client.js")>()),
  pauseUnlessServiceNowRequestCancelled: async () => {},
}));

import { PLAN_FIELD_TYPE_DOT_WALKS, loadFieldTypesInPlan } from "../src/hidden-values.js";
import { createInstanceHibernatingError, createToolError, recordTrustedHttpStatus } from "../src/tool-error.js";
import { canonicalPlatformViewArgs, platformViewReadTables } from "../src/tools/platform-view-contracts.js";
import { createEvaluateHandler, EVALUATE_DOT_WALKS, EVALUATE_WARNINGS } from "../src/tools/platform-view-evaluate.js";
import { preparePayload, type PayloadOutcome } from "../src/tools/platform-view-payload.js";
import type { PlatformViewFieldAccess } from "../src/tools/platform-view-upgrades.js";
import { callLabel, fake, payloadOf, world, FAKE_SECRET } from "./fixtures/update-set-views.js";
import { SET_ID, update } from "./fixtures/update-set-eval/rule-cases.js";
import { model, scripted, xmlRow } from "./fixtures/update-set-eval/evaluate-instance.js";
import { expectReadsWithin, type RecordedCall } from "./platform-view-harness.js";

const http = (status: number): Error =>
  recordTrustedHttpStatus(
    createToolError(status === 403 ? "authorization" : "upstream", status === 403 ? "retry_after_correction" : "do_not_retry"),
    status
  );
const timeout = () => createToolError("timeout", "retry_if_safe_and_idempotent");

/** What a failing read of each table looks like, always (so the one retry fails too). */
type Fail = (call: RecordedCall) => Error | undefined;
const failing = (label: string, error: () => Error): Fail => (call) => (callLabel(call) === label ? error() : undefined);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EvaluateData = Record<string, any>;

/** Table names no text may carry. */
const NAMES = /u_secret_customer_table|u_vendor|u_hostile|sys_script_include/u;

describe("payload view: the hint names the cause, not the table", () => {
  const PAYLOAD = payloadOf("u_vendor_child", { u_name: "Acme", u_api_key_value: FAKE_SECRET });

  async function prepare(fail: Fail | undefined, options: Parameters<typeof loadFieldTypesInPlan>[2] = {}, payload = PAYLOAD, tables = ["u_vendor_child"]) {
    const { instance, ops } = fake(world(), fail === undefined ? {} : { fail });
    const outcome = await preparePayload(payload, tables, (written) => loadFieldTypesInPlan(ops, written, options), 100_000);
    // Every read stays in the plan: the two metadata tables, and their dot-walks.
    expectReadsWithin(instance, ["sys_db_object", "sys_dictionary"], PLAN_FIELD_TYPE_DOT_WALKS);
    return outcome;
  }
  const withheld = (outcome: PayloadOutcome, reason: string, hint: string) => {
    expect(outcome).toMatchObject({ status: "withheld", reason, hint });
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toMatch(NAMES);
    expect(hint).not.toContain("Access denied by policy");
    expect(hint.length).toBeLessThanOrEqual(500);
  };

  const typesCases: Array<[string, Fail, string]> = [
    [
      "a refusal",
      failing("table:sys_dictionary", () => http(403)),
      "Field types could not be read: the instance refused the sys_dictionary read (HTTP 403), so password-type fields cannot be hidden; the payload is not shown.",
    ],
    [
      "a 503 that the retry did not recover",
      failing("table:sys_dictionary", () => http(503)),
      "Field types could not be read: the sys_dictionary request returned HTTP 503 after one retry, so password-type fields cannot be hidden; the payload is not shown.",
    ],
    [
      "a timeout that the retry did not recover",
      failing("table:sys_dictionary", timeout),
      "Field types could not be read: the sys_dictionary request timed out after one retry, so password-type fields cannot be hidden; the payload is not shown.",
    ],
    [
      "a 400",
      failing("table:sys_dictionary", () => http(400)),
      "Field types could not be read: the sys_dictionary read failed (HTTP 400), so password-type fields cannot be hidden; the payload is not shown.",
    ],
    [
      "a hibernating instance",
      failing("table:sys_dictionary", () => createInstanceHibernatingError()),
      "Field types could not be read: the sys_dictionary request could not reach the instance, so password-type fields cannot be hidden; the payload is not shown.",
    ],
  ];
  for (const [label, fail, hint] of typesCases) {
    it(`words ${label} on the dictionary`, async () => {
      withheld(await prepare(fail), "field_types_unavailable", hint);
    });
  }

  const hierarchyCases: Array<[string, Fail, string]> = [
    [
      "a refusal",
      failing("table:sys_db_object", () => http(403)),
      "Table hierarchies could not be read: the instance refused the sys_db_object read (HTTP 403), so the payload is not shown.",
    ],
    [
      "a 500 that the retry did not recover",
      failing("table:sys_db_object", () => http(500)),
      "Table hierarchies could not be read: the sys_db_object request returned HTTP 500 after one retry, so the payload is not shown.",
    ],
    [
      "a timeout that the retry did not recover",
      failing("table:sys_db_object", timeout),
      "Table hierarchies could not be read: the sys_db_object request timed out after one retry, so the payload is not shown.",
    ],
  ];
  for (const [label, fail, hint] of hierarchyCases) {
    it(`words ${label} on the chain read`, async () => {
      withheld(await prepare(fail), "hierarchy_unknown", hint);
    });
  }

  it("says the hierarchy first when both reads fail, as the hierarchy is checked first", async () => {
    const both: Fail = (call) =>
      ["table:sys_db_object", "table:sys_dictionary"].includes(callLabel(call)) ? http(403) : undefined;
    const outcome = await prepare(both);
    expect(outcome).toMatchObject({ reason: "hierarchy_unknown" });
  });

  it("recovers from one blip on either read: the payload is shown, masked", async () => {
    for (const label of ["table:sys_dictionary", "table:sys_db_object"]) {
      let n = 0;
      const outcome = await prepare((call) => (callLabel(call) === label && (n += 1) === 1 ? http(503) : undefined));
      expect(outcome.status, label).toBe("shown");
      expect(JSON.stringify(outcome)).not.toContain(FAKE_SECRET);
    }
  });

  it("words the policy cause, when field policy hides the dictionary's or the hierarchy's fields", async () => {
    const types = await prepare(undefined, { readTypes: false });
    withheld(
      types,
      "field_types_unavailable",
      "This profile does not grant read on sys_db_object and sys_dictionary (name, element, internal_type), so password-type fields cannot be hidden; the payload is not shown."
    );
    const chains = await prepare(undefined, { readChains: false });
    expect(chains).toMatchObject({ status: "withheld", reason: "hierarchy_unknown" });
    expect(JSON.stringify(chains)).not.toMatch(NAMES);
    expect((chains as { hint: string }).hint).toMatch(/^This profile does not grant read on sys_db_object and sys_dictionary/u);
    expect(JSON.stringify(chains)).not.toContain(FAKE_SECRET);
  });

  it("names no table, whatever the payload says it writes to", async () => {
    // A table with no row, a hostile name, and a long one: nothing of them is in the hint.
    for (const table of ["u_secret_customer_table", "u_hostile\"><b>x</b>", `u_${"x".repeat(200)}`, "U_Mixed_Case"]) {
      const outcome = await prepare(undefined, {}, payloadOf(table, { u_value: FAKE_SECRET }), [table]);
      const text = JSON.stringify(outcome);
      expect(text, table).not.toContain(FAKE_SECRET);
      expect(text, table).not.toContain(table.slice(0, 20));
      expect(text, table).not.toContain("<b>");
    }
  });
});

describe("evaluate view: the warnings name the cause, not the table", () => {
  const access = (...hidden: string[]): PlatformViewFieldAccess => {
    const set = new Set(hidden);
    return {
      canRead: (table, field) => !set.has(`${table}.${field}`),
      filter: (table, row) => Object.fromEntries(Object.entries(row).filter(([field]) => !set.has(`${table}.${field}`))),
    };
  };

  async function evaluate(fail: Fail | undefined, hidden: string[] = [], tableName = "u_vendor") {
    const rows = [xmlRow(update(tableName, { u_name: "Acme", u_api_password: FAKE_SECRET }))];
    const { instance, ops } = scripted(model({ rows }), fail === undefined ? undefined : { fail: (call) => fail(call as RecordedCall) });
    const canonical = canonicalPlatformViewArgs({ view: "evaluate", update_set: SET_ID });
    const result = await createEvaluateHandler()(canonical, { serviceNow: ops } as never, access(...hidden));
    expectReadsWithin(instance, platformViewReadTables("evaluate", canonical), EVALUATE_DOT_WALKS);
    const data = (result.structuredContent as { data: EvaluateData }).data;
    return { data, result };
  }

  const expectClean = (data: EvaluateData, result: unknown) => {
    for (const warning of data.warnings as string[]) {
      expect(warning).not.toMatch(NAMES);
      expect(warning).not.toContain("Access denied by policy");
      expect(warning.length).toBeLessThanOrEqual(300);
    }
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
  };

  const failing2 = (table: string, error: () => Error): Fail => (call) =>
    call.path.endsWith(`/${table}`) && !call.path.startsWith("/api/now/stats/") ? error() : undefined;

  const typeCases: Array<[string, Fail, string]> = [
    ["a 503 twice", failing2("sys_dictionary", () => http(503)), "Field types could not be read: the sys_dictionary request returned HTTP 503 after one retry; password-typed field checks were not made."],
    ["a timeout twice", failing2("sys_dictionary", timeout), "Field types could not be read: the sys_dictionary request timed out after one retry; password-typed field checks were not made."],
    ["a 400", failing2("sys_dictionary", () => http(400)), "Field types could not be read: the sys_dictionary read failed (HTTP 400); password-typed field checks were not made."],
    ["a hibernating instance", failing2("sys_dictionary", () => createInstanceHibernatingError()), "Field types could not be read: the sys_dictionary request could not reach the instance; password-typed field checks were not made."],
  ];
  for (const [label, fail, warning] of typeCases) {
    it(`words ${label} on the dictionary as field_types_unavailable`, async () => {
      const { data, result } = await evaluate(fail);
      expect(data.warnings).toContain(warning);
      expect(data.warnings).not.toContain(EVALUATE_WARNINGS.field_types_unavailable);
      expect(data.summary.facts.field_types).toBe("unavailable");
      expectClean(data, result);
    });
  }

  const hierarchyCases: Array<[string, Fail, string]> = [
    ["a refusal", failing2("sys_db_object", () => http(403)), "Table hierarchies could not be read: the instance refused the sys_db_object read (HTTP 403); some table checks were not made."],
    ["a 500 twice", failing2("sys_db_object", () => http(500)), "Table hierarchies could not be read: the sys_db_object request returned HTTP 500 after one retry; some table checks were not made."],
  ];
  for (const [label, fail, warning] of hierarchyCases) {
    it(`words ${label} on the chain read as hierarchy_unavailable`, async () => {
      const { data, result } = await evaluate(fail);
      expect(data.warnings).toContain(warning);
      expect(data.warnings).not.toContain(EVALUATE_WARNINGS.hierarchy_unavailable);
      expectClean(data, result);
    });
  }

  it("words the policy cause when field policy hides the dictionary's or the hierarchy's fields", async () => {
    const types = await evaluate(undefined, ["sys_dictionary.internal_type"]);
    expect(types.data.warnings).toContain(
      "This profile does not grant read on sys_db_object and sys_dictionary (name, element, internal_type); password-typed field checks were not made."
    );
    expectClean(types.data, types.result);
    const hierarchy = await evaluate(undefined, ["sys_db_object.super_class"]);
    const text = (hierarchy.data.warnings as string[]).join("\n");
    expect(text).toMatch(/This profile does not grant read on sys_db_object and sys_dictionary/u);
    expectClean(hierarchy.data, hierarchy.result);
  });

  it("names no table for a table with no row, or with a hostile name", async () => {
    // The update writes to a table that does not exist: the hierarchy cannot be placed, and no name is said.
    for (const table of ["u_secret_customer_table", "u_hostile_table_with_a_long_name_that_is_not_in_the_world"]) {
      const { data, result } = await evaluate(undefined, [], table);
      const warnings = data.warnings as string[];
      expect(warnings.length, table).toBeGreaterThan(0);
      expectClean(data, result);
      expect(JSON.stringify(data)).not.toContain(`"${table}"`);
    }
  });

  it("makes at most one extra read of each metadata table for a blip, and recovers", async () => {
    let dictionary = 0;
    let chains = 0;
    const { data, result } = await evaluate((call) => {
      if (call.path.endsWith("/sys_dictionary") && (dictionary += 1) === 1) return http(503);
      if (call.path.endsWith("/sys_db_object") && (chains += 1) === 1) return http(503);
      return undefined;
    });
    expect(data.summary.facts.field_types).not.toBe("unavailable");
    expect(data.warnings ?? []).not.toContain(EVALUATE_WARNINGS.field_types_unavailable);
    expect(dictionary).toBe(2);
    expect(chains).toBe(2);
    expectClean({ ...data, warnings: data.warnings ?? [] }, result);
  });
});
