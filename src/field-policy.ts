/**
 * Fail-closed ServiceNow field authorization and response filtering.
 *
 * Table authorization answers whether a tool may reach a table. This module
 * supplies the second, independent boundary: which fields may be requested,
 * written, or returned for the supported V2 table domains.
 *
 * @module field-policy
 */

import { types as nodeUtilTypes } from "node:util";

export type ResponseFormat = "concise" | "detailed";

export interface ReadFieldSelectionInput {
  readonly fields?: unknown;
  readonly responseFormat?: unknown;
}

export interface PreparedFieldAccess {
  readonly entries: readonly {
    readonly table: string;
    readonly readableFields: readonly string[];
  }[];
}

export type FieldPolicyFailureReason =
  | "unsupported_table"
  | "invalid_field_selection"
  | "excessive_field_selection"
  | "sensitive_field"
  | "unreadable_field"
  | "invalid_write_payload"
  | "non_writable_field"
  | "traversal_limit_exceeded"
  | "invalid_argument_shape";

interface TableFieldPolicyDefinition {
  readonly defaults: readonly string[];
  readonly readable: readonly string[];
  readonly writable: readonly string[];
}

interface TableFieldPolicy {
  readonly table: string;
  readonly defaults: readonly string[];
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  readonly maxFields: number;
}

const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
export const MAX_FIELDS_PER_OPERATION = 32;
/** Hard bounds for hostile values crossing the field-policy boundary. */
export const MAX_FIELD_VALUE_DEPTH = 24;
export const MAX_FIELD_VALUE_NODES = 50_000;
export const MAX_FIELD_ARRAY_LENGTH = 10_000;
export const MAX_FIELD_OBJECT_OWN_KEYS = 256;
export const MAX_TOOL_ARGUMENT_OWN_KEYS = 64;
const MAX_CANONICAL_ARGUMENT_KEYS = 8;

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
    readable: ["sys_id", "name", "description", "active", "sys_updated_on"],
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
} as const satisfies Record<string, TableFieldPolicyDefinition>;

const TABLE_FIELD_POLICIES = new Map<string, TableFieldPolicy>(
  Object.entries(POLICY_DEFINITIONS).map(([table, definition]) => {
    const defaults = normalizePolicyFields(definition.defaults, `${table} defaults`);
    const readable = normalizePolicyFields(definition.readable, `${table} readable`);
    const writable = normalizePolicyFields(definition.writable, `${table} writable`);
    if (defaults.some((field) => !readable.includes(field))) {
      throw new TypeError(`${table} default fields must be readable`);
    }
    if (readable.length > MAX_FIELDS_PER_OPERATION) {
      throw new TypeError(`${table} readable fields exceed the maximum`);
    }
    return [
      table,
      Object.freeze({
        table,
        defaults,
        readable,
        writable,
        maxFields: MAX_FIELDS_PER_OPERATION,
      }),
    ];
  })
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
      [...TABLE_FIELD_POLICIES]
        .filter(([table]) => GENERIC_RECORD_TABLES.has(table))
        .map(([table, policy]) => [table, policy.defaults])
    )
  );

const PREPARED_FIELD_ACCESS = Symbol("PreparedFieldAccess");
const ISSUED_FIELD_POLICY_ERRORS = new WeakSet<object>();
const ISSUED_PREPARED_FIELD_ACCESS = new WeakSet<object>();

/** Bounded policy rejection that never contains the requested field or payload. */
export class FieldPolicyError extends Error {
  constructor(readonly reason: FieldPolicyFailureReason) {
    super("Field access denied by policy");
    this.name = "FieldPolicyError";
    ISSUED_FIELD_POLICY_ERRORS.add(this);
    Object.freeze(this);
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

/** Resolve a caller selection to a finite approved field list. */
export function resolveReadableFields(
  tableCandidate: unknown,
  input: ReadFieldSelectionInput = {}
): readonly string[] {
  const policy = requirePolicy(tableCandidate);
  const canonicalInput = snapshotPlainDataArguments(
    input as Readonly<Record<string, unknown>>
  );
  const responseFormat = normalizeResponseFormat(canonicalInput.responseFormat);
  const requested = canonicalInput.fields;

  if (requested === undefined) {
    return responseFormat === "detailed" ? policy.readable : policy.defaults;
  }
  if (typeof requested !== "string") {
    throw new FieldPolicyError("invalid_field_selection");
  }
  const trimmed = requested.trim();
  if (trimmed.toLowerCase() === "all") return policy.readable;
  if (!trimmed) throw new FieldPolicyError("invalid_field_selection");

  const rawFields = trimmed.split(",");
  if (rawFields.length > policy.maxFields) {
    throw new FieldPolicyError("excessive_field_selection");
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawFields) {
    const field = normalizeFieldName(candidate);
    if (seen.has(field)) throw new FieldPolicyError("invalid_field_selection");
    if (isSensitiveFieldName(field)) throw new FieldPolicyError("sensitive_field");
    if (!policy.readable.includes(field)) {
      throw new FieldPolicyError("unreadable_field");
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
  const entries = writeOwnDataEntries(payloadCandidate, policy.maxFields);
  if (entries.length === 0) throw new FieldPolicyError("invalid_write_payload");
  if (entries.length > policy.maxFields) {
    throw new FieldPolicyError("excessive_field_selection");
  }

  const output: Record<string, unknown> = {};
  const traversal: WriteTraversalState = {
    nodes: 0,
    seen: new WeakSet<object>(),
  };
  for (const [candidate, descriptor] of entries) {
    if (!("value" in descriptor)) {
      throw new FieldPolicyError("invalid_write_payload");
    }
    const field = normalizeFieldName(candidate);
    if (Object.hasOwn(output, field)) {
      throw new FieldPolicyError("invalid_write_payload");
    }
    if (isSensitiveFieldName(field)) throw new FieldPolicyError("sensitive_field");
    if (!policy.writable.includes(field)) {
      throw new FieldPolicyError("non_writable_field");
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
    safeDefineArgument(overrides, "fields", readableFields.join(","));
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

/** Validate write keys and prepare the corresponding safe response projection. */
export function prepareWriteFieldArguments(
  args: Readonly<Record<string, unknown>>,
  table: string
): Record<string, unknown> {
  const canonicalArgs = withFieldPolicyArgumentValues(args);
  const fields = validateWritableFields(table, canonicalArgs.fields);
  const readableFields = resolveReadableFields(table, {
    fields: "all",
    responseFormat: "detailed",
  });
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
): readonly string[] | undefined {
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
    if (!Array.isArray(fields) || !Object.isFrozen(fields)) return undefined;
    const policy = requirePolicy(table);
    if (
      fields.length === 0 ||
      fields.length > policy.maxFields ||
      fields.some(
        (field) => typeof field !== "string" || !policy.readable.includes(field)
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
  readableFields: readonly string[]
): unknown {
  if (nodeUtilTypes.isProxy(readableFields)) return null;
  const approved = new Set(readableFields.map(normalizeFieldName));
  const state = responseTraversalState();
  return filterRecordNode(candidate, approved, state, 0);
}

/** Remove metadata entries for fields the caller is not permitted to discover. */
export function filterSchemaEntries(
  candidate: unknown,
  readableFields: readonly string[]
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
  const approved = new Set(readableFields.map(normalizeFieldName));
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
    if (!approved.has(field) || isSensitiveFieldName(field)) continue;
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
  readableFields: readonly string[]
): unknown {
  if (nodeUtilTypes.isProxy(readableFields)) return null;
  const approved = new Set(readableFields.map(normalizeFieldName));
  const state = responseTraversalState();
  return filterAggregateNode(candidate, approved, state, 0);
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
  const policy = TABLE_FIELD_POLICIES.get(table);
  if (!policy) throw new FieldPolicyError("unsupported_table");
  return policy;
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

function normalizeResponseFormat(candidate: unknown): ResponseFormat {
  if (candidate === undefined || candidate === "concise") return "concise";
  if (candidate === "detailed") return "detailed";
  throw new FieldPolicyError("invalid_field_selection");
}

function normalizePolicyFields(
  candidates: readonly string[],
  label: string
): readonly string[] {
  if (!Array.isArray(candidates) || candidates.length > MAX_FIELDS_PER_OPERATION) {
    throw new TypeError(`${label} is invalid or exceeds the maximum`);
  }
  const fields = candidates.map((field) => normalizeFieldName(field));
  if (new Set(fields).size !== fields.length) {
    throw new TypeError(`${label} contains duplicate fields`);
  }
  if (fields.some(isSensitiveFieldName)) {
    throw new TypeError(`${label} contains a sensitive field`);
  }
  return Object.freeze(fields);
}

function issuePreparedAccess(
  args: Readonly<Record<string, unknown>>,
  table: string,
  readableFields: readonly string[]
): PreparedFieldAccess {
  const normalizedTable = normalizeTableName(table);
  const previous = issuedPreparedEntries(args).filter(
    (entry) => entry.table !== normalizedTable
  );
  const entry = Object.freeze({
    table: normalizedTable,
    readableFields: Object.freeze([...readableFields]),
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
