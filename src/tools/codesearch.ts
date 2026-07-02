import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, escapeQueryValue, formatError, truncate, withWarnings } from "../utils.js";

export const definition = {
  name: "sn_codesearch",
  description:
    "Search across ServiceNow code artifacts — business rules, script includes, UI scripts, client scripts, and scripted REST operations. Returns matching records with code snippets.",
  annotations: {
    title: "Search code artifacts",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      search_term: {
        type: "string",
        description: "Text to search for in script fields",
      },
      table: {
        type: "string",
        description:
          "Search a specific table only (default: searches all code tables). Options: sys_script, sys_script_include, sys_ui_script, sys_script_client, sys_ws_operation",
      },
      field: {
        type: "string",
        description: "Specific field to search (default: script)",
      },
      limit: {
        type: "number",
        description: "Max total results (default 20)",
      },
      profile: {
        type: "string",
        description: "Named profile to use. Defaults to active profile.",
      },
    },
    required: ["search_term"],
  },
};

export const schema = z.object({
  search_term: z.string(),
  table: z.string().optional(),
  field: z.string().optional(),
  limit: z.number().optional().default(20),
  profile: z.string().optional().describe("Named profile to use. Defaults to active profile."),
});

interface SearchTarget {
  table: string;
  field: string;
  label: string;
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    const targets: SearchTarget[] = args.table
      ? [{ table: args.table, field: args.field || "script", label: args.table }]
      : [
          { table: "sys_script", field: "script", label: "Business Rules" },
          { table: "sys_script_include", field: "script", label: "Script Includes" },
          { table: "sys_ui_script", field: "script", label: "UI Scripts" },
          { table: "sys_script_client", field: "script", label: "Client Scripts" },
          { table: "sys_ws_operation", field: "operation_script", label: "Scripted REST" },
        ];

    const numTargets = targets.length;
    const perTableLimit =
      numTargets > 1
        ? Math.max(5, Math.ceil(args.limit / numTargets))
        : args.limit;

    let allResults: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];

    for (const target of targets) {
      try {
        const resp = await client.get(`/api/now/table/${target.table}`, {
          sysparm_query: `${escapeQueryValue(target.field)}LIKE${escapeQueryValue(args.search_term)}`,
          sysparm_fields: `sys_id,name,${target.field}`,
          sysparm_limit: String(perTableLimit),
        });

        const records = resp.result || [];
        for (const r of records) {
          allResults.push({
            table: target.table,
            table_label: target.label,
            sys_id: r.sys_id,
            name: r.name || "unnamed",
            snippet: r[target.field]
              ? truncate(String(r[target.field]), 200)
              : "",
          });
        }
      } catch (error) {
        // Tables can fail (ACL issues, etc.) -- report, don't hide
        warnings.push(`${target.table}: ${formatError(error)}`);
      }
    }

    // Trim to requested limit
    allResults = allResults.slice(0, args.limit);

    return ok(withWarnings(allResults, warnings));
  } catch (error) {
    return err(formatError(error));
  }
}
