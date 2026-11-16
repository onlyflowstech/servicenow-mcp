import { describe, expect, it } from "vitest";

import { evaluateUpdateSets } from "../../src/update-set-eval/engine.js";
import { RULE_IDS, RULE_MESSAGES, callBefore, type RuleId } from "../../src/update-set-eval/rules.js";
import type { EvaluationInput, EvaluationResult } from "../../src/update-set-eval/types.js";
import {
  CHILD_ID,
  CONTEXT,
  RULE_CASES,
  SET_ID,
  input,
  set,
  update,
} from "../fixtures/update-set-eval/rule-cases.js";

const ids = (result: EvaluationResult) => result.findings.map((f) => f.rule_id);
const run = (value: EvaluationInput) => evaluateUpdateSets(value);
const only = (result: EvaluationResult, id: RuleId) => result.findings.filter((f) => f.rule_id === id);

describe("one positive and one negative case per rule", () => {
  it("covers all 32 rules", () => {
    expect(RULE_IDS).toHaveLength(32);
    expect(Object.keys(RULE_CASES).sort()).toEqual([...RULE_IDS].sort());
  });

  describe.each(RULE_IDS.map((id) => [id] as [RuleId]))("%s", (id) => {
    it("positive: reports the rule", async () => {
      const result = await run(RULE_CASES[id].positive());
      expect(ids(result)).toContain(id);
      for (const finding of only(result, id)) {
        expect(finding.group).toBe(id.startsWith("PERF") ? "perf" : id.startsWith("SEC") ? "sec" : "bp");
        expect(Object.values(RULE_MESSAGES)).toContain(finding.message.replace(/table [a-z0-9_]+,/u, "table {table},"));
      }
    });

    it("negative: does not report the rule", async () => {
      expect(ids(await run(RULE_CASES[id].negative()))).not.toContain(id);
    });
  });
});

describe("rule details", () => {
  it("gives a script finding its element and 1-based line", async () => {
    const [finding] = only(await run(RULE_CASES.PERF001.positive()), "PERF001");
    expect(finding).toMatchObject({ field: "script", line: 5, severity: "high", confidence: "high" });
    expect(finding.update?.update_set).toBe(SET_ID);
  });

  it("SEC001 is medium for a scoped ACL with a role, and high when it is deleted", async () => {
    const role = `<sys_security_acl_role action="INSERT_OR_UPDATE"><sys_user_role display_value="itil">${"1".repeat(32)}</sys_user_role></sys_security_acl_role>`;
    const acl = update("sys_security_acl", { name: "incident", operation: "read", advanced: "false", condition: "active=true" });
    const withRole = { ...acl, payload: (acl.payload ?? "").replace("</record_update>", `${role}</record_update>`) };
    expect(only(await run(input([withRole])), "SEC001")[0].severity).toBe("medium");
    const deleted = update("sys_security_acl", { name: "incident" }, { action: "DELETE" });
    expect(only(await run(input([deleted])), "SEC001")[0].severity).toBe("high");
    const open = update("sys_security_acl", { name: "incident", operation: "read", advanced: "false", condition: "" });
    expect(only(await run(input([open])), "SEC001")[0].severity).toBe("high");
  });

  it("SEC002 is critical for an elevated role and high otherwise", async () => {
    expect(only(await run(RULE_CASES.SEC002.positive()), "SEC002")[0].severity).toBe("critical");
    const plain = update("sys_user_role_contains", { role: { value: "1".repeat(32), display: "x_app.manager" }, contains: { value: "2".repeat(32), display: "x_app.user" } });
    expect(only(await run(input([plain])), "SEC002")[0].severity).toBe("high");
  });

  it("SEC003 is medium for client-callable and high when isPublic returns true", async () => {
    expect(only(await run(RULE_CASES.SEC003.positive()), "SEC003")[0].severity).toBe("high");
    const callable = update("sys_script_include", { name: "Util", client_callable: "true", script: "var Util = Class.create();" });
    expect(only(await run(input([callable])), "SEC003")[0].severity).toBe("medium");
  });

  it("SEC006 is high for a password-typed property, read from a credential row", async () => {
    const property = update("sys_properties", { name: "x_app.vendor.token", type: "password2", value: "ciphertext" }, { target_name: "x_app.vendor.token" });
    const result = await run(input([property]));
    expect(only(result, "SEC006")[0].severity).toBe("high");
    expect(ids(result)).toContain("SEC010");
    expect(result.coverage.credential_rows).toBe(1);
  });

  it("PERF004 is high when the query rule itself queries", async () => {
    const row = update("sys_script", { name: "BR", when: "before", action_query: "true", script: "var g = new GlideRecord('x'); g.addActiveQuery(); g.query();" });
    expect(only(await run(input([row])), "PERF004")[0].severity).toBe("high");
  });

  it("BP004 on a remote set reports problems outside the resolved statuses, an empty one included", async () => {
    const row = update("sys_script", { name: "BR", script: "gs.info(1);" });
    const remote = (status: string | null) =>
      input([row], { source: "remote", problems: [{ sys_id: "9".repeat(32), remote_update: row.sys_id, status, type: "warning" }] });
    expect(ids(await run(remote("")))).toContain("BP004");
    expect(ids(await run(remote(null)))).toContain("BP004");
    expect(ids(await run(remote("resolved")))).toContain("BP004");
    for (const status of ["ignored", "skipped", "skip_collision"]) expect(ids(await run(remote(status)))).not.toContain("BP004");
    // A blocking problem with no row in scope is reported on the set.
    const orphan = input([row], { source: "remote", problems: [{ sys_id: "9".repeat(32), remote_update: null, status: "" }] });
    expect(only(await run(orphan), "BP004")[0].update_set?.sys_id).toBe(SET_ID);
  });

  it("PERF009 also counts a batch as a whole", async () => {
    const result = await run(
      input([], {
        batch_root: SET_ID,
        sets: [set({ update_count: 600 }), set({ sys_id: CHILD_ID, name: "Child", parent: SET_ID, update_count: 600 })],
        updates_total: 0,
      })
    );
    expect(only(result, "PERF009")).toEqual([expect.objectContaining({ update_set: { sys_id: SET_ID, name: "Release 1" }, severity: "medium" })]);
  });
});

describe("SEC005: no location, and call shapes that are not credentials", () => {
  const SECRET = "Zq9-never-in-output";

  it("carries no field, line, offset or matched text", async () => {
    const row = update("sys_script", { name: "BR", script: `\n\nvar password = '${SECRET}';` });
    const result = await run(input([row]));
    const [finding] = only(result, "SEC005");
    expect(finding).toBeDefined();
    expect(Object.keys(finding).sort()).toEqual(["confidence", "group", "message", "rule_id", "severity", "update"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("skips g_form display calls whose first argument is a password field", async () => {
    const calls = ["showFieldMsg", "setLabelOf", "setMandatory", "addDecoration"]
      .map((method) => `g_form.${method}('password', 'Shown text here');`)
      .join("\n");
    const row = update("sys_script_client", { name: "CS", script: `function onLoad() {\n${calls}\n}` });
    expect(ids(await run(input([row])))).not.toContain("SEC005");
  });

  it("reports an encoded-query match at medium severity and low confidence", async () => {
    const row = update("sys_script", { name: "BR", script: "var gr = new GlideRecord('x');\ngr.addEncodedQuery('key=abcdef^active=true');\ngr.query();" });
    expect(only(await run(input([row])), "SEC005")).toEqual([expect.objectContaining({ severity: "medium", confidence: "low" })]);
  });

  it("still reports a real literal next to an excluded call", async () => {
    const row = update("sys_script", { name: "BR", script: "g_form.setMandatory('password', 'true');\nr.setBasicAuth('svc', 'Zq9-real');" });
    expect(only(await run(input([row])), "SEC005")).toEqual([expect.objectContaining({ severity: "high", confidence: "high" })]);
  });

  it("never scans a credential-table row", async () => {
    const row = update("oauth_entity", { name: "Vendor", client_secret: "Zq9-oauth-secret", script: "gs.sleep(1);" });
    const result = await run(input([row]));
    expect(ids(result)).toEqual(expect.arrayContaining(["SEC010"]));
    expect(ids(result)).not.toContain("SEC005");
    expect(ids(result)).not.toContain("PERF008");
  });

  it("finds the call before a value", () => {
    const text = "g_form.setMandatory( 'password' , 'true' )";
    expect(callBefore(text, text.indexOf("true"))).toEqual({ receiver: "g_form", method: "setMandatory" });
    const query = "gr.addEncodedQuery('active=true^key=abc')";
    expect(callBefore(query, query.indexOf("abc"))).toEqual({ receiver: "gr", method: "addEncodedQuery" });
    expect(callBefore("var password = 'x'", 16)).toBeNull();
    expect(callBefore('"{\\"password\\":\\"x\\"}"', 17)).toBeNull();
  });
});

describe("options", () => {
  it("runs only the requested groups and drops findings below min_severity", async () => {
    const row = update("sys_script", { name: "BR", script: "gs.log('x');\ncurrent.update();\nvar r = eval('1');" }, { replace_on_upgrade: true });
    const all = await run(input([row]));
    expect(new Set(ids(all))).toEqual(new Set(["BP011", "PERF007", "SEC004", "BP012"]));
    const sec = await evaluateUpdateSets(input([row]), { groups: ["sec"] });
    expect(ids(sec)).toEqual(["SEC004"]);
    expect(sec.summary.by_group).toEqual({ perf: 0, sec: 1, bp: 0 });
    const high = await evaluateUpdateSets(input([row]), { min_severity: "high" });
    expect(new Set(ids(high))).toEqual(new Set(["PERF007", "SEC004"]));
    expect(high.summary.by_severity).toEqual({ info: 0, low: 0, medium: 0, high: 2, critical: 0 });
  });

  it("sorts by severity, then rule id, then sys_id", async () => {
    const rows = [
      update("sys_script", { name: "A", script: "gs.log(1);" }),
      update("sys_script", { name: "B", script: "gs.log(1); current.update();" }),
      update("sys_user_role_contains", { contains: { value: "2".repeat(32), display: "admin" } }),
    ];
    const result = await run(input(rows));
    const order = result.findings.map((f) => `${f.severity}:${f.rule_id}`);
    expect(order.slice(0, 2)).toEqual(["critical:SEC002", "high:PERF007"]);
    const logs = result.findings.filter((f) => f.rule_id === "BP011").map((f) => f.update?.sys_id);
    expect(logs).toEqual([...logs].sort());
  });

  it("returns at most maxFindings and counts every finding in the summary", async () => {
    const rows = Array.from({ length: 30 }, () => update("sys_script", { name: "BR", script: "gs.log(1);" }));
    const result = await evaluateUpdateSets(input(rows), {}, { cpuBudgetMs: 250, yieldEvery: 50, maxFindings: 10, maxPayloadBytes: 262_144, maxTotalBytes: 16 << 20 });
    expect(result.findings).toHaveLength(10);
    expect(result.findings_truncated).toBe(true);
    expect(result.summary.by_group.bp).toBe(30);
  });

  it("refuses limits out of range with a fixed message", async () => {
    await expect(
      evaluateUpdateSets(input([]), {}, { cpuBudgetMs: 0, yieldEvery: 50, maxFindings: 1, maxPayloadBytes: 1, maxTotalBytes: 1 })
    ).rejects.toThrow("Evaluator limits are out of range.");
    await expect(
      evaluateUpdateSets(input([]), {}, { cpuBudgetMs: 1, yieldEvery: 50, maxFindings: 1, maxPayloadBytes: 2 << 20, maxTotalBytes: 1 })
    ).rejects.toThrow(RangeError);
  });

  it("reports a check it could not make, rather than treating it as clean", async () => {
    const context = { ...CONTEXT, hiddenFieldNames: () => "unavailable" as const, extendsMetadata: () => "unknown" as const };
    const result = await run(input([update("u_vendor", { u_api_password: "x" })], { context, baseline_versions: undefined }));
    expect(ids(result)).not.toContain("SEC010");
    expect(ids(result)).not.toContain("SEC011");
    expect(result.coverage.checks_unavailable).toBe(3);
    expect(result.coverage.partial).toBe(true);
  });
});
