import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_update",
  description:
    "Update an existing ServiceNow record. Pass the sys_id and field values to change.",
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name (e.g. incident)",
      },
      sys_id: {
        type: "string",
        description: "The sys_id of the record to update",
      },
      fields: {
        type: "object",
        description:
          'JSON object of field name/value pairs to update (e.g. {"state":"6","close_notes":"Fixed"})',
        additionalProperties: true,
      },
    },
    required: ["table", "sys_id", "fields"],
  },
};

export const schema = z.object({
  table: z.string(),
  sys_id: z.string(),
  fields: z.record(z.unknown()),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    const resp = await client.patch(
      `/api/now/table/${args.table}/${args.sys_id}`,
      args.fields
    );
    return ok(resp.result);
  } catch (error) {
    return err(formatError(error));
  }
}
