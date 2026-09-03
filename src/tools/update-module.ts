/** Canonical contract-bearing sn_update module. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import {
  ENCODED_QUERY_MIGRATION_MESSAGE,
  rejectRawEncodedWrite,
} from "../encoded-query-policy.js";
import {
  prepareWriteFieldArguments,
  withFieldPolicyArgumentValues,
} from "../field-policy.js";
import { prepareIncidentWriteFields } from "../incident-write-policy.js";
import { rejectGenericIncidentJournalFields } from "../incident-journal-policy.js";
import {
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";
import { normalizeTableName } from "../table-policy.js";
import { createToolError } from "../tool-error.js";
import { ok } from "../utils.js";
import { filteredIncidentWriteRecord } from "./incident-write-shared.js";
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
    "Update ordinary fields on exactly one incident selected by canonical sys_id. " +
    "At least one bounded approved field is required; journals use dedicated tools.",
  annotations: Object.freeze({
    title: "Update record",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  }),
} satisfies ToolDefinition);

function compatibleInputSchema() {
  return z
    .object({
      table: z.string().describe("Exactly incident; subject to the configured write target policy"),
      sys_id: serviceNowSysIdSchema.describe(
        "The exact 32-hex sys_id of one incident to update"
      ),
      fields: z
        .record(z.unknown())
        .describe(
          "At least one approved bounded ordinary incident field; comments and work_notes are rejected"
        ),
    })
    .strict(ENCODED_QUERY_MIGRATION_MESSAGE);
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
  rejectGenericIncidentJournalFields(parsed.fields);
  const table = normalizeTableName(parsed.table);
  let prepared = prepareWriteFieldArguments(parsed, table);
  const fields = prepareIncidentWriteFields("update", table, prepared.fields);
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
  rejectGenericIncidentJournalFields(args.fields);
  const sysId = serviceNowSysIdPathSegment(args.sys_id);
  const fields = prepareIncidentWriteFields("update", args.table, args.fields);
  const response = await client.patch(
    `/api/now/table/incident/${sysId}`,
    fields
  );
  const safeRecord = filteredIncidentWriteRecord(
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
    tables: {
      kind: "static",
      names: ["incident"],
    },
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
