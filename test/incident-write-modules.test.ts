import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import { ENCODED_QUERY_MIGRATION_MESSAGE } from "../src/encoded-query-policy.js";
import { incidentJournalMigrationMessage } from "../src/incident-journal-policy.js";
import { trustedToolErrorDescriptor } from "../src/tool-error.js";
import {
  createToolModule,
  definition as createDefinition,
  handler as createHandler,
  moduleInputSchema as createModuleInputSchema,
  resolveCreateAccess,
  schema as createSchema,
} from "../src/tools/create-module.js";
import {
  createToolModule as facadeCreateToolModule,
  definition as facadeCreateDefinition,
  handler as facadeCreateHandler,
  moduleInputSchema as facadeCreateModuleInputSchema,
  resolveCreateAccess as facadeResolveCreateAccess,
  schema as facadeCreateSchema,
} from "../src/tools/create.js";
import { serviceNowToolModules } from "../src/tools/catalog.js";
import { productionToolOutputSchemas } from "../src/tools/result-envelope.js";
import type { ServiceNowToolHandlerServices } from "../src/tools/tool-module.js";
import {
  definition as updateDefinition,
  handler as updateHandler,
  moduleInputSchema as updateModuleInputSchema,
  resolveUpdateAccess,
  schema as updateSchema,
  updateToolModule,
} from "../src/tools/update-module.js";
import {
  definition as facadeUpdateDefinition,
  handler as facadeUpdateHandler,
  moduleInputSchema as facadeUpdateModuleInputSchema,
  resolveUpdateAccess as facadeResolveUpdateAccess,
  schema as facadeUpdateSchema,
  updateToolModule as facadeUpdateToolModule,
} from "../src/tools/update.js";

const PROFILE = "incident-production";
const SYS_ID = "ABCDEF0123456789ABCDEF0123456789";
const CANONICAL_SYS_ID = SYS_ID.toLowerCase();

function services(serviceNow: ServiceNowOperations): ServiceNowToolHandlerServices {
  return {
    serviceNow,
    settings: {
      instance: "https://incident-write.service-now.com",
      displayValue: "true",
      relDepth: 3,
    },
    context: { effectivePolicy: {} },
  } as ServiceNowToolHandlerServices;
}

function responseData(result: { content: Array<{ type: string; text?: string }> }) {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected one text response");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function rejectedDescriptor(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return trustedToolErrorDescriptor(error);
  }
  throw new Error("Expected operation to reject");
}

describe("SNSDK-49 canonical incident write modules", () => {
  it("owns both public contracts while preserving facade and catalog identity", () => {
    expect(createDefinition).toEqual({
      name: "sn_create",
      description: expect.stringContaining("any table the configured policy grants"),
      annotations: {
        title: "Create record",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
    expect(updateDefinition).toEqual({
      name: "sn_update",
      description: expect.stringContaining("canonical sys_id"),
      annotations: {
        title: "Update record",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    });
    expect(createHandler.length).toBe(4);
    expect(updateHandler.length).toBe(4);

    expect(facadeCreateDefinition).toBe(createDefinition);
    expect(facadeCreateSchema).toBe(createSchema);
    expect(facadeCreateModuleInputSchema).toBe(createModuleInputSchema);
    expect(facadeCreateHandler).toBe(createHandler);
    expect(facadeResolveCreateAccess).toBe(resolveCreateAccess);
    expect(facadeCreateToolModule).toBe(createToolModule);
    expect(facadeUpdateDefinition).toBe(updateDefinition);
    expect(facadeUpdateSchema).toBe(updateSchema);
    expect(facadeUpdateModuleInputSchema).toBe(updateModuleInputSchema);
    expect(facadeUpdateHandler).toBe(updateHandler);
    expect(facadeResolveUpdateAccess).toBe(resolveUpdateAccess);
    expect(facadeUpdateToolModule).toBe(updateToolModule);
    expect(
      serviceNowToolModules.find(({ definition }) => definition.name === "sn_create")
    ).toBe(createToolModule);
    expect(
      serviceNowToolModules.find(({ definition }) => definition.name === "sn_update")
    ).toBe(updateToolModule);
  });

  it("declares complete frozen incident-only dependencies and strict outputs", () => {
    for (const [module, capability] of [
      [createToolModule, "record:create"],
      [updateToolModule, "record:update"],
    ] as const) {
      expect(module.runtime).toBe("servicenow");
      expect(module.requirements).toEqual({
        permissions: ["write"],
        // Which table is written is resolved from the caller's argument and
        // authorized by the configured table policy, so the dependency is
        // dynamic rather than a fixed incident-only set.
        tables: {
          kind: "dynamic",
          names: [],
          description: expect.stringContaining("Caller-selected table"),
        },
        apis: ["table"],
        fieldPolicies: ["write"],
        capabilities: [capability],
      });
      expect(Object.isFrozen(module)).toBe(true);
      expect(Object.isFrozen(module.requirements)).toBe(true);
      expect(Object.isFrozen(module.requirements.tables)).toBe(true);
    }
    expect(createToolModule.outputSchema).toBe(
      productionToolOutputSchemas.sn_create
    );
    expect(updateToolModule.outputSchema).toBe(
      productionToolOutputSchemas.sn_update
    );
    expect(
      createToolModule.outputSchema.safeParse({
        profile: PROFILE,
        data: {
          sys_id: CANONICAL_SYS_ID,
          number: "INC0010001",
          table: "incident",
          record: {},
        },
        metadata: {
          kind: "operation",
          record_count: 1,
          limits: { max_records: 1_000, max_bytes: 1_048_576 },
          pagination: { mode: "none" },
          truncation: { truncated: false },
        },
      }).success
    ).toBe(true);
    for (const invalid of [
      { sys_id: "short", table: "incident", record: {} },
      { sys_id: CANONICAL_SYS_ID, table: "Not A Table", record: {} },
      { sys_id: CANONICAL_SYS_ID, table: "incident", record: {}, extra: true },
    ]) {
      const validEnvelope = {
        profile: PROFILE,
        data: invalid,
        metadata: {
          kind: "operation",
          record_count: 1,
          limits: { max_records: 1_000, max_bytes: 1_048_576 },
          pagination: { mode: "none" },
          truncation: { truncated: false },
        },
      };
      expect(createToolModule.outputSchema.safeParse(validEnvelope).success).toBe(
        false
      );
    }
  });

  it("canonicalizes immutable access plans and approved incident values", () => {
    const create = resolveCreateAccess({
      profile: PROFILE,
      table: " INCIDENT ",
      fields: {
        short_description: "  Database unavailable  ",
        urgency: 2,
        caller_id: SYS_ID,
      },
    });
    const update = resolveUpdateAccess({
      profile: PROFILE,
      table: " INCIDENT ",
      sys_id: SYS_ID,
      fields: { state: "-01", close_notes: "Fixed\nSafely" },
    });

    expect(create.args).toMatchObject({
      profile: PROFILE,
      table: "incident",
      fields: {
        short_description: "Database unavailable",
        urgency: "2",
        caller_id: CANONICAL_SYS_ID,
      },
    });
    expect(update.args).toMatchObject({
      profile: PROFILE,
      table: "incident",
      sys_id: CANONICAL_SYS_ID,
      fields: { state: "-1", close_notes: "Fixed\nSafely" },
    });
    for (const access of [create, update]) {
      expect(access.requests).toEqual([{ operation: "write", table: "incident" }]);
      expect(Object.isFrozen(access.args)).toBe(true);
      expect(Object.isFrozen(access.requests)).toBe(true);
      expect(Object.isFrozen(access.requests[0])).toBe(true);
    }
  });

  it("uses exact POST/PATCH paths and bodies and returns filtered structured data", async () => {
    const createUpstream = {
      sys_id: CANONICAL_SYS_ID,
      number: "INC0010001",
      short_description: "Database unavailable",
      urgency: "2",
      password: "create-secret-must-not-cross",
      comments: "journal-must-not-cross",
      empty: "",
    };
    const updateUpstream = {
      sys_id: SYS_ID,
      state: "6",
      close_notes: "Fixed",
      access_token: "update-secret-must-not-cross",
      empty: null,
    };
    const createBefore = JSON.stringify(createUpstream);
    const updateBefore = JSON.stringify(updateUpstream);
    const post = vi.fn(async () => ({ result: createUpstream }));
    const patch = vi.fn(async () => ({ result: updateUpstream }));
    const operations = { post, patch } as unknown as ServiceNowOperations;
    const createAccess = resolveCreateAccess({
      profile: PROFILE,
      table: "incident",
      fields: { short_description: "Database unavailable", urgency: 2 },
    });
    const updateAccess = resolveUpdateAccess({
      profile: PROFILE,
      table: "incident",
      sys_id: SYS_ID,
      fields: { state: "06", close_notes: "Fixed" },
    });

    const created = await createToolModule.invoke(
      createAccess.args,
      services(operations)
    );
    const updated = await updateToolModule.invoke(
      updateAccess.args,
      services(operations)
    );

    expect(post).toHaveBeenCalledWith("/api/now/table/incident", {
      short_description: "Database unavailable",
      urgency: "2",
    });
    expect(patch).toHaveBeenCalledWith(
      `/api/now/table/incident/${CANONICAL_SYS_ID}`,
      { state: "6", close_notes: "Fixed" }
    );
    expect(responseData(created)).toEqual({
      sys_id: CANONICAL_SYS_ID,
      number: "INC0010001",
      table: "incident",
      // `comments` is no longer withheld by a built-in readable list.
      record: {
        comments: "journal-must-not-cross",
        short_description: "Database unavailable",
        urgency: "2",
      },
    });
    expect(responseData(updated)).toEqual({
      sys_id: CANONICAL_SYS_ID,
      record: { state: "6", close_notes: "Fixed" },
    });
    expect(created.structuredContent?.data).toEqual(responseData(created));
    expect(updated.structuredContent?.data).toEqual(responseData(updated));
    // The journal canary now crosses: `comments` is no longer withheld by a
    // built-in readable list. The sensitive-name filter still removes the
    // secret canary and every password/token-shaped name.
    expect(JSON.stringify([created, updated])).not.toMatch(
      /secret-must-not-cross|access_token|password/u
    );
    expect(JSON.stringify(createUpstream)).toBe(createBefore);
    expect(JSON.stringify(updateUpstream)).toBe(updateBefore);
  });

  it("canonicalizes direct update callers and rejects a mismatched upstream identity", async () => {
    const patch = vi.fn(async () => ({
      result: { sys_id: SYS_ID, state: "6" },
    }));
    const direct = await Reflect.apply(updateHandler, undefined, [
      { table: "incident", sys_id: SYS_ID, fields: { state: "06" } },
      { patch } as unknown as ServiceNowOperations,
      {},
      {},
    ]);
    expect(patch).toHaveBeenCalledWith(
      `/api/now/table/incident/${CANONICAL_SYS_ID}`,
      { state: "6" }
    );
    expect(responseData(direct)).toEqual({
      sys_id: CANONICAL_SYS_ID,
      record: { state: "6" },
    });

    const mismatched = vi.fn(async () => ({
      result: { sys_id: "1".repeat(32), state: "6" },
    }));
    expect(
      await rejectedDescriptor(
        Reflect.apply(updateHandler, undefined, [
          { table: "incident", sys_id: SYS_ID, fields: { state: "6" } },
          { patch: mismatched } as unknown as ServiceNowOperations,
          {},
          {},
        ])
      )
    ).toEqual({
      category: "upstream",
      message: "ServiceNow could not complete the request.",
      retry: "retry_if_safe_and_idempotent",
    });
  });

  it("rejects raw queries, multi-target selectors, journals, and invalid values preflight", () => {
    for (const selector of [
      { query: "active=true" },
      { sys_ids: [CANONICAL_SYS_ID] },
      { identifier: { field: "number", value: "INC0010001" } },
      { structured_query: { where: [] } },
    ]) {
      const input = {
        profile: PROFILE,
        table: "incident",
        fields: { short_description: "safe" },
        ...selector,
      };
      expect(() => resolveCreateAccess(input)).toThrow();
      if ("query" in selector) {
        expect(() => resolveCreateAccess(input)).toThrow(
          ENCODED_QUERY_MIGRATION_MESSAGE
        );
      }
    }
    // A non-incident table is no longer rejected here: whether it may be
    // written is the configured table policy's decision, made by the
    // dispatcher against the plan this resolver returns.
    expect(
      resolveCreateAccess({
        profile: PROFILE,
        table: "problem",
        fields: { short_description: "safe" },
      }).requests
    ).toEqual([{ operation: "write", table: "problem" }]);
    for (const invalid of [
      { profile: PROFILE, table: "incident", fields: { description: "missing" } },
      { profile: PROFILE, table: "incident", fields: { short_description: "  " } },
      {
        profile: PROFILE,
        table: "incident",
        fields: { short_description: "safe", category: "x^ORactive=true" },
      },
      {
        profile: PROFILE,
        table: "incident",
        fields: { short_description: "safe", caller_id: "not-a-sys-id" },
      },
    ]) {
      expect(() => resolveCreateAccess(invalid)).toThrow();
    }
    expect(() =>
      resolveUpdateAccess({
        profile: PROFILE,
        table: "incident",
        sys_id: CANONICAL_SYS_ID,
        fields: {},
      })
    ).toThrow();

    const canary = "journal-value-must-not-echo";
    let message = "";
    try {
      resolveUpdateAccess({
        profile: PROFILE,
        table: "incident",
        sys_id: CANONICAL_SYS_ID,
        fields: { comments: canary },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Incident journal policy rejected the request");
    expect(message).not.toContain(canary);
    expect(incidentJournalMigrationMessage("comments")).toContain(
      "sn_incident_add_comment"
    );
  });

  it("fails closed on malformed upstream wrappers without invoking traps", async () => {
    const trap = vi.fn(() => {
      throw new Error("upstream-trap-must-not-run");
    });
    const accessorWrapper = Object.defineProperty({}, "result", { get: trap });
    const resultProxy = new Proxy({ sys_id: CANONICAL_SYS_ID }, { get: trap });
    const cases = [
      {
        module: createToolModule,
        access: resolveCreateAccess({
          profile: PROFILE,
          table: "incident",
          fields: { short_description: "safe" },
        }),
        operations: {
          post: vi.fn(async () => accessorWrapper),
        } as unknown as ServiceNowOperations,
      },
      {
        module: updateToolModule,
        access: resolveUpdateAccess({
          profile: PROFILE,
          table: "incident",
          sys_id: CANONICAL_SYS_ID,
          fields: { state: "6" },
        }),
        operations: {
          patch: vi.fn(async () => ({ result: resultProxy })),
        } as unknown as ServiceNowOperations,
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      expect(
        await rejectedDescriptor(
          candidate.module.invoke(candidate.access.args, services(candidate.operations))
        )
      ).toEqual({
        category: "upstream",
        message: "ServiceNow could not complete the request.",
        retry:
          index === 0 ? "do_not_retry" : "retry_if_safe_and_idempotent",
      });
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("keeps 5,000 complete write preflights within the local one-second budget", () => {
    const started = performance.now();
    for (let index = 0; index < 2_500; index += 1) {
      resolveCreateAccess({
        profile: PROFILE,
        table: "incident",
        fields: { short_description: `bounded create ${index}`, urgency: 2 },
      });
      resolveUpdateAccess({
        profile: PROFILE,
        table: "incident",
        sys_id: CANONICAL_SYS_ID,
        fields: { state: "6" },
      });
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
