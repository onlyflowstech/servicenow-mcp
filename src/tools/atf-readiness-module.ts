import { z } from "zod";
import { serviceNowSysIdSchema as id } from "../servicenow-identifiers.js";
import { authorizeTableAccess, TablePolicyError } from "../table-policy.js";
import { trustedToolErrorDescriptor } from "../tool-error.js";
import { ok } from "../utils.js";
import { defineServiceNowToolModule, withRequiredProfile } from "./tool-module.js";
import { envelopeCompatibilityResult, productionToolOutputSchemas } from "./result-envelope.js";
import { prepareAtfReads, readAtfRows, resolveSuite, value, display } from "./atf-shared.js";

const baseTables = ["v_plugin", "sys_properties", "sys_scope"];
const suiteTables = ["sys_atf_test_suite", "sys_atf_test_suite_test", "sys_atf_test", "sys_atf_step", "sys_atf_step_config"];
const schema = withRequiredProfile(z.object({
  suite_sys_id: id.optional().describe("Optional suite ID to verify membership and UI-runner requirements"),
  suite_name: z.string().trim().min(1).max(100).optional().describe("Optional exact suite name; mutually exclusive with suite_sys_id"),
}).strict());
export const atfReadinessToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition: { name: "sn_atf_readiness", description: "Check ATF plugins, properties, runner availability and profile grants. Unreadable or unverified checks are reported explicitly. Optionally inspect a suite and its child suites for active tests and UI steps.",
    annotations: { title: "Check ATF readiness", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  inputSchema: schema, outputSchema: productionToolOutputSchemas.sn_atf_readiness,
  requirements: { permissions: ["read"], tables: { kind: "static", names: [...baseTables, ...suiteTables] }, apis: ["cicd", "table"], fieldPolicies: ["read"], capabilities: ["atf:readiness"] },
  resolveAccess: (candidate, policy) => {
    const input = schema.parse(candidate);
    if (input.suite_sys_id && input.suite_name) throw new Error("Supply only one suite selector");
    let args: Record<string, unknown> = input;
    const allowed: string[] = [];
    for (const table of [...baseTables, ...(input.suite_sys_id || input.suite_name ? suiteTables : [])]) {
      try {
        authorizeTableAccess(policy.tableAccess, { operation: "read", table }, "sn_atf_readiness");
        args = prepareAtfReads(args, [table]); allowed.push(table);
      } catch { /* Report each denied check without issuing its request. */ }
    }
    if (!allowed.length) throw new TablePolicyError();
    return { args: { ...args, allowed }, requests: allowed.map(table => ({ operation: "read" as const, table })) };
  },
  handler: async (args, services) => {
    const checks: { check: string; status: "pass" | "fail" | "warn"; message: string }[] = [];
    const add = (check: string, status: "pass" | "fail" | "warn", message: string) => checks.push({ check, status, message });
    const allowed = args.allowed as string[];
    const read = async (table: string, query: string, limit = 1000) => {
      if (!allowed.includes(table)) throw new Error("Check denied by profile");
      return readAtfRows(services, args, table, query, limit);
    };
    for (const [name, plugin] of [["ATF plugin", "com.glide.automated_testing_framework"], ["CI/CD plugin", "com.glide.continuousdelivery"]]) {
      try {
        const rows = await read("v_plugin", `id=${plugin}`, 1);
        add(name, rows.length === 1 && ["true", "active"].includes(value(rows[0].active)) ? "pass" : "fail", rows.length === 1 && ["true", "active"].includes(value(rows[0].active)) ? "Active" : `Activate ${plugin}`);
      } catch { add(name, "warn", "Could not verify; grant access to v_plugin and check the plugin on the instance."); }
    }
    try {
      const rows = await read("sys_properties", "nameINsn_atf.runner.enabled,sn_atf.schedule.enabled", 2);
      const props = new Map(rows.map(row => [value(row.name), value(row.value)]));
      add("Execution property", props.get("sn_atf.runner.enabled") === "true" ? "pass" : "fail", props.get("sn_atf.runner.enabled") === "true" ? "Enabled" : "Set sn_atf.runner.enabled=true on the test instance.");
      add("Scheduled execution (informational)", "pass", props.get("sn_atf.schedule.enabled") === "true" ? "Enabled" : "Disabled; not required for an on-demand CI/CD run.");
    } catch { add("Execution properties", "warn", "Could not verify sys_properties values."); }
    let requiresUI: boolean | undefined;
    if (args.suite_sys_id || args.suite_name) {
      try {
        if (!suiteTables.every(table => allowed.includes(table))) throw new Error("Suite inspection is not fully granted");
        const suite = await resolveSuite(services, args);
        const queue = [suite.id]; const suites = new Set<string>(); const tests = new Set<string>();
        while (queue.length) {
          const suiteId = queue.shift()!;
          if (suites.has(suiteId)) throw new Error("Cyclic suite hierarchy");
          suites.add(suiteId); if (suites.size > 100) throw new Error("Suite hierarchy exceeds inspection limit");
          for (const child of await read("sys_atf_test_suite", `parent=${suiteId}^active=true`, 100)) queue.push(id.parse(value(child.sys_id)));
          for (const member of await read("sys_atf_test_suite_test", `test_suite=${suiteId}`)) tests.add(id.parse(value(member.test)));
        }
        if (tests.size > 1000) throw new Error("Suite has too many tests to inspect");
        requiresUI = false; let activeTests = 0; let emptyTests = 0; let missingTests = 0;
        if (tests.size) {
          const found = await read("sys_atf_test", `sys_idIN${[...tests].join(",")}`);
          const foundIds = new Set(found.map(test => id.parse(value(test.sys_id))));
          missingTests = [...tests].filter(test => !foundIds.has(test)).length;
          if (found.some(test => !["true", "false"].includes(value(test.active)))) throw new Error("Unreadable test activity");
          const active = found.filter(test => value(test.active) === "true");
          activeTests = active.length;
          for (const test of active) {
            const steps = await read("sys_atf_step", `test=${id.parse(value(test.sys_id))}^active=true`);
            const configs = [...new Set(steps.map(step => id.parse(value(step.step_config))))];
            if (!configs.length) { emptyTests++; continue; }
            const rows = await read("sys_atf_step_config", `sys_idIN${configs.join(",")}`);
            if (rows.length !== configs.length || rows.some(row => !display(row.step_env))) throw new Error("Incomplete step environment metadata");
            if (rows.some(row => display(row.step_env) === "UI")) requiresUI = true;
          }
        }
        add("Suite memberships", missingTests ? "fail" : "pass", missingTests ? `${missingTests} referenced tests are missing or unreadable.` : "All referenced tests are readable.");
        add("Active test steps", emptyTests ? "fail" : "pass", emptyTests ? `${emptyTests} active tests have no active steps.` : "No empty active tests found.");
        add("Suite", activeTests && !missingTests && !emptyTests ? "pass" : "fail", `${activeTests} active tests; ${requiresUI ? "Cloud Runner required" : activeTests > emptyTests ? "server-only steps" : "no executable steps"}.`);
      } catch { requiresUI = undefined; add("Suite", "warn", "Could not completely verify the active suite, memberships, or step environments."); }
    }
    try {
      const apps = await read("sys_scope", "scope=sn_atf_tg", 1);
      add("Cloud Runner app", apps.length === 1 ? "pass" : "fail", apps.length === 1 ? "ATF Test Generator and Cloud Runner is installed." : "Install and configure ServiceNow ATF Test Generator and Cloud Runner (sn_atf_tg). Local browser fallback is disabled.");
      if (apps.length === 1) add("Cloud Runner configuration", "warn", "Installation alone does not verify cloud provisioning or the configured cloud user. Validate with a cloud run; no local browser is used.");
    } catch { add("Cloud Runner app", "warn", "Could not verify sn_atf_tg; grant read access to sys_scope and verify Cloud Runner configuration. No local browser fallback is used."); }
    try {
      await services.serviceNow.get("/api/sn_cicd/progress/00000000000000000000000000000000");
      add("CI/CD role", "pass", "CI/CD progress endpoint accepted the request.");
    } catch (error) {
      const denied = trustedToolErrorDescriptor(error)?.category === "authorization";
      add("CI/CD role", denied ? "fail" : "warn", denied ? "Grant sn_cicd.sys_ci_automation (or an appropriate administrator role)." : "Role probe is inconclusive: an unknown progress ID does not prove role membership. Verify it on the instance.");
    }
    add("Execution grant", services.policy.atf.execute ? "pass" : "fail", services.policy.atf.execute ? "Profile enables execution." : "Set atf.execute=true on this profile to permit runs.");
    const authorTables = ["sys_atf_test", "sys_atf_test_suite", "sys_atf_test_suite_test", "sys_atf_step", "sys_variable_value", "sys_element_mapping"];
    const authorAllowed = authorTables.every(table => { try { authorizeTableAccess(services.policy.tableAccess, { operation: "write", table }, "sn_atf_author"); return true; } catch { return false; } });
    add("Authoring grants (informational)", "pass", authorAllowed ? "Authoring table grants are configured." : "Authoring writes are not fully granted; use setup grant --atf if authoring is needed.");
    const verdict = checks.some(check => check.status === "fail") ? "blocked" : checks.some(check => check.status === "warn") ? "unverified" : "ready";
    return envelopeCompatibilityResult("sn_atf_readiness", args, ok({ verdict, checks }));
  },
});
