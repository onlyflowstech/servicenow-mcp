import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { ok, escapeQueryValue, formatError, truncate, withWarnings } from "../utils.js";
import { createCommonToolError } from "../tool-error.js";

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
};

export const schema = z.object({
  search_term: z.string().describe("Text to search for in script fields"),
  table: z.string().optional().describe("Search a specific table only (default: searches all code tables). Options: sys_script, sys_script_include, sys_ui_script, sys_script_client, sys_ws_operation"),
  field: z.string().optional().describe("Specific field to search (default: script)"),
  limit: z.number().int().min(1).max(1000).optional().default(20).describe("Max total results (default 20, max 1000)"),
  offset: z.number().int().min(0).max(10000).optional().default(0).describe("Deterministic combined-result offset (default 0)"),
});

interface SearchTarget {
  table: string;
  field: string;
  label: string;
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  try {
    const targets: SearchTarget[] = args.table
      ? [{ table: args.table, field: args.field || "script", label: args.table }]
      : [
          { table: "sys_script", field: args.field || "script", label: "Business Rules" },
          { table: "sys_script_include", field: args.field || "script", label: "Script Includes" },
          { table: "sys_ui_script", field: args.field || "script", label: "UI Scripts" },
          { table: "sys_script_client", field: args.field || "script", label: "Client Scripts" },
          { table: "sys_ws_operation", field: args.field || "operation_script", label: "Scripted REST" },
        ];

    // Fetch the bounded prefix needed to construct a correct page over the
    // combined, table-ordered result set. Applying the same offset to every
    // table skips records when a continuation crosses a table boundary.
    const windowLimit = args.offset + args.limit + 1;

    let allResults: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const failures: unknown[] = [];

    for (const target of targets) {
      try {
        const fallbackFields = resolveReadableFields(target.table, {
          fields: `sys_id,name,${target.field}`,
        });
        const readableFields =
          preparedReadableFields(args, target.table) ?? fallbackFields;
        const resp = await client.get(`/api/now/table/${target.table}`, {
          sysparm_query: `${escapeQueryValue(target.field)}LIKE${escapeQueryValue(args.search_term)}`,
          sysparm_fields: `sys_id,name,${target.field}`,
          sysparm_limit: String(windowLimit),
          sysparm_offset: "0",
          sysparm_orderby: "sys_id",
        });

        const filtered = filterReadableRecord(resp.result || [], readableFields);
        const records = Array.isArray(filtered) ? filtered : [];
        for (const r of records) {
          if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
          const record = r as Record<string, unknown>;
          allResults.push({
            table: target.table,
            table_label: target.label,
            sys_id: record.sys_id,
            name: record.name || "unnamed",
            snippet: record[target.field]
              ? truncate(String(record[target.field]), 200)
              : "",
          });
        }
      } catch (error) {
        // Tables can fail (ACL issues, etc.) -- report, don't hide
        failures.push(error);
        warnings.push(`${target.table}: ${formatError(error)}`);
      }
    }

    // Every sub-search failed: that is a failure, not "no matches" --
    // an empty success here would read as "nothing references this".
    if (warnings.length === targets.length) {
      throw createCommonToolError(failures);
    }

    allResults.sort((left, right) => {
      const tableOrder = String(left.table).localeCompare(String(right.table));
      return tableOrder !== 0
        ? tableOrder
        : String(left.sys_id).localeCompare(String(right.sys_id));
    });
    allResults = allResults.slice(args.offset, args.offset + args.limit + 1);

    return ok(withWarnings(allResults, warnings));
  } catch (error) {
    throw error;
  }
}
