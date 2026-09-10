import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AtfPolicyError,
  DENY_ALL_ATF_EXECUTION,
  atfPolicyDenialMessage,
  createAtfExecutionPolicy,
  isAtfPolicyError,
  requireAtfExecution,
  type AtfExecutionPolicyInput,
} from "../src/atf-policy.js";
import {
  createAuditRecord,
  createExecutionContext,
} from "../src/execution-context.js";
import {
  createHttpObservability,
  type StructuredHttpEvent,
} from "../src/http-observability.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  withResolvedProfileOutput,
  type ServiceNowApiFamily,
} from "../src/tools/tool-module.js";
import {
  SNSDK54_PROFILE_NAME,
  createMockServiceNowHarness,
} from "./fixtures/mock-servicenow.js";

const REQUEST = Object.freeze({
  correlationId: "atf-policy-correlation",
  identity: Object.freeze({ ownerId: "atf-owner", clientId: "atf-client" }),
});
const PROFILE = Object.freeze({
  name: "atf",
  instance: "https://atf.service-now.com",
});

/** Test-only module standing in for a future ATF execution tool. */
function atfExecutionProbe(apis: readonly ServiceNowApiFamily[] = ["cicd"]) {
  return defineServiceNowToolModule({
    runtime: "servicenow",
    definition: {
      name: "sn_atf_execution_probe",
      description: "Test-only probe for the ATF execution grant.",
      annotations: {
        title: "ATF execution probe",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    inputSchema: withRequiredProfile(z.object({})),
    outputSchema: withResolvedProfileOutput(
      z.object({ result_cache_size:z.number().int() })
    ),
    requirements: {
      permissions: ["write"],
      tables: { kind: "none" },
      apis,
      fieldPolicies: [],
      capabilities: ["atf:execute"],
    },
    resolveAccess: (args, policy) => {
      requireAtfExecution(policy);
      return { args: args as Record<string, unknown>, requests: [] };
    },
    handler: async (_args, services): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "probe ran" }],
      structuredContent: {
        result_cache_size:services.settings.atf?.resultCacheSize ?? -1,
      },
    }),
  });
}

function policyProvider(atf?: AtfExecutionPolicyInput) {
  return {
    resolve: () => ({
      id: "atf-policy",
      revision: "v1",
      tableAccess: createTableAccessPolicy({}),
      ...(atf === undefined ? {} : { atf }),
    }),
  };
}

describe("createAtfExecutionPolicy", () => {
  it("denies everything when the provider states nothing", () => {
    expect(createAtfExecutionPolicy(undefined)).toBe(DENY_ALL_ATF_EXECUTION);
    expect(DENY_ALL_ATF_EXECUTION).toEqual({ execute: false, allowScriptSteps: false });
    expect(Object.isFrozen(DENY_ALL_ATF_EXECUTION)).toBe(true);
  });

  it("grants only what is explicitly true", () => {
    const policy = createAtfExecutionPolicy({ execute: true });
    expect(policy).toEqual({ execute: true, allowScriptSteps: false });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each([null, "execute", { execute: "true" }, { allowScriptSteps: 1 }])(
    "rejects the malformed provider value %j",
    (candidate) => {
      expect(() =>
        createAtfExecutionPolicy(candidate as AtfExecutionPolicyInput)
      ).toThrow(TypeError);
    }
  );
});

describe("AtfPolicyError", () => {
  it("is recognized only when issued by the policy module", () => {
    expect(isAtfPolicyError(new AtfPolicyError("execution_not_enabled"))).toBe(true);
    const impostor = Object.assign(new Error("ATF operation denied by policy"), {
      reason: "execution_not_enabled",
    });
    expect(isAtfPolicyError(impostor)).toBe(false);
    expect(isAtfPolicyError(undefined)).toBe(false);
  });

  it("names the grant that lifts the denial", () => {
    const message = atfPolicyDenialMessage(
      new AtfPolicyError("execution_not_enabled"),
      "sn_atf_run"
    );
    expect(message).toContain("denied by policy");
    expect(message).toContain("sn_atf_run");
    expect(message).toContain('"atf": { "execute": true }');
    expect(message).toContain("SN_ATF_EXECUTE=true");
    expect(
      atfPolicyDenialMessage(new AtfPolicyError("execution_not_enabled"), " ")
    ).toContain("This tool runs ATF tests");
  });
});

describe("requireAtfExecution", () => {
  it("throws the classified error without the grant", () => {
    expect(() => requireAtfExecution({ atf: DENY_ALL_ATF_EXECUTION })).toThrow(
      AtfPolicyError
    );
    expect(() =>
      requireAtfExecution({ atf: { execute: false, allowScriptSteps: true } })
    ).toThrow(AtfPolicyError);
  });

  it("passes with the grant", () => {
    expect(() =>
      requireAtfExecution({ atf: { execute: true, allowScriptSteps: false } })
    ).not.toThrow();
  });
});

describe("execution context ATF policy", () => {
  it("carries the provider's grant onto the resolved policy", async () => {
    const context = await createExecutionContext(
      REQUEST,
      PROFILE,
      "sn_atf_execution_probe",
      policyProvider({ execute: true })
    );
    expect(context.effectivePolicy.atf).toEqual({
      execute: true,
      allowScriptSteps: false,
    });
    expect(Object.isFrozen(context.effectivePolicy.atf)).toBe(true);
  });

  it("resolves an omitted grant to deny-all", async () => {
    const context = await createExecutionContext(
      REQUEST,
      PROFILE,
      "sn_atf_execution_probe",
      policyProvider()
    );
    expect(context.effectivePolicy.atf).toBe(DENY_ALL_ATF_EXECUTION);
  });

  it("fails context creation on a malformed grant", async () => {
    await expect(
      createExecutionContext(
        REQUEST,
        PROFILE,
        "sn_atf_execution_probe",
        policyProvider({ execute: "yes" } as unknown as AtfExecutionPolicyInput)
      )
    ).rejects.toThrow(TypeError);
  });
});

describe("atf_execution_denied audit reason", () => {
  it("is a valid policy rejection and reaches structured tool events", () => {
    const record = createAuditRecord({
      outcome: "policy_rejected",
      reason: "atf_execution_denied",
      tool: "sn_atf_execution_probe",
      request: REQUEST,
      profile: PROFILE,
    });
    expect(record).toMatchObject({
      outcome: "policy_rejected",
      reason: "atf_execution_denied",
      profile: "atf",
    });

    const events: StructuredHttpEvent[] = [];
    const observability = createHttpObservability({
      sink: { write: (event) => events.push(event) },
    });
    observability.beginTool().finish(record);
    expect(events).toEqual([
      expect.objectContaining({
        type: "mcp_tool",
        tool: "sn_atf_execution_probe",
        outcome: "policy_rejected",
        reason: "atf_execution_denied",
      }),
    ]);
  });
});

describe("cicd API family", () => {
  it("is accepted by the module contract", () => {
    expect(() => atfExecutionProbe(["cicd", "table"])).not.toThrow();
  });

  it("still rejects an undeclared family", () => {
    expect(() =>
      atfExecutionProbe(["ci_cd" as ServiceNowApiFamily])
    ).toThrow("unsupported API");
  });
});

describe("dispatcher ATF execution grant", () => {
  it("denies before any configuration or client exists, audited as atf_execution_denied", async () => {
    const harness = await createMockServiceNowHarness({
      modules: [atfExecutionProbe()],
    });
    try {
      const result = (await harness.client.callTool({
        name: "sn_atf_execution_probe",
        arguments: { profile: SNSDK54_PROFILE_NAME },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      const text = result.content.map((block) =>
        block.type === "text" ? block.text : ""
      ).join("");
      expect(text).toContain("ATF execution denied by policy");
      expect(text).toContain("sn_atf_execution_probe");
      expect(text).toContain("Correlation ID:");
      expect(text).not.toContain("Table access was denied");

      expect(harness.audits).toHaveLength(1);
      expect(harness.audits[0]).toMatchObject({
        outcome: "policy_rejected",
        reason: "atf_execution_denied",
        tool: "sn_atf_execution_probe",
      });
      expect(harness.managerCalls.config).toEqual([]);
      expect(harness.managerCalls.client).toEqual([]);
      expect(harness.fixture.calls).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("runs the handler with ATF settings when the profile grants execution", async () => {
    const harness = await createMockServiceNowHarness({
      modules: [atfExecutionProbe()],
      atf: { execute: true },
    });
    try {
      const result = (await harness.client.callTool({
        name: "sn_atf_execution_probe",
        arguments: { profile: SNSDK54_PROFILE_NAME },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        result_cache_size:10,
        profile: SNSDK54_PROFILE_NAME,
      });
      expect(harness.audits).toHaveLength(1);
      expect(harness.audits[0]).toMatchObject({ outcome: "success" });
      expect(harness.managerCalls.client).toEqual([SNSDK54_PROFILE_NAME]);
    } finally {
      await harness.close();
    }
  });
});
