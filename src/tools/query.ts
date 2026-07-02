import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import {
  ok,
  err,
  formatError,
  buildTableParams,
  stripEmpty,
  serializedBytes,
  MAX_RESPONSE_BYTES_DEFAULT,
  MAX_RESPONSE_BYTES_MIN,
  MAX_RESPONSE_BYTES_MAX,
} from "../utils.js";
import { resolveFields } from "../table-defaults.js";

export const definition = {
  name: "sn_query",
  description:
    "Query any ServiceNow table. Returns records with pagination metadata " +
    "(record_count, total, has_more, next_offset). Field verbosity: an " +
    "explicit fields list always wins; otherwise response_format=\"concise\" " +
    "(default) uses a curated default field set on common tables and " +
    "response_format=\"detailed\" returns full records (same as " +
    "fields=\"all\"). Responses larger than max_response_bytes are truncated " +
    "by dropping whole records from the tail, with a hint for fetching the rest.",
  annotations: {
    title: "Query records",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name (e.g. incident, change_request, sys_user)",
      },
      query: {
        type: "string",
        description:
          "ServiceNow encoded query (e.g. active=true^priority=1). Use ^ for AND, ^OR for OR.",
      },
      fields: {
        type: "string",
        description:
          'Comma-separated list of fields to return. Always takes precedence ' +
          'over response_format. Omit for a curated default field set on ' +
          'common tables; pass "all" for every field.',
      },
      response_format: {
        type: "string",
        enum: ["concise", "detailed"],
        description:
          'Verbosity when fields is omitted (default "concise"). "concise" ' +
          "returns the curated default field set on common tables (full " +
          'record on tables without one); "detailed" always returns the full ' +
          'record (same as fields="all"). Ignored when fields is provided.',
      },
      max_response_bytes: {
        type: "integer",
        minimum: MAX_RESPONSE_BYTES_MIN,
        maximum: MAX_RESPONSE_BYTES_MAX,
        description:
          "Byte budget for the serialized response (default 100000, min 1000, " +
          "max 1000000). When exceeded, whole records are dropped from the " +
          "tail (the JSON is never mangled) and the response gains " +
          "truncated: true plus a hint stating how many records were dropped, " +
          "the total available, and the exact offset/limit/fields/" +
          "response_format follow-up arguments to fetch the rest.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Maximum records to return (default 20, max 1000)",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Pagination offset",
      },
      orderby: {
        type: "string",
        description: "Sort field. Prefix with - for descending (e.g. -sys_created_on)",
      },
      display_value: {
        type: "string",
        enum: ["true", "false", "all"],
        description: "Display values mode: true, false, or all (default: true)",
      },
      profile: {
        type: "string",
        description: "Named profile to use. Defaults to active profile.",
      },
    },
    required: ["table"],
  },
};

export const schema = z.object({
  table: z.string(),
  query: z.string().optional(),
  fields: z.string().optional(),
  response_format: z.enum(["concise", "detailed"]).optional().default("concise"),
  max_response_bytes: z
    .number()
    .int()
    .min(MAX_RESPONSE_BYTES_MIN)
    .max(MAX_RESPONSE_BYTES_MAX)
    .optional()
    .default(MAX_RESPONSE_BYTES_DEFAULT),
  limit: z.number().int().min(1).max(1000).optional().default(20),
  offset: z.number().int().min(0).optional(),
  orderby: z.string().optional(),
  display_value: z.enum(["true", "false", "all"]).optional(),
  profile: z.string().optional().describe("Named profile to use. Defaults to active profile."),
});

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
  const shrinkAdvice =
    args.fields === undefined && args.response_format === "detailed"
      ? 'response_format="concise"'
      : 'a narrower fields list (e.g. fields="sys_id,number,short_description")';

  const build = (keep: number): Record<string, unknown> => {
    const dropped = fetched - keep;
    const out: Record<string, unknown> = { record_count: keep };
    if (total !== undefined) out.total = total;
    out.has_more = true;
    out.next_offset = offset + keep;
    out.truncated = true;
    out.hint =
      `Response truncated to fit max_response_bytes=${maxBytes}: dropped ` +
      `${dropped} of ${fetched} fetched records` +
      (total !== undefined ? ` (${total} total match)` : "") +
      `. Fetch the rest with offset=${offset + keep} and ` +
      `limit=${Math.max(keep, 1)}, shrink records with ${shrinkAdvice}, ` +
      `or raise max_response_bytes (max ${MAX_RESPONSE_BYTES_MAX}).`;
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

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    const params = buildTableParams({
      query: args.query,
      // Precedence: explicit fields > response_format. "detailed" maps to
      // the full record exactly like fields="all"; "concise" (default)
      // keeps the curated DEFAULT_FIELDS behavior.
      fields: resolveFields(
        args.table,
        args.fields ?? (args.response_format === "detailed" ? "all" : undefined)
      ),
      limit: args.limit,
      offset: args.offset,
      orderby: args.orderby,
      displayValue: args.display_value ?? config.displayValue,
    });

    const resp = await client.getWithMeta(`/api/now/table/${args.table}`, params);
    const results = stripEmpty(resp.data?.result || []);
    const offset = args.offset ?? 0;
    const recordCount = results.length;

    const totalHeader = resp.headers.get("x-total-count");
    const total =
      totalHeader !== null && Number.isFinite(Number(totalHeader))
        ? Number(totalHeader)
        : undefined;
    const hasMore =
      total !== undefined ? offset + recordCount < total : recordCount === args.limit;

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
    return err(formatError(error));
  }
}
