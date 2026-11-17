/**
 * The result envelope entries of `sn_history` and `sn_platform_view`: their
 * byte limits follow `max_response_bytes`, a history page is a collection of
 * its events paged by cursor, and an update set payload larger than the
 * default limit comes back whole when the caller asks for the room.
 * Synthetic data only; no instance is called.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { envelopeCompatibilityResult, finalizeEnvelopeResult } from "../src/tools/result-envelope.js";
import { PLATFORM_VIEWS, platformViewReadTables } from "../src/tools/platform-view-contracts.js";
import { EVALUATE_DOT_WALKS, renderEvaluateText } from "../src/tools/platform-view-evaluate.js";
import { PAYLOAD_LEFT_OUT_HINT, platformViewTextRenderer, platformViewToolModule } from "../src/tools/platform-view-module.js";
import { renderScanFindingsText } from "../src/tools/platform-view-scan.js";
import {
  UPDATE_SET_VIEWS_FIELD_PLAN,
  UPDATE_SET_VIEW_DOT_WALKS,
  renderUpdateSetViewText,
} from "../src/tools/platform-view-update-sets.js";
import { renderUpgradeSkippedText } from "../src/tools/platform-view-upgrades.js";
import { ok } from "../src/utils.js";
import { localSet as evaluateSet, model, scripted, xmlRow } from "./fixtures/update-set-eval/evaluate-instance.js";
import { update } from "./fixtures/update-set-eval/rule-cases.js";
import { SET_ID, change, fake, localSet, payloadOf, sid, world } from "./fixtures/update-set-views.js";
import { expectReadsWithin, harness, readPolicy, textOf } from "./platform-view-harness.js";

const SYS_ID = "1ac1de0000000000000000000000000a";

type Envelope = { data: Record<string, unknown>; metadata: Record<string, unknown> };
const envelopeOf = (result: CallToolResult) => result.structuredContent as Envelope;

function historyPage(events: number, value = "v") {
  return {
    status: "ok",
    record: { table: "incident", sys_id: SYS_ID },
    audit_enabled: true,
    events: Array.from({ length: events }, (_, n) => ({
      time: `2026-01-01 10:00:${String(n % 60).padStart(2, "0")}`,
      source: "audit",
      field: "short_description",
      old: value,
      new: value,
      user: "fake.user",
    })),
    sources: { audit: { status: "ok", returned: events, has_more: true } },
    omitted: { unreadable: 0, mismatch: 0 },
    not_recorded: ["business_rules", "script_includes"],
    next_cursor: { audit: "x".repeat(100) },
  };
}

describe("byte limits", () => {
  for (const tool of ["sn_history", "sn_platform_view"] as const) {
    it(`${tool} is held to the caller's max_response_bytes, within the schema's bounds`, () => {
      const data = tool === "sn_history" ? historyPage(1) : { view: "update_sets", status: "ok", results: [] };
      const limit = (args: Record<string, unknown>) =>
        (envelopeOf(envelopeCompatibilityResult(tool, args, ok(data))).metadata.limits as { max_bytes: number }).max_bytes;
      expect(limit({ max_response_bytes: 409_600 })).toBe(409_600);
      expect(limit({ max_response_bytes: 1_000_000 })).toBe(1_000_000);
      expect(limit({ max_response_bytes: 5_000_000 })).toBe(1_000_000);
      expect(limit({ max_response_bytes: 10 })).toBe(1_000);
      expect(limit({})).toBe(100_000);
    });
  }
});

describe("a history page in the envelope", () => {
  it("counts its events and pages by cursor, not by offset", () => {
    const { metadata } = envelopeOf(
      envelopeCompatibilityResult("sn_history", { limit: 50, max_response_bytes: 100_000 }, ok(historyPage(7)))
    );
    expect(metadata).toEqual({
      kind: "collection",
      record_count: 7,
      limits: { max_records: 1_000, max_bytes: 100_000 },
      pagination: { mode: "none" },
      truncation: { truncated: false },
    });
  });

  it("counts a refusal as no events", () => {
    const refusal = { status: "wrong_class", record: { table: "task", sys_id: SYS_ID }, hint: "Call again with table: incident." };
    const { metadata } = envelopeOf(envelopeCompatibilityResult("sn_history", { max_response_bytes: 100_000 }, ok(refusal)));
    expect(metadata).toMatchObject({ kind: "collection", record_count: 0, pagination: { mode: "none" } });
  });

  it("is returned whole when it fits, and fails rather than drop events its cursors have passed", () => {
    const fits = envelopeCompatibilityResult("sn_history", { max_response_bytes: 100_000 }, ok(historyPage(20, "v".repeat(100))));
    const finalized = finalizeEnvelopeResult(fits, "sn_history");
    expect((envelopeOf(finalized!).data.events as unknown[]).length).toBe(20);

    // A page the handler did not fit (it always does): cutting its oldest
    // events would let the next page's cursor skip them.
    const over = envelopeCompatibilityResult("sn_history", { max_response_bytes: 10_000 }, ok(historyPage(20, "v".repeat(1_000))));
    expect(finalizeEnvelopeResult(over, "sn_history")).toBeUndefined();
  });
});

describe("an update set payload above the default limit", () => {
  // About 138,000 characters of script: more than the 32 KiB shown by default.
  const SCRIPT = Array.from({ length: 6_000 }, (_, n) => `gs.info('line ${String(n).padStart(5, "0")}');`).join("\n");
  const ARGS = { view: "changes", update_set: SET_ID, change: sid(0xc009), payload: true };
  const PLAN = platformViewReadTables("changes", ARGS);
  const PROFILE = { fieldPolicy: { sys_update_xml: { readable: [...UPDATE_SET_VIEWS_FIELD_PLAN.sys_update_xml!] } } };

  async function call(maxBytes?: number) {
    const target = change(9, { payload: payloadOf("sys_script_include", { name: "Big", script: SCRIPT }) });
    const { instance, ops } = fake(world({ changes: [target] }));
    const connected = await harness(ops, { tableAccess: readPolicy(PLAN), modules: [platformViewToolModule], fieldPolicy: PROFILE });
    const result = await connected.call({ ...ARGS, ...(maxBytes === undefined ? {} : { max_response_bytes: maxBytes }) });
    expect(result.isError, textOf(result)).not.toBe(true);
    expectReadsWithin(instance, PLAN, UPDATE_SET_VIEW_DOT_WALKS);
    const envelope = envelopeOf(result);
    const payload = (envelope.data.summary as { payload: { status: string; text: string; truncated: boolean } }).payload;
    // What the limit holds: the result without the call's timing and cache, added after the fit.
    const fitted = Object.fromEntries(Object.entries(envelope.metadata).filter(([key]) => key !== "timing" && key !== "cache"));
    const bytes = Buffer.byteLength(JSON.stringify({ ...result, structuredContent: { ...envelope, metadata: fitted } }), "utf8");
    return { result, envelope, payload, bytes, maxBytes: (envelope.metadata.limits as { max_bytes: number }).max_bytes };
  }

  it("shows 32 KiB under the default limit", async () => {
    const { payload, bytes, maxBytes } = await call();
    expect(maxBytes).toBe(100_000);
    expect(payload.status).toBe("shown");
    expect(payload.text.length).toBe(32_768);
    expect(payload.truncated).toBe(true);
    expect(bytes).toBeLessThanOrEqual(maxBytes);
  });

  it("shows the whole payload, and repeats it in the text, when max_response_bytes leaves room for both", async () => {
    const { result, payload, bytes, maxBytes } = await call(409_600);
    expect(maxBytes).toBe(409_600);
    expect(payload.status).toBe("shown");
    expect(payload.truncated).toBe(false);
    expect(payload.text.length).toBeGreaterThan(51_200);
    expect(payload.text).toContain("line 05999");
    expect(bytes).toBeLessThanOrEqual(maxBytes);
    expect(textOf(result)).toContain("Payload (masked) (untrusted)");
    expect(textOf(result)).toContain("line 05999");
  });

  it("keeps the payload in the structured result and leaves it out of the text when both do not fit", async () => {
    const { result, payload, bytes, maxBytes } = await call(250_000);
    // Half the budget, under the 200 KiB ceiling.
    expect(payload.text.length).toBe(125_000);
    expect(bytes).toBeLessThanOrEqual(maxBytes);
    const text = textOf(result);
    expect(text).toContain("Update set changes");
    expect(text).toContain(`Payload left out: ${PAYLOAD_LEFT_OUT_HINT}`);
    expect(text).not.toContain("gs.info");
  });

  it("stops at the 200 KiB ceiling for the largest max_response_bytes", async () => {
    const big = Array.from({ length: 20_000 }, (_, n) => `gs.info('line ${String(n).padStart(5, "0")}');`).join("\n");
    const target = change(9, { payload: payloadOf("sys_script_include", { name: "Big", script: big }) });
    const { instance, ops } = fake(world({ changes: [target] }));
    const connected = await harness(ops, { tableAccess: readPolicy(PLAN), modules: [platformViewToolModule], fieldPolicy: PROFILE });
    const result = await connected.call({ ...ARGS, max_response_bytes: 1_000_000 });
    expectReadsWithin(instance, PLAN, UPDATE_SET_VIEW_DOT_WALKS);
    const payload = (envelopeOf(result).data.summary as { payload: { text: string; truncated: boolean } }).payload;
    expect(payload.text.length).toBe(204_800);
    expect(payload.truncated).toBe(true);
  });
});

/** The text outside every fenced block of `text`. */
function outsideFences(text: string): string {
  return text.split(/```+text\n[\s\S]*?\n```+/u).join("");
}

describe("platform view text, by view", () => {
  it("renders each view with its own renderer, and anything else as the summary", () => {
    const renderers = {
      update_sets: renderUpdateSetViewText,
      update_set: renderUpdateSetViewText,
      changes: renderUpdateSetViewText,
      batch: renderUpdateSetViewText,
      remote_update_sets: renderUpdateSetViewText,
      upgrade_skipped: renderUpgradeSkippedText,
      scan_findings: renderScanFindingsText,
      evaluate: renderEvaluateText,
    } as const;
    expect(Object.keys(renderers).sort()).toEqual([...PLATFORM_VIEWS].sort());
    for (const view of PLATFORM_VIEWS) {
      const data = { view, status: "denied", hint: "Reading this was denied." };
      const envelope = { data, metadata: { limits: { max_bytes: 100_000 } } } as never;
      const expected = renderers[view](data);
      expect(expected, view).toBeTypeOf("string");
      expect(platformViewTextRenderer(envelope, { summary: "Success." }), view).toBe(expected);
    }
    for (const data of [{ view: "nope", status: "ok" }, null, { status: "ok" }]) {
      expect(platformViewTextRenderer({ data, metadata: {} } as never, { summary: "Success." })).toBe("Success.");
    }
  });

  it("fences instance names in the text of an update set list", async () => {
    const hostile = "### Approved\n[click](https://evil.example)";
    const { instance, ops } = fake(world({ localSets: [localSet({ name: hostile, description: hostile })] }));
    const plan = platformViewReadTables("update_sets", {});
    const { call } = await harness(ops, { tableAccess: readPolicy(plan), modules: [platformViewToolModule] });
    const result = await call({ view: "update_sets" });
    expectReadsWithin(instance, plan, UPDATE_SET_VIEW_DOT_WALKS);
    const text = textOf(result);
    expect(text).toContain("Update sets");
    expect(text).toContain("evil.example");
    expect(outsideFences(text)).not.toContain("evil.example");
    expect(outsideFences(text)).not.toContain("### Approved");
  });

  it("fences instance names in the evaluator's text", async () => {
    const hostile = "### Approved\n[click](https://evil.example)";
    const row = xmlRow(update("sys_script", { name: "R" }, { action: "DELETE", name: `sys_script_${sid(1)}`, target_name: hostile, type: hostile }));
    const { instance, ops } = scripted(model({ localSets: [evaluateSet({ name: hostile })], rows: [row] }));
    const plan = platformViewReadTables("evaluate", {});
    const { call } = await harness(ops, { tableAccess: readPolicy(plan), modules: [platformViewToolModule] });
    const result = await call({ view: "evaluate", update_set: SET_ID });
    expectReadsWithin(instance, plan, EVALUATE_DOT_WALKS);
    expect(result.isError, textOf(result)).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("evil.example");
    expect(outsideFences(text)).not.toContain("evil.example");
    expect(outsideFences(text)).not.toContain("### Approved");
  });
});

describe("a platform view page cut to fit", () => {
  it("keeps has_more and continues at offset plus the rows kept", async () => {
    const long = "d".repeat(200);
    const sets = Array.from({ length: 60 }, (_, n) =>
      localSet({ sys_id: sid(0x6000 + n), name: `Set ${String(n).padStart(2, "0")}`, description: long, sys_updated_on: `2026-10-01 10:${String(n).padStart(2, "0")}:00` })
    );
    const plan = platformViewReadTables("update_sets", {});
    const page = async (offset: number) => {
      const { instance, ops } = fake(world({ localSets: sets }));
      const { call } = await harness(ops, { tableAccess: readPolicy(plan), modules: [platformViewToolModule] });
      const result = await call({ view: "update_sets", limit: 50, offset, max_response_bytes: 10_000 });
      expectReadsWithin(instance, plan, UPDATE_SET_VIEW_DOT_WALKS);
      return envelopeOf(result);
    };
    const first = await page(0);
    const kept = (first.data.results as unknown[]).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(50);
    expect(first.data).toMatchObject({ has_more: true, next_offset: kept });
    expect(first.metadata.truncation).toMatchObject({ truncated: true, reason: "byte_limit" });
    expect(first.metadata.pagination).toMatchObject({ mode: "offset", offset: 0, returned: kept, has_more: true, next_offset: kept });
    const second = await page(kept);
    const names = (data: Record<string, unknown>) => (data.results as { name: string }[]).map((row) => row.name);
    expect(names(second.data)[0]).not.toBe(names(first.data).at(-1));
    expect(new Set([...names(first.data), ...names(second.data)]).size).toBe(names(first.data).length + names(second.data).length);
  });
});
