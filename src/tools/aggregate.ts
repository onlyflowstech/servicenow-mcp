import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  authorizeRawEncodedRead,
  ENCODED_QUERY_MIGRATION_MESSAGE,
} from "../encoded-query-policy.js";
import {
  filterAggregateResult,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { ok, err } from "../utils.js";

const MAX_AGGREGATE_OFFSET = 10_000;
const MAX_AGGREGATE_PAGE = 1_000;

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
  .object({
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
  })
  .strict(ENCODED_QUERY_MIGRATION_MESSAGE);

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
        : resolveReadableFields(args.table, { fields: args.field })[0];
    const groupByField =
      args.group_by === undefined
        ? undefined
        : resolveReadableFields(args.table, { fields: args.group_by })[0];
    if (aggregateField) selectedFields.push(aggregateField);
    if (groupByField && !selectedFields.includes(groupByField)) {
      selectedFields.push(groupByField);
    }
    if (selectedFields.length === 0) selectedFields.push("sys_id");
    const readableFields =
      preparedReadableFields(args, args.table) ??
      resolveReadableFields(args.table, { fields: selectedFields.join(",") });

    const params: Record<string, string> = {
      // Fetch one sentinel group so the shared envelope can determine whether
      // another page exists without guessing from a full page.
      sysparm_limit: String(groupByField ? args.limit + 1 : 1),
      sysparm_offset: String(groupByField ? args.offset : 0),
    };

    if (aggType === "COUNT") {
      params.sysparm_count = "true";
    } else {
      params[`sysparm_${aggType.toLowerCase()}_fields`] = aggregateField!;
    }

    if (groupByField) {
      params.sysparm_group_by = groupByField;
      // ServiceNow's Aggregate API supports ordering grouped results by a
      // group field. This makes offset pagination stable at the source.
      params.sysparm_order_by = groupByField;
    }
    if (args.display_value) {
      params.sysparm_display_value = args.display_value;
    }

    const resp = await client.get(`/api/now/stats/${args.table}`, params);
    const filtered = filterAggregateResult(resp.result, readableFields);
    const groups = Array.isArray(filtered) ? filtered : [];
    groups.sort((left, right) =>
      canonicalAggregateKey(left).localeCompare(canonicalAggregateKey(right))
    );
    return ok(groups.slice(0, args.limit + 1));
  } catch (error) {
    throw error;
  }
}
