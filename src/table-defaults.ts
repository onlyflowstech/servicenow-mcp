/**
 * Shared per-table knowledge: curated default field sets and
 * natural-language table aliases.
 *
 * DEFAULT_FIELDS drives token-efficient responses: when a tool's `fields`
 * parameter is omitted and the table is listed here, only these
 * high-signal fields are requested instead of the full record.
 *
 * @module table-defaults
 */

import { SAFE_DEFAULT_FIELDS } from "./field-policy.js";

/**
 * Curated default field sets (~8-12 highest-signal fields per table).
 * Applied as sysparm_fields when `fields` is omitted in sn_query / sn_get.
 * Registered V2 calls resolve fields="all" to the policy-approved readable set.
 */
export const DEFAULT_FIELDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SAFE_DEFAULT_FIELDS).map(([table, fields]) => [
      table,
      fields.join(","),
    ])
  )
);

/**
 * Resolve the sysparm_fields value for a table:
 * - fields === "all"  -> undefined for direct legacy handler calls; registered
 *                        V2 calls replace it with the approved readable set
 * - explicit fields   -> passed through as given
 * - omitted           -> the curated DEFAULT_FIELDS set when the table is
 *                        known, otherwise undefined (full record)
 */
export function resolveFields(table: string, fields?: string): string | undefined {
  if (fields === "all") return undefined;
  if (fields) return fields;
  return DEFAULT_FIELDS[table];
}

/** Natural-language aliases mapped to table names (used by sn_nl). */
export const TABLE_ALIASES: Record<string, string> = {
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
  "catalog task": "sc_task", "catalog tasks": "sc_task",
  // Other
  "update set": "sys_update_set", "update sets": "sys_update_set",
  flow: "sys_hub_flow", flows: "sys_hub_flow",
  notification: "sysevent_email_action", notifications: "sysevent_email_action",
  "business rule": "sys_script", "business rules": "sys_script",
  alert: "em_alert", alerts: "em_alert",
  sla: "task_sla", slas: "task_sla",
  email: "sys_email", emails: "sys_email",
};
