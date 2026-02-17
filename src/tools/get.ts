import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_get",
  description:
    "Get a single ServiceNow record by sys_id. Returns all fields or a specified subset.",
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name (e.g. incident)",
      },
      sys_id: {
        type: "string",
        description: "The sys_id of the record to retrieve",
      },
      fields: {
        type: "string",
        description: "Comma-separated list of fields to return",
      },
      display_value: {
        type: "string",
        description: "Display values mode: true, false, or all",
      },
    },
    required: ["table", "sys_id"],
  },
};

export const schema = z.object({
  table: z.string(),
  sys_id: z.string(),
  fields: z.string().optional(),
  display_value: z.string().optional(),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    const params: Record<string, string> = {};
    if (args.fields) params.sysparm_fields = args.fields;
    params.sysparm_display_value = args.display_value ?? config.displayValue;

    const resp = await client.get(
      `/api/now/table/${args.table}/${args.sys_id}`,
      params
    );
    return ok(resp.result);
  } catch (error) {
    return err(formatError(error));
  }
}
