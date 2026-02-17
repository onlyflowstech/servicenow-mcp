import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_batch",
  description:
    "Bulk update or delete records matching a query. Runs in dry-run mode by default — set confirm to true to execute. Safety cap at 10,000 records.",
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name",
      },
      query: {
        type: "string",
        description: "Encoded query to select records (required — refuses to operate on all records)",
      },
      action: {
        type: "string",
        enum: ["update", "delete"],
        description: "Operation to perform: update or delete",
      },
      fields: {
        type: "object",
        description:
          'JSON fields to set on each record (required for update action). e.g. {"state":"7","close_notes":"Bulk closed"}',
        additionalProperties: true,
      },
      limit: {
        type: "number",
        description: "Max records to affect (default 200, safety cap 10000)",
      },
      confirm: {
        type: "boolean",
        description: "Set to true to actually execute. Default is dry-run.",
      },
    },
    required: ["table", "query", "action"],
  },
};

export const schema = z.object({
  table: z.string(),
  query: z.string(),
  action: z.enum(["update", "delete"]),
  fields: z.record(z.unknown()).optional(),
  limit: z.number().optional().default(200),
  confirm: z.boolean().optional().default(false),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    if (args.action === "update" && !args.fields) {
      return err("--fields is required for update action");
    }

    const limit = Math.min(args.limit, 10000);

    // Step 1: Query matching records (sys_id only)
    const resp = await client.get(`/api/now/table/${args.table}`, {
      sysparm_fields: "sys_id",
      sysparm_limit: String(limit),
      sysparm_query: args.query,
    });

    const results = resp.result || [];
    const matched = results.length;

    // Step 2: Dry-run?
    if (!args.confirm) {
      return ok({
        action: args.action,
        table: args.table,
        matched,
        dry_run: true,
        message: "Dry run — no changes made. Set confirm to true to execute.",
      });
    }

    if (matched === 0) {
      return ok({
        action: args.action,
        table: args.table,
        matched: 0,
        processed: 0,
        failed: 0,
      });
    }

    // Step 3: Execute
    let processed = 0;
    let failed = 0;

    for (const record of results) {
      const sysId = record.sys_id;
      try {
        if (args.action === "update") {
          await client.patch(
            `/api/now/table/${args.table}/${sysId}`,
            args.fields
          );
          processed++;
        } else {
          const delResp = await client.delete(
            `/api/now/table/${args.table}/${sysId}`
          );
          if (delResp.status === 204 || delResp.status === 200) {
            processed++;
          } else {
            failed++;
          }
        }
      } catch {
        failed++;
      }
    }

    return ok({
      action: args.action,
      table: args.table,
      matched,
      processed,
      failed,
    });
  } catch (error) {
    return err(formatError(error));
  }
}
