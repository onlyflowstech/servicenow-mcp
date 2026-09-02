/** Canonical contract-bearing sn_get module. */

import { types as nodeUtilTypes } from "node:util";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import { FORCE_RECACHE_PARAM } from "../metadata-cache.js";
import {
  fieldSelectionToSysparmFields,
  filterReadableRecord,
  isAllFieldSelection,
  preparedReadableFields,
  prepareReadFieldArguments,
  resolveReadableFields,
  withFieldPolicyArgumentValues,
  type FieldSelection,
} from "../field-policy.js";
import {
  recordIdentifierSchema,
  resolveRecordLookupSelector,
  type RecordLookupSelector,
} from "../record-identifier-policy.js";
import { serviceNowSysIdPathSegment, serviceNowSysIdSchema } from "../servicenow-identifiers.js";
import { normalizeTableName } from "../table-policy.js";
import { createToolError } from "../tool-error.js";
import {
  buildTableParams,
  escapeQueryValue,
  MAX_RESPONSE_BYTES_DEFAULT,
  MAX_RESPONSE_BYTES_MAX,
  MAX_RESPONSE_BYTES_MIN,
  ok,
  stripEmpty,
} from "../utils.js";
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
  name: "sn_get",
  description:
    "Get exactly one record from a policy-approved ServiceNow table by a strict " +
    "32-hex sys_id or an approved table-specific human-readable identifier. " +
    "Identifier resolution is exact and bounded: no match returns not_found and " +
    "multiple matches return conflict. Explicit fields win; otherwise concise " +
    "uses safe defaults and detailed returns all policy-approved readable fields.",
  annotations: Object.freeze({
    title: "Get record",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  }),
} satisfies ToolDefinition);

function compatibleInputSchema() {
  return z.object({
      table: z.string().describe("Policy-approved ServiceNow table name"),
      sys_id: serviceNowSysIdSchema
        .optional()
        .describe("Exact 32-hex ServiceNow sys_id; mutually exclusive with identifier"),
      identifier: recordIdentifierSchema
        .optional()
        .describe(
          "Approved table-specific human identifier as {field,value}; mutually exclusive with sys_id"
        ),
      fields: z
        .string()
        .optional()
        .describe(
          'Comma-separated approved fields to return. Omit for safe defaults; pass "all" for every approved readable field.'
        ),
      response_format: z
        .enum(["concise", "detailed"])
        .optional()
        .default("concise")
        .describe(
          'Verbosity when fields is omitted. "concise" uses safe defaults; "detailed" uses every approved readable field. Ignored when fields is provided.'
        ),
      max_response_bytes: z
        .number()
        .int()
        .min(MAX_RESPONSE_BYTES_MIN)
        .max(MAX_RESPONSE_BYTES_MAX)
        .optional()
        .default(MAX_RESPONSE_BYTES_DEFAULT)
        .describe(
          "Final response byte budget (default 100000, min 1000, max 1000000). Long field values are shortened without mutating upstream data."
        ),
      display_value: z
        .enum(["true", "false", "all"])
        .optional()
        .describe("Display values mode: true, false, or all"),
      force_recache: z
        .boolean()
        .optional()
        .default(false)
        .describe("For metadata tables, bypass the per-instance metadata cache and refresh from ServiceNow."),
    })
    .strict();
}

/** Legacy source-level schema; MCP registration uses `moduleInputSchema`. */
export const schema = compatibleInputSchema();

/** Exact public MCP input, including the mandatory shared profile selector. */
export const moduleInputSchema = withRequiredProfile(compatibleInputSchema());

type GetArguments = z.output<typeof schema>;

interface GetAccessResolution {
  readonly args: Record<string, unknown>;
  readonly requests: readonly Readonly<{
    operation: "read";
    table: string;
  }>[];
}

/** Compatibility handler retained for direct source consumers. */
export async function handler(
  args: GetArguments,
  client: ServiceNowOperations,
  config: ServiceNowToolSettings,
  _context?: ExecutionContext
): Promise<CallToolResult> {
  return executeGet(args, client, config);
}

/** Complete pre-client access resolution for the dedicated module. */
export function resolveGetAccess(candidate: unknown): GetAccessResolution {
  const parsed = moduleInputSchema.parse(candidate);
  const table = normalizeTableName(parsed.table);
  let prepared = prepareReadFieldArguments(parsed, table, {
    exposeFieldsArgument: true,
  });
  const selector = resolveRecordLookupSelector(table, {
    sys_id: parsed.sys_id,
    identifier: parsed.identifier,
  });
  prepared = withFieldPolicyArgumentValues(
    prepared,
    selector.kind === "sys_id"
      ? { table, sys_id: selector.sysId }
      : {
          table,
          identifier: Object.freeze({
            field: selector.field,
            value: selector.value,
          }),
        }
  );
  return Object.freeze({
    args: Object.freeze(prepared),
    requests: Object.freeze([
      Object.freeze({ operation: "read" as const, table }),
    ]),
  });
}

async function executeGet(
  args: GetArguments,
  client: ServiceNowOperations,
  config: ServiceNowToolSettings
): Promise<CallToolResult> {
  const readableFields =
    preparedReadableFields(args, args.table) ??
    resolveReadableFields(args.table, {
      fields: args.fields,
      responseFormat: args.response_format,
    });
  const selector = resolveRecordLookupSelector(args.table, {
    sys_id: args.sys_id,
    identifier: args.identifier,
  });
  const record = await fetchOneRecord(
    args,
    selector,
    readableFields,
    client,
    config
  );
  const filtered = stripEmpty(filterReadableRecord(record, readableFields));
  if (
    typeof filtered !== "object" ||
    filtered === null ||
    Array.isArray(filtered)
  ) {
    throw createToolError("upstream", "retry_if_safe_and_idempotent");
  }
  // Final byte fitting belongs to the central structured-envelope finalizer.
  // Keeping the record namespace untouched avoids collisions with legitimate
  // ServiceNow fields named `truncated`, `truncated_fields`, or `hint`.
  return ok(filtered);
}

async function fetchOneRecord(
  args: GetArguments,
  selector: RecordLookupSelector,
  readableFields: FieldSelection,
  client: ServiceNowOperations,
  config: ServiceNowToolSettings
): Promise<unknown> {
  const displayValue = args.display_value ?? config.displayValue;
  if (selector.kind === "sys_id") {
    const response = await client.get(
      `/api/now/table/${args.table}/${serviceNowSysIdPathSegment(selector.sysId)}`,
      {
        ...buildTableParams({
          fields: fieldSelectionToSysparmFields(readableFields),
          displayValue,
        }),
        ...(args.force_recache ? { [FORCE_RECACHE_PARAM]: "true" } : {}),
      }
    );
    return resultProperty(response);
  }

  const requestFields = isAllFieldSelection(readableFields)
    ? readableFields
    : [...new Set([...readableFields, "sys_id"])];
  const response = await client.get(`/api/now/table/${args.table}`, {
    ...buildTableParams({
      query:
        `${selector.field}=${escapeQueryValue(selector.value)}` +
        "^ORDERBYsys_id",
      fields: fieldSelectionToSysparmFields(requestFields),
      limit: 2,
      displayValue,
    }),
    ...(args.force_recache ? { [FORCE_RECACHE_PARAM]: "true" } : {}),
  });
  const results = resultProperty(response);
  if (nodeUtilTypes.isProxy(results) || !Array.isArray(results)) {
    throw createToolError("upstream", "retry_if_safe_and_idempotent");
  }
  if (results.length === 0) {
    throw createToolError("not_found", "do_not_retry");
  }
  if (results.length > 1) {
    throw createToolError("conflict", "retry_after_correction");
  }
  const record = Object.getOwnPropertyDescriptor(results, "0");
  if (!record || !("value" in record)) {
    throw createToolError("upstream", "retry_if_safe_and_idempotent");
  }
  return record.value;
}

/** Read the Table API wrapper without invoking accessors or Proxy traps. */
function resultProperty(response: unknown): unknown {
  if (
    typeof response !== "object" ||
    response === null ||
    nodeUtilTypes.isProxy(response) ||
    Array.isArray(response)
  ) {
    throw createToolError("upstream", "retry_if_safe_and_idempotent");
  }
  const prototype = Object.getPrototypeOf(response);
  if (prototype !== Object.prototype && prototype !== null) {
    throw createToolError("upstream", "retry_if_safe_and_idempotent");
  }
  const descriptor = Object.getOwnPropertyDescriptor(response, "result");
  if (!descriptor || !("value" in descriptor)) {
    throw createToolError("upstream", "retry_if_safe_and_idempotent");
  }
  return descriptor.value;
}

/** Dedicated contract-bearing module for production registration. */
export const getToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition,
  inputSchema: moduleInputSchema,
  outputSchema: productionToolOutputSchemas.sn_get,
  requirements: {
    permissions: ["read"],
    tables: {
      kind: "dynamic",
      names: [],
      description: "Caller-selected policy-approved table.",
    },
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["record:get"],
  },
  resolveAccess: (args) => resolveGetAccess(args),
  handler: async (args, services) =>
    envelopeCompatibilityResult(
      "sn_get",
      args,
      await executeGet(
        args as unknown as GetArguments,
        services.serviceNow,
        services.settings
      )
    ),
});
