import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import { trustedToolErrorDescriptor } from "../src/tool-error.js";
import { envelopeCompatibilityResult } from "../src/tools/result-envelope.js";
import { ok } from "../src/utils.js";
import {
  PLATFORM_VIEWS,
  PLATFORM_VIEW_ALL_TABLES,
  PLATFORM_VIEW_TABLES,
  platformViewReadTables,
  type CanonicalPlatformViewArgs,
  type PlatformView,
  type PlatformViewHandler,
} from "../src/tools/platform-view-contracts.js";
import { createPlatformViewToolModule, platformViewToolModule } from "../src/tools/platform-view-module.js";
import { handleEvaluate } from "../src/tools/platform-view-evaluate.js";
import {
  closeHarnesses,
  expectReadsWithin,
  queryFields,
  harness,
  readPolicy,
  recordingInstance,
  tableOfCall,
  textOf,
} from "./platform-view-harness.js";

const SYS_ID = "0123456789abcdef0123456789abcdef";
const MINIMAL: Readonly<Record<PlatformView, Record<string, unknown>>> = {
  update_sets: {},
  update_set: { update_set: "My set" },
  changes: { update_set: SYS_ID },
  batch: { update_set: SYS_ID },
  remote_update_sets: {},
  upgrade_skipped: {},
  scan_findings: {},
  evaluate: { update_set: SYS_ID },
};

/** The call arguments that widen a view's plan to its largest. */
const WIDEST: Readonly<Record<PlatformView, Record<string, unknown>>> = {
  ...MINIMAL,
  changes: { update_set: SYS_ID, change: SYS_ID, payload: true },
  remote_update_sets: { problems: true },
};

/** Views whose handler is implemented; the others are still stubs. */
const IMPLEMENTED: readonly PlatformView[] = ["upgrade_skipped", "scan_findings"];
const STUB_VIEWS = PLATFORM_VIEWS.filter((view) => !IMPLEMENTED.includes(view));

function expectFixedInternalError(result: CallToolResult): void {
  expect(result.isError).toBe(true);
  const text = textOf(result);
  expect(text).toContain("Error category: internal.");
  expect(text).toContain("Retry unchanged is not recommended.");
  expect(result.structuredContent).toBeUndefined();
}

describe("sn_platform_view dispatcher", () => {
  it("lists one read-only tool, with the schema's keys and the declared tables", async () => {
    const { client } = await harness(recordingInstance().ops);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["sn_platform_view"]);
    expect(platformViewToolModule.definition.name).toBe("sn_platform_view");
    expect(platformViewToolModule.runtime).toBe("servicenow");
    expect(PLATFORM_VIEW_ALL_TABLES.length).toBeGreaterThan(0);
  });

  it("answers every view with the fixed not-implemented error, and reads nothing", async () => {
    const instance = recordingInstance();
    const { call } = await harness(instance.ops, { tableAccess: readPolicy(PLATFORM_VIEW_ALL_TABLES) });
    for (const view of STUB_VIEWS) {
      expectFixedInternalError(await call({ view, ...MINIMAL[view] }));
    }
    expect(instance.calls).toEqual([]);
  });

  it("stub handlers throw the fixed internal error and name nothing", async () => {
    const canonical = { view: "evaluate", limit: 25, offset: 0, max_response_bytes: 100_000 } as CanonicalPlatformViewArgs;
    const services = {} as never;
    for (const handler of [handleEvaluate]) {
      const error = await handler(canonical, services).then(
        () => undefined,
        (caught: unknown) => caught
      );
      expect(trustedToolErrorDescriptor(error)).toMatchObject({ category: "internal", retry: "do_not_retry" });
    }
  });

  it("refuses a selector the view does not take with a correctable error, before any handler runs", async () => {
    let reached = 0;
    const handlers = Object.fromEntries(PLATFORM_VIEWS.map((view) => [view, async () => { reached += 1; throw new Error("x"); }])) as Record<PlatformView, PlatformViewHandler>;
    const { call } = await harness(recordingInstance().ops, {
      tableAccess: readPolicy(PLATFORM_VIEW_ALL_TABLES),
      modules: [createPlatformViewToolModule(handlers)],
    });
    for (const args of [
      { view: "batch", update_set: SYS_ID, state: "complete" },
      { view: "scan_findings", payload: true },
      { view: "update_sets", name_contains: "^" },
      { view: "update_sets", state: "previewed" },
      { view: "upgrade_skipped", upgrade: "newest" },
    ]) {
      const result = await call(args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result), JSON.stringify(args)).toContain("Error category: conflict.");
      expect(textOf(result)).toContain("Retry after correcting the request or configuration.");
    }
    expect(reached).toBe(0);
  });

  it("hands a handler the canonical arguments and the call's services", async () => {
    const seen: CanonicalPlatformViewArgs[] = [];
    const handlers = Object.fromEntries(
      PLATFORM_VIEWS.map((view) => [
        view,
        async (args: CanonicalPlatformViewArgs, services: { serviceNow: unknown }) => {
          seen.push(args);
          expect(services.serviceNow).toBeDefined();
          throw new Error("stop");
        },
      ])
    ) as unknown as Record<PlatformView, PlatformViewHandler>;
    const { call } = await harness(recordingInstance().ops, {
      tableAccess: readPolicy(PLATFORM_VIEW_ALL_TABLES),
      modules: [createPlatformViewToolModule(handlers)],
    });
    await call({ view: "update_sets", name_contains: "Rel^ORx=y", state: "in progress", limit: 5 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      view: "update_sets", name_contains: "RelORx=y", state: "in progress", limit: 5, offset: 0, max_response_bytes: 100_000,
    });
    expect("profile" in seen[0]!).toBe(false);
  });

  it("needs a handler for every view", () => {
    expect(() => createPlatformViewToolModule({} as never)).toThrow(/no handler/u);
  });
});

describe("the access plan is authorized before any handler runs", () => {
  it("lets a profile that reads exactly a view's closure reach the view, and denies it one table short", async () => {
    for (const view of PLATFORM_VIEWS) {
      const plan = platformViewReadTables(view, WIDEST[view]);
      const instance = recordingInstance();
      const granted = await harness(instance.ops, { tableAccess: readPolicy(plan) });
      const reached = await granted.call({ view, ...WIDEST[view] });
      if (IMPLEMENTED.includes(view)) {
        expect(reached.isError, view).not.toBe(true);
        expectReadsWithin(instance, plan);
      } else {
        expectFixedInternalError(reached);
      }
      await closeHarnesses();
      for (const missing of plan) {
        const short = await harness(recordingInstance().ops, {
          tableAccess: readPolicy(plan.filter((table) => table !== missing)),
        });
        const result = await short.call({ view, ...WIDEST[view] });
        expect(result.isError, `${view} without ${missing}`).toBe(true);
        expect(textOf(result), `${view} without ${missing}`).toContain("denied by policy");
        expect(textOf(result)).not.toContain("Error category: internal");
        await closeHarnesses();
      }
    }
  });

  it("asks for the payload and problem tables only when the call does", async () => {
    const plain = readPolicy(PLATFORM_VIEW_TABLES.changes);
    const { call } = await harness(recordingInstance().ops, { tableAccess: plain });
    expectFixedInternalError(await call({ view: "changes", update_set: SYS_ID }));
    const payload = await call({ view: "changes", update_set: SYS_ID, change: SYS_ID, payload: true });
    expect(textOf(payload)).toContain("denied by policy");
    const problems = await harness(recordingInstance().ops, { tableAccess: readPolicy(PLATFORM_VIEW_TABLES.remote_update_sets) });
    expectFixedInternalError(await problems.call({ view: "remote_update_sets" }));
    expect(textOf(await problems.call({ view: "remote_update_sets", problems: true }))).toContain("denied by policy");
  });

  it("denies a write: the tool declares reads only", async () => {
    expect(platformViewToolModule.requirements.permissions).toEqual(["read"]);
    for (const view of PLATFORM_VIEWS) {
      const access = platformViewToolModule.resolveAccess(
        { profile: "p", view, ...WIDEST[view] },
        { tableAccess: readPolicy([]) } as never
      );
      expect(new Set(access.requests.map((request) => request.operation))).toEqual(new Set(["read"]));
      expect(access.requests.map((request) => request.table)).toEqual(platformViewReadTables(view, WIDEST[view]));
    }
  });
});

describe("recording client: a handler reads only tables in its view's plan", () => {
  /**
   * Run one handler, the same for every view, behind the real dispatcher. The
   * handler swallows what its reads throw, as a careless one could, and returns
   * a valid result, so what the test sees is only what the recorder kept.
   */
  async function runHandler(
    act: (ops: ServiceNowOperations) => Promise<void>,
    view: PlatformView = "batch"
  ) {
    const instance = recordingInstance();
    const handler: PlatformViewHandler = async (args, services) => {
      try {
        await act(services.serviceNow);
      } catch {
        /* swallowed on purpose */
      }
      return envelopeCompatibilityResult(
        "sn_platform_view" as never,
        args as unknown as Record<string, unknown>,
        ok({ view: args.view, status: "ok", results: [] })
      );
    };
    const module = createPlatformViewToolModule(
      Object.fromEntries(PLATFORM_VIEWS.map((name) => [name, handler])) as Record<PlatformView, PlatformViewHandler>
    );
    const { call } = await harness(instance.ops, { tableAccess: readPolicy(PLATFORM_VIEW_ALL_TABLES), modules: [module] });
    const result = await call({ view, ...MINIMAL[view] });
    return { instance, result };
  }

  const BATCH_PLAN = platformViewReadTables("batch", MINIMAL.batch);
  const table = (name: string) => `/api/now/table/${name}`;

  it("holds the shipped handlers to their plans (the stubs read nothing)", async () => {
    for (const view of PLATFORM_VIEWS) {
      const instance = recordingInstance();
      const { call } = await harness(instance.ops, { tableAccess: readPolicy(PLATFORM_VIEW_ALL_TABLES) });
      await call({ view, ...WIDEST[view] });
      if (!IMPLEMENTED.includes(view)) expect(instance.calls, view).toEqual([]);
      expectReadsWithin(instance, platformViewReadTables(view, WIDEST[view]));
      await closeHarnesses();
    }
  });

  it("accepts a handler that reads its closure by every read method, a record by sys_id, and a declared dot-walk", async () => {
    const { instance, result } = await runHandler(async (ops) => {
      await ops.get(table("sys_update_set"), { sysparm_query: "state=complete^ORDERBYDESCsys_updated_on", sysparm_fields: "sys_id,name,application.name", sysparm_limit: "26" });
      await ops.getWithMeta(`${table("sys_update_xml")}/${SYS_ID}`, { sysparm_fields: "sys_id" });
      await ops.get("/api/now/stats/sys_update_xml", { sysparm_group_by: "update_set", sysparm_count: "true", sysparm_sum_fields: "sys_mod_count", sysparm_max_fields: "sys_updated_on" });
      await ops.getRaw(table("sys_update_set"));
    });
    // The call succeeds: the result is a valid envelope and the plan was authorized.
    expect(result.isError, textOf(result)).not.toBe(true);
    expect(instance.calls.map((call) => call.operation)).toEqual(["get", "getWithMeta", "get", "getRaw"]);
    expect(instance.calls.map((call) => tableOfCall(call))).toEqual(["sys_update_set", "sys_update_xml", "sys_update_xml", "sys_update_set"]);
    expectReadsWithin(instance, [...BATCH_PLAN, "sys_scope"], [{ from: "sys_update_set", field: "application", target: "sys_scope" }]);
  });

  it("catches an out-of-plan table read through get, getWithMeta and getRaw, even when the handler swallows the error", async () => {
    for (const method of ["get", "getWithMeta", "getRaw"] as const) {
      const { instance, result } = await runHandler(async (ops) => {
        await ops.get(table("sys_update_set"));
        await (ops[method] as (path: string) => Promise<unknown>)(table("sys_audit"));
      });
      expect(result.isError, method).not.toBe(true);
      expect(instance.calls.at(-1), method).toMatchObject({ operation: method, path: table("sys_audit") });
      expect(() => expectReadsWithin(instance, BATCH_PLAN), method).toThrow(/outside the plan/u);
    }
  });

  it("catches a read of an out-of-plan table by sys_id, and of a path that is not a table read", async () => {
    const byId = await runHandler((ops) => ops.getWithMeta(`${table("sys_user")}/${SYS_ID}`).then(() => undefined));
    expect(() => expectReadsWithin(byId.instance, BATCH_PLAN)).toThrow(/outside the plan/u);
    for (const path of ["/api/sn_cicd/update_set/commit/x", `${table("sys_update_set")}?sysparm_query=x`, "/api/now/attachment/file", `${table("sys_update_set")}/short`]) {
      const other = await runHandler((ops) => ops.get(path).then(() => undefined));
      expect(() => expectReadsWithin(other.instance, BATCH_PLAN), path).toThrow(/not a Table or Stats API read/u);
    }
  });

  it("catches every write operation, which the fake refuses and records", async () => {
    const { instance } = await runHandler(async (ops) => {
      await ops.post(table("sys_update_set"), {}).catch(() => undefined);
      await ops.patch(`${table("sys_update_set")}/${SYS_ID}`, {}).catch(() => undefined);
      await ops.delete(`${table("sys_update_set")}/${SYS_ID}`).catch(() => undefined);
      await ops.postBinary(table("sys_update_set"), Buffer.alloc(0), "text/plain").catch(() => undefined);
    });
    expect(instance.calls.map((call) => call.operation)).toEqual(["post", "patch", "delete", "postBinary"]);
    expect(() => expectReadsWithin(instance, BATCH_PLAN)).toThrow(/not a read operation/u);
  });

  it("catches an undeclared dot-walk in the query, the fields, the order and the group", async () => {
    const walks: Record<string, Record<string, string>> = {
      "sysparm_query": { sysparm_query: "application.name=Global" },
      "or clause": { sysparm_query: "state=complete^ORapplication.scope=x" },
      "order by": { sysparm_query: "state=complete^ORDERBYapplication.name" },
      "order by desc": { sysparm_query: "ORDERBYDESCapplication.name" },
      "group by clause": { sysparm_query: "GROUPBYapplication.name" },
      "sysparm_fields": { sysparm_fields: "sys_id,application.name" },
      "sysparm_group_by": { sysparm_group_by: "application.name" },
      "sysparm_orderby": { sysparm_orderby: "application.name" },
      "sysparm_sum_fields": { sysparm_sum_fields: "update_set.sys_mod_count" },
    };
    for (const [label, params] of Object.entries(walks)) {
      const { instance } = await runHandler((ops) => ops.get(table("sys_update_set"), params).then(() => undefined));
      expect(() => expectReadsWithin(instance, BATCH_PLAN), label).toThrow(/dot-walk .* is not declared by the view/u);
    }
  });

  it("catches a declared dot-walk whose target is outside the plan, and one that is more than one hop", async () => {
    const declared = [{ from: "sys_update_set", field: "application", target: "sys_scope" }];
    const named = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_query: "application.name=Global" }).then(() => undefined));
    expect(() => expectReadsWithin(named.instance, BATCH_PLAN, declared)).toThrow(/reads sys_scope, outside the plan/u);
    expect(() => expectReadsWithin(named.instance, [...BATCH_PLAN, "sys_scope"], declared)).not.toThrow();
    const deep = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_fields: "application.parent.name" }).then(() => undefined));
    expect(() => expectReadsWithin(deep.instance, [...BATCH_PLAN, "sys_scope"], declared)).toThrow(/more than one hop/u);
    // A declaration on another table or another field declares nothing here.
    const other = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_fields: "application.name" }).then(() => undefined));
    expect(() => expectReadsWithin(other.instance, [...BATCH_PLAN, "sys_scope"], [{ from: "sys_update_xml", field: "application", target: "sys_scope" }])).toThrow(/not declared/u);
  });

  it("fails on every query that reads another table or runs script, and on a clause it cannot parse", async () => {
    const queries: Record<string, string> = {
      "a related-list query": "RLQUERYsys_journal_field.element_id,>=1^name=x^ENDRLQUERY",
      "a subquery": "sys_idINSUBQUERYuser,sys_user_grmember^ENDSUBQUERY",
      "script in a value": "sys_id=javascript:new GlideRecord('sys_audit').query()",
      "script in a value, mixed case": "sys_id=JavaScript:gs.getUserID()",
      "a dynamic filter": "sys_idDYNAMIC0123456789abcdef0123456789abcdef",
      "a join": "sys_idJOINsys_update_xml::update_set",
      "an uppercase field": "Application.name=x",
      "an uppercase field with a prefix": "state=complete^ORApplication=x",
      "NQ then OR": "state=complete^NQORapplication.name=x",
      "an unknown operator": "state~complete",
      "a clause with no operator": "state",
      "an empty clause": "state=complete^",
      "a leading empty clause": "^state=complete",
      "a sort with no field": "ORDERBY",
      "an uppercase sort field": "ORDERBYName",
      "a dash in a field": "sys-id=x",
    };
    for (const [label, query] of Object.entries(queries)) {
      const { instance } = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_query: query }).then(() => undefined));
      expect(() => expectReadsWithin(instance, [...BATCH_PLAN, "sys_scope"], [{ from: "sys_update_set", field: "application", target: "sys_scope" }]), label).toThrow(
        /contains|unparseable|not declared/u
      );
    }
  });

  it("accepts the conditions the views build, with every allowed operator and the EQ terminator", async () => {
    const query = [
      "state=complete", "ORname=x", "NQstate!=ignore", "sys_updated_on>=2026-01-01 00:00:00", "sys_updated_on<=2026-12-31",
      "countBETWEEN1@5", "nameLIKEx", "nameSTARTSWITHx", "nameENDSWITHx", "nameNOT LIKEx", "state>1", "state<9",
      "sys_idIN0123,4567", "stateNOT INa,b", "descriptionISEMPTY", "descriptionISNOTEMPTY",
      "ORDERBYDESCsys_updated_on", "ORDERBYname", "GROUPBYstate", "EQ",
    ].join("^");
    const { instance } = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_query: query }).then(() => undefined));
    expect(() => expectReadsWithin(instance, BATCH_PLAN)).not.toThrow();
  });

  it("refuses the parameters that widen a read, and a display_value other than true, false or all", async () => {
    const params: Record<string, Record<string, string>> = {
      sysparm_view: { sysparm_view: "mobile" },
      sysparm_query_no_domain: { sysparm_query_no_domain: "true" },
      sysparm_having: { sysparm_having: "count>1" },
      "display_value 1": { sysparm_display_value: "1" },
      "display_value empty": { sysparm_display_value: "" },
      "display_value mixed case": { sysparm_display_value: "All" },
      "a boolean parameter": { sysparm_count: "yes" },
      "a limit that is not a number": { sysparm_limit: "all" },
    };
    for (const [label, query] of Object.entries(params)) {
      const { instance } = await runHandler((ops) => ops.get(table("sys_update_set"), query).then(() => undefined));
      expect(() => expectReadsWithin(instance, BATCH_PLAN), label).toThrow(/unclassified parameter|sysparm_display_value|sysparm_count|sysparm_limit/u);
    }
    for (const value of ["true", "false", "all"]) {
      const { instance } = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_display_value: value, sysparm_limit: "26", sysparm_count: "true" }).then(() => undefined));
      expect(() => expectReadsWithin(instance, BATCH_PLAN), value).not.toThrow();
    }
  });

  it("fails on a field list entry that is not a field, and on an uppercase one", async () => {
    for (const value of ["Name", "sys_id,", "a b", "a.b.c", "a-b", "name;x"]) {
      const { instance } = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_fields: value }).then(() => undefined));
      expect(() => expectReadsWithin(instance, BATCH_PLAN, [{ from: "sys_update_set", field: "a", target: "sys_update_set" }]), value).toThrow();
    }
  });

  it("stubs fetch while a harness is open, so a handler cannot bypass the recorder", async () => {
    const before = globalThis.fetch;
    const { instance } = await runHandler(async () => {
      await fetch("https://platform-view-test.service-now.com/api/now/table/sys_audit");
    });
    expect(instance.calls).toEqual([]);
    expect(() => globalThis.fetch("https://example.com")).toThrow(/fetch is not allowed/u);
    expectReadsWithin(instance, BATCH_PLAN);
    await closeHarnesses();
    expect(globalThis.fetch).toBe(before);
  });

  it("does not mistake a dot in a value for a dot-walk, and refuses an unclassified parameter", async () => {
    const plain = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_query: "nameLIKEv1.2.3^description=a.b^ORupdate_set=x.y" }).then(() => undefined));
    expect(() => expectReadsWithin(plain.instance, BATCH_PLAN)).not.toThrow();
    const odd = await runHandler((ops) => ops.get(table("sys_update_set"), { sysparm_future_param: "application.name" }).then(() => undefined));
    expect(() => expectReadsWithin(odd.instance, BATCH_PLAN)).toThrow(/unclassified parameter sysparm_future_param/u);
  });

  it("fails the test when a read is made after the last check", async () => {
    const { instance } = await runHandler((ops) => ops.get(table("sys_update_set")).then(() => undefined));
    expectReadsWithin(instance, BATCH_PLAN);
    expect(instance.judged).toBe(1);
    // A later read, outside the plan, that nothing judges.
    await instance.ops.get(table("sys_audit"));
    expect(instance.calls).toHaveLength(2);
    await expect(closeHarnesses()).rejects.toThrow(/after the last check/u);
    // Judging the whole record afterwards is what catches it.
    expect(() => expectReadsWithin(instance, BATCH_PLAN)).toThrow(/outside the plan/u);
  });

  it("restores fetch when the harnesses close", async () => {
    const before = globalThis.fetch;
    const { instance } = await runHandler(async () => undefined);
    expectReadsWithin(instance, BATCH_PLAN);
    expect(globalThis.fetch).not.toBe(before);
    await closeHarnesses();
    expect(globalThis.fetch).toBe(before);
  });

  it("parses INSTANCEOF as its own operator, not as IN", () => {
    expect(queryFields("sys_class_nameINSTANCEOFcmdb_ci_server")).toEqual(["sys_class_name"]);
    expect(queryFields("sys_class_nameINSTANCEOFx^ORstateINa,b")).toEqual(["sys_class_name", "state"]);
  });

  it("fails the test when a recording instance made calls that nobody checked", async () => {
    const { instance } = await runHandler((ops) => ops.get(table("sys_update_set")).then(() => undefined));
    expect(instance.calls).toHaveLength(1);
    await expect(closeHarnesses()).rejects.toThrow(/no test judged/u);
    // closeHarnesses cleared the list, so the afterEach hook has nothing left to fail on.
  });
});
