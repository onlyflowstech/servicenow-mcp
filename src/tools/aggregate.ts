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

function isWholeGroup(group: unknown): boolean {
  if (typeof group !== "object" || group === null) return false;
  const { groupby_fields: fields, stats } = group as Record<string, unknown>;
  return Array.isArray(fields) && typeof stats === "object" && stats !== null;
}

/** Total order on groups: code-unit order of each group's canonical form, built once. */
function sortGroupsDeterministically(groups: unknown[]): unknown[] {
  const keyed = groups.map((group) => ({ group, key: canonicalAggregateKey(group) }));
  keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return keyed.map((entry) => entry.group);
}

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

    // A response over the byte limit propagates as the trusted too-large
    // error: only that path gives the caller a category and what to change.
    const resp: { result?: unknown } | null = await client.get(`/api/now/stats/${args.table}`, params);
    if (!groupByField) {
      const single = normalizeAggregateGroups(filterAggregateResult(resp?.result, readableFields));
      return ok(sortGroupsDeterministically(single).slice(0, args.limit + 1));
    }

    // The raw list is counted and cut before the field filter, which has
    // limits of its own: only its first MAX_AGGREGATE_GROUPS groups, in the
    // instance's order, are ever filtered, whether or not the instance
    // honoured the limit. A longer raw list is capped; so is a list the filter
    // gave back with fewer groups than it was given, since the total of a
    // list with groups missing would be false.
    const raw = Array.isArray(resp?.result) ? (resp!.result as unknown[]) : undefined;
    const overCap = raw !== undefined && raw.length > MAX_AGGREGATE_GROUPS;
    const source = raw === undefined ? resp?.result : raw.slice(0, MAX_AGGREGATE_GROUPS);
    const groups = normalizeAggregateGroups(filterAggregateResult(source, readableFields));
    // A group the filter cut short (its stats or group fields gone) is left
    // out too, never shown as if it were whole.
    const whole = groups.filter(isWholeGroup);
    const lost = raw !== undefined && whole.length !== (source as unknown[]).length;

    const known = sortGroupsDeterministically(whole);
    // One group past the page stays in the result: it only says another page
    // exists, and the envelope removes it.
    const page = known.slice(args.offset, args.offset + args.limit + 1);
    const warnings = [
      ...(overCap
        ? [
            `More than ${MAX_AGGREGATE_GROUPS} groups exist; only the first ${MAX_AGGREGATE_GROUPS} in the instance's order by the group field can be paged, and no total is given. Group by a field with fewer distinct values to see them all.`,
          ]
        : []),
      ...(lost
        ? [
            "Some groups were left out of this list by response limits or field policy, so no total is given. Group by a field with fewer distinct values to see them all.",
          ]
        : []),
    ];
    return ok({
      result: page,
      has_more: page.length > args.limit,
      // The group total is known only when every group was read and kept.
      ...(warnings.length === 0 ? { total_groups: known.length } : { truncated: true, warnings }),
    });
  } catch (error) {
    throw error;
  }
}
