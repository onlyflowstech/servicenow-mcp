/**
 * `sn_history` says why the class's field types could not be read, retries a
 * blip once, and does not remember it. Values stay withheld whatever the cause.
 * Synthetic data only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", async (original) => ({
  ...(await original<typeof import("../src/client.js")>()),
  pauseUnlessServiceNowRequestCancelled: async () => {},
}));

import { createToolError, recordTrustedHttpStatus } from "../src/tool-error.js";
import { incidentFixture } from "./history-fixtures.js";
import { dataOf, fakeInstance, FULL_TABLES, harness, ids, namedPolicy, tableOfCall, type HistoryFixture } from "./history-harness.js";

const FULL = namedPolicy(FULL_TABLES);
const ARGS = { table: "incident", sys_id: ids.incident };
const http500 = () => recordTrustedHttpStatus(createToolError("upstream", "do_not_retry"), 500);
const http503 = () => recordTrustedHttpStatus(createToolError("upstream", "do_not_retry"), 503);
const timeout = () => createToolError("timeout", "retry_if_safe_and_idempotent");

async function session(fixture: HistoryFixture) {
  const instance = fakeInstance(fixture);
  const { call } = await harness(instance.ops, { tableAccess: FULL });
  const dictionaryReads = () => instance.calls.filter((entry) => tableOfCall(entry) === "sys_dictionary").length;
  return { call, dictionaryReads };
}

describe("sn_history field types: a blip", () => {
  it("is read once more, and the second answer is used", async () => {
    const { call, dictionaryReads } = await session(incidentFixture({ dictionaryFaults: [http500()] }));
    const data = dataOf(await call(ARGS));
    expect(dictionaryReads()).toBe(2);
    expect(data.warnings).toBeUndefined();
    expect(data.audit_enabled).not.toBeNull();
  });

  it("gives no values when it fails twice, says it can be retried, and is not remembered", async () => {
    const { call, dictionaryReads } = await session(incidentFixture({ dictionaryFaults: [timeout(), timeout()] }));
    const first = dataOf(await call(ARGS));
    expect(dictionaryReads()).toBe(2);
    expect(first.warnings).toEqual([
      "Field types could not be read: the sys_dictionary request timed out after retrying, so no values are shown.",
    ]);
    expect(JSON.stringify(first.events)).not.toMatch(/"(?:old|new)"/u);
    // Not kept: the next call reads again, and the instance has recovered.
    const second = dataOf(await call(ARGS));
    expect(dictionaryReads()).toBe(3);
    expect(second.warnings).toBeUndefined();
  });

  it("names the status of a 5xx that failed twice", async () => {
    const { call } = await session(incidentFixture({ dictionaryFaults: [http503(), http503()] }));
    expect(dataOf(await call(ARGS)).warnings).toEqual([
      "Field types could not be read: the sys_dictionary request returned HTTP 503 after retrying, so no values are shown.",
    ]);
  });

  it("makes no retry for a refusal", async () => {
    const refusal = recordTrustedHttpStatus(createToolError("authorization", "retry_after_correction"), 403);
    const { call, dictionaryReads } = await session(incidentFixture({ dictionaryFaults: [refusal] }));
    expect(dataOf(await call(ARGS)).warnings).toEqual([
      "Field types could not be read: the instance refused the sys_dictionary read (HTTP 403), so no values are shown.",
    ]);
    expect(dictionaryReads()).toBe(1);
  });
});
