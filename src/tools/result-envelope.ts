/** Shared SNSDK-33 structured-result contracts and compatibility adapter. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  MAX_RESPONSE_BYTES_DEFAULT,
  MAX_RESPONSE_BYTES_MAX,
  MAX_RESPONSE_BYTES_MIN,
} from "../utils.js";
import { withResolvedProfileOutput } from "./tool-module.js";

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
    if (
      value.has_more &&
      (value.next_offset === undefined || value.next_offset <= value.offset)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "next_offset must advance beyond offset when has_more is true",
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
  })
  .strict();

export function withStructuredResultEnvelope<TSchema extends z.ZodTypeAny>(
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

const dynamicRecordSchema = z.record(z.unknown());
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
  sn_syslog: queryResultSchema,
  sn_codesearch: listResultSchema,
  sn_discover: listResultSchema,
  sn_atf: atfResultEnvelopeSchema,
  sn_nl: naturalLanguageResultSchema,
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
  sn_nl: withStructuredResultEnvelope(productionDataSchemas.sn_nl),
  sn_profile: withStructuredResultEnvelope(productionDataSchemas.sn_profile),
});

export function isProductionToolName(name: string): name is ProductionToolName {
  return Object.hasOwn(productionToolOutputSchemas, name);
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

function collectionArray(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.results)) return record.results;
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
  return DEFAULT_RESULT_BYTE_LIMIT;
}

function resultKind(
  name: ProductionToolName,
  data: unknown
): MutableMetadata["kind"] {
  if (collectionArray(data)) return "collection";
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
      return ["table", "sys_id"];
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

function synchronizePagingFields(
  data: unknown,
  pagination: MutableMetadata["pagination"],
  truncation: MutableMetadata["truncation"],
  depth = 0
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
      if (Object.hasOwn(target, "next_offset")) {
        target.next_offset = pagination.next_offset;
      }
    } else if (Object.hasOwn(target, "next_offset")) {
      delete target.next_offset;
    }
    if (Object.hasOwn(target, "truncated")) {
      target.truncated = truncation.truncated;
    }
    if (Object.hasOwn(target, "dropped_records")) {
      if (truncation.dropped_records === undefined) {
        delete target.dropped_records;
      } else {
        target.dropped_records = truncation.dropped_records;
      }
    }
  };
  synchronizeObject(record);
  if (typeof record.meta === "object" && record.meta !== null) {
    synchronizeObject(record.meta as Record<string, unknown>);
  }
  for (const wrapper of ["request", "result"] as const) {
    synchronizePagingFields(record[wrapper], pagination, truncation, depth + 1);
  }
}

export function envelopeCompatibilityResult(
  name: ProductionToolName,
  args: Readonly<Record<string, unknown>>,
  result: CallToolResult
): CallToolResult {
  if (result.isError) return result;
  const data = normalizeToolData(name, args, parseHandlerJson(result));
  const records = collectionArray(data);
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
  let hasMore =
    collection &&
    (originalCount > returned ||
      explicitHasMore === true ||
      (explicitHasMore === undefined && returned >= limit));
  let nextOffset: number | undefined;
  let recovery: "adjust_request_and_retry_same_offset" | undefined =
    legacyTruncated ? "adjust_request_and_retry_same_offset" : undefined;
  if (hasMore) {
    if (explicitNextOffset !== undefined && explicitNextOffset > offset) {
      nextOffset = explicitNextOffset;
    } else if (originalCount > returned && returned > 0) {
      nextOffset = offset + returned;
    } else if (returned > 0) {
      // An explicit has_more without a usable next offset means the upstream
      // window, not merely the delivered rows, is authoritative. Advancing by
      // the effective limit prevents ACL-filtered windows from being replayed.
      nextOffset = offset + limit;
    } else {
      hasMore = false;
      recovery = "adjust_request_and_retry_same_offset";
    }
  }
  const droppedByRecordLimit = originalCount - returned;
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
    pagination: collection
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
  const continuation =
    pagination.mode === "offset" && pagination.has_more
      ? ` More records are available at offset ${pagination.next_offset}.`
      : "";
  const recovery =
    pagination.mode === "offset" && pagination.recovery !== undefined
      ? pagination.has_more
        ? ` To recover records dropped from the current window, adjust the request and retry offset ${pagination.offset}; use offset ${pagination.next_offset} only to resume after the consumed window.`
        : ` No automatic post-window continuation is available; adjust the request and retry offset ${pagination.offset}.`
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
 * Replace handler text with a coordinator-rendered summary and enforce the
 * declared final MCP result byte limit. Returns undefined when even a fully
 * minimized valid envelope cannot fit, causing the caller to fail closed.
 */
export function finalizeEnvelopeResult(
  result: CallToolResult
): CallToolResult | undefined {
  if (!isMutableEnvelope(result.structuredContent)) return result;
  const sourceEnvelope = JSON.parse(
    JSON.stringify(result.structuredContent)
  ) as MutableEnvelope;
  let candidate = candidateResult(result, sourceEnvelope);
  const maximum = sourceEnvelope.metadata.limits.max_bytes;
  if (resultBytes(candidate) <= maximum) return candidate;

  const sourceRecords = collectionArray(sourceEnvelope.data);
  let envelope = sourceEnvelope;
  if (sourceRecords) {
    const originalRecordCount = sourceRecords.length;
    const priorDropped = sourceEnvelope.metadata.truncation.dropped_records ?? 0;
    const envelopeForCount = (count: number): MutableEnvelope => {
      const probe = JSON.parse(JSON.stringify(sourceEnvelope)) as MutableEnvelope;
      const probeRecords = collectionArray(probe.data);
      if (!probeRecords) throw new TypeError("collection envelope lost its records");
      probeRecords.splice(count);
      probe.metadata.record_count = count;
      synchronizeRecordCount(probe.data, count);
      if (probe.metadata.pagination.mode === "offset") {
        probe.metadata.pagination.returned = count;
        if (count < originalRecordCount) {
          probe.metadata.pagination.recovery =
            "adjust_request_and_retry_same_offset";
        }
      }
      applyByteTruncation(
        probe,
        priorDropped + originalRecordCount - count
      );
      synchronizePagingFields(
        probe.data,
        probe.metadata.pagination,
        probe.metadata.truncation
      );
      return probe;
    };
    let low = 0;
    let high = originalRecordCount;
    let best = -1;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const probe = candidateResult(result, envelopeForCount(midpoint));
      if (resultBytes(probe) <= maximum) {
        best = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    // Collections are fitted only by removing complete rows. In particular,
    // never shorten a field merely to force one row into the envelope: callers
    // can retry this exact window with a narrower projection/larger budget,
    // while next_offset (when present) remains the separately authoritative
    // post-window resume point.
    envelope = envelopeForCount(Math.max(best, 0));
    candidate = candidateResult(result, envelope);
    return resultBytes(candidate) <= maximum ? candidate : undefined;
  }

  while (resultBytes(candidate) > maximum && truncateLongestString(envelope.data)) {
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
