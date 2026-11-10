import { describe, expect, it } from "vitest";

import { enrichSuccessfulResult } from "../src/tools/index.js";
import {
  headline,
  inline,
  recordLink,
  renderMarkdown,
  table,
} from "../src/tools/markdown.js";
import {
  DEFAULT_RESULT_BYTE_LIMIT,
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
  registerEnvelopeTextRenderer,
  type EnvelopeTextRenderContext,
  type ProductionToolName,
  type RenderableEnvelope,
} from "../src/tools/result-envelope.js";
import {
  SNSDK54_INSTANCE,
  SNSDK54_PROFILE_NAME,
  SNSDK54_SYS_ID,
  createMockServiceNowHarness,
} from "./fixtures/mock-servicenow.js";

const PROFILE = "renderer-profile";

function captureError(action: () => void): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

// Vitest isolates modules per file, so these test-only renderers are
// registered before this file finalizes anything and never leak elsewhere.
const seen: RenderableEnvelope[] = [];
const seenContexts: EnvelopeTextRenderContext[] = [];
registerEnvelopeTextRenderer("sn_health", (envelope, context) => {
  seen.push(envelope);
  seenContexts.push(context);
  return renderMarkdown(
    headline("Instance health", { status: "pass" }),
    inline(context.summary)
  );
});
registerEnvelopeTextRenderer("sn_nl", () => "x".repeat(DEFAULT_RESULT_BYTE_LIMIT));
registerEnvelopeTextRenderer("sn_profile", () => {
  throw new Error("renderer failure");
});
registerEnvelopeTextRenderer("sn_aggregate", () => 42 as unknown as string);
registerEnvelopeTextRenderer("sn_schema", () => "   ");
registerEnvelopeTextRenderer("sn_discover", (envelope) => {
  (envelope.data as { results: unknown[] }).results.push("mutated");
  return "unreachable";
});
registerEnvelopeTextRenderer("sn_query", (envelope, context) => {
  const results = (envelope.data as { results: Array<Record<string, unknown>> })
    .results;
  return renderMarkdown(
    headline("Incidents", { detail: `${results.length} shown` }),
    table(
      ["Number"],
      results.map((record) => [
        recordLink(
          context.instanceOrigin ?? "",
          "incident",
          String(record.sys_id),
          String(record.number)
        ),
      ])
    )
  );
});

const earlyRegistrationErrors = {
  duplicate: captureError(() =>
    registerEnvelopeTextRenderer("sn_health", () => "again")
  ),
  unknown: captureError(() =>
    registerEnvelopeTextRenderer("sn_nope" as ProductionToolName, () => "x")
  ),
  nonFunction: captureError(() =>
    registerEnvelopeTextRenderer("sn_get", "x" as never)
  ),
};

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function enriched(
  tool: ProductionToolName,
  args: Readonly<Record<string, unknown>>,
  data: unknown
) {
  return enrichSuccessfulResult(
    envelopeCompatibilityResult(tool, args, textResult(data)),
    PROFILE
  );
}

function withAndWithoutTool(
  tool: ProductionToolName,
  args: Readonly<Record<string, unknown>>,
  data: unknown
) {
  const source = enriched(tool, args, data);
  const withTool = finalizeEnvelopeResult(source, tool);
  const withoutTool = finalizeEnvelopeResult(source);
  expect(withTool).toBeDefined();
  expect(withoutTool).toBeDefined();
  return { withTool: withTool!, withoutTool: withoutTool! };
}

describe("envelope text renderer registry", () => {
  it("rejects duplicate, unknown, and non-function registrations", () => {
    expect(earlyRegistrationErrors.duplicate).toBeInstanceOf(TypeError);
    expect(String(earlyRegistrationErrors.duplicate)).toMatch(/already registered/u);
    expect(earlyRegistrationErrors.unknown).toBeInstanceOf(TypeError);
    expect(String(earlyRegistrationErrors.unknown)).toMatch(/production tool name/u);
    expect(earlyRegistrationErrors.nonFunction).toBeInstanceOf(TypeError);
  });

  it("seals the registry once a result has been finalized", () => {
    finalizeEnvelopeResult(enriched("sn_get", {}, { sys_id: SNSDK54_SYS_ID }));
    expect(() => registerEnvelopeTextRenderer("sn_get", () => "late")).toThrow(
      /sealed/u
    );
  });

  it("keeps the one-line summary byte-identical for tools without a renderer", () => {
    for (const tool of ["sn_get", "sn_nope"]) {
      const source = enriched("sn_get", {}, { sys_id: SNSDK54_SYS_ID });
      const result = finalizeEnvelopeResult(source, tool);
      expect(result).toStrictEqual(finalizeEnvelopeResult(source));
      expect(result?.content).toEqual([
        {
          type: "text",
          text: `Success for profile "${PROFILE}": single result with 1 record.`,
        },
      ]);
    }
  });

  it("dispatches to the registered renderer without changing structured content", () => {
    const { withTool, withoutTool } = withAndWithoutTool("sn_health", {}, {
      status: "ok",
    });
    expect(withTool.content).toEqual([
      {
        type: "text",
        text:
          "### ✅ Instance health\n\n" +
          `Success for profile "${PROFILE}": single result with 1 record.`,
      },
    ]);
    expect(withTool.structuredContent).toStrictEqual(withoutTool.structuredContent);
    const view = seen.at(-1)!;
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.metadata)).toBe(true);
    expect(Object.isFrozen(view.data)).toBe(true);
  });

  it("passes only a validated instance origin in the render context", () => {
    const source = enriched("sn_health", {}, { status: "ok" });
    const summary = `Success for profile "${PROFILE}": single result with 1 record.`;

    finalizeEnvelopeResult(source, "sn_health", {
      instanceOrigin: "https://example.service-now.com/",
    });
    expect(seenContexts.at(-1)).toStrictEqual({
      summary,
      instanceOrigin: "https://example.service-now.com",
    });
    expect(Object.isFrozen(seenContexts.at(-1))).toBe(true);

    for (const instanceOrigin of [
      undefined,
      "http://example.service-now.com",
      "https://example.service-now.com/path",
      "https://user:pw@example.service-now.com",
    ]) {
      finalizeEnvelopeResult(source, "sn_health", { instanceOrigin });
      expect(seenContexts.at(-1)).toStrictEqual({ summary });
    }
  });

  it("falls back to the summary instead of truncating when rendered text overflows", () => {
    const { withTool, withoutTool } = withAndWithoutTool("sn_nl", {}, {
      table: "incident",
      results: [{ sys_id: SNSDK54_SYS_ID }],
    });
    expect(withTool).toStrictEqual(withoutTool);
    expect(withTool.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^Success for profile/u),
    });
  });

  it.each([
    ["throws", "sn_profile" as const, { name: PROFILE, instance: "https://x.service-now.com", auth_type: "basic" }],
    ["returns a non-string", "sn_aggregate" as const, { stats: { count: "3" } }],
    ["returns blank text", "sn_schema" as const, [{ field: "number" }]],
  ])("falls back to the summary when the renderer %s", (_label, tool, data) => {
    const { withTool, withoutTool } = withAndWithoutTool(tool, {}, data);
    expect(withTool).toStrictEqual(withoutTool);
  });

  it("gives renderers a frozen copy so structured content cannot be altered", () => {
    const { withTool, withoutTool } = withAndWithoutTool(
      "sn_discover",
      { type: "tables" },
      { results: [{ name: "incident" }] }
    );
    expect(withTool).toStrictEqual(withoutTool);
    expect(
      (withTool.structuredContent as { data: { results: unknown[] } }).data.results
    ).toEqual([{ name: "incident" }]);
  });

  it("delivers rendered text, linked from the profile's instance, through the MCP dispatcher", async () => {
    const connected = await createMockServiceNowHarness({
      steps: [
        {
          operation: "getWithMeta",
          response: {
            data: { result: [{ sys_id: SNSDK54_SYS_ID, number: "INC0010054" }] },
            status: 200,
            headers: new Headers({ "x-total-count": "1" }),
          },
        },
      ],
    });
    try {
      const result = await connected.client.callTool({
        name: "sn_query",
        arguments: {
          profile: SNSDK54_PROFILE_NAME,
          table: "incident",
          fields: "sys_id,number",
          limit: 2,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([
        {
          type: "text",
          text:
            "### Incidents — 1 shown\n\n| Number |\n| --- |\n" +
            `| [INC0010054](${SNSDK54_INSTANCE}/incident.do?sys_id=${SNSDK54_SYS_ID}) |`,
        },
      ]);
      expect(
        (result.structuredContent as { data: { results: unknown[] } }).data.results
      ).toHaveLength(1);
      // The origin reaches the renderer only; structured output is unchanged.
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        SNSDK54_INSTANCE
      );
      connected.fixture.assertConsumed();
    } finally {
      await connected.close();
    }
  });
});
