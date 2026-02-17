import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_discover",
  description:
    "Discover tables, applications, and plugins installed on the ServiceNow instance.",
  inputSchema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        enum: ["tables", "apps", "plugins"],
        description: "What to discover: tables, apps, or plugins",
      },
      query: {
        type: "string",
        description: "Search by name (LIKE match)",
      },
      limit: {
        type: "number",
        description: "Max results (default 20)",
      },
      active: {
        type: "string",
        description: "Filter by active status: true or false (apps and plugins only)",
      },
    },
    required: ["type"],
  },
};

export const schema = z.object({
  type: z.enum(["tables", "apps", "plugins"]),
  query: z.string().optional(),
  limit: z.number().optional().default(20),
  active: z.string().optional(),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    switch (args.type) {
      case "tables": {
        let sysparmQuery = "";
        if (args.query) {
          sysparmQuery = `nameLIKE${args.query}^ORlabelLIKE${args.query}`;
        }

        const resp = await client.get("/api/now/table/sys_db_object", {
          sysparm_fields: "sys_id,name,label,super_class,sys_scope,is_extendable",
          sysparm_limit: String(args.limit),
          sysparm_display_value: "true",
          ...(sysparmQuery ? { sysparm_query: sysparmQuery } : {}),
        });

        const results = (resp.result || []).map(
          (r: Record<string, string>) => ({
            sys_id: r.sys_id,
            name: r.name,
            label: r.label,
            super_class: r.super_class,
            scope: r.sys_scope,
            is_extendable: r.is_extendable,
          })
        );
        return ok(results);
      }

      case "apps": {
        let allApps: Array<Record<string, unknown>> = [];

        // Scoped apps (sys_app)
        const appQuery: string[] = [];
        if (args.query) appQuery.push(`nameLIKE${args.query}`);
        if (args.active === "true") appQuery.push("active=true");

        try {
          const appResp = await client.get("/api/now/table/sys_app", {
            sysparm_fields: "sys_id,name,version,scope,active",
            sysparm_limit: String(args.limit),
            ...(appQuery.length ? { sysparm_query: appQuery.join("^") } : {}),
          });
          for (const r of appResp.result || []) {
            allApps.push({ ...r, source: "scoped" });
          }
        } catch {
          // sys_app may require elevated role
        }

        // Store apps (sys_store_app)
        const storeQuery: string[] = [];
        if (args.query) storeQuery.push(`nameLIKE${args.query}`);
        if (args.active === "true") storeQuery.push("active=true");

        try {
          const storeResp = await client.get("/api/now/table/sys_store_app", {
            sysparm_fields: "sys_id,name,version,scope,active",
            sysparm_limit: String(args.limit),
            ...(storeQuery.length
              ? { sysparm_query: storeQuery.join("^") }
              : {}),
          });
          for (const r of storeResp.result || []) {
            allApps.push({ ...r, source: "store" });
          }
        } catch {
          // May not be accessible
        }

        allApps = allApps.slice(0, args.limit);
        return ok(allApps);
      }

      case "plugins": {
        const pluginQuery: string[] = [];
        if (args.query) pluginQuery.push(`nameLIKE${args.query}`);
        if (args.active) pluginQuery.push(`active=${args.active}`);

        const resp = await client.get("/api/now/table/v_plugin", {
          sysparm_fields: "sys_id,name,active",
          sysparm_limit: String(args.limit),
          ...(pluginQuery.length
            ? { sysparm_query: pluginQuery.join("^") }
            : {}),
        });

        const results = (resp.result || []).map(
          (r: Record<string, string>) => ({
            sys_id: r.sys_id,
            name: r.name,
            active: r.active,
          })
        );
        return ok(results);
      }

      default:
        return err(`Unknown discover type: ${args.type}`);
    }
  } catch (error) {
    return err(formatError(error));
  }
}
