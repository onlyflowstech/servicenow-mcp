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
  validateWritableFields,
} from "../field-policy.js";
import { rejectGenericIncidentJournalFields } from "../incident-journal-policy.js";
import { ok, err } from "../utils.js";
import { serviceNowSysIdPathSegment } from "../servicenow-identifiers.js";
import {
  compileStructuredQuery,
  structuredQuerySchema,
} from "../structured-query.js";

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
    // The append-only journal discipline is uniform across every write path.
    // Without this, sn_batch was the one way to set comments/work_notes as
    // generic fields, which is exactly what makes the journal audit trail
    // meaningless. Matches sn_create and sn_update.
    rejectGenericIncidentJournalFields(args.fields);
    if (args.action === "update" && !args.fields) {
      return err("--fields is required for update action");
    }
    const writableFields =
      args.action === "update"
        ? validateWritableFields(args.table, args.fields)
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

    // Step 3: Execute through ServiceNow REST Batch API where available.
    // If the instance rejects /api/now/v1/batch, fall back to the serial table
    // API path so the public tool behavior stays compatible.
    const execution = await executeBatchMutation(
      client,
      args.table,
      args.action,
      results,
      writableFields
    );
    const { processed, failed } = execution;

    return ok({
      action: args.action,
      table: args.table,
      matched,
      processed,
      failed,
    });
  } catch (error) {
    throw error;
  }
}

const REST_BATCH_CHUNK_SIZE = 50;

interface BatchExecutionResult {
  readonly processed: number;
  readonly failed: number;
}

async function executeBatchMutation(
  client: ServiceNowOperations,
  table: string,
  action: "update" | "delete",
  records: readonly Record<string, unknown>[],
  fields: Readonly<Record<string, unknown>> | undefined
): Promise<BatchExecutionResult> {
  try {
    return await executeRestBatchMutation(client, table, action, records, fields);
  } catch {
    return executeSerialMutation(client, table, action, records, fields);
  }
}

async function executeRestBatchMutation(
  client: ServiceNowOperations,
  table: string,
  action: "update" | "delete",
  records: readonly Record<string, unknown>[],
  fields: Readonly<Record<string, unknown>> | undefined
): Promise<BatchExecutionResult> {
  let processed = 0;
  let failed = 0;
  for (let offset = 0; offset < records.length; offset += REST_BATCH_CHUNK_SIZE) {
    const chunk = records.slice(offset, offset + REST_BATCH_CHUNK_SIZE);
    const restRequests = chunk.map((record, index) => {
      const sysId = serviceNowSysIdPathSegment(record.sys_id);
      return {
        id: String(offset + index + 1),
        method: action === "update" ? "PATCH" : "DELETE",
        url: `/api/now/table/${table}/${sysId}`,
        ...(action === "update" ? { body: fields ?? {} } : {}),
      };
    });
    const response = await client.post<unknown>("/api/now/v1/batch", {
      batch_request_id: `sn_batch_${Date.now()}_${offset}`,
      rest_requests: restRequests,
    });
    const statuses = extractBatchStatuses(response);
    if (statuses.length !== chunk.length) {
      throw new TypeError("REST Batch response did not include per-request statuses");
    }
    for (const status of statuses) {
      if (status >= 200 && status < 300) processed += 1;
      else failed += 1;
    }
  }
  return { processed, failed };
}

function extractBatchStatuses(response: unknown): number[] {
  const root = unwrapBatchResponse(response);
  if (!Array.isArray(root)) return [];
  return root
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      const status = record.status_code ?? record.status ?? record.http_status;
      return typeof status === "number" && Number.isSafeInteger(status)
        ? status
        : typeof status === "string" && /^(?:0|[1-9]\d*)$/u.test(status)
          ? Number(status)
          : undefined;
    })
    .filter((status): status is number => status !== undefined);
}

function unwrapBatchResponse(response: unknown): unknown {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return response;
  }
  const record = response as Record<string, unknown>;
  const result = record.result;
  if (Array.isArray(record.rest_requests)) return record.rest_requests;
  if (Array.isArray(record.responses)) return record.responses;
  if (Array.isArray(result)) return result;
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const nested = result as Record<string, unknown>;
    if (Array.isArray(nested.rest_requests)) return nested.rest_requests;
    if (Array.isArray(nested.responses)) return nested.responses;
  }
  return undefined;
}

async function executeSerialMutation(
  client: ServiceNowOperations,
  table: string,
  action: "update" | "delete",
  records: readonly Record<string, unknown>[],
  fields: Readonly<Record<string, unknown>> | undefined
): Promise<BatchExecutionResult> {
  let processed = 0;
  let failed = 0;
  for (const record of records) {
    try {
      const sysId = serviceNowSysIdPathSegment(record.sys_id);
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
