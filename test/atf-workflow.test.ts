import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryToolModule } from "../src/tools/query-module.js";
import { atfRunToolModule } from "../src/tools/atf-run-module.js";
import { atfResultsToolModule } from "../src/tools/atf-results-module.js";
import { atfReadinessToolModule } from "../src/tools/atf-readiness-module.js";
import { compareAtfRuns } from "../src/tools/atf-shared.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { createToolError } from "../src/tool-error.js";
import type { ServiceNowToolHandlerServices, ServiceNowToolModuleContract } from "../src/tools/tool-module.js";
import type { ResolvedEffectivePolicyReference } from "../src/execution-context.js";
import type { AtfRunSummary } from "../src/atf-result-cache.js";
import { createMockServiceNowFixture, createMockServiceNowHarness, SNSDK54_PROFILE_NAME, type MockServiceNowStep } from "./fixtures/mock-servicenow.js";

const id = (n: number) => n.toString(16).padStart(32, "0");
const policy = { atf: { execute: true, allowScriptSteps: false }, tableAccess: createTableAccessPolicy({ readTables: ["*"], writeTables: ["*"] }) } as ResolvedEffectivePolicyReference;
const rows = (result: unknown): MockServiceNowStep => ({ operation: "get", response: { result } });
const counts = { rolled_up_test_success_count: "1", rolled_up_test_failure_count: "0", rolled_up_test_error_count: "0", rolled_up_test_skip_count: "0" };
const suiteResult = { sys_id: id(3), test_suite: id(1), status: "success", start_time: "2026-01-01 00:00:00", end_time: "2026-01-01 00:00:08", ...counts };
function results(): MockServiceNowStep[] { return [rows({ test_suite_name: "Example", test_suite_status: "success" }), rows([suiteResult]), rows([]), rows([{ sys_id: id(4), test: id(5), test_name: "Test", parent: id(3), status: "success" }])]; }
const submission: MockServiceNowStep = { operation: "post", response: { result: { status: "0", links: { progress: { id: id(2), url: "https://hostile.example/ignore" } } } } };
function harness(steps: MockServiceNowStep[], overrides: Partial<ServiceNowToolHandlerServices> = {}) {
  const fixture = createMockServiceNowFixture(steps);
  const store: AtfRunSummary[] = [];
  const controller = new AbortController();
  const services = { serviceNow: fixture.operations, settings: { instance: "https://example.service-now.com" }, context: { signal: controller.signal }, policy,
    atfResults: { history: vi.fn(async () => [...store]), testHistory: vi.fn(async () => [...store]), put: vi.fn(async (run: AtfRunSummary) => { store.push(run); }) }, ...overrides } as unknown as ServiceNowToolHandlerServices;
  const call = async (module: ServiceNowToolModuleContract, args: Record<string, unknown>) => {
    const access = module.resolveAccess({ profile: "pdi", ...args }, services.policy);
    return module.invoke(access.args, services);
  };
  return { fixture, services, store, call, controller };
}
const data = (result: Awaited<ReturnType<ServiceNowToolModuleContract["invoke"]>>) => result.structuredContent!.data as Record<string, unknown>;
afterEach(() => vi.useRealTimers());

describe("ATF execution and results", () => {
  it("submits once with query parameters and returns progress without polling", async () => {
    const h = harness([rows([{ sys_id: id(1), name: "Example", active: "true" }]), submission]);
    expect(data(await h.call(atfRunToolModule, { suite_sys_id: id(1), wait: false }))).toMatchObject({ outcome: "running", progress_id: id(2) });
    expect(h.fixture.calls[1]).toMatchObject({ operation: "post", path: "/api/sn_cicd/testsuite/run", body: {}, params: { test_suite_sys_id: id(1), run_in_cloud: "true" } });
    h.fixture.assertConsumed();
  });
  it("rejects requests for a local runner before I/O", () => {
    expect(() => atfRunToolModule.resolveAccess({ profile: "pdi", suite_sys_id: id(1), run_in_cloud: false }, policy)).toThrow();
  });
  it("does not fall back to a local runner when cloud submission fails", async () => {
    const h = harness([rows([{ sys_id: id(1), name: "Example", active: "true" }]), { operation: "post", error: createToolError("upstream", "retry_after_correction") }]);
    expect(data(await h.call(atfRunToolModule, { suite_sys_id: id(1) })).outcome).toBe("unavailable");
    expect(h.fixture.calls.filter(call => call.operation === "post")).toHaveLength(1);
    expect(h.fixture.calls[1].params).toMatchObject({ run_in_cloud: "true" });
  });
  it("polls to completion, follows only validated IDs, and caches a compact summary", async () => {
    vi.useFakeTimers();
    const h = harness([rows([{ sys_id: id(1), name: "Example", active: "true" }]), submission,
      rows({ status: "2", links: { results: { id: id(3), url: "https://hostile.example/ignore" } } }), ...results()]);
    const result = h.call(atfRunToolModule, { suite_sys_id: id(1) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(data(await result)).toMatchObject({ outcome: "completed", run: { counts: { passed: 1 }, durationMs: 8000 } });
    expect(h.store).toHaveLength(1); expect(h.fixture.calls.every(call => call.path.startsWith("/api/"))).toBe(true);
    h.fixture.assertConsumed();
  });
  it("returns progress when the wait deadline expires", async () => {
    vi.useFakeTimers(); const h = harness([rows([{ sys_id: id(1), name: "Example", active: "true" }]), submission]);
    const result = h.call(atfRunToolModule, { suite_sys_id: id(1), timeout: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(data(await result)).toMatchObject({ outcome: "running", progress_id: id(2), warnings: [expect.stringContaining("timed out")] });
    expect(h.fixture.calls).toHaveLength(2);
  });
  it("honors cancellation and never submits a second run", async () => {
    vi.useFakeTimers(); const h = harness([rows([{ sys_id: id(1), name: "Example", active: "true" }]), submission]);
    const result = h.call(atfRunToolModule, { suite_sys_id: id(1) });
    const check = expect(result).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1); h.controller.abort(new Error("cancelled"));
    await check; expect(h.fixture.calls.filter(call => call.operation === "post")).toHaveLength(1);
  });
  it("preserves a remediation on CI/CD authorization failure", async () => {
    const h = harness([rows([{ sys_id: id(1), name: "Example", active: "true" }]), { operation: "post", error: createToolError("authorization", "retry_after_correction") }]);
    expect(data(await h.call(atfRunToolModule, { suite_sys_id: id(1) }))).toMatchObject({ outcome: "unavailable", warnings: [expect.stringContaining("sn_atf_readiness")] });
  });
  it("rejects execution before credential/client creation when the grant is absent", async () => {
    const h = await createMockServiceNowHarness({ modules: [atfRunToolModule], tableAccess: policy.tableAccess });
    try {
      const result = await h.client.callTool({ name: "sn_atf_run", arguments: { profile: SNSDK54_PROFILE_NAME, suite_sys_id: id(1) } });
      expect(result.isError).toBe(true); expect(h.managerCalls.config).toEqual([]); expect(h.managerCalls.client).toEqual([]);
    } finally { await h.close(); }
  });
  it("gets verified failure detail and maps table rolled_up counts", async () => {
    const h = harness([rows({ test_suite_name: "Example", rolledup_test_failure_count: 99 }), rows([{ ...suiteResult, status: "failure", rolled_up_test_success_count: "0", rolled_up_test_failure_count: "1" }]), rows([]),
      rows([{ sys_id: id(4), test: id(5), test_name: "<script>name</script>", status: "failure", first_failing_step: id(6) }]),
      rows([{ sys_id: id(6), test_result: id(4), summary: "failure", description: "Validate", type: "step_result" }])]);
    expect(data(await h.call(atfResultsToolModule, { action: "get", result_id: id(3) }))).toMatchObject({ execution: { run: { counts: { failed: 1 } }, failures: [{ message: "failure" }] } });
    expect(h.store[0].tests[0].firstFailure).toBe("failure");
  });
  it("keeps an assertion after noisy logging and provides a step detail locator and label", async () => {
    const h = harness([rows({ test_suite_name: "Example" }), rows([{ ...suiteResult, status: "failure", rolled_up_test_success_count: "0", rolled_up_test_failure_count: "1" }]), rows([]),
      rows([{ sys_id: id(4), test: id(5), status: "failure", first_failing_step: id(6) }]),
      rows([{ sys_id: id(6), test_result: id(4), step: { value: id(7), display_value: "Check templates" }, summary: "provisioning noise\n".repeat(200) + "Assertion failed: expected task template", description: "" }])]);
    const result = data(await h.call(atfResultsToolModule, { action: "get", result_id: id(3) }));
    expect(result).toMatchObject({ execution: { failures: [{ step: "Check templates", step_result_id: id(6), test_result_id: id(4), message_truncated: true, message: expect.stringContaining("Assertion failed: expected task template") }] } });
  });
  it("returns all 118 tests by default and supports explicit subsequent pages", async () => {
    const tests = Array.from({length: 118}, (_, n) => ({ sys_id: id(n + 1000), test: id(n + 2000), status: "success" }));
    const steps = () => [rows({}), rows([{ ...suiteResult, rolled_up_test_success_count: "118" }]), rows([]), rows(tests)];
    const first = data(await harness(steps()).call(atfResultsToolModule, { action: "get", result_id: id(3) }));
    expect(first).toMatchObject({ execution: { pagination: { tests_total: 118 }, run: { tests: tests.map(t => ({testId:t.test,status:t.status})) } } });
    const page = data(await harness(steps()).call(atfResultsToolModule, { action: "get", result_id: id(3), tests_offset: 100, tests_limit: 10 }));
    expect(page).toMatchObject({ execution: { pagination: { tests_next_offset: 110, tests_total: 118 }, run: { tests: tests.slice(100,110).map(t => ({testId:t.test,status:t.status})) } } });
  });
  it("provides a next offset for failures beyond the first ten", async () => {
    const tests = Array.from({length:11}, (_, n) => ({sys_id:id(n+100),test:id(n+200),status:"failure"}));
    const steps = () => [rows({}),rows([{...suiteResult,status:"failure",rolled_up_test_success_count:"0",rolled_up_test_failure_count:"11"}]),rows([]),rows(tests)];
    const first = data(await harness(steps()).call(atfResultsToolModule,{action:"get",result_id:id(3)}));
    expect(first).toMatchObject({execution:{pagination:{failures_total:11,failures_next_offset:10}}});
    const last = data(await harness(steps()).call(atfResultsToolModule,{action:"get",result_id:id(3),failures_offset:10}));
    expect(last).toMatchObject({execution:{failures:[{test_id:id(210)}],pagination:{failures_offset:10}}});
    expect((last.execution as {failures:unknown[]}).failures).toHaveLength(1);
  });
  it("retrieves step diagnostics with only a read grant on the step-result table", async () => {
    const table="sys_atf_test_result_step";
    const h=await createMockServiceNowHarness({modules:[atfResultsToolModule],tableAccess:createTableAccessPolicy({readTables:[table],targets:[{table,kind:"canonical",tools:["sn_atf_results"],closureComplete:true,relatedTables:[table]}]}),steps:[rows([{sys_id:id(6),test_result:id(4),summary:"assertion"}])]});
    try {
      const result=await h.client.callTool({name:"sn_atf_results",arguments:{profile:SNSDK54_PROFILE_NAME,action:"step",step_result_id:id(6)}});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({data:{step_detail:{text:"assertion"}}});
      h.fixture.assertConsumed();
    } finally {await h.close();}
  });
  it("retrieves complete step output in lossless chunks without fetching unrelated result tables", async () => {
    const output = "noise\n".repeat(1000) + "assertion at the end";
    let recovered = "";
    for (let offset=0; offset<output.length; offset+=1000) {
      const h = harness([rows([{sys_id:id(6),test_result:id(4),step:id(7),status:"failure",output}])]);
      const result = await h.call(atfResultsToolModule, {action:"step",step_result_id:id(6),output_field:"output",output_offset:offset,output_limit:1000});
      const detail = (data(result).step_detail as {text:string;next_offset?:number});
      recovered += detail.text;
      expect(h.fixture.calls).toHaveLength(1);
      expect(h.fixture.calls[0].path).toBe("/api/now/table/sys_atf_test_result_step");
      expect(detail.next_offset).toBe(offset+1000<output.length?offset+1000:undefined);
    }
    expect(recovered).toBe(output);
  });
  it("does not cache an unverified CI/CD-to-table result mapping", async () => {
    const h = harness([rows({ test_suite_name: "Example" }), rows([])]);
    expect(data(await h.call(atfResultsToolModule, { action: "get", result_id: id(3) }))).toMatchObject({ execution: { outcome: "unavailable" } });
    expect(h.store).toEqual([]);
  });
  it("reads history and comparisons without network operations", async () => {
    const h = harness([]);
    expect(data(await h.call(atfResultsToolModule, { action: "history", suite_sys_id: id(1) }))).toMatchObject({ runs: [], message: expect.stringContaining("sn_atf_run") });
    h.store.push(summary(1, "failure"), summary(2, "success"));
    expect(data(await h.call(atfResultsToolModule, { action: "compare", suite_sys_id: id(1), result_id: id(2), previous_result_id: id(1) }))).toMatchObject({ comparison: { fixed: [id(5)] } });
    expect(h.fixture.calls).toEqual([]);
  });
});
function summary(n: number, status: AtfRunSummary["status"]): AtfRunSummary { return { runId: id(n), suiteId: id(1), startedAt: new Date(n * 1000).toISOString(), status, durationMs: n * 1000, counts: { passed: 0, failed: 0, errors: 0, skipped: 0 }, tests: [{ testId: id(5), status }] }; }
describe("ATF comparisons", () => {
  it("distinguishes fixed, new and still-failing tests without claiming flakiness", () => {
    const old = summary(1, "failure"), next = summary(2, "success");
    expect(compareAtfRuns(old, next)).toMatchObject({ fixed: [id(5)], new_failures: [], still_failing: [], flaky: [], status_changed: [id(5)], duration_regression: true });
    expect(compareAtfRuns(next, old)).toMatchObject({ new_failures: [id(5)], fixed: [] });
    expect(compareAtfRuns(old, { ...next, tests: old.tests })).toMatchObject({ still_failing: [id(5)] });
    expect(() => compareAtfRuns(old, { ...next, suiteId: id(9) })).toThrow();
  });
});
describe("ATF readiness", () => {
  it.each(["empty", "missing", "inactive"])("reports %s suite structure accurately", async scenario => {
    const h = harness([
      rows([{ active: "active" }]), rows([{ active: "active" }]), rows([{ name: "sn_atf.runner.enabled", value: "true" }]),
      rows([{ sys_id: id(1), active: "true" }]), rows([]), rows([{ test: { value: id(2) } }, { test: id(3) }]),
      rows([{ sys_id: id(2), active: "true" }, ...(scenario === "missing" ? [] : [{ sys_id: id(3), active: "false" }])]),
      rows(scenario === "empty" ? [] : [{ step_config: id(4) }]),
      ...(scenario === "empty" ? [] : [rows([{ sys_id: id(4), step_env: "Server" }])]),
      rows([{ sys_id: id(8) }]), rows({}),
    ]);
    const result = data(await h.call(atfReadinessToolModule, { suite_sys_id: id(1) }));
    expect(result.verdict).toBe(["empty", "missing"].includes(scenario) ? "blocked" : "unverified");
    expect(result.checks).toEqual(expect.arrayContaining([
      { check: "Suite memberships", status: scenario === "missing" ? "fail" : "pass", message: expect.any(String) },
      { check: "Active test steps", status: scenario === "empty" ? "fail" : "pass", message: expect.any(String) },
    ]));
    h.fixture.assertConsumed();
  });
  it("flags an empty active test in a child suite", async () => {
    const h = harness([
      rows([{ active: "active" }]), rows([{ active: "active" }]), rows([{ name: "sn_atf.runner.enabled", value: "true" }]),
      rows([{ sys_id: id(1), active: "true" }]), rows([{ sys_id: id(9) }]), rows([]), rows([]), rows([{ test: id(2) }]),
      rows([{ sys_id: id(2), active: "true" }]), rows([]), rows([{ sys_id: id(8) }]), rows({}),
    ]);
    expect(data(await h.call(atfReadinessToolModule, { suite_sys_id: id(1) }))).toMatchObject({ verdict: "blocked", checks: expect.arrayContaining([
      { check: "Active test steps", status: "fail", message: "1 active tests have no active steps." },
    ]) });
    h.fixture.assertConsumed();
  });
  it("checks cloud installation without probing a local browser and keeps provisioning unverified", async () => {
    const h = harness([rows([{ active: "active" }]), rows([{ active: "active" }]), rows([{ name: "sn_atf.runner.enabled", value: "true" }]), rows([{ sys_id: id(8), scope: "sn_atf_tg" }]), rows({})]);
    const result = data(await h.call(atfReadinessToolModule, {}));
    expect(result.verdict).toBe("unverified");
    expect(result.checks).toEqual(expect.arrayContaining([{ check: "Cloud Runner app", status: "pass", message: expect.any(String) }, { check: "Cloud Runner configuration", status: "warn", message: expect.any(String) }]));
    expect(h.fixture.calls.some(call => call.path.includes("sys_atf_agent"))).toBe(false);
    h.fixture.assertConsumed();
  });
  it("blocks a missing cloud app instead of recommending a local browser", async () => {
    const h = harness([rows([{ active: "active" }]), rows([{ active: "active" }]), rows([{ name: "sn_atf.runner.enabled", value: "true" }]), rows([]), rows({})]);
    expect(data(await h.call(atfReadinessToolModule, {}))).toMatchObject({ verdict: "blocked", checks: expect.arrayContaining([{ check: "Cloud Runner app", status: "fail", message: expect.stringContaining("Local browser fallback is disabled") }]) });
  });
  it("recognizes the active plugin choice returned by the live Table API", async () => {
    const h = harness([rows([{ active: "active" }]), rows([{ active: "active" }]), rows([{ name: "sn_atf.runner.enabled", value: "true" }]), rows([]), rows({})]);
    const result = data(await h.call(atfReadinessToolModule, {}));
    expect(result.checks).toEqual(expect.arrayContaining([
      { check: "ATF plugin", status: "pass", message: "Active" },
      { check: "CI/CD plugin", status: "pass", message: "Active" },
    ]));
  });
  it("reports blocked properties, absent execution grants and inconclusive role probes", async () => {
    const h = harness([rows([{ id: "com.glide.automated_testing_framework", active: "true" }]), rows([]), rows([]), rows([]), { operation: "get", error: createToolError("not_found", "do_not_retry") }], { policy: { ...policy, atf: { execute: false, allowScriptSteps: false } } });
    expect(data(await h.call(atfReadinessToolModule, {}))).toMatchObject({ verdict: "blocked", checks: expect.arrayContaining([{ check: "CI/CD role", status: "warn", message: expect.any(String) }, { check: "Execution grant", status: "fail", message: expect.any(String) }]) });
  });
  it("does not report authoring grants complete when mapping writes are missing", async () => {
    const tableAccess=createTableAccessPolicy({readTables:["*"],writeTables:["sys_atf_test","sys_atf_test_suite","sys_atf_test_suite_test","sys_atf_step","sys_variable_value"],targets:["sys_atf_test","sys_atf_test_suite","sys_atf_test_suite_test","sys_atf_step","sys_variable_value"].map(table=>({table,kind:"canonical" as const,tools:["sn_atf_author"],closureComplete:true,relatedTables:[table]}))});
    const h=harness([rows([{active:"active"}]),rows([{active:"active"}]),rows([{name:"sn_atf.runner.enabled",value:"true"}]),rows([]),rows({})],{policy:{...policy,tableAccess}});
    expect(data(await h.call(atfReadinessToolModule,{})).checks).toEqual(expect.arrayContaining([{check:"Authoring grants (informational)",status:"pass",message:expect.stringContaining("not fully granted")}])) ;
  });
  it("denies a profile with no readable checks before I/O", () => {
    expect(() => atfReadinessToolModule.resolveAccess({ profile: "pdi" }, { ...policy, tableAccess: createTableAccessPolicy({}) })).toThrow();
  });
  it("does not report unreadable plugins or runner data as passed", async () => {
    const h = harness(Array.from({ length: 5 }, () => ({ operation: "get" as const, error: createToolError("authorization", "retry_after_correction") })));
    const result = data(await h.call(atfReadinessToolModule, {}));
    expect(result.verdict).toBe("blocked");
    expect(result.checks).toEqual(expect.arrayContaining([{ check: "ATF plugin", status: "warn", message: expect.any(String) }]));
  });
});


describe("ATF MCP result-cache integration", () => {
  it("persists a verified result and serves history through the coordinator without further I/O", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atf-workflow-"));
    const h = await createMockServiceNowHarness({
      modules: [atfResultsToolModule], steps: results(), tableAccess: policy.tableAccess,
      atfCacheDirectory: directory,
    });
    try {
      const fetched = await h.client.callTool({ name: "sn_atf_results", arguments: { profile: SNSDK54_PROFILE_NAME, action: "get", result_id: id(3) } });
      expect(fetched.isError).not.toBe(true);
      expect(fetched.structuredContent).toMatchObject({ data: { execution: { outcome: "completed" } } });
      const history = await h.client.callTool({ name: "sn_atf_results", arguments: { profile: SNSDK54_PROFILE_NAME, action: "history", suite_sys_id: id(1) } });
      expect(history.isError).not.toBe(true);
      expect(history.structuredContent).toMatchObject({ data: { runs: [{ runId: id(3), tests: [] }] } });
    } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
  });
});


describe("ATF diagnostic reads with wildcard profile grants", () => {
  it.each(["sys_atf_test_result", "sys_atf_test_result_step", "sys_script"])("allows sn_query reads of %s through the MCP coordinator", async table => {
    const h = await createMockServiceNowHarness({ modules: [queryToolModule], tableAccess: createTableAccessPolicy({readTables:["*"],writeTables:["*"],targets:[]}), steps: [{operation:"getWithMeta",response:{data:{result:[{sys_id:id(1)}]},status:200,headers:new Headers()}}] });
    try {
      const result=await h.client.callTool({name:"sn_query",arguments:{profile:SNSDK54_PROFILE_NAME,table,fields:"sys_id",limit:1}});
      expect(result.isError).not.toBe(true);
      expect(h.fixture.calls[0].path).toBe(`/api/now/table/${table}`);
      h.fixture.assertConsumed();
    } finally {await h.close();}
  });
});
