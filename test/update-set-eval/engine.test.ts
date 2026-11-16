import { describe, expect, it } from "vitest";

import { ENGINE_LIMITS, evaluateUpdateSets } from "../../src/update-set-eval/engine.js";
import { RULE_IDS } from "../../src/update-set-eval/rules.js";
import type { EngineLimits, EvaluateUpdate } from "../../src/update-set-eval/types.js";
import { RULE_CASES, input, sid, update } from "../fixtures/update-set-eval/rule-cases.js";

const br = (script: string) => update("sys_script", { name: "BR", when: "before", script });

/** A fake clock: each read advances it by `step` ms; `jump` adds time that passes while the engine yields. */
function fakeClock(step: number, jump = 0) {
  let t = 0;
  let yields = 0;
  return {
    hooks: {
      now: () => (t += step),
      yieldToLoop: async () => {
        yields++;
        t += jump;
      },
    },
    yields: () => yields,
  };
}

const limits = (overrides: Partial<EngineLimits>): EngineLimits => ({ ...ENGINE_LIMITS, ...overrides });

describe("coverage", () => {
  it("reports a full scan when every payload was read", async () => {
    const result = await evaluateUpdateSets(input([br("gs.info(1);"), br("gs.info(2);")]));
    expect(result.coverage).toEqual({
      updates_total: 2,
      evaluated: 2,
      scanned: 2,
      skipped_unreadable: 0,
      credential_rows: 0,
      not_evaluated: 0,
      checks_unavailable: 0,
      partial: false,
      cpu_budget_hit: false,
      bytes_cap_hit: false,
      metadata_only: false,
    });
    expect(result.rules_version).toBe("1");
  });

  it("runs only metadata rules when field policy hides payloads", async () => {
    const row = { ...br("current.update();"), action: "DELETE" };
    const result = await evaluateUpdateSets(input([row], { payload_access: "denied" }));
    expect(result.findings.map((f) => f.rule_id)).toEqual(["BP003"]);
    expect(result.coverage).toMatchObject({ scanned: 0, skipped_unreadable: 0, metadata_only: true, partial: false });
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["a DOCTYPE", '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "current.update();">]><record_update table="sys_script"><sys_script><script>&e;</script></sys_script></record_update>'],
    ["a mid-document processing instruction", '<record_update table="sys_script"><?x y?><sys_script><script>current.update();</script></sys_script></record_update>'],
    ["nesting past the depth cap", `<record_update table="sys_script">${"<a>".repeat(70)}${"</a>".repeat(70)}</record_update>`],
    ["more elements than the cap", `<record_update table="sys_script"><sys_script>${"<a/>".repeat(20_001)}</sys_script></record_update>`],
    ["a payload over 256 KiB", `<record_update table="sys_script"><sys_script><script>current.update();${" ".repeat(262_144)}</script></sys_script></record_update>`],
  ])("counts a payload that is %s as not scanned, never as clean", async (_label, payload) => {
    const row: EvaluateUpdate = { ...br("unused"), payload, action: "DELETE" };
    const result = await evaluateUpdateSets(input([row]));
    expect(result.coverage).toMatchObject({ evaluated: 1, scanned: 0, skipped_unreadable: 1, partial: true });
    // Metadata rules still run; script rules do not.
    expect(result.findings.map((f) => f.rule_id)).toEqual(["BP003"]);
  });

  it("counts rows the caller did not read as not evaluated", async () => {
    const result = await evaluateUpdateSets(input([br("gs.info(1);")], { updates_total: 1_200 }));
    expect(result.coverage).toMatchObject({ updates_total: 1_200, evaluated: 1, not_evaluated: 1_199, partial: true });
  });

  it("skips a row whose ids are not sys_ids", async () => {
    const result = await evaluateUpdateSets(input([{ ...br("current.update();"), sys_id: "not-an-id" }]));
    expect(result.findings).toEqual([]);
    expect(result.coverage).toMatchObject({ evaluated: 0, not_evaluated: 1, partial: true });
  });
});

describe("CPU budget, counted between rows", () => {
  const rows = () => Array.from({ length: 200 }, (_, k) => br(`gs.info(${k});`));

  it("stops when the budget runs out and returns a partial result", async () => {
    // Each clock read costs 1 ms, and each row reads the clock twice.
    const clock = fakeClock(1);
    const result = await evaluateUpdateSets(input(rows()), {}, limits({ cpuBudgetMs: 100 }), clock.hooks);
    expect(result.coverage.cpu_budget_hit).toBe(true);
    expect(result.coverage.partial).toBe(true);
    expect(result.coverage.evaluated).toBeGreaterThan(0);
    expect(result.coverage.evaluated).toBeLessThan(200);
    expect(result.coverage.not_evaluated).toBe(200 - result.coverage.evaluated);
  });

  it("does not count time spent yielding to other work", async () => {
    // 10 s pass during every yield; the engine's own time stays small.
    const clock = fakeClock(0.01, 10_000);
    const result = await evaluateUpdateSets(input(rows()), {}, limits({ cpuBudgetMs: 250 }), clock.hooks);
    expect(result.coverage.cpu_budget_hit).toBe(false);
    expect(result.coverage.evaluated).toBe(200);
    expect(clock.yields()).toBe(3); // after rows 50, 100 and 150
  });

  it("evaluates every row of a real 500-row scope", async () => {
    // The real clock, with a budget no runner reaches: this checks that all
    // rows are evaluated. The budget itself is tested with the fake clock above.
    const script = RULE_CASES.PERF001.positive().updates[0].payload ?? "";
    const many = Array.from({ length: 500 }, () => ({ ...br("x"), payload: script }));
    const result = await evaluateUpdateSets(input(many), {}, limits({ cpuBudgetMs: 5_000 }));
    expect(result.coverage.evaluated).toBe(500);
    expect(result.coverage.cpu_budget_hit).toBe(false);
  });
});

describe("byte caps", () => {
  it("stops reading payloads past the per-call byte cap", async () => {
    const big = Array.from({ length: 10 }, () => br(`gs.info('${"x".repeat(10_000)}');`));
    const result = await evaluateUpdateSets(input(big), {}, limits({ maxTotalBytes: 30_000 }));
    expect(result.coverage.bytes_cap_hit).toBe(true);
    expect(result.coverage.evaluated).toBe(3);
    expect(result.coverage.partial).toBe(true);
  });

  it("honours a lower per-payload cap", async () => {
    const result = await evaluateUpdateSets(input([br(`gs.info('${"x".repeat(5_000)}');`)]), {}, limits({ maxPayloadBytes: 1_000 }));
    expect(result.coverage).toMatchObject({ scanned: 0, skipped_unreadable: 1 });
  });
});

describe("no payload text in any message or finding", () => {
  const CANARY = "CANARY_d2_payload_text";

  it("keeps payload text out of the whole result, for every rule's positive case", async () => {
    for (const id of RULE_IDS) {
      const value = RULE_CASES[id].positive();
      const updates = value.updates.map((u) =>
        u.payload === null ? u : { ...u, payload: u.payload.replace("</record_update>", `<u_note>${CANARY}</u_note></record_update>`) }
      );
      const result = await evaluateUpdateSets({ ...value, updates });
      const text = JSON.stringify(result);
      expect(text, id).not.toContain(CANARY);
      expect(result.findings.length, id).toBeGreaterThan(0);
    }
  });

  it("puts no script text in a finding, even where a script names a table or a secret", async () => {
    const script = `var ${CANARY} = new GlideRecord('${CANARY}');\n${CANARY}.query();\ngs.log('${CANARY}');\nvar password = '${CANARY}';`;
    const result = await evaluateUpdateSets(input([br(script)]));
    expect(result.findings.length).toBeGreaterThan(2);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("puts SEC011's table in its own field, never in the message", async () => {
    const row = update("incident", { number: "INC1" });
    const [finding] = (await evaluateUpdateSets(input([row]))).findings.filter((f) => f.rule_id === "SEC011");
    expect(finding.table).toBe("incident");
    expect(finding.message).not.toContain("incident");
  });

  it("caps row metadata it returns as data", async () => {
    const row = { ...br("current.update();"), target_name: "t".repeat(5_000) };
    const [finding] = (await evaluateUpdateSets(input([row]))).findings;
    expect(finding.update?.target_name).toHaveLength(200);
  });

  it("never throws on hostile rows", async () => {
    const hostile: EvaluateUpdate[] = [
      { ...br("x"), payload: "<".repeat(10_000) },
      { ...br("x"), payload: `<record_update table="sys_script"><sys_script><script>${"{(".repeat(20_000)}</script></sys_script></record_update>` },
      { ...br("x"), payload: `<record_update table="sys_script"><sys_script><script>${"while(a.next()){".repeat(5_000)}</script></sys_script></record_update>` },
      { ...br("x"), name: "__proto__", table: "constructor", payload: "<__proto__/>" },
      { ...br("x"), sys_id: sid(7), update_set: "x".repeat(32) },
    ];
    const result = await evaluateUpdateSets(input(hostile));
    expect(result.coverage.evaluated).toBe(4);
  });
});
