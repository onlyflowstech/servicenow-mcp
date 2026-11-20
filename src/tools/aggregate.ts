import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  authorizeRawEncodedRead,
  ENCODED_QUERY_STRICT_OBJECT_PARAMS,
} from "../encoded-query-policy.js";
import {
  filterAggregateResult,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import type { EnvelopeTextRenderer } from "./result-envelope.js";
import { isServiceNowResponseTooLarge } from "../response-too-large.js";
import { ok, err } from "../utils.js";

const MAX_AGGREGATE_OFFSET = 10_000;
const MAX_AGGREGATE_PAGE = 1_000;
/**
 * The most groups one call reads. The Stats API does not page grouped results
 * (it ignores sysparm_limit and sysparm_offset), so a grouped call reads the
 * group list in one request, orders it here and pages it here. A group is
 * about 100 to 150 bytes, so this many fit the 1 MiB upstream response limit
 * with room to spare; a list longer than this is reported as truncated.
 */
export const MAX_AGGREGATE_GROUPS = 5_000;

function canonicalAggregateKey(value: unknown, depth = 0): string {
  if (depth > 8) return "<depth-limit>";
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalAggregateKey(entry, depth + 1))
      .join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalAggregateKey(
            Reflect.get(value, key),
            depth + 1
          )}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function normalizeAggregateGroups(filtered: unknown): unknown[] {
  if (Array.isArray(filtered)) return filtered;
  if (
    typeof filtered === "object" &&
    filtered !== null &&
    !Array.isArray(filtered) &&
    "stats" in filtered
  ) {
    return [filtered];
  }
  return [];
}

/** Total order on groups: code-unit order of each group's canonical form, built once. */
function sortGroupsDeterministically(groups: unknown[]): unknown[] {
  const keyed = groups.map((group) => ({ group, key: canonicalAggregateKey(group) }));
  keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return keyed.map((entry) => entry.group);
}

/**
 * The text of a grouped page: the dispatcher's summary (with the paging line
 * and any truncation reason), then the group total when every group was read,
 * and the tool's cap warning when the list was cut at the cap. The warning is
 * the tool's own fixed wording, never ServiceNow data. It stays in the text
 * when the page was also cut for size, which then names `byte_limit` in the
 * metadata.
 */
export const aggregateTextRenderer: EnvelopeTextRenderer = (envelope, context) => {
  const data = envelope.data as { total_groups?: unknown; warnings?: unknown } | null;
  const parts = [context.summary];
  if (typeof data?.total_groups === "number") parts.push(`Total groups: ${data.total_groups}.`);
  if (Array.isArray(data?.warnings)) {
    for (const warning of data.warnings) if (typeof warning === "string") parts.push(warning);
  }
  return parts.join(" ");
};

export const definition = {
  name: "sn_aggregate",
  description:
    "Run aggregate queries (COUNT, AVG, MIN, MAX, SUM) on a ServiceNow table with optional grouping.",
  annotations: {
    title: "Aggregate records",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z
  .strictObject({
    table: z.string().describe("ServiceNow table name (e.g. incident)"),
    type: z
      .enum(["COUNT", "AVG", "MIN", "MAX", "SUM"])
      .describe("Aggregation type"),
    field: z
      .string()
      .optional()
      .describe("Field to aggregate on (required for AVG, MIN, MAX, SUM)"),
    group_by: z.string().optional().describe("Group results by this field"),
    display_value: z
      .enum(["true", "false", "all"])
      .optional()
      .describe("Display values mode: true, false, or all"),
    limit: z.number().int().min(1).max(MAX_AGGREGATE_PAGE).optional().default(MAX_AGGREGATE_PAGE).describe("Maximum aggregate groups to return (default and max 1000)"),
    offset: z.number().int().min(0).max(MAX_AGGREGATE_OFFSET).optional().default(0).describe("Deterministic aggregate-group offset (default 0)"),
  }, ENCODED_QUERY_STRICT_OBJECT_PARAMS);

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  try {
    const rawQuery = (args as unknown as Readonly<Record<string, unknown>>).query;
    if (rawQuery !== undefined) {
      authorizeRawEncodedRead(_context?.effectivePolicy.encodedQueryAccess, {
        tool: "sn_aggregate",
        table: args.table,
        query: rawQuery,
        limit: 1,
        offset: 0,
        maxResponseBytes: 100_000,
        outputFields: [],
      });
    }
    const aggType = args.type.toUpperCase();

    if (aggType !== "COUNT" && !args.field) {
      return err(`${aggType} requires a field parameter`);
    }
    const selectedFields: string[] = [];
    const aggregateField =
      args.field === undefined
        ? undefined
        : resolveReadableFields(args.table, { fields: args.field, purpose: "query" })[0];
    const groupByField =
      args.group_by === undefined
        ? undefined
        : resolveReadableFields(args.table, { fields: args.group_by, purpose: "query" })[0];
    if (aggregateField) selectedFields.push(aggregateField);
    if (groupByField && !selectedFields.includes(groupByField)) {
      selectedFields.push(groupByField);
    }
    if (selectedFields.length === 0) selectedFields.push("sys_id");
    const readableFields =
      preparedReadableFields(args, args.table) ??
      resolveReadableFields(args.table, { fields: selectedFields.join(",") });

    const params: Record<string, string> = {
      // Grouped: ask for one group more than the cap, so a longer list is
      // noticed (an instance that honours the limit then sends up to that
      // many groups even for a small page: a deliberate trade for one
      // request and one stable order), and send no offset: the server's paging of groups is not
      // relied on (it may ignore both). Ungrouped: one aggregate row.
      sysparm_limit: String(groupByField ? MAX_AGGREGATE_GROUPS + 1 : 1),
      ...(groupByField ? {} : { sysparm_offset: "0" }),
    };

    if (aggType === "COUNT") {
      params.sysparm_count = "true";
    } else {
      params[`sysparm_${aggType.toLowerCase()}_fields`] = aggregateField!;
    }

    if (groupByField) {
      params.sysparm_group_by = groupByField;
      params.sysparm_order_by = groupByField;
    }
    if (args.display_value) {
      params.sysparm_display_value = args.display_value;
    }

    let resp: { result?: unknown } | null;
    try {
      resp = await client.get(`/api/now/stats/${args.table}`, params);
    } catch (error) {
      if (groupByField && isServiceNowResponseTooLarge(error)) {
        return err(
          `The group list for ${args.table} grouped by ${groupByField} is too large to read in one response. ` +
            "Group by a field with fewer distinct values, or set display_value to false."
        );
      }
      throw error;
    }
    const filtered = filterAggregateResult(resp?.result, readableFields);
    const groups = normalizeAggregateGroups(filtered);
    if (!groupByField) {
      return ok(sortGroupsDeterministically(groups).slice(0, args.limit + 1));
    }

    // Order the whole list, keep what the cap allows, then page it here.
    const ordered = sortGroupsDeterministically(groups);
    const capped = ordered.length > MAX_AGGREGATE_GROUPS;
    const known = capped ? ordered.slice(0, MAX_AGGREGATE_GROUPS) : ordered;
    // One group past the page stays in the result: it only says another page
    // exists, and the envelope removes it.
    const page = known.slice(args.offset, args.offset + args.limit + 1);
    return ok({
      result: page,
      has_more: page.length > args.limit,
      // The group total is known only when every group was read.
      ...(capped ? {} : { total_groups: known.length }),
      ...(capped
        ? {
            truncated: true,
            warnings: [
              `More than ${MAX_AGGREGATE_GROUPS} groups exist; only the first ${MAX_AGGREGATE_GROUPS} in order can be paged and no total is given. Group by a field with fewer distinct values to see them all.`,
            ],
          }
        : {}),
    });
  } catch (error) {
    throw error;
  }
}
