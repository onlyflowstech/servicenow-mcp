import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_delete",
  description:
    "Delete a ServiceNow record by sys_id. Requires the confirm flag set to true as a safety measure.",
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name (e.g. incident)",
      },
      sys_id: {
        type: "string",
        description: "The sys_id of the record to delete",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to execute the deletion. Safety measure to prevent accidental deletes.",
      },
    },
    required: ["table", "sys_id", "confirm"],
  },
};

export const schema = z.object({
  table: z.string(),
  sys_id: z.string(),
  confirm: z.boolean(),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    if (!args.confirm) {
      return err(
        "Must set confirm to true to delete records. This is a safety measure."
      );
    }

    const resp = await client.delete(
      `/api/now/table/${args.table}/${args.sys_id}`
    );

    if (resp.status === 204 || resp.status === 200) {
      return ok({
        status: "deleted",
        sys_id: args.sys_id,
        table: args.table,
      });
    }

    return err(`Delete failed with HTTP ${resp.status}`);
  } catch (error) {
    return err(formatError(error));
  }
}
