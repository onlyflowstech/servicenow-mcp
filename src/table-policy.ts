/**
 * Fail-closed ServiceNow table authorization for SNSDK-29.
 *
 * Policies contain separate exact read and write allowlists. A built-in hard
 * denial for credential, authentication, encryption, and security-policy
 * tables is applied both while configuration is loaded and at every decision.
 *
 * @module table-policy
 */

export type TableAccessOperation = "read" | "write";

export interface TableAccessRequest {
  readonly operation: TableAccessOperation;
  readonly table: string;
}

export interface TableAccessPolicyInput {
  readonly readTables?: readonly string[];
  readonly writeTables?: readonly string[];
  /** Trusted startup classification for every table named by either allowlist. */
  readonly targets?: readonly TableAccessTargetInput[];
}

export type TableAccessTargetKind =
  | "canonical"
  | "alias"
  | "view"
  | "extension";

export interface TableAccessTargetInput {
  readonly table: string;
  readonly kind: TableAccessTargetKind;
  /** Exact published tools permitted to address this target. */
  readonly tools: readonly string[];
  /** Explicit proof that relatedTables is the complete reachable closure. */
  readonly closureComplete: true;
  /**
   * Requested table plus every reachable backing, ancestor, and descendant
   * table for the ServiceNow operation. Related permission does not make a
   * table directly caller-addressable unless it has its own target entry.
   */
  readonly relatedTables: readonly string[];
}

export interface TableAccessTarget extends TableAccessTargetInput {
  readonly relatedTables: readonly string[];
}

/** Immutable, non-secret policy material safe to retain in a request context. */
export interface TableAccessPolicy {
  readonly readTables: readonly string[];
  readonly writeTables: readonly string[];
  readonly targets: readonly TableAccessTarget[];
}

export interface TablePolicyEnvironment {
  readonly SN_ALLOWED_READ_TABLES?: string;
  readonly SN_ALLOWED_WRITE_TABLES?: string;
  readonly SN_TABLE_ACCESS_TARGETS?: string;
}

const MAX_TABLE_NAME_LENGTH = 80;
const MAX_TABLES_PER_ALLOWLIST = 512;
const MAX_ALLOWLIST_TEXT_LENGTH = 16_384;
const MAX_TARGET_TEXT_LENGTH = 65_536;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const TOOL_NAME = /^sn_[a-z0-9_]{1,61}$/u;

/** Exact families that must never become remotely accessible by configuration. */
const HARD_DENIED_EXACT = new Set([
  "discovery_credentials",
  "discovery_credentials_affinity",
  "ecc_agent_credential",
  "oauth_credential",
  "oauth_entity",
  "oauth_requestor_profile",
  "oauth_token",
  "sys_certificate",
  "sys_credentials",
  "sys_db_view",
  "sys_db_view_table",
  "sys_encryption_context",
  "sys_encryption_key",
  "sys_group_has_role",
  "sys_security_acl",
  "sys_security_acl_role",
  "sys_table_alias",
  "sys_table_rotation",
  "sys_user_has_role",
  "sys_user_password",
  "sys_user_role",
  "sys_user_token",
]);

const HARD_DENIED_PREFIXES = Object.freeze([
  "discovery_credentials_",
  "oauth_",
  "sys_auth_",
  "sys_credential_",
  "sys_encryption_",
  "sys_kmf_",
  "sys_mfa_",
  "sys_security_acl_",
  "sys_user_password_",
  "sys_user_token_",
]);

const ISSUED_TABLE_POLICY_ERRORS = new WeakSet<object>();
const ISSUED_TABLE_POLICIES = new WeakSet<object>();

/** Generic denial error; it never contains the table or policy contents. */
export class TablePolicyError extends Error {
  constructor() {
    super("Table access denied by policy");
    this.name = "TablePolicyError";
    ISSUED_TABLE_POLICY_ERRORS.add(this);
    Object.freeze(this);
  }
}

export function isTablePolicyError(error: unknown): error is TablePolicyError {
  try {
    return (
      error instanceof TablePolicyError &&
      Object.isFrozen(error) &&
      ISSUED_TABLE_POLICY_ERRORS.has(error)
    );
  } catch {
    return false;
  }
}

/** Canonical ServiceNow table identifier used for both config and decisions. */
export function normalizeTableName(candidate: unknown): string {
  if (typeof candidate !== "string") {
    throw new TypeError("table name must be a string");
  }
  const normalized = candidate.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_TABLE_NAME_LENGTH ||
    !TABLE_NAME.test(normalized)
  ) {
    throw new TypeError("table name must be a valid ServiceNow identifier");
  }
  return normalized;
}

/** True for tables whose remote exposure is prohibited regardless of config. */
export function isHardDeniedTable(candidate: unknown): boolean {
  let table: string;
  try {
    table = normalizeTableName(candidate);
  } catch {
    return true;
  }
  return (
    HARD_DENIED_EXACT.has(table) ||
    HARD_DENIED_PREFIXES.some((prefix) => table.startsWith(prefix))
  );
}

/** Validate, canonicalize, deduplicate, and deeply freeze one table policy. */
export function createTableAccessPolicy(
  input: TableAccessPolicyInput
): TableAccessPolicy {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("table access policy must be an object");
  }
  const readTables = normalizeAllowlist(input.readTables, "read");
  const writeTables = normalizeAllowlist(input.writeTables, "write");
  const targets = normalizeTargets(input.targets, readTables, writeTables);
  validateRelatedPermissions(targets, readTables, writeTables);
  const policy = Object.freeze({ readTables, writeTables, targets });
  ISSUED_TABLE_POLICIES.add(policy);
  return policy;
}

/** Parse comma-separated process configuration; missing variables deny all. */
export function tableAccessPolicyFromEnvironment(
  environment: TablePolicyEnvironment = process.env as TablePolicyEnvironment
): TableAccessPolicy {
  return createTableAccessPolicy({
    readTables: parseEnvironmentAllowlist(
      environment.SN_ALLOWED_READ_TABLES,
      "SN_ALLOWED_READ_TABLES"
    ),
    writeTables: parseEnvironmentAllowlist(
      environment.SN_ALLOWED_WRITE_TABLES,
      "SN_ALLOWED_WRITE_TABLES"
    ),
    targets: parseEnvironmentTargets(environment.SN_TABLE_ACCESS_TARGETS),
  });
}

/** Throw a branded safe denial unless the exact operation/table is allowed. */
export function authorizeTableAccess(
  policy: TableAccessPolicy,
  request: TableAccessRequest,
  tool: string
): string {
  try {
    if (!isIssuedTableAccessPolicy(policy)) throw new TablePolicyError();
    if (typeof request !== "object" || request === null) {
      throw new TypeError("table access request must be an object");
    }
    const operation = request.operation;
    if (operation !== "read" && operation !== "write") {
      throw new TypeError("table access operation is invalid");
    }
    const table = normalizeTableName(request.table);
    const authorizedTool = normalizeToolName(tool);
    if (isHardDeniedTable(table)) throw new TablePolicyError();
    const allowlist =
      operation === "read"
        ? policy.readTables
        : policy.writeTables;
    if (!allowlist.includes(table)) throw new TablePolicyError();
    const target = policy.targets.find((entry) => entry.table === table);
    if (!target) throw new TablePolicyError();
    if (!target.tools.includes(authorizedTool)) throw new TablePolicyError();
    for (const relatedTable of target.relatedTables) {
      if (isHardDeniedTable(relatedTable) || !allowlist.includes(relatedTable)) {
        throw new TablePolicyError();
      }
    }
    return table;
  } catch (error) {
    if (isTablePolicyError(error)) throw error;
    throw new TablePolicyError();
  }
}

function isIssuedTableAccessPolicy(
  candidate: unknown
): candidate is TableAccessPolicy {
  try {
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      Object.isFrozen(candidate) &&
      ISSUED_TABLE_POLICIES.has(candidate)
    );
  } catch {
    return false;
  }
}

/** Authorize a complete operation before the first ServiceNow client access. */
export function authorizeTableAccessPlan(
  policy: TableAccessPolicy,
  requests: readonly TableAccessRequest[],
  tool: string
): readonly TableAccessRequest[] {
  try {
    if (!Array.isArray(requests)) throw new TypeError("access plan must be an array");
    const authorized = requests.map((request) =>
      Object.freeze({
        operation: request.operation,
        table: authorizeTableAccess(policy, request, tool),
      })
    );
    return Object.freeze(authorized);
  } catch (error) {
    if (isTablePolicyError(error)) throw error;
    throw new TablePolicyError();
  }
}

function normalizeAllowlist(
  candidate: readonly string[] | undefined,
  label: string
): readonly string[] {
  if (candidate === undefined) return Object.freeze([]);
  if (!Array.isArray(candidate) || candidate.length > MAX_TABLES_PER_ALLOWLIST) {
    throw new TypeError(
      `${label} table allowlist must contain at most ${MAX_TABLES_PER_ALLOWLIST} entries`
    );
  }
  const tables = new Set<string>();
  for (const entry of candidate) {
    const table = normalizeTableName(entry);
    if (isHardDeniedTable(table)) {
      throw new TypeError(`${label} table allowlist contains a prohibited table`);
    }
    tables.add(table);
  }
  return Object.freeze([...tables].sort());
}

function parseEnvironmentAllowlist(
  candidate: string | undefined,
  name: string
): readonly string[] {
  if (candidate === undefined || candidate.trim() === "") return [];
  if (candidate.length > MAX_ALLOWLIST_TEXT_LENGTH) {
    throw new TypeError(`${name} exceeds its maximum length`);
  }
  const entries = candidate.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new TypeError(`${name} contains an empty table name`);
  }
  return entries;
}

function normalizeTargets(
  candidate: readonly TableAccessTargetInput[] | undefined,
  readTables: readonly string[],
  writeTables: readonly string[]
): readonly TableAccessTarget[] {
  const configuredTables = new Set([...readTables, ...writeTables]);
  if (candidate === undefined) {
    if (configuredTables.size === 0) return Object.freeze([]);
    throw new TypeError("table access targets are required for every allowed table");
  }
  if (!Array.isArray(candidate) || candidate.length > MAX_TABLES_PER_ALLOWLIST * 2) {
    throw new TypeError("table access targets are invalid or exceed the limit");
  }

  const targets = new Map<string, TableAccessTarget>();
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("table access target must be an object");
    }
    const table = normalizeTableName(entry.table);
    if (!configuredTables.has(table) || targets.has(table)) {
      throw new TypeError("table access target is duplicate or not allowlisted");
    }
    const kind = normalizeTargetKind(entry.kind);
    if (!Array.isArray(entry.tools) || entry.tools.length === 0) {
      throw new TypeError("table access target must include at least one tool");
    }
    const tools = Object.freeze(
      [...new Set<string>(entry.tools.map((tool: unknown) => normalizeToolName(tool)))].sort()
    );
    if (entry.closureComplete !== true) {
      throw new TypeError("table access target closure must be explicitly complete");
    }
    if (!Array.isArray(entry.relatedTables) || entry.relatedTables.length === 0) {
      throw new TypeError("table access target must include related tables");
    }
    const relatedTables = Object.freeze(
      [
        ...new Set<string>(
          entry.relatedTables.map((related: unknown) => normalizeTableName(related))
        ),
      ].sort()
    );
    if (!relatedTables.includes(table)) {
      throw new TypeError("table access target must include its requested table");
    }
    if (relatedTables.some(isHardDeniedTable)) {
      throw new TypeError("table access target reaches a prohibited table");
    }
    if (kind !== "canonical" && relatedTables.length < 2) {
      throw new TypeError("indirect table targets must identify a backing table");
    }
    targets.set(
      table,
      Object.freeze({
        table,
        kind,
        tools,
        closureComplete: true,
        relatedTables,
      })
    );
  }
  return Object.freeze([...targets.values()].sort((a, b) => a.table.localeCompare(b.table)));
}

function validateRelatedPermissions(
  targets: readonly TableAccessTarget[],
  readTables: readonly string[],
  writeTables: readonly string[]
): void {
  for (const target of targets) {
    for (const allowlist of [readTables, writeTables]) {
      if (!allowlist.includes(target.table)) continue;
      if (target.relatedTables.some((related) => !allowlist.includes(related))) {
        throw new TypeError(
          "table access target backing tables require the same operation permission"
        );
      }
    }
  }
}

function normalizeTargetKind(candidate: unknown): TableAccessTargetKind {
  if (
    candidate !== "canonical" &&
    candidate !== "alias" &&
    candidate !== "view" &&
    candidate !== "extension"
  ) {
    throw new TypeError("table access target kind is invalid");
  }
  return candidate;
}

function normalizeToolName(candidate: unknown): string {
  if (typeof candidate !== "string" || !TOOL_NAME.test(candidate)) {
    throw new TypeError("table access target tool is invalid");
  }
  return candidate;
}

function parseEnvironmentTargets(
  candidate: string | undefined
): readonly TableAccessTargetInput[] | undefined {
  if (candidate === undefined || candidate.trim() === "") return undefined;
  if (candidate.length > MAX_TARGET_TEXT_LENGTH) {
    throw new TypeError("SN_TABLE_ACCESS_TARGETS exceeds its maximum length");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new TypeError("SN_TABLE_ACCESS_TARGETS must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("SN_TABLE_ACCESS_TARGETS must be a JSON array");
  }
  return parsed as readonly TableAccessTargetInput[];
}
