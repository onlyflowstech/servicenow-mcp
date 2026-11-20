/**
 * `sn_relationships` behind the real dispatcher: what the caller receives for
 * a map, an ambiguous name, a missing CI, and a profile that cannot read the
 * relationship fields. The instance is a scripted double, one step per read.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createTableAccessPolicy } from "../src/table-policy.js";
import {
  createMockServiceNowHarness,
  SNSDK54_PROFILE_NAME,
  type MockServiceNowStep,
} from "./fixtures/mock-servicenow.js";

const ROOT = "a".repeat(32);
const CHILD = "b".repeat(32);
const REL = "c".repeat(32);

const policy = createTableAccessPolicy({ readTables: ["*"], writeTables: [] });
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function call(steps: readonly MockServiceNowStep[], args: Record<string, unknown>) {
  const harness = await createMockServiceNowHarness({ steps, tableAccess: policy });
  open.push(harness);
  const result = await harness.client.callTool({
    name: "sn_relationships",
    arguments: { profile: SNSDK54_PROFILE_NAME, ...args },
  });
  return { result, harness };
}

interface MapData {
  relationships: unknown[];
  edges: unknown[];
  diagram: { source: string };
}

const text = (result: { content?: unknown }): string =>
  (result.content as Array<{ text: string }>).map((block) => block.text).join("\n");

describe("sn_relationships through the dispatcher", () => {
  const root = { operation: "get", response: { result: { sys_id: ROOT, name: "root-ci", sys_class_name: "Linux Server" } } } as const;
  const rels = {
    operation: "get",
    response: {
      result: [
        {
          sys_id: { value: REL, display_value: REL },
          parent: { value: ROOT, display_value: "root-ci" },
          child: { value: CHILD, display_value: "child-ci" },
          type: { value: "d".repeat(32), display_value: "Depends on::Used by" },
        },
      ],
    },
  } as const;
  const cis = { operation: "get", response: { result: [{ sys_id: CHILD, name: "child-ci", sys_class_name: "Application" }] } } as const;

  it("returns the map as structured data and as text with a Mermaid block", async () => {
    const { result, harness } = await call([root, rels, cis], { sys_id: ROOT, depth: 1, map: true });
    expect(result.isError).toBeFalsy();
    const data = (result.structuredContent as { data: MapData }).data;
    expect(data.relationships).toEqual([
      { name: "child-ci", class: "Application", type: "Depends on::Used by", direction: "downstream", sys_id: CHILD, via: ROOT, depth: 1 },
    ]);
    expect(data.edges).toEqual([{ sys_id: REL, parent: ROOT, child: CHILD, type: "Depends on::Used by" }]);
    expect(data.diagram.source).toBe('flowchart TD\nn1(["root-ci (Linux Server)"])\nn2["child-ci (Application)"]\nn1 --> n2');
    expect(text(result)).toContain("```mermaid");
    harness.fixture.assertConsumed();
    expect(harness.fixture.calls.map((entry) => entry.params?.sysparm_query)).toEqual([
      undefined,
      `parentIN${ROOT}^ORchildIN${ROOT}^ORDERBYsys_id`,
      `sys_idIN${CHILD}`,
    ]);
  });

  it("tells the caller which CIs share an ambiguous name", async () => {
    const { result } = await call(
      [{ operation: "get", response: { result: [{ sys_id: ROOT, name: "dup", sys_class_name: "Linux Server" }, { sys_id: CHILD, name: "dup", sys_class_name: "Application" }] } }],
      { ci_name: "dup" }
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('ci_name "dup" matches more than one CI');
    expect(text(result)).toContain(`dup, class Application, sys_id ${CHILD}`);
  });

  it("says a missing CI was not found, not that the call failed unexpectedly", async () => {
    const { result } = await call([{ operation: "get", response: { result: [] } }], { ci_name: "nothing" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("was not found");
    expect(text(result)).not.toContain("failed unexpectedly");
  });

  it("tells the caller a start CI is required", async () => {
    const { result } = await call([], { depth: 1 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Either ci_name or sys_id is required");
    expect(text(result)).not.toContain("failed unexpectedly");
  });

  it("says when max_response_bytes is too small for any result, and what to do", async () => {
    const { result } = await call([root, rels, cis], { sys_id: ROOT, depth: 1, map: true, max_response_bytes: 1000 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("does not fit max_response_bytes");
  });

  it("honours max_response_bytes at the default and a larger budget", async () => {
    for (const max_response_bytes of [100_000, 1_000_000]) {
      const { result } = await call([root, rels, cis], { sys_id: ROOT, depth: 1, max_response_bytes });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { metadata: { limits: { max_bytes: number } } }).metadata.limits.max_bytes).toBe(max_response_bytes);
    }
  });
});
