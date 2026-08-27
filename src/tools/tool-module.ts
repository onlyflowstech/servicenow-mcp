/**
 * Provider-neutral contract for one ServiceNow MCP tool module.
 *
 * Registration consumes only values created by this contract: a shared
 * profile-bearing input schema, a profile-bearing structured-output schema,
 * complete security/dependency declarations, an access preflight, and a
 * handler whose runtime services contain no AI-client or transport objects.
 *
 * @module tools/tool-module
 */

import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { types as nodeUtilTypes } from "node:util";
import { z } from "zod";

import type { ServiceNowOperations } from "../client.js";
import type { ServiceNowConfig } from "../config.js";
import { ENCODED_QUERY_MIGRATION_MESSAGE } from "../encoded-query-policy.js";
import type {
  ExecutionContext,
  ResolvedEffectivePolicyReference,
} from "../execution-context.js";
import type { ToolTableAccessResolution } from "../tool-table-access.js";

/** Every discovery hint is intentional instead of relying on SDK defaults. */
export type RequiredToolAnnotations = Required<ToolAnnotations>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly annotations: RequiredToolAnnotations;
}

/**
 * Required on every published tool. Trimming makes whitespace-only selectors
 * invalid and ensures profile lookup uses the exact value clients discover.
 */
export const profileNameSchema = z
  .string()
  .trim()
  .min(1, "profile must not be empty")
  .max(128, "profile must not exceed 128 characters")
  .describe("Configured ServiceNow profile name (required; no default fallback).");

interface IssuedSchemaSnapshot {
  readonly definition: z.ZodObjectDef;
  readonly shape: Readonly<Record<string, z.ZodTypeAny>>;
  readonly parse: z.AnyZodObject["parse"];
  readonly safeParse: z.AnyZodObject["safeParse"];
  readonly unknownKeys: "strip" | "strict";
}

const ISSUED_INPUT_SCHEMAS = new WeakSet<object>();
const ISSUED_OUTPUT_SCHEMAS = new WeakSet<object>();
const ISSUED_SCHEMA_SNAPSHOTS = new WeakMap<object, IssuedSchemaSnapshot>();
const HARDENED_SCHEMA_NODES = new WeakSet<object>();
const MAX_TOOL_SCHEMA_FIELDS = 128;
const MAX_SCHEMA_GRAPH_DEPTH = 128;
const MAX_SCHEMA_GRAPH_NODES = 10_000;
const MAX_SCHEMA_GRAPH_OWN_KEYS = 50_000;
const MAX_SCHEMA_CONTAINER_KEYS = 2_048;
const INTRINSIC_MAP_SIZE = Object.getOwnPropertyDescriptor(
  Map.prototype,
  "size"
)?.get;
const INTRINSIC_MAP_ENTRIES = Map.prototype.entries;
const INTRINSIC_MAP_ITERATOR_NEXT = Object.getPrototypeOf(
  new Map().entries()
).next as () => IteratorResult<[unknown, unknown]>;
const INTRINSIC_SET_SIZE = Object.getOwnPropertyDescriptor(
  Set.prototype,
  "size"
)?.get;
const INTRINSIC_SET_VALUES = Set.prototype.values;
const INTRINSIC_SET_ITERATOR_NEXT = Object.getPrototypeOf(
  new Set().values()
).next as () => IteratorResult<unknown>;

interface SchemaGraphState {
  readonly seen: WeakMap<object, unknown>;
  depth: number;
  nodes: number;
  ownKeys: number;
}

/** Compose tool-local fields with the exact shared profile selector. */
export function withRequiredProfile<TSchema extends z.AnyZodObject>(
  toolSchema: TSchema
) {
  const source = snapshotUntrustedObjectSchema(toolSchema, "tool-local input schema");
  const normalized = z.object({
    ...source.shape,
    profile: profileNameSchema,
  });
  const composed =
    source.unknownKeys === "strict"
      ? normalized.strict(ENCODED_QUERY_MIGRATION_MESSAGE)
      : normalized.strip();
  return issueSchema(composed, "input") as ReturnType<TSchema["extend"]>;
}

/** Compose module output fields with the coordinator-owned profile envelope. */
export function withResolvedProfileOutput<TSchema extends z.AnyZodObject>(
  outputSchema: TSchema
) {
  const source = snapshotUntrustedObjectSchema(
    outputSchema,
    "tool-local output schema"
  );
  const normalized = z
    .object({
      ...source.shape,
      profile: profileNameSchema,
    })
    .strict();
  return issueSchema(normalized, "output") as ReturnType<TSchema["extend"]>;
}

/** Base output envelope used until a module declares additional structured data. */
export const profileOutputSchema = withResolvedProfileOutput(z.object({}));

export type ToolPermission = "read" | "write";
export type ToolFieldPolicy = "read" | "write";
export type ServiceNowApiFamily = "aggregate" | "atf" | "attachment" | "table";

export type ToolTableDependencies =
  | { readonly kind: "none" }
  | { readonly kind: "static"; readonly names: readonly string[] }
  | {
      readonly kind: "dynamic";
      /** Fixed tables used in addition to caller/resolver-selected tables. */
      readonly names: readonly string[];
      readonly description: string;
    };

/** Complete, reviewable security and platform-dependency declaration. */
export interface ToolModuleRequirements {
  readonly permissions: readonly ToolPermission[];
  readonly tables: ToolTableDependencies;
  readonly apis: readonly ServiceNowApiFamily[];
  readonly fieldPolicies: readonly ToolFieldPolicy[];
  readonly capabilities: readonly string[];
}

/** Narrow non-secret settings available to a ServiceNow tool handler. */
export type ServiceNowToolSettings = Readonly<
  Pick<ServiceNowConfig, "displayValue" | "instance" | "relDepth">
>;

export type ToolModuleLogLevel = "debug" | "info" | "warn";

/** Bounded provider-neutral logging port; implementations own redaction/sinks. */
export interface ToolModuleLogger {
  write(entry: {
    readonly level: ToolModuleLogLevel;
    readonly event: string;
    readonly correlationId: string;
    readonly tool: string;
  }): void;
}

export const SILENT_TOOL_MODULE_LOGGER: ToolModuleLogger = Object.freeze({
  write(): void {},
});

interface CommonToolHandlerServices {
  readonly context: ExecutionContext;
  readonly policy: ResolvedEffectivePolicyReference;
  readonly logger: ToolModuleLogger;
}

/** Services for modules permitted to call profile-resolved ServiceNow operations. */
export interface ServiceNowToolHandlerServices
  extends CommonToolHandlerServices {
  readonly serviceNow: ServiceNowOperations;
  readonly settings: ServiceNowToolSettings;
}

/**
 * Services for a context-only module such as sn_profile. No credentials,
 * operation facade, client, or mutable configuration can cross this boundary.
 */
export interface ContextOnlyToolHandlerServices
  extends CommonToolHandlerServices {
  readonly profileMetadata: {
    readonly authType: "apikey" | "basic" | "oauth";
    readonly instance: string;
  };
}

type ToolAccessResolver = (
  candidateArgs: unknown,
  policy: ResolvedEffectivePolicyReference
) => ToolTableAccessResolution;

interface ToolModuleContractBase {
  readonly definition: ToolDefinition;
  readonly inputSchema: z.AnyZodObject;
  readonly outputSchema: z.AnyZodObject;
  readonly requirements: ToolModuleRequirements;
  readonly resolveAccess: ToolAccessResolver;
}

export interface ServiceNowToolModuleContract extends ToolModuleContractBase {
  readonly runtime: "servicenow";
  readonly invoke: (
    candidateArgs: unknown,
    services: ServiceNowToolHandlerServices
  ) => Promise<CallToolResult>;
}

export interface ContextOnlyToolModuleContract extends ToolModuleContractBase {
  readonly runtime: "context-only";
  readonly invoke: (
    candidateArgs: unknown,
    services: ContextOnlyToolHandlerServices
  ) => Promise<CallToolResult>;
}

export type ToolModuleContract =
  | ServiceNowToolModuleContract
  | ContextOnlyToolModuleContract;

const ISSUED_TOOL_MODULES = new WeakSet<object>();
const MAX_TOOL_MODULES = 128;

interface UntrustedObjectSchemaSnapshot {
  readonly shape: Readonly<Record<string, z.ZodTypeAny>>;
  readonly unknownKeys: "strip" | "strict";
}

/**
 * Treat a caller-provided ZodObject only as an untrusted shape container.
 * No source methods, bound functions, descriptors, or object identity are
 * retained in the normalized contract schema.
 */
function snapshotUntrustedObjectSchema(
  candidate: unknown,
  label: string
): UntrustedObjectSchemaSnapshot {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    throw new TypeError(`${label} must provide a non-proxy object shape`);
  }
  const definitionDescriptor = Object.getOwnPropertyDescriptor(candidate, "_def");
  if (!definitionDescriptor || !("value" in definitionDescriptor)) {
    throw new TypeError(`${label} definition must be a data property`);
  }
  const definition = definitionDescriptor.value;
  if (
    typeof definition !== "object" ||
    definition === null ||
    nodeUtilTypes.isProxy(definition) ||
    Object.getPrototypeOf(definition) !== Object.prototype
  ) {
    throw new TypeError(`${label} definition must be a plain data object`);
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(definition, "typeName");
  const shapeDescriptor = Object.getOwnPropertyDescriptor(definition, "shape");
  const unknownKeysDescriptor = Object.getOwnPropertyDescriptor(
    definition,
    "unknownKeys"
  );
  const catchallDescriptor = Object.getOwnPropertyDescriptor(definition, "catchall");
  if (
    !typeDescriptor ||
    !("value" in typeDescriptor) ||
    typeDescriptor.value !== z.ZodFirstPartyTypeKind.ZodObject ||
    !shapeDescriptor ||
    !("value" in shapeDescriptor) ||
    typeof shapeDescriptor.value !== "function" ||
    !unknownKeysDescriptor ||
    !("value" in unknownKeysDescriptor) ||
    (unknownKeysDescriptor.value !== "strip" &&
      unknownKeysDescriptor.value !== "strict") ||
    !catchallDescriptor ||
    !("value" in catchallDescriptor) ||
    !(catchallDescriptor.value instanceof z.ZodNever) ||
    nodeUtilTypes.isProxy(catchallDescriptor.value)
  ) {
    throw new TypeError(`${label} definition is unsupported`);
  }

  let shapeCandidate: unknown;
  try {
    shapeCandidate = Reflect.apply(shapeDescriptor.value, undefined, []);
  } catch {
    throw new TypeError(`${label} shape could not be materialized`);
  }
  if (
    typeof shapeCandidate !== "object" ||
    shapeCandidate === null ||
    Array.isArray(shapeCandidate) ||
    nodeUtilTypes.isProxy(shapeCandidate) ||
    (Object.getPrototypeOf(shapeCandidate) !== Object.prototype &&
      Object.getPrototypeOf(shapeCandidate) !== null)
  ) {
    throw new TypeError(`${label} shape must be a plain data object`);
  }
  const keys = Reflect.ownKeys(shapeCandidate);
  if (keys.length > MAX_TOOL_SCHEMA_FIELDS) {
    throw new TypeError(`${label} has too many fields`);
  }
  const shape: Record<string, z.ZodTypeAny> = Object.create(null);
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      !/^[a-z][a-z0-9_]{0,79}$/u.test(key)
    ) {
      throw new TypeError(`${label} contains an invalid field name`);
    }
    if (key === "profile") {
      throw new TypeError(`${label} must not redefine profile`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(shapeCandidate, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${label} shape must contain only data fields`);
    }
    const field = descriptor.value;
    if (
      typeof field !== "object" ||
      field === null ||
      nodeUtilTypes.isProxy(field)
    ) {
      throw new TypeError(`${label} contains an invalid field schema`);
    }
    shape[key] = field as z.ZodTypeAny;
  }

  const shapeSnapshot = Object.freeze({ ...shape });
  try {
    const probe = z.object({ ...shapeSnapshot }).safeParse(Object.create(null));
    if (typeof probe.success !== "boolean") {
      throw new TypeError("invalid parse result");
    }
  } catch {
    throw new TypeError(`${label} fields could not be safely validated`);
  }
  return Object.freeze({
    shape: shapeSnapshot,
    unknownKeys: unknownKeysDescriptor.value,
  });
}

function issueSchema<TSchema extends z.AnyZodObject>(
  schema: TSchema,
  kind: "input" | "output"
): TSchema {
  hardenSchemaGraph(schema);
  const shape = Object.freeze({ ...schema.shape });
  const snapshot = Object.freeze({
    definition: schema._def,
    shape,
    parse: schema.parse,
    safeParse: schema.safeParse,
    unknownKeys: schema._def.unknownKeys as "strip" | "strict",
  });
  ISSUED_SCHEMA_SNAPSHOTS.set(
    schema,
    snapshot
  );
  (kind === "input" ? ISSUED_INPUT_SCHEMAS : ISSUED_OUTPUT_SCHEMAS).add(schema);
  return schema;
}

function issuedSchemaSnapshot(
  schema: z.AnyZodObject,
  kind: "input" | "output"
): IssuedSchemaSnapshot {
  const issued =
    kind === "input" ? ISSUED_INPUT_SCHEMAS : ISSUED_OUTPUT_SCHEMAS;
  const snapshot = ISSUED_SCHEMA_SNAPSHOTS.get(schema);
  if (
    nodeUtilTypes.isProxy(schema) ||
    !issued.has(schema) ||
    !snapshot ||
    schema._def !== snapshot.definition ||
    schema.parse !== snapshot.parse ||
    schema.safeParse !== snapshot.safeParse
  ) {
    throw new TypeError(`tool ${kind} schema is not an issued contract-normalized schema`);
  }
  const currentShape = schema.shape;
  const expectedKeys = Object.keys(snapshot.shape);
  const currentKeys = Object.keys(currentShape);
  if (
    currentKeys.length !== expectedKeys.length ||
    expectedKeys.some(
      (key, index) =>
        currentKeys[index] !== key || currentShape[key] !== snapshot.shape[key]
    )
  ) {
    throw new TypeError(`tool ${kind} schema changed after factory issuance`);
  }
  return snapshot;
}

/** Clone an issued top-level schema so later source-catalog mutation is inert. */
export function snapshotIssuedToolSchema(
  schema: z.AnyZodObject,
  kind: "input" | "output"
): z.AnyZodObject {
  const snapshot = issuedSchemaSnapshot(schema, kind);
  const normalized = z.object({ ...snapshot.shape });
  const cloned = snapshot.unknownKeys === "strict"
    ? normalized.strict(
        kind === "input" ? ENCODED_QUERY_MIGRATION_MESSAGE : undefined
      )
    : normalized.strip();
  hardenSchemaGraph(cloned);
  return cloned;
}

/**
 * Make every parse-relevant value reachable from a normalized schema stable.
 * Zod definitions are replaced with contract-owned copies before the schema
 * node is frozen, so references to an earlier definition become inert. The
 * traversal is deliberately bounded and rejects accessors, proxies, and
 * mutable exotic containers rather than attempting to execute them.
 */
function hardenSchemaGraph(schema: z.ZodTypeAny): void {
  const state: SchemaGraphState = {
    seen: new WeakMap<object, unknown>(),
    depth: 0,
    nodes: 0,
    ownKeys: 0,
  };
  hardenZodSchemaNode(schema, state);
}

function hardenZodSchemaNode<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  state: SchemaGraphState
): TSchema {
  if (nodeUtilTypes.isProxy(schema)) {
    throw new TypeError("tool schema graph must not contain a Proxy");
  }
  if (HARDENED_SCHEMA_NODES.has(schema)) return schema;
  const seen = state.seen.get(schema);
  if (seen) return seen as TSchema;
  enterSchemaGraphValue(state, schema);
  state.seen.set(schema, schema);

  const definitionDescriptor = Object.getOwnPropertyDescriptor(schema, "_def");
  if (
    !definitionDescriptor ||
    !("value" in definitionDescriptor) ||
    (!definitionDescriptor.configurable && !definitionDescriptor.writable)
  ) {
    leaveSchemaGraphValue(state);
    throw new TypeError("tool schema graph contains an immutable foreign definition");
  }

  try {
    const definition = cloneSchemaDefinition(
      schema,
      definitionDescriptor.value,
      state
    );
    Object.defineProperty(schema, "_def", {
      value: definition,
      enumerable: definitionDescriptor.enumerable,
      writable: false,
      configurable: false,
    });

    initializeZodParseCaches(schema);
    hardenSchemaOwnProperties(schema, state);
    shadowZodPrototypeBehavior(schema);
    Object.freeze(schema);
    HARDENED_SCHEMA_NODES.add(schema);
    return schema;
  } catch (error) {
    throw error instanceof TypeError
      ? error
      : new TypeError("tool schema graph could not be hardened");
  } finally {
    leaveSchemaGraphValue(state);
  }
}

function cloneSchemaDefinition(
  schema: z.ZodTypeAny,
  candidate: unknown,
  state: SchemaGraphState
): Readonly<Record<PropertyKey, unknown>> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("tool schema graph definitions must be plain data objects");
  }
  const existing = state.seen.get(candidate);
  if (existing) return existing as Readonly<Record<PropertyKey, unknown>>;
  enterSchemaGraphValue(state, candidate);
  const descriptors = boundedDataDescriptors(candidate, state, "definition");
  const clone: Record<PropertyKey, unknown> = Object.create(
    Object.getPrototypeOf(candidate)
  ) as Record<PropertyKey, unknown>;
  state.seen.set(candidate, clone);

  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key] as PropertyDescriptor;
      let value = descriptor.value;
      if (schema instanceof z.ZodObject && key === "shape") {
        if (typeof value !== "function") {
          throw new TypeError("tool schema graph has an invalid object shape");
        }
        const shape = materializeZodShape(value, state);
        value = Object.freeze(() => shape);
      } else if (schema instanceof z.ZodLazy && key === "getter") {
        if (typeof value !== "function") {
          throw new TypeError("tool schema graph has an invalid lazy getter");
        }
        const lazyTarget = Reflect.apply(value, undefined, []) as unknown;
        if (!isZodSchemaNode(lazyTarget)) {
          throw new TypeError("tool schema graph lazy getter returned an invalid schema");
        }
        const stableTarget = hardenZodSchemaNode(lazyTarget, state);
        value = Object.freeze(() => stableTarget);
      } else {
        value = cloneAndHardenGraphValue(value, state);
      }
      Object.defineProperty(clone, key, immutableDataDescriptor(descriptor, value));
    }
    return Object.freeze(clone);
  } finally {
    leaveSchemaGraphValue(state);
  }
}

function materializeZodShape(
  shapeFactory: (...args: never[]) => unknown,
  state: SchemaGraphState
): Readonly<Record<string, z.ZodTypeAny>> {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(shapeFactory, undefined, []);
  } catch {
    throw new TypeError("tool schema graph object shape could not be materialized");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    nodeUtilTypes.isProxy(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("tool schema graph object shape must be a plain data object");
  }
  enterSchemaGraphValue(state, candidate);
  const descriptors = boundedDataDescriptors(candidate, state, "object shape");
  const shape: Record<string, z.ZodTypeAny> = Object.create(null) as Record<
    string,
    z.ZodTypeAny
  >;
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw new TypeError("tool schema graph object shape has a symbol field");
      }
      const field = (descriptors[key] as PropertyDescriptor).value as unknown;
      if (!isZodSchemaNode(field)) {
        throw new TypeError("tool schema graph object shape has an invalid field");
      }
      shape[key] = hardenZodSchemaNode(field, state);
    }
    return Object.freeze({ ...shape });
  } finally {
    leaveSchemaGraphValue(state);
  }
}

function initializeZodParseCaches(schema: z.ZodTypeAny): void {
  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape();
    Object.defineProperty(schema, "_cached", {
      value: { shape, keys: Object.keys(shape) },
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return;
  }
  if (schema instanceof z.ZodEnum) {
    Object.defineProperty(schema, "_cache", {
      value: new Set(schema._def.values),
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return;
  }
  if (schema instanceof z.ZodNativeEnum) {
    const values = schema._def.values as Record<string, string | number>;
    const validValues = Object.keys(values)
      .filter((key) => typeof values[String(values[key])] !== "number")
      .map((key) => values[key]);
    Object.defineProperty(schema, "_cache", {
      value: new Set(validValues),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

function hardenSchemaOwnProperties(
  schema: z.ZodTypeAny,
  state: SchemaGraphState
): void {
  const descriptors = boundedDataDescriptors(schema, state, "schema node");
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "_def") continue;
    const descriptor = descriptors[key] as PropertyDescriptor;
    const value = cloneAndHardenGraphValue(descriptor.value, state);
    if (
      !descriptor.configurable &&
      !descriptor.writable &&
      value !== descriptor.value
    ) {
      throw new TypeError("tool schema graph contains immutable foreign state");
    }
    Object.defineProperty(schema, key, immutableDataDescriptor(descriptor, value));
  }
}

/** Shadow parse-relevant prototype behavior before freezing the node. */
function shadowZodPrototypeBehavior(schema: z.ZodTypeAny): void {
  let prototype = Object.getPrototypeOf(schema) as object | null;
  let levels = 0;
  while (prototype && prototype !== Object.prototype) {
    levels += 1;
    if (levels > 16 || nodeUtilTypes.isProxy(prototype)) {
      throw new TypeError("tool schema graph has an unsupported prototype chain");
    }
    for (const key of Reflect.ownKeys(prototype)) {
      if (key === "constructor" || Object.hasOwn(schema, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor) continue;
      if ("value" in descriptor) {
        if (typeof descriptor.value !== "function") continue;
        Object.freeze(descriptor.value);
        Object.defineProperty(schema, key, {
          value: descriptor.value,
          enumerable: descriptor.enumerable,
          writable: false,
          configurable: false,
        });
      } else {
        if (descriptor.get) Object.freeze(descriptor.get);
        if (descriptor.set) Object.freeze(descriptor.set);
        Object.defineProperty(schema, key, {
          get: descriptor.get,
          set: descriptor.set,
          enumerable: descriptor.enumerable,
          configurable: false,
        });
      }
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
}

function cloneAndHardenGraphValue(
  value: unknown,
  state: SchemaGraphState
): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  if (nodeUtilTypes.isProxy(value)) {
    throw new TypeError("tool schema graph must not contain a Proxy");
  }
  if (isZodSchemaNode(value)) return hardenZodSchemaNode(value, state);
  const existing = state.seen.get(value);
  if (existing) return existing;
  if (typeof value === "function") {
    Object.freeze(value);
    state.seen.set(value, value);
    return value;
  }
  if (Array.isArray(value)) return cloneAndFreezeArray(value, state);
  const mapSize = intrinsicMapSize(value);
  if (mapSize !== undefined) return cloneAndFreezeMap(value, mapSize, state);
  const setSize = intrinsicSetSize(value);
  if (setSize !== undefined) return cloneAndFreezeSet(value, setSize, state);
  if (
    value instanceof RegExp &&
    Object.getPrototypeOf(value) === RegExp.prototype
  ) {
    if (value.global || value.sticky) {
      throw new TypeError("tool schema graph does not allow stateful regular expressions");
    }
    enterSchemaGraphValue(state, value);
    try {
      const clone = new RegExp(value.source, value.flags);
      state.seen.set(value, clone);
      // Zod writes lastIndex before every regex test, even for non-stateful
      // expressions. Keep only that behavior-irrelevant slot writable while
      // disabling the mutator and pinning all parse methods/prototype state.
      Object.defineProperties(clone, {
        compile: immutableCollectionMethod("RegExp.compile"),
        test: immutableBoundMethod(RegExp.prototype.test, clone),
        exec: immutableBoundMethod(RegExp.prototype.exec, clone),
      });
      Object.preventExtensions(clone);
      return clone;
    } finally {
      leaveSchemaGraphValue(state);
    }
  }
  if (
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null
  ) {
    return cloneAndFreezePlainObject(value, state);
  }
  throw new TypeError("tool schema graph contains an unsupported mutable container");
}

function cloneAndFreezeArray(
  value: readonly unknown[],
  state: SchemaGraphState
): readonly unknown[] {
  enterSchemaGraphValue(state, value);
  const descriptors = boundedDataDescriptors(value, state, "array");
  if (value.length > MAX_SCHEMA_CONTAINER_KEYS) {
    leaveSchemaGraphValue(state);
    throw new TypeError("tool schema graph array is too large");
  }
  const clone: unknown[] = [];
  state.seen.set(value, clone);
  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)] as
        | PropertyDescriptor
        | undefined;
      if (!descriptor) {
        throw new TypeError("tool schema graph arrays must be dense");
      }
      clone.push(cloneAndHardenGraphValue(descriptor.value, state));
    }
    const allowedKeys = new Set<PropertyKey>([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    if (Reflect.ownKeys(descriptors).some((key) => !allowedKeys.has(key))) {
      throw new TypeError("tool schema graph arrays must not have custom properties");
    }
    return Object.freeze(clone);
  } finally {
    leaveSchemaGraphValue(state);
  }
}

function cloneAndFreezePlainObject(
  value: object,
  state: SchemaGraphState
): Readonly<Record<PropertyKey, unknown>> {
  enterSchemaGraphValue(state, value);
  const descriptors = boundedDataDescriptors(value, state, "plain object");
  const clone: Record<PropertyKey, unknown> = Object.create(
    Object.getPrototypeOf(value)
  ) as Record<PropertyKey, unknown>;
  state.seen.set(value, clone);
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key] as PropertyDescriptor;
      Object.defineProperty(
        clone,
        key,
        immutableDataDescriptor(
          descriptor,
          cloneAndHardenGraphValue(descriptor.value, state)
        )
      );
    }
    return Object.freeze(clone);
  } finally {
    leaveSchemaGraphValue(state);
  }
}

function cloneAndFreezeMap(
  value: object,
  initialSize: number,
  state: SchemaGraphState
): ReadonlyMap<unknown, unknown> {
  enterSchemaGraphValue(state, value);
  if (initialSize > MAX_SCHEMA_CONTAINER_KEYS) {
    leaveSchemaGraphValue(state);
    throw new TypeError("tool schema graph map is too large");
  }
  const rawEntries = intrinsicMapEntries(value, initialSize);
  const holder: {
    entries: readonly (readonly [unknown, unknown])[];
  } = { entries: Object.freeze([]) };
  const facade = immutableMapFacade(holder, initialSize);
  state.seen.set(value, facade);
  try {
    holder.entries = Object.freeze(
      rawEntries.map(([key, entry]) =>
        Object.freeze([
          cloneAndHardenGraphValue(key, state),
          cloneAndHardenGraphValue(entry, state),
        ] as const)
      )
    );
    Object.freeze(holder);
    return facade;
  } finally {
    leaveSchemaGraphValue(state);
  }
}

function cloneAndFreezeSet(
  value: object,
  initialSize: number,
  state: SchemaGraphState
): ReadonlySet<unknown> {
  enterSchemaGraphValue(state, value);
  if (initialSize > MAX_SCHEMA_CONTAINER_KEYS) {
    leaveSchemaGraphValue(state);
    throw new TypeError("tool schema graph set is too large");
  }
  const rawValues = intrinsicSetValues(value, initialSize);
  const holder: { values: readonly unknown[] } = {
    values: Object.freeze([]),
  };
  const facade = immutableSetFacade(holder, initialSize);
  state.seen.set(value, facade);
  try {
    holder.values = Object.freeze(
      rawValues.map((entry) => cloneAndHardenGraphValue(entry, state))
    );
    Object.freeze(holder);
    return facade;
  } finally {
    leaveSchemaGraphValue(state);
  }
}

function intrinsicMapSize(value: object): number | undefined {
  if (!INTRINSIC_MAP_SIZE) return undefined;
  try {
    const size = Reflect.apply(INTRINSIC_MAP_SIZE, value, []) as unknown;
    return Number.isSafeInteger(size) && (size as number) >= 0
      ? (size as number)
      : undefined;
  } catch {
    return undefined;
  }
}

function intrinsicSetSize(value: object): number | undefined {
  if (!INTRINSIC_SET_SIZE) return undefined;
  try {
    const size = Reflect.apply(INTRINSIC_SET_SIZE, value, []) as unknown;
    return Number.isSafeInteger(size) && (size as number) >= 0
      ? (size as number)
      : undefined;
  } catch {
    return undefined;
  }
}

function intrinsicMapEntries(
  value: object,
  initialSize: number
): readonly (readonly [unknown, unknown])[] {
  const iterator = Reflect.apply(INTRINSIC_MAP_ENTRIES, value, []) as object;
  const entries: (readonly [unknown, unknown])[] = [];
  for (;;) {
    const step = Reflect.apply(INTRINSIC_MAP_ITERATOR_NEXT, iterator, []);
    if (step.done) break;
    if (entries.length >= MAX_SCHEMA_CONTAINER_KEYS) {
      throw new TypeError("tool schema graph map iteration exceeded its bound");
    }
    if (!Array.isArray(step.value) || step.value.length !== 2) {
      throw new TypeError("tool schema graph map iterator returned an invalid entry");
    }
    entries.push(Object.freeze([step.value[0], step.value[1]] as const));
  }
  if (entries.length !== initialSize || intrinsicMapSize(value) !== initialSize) {
    throw new TypeError("tool schema graph map changed during traversal");
  }
  return Object.freeze(entries);
}

function intrinsicSetValues(
  value: object,
  initialSize: number
): readonly unknown[] {
  const iterator = Reflect.apply(INTRINSIC_SET_VALUES, value, []) as object;
  const values: unknown[] = [];
  for (;;) {
    const step = Reflect.apply(INTRINSIC_SET_ITERATOR_NEXT, iterator, []);
    if (step.done) break;
    if (values.length >= MAX_SCHEMA_CONTAINER_KEYS) {
      throw new TypeError("tool schema graph set iteration exceeded its bound");
    }
    values.push(step.value);
  }
  if (values.length !== initialSize || intrinsicSetSize(value) !== initialSize) {
    throw new TypeError("tool schema graph set changed during traversal");
  }
  return Object.freeze(values);
}

function immutableMapFacade(
  holder: { readonly entries: readonly (readonly [unknown, unknown])[] },
  size: number
): ReadonlyMap<unknown, unknown> {
  const facade = Object.create(null) as Record<PropertyKey, unknown>;
  const get = Object.freeze((candidate: unknown): unknown => {
    for (const [key, value] of holder.entries) {
      if (sameValueZero(key, candidate)) return value;
    }
    return undefined;
  });
  const has = Object.freeze((candidate: unknown): boolean =>
    holder.entries.some(([key]) => sameValueZero(key, candidate))
  );
  const entries = Object.freeze(() => immutableIterator(holder.entries));
  const keys = Object.freeze(() =>
    immutableIterator(holder.entries.map(([key]) => key))
  );
  const values = Object.freeze(() =>
    immutableIterator(holder.entries.map(([, value]) => value))
  );
  const forEach = Object.freeze(
    (
      callback: (value: unknown, key: unknown, map: ReadonlyMap<unknown, unknown>) => void,
      thisArg?: unknown
    ): void => {
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      for (const [key, value] of holder.entries) {
        Reflect.apply(callback, thisArg, [value, key, facade]);
      }
    }
  );
  Object.defineProperties(facade, {
    size: immutableValueDescriptor(size),
    get: immutableValueDescriptor(get),
    has: immutableValueDescriptor(has),
    entries: immutableValueDescriptor(entries),
    keys: immutableValueDescriptor(keys),
    values: immutableValueDescriptor(values),
    forEach: immutableValueDescriptor(forEach),
    set: immutableCollectionMethod("Map.set"),
    delete: immutableCollectionMethod("Map.delete"),
    clear: immutableCollectionMethod("Map.clear"),
    [Symbol.iterator]: immutableValueDescriptor(entries),
  });
  return Object.freeze(facade) as unknown as ReadonlyMap<unknown, unknown>;
}

function immutableSetFacade(
  holder: { readonly values: readonly unknown[] },
  size: number
): ReadonlySet<unknown> {
  const facade = Object.create(null) as Record<PropertyKey, unknown>;
  const has = Object.freeze((candidate: unknown): boolean =>
    holder.values.some((value) => sameValueZero(value, candidate))
  );
  const values = Object.freeze(() => immutableIterator(holder.values));
  const entries = Object.freeze(() =>
    immutableIterator(
      holder.values.map((value) => Object.freeze([value, value] as const))
    )
  );
  const forEach = Object.freeze(
    (
      callback: (value: unknown, key: unknown, set: ReadonlySet<unknown>) => void,
      thisArg?: unknown
    ): void => {
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      for (const value of holder.values) {
        Reflect.apply(callback, thisArg, [value, value, facade]);
      }
    }
  );
  Object.defineProperties(facade, {
    size: immutableValueDescriptor(size),
    has: immutableValueDescriptor(has),
    entries: immutableValueDescriptor(entries),
    keys: immutableValueDescriptor(values),
    values: immutableValueDescriptor(values),
    forEach: immutableValueDescriptor(forEach),
    add: immutableCollectionMethod("Set.add"),
    delete: immutableCollectionMethod("Set.delete"),
    clear: immutableCollectionMethod("Set.clear"),
    [Symbol.iterator]: immutableValueDescriptor(values),
  });
  return Object.freeze(facade) as unknown as ReadonlySet<unknown>;
}

function immutableIterator<T>(values: readonly T[]): IterableIterator<T> {
  let index = 0;
  const iterator = Object.create(null) as Record<PropertyKey, unknown>;
  const next = Object.freeze((): IteratorResult<T> =>
    index < values.length
      ? { done: false, value: values[index++] as T }
      : { done: true, value: undefined }
  );
  const self = Object.freeze(() => iterator as unknown as IterableIterator<T>);
  Object.defineProperties(iterator, {
    next: immutableValueDescriptor(next),
    [Symbol.iterator]: immutableValueDescriptor(self),
  });
  return Object.freeze(iterator) as unknown as IterableIterator<T>;
}

function sameValueZero(left: unknown, right: unknown): boolean {
  return left === right || (left !== left && right !== right);
}

function immutableCollectionMethod(name: string): PropertyDescriptor {
  const method = Object.freeze((): never => {
    throw new TypeError(`${name} is disabled on a hardened tool schema`);
  });
  return {
    value: method,
    enumerable: false,
    writable: false,
    configurable: false,
  };
}

function immutableValueDescriptor(value: unknown): PropertyDescriptor {
  return {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  };
}

function immutableBoundMethod<T extends (...args: never[]) => unknown>(
  method: T,
  receiver: object
): PropertyDescriptor {
  return {
    value: Object.freeze(method.bind(receiver)),
    enumerable: false,
    writable: false,
    configurable: false,
  };
}

function boundedDataDescriptors(
  value: object,
  state: SchemaGraphState,
  label: string
): Record<PropertyKey, PropertyDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_SCHEMA_CONTAINER_KEYS) {
    throw new TypeError(`tool schema graph ${label} has too many properties`);
  }
  state.ownKeys += keys.length;
  if (state.ownKeys > MAX_SCHEMA_GRAPH_OWN_KEYS) {
    throw new TypeError("tool schema graph property budget exceeded");
  }
  for (const key of keys) {
    if (!("value" in (descriptors[key] as PropertyDescriptor))) {
      throw new TypeError(`tool schema graph ${label} must not contain accessors`);
    }
  }
  return descriptors;
}

function immutableDataDescriptor(
  source: PropertyDescriptor,
  value: unknown
): PropertyDescriptor {
  return {
    value,
    enumerable: source.enumerable,
    writable: false,
    configurable: false,
  };
}

function enterSchemaGraphValue(state: SchemaGraphState, value: object): void {
  if (nodeUtilTypes.isProxy(value)) {
    throw new TypeError("tool schema graph must not contain a Proxy");
  }
  state.depth += 1;
  state.nodes += 1;
  if (
    state.depth > MAX_SCHEMA_GRAPH_DEPTH ||
    state.nodes > MAX_SCHEMA_GRAPH_NODES
  ) {
    state.depth -= 1;
    throw new TypeError("tool schema graph traversal budget exceeded");
  }
}

function leaveSchemaGraphValue(state: SchemaGraphState): void {
  state.depth -= 1;
}

function isZodSchemaNode(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === "object" &&
    value !== null &&
    !nodeUtilTypes.isProxy(value) &&
    value instanceof z.ZodType
  );
}

interface DefineToolModuleBase<
  TInput extends z.AnyZodObject,
  TOutput extends z.AnyZodObject,
> {
  readonly definition: ToolDefinition;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly requirements: ToolModuleRequirements;
  readonly resolveAccess: ToolAccessResolver;
}

export type DefineServiceNowToolModule<
  TInput extends z.AnyZodObject,
  TOutput extends z.AnyZodObject,
> = DefineToolModuleBase<TInput, TOutput> & {
  readonly runtime: "servicenow";
  readonly handler: (
    args: z.output<TInput>,
    services: ServiceNowToolHandlerServices
  ) => Promise<CallToolResult>;
};

export type DefineContextOnlyToolModule<
  TInput extends z.AnyZodObject,
  TOutput extends z.AnyZodObject,
> = DefineToolModuleBase<TInput, TOutput> & {
  readonly runtime: "context-only";
  readonly handler: (
    args: z.output<TInput>,
    services: ContextOnlyToolHandlerServices
  ) => Promise<CallToolResult>;
};

/** Define, validate, snapshot, and freeze a profile-resolved tool module. */
export function defineServiceNowToolModule<
  TInput extends z.AnyZodObject,
  TOutput extends z.AnyZodObject,
>(
  candidate: DefineServiceNowToolModule<TInput, TOutput>
): ServiceNowToolModuleContract {
  validateFactoryToolModule(candidate);
  const handler = candidate.handler;
  return freezeModule({
    ...candidate,
    // Registration validates with this exact schema before access preflight.
    // The resolver may add private field-policy preparation metadata, so a
    // second Zod parse here would incorrectly strip that authorized metadata.
    invoke: async (args, services) =>
      handler(args as z.output<TInput>, services),
  });
}

/** Define, validate, snapshot, and freeze a client-free diagnostic module. */
export function defineContextOnlyToolModule<
  TInput extends z.AnyZodObject,
  TOutput extends z.AnyZodObject,
>(
  candidate: DefineContextOnlyToolModule<TInput, TOutput>
): ContextOnlyToolModuleContract {
  validateFactoryToolModule(candidate);
  const handler = candidate.handler;
  return freezeModule({
    ...candidate,
    invoke: async (args, services) =>
      handler(args as z.output<TInput>, services),
  });
}

/**
 * Validate the complete catalog before registration performs its first side
 * effect. This runtime guard also protects callers that bypass TypeScript.
 */
export function validateToolModuleCatalog(
  modules: readonly ToolModuleContract[]
): void {
  snapshotToolModuleCatalog(modules);
}

/**
 * Snapshot and validate the full issued catalog before registration starts.
 * Proxies, sparse/accessor arrays, and hand-forged module objects fail closed.
 */
export function snapshotToolModuleCatalog(
  modules: readonly ToolModuleContract[]
): readonly ToolModuleContract[] {
  if (
    !Array.isArray(modules) ||
    nodeUtilTypes.isProxy(modules) ||
    modules.length === 0 ||
    modules.length > MAX_TOOL_MODULES
  ) {
    throw new TypeError("tool module catalog must not be empty");
  }
  const names = new Set<string>();
  const snapshot: ToolModuleContract[] = [];
  for (let index = 0; index < modules.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(modules, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("tool module catalog must contain data entries");
    }
    const module = descriptor.value as ToolModuleContract;
    validateRegisteredToolModule(module);
    if (names.has(module.definition.name)) {
      throw new TypeError(`duplicate tool module name: ${module.definition.name}`);
    }
    names.add(module.definition.name);
    snapshot.push(module);
  }
  return Object.freeze(snapshot);
}

type ToolModuleCandidate = {
  readonly definition?: ToolDefinition;
  readonly inputSchema?: z.AnyZodObject;
  readonly outputSchema?: z.AnyZodObject;
  readonly requirements?: ToolModuleRequirements;
  readonly resolveAccess?: ToolAccessResolver;
  readonly runtime?: string;
  readonly handler?: unknown;
  readonly invoke?: unknown;
};

function validateFactoryToolModule(candidate: ToolModuleCandidate): void {
  validateToolModuleShape(candidate, "factory");
  if (typeof candidate.handler !== "function" || candidate.invoke !== undefined) {
    throw new TypeError(`${candidate.definition?.name ?? "tool module"}: factory requires handler and prohibits invoke`);
  }
}

function validateRegisteredToolModule(candidate: ToolModuleCandidate): void {
  validateToolModuleShape(candidate, "registered");
  if (typeof candidate.invoke !== "function" || candidate.handler !== undefined) {
    throw new TypeError(`${candidate.definition?.name ?? "tool module"}: registered module requires invoke and prohibits handler`);
  }
  if (!ISSUED_TOOL_MODULES.has(candidate as object)) {
    throw new TypeError(`${candidate.definition?.name ?? "tool module"}: registered module was not issued by a contract factory`);
  }
}

function validateToolModuleShape(
  candidate: ToolModuleCandidate,
  phase: "factory" | "registered"
): void {
  assertPlainDataObject(candidate, `${phase} tool module`, [
    "definition",
    "inputSchema",
    "outputSchema",
    "requirements",
    "resolveAccess",
    "runtime",
    phase === "factory" ? "handler" : "invoke",
  ]);
  const definition = candidate.definition;
  assertPlainDataObject(definition, "tool module definition", [
    "name",
    "description",
    "annotations",
  ]);
  if (!/^sn_[a-z][a-z0-9_]*$/u.test(String(definition.name))) {
    throw new TypeError("tool module name must use the sn_* namespace");
  }
  const typedDefinition = definition as unknown as ToolDefinition;
  if (!typedDefinition.description?.trim()) {
    throw new TypeError(`${typedDefinition.name}: description is required`);
  }
  validateAnnotations(typedDefinition.name, typedDefinition.annotations);
  validateProfileSchema(typedDefinition.name, "input", candidate.inputSchema, false);
  validateProfileSchema(typedDefinition.name, "output", candidate.outputSchema, true);
  validateRequirements(typedDefinition, candidate.requirements, candidate.runtime);
  if (typeof candidate.resolveAccess !== "function") {
    throw new TypeError(`${typedDefinition.name}: access resolver is required`);
  }
  if (candidate.runtime !== "servicenow" && candidate.runtime !== "context-only") {
    throw new TypeError(`${typedDefinition.name}: runtime declaration is incomplete`);
  }
}

function validateAnnotations(
  name: string,
  annotations: RequiredToolAnnotations | undefined
): void {
  assertPlainDataObject(annotations, `${name} annotations`, [
    "title",
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ]);
  if (
    !annotations ||
    !annotations.title?.trim() ||
    typeof annotations.readOnlyHint !== "boolean" ||
    typeof annotations.destructiveHint !== "boolean" ||
    typeof annotations.idempotentHint !== "boolean" ||
    typeof annotations.openWorldHint !== "boolean"
  ) {
    throw new TypeError(`${name}: complete MCP annotations are required`);
  }
}

function validateProfileSchema(
  name: string,
  kind: "input" | "output",
  schema: z.AnyZodObject | undefined,
  requireStrict: boolean
): void {
  let issued: IssuedSchemaSnapshot | undefined;
  try {
    if (schema) issued = issuedSchemaSnapshot(schema, kind);
  } catch {
    // The stable contract error below intentionally hides exotic object detail.
  }
  if (
    !schema ||
    !issued ||
    schema.shape.profile !== profileNameSchema ||
    (requireStrict && schema._def.unknownKeys !== "strict")
  ) {
    throw new TypeError(
      `${name}: ${kind} schema must use the shared required profile schema and be an issued contract-normalized Zod object${requireStrict ? " in strict mode" : ""}`
    );
  }
}

function validateRequirements(
  definition: ToolDefinition,
  requirements: ToolModuleRequirements | undefined,
  runtime: string | undefined
): void {
  const name = definition.name;
  if (!requirements) {
    throw new TypeError(`${name}: permission/dependency declaration is required`);
  }
  assertPlainDataObject(requirements, `${name} requirements`, [
    "permissions",
    "tables",
    "apis",
    "fieldPolicies",
    "capabilities",
  ]);
  const permissions = uniqueEnumValues(
    name,
    "permission",
    requirements.permissions,
    ["read", "write"] as const
  );
  const fieldPolicies = uniqueEnumValues(
    name,
    "field policy",
    requirements.fieldPolicies,
    ["read", "write"] as const
  );
  uniqueEnumValues(name, "API", requirements.apis, [
    "aggregate",
    "atf",
    "attachment",
    "table",
  ] as const);
  validateTables(name, requirements.tables);
  if (permissions.size === 0) {
    throw new TypeError(`${name}: at least one permission is required`);
  }
  if (!Array.isArray(requirements.capabilities) || requirements.capabilities.length === 0) {
    throw new TypeError(`${name}: at least one capability is required`);
  }
  validateUniqueNames(name, "capability", requirements.capabilities);
  for (const fieldPolicy of fieldPolicies) {
    if (!permissions.has(fieldPolicy)) {
      throw new TypeError(`${name}: field policy exceeds declared permissions`);
    }
  }
  if (definition.annotations.readOnlyHint && permissions.has("write")) {
    throw new TypeError(`${name}: read-only annotation conflicts with write permission`);
  }
  if (!definition.annotations.readOnlyHint && !permissions.has("write")) {
    throw new TypeError(`${name}: non-read-only tool requires write permission`);
  }
  if (definition.annotations.destructiveHint && !permissions.has("write")) {
    throw new TypeError(`${name}: destructive tool requires write permission`);
  }
  if (
    runtime === "context-only" &&
    (requirements.tables.kind !== "none" || requirements.apis.length > 0)
  ) {
    throw new TypeError(`${name}: context-only tool cannot declare ServiceNow dependencies`);
  }
}

function validateTables(
  name: string,
  tables: ToolTableDependencies | undefined
): void {
  assertPlainDataObject(tables, `${name} table dependencies`, [
    "kind",
    "names",
    "description",
  ]);
  if (!tables || !["none", "static", "dynamic"].includes(tables.kind)) {
    throw new TypeError(`${name}: table dependency declaration is required`);
  }
  if (tables.kind === "none") return;
  validateUniqueNames(name, "table dependency", tables.names);
  if (tables.kind === "static" && tables.names.length === 0) {
    throw new TypeError(`${name}: static table dependencies must not be empty`);
  }
  if (tables.kind === "dynamic" && !tables.description.trim()) {
    throw new TypeError(`${name}: dynamic table dependencies need a description`);
  }
}

function validateUniqueNames(
  moduleName: string,
  label: string,
  values: readonly string[] | undefined
): void {
  if (!Array.isArray(values)) {
    throw new TypeError(`${moduleName}: ${label} declaration is required`);
  }
  if (nodeUtilTypes.isProxy(values)) {
    throw new TypeError(`${moduleName}: ${label} declaration must not be a Proxy`);
  }
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${moduleName}: ${label} declaration must contain data entries`);
    }
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`${moduleName}: invalid ${label}`);
    }
    return value.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${moduleName}: duplicate ${label}`);
  }
}

function assertPlainDataObject(
  candidate: unknown,
  label: string,
  allowedKeys: readonly string[]
): asserts candidate is Record<string, unknown> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unsupported property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${label} must not contain accessors`);
    }
  }
}

function uniqueEnumValues<const T extends readonly string[]>(
  moduleName: string,
  label: string,
  values: readonly string[] | undefined,
  allowed: T
): Set<T[number]> {
  validateUniqueNames(moduleName, label, values);
  const result = new Set<T[number]>();
  for (const value of values ?? []) {
    if (!allowed.includes(value as T[number])) {
      throw new TypeError(`${moduleName}: unsupported ${label}`);
    }
    result.add(value as T[number]);
  }
  return result;
}

function freezeModule<T extends ToolModuleContract>(module: T): T {
  const tables =
    module.requirements.tables.kind === "none"
      ? Object.freeze({ kind: "none" as const })
      : Object.freeze({
          ...module.requirements.tables,
          names: Object.freeze([...module.requirements.tables.names]),
        });
  const frozen = Object.freeze({
    definition: Object.freeze({
      ...module.definition,
      annotations: Object.freeze({ ...module.definition.annotations }),
    }),
    inputSchema: module.inputSchema,
    outputSchema: module.outputSchema,
    requirements: Object.freeze({
      permissions: Object.freeze([...module.requirements.permissions]),
      tables,
      apis: Object.freeze([...module.requirements.apis]),
      fieldPolicies: Object.freeze([...module.requirements.fieldPolicies]),
      capabilities: Object.freeze([...module.requirements.capabilities]),
    }),
    resolveAccess: module.resolveAccess,
    runtime: module.runtime,
    invoke: module.invoke,
  }) as T;
  ISSUED_TOOL_MODULES.add(frozen);
  return frozen;
}
