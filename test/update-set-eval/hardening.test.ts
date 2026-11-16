// Cases from the D2 security review: payload structure the rules cannot
// cover, checks that do not answer as declared, malformed input, and
// evasions of SEC004 and SEC009.

import { describe, expect, it } from "vitest";

import { evaluateUpdateSets } from "../../src/update-set-eval/engine.js";
import type { EvaluateUpdate, EvaluationInput, EvaluationResult } from "../../src/update-set-eval/types.js";
import { CONTEXT, input, sid, update } from "../fixtures/update-set-eval/rule-cases.js";

const SECRET = "Zq9-Secret-Value-77";
const CANARY = "CANARY_d2_hardening";
const EVIL = `eval(x); current.update(); var password = '${SECRET}';`;
const ids = (r: EvaluationResult) => r.findings.map((f) => f.rule_id);
const br = (script: string) => update("sys_script", { name: "BR", when: "before", script });
const row = (payload: string, overrides: Partial<EvaluateUpdate> = {}): EvaluateUpdate => ({ ...br("unused"), payload, ...overrides });

describe("structure the rules cannot cover is not scanned, and says so", () => {
  it.each([
    ["a duplicate script element, benign first", `<record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><script>gs.info(1);</script><script>${EVIL}</script></sys_script></record_update>`],
    ["a script element holding an element", `<record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><script>gs.info(1);<x/>${EVIL}</script></sys_script></record_update>`],
    ["a script nested one level", `<record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><w><script>${EVIL}</script></w></sys_script></record_update>`],
    ["a wrapped record", `<record_update table="sys_script"><wrap><sys_script action="INSERT_OR_UPDATE"><script>${EVIL}</script></sys_script></wrap></record_update>`],
    ["a root that is not record_update", `<unload><sys_script action="INSERT_OR_UPDATE"><script>${EVIL}</script></sys_script></unload>`],
    ["a root table that disagrees with the record", `<record_update table="sys_ui_page"><sys_script action="INSERT_OR_UPDATE"><when>before</when><script>${EVIL}</script></sys_script></record_update>`],
    ["a root table of constructor", `<record_update table="constructor"><sys_script action="INSERT_OR_UPDATE"><script>${EVIL}</script></sys_script></record_update>`],
  ])("%s", async (_label, payload) => {
    const result = await evaluateUpdateSets(input([row(payload)]));
    expect(result.coverage).toMatchObject({ scanned: 0, skipped_unreadable: 1, partial: true });
    expect(ids(result)).not.toContain("SEC004");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("scans a record element named after an Object prototype property", async () => {
    const payload = `<record_update><constructor action="INSERT_OR_UPDATE"><script>${EVIL}</script></constructor></record_update>`;
    const result = await evaluateUpdateSets(input([row(payload, { name: "x", table: null })]));
    expect(result.coverage.scanned).toBe(1);
    expect(ids(result)).toEqual(expect.arrayContaining(["SEC004", "SEC005"]));
  });

  it("handles a credential column with a prototype-named root without throwing", async () => {
    const payload = `<record_update table="constructor"><sys_properties action="INSERT_OR_UPDATE"><name>p</name><value>v</value></sys_properties></record_update>`;
    const result = await evaluateUpdateSets(input([row(payload, { name: "x", table: "sys_properties" })]));
    expect(result.coverage.credential_rows).toBe(1);
    expect(ids(result)).toContain("SEC010");
  });

  it("treats a row as a credential row when any record is on a credential table", async () => {
    const payload =
      `<record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><script>gs.info(1);</script></sys_script>` +
      `<sys_properties action="INSERT_OR_UPDATE"><name>p</name><value>${CANARY} password='${SECRET}'</value></sys_properties></record_update>`;
    const result = await evaluateUpdateSets(input([row(payload, { name: "anything", table: null })]));
    expect(result.coverage).toMatchObject({ credential_rows: 1, scanned: 0 });
    expect(ids(result)).toContain("SEC010");
    expect(ids(result)).not.toContain("SEC005");
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(CANARY);
  });
});

describe("the caller's checks fail closed", () => {
  const rows = () => [br("current.update();"), update("incident", { number: "INC1" }), update("u_vendor", { u_api_password: "x" })];
  const run = (overrides: Partial<EvaluationInput>) => evaluateUpdateSets(input(rows(), overrides));
  const thrower = () => {
    throw new Error(`lookup failed for ${CANARY}`);
  };

  it.each([
    ["throws", thrower],
    ["returns undefined", () => undefined],
    ["returns a string", () => "true"],
  ])("isCredentialTable %s: every row is a credential row, and the result is partial", async (_label, check) => {
    const result = await run({ context: { ...CONTEXT, isCredentialTable: check as never } });
    expect(result.coverage).toMatchObject({ credential_rows: 3, scanned: 0, partial: true });
    expect(result.coverage.checks_unavailable).toBeGreaterThan(0);
    expect(ids(result)).not.toContain("PERF007");
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it.each([
    ["throws", thrower],
    ["returns undefined", () => undefined],
    ["returns an array", () => ["u_api_password"]],
    ["returns another sentinel", () => "unknown"],
  ])("hiddenFieldNames %s: the check is unavailable, not clean", async (_label, check) => {
    const result = await run({ context: { ...CONTEXT, hiddenFieldNames: check as never } });
    expect(result.coverage.checks_unavailable).toBeGreaterThan(0);
    expect(result.coverage.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it.each([
    ["throws", thrower],
    ["returns another sentinel", () => "unavailable"],
    ["returns undefined", () => undefined],
    ["returns a truthy string", () => "yes"],
  ])("extendsMetadata %s: SEC011 is unavailable, not silently skipped", async (_label, check) => {
    const result = await run({ context: { ...CONTEXT, extendsMetadata: check as never } });
    expect(ids(result)).not.toContain("SEC011");
    expect(result.coverage.checks_unavailable).toBeGreaterThan(0);
    expect(result.coverage.partial).toBe(true);
  });

  it("survives a missing context, with every check unavailable", async () => {
    const result = await run({ context: undefined as never });
    expect(result.coverage).toMatchObject({ credential_rows: 3, partial: true });
  });

  it("survives a context whose properties throw when read", async () => {
    const context = Object.defineProperty({}, "isCredentialTable", { get: thrower });
    const result = await run({ context: context as never });
    expect(result.coverage.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("malformed input never aborts the call", () => {
  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "1200"],
    ["negative", -1],
  ])("an updates_total that is %s makes the result partial", async (_label, total) => {
    const result = await evaluateUpdateSets(input([br("gs.info(1);")], { updates_total: total as never }));
    expect(result.coverage.partial).toBe(true);
    expect(Number.isFinite(result.coverage.not_evaluated)).toBe(true);
    expect(result.coverage.updates_total).toBe(1);
  });

  it("reads a payload_access other than granted as denied", async () => {
    const result = await evaluateUpdateSets(input([br("current.update();")], { payload_access: "Granted" as never }));
    expect(result.coverage.metadata_only).toBe(true);
    expect(ids(result)).not.toContain("PERF007");
  });

  it("treats non-string row fields as absent", async () => {
    const odd = { ...br("current.update();"), action: { value: "DELETE" } as never, type: { display_value: "x" } as never };
    const result = await evaluateUpdateSets(input([odd]));
    expect(result.coverage.evaluated).toBe(1);
    expect(ids(result)).toContain("PERF007");
    expect(result.findings[0].update?.type).toBeNull();
  });

  it("blocks on a preview-problem status that is not a string", async () => {
    const r = br("gs.info(1);");
    const result = await evaluateUpdateSets(
      input([r], { source: "remote", problems: [{ sys_id: sid(1), remote_update: r.sys_id, status: 3 as never }] })
    );
    expect(ids(result)).toContain("BP004");
  });

  it("keeps going past a row whose fields throw when read, and does not count it as scanned", async () => {
    const hostile = Object.defineProperty({ ...br("x") }, "payload", {
      get() {
        throw new Error(CANARY);
      },
    });
    const result = await evaluateUpdateSets(input([hostile, br("current.update();")]));
    expect(ids(result)).toContain("PERF007");
    expect(result.coverage).toMatchObject({ scanned: 1, partial: true });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("treats maps and lists of the wrong type as unavailable", async () => {
    const result = await evaluateUpdateSets(
      input([br("gs.info(1);")], { open_set_collisions: {} as never, baseline_versions: [] as never, sets: "x" as never })
    );
    expect(result.coverage.checks_unavailable).toBeGreaterThanOrEqual(3);
    expect(result.coverage.partial).toBe(true);
  });
});

describe("SEC004 and SEC009 evasions", () => {
  it.each([
    ["a unicode-escaped identifier", "\\u0065val(x);"],
    ["a braced unicode escape", "\\u{65}val(x);"],
    ["bracket access on gs", "gs['eval'](x);"],
    ["bracket access on this", 'this["GlideEvaluator"];'],
  ])("SEC004 catches %s", async (_label, script) => {
    expect(ids(await evaluateUpdateSets(input([br(script)])))).toContain("SEC004");
  });

  it("does not report a string that only names an evaluator", async () => {
    expect(ids(await evaluateUpdateSets(input([br("gs.info('GlideEvaluator'); var s = 'eval';")])))).not.toContain("SEC004");
  });

  it.each([["false"], ["0"], ["!1"]])("SEC009 catches setWorkflow(%s)", async (arg) => {
    expect(ids(await evaluateUpdateSets(input([br(`gr.setWorkflow(${arg});`)])))).toContain("SEC009");
  });

  it("does not report setWorkflow(true)", async () => {
    expect(ids(await evaluateUpdateSets(input([br("gr.setWorkflow(true);")])))).not.toContain("SEC009");
  });

  it("reads a broken unicode escape without throwing", async () => {
    for (const script of ["\\u00", "\\u{", "\\u{110000}x", "\\x", "\\u{" + "1".repeat(50)]) {
      await expect(evaluateUpdateSets(input([br(script)]))).resolves.toBeDefined();
    }
  });
});
