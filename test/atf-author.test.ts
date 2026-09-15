import { describe, expect, it } from "vitest";
import { runWithFieldPolicyConfiguration } from "../src/field-policy.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { atfAuthorToolModule, resolveAtfAuthorAccess } from "../src/tools/atf-author-module.js";
import { createMockServiceNowHarness, SNSDK54_PROFILE_NAME, type MockServiceNowStep } from "./fixtures/mock-servicenow.js";

const id = (n: number) => n.toString(16).padStart(32, "0");
const tables = ["sys_atf_test", "sys_atf_test_suite", "sys_atf_test_suite_test"];
const policy = createTableAccessPolicy({ readTables: tables, writeTables: tables, targets: tables.map(table => ({ table, kind: "canonical" as const, tools: ["sn_atf_author"], closureComplete: true, relatedTables: [table] })) });
const membershipReads: MockServiceNowStep[] = [
  { operation: "get", response: { result: [{ sys_id: id(1) }] } },
  { operation: "get", response: { result: [{ sys_id: id(2) }, { sys_id: id(3) }] } },
];
async function call(args: Record<string, unknown>, steps: MockServiceNowStep[], granted = true) {
  const harness = await createMockServiceNowHarness({ modules: [atfAuthorToolModule], tableAccess: granted ? policy : createTableAccessPolicy({}), steps });
  try {
    const result = await harness.client.callTool({ name: "sn_atf_author", arguments: { profile: SNSDK54_PROFILE_NAME, ...args } });
    return { result, calls: harness.fixture.calls, managerCalls: harness.managerCalls };
  } finally { await harness.close(); }
}
describe("sn_atf_author", () => {
  it.each(["create_test", "create_suite"])("creates %s through the MCP contract and renders a trusted link", async action => {
    const { result, calls } = await call({ action, name: "Example", application_scope: id(2) }, [{ operation: "post", response: { result: { sys_id: id(1), output: "<script>untrusted</script>" } } }]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ profile: SNSDK54_PROFILE_NAME, data: { action, results: [{ sys_id: id(1) }] } });
    expect(JSON.stringify(result.content)).toContain(".do?sys_id=");
    expect(JSON.stringify(result)).not.toContain("untrusted");
    expect(calls[0]).toMatchObject({ path: `/api/now/table/${action === "create_test" ? "sys_atf_test" : "sys_atf_test_suite"}`, body: { name: "Example", active: "true", sys_scope: id(2) } });
  });
  it.each(["create_test", "create_suite"])("accepts the Global scope ID for %s", async action => {
    const { result, calls } = await call({ action, name: "Global example", application_scope: "global" }, [{ operation: "post", response: { result: { sys_id: id(1) } } }]);
    expect(result.isError).not.toBe(true);
    expect(calls[0].body).toMatchObject({ sys_scope: "global" });
  });
  it("creates ordered membership rows", async () => {
    const { result, calls } = await call({ action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(3)], start_order: 20 }, [
      ...membershipReads,
      { operation: "post", response: { result: { sys_id: id(4) } } }, { operation: "post", response: { result: { sys_id: id(5) } } },
    ]);
    expect(result.isError).not.toBe(true);
    expect(calls.filter(c => c.operation === "post").map(c => c.body)).toEqual([{ test: id(2), test_suite: id(1), order: "20" }, { test: id(3), test_suite: id(1), order: "21" }]);
  });
  it.each(["create_test", "create_suite", "add_tests_to_suite"])("denies %s before credentials or I/O", async action => {
    const args = action === "add_tests_to_suite" ? { suite_sys_id: id(1), test_sys_ids: [id(2)] } : { name: "Example" };
    const { result, calls, managerCalls } = await call({ action, ...args }, [], false);
    expect(result.isError).toBe(true); expect(calls).toEqual([]); expect(managerCalls.config).toEqual([]); expect(managerCalls.client).toEqual([]);
  });
  it("rolls back only this invocation's confirmed records and reports uncertainty", async () => {
    const { result, calls } = await call({ action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(3)] }, [
      ...membershipReads,
      { operation: "post", response: { result: { sys_id: id(4) } } }, { operation: "post", error: new Error("secret upstream message") }, { operation: "delete", response: { status: 204 } },
    ]);
    expect(result.structuredContent).toMatchObject({ data: { outcome: "failed" } }); expect(calls[4]!.path).toBe(`/api/now/table/sys_atf_test_suite_test/${id(4)}`);
    expect(JSON.stringify(result)).toContain(`Rolled back: ${id(4)}`); expect(JSON.stringify(result)).toContain("may have succeeded"); expect(JSON.stringify(result)).not.toContain("secret upstream");
  });
  it("reports rollback failure without deleting the caller's test or suite", async () => {
    const { result, calls } = await call({ action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(3)] }, [
      ...membershipReads,
      { operation: "post", response: { result: { sys_id: id(4) } } }, { operation: "post", response: {} }, { operation: "delete", error: new Error("denied") },
    ]);
    expect(JSON.stringify(result)).toContain(`Rollback failed for: ${id(4)}`); expect(calls.filter(c => c.operation === "delete")).toHaveLength(1);
  });
  it("rejects duplicate IDs as invalid input before credentials or I/O", async () => {
    const { result, calls, managerCalls } = await call({ action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(2)] }, []);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("test_sys_ids must be unique");
    expect(JSON.stringify(result)).not.toContain("Table access denied");
    expect(calls).toEqual([]);
    expect(managerCalls.config).toEqual([]);
  });
  it.each(["suite", "test", "unreadable"])("does not create partial memberships for a missing or %s reference", async missing => {
    const steps: MockServiceNowStep[] = missing === "unreadable" ? [{ operation: "get", error: new Error("private denial") }] : [
      { operation: "get", response: { result: missing === "suite" ? [] : [{ sys_id: id(1) }] } },
      { operation: "get", response: { result: [{ sys_id: id(2) }] } },
    ];
    const { result, calls } = await call({ action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(3)] }, steps);
    expect(result.structuredContent).toMatchObject({ data: { outcome: "failed", results: [], uncertain_insert: false, message: expect.stringContaining("No memberships were created") } });
    expect(calls.every(c => c.operation === "get")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private denial");
  });
  it("requires reference read grants before credentials or writes", async () => {
    const h = await createMockServiceNowHarness({ modules: [atfAuthorToolModule], tableAccess: createTableAccessPolicy({ ...policy, readTables: [] }), steps: [] });
    try {
      const result = await h.client.callTool({ name: "sn_atf_author", arguments: { profile: SNSDK54_PROFILE_NAME, action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2)] } });
      expect(result.isError).toBe(true);
      expect(h.fixture.calls).toEqual([]);
      expect(h.managerCalls.config).toEqual([]);
    } finally { await h.close(); }
  });
  it("preflights every membership field under the configured policy", () => {
    expect(() => runWithFieldPolicyConfiguration({ fieldPolicy: { sys_atf_test_suite_test: { writable: ["test", "test_suite"] } } }, () =>
      resolveAtfAuthorAccess({ profile: "test", action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(3)] })
    )).toThrow();
  });

  it("validates all rows and rejects unsupported action fields", () => {
    for (const args of [
      { action: "create_test" }, { action: "create_test", name: "Example", description: "x".repeat(1001) }, { action: "create_test", name: "Example", script: "bad" },
      { action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(2)] },
      { action: "create_suite", name: "Example", test_sys_ids: [id(2)] },
    ]) expect(() => resolveAtfAuthorAccess({ profile: "test", ...args })).toThrow();
  });
});
