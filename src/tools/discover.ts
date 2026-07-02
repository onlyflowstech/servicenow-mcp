import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, escapeQueryValue, formatError, withWarnings } from "../utils.js";

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
      profile: {
        type: "string",
        description: "Named profile to use. Defaults to active profile.",
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
  profile: z.string().optional().describe("Named profile to use. Defaults to active profile."),
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
          const q = escapeQueryValue(args.query);
          sysparmQuery = `nameLIKE${q}^ORlabelLIKE${q}`;
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
        const warnings: string[] = [];

        // Scoped apps (sys_app)
        const appQuery: string[] = [];
        if (args.query) appQuery.push(`nameLIKE${escapeQueryValue(args.query)}`);
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
        } catch (error) {
          // sys_app may require elevated role -- report, don't hide
          warnings.push(`sys_app: ${formatError(error)}`);
        }

        // Store apps (sys_store_app)
        const storeQuery: string[] = [];
        if (args.query) storeQuery.push(`nameLIKE${escapeQueryValue(args.query)}`);
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
        } catch (error) {
          // May not be accessible -- report, don't hide
          warnings.push(`sys_store_app: ${formatError(error)}`);
        }

        // Both app tables failed: that is a failure, not "no apps
        // installed" -- an empty success here would misread as none.
        if (warnings.length === 2) {
          return err(`both app tables failed:\n${warnings.join("\n")}`);
        }

        allApps = allApps.slice(0, args.limit);
        return ok(withWarnings(allApps, warnings));
      }

      case "plugins": {
        const pluginQuery: string[] = [];
        if (args.query) pluginQuery.push(`nameLIKE${escapeQueryValue(args.query)}`);
        if (args.active) pluginQuery.push(`active=${escapeQueryValue(args.active)}`);

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
