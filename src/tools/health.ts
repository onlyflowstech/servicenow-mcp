import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_health",
  description:
    "Check ServiceNow instance health: version, cluster nodes, stuck jobs, semaphores, and key stats (active incidents, P1s, changes, problems).",
  inputSchema: {
    type: "object" as const,
    properties: {
      check: {
        type: "string",
        enum: ["all", "version", "nodes", "jobs", "semaphores", "stats"],
        description: "Which health check to run (default: all)",
      },
    },
    required: [],
  },
};

export const schema = z.object({
  check: z
    .enum(["all", "version", "nodes", "jobs", "semaphores", "stats"])
    .optional()
    .default("all"),
});

async function safeGet(
  client: ServiceNowClient,
  path: string,
  params: Record<string, string>
): Promise<any> {
  try {
    return await client.get(path, params);
  } catch {
    return null;
  }
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    const check = args.check;
    const output: Record<string, unknown> = {
      instance: config.instance,
      timestamp: new Date().toISOString(),
    };

    // ── version ──
    if (check === "all" || check === "version") {
      const version: Record<string, string> = {};

      const buildResp = await safeGet(client, "/api/now/table/sys_properties", {
        sysparm_query: "name=glide.war",
        sysparm_fields: "value",
        sysparm_limit: "1",
      });
      version.build = buildResp?.result?.[0]?.value ?? "unavailable";

      const dateResp = await safeGet(client, "/api/now/table/sys_properties", {
        sysparm_query: "name=glide.build.date",
        sysparm_fields: "value",
        sysparm_limit: "1",
      });
      if (dateResp?.result?.[0]?.value) {
        version.build_date = dateResp.result[0].value;
      }

      const tagResp = await safeGet(client, "/api/now/table/sys_properties", {
        sysparm_query: "name=glide.build.tag",
        sysparm_fields: "value",
        sysparm_limit: "1",
      });
      if (tagResp?.result?.[0]?.value) {
        version.build_tag = tagResp.result[0].value;
      }

      output.version = version;
    }

    // ── nodes ──
    if (check === "all" || check === "nodes") {
      const nodesResp = await safeGet(
        client,
        "/api/now/table/sys_cluster_state",
        {
          sysparm_fields: "node_id,status,system_id,most_recent_message",
          sysparm_limit: "50",
        }
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
      const jobsResp = await safeGet(client, "/api/now/table/sys_trigger", {
        sysparm_query: "state=0^next_action<javascript:gs.minutesAgo(30)",
        sysparm_fields: "name,next_action,state,trigger_type",
        sysparm_limit: "20",
      });
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
      const semResp = await safeGet(client, "/api/now/table/sys_semaphore", {
        sysparm_query: "state=active",
        sysparm_fields: "name,state,holder",
        sysparm_limit: "20",
      });
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

      const incResp = await safeGet(client, "/api/now/stats/incident", {
        sysparm_count: "true",
        sysparm_query: "state!=7",
      });
      if (incResp?.result?.stats?.count) {
        stats.incidents_active = parseInt(incResp.result.stats.count, 10);
      }

      const p1Resp = await safeGet(client, "/api/now/stats/incident", {
        sysparm_count: "true",
        sysparm_query: "active=true^priority=1",
      });
      if (p1Resp?.result?.stats?.count) {
        stats.p1_open = parseInt(p1Resp.result.stats.count, 10);
      }

      const chgResp = await safeGet(client, "/api/now/stats/change_request", {
        sysparm_count: "true",
        sysparm_query: "active=true",
      });
      if (chgResp?.result?.stats?.count) {
        stats.changes_active = parseInt(chgResp.result.stats.count, 10);
      }

      const prbResp = await safeGet(client, "/api/now/stats/problem", {
        sysparm_count: "true",
        sysparm_query: "active=true",
      });
      if (prbResp?.result?.stats?.count) {
        stats.problems_open = parseInt(prbResp.result.stats.count, 10);
      }

      output.stats = stats;
    }

    return ok(output);
  } catch (error) {
    return err(formatError(error));
  }
}
