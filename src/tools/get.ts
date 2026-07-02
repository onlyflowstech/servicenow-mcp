import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError, buildTableParams, stripEmpty } from "../utils.js";
import { resolveFields } from "../table-defaults.js";

export const definition = {
  name: "sn_get",
  description:
    "Get a single ServiceNow record by sys_id. Omit fields for a curated " +
    'default field set on common tables; pass fields="all" for every field.',
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
        description:
          'Comma-separated list of fields to return. Omit for a curated default ' +
          'field set on common tables; pass "all" for every field.',
      },
      display_value: {
        type: "string",
        enum: ["true", "false", "all"],
        description: "Display values mode: true, false, or all",
      },
      profile: {
        type: "string",
        description: "Named profile to use. Defaults to active profile.",
      },
    },
    required: ["table", "sys_id"],
  },
};

export const schema = z.object({
  table: z.string(),
  sys_id: z.string(),
  fields: z.string().optional(),
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
      fields: resolveFields(args.table, args.fields),
      displayValue: args.display_value ?? config.displayValue,
    });

    const resp = await client.get(
      `/api/now/table/${args.table}/${args.sys_id}`,
      params
    );
    return ok(stripEmpty(resp.result));
  } catch (error) {
    return err(formatError(error));
  }
}
