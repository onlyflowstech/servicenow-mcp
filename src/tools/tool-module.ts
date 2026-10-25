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
import type { AtfResultStore } from "../atf-result-cache.js";
import type { AtfHandlerSettings } from "../atf-config.js";
import type { ServiceNowConfig } from "../config.js";
import { ENCODED_QUERY_STRICT_OBJECT_PARAMS } from "../encoded-query-policy.js";
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
 * Any zod object schema. zod 4 removed `AnyZodObject`; this is its
 * replacement in the shape every tool contract accepts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZodObject = z.ZodObject<{ [key: string]: z.ZodType<any, any> }, z.core.$ZodObjectConfig>;

interface IssuedSchemaSnapshot {
  readonly definition: object;
  readonly shape: Readonly<Record<string, z.ZodType>>;
  readonly parse: AnyZodObject["parse"];
  readonly safeParse: AnyZodObject["safeParse"];
  readonly unknownKeys: "strip" | "strict";
}

const ISSUED_INPUT_SCHEMAS = new WeakSet<object>();
const ISSUED_OUTPUT_SCHEMAS = new WeakSet<object>();
const ISSUED_SCHEMA_SNAPSHOTS = new WeakMap<object, IssuedSchemaSnapshot>();
const HARDENED_SCHEMA_NODES = new WeakSet<object>();
/**
 * Process-wide: each source zod node maps to the one hardened rebuild made
 * from it. Tools share source schemas (every output envelope embeds the same
 * result metadata), and without this every tool rebuilt and froze its own
 * copy. Two consequences, both intended:
 *
 * - The first issuance wins. A source schema changed after it was first
 *   hardened is not read again, so no issued schema, earlier or later, sees
 *   the change; issued graphs stay inert to their sources.
 * - Reuse skips the rebuild but not the budgets. A graph that reuses a
 *   hardened subgraph is charged for every value in it that the graph has not
 *   already counted, exactly as a fresh traversal would have counted it, and
 *   the subgraph's height is checked at the depth it is reached (see
 *   {@link HARDENED_SUBGRAPHS} and `chargeReusedSubgraph`).
 */
const HARDENED_FROM_SOURCE = new WeakMap<object, object>();

/**
 * What hardening one zod node charged to the budgets. A node's own charge
 * folds in every non-zod value (definition, container, regex, function) its
 * build cloned, and also any non-zod value it reached that another node
 * cloned first, so that value is still paid for when this node is reused
 * without that other node. That second case counts the value twice in a graph
 * holding both nodes, which only makes the budgets stricter.
 */
interface SubgraphRecord {
  /** Traversal nodes charged for the node itself, excluding child zod nodes. */
  readonly nodes: number;
  /** Own-key charges for the node itself, excluding child zod nodes. */
  readonly ownKeys: number;
  /** Deepest level below the node's parent reached through any path. */
  readonly height: number;
  /** Every zod node the build reached, directly or through non-zod values. */
  readonly children: readonly object[];
}

/**
 * Budget records for every hardened zod node, so the nodes reachable from a
 * reused subgraph, and what a fresh traversal would have charged for each,
 * can be recovered without traversing it again.
 */
const HARDENED_SUBGRAPHS = new WeakMap<object, SubgraphRecord>();

/** Charges made while one value is being built. */
interface SubgraphFrame {
  /** The nearest frame building a zod node: itself, or an enclosing one. */
  zodFrame: SubgraphFrame | undefined;
  /** On a zod frame, the node being built, once it exists. */
  node: object | undefined;
  /** Charged by zod nodes built or reused below this value. */
  zodNodes: number;
  zodOwnKeys: number;
  /** Folded in for non-zod values first cloned by another zod node. */
  extraNodes: number;
  extraOwnKeys: number;
  readonly zodChildren: object[];
}

/** A cloned non-zod value's folded charge, kept for the current graph only. */
interface LocalSubgraphRecord extends SubgraphRecord {
  /** The zod frame whose node's charge already includes this value. */
  readonly owner: SubgraphFrame | undefined;
}
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

/**
 * The zod constructors a schema graph may be rebuilt with: every classic
 * schema class and every core check class. A node whose internals name any
 * other constructor is refused, so hardening never runs a constructor that a
 * caller supplied.
 */
const ZOD_NODE_CONSTRUCTORS: ReadonlySet<unknown> = new Set(
  [...Object.values(z), ...Object.values(z.core)].filter(
    (candidate) =>
      typeof candidate === "function" &&
      Object.hasOwn(candidate, "init") &&
      typeof (candidate as { readonly name?: unknown }).name === "string"
  )
);

/**
 * The definition keys zod itself installs as getters: an object's `shape`
 * (built on first read) and a default's `defaultValue` (a fresh copy per
 * parse). Any other accessor in a definition is refused.
 */
const ZOD_DEFINITION_ACCESSOR_KEYS: ReadonlySet<PropertyKey> = new Set([
  "shape",
  "defaultValue",
]);
const NO_ACCESSORS: ReadonlySet<PropertyKey> = new Set();

/**
 * Container types whose parse zod's memoizer wraps at construction. On its
 * first call the wrapper checks whether the schema can recurse and, when it
 * cannot, writes the unwrapped parse back onto the node's internals. That
 * write is made before freezing (see `settleMemoizedParse`).
 */
const MEMOIZED_CONTAINER_TYPES: ReadonlySet<unknown> = new Set([
  "array",
  "object",
  "tuple",
  "record",
  "map",
  "set",
]);

interface SchemaGraphState {
  readonly seen: WeakMap<object, unknown>;
  depth: number;
  /** Deepest level reached within the value being measured. */
  maxDepth: number;
  /** One frame per value being built, innermost last. */
  readonly frames: SubgraphFrame[];
  /** Folded charges of this graph's cloned non-zod values. */
  readonly local: WeakMap<object, LocalSubgraphRecord>;
  /** Source non-zod values whose clone is still being built, and its frame. */
  readonly building: WeakMap<object, SubgraphFrame>;
  nodes: number;
  ownKeys: number;
}

/**
 * Required on every published tool. Trimming makes whitespace-only selectors
 * invalid and ensures profile lookup uses the exact value clients discover.
 * Hardened once here, so every issued schema shares this exact node.
 */
export const profileNameSchema = hardenSchemaGraph(
  z
    .string()
    .trim()
    .min(1, "profile must not be empty")
    .max(128, "profile must not exceed 128 characters")
    .describe("Configured ServiceNow profile name (required; no default fallback).")
);

/**
 * The issued shape: the tool-local fields plus the shared profile selector.
 * The open index signature keeps zod 3's typing of handler arguments, where
 * an access resolver may add prepared fields beyond the declared schema.
 */
type WithProfile<TShape> = Omit<TShape, "profile"> & {
  profile: typeof profileNameSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & { [key: string]: z.ZodType<any, any> };

/** Compose tool-local fields with the exact shared profile selector. */
export function withRequiredProfile<TShape extends z.ZodRawShape, TConfig extends z.core.$ZodObjectConfig>(
  toolSchema: z.ZodObject<TShape, TConfig>
): z.ZodObject<WithProfile<TShape>, TConfig> {
  const source = snapshotUntrustedObjectSchema(toolSchema, "tool-local input schema");
  const shape = { ...source.shape, profile: profileNameSchema };
  const composed =
    source.unknownKeys === "strict"
      ? strictInputObject(shape)
      : stripInputObject(shape);
  return issueSchema(composed, "input") as unknown as z.ZodObject<
    WithProfile<TShape>,
    TConfig
  >;
}

/** Compose module output fields with the coordinator-owned profile envelope. */
export function withResolvedProfileOutput<TShape extends z.ZodRawShape, TConfig extends z.core.$ZodObjectConfig>(
  outputSchema: z.ZodObject<TShape, TConfig>
): z.ZodObject<WithProfile<TShape>, z.core.$strict> {
  const source = snapshotUntrustedObjectSchema(
    outputSchema,
    "tool-local output schema"
  );
  const normalized = z.strictObject({ ...source.shape, profile: profileNameSchema });
  return issueSchema(normalized, "output") as unknown as z.ZodObject<
    WithProfile<TShape>,
    z.core.$strict
  >;
}

/**
 * A strict input object whose unknown-key issue carries the encoded-query
 * migration hint, as zod 3's `.strict(message)` did. Every other issue keeps
 * zod's own message: the map answers only `unrecognized_keys`.
 */
function strictInputObject(shape: AnyZodObject["shape"]): AnyZodObject {
  return z.strictObject(shape, ENCODED_QUERY_STRICT_OBJECT_PARAMS);
}

/**
 * A stripping input object that still tells clients it takes no other keys.
 *
 * Unknown keys are dropped, not rejected, at parse; clients have always been
 * told `additionalProperties: false` for these tools, which the registration
 * preflight requires. zod 3's converter emitted that for a stripping object;
 * zod 4's emits it only for a strict one, and copies a node's metadata into
 * its JSON Schema, so the keyword is carried as metadata. Parsing is
 * unaffected.
 */
function stripInputObject(shape: AnyZodObject["shape"]): AnyZodObject {
  return z.object(shape).meta({ additionalProperties: false });
}

/** Base output envelope used until a module declares additional structured data. */
export const profileOutputSchema = withResolvedProfileOutput(z.object({}));

export type ToolPermission = "read" | "write";
export type ToolFieldPolicy = "read" | "write";
export type ServiceNowApiFamily =
  | "aggregate"
  | "atf"
  | "attachment"
  | "cicd"
  | "table";

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

/**
 * Narrow non-secret settings available to a ServiceNow tool handler. The
 * dispatcher always supplies `atf`; it is optional only so direct handler
 * tests need not construct it. ATF grants are not settings: they are enforced
 * from the resolved policy before the handler runs.
 */
export type ServiceNowToolSettings = Readonly<
  Pick<ServiceNowConfig, "displayValue" | "instance" | "relDepth"> & {
    readonly atf?: AtfHandlerSettings;
  }
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

/**
 * Cross-call partition for sn_schema results. The coordinator derives `scope`
 * as a digest of profile, instance, credential identity and effective policy,
 * so no credential material crosses into the handler and two profiles,
 * identities or policies never share an entry.
 */
export interface SchemaCacheBinding {
  readonly scope: string;
  readonly ttlMs: number;
}

/** Services for modules permitted to call profile-resolved ServiceNow operations. */
export interface ServiceNowToolHandlerServices
  extends CommonToolHandlerServices {
  readonly serviceNow: ServiceNowOperations;
  readonly atfResults?: AtfResultStore;
  readonly schemaCache?: SchemaCacheBinding;
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
  readonly inputSchema: AnyZodObject;
  readonly outputSchema: AnyZodObject;
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
  readonly shape: Readonly<Record<string, z.ZodType>>;
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
  const internals = ownDataValue(candidate, "_zod");
  if (
    typeof internals !== "object" ||
    internals === null ||
    nodeUtilTypes.isProxy(internals)
  ) {
    throw new TypeError(`${label} definition must be a data property`);
  }
  const definition = ownDataValue(internals, "def");
  if (
    typeof definition !== "object" ||
    definition === null ||
    nodeUtilTypes.isProxy(definition) ||
    Object.getPrototypeOf(definition) !== Object.prototype
  ) {
    throw new TypeError(`${label} definition must be a plain data object`);
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(definition, "type");
  const catchallDescriptor = Object.getOwnPropertyDescriptor(definition, "catchall");
  const catchall =
    catchallDescriptor && "value" in catchallDescriptor
      ? (catchallDescriptor.value as unknown)
      : undefined;
  if (
    ownDataValue(internals, "constr") !== z.ZodObject ||
    !typeDescriptor ||
    !("value" in typeDescriptor) ||
    typeDescriptor.value !== "object" ||
    (catchallDescriptor !== undefined && !("value" in catchallDescriptor)) ||
    (catchall !== undefined && !isZodNeverNode(catchall))
  ) {
    throw new TypeError(`${label} definition is unsupported`);
  }
  const unknownKeys = catchall === undefined ? "strip" : "strict";

  let shapeCandidate: unknown;
  try {
    shapeCandidate = readDefinitionShape(definition);
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
  const shape: Record<string, z.ZodType> = Object.create(null);
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
    const field = descriptor.value as unknown;
    if (!isZodSchemaNode(field)) {
      throw new TypeError(`${label} contains an invalid field schema`);
    }
    shape[key] = field;
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
  return Object.freeze({ shape: shapeSnapshot, unknownKeys });
}

/** The value of an own data property, or undefined for an accessor or absence. */
function ownDataValue(target: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Read an object definition's shape. zod 4 installs `shape` as a getter that
 * builds the shape on first read, so that getter (and only that key's getter)
 * is run once here; a data property is read directly.
 */
function readDefinitionShape(definition: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(definition, "shape");
  if (!descriptor) throw new TypeError("object definition has no shape");
  if ("value" in descriptor) return descriptor.value;
  if (typeof descriptor.get !== "function") {
    throw new TypeError("object definition shape is not readable");
  }
  return Reflect.apply(descriptor.get, definition, []);
}

function isZodNeverNode(value: unknown): boolean {
  if (!isZodSchemaNode(value)) return false;
  const internals = ownDataValue(value, "_zod");
  if (typeof internals !== "object" || internals === null) return false;
  const definition = ownDataValue(internals, "def");
  return (
    typeof definition === "object" &&
    definition !== null &&
    ownDataValue(definition, "type") === "never"
  );
}

function issueSchema<TSchema extends AnyZodObject>(
  source: TSchema,
  kind: "input" | "output"
): TSchema {
  const schema = hardenSchemaGraph(source);
  const definition = schema._zod.def;
  const snapshot: IssuedSchemaSnapshot = Object.freeze({
    definition,
    shape: Object.freeze({ ...(schema.shape as Record<string, z.ZodType>) }),
    parse: schema.parse,
    safeParse: schema.safeParse,
    unknownKeys: isZodNeverNode(definition.catchall) ? "strict" : "strip",
  });
  ISSUED_SCHEMA_SNAPSHOTS.set(schema, snapshot);
  (kind === "input" ? ISSUED_INPUT_SCHEMAS : ISSUED_OUTPUT_SCHEMAS).add(schema);
  return schema;
}

function issuedSchemaSnapshot(
  schema: AnyZodObject,
  kind: "input" | "output"
): IssuedSchemaSnapshot {
  const issued =
    kind === "input" ? ISSUED_INPUT_SCHEMAS : ISSUED_OUTPUT_SCHEMAS;
  const snapshot = ISSUED_SCHEMA_SNAPSHOTS.get(schema);
  if (
    nodeUtilTypes.isProxy(schema) ||
    !issued.has(schema) ||
    !snapshot ||
    schema._zod.def !== snapshot.definition ||
    schema.parse !== snapshot.parse ||
    schema.safeParse !== snapshot.safeParse
  ) {
    throw new TypeError(`tool ${kind} schema is not an issued contract-normalized schema`);
  }
  const currentShape = schema.shape as Readonly<Record<string, unknown>>;
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
  schema: AnyZodObject,
  kind: "input" | "output"
): AnyZodObject {
  const snapshot = issuedSchemaSnapshot(schema, kind);
  const shape = { ...snapshot.shape };
  const cloned =
    snapshot.unknownKeys === "strip"
      ? stripInputObject(shape)
      : kind === "input"
        ? strictInputObject(shape)
        : z.strictObject(shape);
  return hardenSchemaGraph(cloned);
}

/**
 * Rebuild a schema graph from contract-owned, frozen definitions and return
 * the rebuilt root.
 *
 * zod 4 parses through closures that each node's constructor creates over the
 * definition it was given, so swapping a definition after construction would
 * not reach parsing. Instead every node, checks included, is constructed anew
 * from a frozen copy of its definition, and that copy is the only state its
 * closures can see. References a caller kept to the source graph (its
 * definitions, checks, regexes or collections) are therefore inert. Each
 * rebuilt node then has its lazily derived state computed and its prototype
 * members pinned as own values, and is frozen. The traversal is deliberately
 * bounded and rejects accessors, proxies, foreign constructors, lazy
 * (recursive) nodes and mutable exotic containers rather than attempting to
 * execute them.
 */
function hardenSchemaGraph<TSchema extends z.ZodType>(schema: TSchema): TSchema {
  const state: SchemaGraphState = {
    seen: new WeakMap<object, unknown>(),
    depth: 0,
    maxDepth: 0,
    frames: [],
    local: new WeakMap<object, LocalSubgraphRecord>(),
    building: new WeakMap<object, SubgraphFrame>(),
    nodes: 0,
    ownKeys: 0,
  };
  try {
    return hardenZodNode(schema, state) as TSchema;
  } catch (error) {
    throw error instanceof TypeError
      ? error
      : new TypeError("tool schema graph could not be hardened");
  }
}

type ZodNodeConstructor = new (definition: object) => object;

/** The allowlisted constructor a genuine zod node was built by, or undefined. */
function zodNodeConstructor(value: unknown): ZodNodeConstructor | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return undefined;
  }
  const internals = ownDataValue(value, "_zod");
  if (
    typeof internals !== "object" ||
    internals === null ||
    nodeUtilTypes.isProxy(internals)
  ) {
    return undefined;
  }
  const constructor = ownDataValue(internals, "constr");
  if (!ZOD_NODE_CONSTRUCTORS.has(constructor)) return undefined;
  return value instanceof (constructor as ZodNodeConstructor)
    ? (constructor as ZodNodeConstructor)
    : undefined;
}

function hardenZodNode(node: object, state: SchemaGraphState): object {
  if (nodeUtilTypes.isProxy(node)) {
    throw new TypeError("tool schema graph must not contain a Proxy");
  }
  const reused = HARDENED_SCHEMA_NODES.has(node)
    ? node
    : (HARDENED_FROM_SOURCE.get(node) ?? (state.seen.get(node) as object | undefined));
  if (reused !== undefined) {
    // Already counted in this graph, or built by an earlier one.
    if (state.seen.has(reused)) noteSeenSubgraph(state, reused);
    else chargeReusedSubgraph(state, reused);
    if (reused !== node) state.seen.set(node, reused);
    return reused;
  }
  const constructor = zodNodeConstructor(node);
  if (!constructor) {
    throw new TypeError("tool schema graph contains an unsupported schema node");
  }
  return measureSubgraph(state, () => rebuildZodNode(node, constructor, state), true);
}

function rebuildZodNode(
  node: object,
  constructor: ZodNodeConstructor,
  state: SchemaGraphState
): object {
  const internals = ownDataValue(node, "_zod") as object;
  const definitionDescriptor = Object.getOwnPropertyDescriptor(internals, "def");
  if (
    !definitionDescriptor ||
    !("value" in definitionDescriptor) ||
    typeof definitionDescriptor.value !== "object" ||
    definitionDescriptor.value === null
  ) {
    throw new TypeError("tool schema graph definition must be a data property");
  }
  const sourceDefinition = definitionDescriptor.value as object;
  // measureSubgraph pushed this node's frame; the only in-progress node a
  // build may reach again is the one recorded here (see noteSeenSubgraph).
  const frame = state.frames.at(-1) as SubgraphFrame;

  enterSchemaGraphValue(state, node);
  try {
    if (constructor === z.core.$ZodCheck) {
      // A bare check (from .superRefine() or .check(fn)) gets its behaviour
      // assigned after construction, and its closure refers to the check
      // itself, so it cannot be rebuilt from its definition. It is frozen in
      // place instead: a reference kept to it, or to its definition, can no
      // longer change it.
      state.seen.set(node, node);
      frame.node = node;
      sealCheckDefinitionInPlace(sourceDefinition, state);
      sealRebuiltZodNode(node, state);
      HARDENED_SCHEMA_NODES.add(node);
      return node;
    }
    if (ownDataValue(sourceDefinition, "type") === "lazy") {
      // zod 4 resolves a lazy target by writing it onto the definition and
      // the node on first use, which a frozen graph cannot allow. A lazy node
      // is also the way to build a recursive schema (shape getters are
      // refused as accessors; a cycle closed through metadata is refused by
      // noteSeenSubgraph and noteSeenValue). No tool schema is recursive, so
      // lazy nodes are refused rather than half supported.
      throw new TypeError("tool schema graph does not support lazy (recursive) schemas");
    }
    const definition = cloneSchemaDefinition(sourceDefinition, state);
    const assigned = new Map(
      Reflect.ownKeys(definition).map((key) => [key, definition[key]] as const)
    );
    const rebuilt = new constructor(definition);
    state.seen.set(node, rebuilt);
    // A rebuilt node reached again through its own members is itself.
    state.seen.set(rebuilt, rebuilt);
    frame.node = rebuilt;
    sealSchemaDefinition(definition, assigned, state);
    copySchemaMetadata(node, rebuilt, state);
    sealRebuiltZodNode(rebuilt, state);
    HARDENED_SCHEMA_NODES.add(rebuilt);
    // Only a completely sealed rebuild is shared; a failure above leaves
    // nothing behind for the next graph.
    HARDENED_FROM_SOURCE.set(node, rebuilt);
    return rebuilt;
  } finally {
    leaveSchemaGraphValue(state);
  }
}

/**
 * Build a hardened value and record its budget charge and height. A zod
 * node's record is kept for the process (see {@link HARDENED_SUBGRAPHS}); a
 * non-zod value's folded record is kept for the current graph only, and its
 * charge is part of the enclosing zod node's.
 */
function measureSubgraph<T extends object>(
  state: SchemaGraphState,
  build: () => T,
  isZodNode: boolean,
  /** For a non-zod value, the source being cloned (tracked while in progress). */
  source?: object
): T {
  const startNodes = state.nodes;
  const startOwnKeys = state.ownKeys;
  const startDepth = state.depth;
  const outerMaxDepth = state.maxDepth;
  const parent = state.frames.at(-1);
  const frame: SubgraphFrame = {
    zodFrame: parent?.zodFrame,
    node: undefined,
    zodNodes: 0,
    zodOwnKeys: 0,
    extraNodes: 0,
    extraOwnKeys: 0,
    zodChildren: [],
  };
  if (isZodNode) frame.zodFrame = frame;
  state.maxDepth = startDepth;
  state.frames.push(frame);
  if (source !== undefined) state.building.set(source, frame);
  let hardened: T;
  let height: number;
  try {
    hardened = build();
    height = state.maxDepth - startDepth;
  } finally {
    if (source !== undefined) state.building.delete(source);
    state.frames.pop();
    state.maxDepth = Math.max(outerMaxDepth, state.maxDepth);
  }
  const nodes = state.nodes - startNodes;
  const ownKeys = state.ownKeys - startOwnKeys;
  const ownCharge = {
    nodes: nodes - frame.zodNodes + frame.extraNodes,
    ownKeys: ownKeys - frame.zodOwnKeys + frame.extraOwnKeys,
    height,
  };
  if (isZodNode) {
    if (!HARDENED_SUBGRAPHS.has(hardened)) {
      HARDENED_SUBGRAPHS.set(
        hardened,
        Object.freeze({ ...ownCharge, children: Object.freeze(frame.zodChildren) })
      );
    }
    if (parent) {
      parent.zodNodes += nodes;
      parent.zodOwnKeys += ownKeys;
      parent.zodChildren.push(hardened);
    }
    return hardened;
  }
  if (!state.local.has(hardened)) {
    state.local.set(hardened, {
      ...ownCharge,
      children: frame.zodChildren,
      owner: frame.zodFrame,
    });
  }
  if (parent) {
    parent.zodNodes += frame.zodNodes;
    parent.zodOwnKeys += frame.zodOwnKeys;
    parent.extraNodes += frame.extraNodes;
    parent.extraOwnKeys += frame.extraOwnKeys;
    for (const child of frame.zodChildren) parent.zodChildren.push(child);
  }
  return hardened;
}

/** Record a depth reached through a subgraph, failing past the bound. */
function reachSchemaGraphDepth(state: SchemaGraphState, depth: number): void {
  if (depth > state.maxDepth) state.maxDepth = depth;
  if (depth > MAX_SCHEMA_GRAPH_DEPTH) {
    throw new TypeError("tool schema graph traversal budget exceeded");
  }
}

/**
 * The error for a graph that reaches back into something still being built
 * by another node. Metadata is attached after a node is constructed, so it
 * can point back at an enclosing value or node and close a cycle even though
 * lazy nodes are refused and accessors are not followed. The node closing the
 * cycle would be recorded without what lies behind it, and a later graph
 * reusing it would be charged too little, so such graphs are refused.
 */
function schemaGraphCycle(): TypeError {
  return new TypeError("tool schema graph contains a cycle");
}

/** The node the innermost zod frame is building, if it exists yet. */
function nodeBeingBuilt(state: SchemaGraphState): object | undefined {
  return state.frames.at(-1)?.zodFrame?.node;
}

/**
 * A zod node reached again within the graph that already counted it: no new
 * charge, as before, but its height is checked at this depth too and it is
 * linked as a child of the node being built. A node with no record is still
 * being built; reaching it is allowed only from within its own build (a node
 * reached through its own members), which is counted by that build. Reaching
 * any other node still being built is a cycle and is refused.
 */
function noteSeenSubgraph(state: SchemaGraphState, hardened: object): void {
  const record = HARDENED_SUBGRAPHS.get(hardened);
  if (record === undefined) {
    if (hardened !== nodeBeingBuilt(state)) throw schemaGraphCycle();
    return;
  }
  reachSchemaGraphDepth(state, state.depth + record.height);
  state.frames.at(-1)?.zodChildren.push(hardened);
}

/**
 * A cloned non-zod value reached again within this graph. No new charge to
 * the graph and its height is checked at this depth. When another zod node
 * cloned it first, its folded charge and its zod nodes are added to the
 * current node's record as well, so reusing the current node without that
 * other node still pays for it. A value still being built may be reached
 * again only from within the same zod node's build; reaching it from another
 * node is a cycle and is refused.
 */
function noteSeenValue(state: SchemaGraphState, source: object, hardened: object): void {
  const record = state.local.get(hardened);
  if (record === undefined) {
    const building = state.building.get(source);
    if (building === undefined) {
      throw new TypeError("tool schema graph reuses a value with no recorded budget");
    }
    if (building.zodFrame !== state.frames.at(-1)?.zodFrame) throw schemaGraphCycle();
    return;
  }
  reachSchemaGraphDepth(state, state.depth + record.height);
  const frame = state.frames.at(-1);
  if (frame === undefined || record.owner === frame.zodFrame) return;
  frame.extraNodes += record.nodes;
  frame.extraOwnKeys += record.ownKeys;
  for (const child of record.children) frame.zodChildren.push(child);
}

/**
 * A hardened subgraph built by an earlier graph. Every value in it that this
 * graph has not counted yet is charged its recorded own nodes and own keys,
 * which is what a fresh traversal of the same subgraph would have charged,
 * and its height is checked at the depth it is reached. The walk follows the
 * recorded links only; it does not touch the frozen nodes.
 */
function chargeReusedSubgraph(state: SchemaGraphState, hardened: object): void {
  const record = HARDENED_SUBGRAPHS.get(hardened);
  if (record === undefined) {
    throw new TypeError("tool schema graph reuses a node with no recorded budget");
  }
  reachSchemaGraphDepth(state, state.depth + record.height);
  let nodes = 0;
  let ownKeys = 0;
  const pending: object[] = [hardened];
  while (pending.length > 0) {
    const value = pending.pop() as object;
    if (state.seen.has(value)) continue;
    const valueRecord = HARDENED_SUBGRAPHS.get(value);
    if (valueRecord === undefined) {
      throw new TypeError("tool schema graph reuses a node with no recorded budget");
    }
    state.seen.set(value, value);
    nodes += valueRecord.nodes;
    ownKeys += valueRecord.ownKeys;
    for (const child of valueRecord.children) pending.push(child);
  }
  state.nodes += nodes;
  state.ownKeys += ownKeys;
  if (state.nodes > MAX_SCHEMA_GRAPH_NODES) {
    throw new TypeError("tool schema graph traversal budget exceeded");
  }
  if (state.ownKeys > MAX_SCHEMA_GRAPH_OWN_KEYS) {
    throw new TypeError("tool schema graph property budget exceeded");
  }
  const parent = state.frames.at(-1);
  if (parent) {
    parent.zodNodes += nodes;
    parent.zodOwnKeys += ownKeys;
    parent.zodChildren.push(hardened);
  }
}

function cloneSchemaDefinition(
  candidate: object,
  state: SchemaGraphState
): Record<PropertyKey, unknown> {
  if (
    nodeUtilTypes.isProxy(candidate) ||
    (Object.getPrototypeOf(candidate) !== Object.prototype &&
      Object.getPrototypeOf(candidate) !== null)
  ) {
    throw new TypeError("tool schema graph definitions must be plain data objects");
  }
  enterSchemaGraphValue(state, candidate);
  try {
    const descriptors = boundedDataDescriptors(
      candidate,
      state,
      "definition",
      ZOD_DEFINITION_ACCESSOR_KEYS
    );
    const clone: Record<PropertyKey, unknown> = Object.create(
      Object.getPrototypeOf(candidate)
    ) as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key] as PropertyDescriptor;
      let value: unknown;
      if ("value" in descriptor) {
        value = descriptor.value;
      } else {
        try {
          value = Reflect.apply(descriptor.get as () => unknown, candidate, []);
        } catch {
          throw new TypeError("tool schema graph definition getter could not be read");
        }
      }
      value =
        key === "shape"
          ? materializeZodShape(value, state)
          : cloneAndHardenGraphValue(value, state);
      // Left writable until the node is constructed: zod constructors fill
      // in definition defaults (a number format, a format's pattern) and an
      // object's constructor reinstalls `shape` as its own getter. The
      // definition is sealed right after construction.
      Object.defineProperty(clone, key, {
        value,
        enumerable: descriptor.enumerable ?? true,
        writable: true,
        configurable: true,
      });
    }
    return clone;
  } finally {
    leaveSchemaGraphValue(state);
  }
}

/** Freeze a bare check's own definition where it is, hardening its values. */
function sealCheckDefinitionInPlace(definition: object, state: SchemaGraphState): void {
  if (
    nodeUtilTypes.isProxy(definition) ||
    Object.getPrototypeOf(definition) !== Object.prototype
  ) {
    throw new TypeError("tool schema graph definitions must be plain data objects");
  }
  enterSchemaGraphValue(state, definition);
  try {
    boundedDataDescriptors(definition, state, "definition");
    sealSchemaDefinition(definition as Record<PropertyKey, unknown>, new Map(), state);
  } finally {
    leaveSchemaGraphValue(state);
  }
}

/**
 * Freeze a rebuilt definition once its node is constructed. Any getter the
 * constructor installed (an object's `shape`, which copies the frozen shape
 * on first read) is read once so it settles as data, and the copy is frozen.
 * A value the constructor added or replaced (a format's default pattern) is
 * hardened like any other; the values cloned in are already hardened.
 */
function sealSchemaDefinition(
  definition: Record<PropertyKey, unknown>,
  assigned: ReadonlyMap<PropertyKey, unknown>,
  state: SchemaGraphState
): void {
  for (const key of Reflect.ownKeys(definition)) {
    const descriptor = Object.getOwnPropertyDescriptor(definition, key);
    if (!descriptor) continue;
    let value: unknown;
    if ("value" in descriptor) {
      value = descriptor.value;
    } else {
      value = Reflect.get(definition, key);
      if (key !== "shape") {
        throw new TypeError("tool schema graph definition gained an unexpected accessor");
      }
    }
    if (key === "shape") {
      if (
        typeof value !== "object" ||
        value === null ||
        nodeUtilTypes.isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      ) {
        throw new TypeError("tool schema graph object shape must be a plain data object");
      }
      Object.freeze(value);
    } else if (!assigned.has(key) || assigned.get(key) !== value) {
      value = cloneAndHardenGraphValue(value, state);
    }
    Object.defineProperty(definition, key, {
      value,
      enumerable: descriptor.enumerable ?? true,
      writable: false,
      configurable: false,
    });
  }
  Object.freeze(definition);
}

function materializeZodShape(
  candidate: unknown,
  state: SchemaGraphState
): Readonly<Record<string, z.ZodType>> {
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
  try {
    const descriptors = boundedDataDescriptors(candidate, state, "object shape");
    const shape: Record<string, z.ZodType> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw new TypeError("tool schema graph object shape has a symbol field");
      }
      const field = (descriptors[key] as PropertyDescriptor).value as unknown;
      if (!isZodSchemaNode(field)) {
        throw new TypeError("tool schema graph object shape has an invalid field");
      }
      Object.defineProperty(shape, key, {
        value: hardenZodNode(field, state),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(shape);
  } finally {
    leaveSchemaGraphValue(state);
  }
}

/**
 * zod 4 keeps a description in its global metadata registry, keyed by node,
 * so the rebuilt node is registered with a frozen copy of the source's.
 */
function copySchemaMetadata(
  source: object,
  rebuilt: object,
  state: SchemaGraphState
): void {
  const metadata = z.globalRegistry.get(source as z.ZodType) as unknown;
  if (metadata === undefined) return;
  z.globalRegistry.add(
    rebuilt as z.ZodType,
    cloneAndHardenGraphValue(metadata, state) as z.core.GlobalMeta
  );
}

/**
 * Make a freshly rebuilt node immutable without breaking zod's own lazy
 * state. zod 4 derives some internals on first read and binds prototype
 * methods to the instance on first access, writing each onto the object, so
 * freezing first would turn that write into a TypeError mid-parse. Every
 * derived internal is therefore computed and every prototype member
 * materialized first, Set/Map state is swapped for immutable facades, and only
 * then is the node frozen. Prototype members stay pinned as own properties, so
 * a later change to a zod prototype cannot reach an issued node.
 */
function sealRebuiltZodNode(node: object, state: SchemaGraphState): void {
  const internals = ownDataValue(node, "_zod") as object;
  settleMemoizedParse(internals);
  materializeDerivedMembers(internals, true);
  hardenOwnMembers(internals, state, new Set<PropertyKey>(["constr", "version"]));
  Object.freeze(internals);

  materializeDerivedMembers(node);
  hardenOwnMembers(node, state, new Set<PropertyKey>(["_zod"]));
  Object.freeze(node);
}

/**
 * Let zod's memoizer settle a container's parse before the node is frozen.
 * The wrapper decides on its first call whether the schema can recurse and,
 * if not, restores the plain parse onto the internals; on a frozen node that
 * write would throw mid-parse. Each memoized container rejects a non-object
 * input before reaching any child or user function, so parsing `undefined`
 * here only makes that decision.
 */
function settleMemoizedParse(internals: object): void {
  const definition = ownDataValue(internals, "def") as object;
  if (!MEMOIZED_CONTAINER_TYPES.has(ownDataValue(definition, "type"))) return;
  const parse = ownDataValue(internals, "parse");
  if (typeof parse !== "function") {
    throw new TypeError("tool schema graph container has no parse function");
  }
  Reflect.apply(parse, internals, [{ value: undefined, issues: [] }, {}]);
}

/**
 * Harden every own member of a rebuilt node or its internals before the
 * caller freezes it (freezing pins each member non-writable and
 * non-configurable). Object data is replaced by its frozen clone or facade
 * and functions are frozen; an accessor (a live zod getter pinned from the
 * prototype) keeps its frozen functions. Members named in `shared` are zod
 * module values every schema points at, and are left as they are. Only the
 * members traversed count toward the property budget: the rest were created
 * by zod's constructors from the bounded, cloned definition.
 */
function hardenOwnMembers(
  target: object,
  state: SchemaGraphState,
  shared: ReadonlySet<PropertyKey>
): void {
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      if (descriptor.get) Object.freeze(descriptor.get);
      if (descriptor.set) Object.freeze(descriptor.set);
      continue;
    }
    const value: unknown = descriptor.value;
    if (shared.has(key) || value === null) continue;
    if (typeof value === "function") {
      Object.freeze(value);
      continue;
    }
    if (typeof value !== "object") continue;
    state.ownKeys += 1;
    if (state.ownKeys > MAX_SCHEMA_GRAPH_OWN_KEYS) {
      throw new TypeError("tool schema graph property budget exceeded");
    }
    const hardened = cloneAndHardenGraphValue(value, state);
    if (hardened !== value) {
      if (!descriptor.configurable && !descriptor.writable) {
        throw new TypeError("tool schema graph contains immutable foreign state");
      }
      Object.defineProperty(target, key, { value: hardened });
    }
  }
}

/**
 * Read every prototype getter of `target` once, so zod's lazily derived
 * members land as own data, then pin any member still inherited (a method
 * value, or a getter that stays live, such as `description`, which reads the
 * registry on each access) as an own property.
 *
 * On a node's internals every prototype getter is a memoizing derivation, and
 * one that resolved through a recursion break stays unmemoized (zod retries
 * it later by writing to the internals). There the value read now, with the
 * graph complete, is pinned as data instead, so no later read writes.
 */
function materializeDerivedMembers(target: object, pinGettersAsData = false): void {
  let prototype = Object.getPrototypeOf(target) as object | null;
  let levels = 0;
  while (prototype && prototype !== Object.prototype) {
    levels += 1;
    if (levels > 16 || nodeUtilTypes.isProxy(prototype)) {
      throw new TypeError("tool schema graph has an unsupported prototype chain");
    }
    for (const key of Reflect.ownKeys(prototype)) {
      if (key === "constructor" || Object.hasOwn(target, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor) continue;
      if ("value" in descriptor) {
        if (typeof descriptor.value !== "function") continue;
        Object.defineProperty(target, key, {
          value: descriptor.value,
          enumerable: descriptor.enumerable,
          writable: false,
          configurable: true,
        });
        continue;
      }
      if (pinGettersAsData) {
        const value: unknown = Reflect.get(target, key);
        if (Object.hasOwn(target, key)) continue;
        Object.defineProperty(target, key, {
          value,
          enumerable: descriptor.enumerable,
          writable: false,
          configurable: true,
        });
        continue;
      }
      try {
        Reflect.get(target, key);
      } catch {
        // A getter that cannot run for this node is pinned unread below.
      }
      if (Object.hasOwn(target, key)) continue;
      Object.defineProperty(target, key, {
        get: descriptor.get,
        set: descriptor.set,
        enumerable: descriptor.enumerable,
        configurable: true,
      });
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
  if (zodNodeConstructor(value)) return hardenZodNode(value as object, state);
  const existing = state.seen.get(value);
  if (existing) {
    noteSeenValue(state, value as object, existing as object);
    return existing;
  }
  return measureSubgraph(state, () => cloneFreshGraphValue(value as object, state), false, value as object);
}

/** Clone and freeze one non-zod value not yet seen in this graph. */
function cloneFreshGraphValue(value: object, state: SchemaGraphState): object {
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
  // isMap reads the internal slot, so it cannot be spoofed and, unlike the
  // intrinsic getter on a non-Map, does not throw for every plain object.
  if (!INTRINSIC_MAP_SIZE || !nodeUtilTypes.isMap(value)) return undefined;
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
  if (!INTRINSIC_SET_SIZE || !nodeUtilTypes.isSet(value)) return undefined;
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
  label: string,
  allowedAccessors: ReadonlySet<PropertyKey> = NO_ACCESSORS
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
    const descriptor = descriptors[key] as PropertyDescriptor;
    if (
      !("value" in descriptor) &&
      (!allowedAccessors.has(key) ||
        typeof descriptor.get !== "function" ||
        nodeUtilTypes.isProxy(descriptor.get))
    ) {
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
  if (state.depth > state.maxDepth) state.maxDepth = state.depth;
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

function isZodSchemaNode(value: unknown): value is z.ZodType {
  return zodNodeConstructor(value) !== undefined && value instanceof z.ZodType;
}

interface DefineToolModuleBase<
  TInput extends AnyZodObject,
  TOutput extends AnyZodObject,
> {
  readonly definition: ToolDefinition;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly requirements: ToolModuleRequirements;
  readonly resolveAccess: ToolAccessResolver;
}

export type DefineServiceNowToolModule<
  TInput extends AnyZodObject,
  TOutput extends AnyZodObject,
> = DefineToolModuleBase<TInput, TOutput> & {
  readonly runtime: "servicenow";
  readonly handler: (
    args: z.output<TInput>,
    services: ServiceNowToolHandlerServices
  ) => Promise<CallToolResult>;
};

export type DefineContextOnlyToolModule<
  TInput extends AnyZodObject,
  TOutput extends AnyZodObject,
> = DefineToolModuleBase<TInput, TOutput> & {
  readonly runtime: "context-only";
  readonly handler: (
    args: z.output<TInput>,
    services: ContextOnlyToolHandlerServices
  ) => Promise<CallToolResult>;
};

/** Define, validate, snapshot, and freeze a profile-resolved tool module. */
export function defineServiceNowToolModule<
  TInput extends AnyZodObject,
  TOutput extends AnyZodObject,
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
  TInput extends AnyZodObject,
  TOutput extends AnyZodObject,
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
  readonly inputSchema?: AnyZodObject;
  readonly outputSchema?: AnyZodObject;
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
  schema: AnyZodObject | undefined,
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
    (requireStrict && issued.unknownKeys !== "strict")
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
    "cicd",
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
