import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError, buildTableParams } from "../utils.js";

export const definition = {
  name: "sn_nl",
  description:
    "Natural language interface for ServiceNow. Translates plain English into ServiceNow API calls. Supports queries, aggregates, schema lookups, creates, updates, and batch operations. Read operations execute immediately; write operations require execute=true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: {
        type: "string",
        description:
          'Natural language request (e.g. "show all P1 incidents", "how many open changes", "create incident for VPN outage")',
      },
      execute: {
        type: "boolean",
        description: "Execute write operations (reads always execute). Default false.",
      },
      confirm: {
        type: "boolean",
        description: "Required for batch/bulk operations",
      },
      force: {
        type: "boolean",
        description: "Required for bulk deletes (in addition to confirm)",
      },
    },
    required: ["text"],
  },
};

export const schema = z.object({
  text: z.string(),
  execute: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
});

// ── Table aliases ──────────────────────────────────────────────────
const TABLE_ALIASES: Record<string, string> = {
  // ITSM
  incident: "incident", incidents: "incident", inc: "incident",
  ticket: "incident", tickets: "incident",
  change: "change_request", changes: "change_request",
  "change request": "change_request", "change requests": "change_request",
  problem: "problem", problems: "problem",
  task: "task", tasks: "task",
  // Users
  user: "sys_user", users: "sys_user", people: "sys_user", person: "sys_user",
  group: "sys_user_group", groups: "sys_user_group",
  team: "sys_user_group", teams: "sys_user_group",
  // CMDB
  server: "cmdb_ci_server", servers: "cmdb_ci_server",
  ci: "cmdb_ci", cis: "cmdb_ci", cmdb: "cmdb_ci",
  "configuration item": "cmdb_ci", "configuration items": "cmdb_ci",
  computer: "cmdb_ci_computer", computers: "cmdb_ci_computer",
  laptop: "cmdb_ci_computer", laptops: "cmdb_ci_computer",
  database: "cmdb_ci_database", databases: "cmdb_ci_database", db: "cmdb_ci_database",
  application: "cmdb_ci_appl", applications: "cmdb_ci_appl",
  app: "cmdb_ci_appl", apps: "cmdb_ci_appl",
  service: "cmdb_ci_service", services: "cmdb_ci_service",
  "business service": "cmdb_ci_service", "business services": "cmdb_ci_service",
  "network gear": "cmdb_ci_netgear", router: "cmdb_ci_netgear", routers: "cmdb_ci_netgear",
  switch: "cmdb_ci_netgear", switches: "cmdb_ci_netgear",
  // Knowledge
  knowledge: "kb_knowledge", "knowledge article": "kb_knowledge",
  "knowledge articles": "kb_knowledge", article: "kb_knowledge",
  articles: "kb_knowledge", kb: "kb_knowledge",
  // Service Catalog
  "catalog item": "sc_cat_item", "catalog items": "sc_cat_item",
  request: "sc_request", requests: "sc_request",
  "requested item": "sc_req_item", "requested items": "sc_req_item",
  ritm: "sc_req_item", ritms: "sc_req_item",
  // Other
  "update set": "sys_update_set", "update sets": "sys_update_set",
  flow: "sys_hub_flow", flows: "sys_hub_flow",
  notification: "sysevent_email_action", notifications: "sysevent_email_action",
  "business rule": "sys_script", "business rules": "sys_script",
  alert: "em_alert", alerts: "em_alert",
  sla: "task_sla", slas: "task_sla",
  email: "sys_email", emails: "sys_email",
};

// Default fields by table
const DEFAULT_FIELDS: Record<string, string> = {
  incident: "number,short_description,state,priority,assigned_to,assignment_group,opened_at",
  change_request: "number,short_description,state,priority,assigned_to,start_date,end_date",
  problem: "number,short_description,state,priority,assigned_to,opened_at",
  sc_req_item: "number,short_description,state,assigned_to,request,opened_at",
  sc_request: "number,short_description,state,requested_for,opened_at",
  sys_user: "user_name,name,email,department,active",
  sys_user_group: "name,description,manager,active",
  cmdb_ci_server: "name,ip_address,os,classification,operational_status",
  cmdb_ci: "name,sys_class_name,operational_status,owned_by",
  kb_knowledge: "number,short_description,workflow_state,author,published",
  task: "number,short_description,state,assigned_to,sys_class_name,opened_at",
};

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    const input = args.text;
    const lower = input.toLowerCase();

    // ── Resolve table ──
    let table = "";
    // Try longest alias first
    const sortedAliases = Object.keys(TABLE_ALIASES).sort(
      (a, b) => b.length - a.length
    );
    for (const alias of sortedAliases) {
      if (lower.includes(alias)) {
        table = TABLE_ALIASES[alias];
        break;
      }
    }
    // Try raw table name pattern
    if (!table) {
      const rawMatch = lower.match(/[a-z][a-z_]+_[a-z_]+/);
      if (rawMatch) table = rawMatch[0];
    }

    // ── Detect intent ──
    let intent: string;
    if (/schema|fields|columns|structure|what fields|describe table/.test(lower)) {
      intent = "SCHEMA";
    } else if (/how many|count of|total number|number of|sum of|average|avg of|minimum|maximum/.test(lower)) {
      intent = "AGGREGATE";
    } else if (/^(create|new|add|open|log|raise|submit|register)\b/.test(lower)) {
      intent = "CREATE";
    } else if (/^(update|change|set|modify|edit|patch|reassign|escalate)\b/.test(lower)) {
      intent = "UPDATE";
    } else if (/close all|update all|delete all|bulk|mass update|mass close|batch/.test(lower)) {
      intent = "BATCH";
    } else if (/^(delete|remove|destroy|purge)\b/.test(lower)) {
      intent = "DELETE";
    } else {
      intent = "QUERY";
    }

    // ── Build query parts ──
    const queryParts: string[] = [];

    // Priority
    if (/\bp1\b|priority\s*1|critical priority/.test(lower)) queryParts.push("priority=1");
    else if (/\bp2\b|priority\s*2|high priority/.test(lower)) queryParts.push("priority=2");
    else if (/\bp3\b|priority\s*3|moderate priority|medium priority/.test(lower)) queryParts.push("priority=3");
    else if (/\bp4\b|priority\s*4|low priority/.test(lower)) queryParts.push("priority=4");

    // State
    if (/\bopen\b|\bnew\b/.test(lower)) queryParts.push("active=true");
    else if (/\bclosed\b|\bcomplete\b|\bcompleted\b/.test(lower)) queryParts.push("state=7");
    else if (/\bresolved\b|\bfixed\b/.test(lower)) queryParts.push("state=6");
    else if (/\bin progress\b|\bwip\b/.test(lower)) queryParts.push("state=2");
    else if (/\bon hold\b|\bpending\b|\bwaiting\b/.test(lower)) queryParts.push("state=3");
    else if (/\bactive\b/.test(lower)) queryParts.push("active=true");
    else if (/\binactive\b|\barchived\b/.test(lower)) queryParts.push("active=false");

    // Assignment group
    const groupMatch = input.match(/[Aa]ssigned?\s+[Tt]o\s+([A-Za-z][\w\s]+?)(?:\s+(?:team|group|sorted|order|limit|since|from|with|and|or|in|on|by|the)(?:\s|$)|$)/);
    if (groupMatch) {
      queryParts.push(`assignment_group.name=${groupMatch[1].trim()}`);
    }

    // Record number reference
    const refMatch = lower.match(/(inc|chg|prb|ritm|req|task|kb)\d{7,10}/);
    if (refMatch) {
      const refNum = refMatch[0].toUpperCase();
      queryParts.push(`number=${refNum}`);
      if (!table) {
        const prefix = refNum.slice(0, 3);
        const prefixMap: Record<string, string> = {
          INC: "incident", CHG: "change_request", PRB: "problem",
          RIT: "sc_req_item", REQ: "sc_request", TAS: "task", KB0: "kb_knowledge",
        };
        table = prefixMap[prefix] || table;
      }
    }

    // Time filters
    if (/last\s+(24\s+hours?|day)/.test(lower)) queryParts.push("sys_created_on>=javascript:gs.hoursAgo(24)");
    else if (/last\s+week|past\s+week/.test(lower)) queryParts.push("sys_created_on>=javascript:gs.daysAgo(7)");
    else if (/last\s+month|past\s+month/.test(lower)) queryParts.push("sys_created_on>=javascript:gs.daysAgo(30)");
    else if (/\btoday\b/.test(lower)) queryParts.push("sys_created_on>=javascript:gs.daysAgo(0)");

    // Sort
    let orderby = "";
    if (/sort(ed)?\s+by\s+created|oldest\s+first/.test(lower)) orderby = "sys_created_on";
    else if (/sort(ed)?\s+by\s+updated|recently\s+updated/.test(lower)) orderby = "-sys_updated_on";
    else if (/newest\s+first|most\s+recent|latest/.test(lower)) orderby = "-sys_created_on";
    else if (/sort(ed)?\s+by\s+priority|highest\s+priority/.test(lower)) orderby = "priority";

    // Limit
    let limit = 20;
    const limitMatch = lower.match(/(top|first|limit|show)\s+(\d+)/);
    if (limitMatch) limit = parseInt(limitMatch[2], 10);
    else if (/\ball\b/.test(lower)) limit = 100;

    const encodedQuery = queryParts.join("^");

    // Default table
    if (!table) {
      if (/ticket|issue|outage|down|broke|fix|urgent|critical/.test(lower)) {
        table = "incident";
      } else {
        return ok({
          error: "Could not determine target table from input.",
          hint: "Mention a table name like 'incidents', 'changes', 'users', 'servers', etc.",
          available_aliases: [
            "ITSM: incidents, changes, problems, tasks, requests, ritms",
            "Users: users, groups, teams",
            "CMDB: servers, computers, databases, applications, services, cis",
            "Other: knowledge/articles, catalog items, alerts, slas, notifications",
          ],
        });
      }
    }

    // ── Execute based on intent ──
    const result: Record<string, unknown> = {
      intent,
      table,
      query: encodedQuery || undefined,
    };

    switch (intent) {
      case "SCHEMA": {
        result.action = "Fetching schema";
        const resp = await client.get("/api/now/table/sys_dictionary", {
          sysparm_query: `name=${table}^internal_type!=collection`,
          sysparm_fields: "element,column_label,internal_type,max_length,mandatory,reference",
          sysparm_limit: "500",
          sysparm_display_value: "true",
        });
        const fields = (resp.result || [])
          .filter((r: Record<string, string>) => r.element)
          .map((r: Record<string, string>) => ({
            field: r.element, label: r.column_label, type: r.internal_type,
            max_length: r.max_length, mandatory: r.mandatory,
            reference: r.reference || null,
          }))
          .sort((a: { field: string }, b: { field: string }) => a.field.localeCompare(b.field));
        result.results = fields;
        break;
      }

      case "AGGREGATE": {
        let aggType = "COUNT";
        let aggField = "";
        if (/\b(average|avg)\b/.test(lower)) { aggType = "AVG"; }
        else if (/\bsum\b/.test(lower)) { aggType = "SUM"; }
        else if (/\bmin(imum)?\b/.test(lower)) { aggType = "MIN"; }
        else if (/\bmax(imum)?\b/.test(lower)) { aggType = "MAX"; }

        // Extract field for non-COUNT
        if (aggType !== "COUNT") {
          const fieldMatch = lower.match(new RegExp(`(?:${aggType.toLowerCase()}|average|avg|sum|min(?:imum)?|max(?:imum)?)\\s+(?:of\\s+)?(\\w+)`));
          if (fieldMatch) aggField = fieldMatch[1];
        }

        // Group by
        let groupBy = "";
        const groupMatch = lower.match(/(group(?:ed)?|by)\s+(priority|state|category|assigned_to|assignment_group|urgency|impact)/);
        if (groupMatch) groupBy = groupMatch[2];

        const params: Record<string, string> = {};
        if (aggType === "COUNT") params.sysparm_count = "true";
        else params[`sysparm_${aggType.toLowerCase()}_fields`] = aggField;
        if (encodedQuery) params.sysparm_query = encodedQuery;
        if (groupBy) params.sysparm_group_by = groupBy;

        const resp = await client.get(`/api/now/stats/${table}`, params);
        result.aggregate_type = aggType;
        if (groupBy) result.group_by = groupBy;
        result.results = resp.result;
        break;
      }

      case "QUERY": {
        const fields = DEFAULT_FIELDS[table] || "";
        const params = buildTableParams({
          query: encodedQuery,
          fields,
          limit,
          orderby,
          displayValue: "true",
        });
        const resp = await client.get(`/api/now/table/${table}`, params);
        const records = resp.result || [];
        result.limit = limit;
        if (orderby) result.sort = orderby;
        result.record_count = records.length;
        result.results = records;
        break;
      }

      case "CREATE": {
        const payload: Record<string, string> = {};
        // Extract short description
        const descMatch = input.match(/(?:for|about|regarding)\s+([^,]+)/i);
        if (descMatch) {
          let desc = descMatch[1].replace(/\s*(,|assign|priority|p[1-5]|urgency|impact|category).*$/i, "").trim();
          payload.short_description = desc;
        }
        // Priority from query parts
        for (const part of queryParts) {
          if (part.startsWith("priority=")) payload.priority = part.split("=")[1];
        }
        if (groupMatch) payload.assignment_group = groupMatch[1].trim();

        result.payload = payload;

        if (args.execute) {
          const resp = await client.post(`/api/now/table/${table}`, payload);
          result.executed = true;
          result.created = resp.result;
        } else {
          result.executed = false;
          result.message = "Write operation — set execute=true to create the record.";
        }
        break;
      }

      case "UPDATE": {
        const updatePayload: Record<string, string> = {};
        if (/\bclose\b/.test(lower)) updatePayload.state = "7";
        else if (/\bresolve\b/.test(lower)) updatePayload.state = "6";
        for (const part of queryParts) {
          if (part.startsWith("priority=")) updatePayload.priority = part.split("=")[1];
        }

        result.payload = updatePayload;
        result.executed = false;
        result.message =
          "Update requires a sys_id. Use sn_query to find the record, then sn_update to modify it.";
        break;
      }

      case "BATCH": {
        const batchAction = /\bdelete\b|\bremove\b/.test(lower) ? "delete" : "update";
        let batchFields: Record<string, string> | undefined;
        if (batchAction === "update") {
          if (/\bclose\b/.test(lower))
            batchFields = { state: "7", close_code: "Solved (Permanently)", close_notes: "Bulk closed via sn_nl" };
          else if (/\bresolve\b/.test(lower))
            batchFields = { state: "6" };
        }

        result.batch_action = batchAction;
        result.batch_fields = batchFields;
        result.limit = limit;

        if (args.execute && args.confirm) {
          if (batchAction === "delete" && !args.force) {
            result.executed = false;
            result.message = "Bulk DELETE requires force=true. This is a safety measure.";
          } else {
            // Actually execute the batch
            const matchResp = await client.get(`/api/now/table/${table}`, {
              sysparm_fields: "sys_id",
              sysparm_limit: String(limit),
              sysparm_query: encodedQuery,
            });
            const records = matchResp.result || [];
            let processed = 0;
            let failed = 0;
            for (const rec of records) {
              try {
                if (batchAction === "update" && batchFields) {
                  await client.patch(`/api/now/table/${table}/${rec.sys_id}`, batchFields);
                  processed++;
                } else if (batchAction === "delete") {
                  await client.delete(`/api/now/table/${table}/${rec.sys_id}`);
                  processed++;
                }
              } catch { failed++; }
            }
            result.executed = true;
            result.matched = records.length;
            result.processed = processed;
            result.failed = failed;
          }
        } else {
          // Dry run
          const matchResp = await client.get(`/api/now/table/${table}`, {
            sysparm_fields: "sys_id",
            sysparm_limit: String(limit),
            sysparm_query: encodedQuery,
          });
          result.executed = false;
          result.matched = (matchResp.result || []).length;
          result.message = `Dry run — ${(matchResp.result || []).length} records would be affected. Set execute=true and confirm=true to proceed.`;
        }
        break;
      }

      case "DELETE": {
        result.executed = false;
        result.message =
          "Delete requires a specific sys_id. Use sn_query to find the record, then sn_delete to remove it.";
        break;
      }
    }

    return ok(result);
  } catch (error) {
    return err(formatError(error));
  }
}
