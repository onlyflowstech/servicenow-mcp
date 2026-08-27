import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  ENCODED_QUERY_MIGRATION_MESSAGE,
  rejectRawEncodedWrite,
} from "../encoded-query-policy.js";
import { ok, err } from "../utils.js";
import {
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";

export const definition = {
  name: "sn_delete",
  description:
    "Delete a ServiceNow record by sys_id. Requires the confirm flag set to true as a safety measure.",
  annotations: {
    title: "Delete record",
    readOnlyHint: false,
    destructiveHint: true,
    // Repeating a successful delete errors (404) but has no further
    // effect on the instance, matching HTTP DELETE semantics.
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z
  .object({
    table: z.string().describe("ServiceNow table name (e.g. incident)"),
    sys_id: serviceNowSysIdSchema.describe(
      "The 32-hex sys_id of the record to delete"
    ),
    confirm: z
      .boolean()
      .describe(
        "Must be true to execute the deletion. Safety measure to prevent accidental deletes."
      ),
  })
  .strict(ENCODED_QUERY_MIGRATION_MESSAGE);

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  try {
    rejectRawEncodedWrite(
      (args as unknown as Readonly<Record<string, unknown>>).query
    );
    if (!args.confirm) {
      return err(
        "Must set confirm to true to delete records. This is a safety measure."
      );
    }

    // client.delete throws on any failure status, so reaching this point
    // means the deletion succeeded (ServiceNow returns 204 No Content).
    await client.delete(
      `/api/now/table/${args.table}/${serviceNowSysIdPathSegment(args.sys_id)}`
    );

    return ok({
      status: "deleted",
      sys_id: args.sys_id,
      table: args.table,
    });
  } catch (error) {
    throw error;
  }
}
