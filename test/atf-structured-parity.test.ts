import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { createTableAccessPolicy } from "../src/table-policy.js";
import {
  ATF_STEP_DETAIL_ADVICE,
  ATF_SUITE_RESULT_TABLE,
  ATF_UNCERTAIN_INSERT_ADVICE,
} from "../src/tools/atf-contracts.js";
import { atfAuthorToolModule } from "../src/tools/atf-author-module.js";
import { atfResultsToolModule } from "../src/tools/atf-results-module.js";
import { atfRunToolModule } from "../src/tools/atf-run-module.js";
import { enrichSuccessfulResult } from "../src/tools/index.js";
import {
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
  type ProductionToolName,
} from "../src/tools/result-envelope.js";
import {
  SNSDK54_INSTANCE,
  SNSDK54_PROFILE_NAME,
  createMockServiceNowHarness,
  type MockServiceNowStep,
} from "./fixtures/mock-servicenow.js";

const id = (n: number) => n.toString(16).padStart(32, "0");
const rows = (result: unknown): MockServiceNowStep => ({ operation: "get", response: { result } });
const HOST = new URL(SNSDK54_INSTANCE).host;
const atf = { execute: true, allowScriptSteps: false };
const readWrite = createTableAccessPolicy({ readTables: ["*"], writeTables: ["*"] });
const authoringTables = ["sys_atf_test", "sys_atf_test_suite", "sys_atf_test_suite_test"];
const authoringPolicy = createTableAccessPolicy({
  readTables: authoringTables,
  writeTables: authoringTables,
  targets: authoringTables.map((table) => ({
    table,
    kind: "canonical" as const,
    tools: ["sn_atf_author"],
    closureComplete: true,
    relatedTables: [table],
  })),
});
const counts = {
  rolled_up_test_success_count: "0",
  rolled_up_test_failure_count: "1",
  rolled_up_test_error_count: "0",
  rolled_up_test_skip_count: "0",
};
/** One failed suite run whose failing step is readable: what `sn_atf_results get` reads. */
const failedRun = (): MockServiceNowStep[] => [
  rows({ test_suite_name: "Example" }),
  rows([{ sys_id: id(3), test_suite: id(1), status: "failure", start_time: "2026-01-01 00:00:00", end_time: "2026-01-01 00:00:08", ...counts }]),
  rows([]),
  rows([{ sys_id: id(4), test: id(5), test_name: "Login", status: "failure", first_failing_step: id(6) }]),
  rows([{ sys_id: id(6), test_result: id(4), summary: "Assertion failed", description: "Validate", type: "step_result" }]),
];

/** What the handler's data would have been before the added fields: the text must still come from this. */
function textWithout(tool: ProductionToolName, args: Record<string, unknown>, result: CallToolResult, drop: (data: Record<string, unknown>) => void): string {
  const envelope = result.structuredContent as { data: Record<string, unknown> };
  const data = JSON.parse(JSON.stringify(envelope.data)) as Record<string, unknown>;
  drop(data);
  const handler = { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  const finalized = finalizeEnvelopeResult(
    enrichSuccessfulResult(envelopeCompatibilityResult(tool, args, handler), SNSDK54_PROFILE_NAME),
    tool,
    { instanceOrigin: SNSDK54_INSTANCE }
  );
  const block = finalized!.content[0]!;
  return block.type === "text" ? block.text : "";
}
const textOf = (result: CallToolResult): string => {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

async function published(
  harness: Awaited<ReturnType<typeof createMockServiceNowHarness>>,
  tool: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const listed = (await harness.client.listTools()).tools.find((candidate) => candidate.name === tool)!;
  const result = (await harness.client.callTool({
    name: tool,
    arguments: { profile: SNSDK54_PROFILE_NAME, ...args },
  })) as CallToolResult;
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(listed.outputSchema!);
  expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true);
  return result;
}

describe("sn_atf_results and sn_atf_run: structuredContent carries what only the text carried", () => {
  it("has the suite result's record and the pointer to a failed step's full output", async () => {
    const h = await createMockServiceNowHarness({ modules: [atfResultsToolModule], steps: failedRun(), tableAccess: readWrite, atf });
    try {
      const args = { action: "get", result_id: id(3) };
      const result = await published(h, "sn_atf_results", args);
      const { execution } = (result.structuredContent as { data: { execution: Record<string, unknown> } }).data;
      expect(execution.result_ref).toEqual({ table: ATF_SUITE_RESULT_TABLE, sys_id: id(3) });
      expect(execution.advice).toEqual([ATF_STEP_DETAIL_ADVICE]);
      expect(execution.failures).toMatchObject([{ step_result_id: id(6) }]);
      const text = textOf(result);
      expect(text).toContain(`[Open suite result](${SNSDK54_INSTANCE}/sys_atf_test_suite_result.do?sys_id=${id(3)})`);
      expect(text).toContain(`Full details: sn_atf_results action=step step_result_id=${id(6)} (output_field=summary or output)`);
      // The advice names the same call, tool, action, field and both outputs.
      for (const part of ["sn_atf_results", "action=step", "step_result_id=", "output_field=summary or output"]) {
        expect(ATF_STEP_DETAIL_ADVICE).toContain(part);
      }
      // Table and sys_id only: the instance address stays in the text.
      expect(JSON.stringify(result.structuredContent)).not.toContain(HOST);
      expect(textOf(result)).toBe(
        textWithout("sn_atf_results", args, result, (data) => {
          const run = data.execution as Record<string, unknown>;
          delete run.result_ref;
          delete run.advice;
        })
      );
    } finally { await h.close(); }
  });

  it("gives no advice when no failure has a step to read", async () => {
    const steps = failedRun().slice(0, 3);
    steps.push(rows([{ sys_id: id(4), test: id(5), test_name: "Login", status: "failure" }]));
    const h = await createMockServiceNowHarness({ modules: [atfResultsToolModule], steps, tableAccess: readWrite, atf });
    try {
      const result = await published(h, "sn_atf_results", { action: "get", result_id: id(3) });
      const { execution } = (result.structuredContent as { data: { execution: Record<string, unknown> } }).data;
      expect(execution.advice).toBeUndefined();
      expect(execution.result_ref).toEqual({ table: ATF_SUITE_RESULT_TABLE, sys_id: id(3) });
      expect(textOf(result)).not.toContain("Full details");
    } finally { await h.close(); }
  });

  it("has the suite result's record after a submission", async () => {
    const submission: MockServiceNowStep = { operation: "post", response: { result: { status: "0", links: { progress: { id: id(2) }, results: { id: id(3) } } } } };
    const h = await createMockServiceNowHarness({
      modules: [atfRunToolModule],
      steps: [rows([{ sys_id: id(1), name: "Example", active: "true" }]), submission],
      tableAccess: readWrite,
      atf,
    });
    try {
      const args = { suite_sys_id: id(1), wait: false };
      const result = await published(h, "sn_atf_run", args);
      const data = (result.structuredContent as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ outcome: "running", progress_id: id(2), result_id: id(3), result_ref: { table: ATF_SUITE_RESULT_TABLE, sys_id: id(3) } });
      expect(data.advice).toBeUndefined();
      expect(textOf(result)).toContain(`${SNSDK54_INSTANCE}/sys_atf_test_suite_result.do?sys_id=${id(3)}`);
      expect(JSON.stringify(result.structuredContent)).not.toContain(HOST);
      expect(textOf(result)).toBe(textWithout("sn_atf_run", args, result, (value) => { delete value.result_ref; }));
    } finally { await h.close(); }
  });

  it("has no suite result record before there is a result", async () => {
    const submission: MockServiceNowStep = { operation: "post", response: { result: { status: "0", links: { progress: { id: id(2) } } } } };
    const h = await createMockServiceNowHarness({
      modules: [atfRunToolModule],
      steps: [rows([{ sys_id: id(1), name: "Example", active: "true" }]), submission],
      tableAccess: readWrite,
      atf,
    });
    try {
      const result = await published(h, "sn_atf_run", { suite_sys_id: id(1), wait: false });
      expect((result.structuredContent as { data: Record<string, unknown> }).data.result_ref).toBeUndefined();
    } finally { await h.close(); }
  });
});

describe("sn_atf_author: structuredContent carries what only the text carried", () => {
  const membershipReads: MockServiceNowStep[] = [rows([{ sys_id: id(1) }]), rows([{ sys_id: id(2) }, { sys_id: id(3) }])];

  it("names each created record by table and sys_id, which the text links", async () => {
    const h = await createMockServiceNowHarness({
      modules: [atfAuthorToolModule],
      steps: [...membershipReads, { operation: "post", response: { result: { sys_id: id(4) } } }, { operation: "post", response: { result: { sys_id: id(5) } } }],
      tableAccess: authoringPolicy,
    });
    try {
      const args = { action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(3)] };
      const result = await published(h, "sn_atf_author", args);
      const data = (result.structuredContent as { data: Record<string, unknown> }).data;
      expect(data.results).toEqual([
        { table: "sys_atf_test_suite_test", sys_id: id(4) },
        { table: "sys_atf_test_suite_test", sys_id: id(5) },
      ]);
      expect(data.advice).toBeUndefined();
      for (const sysId of [id(4), id(5)]) expect(textOf(result)).toContain(`${SNSDK54_INSTANCE}/sys_atf_test_suite_test.do?sys_id=${sysId}`);
      expect(JSON.stringify(result.structuredContent)).not.toContain(HOST);
      expect(textOf(result)).toBe(textWithout("sn_atf_author", args, result, () => {}));
    } finally { await h.close(); }
  });

  it("has the advice after an insert whose outcome is not known", async () => {
    const h = await createMockServiceNowHarness({
      modules: [atfAuthorToolModule],
      steps: [...membershipReads, { operation: "post", response: { result: { sys_id: id(4) } } }, { operation: "post", error: new Error("upstream detail") }, { operation: "delete", response: { status: 204 } }],
      tableAccess: authoringPolicy,
    });
    try {
      const args = { action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2), id(3)] };
      const result = await published(h, "sn_atf_author", args);
      const data = (result.structuredContent as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ outcome: "failed", uncertain_insert: true, advice: [ATF_UNCERTAIN_INSERT_ADVICE] });
      expect(textOf(result)).toContain(ATF_UNCERTAIN_INSERT_ADVICE);
      expect(textOf(result)).toBe(textWithout("sn_atf_author", args, result, (value) => { delete value.advice; }));
    } finally { await h.close(); }
  });

  it("has no advice after a failure that is certain", async () => {
    const h = await createMockServiceNowHarness({
      modules: [atfAuthorToolModule],
      steps: [rows([]), rows([])],
      tableAccess: authoringPolicy,
    });
    try {
      const result = await published(h, "sn_atf_author", { action: "add_tests_to_suite", suite_sys_id: id(1), test_sys_ids: [id(2)] });
      const data = (result.structuredContent as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({ outcome: "failed", uncertain_insert: false });
      expect(data.advice).toBeUndefined();
      expect(textOf(result)).not.toContain(ATF_UNCERTAIN_INSERT_ADVICE);
    } finally { await h.close(); }
  });
});
