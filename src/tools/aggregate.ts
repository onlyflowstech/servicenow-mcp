import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_aggregate",
  description:
    "Run aggregate queries (COUNT, AVG, MIN, MAX, SUM) on a ServiceNow table with optional grouping.",
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name (e.g. incident)",
      },
      type: {
        type: "string",
        enum: ["COUNT", "AVG", "MIN", "MAX", "SUM"],
        description: "Aggregation type",
      },
      query: {
        type: "string",
        description: "ServiceNow encoded query filter",
      },
      field: {
        type: "string",
        description: "Field to aggregate on (required for AVG, MIN, MAX, SUM)",
      },
      group_by: {
        type: "string",
        description: "Group results by this field",
      },
      display_value: {
        type: "string",
        description: "Display values mode: true, false, or all",
      },
    },
    required: ["table", "type"],
  },
};

export const schema = z.object({
  table: z.string(),
  type: z.enum(["COUNT", "AVG", "MIN", "MAX", "SUM"]),
  query: z.string().optional(),
  field: z.string().optional(),
  group_by: z.string().optional(),
  display_value: z.string().optional(),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    const aggType = args.type.toUpperCase();

    if (aggType !== "COUNT" && !args.field) {
      return err(`${aggType} requires a field parameter`);
    }

    const params: Record<string, string> = {};

    if (aggType === "COUNT") {
      params.sysparm_count = "true";
    } else {
      params[`sysparm_${aggType.toLowerCase()}_fields`] = args.field!;
    }

    if (args.query) params.sysparm_query = args.query;
    if (args.group_by) params.sysparm_group_by = args.group_by;
    if (args.display_value) {
      params.sysparm_display_value = args.display_value;
    }

    const resp = await client.get(`/api/now/stats/${args.table}`, params);
    return ok(resp.result);
  } catch (error) {
    return err(formatError(error));
  }
}
