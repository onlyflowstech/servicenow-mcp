import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_relationships",
  description:
    "Traverse CMDB CI relationships (graph walk). Supports upstream, downstream, or both directions with configurable depth. Use for impact analysis and dependency mapping.",
  inputSchema: {
    type: "object" as const,
    properties: {
      ci_name: {
        type: "string",
        description: "Name of the CI to start from (resolved via cmdb_ci name field)",
      },
      sys_id: {
        type: "string",
        description: "Sys_id of the CI to start from (alternative to ci_name)",
      },
      depth: {
        type: "number",
        description: "How many levels deep to traverse (1-5, default from SN_REL_DEPTH or 3)",
      },
      direction: {
        type: "string",
        enum: ["upstream", "downstream", "both"],
        description: "Traversal direction (default: both)",
      },
      type: {
        type: "string",
        description: "Filter by relationship type name (substring match)",
      },
      class: {
        type: "string",
        description: "Filter displayed CIs by class name (substring match)",
      },
      impact: {
        type: "boolean",
        description: "Impact analysis mode — walks upstream only",
      },
    },
    required: [],
  },
};

export const schema = z.object({
  ci_name: z.string().optional(),
  sys_id: z.string().optional(),
  depth: z.number().optional(),
  direction: z.enum(["upstream", "downstream", "both"]).optional().default("both"),
  type: z.string().optional(),
  class: z.string().optional(),
  impact: z.boolean().optional().default(false),
});

interface RelNode {
  name: string;
  class: string;
  type: string;
  direction: string;
  sys_id: string;
  depth: number;
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    if (!args.ci_name && !args.sys_id) {
      return err("Either ci_name or sys_id is required");
    }

    const maxDepth = Math.min(Math.max(args.depth ?? config.relDepth, 1), 5);
    let direction = args.direction;
    if (args.impact) direction = "upstream";

    // ── Resolve root CI ──
    let rootId: string;
    let rootName: string;
    let rootClass: string;

    if (args.sys_id) {
      const ciResp = await client.get(`/api/now/table/cmdb_ci/${args.sys_id}`, {
        sysparm_fields: "sys_id,name,sys_class_name",
        sysparm_display_value: "true",
      });
      if (!ciResp.result?.name) {
        return err(`CI not found with sys_id: ${args.sys_id}`);
      }
      rootId = args.sys_id;
      rootName = ciResp.result.name;
      rootClass = ciResp.result.sys_class_name;
    } else {
      const ciResp = await client.get("/api/now/table/cmdb_ci", {
        sysparm_query: `name=${args.ci_name}`,
        sysparm_fields: "sys_id,name,sys_class_name",
        sysparm_display_value: "true",
        sysparm_limit: "5",
      });
      const results = ciResp.result || [];
      if (results.length === 0) {
        return err(`CI not found: ${args.ci_name}`);
      }
      rootId = results[0].sys_id;
      rootName = results[0].name;
      rootClass = results[0].sys_class_name;
    }

    // ── Traverse ──
    const visited = new Set<string>([rootId]);
    const classCache = new Map<string, string>([[rootId, rootClass]]);
    const allRels: RelNode[] = [];

    async function getClass(id: string): Promise<string> {
      if (classCache.has(id)) return classCache.get(id)!;
      try {
        const resp = await client.get(`/api/now/table/cmdb_ci/${id}`, {
          sysparm_fields: "sys_class_name",
          sysparm_display_value: "true",
        });
        const cls = resp.result?.sys_class_name || "unknown";
        classCache.set(id, cls);
        return cls;
      } catch {
        classCache.set(id, "unknown");
        return "unknown";
      }
    }

    function extractValue(field: unknown): string {
      if (!field) return "";
      if (typeof field === "string") return field;
      if (typeof field === "object" && field !== null) {
        const f = field as Record<string, unknown>;
        if (f.value && typeof f.value === "string") return f.value;
        if (f.link && typeof f.link === "string") {
          // Extract sys_id from link URL
          const parts = (f.link as string).split("/");
          return parts[parts.length - 1];
        }
      }
      return "";
    }

    function extractDisplay(field: unknown): string {
      if (!field) return "";
      if (typeof field === "string") {
        // If it's a 32-char hex string, it's a sys_id not a display value
        if (/^[a-f0-9]{32}$/.test(field)) return "";
        return field;
      }
      if (typeof field === "object" && field !== null) {
        const f = field as Record<string, unknown>;
        if (f.display_value && typeof f.display_value === "string") return f.display_value;
      }
      return "";
    }

    async function traverse(currentId: string, currentDepth: number): Promise<void> {
      if (currentDepth > maxDepth) return;

      let relResp;
      try {
        relResp = await client.get("/api/now/table/cmdb_rel_ci", {
          sysparm_query: `parent=${currentId}^ORchild=${currentId}`,
          sysparm_fields: "parent,child,type",
          sysparm_display_value: "all",
          sysparm_limit: "100",
        });
      } catch {
        return;
      }

      const records = relResp.result || [];
      const seen = new Set<string>();

      for (const rec of records) {
        const parentId = extractValue(rec.parent);
        const childId = extractValue(rec.child);
        const parentName = extractDisplay(rec.parent);
        const childName = extractDisplay(rec.child);
        const typeName = extractDisplay(rec.type) || "Related to";

        let otherId: string;
        let otherName: string;
        let relDir: string;

        if (parentId === currentId) {
          otherId = childId;
          otherName = childName;
          relDir = "downstream";
        } else if (childId === currentId) {
          otherId = parentId;
          otherName = parentName;
          relDir = "upstream";
        } else {
          continue;
        }

        if (otherId === currentId) continue;
        if (direction !== "both" && relDir !== direction) continue;
        if (args.type && !typeName.toLowerCase().includes(args.type.toLowerCase())) continue;

        const pairKey = `${otherId}:${relDir}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const otherClass = await getClass(otherId);

        // Apply class filter for display only
        if (!args.class || otherClass.toLowerCase().includes(args.class.toLowerCase())) {
          allRels.push({
            name: otherName || otherId,
            class: otherClass,
            type: typeName,
            direction: relDir,
            sys_id: otherId,
            depth: currentDepth,
          });
        }

        // Recurse
        if (currentDepth < maxDepth && !visited.has(otherId)) {
          visited.add(otherId);
          await traverse(otherId, currentDepth + 1);
        }
      }
    }

    await traverse(rootId, 1);

    return ok({
      root: { name: rootName, class: rootClass, sys_id: rootId },
      relationships: allRels,
      meta: { depth: maxDepth, direction, total: allRels.length },
    });
  } catch (error) {
    return err(formatError(error));
  }
}
