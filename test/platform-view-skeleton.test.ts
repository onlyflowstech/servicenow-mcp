import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { trustedToolErrorDescriptor } from "../src/tool-error.js";
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
import { handleScanFindings } from "../src/tools/platform-view-scan.js";
import { handleUpgradeSkipped } from "../src/tools/platform-view-upgrades.js";
import {
  closeHarnesses,
  expectReadsWithin,
  harness,
  readPolicy,
  recordingInstance,
  tableOfCall,
  textOf,
} from "./platform-view-harness.js";

afterEach(closeHarnesses);

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
    for (const view of PLATFORM_VIEWS) {
      expectFixedInternalError(await call({ view, ...MINIMAL[view] }));
    }
    expect(instance.calls).toEqual([]);
  });

  it("stub handlers throw the fixed internal error and name nothing", async () => {
    const canonical = { view: "evaluate", limit: 25, offset: 0, max_response_bytes: 100_000 } as CanonicalPlatformViewArgs;
    const services = {} as never;
    for (const handler of [handleUpgradeSkipped, handleScanFindings, handleEvaluate]) {
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
      const granted = await harness(recordingInstance().ops, { tableAccess: readPolicy(plan) });
      expectFixedInternalError(await granted.call({ view, ...WIDEST[view] }));
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
  /** A handler that reads each table it is given, through the call's services. */
  function readingHandlers(tablesFor: (view: PlatformView) => readonly string[]) {
    return Object.fromEntries(
      PLATFORM_VIEWS.map((view) => [
        view,
        (async (args, services) => {
          for (const table of tablesFor(view)) {
            await services.serviceNow.get(`/api/now/table/${table}`, { sysparm_limit: String(args.limit) });
          }
          return { content: [{ type: "text" as const, text: "read" }] };
        }) satisfies PlatformViewHandler,
      ])
    ) as unknown as Record<PlatformView, PlatformViewHandler>;
  }

  it("holds the shipped handlers to their plans (they read nothing yet)", async () => {
    for (const view of PLATFORM_VIEWS) {
      const instance = recordingInstance();
      const { call } = await harness(instance.ops, { tableAccess: readPolicy(PLATFORM_VIEW_ALL_TABLES) });
      await call({ view, ...WIDEST[view] });
      expectReadsWithin(instance.calls, platformViewReadTables(view, WIDEST[view]));
      await closeHarnesses();
    }
  });

  it("accepts a handler that reads its whole closure", async () => {
    for (const view of PLATFORM_VIEWS) {
      const instance = recordingInstance();
      const module = createPlatformViewToolModule(readingHandlers((name) => platformViewReadTables(name, WIDEST[name])));
      const { call } = await harness(instance.ops, { tableAccess: readPolicy(PLATFORM_VIEW_ALL_TABLES), modules: [module] });
      // The reads are what is checked. The fake's text result is not a result
      // envelope (that entry is added with the registration), so the call itself
      // is not asserted to succeed.
      await call({ view, ...WIDEST[view] });
      const plan = platformViewReadTables(view, WIDEST[view]);
      expect(instance.calls.map((entry) => tableOfCall(entry))).toEqual([...plan]);
      expectReadsWithin(instance.calls, plan);
      await closeHarnesses();
    }
  });

  it("catches a handler that reads a table outside its plan", async () => {
    const instance = recordingInstance();
    const module = createPlatformViewToolModule(
      readingHandlers((view) => [...platformViewReadTables(view, MINIMAL[view]), "sys_audit"])
    );
    const { call } = await harness(instance.ops, { tableAccess: readPolicy(PLATFORM_VIEW_ALL_TABLES), modules: [module] });
    await call({ view: "batch", update_set: SYS_ID });
    expect(() => expectReadsWithin(instance.calls, platformViewReadTables("batch", MINIMAL.batch))).toThrow(/outside the plan/u);
  });

  it("catches a read that is not a Table or Stats API read", async () => {
    expect(() => expectReadsWithin([{ path: "/api/sn_cicd/update_set/commit/x", params: {} }], ["sys_update_set"])).toThrow(
      /not a Table or Stats API read/u
    );
  });
});
