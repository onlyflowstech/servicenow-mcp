import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import { trustedToolErrorDescriptor } from "../src/tool-error.js";
import {
  definition,
  getToolModule,
  handler,
  moduleInputSchema,
  resolveGetAccess,
  schema,
} from "../src/tools/get-module.js";
import {
  definition as compatibilityDefinition,
  getToolModule as compatibilityToolModule,
  handler as compatibilityHandler,
  moduleInputSchema as compatibilityModuleInputSchema,
  resolveGetAccess as compatibilityResolveGetAccess,
  schema as compatibilitySchema,
} from "../src/tools/get.js";
import {
  finalizeEnvelopeResult,
  productionToolOutputSchemas,
} from "../src/tools/result-envelope.js";
import type { ServiceNowToolHandlerServices } from "../src/tools/tool-module.js";

const PROFILE = "production";
const SYS_ID = "ABCDEF0123456789ABCDEF0123456789";

function parsedInput(overrides: Record<string, unknown> = {}) {
  return moduleInputSchema.parse({
    profile: PROFILE,
    table: "incident",
    sys_id: SYS_ID,
    ...overrides,
  });
}

function services(serviceNow: ServiceNowOperations): ServiceNowToolHandlerServices {
  return {
    serviceNow,
    settings: {
      instance: "https://get-module.service-now.com",
      displayValue: "true",
      relDepth: 3,
    },
    context: { effectivePolicy: {} },
  } as ServiceNowToolHandlerServices;
}

function fakeOperations(
  implementation: (
    path: string,
    params: Record<string, string>
  ) => Promise<{ result: unknown }>
) {
  const get = vi.fn(implementation);
  return {
    get,
    operations: { get } as unknown as ServiceNowOperations,
  };
}

function responseData(
  result: Awaited<ReturnType<typeof getToolModule.invoke>>
): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text response");
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function rejectedDescriptor(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return trustedToolErrorDescriptor(error);
  }
  throw new Error("expected operation to reject");
}

describe("SNSDK-48 sn_get module", () => {
  it("owns the exact public contract while preserving identity facade exports", () => {
    expect(definition).toEqual({
      name: "sn_get",
      description: expect.stringContaining("human-readable identifier"),
      annotations: {
        title: "Get record",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    });
    expect(moduleInputSchema.safeParse({ table: "incident", sys_id: SYS_ID }).success).toBe(
      false
    );
    expect(
      moduleInputSchema.safeParse({
        profile: PROFILE,
        table: "incident",
        sys_id: SYS_ID,
        unknown: true,
      }).success
    ).toBe(false);
    expect(compatibilityDefinition).toBe(definition);
    expect(compatibilitySchema).toBe(schema);
    expect(compatibilityModuleInputSchema).toBe(moduleInputSchema);
    expect(compatibilityHandler).toBe(handler);
    expect(compatibilityResolveGetAccess).toBe(resolveGetAccess);
    expect(compatibilityToolModule).toBe(getToolModule);
  });

  it("declares a complete frozen read module and canonical preflight", () => {
    expect(getToolModule.runtime).toBe("servicenow");
    expect(getToolModule.outputSchema).toBe(productionToolOutputSchemas.sn_get);
    expect(getToolModule.requirements).toEqual({
      permissions: ["read"],
      tables: {
        kind: "dynamic",
        names: [],
        description: "Caller-selected policy-approved table.",
      },
      apis: ["table"],
      fieldPolicies: ["read"],
      capabilities: ["record:get"],
    });
    const access = getToolModule.resolveAccess(
      parsedInput({ table: " INCIDENT ", fields: "sys_id,number" }),
      {} as Parameters<typeof getToolModule.resolveAccess>[1]
    );
    expect(access.args).toMatchObject({
      profile: PROFILE,
      table: "incident",
      sys_id: SYS_ID.toLowerCase(),
      fields: "sys_id,number",
    });
    expect(access.requests).toEqual([{ operation: "read", table: "incident" }]);
    expect(Object.isFrozen(access.args)).toBe(true);
    expect(Object.isFrozen(access.requests)).toBe(true);
  });

  it("fetches an approved record directly by canonical sys_id", async () => {
    const fake = fakeOperations(async () => ({
      result: {
        sys_id: SYS_ID.toLowerCase(),
        number: "INC0010001",
        password: "must-not-cross",
      },
    }));
    const access = getToolModule.resolveAccess(
      parsedInput({ fields: "sys_id,number" }),
      {} as Parameters<typeof getToolModule.resolveAccess>[1]
    );
    const result = await getToolModule.invoke(access.args, services(fake.operations));

    expect(fake.get).toHaveBeenCalledWith(
      `/api/now/table/incident/${SYS_ID.toLowerCase()}`,
      {
        sysparm_exclude_reference_link: "true",
        sysparm_fields: "sys_id,number",
        sysparm_display_value: "true",
      }
    );
    expect(responseData(result)).toEqual({
      sys_id: SYS_ID.toLowerCase(),
      number: "INC0010001",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
  });

  it("resolves one approved human identifier with an exact bounded stable query", async () => {
    const fake = fakeOperations(async () => ({
      result: [
        {
          sys_id: SYS_ID.toLowerCase(),
          number: "INC0010001",
          short_description: "Database down",
          password: "must-not-cross",
        },
      ],
    }));
    const access = getToolModule.resolveAccess(
      moduleInputSchema.parse({
        profile: PROFILE,
        table: "incident",
        identifier: { field: " NUMBER ", value: " INC0010001 " },
        fields: "number,short_description",
      }),
      {} as Parameters<typeof getToolModule.resolveAccess>[1]
    );
    const result = await getToolModule.invoke(access.args, services(fake.operations));

    expect(access.args.identifier).toEqual({
      field: "number",
      value: "INC0010001",
    });
    expect(fake.get).toHaveBeenCalledWith("/api/now/table/incident", {
      sysparm_exclude_reference_link: "true",
      sysparm_limit: "2",
      sysparm_query: "number=INC0010001^ORDERBYsys_id",
      sysparm_fields: "number,short_description,sys_id",
      sysparm_display_value: "true",
    });
    expect(responseData(result)).toEqual({
      number: "INC0010001",
      short_description: "Database down",
    });
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("issues normalized not-found and ambiguity errors without selector values", async () => {
    const notFound = fakeOperations(async () => ({ result: [] }));
    const ambiguous = fakeOperations(async () => ({
      result: [{ sys_id: "1".repeat(32) }, { sys_id: "2".repeat(32) }],
    }));
    const access = getToolModule.resolveAccess(
      moduleInputSchema.parse({
        profile: PROFILE,
        table: "incident",
        identifier: { field: "number", value: "SECRET-LOOKUP-VALUE" },
      }),
      {} as Parameters<typeof getToolModule.resolveAccess>[1]
    );

    expect(
      await rejectedDescriptor(
        getToolModule.invoke(access.args, services(notFound.operations))
      )
    ).toEqual({
      category: "not_found",
      message: "The requested ServiceNow resource was not found.",
      retry: "do_not_retry",
    });
    expect(
      await rejectedDescriptor(
        getToolModule.invoke(access.args, services(ambiguous.operations))
      )
    ).toEqual({
      category: "conflict",
      message: "ServiceNow reported a conflicting resource state.",
      retry: "retry_after_correction",
    });
    for (const operation of [notFound.get, ambiguous.get]) {
      expect(JSON.stringify(operation.mock.calls)).toContain("SECRET-LOOKUP-VALUE");
    }
  });

  it("fails closed on malformed upstream wrappers without invoking traps", async () => {
    const trap = vi.fn(() => {
      throw new Error("must-not-run-upstream-trap");
    });
    const accessorWrapper = Object.defineProperty({}, "result", { get: trap });
    const listProxy = new Proxy([], { get: trap });
    const cases = [
      fakeOperations(async () => accessorWrapper as { result: unknown }),
      fakeOperations(async () => ({ result: listProxy })),
    ];
    const inputs = [
      parsedInput(),
      moduleInputSchema.parse({
        profile: PROFILE,
        table: "incident",
        identifier: { field: "number", value: "INC0010001" },
      }),
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const access = getToolModule.resolveAccess(
        inputs[index]!,
        {} as Parameters<typeof getToolModule.resolveAccess>[1]
      );
      expect(
        await rejectedDescriptor(
          getToolModule.invoke(access.args, services(cases[index]!.operations))
        )
      ).toEqual({
        category: "upstream",
        message: "ServiceNow could not complete the request.",
        retry: "retry_if_safe_and_idempotent",
      });
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("rejects malformed selectors and unauthorized fields before operations", () => {
    for (const input of [
      { profile: PROFILE, table: "incident" },
      {
        profile: PROFILE,
        table: "incident",
        sys_id: SYS_ID,
        identifier: { field: "number", value: "INC0010001" },
      },
      {
        profile: PROFILE,
        table: "incident",
        identifier: { field: "short_description", value: "Database down" },
      },
      {
        profile: PROFILE,
        table: "incident",
        identifier: { field: "number", value: "INC1^ORactive=true" },
      },
      {
        profile: PROFILE,
        table: "incident",
        sys_id: SYS_ID,
        fields: "sys_id,password",
      },
    ]) {
      expect(() => resolveGetAccess(input)).toThrow();
    }
  });

  it("filters, copies, and byte-fits a record without mutating upstream data", async () => {
    const upstream = {
      sys_id: SYS_ID.toLowerCase(),
      description: "record-canary-" + "x".repeat(5_000),
      password: "must-not-cross",
      caller_id: {
        value: "3".repeat(32),
        display_value: "Caller",
        access_token: "must-not-cross-nested",
      },
      truncated: "legitimate-record-collision-canary",
      truncated_fields: "legitimate-record-collision-canary",
      hint: "legitimate-record-collision-canary",
    };
    const before = JSON.stringify(upstream);
    const fake = fakeOperations(async () => ({ result: upstream }));
    const access = getToolModule.resolveAccess(
      parsedInput({
        fields: "sys_id,description,caller_id",
        max_response_bytes: 1_000,
      }),
      {} as Parameters<typeof getToolModule.resolveAccess>[1]
    );
    const result = await getToolModule.invoke(access.args, services(fake.operations));
    const finalized = finalizeEnvelopeResult({
      ...result,
      structuredContent: {
        ...result.structuredContent,
        profile: PROFILE,
      },
    });
    if (!finalized?.structuredContent) {
      throw new Error("expected a fitted structured result");
    }
    const data = finalized.structuredContent.data as {
      record: Record<string, unknown>;
    };

    expect(JSON.stringify(upstream)).toBe(before);
    expect(Buffer.byteLength(JSON.stringify(finalized), "utf8")).toBeLessThanOrEqual(
      1_000
    );
    expect(data.record).toMatchObject({
      sys_id: SYS_ID.toLowerCase(),
    });
    expect(data.record).not.toHaveProperty("truncated");
    expect(data.record).not.toHaveProperty("truncated_fields");
    expect(data.record).not.toHaveProperty("hint");
    expect(finalized.structuredContent.metadata).toMatchObject({
      kind: "single",
      record_count: 1,
      pagination: { mode: "none" },
      truncation: { truncated: true, reason: "byte_limit" },
    });
    expect(JSON.stringify(data)).not.toMatch(
      /password|access_token|must-not-cross|collision-canary/u
    );
  });
});
