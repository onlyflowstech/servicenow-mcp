// Builders and one positive and one negative case for every evaluator rule.
// Payloads follow the shape of `sys_update_xml.payload`: a declaration, then
// <record_update table="…"><table action="…">fields…</table></record_update>.

import type { RuleId } from "../../../src/update-set-eval/rules.js";
import type {
  EvaluateContext,
  EvaluateSet,
  EvaluateUpdate,
  EvaluationInput,
} from "../../../src/update-set-eval/types.js";

export const sid = (n: number): string => n.toString(16).padStart(32, "0");

export const SET_ID = sid(0x5e7);
export const CHILD_ID = sid(0xc41d);
export const APP_GLOBAL = sid(0x910ba1);
export const APP_OTHER = sid(0x07e2);

type FieldValue = string | { readonly value: string; readonly display?: string };

const escapeText = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const escapeAttr = (value: string) => escapeText(value).replace(/"/gu, "&quot;");

/** A payload with one record, and optional extra records (raw XML) after it. */
export function payload(
  table: string,
  fields: Readonly<Record<string, FieldValue>>,
  options: { readonly action?: string; readonly extra?: string; readonly cdata?: readonly string[] } = {}
): string {
  const cdata = new Set(options.cdata ?? ["script", "condition", "client_script", "operation_script", "processing_script", "script_true", "script_false"]);
  const body = Object.entries(fields)
    .map(([name, field]) => {
      const value = typeof field === "string" ? field : field.value;
      const display = typeof field === "string" || field.display === undefined ? "" : ` display_value="${escapeAttr(field.display)}"`;
      const text = cdata.has(name) ? `<![CDATA[${value.replace(/\]\]>/gu, "]]]]><![CDATA[>")}]]>` : escapeText(value);
      return `<${name}${display}>${text}</${name}>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><record_update table="${table}">` +
    `<${table} action="${options.action ?? "INSERT_OR_UPDATE"}">${body}</${table}>${options.extra ?? ""}</record_update>`
  );
}

let rowCounter = 0x1000;

export function update(table: string, fields: Readonly<Record<string, FieldValue>>, overrides: Partial<EvaluateUpdate> = {}): EvaluateUpdate {
  const id = sid(++rowCounter);
  return {
    sys_id: id,
    name: `${table}_${id}`,
    type: "Record",
    target_name: "target",
    update_set: SET_ID,
    action: overrides.action ?? "INSERT_OR_UPDATE",
    application: APP_GLOBAL,
    replace_on_upgrade: false,
    payload: payload(table, fields, { action: overrides.action ?? "INSERT_OR_UPDATE" }),
    ...overrides,
  };
}

export function set(overrides: Partial<EvaluateSet> = {}): EvaluateSet {
  return {
    sys_id: SET_ID,
    name: "Release 1",
    state: "in progress",
    is_default: false,
    has_description: true,
    application: APP_GLOBAL,
    parent: null,
    update_count: 1,
    ...overrides,
  };
}

/** Tables the test context treats as data (not extending sys_metadata). */
export const DATA_TABLES = new Set(["incident", "u_vendor", "sys_user", "cmdb_ci"]);
/** Tables the test context treats as credential tables. */
export const TEST_CREDENTIAL_TABLES = new Set(["sys_properties", "oauth_entity", "sys_auth_profile_basic", "discovery_credentials"]);

export const CONTEXT: EvaluateContext = {
  isCredentialTable: (table) => TEST_CREDENTIAL_TABLES.has(table),
  hiddenFieldNames: (table) => (table === "u_vendor" ? new Set(["u_api_password"]) : new Set()),
  extendsMetadata: (table) => !DATA_TABLES.has(table),
};

export function input(updates: readonly EvaluateUpdate[], overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    source: "local",
    sets: [set({ update_count: updates.length })],
    updates,
    updates_total: updates.length,
    payload_access: "granted",
    open_set_collisions: new Map(),
    baseline_versions: new Map(updates.map((u) => [u.name, "customer" as const])),
    context: CONTEXT,
    ...overrides,
  };
}

const br = (script: string, extra: Record<string, FieldValue> = {}) =>
  update("sys_script", { name: "BR", collection: "incident", when: "before", action_query: "false", script, ...extra });
const client = (script: string) => update("sys_script_client", { name: "CS", table: "incident", type: "onChange", script });
const include = (fields: Record<string, FieldValue>) =>
  update("sys_script_include", { name: "Util", api_name: "global.Util", access: "package_private", client_callable: "false", script: "var Util = Class.create();", ...fields });

export interface RuleCase {
  readonly positive: () => EvaluationInput;
  readonly negative: () => EvaluationInput;
}

const one = (row: () => EvaluateUpdate) => () => input([row()]);

export const RULE_CASES: Readonly<Record<RuleId, RuleCase>> = {
  PERF001: {
    positive: one(() => br("var gr = new GlideRecord('incident');\ngr.addActiveQuery();\ngr.query();\nwhile (gr.next()) {\n  var t = new GlideRecord('task');\n  t.get(gr.parent);\n}")),
    negative: one(() => br("var ids = [];\nvar gr = new GlideRecord('incident');\ngr.addActiveQuery();\ngr.query();\nwhile (gr.next()) { ids.push(gr.getUniqueValue()); }\nvar t = new GlideRecord('task');\nt.addQuery('parent', 'IN', ids);\nt.query();")),
  },
  PERF002: {
    positive: one(() => br("var gr = new GlideRecord('incident');\ngr.query();\nwhile (gr.next()) { gs.info(gr.number); }")),
    negative: one(() => br("var gr = new GlideRecord('incident');\ngr.addActiveQuery();\ngr.setLimit(10);\ngr.query();")),
  },
  PERF003: {
    positive: one(() => br("var gr = new GlideRecord('incident');\ngr.addActiveQuery();\ngr.query();\nvar n = gr.getRowCount();")),
    negative: one(() => br("var ga = new GlideAggregate('incident');\nga.addAggregate('COUNT');\nga.query();")),
  },
  PERF004: {
    positive: one(() => br("current.addQuery('active', true);", { action_query: "true" })),
    negative: one(() => br("current.setValue('state', 2);", { action_query: "false" })),
  },
  PERF005: {
    positive: one(() => client("function onChange(control, oldValue, newValue) {\n  var caller = g_form.getReference('caller_id');\n}")),
    negative: one(() => client("function onChange(control, oldValue, newValue) {\n  g_form.getReference('caller_id', function(caller) { g_form.setValue('location', caller.location); });\n}")),
  },
  PERF006: {
    positive: one(() => br("var r = new sn_ws.RESTMessageV2('Vendor', 'get');\nvar response = r.execute();", { when: "before" })),
    negative: one(() => br("var r = new sn_ws.RESTMessageV2('Vendor', 'get');\nvar response = r.execute();", { when: "async" })),
  },
  PERF007: {
    positive: one(() => br("current.state = 2;\ncurrent.update();")),
    negative: one(() => br("current.setValue('state', 2);")),
  },
  PERF008: {
    positive: one(() => br("gs.sleep(5000);")),
    negative: one(() => br("gs.info('no sleep here');")),
  },
  PERF009: {
    positive: () => input([br("gs.info(1);")], { sets: [set({ update_count: 1_500 })], updates_total: 1 }),
    negative: () => input([br("gs.info(1);")], { sets: [set({ update_count: 999 })], updates_total: 1 }),
  },
  SEC001: {
    positive: one(() => update("sys_security_acl", { name: "incident.u_notes", operation: "read", advanced: "true", condition: "", script: "answer = true;" })),
    negative: one(() => br("gs.info('not an ACL');")),
  },
  SEC002: {
    positive: one(() => update("sys_user_role_contains", { role: { value: sid(1), display: "x_app.manager" }, contains: { value: sid(2), display: "admin" } })),
    negative: one(() => br("gs.info('not a role');")),
  },
  SEC003: {
    positive: one(() => include({ client_callable: "true", script: "var Util = Class.create();\nUtil.prototype = Object.extendsObject(AbstractAjaxProcessor, {\n  isPublic: function() { return true; },\n  type: 'Util'\n});" })),
    negative: one(() => include({ client_callable: "false" })),
  },
  SEC004: {
    positive: one(() => br("var value = eval(current.u_expression + '');")),
    negative: one(() => br("var evaluation = current.u_expression + '';")),
  },
  SEC005: {
    positive: one(() => br("var r = new sn_ws.RESTMessageV2();\nr.setBasicAuth('svc', 'Zq9-literal-secret');")),
    negative: one(() => client("function onLoad() {\n  g_form.setMandatory('password', 'true');\n  g_form.showFieldMsg('password', 'Use at least 12 characters', 'info');\n}")),
  },
  SEC006: {
    positive: one(() => update("sys_properties", { name: "glide.security.use_csrf_token", type: "true|false", value: "false" }, { target_name: "glide.security.use_csrf_token" })),
    negative: one(() => br("gs.info('not a property');")),
  },
  SEC007: {
    positive: one(() => include({ access: "public" })),
    negative: one(() => include({ access: "package_private" })),
  },
  SEC008: {
    positive: one(() => update("sys_ws_operation", { name: "lookup", http_method: "GET", requires_authentication: "false", operation_script: "response.setBody({});" })),
    negative: one(() => update("sys_ws_operation", { name: "lookup", http_method: "GET", requires_authentication: "true", operation_script: "response.setBody({});" })),
  },
  SEC009: {
    positive: one(() => br("var gr = new GlideRecord('task');\ngr.get(current.parent);\ngr.setWorkflow(false);\ngr.update();")),
    negative: one(() => br("var gr = new GlideRecord('task');\ngr.get(current.parent);\ngr.setWorkflow(true);\ngr.update();")),
  },
  SEC010: {
    positive: one(() => update("u_vendor", { u_name: "Acme", u_api_password: "c2VjcmV0LWNpcGhlcnRleHQ=" })),
    negative: one(() => update("u_vendor", { u_name: "Acme", u_api_password: "" })),
  },
  SEC011: {
    positive: one(() => update("incident", { number: "INC0010001", short_description: "data" })),
    negative: one(() => br("gs.info('metadata');")),
  },
  BP001: {
    positive: () => input([br("gs.info(1);")], { sets: [set({ is_default: true })] }),
    negative: () => input([br("gs.info(1);")], { sets: [set({ is_default: false })] }),
  },
  BP002: {
    positive: () => input([br("gs.info(1);"), br("gs.info(2);", {})].map((u, i) => ({ ...u, application: i === 0 ? APP_GLOBAL : APP_OTHER }))),
    negative: () => input([br("gs.info(1);"), br("gs.info(2);")]),
  },
  BP003: {
    positive: one(() => update("sys_script", { name: "Old BR", script: "gs.info(1);" }, { action: "DELETE" })),
    negative: one(() => br("gs.info(1);")),
  },
  BP004: {
    positive: () => {
      const row = br("gs.info(1);");
      return input([row], { open_set_collisions: new Map([[row.name, 1]]) });
    },
    negative: () => {
      const row = br("gs.info(1);");
      return input([row], { open_set_collisions: new Map([[`other_${row.name}`, 1]]) });
    },
  },
  BP005: {
    positive: () => {
      const row = br("gs.info(1);");
      return input([row], { baseline_versions: new Map([[row.name, "baseline" as const]]) });
    },
    negative: () => {
      const row = br("gs.info(1);");
      return input([row], { baseline_versions: new Map([[row.name, "customer" as const]]) });
    },
  },
  BP006: {
    positive: () => input([br("gs.info(1);")], { sets: [set({ has_description: false })] }),
    negative: () => input([br("gs.info(1);")], { sets: [set({ has_description: true })] }),
  },
  BP007: {
    positive: () =>
      input([br("gs.info(1);")], {
        batch_root: SET_ID,
        sets: [set({ state: "complete" }), set({ sys_id: CHILD_ID, name: "Child", parent: SET_ID, state: "in progress" })],
      }),
    negative: () =>
      input([br("gs.info(1);")], {
        batch_root: SET_ID,
        sets: [set({ state: "complete" }), set({ sys_id: CHILD_ID, name: "Child", parent: SET_ID, state: "complete" })],
      }),
  },
  BP008: {
    positive: () => {
      const a = br("gs.info(1);");
      const b = { ...br("gs.info(2);"), name: a.name, update_set: CHILD_ID };
      return input([a, b], { batch_root: SET_ID, sets: [set(), set({ sys_id: CHILD_ID, name: "Child", parent: SET_ID })] });
    },
    negative: () => {
      const a = br("gs.info(1);");
      const b = { ...br("gs.info(2);"), update_set: CHILD_ID };
      return input([a, b], { batch_root: SET_ID, sets: [set(), set({ sys_id: CHILD_ID, name: "Child", parent: SET_ID })] });
    },
  },
  BP009: {
    positive: () => input([], { sets: [set({ update_count: 0 })] }),
    negative: () => input([br("gs.info(1);")], { sets: [set({ update_count: 1 })] }),
  },
  BP010: {
    positive: one(() => br("var group = '0123456789abcdef0123456789abcdef';\ncurrent.assignment_group = group;")),
    negative: one(() => br("current.assignment_group = gs.getProperty('x_app.default_group');")),
  },
  BP011: {
    positive: one(() => br("gs.log('debugging');")),
    negative: one(() => br("gs.info('information');")),
  },
  BP012: {
    positive: one(() => ({ ...br("gs.info(1);"), replace_on_upgrade: true })),
    negative: one(() => br("gs.info(1);")),
  },
};
