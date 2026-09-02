import { readdirSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ExecutionContextDependencies } from "../src/execution-context.js";
import type { ProfileManager } from "../src/profile-manager.js";
import {
  REGISTERED_TOOL_COUNT,
  defineServiceNowToolModule,
  profileNameSchema,
  profileOutputSchema,
  registerServiceNowToolModules,
  toolModules,
  validateToolModuleCatalog,
  withRequiredProfile,
  withResolvedProfileOutput,
  type ToolModuleContract,
  type ToolModuleRequirements,
} from "../src/tools/index.js";

const definition = {
  name: "sn_contract_fixture",
  description: "Contract fixture used only by module unit tests.",
  annotations: {
    title: "Contract fixture",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

const requirements: ToolModuleRequirements = {
  permissions: ["read"],
  tables: {
    kind: "dynamic",
    names: [],
    description: "Fixture table selected from validated input.",
  },
  apis: ["table"],
  fieldPolicies: ["read"],
  capabilities: ["fixture:read"],
};

const inputSchema = withRequiredProfile(z.object({ table: z.string() }));
const outputSchema = withResolvedProfileOutput(
  z.object({ count: z.number().int().nonnegative() })
);

function descriptorPerfectClone<T extends object>(source: T): T {
  const clone = Object.create(Object.getPrototypeOf(source));
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(source));
  return clone as T;
}

function fixtureModule(name = definition.name) {
  return defineServiceNowToolModule({
    runtime: "servicenow",
    definition: { ...definition, name },
    inputSchema,
    outputSchema,
    requirements,
    resolveAccess: (args) => ({
      args: Object.freeze(inputSchema.parse(args)),
      requests: Object.freeze([]),
    }),
    handler: async () => ({
      content: [{ type: "text", text: "fixture" }],
      structuredContent: { count: 0 },
    }),
  });
}

describe("tool-module contract", () => {
  it("publishes one complete immutable contract for every compatible tool", () => {
    expect(toolModules).toHaveLength(REGISTERED_TOOL_COUNT);
    // Single source of truth for the published tool count. Every other
    // suite derives from REGISTERED_TOOL_COUNT, so this is the one literal
    // to update when a tool is added or removed.
    expect(REGISTERED_TOOL_COUNT).toBe(19);
    expect(() => validateToolModuleCatalog(toolModules)).not.toThrow();

    for (const module of toolModules) {
      expect(module.definition.name).toMatch(/^sn_[a-z][a-z0-9_]*$/u);
      expect(module.inputSchema.shape.profile).toBe(profileNameSchema);
      expect(module.outputSchema.shape.profile).toBe(profileNameSchema);
      expect(module.inputSchema.safeParse({ profile: "   " }).success).toBe(false);
      expect(module.outputSchema.safeParse({ profile: "   " }).success).toBe(false);
      expect(module.requirements.permissions.length).toBeGreaterThan(0);
      expect(module.requirements.capabilities.length).toBeGreaterThan(0);
      expect(module.requirements.tables).toHaveProperty("kind");
      expect(Array.isArray(module.requirements.apis)).toBe(true);
      expect(Array.isArray(module.requirements.fieldPolicies)).toBe(true);
      expect(Object.isFrozen(module)).toBe(true);
      expect(Object.isFrozen(module.definition.annotations)).toBe(true);
      expect(Object.isFrozen(module.requirements)).toBe(true);
    }
  });

  it("composes shared profile schemas without allowing local redefinition", () => {
    expect(inputSchema.parse({ profile: "  prod  ", table: "incident" })).toEqual({
      profile: "prod",
      table: "incident",
    });
    expect(outputSchema.parse({ profile: "  prod  ", count: 1 })).toEqual({
      profile: "prod",
      count: 1,
    });
    expect(
      outputSchema.safeParse({ profile: "prod", count: 1, undeclared: true })
        .success
    ).toBe(false);
    expect(() =>
      withRequiredProfile(z.object({ profile: z.string().optional() }))
    ).toThrow(/must not redefine profile/u);
    expect(() =>
      withResolvedProfileOutput(z.object({ profile: z.string() }))
    ).toThrow(/must not redefine profile/u);
  });

  it("rejects missing shared input or output profile schemas at definition", () => {
    expect(() =>
      defineServiceNowToolModule({
        runtime: "servicenow",
        definition,
        inputSchema: z.object({ table: z.string() }),
        outputSchema,
        requirements,
        resolveAccess: () => ({ args: {}, requests: [] }),
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/input schema must use the shared required profile schema/u);

    expect(() =>
      defineServiceNowToolModule({
        runtime: "servicenow",
        definition,
        inputSchema,
        outputSchema: z.object({ count: z.number() }),
        requirements,
        resolveAccess: () => ({ args: {}, requests: [] }),
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/output schema must use the shared required profile schema/u);
  });

  it("requires a handler-only factory and an invoke-only issued catalog module", () => {
    const invokeOnlyFactory = {
      runtime: "servicenow",
      definition,
      inputSchema,
      outputSchema,
      requirements,
      resolveAccess: () => ({ args: {}, requests: [] }),
      invoke: async () => ({ content: [] }),
    };
    expect(() =>
      defineServiceNowToolModule(
        invokeOnlyFactory as unknown as Parameters<
          typeof defineServiceNowToolModule
        >[0]
      )
    ).toThrow(/factory requires handler and prohibits invoke|unsupported property/u);

    const module = fixtureModule();
    expect(() =>
      validateToolModuleCatalog([
        { ...module, handler: async () => ({ content: [] }) } as unknown as ToolModuleContract,
      ])
    ).toThrow(/registered module|unsupported property/u);
    expect(() =>
      validateToolModuleCatalog([
        { ...module, invoke: undefined } as unknown as ToolModuleContract,
      ])
    ).toThrow(/registered module requires invoke/u);
  });

  it("rejects fake and proxied schemas that only imitate shape.profile", () => {
    const fakeSchema = { shape: { profile: profileNameSchema } };
    expect(() =>
      defineServiceNowToolModule({
        runtime: "servicenow",
        definition,
        inputSchema: fakeSchema as unknown as typeof inputSchema,
        outputSchema,
        requirements,
        resolveAccess: () => ({ args: {}, requests: [] }),
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/issued contract-normalized Zod object/u);

    const proxiedSchema = new Proxy(inputSchema, {});
    expect(() =>
      defineServiceNowToolModule({
        runtime: "servicenow",
        definition,
        inputSchema: proxiedSchema,
        outputSchema,
        requirements,
        resolveAccess: () => ({ args: {}, requests: [] }),
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/issued contract-normalized Zod object/u);
  });

  it("normalizes descriptor-perfect source clones and isolates parse/discovery from later mutation", async () => {
    const sourceInput = z.object({ table: z.string().min(1) });
    const sourceOutput = z.object({ count: z.number().int() });
    const inputShape = sourceInput.shape;
    const outputShape = sourceOutput.shape;
    const clonedInput = descriptorPerfectClone(sourceInput);
    const clonedOutput = descriptorPerfectClone(sourceOutput);

    const normalizedInput = withRequiredProfile(clonedInput);
    const normalizedOutput = withResolvedProfileOutput(clonedOutput);
    expect(normalizedInput).not.toBe(clonedInput);
    expect(normalizedOutput).not.toBe(clonedOutput);

    inputShape.table = z.number() as unknown as typeof inputShape.table;
    outputShape.count = z.string() as unknown as typeof outputShape.count;
    Object.defineProperty(clonedInput, "safeParse", {
      get: () => {
        throw new Error("source descriptor must never be observed");
      },
      configurable: true,
    });
    Object.defineProperty(clonedOutput, "parse", {
      value: () => ({ count: "source-spoof" }),
      configurable: true,
    });

    expect(
      normalizedInput.safeParse({ profile: "prod", table: "incident" }).success
    ).toBe(true);
    expect(
      normalizedInput.safeParse({ profile: "prod", table: 42 }).success
    ).toBe(false);
    expect(
      normalizedOutput.safeParse({ profile: "prod", count: 1 }).success
    ).toBe(true);
    expect(
      normalizedOutput.safeParse({ profile: "prod", count: "1" }).success
    ).toBe(false);

    const normalizedModule = defineServiceNowToolModule({
      runtime: "servicenow",
      definition: { ...definition, name: "sn_normalized_clone_probe" },
      inputSchema: normalizedInput,
      outputSchema: normalizedOutput,
      requirements,
      resolveAccess: (args) => ({
        args: Object.freeze(normalizedInput.parse(args)),
        requests: Object.freeze([]),
      }),
      handler: async () => ({
        content: [{ type: "text", text: "normalized" }],
        structuredContent: { count: 1 },
      }),
    });
    let registeredConfig: unknown;
    await registerServiceNowToolModules(
      {
        registerTool: vi.fn((_name: string, config: unknown) => {
          registeredConfig = config;
        }),
      } as unknown as Parameters<typeof registerServiceNowToolModules>[0],
      {} as ProfileManager,
      {} as ExecutionContextDependencies,
      [normalizedModule]
    );
    const config = registeredConfig as {
      inputSchema: z.AnyZodObject;
      outputSchema: z.AnyZodObject;
    };
    expect(
      config.inputSchema.safeParse({ profile: "prod", table: "incident" }).success
    ).toBe(true);
    expect(
      config.inputSchema.safeParse({ profile: "prod", table: 42 }).success
    ).toBe(false);
    expect(
      config.outputSchema.safeParse({ profile: "prod", count: 1 }).success
    ).toBe(true);
  });

  it("makes the full nested schema graph parse-stable before and after SDK preflight", async () => {
    const field = z.string().min(2);
    const sourceDefinition = field._def;
    const sourceChecks = sourceDefinition.checks;
    const sourceMinimumCheck = sourceChecks[0];
    const sourceUnion = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("first"), value: z.string() }),
      z.object({ kind: z.literal("second"), count: z.number() }),
    ]);
    const sourceOptionsMap = sourceUnion._def.optionsMap;
    const shadowedEntries = vi.fn(() =>
      Array.from({ length: 3_000 }, (_, index) => [
        `spoofed-${index}`,
        sourceUnion.options[0],
      ] as const)[Symbol.iterator]()
    );
    Object.defineProperty(sourceOptionsMap, "entries", {
      value: shadowedEntries,
      configurable: true,
    });
    Object.defineProperty(sourceOptionsMap, "size", {
      get: () => {
        throw new Error("shadowed size must not be observed");
      },
      configurable: true,
    });
    const sourceEnum = z.enum(["open", "closed"]);
    const normalizedInput = withRequiredProfile(
      z.object({ field, choice: sourceUnion, state: sourceEnum })
    );
    const normalizedOutput = withResolvedProfileOutput(z.object({ ok: z.boolean() }));

    const hardenedField = normalizedInput.shape.field as typeof field;
    const hardenedUnion = normalizedInput.shape.choice as typeof sourceUnion;
    const hardenedEnum = normalizedInput.shape.state as typeof sourceEnum;
    const hardenedChecks = hardenedField._def.checks;
    const hardenedMinimumCheck = hardenedChecks[0];
    const hardenedOptionsMap = hardenedUnion._def.optionsMap;
    const hardenedEnumCache = (
      hardenedEnum as unknown as { readonly _cache: Set<string> }
    )._cache;
    const originalFieldPrototype = Object.getPrototypeOf(hardenedField);

    expect(Object.isFrozen(hardenedField)).toBe(true);
    expect(Object.isFrozen(hardenedField._def)).toBe(true);
    expect(Object.isFrozen(hardenedChecks)).toBe(true);
    expect(Object.isFrozen(hardenedMinimumCheck)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(hardenedField, "_def")).toMatchObject({
      configurable: false,
      writable: false,
    });
    expect(hardenedOptionsMap).not.toBe(sourceOptionsMap);
    expect(hardenedOptionsMap).not.toBeInstanceOf(Map);
    expect(hardenedEnumCache).not.toBeInstanceOf(Set);
    expect(shadowedEntries).not.toHaveBeenCalled();

    // References retained before contract issuance are no longer parse-active.
    sourceDefinition.coerce = true;
    sourceChecks.push({ kind: "max", value: 1 });
    if (sourceMinimumCheck.kind === "min") sourceMinimumCheck.value = 100;
    sourceOptionsMap.set(
      "third",
      z.object({ kind: z.literal("third"), bypass: z.boolean() })
    );

    expect(() => {
      (hardenedField as unknown as { _def: unknown })._def = sourceDefinition;
    }).toThrow(TypeError);
    expect(() => {
      (hardenedField._def as { coerce: boolean }).coerce = true;
    }).toThrow(TypeError);
    expect(() => {
      hardenedChecks.push({ kind: "max", value: 1 });
    }).toThrow(TypeError);
    expect(() => {
      if (hardenedMinimumCheck.kind === "min") hardenedMinimumCheck.value = 100;
    }).toThrow(TypeError);
    expect(() => {
      (hardenedField as unknown as { safeParse: unknown }).safeParse = () => ({
        success: true,
      });
    }).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(hardenedField, {})).toThrow(TypeError);
    expect(() => hardenedOptionsMap.set("third", sourceUnion.options[0])).toThrow(
      /disabled/u
    );
    expect(() => hardenedOptionsMap.delete("first")).toThrow(/disabled/u);
    expect(() => hardenedEnumCache.add("spoofed")).toThrow(/disabled/u);
    expect(() => hardenedEnumCache.clear()).toThrow(/disabled/u);
    expect(() =>
      Map.prototype.set.call(
        hardenedOptionsMap,
        "third",
        sourceUnion.options[0]
      )
    ).toThrow(TypeError);
    expect(() => Set.prototype.add.call(hardenedEnumCache, "spoofed")).toThrow(
      TypeError
    );

    const sloppyAssign = Function(
      "target",
      "key",
      "value",
      "target[key] = value; return target[key];"
    ) as (target: object, key: string, value: unknown) => unknown;
    expect(sloppyAssign(hardenedField._def, "coerce", true)).toBe(false);
    expect(sloppyAssign(hardenedMinimumCheck, "value", 100)).toBe(2);
    expect(sloppyAssign(hardenedField, "safeParse", null)).toBe(
      hardenedField.safeParse
    );
    expect(Object.getPrototypeOf(hardenedField)).toBe(originalFieldPrototype);

    const validInput = {
      profile: "prod",
      field: "ok",
      choice: { kind: "first", value: "yes" },
      state: "open",
    };
    expect(normalizedInput.safeParse(validInput).success).toBe(true);
    expect(
      normalizedInput.safeParse({ ...validInput, field: 42 }).success
    ).toBe(false);
    expect(
      normalizedInput.safeParse({
        ...validInput,
        choice: { kind: "third", bypass: true },
      }).success
    ).toBe(false);

    const module = defineServiceNowToolModule({
      runtime: "servicenow",
      definition: { ...definition, name: "sn_nested_graph_probe" },
      inputSchema: normalizedInput,
      outputSchema: normalizedOutput,
      requirements,
      resolveAccess: (args) => ({
        args: Object.freeze(normalizedInput.parse(args)),
        requests: Object.freeze([]),
      }),
      handler: async () => ({
        content: [{ type: "text", text: "stable" }],
        structuredContent: { ok: true },
      }),
    });
    let registeredConfig: unknown;
    await registerServiceNowToolModules(
      {
        registerTool: vi.fn((_name: string, config: unknown) => {
          registeredConfig = config;
        }),
      } as unknown as Parameters<typeof registerServiceNowToolModules>[0],
      {} as ProfileManager,
      {} as ExecutionContextDependencies,
      [module]
    );
    const config = registeredConfig as {
      inputSchema: z.AnyZodObject;
      outputSchema: z.AnyZodObject;
    };
    const registeredField = config.inputSchema.shape.field;
    expect(registeredField).toBe(hardenedField);
    expect(() => {
      (registeredField._def as { coerce?: boolean }).coerce = true;
    }).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(registeredField, null)).toThrow(TypeError);
    expect(config.inputSchema.safeParse(validInput).success).toBe(true);
    expect(config.inputSchema.safeParse({ ...validInput, field: 42 }).success).toBe(
      false
    );
    expect(config.outputSchema.safeParse({ profile: "prod", ok: true }).success).toBe(
      true
    );
    expect(() =>
      Map.prototype.set.call(
        (config.inputSchema.shape.choice as typeof sourceUnion)._def.optionsMap,
        "third",
        sourceUnion.options[0]
      )
    ).toThrow(TypeError);
  });

  it("rejects genuine oversized collections without trusting shadowed iteration", () => {
    const oversized = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("first") }),
      z.object({ kind: z.literal("second") }),
    ]);
    const oversizedOptions = new Map<unknown, z.AnyZodObject>();
    for (let index = 0; index <= 2_048; index += 1) {
      oversizedOptions.set(index, oversized.options[0]);
    }
    oversized._def.optionsMap = oversizedOptions;

    expect(() =>
      withRequiredProfile(z.object({ choice: oversized }))
    ).toThrow(/map is too large/u);
  });

  it("rejects accessor-based invalid source shapes with zero target side effects", async () => {
    const invalidSource = z.object({ table: z.string() });
    Object.defineProperty(invalidSource.shape, "table", {
      get: () => z.string(),
      configurable: true,
    });
    expect(() => withRequiredProfile(invalidSource)).toThrow(/data fields/u);

    const targetRegister = vi.fn();
    const invalidRegistered = {
      ...fixtureModule("sn_invalid_shape_contract"),
      inputSchema: invalidSource,
    } as unknown as ToolModuleContract;
    await expect(
      registerServiceNowToolModules(
        { registerTool: targetRegister } as unknown as Parameters<
          typeof registerServiceNowToolModules
        >[0],
        {} as ProfileManager,
        {} as ExecutionContextDependencies,
        [fixtureModule("sn_valid_before_invalid_shape"), invalidRegistered]
      )
    ).rejects.toThrow(/issued contract-normalized Zod object/u);
    expect(targetRegister).not.toHaveBeenCalled();
  });

  it("rejects the exact forged ZodObject-prototype replay with no partial target registration", async () => {
    const forged = Object.create(z.ZodObject.prototype) as z.AnyZodObject;
    Object.defineProperty(forged, "_def", {
      value: {
        typeName: z.ZodFirstPartyTypeKind.ZodObject,
        unknownKeys: "strict",
        catchall: z.never(),
        shape: () => ({ profile: profileNameSchema, table: z.string() }),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(forged).toBeInstanceOf(z.ZodObject);
    expect(forged.shape.profile).toBe(profileNameSchema);
    expect(() =>
      defineServiceNowToolModule({
        runtime: "servicenow",
        definition,
        inputSchema: forged,
        outputSchema,
        requirements,
        resolveAccess: () => ({ args: {}, requests: [] }),
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/issued contract-normalized Zod object/u);

    const targetRegister = vi.fn();
    const forgedRegistered = {
      ...fixtureModule("sn_forged_schema_contract"),
      inputSchema: forged,
    } as unknown as ToolModuleContract;
    await expect(
      registerServiceNowToolModules(
        { registerTool: targetRegister } as unknown as Parameters<
          typeof registerServiceNowToolModules
        >[0],
        {} as ProfileManager,
        {} as ExecutionContextDependencies,
        [fixtureModule("sn_valid_before_forgery"), forgedRegistered]
      )
    ).rejects.toThrow(/issued contract-normalized Zod object/u);
    expect(targetRegister).not.toHaveBeenCalled();
  });

  it.each([
    ["permissions", { ...requirements, permissions: undefined }],
    ["tables", { ...requirements, tables: undefined }],
    ["APIs", { ...requirements, apis: undefined }],
    ["field policies", { ...requirements, fieldPolicies: undefined }],
    ["capabilities", { ...requirements, capabilities: undefined }],
  ])("fails fast for incomplete %s declarations", (_label, incomplete) => {
    expect(() =>
      defineServiceNowToolModule({
        runtime: "servicenow",
        definition,
        inputSchema,
        outputSchema,
        requirements: incomplete as ToolModuleRequirements,
        resolveAccess: () => ({ args: {}, requests: [] }),
        handler: async () => ({ content: [] }),
      })
    ).toThrow();
  });

  it("rejects permission/annotation conflicts and duplicate dependencies", () => {
    expect(() =>
      defineServiceNowToolModule({
        runtime: "servicenow",
        definition,
        inputSchema,
        outputSchema,
        requirements: { ...requirements, permissions: ["read", "write"] },
        resolveAccess: () => ({ args: {}, requests: [] }),
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/read-only annotation conflicts/u);

    expect(() =>
      defineServiceNowToolModule({
        runtime: "servicenow",
        definition,
        inputSchema,
        outputSchema,
        requirements: { ...requirements, apis: ["table", "table"] },
        resolveAccess: () => ({ args: {}, requests: [] }),
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/duplicate API/u);
  });

  it("preflights the entire catalog before any SDK registration side effect", async () => {
    const registerTool = vi.fn();
    const server = {
      registerTool,
    } as unknown as Parameters<typeof registerServiceNowToolModules>[0];
    const profileManager = {} as ProfileManager;
    const contextDependencies = {} as ExecutionContextDependencies;
    const module = fixtureModule();

    await expect(
      registerServiceNowToolModules(
        server,
        profileManager,
        contextDependencies,
        [module, module]
      )
    ).rejects.toThrow(/duplicate tool module name/u);
    expect(registerTool).not.toHaveBeenCalled();

    const incomplete = {
      ...module,
      requirements: { ...module.requirements, capabilities: undefined },
    } as unknown as ToolModuleContract;
    await expect(
      registerServiceNowToolModules(
        server,
        profileManager,
        contextDependencies,
        [module, incomplete]
      )
    ).rejects.toThrow();
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("registers from a complete snapshot despite immediate and target-time source mutation", async () => {
    const first = fixtureModule("sn_contract_fixture_first");
    const second = fixtureModule("sn_contract_fixture_second");
    const catalog: ToolModuleContract[] = [first, second];
    const registered: string[] = [];
    const server = {
      registerTool: vi.fn((name: string) => {
        registered.push(name);
        if (registered.length === 1) catalog[1] = first;
      }),
    } as unknown as Parameters<typeof registerServiceNowToolModules>[0];

    const registration = registerServiceNowToolModules(
      server,
      {} as ProfileManager,
      {} as ExecutionContextDependencies,
      catalog
    );
    catalog[1] = first;
    await registration;

    expect(registered).toEqual([
      "sn_contract_fixture_first",
      "sn_contract_fixture_second",
    ]);
  });

  it("rejects proxied catalogs before any target registration", async () => {
    const registerTool = vi.fn();
    const catalog = new Proxy([fixtureModule()], {});
    await expect(
      registerServiceNowToolModules(
        { registerTool } as unknown as Parameters<
          typeof registerServiceNowToolModules
        >[0],
        {} as ProfileManager,
        {} as ExecutionContextDependencies,
        catalog
      )
    ).rejects.toThrow(/catalog/u);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("declares composed aggregate and ATF tracker dependencies", () => {
    const atf = toolModules.find((module) => module.definition.name === "sn_atf");
    const naturalLanguage = toolModules.find(
      (module) => module.definition.name === "sn_nl"
    );
    expect(atf?.requirements.tables).toMatchObject({
      kind: "static",
      names: expect.arrayContaining(["sys_execution_tracker"]),
    });
    expect(naturalLanguage?.requirements.apis).toEqual(["aggregate", "table"]);
  });

  it("keeps tool modules free of provider-specific integration imports", () => {
    const directory = new URL("../src/tools/", import.meta.url);
    const forbidden = /(?:chatgpt|claude|openai|anthropic|tunnel)/iu;
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(new URL(file, directory), "utf8");
      const moduleSpecifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)]
        .map((match) => match[1])
        .join("\n");
      expect(moduleSpecifiers, file).not.toMatch(forbidden);
    }
  });

  it("validates the production catalog within a bounded startup budget", () => {
    const iterations = 2_000;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      validateToolModuleCatalog(toolModules);
    }
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    expect(iterations * toolModules.length).toBe(iterations * REGISTERED_TOOL_COUNT);
  });

  it("uses strict structured result envelopes for production modules", () => {
    expect(profileOutputSchema.parse({ profile: "secondary" })).toEqual({
      profile: "secondary",
    });
    for (const module of toolModules) {
      expect(Object.keys(module.outputSchema.shape).sort(), module.definition.name).toEqual([
        "data",
        "metadata",
        "profile",
      ]);
      expect(module.outputSchema._def.unknownKeys, module.definition.name).toBe(
        "strict"
      );
    }
  });
});
