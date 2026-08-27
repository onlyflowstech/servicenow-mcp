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
import { prepareIncidentWriteFields } from "../incident-write-policy.js";
import { rejectGenericIncidentJournalFields } from "../incident-journal-policy.js";
import { normalizeTableName } from "../table-policy.js";
import { ok } from "../utils.js";
import {
  filteredIncidentWriteRecord,
  optionalIncidentNumber,
  requiredCreatedSysId,
} from "./incident-write-shared.js";
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
    "Create one incident with a required bounded short_description and optional " +
    "policy-approved ordinary fields. Journal fields require dedicated tools.",
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
      table: z.string().describe("Exactly incident; subject to the configured write target policy"),
      fields: z
        .record(z.unknown())
        .describe(
          'Approved ordinary incident values; short_description is required (e.g. {"short_description":"Server down","urgency":"1"})'
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
  const table = normalizeTableName(parsed.table);
  let prepared = prepareWriteFieldArguments(parsed, table);
  const fields = prepareIncidentWriteFields("create", table, prepared.fields);
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
  const fields = prepareIncidentWriteFields("create", args.table, args.fields);
  const response = await client.post("/api/now/table/incident", fields);
  const safeRecord = filteredIncidentWriteRecord(args, response, "do_not_retry");
  const sysId = requiredCreatedSysId(safeRecord);
  const number = optionalIncidentNumber(safeRecord);
  const record = Object.fromEntries(
    Object.entries(safeRecord).filter(
      ([field]) => field !== "sys_id" && field !== "number"
    )
  );
  return ok({
    sys_id: sysId,
    ...(number === undefined ? {} : { number }),
    table: "incident",
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
    tables: {
      kind: "static",
      names: ["incident"],
    },
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
