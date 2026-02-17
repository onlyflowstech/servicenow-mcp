import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_create",
  description:
    "Create a new record on any ServiceNow table. Pass field values as a JSON object.",
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name (e.g. incident)",
      },
      fields: {
        type: "object",
        description:
          'JSON object of field name/value pairs (e.g. {"short_description":"Server down","urgency":"1"})',
        additionalProperties: true,
      },
    },
    required: ["table", "fields"],
  },
};

export const schema = z.object({
  table: z.string(),
  fields: z.record(z.unknown()),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    const resp = await client.post(`/api/now/table/${args.table}`, args.fields);
    const result = resp.result || {};
    return ok({
      sys_id: result.sys_id,
      number: result.number,
      result,
    });
  } catch (error) {
    return err(formatError(error));
  }
}
