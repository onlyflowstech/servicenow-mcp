/**
 * Tables whose rows are credential material as a whole.
 *
 * A field-type rule hides one column; on these tables the secret is the row:
 * an authentication profile, an OAuth client, a discovery credential, a
 * certificate, a source instance's login, a REST message's auth settings, or
 * a system property whose secrecy is its per-row `type`. A tool that shows
 * values from arbitrary rows (record history, update-set payloads) shows none
 * from these tables, whatever each column's type is.
 *
 * The list is shared and read-only: every tool that needs it imports it from
 * here, so it is decided in one place and tested once. It is matched on the
 * table a field ends at, so a dot-walk through a reference into one of these
 * tables is caught too (see hidden-values.ts).
 *
 * @module credential-tables
 */

const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;

/**
 * Exact names, or a prefix ending in `*` that matches every table whose name
 * starts with it (`sys_auth_profile*` covers `sys_auth_profile_basic`,
 * `sys_auth_profile_oauth2`, ...).
 */
export const CREDENTIAL_TABLE_PATTERNS: readonly string[] = Object.freeze([
  "sys_properties",
  "sys_auth_profile*",
  "oauth_entity",
  "oauth_credential",
  "discovery_credentials",
  "sys_certificate",
  "sys_update_set_source",
  "sys_rest_message*",
]);

/** True when `table` is on the credential-table list. A non-name is never one. */
export function isCredentialTable(table: unknown): boolean {
  if (typeof table !== "string") return false;
  const normalized = table.trim().toLowerCase();
  if (!TABLE_NAME.test(normalized)) return false;
  return CREDENTIAL_TABLE_PATTERNS.some((pattern) =>
    pattern.endsWith("*")
      ? normalized.startsWith(pattern.slice(0, -1))
      : normalized === pattern
  );
}

/**
 * True when `table` or any table in its extension chain is on the list. The
 * chain is the table first, then its ancestors (`ssh_credentials` extends
 * `discovery_credentials`).
 */
export function isCredentialTableHierarchy(hierarchy: readonly string[]): boolean {
  return hierarchy.some(isCredentialTable);
}
