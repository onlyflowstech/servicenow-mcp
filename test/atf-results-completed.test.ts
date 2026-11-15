import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { createTableAccessPolicy } from "../src/table-policy.js";
import { atfResultsToolModule } from "../src/tools/atf-results-module.js";
import {
  SNSDK54_PROFILE_NAME,
  createMockServiceNowHarness,
  type MockServiceNowStep,
} from "./fixtures/mock-servicenow.js";

/**
 * Shapes of `sn_atf_results get`, taken from a live instance (field names, types
 * and which fields were empty; every value here is synthetic). A completed
 * result can have an empty suite reference (an empty string), with its child
 * rows pointing at it as `parent`.
 */
const id = (n: number) => n.toString(16).padStart(32, "0");
const RESULT = id(3);
const SUITE = id(1);
const policy = createTableAccessPolicy({ readTables: ["*"], writeTables: ["*"] });
const rows = (result: unknown): MockServiceNowStep => ({ operation: "get", response: { result } });

/** The CI/CD answer for a finished result; `test_suite_name` is empty when there is no suite. */
const cicd = (overrides: Record<string, unknown> = {}) =>
  rows({
    status: "2",
    status_label: "Success",
    status_message: "",
    status_detail: "",
    error: "",
    links: { results: { id: RESULT, url: "https://example.invalid/ignored" } },
    test_suite_status: "success",
    test_suite_duration: "00:00:08",
    rolledup_test_success_count: 2,
    rolledup_test_failure_count: 0,
    rolledup_test_error_count: 0,
    rolledup_test_skip_count: 0,
    test_suite_name: "",
    child_suite_results: [],
    ...overrides,
  });

/** The suite-result row: Table API, display_value=false, so a set reference is a bare sys_id. */
const suiteRow = (overrides: Record<string, unknown> = {}) =>
  rows([
    {
      sys_id: RESULT,
      test_suite: "",
      parent: "",
      status: "success",
      success: "true",
      start_time: "2026-01-01 00:00:00",
      end_time: "2026-01-01 00:00:08",
      run_time: "1970-01-01 00:00:08",
      rolled_up_test_success_count: "2",
      rolled_up_test_failure_count: "0",
      rolled_up_test_error_count: "0",
      rolled_up_test_skip_count: "0",
      ...overrides,
    },
  ]);
const noChildren = rows([]);
const passing = (n: number) => ({ sys_id: id(100 + n), test: id(200 + n), test_name: `Test ${n}`, parent: RESULT, status: "success" });

async function get(steps: MockServiceNowStep[], options: { cache?: string } = {}) {
  const h = await createMockServiceNowHarness({
    modules: [atfResultsToolModule],
    steps,
    tableAccess: policy,
    ...(options.cache === undefined ? {} : { atfCacheDirectory: options.cache }),
  });
  try {
    const result = (await h.client.callTool({
      name: "sn_atf_results",
      arguments: { profile: SNSDK54_PROFILE_NAME, action: "get", result_id: RESULT },
    })) as CallToolResult;
    return { result, h };
  } finally {
    await h.close();
  }
}
const dataOf = (result: CallToolResult) => (result.structuredContent as { data: { execution: Record<string, unknown> & { run: Record<string, unknown>; warnings: string[] } } }).data.execution;
const textOf = (result: CallToolResult) => (result.content[0]?.type === "text" ? result.content[0].text : "");

describe("sn_atf_results get on a completed result", () => {
  it("returns a normal result when the result has no test suite", async () => {
    const { result, h } = await get([cicd(), suiteRow(), noChildren, rows([passing(1), passing(2)])]);
    expect(result.isError, textOf(result)).not.toBe(true);
    const execution = dataOf(result);
    expect(execution).toMatchObject({
      outcome: "completed",
      result_id: RESULT,
      failures: [],
      run: { runId: RESULT, status: "success", counts: { passed: 2, failed: 0, errors: 0, skipped: 0 }, durationMs: 8000 },
      pagination: { tests_total: 2 },
    });
    // No suite: no suite_id anywhere, and the result says why there is no history.
    expect(execution.suite_id).toBeUndefined();
    expect(execution.run.suiteId).toBeUndefined();
    expect(execution.warnings.join(" ")).toContain("no test suite");
    h.fixture.assertConsumed();
  });

  it("returns the failures of a completed result that has no test suite", async () => {
    const failedCounts = { rolled_up_test_success_count: "1", rolled_up_test_failure_count: "1" };
    const { result, h } = await get([
      cicd({ rolledup_test_success_count: 1, rolledup_test_failure_count: 1, test_suite_status: "failure" }),
      suiteRow({ status: "failure", success: "false", ...failedCounts }),
      noChildren,
      rows([passing(1), { sys_id: id(104), test: id(204), test_name: "Login", parent: RESULT, status: "failure", first_failing_step: id(6) }]),
      rows([{ sys_id: id(6), test_result: id(104), summary: "Assertion failed", description: "Validate", type: "step_result" }]),
    ]);
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(dataOf(result)).toMatchObject({
      outcome: "completed",
      run: { status: "failure", counts: { passed: 1, failed: 1 } },
      failures: [{ test_id: id(204), step_result_id: id(6), message: "Assertion failed" }],
    });
    expect(textOf(result)).toContain("Full details: sn_atf_results action=step");
    h.fixture.assertConsumed();
  });

  it("returns a completed result whose test results have no test reference, as the live rows did", async () => {
    // Live shape: both the suite reference and every test reference were empty strings.
    const failure = { sys_id: id(104), test: "", test_name: "Login", parent: RESULT, status: "failure", first_failing_step: id(6) };
    const { result, h } = await get([
      cicd({ rolledup_test_success_count: 1, rolledup_test_failure_count: 1 }),
      suiteRow({ status: "failure", success: "false", rolled_up_test_success_count: "1", rolled_up_test_failure_count: "1" }),
      noChildren,
      rows([{ ...passing(1), test: "" }, failure]),
      rows([{ sys_id: id(6), test_result: id(104), summary: "Assertion failed", description: "Validate", type: "step_result" }]),
    ]);
    expect(result.isError, textOf(result)).not.toBe(true);
    const execution = dataOf(result);
    expect(execution).toMatchObject({
      outcome: "completed",
      failures: [{ test_id: id(104), test_result_id: id(104), step_result_id: id(6) }],
      run: { tests: [{ testId: id(101), status: "success" }, { testId: id(104), status: "failure" }] },
    });
    expect(execution.warnings.join(" ")).toContain("2 test results have no test reference");
    h.fixture.assertConsumed();
  });

  it("does not cache a result with a suite when some of its tests have no test reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atf-completed-"));
    try {
      const { result } = await get([cicd({ test_suite_name: "Example" }), suiteRow({ test_suite: SUITE }), noChildren, rows([{ ...passing(1), test: "" }, passing(2)])], { cache: directory });
      expect(result.isError, textOf(result)).not.toBe(true);
      expect(dataOf(result)).toMatchObject({ outcome: "completed", suite_id: SUITE });
      expect(dataOf(result).warnings.join(" ")).toContain("some of its tests have no test reference");
      const h = await createMockServiceNowHarness({ modules: [atfResultsToolModule], steps: [], tableAccess: policy, atfCacheDirectory: directory });
      try {
        const history = (await h.client.callTool({ name: "sn_atf_results", arguments: { profile: SNSDK54_PROFILE_NAME, action: "history", suite_sys_id: SUITE } })) as CallToolResult;
        expect((history.structuredContent as { data: { runs: unknown[] } }).data.runs).toEqual([]);
      } finally { await h.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("still returns a running result, with its suite", async () => {
    const { result, h } = await get([
      cicd({ status: "1", status_label: "Running", test_suite_name: "Example", test_suite_status: "running" }),
      suiteRow({ test_suite: SUITE, status: "running", success: "false", end_time: "" }),
      noChildren,
      rows([passing(1)]),
    ]);
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(dataOf(result)).toMatchObject({ outcome: "running", suite_id: SUITE, suite_name: "Example", run: { status: "running", suiteId: SUITE } });
    h.fixture.assertConsumed();
  });

  it("keeps caching a completed result that has a suite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atf-completed-"));
    try {
      const { result, h } = await get([cicd({ test_suite_name: "Example" }), suiteRow({ test_suite: SUITE }), noChildren, rows([passing(1), passing(2)])], { cache: directory });
      expect(result.isError, textOf(result)).not.toBe(true);
      expect(dataOf(result)).toMatchObject({ outcome: "completed", suite_id: SUITE, run: { suiteId: SUITE } });
      expect(dataOf(result).warnings.join(" ")).not.toContain("no test suite");
      h.fixture.assertConsumed();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses a suite_sys_id that the result does not belong to, as before", async () => {
    const h = await createMockServiceNowHarness({ modules: [atfResultsToolModule], steps: [cicd(), suiteRow(), noChildren, rows([])], tableAccess: policy });
    try {
      const result = (await h.client.callTool({ name: "sn_atf_results", arguments: { profile: SNSDK54_PROFILE_NAME, action: "get", result_id: RESULT, suite_sys_id: SUITE } })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Error category: upstream");
    } finally { await h.close(); }
  });
});

describe("sn_atf_results never throws uncaught for malformed upstream data", () => {
  const failingTest = { sys_id: id(104), test: id(204), test_name: "Login", parent: RESULT, status: "failure", first_failing_step: id(6) };
  const cases: Array<[string, () => MockServiceNowStep[]]> = [
    ["a suite reference that is not a sys_id", () => [cicd(), suiteRow({ test_suite: "not-a-sys-id" }), noChildren, rows([])]],
    ["a suite reference object whose value is not a sys_id", () => [cicd(), suiteRow({ test_suite: { link: "x", value: "not-a-sys-id" } }), noChildren, rows([])]],
    ["a CI/CD answer that is not an object", () => [rows("unexpected"), suiteRow(), noChildren, rows([])]],
    ["a CI/CD answer with no result", () => [{ operation: "get", response: {} }, suiteRow(), noChildren, rows([])]],
    ["a status this server does not know", () => [cicd(), suiteRow({ status: "teapot" }), noChildren, rows([passing(1)])]],
    ["a test whose reference is not a sys_id", () => [cicd(), suiteRow(), noChildren, rows([{ ...passing(1), test: "not-a-sys-id" }])]],
    ["a test status this server does not know", () => [cicd(), suiteRow(), noChildren, rows([{ ...passing(1), status: "teapot" }])]],
    ["roll-up counts that are not numbers", () => [cicd({ rolledup_test_success_count: "many" }), suiteRow({ rolled_up_test_success_count: "many" }), noChildren, rows([passing(1)])]],
    ["a first failing step that is not a sys_id", () => [cicd(), suiteRow({ status: "failure" }), noChildren, rows([{ ...failingTest, first_failing_step: "nope" }])]],
    ["rows that are not an array", () => [cicd(), rows("not rows")]],
  ];
  it.each(cases)("maps %s to an upstream error, not an internal one", async (_name, steps) => {
    const { result } = await get(steps());
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Error category: upstream");
    expect(text).not.toContain("Error category: internal");
    expect(result.structuredContent).toBeUndefined();
  });
});
