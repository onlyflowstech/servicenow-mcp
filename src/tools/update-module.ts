/** Canonical contract-bearing sn_update module. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import {
  ENCODED_QUERY_STRICT_OBJECT_PARAMS,
  rejectRawEncodedWrite,
} from "../encoded-query-policy.js";
import {
  prepareWriteFieldArguments,
  withFieldPolicyArgumentValues,
} from "../field-policy.js";
import {
  normalizeWriteTable,
  prepareWriteFieldValues,
} from "../write-value-policy.js";
import {
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";
import { createToolError } from "../tool-error.js";
import { ok } from "../utils.js";
import { filteredWriteRecord } from "./record-write-shared.js";
import {
  envelopeCompatibilityResult,
  productionToolOutputSchemas,
} from "./result-envelope.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  type ServiceNowToolSettings,
  type ToolDefinition,
} from "./tool-module.js";

export const definition = Object.freeze({
  name: "sn_update",
  description:
    "Update fields on exactly one record selected by canonical sys_id, on any " +
    "table the configured policy grants for writes. At least one bounded " +
    "approved field is required; journal fields (comments, work_notes) add an entry.",
  annotations: Object.freeze({
    title: "Update record",
    readOnlyHint: false,
    destructiveHint: false,
    // A journal field (comments, work_notes) appends an entry on every call,
    // so repeating the same update is not free of additional effect.
    idempotentHint: false,
    openWorldHint: true,
  }),
} satisfies ToolDefinition);

function compatibleInputSchema() {
  return z
    .strictObject({
      table: z
        .string()
        .describe(
          "Target table; must be granted for writes by the configured table policy"
        ),
      sys_id: serviceNowSysIdSchema.describe(
        "The exact 32-hex sys_id of the one record to update"
      ),
      fields: z
        .record(z.string(), z.unknown())
        .describe(
          'At least one field approved by the configured field policy. comments and work_notes add a journal entry; "" or null clears a field (e.g. {"state":"2","work_notes":"Investigating"})'
        ),
    }, ENCODED_QUERY_STRICT_OBJECT_PARAMS);
}

export const schema = compatibleInputSchema();
export const moduleInputSchema = withRequiredProfile(compatibleInputSchema());

type UpdateArguments = z.output<typeof schema>;

interface UpdateAccessResolution {
  readonly args: Record<string, unknown>;
  readonly requests: readonly Readonly<{ operation: "write"; table: string }>[];
}

/** Compatibility handler retained with the legacy four-argument signature. */
export async function handler(
  args: UpdateArguments,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
): Promise<CallToolResult> {
  return executeUpdate(args, client);
}

export function resolveUpdateAccess(candidate: unknown): UpdateAccessResolution {
  const parsed = moduleInputSchema.parse(candidate);
  rejectRawEncodedWrite(
    (parsed as unknown as Readonly<Record<string, unknown>>).query
  );
  const table = normalizeWriteTable(parsed.table);
  let prepared = prepareWriteFieldArguments(parsed, table);
  const fields = prepareWriteFieldValues("update", table, prepared.fields);
  prepared = withFieldPolicyArgumentValues(prepared, {
    table,
    sys_id: parsed.sys_id,
    fields,
  });
  return Object.freeze({
    args: Object.freeze(prepared),
    requests: Object.freeze([
      Object.freeze({ operation: "write" as const, table }),
    ]),
  });
}

async function executeUpdate(
  args: UpdateArguments,
  client: ServiceNowOperations
): Promise<CallToolResult> {
  rejectRawEncodedWrite(
    (args as unknown as Readonly<Record<string, unknown>>).query
  );
  const sysId = serviceNowSysIdPathSegment(args.sys_id);
  const table = normalizeWriteTable(args.table);
  const fields = prepareWriteFieldValues("update", table, args.fields);
  const response = await client.patch(
    `/api/now/table/${table}/${sysId}`,
    fields
  );
  const safeRecord = filteredWriteRecord(
    args,
    response,
    "retry_if_safe_and_idempotent"
  );
  if (Object.hasOwn(safeRecord, "sys_id")) {
    let upstreamSysId: string;
    try {
      upstreamSysId = serviceNowSysIdPathSegment(safeRecord.sys_id);
    } catch {
      throw createToolError("upstream", "retry_if_safe_and_idempotent");
    }
    if (upstreamSysId !== sysId) {
      throw createToolError("upstream", "retry_if_safe_and_idempotent");
    }
  }
  const record = Object.fromEntries(
    Object.entries(safeRecord).filter(([field]) => field !== "sys_id")
  );
  return ok({ sys_id: sysId, record });
}

export const updateToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition,
  inputSchema: moduleInputSchema,
  outputSchema: productionToolOutputSchemas.sn_update,
  requirements: {
    permissions: ["write"],
    tables: Object.freeze({
      kind: "dynamic",
      names: Object.freeze([]),
      description: "Caller-selected table approved for writes by the table policy.",
    }),
    apis: ["table"],
    fieldPolicies: ["write"],
    capabilities: ["record:update"],
  },
  resolveAccess: (args) => resolveUpdateAccess(args),
  handler: async (args, services) =>
    envelopeCompatibilityResult(
      "sn_update",
      args,
      await executeUpdate(
        args as unknown as UpdateArguments,
        services.serviceNow
      )
    ),
});
