import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  runWithServiceNowRequestSignal,
  type ServiceNowOperations,
} from "../client.js";
import { BATCH_LIMITS } from "../batch-limits.js";
import type { ExecutionContext } from "../execution-context.js";
import { uncachedOperations } from "../metadata-cache.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  ENCODED_QUERY_MIGRATION_MESSAGE,
  EncodedQueryPolicyError,
  rejectRawEncodedWrite,
} from "../encoded-query-policy.js";
import {
  filterReadableRecord,
  isAllFieldSelection,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { ok, err } from "../utils.js";
import { serviceNowSysIdPathSegment } from "../servicenow-identifiers.js";
import {
  compileStructuredQuery,
  structuredQuerySchema,
} from "../structured-query.js";
import {
  trustedToolErrorDescriptor,
  type ToolErrorCategory,
  type ToolErrorDescriptor,
} from "../tool-error.js";
import { prepareWriteFieldValues } from "../write-value-policy.js";

const structuredWriteQuerySchema = structuredQuerySchema.refine(
  (query) => query.filter !== undefined,
  { message: "Batch mutations require structured_query.filter" }
);

export const definition = {
  name: "sn_batch",
  description:
    "Bulk update or delete records matching policy-authorized structured filters. Runs in dry-run mode by default — set confirm to true to execute. Raw encoded queries are prohibited. Safety cap at 10,000 records.",
  annotations: {
    title: "Bulk update/delete records",
    readOnlyHint: false,
    destructiveHint: true,
    // The matched record set is re-queried on every run, so repeats can
    // touch different records.
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const schema = z
  .object({
    table: z.string().describe("ServiceNow table name"),
    structured_query: structuredWriteQuerySchema.describe(
      "Required policy-authorized structured filter selecting records. Raw encoded queries are prohibited."
    ),
    action: z
      .enum(["update", "delete"])
      .describe("Operation to perform: update or delete"),
    fields: z
      .record(z.unknown())
      .optional()
      .describe(
        'JSON fields to set on each record (required for update action). e.g. {"state":"7","close_notes":"Bulk closed"}'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(BATCH_LIMITS.maxLimit)
      .optional()
      .default(BATCH_LIMITS.defaultLimit)
      .describe("Max records to affect (default 200, safety cap 10000)"),
    confirm: z
      .boolean()
      .optional()
      .default(false)
      .describe("Set to true to actually execute. Default is dry-run."),
  })
  .strict(ENCODED_QUERY_MIGRATION_MESSAGE);

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  context: ExecutionContext
) {
  try {
    rejectRawEncodedWrite(
      (args as unknown as Readonly<Record<string, unknown>>).query
    );
    if (args.action === "update" && !args.fields) {
      return err("--fields is required for update action");
    }
    // The same field and value policy as sn_create and sn_update, including
    // the journal bounds for comments/work_notes. Preflight already applied
    // it; repeating it keeps a direct handler call equally bounded, and the
    // canonical strings are what goes upstream.
    const writableFields =
      args.action === "update"
        ? prepareWriteFieldValues("update", args.table, args.fields)
        : undefined;
    const readableFields =
      preparedReadableFields(args, args.table) ??
      resolveReadableFields(args.table, { fields: "sys_id" });
    const structuredPlan = compileStructuredQuery(
      args.structured_query,
      resolveReadableFields(args.table, { fields: "all" })
    );
    if (structuredPlan.structuredQuery.filter === undefined) {
      throw new EncodedQueryPolicyError("encoded_write_prohibited");
    }

    const limit = Math.min(args.limit, BATCH_LIMITS.maxLimit);

    // Step 1: Query matching records (sys_id only). These are the records the
    // run will change, so they come from the instance on every run, never
    // from the metadata cache: a cached answer can be stale within the
    // watermark's gaps, and would update or delete records that no longer
    // match.
    const resp = await uncachedOperations(client).get(`/api/now/table/${args.table}`, {
      sysparm_fields: "sys_id",
      sysparm_limit: String(limit),
      sysparm_query: structuredPlan.encodedQuery,
    });

    const filtered = filterReadableRecord(resp.result || [], readableFields);
    const results = Array.isArray(filtered)
      ? (filtered.filter(
          (record): record is Record<string, unknown> =>
            typeof record === "object" && record !== null && !Array.isArray(record)
        ))
      : [];
    const targets = targetSysIds(results);
    const matched = targets.sysIds.length + targets.invalid;

    // Step 2: Dry-run?
    if (!args.confirm) {
      const sample = await dryRunSample(
        client,
        args.table,
        targets.sysIds,
        resolveReadableFields(args.table, { fields: "all" }),
        context?.signal
      );
      return ok({
        action: args.action,
        table: args.table,
        matched,
        dry_run: true,
        message: "Dry run — no changes made. Set confirm to true to execute.",
        ...(sample.length === 0 ? {} : { sample }),
        // Names only, never values: the values are the caller's own input.
        ...(writableFields === undefined
          ? {}
          : { fields_to_write: Object.keys(writableFields) }),
        note: DRY_RUN_NOTE,
      });
    }

    if (matched === 0) {
      return ok({
        action: args.action,
        table: args.table,
        matched: 0,
        processed: 0,
        failed: 0,
      });
    }

    // Step 3: Execute through the ServiceNow REST Batch API. Serial Table API
    // calls are used only when the instance refused a batch request before
    // running any of it, so no change is ever sent twice.
    const execution = await executeBatchMutation(
      client,
      args.table,
      args.action,
      targets,
      writableFields,
      // A direct handler call may pass no context; it then keeps the single
      // budget of whatever scope it runs in.
      context?.signal
    );
    const { processed, failed, message } = execution;

    return ok({
      action: args.action,
      table: args.table,
      matched,
      processed,
      failed,
      ...(message === undefined ? {} : { message }),
    });
  } catch (error) {
    throw error;
  }
}

/** Records a dry run shows. */
const DRY_RUN_SAMPLE_SIZE = BATCH_LIMITS.dryRunSampleSize;
/** Longest display value a sample row carries. */
const DRY_RUN_DISPLAY_MAX_CHARS = 120;
/** Readable fields that identify a record to a person, in order of preference. */
const DRY_RUN_DISPLAY_FIELDS: readonly string[] = Object.freeze([
  "number",
  "name",
  "short_description",
  "title",
]);
const DRY_RUN_SAMPLE_DEADLINE_MS = 5_000;
const DRY_RUN_NOTE =
  "The sample is a preview of the first matches, not a list of what will change. " +
  "Running again with confirm true re-runs the query, so it can match different " +
  "records than this dry run did.";

interface DryRunSampleRow {
  sys_id: string;
  display?: string;
}

/**
 * The one extra read a dry run makes: at most DRY_RUN_SAMPLE_SIZE records,
 * addressed by the sys_ids the lookup already returned, so the preview shows
 * rows from that same result rather than a second evaluation of the filter.
 * It asks only for sys_id and one display field the profile may read, and the
 * rows pass the same readable-field filter as the lookup. It is skipped when
 * nothing matched, and a failed response yields no sample rather than failing
 * the dry run: the count is already in hand.
 */
async function dryRunSample(
  client: ServiceNowOperations,
  table: string,
  sysIds: readonly string[],
  readable: readonly string[],
  signal: AbortSignal | undefined
): Promise<DryRunSampleRow[]> {
  const ids = sysIds.slice(0, DRY_RUN_SAMPLE_SIZE);
  if (ids.length === 0) return [];
  const readableAll = isAllFieldSelection(readable);
  const allows = (field: string): boolean => readableAll || readable.includes(field);
  if (!allows("sys_id")) return [];
  const displayField = DRY_RUN_DISPLAY_FIELDS.find(allows);
  const selection = Object.freeze(
    displayField === undefined ? ["sys_id"] : ["sys_id", displayField]
  );
  let response: { result?: unknown } | null;
  try {
    // A short deadline: the count is already in hand, so a slow instance
    // costs the preview, never the dry run.
    const deadline = AbortSignal.timeout(DRY_RUN_SAMPLE_DEADLINE_MS);
    response = await inOwnResponseBudget(
      signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      () =>
      uncachedOperations(client).get(`/api/now/table/${table}`, {
        sysparm_fields: selection.join(","),
        sysparm_limit: String(DRY_RUN_SAMPLE_SIZE),
        sysparm_query: `sys_idIN${ids.join(",")}`,
      })
    );
  } catch (error) {
    // A cancelled call stays cancelled; any other failure only drops the preview.
    if (signal?.aborted) throw error;
    return [];
  }
  const filtered = filterReadableRecord(
    Array.isArray(response?.result) ? response.result : [],
    selection
  );
  const rows: DryRunSampleRow[] = [];
  // Only rows for the sys_ids asked for, each once: the sample must come from
  // the matched set, whatever the instance answers.
  const requested = new Set(ids);
  const shown = new Set<string>();
  for (const record of Array.isArray(filtered) ? filtered : []) {
    const item = plainRecord(record);
    if (item === undefined) continue;
    let sysId: string;
    try {
      sysId = serviceNowSysIdPathSegment(item.sys_id);
    } catch {
      continue;
    }
    if (!requested.has(sysId) || shown.has(sysId)) continue;
    shown.add(sysId);
    const display =
      displayField === undefined ? undefined : displayText(item[displayField]);
    rows.push(display === undefined ? { sys_id: sysId } : { sys_id: sysId, display });
    if (rows.length === DRY_RUN_SAMPLE_SIZE) break;
  }
  return rows;
}

/** A display value is text; a reference object contributes its own display text. */
function displayText(candidate: unknown): string | undefined {
  const reference = plainRecord(candidate);
  const value =
    typeof candidate === "string"
      ? candidate
      : typeof reference?.display_value === "string"
        ? reference.display_value
        : undefined;
  if (value === undefined || value === "") return undefined;
  return value.length > DRY_RUN_DISPLAY_MAX_CHARS
    ? `${value.slice(0, DRY_RUN_DISPLAY_MAX_CHARS)}…`
    : value;
}

const REST_BATCH_CHUNK_SIZE = BATCH_LIMITS.restBatchChunkSize;
const REST_BATCH_PATH = "/api/now/v1/batch";

/**
 * Target size of one batch request body. ServiceNow caps REST request
 * payloads (about 10 MB by default), and an oversized batch that is refused
 * has an unknown outcome, so a chunk holds fewer records when values are
 * large. A request stays under this size unless one record's fields alone
 * exceed about 3 MiB of JSON; such a record is sent one per request, because
 * a chunk never holds fewer than one record.
 */
const MAX_BATCH_REQUEST_BYTES = 4 * 1024 * 1024;
/**
 * Upper bound on the JSON one `rest_requests` entry adds besides its body and
 * table name: id, method, url, headers and exclude_response_headers.
 */
const REST_BATCH_REQUEST_OVERHEAD_BYTES = 300;

/**
 * A sub-request that returns a 5xx or 408 inside a readable batch response
 * is unconfirmed and never retried, but the run continues: the instance is
 * answering, and every other record is still sent at most once. Past this
 * many unconfirmed records in one run, the run stops and reports the rest as
 * not sent, because that many server errors suggest an unhealthy instance.
 */
const MAX_UNCONFIRMED_SUB_REQUESTS = 10;

/**
 * Failure categories that mean ServiceNow refused a batch request before
 * running any request in it, and that serial calls can work around: the
 * Batch API is missing or not permitted for this credential. Only these fall
 * back to serial calls. Any other failure, and every 2xx response, can follow
 * a batch ServiceNow already applied in whole or in part. Replaying it would
 * apply a change twice, which for a journal field is a duplicate entry.
 *
 * A rate limit (429) also means nothing ran, but it is not in the set: serial
 * calls would add one request per record to the limit the instance is
 * enforcing. The run stops instead and reports the Retry-After hint.
 */
const BATCH_REFUSED_BEFORE_PROCESSING: ReadonlySet<ToolErrorCategory> = new Set<
  ToolErrorCategory
>(["authentication", "authorization", "not_found"]);

/** Per-request headers, as the documented Batch API takes them. */
const JSON_BODY_HEADERS = Object.freeze([
  Object.freeze({ name: "Content-Type", value: "application/json" }),
  Object.freeze({ name: "Accept", value: "application/json" }),
]);
const JSON_ACCEPT_HEADERS = Object.freeze([
  Object.freeze({ name: "Accept", value: "application/json" }),
]);

interface BatchExecutionResult {
  readonly processed: number;
  readonly failed: number;
  readonly message?: string;
}

/** Every matched record lands in exactly one of these counts. */
interface MutationTally {
  readonly processed: number;
  /** Includes unserviced records; excludes records never sent. */
  readonly failed: number;
  /** Listed by ServiceNow in unserviced_requests: not run, counted as failed. */
  readonly unserviced: number;
  /** Not confirmed either way: may have been applied, never retried. */
  readonly unconfirmed: number;
  /** Of the unconfirmed: a sub-request ServiceNow answered with 5xx or 408. */
  readonly serverErrors?: number;
  /** Never sent because the run stopped; counted as failed. */
  readonly notSent: number;
  /** Set when the run stopped on a rate limit (HTTP 429). */
  readonly rateLimited?: Readonly<{ retryAfterSeconds?: number }>;
  /** Set when the run stopped because ServiceNow rejected the credentials. */
  readonly authenticationFailed?: true;
  /** Why a run stopped after ServiceNow answered a batch request with a 2xx. */
  readonly stoppedOn?: "unreadable_response" | "server_errors" | "unconfirmed_limit";
}

/** The records one run changes: each valid sys_id once. */
interface BatchTargets {
  readonly sysIds: readonly string[];
  /** Lookup rows without a valid sys_id; counted as failed. */
  readonly invalid: number;
}

interface RestBatchRequest {
  readonly id: string;
  readonly method: "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: readonly Readonly<{ name: string; value: string }>[];
  readonly exclude_response_headers: true;
  readonly body?: string;
}

interface ChunkOutcome {
  readonly processed: number;
  /** Serviced with a 4xx, or listed as unserviced. */
  readonly failed: number;
  readonly unserviced: number;
  /** Serviced with a 5xx or 408: may have been applied. */
  readonly serverErrors: number;
  /**
   * Missing from the response or reported more than once: the response
   * cannot be attributed, so it is treated like an unreadable one.
   */
  readonly unattributed: number;
}

/**
 * Validate and de-duplicate the sys_ids the lookup returned. The lookup can
 * name a record more than once; each record is changed at most once per run,
 * so a journal entry is never appended twice to it.
 */
function targetSysIds(records: readonly Record<string, unknown>[]): BatchTargets {
  const unique = new Set<string>();
  let invalid = 0;
  for (const record of records) {
    try {
      unique.add(serviceNowSysIdPathSegment(record.sys_id));
    } catch {
      invalid += 1;
    }
  }
  return { sysIds: [...unique], invalid };
}

/**
 * Apply one update or delete to every matched record through the documented
 * REST Batch API (`POST /api/now/v1/batch`), up to 50 requests per batch and
 * at most MAX_BATCH_REQUEST_BYTES per request body.
 *
 * Request: `rest_requests[]` with `id`, `method`, `url`, `headers` as
 * name/value pairs, and a base64-encoded `body`. Response:
 * `serviced_requests[]` with `id` and `status_code`, plus
 * `unserviced_requests[]` with the ids ServiceNow did not run.
 *
 * A batch request is never replayed. Serial Table API calls replace it only
 * when ServiceNow refused the request before running any of it.
 *
 * The run stops, reporting the rest as not sent, when a batch request fails
 * or its response cannot be read or attributed, when every serviced
 * sub-request in a batch returns a server error, or when more than
 * MAX_UNCONFIRMED_SUB_REQUESTS records are unconfirmed. An isolated
 * sub-request server error is reported as unconfirmed and the run continues.
 */
async function executeBatchMutation(
  client: ServiceNowOperations,
  table: string,
  action: "update" | "delete",
  targets: BatchTargets,
  fields: Readonly<Record<string, string>> | undefined,
  signal: AbortSignal | undefined
): Promise<BatchExecutionResult> {
  let processed = 0;
  let failed = targets.invalid;
  let unserviced = 0;
  let unconfirmed = 0;
  let serverErrors = 0;
  const { sysIds } = targets;
  const body = action === "update" ? encodeBatchBody(fields ?? {}) : undefined;
  const chunkSize = batchChunkSize(table, body);

  for (let offset = 0; offset < sysIds.length; offset += chunkSize) {
    const chunk = sysIds.slice(offset, offset + chunkSize);
    const requests = chunk.map((sysId, index) =>
      restBatchRequest(table, action, sysId, String(offset + index + 1), body)
    );
    let response: unknown;
    try {
      response = await inOwnResponseBudget(signal, () =>
        client.post<unknown>(REST_BATCH_PATH, {
          batch_request_id: `sn_batch_${Date.now()}_${offset}`,
          rest_requests: requests,
        })
      );
    } catch (error) {
      const descriptor = trustedToolErrorDescriptor(error);
      if (
        descriptor !== undefined &&
        BATCH_REFUSED_BEFORE_PROCESSING.has(descriptor.category)
      ) {
        // Nothing in this batch ran. The records from here on go through the
        // Table API one at a time; earlier batches are confirmed and are not
        // sent again.
        const serial = await executeSerialMutation(
          client,
          table,
          action,
          sysIds.slice(offset),
          fields,
          signal
        );
        return batchResult({
          ...serial,
          processed: processed + serial.processed,
          failed: failed + serial.failed,
          unserviced,
          unconfirmed: unconfirmed + serial.unconfirmed,
          serverErrors,
        });
      }
      if (descriptor?.category === "rate_limit") {
        // Nothing in this batch ran, and the client already retried it.
        return batchResult({
          processed,
          failed,
          unserviced,
          unconfirmed,
          serverErrors,
          notSent: sysIds.length - offset,
          rateLimited: { retryAfterSeconds: descriptor.retryAfterSeconds },
        });
      }
      // The request may have reached ServiceNow and been applied.
      return batchResult({
        processed,
        failed,
        unserviced,
        unconfirmed: unconfirmed + chunk.length,
        serverErrors,
        notSent: sysIds.length - offset - chunk.length,
      });
    }
    const outcome = chunkOutcome(
      response,
      requests.map(({ id }) => id)
    );
    processed += outcome.processed;
    failed += outcome.failed;
    unserviced += outcome.unserviced;
    unconfirmed += outcome.serverErrors + outcome.unattributed;
    serverErrors += outcome.serverErrors;
    const serviced =
      outcome.processed + outcome.failed - outcome.unserviced + outcome.serverErrors;
    const stoppedOn: MutationTally["stoppedOn"] =
      outcome.unattributed > 0
        ? "unreadable_response"
        : outcome.serverErrors > 0 && outcome.serverErrors === serviced
          ? "server_errors"
          : unconfirmed > MAX_UNCONFIRMED_SUB_REQUESTS
            ? "unconfirmed_limit"
            : undefined;
    if (stoppedOn !== undefined) {
      return batchResult({
        processed,
        failed,
        unserviced,
        unconfirmed,
        serverErrors,
        notSent: sysIds.length - offset - chunk.length,
        stoppedOn,
      });
    }
  }
  return batchResult({
    processed,
    failed,
    unserviced,
    unconfirmed,
    serverErrors,
    notSent: 0,
  });
}

/**
 * Run one upstream request with its own response-byte budget, bound to the
 * tool call's cancellation signal.
 *
 * A single per-call budget would cut a large run short: the sys_id lookup and
 * every batch response draw on it, so a 10,000-record update would stop after
 * about 3,400 records. Each response is still capped by the client, and is
 * parsed and dropped before the next request, so memory stays bounded by one
 * chunk. Without a signal (a direct handler call) the request runs in the
 * caller's scope.
 */
function inOwnResponseBudget<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return signal instanceof AbortSignal
    ? runWithServiceNowRequestSignal(signal, operation)
    : operation();
}

/** Up to 50 records, fewer when the encoded body is large. */
function batchChunkSize(table: string, body: string | undefined): number {
  const perRequestBytes =
    (body?.length ?? 0) + table.length + REST_BATCH_REQUEST_OVERHEAD_BYTES;
  return Math.max(
    1,
    Math.min(
      REST_BATCH_CHUNK_SIZE,
      Math.floor(MAX_BATCH_REQUEST_BYTES / perRequestBytes)
    )
  );
}

function restBatchRequest(
  table: string,
  action: "update" | "delete",
  sysId: string,
  id: string,
  body: string | undefined
): RestBatchRequest {
  if (action === "update") {
    return {
      id,
      method: "PATCH",
      // Only sys_id comes back per record, which keeps each batch response
      // small and its parse cheap.
      url: `/api/now/table/${table}/${sysId}?sysparm_fields=sys_id`,
      headers: JSON_BODY_HEADERS,
      exclude_response_headers: true,
      body,
    };
  }
  return {
    id,
    method: "DELETE",
    url: `/api/now/table/${table}/${sysId}`,
    headers: JSON_ACCEPT_HEADERS,
    exclude_response_headers: true,
  };
}

/** Base64 text is ASCII, so its length is its byte count. */
function encodeBatchBody(fields: Readonly<Record<string, string>>): string {
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64");
}

/**
 * Count one batch response against the ids that were sent. An id ServiceNow
 * neither serviced nor listed as unserviced is unattributed, and so is an id
 * reported more than once, because its result cannot be attributed.
 *
 * A sub-request answered with a 5xx or a 408 is a server error. It is
 * reported as unconfirmed, matching the serial path: a server error can
 * follow a change that was partly applied (ServiceNow does not roll back a
 * journal insert when a later business rule fails), so it must not read as
 * "failed, safe to re-run".
 */
function chunkOutcome(response: unknown, ids: readonly string[]): ChunkOutcome {
  const requested = new Set(ids);
  const statuses = new Map<string, number | undefined>();
  const notServiced = new Set<string>();
  const root = plainRecord(response);

  const serviced = root?.serviced_requests;
  if (Array.isArray(serviced)) {
    for (const entry of serviced) {
      const item = plainRecord(entry);
      if (item === undefined) continue;
      const id = batchRequestId(item.id);
      if (id === undefined || !requested.has(id)) continue;
      statuses.set(id, statuses.has(id) ? undefined : statusCode(item.status_code));
    }
  }
  const unservicedEntries = root?.unserviced_requests;
  if (Array.isArray(unservicedEntries)) {
    for (const entry of unservicedEntries) {
      const id = batchRequestId(entry) ?? batchRequestId(plainRecord(entry)?.id);
      if (id !== undefined && requested.has(id) && !statuses.has(id)) {
        notServiced.add(id);
      }
    }
  }

  let processed = 0;
  let failed = 0;
  let serverErrors = 0;
  let unattributed = 0;
  for (const id of ids) {
    const status = statuses.get(id);
    if (status !== undefined) {
      if (status >= 200 && status < 300) {
        processed += 1;
      } else if (status >= 500 || status === 408) {
        serverErrors += 1;
      } else {
        failed += 1;
      }
    } else if (notServiced.has(id)) {
      failed += 1;
    } else {
      unattributed += 1;
    }
  }
  return {
    processed,
    failed,
    unserviced: notServiced.size,
    serverErrors,
    unattributed,
  };
}

function batchResult(tally: MutationTally): BatchExecutionResult {
  const notes: string[] = [];
  if (tally.unconfirmed > 0) {
    const serverErrors = tally.serverErrors ?? 0;
    notes.push(
      `ServiceNow did not confirm the outcome for ${tally.unconfirmed} record(s)` +
        (serverErrors === 0
          ? ". "
          : `; ${serverErrors} of them returned a server error (HTTP 5xx or ` +
            "408), which can follow a partly applied change. ") +
        "They may have been changed. The run has not retried them. A journal " +
        "write (comments, work_notes) is never re-sent, but when records are " +
        "sent one at a time, other fields may have been sent up to three " +
        "times by the HTTP client's retry on a transient error. Check them " +
        "before running the batch again."
    );
  }
  if (tally.stoppedOn === "server_errors") {
    notes.push(
      "Every serviced record in one batch returned a server error, so nothing " +
        "more was sent."
    );
  } else if (tally.stoppedOn === "unconfirmed_limit") {
    notes.push(
      `More than ${MAX_UNCONFIRMED_SUB_REQUESTS} records had an unconfirmed ` +
        "outcome, so nothing more was sent."
    );
  }
  if (tally.authenticationFailed === true) {
    notes.push(
      "ServiceNow rejected the credentials (HTTP 401), so nothing more was sent."
    );
  }
  if (tally.rateLimited !== undefined) {
    const retryAfter = tally.rateLimited.retryAfterSeconds;
    notes.push(
      "ServiceNow rate-limited the request (HTTP 429), so nothing more was sent." +
        (retryAfter === undefined ? "" : ` Retry after ${retryAfter} seconds.`)
    );
  }
  if (tally.notSent > 0) {
    notes.push(
      `The remaining ${tally.notSent} record(s) were not sent and are counted as failed.`
    );
  }
  if (tally.unserviced > 0) {
    notes.push(
      `ServiceNow did not process ${tally.unserviced} record(s) because a batch ` +
        "reached a size or time limit. They are counted as failed."
    );
  }
  return {
    processed: tally.processed,
    failed: tally.failed + tally.notSent,
    ...(notes.length === 0 ? {} : { message: notes.join(" ") }),
  };
}

function plainRecord(candidate: unknown): Record<string, unknown> | undefined {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function batchRequestId(candidate: unknown): string | undefined {
  if (typeof candidate === "string" && candidate !== "") return candidate;
  if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
    return String(candidate);
  }
  return undefined;
}

function statusCode(candidate: unknown): number | undefined {
  const status =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && /^[1-5][0-9]{2}$/u.test(candidate)
        ? Number(candidate)
        : undefined;
  return status !== undefined &&
    Number.isSafeInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

/**
 * One Table API call per record, each with its own response budget. The run
 * stops at the first failure whose outcome is unknown, at a rate limit, or at
 * an authentication failure (a 401 the client could not refresh); the records
 * after it are reported as not sent. Sending them would only repeat the same
 * rejection, and repeated failed logins can trip an account lockout.
 */
async function executeSerialMutation(
  client: ServiceNowOperations,
  table: string,
  action: "update" | "delete",
  sysIds: readonly string[],
  fields: Readonly<Record<string, string>> | undefined,
  signal: AbortSignal | undefined
): Promise<MutationTally> {
  let processed = 0;
  let failed = 0;
  for (const [index, sysId] of sysIds.entries()) {
    const path = `/api/now/table/${table}/${sysId}`;
    try {
      if (action === "update") {
        await inOwnResponseBudget(signal, () => client.patch(path, fields));
        processed += 1;
      } else {
        const delResp = await inOwnResponseBudget(signal, () => client.delete(path));
        if (delResp.status === 204 || delResp.status === 200) processed += 1;
        else failed += 1;
      }
    } catch (error) {
      const notSent = sysIds.length - index - 1;
      const descriptor = trustedToolErrorDescriptor(error);
      if (descriptor?.category === "rate_limit") {
        return {
          processed,
          failed: failed + 1,
          unserviced: 0,
          unconfirmed: 0,
          notSent,
          rateLimited: { retryAfterSeconds: descriptor.retryAfterSeconds },
        };
      }
      if (descriptor?.category === "authentication") {
        // Rejected before processing, so this record failed definitely.
        return {
          processed,
          failed: failed + 1,
          unserviced: 0,
          unconfirmed: 0,
          notSent,
          authenticationFailed: true,
        };
      }
      if (!serialFailureIsDefinite(descriptor)) {
        return { processed, failed, unserviced: 0, unconfirmed: 1, notSent };
      }
      failed += 1;
    }
  }
  return { processed, failed, unserviced: 0, unconfirmed: 0, notSent: 0 };
}

/**
 * True when a single-record PATCH or DELETE failed with a status that means
 * ServiceNow did not apply it, and the run can continue with the next record.
 * For these methods the client classifies a 4xx it has no category for as
 * `upstream` with `do_not_retry`, and a 5xx or connection failure as
 * `upstream` with `retry_if_safe_and_idempotent`. A 5xx, a timeout, a
 * connection failure, or an unreadable or over-budget response may follow an
 * applied write, so its outcome is unknown. Authentication and rate-limit
 * failures stop the run before this is consulted.
 */
function serialFailureIsDefinite(descriptor: ToolErrorDescriptor | undefined): boolean {
  if (descriptor === undefined) return false;
  switch (descriptor.category) {
    case "authorization":
    case "not_found":
    case "conflict":
      return true;
    case "upstream":
      return descriptor.retry === "do_not_retry";
    default:
      return false;
  }
}
