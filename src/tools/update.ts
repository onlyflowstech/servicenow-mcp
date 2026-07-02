import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError, stripEmpty } from "../utils.js";

export const definition = {
  name: "sn_update",
  description:
    "Update an existing ServiceNow record. Pass the sys_id and field values to change. " +
    "Returns sys_id and the updated record (empty fields stripped) under record.",
  annotations: {
    title: "Update record",
    readOnlyHint: false,
    // PATCHes existing data in place (recoverable via audit history) and
    // repeating the same field values yields the same record state.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
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
      profile: {
        type: "string",
        description: "Named profile to use. Defaults to active profile.",
      },
    },
    required: ["table", "sys_id", "fields"],
  },
};

export const schema = z.object({
  table: z.string(),
  sys_id: z.string(),
  fields: z.record(z.unknown()),
  profile: z.string().optional().describe("Named profile to use. Defaults to active profile."),
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
    const { sys_id, ...rest } = resp.result || {};
    return ok({
      sys_id: sys_id ?? args.sys_id,
      record: stripEmpty(rest),
    });
  } catch (error) {
    return err(formatError(error));
  }
}
