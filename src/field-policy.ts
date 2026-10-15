/**
 * Fail-closed ServiceNow field authorization and response filtering.
 *
 * Table authorization answers whether a tool may reach a table. This module
 * supplies the second, independent boundary: which fields may be requested,
 * written, or returned for the supported V2 table domains. Built-in defaults
 * can be narrowed per profile (`fieldPolicy`, `readableTableFields`,
 * `writableTableFields`), including a generic "*" table fallback. The
 * SN_FIELD_POLICY_DEFINITIONS variable feeds only the SN_PROFILE_NAME
 * environment profile; this module never reads the process environment.
 *
 * @module field-policy
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeUtilTypes } from "node:util";

export type ResponseFormat = "concise" | "detailed";

export interface ReadFieldSelectionInput {
  readonly fields?: unknown;
  readonly responseFormat?: unknown;
}

export type FieldSelection = readonly string[];

export interface PreparedFieldAccess {
  readonly entries: readonly {
    readonly table: string;
    readonly readableFields: FieldSelection;
  }[];
}

export type FieldPolicyFailureReason =
  | "unsupported_table"
  | "invalid_field_selection"
  | "unreadable_field"
  | "invalid_write_payload"
  | "non_writable_field"
  | "sensitive_field"
  | "unsupported_field_path"
  | "explicit_field_required"
  | "traversal_limit_exceeded"
  | "invalid_argument_shape";

type FieldPolicySet = readonly string[] | "*";

interface TableFieldPolicyDefinition {
  readonly defaults?: FieldPolicySet;
  readonly readable?: FieldPolicySet;
  readonly writable?: FieldPolicySet;
}

interface MutableTableFieldPolicyDefinition {
  readonly defaults?: FieldPolicySet;
  readonly readable?: FieldPolicySet;
  readonly writable?: FieldPolicySet;
}

export interface TableFieldListDefinition {
  readonly table: string;
  readonly fields: readonly string[] | "*";
}

export interface FieldPolicyConfigurationInput {
  readonly fieldPolicy?: unknown;
  readonly readableTableFields?: unknown;
  readonly writableTableFields?: unknown;
}

export interface FieldPolicyEnvironment {
  readonly SN_FIELD_POLICY_DEFINITIONS?: string;
}

interface FieldPolicyConfiguration {
  readonly definitions: Record<string, MutableTableFieldPolicyDefinition>;
}

interface TableFieldPolicy {
  readonly table: string;
  readonly defaults: FieldSelection;
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  readonly allowAnyReadable: boolean;
  readonly allowAnyWritable: boolean;
}

const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
/** @deprecated Field authorization no longer caps the number of selected fields. */
export const MAX_FIELDS_PER_OPERATION = 10_000;
/** Hard bounds for hostile values crossing the field-policy boundary. */
export const MAX_FIELD_VALUE_DEPTH = 24;
export const MAX_FIELD_VALUE_NODES = 50_000;
export const MAX_FIELD_ARRAY_LENGTH = 10_000;
export const MAX_FIELD_OBJECT_OWN_KEYS = 256;
export const MAX_TOOL_ARGUMENT_OWN_KEYS = 64;
const MAX_CANONICAL_ARGUMENT_KEYS = 8;
const FIELD_POLICY_DEFINITIONS_ENV = "SN_FIELD_POLICY_DEFINITIONS";
const MAX_FIELD_POLICY_DEFINITIONS_TEXT_LENGTH = 65_536;
const FIELD_POLICY_WILDCARD = "*";
const ALL_FIELDS_SELECTION = Object.freeze([FIELD_POLICY_WILDCARD]) as readonly string[];
/** Bounded projection for a table whose readable set is a wildcard but whose
 * defaults the operator did not state. An unstated default must stay finite:
 * "may read any field" is not "return every field on every query". */
const GENERIC_DEFAULT_FIELDS = Object.freeze(["sys_id"]) as readonly string[];
/** Write-response projection for a write-only table (`readable: []`). The
 * record's own handle is all a write returns there; denying the write instead
 * would make a write-only policy unable to write anything. */
const WRITE_ONLY_RESPONSE_FIELDS = Object.freeze(["sys_id"]) as readonly string[];
/** Configuration keys a scoped field policy may carry. */
const FIELD_POLICY_CONFIGURATION_KEYS = Object.freeze([
  "fieldPolicy",
  "readableTableFields",
  "writableTableFields",
] as const);
/** The two table-list keys; neither may be combined with `fieldPolicy`. */
const TABLE_FIELD_LIST_KEYS = Object.freeze([
  "readableTableFields",
  "writableTableFields",
] as const);
/** Keys a `fieldPolicy` table entry may state. */
const TABLE_ENTRY_KEYS = Object.freeze(["defaults", "readable", "writable"] as const);
/** Keys a `{ table, fields }` list entry may state. */
const LIST_ENTRY_KEYS = Object.freeze(["table", "fields"] as const);
const FIELD_NAME_RULE =
  "letters, digits, and underscores, starting with a letter, at most 80 characters";
/**
 * Fields that change what a record is rather than what it says:
 * sys_class_name moves it to another class (table), and sys_domain moves it
 * to another domain. A writable wildcard, including the open built-in
 * default, never covers them. They are writable only where a profile lists
 * them in `writable`.
 */
const EXPLICIT_WRITE_FIELDS: ReadonlySet<string> = new Set(["sys_class_name", "sys_domain"]);

const INCIDENT_DEFAULTS = [
  "sys_id",
  "number",
  "short_description",
  "state",
  "priority",
  "assigned_to",
  "assignment_group",
  "caller_id",
  "opened_at",
  "sys_updated_on",
  "active",
] as const;

/**
 * Built-in table entries. Only `defaults`, the bounded projection a read gets
 * when it names no fields, is applied (see FIELD_POLICY_BASE). The `readable`
 * and `writable` lists below are not read by any code path: a `writable: []`
 * here denies nothing. What a profile may read or write is decided by its
 * own field policy, its tableAccess grant, and ServiceNow's ACLs.
 */
const POLICY_DEFINITIONS = {
  incident: {
    defaults: INCIDENT_DEFAULTS,
    readable: [
      ...INCIDENT_DEFAULTS,
      "category",
      "subcategory",
      "description",
      "impact",
      "urgency",
      "contact_type",
      "opened_by",
      "resolved_at",
      "resolved_by",
      "close_code",
      "close_notes",
    ],
    writable: [
      "short_description",
      "description",
      "caller_id",
      "assignment_group",
      "assigned_to",
      "impact",
      "urgency",
      "priority",
      "category",
      "subcategory",
      "state",
      "close_code",
      "close_notes",
      "contact_type",
    ],
  },
  change_request: {
    defaults: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "priority",
      "type",
      "risk",
      "assigned_to",
      "assignment_group",
      "start_date",
      "end_date",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "number",
      "short_description",
      "description",
      "state",
      "priority",
      "type",
      "risk",
      "impact",
      "assigned_to",
      "assignment_group",
      "requested_by",
      "start_date",
      "end_date",
      "sys_updated_on",
    ],
    writable: [],
  },
  problem: {
    defaults: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "priority",
      "assigned_to",
      "assignment_group",
      "known_error",
      "opened_at",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "number",
      "short_description",
      "description",
      "state",
      "priority",
      "assigned_to",
      "assignment_group",
      "known_error",
      "opened_at",
      "resolved_at",
      "sys_updated_on",
    ],
    writable: [],
  },
  sc_request: {
    defaults: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "request_state",
      "priority",
      "requested_for",
      "approval",
      "opened_at",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "request_state",
      "priority",
      "requested_for",
      "requested_by",
      "approval",
      "opened_at",
      "sys_updated_on",
    ],
    writable: [],
  },
  sc_req_item: {
    defaults: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "priority",
      "cat_item",
      "request",
      "assigned_to",
      "stage",
      "opened_at",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "priority",
      "cat_item",
      "request",
      "requested_for",
      "assigned_to",
      "assignment_group",
      "stage",
      "opened_at",
      "sys_updated_on",
    ],
    writable: [],
  },
  sc_task: {
    defaults: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "priority",
      "assigned_to",
      "assignment_group",
      "request_item",
      "opened_at",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "priority",
      "assigned_to",
      "assignment_group",
      "request_item",
      "opened_at",
      "sys_updated_on",
    ],
    writable: [],
  },
  sys_user: {
    defaults: [
      "sys_id",
      "user_name",
      "name",
      "email",
      "title",
      "department",
      "manager",
      "location",
      "active",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "user_name",
      "name",
      "email",
      "title",
      "department",
      "manager",
      "location",
      "active",
      "sys_updated_on",
    ],
    writable: [],
  },
  sys_user_group: {
    defaults: [
      "sys_id",
      "name",
      "description",
      "manager",
      "parent",
      "email",
      "active",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "name",
      "description",
      "manager",
      "parent",
      "email",
      "active",
      "sys_updated_on",
    ],
    writable: [],
  },
  // Group membership grants every role the group holds, so a write here can
  // escalate the integration account as surely as a sys_script write. Nothing
  // in this module denies it: like sys_user_role, sys_user_has_role, and
  // sys_group_has_role (which have no entry here and no table-level block in
  // table-policy.ts), it is writable exactly when the profile's tableAccess
  // grants it and its field policy does not narrow it. Grant it deliberately.
  sys_user_grmember: {
    defaults: ["sys_id", "user", "group"],
    readable: ["sys_id", "user", "group", "sys_created_on", "sys_updated_on"],
    writable: [],
  },
  cmdb_ci: {
    defaults: [
      "sys_id",
      "name",
      "sys_class_name",
      "operational_status",
      "install_status",
      "category",
      "owned_by",
      "support_group",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "name",
      "sys_class_name",
      "operational_status",
      "install_status",
      "category",
      "subcategory",
      "owned_by",
      "managed_by",
      "support_group",
      "location",
      "sys_updated_on",
    ],
    writable: [],
  },
  cmdb_ci_server: {
    defaults: [
      "sys_id",
      "name",
      "host_name",
      "ip_address",
      "os",
      "os_version",
      "classification",
      "operational_status",
      "install_status",
      "support_group",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "name",
      "host_name",
      "ip_address",
      "os",
      "os_version",
      "classification",
      "operational_status",
      "install_status",
      "owned_by",
      "support_group",
      "location",
      "sys_updated_on",
    ],
    writable: [],
  },
  cmdb_ci_computer: {
    defaults: [
      "sys_id",
      "name",
      "host_name",
      "ip_address",
      "os",
      "manufacturer",
      "model_id",
      "operational_status",
      "assigned_to",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "name",
      "host_name",
      "ip_address",
      "os",
      "os_version",
      "manufacturer",
      "model_id",
      "serial_number",
      "operational_status",
      "install_status",
      "assigned_to",
      "support_group",
      "location",
      "sys_updated_on",
    ],
    writable: [],
  },
  kb_knowledge: {
    defaults: [
      "sys_id",
      "number",
      "short_description",
      "workflow_state",
      "kb_knowledge_base",
      "kb_category",
      "author",
      "published",
      "sys_view_count",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "number",
      "short_description",
      "workflow_state",
      "kb_knowledge_base",
      "kb_category",
      "author",
      "published",
      "sys_view_count",
      "sys_updated_on",
    ],
    writable: [],
  },
  task: {
    defaults: [
      "sys_id",
      "number",
      "short_description",
      "state",
      "priority",
      "assigned_to",
      "assignment_group",
      "sys_class_name",
      "opened_at",
      "sys_updated_on",
    ],
    readable: [
      "sys_id",
      "number",
      "short_description",
      "description",
      "state",
      "priority",
      "assigned_to",
      "assignment_group",
      "sys_class_name",
      "opened_at",
      "sys_updated_on",
    ],
    writable: [],
  },
  syslog: {
    defaults: ["sys_id", "level", "source", "message", "sys_created_on"],
    readable: [
      "sys_id",
      "level",
      "source",
      "message",
      "sys_created_on",
      "sys_updated_on",
    ],
    writable: [],
  },
  sys_script: {
    defaults: ["sys_id", "name", "script"],
    readable: ["sys_id", "name", "script", "active", "collection", "filter", "when", "order", "sys_updated_on"],
    writable: [],
  },
  sys_script_include: {
    defaults: ["sys_id", "name", "script"],
    readable: ["sys_id", "name", "script", "active", "api_name", "client_callable", "access", "sys_updated_on"],
    writable: [],
  },
  sys_ui_script: {
    defaults: ["sys_id", "name", "script"],
    readable: ["sys_id", "name", "script", "active", "global", "sys_updated_on"],
    writable: [],
  },
  sys_script_client: {
    defaults: ["sys_id", "name", "script"],
    readable: ["sys_id", "name", "script", "active", "table", "type", "condition", "sys_updated_on"],
    writable: [],
  },
  sys_ws_operation: {
    defaults: ["sys_id", "name", "operation_script"],
    readable: ["sys_id", "name", "operation_script", "active", "http_method", "relative_path", "sys_updated_on"],
    writable: [],
  },
  sys_db_object: {
    defaults: ["sys_id", "name", "label", "super_class", "sys_scope", "is_extendable"],
    readable: ["sys_id", "name", "label", "super_class", "sys_scope", "is_extendable"],
    writable: [],
  },
  sys_app: {
    defaults: ["sys_id", "name", "version", "scope", "active"],
    readable: ["sys_id", "name", "version", "scope", "active"],
    writable: [],
  },
  sys_store_app: {
    defaults: ["sys_id", "name", "version", "scope", "active"],
    readable: ["sys_id", "name", "version", "scope", "active"],
    writable: [],
  },
  v_plugin: {
    defaults: ["sys_id", "name", "active"],
    readable: ["sys_id", "name", "active"],
    writable: [],
  },
  sys_atf_test: {
    defaults: ["sys_id", "name", "description", "active", "sys_updated_on"],
    readable: ["sys_id", "name", "description", "active", "sys_updated_on", "sys_scope"],
    writable: [],
  },
  sys_atf_test_suite: {
    defaults: ["sys_id", "name", "description", "active"],
    readable: ["sys_id", "name", "description", "active", "sys_updated_on"],
    writable: [],
  },
  sys_atf_test_suite_test: {
    defaults: ["test"],
    readable: ["sys_id", "test", "test_suite"],
    writable: [],
  },
  sys_atf_test_result: {
    defaults: ["sys_id", "test", "status", "output", "duration", "start_time", "end_time"],
    readable: ["sys_id", "test", "test_suite", "execution", "parent", "status", "output", "duration", "start_time", "end_time", "sys_created_on"],
    writable: [],
  },
  // Field names for the tables below are provisional until the ATF platform
  // spike (SNSDK-67) confirms them against an instance. Only `defaults` is
  // applied (see FIELD_POLICY_BASE); an unknown default is ignored upstream.
  sys_atf_step: {
    defaults: ["sys_id", "test", "step_config", "order", "active", "description"],
    readable: ["sys_id", "test", "step_config", "order", "active", "description", "sys_updated_on"],
    writable: [],
  },
  // Shared with catalog and other variable owners; values can be sensitive.
  // Reachable only through an explicit tableAccess grant.
  sys_element_mapping: {
    defaults: ["sys_id", "id", "table", "field", "value"],
    readable: ["sys_id", "id", "table", "field", "value"],
    writable: [],
  },
  sys_variable_value: {
    defaults: ["sys_id", "document", "document_key", "variable", "value"],
    readable: ["sys_id", "document", "document_key", "variable", "value", "order", "sys_updated_on"],
    writable: [],
  },
  sys_atf_test_suite_result: {
    defaults: ["sys_id", "test_suite", "status", "start_time", "end_time", "run_time"],
    readable: [
      "sys_id",
      "test_suite",
      "status",
      "start_time",
      "end_time",
      "run_time",
      "rolled_up_test_success_count",
      "rolled_up_test_failure_count",
      "rolled_up_test_error_count",
      "rolled_up_test_skip_count",
      "sys_created_on",
    ],
    writable: [],
  },
  sys_atf_test_result_step: {
    defaults: ["sys_id", "test_result", "step", "order", "status", "summary"],
    readable: ["sys_id", "test_result", "step", "order", "status", "summary", "output", "start_time", "end_time"],
    writable: [],
  },
  sys_atf_agent: {
    defaults: ["sys_id", "name", "status", "browser_name", "os_name", "sys_updated_on"],
    readable: ["sys_id", "name", "status", "browser_name", "browser_version", "os_name", "os_version", "sys_updated_on"],
    writable: [],
  },
} as const satisfies Record<string, TableFieldPolicyDefinition>;

/**
 * The policy base.
 *
 * The built-in entries contribute their `defaults` -- the bounded projection
 * used when a caller names no fields -- and nothing else. Their `readable` and
 * `writable` lists are deliberately NOT carried over: field policy does not
 * deny at table granularity. Reachability is decided by the profile's
 * `tableAccess` grant and by ServiceNow's per-user ACLs; a table that reaches
 * this module has already been granted, so denying its fields here would only
 * contradict the operator's own configuration.
 *
 * The "*" entry makes every other table resolvable with the same posture, so
 * a granted custom table needs no field-policy entry to be usable.
 *
 * A profile's own "*" entry reaches further: it also covers the ITSM tables
 * (ITSM_TABLES) and every table the profile names, key by key, wherever the
 * table's own entry is silent. Only the system tables (SYSTEM_TABLES) are
 * never covered by a "*" entry.
 */
const FIELD_POLICY_BASE: Readonly<Record<string, TableFieldPolicyDefinition>> =
  Object.freeze({
    ...Object.fromEntries(
      Object.entries(POLICY_DEFINITIONS).map(([table, definition]) => [
        table,
        Object.freeze({
          defaults: definition.defaults,
          readable: FIELD_POLICY_WILDCARD,
          writable: FIELD_POLICY_WILDCARD,
        }),
      ])
    ),
    [FIELD_POLICY_WILDCARD]: Object.freeze({
      defaults: GENERIC_DEFAULT_FIELDS,
      readable: FIELD_POLICY_WILDCARD,
      writable: FIELD_POLICY_WILDCARD,
    }),
  });

const BUILT_IN_TABLE_FIELD_POLICIES = buildFieldPolicyMap(FIELD_POLICY_BASE);

/**
 * Built-in tables whose field policy belongs to the profile, like every
 * custom table. For these, `readable` and `writable` resolve from the
 * profile's own table entry, then the profile's "*" entry, then the built-in
 * "*" (open). Their built-in `defaults` stay as a read-projection
 * convenience, clamped to the effective readable set.
 */
const ITSM_TABLES: ReadonlySet<string> = new Set([
  "incident",
  "change_request",
  "problem",
  "sc_request",
  "sc_req_item",
  "sc_task",
  "task",
  "cmdb_ci",
  "cmdb_ci_server",
  "cmdb_ci_computer",
  "kb_knowledge",
]);

/**
 * Every other built-in table is a system table (scripts, users and groups,
 * ATF, application and dictionary metadata, syslog). It keeps its own
 * built-in entry, a "*" entry never covers it, and it is narrowed only by
 * naming it.
 */
const SYSTEM_TABLES: ReadonlySet<string> = new Set(
  Object.keys(POLICY_DEFINITIONS).filter((table) => !ITSM_TABLES.has(table))
);

const GENERIC_RECORD_TABLES = new Set([
  "incident",
  "change_request",
  "problem",
  "sc_request",
  "sc_req_item",
  "sc_task",
  "sys_user",
  "sys_user_group",
  "cmdb_ci",
  "cmdb_ci_server",
  "cmdb_ci_computer",
  "kb_knowledge",
  "task",
]);

/** Safe defaults exported for legacy concise-response helpers without drift. */
export const SAFE_DEFAULT_FIELDS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      [...BUILT_IN_TABLE_FIELD_POLICIES]
        .filter(([table]) => GENERIC_RECORD_TABLES.has(table))
        .map(([table, policy]) => [table, policy.defaults])
    )
  );

const FIELD_POLICY_CONFIGURATION_SCOPE = new AsyncLocalStorage<FieldPolicyConfigurationInput>();

const PREPARED_FIELD_ACCESS = Symbol("PreparedFieldAccess");
const ISSUED_FIELD_POLICY_ERRORS = new WeakSet<object>();
const ISSUED_PREPARED_FIELD_ACCESS = new WeakSet<object>();

/**
 * Bounded policy rejection that never contains a field *value* or the policy
 * contents. The table and field *names* are carried when known so the denial
 * can be explained to an operator; both are caller-supplied identifiers that
 * have already passed the FIELD_NAME regex, so echoing them discloses nothing
 * the caller did not send.
 */
export class FieldPolicyError extends Error {
  readonly table: string | undefined;
  readonly field: string | undefined;

  constructor(
    readonly reason: FieldPolicyFailureReason,
    detail: { readonly table?: string; readonly field?: string } = {}
  ) {
    super("Field access denied by policy");
    this.name = "FieldPolicyError";
    this.table = detail.table;
    this.field = detail.field;
    ISSUED_FIELD_POLICY_ERRORS.add(this);
    Object.freeze(this);
  }
}

/**
 * Operator-facing explanation for a field-policy denial.
 *
 * Names the table, the offending field, and the configuration key that would
 * grant it, so a denial is fixable without reading source. Two deliberate
 * limits:
 *
 * - Field *values* never appear -- only names the caller itself supplied.
 * - A `sensitive_field` denial names nothing. The field name *is* the signal
 *   there, so echoing it both reflects caller input into a response and hands
 *   back an oracle for the sensitive-name blocklist. That case is not operator-
 *   actionable anyway: a sensitive name cannot be granted by configuration.
 *
 * Every message keeps the phrase "denied by policy" so callers that classify
 * denials on that substring keep working.
 */
export function fieldPolicyDenialMessage(error: FieldPolicyError): string {
  const { table, field } = error;
  switch (error.reason) {
    case "non_writable_field":
      return table && field
        ? `Write denied by policy: field "${field}" is not writable on "${table}" under the ` +
            `configured field policy. Add it to fieldPolicy.${table}.writable to allow this write.`
        : "Write denied by policy: a field in the payload is not writable under the configured field policy.";
    case "unreadable_field":
      return table && field
        ? `Read denied by policy: field "${field}" is not readable on "${table}" under the ` +
            `configured field policy. Add it to fieldPolicy.${table}.readable to allow this read.`
        : "Read denied by policy: a requested field is not readable under the configured field policy.";
    case "unsupported_table":
      return table
        ? `Access denied by policy: table "${table}" has no field policy entry. Add ` +
            `fieldPolicy.${table}, or a fieldPolicy."*" fallback, to allow it.`
        : "Access denied by policy: the requested table has no field policy entry.";
    case "sensitive_field":
      return "Access denied by policy: a requested field is denied by name as sensitive and cannot be granted by configuration.";
    case "explicit_field_required":
      // Only sys_class_name or sys_domain reach this case; both are fixed
      // names that passed FIELD_NAME.
      return table && field
        ? `Write denied by policy: field "${field}" on "${table}" changes the record's ` +
            "class or domain, so a writable wildcard never covers it. List it explicitly " +
            `in fieldPolicy.${table}.writable to allow this write.`
        : "Write denied by policy: a class or domain field must be listed explicitly in the writable set.";
    case "unsupported_field_path":
      // The key itself is not echoed: as a whole it did not pass FIELD_NAME.
      return (
        `Write denied by policy: write keys${table ? ` on "${table}"` : ""} must be plain field names. ` +
        "Dot-walked names (such as caller_id.email) and catalog variables (variables.*) " +
        "cannot be written through this tool. To change a dot-walked value, update the " +
        "referenced record itself."
      );
    default:
      return `Access denied by policy (${error.reason}).`;
  }
}

export function isFieldPolicyError(error: unknown): error is FieldPolicyError {
  try {
    return (
      (typeof error !== "object" ||
        error === null ||
        !nodeUtilTypes.isProxy(error)) &&
      error instanceof FieldPolicyError &&
      Object.isFrozen(error) &&
      ISSUED_FIELD_POLICY_ERRORS.has(error)
    );
  } catch {
    return false;
  }
}

/**
 * Snapshot untrusted tool arguments without evaluating accessors. Proxy
 * failures, symbols, exotic prototypes, hidden properties, and excessive key
 * sets are rejected before any argument value is traversed.
 */
export function snapshotPlainDataArguments(
  candidate: unknown
): Record<string, unknown> {
  return copyPlainDataArguments(candidate, false);
}

/** Copy already-snapshotted arguments and replace canonical values safely. */
export function withFieldPolicyArgumentValues(
  args: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  const output = copyPlainDataArguments(args, true);
  const canonicalOverrides = copyPlainDataArguments(overrides, false);
  const keys = argumentOwnKeys(canonicalOverrides, MAX_TOOL_ARGUMENT_OWN_KEYS);
  for (const key of keys) {
    const descriptor = ownDataDescriptor(canonicalOverrides, key);
    if (!descriptor) throw new FieldPolicyError("invalid_argument_shape");
    safeDefineArgument(output, key, descriptor.value);
  }
  return output;
}

/** Resolve a caller selection to a policy-approved field selection. */
export function resolveReadableFields(
  tableCandidate: unknown,
  input: ReadFieldSelectionInput = {}
): FieldSelection {
  const policy = requirePolicy(tableCandidate);
  const canonicalInput = snapshotPlainDataArguments(
    input as Readonly<Record<string, unknown>>
  );
  const responseFormat = normalizeResponseFormat(canonicalInput.responseFormat);
  const requested = canonicalInput.fields;

  if (requested === undefined) {
    return requireNonEmptySelection(
      responseFormat === "detailed" ? readableSelection(policy) : policy.defaults
    );
  }
  if (typeof requested !== "string") {
    throw new FieldPolicyError("invalid_field_selection");
  }
  const trimmed = requested.trim();
  if (trimmed.toLowerCase() === "all") {
    return requireNonEmptySelection(readableSelection(policy));
  }
  if (!trimmed) throw new FieldPolicyError("invalid_field_selection");

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of trimmed.split(",")) {
    const field = normalizeFieldName(candidate);
    if (seen.has(field)) throw new FieldPolicyError("invalid_field_selection");
    if (isSensitiveFieldName(field)) {
      throw new FieldPolicyError("sensitive_field", { table: policy.table });
    }
    if (!fieldSetAllows(policy.readable, policy.allowAnyReadable, field)) {
      throw new FieldPolicyError("unreadable_field", { table: policy.table, field });
    }
    seen.add(field);
    selected.push(field);
  }
  return Object.freeze(selected);
}


/** Validate and clone one Table API write map using the separate write set. */
export function validateWritableFields(
  tableCandidate: unknown,
  payloadCandidate: unknown
): Readonly<Record<string, unknown>> {
  const policy = requirePolicy(tableCandidate);
  if (
    typeof payloadCandidate !== "object" ||
    payloadCandidate === null ||
    nodeUtilTypes.isProxy(payloadCandidate) ||
    Array.isArray(payloadCandidate)
  ) {
    throw new FieldPolicyError("invalid_write_payload");
  }
  assertPlainWriteObject(payloadCandidate);
  const entries = writeOwnDataEntries(payloadCandidate, MAX_FIELD_OBJECT_OWN_KEYS);
  if (entries.length === 0) throw new FieldPolicyError("invalid_write_payload");

  const output: Record<string, unknown> = {};
  const traversal: WriteTraversalState = {
    nodes: 0,
    seen: new WeakSet<object>(),
  };
  for (const [candidate, descriptor] of entries) {
    if (!("value" in descriptor)) {
      throw new FieldPolicyError("invalid_write_payload");
    }
    const field = normalizeWriteFieldName(candidate, policy.table);
    if (Object.hasOwn(output, field)) {
      throw new FieldPolicyError("invalid_write_payload");
    }
    if (isSensitiveFieldName(field)) {
      throw new FieldPolicyError("sensitive_field", { table: policy.table });
    }
    // policy.writable holds only explicitly listed names; it is empty when
    // the writable set is a wildcard.
    if (EXPLICIT_WRITE_FIELDS.has(field) && !policy.writable.includes(field)) {
      throw new FieldPolicyError("explicit_field_required", { table: policy.table, field });
    }
    if (!fieldSetAllows(policy.writable, policy.allowAnyWritable, field)) {
      throw new FieldPolicyError("non_writable_field", { table: policy.table, field });
    }
    safeDefine(
      output,
      field,
      cloneJsonSafeWriteValue(descriptor.value, traversal, 0)
    );
  }
  return Object.freeze(output);
}


/**
 * Attach a non-JSON marker after request-field validation. The symbol survives
 * internal object spreads but can never be serialized into ServiceNow data.
 */
export function prepareReadFieldArguments(
  args: Readonly<Record<string, unknown>>,
  table: string,
  options: {
    readonly exposeFieldsArgument: boolean;
    readonly allReadable?: boolean;
  }
): Record<string, unknown> {
  const canonicalArgs = withFieldPolicyArgumentValues(args);
  const canonicalOptions = snapshotPlainDataArguments(
    options as unknown as Readonly<Record<string, unknown>>
  );
  const readableFields = resolveReadableFields(table, {
    fields: canonicalOptions.allReadable ? "all" : canonicalArgs.fields,
    responseFormat: canonicalArgs.response_format,
  });
  const overrides: Record<string, unknown> = { table };
  if (canonicalOptions.exposeFieldsArgument) {
    safeDefineArgument(
      overrides,
      "fields",
      isAllFieldSelection(readableFields) ? "all" : readableFields.join(",")
    );
  }
  const prepared = withFieldPolicyArgumentValues(canonicalArgs, overrides);
  safeDefineArgument(
    prepared,
    PREPARED_FIELD_ACCESS,
    issuePreparedAccess(canonicalArgs, table, readableFields)
  );
  return prepared;
}

/** Add a validated fixed/derived projection without changing public arguments. */
export function prepareAdditionalReadFieldArguments(
  args: Readonly<Record<string, unknown>>,
  table: string,
  fields: unknown
): Record<string, unknown> {
  const canonicalArgs = withFieldPolicyArgumentValues(args);
  const readableFields = resolveReadableFields(table, { fields });
  const prepared = withFieldPolicyArgumentValues(canonicalArgs);
  safeDefineArgument(
    prepared,
    PREPARED_FIELD_ACCESS,
    issuePreparedAccess(canonicalArgs, table, readableFields)
  );
  return prepared;
}

/**
 * The projection a write returns for one table: the table's readable set, or
 * `sys_id` alone when an operator made the table write-only (`readable: []`).
 * A write is authorized by the writable set; an empty readable set narrows
 * what comes back, it does not turn the write into a denial.
 */
export function resolveWriteResponseFields(
  tableCandidate: unknown
): FieldSelection {
  const selection = readableSelection(requirePolicy(tableCandidate));
  return selection.length === 0 ? WRITE_ONLY_RESPONSE_FIELDS : selection;
}

/** Validate write keys and prepare the corresponding safe response projection. */
export function prepareWriteFieldArguments(
  args: Readonly<Record<string, unknown>>,
  table: string
): Record<string, unknown> {
  const canonicalArgs = withFieldPolicyArgumentValues(args);
  const fields = validateWritableFields(table, canonicalArgs.fields);
  const readableFields = resolveWriteResponseFields(table);
  const prepared = withFieldPolicyArgumentValues(canonicalArgs, { table, fields });
  safeDefineArgument(
    prepared,
    PREPARED_FIELD_ACCESS,
    issuePreparedAccess(canonicalArgs, table, readableFields)
  );
  return prepared;
}

/** Recover only a marker issued by this module for the same canonical table. */
export function preparedReadableFields(
  args: unknown,
  tableCandidate: unknown
): FieldSelection | undefined {
  try {
    if (
      typeof args !== "object" ||
      args === null ||
      nodeUtilTypes.isProxy(args)
    ) {
      return undefined;
    }
    const marker = safeOwnDataValue(args, PREPARED_FIELD_ACCESS);
    if (
      typeof marker !== "object" ||
      marker === null ||
      nodeUtilTypes.isProxy(marker) ||
      !ISSUED_PREPARED_FIELD_ACCESS.has(marker) ||
      !Object.isFrozen(marker)
    ) {
      return undefined;
    }
    const table = normalizeTableName(tableCandidate);
    const entries = safeOwnDataValue(marker, "entries");
    if (!Array.isArray(entries) || !Object.isFrozen(entries)) return undefined;
    const entry = entries.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        Object.isFrozen(candidate) &&
        safeOwnDataValue(candidate, "table") === table
    );
    if (!entry) return undefined;
    const fields = safeOwnDataValue(entry, "readableFields");
    const policy = requirePolicy(table);
    if (!Array.isArray(fields) || !Object.isFrozen(fields)) return undefined;
    if (isAllFieldSelection(fields)) {
      return policy.allowAnyReadable ? ALL_FIELDS_SELECTION : undefined;
    }
    if (
      fields.some(
        (field) =>
          typeof field !== "string" ||
          !fieldSetAllows(policy.readable, policy.allowAnyReadable, field)
      )
    ) {
      return undefined;
    }
    return fields as readonly string[];
  } catch {
    return undefined;
  }
}

/** Keep approved top-level record fields and scrub sensitive nested keys. */
export function filterReadableRecord(
  candidate: unknown,
  readableFields: FieldSelection
): unknown {
  if (nodeUtilTypes.isProxy(readableFields)) return null;
  const state = responseTraversalState();
  if (isAllFieldSelection(readableFields)) {
    return sanitizeNestedValue(candidate, state, 0);
  }
  const approved = new Set(readableFields.map(normalizeFieldName));
  return filterRecordNode(candidate, approved, state, 0);
}

/** Remove metadata entries for fields the caller is not permitted to discover. */
export function filterSchemaEntries(
  candidate: unknown,
  readableFields: FieldSelection
): Array<Record<string, unknown>> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate) ||
    !Array.isArray(candidate)
  ) {
    return [];
  }
  if (nodeUtilTypes.isProxy(readableFields)) return [];
  const allReadable = isAllFieldSelection(readableFields);
  const approved = allReadable ? undefined : new Set(readableFields.map(normalizeFieldName));
  const output: Array<Record<string, unknown>> = [];
  const state = responseTraversalState();
  const view = responseArrayView(candidate);
  if (!view) return output;
  for (let index = 0; index < view.length; index += 1) {
    const key = String(index);
    if (!view.presentKeys.has(key)) continue;
    const entryDescriptor = ownDataDescriptor(candidate, key);
    const entry = entryDescriptor?.value;
    if (
      typeof entry !== "object" ||
      entry === null ||
      nodeUtilTypes.isProxy(entry) ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const keys = responseOwnKeys(entry, MAX_FIELD_OBJECT_OWN_KEYS);
    if (!keys?.includes("element")) continue;
    const rawField = safeOwnDataValue(entry, "element");
    let field: string;
    try {
      field = normalizeFieldName(rawField);
    } catch {
      continue;
    }
    // A wildcard readable set leaves `approved` undefined; the sensitive-name
    // check is then the only thing keeping user_password and its siblings out
    // of schema metadata.
    if ((approved && !approved.has(field)) || isSensitiveFieldName(field)) continue;
    const sanitized = sanitizeNestedValue(entry, state, 1);
    if (
      typeof sanitized !== "object" ||
      sanitized === null ||
      Array.isArray(sanitized)
    ) {
      continue;
    }
    output.push(sanitized as Record<string, unknown>);
  }
  return output;
}

/** Filter the documented Stats API envelope and approved aggregate fields. */
export function filterAggregateResult(
  candidate: unknown,
  readableFields: FieldSelection
): unknown {
  if (nodeUtilTypes.isProxy(readableFields)) return null;
  const state = responseTraversalState();
  if (isAllFieldSelection(readableFields)) {
    return sanitizeNestedValue(candidate, state, 0);
  }
  const approved = new Set(readableFields.map(normalizeFieldName));
  return filterAggregateNode(candidate, approved, state, 0);
}



export function runWithFieldPolicyConfiguration<T>(
  configuration: FieldPolicyConfigurationInput | undefined,
  callback: () => T
): T {
  return FIELD_POLICY_CONFIGURATION_SCOPE.run(configuration ?? Object.freeze({}), callback);
}

/** True when a field selection means ServiceNow should return all fields. */
export function isAllFieldSelection(selection: readonly string[]): boolean {
  return selection.length === 1 && selection[0] === FIELD_POLICY_WILDCARD;
}

/** Convert a policy selection into a Table API sysparm_fields value. */
export function fieldSelectionToSysparmFields(
  selection: readonly string[]
): string | undefined {
  return isAllFieldSelection(selection) ? undefined : selection.join(",");
}

/** Sensitive names are denied even if accidentally added to a table policy. */
export function isSensitiveFieldName(candidate: unknown): boolean {
  if (typeof candidate !== "string") return true;
  const normalized = candidate.trim().toLowerCase();
  if (!FIELD_NAME.test(normalized)) return true;
  return (
    /(?:^|_)(?:password|passwd|credential|credentials|secret|token|api_key|private_key|encryption_key|ssn)(?:_|$)/u.test(
      normalized
    ) ||
    normalized === "social_security_number"
  );
}

function requirePolicy(tableCandidate: unknown): TableFieldPolicy {
  const table = normalizeTableName(tableCandidate);
  const policies = currentTableFieldPolicies();
  const policy = policies.get(table);
  if (policy) return policy;
  const fallback = policies.get(FIELD_POLICY_WILDCARD);
  if (!fallback) throw new FieldPolicyError("unsupported_table", { table });
  return Object.freeze({ ...fallback, table });
}

function fieldSetAllows(
  fields: readonly string[],
  allowAny: boolean,
  field: string
): boolean {
  return allowAny || fields.includes(field);
}

function currentTableFieldPolicies(): ReadonlyMap<string, TableFieldPolicy> {
  const configured = readConfiguredFieldPolicyDefinitions();
  if (!configured) return BUILT_IN_TABLE_FIELD_POLICIES;
  // Configuration narrows the base; it is the only thing that denies a field.
  return buildFieldPolicyMap(
    mergeFieldPolicyDefinitions(FIELD_POLICY_BASE, configured.definitions)
  );
}

function mergeFieldPolicyDefinitions(
  base: Readonly<Record<string, TableFieldPolicyDefinition>>,
  configured: Readonly<Record<string, MutableTableFieldPolicyDefinition>>
): Record<string, TableFieldPolicyDefinition> {
  const merged: Record<string, TableFieldPolicyDefinition> = { ...base };
  // A profile's "*" entry also covers the ITSM tables it does not name, so
  // they are merged even without an entry of their own.
  const profileWildcard = Object.hasOwn(configured, FIELD_POLICY_WILDCARD)
    ? configured[FIELD_POLICY_WILDCARD]
    : undefined;
  const tables = new Set(Object.keys(configured));
  if (profileWildcard !== undefined) {
    for (const table of ITSM_TABLES) tables.add(table);
  }
  for (const table of tables) {
    const definition: MutableTableFieldPolicyDefinition = Object.hasOwn(configured, table)
      ? configured[table]!
      : {};
    const existing = merged[table];
    // Every table but the system tables (ITSM and custom alike) resolves each
    // set from its own entry, then the profile's "*" entry, then the base. A
    // named custom table therefore cannot escape a narrowing "*" by stating
    // only the other key. System tables never take the "*" entry.
    const fallback =
      table === FIELD_POLICY_WILDCARD || SYSTEM_TABLES.has(table)
        ? undefined
        : profileWildcard;
    const readable = definition.readable ?? fallback?.readable;
    merged[table] = {
      defaults:
        definition.defaults ??
        (existing === undefined && definition.readable === undefined
          ? // A named custom table that leaves readable to the "*" entry
            // projects what an unnamed table does: the "*" entry's defaults,
            // else sys_id, clamped. Inheriting the whole "*" readable list
            // made a concise read ask for every readable column.
            clampedDefaults(fallback?.defaults ?? GENERIC_DEFAULT_FIELDS, readable)
          : // Built-in defaults are clamped to the effective readable set, so
            // a narrowed "*" never leaves a default the table may not read.
            // sys_id leads every built-in list and stays whenever readable.
            inheritedDefaults(existing?.defaults, readable)),
      // An entry that states only `defaults` reads exactly those fields.
      readable: readable ?? existing?.readable ?? definition.defaults,
      // Omission no longer denies. An operator who states nothing about
      // writes has not asked for a restriction, and tableAccess already
      // decided whether this table is reachable at all.
      writable: definition.writable ?? fallback?.writable ?? existing?.writable,
    };
  }
  return merged;
}

/**
 * Clamp a default projection to a readable set, the way the "*" entry's own
 * defaults are clamped for an unnamed table: keep the defaults the set
 * allows, and fall back to the set itself only when none survive.
 */
function clampedDefaults(
  defaults: FieldPolicySet,
  readable: FieldPolicySet | undefined
): FieldPolicySet {
  if (readable === undefined || readable === FIELD_POLICY_WILDCARD) return defaults;
  if (defaults === FIELD_POLICY_WILDCARD) return readable;
  const allowed = new Set(readable);
  const permitted = defaults.filter((field) => allowed.has(field));
  return permitted.length > 0 ? permitted : readable;
}

/**
 * Carry inherited defaults across a configured `readable` replacement.
 *
 * Inheriting them wholesale lets a narrowing override keep defaults the new
 * readable set no longer permits, which the consistency check in
 * buildFieldPolicyMap then rejects on every request.
 */
function inheritedDefaults(
  existingDefaults: FieldPolicySet | undefined,
  configuredReadable: FieldPolicySet | undefined
): FieldPolicySet | undefined {
  if (configuredReadable === undefined) return existingDefaults;
  if (configuredReadable === FIELD_POLICY_WILDCARD) {
    // Widening what may be read says nothing about what to return by default.
    // Keep the inherited projection; where there is none, fall through to the
    // bounded generic default rather than manufacturing a wildcard.
    return existingDefaults === FIELD_POLICY_WILDCARD ? undefined : existingDefaults;
  }
  if (existingDefaults === undefined || existingDefaults === FIELD_POLICY_WILDCARD) {
    return configuredReadable;
  }
  const permitted = existingDefaults.filter((field) =>
    configuredReadable.includes(field)
  );
  return permitted.length > 0 ? permitted : configuredReadable;
}

/**
 * @param root Configuration key the definitions came from. Given only while a
 * configuration is validated at load, so a contradiction names its table.
 */
function buildFieldPolicyMap(
  definitions: Readonly<Record<string, TableFieldPolicyDefinition>>,
  root?: string
): ReadonlyMap<string, TableFieldPolicy> {
  return new Map<string, TableFieldPolicy>(
    Object.entries(definitions).map(([tableCandidate, definition]) => {
      const table = normalizePolicyTableName(tableCandidate);
      // An unstated set is open. Only an explicit operator list narrows.
      const readable = normalizePolicyFieldSet(
        definition.readable ?? FIELD_POLICY_WILDCARD
      );
      const writable = normalizePolicyFieldSet(
        definition.writable ?? FIELD_POLICY_WILDCARD
      );
      const defaultsCandidate = normalizePolicyFieldSet(
        definition.defaults ??
          (readable === FIELD_POLICY_WILDCARD ? GENERIC_DEFAULT_FIELDS : readable)
      );
      const defaults = defaultsCandidate === FIELD_POLICY_WILDCARD ? ALL_FIELDS_SELECTION : defaultsCandidate;
      const readableFields = readable === FIELD_POLICY_WILDCARD ? [] : readable;
      const writableFields = writable === FIELD_POLICY_WILDCARD ? [] : writable;
      if (isAllFieldSelection(defaults)) {
        // "Return every column by default" contradicts a narrowed readable
        // set: a concise read would ask ServiceNow for every field.
        if (readable !== FIELD_POLICY_WILDCARD) {
          rejectConfiguration(
            root === undefined ? undefined : { key: `${root}.${table}.defaults` },
            `is "*" (every field), which ${root}.${table}.readable does not allow. ` +
              'List the default fields, or make readable "*".'
          );
        }
      } else {
        for (const field of defaults) {
          if (!fieldSetAllows(readableFields, readable === FIELD_POLICY_WILDCARD, field)) {
            // Branded so a contradictory operator policy is classified as a
            // policy denial instead of escaping the request path as a raw
            // TypeError.
            rejectConfiguration(
              root === undefined ? undefined : { key: `${root}.${table}.defaults` },
              `lists "${field}", which ${root}.${table}.readable does not allow.`
            );
          }
        }
      }
      return [
        table,
        Object.freeze({
          table,
          defaults,
          readable: readableFields,
          writable: writableFields,
          allowAnyReadable: readable === FIELD_POLICY_WILDCARD,
          allowAnyWritable: writable === FIELD_POLICY_WILDCARD,
        }),
      ];
    })
  );
}

function readConfiguredFieldPolicyDefinitions():
  | FieldPolicyConfiguration
  | undefined {
  // Only the profile scope configures field policy. SN_FIELD_POLICY_DEFINITIONS
  // reaches this point solely as the SN_PROFILE_NAME environment profile's
  // own keys (profile-manager.ts), never as a process-wide fallback.
  const scoped = FIELD_POLICY_CONFIGURATION_SCOPE.getStore();
  if (scoped && (scoped.fieldPolicy !== undefined || scoped.readableTableFields !== undefined || scoped.writableTableFields !== undefined)) {
    return normalizeConfiguredFieldPolicy(scoped);
  }
  return undefined;
}

/**
 * A malformed field-policy configuration, raised when a profile is loaded.
 *
 * The message names the key path to fix, and with it the table. It never
 * repeats a configured value that failed validation; a table or field name
 * appears only once it has passed FIELD_NAME.
 */
export class FieldPolicyConfigurationError extends Error {
  public override readonly name = "FieldPolicyConfigurationError";
}

/** Labels for the three configuration keys, as the operator wrote them. */
interface ConfigurationLabels {
  readonly fieldPolicy: string;
  readonly readableTableFields: string;
  readonly writableTableFields: string;
}

const PROFILE_CONFIGURATION_LABELS: ConfigurationLabels = Object.freeze({
  fieldPolicy: "fieldPolicy",
  readableTableFields: "readableTableFields",
  writableTableFields: "writableTableFields",
});

/**
 * Reject a malformed profile field policy at load instead of on every request.
 *
 * The request path normalizes the same configuration on each call and fails
 * closed, so a malformed entry used to deny every call on the profile, reads
 * included, with an opaque reason. This runs the same normalizers with a key
 * path attached and throws FieldPolicyConfigurationError naming the table and
 * key. A configuration that passes cannot fail normalization on a request.
 *
 * Beyond malformed names and shapes, it rejects what used to load and then
 * silently fail open: `fieldPolicy` stated beside a table list (the request
 * path applied only the lists), unknown keys in a table or list entry (a
 * `writeable` typo narrowed nothing), table keys that differ only in case,
 * and a table repeated within one list (the last entry won).
 */
export function validateFieldPolicyConfiguration(
  input: FieldPolicyConfigurationInput
): void {
  validateConfiguration(input, PROFILE_CONFIGURATION_LABELS);
}

/**
 * Map SN_FIELD_POLICY_DEFINITIONS onto the field-policy keys of the
 * SN_PROFILE_NAME environment profile. The caller passes the environment:
 * this module never reads process.env, so the variable cannot reach a
 * file-backed profile.
 *
 * The value is either a table map (`{"incident":{...}}`) or an object holding
 * the profile keys themselves (`fieldPolicy`, `readableTableFields`,
 * `writableTableFields`); both keep their previous meaning. A value that
 * mixes the two is rejected: the table keys used to be dropped silently.
 */
export function fieldPolicyInputFromEnvironment(
  environment: FieldPolicyEnvironment
): FieldPolicyConfigurationInput {
  const text = environment.SN_FIELD_POLICY_DEFINITIONS;
  if (text === undefined || text.trim() === "") return Object.freeze({});
  if (text.length > MAX_FIELD_POLICY_DEFINITIONS_TEXT_LENGTH) {
    throw new FieldPolicyConfigurationError(
      `${FIELD_POLICY_DEFINITIONS_ENV} exceeds ${MAX_FIELD_POLICY_DEFINITIONS_TEXT_LENGTH} characters.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FieldPolicyConfigurationError(
      `${FIELD_POLICY_DEFINITIONS_ENV} is not valid JSON.`
    );
  }
  if (!isPlainRecordCandidate(parsed)) {
    throw new FieldPolicyConfigurationError(
      `${FIELD_POLICY_DEFINITIONS_ENV} must be a JSON object.`
    );
  }
  const record = definedOwnProperties(parsed as Record<string, unknown>);
  const stated = FIELD_POLICY_CONFIGURATION_KEYS.filter((key) =>
    Object.hasOwn(record, key)
  );
  if (stated.length > 0 && Object.keys(record).length > stated.length) {
    // The other keys are table names; they are not repeated here.
    throw new FieldPolicyConfigurationError(
      `${FIELD_POLICY_DEFINITIONS_ENV} mixes table keys with the profile keys ` +
        `${stated.join(", ")}. Use either a table map or the profile keys ` +
        `(${FIELD_POLICY_CONFIGURATION_KEYS.join(", ")}), not both.`
    );
  }
  const input: FieldPolicyConfigurationInput =
    stated.length > 0
      ? Object.freeze(Object.fromEntries(stated.map((key) => [key, record[key]])))
      : Object.freeze({ fieldPolicy: record });
  validateConfiguration(
    input,
    stated.length > 0
      ? {
          fieldPolicy: `${FIELD_POLICY_DEFINITIONS_ENV}.fieldPolicy`,
          readableTableFields: `${FIELD_POLICY_DEFINITIONS_ENV}.readableTableFields`,
          writableTableFields: `${FIELD_POLICY_DEFINITIONS_ENV}.writableTableFields`,
        }
      : {
          ...PROFILE_CONFIGURATION_LABELS,
          fieldPolicy: FIELD_POLICY_DEFINITIONS_ENV,
        }
  );
  return input;
}

function validateConfiguration(
  input: unknown,
  labels: ConfigurationLabels
): void {
  if (!isPlainRecordCandidate(input)) {
    throw new FieldPolicyConfigurationError(
      "Field policy configuration must be an object."
    );
  }
  const record = definedOwnProperties(input as Record<string, unknown>);
  const statedLists = TABLE_FIELD_LIST_KEYS.filter((key) => Object.hasOwn(record, key));
  if (Object.hasOwn(record, "fieldPolicy") && statedLists.length > 0) {
    // The request path applied only the lists and dropped every narrowing in
    // fieldPolicy. There is no unambiguous merge, so the two forms exclude
    // each other.
    throw new FieldPolicyConfigurationError(
      `${labels.fieldPolicy} cannot be combined with ` +
        `${statedLists.map((key) => labels[key]).join(" and ")}. State the field ` +
        "policy in one form: fieldPolicy alone, or readableTableFields and " +
        "writableTableFields without fieldPolicy."
    );
  }
  try {
    // The same normalizers the request path runs, with key paths attached.
    if (Object.hasOwn(record, "fieldPolicy")) {
      buildFieldPolicyMap(
        mergeFieldPolicyDefinitions(
          FIELD_POLICY_BASE,
          fieldPolicyDefinitions(record.fieldPolicy, labels.fieldPolicy)
        ),
        labels.fieldPolicy
      );
    } else {
      buildFieldPolicyMap(
        mergeFieldPolicyDefinitions(
          FIELD_POLICY_BASE,
          tableFieldListDefinitions(record, labels)
        )
      );
    }
  } catch (error) {
    if (error instanceof FieldPolicyConfigurationError) throw error;
    if (isFieldPolicyError(error)) {
      throw new FieldPolicyConfigurationError(
        `Field policy configuration is invalid (${error.reason}).`
      );
    }
    throw error;
  }
}

/**
 * Where in an operator's configuration a normalizer is reading. Present only
 * while a configuration is validated at load, so the operator is told which
 * table and key to fix. Absent on the request path, where a malformed policy
 * stays a branded denial that carries no configuration content.
 */
interface ConfigurationLocation {
  /** Key path as the operator wrote it, such as `fieldPolicy.incident.writable`. */
  readonly key: string;
  /** Table of a list entry whose key path does not already name it. */
  readonly table?: string;
}

function configurationLocation(
  key: string | undefined,
  table?: string
): ConfigurationLocation | undefined {
  if (key === undefined) return undefined;
  return table === undefined ? { key } : { key, table };
}

function rejectConfiguration(
  location: ConfigurationLocation | undefined,
  problem: string,
  entry = ""
): never {
  if (location === undefined) throw new FieldPolicyError("invalid_argument_shape");
  const table = location.table === undefined ? "" : ` (table "${location.table}")`;
  throw new FieldPolicyConfigurationError(
    `${location.key}${entry}${table} ${problem}`
  );
}

function normalizeConfiguredFieldPolicy(
  parsed: unknown
): FieldPolicyConfiguration | undefined {
  if (!isPlainRecordCandidate(parsed)) {
    throw new FieldPolicyError("invalid_argument_shape");
  }
  const outerRecord = definedOwnProperties(parsed as Record<string, unknown>);
  if (TABLE_FIELD_LIST_KEYS.some((key) => Object.hasOwn(outerRecord, key))) {
    // Profile load rejects this combination. A scope that skipped the load
    // fails closed rather than applying one form and dropping the other.
    if (Object.hasOwn(outerRecord, "fieldPolicy")) {
      throw new FieldPolicyError("invalid_argument_shape");
    }
    return Object.freeze({ definitions: tableFieldListDefinitions(outerRecord) });
  }
  if (outerRecord.fieldPolicy === undefined) return undefined;
  return Object.freeze({
    definitions: fieldPolicyDefinitions(outerRecord.fieldPolicy),
  });
}

/**
 * Normalize a `fieldPolicy` table map.
 *
 * @param root Configuration key the map came from; given only at load.
 */
function fieldPolicyDefinitions(
  source: unknown,
  root?: string
): Record<string, MutableTableFieldPolicyDefinition> {
  if (!isPlainRecordCandidate(source)) {
    rejectConfiguration(
      configurationLocation(root),
      "must be an object that maps table names to { defaults, readable, writable }."
    );
  }
  const record = source as Record<string, unknown>;
  const definitions: Record<string, MutableTableFieldPolicyDefinition> = {};
  const firstPosition = new Map<string, number>();
  const keys = Object.keys(record);
  for (let position = 0; position < keys.length; position += 1) {
    const key = keys[position]!;
    const keyLocation = configurationLocation(
      root === undefined ? undefined : `${root} key ${position + 1}`
    );
    const table = normalizePolicyTableName(key, keyLocation);
    // Table names are case-insensitive, so "INCIDENT" and "incident" are one
    // table, and the later entry used to replace the earlier one silently.
    const earlier = firstPosition.get(table);
    if (earlier !== undefined) {
      rejectConfiguration(
        keyLocation,
        `names table "${table}" again (table names are case-insensitive); ` +
          `it repeats key ${earlier + 1}. State each table once.`
      );
    }
    firstPosition.set(table, position);
    const path = root === undefined ? undefined : `${root}.${table}`;
    const value = record[key];
    if (!isPlainRecordCandidate(value)) {
      rejectConfiguration(
        configurationLocation(path),
        "must be an object with defaults, readable, or writable."
      );
    }
    const candidate = definedOwnProperties(value as Record<string, unknown>);
    rejectUnknownKeys(
      candidate,
      TABLE_ENTRY_KEYS,
      configurationLocation(path),
      "A table entry accepts only defaults, readable, and writable."
    );
    const definition: Record<string, FieldPolicySet> = {};
    for (const kind of TABLE_ENTRY_KEYS) {
      if (Object.hasOwn(candidate, kind)) {
        definition[kind] = normalizePolicyFieldSet(
          candidate[kind] as FieldPolicySet,
          configurationLocation(path === undefined ? undefined : `${path}.${kind}`)
        );
      }
    }
    definitions[table] = Object.freeze(definition) as MutableTableFieldPolicyDefinition;
  }
  return definitions;
}

/**
 * Reject a key outside `allowed`. An unknown key used to be ignored, so a
 * typo such as `writeable` loaded and narrowed nothing. The key is named only
 * when it is a valid identifier; anything else is identified by position.
 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  location: ConfigurationLocation | undefined,
  accepted: string
): void {
  const keys = Object.keys(record);
  for (let position = 0; position < keys.length; position += 1) {
    const key = keys[position]!;
    if (allowed.includes(key)) continue;
    rejectConfiguration(
      location,
      `has an unknown key ${FIELD_NAME.test(key) ? `"${key}"` : `at position ${position + 1}`}. ${accepted}`
    );
  }
}

/**
 * Normalize the `readableTableFields` / `writableTableFields` form.
 *
 * @param labels Configuration keys the lists came from; given only at load.
 */
function tableFieldListDefinitions(
  record: Record<string, unknown>,
  labels?: ConfigurationLabels
): Record<string, MutableTableFieldPolicyDefinition> {
  const definitions: Record<string, MutableTableFieldPolicyDefinition> = {};
  applyTableFieldList(definitions, record.readableTableFields, "readable", labels?.readableTableFields);
  applyTableFieldList(definitions, record.writableTableFields, "writable", labels?.writableTableFields);
  return definitions;
}

function isPlainRecordCandidate(candidate: unknown): boolean {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    !nodeUtilTypes.isProxy(candidate)
  );
}

/**
 * Drop own keys whose value is `undefined`.
 *
 * Policy shape is selected by key presence, and a key materialized with an
 * `undefined` value is indistinguishable from a stated one to Object.hasOwn.
 * Normalizing here keeps an object built with optional keys spread in
 * identical to one that never carried the key at all, so the same policy
 * cannot mean different things depending on how the caller constructed it.
 */
function definedOwnProperties(
  record: Record<string, unknown>
): Record<string, unknown> {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}

/**
 * @param root Configuration key the list came from; given only at load.
 */
function applyTableFieldList(
  definitions: Record<string, MutableTableFieldPolicyDefinition>,
  candidate: unknown,
  kind: "readable" | "writable",
  root?: string
): void {
  if (candidate === undefined) return;
  if (!Array.isArray(candidate) || nodeUtilTypes.isProxy(candidate)) {
    rejectConfiguration(
      configurationLocation(root),
      "must be a list of { table, fields } entries."
    );
  }
  // A table may appear in both lists, but only once in each: a repeated
  // entry used to replace the earlier one, so the last entry won.
  const firstIndex = new Map<string, number>();
  for (let index = 0; index < candidate.length; index += 1) {
    const path = root === undefined ? undefined : `${root}[${index}]`;
    const normalized = normalizeTableFieldListDefinition(candidate[index], path);
    const earlier = firstIndex.get(normalized.table);
    if (earlier !== undefined) {
      rejectConfiguration(
        configurationLocation(path, normalized.table),
        `repeats a table already listed at ${root}[${earlier}]. List each table once.`
      );
    }
    firstIndex.set(normalized.table, index);
    const previous = definitions[normalized.table] ?? {};
    definitions[normalized.table] = Object.freeze({
      ...previous,
      [kind]: normalized.fields,
    }) as MutableTableFieldPolicyDefinition;
  }
}

function normalizeTableFieldListDefinition(
  candidate: unknown,
  path?: string
): TableFieldListDefinition {
  if (!isPlainRecordCandidate(candidate)) {
    rejectConfiguration(
      configurationLocation(path),
      "must be an object with table and fields."
    );
  }
  const record = candidate as Record<string, unknown>;
  const table = normalizePolicyTableName(
    record.table,
    configurationLocation(path === undefined ? undefined : `${path}.table`)
  );
  rejectUnknownKeys(
    definedOwnProperties(record),
    LIST_ENTRY_KEYS,
    configurationLocation(path, table),
    "A list entry accepts only table and fields."
  );
  const fields = normalizePolicyFieldSet(
    record.fields as FieldPolicySet,
    configurationLocation(path === undefined ? undefined : `${path}.fields`, table)
  );
  return Object.freeze({ table, fields });
}

function readableSelection(policy: TableFieldPolicy): FieldSelection {
  return policy.allowAnyReadable ? ALL_FIELDS_SELECTION : policy.readable;
}

/**
 * A table policy granting no readable field denies the read outright. An
 * empty selection would otherwise serialize to an empty sysparm_fields, which
 * ServiceNow reads as "every field".
 */
function requireNonEmptySelection(selection: FieldSelection): FieldSelection {
  if (selection.length === 0) throw new FieldPolicyError("unreadable_field");
  return selection;
}


function normalizePolicyTableName(
  candidate: unknown,
  location?: ConfigurationLocation
): string {
  if (candidate === FIELD_POLICY_WILDCARD) return FIELD_POLICY_WILDCARD;
  try {
    return normalizeTableName(candidate);
  } catch (error) {
    if (location === undefined) throw error;
    rejectConfiguration(
      location,
      `is not a valid table name. Use a table name (${FIELD_NAME_RULE}) or "*".`
    );
  }
}

function normalizeTableName(candidate: unknown): string {
  if (typeof candidate !== "string") {
    throw new FieldPolicyError("unsupported_table");
  }
  const normalized = candidate.trim().toLowerCase();
  if (!FIELD_NAME.test(normalized)) {
    throw new FieldPolicyError("unsupported_table");
  }
  return normalized;
}

function normalizeFieldName(candidate: unknown): string {
  if (typeof candidate !== "string") {
    throw new FieldPolicyError("invalid_field_selection");
  }
  const normalized = candidate.trim().toLowerCase();
  if (!FIELD_NAME.test(normalized)) {
    throw new FieldPolicyError("invalid_field_selection");
  }
  return normalized;
}

/** Longest dotted write key inspected for a specific denial message. */
const MAX_FIELD_PATH_LENGTH = 1_024;

/**
 * Normalize one write key. A dotted key whose every segment is a field name,
 * such as the dot-walk caller_id.email or variables.requested_for, is still
 * denied: Table API write support for those names is unverified. It gets its
 * own reason so the denial says why instead of reading as a malformed name.
 */
function normalizeWriteFieldName(candidate: unknown, table: string): string {
  try {
    return normalizeFieldName(candidate);
  } catch (error) {
    if (isFieldPath(candidate)) {
      throw new FieldPolicyError("unsupported_field_path", { table });
    }
    throw error;
  }
}

function isFieldPath(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length > MAX_FIELD_PATH_LENGTH) {
    return false;
  }
  const segments = candidate.trim().toLowerCase().split(".");
  return segments.length > 1 && segments.every((segment) => FIELD_NAME.test(segment));
}

function normalizeResponseFormat(candidate: unknown): ResponseFormat {
  if (candidate === undefined || candidate === "concise") return "concise";
  if (candidate === "detailed") return "detailed";
  throw new FieldPolicyError("invalid_field_selection");
}

function normalizePolicyFieldSet(
  candidates: FieldPolicySet,
  location?: ConfigurationLocation
): readonly string[] | "*" {
  if (candidates === FIELD_POLICY_WILDCARD || isWildcardFieldList(candidates)) {
    return FIELD_POLICY_WILDCARD;
  }
  return normalizePolicyFields(candidates, location);
}

/**
 * `["*"]` is how `tableAccess.writeTables` spells "everything", so an operator
 * writes it here too. It means exactly what the string `"*"` means.
 */
function isWildcardFieldList(candidate: unknown): boolean {
  return (
    Array.isArray(candidate) &&
    !nodeUtilTypes.isProxy(candidate) &&
    candidate.length === 1 &&
    candidate[0] === FIELD_POLICY_WILDCARD
  );
}

function normalizePolicyFields(
  candidates: readonly string[],
  location?: ConfigurationLocation
): readonly string[] {
  // Operator policy is normalized on the request path, so a malformed set
  // must surface as a branded policy denial rather than a raw TypeError.
  if (!Array.isArray(candidates) || nodeUtilTypes.isProxy(candidates)) {
    rejectConfiguration(location, 'must be "*" or a list of field names.');
  }
  const fields: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    let field: string;
    try {
      field = normalizeFieldName(candidates[index]);
    } catch (error) {
      if (location === undefined) throw error;
      rejectConfiguration(
        location,
        `is not a field name. List exact field names (${FIELD_NAME_RULE}), or use "*" ` +
          'on its own for every field; patterns such as "u_*" are not supported.',
        `[${index}]`
      );
    }
    if (seen.has(field)) {
      rejectConfiguration(location, `repeats the field "${field}".`, `[${index}]`);
    }
    seen.add(field);
    fields.push(field);
  }
  return Object.freeze(fields);
}

function issuePreparedAccess(
  args: Readonly<Record<string, unknown>>,
  table: string,
  readableFields: FieldSelection
): PreparedFieldAccess {
  const normalizedTable = normalizeTableName(table);
  const previous = issuedPreparedEntries(args).filter(
    (entry) => entry.table !== normalizedTable
  );
  const entry = Object.freeze({
    table: normalizedTable,
    readableFields:
      isAllFieldSelection(readableFields)
        ? ALL_FIELDS_SELECTION
        : Object.freeze([...readableFields]),
  });
  const marker = Object.freeze({
    entries: Object.freeze([...previous, entry]),
  });
  ISSUED_PREPARED_FIELD_ACCESS.add(marker);
  return marker;
}

interface WriteTraversalState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

interface ResponseTraversalState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

const AGGREGATE_ENVELOPE_FIELDS = new Set([
  "stats",
  "groupby_fields",
  "field",
  "value",
  "display_value",
  "count",
  "avg",
  "min",
  "max",
  "sum",
]);

function issuedPreparedEntries(
  args: Readonly<Record<string, unknown>>
): PreparedFieldAccess["entries"] {
  try {
    const marker = safeOwnDataValue(args, PREPARED_FIELD_ACCESS);
    if (
      typeof marker !== "object" ||
      marker === null ||
      nodeUtilTypes.isProxy(marker) ||
      !ISSUED_PREPARED_FIELD_ACCESS.has(marker) ||
      !Object.isFrozen(marker)
    ) {
      return [];
    }
    const entries = safeOwnDataValue(marker, "entries");
    return Array.isArray(entries) && Object.isFrozen(entries)
      ? (entries as PreparedFieldAccess["entries"])
      : [];
  } catch {
    return [];
  }
}

function copyPlainDataArguments(
  candidate: unknown,
  allowPreparedMarker: boolean
): Record<string, unknown> {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate) ||
    Array.isArray(candidate)
  ) {
    throw new FieldPolicyError("invalid_argument_shape");
  }
  try {
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new FieldPolicyError("invalid_argument_shape");
    }
  } catch (error) {
    if (isFieldPolicyError(error)) throw error;
    throw new FieldPolicyError("invalid_argument_shape");
  }

  const keys = argumentOwnKeys(
    candidate,
    MAX_TOOL_ARGUMENT_OWN_KEYS +
      (allowPreparedMarker ? MAX_CANONICAL_ARGUMENT_KEYS + 1 : 0)
  );
  const carriesPreparedMarker = keys.includes(PREPARED_FIELD_ACCESS);
  if (
    keys.length > MAX_TOOL_ARGUMENT_OWN_KEYS &&
    (!allowPreparedMarker || !carriesPreparedMarker)
  ) {
    throw new FieldPolicyError("invalid_argument_shape");
  }
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key === "symbol") {
      if (key !== PREPARED_FIELD_ACCESS || !allowPreparedMarker) {
        throw new FieldPolicyError("invalid_argument_shape");
      }
      const descriptor = ownDataDescriptor(candidate, key);
      if (
        !descriptor ||
        typeof descriptor.value !== "object" ||
        descriptor.value === null ||
        !ISSUED_PREPARED_FIELD_ACCESS.has(descriptor.value)
      ) {
        throw new FieldPolicyError("invalid_argument_shape");
      }
      safeDefineArgument(output, key, descriptor.value);
      continue;
    }
    const descriptor = ownDataDescriptor(candidate, key);
    if (!descriptor || !descriptor.enumerable) {
      throw new FieldPolicyError("invalid_argument_shape");
    }
    safeDefineArgument(output, key, descriptor.value);
  }
  return output;
}

function argumentOwnKeys(candidate: object, maximum: number): PropertyKey[] {
  try {
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > maximum) {
      throw new FieldPolicyError("invalid_argument_shape");
    }
    return keys;
  } catch (error) {
    if (isFieldPolicyError(error)) throw error;
    throw new FieldPolicyError("invalid_argument_shape");
  }
}

function ownDataDescriptor(
  candidate: object,
  key: PropertyKey
): (PropertyDescriptor & { value: unknown }) | undefined {
  if (nodeUtilTypes.isProxy(candidate)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor && "value" in descriptor
      ? (descriptor as PropertyDescriptor & { value: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

function safeDefineArgument(
  target: Record<string, unknown>,
  key: PropertyKey,
  value: unknown
): void {
  try {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } catch {
    throw new FieldPolicyError("invalid_argument_shape");
  }
}

function assertPlainWriteObject(candidate: object): void {
  if (nodeUtilTypes.isProxy(candidate)) {
    throw new FieldPolicyError("invalid_write_payload");
  }
  try {
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new FieldPolicyError("invalid_write_payload");
    }
  } catch (error) {
    if (isFieldPolicyError(error)) throw error;
    throw new FieldPolicyError("invalid_write_payload");
  }
}

function writeOwnKeys(candidate: object, maximum: number): PropertyKey[] {
  if (nodeUtilTypes.isProxy(candidate)) {
    throw new FieldPolicyError("invalid_write_payload");
  }
  try {
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > maximum) {
      throw new FieldPolicyError("traversal_limit_exceeded");
    }
    return keys;
  } catch (error) {
    if (isFieldPolicyError(error)) throw error;
    throw new FieldPolicyError("invalid_write_payload");
  }
}

function writeOwnDataEntries(
  candidate: object,
  maximum: number
): Array<[string, PropertyDescriptor & { value: unknown }]> {
  const keys = writeOwnKeys(candidate, maximum);
  const entries: Array<[string, PropertyDescriptor & { value: unknown }]> = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new FieldPolicyError("invalid_write_payload");
    }
    const descriptor = ownDataDescriptor(candidate, key);
    if (!descriptor || !descriptor.enumerable) {
      throw new FieldPolicyError("invalid_write_payload");
    }
    entries.push([key, descriptor]);
  }
  return entries;
}

function cloneJsonSafeWriteValue(
  candidate: unknown,
  state: WriteTraversalState,
  depth: number
): unknown {
  state.nodes += 1;
  if (depth > MAX_FIELD_VALUE_DEPTH || state.nodes > MAX_FIELD_VALUE_NODES) {
    throw new FieldPolicyError("traversal_limit_exceeded");
  }
  if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
    return candidate;
  }
  if (typeof candidate === "number") {
    if (!Number.isFinite(candidate)) {
      throw new FieldPolicyError("invalid_write_payload");
    }
    return candidate;
  }
  if (typeof candidate !== "object") {
    throw new FieldPolicyError("invalid_write_payload");
  }
  if (nodeUtilTypes.isProxy(candidate)) {
    throw new FieldPolicyError("invalid_write_payload");
  }
  if (state.seen.has(candidate)) {
    throw new FieldPolicyError("invalid_write_payload");
  }
  state.seen.add(candidate);
  try {
    if (Array.isArray(candidate)) {
      const keys = writeOwnKeys(candidate, MAX_FIELD_ARRAY_LENGTH + 1);
      const lengthDescriptor = ownDataDescriptor(candidate, "length");
      const length = lengthDescriptor?.value;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_FIELD_ARRAY_LENGTH
      ) {
        throw new FieldPolicyError("traversal_limit_exceeded");
      }
      for (const key of keys) {
        if (typeof key !== "string") {
          throw new FieldPolicyError("invalid_write_payload");
        }
        if (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
          throw new FieldPolicyError("invalid_write_payload");
        }
      }
      const presentKeys = new Set(keys.filter((key): key is string => typeof key === "string"));
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = ownDataDescriptor(candidate, key);
        if (!descriptor) {
          if (presentKeys.has(key)) {
            throw new FieldPolicyError("invalid_write_payload");
          }
          output.push(null);
        } else {
          output.push(cloneJsonSafeWriteValue(descriptor.value, state, depth + 1));
        }
      }
      return Object.freeze(output);
    }

    assertPlainWriteObject(candidate);
    const entries = writeOwnDataEntries(candidate, MAX_FIELD_OBJECT_OWN_KEYS);
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of entries) {
      if (isSensitiveFieldName(key)) {
        throw new FieldPolicyError("invalid_write_payload");
      }
      safeDefine(
        output,
        key,
        cloneJsonSafeWriteValue(descriptor.value, state, depth + 1)
      );
    }
    return Object.freeze(output);
  } finally {
    state.seen.delete(candidate);
  }
}

function responseTraversalState(): ResponseTraversalState {
  return { nodes: 0, seen: new WeakSet<object>() };
}

function responseNodeAllowed(
  candidate: unknown,
  state: ResponseTraversalState,
  depth: number
): candidate is object {
  state.nodes += 1;
  if (
    depth > MAX_FIELD_VALUE_DEPTH ||
    state.nodes > MAX_FIELD_VALUE_NODES ||
    typeof candidate !== "object" ||
    candidate === null ||
    nodeUtilTypes.isProxy(candidate) ||
    state.seen.has(candidate)
  ) {
    return false;
  }
  state.seen.add(candidate);
  return true;
}

function filterRecordNode(
  candidate: unknown,
  approved: ReadonlySet<string>,
  state: ResponseTraversalState,
  depth: number
): unknown {
  if (!responseNodeAllowed(candidate, state, depth)) {
    return null;
  }
  try {
    if (Array.isArray(candidate)) {
      const output: unknown[] = [];
      const view = responseArrayView(candidate);
      if (!view) return output;
      for (let index = 0; index < view.length; index += 1) {
        const key = String(index);
        if (!view.presentKeys.has(key)) continue;
        const descriptor = ownDataDescriptor(candidate, key);
        if (
          !descriptor ||
          typeof descriptor.value !== "object" ||
          descriptor.value === null ||
          nodeUtilTypes.isProxy(descriptor.value) ||
          Array.isArray(descriptor.value)
        ) {
          continue;
        }
        const filtered = filterRecordNode(
          descriptor.value,
          approved,
          state,
          depth + 1
        );
        if (typeof filtered === "object" && filtered !== null) {
          output.push(filtered);
        }
      }
      return output;
    }
    const keys = responseOwnKeys(candidate, MAX_FIELD_OBJECT_OWN_KEYS);
    if (!keys) return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") continue;
      let field: string;
      try {
        field = normalizeFieldName(key);
      } catch {
        continue;
      }
      if (!approved.has(field) || isSensitiveFieldName(field)) continue;
      const descriptor = ownDataDescriptor(candidate, key);
      if (!descriptor || !descriptor.enumerable) continue;
      safeDefine(
        output,
        field,
        sanitizeNestedValue(descriptor.value, state, depth + 1)
      );
    }
    return output;
  } finally {
    state.seen.delete(candidate);
  }
}

function sanitizeNestedValue(
  candidate: unknown,
  state: ResponseTraversalState,
  depth: number
): unknown {
  if (!responseNodeAllowed(candidate, state, depth)) {
    return sanitizePrimitive(candidate);
  }
  try {
    if (Array.isArray(candidate)) {
      const view = responseArrayView(candidate);
      if (!view) return null;
      const output: unknown[] = [];
      for (let index = 0; index < view.length; index += 1) {
        const key = String(index);
        const descriptor = view.presentKeys.has(key)
          ? ownDataDescriptor(candidate, key)
          : undefined;
        output.push(
          descriptor
            ? sanitizeNestedValue(descriptor.value, state, depth + 1)
            : null
        );
      }
      return output;
    }
    const keys = responseOwnKeys(candidate, MAX_FIELD_OBJECT_OWN_KEYS);
    if (!keys) return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") continue;
      if (isSensitiveFieldName(key)) continue;
      const descriptor = ownDataDescriptor(candidate, key);
      if (!descriptor || !descriptor.enumerable) continue;
      safeDefine(
        output,
        key,
        sanitizeNestedValue(descriptor.value, state, depth + 1)
      );
    }
    return output;
  } finally {
    state.seen.delete(candidate);
  }
}

function filterAggregateNode(
  candidate: unknown,
  approved: ReadonlySet<string>,
  state: ResponseTraversalState,
  depth: number
): unknown {
  if (!responseNodeAllowed(candidate, state, depth)) {
    return sanitizePrimitive(candidate);
  }
  try {
    if (Array.isArray(candidate)) {
      const view = responseArrayView(candidate);
      if (!view) return [];
      const output: unknown[] = [];
      for (let index = 0; index < view.length; index += 1) {
        const key = String(index);
        const descriptor = view.presentKeys.has(key)
          ? ownDataDescriptor(candidate, key)
          : undefined;
        const value =
          descriptor
            ? filterAggregateNode(descriptor.value, approved, state, depth + 1)
            : null;
        if (value !== null) output.push(value);
      }
      return output;
    }
    const keys = responseOwnKeys(candidate, MAX_FIELD_OBJECT_OWN_KEYS);
    if (!keys) return null;
    const declaredField = keys.includes("field")
      ? ownDataDescriptor(candidate, "field")
      : undefined;
    if (declaredField) {
      try {
        const field = normalizeFieldName(declaredField.value);
        if (!approved.has(field) || isSensitiveFieldName(field)) return null;
      } catch {
        return null;
      }
    }
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") continue;
      let normalized: string;
      try {
        normalized = normalizeFieldName(key);
      } catch {
        continue;
      }
      if (
        isSensitiveFieldName(normalized) ||
        (!AGGREGATE_ENVELOPE_FIELDS.has(normalized) && !approved.has(normalized))
      ) {
        continue;
      }
      const descriptor = ownDataDescriptor(candidate, key);
      if (!descriptor || !descriptor.enumerable) continue;
      safeDefine(
        output,
        normalized,
        filterAggregateNode(descriptor.value, approved, state, depth + 1)
      );
    }
    return output;
  } finally {
    state.seen.delete(candidate);
  }
}

function responseOwnKeys(
  candidate: object,
  maximum: number
): PropertyKey[] | undefined {
  if (nodeUtilTypes.isProxy(candidate)) return undefined;
  try {
    const keys = Reflect.ownKeys(candidate);
    return keys.length <= maximum ? keys : undefined;
  } catch {
    return undefined;
  }
}

function responseArrayView(
  candidate: unknown[]
): { readonly length: number; readonly presentKeys: ReadonlySet<string> } | undefined {
  const keys = responseOwnKeys(candidate, MAX_FIELD_ARRAY_LENGTH + 1);
  if (!keys) return undefined;
  const lengthDescriptor = ownDataDescriptor(candidate, "length");
  const rawLength = lengthDescriptor?.value;
  if (
    typeof rawLength !== "number" ||
    !Number.isSafeInteger(rawLength) ||
    rawLength < 0
  ) {
    return undefined;
  }
  return {
    length: Math.min(rawLength, MAX_FIELD_ARRAY_LENGTH),
    presentKeys: new Set(
      keys.filter((key): key is string => typeof key === "string" && key !== "length")
    ),
  };
}

function sanitizePrimitive(candidate: unknown): unknown {
  if (
    candidate === null ||
    typeof candidate === "string" ||
    typeof candidate === "boolean"
  ) {
    return candidate;
  }
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

function safeOwnDataValue(candidate: object, key: PropertyKey): unknown {
  if (nodeUtilTypes.isProxy(candidate)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeDefine(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
