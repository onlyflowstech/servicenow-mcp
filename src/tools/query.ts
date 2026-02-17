import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError, buildTableParams } from "../utils.js";

export const definition = {
  name: "sn_query",
  description:
    "Query any ServiceNow table. Returns records matching the encoded query with support for field selection, pagination, sorting, and display values.",
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
        description: "Comma-separated list of fields to return",
      },
      limit: {
        type: "number",
        description: "Maximum records to return (default 20)",
      },
      offset: {
        type: "number",
        description: "Pagination offset",
      },
      orderby: {
        type: "string",
        description: "Sort field. Prefix with - for descending (e.g. -sys_created_on)",
      },
      display_value: {
        type: "string",
        description: "Display values mode: true, false, or all (default: true)",
      },
    },
    required: ["table"],
  },
};

export const schema = z.object({
  table: z.string(),
  query: z.string().optional(),
  fields: z.string().optional(),
  limit: z.number().optional().default(20),
  offset: z.number().optional(),
  orderby: z.string().optional(),
  display_value: z.string().optional(),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    const params = buildTableParams({
      query: args.query,
      fields: args.fields,
      limit: args.limit,
      offset: args.offset,
      orderby: args.orderby,
      displayValue: args.display_value ?? config.displayValue,
    });

    const resp = await client.get(`/api/now/table/${args.table}`, params);
    const results = resp.result || [];
    return ok({
      record_count: results.length,
      results,
    });
  } catch (error) {
    return err(formatError(error));
  }
}
