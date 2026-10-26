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
  type AnyZodObject,
  type ToolModuleContract,
  type ToolModuleRequirements,
} from "../src/tools/index.js";
import { snapshotIssuedToolSchema } from "../src/tools/tool-module.js";

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
    expect(REGISTERED_TOOL_COUNT).toBe(24);
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
      inputSchema: AnyZodObject;
      outputSchema: AnyZodObject;
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
    const sourceInternals = field._zod;
    const sourceDefinition = field._zod.def as { coerce?: boolean; checks: unknown[] };
    const sourceChecks = sourceDefinition.checks;
    const sourceMinimumCheck = field._zod.def.checks?.[0] as z.core.$ZodCheckMinLength;
    const sourceUnion = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("first"), value: z.string() }),
      z.object({ kind: z.literal("second"), count: z.number() }),
    ]);
    const sourceUnionOptions = sourceUnion._zod.def.options as unknown[];
    // zod 4 definitions hold no Map of their own, so one is planted to prove
    // that hardening iterates collections through intrinsics, never through
    // methods a source shadowed.
    const sourceOptionsMap = new Map<unknown, unknown>([["first", sourceUnion.options[0]]]);
    Object.defineProperty(sourceUnion._zod.def, "optionsMap", {
      value: sourceOptionsMap,
      enumerable: true,
      configurable: true,
      writable: true,
    });
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
    const sourceEnumValues = sourceEnum._zod.values as Set<unknown>;
    const normalizedInput = withRequiredProfile(
      z.object({ field, choice: sourceUnion, state: sourceEnum })
    );
    const normalizedOutput = withResolvedProfileOutput(z.object({ ok: z.boolean() }));

    const hardenedField = normalizedInput.shape.field as typeof field;
    const hardenedUnion = normalizedInput.shape.choice as typeof sourceUnion;
    const hardenedEnum = normalizedInput.shape.state as typeof sourceEnum;
    const hardenedChecks = hardenedField._zod.def.checks as unknown[];
    const hardenedMinimumCheck = hardenedChecks[0] as z.core.$ZodCheckMinLength;
    const hardenedOptionsMap = (
      hardenedUnion._zod.def as unknown as { optionsMap: Map<unknown, unknown> }
    ).optionsMap;
    const hardenedEnumValues = hardenedEnum._zod.values as Set<unknown>;
    const originalFieldPrototype = Object.getPrototypeOf(hardenedField);

    // Every node is rebuilt from a contract-owned definition, so the source
    // graph shares no parse state with the issued one.
    expect(hardenedField).not.toBe(field);
    expect(hardenedMinimumCheck).not.toBe(sourceMinimumCheck);
    expect(Object.isFrozen(hardenedField)).toBe(true);
    expect(Object.isFrozen(hardenedField._zod)).toBe(true);
    expect(Object.isFrozen(hardenedField._zod.def)).toBe(true);
    expect(Object.isFrozen(hardenedChecks)).toBe(true);
    expect(Object.isFrozen(hardenedMinimumCheck)).toBe(true);
    expect(Object.isFrozen(hardenedMinimumCheck._zod.def)).toBe(true);
    expect(Object.isFrozen(hardenedUnion._zod.def.options)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(hardenedField, "_zod")).toMatchObject({
      configurable: false,
      writable: false,
    });
    expect(hardenedOptionsMap).not.toBe(sourceOptionsMap);
    expect(hardenedOptionsMap).not.toBeInstanceOf(Map);
    expect(hardenedEnumValues).not.toBe(sourceEnumValues);
    expect(hardenedEnumValues).not.toBeInstanceOf(Set);
    expect(shadowedEntries).not.toHaveBeenCalled();

    // References retained before contract issuance are no longer parse-active.
    sourceDefinition.coerce = true;
    sourceChecks.push(z.string().max(1)._zod.def.checks?.[0]);
    (sourceMinimumCheck._zod.def as { minimum: number }).minimum = 100;
    sourceEnumValues.add("spoofed");
    sourceUnionOptions.push(
      z.object({ kind: z.literal("third"), bypass: z.boolean() })
    );
    sourceOptionsMap.set(
      "third",
      z.object({ kind: z.literal("third"), bypass: z.boolean() })
    );

    expect(() => {
      (hardenedField as unknown as { _zod: unknown })._zod = sourceInternals;
    }).toThrow(TypeError);
    expect(() => {
      (hardenedField._zod.def as { coerce?: boolean }).coerce = true;
    }).toThrow(TypeError);
    expect(() => {
      hardenedChecks.push(sourceMinimumCheck);
    }).toThrow(TypeError);
    expect(() => {
      (hardenedMinimumCheck._zod.def as { minimum: number }).minimum = 100;
    }).toThrow(TypeError);
    expect(() => {
      (hardenedField._zod as { run: unknown }).run = () => ({ value: "ok", issues: [] });
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
    expect(() => hardenedEnumValues.add("spoofed")).toThrow(/disabled/u);
    expect(() => hardenedEnumValues.clear()).toThrow(/disabled/u);
    expect(() =>
      Map.prototype.set.call(
        hardenedOptionsMap,
        "third",
        sourceUnion.options[0]
      )
    ).toThrow(TypeError);
    expect(() => Set.prototype.add.call(hardenedEnumValues, "spoofed")).toThrow(
      TypeError
    );

    const sloppyAssign = Function(
      "target",
      "key",
      "value",
      "target[key] = value; return target[key];"
    ) as (target: object, key: string, value: unknown) => unknown;
    expect(sloppyAssign(hardenedField._zod.def, "coerce", true)).toBeUndefined();
    expect(sloppyAssign(hardenedMinimumCheck._zod.def, "minimum", 100)).toBe(2);
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
      normalizedInput.safeParse({ ...validInput, field: "x" }).success
    ).toBe(false);
    expect(
      normalizedInput.safeParse({ ...validInput, state: "spoofed" }).success
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
      inputSchema: AnyZodObject;
      outputSchema: AnyZodObject;
    };
    const registeredField = config.inputSchema.shape.field as typeof field;
    expect(registeredField).toBe(hardenedField);
    expect(() => {
      (registeredField._zod.def as { coerce?: boolean }).coerce = true;
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
      Set.prototype.add.call(
        (config.inputSchema.shape.state as typeof sourceEnum)._zod.values,
        "spoofed"
      )
    ).toThrow(TypeError);
  });

  it("rejects genuine oversized collections without trusting shadowed iteration", () => {
    const oversized = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("first") }),
      z.object({ kind: z.literal("second") }),
    ]);
    const oversizedOptions = new Map<unknown, AnyZodObject>();
    for (let index = 0; index <= 2_048; index += 1) {
      oversizedOptions.set(index, oversized.options[0]);
    }
    // zod 4 definitions hold no Map of their own; one is planted to reach
    // the collection bound.
    Object.defineProperty(oversized._zod.def, "optionsMap", {
      value: oversizedOptions,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() =>
      withRequiredProfile(z.object({ choice: oversized }))
    ).toThrow(/map is too large/u);
  });

  it("refuses lazy (recursive) schemas, which a frozen zod 4 graph cannot resolve", () => {
    const node = z.lazy(() => z.object({ name: z.string() }));
    expect(() => withRequiredProfile(z.object({ tree: node }))).toThrow(
      /does not support lazy/u
    );
  });

  it("freezes a bare refinement check in place and keeps enforcing it", () => {
    const refined = z.string().superRefine((value, context) => {
      if (value === "blocked") context.addIssue({ code: "custom", message: "blocked value" });
    });
    const sourceCheck = refined._zod.def.checks?.[0] as z.core.$ZodCheck;
    const issued = withRequiredProfile(z.object({ value: refined }));
    const issuedCheck = (issued.shape.value as typeof refined)._zod.def.checks?.[0];

    // Its behaviour is assigned after construction, so it is not rebuilt.
    expect(issuedCheck).toBe(sourceCheck);
    expect(Object.isFrozen(sourceCheck)).toBe(true);
    expect(Object.isFrozen(sourceCheck._zod)).toBe(true);
    expect(Object.isFrozen(sourceCheck._zod.def)).toBe(true);
    expect(() => {
      (sourceCheck._zod as { check: unknown }).check = () => {};
    }).toThrow(TypeError);
    expect(issued.safeParse({ profile: "prod", value: "fine" }).success).toBe(true);
    expect(issued.safeParse({ profile: "prod", value: "blocked" }).error?.issues).toEqual([
      expect.objectContaining({ code: "custom", message: "blocked value", path: ["value"] }),
    ]);
  });

  describe("process-wide reuse of hardened subgraphs", () => {
    // Each case builds its own source nodes: the reuse map is process-wide,
    // so sharing sources across cases would make them depend on order.
    const wide = (fields: number) =>
      z.object(
        Object.fromEntries(
          Array.from({ length: fields }, (_, index) => [`f${index}`, z.string().max(index + 1)])
        )
      );
    const nest = (inner: z.ZodType, levels: number): z.ZodType => {
      let schema = inner;
      for (let level = 0; level < levels; level += 1) schema = z.object({ inner: schema });
      return schema;
    };
    // About 13 budget nodes per field: one 450-field object fits the 10,000
    // node budget, two do not. 30 nested levels fit the depth budget, 50 do
    // not (calibrated against fresh traversals of the same shapes).
    const HALF_BUDGET_FIELDS = 450;

    it("reuses the first hardened copy of a shared source node", () => {
      const shared = wide(3);
      const first = withRequiredProfile(z.object({ a: shared }));
      const second = withRequiredProfile(z.object({ b: shared }));
      expect(second.shape.b).toBe(first.shape.a);
      expect(Object.isFrozen(first.shape.a)).toBe(true);
    });

    it("first issuance wins: mutating a source schema reaches no issued schema", () => {
      const shared = z.string().min(3);
      const minimum = shared._zod.def.checks?.[0] as z.core.$ZodCheckMinLength;
      const setMinimum = (value: number) => {
        (minimum._zod.def as { minimum: number }).minimum = value;
      };
      const first = withRequiredProfile(z.object({ a: shared }));

      // Mutated between two issuances: the source itself changes, and the
      // second issuance gets the copy made before the change.
      setMinimum(0);
      expect(shared.safeParse("ab").success).toBe(true);
      const second = withRequiredProfile(z.object({ b: shared }));
      expect(second.shape.b).toBe(first.shape.a);
      expect(first.safeParse({ profile: "p", a: "ab" }).success).toBe(false);
      expect(second.safeParse({ profile: "p", b: "ab" }).success).toBe(false);

      // Mutated after both: neither issued schema moves.
      setMinimum(100);
      expect(shared.safeParse("abcd").success).toBe(false);
      expect(first.safeParse({ profile: "p", a: "abcd" }).success).toBe(true);
      expect(second.safeParse({ profile: "p", b: "abcd" }).success).toBe(true);
    });

    it("charges reused subgraphs against the node budget of the graph reusing them", () => {
      const left = wide(HALF_BUDGET_FIELDS);
      const right = wide(HALF_BUDGET_FIELDS);
      // Each half fits on its own and is hardened, and cached, here.
      withRequiredProfile(z.object({ left }));
      withRequiredProfile(z.object({ right }));
      // Reusing both costs no rebuild, but the graph is charged for every
      // node in both, exactly as a fresh traversal would have been.
      expect(() => withRequiredProfile(z.object({ left, right }))).toThrow(
        /traversal budget exceeded/u
      );
      // The same control without reuse: fresh halves fail the same way.
      expect(() =>
        withRequiredProfile(
          z.object({ left: wide(HALF_BUDGET_FIELDS), right: wide(HALF_BUDGET_FIELDS) })
        )
      ).toThrow(/traversal budget exceeded/u);
    });

    it("counts a subgraph reused twice in one graph once, as a fresh traversal does", () => {
      const half = wide(HALF_BUDGET_FIELDS);
      const first = withRequiredProfile(z.object({ half }));
      const twice = withRequiredProfile(z.object({ one: half, two: half }));
      expect(twice.shape.one).toBe(first.shape.half);
      expect(twice.shape.two).toBe(first.shape.half);
    });

    // Metadata is attached after a node is built, so it can close a cycle:
    // the ancestor's metadata holds `value`, `value` holds the closing node,
    // and the closing node's metadata points back at `value` while `value` is
    // still being built. Recording the closing node then would leave out
    // everything `value` holds, and a later graph reusing it would be
    // charged too little.
    const metadataCycle = (hidden: z.ZodType) => {
      const value: Record<string, unknown> = {};
      const closing = z.string().meta({ value });
      value.closing = closing;
      value.hidden = hidden;
      const ancestor = z.number().meta({ value });
      return { ancestor, closing };
    };

    it("refuses a cycle closed through metadata, so no under-charged node is cached", () => {
      const parts = [metadataCycle(wide(HALF_BUDGET_FIELDS)), metadataCycle(wide(HALF_BUDGET_FIELDS))];
      for (const { ancestor } of parts) {
        expect(() => withRequiredProfile(z.object({ ancestor }))).toThrow(/contains a cycle/u);
      }
      // Each closing node reaches its hidden half through its own metadata,
      // so a graph holding both closing nodes is charged for both halves.
      expect(() =>
        withRequiredProfile(z.object({ c0: parts[0]!.closing, c1: parts[1]!.closing }))
      ).toThrow(/traversal budget exceeded/u);
      // Fresh control: the same shape, never issued before.
      const fresh = [metadataCycle(wide(HALF_BUDGET_FIELDS)), metadataCycle(wide(HALF_BUDGET_FIELDS))];
      expect(() =>
        withRequiredProfile(z.object({ c0: fresh[0]!.closing, c1: fresh[1]!.closing }))
      ).toThrow(/traversal budget exceeded/u);
    });

    it("refuses a cycle closed through metadata between two zod nodes", () => {
      const backToAncestor: Record<string, unknown> = {};
      const closing = z.string().meta(backToAncestor);
      const ancestor = z.number().meta({ closing });
      backToAncestor.ancestor = ancestor;
      expect(() => withRequiredProfile(z.object({ ancestor }))).toThrow(/contains a cycle/u);
    });

    it("refuses the depth form of a metadata cycle, as a fresh build does", () => {
      const { ancestor, closing } = metadataCycle(nest(z.string(), 30));
      expect(() => withRequiredProfile(z.object({ ancestor }))).toThrow(/contains a cycle/u);
      expect(() => withRequiredProfile(z.object({ deeper: nest(closing, 30) }))).toThrow(
        /traversal budget exceeded/u
      );
      const control = metadataCycle(nest(z.string(), 30));
      expect(() => withRequiredProfile(z.object({ deeper: nest(control.closing, 30) }))).toThrow(
        /traversal budget exceeded/u
      );
    });

    // Graph-size refusal for a reused shape: either message is a refusal, and
    // which one depends on whether the cycle or the budget is met first.
    const REFUSED = /contains a cycle|traversal budget exceeded/u;

    // X's metadata holds W and Y; W points back at X; Y's metadata holds W.
    const selfBoundValue = (hidden: z.ZodType) => {
      const value: Record<string, unknown> = {};
      const reacher = z.string().meta({ value });
      const node = z.number().meta({ value, reacher, hidden });
      value.node = node;
      return { node, reacher };
    };

    it("refuses another node reaching a value bound to its node's cycle, issued first", () => {
      const parts = [selfBoundValue(wide(HALF_BUDGET_FIELDS)), selfBoundValue(wide(HALF_BUDGET_FIELDS))];
      for (const { node } of parts) {
        expect(() => withRequiredProfile(z.object({ node }))).toThrow(/contains a cycle/u);
      }
      expect(() =>
        withRequiredProfile(z.object({ r0: parts[0]!.reacher, r1: parts[1]!.reacher }))
      ).toThrow(REFUSED);
      const fresh = [selfBoundValue(wide(HALF_BUDGET_FIELDS)), selfBoundValue(wide(HALF_BUDGET_FIELDS))];
      expect(() =>
        withRequiredProfile(z.object({ r0: fresh[0]!.reacher, r1: fresh[1]!.reacher }))
      ).toThrow(REFUSED);
    });

    it("refuses the depth form of a value bound to its node's cycle", () => {
      const { node, reacher } = selfBoundValue(nest(z.string(), 30));
      expect(() => withRequiredProfile(z.object({ node }))).toThrow(/contains a cycle/u);
      expect(() => withRequiredProfile(z.object({ deeper: nest(reacher, 30) }))).toThrow(REFUSED);
      const control = selfBoundValue(nest(z.string(), 30));
      expect(() => withRequiredProfile(z.object({ deeper: nest(control.reacher, 30) }))).toThrow(
        REFUSED
      );
    });

    it("refuses a later sibling reaching a value bound to a finished node's cycle", () => {
      const sibling = (hidden: z.ZodType) => {
        const value: Record<string, unknown> = {};
        const node = z.number().meta({ value, hidden });
        value.node = node;
        return { node, later: z.string().meta({ value }) };
      };
      const parts = [sibling(wide(HALF_BUDGET_FIELDS)), sibling(wide(HALF_BUDGET_FIELDS))];
      for (const { node, later } of parts) {
        expect(() => withRequiredProfile(z.object({ node, later }))).toThrow(/contains a cycle/u);
      }
      expect(() =>
        withRequiredProfile(z.object({ l0: parts[0]!.later, l1: parts[1]!.later }))
      ).toThrow(REFUSED);
      const fresh = [sibling(wide(HALF_BUDGET_FIELDS)), sibling(wide(HALF_BUDGET_FIELDS))];
      expect(() =>
        withRequiredProfile(z.object({ l0: fresh[0]!.later, l1: fresh[1]!.later }))
      ).toThrow(REFUSED);
    });

    it("charges a node for a shared value whose contents another node reached first", () => {
      // No cycle: X's metadata holds U and V, and V holds U, so U is reached
      // twice within X's build. Y, in the same graph, holds V. Y's record must
      // still include U and what U holds.
      const shared = (hidden: z.ZodType) => {
        const inner = { hidden };
        const outer = { inner };
        return {
          first: z.number().meta({ inner, outer }),
          second: z.string().meta({ outer }),
        };
      };
      const parts = [shared(wide(HALF_BUDGET_FIELDS)), shared(wide(HALF_BUDGET_FIELDS))];
      for (const { first, second } of parts) {
        // A legitimate DAG: accepted.
        withRequiredProfile(z.object({ first, second }));
      }
      expect(() =>
        withRequiredProfile(z.object({ s0: parts[0]!.second, s1: parts[1]!.second }))
      ).toThrow(/traversal budget exceeded/u);
      const fresh = [shared(wide(HALF_BUDGET_FIELDS)), shared(wide(HALF_BUDGET_FIELDS))];
      expect(() =>
        withRequiredProfile(z.object({ s0: fresh[0]!.second, s1: fresh[1]!.second }))
      ).toThrow(/traversal budget exceeded/u);
    });

    it("accepts legitimate shared metadata values and shared nodes, issued twice", () => {
      // A DAG through metadata: X holds W and Y, Y holds W, nothing points back.
      const value = { note: "shared" };
      const reacher = z.string().meta({ value });
      const node = z.number().meta({ value, reacher });
      expect(() => withRequiredProfile(z.object({ node }))).not.toThrow();
      expect(() => withRequiredProfile(z.object({ node, reacher }))).not.toThrow();
      // A node reached both directly and through a sibling's metadata.
      const a = z.string();
      const parent = z.object({ a, b: z.number().meta({ a }) });
      expect(() => withRequiredProfile(z.object({ parent }))).not.toThrow();
      expect(() => withRequiredProfile(z.object({ again: parent }))).not.toThrow();
    });

    it("lets a node reach itself through its own metadata and charges what it holds", () => {
      expect(() =>
        withRequiredProfile(z.object({ small: metadataCycle(wide(3)).closing }))
      ).not.toThrow();
      expect(() =>
        withRequiredProfile(z.object({ large: metadataCycle(wide(800)).closing }))
      ).toThrow(/traversal budget exceeded/u);
    });

    it("re-issues every production schema at registration within the budgets", () => {
      for (const tool of toolModules) {
        expect(() => snapshotIssuedToolSchema(tool.inputSchema, "input")).not.toThrow();
        expect(() => snapshotIssuedToolSchema(tool.outputSchema, "output")).not.toThrow();
      }
    });

    it("re-issues a graph near the node budget at registration", () => {
      // Registration re-issues each schema from its records, which can charge
      // up to about one node per field more than a fresh issue (about 7%). A
      // graph at about 85% of the node budget still re-issues; the largest
      // production graph is about 12%.
      const issued = withRequiredProfile(z.object({ near: wide(600) }));
      expect(() => snapshotIssuedToolSchema(issued, "input")).not.toThrow();
    });

    it("checks a reused subgraph's height at the depth it is reached", () => {
      const deep = nest(z.string(), 30);
      withRequiredProfile(z.object({ deep }));
      expect(() => withRequiredProfile(z.object({ deeper: nest(deep, 20) }))).toThrow(
        /traversal budget exceeded/u
      );
      // The same total depth built fresh fails the same way.
      expect(() =>
        withRequiredProfile(z.object({ deeper: nest(nest(z.string(), 30), 20) }))
      ).toThrow(/traversal budget exceeded/u);
    });
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
    // zod 4 keeps a node's state in `_zod`, and instanceof reads its traits.
    const forged = Object.create(z.ZodObject.prototype) as AnyZodObject;
    Object.defineProperty(forged, "_zod", {
      value: {
        def: {
          type: "object",
          catchall: z.never(),
          shape: { profile: profileNameSchema, table: z.string() },
        },
        constr: z.ZodObject,
        traits: new Set(["$ZodType", "ZodType", "$ZodObject", "ZodObject"]),
      },
      enumerable: false,
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

  it("declares aggregate dependencies and removes legacy ATF trackers", () => {
    const atf = toolModules.find((module) => module.definition.name === "sn_atf");
    const naturalLanguage = toolModules.find(
      (module) => module.definition.name === "sn_nl"
    );
    expect(atf?.requirements.tables).toMatchObject({
      kind: "static",
      names: expect.not.arrayContaining(["sys_execution_tracker"]),
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
      expect(
        module.outputSchema._zod.def.catchall?._zod.def.type,
        module.definition.name
      ).toBe("never");
    }
  });
});
