import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError, buildTableParams, stripEmpty } from "../utils.js";
import { resolveFields } from "../table-defaults.js";

export const definition = {
  name: "sn_query",
  description:
    "Query any ServiceNow table. Returns records with pagination metadata " +
    "(record_count, total, has_more, next_offset). Omit fields for a curated " +
    'default field set on common tables; pass fields="all" for every field.',
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
          'Comma-separated list of fields to return. Omit for a curated default ' +
          'field set on common tables; pass "all" for every field.',
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
  limit: z.number().int().min(1).max(1000).optional().default(20),
  offset: z.number().int().min(0).optional(),
  orderby: z.string().optional(),
  display_value: z.enum(["true", "false", "all"]).optional(),
  profile: z.string().optional().describe("Named profile to use. Defaults to active profile."),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    const params = buildTableParams({
      query: args.query,
      fields: resolveFields(args.table, args.fields),
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
    return ok(payload);
  } catch (error) {
    return err(formatError(error));
  }
}
