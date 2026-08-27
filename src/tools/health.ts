import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import { ok, formatError, withWarnings } from "../utils.js";
import { createCommonToolError } from "../tool-error.js";

export const definition = {
  name: "sn_health",
  description:
    "Check ServiceNow instance health: version, cluster nodes, stuck jobs, semaphores, and key stats (active incidents, P1s, changes, problems).",
  annotations: {
    title: "Check instance health",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z.object({
  check: z
    .enum(["all", "version", "nodes", "jobs", "semaphores", "stats"])
    .optional()
    .default("all")
    .describe("Which health check to run (default: all)"),
});

interface PropertyResponse {
  readonly result?: ReadonlyArray<{ readonly value?: string }>;
}

interface TableResponse {
  readonly result?: ReadonlyArray<Record<string, string>>;
}

interface StatsResponse {
  readonly result?: { readonly stats?: { readonly count?: string } };
}

/**
 * GET that converts a failure into a null result plus a warning naming
 * the sub-check and the underlying error, so a denied table is
 * distinguishable from an empty one.
 */
async function safeGet<T>(
  client: ServiceNowOperations,
  path: string,
  params: Record<string, string>,
  label: string,
  warnings: string[],
  failures: unknown[]
): Promise<T | null> {
  try {
    return await client.get<T>(path, params);
  } catch (error) {
    failures.push(error);
    warnings.push(`${label}: ${formatError(error)}`);
    return null;
  }
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  try {
    const check = args.check;
    const output: Record<string, unknown> = {
      instance: config.instance,
      timestamp: new Date().toISOString(),
    };
    const warnings: string[] = [];
    const failures: unknown[] = [];
    // Count sub-requests so a TOTAL failure (every request warned) can be
    // reported as an error instead of a healthy-looking empty envelope.
    let attempts = 0;
    const tryGet = <T>(
      path: string,
      params: Record<string, string>,
      label: string
    ): Promise<T | null> => {
      attempts += 1;
      return safeGet<T>(client, path, params, label, warnings, failures);
    };

    // ── version ──
    if (check === "all" || check === "version") {
      const version: Record<string, string> = {};

      const buildResp = await tryGet<PropertyResponse>(
        "/api/now/table/sys_properties",
        {
          sysparm_query: "name=glide.war",
          sysparm_fields: "value",
          sysparm_limit: "1",
        },
        "sys_properties (glide.war)"
      );
      version.build = buildResp?.result?.[0]?.value ?? "unavailable";

      const dateResp = await tryGet<PropertyResponse>(
        "/api/now/table/sys_properties",
        {
          sysparm_query: "name=glide.build.date",
          sysparm_fields: "value",
          sysparm_limit: "1",
        },
        "sys_properties (glide.build.date)"
      );
      if (dateResp?.result?.[0]?.value) {
        version.build_date = dateResp.result[0].value;
      }

      const tagResp = await tryGet<PropertyResponse>(
        "/api/now/table/sys_properties",
        {
          sysparm_query: "name=glide.build.tag",
          sysparm_fields: "value",
          sysparm_limit: "1",
        },
        "sys_properties (glide.build.tag)"
      );
      if (tagResp?.result?.[0]?.value) {
        version.build_tag = tagResp.result[0].value;
      }

      output.version = version;
    }

    // ── nodes ──
    if (check === "all" || check === "nodes") {
      const nodesResp = await tryGet<TableResponse>(
        "/api/now/table/sys_cluster_state",
        {
          sysparm_fields: "node_id,status,system_id,most_recent_message",
          sysparm_limit: "50",
        },
        "sys_cluster_state"
      );
      if (nodesResp?.result) {
        output.nodes = nodesResp.result.map(
          (n: Record<string, string>) => ({
            node_id: n.node_id,
            status: n.status,
            system_id: n.system_id,
            most_recent_message: n.most_recent_message,
          })
        );
      } else {
        output.nodes = { error: "Unable to query sys_cluster_state — check ACLs" };
      }
    }

    // ── jobs ──
    if (check === "all" || check === "jobs") {
      const jobsResp = await tryGet<TableResponse>(
        "/api/now/table/sys_trigger",
        {
          sysparm_query: "state=0^next_action<javascript:gs.minutesAgo(30)",
          sysparm_fields: "name,next_action,state,trigger_type",
          sysparm_limit: "20",
        },
        "sys_trigger"
      );
      if (jobsResp?.result) {
        output.jobs = {
          stuck: jobsResp.result.length,
          overdue: jobsResp.result.map((j: Record<string, string>) => ({
            name: j.name,
            next_action: j.next_action,
            state: j.state,
            trigger_type: j.trigger_type,
          })),
        };
      } else {
        output.jobs = { error: "Unable to query sys_trigger — check ACLs" };
      }
    }

    // ── semaphores ──
    if (check === "all" || check === "semaphores") {
      const semResp = await tryGet<TableResponse>(
        "/api/now/table/sys_semaphore",
        {
          sysparm_query: "state=active",
          sysparm_fields: "name,state,holder",
          sysparm_limit: "20",
        },
        "sys_semaphore"
      );
      if (semResp?.result) {
        output.semaphores = {
          active: semResp.result.length,
          list: semResp.result.map((s: Record<string, string>) => ({
            name: s.name,
            state: s.state,
            holder: s.holder,
          })),
        };
      } else {
        output.semaphores = {
          error: "Unable to query sys_semaphore — check ACLs",
        };
      }
    }

    // ── stats ──
    if (check === "all" || check === "stats") {
      const stats: Record<string, number> = {};

      const incResp = await tryGet<StatsResponse>(
        "/api/now/stats/incident",
        {
          sysparm_count: "true",
          sysparm_query: "state!=7",
        },
        "incident stats (active count)"
      );
      if (incResp?.result?.stats?.count) {
        stats.incidents_active = parseInt(incResp.result.stats.count, 10);
      }

      const p1Resp = await tryGet<StatsResponse>(
        "/api/now/stats/incident",
        {
          sysparm_count: "true",
          sysparm_query: "active=true^priority=1",
        },
        "incident stats (open P1 count)"
      );
      if (p1Resp?.result?.stats?.count) {
        stats.p1_open = parseInt(p1Resp.result.stats.count, 10);
      }

      const chgResp = await tryGet<StatsResponse>(
        "/api/now/stats/change_request",
        {
          sysparm_count: "true",
          sysparm_query: "active=true",
        },
        "change_request stats (active count)"
      );
      if (chgResp?.result?.stats?.count) {
        stats.changes_active = parseInt(chgResp.result.stats.count, 10);
      }

      const prbResp = await tryGet<StatsResponse>(
        "/api/now/stats/problem",
        {
          sysparm_count: "true",
          sysparm_query: "active=true",
        },
        "problem stats (active count)"
      );
      if (prbResp?.result?.stats?.count) {
        stats.problems_open = parseInt(prbResp.result.stats.count, 10);
      }

      output.stats = stats;
    }

    // Every sub-request failed: report an error, not a healthy-looking
    // envelope whose only content is the instance URL and a timestamp.
    if (attempts > 0 && warnings.length >= attempts) {
      throw createCommonToolError(failures);
    }

    return ok(withWarnings(output, warnings));
  } catch (error) {
    throw error;
  }
}
