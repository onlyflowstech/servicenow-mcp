import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { ok, escapeQueryValue, formatError, withWarnings } from "../utils.js";
import { createCommonToolError } from "../tool-error.js";
import { searchProjection } from "../code-search-targets.js";
import { snippetAround } from "../code-search-snippet.js";

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

/** The snippet (and the line it is on) for one row's searched value. */
function snippetFields(value: unknown, term: string): { snippet: string; line?: number } {
  if (!value) return { snippet: "" };
  const { text, line } = snippetAround(String(value), term);
  return line === undefined ? { snippet: text } : { snippet: text, line };
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

    // The per-table reads are independent, so they run together instead of one
    // round trip after another (each also costs a watermark read when the
    // table is cached). The upstream client's per-origin limiter bounds how
    // many are in flight, and its per-call cumulative byte budget still caps
    // what they read between them; both are shared, not per table. Results,
    // warnings and failures are merged in target order after the join, so the
    // output does not depend on which request finished first. One difference
    // from a serial loop: if the cumulative byte budget runs out, the table
    // that gets the error is whichever read crossed it, no longer always the
    // last one.
    const outcomes = await Promise.all(
      targets.map(async (target) => {
        try {
          // The identifier, the name and the searched field, each once: the
          // searched field may itself be the name or the identifier.
          const projection = searchProjection("name", target.field).join(",");
          const fallbackFields = resolveReadableFields(target.table, {
            fields: projection,
          });
          const readableFields =
            preparedReadableFields(args, target.table) ?? fallbackFields;
          const resp = await client.get(`/api/now/table/${target.table}`, {
            // `sysparm_orderby` is not a Table API parameter; ordering is part
            // of the encoded query. Without it the window is not a stable
            // prefix of the table, and an offset can skip or repeat a record.
            sysparm_query: `${escapeQueryValue(target.field)}LIKE${escapeQueryValue(args.search_term)}^ORDERBYsys_id`,
            sysparm_fields: projection,
            sysparm_limit: String(windowLimit),
            sysparm_offset: "0",
          });

          const filtered = filterReadableRecord(resp.result || [], readableFields);
          const records = Array.isArray(filtered) ? filtered : [];
          const matches: Array<Record<string, unknown>> = [];
          for (const r of records) {
            if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
            const record = r as Record<string, unknown>;
            matches.push({
              table: target.table,
              table_label: target.label,
              sys_id: record.sys_id,
              name: record.name || "unnamed",
              ...snippetFields(record[target.field], escapeQueryValue(args.search_term)),
            });
          }
          return { matches } as const;
        } catch (error) {
          // Tables can fail (ACL issues, etc.) -- report, don't hide
          return { error } as const;
        }
      })
    );
    for (const [index, outcome] of outcomes.entries()) {
      if ("error" in outcome) {
        failures.push(outcome.error);
        warnings.push(`${targets[index].table}: ${formatError(outcome.error)}`);
      } else {
        allResults.push(...outcome.matches);
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
