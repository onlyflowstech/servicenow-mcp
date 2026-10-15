import { Buffer } from "node:buffer";
import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  ENCODED_QUERY_MIGRATION_MESSAGE,
  EncodedQueryPolicyError,
  rejectRawEncodedWrite,
} from "../encoded-query-policy.js";
import {
  filterReadableRecord,
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
      .max(10_000)
      .optional()
      .default(200)
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
  _context: ExecutionContext
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

    const limit = Math.min(args.limit, 10000);

    // Step 1: Query matching records (sys_id only)
    const resp = await client.get(`/api/now/table/${args.table}`, {
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
    const matched = results.length;

    // Step 2: Dry-run?
    if (!args.confirm) {
      return ok({
        action: args.action,
        table: args.table,
        matched,
        dry_run: true,
        message: "Dry run — no changes made. Set confirm to true to execute.",
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
      results,
      writableFields
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

const REST_BATCH_CHUNK_SIZE = 50;
const REST_BATCH_PATH = "/api/now/v1/batch";

/**
 * Failure categories that mean ServiceNow refused a batch request before
 * running any request in it: the Batch API is missing, not permitted for
 * this credential, or rate limited. Only these fall back to serial calls.
 * Any other failure, and every 2xx response, can follow a batch ServiceNow
 * already applied in whole or in part. Replaying it would apply a change
 * twice, which for a journal field is a duplicate entry.
 */
const BATCH_REFUSED_BEFORE_PROCESSING: ReadonlySet<ToolErrorCategory> = new Set<
  ToolErrorCategory
>(["authentication", "authorization", "not_found", "rate_limit"]);

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
  readonly failed: number;
  /** Listed by ServiceNow in unserviced_requests: not run, counted as failed. */
  readonly unserviced: number;
  /** Not reported either way: may have been applied, never retried. */
  readonly unconfirmed: number;
}

/**
 * Apply one update or delete to every matched record through the documented
 * REST Batch API (`POST /api/now/v1/batch`), 50 requests per batch.
 *
 * Request: `rest_requests[]` with `id`, `method`, `url`, `headers` as
 * name/value pairs, and a base64-encoded `body`. Response:
 * `serviced_requests[]` with `id` and `status_code`, plus
 * `unserviced_requests[]` with the ids ServiceNow did not run.
 *
 * A batch request is never replayed. Serial Table API calls replace it only
 * when ServiceNow refused the request before running any of it.
 */
async function executeBatchMutation(
  client: ServiceNowOperations,
  table: string,
  action: "update" | "delete",
  records: readonly Record<string, unknown>[],
  fields: Readonly<Record<string, string>> | undefined
): Promise<BatchExecutionResult> {
  let processed = 0;
  let failed = 0;
  let unserviced = 0;
  const sysIds: string[] = [];
  for (const record of records) {
    try {
      sysIds.push(serviceNowSysIdPathSegment(record.sys_id));
    } catch {
      failed += 1;
    }
  }
  const body = action === "update" ? encodeBatchBody(fields ?? {}) : undefined;

  for (let offset = 0; offset < sysIds.length; offset += REST_BATCH_CHUNK_SIZE) {
    const chunk = sysIds.slice(offset, offset + REST_BATCH_CHUNK_SIZE);
    const requests = chunk.map((sysId, index) =>
      restBatchRequest(table, action, sysId, String(offset + index + 1), body)
    );
    let response: unknown;
    try {
      response = await client.post<unknown>(REST_BATCH_PATH, {
        batch_request_id: `sn_batch_${Date.now()}_${offset}`,
        rest_requests: requests,
      });
    } catch (error) {
      if (batchRefusedBeforeProcessing(error)) {
        // Nothing in this batch ran. The records from here on go through the
        // Table API one at a time; earlier batches are confirmed and are not
        // sent again.
        const serial = await executeSerialMutation(
          client,
          table,
          action,
          sysIds.slice(offset),
          fields
        );
        return batchResult(
          processed + serial.processed,
          failed + serial.failed,
          unserviced,
          0,
          0
        );
      }
      // The request may have reached ServiceNow and been applied.
      return batchResult(
        processed,
        failed,
        unserviced,
        chunk.length,
        sysIds.length - offset - chunk.length
      );
    }
    const outcome = chunkOutcome(
      response,
      requests.map(({ id }) => id)
    );
    processed += outcome.processed;
    failed += outcome.failed;
    unserviced += outcome.unserviced;
    if (outcome.unconfirmed > 0) {
      return batchResult(
        processed,
        failed,
        unserviced,
        outcome.unconfirmed,
        sysIds.length - offset - chunk.length
      );
    }
  }
  return batchResult(processed, failed, unserviced, 0, 0);
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
      // Only sys_id comes back per record. A full record per response would
      // make each batch response large enough to exhaust the per-call
      // response budget, and the outcome of a batch whose response cannot be
      // read is unknown.
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

function encodeBatchBody(fields: Readonly<Record<string, string>>): string {
  return Buffer.from(JSON.stringify(fields), "utf8").toString("base64");
}

function batchRefusedBeforeProcessing(error: unknown): boolean {
  const descriptor = trustedToolErrorDescriptor(error);
  return (
    descriptor !== undefined &&
    BATCH_REFUSED_BEFORE_PROCESSING.has(descriptor.category)
  );
}

/**
 * Count one batch response against the ids that were sent. An id ServiceNow
 * neither serviced nor listed as unserviced is unconfirmed, and so is an id
 * reported more than once, because its result cannot be attributed.
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
  let unconfirmed = 0;
  for (const id of ids) {
    const status = statuses.get(id);
    if (status !== undefined) {
      if (status >= 200 && status < 300) processed += 1;
      else failed += 1;
    } else if (notServiced.has(id)) {
      failed += 1;
    } else {
      unconfirmed += 1;
    }
  }
  return { processed, failed, unserviced: notServiced.size, unconfirmed };
}

function batchResult(
  processed: number,
  failed: number,
  unserviced: number,
  unconfirmed: number,
  notSent: number
): BatchExecutionResult {
  const notes: string[] = [];
  if (unconfirmed > 0) {
    notes.push(
      `ServiceNow did not confirm the outcome for ${unconfirmed} record(s). ` +
        "They may have been changed. They were not retried, so no change is " +
        "applied twice. Check them before running the batch again."
    );
  }
  if (notSent > 0) {
    notes.push(
      `The remaining ${notSent} record(s) were not sent and are counted as failed.`
    );
  }
  if (unserviced > 0) {
    notes.push(
      `ServiceNow did not process ${unserviced} record(s) because a batch ` +
        "reached a size or time limit. They are counted as failed."
    );
  }
  return {
    processed,
    failed: failed + notSent,
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

async function executeSerialMutation(
  client: ServiceNowOperations,
  table: string,
  action: "update" | "delete",
  sysIds: readonly string[],
  fields: Readonly<Record<string, string>> | undefined
): Promise<BatchExecutionResult> {
  let processed = 0;
  let failed = 0;
  for (const sysId of sysIds) {
    try {
      if (action === "update") {
        await client.patch(`/api/now/table/${table}/${sysId}`, fields);
        processed += 1;
      } else {
        const delResp = await client.delete(`/api/now/table/${table}/${sysId}`);
        if (delResp.status === 204 || delResp.status === 200) processed += 1;
        else failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { processed, failed };
}
