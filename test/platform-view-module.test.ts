/**
 * The update set views behind the real `sn_platform_view` dispatcher.
 *
 * Handlers are not held to their plan at run time, so the shipped module runs
 * here against a recording client, under a profile that may read exactly the
 * call's resolved plan, and every recorded read is judged against that plan.
 * The payload tests also show the explicit-read rule: `sys_update_xml.payload`
 * is read only when the profile's own `sys_update_xml` entry names it, never
 * through `"*"`. Synthetic data only.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { platformViewReadTables } from "../src/tools/platform-view-contracts.js";
import { platformViewToolModule } from "../src/tools/platform-view-module.js";
import { HIDDEN_MARK, PAYLOAD_HINTS } from "../src/tools/platform-view-payload.js";
import {
  UPDATE_SET_VIEWS_FIELD_PLAN,
  UPDATE_SET_VIEW_DOT_WALKS,
} from "../src/tools/platform-view-update-sets.js";
import {
  CANARY,
  CHILD_ID,
  FAKE_SECRET,
  REMOTE_ID,
  SET_ID,
  callLabel,
  change,
  fake,
  localSet,
  payloadOf,
  remoteSet,
  sid,
  world,
} from "./fixtures/update-set-views.js";
import { expectReadsWithin, harness, readPolicy, textOf, type RecordedCall } from "./platform-view-harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;

/** A profile whose own `sys_update_xml` entry names every field the views use, payload included. */
const PAYLOAD_PROFILE = { fieldPolicy: { sys_update_xml: { readable: [...UPDATE_SET_VIEWS_FIELD_PLAN.sys_update_xml!] } } };

function dataOf(result: CallToolResult): Data {
  expect(result.isError, textOf(result)).not.toBe(true);
  return (result.structuredContent as { data: Data }).data;
}

const fieldsOf = (call: RecordedCall) => (call.params.sysparm_fields ?? "").split(",").filter(Boolean);
const asksForPayload = (calls: readonly RecordedCall[]) => calls.some((call) => fieldsOf(call).includes("payload"));

const SECRET_SCRIPT = `r.setBasicAuth('svc_user', '${FAKE_SECRET}');`;
const TARGET = change(9, {
  table: "u_vendor_child",
  name: `u_vendor_child_${sid(0xc009)}`,
  payload: payloadOf("u_vendor_child", { u_name: "Acme", u_api_key_value: FAKE_SECRET, u_script: SECRET_SCRIPT }),
});

/** One instance where every view has something to read. */
const RICH = world({
  localSets: [
    localSet({ remote_sys_id: REMOTE_ID }),
    localSet({ sys_id: CHILD_ID, name: "Child", parent: SET_ID, base_update_set: SET_ID }),
  ],
  remoteSets: [remoteSet()],
  changes: [change(1), change(2, { update_set: CHILD_ID }), TARGET, change(4, { update_set: "", remote_update_set: REMOTE_ID })],
  problems: [{ sys_id: sid(0xb01), remote_update_set: REMOTE_ID, type: "error", status: "", description: "x" }],
});

const CALLS: readonly Record<string, unknown>[] = [
  { view: "update_sets" },
  { view: "update_sets", state: "in progress", name_contains: "Release", application: "global", updated_since: "2026-01-01", batch_root: SET_ID },
  { view: "update_set", update_set: SET_ID },
  { view: "update_set", update_set: "Release 1" },
  { view: "changes", update_set: SET_ID, include_children: true, type: "Script Include", action: "INSERT_OR_UPDATE" },
  { view: "changes", update_set: SET_ID, change: sid(0xc009), payload: true },
  { view: "changes", remote_update_set: REMOTE_ID },
  { view: "batch", update_set: CHILD_ID },
  { view: "remote_update_sets", state: "previewed" },
  { view: "remote_update_sets", remote_update_set: REMOTE_ID, problems: true },
];

describe("update set views: recording client behind the real dispatcher", () => {
  it("reads only tables in each call's resolved plan, with only the declared dot-walk", async () => {
    const seen = new Set<string>();
    for (const args of CALLS) {
      const { instance, ops } = fake(RICH);
      const plan = platformViewReadTables(args.view as never, args);
      const { call } = await harness(ops, { tableAccess: readPolicy(plan), modules: [platformViewToolModule], fieldPolicy: PAYLOAD_PROFILE });
      const data = dataOf(await call(args));
      expect(data.status, JSON.stringify(args)).toBe("ok");
      expectReadsWithin(instance, plan, UPDATE_SET_VIEW_DOT_WALKS);
      for (const call of instance.calls) seen.add(callLabel(call));
    }
    // Every kind of read these views make was exercised and judged, the payload's type lookup included.
    expect(seen).toEqual(
      new Set([
        "table:sys_update_set", "stats:sys_update_xml", "table:sys_update_xml", "table:sys_remote_update_set",
        "table:sys_update_preview_problem", "stats:sys_update_preview_problem", "table:sys_db_object", "table:sys_dictionary",
      ])
    );
  });

  it("never names payload_diff, and names payload only in the payload read", async () => {
    for (const args of CALLS) {
      const { instance, ops } = fake(RICH);
      const plan = platformViewReadTables(args.view as never, args);
      const { call } = await harness(ops, { tableAccess: readPolicy(plan), modules: [platformViewToolModule], fieldPolicy: PAYLOAD_PROFILE });
      await call(args);
      expectReadsWithin(instance, plan, UPDATE_SET_VIEW_DOT_WALKS);
      for (const recorded of instance.calls) {
        expect(fieldsOf(recorded), JSON.stringify(args)).not.toContain("payload_diff");
        expect(recorded.params.sysparm_query ?? "").not.toContain("payload");
        if (fieldsOf(recorded).includes("payload")) expect(fieldsOf(recorded)).toEqual(["sys_id", "payload"]);
      }
      expect(asksForPayload(instance.calls), JSON.stringify(args)).toBe(args.payload === true);
    }
  });

  it("is denied by the dispatcher, before any read, without a table of its plan", async () => {
    for (const args of CALLS) {
      const plan = platformViewReadTables(args.view as never, args);
      for (const missing of plan) {
        const { instance, ops } = fake(RICH);
        const { call } = await harness(ops, { tableAccess: readPolicy(plan.filter((table) => table !== missing)), modules: [platformViewToolModule] });
        const result = await call(args);
        expect(result.isError, `${String(args.view)} without ${missing}`).toBe(true);
        expect(textOf(result)).toContain("denied by policy");
        expectReadsWithin(instance, plan);
        expect(instance.calls).toEqual([]);
      }
    }
  });
});

describe("payload: explicit read", () => {
  const ARGS = { view: "changes", update_set: SET_ID, change: sid(0xc009), payload: true };
  const PLAN = platformViewReadTables("changes", ARGS);

  async function payloadCall(fieldPolicy?: Record<string, unknown>) {
    const { instance, ops } = fake(RICH);
    const { call } = await harness(ops, {
      tableAccess: readPolicy(PLAN),
      modules: [platformViewToolModule],
      ...(fieldPolicy === undefined ? {} : { fieldPolicy: fieldPolicy as never }),
    });
    const result = await call(ARGS);
    const data = dataOf(result);
    expectReadsWithin(instance, PLAN, UPDATE_SET_VIEW_DOT_WALKS);
    return { data, instance, result };
  }

  it('works metadata-only under the defaults and under "*", and never asks for payload', async () => {
    for (const policy of [
      undefined,
      { fieldPolicy: { "*": { readable: ["*"] } } },
      // Naming payload in "*" does not open it: only the table's own entry does.
      { fieldPolicy: { "*": { readable: [...UPDATE_SET_VIEWS_FIELD_PLAN.sys_update_xml!] } } },
    ]) {
      const { data, instance, result } = await payloadCall(policy);
      expect(data.summary.payload, JSON.stringify(policy)).toEqual({ status: "not_readable", reason: "field_policy", hint: PAYLOAD_HINTS.field_policy });
      expect(data.results.map((row: Data) => row.sys_id)).toEqual([sid(0xc009)]);
      expect(asksForPayload(instance.calls)).toBe(false);
      expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
    }
  });

  it("reads and masks payload when the profile's own sys_update_xml entry names it", async () => {
    const { data, instance, result } = await payloadCall(PAYLOAD_PROFILE);
    expect(asksForPayload(instance.calls)).toBe(true);
    expect(data.summary.payload.status).toBe("shown");
    expect(data.summary.payload.text).toContain(`<u_api_key_value>${HIDDEN_MARK}</u_api_key_value>`);
    expect(data.summary.payload.text).toContain("<u_name>Acme</u_name>");
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
  });

  it("lists change metadata under the defaults, with no payload column in any read", async () => {
    const { instance, ops } = fake(RICH);
    const args = { view: "changes", update_set: SET_ID };
    const plan = platformViewReadTables("changes", args);
    const { call } = await harness(ops, { tableAccess: readPolicy(plan), modules: [platformViewToolModule] });
    const data = dataOf(await call(args));
    expectReadsWithin(instance, plan, UPDATE_SET_VIEW_DOT_WALKS);
    expect(data.results.length).toBeGreaterThan(0);
    expect(asksForPayload(instance.calls)).toBe(false);
    expect(JSON.stringify(data)).not.toContain(CANARY);
  });
});
