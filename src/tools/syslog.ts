import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError, truncate } from "../utils.js";

export const definition = {
  name: "sn_syslog",
  description:
    "Query ServiceNow system logs (syslog table) with severity, source, and time-based filters. Results ordered newest first.",
  inputSchema: {
    type: "object" as const,
    properties: {
      level: {
        type: "string",
        enum: ["error", "warning", "info", "debug"],
        description: "Filter by severity level",
      },
      source: {
        type: "string",
        description: "Filter by source field (LIKE match)",
      },
      message: {
        type: "string",
        description: "Filter message contains text (LIKE match)",
      },
      query: {
        type: "string",
        description: "Raw encoded query (overrides individual filters)",
      },
      limit: {
        type: "number",
        description: "Max records (default 25)",
      },
      since: {
        type: "number",
        description: "Show logs from last N minutes (default 60)",
      },
      fields: {
        type: "string",
        description: "Fields to return (default: sys_id,level,source,message,sys_created_on)",
      },
    },
    required: [],
  },
};

export const schema = z.object({
  level: z.enum(["error", "warning", "info", "debug"]).optional(),
  source: z.string().optional(),
  message: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().optional().default(25),
  since: z.number().optional().default(60),
  fields: z.string().optional(),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    const fields = args.fields || "sys_id,level,source,message,sys_created_on";
    let sysparmQuery: string;

    if (args.query) {
      sysparmQuery = args.query;
    } else {
      const parts: string[] = [];
      if (args.level) parts.push(`level=${args.level}`);
      if (args.source) parts.push(`sourceLIKE${args.source}`);
      if (args.message) parts.push(`messageLIKE${args.message}`);
      parts.push(`sys_created_on>=javascript:gs.minutesAgoStart(${args.since})`);
      sysparmQuery = parts.join("^");
    }

    // Always order newest first
    sysparmQuery += "^ORDERBYDESCsys_created_on";

    const resp = await client.get("/api/now/table/syslog", {
      sysparm_query: sysparmQuery,
      sysparm_fields: fields,
      sysparm_limit: String(args.limit),
    });

    const results = (resp.result || []).map((r: Record<string, string>) => ({
      sys_id: r.sys_id,
      timestamp: r.sys_created_on,
      level: r.level,
      source: r.source,
      message: r.message ? truncate(r.message, 300) : undefined,
    }));

    return ok(results);
  } catch (error) {
    return err(formatError(error));
  }
}
