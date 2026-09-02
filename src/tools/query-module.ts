/** Canonical contract-bearing sn_query module. */

import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import { FORCE_RECACHE_PARAM } from "../metadata-cache.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  authorizeRawEncodedRead,
  ENCODED_QUERY_MIGRATION_MESSAGE,
} from "../encoded-query-policy.js";
import {
  fieldSelectionToSysparmFields,
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import {
  compileStructuredQuery,
  StructuredQueryError,
  structuredQuerySchema,
} from "../structured-query.js";
import { resolveToolTableAccess } from "../tool-table-access.js";
import {
  ok,
  buildTableParams,
  stripEmpty,
  serializedBytes,
  MAX_RESPONSE_BYTES_DEFAULT,
  MAX_RESPONSE_BYTES_MIN,
  MAX_RESPONSE_BYTES_MAX,
} from "../utils.js";
import {
  envelopeCompatibilityResult,
  productionToolOutputSchemas,
} from "./result-envelope.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  type ToolDefinition,
} from "./tool-module.js";

export const definition = Object.freeze({
  name: "sn_query",
  description:
    "Query a policy-approved ServiceNow table. Returns records with pagination metadata " +
    "(record_count, total, has_more, next_offset). Field verbosity: an " +
    "explicit fields list always wins; otherwise response_format=\"concise\" " +
    "(default) uses the table's safe default field set and " +
    "response_format=\"detailed\" returns all policy-approved readable fields " +
    "(same as fields=\"all\"). Responses larger than max_response_bytes are truncated " +
    "by dropping whole records from the tail, with a hint for fetching the rest.",
  annotations: Object.freeze({
    title: "Query records",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  }),
} satisfies ToolDefinition);

function compatibleInputSchema() {
  return z.object({
    table: z
      .string()
      .describe(
        "ServiceNow table name (e.g. incident, change_request, sys_user)"
      ),
    query: z
      .string()
      .optional()
      .describe(
        "Legacy raw ServiceNow encoded query. Disabled by default; accepted " +
          "only for an explicit bounded sn_query/table policy rule. Prefer " +
          "structured_query."
      ),
    structured_query: structuredQuerySchema
      .optional()
      .describe(
        "Policy-authorized structured filters and ordering. Use instead of " +
          "raw query/orderby; supports bounded equality, set, range, text, " +
          "null, AND/OR group, and order_by cases."
      ),
    fields: z
      .string()
      .optional()
      .describe(
        "Comma-separated approved fields to return. Always takes precedence " +
          'over response_format. Omit for the table safe defaults; pass "all" ' +
          "for every policy-approved readable field."
      ),
    response_format: z
      .enum(["concise", "detailed"])
      .optional()
      .default("concise")
      .describe(
        'Verbosity when fields is omitted (default "concise"). "concise" ' +
          "returns the safe default set; \"detailed\" returns every " +
          "policy-approved readable field. Ignored when fields is provided."
      ),
    max_response_bytes: z
      .number()
      .int()
      .min(MAX_RESPONSE_BYTES_MIN)
      .max(MAX_RESPONSE_BYTES_MAX)
      .optional()
      .default(MAX_RESPONSE_BYTES_DEFAULT)
      .describe(
        "Byte budget for the serialized response (default 100000, min 1000, " +
          "max 1000000). When exceeded, whole records are dropped from the " +
          "tail (the JSON is never mangled) and the response gains truncated: " +
          "true plus a hint stating how many records were dropped, the total " +
          "available, and the exact offset/limit/fields/response_format " +
          "follow-up arguments to fetch the rest."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .default(20)
      .describe("Maximum records to return (default 20, max 1000)"),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe("Pagination offset (max 10000)"),
    orderby: z
      .string()
      .optional()
      .describe(
        "Sort field. Prefix with - for descending (e.g. -sys_created_on)"
      ),
    display_value: z
      .enum(["true", "false", "all"])
      .optional()
      .describe("Display values mode: true, false, or all (default: true)"),
    force_recache: z
      .boolean()
      .optional()
      .default(false)
      .describe("For metadata tables, bypass the per-instance metadata cache and refresh from ServiceNow."),
  }).strict(ENCODED_QUERY_MIGRATION_MESSAGE);
}

/** Legacy source-level schema; MCP registration uses `moduleInputSchema`. */
export const schema = compatibleInputSchema();

/** Exact public MCP input, including the mandatory shared profile selector. */
export const moduleInputSchema = withRequiredProfile(compatibleInputSchema());

function stableOrderQuery(
  conditionQuery: string | undefined,
  orderby: string | undefined,
  structuredOrder: readonly { readonly field: string; readonly direction: "asc" | "desc" }[] | undefined
): string {
  const tokens: string[] = conditionQuery ? [conditionQuery] : [];
  if (!structuredOrder && orderby) {
    const descending = orderby.startsWith("-");
    const field = descending ? orderby.slice(1) : orderby;
    tokens.push(`${descending ? "ORDERBYDESC" : "ORDERBY"}${field}`);
  }
  const alreadyStable = structuredOrder
    ? structuredOrder.some(({ field }) => field === "sys_id")
    : orderby === "sys_id" || orderby === "-sys_id";
  if (!alreadyStable) tokens.push("ORDERBYsys_id");
  return tokens.join("^");
}

/**
 * Enforce the max_response_bytes budget by dropping whole records from the
 * tail of `results`. Records are never split or mangled -- the reply stays
 * valid JSON. Untouched payloads are returned as-is (byte-identical to the
 * unguarded response). On truncation the payload gains `truncated: true`
 * and a hint with the exact follow-up arguments (offset/limit/fields/
 * response_format) needed to fetch the dropped records.
 */
function enforceByteBudget(
  payload: Record<string, unknown>,
  results: unknown[],
  args: z.infer<typeof schema>,
  total: number | undefined
): Record<string, unknown> {
  const maxBytes = args.max_response_bytes;
  if (results.length === 0 || serializedBytes(payload) <= maxBytes) return payload;

  const fetched = results.length;
  const offset = args.offset ?? 0;
  const upstreamHasMore = payload.has_more === true;
  const declaredNextOffset = payload.next_offset;
  const upstreamNextOffset =
    typeof declaredNextOffset === "number" &&
    Number.isSafeInteger(declaredNextOffset) &&
    declaredNextOffset > offset
      ? declaredNextOffset
      : offset + args.limit;
  const shrinkAdvice =
    args.fields === undefined && args.response_format === "detailed"
      ? 'response_format="concise"'
      : 'fields="sys_id,number"';

  const build = (keep: number): Record<string, unknown> => {
    const dropped = fetched - keep;
    const out: Record<string, unknown> = { record_count: keep };
    if (total !== undefined) out.total = total;
    // Keep the authoritative post-window continuation even when this local
    // byte budget cannot retain a row. The shared envelope separately marks
    // same-offset recovery for rows dropped from the consumed window.
    out.has_more = upstreamHasMore;
    if (out.has_more) out.next_offset = upstreamNextOffset;
    out.truncated = true;
    out.dropped_records = dropped;
    // Keep the recovery hint compact enough that a zero-record production
    // envelope can still fit the minimum byte budget after shared metadata is
    // added. The structured pagination object carries the same retry/resume
    // distinction for machine clients.
    out.hint =
      `Dropped ${dropped}/${fetched}` +
      (total !== undefined ? ` (${total} total)` : "") +
      (keep === 0 ? "; row too large" : "") +
      `; recover offset=${offset} with ${shrinkAdvice}/max_response_bytes` +
      (keep === 0 ? "/sn_get" : "") +
      (upstreamHasMore
        ? `; resume offset=${upstreamNextOffset} limit=${args.limit}.`
        : "; no post-window continuation.");
    out.results = results.slice(0, keep);
    return out;
  };

  // Estimate the largest prefix that fits via per-record sizes, then walk
  // down until the exact serialization is within budget (the hint's digits
  // shift the envelope size slightly as `keep` changes).
  const envelope = serializedBytes(build(0));
  let keep = 0;
  let used = envelope;
  for (let i = 0; i < fetched; i++) {
    used += serializedBytes(results[i]) + 1; // +1 for the array comma
    if (used > maxBytes) break;
    keep = i + 1;
  }
  keep = Math.min(keep, fetched - 1); // over budget => at least one record goes
  let out = build(keep);
  while (keep > 0 && serializedBytes(out) > maxBytes) {
    keep -= 1;
    out = build(keep);
  }
  return out;
}

/** Accept only one canonical non-negative safe-integer count header. */
function parseTotalCountHeader(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  return executeQuery(args, client, config, _context);
}

async function executeQuery(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  config: ServiceNowToolSettings,
  context: ExecutionContext
) {
  try {
    const readableFields =
      preparedReadableFields(args, args.table) ??
      resolveReadableFields(args.table, {
        fields: args.fields,
        responseFormat: args.response_format,
      });
    if (
      args.structured_query !== undefined &&
      (args.query !== undefined || args.orderby !== undefined)
    ) {
      throw new StructuredQueryError("invalid_shape");
    }
    const structuredPlan =
      args.structured_query === undefined
        ? undefined
        : compileStructuredQuery(
            args.structured_query,
            resolveReadableFields(args.table, { fields: "all" })
          );
    const rawPlan =
      args.query === undefined
        ? undefined
        : authorizeRawEncodedRead(
            context?.effectivePolicy.encodedQueryAccess,
            {
              tool: "sn_query",
              table: args.table,
              query: args.query,
              limit: args.limit,
              offset: args.offset ?? 0,
              maxResponseBytes: args.max_response_bytes,
              orderBy: args.orderby,
              outputFields: readableFields,
            }
          );
    if (args.orderby) {
      const orderField = args.orderby.startsWith("-")
        ? args.orderby.slice(1)
        : args.orderby;
      resolveReadableFields(args.table, { fields: orderField });
    }
    const queryWithStableOrder = stableOrderQuery(
      structuredPlan?.encodedQuery ?? rawPlan?.query,
      structuredPlan ? undefined : args.orderby,
      structuredPlan?.structuredQuery.order_by
    );
    const params = buildTableParams({
      query: queryWithStableOrder,
      fields: rawPlan?.outputFields
        ? rawPlan.outputFields.join(",")
        : fieldSelectionToSysparmFields(readableFields),
      // Fetch one bounded sentinel row so a missing total-count header never
      // turns an exactly full final page into speculative continuation.
      limit: args.limit + 1,
      offset: args.offset,
      orderby: undefined,
      displayValue: args.display_value ?? config.displayValue,
      noCount: true,
    });
    if (args.force_recache) {
      params[FORCE_RECACHE_PARAM] = "true";
    }

    const resp = await client.getWithMeta(`/api/now/table/${args.table}`, params);
    const rawResults = Array.isArray(resp.data?.result) ? resp.data.result : [];
    const hasSentinel = rawResults.length > args.limit;
    const consumedRawResults = rawResults.slice(0, args.limit);
    const policyFiltered = filterReadableRecord(
      consumedRawResults,
      rawPlan?.outputFields ?? readableFields
    );
    const results = stripEmpty(Array.isArray(policyFiltered) ? policyFiltered : []);
    const offset = args.offset ?? 0;
    const recordCount = results.length;

    const total = parseTotalCountHeader(resp.headers.get("x-total-count"));
    // A valid total header is authoritative. Otherwise the bounded sentinel,
    // not the post-policy returned count, decides continuation: policy/ACL
    // filtering may remove every deliverable row from the consumed window.
    const hasMore =
      total !== undefined
        ? offset + args.limit < total
        : hasSentinel;

    const payload: Record<string, unknown> = { record_count: recordCount };
    if (total !== undefined) payload.total = total;
    payload.has_more = hasMore;
    if (hasMore) {
      // Advance by the requested limit, not the returned count: ACLs/domain
      // separation can strip rows from a page AFTER the limit/offset window
      // is applied, so record_count < limit does not mean the window was
      // short -- offset + record_count would re-read (or infinitely repeat)
      // the same window.
      const nextOffset = offset + args.limit;
      payload.next_offset = nextOffset;
      payload.hint = `More records available. Call sn_query again with offset=${nextOffset}.`;
    }
    payload.results = results;
    return ok(enforceByteBudget(payload, results, args, total));
  } catch (error) {
    throw error;
  }
}

/** Dedicated contract-bearing module for production registration. */
export const queryToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition,
  inputSchema: moduleInputSchema,
  outputSchema: productionToolOutputSchemas.sn_query,
  requirements: {
    permissions: ["read"],
    tables: {
      kind: "dynamic",
      names: [],
      description: "Caller-selected policy-approved table.",
    },
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["records:query"],
  },
  resolveAccess: (args, policy) =>
    resolveToolTableAccess("sn_query", args, policy.encodedQueryAccess),
  handler: async (args, services) =>
    envelopeCompatibilityResult(
      "sn_query",
      args,
      await executeQuery(
        args as unknown as z.infer<typeof schema>,
        services.serviceNow,
        services.settings,
        services.context
      )
    ),
});
