/**
 * Test-worker coverage on top of `history-cause.test.ts`: `sn_history` words
 * every cause of unknown field types the same way, retries a blip of either
 * read once, remembers only what the design says, and withholds every value
 * whatever the cause. Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", async (original) => ({
  ...(await original<typeof import("../src/client.js")>()),
  pauseUnlessServiceNowRequestCancelled: async () => {},
}));

import {
  createHtmlResponseError,
  createInstanceHibernatingError,
  createRedirectedError,
  createToolError,
  recordTrustedHttpStatus,
} from "../src/tool-error.js";
import { DICTIONARY, incidentFixture } from "./history-fixtures.js";
import { dataOf, fakeInstance, FULL_TABLES, harness, ids, namedPolicy, tableOfCall, type HistoryFixture } from "./history-harness.js";

const FULL = namedPolicy(FULL_TABLES);
const ARGS = { table: "incident", sys_id: ids.incident };

const status = (code: number) =>
  recordTrustedHttpStatus(
    createToolError(
      code === 403 ? "authorization" : code === 401 ? "authentication" : code === 429 ? "rate_limit" : "upstream",
      code === 403 || code === 401 ? "retry_after_correction" : code === 429 ? "retry_later" : "do_not_retry"
    ),
    code
  );
const timeout = () => createToolError("timeout", "retry_if_safe_and_idempotent");
const network = () => createToolError("upstream", "retry_if_safe_and_idempotent");

/**
 * The harness has no per-credential memo unless the metadata cache is on:
 * without it, "the next call reads again" would hold for any failure. Every
 * test here runs with it on.
 */
async function session(fixture: HistoryFixture) {
  const instance = fakeInstance(fixture);
  const { call } = await harness(instance.ops, { tableAccess: FULL, metadataCache: { smallReadBytes: 0 } });
  const reads = (table: string) => instance.calls.filter((entry) => tableOfCall(entry) === table).length;
  return { call, instance, reads };
}

/** No value of any event, whatever the cause: no old, no new, and no journal text. */
function expectNoValues(data: Record<string, unknown>) {
  const events = JSON.stringify(data.events);
  expect(events).not.toMatch(/"(?:old|new)"/u);
  expect(events).not.toContain("journal text in the audit log");
  expect(events).not.toContain("fake-cipher");
  expect(JSON.stringify(data)).not.toContain("old 1");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sn_history: every dictionary cause is worded, and none is a policy denial", () => {
  const cases: Array<{ label: string; fault: () => Error; warning: string; reads: number }> = [
    { label: "a 429 (not retried)", fault: () => status(429), warning: "the sys_dictionary request returned HTTP 429, so no values are shown.", reads: 1 },
    { label: "a 400", fault: () => status(400), warning: "the sys_dictionary read failed (HTTP 400), so no values are shown.", reads: 1 },
    { label: "a 401", fault: () => status(401), warning: "the instance refused the sys_dictionary read (HTTP 401), so no values are shown.", reads: 1 },
    { label: "an HTML page", fault: createHtmlResponseError, warning: "the sys_dictionary read failed, so no values are shown.", reads: 1 },
    { label: "a redirect", fault: createRedirectedError, warning: "the sys_dictionary read failed, so no values are shown.", reads: 1 },
    { label: "a hibernating instance (not retried)", fault: () => createInstanceHibernatingError(), warning: "the sys_dictionary request could not reach the instance, so no values are shown.", reads: 1 },
    { label: "a network failure (the client already retried it)", fault: network, warning: "the sys_dictionary request could not reach the instance after retrying, so no values are shown.", reads: 1 },
    { label: "a 503 (the client already retried it)", fault: () => status(503), warning: "the sys_dictionary request returned HTTP 503 after retrying, so no values are shown.", reads: 1 },
    { label: "a 500, twice", fault: () => status(500), warning: "the sys_dictionary request returned HTTP 500 after retrying, so no values are shown.", reads: 2 },
  ];
  for (const { label, fault, warning, reads } of cases) {
    it(`for ${label}: the warning, one retry only when a retry helps, and no value`, async () => {
      const { call, reads: count } = await session(incidentFixture({ dictionaryFaults: [fault(), fault()] }));
      const data = dataOf(await call(ARGS));
      expect(data.warnings).toEqual([`Field types could not be read: ${warning}`]);
      expect(count("sys_dictionary")).toBe(reads);
      expect(String(data.warnings)).not.toContain("Access denied by policy");
      expect(String(data.warnings)).not.toContain("does not grant");
      expectNoValues(data);
    });
  }

  it("is never a policy denial, for a read this profile does grant", async () => {
    const { call } = await session(incidentFixture({ dictionary: "forbidden" }));
    const data = dataOf(await call(ARGS));
    expect(String(data.warnings)).not.toContain("does not grant");
    expectNoValues(data);
  });
});

describe("sn_history: the class's chain read", () => {
  it("is read once more after a blip, and the second answer is used", async () => {
    const { call, reads } = await session(incidentFixture({ chainFaults: [status(500)] }));
    const data = dataOf(await call(ARGS));
    expect(reads("sys_db_object")).toBe(2);
    expect(data.warnings).toBeUndefined();
    expect(data.audit_enabled).not.toBeNull();
  });

  it("gives no values after two blips, names sys_db_object, and is not remembered", async () => {
    const { call, reads } = await session(incidentFixture({ chainFaults: [timeout(), timeout()] }));
    const first = dataOf(await call(ARGS));
    expect(reads("sys_db_object")).toBe(2);
    expect(reads("sys_dictionary")).toBe(0);
    expect(first.warnings).toEqual([
      "Field types could not be read: the sys_db_object request timed out after retrying, so no values are shown.",
    ]);
    expectNoValues(first);
    const second = dataOf(await call(ARGS));
    expect(second.warnings).toBeUndefined();
    expect(reads("sys_db_object")).toBe(3);
  });

  it("makes no retry for a refusal, a 429 or a 404, and says which", async () => {
    for (const [fault, warning] of [
      [status(403), "the instance refused the sys_db_object read (HTTP 403)"],
      [status(429), "the sys_db_object request returned HTTP 429"],
      [status(404), "the sys_db_object read failed (HTTP 404)"],
    ] as const) {
      const { call, reads } = await session(incidentFixture({ chainFaults: [fault, fault] }));
      const data = dataOf(await call(ARGS));
      expect(data.warnings).toEqual([`Field types could not be read: ${warning}, so no values are shown.`]);
      expect(reads("sys_db_object")).toBe(1);
      expectNoValues(data);
    }
  });
});

describe("sn_history: what is remembered", () => {
  it("does not remember a refusal (unlike the dispatcher's 30 seconds): the next call reads again", async () => {
    const { call, reads } = await session(incidentFixture({ dictionaryFaults: [status(403)] }));
    expect(dataOf(await call(ARGS)).warnings).toEqual([
      "Field types could not be read: the instance refused the sys_dictionary read (HTTP 403), so no values are shown.",
    ]);
    const second = dataOf(await call(ARGS));
    expect(second.warnings).toBeUndefined();
    expect(reads("sys_dictionary")).toBe(2);
  });

  it("remembers a success for the hour, and not longer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const { call, reads } = await session(incidentFixture());
    await call(ARGS);
    expect(reads("sys_dictionary")).toBe(1);
    expect(reads("sys_db_object")).toBe(1);
    vi.setSystemTime(new Date("2026-11-24T12:59:00Z"));
    await call(ARGS);
    expect(reads("sys_dictionary")).toBe(1);
    expect(reads("sys_db_object")).toBe(1);
    vi.setSystemTime(new Date("2026-11-24T13:01:00Z"));
    await call(ARGS);
    expect(reads("sys_dictionary")).toBe(2);
    expect(reads("sys_db_object")).toBe(2);
  });

  it("remembers a full dictionary page for 30 seconds, with its cause", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const many = Array.from({ length: 10_000 }, (_, n) => ({ name: "incident", element: `u_f${n}`, internal_type: "string", audit: "false" }));
    const { call, reads } = await session(incidentFixture({ dictionary: [...DICTIONARY, ...many] }));
    const expected = ["Field types could not be read: sys_dictionary has more password-type fields than one read returns, so no values are shown."];
    for (let n = 0; n < 3; n += 1) expect(dataOf(await call(ARGS)).warnings).toEqual(expected);
    expect(reads("sys_dictionary")).toBe(1);
    vi.setSystemTime(new Date("2026-11-24T12:00:31Z"));
    expect(dataOf(await call(ARGS)).warnings).toEqual(expected);
    expect(reads("sys_dictionary")).toBe(2);
  });

  it("remembers an incomplete chain for 30 seconds, with its gap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const { call, reads } = await session(incidentFixture({ hiddenRows: ["task"] }));
    const expected = [
      'Field types could not be confirmed: the parent table of "incident" could not be read (the instance did not return its name to the integration user), so no values are shown.',
    ];
    for (let n = 0; n < 3; n += 1) expect(dataOf(await call(ARGS)).warnings).toEqual(expected);
    expect(reads("sys_db_object")).toBe(1);
    vi.setSystemTime(new Date("2026-11-24T12:00:31Z"));
    expect(dataOf(await call(ARGS)).warnings).toEqual(expected);
    expect(reads("sys_db_object")).toBe(2);
  });
});

describe("sn_history: the policy cause is the only one that says the profile does not grant the read", () => {
  it("names both tables and the fields, for a profile that grants neither", async () => {
    const policy = namedPolicy(["incident", "sys_audit", "sys_journal_field", "sys_flow_context"]);
    const instance = fakeInstance(incidentFixture());
    const { call } = await harness(instance.ops, { tableAccess: policy });
    const data = dataOf(await call(ARGS));
    expect(data.warnings).toEqual([
      "This profile does not grant read on sys_db_object and sys_dictionary (name, element, internal_type), so no values are shown.",
    ]);
    expectNoValues(data);
    expect(instance.calls.map(tableOfCall)).not.toContain("sys_dictionary");
    expect(instance.calls.map(tableOfCall)).not.toContain("sys_db_object");
  });
});
