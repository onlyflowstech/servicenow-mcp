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

/**
 * Curated default field sets (~8-12 highest-signal fields per table).
 * Applied as sysparm_fields when `fields` is omitted in sn_query / sn_get.
 * Pass fields="all" to those tools to request the full record instead.
 */
export const DEFAULT_FIELDS: Record<string, string> = {
  incident:
    "sys_id,number,short_description,state,priority,assigned_to,assignment_group,caller_id,opened_at,sys_updated_on",
  change_request:
    "sys_id,number,short_description,state,priority,type,risk,assigned_to,assignment_group,start_date,end_date,sys_updated_on",
  problem:
    "sys_id,number,short_description,state,priority,assigned_to,assignment_group,known_error,opened_at,sys_updated_on",
  sc_request:
    "sys_id,number,short_description,state,request_state,priority,requested_for,approval,opened_at,sys_updated_on",
  sc_req_item:
    "sys_id,number,short_description,state,priority,cat_item,request,assigned_to,stage,opened_at,sys_updated_on",
  sc_task:
    "sys_id,number,short_description,state,priority,assigned_to,assignment_group,request_item,opened_at,sys_updated_on",
  sys_user:
    "sys_id,user_name,name,email,title,department,manager,location,active,sys_updated_on",
  sys_user_group:
    "sys_id,name,description,manager,parent,email,active,sys_updated_on",
  cmdb_ci:
    "sys_id,name,sys_class_name,operational_status,install_status,category,owned_by,support_group,sys_updated_on",
  cmdb_ci_server:
    "sys_id,name,host_name,ip_address,os,os_version,classification,operational_status,install_status,support_group,sys_updated_on",
  cmdb_ci_computer:
    "sys_id,name,host_name,ip_address,os,manufacturer,model_id,operational_status,assigned_to,sys_updated_on",
  kb_knowledge:
    "sys_id,number,short_description,workflow_state,kb_knowledge_base,kb_category,author,published,sys_view_count,sys_updated_on",
  task:
    "sys_id,number,short_description,state,priority,assigned_to,assignment_group,sys_class_name,opened_at,sys_updated_on",
};

/**
 * Resolve the sysparm_fields value for a table:
 * - fields === "all"  -> undefined (full record for any table)
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
