/**
 * Fail-closed ServiceNow table authorization for SNSDK-29.
 *
 * Policies contain separate read and write allowlists. Each allowlist accepts
 * exact table names or the literal "*" to allow every table for that operation.
 * The per-profile configuration is the sole MCP-side authority over which
 * tables are reachable: this module carries no built-in table denials, because
 * ServiceNow evaluates its own ACLs per authenticated user on every request and
 * a second hard-coded layer here would silently override what an operator
 * deliberately configured.
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
  /**
   * Required literal. It marks relatedTables as deliberately stated; the
   * loader does not check the list against the instance.
   */
  readonly closureComplete: true;
  /**
   * The requested table plus any backing or parent tables the operator
   * declares. The loader requires each one to carry the target's operation
   * permission; the list grants no access, and a related table is not
   * caller-addressable unless it has its own target entry or the operation's
   * allowlist is "*". Inherited fields are read through the target's own
   * endpoint, so a canonical target may list itself alone.
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
const TABLE_ALLOWLIST_WILDCARD = "*";

/**
 * Tables a "*" grant never covers. An allowlist reaches one of these only
 * when it names the table, for read and for write alike. Their rows hold the
 * old and new values of other tables' fields, comments and work notes, so a
 * blanket grant is not a deliberate choice to expose them.
 *
 * Every entry is also a built-in system table (SYSTEM_TABLES in
 * field-policy.ts), which a test enforces. The list is deliberately short:
 * it applies to these tables only, and no other table's reach changes.
 */
export const NAMED_ONLY_TABLES: readonly string[] = Object.freeze([
  "sys_audit",
  "sys_journal_field",
]);

const NAMED_ONLY_SET: ReadonlySet<string> = new Set(NAMED_ONLY_TABLES);

const ISSUED_TABLE_POLICY_ERRORS = new WeakSet<object>();
const ISSUED_TABLE_POLICIES = new WeakSet<object>();

/**
 * Why a table was refused, in the terms an operator can act on.
 *
 * - `not_granted`: the profile's allowlist for the operation does not name it.
 * - `named_only`: the allowlist grants "*" but the table is covered only when
 *   named, so the grant that lifts the denial is one that names it.
 * - `tool_not_bound`: the allowlist names it, but this tool is not among the
 *   tools its target permits.
 * - `unsupported_table`: the tool does not work on that table at all, so no
 *   grant would help.
 * - `none_granted`: a search that reads a fixed set of tables may read none
 *   of them under this profile.
 */
export type TablePolicyDenialReason =
  | "not_granted"
  | "named_only"
  | "tool_not_bound"
  | "unsupported_table"
  | "none_granted";

/**
 * What a denial may say about itself. Every value is a canonical identifier
 * the caller already sent or the profile already holds: a table name that
 * passed normalizeTableName, the registered tool's name, and a fixed word for
 * the operation and reason. Nothing here is policy contents beyond the one
 * decision being explained to the profile's own caller.
 */
export interface TablePolicyDenialDetail {
  readonly reason: TablePolicyDenialReason;
  readonly operation?: TableAccessOperation;
  readonly table?: string;
  readonly tool?: string;
  /** For `none_granted`: the fixed tables the tool would have read. */
  readonly tables?: readonly string[];
}

/**
 * Denial error. It never contains the profile's allowlists or targets. When a
 * denial is raised with detail, the client text can name the table and tool
 * and say which grant is missing; without it the text is the fixed sentence.
 */
export class TablePolicyError extends Error {
  readonly detail: TablePolicyDenialDetail | undefined;

  constructor(detail?: TablePolicyDenialDetail) {
    super("Table access denied by policy");
    this.name = "TablePolicyError";
    this.detail = detail === undefined ? undefined : safeDenialDetail(detail);
    ISSUED_TABLE_POLICY_ERRORS.add(this);
    Object.freeze(this);
  }
}

/** Keep only well-formed, bounded values, so a bad detail degrades to the fixed text. */
function safeDenialDetail(candidate: TablePolicyDenialDetail): TablePolicyDenialDetail | undefined {
  try {
    const reason = candidate.reason;
    if (
      reason !== "not_granted" &&
      reason !== "named_only" &&
      reason !== "tool_not_bound" &&
      reason !== "unsupported_table" &&
      reason !== "none_granted"
    ) {
      return undefined;
    }
    const operation =
      candidate.operation === "read" || candidate.operation === "write"
        ? candidate.operation
        : undefined;
    const table = safeIdentifier(candidate.table, TABLE_NAME);
    const tool = safeIdentifier(candidate.tool, TOOL_NAME);
    const tables = Array.isArray(candidate.tables)
      ? Object.freeze(
          candidate.tables
            .map((entry) => safeIdentifier(entry, TABLE_NAME))
            .filter((entry): entry is string => entry !== undefined)
            .slice(0, 16)
        )
      : undefined;
    return Object.freeze({
      reason,
      ...(operation === undefined ? {} : { operation }),
      ...(table === undefined ? {} : { table }),
      ...(tool === undefined ? {} : { tool }),
      ...(tables === undefined || tables.length === 0 ? {} : { tables }),
    });
  } catch {
    return undefined;
  }
}

function safeIdentifier(candidate: unknown, pattern: RegExp): string | undefined {
  return typeof candidate === "string" && pattern.test(candidate) ? candidate : undefined;
}

const DENIED_PREFIX = "Table access was denied by policy";

/**
 * The text a caller sees for a table denial, with the correlation id left to
 * the caller. It keeps the phrase "denied by policy" that denial classifiers
 * match on, and, when the error carries detail, names the table and the tool
 * and the one `grant` command that lifts it. `<profile>` stays a placeholder:
 * the profile name is the caller's own input, and the operator knows it.
 */
export function tablePolicyDenialMessage(error: TablePolicyError): string {
  const detail = error.detail;
  if (detail === undefined) return `${DENIED_PREFIX}.`;
  const { operation, table, tool } = detail;
  const grant = (name: string): string =>
    `servicenow-mcp-setup grant --profile <profile> --${operation ?? "read"} ${name}` +
    `${tool === undefined ? "" : ` --tools ${tool}`}`;
  const restart = "then restart the MCP client";
  switch (detail.reason) {
    case "not_granted":
      return table === undefined || tool === undefined
        ? `${DENIED_PREFIX}.`
        : `${DENIED_PREFIX}: this profile has no ${operation ?? "read"} grant on "${table}" ` +
            `that allows ${tool}. To allow it, run: ${grant(table)}, ${restart}.`;
    case "named_only":
      return table === undefined || tool === undefined
        ? `${DENIED_PREFIX}.`
        : `${DENIED_PREFIX}: a "*" grant does not cover "${table}". This profile has no ` +
            `${operation ?? "read"} grant on "${table}" that allows ${tool}. ` +
            `To allow it, run: ${grant(table)}, ${restart}.`;
    case "tool_not_bound":
      return table === undefined || tool === undefined
        ? `${DENIED_PREFIX}.`
        : `${DENIED_PREFIX}: "${table}" is granted to this profile, but not for ${tool}. ` +
            `To allow it, run: ${grant(table)}, ${restart}. The tools already allowed on ` +
            `that table stay allowed.`;
    case "unsupported_table":
      return table === undefined || tool === undefined
        ? `${DENIED_PREFIX}.`
        : `${DENIED_PREFIX}: ${tool} does not support table "${table}", so no grant allows it.`;
    case "none_granted":
      return tool === undefined
        ? `${DENIED_PREFIX}.`
        : `${DENIED_PREFIX}: this profile does not allow ${tool} to read any of the tables ` +
            `it searches${detail.tables === undefined ? "" : ` (${detail.tables.join(", ")})`}. ` +
            `To allow one, run: ${grant("<table>")}, ${restart}.`;
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

/** Parse comma-separated process configuration as profile-local policy input. */
export function tableAccessPolicyInputFromEnvironment(
  environment: TablePolicyEnvironment = process.env as TablePolicyEnvironment
): TableAccessPolicyInput {
  return Object.freeze({
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

/** Parse comma-separated process configuration; missing variables deny all. */
export function tableAccessPolicyFromEnvironment(
  environment: TablePolicyEnvironment = process.env as TablePolicyEnvironment
): TableAccessPolicy {
  return createTableAccessPolicy(tableAccessPolicyInputFromEnvironment(environment));
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
    const allowlist =
      operation === "read"
        ? policy.readTables
        : policy.writeTables;
    const denied = (
      reason: "not_granted" | "named_only" | "tool_not_bound"
    ): TablePolicyError =>
      new TablePolicyError({ reason, operation, table, tool: authorizedTool });
    if (!allowlistGrantsTable(allowlist, table)) {
      // A "*" grant is present but does not reach this table: say so, because
      // "no grant" would read as though the wildcard were missing.
      throw denied(
        allowlistGrantsAllTables(allowlist) && NAMED_ONLY_SET.has(table)
          ? "named_only"
          : "not_granted"
      );
    }
    const target = policy.targets.find((entry) => entry.table === table);
    if (!target) {
      // The table passed allowlistGrantsTable above, so under "*" it is
      // either covered by it or, for a named-only table, named.
      if (allowlistGrantsAllTables(allowlist)) return table;
      throw denied("not_granted");
    }
    if (!target.tools.includes(authorizedTool)) throw denied("tool_not_bound");
    for (const relatedTable of target.relatedTables) {
      if (!allowlistGrantsTable(allowlist, relatedTable)) {
        throw denied("not_granted");
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
    if (typeof entry === "string" && entry.trim() === TABLE_ALLOWLIST_WILDCARD) {
      tables.add(TABLE_ALLOWLIST_WILDCARD);
      continue;
    }
    tables.add(normalizeTableName(entry));
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
  const readAllowsAll = allowlistGrantsAllTables(readTables);
  const writeAllowsAll = allowlistGrantsAllTables(writeTables);
  const allowsAnyConfiguredOperation = (table: string): boolean =>
    configuredTables.has(table) || readAllowsAll || writeAllowsAll;
  if (candidate === undefined) {
    if (configuredTables.size === 0 || readAllowsAll || writeAllowsAll) {
      return Object.freeze([]);
    }
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
    if (!allowsAnyConfiguredOperation(table) || targets.has(table)) {
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
      throw new TypeError("table access target must set closureComplete: true");
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
      if (!allowlistGrantsTable(allowlist, target.table)) continue;
      if (target.relatedTables.some((related) => !allowlistGrantsTable(allowlist, related))) {
        throw new TypeError(
          "table access target backing tables require the same operation permission"
        );
      }
    }
  }
}

function allowlistGrantsAllTables(allowlist: readonly string[]): boolean {
  return allowlist.includes(TABLE_ALLOWLIST_WILDCARD);
}

/**
 * Whether an allowlist reaches a table: by name, or through "*" for every
 * table except the named-only ones.
 */
function allowlistGrantsTable(allowlist: readonly string[], table: string): boolean {
  if (allowlist.includes(table)) return true;
  return allowlistGrantsAllTables(allowlist) && !NAMED_ONLY_SET.has(table);
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
