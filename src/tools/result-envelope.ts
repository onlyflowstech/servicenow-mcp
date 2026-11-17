import { atfExecutionResultSchema, atfResultsSchema, atfReadinessSchema } from "./atf-contracts.js";
import { FLOW_DIAGRAM_OMITTED_NOTE as DIAGRAM_OMITTED_NOTE, FLOW_VIEW_LIMITS, flowGraphSchema } from "./flow-view-contracts.js";
import { HISTORY_LIMITS, historyDataSchema } from "./history-contracts.js";
import { PLATFORM_VIEW_LIMITS, platformViewDataSchema } from "./platform-view-contracts.js";
/** Shared SNSDK-33 structured-result contracts and compatibility adapter. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { BATCH_LIMITS } from "../batch-limits.js";
import type { CacheStatus, CallMetricsSnapshot, CallTiming } from "../call-metrics.js";
import { MAX_FIELD_OBJECT_OWN_KEYS } from "../field-policy.js";
import {
  MAX_RESPONSE_BYTES_DEFAULT,
  MAX_RESPONSE_BYTES_MAX,
  MAX_RESPONSE_BYTES_MIN,
} from "../utils.js";
import { canonicalHttpsOrigin } from "./markdown.js";
import {
  neededResponseBytes,
  parseTruncationHint,
  refreshTruncationHint,
  restateContinuationHint,
  type TruncationHintParts,
} from "./truncation-hint.js";
import { withResolvedProfileOutput } from "./tool-module.js";
import { MAX_CURSOR_LENGTH, restateTailPageAfterFit } from "./syslog-cursor.js";

export const DEFAULT_RESULT_RECORD_LIMIT = 1_000;
export const DEFAULT_RESULT_BYTE_LIMIT = MAX_RESPONSE_BYTES_DEFAULT;
export const ATTACHMENT_RESULT_BYTE_LIMIT = 14 * 1024 * 1024;

const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

const offsetPaginationSchema = z
  .object({
    mode: z.literal("offset"),
    limit: positiveInteger,
    offset: nonNegativeInteger,
    returned: nonNegativeInteger,
    has_more: z.boolean(),
    next_offset: nonNegativeInteger.optional(),
    recovery: z
      .literal("adjust_request_and_retry_same_offset")
      .optional(),
    order_by: z.array(z.string().min(1)).min(1).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    // has_more means rows exist that this response did not contain. Normally
    // next_offset points at the first of them. When rows were dropped for
    // size and not one fit, no offset can advance: `recovery` then marks that
    // the request itself must change, and next_offset is left out.
    if (
      value.has_more &&
      (value.next_offset === undefined
        ? value.recovery === undefined
        : value.next_offset <= value.offset)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "next_offset must advance beyond offset when has_more is true, " +
          "unless recovery says the request must change",
        path: ["next_offset"],
      });
    }
    if (!value.has_more && value.next_offset !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "next_offset requires has_more",
        path: ["next_offset"],
      });
    }
  });

/** Offset is the sole production continuation mode until a real cursor exists. */
export const resultPaginationSchema = z.union([
  z.object({ mode: z.literal("none") }).strict(),
  offsetPaginationSchema,
]);

/**
 * What a call reports about itself (see `call-metrics.ts`): one compact
 * definition, shared by every tool's output schema. `metadata.cache` and
 * `metadata.timing` are both optional: a handler builds its envelope without
 * them and the dispatcher adds them, and `cache` is absent when the call made
 * no cacheable read.
 */
// Validation still bounds these to safe integers; only the advertised
// `maximum` (2^53 - 1, 81 characters per tool in `tools/list`) is left out,
// since no duration comes near it. The undefined meta value removes the key.
const wholeMilliseconds = nonNegativeInteger.meta({ maximum: undefined });
const callTimingSchema = z
  .object({
    total_ms: wholeMilliseconds,
    upstream_ms: wholeMilliseconds,
    watermark_ms: wholeMilliseconds,
  })
  .strict();

const callMetadataShape = {
  cache: z.enum(["hit", "miss", "bypass", "mixed"]).optional(),
  timing: callTimingSchema.optional(),
};
const callMetadataSchema = z.object(callMetadataShape).strict();

export const resultMetadataSchema = z
  .object({
    kind: z.enum(["single", "collection", "operation"]),
    record_count: nonNegativeInteger,
    limits: z
      .object({
        max_records: positiveInteger,
        max_bytes: z
          .number()
          .int()
          .min(MAX_RESPONSE_BYTES_MIN)
          .max(ATTACHMENT_RESULT_BYTE_LIMIT),
      })
      .strict(),
    pagination: resultPaginationSchema,
    truncation: z
      .object({
        truncated: z.boolean(),
        reason: z.enum(["record_limit", "byte_limit"]).optional(),
        dropped_records: nonNegativeInteger.optional(),
      })
      .strict(),
    ...callMetadataShape,
  })
  .strict();

export function withStructuredResultEnvelope<TSchema extends z.ZodType>(
  dataSchema: TSchema
) {
  return withResolvedProfileOutput(
    z
      .object({
        data: dataSchema,
        metadata: resultMetadataSchema,
      })
      .strict()
  );
}

const dynamicRecordSchema = z.record(z.string(), z.unknown());
const canonicalSysIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const dynamicArraySchema = z.array(z.unknown());
const dynamicJsonRootSchema = z.union([
  z.null(),
  z.string(),
  z.number(),
  z.boolean(),
  dynamicRecordSchema,
  dynamicArraySchema,
]);

const wrappedRecordSchema = z
  .object({
    record: dynamicRecordSchema,
    // Optional caller-facing notice, mirroring sn_query's `hint`. Optional so
    // existing consumers are unaffected: it is present only when the tool has
    // something to say, such as an all-fields projection having been capped.
    hint: z.string().optional(),
  })
  .strict();

/**
 * Reserved key a single-record handler uses to carry an envelope-level hint
 * alongside its record.
 *
 * It is deliberately not a legal ServiceNow element name (those match
 * /^[a-z][a-z0-9_]{0,79}$/), so it can never collide with a real column --
 * which is exactly why the hint is not carried inside the record namespace.
 */
export const ENVELOPE_HINT_KEY = "$hint";
const wrappedResultSchema = z.object({ result: dynamicJsonRootSchema }).strict();
const schemaResultSchema = z.object({ fields: dynamicArraySchema }).strict();
const healthResultSchema = z.object({ health: dynamicRecordSchema }).strict();
const naturalLanguageResultSchema = z
  .object({ request: dynamicRecordSchema })
  .strict();
const listResultSchema = z
  .object({
    results: dynamicArraySchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict();
const attachmentResultEnvelopeSchema = z
  .object({
    action: z.enum(["list", "download", "upload"]),
    result: dynamicJsonRootSchema,
  })
  .strict();
const atfResultEnvelopeSchema = z
  .object({
    action: z.enum(["list", "suites", "run", "run-suite", "results"]),
    result: dynamicJsonRootSchema,
  })
  .strict();

const atfRecordIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const atfAuthorResultSchema = z.object({
  action: z.enum(["create_test", "create_suite", "add_tests_to_suite", "add_steps", "list_step_types"]),
  step_types: z.array(z.record(z.string(), z.unknown())).optional(),
  outcome: z.enum(["created", "failed", "catalog"]),
  results: z.array(z.object({
    table: z.enum(["sys_atf_test", "sys_atf_test_suite", "sys_atf_test_suite_test", "sys_atf_step"]),
    sys_id: atfRecordIdSchema,
  }).strict()).max(100),
  rolled_back: z.array(atfRecordIdSchema).max(1000),
  rollback_failed: z.array(atfRecordIdSchema).max(1000),
  uncertain_insert: z.boolean(),
  message: z.string().max(1000).optional(),
  advice: z.array(z.string().max(500)).max(5).optional(),
}).strict();

const queryResultSchema = z
  .object({
    record_count: nonNegativeInteger,
    total: nonNegativeInteger.optional(),
    has_more: z.boolean(),
    next_offset: nonNegativeInteger.optional(),
    hint: z.string().optional(),
    truncated: z.boolean().optional(),
    dropped_records: nonNegativeInteger.optional(),
    results: dynamicArraySchema,
  })
  .strict();

/** sn_syslog's page, plus the cursor a tail returns. */
const syslogResultSchema = queryResultSchema.extend({
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

const createResultSchema = z
  .object({
    sys_id: canonicalSysIdSchema,
    number: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u).optional(),
    // The created record's canonical table. Writes are no longer pinned to
    // incident; which tables are writable is the configured table policy's
    // decision.
    table: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u),
    record: dynamicRecordSchema,
  })
  .strict();

const updateResultSchema = z
  .object({
    sys_id: canonicalSysIdSchema,
    record: dynamicRecordSchema,
  })
  .strict();

const incidentJournalResultSchema = z
  .object({
    status: z.literal("appended"),
    sys_id: canonicalSysIdSchema,
    journal_field: z.enum(["comments", "work_notes"]),
  })
  .strict();

const deleteResultSchema = z
  .object({
    status: z.literal("deleted"),
    sys_id: z.string(),
    table: z.string(),
  })
  .strict();

const batchResultSchema = z
  .object({
    action: z.enum(["update", "delete"]),
    table: z.string(),
    matched: nonNegativeInteger,
    dry_run: z.boolean().optional(),
    message: z.string().optional(),
    sample: z
      .array(
        z.object({ sys_id: z.string(), display: z.string().optional() }).strict()
      )
      .max(BATCH_LIMITS.dryRunSampleSize)
      .optional(),
    fields_to_write: z.array(z.string()).max(MAX_FIELD_OBJECT_OWN_KEYS).optional(),
    note: z.string().optional(),
    processed: nonNegativeInteger.optional(),
    failed: nonNegativeInteger.optional(),
  })
  .strict();

const relationshipResultSchema = z
  .object({
    root: dynamicRecordSchema,
    relationships: dynamicArraySchema,
    meta: dynamicRecordSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict();

const profileResultSchema = z
  .object({
    name: z.string(),
    instance: z.string(),
    auth_type: z.enum(["apikey", "basic", "oauth"]),
    /** The effective policy as data, and the same card as text. */
    policy: dynamicRecordSchema,
    policy_card: z.string().optional(),
  })
  .strict();

const productionDataSchemas = Object.freeze({
  sn_query: queryResultSchema,
  sn_get: wrappedRecordSchema,
  sn_create: createResultSchema,
  sn_update: updateResultSchema,
  sn_incident_add_comment: incidentJournalResultSchema,
  sn_incident_add_work_note: incidentJournalResultSchema,
  sn_delete: deleteResultSchema,
  sn_batch: batchResultSchema,
  sn_aggregate: wrappedResultSchema,
  sn_schema: schemaResultSchema,
  sn_health: healthResultSchema,
  sn_attach: attachmentResultEnvelopeSchema,
  sn_relationships: relationshipResultSchema,
  sn_syslog: syslogResultSchema,
  sn_codesearch: listResultSchema,
  sn_discover: listResultSchema,
  sn_atf: atfResultEnvelopeSchema,
  sn_atf_run: atfExecutionResultSchema,
  sn_atf_results: atfResultsSchema,
  sn_atf_readiness: atfReadinessSchema,
  sn_atf_author: atfAuthorResultSchema,
  sn_flow_view: flowGraphSchema,
  sn_nl: naturalLanguageResultSchema,
  sn_history: historyDataSchema,
  sn_platform_view: platformViewDataSchema,
  sn_profile: profileResultSchema,
});

export type ProductionToolName = keyof typeof productionDataSchemas;

export const productionToolOutputSchemas = Object.freeze({
  sn_query: withStructuredResultEnvelope(productionDataSchemas.sn_query),
  sn_get: withStructuredResultEnvelope(productionDataSchemas.sn_get),
  sn_create: withStructuredResultEnvelope(productionDataSchemas.sn_create),
  sn_update: withStructuredResultEnvelope(productionDataSchemas.sn_update),
  sn_incident_add_comment: withStructuredResultEnvelope(
    productionDataSchemas.sn_incident_add_comment
  ),
  sn_incident_add_work_note: withStructuredResultEnvelope(
    productionDataSchemas.sn_incident_add_work_note
  ),
  sn_delete: withStructuredResultEnvelope(productionDataSchemas.sn_delete),
  sn_batch: withStructuredResultEnvelope(productionDataSchemas.sn_batch),
  sn_aggregate: withStructuredResultEnvelope(productionDataSchemas.sn_aggregate),
  sn_schema: withStructuredResultEnvelope(productionDataSchemas.sn_schema),
  sn_health: withStructuredResultEnvelope(productionDataSchemas.sn_health),
  sn_attach: withStructuredResultEnvelope(productionDataSchemas.sn_attach),
  sn_relationships: withStructuredResultEnvelope(
    productionDataSchemas.sn_relationships
  ),
  sn_syslog: withStructuredResultEnvelope(productionDataSchemas.sn_syslog),
  sn_codesearch: withStructuredResultEnvelope(productionDataSchemas.sn_codesearch),
  sn_discover: withStructuredResultEnvelope(productionDataSchemas.sn_discover),
  sn_atf: withStructuredResultEnvelope(productionDataSchemas.sn_atf),
  sn_atf_run: withStructuredResultEnvelope(productionDataSchemas.sn_atf_run),
  sn_atf_results: withStructuredResultEnvelope(productionDataSchemas.sn_atf_results),
  sn_atf_readiness: withStructuredResultEnvelope(productionDataSchemas.sn_atf_readiness),
  sn_atf_author: withStructuredResultEnvelope(productionDataSchemas.sn_atf_author),
  sn_flow_view: withStructuredResultEnvelope(productionDataSchemas.sn_flow_view),
  sn_nl: withStructuredResultEnvelope(productionDataSchemas.sn_nl),
  sn_profile: withStructuredResultEnvelope(productionDataSchemas.sn_profile),
  sn_history: withStructuredResultEnvelope(productionDataSchemas.sn_history),
  sn_platform_view: withStructuredResultEnvelope(productionDataSchemas.sn_platform_view),
});

/**
 * The tools for which a result that cannot be fitted to its byte limit is
 * reported as too large for the caller's `max_response_bytes`, which the caller
 * can raise: their whole result is sized to that argument.
 */
const CALLER_SIZED_TOOLS: ReadonlySet<string> = new Set(["sn_history", "sn_platform_view"]);

export function isCallerSizedTool(name: string): boolean {
  return CALLER_SIZED_TOOLS.has(name);
}

export function isProductionToolName(name: string): name is ProductionToolName {
  return Object.hasOwn(productionToolOutputSchemas, name);
}

/** Read-only copy of a finalized envelope handed to a tool text renderer. */
export interface RenderableEnvelope {
  readonly profile?: string;
  readonly data: unknown;
  readonly metadata: Readonly<z.infer<typeof resultMetadataSchema>>;
}

export interface EnvelopeTextRenderContext {
  /** The generic one-line summary, including continuation/truncation guidance. */
  readonly summary: string;
  /**
   * Canonical https origin of the resolved profile's instance, for building
   * record links. Coordinator-supplied, never taken from ServiceNow content,
   * and absent when the profile instance is not a bare https origin.
   */
  readonly instanceOrigin?: string;
}

/** Trusted coordinator inputs to text rendering; never part of structuredContent. */
export interface EnvelopeTextRenderOptions {
  readonly instanceOrigin?: string;
  /**
   * The most `max_response_bytes` this call may use when a raw-read rule holds
   * it below the schema maximum; a truncation hint never offers more.
   */
  readonly maxResponseBytesCap?: number;
}

/**
 * Human-readable text for one tool's successful result. It receives a deeply
 * frozen copy, so it cannot alter structuredContent, and the values in it come
 * from ServiceNow: build output only with the escaping helpers in markdown.ts.
 */
export type EnvelopeTextRenderer = (
  envelope: RenderableEnvelope,
  context: EnvelopeTextRenderContext
) => string;

// Populated while modules load, then sealed by the first finalized result so a
// renderer cannot be added or swapped once tool calls are being served.
const ENVELOPE_TEXT_RENDERERS = new Map<string, EnvelopeTextRenderer>();
let envelopeTextRenderersSealed = false;

/** Register the text renderer for one production tool, once, before first use. */
export function registerEnvelopeTextRenderer(
  tool: ProductionToolName,
  renderer: EnvelopeTextRenderer
): void {
  if (envelopeTextRenderersSealed) {
    throw new TypeError("envelope text renderers are sealed once results are finalized");
  }
  if (typeof tool !== "string" || !isProductionToolName(tool)) {
    throw new TypeError("envelope text renderer requires a production tool name");
  }
  if (typeof renderer !== "function") {
    throw new TypeError(`${tool}: envelope text renderer must be a function`);
  }
  if (ENVELOPE_TEXT_RENDERERS.has(tool)) {
    throw new TypeError(`${tool}: envelope text renderer is already registered`);
  }
  ENVELOPE_TEXT_RENDERERS.set(tool, renderer);
}

interface MutableMetadata {
  kind: "single" | "collection" | "operation";
  record_count: number;
  limits: { max_records: number; max_bytes: number };
  pagination:
    | { mode: "none" }
    | {
        mode: "offset";
        limit: number;
        offset: number;
        returned: number;
        has_more: boolean;
        next_offset?: number;
        recovery?: "adjust_request_and_retry_same_offset";
        order_by: string[];
      };
  truncation: {
    truncated: boolean;
    reason?: "record_limit" | "byte_limit";
    dropped_records?: number;
  };
  cache?: CacheStatus;
  timing?: CallTiming;
}

interface MutableEnvelope {
  [key: string]: unknown;
  profile?: string;
  data: unknown;
  metadata: MutableMetadata;
}

function parseHandlerJson(result: CallToolResult): unknown {
  if (result.content.length !== 1 || result.content[0]?.type !== "text") {
    throw new TypeError("successful compatibility handler must return one text block");
  }
  try {
    return JSON.parse(result.content[0].text) as unknown;
  } catch {
    throw new TypeError("successful compatibility handler returned non-JSON text");
  }
}

function normalizedListResult(data: unknown): unknown {
  if (Array.isArray(data)) return { results: data };
  if (typeof data !== "object" || data === null) return data;
  const results = Reflect.get(data, "results");
  const warnings = Reflect.get(data, "warnings");
  if (!Array.isArray(results)) return data;
  return {
    results,
    ...(Array.isArray(warnings) ? { warnings } : {}),
  };
}

/** Recognize the reserved single-record hint wrapper, if present. */
function envelopeHint(
  data: unknown
): { readonly record: unknown; readonly hint: string } | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const candidate = data as Record<string, unknown>;
  const hint = candidate[ENVELOPE_HINT_KEY];
  if (typeof hint !== "string" || !Object.hasOwn(candidate, "record")) {
    return undefined;
  }
  return { record: candidate.record, hint };
}

function normalizeToolData(
  name: ProductionToolName,
  args: Readonly<Record<string, unknown>>,
  data: unknown
): unknown {
  switch (name) {
    case "sn_get": {
      const hinted = envelopeHint(data);
      return hinted === undefined
        ? { record: data }
        : { record: hinted.record, hint: hinted.hint };
    }
    case "sn_aggregate":
      return { result: data };
    case "sn_schema":
      return { fields: data };
    case "sn_health":
      return { health: data };
    case "sn_attach":
      return { action: args.action, result: data };
    case "sn_codesearch":
    case "sn_discover":
      return normalizedListResult(data);
    case "sn_atf":
      return { action: args.action, result: data };
    case "sn_nl":
      return { request: data };
    default:
      return data;
  }
}

/**
 * The rows of a result, for the tools whose rows sit under a key of their
 * own. `sn_history`'s rows are its `events`; a refusal has none, so it is an
 * empty collection, never one record.
 */
function collectionFor(tool: string | undefined, data: unknown): unknown[] | undefined {
  if (tool === "sn_history") {
    const events = typeof data === "object" && data !== null ? Reflect.get(data, "events") : undefined;
    return Array.isArray(events) ? events : [];
  }
  return collectionArray(data);
}

function collectionArray(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.runs)) return record.runs;
  if (Array.isArray(record.failures)) return record.failures;
  if (typeof record.execution === "object" && record.execution !== null) return collectionArray(record.execution);
  if (Array.isArray(record.relationships)) return record.relationships;
  if (Array.isArray(record.fields)) return record.fields;
  if (Array.isArray(record.result)) return record.result;
  if (typeof record.result === "object" && record.result !== null) {
    const nestedResults = Reflect.get(record.result, "results");
    if (Array.isArray(nestedResults)) return nestedResults;
  }
  if (typeof record.request === "object" && record.request !== null) {
    const nestedResults = Reflect.get(record.request, "results");
    if (Array.isArray(nestedResults)) return nestedResults;
  }
  return undefined;
}

function requestedLimit(
  args: Readonly<Record<string, unknown>>,
  maximum: number,
  data: unknown
): number {
  const dataLimit = numericObjectField(data, "limit");
  const candidate =
    typeof dataLimit === "number"
      ? dataLimit
      : typeof args.limit === "number"
        ? args.limit
        : undefined;
  return typeof candidate === "number" && Number.isSafeInteger(candidate)
    ? Math.min(Math.max(candidate, 1), maximum)
    : maximum;
}

function nestedObjectField(
  data: unknown,
  field: string,
  depth = 0
): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  if (depth > 3) return undefined;
  const value = Reflect.get(data, field);
  if (value !== undefined) return value;
  const meta = Reflect.get(data, "meta");
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    const metaValue = Reflect.get(meta, field);
    if (metaValue !== undefined) return metaValue;
  }
  for (const wrapper of ["request", "result"] as const) {
    const nested = Reflect.get(data, wrapper);
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
      continue;
    }
    const nestedValue = nestedObjectField(nested, field, depth + 1);
    if (nestedValue !== undefined) return nestedValue;
  }
  return undefined;
}

function numericObjectField(data: unknown, field: string): number | undefined {
  const value = nestedObjectField(data, field);
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function booleanObjectField(data: unknown, field: string): boolean | undefined {
  const value = nestedObjectField(data, field);
  return typeof value === "boolean" ? value : undefined;
}

function requestedOffset(
  args: Readonly<Record<string, unknown>>,
  data: unknown
): number {
  const candidate =
    typeof args.offset === "number"
      ? args.offset
      : numericObjectField(data, "offset");
  return typeof candidate === "number" && Number.isSafeInteger(candidate)
    ? Math.max(candidate, 0)
    : 0;
}

function byteLimit(
  name: ProductionToolName,
  args: Readonly<Record<string, unknown>>
): number {
  if (name === "sn_attach" && args.action === "download") {
    return ATTACHMENT_RESULT_BYTE_LIMIT;
  }
  if (
    (name === "sn_query" || name === "sn_get") &&
    typeof args.max_response_bytes === "number" &&
    Number.isSafeInteger(args.max_response_bytes)
  ) {
    return Math.min(
      Math.max(args.max_response_bytes, MAX_RESPONSE_BYTES_MIN),
      MAX_RESPONSE_BYTES_MAX
    );
  }
  if (name === "sn_flow_view") {
    // Canonical arguments always carry max_response_bytes; the clamp is
    // defense in depth behind the input schema.
    const requested = args.max_response_bytes;
    return typeof requested === "number" && Number.isSafeInteger(requested)
      ? Math.min(
          Math.max(requested, FLOW_VIEW_LIMITS.MIN_MAX_RESPONSE_BYTES),
          FLOW_VIEW_LIMITS.MAX_MAX_RESPONSE_BYTES
        )
      : FLOW_VIEW_LIMITS.DEFAULT_MAX_RESPONSE_BYTES;
  }
  if (name === "sn_history" || name === "sn_platform_view") {
    // Both fill their `data` to the caller's `max_response_bytes`, which
    // their canonical arguments always carry; the clamp is defense in depth.
    const limits = name === "sn_history" ? HISTORY_LIMITS : PLATFORM_VIEW_LIMITS;
    const requested = args.max_response_bytes;
    return typeof requested === "number" && Number.isSafeInteger(requested)
      ? Math.min(Math.max(requested, limits.MIN_MAX_RESPONSE_BYTES), limits.MAX_MAX_RESPONSE_BYTES)
      : limits.DEFAULT_MAX_RESPONSE_BYTES;
  }
  return DEFAULT_RESULT_BYTE_LIMIT;
}

function resultKind(
  name: ProductionToolName,
  data: unknown
): MutableMetadata["kind"] {
  if (collectionFor(name, data)) return "collection";
  if (
    [
      "sn_create",
      "sn_update",
      "sn_incident_add_comment",
      "sn_incident_add_work_note",
      "sn_delete",
      "sn_batch",
    ].includes(name)
  ) {
    return "operation";
  }
  return "single";
}

function effectiveOrder(
  name: ProductionToolName,
  args: Readonly<Record<string, unknown>>
): string[] {
  switch (name) {
    case "sn_query": {
      const structured = Reflect.get(args, "structured_query");
      const orderBy =
        typeof structured === "object" && structured !== null
          ? Reflect.get(structured, "order_by")
          : undefined;
      const structuredOrder = Array.isArray(orderBy)
        ? orderBy.flatMap((entry) => {
            if (typeof entry !== "object" || entry === null) return [];
            const field = Reflect.get(entry, "field");
            const direction = Reflect.get(entry, "direction");
            return typeof field === "string"
              ? [`${direction === "desc" ? "-" : ""}${field}`]
              : [];
          })
        : [];
      const requestedOrder =
        structuredOrder.length > 0
          ? structuredOrder
          : typeof args.orderby === "string" && args.orderby.length > 0
            ? [args.orderby]
            : [];
      return [...requestedOrder, "sys_id"].filter(
        (value, index, values) =>
          values.findIndex((candidate) => candidate.replace(/^-/, "") === value.replace(/^-/, "")) === index
      );
    }
    case "sn_syslog":
      return ["-sys_created_on", "-sys_id"];
    case "sn_schema":
      return ["field", "sys_id"];
    case "sn_relationships":
      return ["depth_first", "relationship_sys_id"];
    case "sn_codesearch":
      // One table: its own sys_id order. Several: each table's first match
      // (script includes first), then each table's second, and so on; `round`
      // is that turn, a position and not a field of the rows.
      return typeof args.table === "string" ? ["sys_id"] : ["round", "table", "sys_id"];
    case "sn_discover":
      return args.type === "apps" ? ["source", "sys_id"] : ["sys_id"];
    case "sn_aggregate":
      return typeof args.group_by === "string" ? [args.group_by] : ["aggregate"];
    case "sn_atf":
      return args.action === "run-suite"
        ? ["-sys_created_on", "-sys_id"]
        : ["sys_id"];
    default:
      return ["sys_id"];
  }
}

function synchronizeRecordCount(data: unknown, count: number): void {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return;
  const record = data as Record<string, unknown>;
  if (Object.hasOwn(record, "record_count")) record.record_count = count;
  for (const wrapper of ["request", "result"] as const) {
    const nested = record[wrapper];
    if (typeof nested === "object" && nested !== null) {
      synchronizeRecordCount(nested, count);
    }
  }
}

/**
 * The truncation hint a tool wrote, if `data` carries one this module's
 * parser accepts, looked for where {@link synchronizePagingFields} restates it.
 */
function truncationHintParts(data: unknown, depth = 0): TruncationHintParts | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data) || depth > 3) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.hint === "string" && Object.hasOwn(record, "dropped_records")) {
    const parts = parseTruncationHint(record.hint);
    if (parts !== undefined) return parts;
  }
  for (const wrapper of ["meta", "request", "result"] as const) {
    const parts = truncationHintParts(record[wrapper], depth + 1);
    if (parts !== undefined) return parts;
  }
  return undefined;
}

function synchronizePagingFields(
  data: unknown,
  pagination: MutableMetadata["pagination"],
  truncation: MutableMetadata["truncation"],
  depth = 0,
  neededBytes?: number,
  capBytes?: number,
  allBytes?: number | null,
  withoutAdvice?: boolean,
  widestHint?: boolean
): void {
  if (
    pagination.mode !== "offset" ||
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    depth > 3
  ) {
    return;
  }
  const record = data as Record<string, unknown>;
  const synchronizeObject = (target: Record<string, unknown>): void => {
    if (Object.hasOwn(target, "record_count")) {
      target.record_count = pagination.returned;
    }
    if (Object.hasOwn(target, "limit")) target.limit = pagination.limit;
    if (Object.hasOwn(target, "offset")) target.offset = pagination.offset;
    if (Object.hasOwn(target, "has_more")) {
      target.has_more = pagination.has_more;
    }
    if (pagination.has_more && pagination.next_offset !== undefined) {
      // A tool that reports has_more reports where to continue, even when
      // the fit created the continuation (rows dropped for size).
      if (Object.hasOwn(target, "next_offset") || Object.hasOwn(target, "has_more")) {
        target.next_offset = pagination.next_offset;
      }
    } else if (Object.hasOwn(target, "next_offset")) {
      delete target.next_offset;
    }
    if (pagination.has_more && typeof target.hint === "string") {
      // The tool wrote its continuation from the page it fetched; if the fit
      // dropped rows, the first row not returned is where to continue.
      target.hint = restateContinuationHint(target.hint, {
        offset: pagination.offset,
        ...(pagination.next_offset === undefined
          ? {}
          : { nextOffset: pagination.next_offset }),
      });
    }
    if (Object.hasOwn(target, "truncated")) {
      target.truncated = truncation.truncated;
    }
    if (Object.hasOwn(target, "dropped_records")) {
      if (truncation.dropped_records === undefined) {
        delete target.dropped_records;
      } else {
        target.dropped_records = truncation.dropped_records;
        // A tool that explains the drop in a hint wrote it before this fit
        // dropped more rows. Restate it from the final counts and
        // continuation so the text agrees with the fields beside it.
        if (typeof target.hint === "string") {
          target.hint = refreshTruncationHint(target.hint, {
            dropped: truncation.dropped_records,
            returned: pagination.returned,
            ...(neededBytes === undefined ? {} : { neededBytes }),
            ...(allBytes === undefined ? {} : { allBytes }),
            ...(withoutAdvice === true ? { withoutAdvice } : {}),
            ...(widestHint === true ? { widest: true } : {}),
            ...(capBytes === undefined ? {} : { capBytes }),
          });
        }
      }
    }
  };
  synchronizeObject(record);
  if (typeof record.meta === "object" && record.meta !== null) {
    synchronizeObject(record.meta as Record<string, unknown>);
  }
  for (const wrapper of ["request", "result"] as const) {
    synchronizePagingFields(
      record[wrapper],
      pagination,
      truncation,
      depth + 1,
      neededBytes,
      capBytes,
      allBytes,
      withoutAdvice,
      widestHint
    );
  }
}

/**
 * Remove `metadata.cache` and `metadata.timing` from a handler's result. Only
 * the dispatcher reports them, from what it observed, so a value a handler
 * sets is never passed on, whether or not the dispatcher adds its own.
 */
export function withoutCallMetadata(result: CallToolResult): CallToolResult {
  const content = result.structuredContent;
  if (typeof content !== "object" || content === null) return result;
  const metadata = (content as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return result;
  const rest: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
  delete rest.cache;
  delete rest.timing;
  return { ...result, structuredContent: { ...content, metadata: rest } };
}

/**
 * Add what the call reports about itself to a finished result's envelope
 * metadata. The two fields are not counted against the result's byte limit.
 *
 * They are diagnostics, so they never cost the caller anything: the result is
 * fitted to its limit first, exactly as before, with the fit, the paging
 * fields and the truncation hint knowing nothing about them, and the fields
 * are added after. A successful response therefore carries them always, on the
 * calls where the timing matters most (a truncated one is often fitted to
 * within a few bytes of the limit), and may exceed the limit by their size,
 * under 100 bytes. A result that is not an envelope comes back untouched.
 */
export function withCallMetadata(
  handlerResult: CallToolResult,
  snapshot: CallMetricsSnapshot
): CallToolResult {
  // Whatever the handler put in the two fields never survives, fitted or not.
  const result = withoutCallMetadata(handlerResult);
  const content = result.structuredContent;
  if (typeof content !== "object" || content === null) return result;
  const metadata = (content as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return result;
  // Only an envelope has limits; anything else is not this function's to annotate.
  const maxBytes = (metadata as { limits?: { max_bytes?: unknown } }).limits?.max_bytes;
  if (typeof maxBytes !== "number") return result;
  const added = callMetadataSchema.safeParse({
    ...(snapshot.cache === undefined ? {} : { cache: snapshot.cache }),
    timing: snapshot.timing,
  });
  if (!added.success) return result;
  return {
    ...result,
    structuredContent: {
      ...content,
      metadata: { ...metadata, ...added.data },
    },
  };
}

/**
 * The tools whose handler reads one row past the page it was asked for (limit
 * + 1) and hands that row back with the page. It is not a result: it only
 * says another page exists, so the envelope cuts it, reports `has_more`, and
 * does not count it as dropped. A tool not listed here that returns more rows
 * than the limit has rows cut by the limit, and that is reported.
 */
const LOOK_AHEAD_TOOLS: ReadonlySet<string> = new Set([
  "sn_codesearch",
  "sn_discover",
  "sn_aggregate",
]);

/**
 * A tail read of the system log, and every `sn_history` page, pages by cursor,
 * not by offset: it has no offset to continue at, and its `has_more` and
 * cursors are the tool's own.
 */
function isTailRead(
  name: ProductionToolName,
  args: Readonly<Record<string, unknown>>
): boolean {
  if (name === "sn_history") return true;
  return name === "sn_syslog" && (args.tail === true || args.after_cursor !== undefined);
}

export function envelopeCompatibilityResult(
  name: ProductionToolName,
  args: Readonly<Record<string, unknown>>,
  result: CallToolResult
): CallToolResult {
  if (result.isError) return result;
  const data = normalizeToolData(name, args, parseHandlerJson(result));
  const records = collectionFor(name, data);
  const maximumRecords = DEFAULT_RESULT_RECORD_LIMIT;
  const limit = requestedLimit(args, maximumRecords, data);
  const originalCount = records?.length ?? 1;
  if (records && records.length > limit) records.splice(limit);
  const returned = records?.length ?? 1;
  synchronizeRecordCount(data, returned);
  const collection = records !== undefined;
  const offset = requestedOffset(args, data);
  const explicitHasMore = booleanObjectField(data, "has_more");
  const explicitNextOffset = numericObjectField(data, "next_offset");
  const legacyTruncated = booleanObjectField(data, "truncated") === true;
  const priorDropped = numericObjectField(data, "dropped_records") ?? 0;
  // A tool that dropped rows for size says so (truncated, dropped_records):
  // rows exist that its response does not hold, so there is more to fetch.
  const droppedForSize = collection && legacyTruncated && priorDropped > 0;
  let hasMore =
    collection &&
    (originalCount > returned ||
      explicitHasMore === true ||
      droppedForSize ||
      (explicitHasMore === undefined && returned >= limit));
  let nextOffset: number | undefined;
  let recovery: "adjust_request_and_retry_same_offset" | undefined =
    legacyTruncated ? "adjust_request_and_retry_same_offset" : undefined;
  if (hasMore) {
    if (droppedForSize && returned > 0) {
      // The rows returned are a prefix of the window, so the first row not
      // returned is the one to continue at; nothing is skipped.
      nextOffset = offset + returned;
    } else if (explicitNextOffset !== undefined && explicitNextOffset > offset) {
      nextOffset = explicitNextOffset;
    } else if (originalCount > returned && returned > 0) {
      nextOffset = offset + returned;
    } else if (returned > 0) {
      // An explicit has_more without a usable next offset means the upstream
      // window, not merely the delivered rows, is authoritative. Advancing by
      // the effective limit prevents ACL-filtered windows from being replayed.
      nextOffset = offset + limit;
    } else if (droppedForSize) {
      // Not one row fit: has_more stays true, no offset can advance, and the
      // request has to change.
      recovery = "adjust_request_and_retry_same_offset";
    } else {
      hasMore = false;
      recovery = "adjust_request_and_retry_same_offset";
    }
  }
  // The look-ahead row was read to find out whether more exists, not to be
  // returned: it is not a dropped record. Rows past it still are.
  const lookAheadRow =
    LOOK_AHEAD_TOOLS.has(name) && originalCount > returned ? 1 : 0;
  const droppedByRecordLimit = originalCount - returned - lookAheadRow;
  const droppedRecords = priorDropped + droppedByRecordLimit;
  const truncation: MutableMetadata["truncation"] =
    legacyTruncated || droppedByRecordLimit > 0
      ? {
          truncated: true,
          reason: legacyTruncated ? "byte_limit" : "record_limit",
          ...(droppedRecords > 0 ? { dropped_records: droppedRecords } : {}),
        }
      : { truncated: false };
  const metadata: MutableMetadata = {
    kind: resultKind(name, data),
    record_count: returned,
    limits: {
      max_records: maximumRecords,
      max_bytes: byteLimit(name, args),
    },
    pagination: collection && !isTailRead(name, args)
      ? {
          mode: "offset",
          limit,
          offset,
          returned,
          has_more: hasMore,
          ...(hasMore && nextOffset !== undefined
            ? { next_offset: nextOffset }
            : {}),
          ...(recovery === undefined ? {} : { recovery }),
          order_by: effectiveOrder(name, args),
        }
      : { mode: "none" },
    truncation,
  };
  synchronizePagingFields(data, metadata.pagination, metadata.truncation);
  return {
    ...result,
    structuredContent: { data, metadata },
  };
}

function isMutableEnvelope(candidate: unknown): candidate is MutableEnvelope {
  if (typeof candidate !== "object" || candidate === null) return false;
  const record = candidate as Record<string, unknown>;
  return (
    Object.hasOwn(record, "data") &&
    typeof record.metadata === "object" &&
    record.metadata !== null &&
    Object.hasOwn(record.metadata, "limits")
  );
}

function renderEnvelopeText(envelope: MutableEnvelope): string {
  const pagination = envelope.metadata.pagination;
  const noRowFit = pagination.mode === "offset" && pagination.returned === 0;
  const continuation =
    pagination.mode === "offset" && pagination.has_more
      ? pagination.next_offset !== undefined
        ? ` More records are available at offset ${pagination.next_offset}.`
        : noRowFit
          ? " More records are available, but none fit."
          : " More records are available; this result has no offset to continue at."
      : "";
  const recovery =
    pagination.mode === "offset" && pagination.recovery !== undefined
      ? pagination.has_more && pagination.next_offset !== undefined
        ? ` Rows were dropped from the current window; next_offset is the first row not returned, or adjust the request and retry offset ${pagination.offset} to get them in one response.`
        : noRowFit
          ? ` No row fit; adjust the request (fewer fields, a lower limit or a higher max_response_bytes) and retry offset ${pagination.offset}.`
          : ` Rows were dropped from the current window; adjust the request (fewer fields, a lower limit or a higher max_response_bytes) and retry offset ${pagination.offset}.`
      : "";
  const truncated = envelope.metadata.truncation.truncated
    ? ` Output was truncated by ${envelope.metadata.truncation.reason}.`
    : "";
  return (
    `Success for profile ${JSON.stringify(envelope.profile)}: ` +
    `${envelope.metadata.kind} result with ${envelope.metadata.record_count} ` +
    `record${envelope.metadata.record_count === 1 ? "" : "s"}.` +
    continuation +
    recovery +
    truncated
  );
}

function resultBytes(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function candidateResult(
  base: CallToolResult,
  envelope: MutableEnvelope
): CallToolResult {
  return {
    ...base,
    content: [{ type: "text", text: renderEnvelopeText(envelope) }],
    structuredContent: envelope,
  };
}

function applyByteTruncation(
  envelope: MutableEnvelope,
  droppedRecords: number
): void {
  envelope.metadata.truncation = {
    truncated: true,
    reason: "byte_limit",
    ...(droppedRecords > 0 ? { dropped_records: droppedRecords } : {}),
  };
}

function truncateLongestString(data: unknown): boolean {
  const candidates: Array<{
    parent: Record<string, unknown> | unknown[];
    key: string | number;
    value: string;
  }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (typeof entry === "string") {
          candidates.push({ parent: value, key: index, value: entry });
        } else {
          visit(entry);
        }
      });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        candidates.push({
          parent: value as Record<string, unknown>,
          key,
          value: entry,
        });
      } else {
        visit(entry);
      }
    }
  };
  visit(data);
  candidates.sort((left, right) => right.value.length - left.value.length);
  const longest = candidates[0];
  if (!longest || longest.value.length <= 64) return false;
  const keep = Math.max(32, Math.floor(longest.value.length / 2));
  const shortened =
    longest.value.slice(0, keep) +
    `...[truncated ${longest.value.length - keep} characters]`;
  if (Array.isArray(longest.parent) && typeof longest.key === "number") {
    longest.parent[longest.key] = shortened;
  } else if (!Array.isArray(longest.parent) && typeof longest.key === "string") {
    longest.parent[longest.key] = shortened;
  } else {
    return false;
  }
  return true;
}

/**
 * Give up a derived diagram before any text is cut. A diagram's source is a
 * rendering of fields the result already carries, and cutting it mid-line
 * leaves source that does not parse, so it goes whole, with a note.
 */
function dropDerivedDiagram(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const diagram = (data as { diagram?: unknown }).diagram;
  if (typeof diagram !== "object" || diagram === null) return false;
  const entry = diagram as { source?: unknown; note?: unknown };
  if (typeof entry.source !== "string") return false;
  delete entry.source;
  entry.note = DIAGRAM_OMITTED_NOTE;
  return true;
}

function deepFreeze(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function renderedEnvelopeText(
  renderer: EnvelopeTextRenderer,
  envelope: MutableEnvelope,
  context: EnvelopeTextRenderContext
): string | undefined {
  try {
    const view = deepFreeze(
      JSON.parse(JSON.stringify(envelope))
    ) as RenderableEnvelope;
    const text = renderer(view, context);
    return typeof text === "string" && text.trim() !== "" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replace handler text with coordinator-rendered text and enforce the
 * declared final MCP result byte limit. Returns undefined when even a fully
 * minimized valid envelope cannot fit, causing the caller to fail closed.
 *
 * The envelope is always fitted against the generic one-line summary. A tool
 * with a registered renderer then gets its readable text only if the fitted
 * result still fits with it; a renderer that throws, returns no text, or
 * overflows the budget falls back to the summary. Readable text therefore
 * never costs structured records and never turns a success into an error.
 */
export function finalizeEnvelopeResult(
  result: CallToolResult,
  tool?: string,
  options: EnvelopeTextRenderOptions = {}
): CallToolResult | undefined {
  envelopeTextRenderersSealed = true;
  const summarized = finalizeSummaryResult(result, tool, options.maxResponseBytesCap);
  const renderer =
    tool === undefined ? undefined : ENVELOPE_TEXT_RENDERERS.get(tool);
  if (
    !summarized ||
    !renderer ||
    !isMutableEnvelope(summarized.structuredContent)
  ) {
    return summarized;
  }
  const envelope = summarized.structuredContent;
  const block = summarized.content[0];
  const instanceOrigin = canonicalHttpsOrigin(options.instanceOrigin);
  const text = renderedEnvelopeText(
    renderer,
    envelope,
    Object.freeze({
      summary: block?.type === "text" ? block.text : "",
      ...(instanceOrigin === undefined ? {} : { instanceOrigin }),
    })
  );
  if (text === undefined) return summarized;
  const rendered: CallToolResult = {
    ...summarized,
    content: [{ type: "text", text }],
  };
  return resultBytes(rendered) <= envelope.metadata.limits.max_bytes
    ? rendered
    : summarized;
}

/**
 * The `max_response_bytes` to name for the whole window: what the tool
 * measured for all its rows, plus what the envelope adds around them. Null
 * when the tool named none (the window exceeded the maximum on its own) or
 * when the sum exceeds the maximum, so the hint leaves it out.
 */
function wholeWindowBytes(
  toolHint: TruncationHintParts,
  envelopeBytes: number,
  current: number,
  cap: number
): number | null {
  if (toolHint.allBytes === undefined) return null;
  const needed = neededResponseBytes(toolHint.allBytes + envelopeBytes, current, cap);
  return Number.isFinite(needed) ? needed : null;
}

/**
 * The tools whose `offset` argument is a row offset into the collection they
 * return, so that `offset + rows returned` is the first row not returned. For
 * these a fit that drops rows for size can offer that offset as
 * `next_offset`. Any other collection still reports `has_more`, but with no
 * offset to give: the request has to change.
 */
const OFFSET_PAGED_TOOLS: ReadonlySet<string> = new Set([
  "sn_query",
  "sn_syslog",
  "sn_schema",
  "sn_relationships",
  "sn_codesearch",
  "sn_discover",
  "sn_attach",
  "sn_atf",
  // Every view's `results` page starts at `offset`.
  "sn_platform_view",
]);

/**
 * Fit the result to its byte limit by dropping whole rows from the tail.
 * Rows dropped for size mean rows exist that the response does not hold, so
 * `has_more` is true; the rows returned are a prefix of the window, so a
 * paged tool continues at `offset + rows returned` and loses nothing, and
 * when no row fits there is no offset to give. With no `tool` (a caller that
 * does not say which), the offset is offered as for a paged tool.
 */
function finalizeSummaryResult(
  result: CallToolResult,
  tool?: string,
  byteCap: number = MAX_RESPONSE_BYTES_MAX
): CallToolResult | undefined {
  const offsetPaged = tool === undefined || OFFSET_PAGED_TOOLS.has(tool);
  if (!isMutableEnvelope(result.structuredContent)) return result;
  const sourceEnvelope = JSON.parse(
    JSON.stringify(result.structuredContent)
  ) as MutableEnvelope;
  let candidate = candidateResult(result, sourceEnvelope);
  const maximum = sourceEnvelope.metadata.limits.max_bytes;
  // A tool that dropped rows for size wrote the budget that would hold the
  // next row from what it could measure, the payload alone. Only here is the
  // rest of the result known.
  const toolHint = truncationHintParts(sourceEnvelope.data);
  if (resultBytes(candidate) <= maximum) {
    if (toolHint === undefined || !Number.isFinite(toolHint.neededBytes)) return candidate;
    const overhead = resultBytes(candidate) - Buffer.byteLength(JSON.stringify(sourceEnvelope.data), "utf8");
    const restated = JSON.parse(JSON.stringify(sourceEnvelope)) as MutableEnvelope;
    synchronizePagingFields(
      restated.data,
      restated.metadata.pagination,
      restated.metadata.truncation,
      0,
      neededResponseBytes(toolHint.neededBytes + overhead, maximum, byteCap),
      byteCap,
      wholeWindowBytes(toolHint, overhead, maximum, byteCap)
    );
    const restatedCandidate = candidateResult(result, restated);
    // The larger number can add a digit; if that tips the result over its
    // limit, fit it like any other result that is too big.
    if (resultBytes(restatedCandidate) <= maximum) return restatedCandidate;
  }

  const sourceRecords = collectionFor(tool, sourceEnvelope.data);
  let envelope = sourceEnvelope;
  if (sourceRecords) {
    const originalRecordCount = sourceRecords.length;
    const priorDropped = sourceEnvelope.metadata.truncation.dropped_records ?? 0;
    // While fitting, a hint carries the widest form of its byte budget (the
    // "exceeds the maximum" clause), which is never shorter than a number, so
    // a result that fits that way still fits with the real number.
    const envelopeForCount = (
      count: number,
      neededBytes?: number,
      allBytes?: number | null,
      withoutAdvice?: boolean,
      widestHint?: boolean
    ): MutableEnvelope => {
      const probe = JSON.parse(JSON.stringify(sourceEnvelope)) as MutableEnvelope;
      const probeRecords = collectionFor(tool, probe.data);
      if (!probeRecords) throw new TypeError("collection envelope lost its records");
      probeRecords.splice(count);
      probe.metadata.record_count = count;
      synchronizeRecordCount(probe.data, count);
      if (tool === "sn_syslog" && probe.metadata.pagination.mode === "none" && count < originalRecordCount) {
        restateTailPageAfterFit(probe.data, count);
      }
      if (probe.metadata.pagination.mode === "offset") {
        probe.metadata.pagination.returned = count;
        if (count < originalRecordCount) {
          const paging = probe.metadata.pagination;
          paging.recovery = "adjust_request_and_retry_same_offset";
          paging.has_more = true;
          if (offsetPaged && count > 0) {
            paging.next_offset = paging.offset + count;
          } else {
            delete paging.next_offset;
          }
        }
      }
      applyByteTruncation(
        probe,
        priorDropped + originalRecordCount - count
      );
      synchronizePagingFields(
        probe.data,
        probe.metadata.pagination,
        probe.metadata.truncation,
        0,
        neededBytes,
        byteCap,
        allBytes,
        withoutAdvice,
        widestHint
      );
      return probe;
    };
    const widest = Number.POSITIVE_INFINITY;
    // The forms the hint can take while fitting, fullest first. The labelled
    // hint is longer than the bare one was, and at the smallest budgets the
    // envelope's own metadata leaves room for little more than the counts: the
    // page figure can go, then the field advice, which is the least that
    // still names the next row's budget. A narrower form is used only when no
    // row, not even zero, fits beside the fuller one. Each form's widest text
    // (the longest any real figures could make it) is what rows are sized
    // with, and the real text is rendered in the same form, so it is never
    // longer than the probe. The budget named for the next row is always
    // measured with the fullest form, so a call at that budget, which takes
    // the fullest form that fits, returns the row.
    const forms: ReadonlyArray<{ all: number | null; withoutAdvice: boolean }> =
      toolHint === undefined
        ? [{ all: widest, withoutAdvice: false }]
        : [
            { all: widest, withoutAdvice: false },
            { all: null, withoutAdvice: false },
            { all: null, withoutAdvice: true },
          ];
    let best = -1;
    let form = forms[0] as (typeof forms)[number];
    for (const candidateForm of forms) {
      let low = 0;
      let high = originalRecordCount;
      let fitted = -1;
      while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        const probe = candidateResult(
          result,
          envelopeForCount(midpoint, widest, candidateForm.all, candidateForm.withoutAdvice, true)
        );
        if (resultBytes(probe) <= maximum) {
          fitted = midpoint;
          low = midpoint + 1;
        } else {
          high = midpoint - 1;
        }
      }
      // The first form that fits (zero rows is enough) is the one used.
      form = candidateForm;
      best = fitted;
      if (best >= 0) break;
    }
    // Collections are fitted only by removing complete rows. In particular,
    // never shorten a field merely to force one row into the envelope: callers
    // can retry this exact window with a narrower projection/larger budget,
    // while next_offset (when present) remains the separately authoritative
    // post-window resume point.
    const kept = Math.max(best, 0);
    // A history page's cursors continue after its last event, so an event cut
    // here would be skipped by the next page. The handler fits its own page;
    // one that still does not fit fails rather than lose events.
    if (tool === "sn_history" && kept < originalRecordCount) return undefined;
    envelope = envelopeForCount(kept, widest, form.all, form.withoutAdvice, true);
    candidate = candidateResult(result, envelope);
    if (resultBytes(candidate) > maximum) return undefined;
    if (toolHint === undefined) return candidate;
    // The rows the tool already dropped are not here to measure, so the whole
    // window is its payload size, which the tool measured, plus what this
    // envelope adds around the rows. The envelope of a whole page carries no
    // truncation fields, so this is never too small.
    const overhead = resultBytes(candidate) - Buffer.byteLength(JSON.stringify(envelope.data), "utf8");
    // The budget that would hold one more row is measured here, with the
    // envelope's own cost in it, not guessed. When the fit dropped nothing
    // (the tool had already dropped every row, and only a narrower form
    // fitted) there is no row of ours to add: it is the tool's figure plus
    // the envelope's cost, as in the first branch.
    // With no row returned the envelope carries no `next_offset`, which the
    // first row brings with it, in the data and in the pagination metadata. The
    // zero-row overhead would then name a budget a few bytes short of one row.
    const overheadWithARow = (zeroOrMore: MutableEnvelope, rows: number, base: number): number => {
      if (rows > 0 || !offsetPaged) return base;
      const withRow = JSON.parse(JSON.stringify(zeroOrMore)) as MutableEnvelope;
      const paging = withRow.metadata.pagination;
      if (paging.mode !== "offset") return base;
      paging.returned = 1;
      paging.next_offset = paging.offset + 1;
      synchronizePagingFields(
        withRow.data,
        withRow.metadata.pagination,
        withRow.metadata.truncation,
        0,
        undefined,
        byteCap
      );
      return (
        resultBytes(candidateResult(result, withRow)) -
        Buffer.byteLength(JSON.stringify(withRow.data), "utf8")
      );
    };
    const needed =
      kept >= originalRecordCount
        ? neededResponseBytes(
            toolHint.neededBytes + overheadWithARow(envelope, kept, overhead),
            maximum,
            byteCap
          )
        : neededResponseBytes(
            resultBytes(
              candidateResult(
                result,
                envelopeForCount(
                  kept + 1,
                  widest,
                  (forms[0] as (typeof forms)[number]).all,
                  false,
                  true
                )
              )
            ),
            maximum,
            byteCap
          );
    const restated = candidateResult(
      result,
      envelopeForCount(
        kept,
        needed,
        form.all === null ? null : wholeWindowBytes(toolHint, overhead, maximum, byteCap),
        form.withoutAdvice
      )
    );
    return resultBytes(restated) <= maximum ? restated : candidate;
  }

  while (
    resultBytes(candidate) > maximum &&
    (dropDerivedDiagram(envelope.data) || truncateLongestString(envelope.data))
  ) {
    applyByteTruncation(
      envelope,
      envelope.metadata.truncation.dropped_records ?? 0
    );
    synchronizePagingFields(
      envelope.data,
      envelope.metadata.pagination,
      envelope.metadata.truncation
    );
    candidate = candidateResult(result, envelope);
  }
  return resultBytes(candidate) <= maximum ? candidate : undefined;
}
