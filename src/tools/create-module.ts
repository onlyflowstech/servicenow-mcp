/** Canonical contract-bearing sn_create module. */

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
import {
  normalizeWriteTable,
  prepareWriteFieldValues,
} from "../write-value-policy.js";
import { rejectGenericIncidentJournalFields } from "../incident-journal-policy.js";
import { ok } from "../utils.js";
import {
  filteredWriteRecord,
  optionalRecordNumber,
  requiredCreatedSysId,
} from "./record-write-shared.js";
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
  name: "sn_create",
  description:
    "Create one record on any table the configured policy grants for writes. " +
    "Fields are bounded by the field policy; incident additionally requires a " +
    "short_description. Journal fields require dedicated tools.",
  annotations: Object.freeze({
    title: "Create record",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  }),
} satisfies ToolDefinition);

function compatibleInputSchema() {
  return z
    .object({
      table: z
        .string()
        .describe(
          "Target table; must be granted for writes by the configured table policy"
        ),
      fields: z
        .record(z.unknown())
        .describe(
          'Field values approved by the configured field policy. On incident, short_description is required (e.g. {"short_description":"Server down","urgency":"1"})'
        ),
    })
    .strict(ENCODED_QUERY_MIGRATION_MESSAGE);
}

export const schema = compatibleInputSchema();
export const moduleInputSchema = withRequiredProfile(compatibleInputSchema());

type CreateArguments = z.output<typeof schema>;

interface CreateAccessResolution {
  readonly args: Record<string, unknown>;
  readonly requests: readonly Readonly<{ operation: "write"; table: string }>[];
}

/** Compatibility handler retained with the legacy four-argument signature. */
export async function handler(
  args: CreateArguments,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
): Promise<CallToolResult> {
  return executeCreate(args, client);
}

export function resolveCreateAccess(candidate: unknown): CreateAccessResolution {
  const parsed = moduleInputSchema.parse(candidate);
  rejectRawEncodedWrite(
    (parsed as unknown as Readonly<Record<string, unknown>>).query
  );
  rejectGenericIncidentJournalFields(parsed.fields);
  const table = normalizeWriteTable(parsed.table);
  let prepared = prepareWriteFieldArguments(parsed, table);
  const fields = prepareWriteFieldValues("create", table, prepared.fields);
  prepared = withFieldPolicyArgumentValues(prepared, { table, fields });
  return Object.freeze({
    args: Object.freeze(prepared),
    requests: Object.freeze([
      Object.freeze({ operation: "write" as const, table }),
    ]),
  });
}

async function executeCreate(
  args: CreateArguments,
  client: ServiceNowOperations
): Promise<CallToolResult> {
  rejectRawEncodedWrite(
    (args as unknown as Readonly<Record<string, unknown>>).query
  );
  rejectGenericIncidentJournalFields(args.fields);
  const table = normalizeWriteTable(args.table);
  const fields = prepareWriteFieldValues("create", table, args.fields);
  const response = await client.post(`/api/now/table/${table}`, fields);
  const safeRecord = filteredWriteRecord(args, response, "do_not_retry");
  const sysId = requiredCreatedSysId(safeRecord);
  const number = optionalRecordNumber(safeRecord);
  const record = Object.fromEntries(
    Object.entries(safeRecord).filter(
      ([field]) => field !== "sys_id" && field !== "number"
    )
  );
  return ok({
    sys_id: sysId,
    ...(number === undefined ? {} : { number }),
    table,
    record,
  });
}

export const createToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition,
  inputSchema: moduleInputSchema,
  outputSchema: productionToolOutputSchemas.sn_create,
  requirements: {
    permissions: ["write"],
    tables: Object.freeze({
      kind: "dynamic",
      names: Object.freeze([]),
      description: "Caller-selected table approved for writes by the table policy.",
    }),
    apis: ["table"],
    fieldPolicies: ["write"],
    capabilities: ["record:create"],
  },
  resolveAccess: (args) => resolveCreateAccess(args),
  handler: async (args, services) =>
    envelopeCompatibilityResult(
      "sn_create",
      args,
      await executeCreate(
        args as unknown as CreateArguments,
        services.serviceNow
      )
    ),
});
