import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import { ok, err, escapeQueryValue, formatError, withWarnings } from "../utils.js";
import {
  normalizeServiceNowSysId,
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";

export const definition = {
  name: "sn_relationships",
  description:
    "Traverse CMDB CI relationships (graph walk). Supports upstream, downstream, or both directions with configurable depth. Use for impact analysis and dependency mapping.",
  annotations: {
    title: "Traverse CI relationships",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z.object({
  ci_name: z.string().optional().describe("Name of the CI to start from (resolved via cmdb_ci name field)"),
  sys_id: serviceNowSysIdSchema.optional().describe("32-hex sys_id of the CI to start from (alternative to ci_name)"),
  depth: z.number().int().min(1).max(5).optional().describe("How many levels deep to traverse (1-5, default from SN_REL_DEPTH or 3)"),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe("Maximum relationships to return (default 100, max 1000)"),
  offset: z.number().int().min(0).max(1000).optional().default(0).describe("Deterministic traversal offset (default 0, max 1000)"),
  direction: z.enum(["upstream", "downstream", "both"]).optional().default("both").describe("Traversal direction (default: both)"),
  type: z.string().optional().describe("Filter by relationship type name (substring match)"),
  class: z.string().optional().describe("Filter displayed CIs by class name (substring match)"),
  impact: z.boolean().optional().default(false).describe("Impact analysis mode -- walks upstream only"),
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
  client: ServiceNowOperations,
  config: ServiceNowToolSettings,
  _context: ExecutionContext
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
      const ciResp = await client.get(`/api/now/table/cmdb_ci/${serviceNowSysIdPathSegment(args.sys_id)}`, {
        sysparm_fields: "sys_id,name,sys_class_name",
        sysparm_display_value: "true",
      });
      if (!ciResp.result?.name) {
        return err(`CI not found with sys_id: ${args.sys_id}`);
      }
      rootId = normalizeServiceNowSysId(args.sys_id);
      rootName = ciResp.result.name;
      rootClass = ciResp.result.sys_class_name;
    } else {
      const ciResp = await client.get("/api/now/table/cmdb_ci", {
        sysparm_query: `name=${escapeQueryValue(args.ci_name!)}^ORDERBYsys_id`,
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
    const warnings: string[] = [];
    const traversalTarget = args.offset + args.limit + 1;
    const maxTraversalRequests = 2_001;
    let traversalRequests = 0;
    let traversalTruncated = false;

    async function getClass(id: string): Promise<string> {
      if (classCache.has(id)) return classCache.get(id)!;
      try {
        const safeId = normalizeServiceNowSysId(id);
        const resp = await client.get(`/api/now/table/cmdb_ci/${serviceNowSysIdPathSegment(safeId)}`, {
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
      if (currentDepth > maxDepth || allRels.length >= traversalTarget) return;
      if (traversalRequests >= maxTraversalRequests) {
        traversalTruncated = true;
        return;
      }
      traversalRequests += 1;

      let relResp;
      try {
        const safeId = escapeQueryValue(normalizeServiceNowSysId(currentId));
        relResp = await client.get("/api/now/table/cmdb_rel_ci", {
          sysparm_query: `parent=${safeId}^ORchild=${safeId}^ORDERBYsys_id`,
          sysparm_fields: "parent,child,type",
          sysparm_display_value: "all",
          sysparm_limit: "100",
        });
      } catch (error) {
        // A failed hop truncates the walk -- report, don't hide
        warnings.push(
          `cmdb_rel_ci (traversal at depth ${currentDepth}): ${formatError(error)}`
        );
        return;
      }

      const records = relResp.result || [];
      const seen = new Set<string>();

      for (const rec of records) {
        if (allRels.length >= traversalTarget) {
          traversalTruncated = true;
          break;
        }
        let parentId: string;
        let childId: string;
        try {
          parentId = normalizeServiceNowSysId(extractValue(rec.parent));
          childId = normalizeServiceNowSysId(extractValue(rec.child));
        } catch {
          warnings.push("cmdb_rel_ci returned an invalid relationship identifier");
          continue;
        }
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

    const page = allRels.slice(args.offset, args.offset + args.limit);

    return ok(
      withWarnings(
        {
          root: { name: rootName, class: rootClass, sys_id: rootId },
          relationships: page,
          meta: {
            depth: maxDepth,
            direction,
            total: allRels.length,
            offset: args.offset,
            limit: args.limit,
            has_more: args.offset + page.length < allRels.length,
            ...(args.offset + page.length < allRels.length
              ? { next_offset: args.offset + page.length }
              : {}),
            traversal_truncated: traversalTruncated,
            traversal_requests: traversalRequests,
          },
        },
        warnings
      )
    );
  } catch (error) {
    throw error;
  }
}
