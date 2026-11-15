/** Canonical contract-bearing sn_query module. */

import { allFieldsCapNotice, boundedAllFields } from "./all-fields-cap.js";
import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import { FORCE_RECACHE_PARAM } from "../metadata-cache.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  authorizeRawEncodedRead,
  ENCODED_QUERY_STRICT_OBJECT_PARAMS,
} from "../encoded-query-policy.js";
import {
  fieldSelectionToSysparmFields,
  isAllFieldSelection,
  isSensitiveFieldName,
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import {
  compileStructuredQuery,
  StructuredQueryError,
  structuredQueryReadSchema,
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
import { neededResponseBytes, renderTruncationHint } from "./truncation-hint.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  type ToolDefinition,
} from "./tool-module.js";

// Only this tool reads a list filter as AND (sn_batch does not), so the
// example lives here and not in the shared schema text.
const STRUCTURED_FILTER_TOOL_EXAMPLE =
  'Filter example (a list means AND): structured_query={filter:[{type:"equality",' +
  'field:"active",operator:"eq",value:true},{type:"text",field:"name",' +
  'operator:"contains",value:"fleet"}]}. OR: {type:"group",operator:"or",conditions:[...]}.';

export const definition = Object.freeze({
  name: "sn_query",
  description:
    "Query a policy-approved ServiceNow table. Returns records with pagination metadata " +
    "(record_count, has_more, next_offset; no table total, which would cost a COUNT query: page with next_offset until has_more is false). Field verbosity: an " +
    "explicit fields list always wins; otherwise response_format=\"concise\" " +
    "(default) uses the table's safe default field set and " +
    "response_format=\"detailed\" returns all policy-approved readable fields " +
    "(same as fields=\"all\"). Responses larger than max_response_bytes are truncated " +
    "by dropping whole records from the tail, with a hint for fetching the rest. " +
    STRUCTURED_FILTER_TOOL_EXAMPLE,
  annotations: Object.freeze({
    title: "Query records",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  }),
} satisfies ToolDefinition);

function compatibleInputSchema() {
  return z.strictObject({
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
    structured_query: structuredQueryReadSchema
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
          "true, has_more: true and a hint with the dropped count and the " +
          "offset, limit, max_response_bytes, fields or response_format to " +
          "retry with. Cache and timing metadata (under 100 bytes) are not counted."
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
  }, ENCODED_QUERY_STRICT_OBJECT_PARAMS);
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

/** Most fields a recovery hint suggests. */
const SUGGESTED_FIELD_LIMIT = 3;
/** A caller's own field list is offered back only up to this many names. */
const SUGGESTED_CHOSEN_FIELD_LIMIT = 12;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
/** Readable fields that identify a record to a person, in order of preference. */
const DISPLAY_FIELDS: readonly string[] = ["number", "name", "short_description", "title"];
/**
 * Columns that hold a record's bulk (code, markup, free text), which a slimmer
 * projection leaves out. short_description is short, so it is not in the set.
 */
const LARGE_FIELDS: ReadonlySet<string> = new Set([
  "script",
  "condition",
  "description",
  "text",
  "body",
  "payload",
  "comments",
  "work_notes",
  "close_notes",
  "html",
  "xml",
]);

function isLargeField(field: string): boolean {
  return LARGE_FIELDS.has(field) || /_(?:script|html|xml|json|payload)$/u.test(field);
}

/**
 * A short field list that exists for `table`, for a recovery hint: the table's
 * configured default fields without the large ones, at most
 * {@link SUGGESTED_FIELD_LIMIT}. When that leaves nothing but sys_id, sys_id
 * plus the table's display field if its readable fields name one, else sys_id
 * alone. Every name comes from the field policy, never from the caller, and a
 * name on the sensitive-field blocklist is never suggested.
 * Returns undefined when the suggestion would not narrow what was requested
 * or the policy cannot be resolved.
 */
function suggestedFields(table: string): readonly string[] | undefined {
  try {
    const defaults = resolveReadableFields(table);
    if (isAllFieldSelection(defaults)) return undefined;
    const usable = (field: string) =>
      FIELD_NAME.test(field) && !isSensitiveFieldName(field);
    let suggestion = defaults
      .filter((field) => usable(field) && !isLargeField(field))
      .slice(0, SUGGESTED_FIELD_LIMIT);
    if (!suggestion.some((field) => field !== "sys_id")) {
      const readable = resolveReadableFields(table, { fields: "all" });
      const allows = (field: string) =>
        isAllFieldSelection(readable) ? false : readable.includes(field);
      const display = DISPLAY_FIELDS.find(allows);
      suggestion = [
        ...(allows("sys_id") || defaults.includes("sys_id") ? ["sys_id"] : []),
        ...(display === undefined ? [] : [display]),
      ];
    }
    // Suggesting what the read already returned would not shrink it.
    const alreadyRequested =
      suggestion.length === defaults.length &&
      suggestion.every((field) => defaults.includes(field));
    return suggestion.length === 0 || alreadyRequested ? undefined : suggestion;
  } catch {
    return undefined;
  }
}

/**
 * The fields of a caller's own list that the hint may offer back: the names
 * without the large ones (see {@link isLargeField}), or undefined when it
 * would not narrow the list. Every name must be one the policy lets this
 * caller read (so no sensitive or unreadable field is ever repeated) and a
 * well-formed field name; if any name fails that, nothing is offered rather
 * than a list that silently leaves one out.
 */
function slimmerChosenFields(table: string, chosen: string): readonly string[] | undefined {
  try {
    const names = [
      ...new Set(
        chosen
          .split(",")
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name !== "")
      ),
    ];
    const readable = resolveReadableFields(table, { fields: "all" });
    const allows = (name: string) =>
      FIELD_NAME.test(name) &&
      !isSensitiveFieldName(name) &&
      (isAllFieldSelection(readable) || readable.includes(name));
    if (names.length === 0 || names.length > SUGGESTED_CHOSEN_FIELD_LIMIT || !names.every(allows)) {
      return undefined;
    }
    const slimmer = names.filter((name) => !isLargeField(name));
    return slimmer.length > 0 && slimmer.length < names.length ? slimmer : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How the caller can shrink a truncated read, or undefined when no field
 * advice applies (the hint then gives a `limit` and a byte budget). A detailed
 * read is pointed back at the concise default. A caller who chose their own
 * `fields` gets that list without its large fields (such as `script`) when it
 * has any; a list without them gets no field advice, since only a lower limit
 * or a bigger budget can help. A read of every field, or of no particular
 * fields, gets a short list of fields that exist on the table.
 *
 * A registered call arrives with `fields` already resolved from the caller's
 * request: the default list for a concise read, "all" for a detailed read or
 * for fields="all". So an unset `fields`, the table's own default list, and
 * "all" with response_format="detailed" all mean the caller chose no fields;
 * any other value is the caller's own selection. The one case this cannot
 * tell apart is a caller who typed the table's default list themselves: they
 * get the suggestion, a valid and shorter list.
 */
function shrinkAdviceFor(args: z.infer<typeof schema>): string | undefined {
  const detailed = args.response_format === "detailed";
  if (detailed && (args.fields === undefined || args.fields === "all")) {
    return 'response_format="concise"';
  }
  if (
    args.fields !== undefined &&
    args.fields !== "all" &&
    args.fields !== defaultFieldList(args.table)
  ) {
    const slimmer = slimmerChosenFields(args.table, args.fields);
    return slimmer === undefined ? undefined : `fields="${slimmer.join(",")}"`;
  }
  const fields = suggestedFields(args.table);
  return fields === undefined ? undefined : `fields="${fields.join(",")}"`;
}

function defaultFieldList(table: string): string | undefined {
  try {
    return resolveReadableFields(table).join(",");
  } catch {
    return undefined;
  }
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
  byteCap: number
): Record<string, unknown> {
  const maxBytes = args.max_response_bytes;
  if (results.length === 0 || serializedBytes(payload) <= maxBytes) return payload;

  const fetched = results.length;
  const offset = args.offset ?? 0;
  const shrinkAdvice = shrinkAdviceFor(args);
  // The byte budget the hint names is measured, not guessed: build(keep) with
  // the widest value is the size of the response that would hold `keep` rows.
  // This stage measures the payload alone; the shared envelope restates the
  // number with its own cost added (see refreshTruncationHint).
  const build = (
    keep: number,
    neededBytes: number,
    allBytes?: number
  ): Record<string, unknown> => {
    const dropped = fetched - keep;
    const out: Record<string, unknown> = { record_count: keep };
    // Rows were dropped, so rows exist that this response does not hold:
    // has_more is true whatever lies beyond the window. The rows returned are
    // a prefix of the window, so offset + keep is the first row not returned,
    // and following next_offset re-reads the dropped rows before anything
    // later. With no row returned the same offset cannot advance: next_offset
    // is left out and the request has to change (see the hint).
    out.has_more = true;
    if (keep > 0) out.next_offset = offset + keep;
    out.truncated = true;
    out.dropped_records = dropped;
    // Keep the recovery hint compact enough that a zero-record production
    // envelope can still fit the minimum byte budget after shared metadata is
    // added. The structured pagination object carries the same retry/resume
    // distinction for machine clients. The shared envelope restates the
    // counts, the continuation and the byte budget if it drops more rows (see
    // refreshTruncationHint), so the text always matches dropped_records.
    out.hint = renderTruncationHint({
      dropped,
      total: fetched,
      offset,
      ...(shrinkAdvice === undefined ? {} : { advice: shrinkAdvice }),
      neededBytes,
      ...(allBytes === undefined ? {} : { allBytes }),
      capBytes: byteCap,
    });
    out.results = results.slice(0, keep);
    return out;
  };
  const WIDEST = Number.POSITIVE_INFINITY;

  // Estimate the largest prefix that fits via per-record sizes, then walk
  // down until the exact serialization is within budget (the hint's digits
  // shift the envelope size slightly as `keep` changes).
  const envelope = serializedBytes(build(0, WIDEST, WIDEST));
  let keep = 0;
  let used = envelope;
  for (let i = 0; i < fetched; i++) {
    used += serializedBytes(results[i]) + 1; // +1 for the array comma
    if (used > maxBytes) break;
    keep = i + 1;
  }
  keep = Math.min(keep, fetched - 1); // over budget => at least one record goes
  let out = build(keep, WIDEST, WIDEST);
  while (keep > 0 && serializedBytes(out) > maxBytes) {
    keep -= 1;
    out = build(keep, WIDEST, WIDEST);
  }
  // The budget that would hold one more row. The widest hint is what was
  // measured, so the number is never too small once the real, shorter hint
  // replaces it.
  const withNextRow = serializedBytes(build(keep + 1, WIDEST, WIDEST));
  const needed = neededResponseBytes(withNextRow, maxBytes, byteCap);
  // The budget for the whole window: the response with the next row plus the
  // rows after it. It stops adding once it passes the largest budget there
  // is, so a window far over the maximum costs no more than the maximum.
  let withAllRows = withNextRow;
  for (let i = keep + 1; i < fetched && withAllRows <= byteCap; i++) {
    withAllRows += serializedBytes(results[i]) + 1;
  }
  const whole = neededResponseBytes(withAllRows, maxBytes, byteCap);
  return build(keep, needed, Number.isFinite(whole) ? whole : undefined);
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
    // A wildcard selection would drop sysparm_fields and pull every column,
    // which errors on a wide table rather than returning a trimmed record.
    const bounded = isAllFieldSelection(readableFields)
      ? await boundedAllFields(
          client,
          args.table,
          resolveReadableFields(args.table),
          args.force_recache === true
        )
      : undefined;
    const effectiveFields = bounded ? bounded.fields : readableFields;
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
        : fieldSelectionToSysparmFields(effectiveFields),
      // Fetch one bounded sentinel row: it is the only continuation signal.
      // The request sets sysparm_no_count, so ServiceNow skips the COUNT and
      // the X-Total-Count header reports the size of this response (limit +
      // sentinel), not the table. It is therefore never read, and no total is
      // reported; a caller pages on has_more/next_offset.
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
      rawPlan?.outputFields ?? effectiveFields
    );
    const results = stripEmpty(Array.isArray(policyFiltered) ? policyFiltered : []);
    const offset = args.offset ?? 0;
    const recordCount = results.length;

    // The sentinel, not the post-policy returned count, decides continuation:
    // policy/ACL filtering may remove every deliverable row from the consumed
    // window.
    const hasMore = hasSentinel;

    const payload: Record<string, unknown> = { record_count: recordCount };
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
    if (bounded?.capped === true) {
      // The caller asked for every field and did not get every field. Without
      // this they would conclude the missing columns do not exist.
      const notice = allFieldsCapNotice(bounded, args.table);
      payload.hint =
        typeof payload.hint === "string" ? `${payload.hint} ${notice}` : notice;
    }
    payload.results = results;
    // A raw read is held to its rule's byte cap, so the hint never offers more.
    return ok(
      enforceByteBudget(
        payload,
        results,
        args,
        Math.min(rawPlan?.maxResponseBytes ?? MAX_RESPONSE_BYTES_MAX, MAX_RESPONSE_BYTES_MAX)
      )
    );
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
