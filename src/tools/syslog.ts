import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError, truncate } from "../utils.js";

export const definition = {
  name: "sn_syslog",
  description:
    "Query ServiceNow system logs (syslog table) with severity, source, and time-based filters. " +
    "Results ordered newest first, with pagination metadata (record_count, total, has_more, next_offset).",
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
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Max records (default 25, max 1000)",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Pagination offset",
      },
      since: {
        type: "number",
        description: "Show logs from last N minutes (default 60)",
      },
      fields: {
        type: "string",
        description: "Fields to return (default: sys_id,level,source,message,sys_created_on)",
      },
      profile: {
        type: "string",
        description: "Named profile to use. Defaults to active profile.",
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
  limit: z.number().int().min(1).max(1000).optional().default(25),
  offset: z.number().int().min(0).optional(),
  since: z.number().optional().default(60),
  fields: z.string().optional(),
  profile: z.string().optional().describe("Named profile to use. Defaults to active profile."),
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

    const params: Record<string, string> = {
      sysparm_query: sysparmQuery,
      sysparm_fields: fields,
      sysparm_limit: String(args.limit),
    };
    if (args.offset !== undefined) params.sysparm_offset = String(args.offset);

    const resp = await client.getWithMeta("/api/now/table/syslog", params);

    const results = (resp.data?.result || []).map((r: Record<string, string>) => ({
      sys_id: r.sys_id,
      timestamp: r.sys_created_on,
      level: r.level,
      source: r.source,
      message: r.message ? truncate(r.message, 300) : undefined,
    }));

    const offset = args.offset ?? 0;
    const recordCount = results.length;
    const totalHeader = resp.headers.get("x-total-count");
    const total =
      totalHeader !== null && Number.isFinite(Number(totalHeader))
        ? Number(totalHeader)
        : undefined;
    const hasMore =
      total !== undefined ? offset + recordCount < total : recordCount === args.limit;

    const payload: Record<string, unknown> = { record_count: recordCount };
    if (total !== undefined) payload.total = total;
    payload.has_more = hasMore;
    if (hasMore) {
      const nextOffset = offset + recordCount;
      payload.next_offset = nextOffset;
      payload.hint = `More records available. Call sn_syslog again with offset=${nextOffset}.`;
    }
    payload.results = results;
    return ok(payload);
  } catch (error) {
    return err(formatError(error));
  }
}
