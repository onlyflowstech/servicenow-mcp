import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { ok, err, escapeQueryValue, formatError, withWarnings } from "../utils.js";
import { createCommonToolError } from "../tool-error.js";

export const definition = {
  name: "sn_discover",
  description:
    "Discover tables, applications, and plugins installed on the ServiceNow instance.",
  annotations: {
    title: "Discover tables, apps, and plugins",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z.object({
  type: z.enum(["tables", "apps", "plugins"]).describe("What to discover: tables, apps, or plugins"),
  query: z.string().optional().describe("Search by name (LIKE match)"),
  limit: z.number().int().min(1).max(1000).optional().default(20).describe("Max results (default 20, max 1000)"),
  offset: z.number().int().min(0).max(10000).optional().default(0).describe("Deterministic result offset (default 0)"),
  active: z.string().optional().describe("Filter by active status: true or false (apps and plugins only)"),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  try {
    switch (args.type) {
      case "tables": {
        const readableFields =
          preparedReadableFields(args, "sys_db_object") ??
          resolveReadableFields("sys_db_object");
        let sysparmQuery = "";
        if (args.query) {
          const q = escapeQueryValue(args.query);
          sysparmQuery = `nameLIKE${q}^ORlabelLIKE${q}`;
        }

        const resp = await client.get("/api/now/table/sys_db_object", {
          sysparm_fields: "sys_id,name,label,super_class,sys_scope,is_extendable",
          sysparm_limit: String(args.limit + 1),
          sysparm_offset: String(args.offset),
          sysparm_orderby: "sys_id",
          sysparm_display_value: "true",
          ...(sysparmQuery ? { sysparm_query: sysparmQuery } : {}),
        });

        const filtered = filterReadableRecord(resp.result || [], readableFields);
        const records = Array.isArray(filtered) ? filtered : [];
        const results = records.flatMap((candidate) => {
          if (
            typeof candidate !== "object" ||
            candidate === null ||
            Array.isArray(candidate)
          ) {
            return [];
          }
          const r = candidate as Record<string, unknown>;
          return [{
            sys_id: r.sys_id,
            name: r.name,
            label: r.label,
            super_class: r.super_class,
            scope: r.sys_scope,
            is_extendable: r.is_extendable,
          }];
        });
        return ok(results);
      }

      case "apps": {
        const appReadableFields =
          preparedReadableFields(args, "sys_app") ??
          resolveReadableFields("sys_app");
        const storeReadableFields =
          preparedReadableFields(args, "sys_store_app") ??
          resolveReadableFields("sys_store_app");
        let allApps: Array<Record<string, unknown>> = [];
        const warnings: string[] = [];
        const failures: unknown[] = [];
        const windowLimit = args.offset + args.limit + 1;

        // Scoped apps (sys_app)
        const appQuery: string[] = [];
        if (args.query) appQuery.push(`nameLIKE${escapeQueryValue(args.query)}`);
        if (args.active === "true") appQuery.push("active=true");

        try {
          const appResp = await client.get("/api/now/table/sys_app", {
            sysparm_fields: "sys_id,name,version,scope,active",
            sysparm_limit: String(windowLimit),
            sysparm_offset: "0",
            sysparm_orderby: "sys_id",
            ...(appQuery.length ? { sysparm_query: appQuery.join("^") } : {}),
          });
          const filtered = filterReadableRecord(
            appResp.result || [],
            appReadableFields
          );
          for (const r of Array.isArray(filtered) ? filtered : []) {
            if (typeof r === "object" && r !== null && !Array.isArray(r)) {
              allApps.push({ ...(r as Record<string, unknown>), source: "scoped" });
            }
          }
        } catch (error) {
          // sys_app may require elevated role -- report, don't hide
          failures.push(error);
          warnings.push(`sys_app: ${formatError(error)}`);
        }

        // Store apps (sys_store_app)
        const storeQuery: string[] = [];
        if (args.query) storeQuery.push(`nameLIKE${escapeQueryValue(args.query)}`);
        if (args.active === "true") storeQuery.push("active=true");

        try {
          const storeResp = await client.get("/api/now/table/sys_store_app", {
            sysparm_fields: "sys_id,name,version,scope,active",
            sysparm_limit: String(windowLimit),
            sysparm_offset: "0",
            sysparm_orderby: "sys_id",
            ...(storeQuery.length
              ? { sysparm_query: storeQuery.join("^") }
              : {}),
          });
          const filtered = filterReadableRecord(
            storeResp.result || [],
            storeReadableFields
          );
          for (const r of Array.isArray(filtered) ? filtered : []) {
            if (typeof r === "object" && r !== null && !Array.isArray(r)) {
              allApps.push({ ...(r as Record<string, unknown>), source: "store" });
            }
          }
        } catch (error) {
          // May not be accessible -- report, don't hide
          failures.push(error);
          warnings.push(`sys_store_app: ${formatError(error)}`);
        }

        // Both app tables failed: that is a failure, not "no apps
        // installed" -- an empty success here would misread as none.
        if (warnings.length === 2) {
          throw createCommonToolError(failures);
        }

        allApps.sort((left, right) => {
          const sourceOrder = String(left.source).localeCompare(
            String(right.source)
          );
          return sourceOrder !== 0
            ? sourceOrder
            : String(left.sys_id).localeCompare(String(right.sys_id));
        });
        allApps = allApps.slice(args.offset, args.offset + args.limit + 1);
        return ok(withWarnings(allApps, warnings));
      }

      case "plugins": {
        const readableFields =
          preparedReadableFields(args, "v_plugin") ??
          resolveReadableFields("v_plugin");
        const pluginQuery: string[] = [];
        if (args.query) pluginQuery.push(`nameLIKE${escapeQueryValue(args.query)}`);
        if (args.active) pluginQuery.push(`active=${escapeQueryValue(args.active)}`);

        const resp = await client.get("/api/now/table/v_plugin", {
          sysparm_fields: "sys_id,name,active",
          sysparm_limit: String(args.limit + 1),
          sysparm_offset: String(args.offset),
          sysparm_orderby: "sys_id",
          ...(pluginQuery.length
            ? { sysparm_query: pluginQuery.join("^") }
            : {}),
        });

        const filtered = filterReadableRecord(resp.result || [], readableFields);
        const results = (Array.isArray(filtered) ? filtered : []).flatMap(
          (candidate) => {
            if (
              typeof candidate !== "object" ||
              candidate === null ||
              Array.isArray(candidate)
            ) {
              return [];
            }
            const r = candidate as Record<string, unknown>;
            return [{ sys_id: r.sys_id, name: r.name, active: r.active }];
          }
        );
        return ok(results);
      }

      default:
        return err(`Unknown discover type: ${args.type}`);
    }
  } catch (error) {
    throw error;
  }
}
