/**
 * Tables where a write changes who may do what or what runs: role
 * assignments, group membership, role inheritance, delegations, ACLs,
 * approvals, server-side scripts, system properties, users and groups, and
 * authentication settings.
 *
 * This list drives warnings only. It denies nothing: these tables
 * are controlled by the profile's own configuration (its table grant and field
 * policy), so a grant on one is allowed and printed with a warning, and the
 * policy card flags it. Keeping the warning separate from enforcement means a
 * stale entry here can never block or permit a write.
 *
 * @module risky-grants
 */

export const RISKY_WRITE_TABLES: readonly string[] = Object.freeze([
  "sys_user_has_role",
  "sys_user_grmember",
  "sys_group_has_role",
  "sys_user_role",
  "sys_user_role_contains",
  "sys_user_delegate",
  "sys_security_acl",
  "sys_security_acl_role",
  "sysapproval_approver",
  "sysapproval_group",
  // Server-side code: a `script` write on these is code execution.
  "sys_script",
  "sys_script_include",
  "sysauto_script",
  "sys_trigger",
  "sys_ui_script",
  "sys_script_client",
  "sys_ws_operation",
  "sys_processor",
  // Configuration, identity and authentication.
  "sys_properties",
  "sys_user",
  "sys_user_group",
  "oauth_entity",
  "oauth_credential",
  "sys_certificate",
  "sys_auth_profile",
  "sys_auth_profile_basic",
]);

const RISKY_SET: ReadonlySet<string> = new Set(RISKY_WRITE_TABLES);

/** The risky tables among `writeTables`; `"*"` covers all of them. */
export function riskyWriteTables(writeTables: readonly string[]): readonly string[] {
  if (writeTables.includes("*")) return RISKY_WRITE_TABLES;
  return Object.freeze(writeTables.filter((table) => RISKY_SET.has(table)).sort());
}

/**
 * The warning printed when a grant gives write access on a privilege-sensitive
 * table, or undefined when it does not. `granted` is what the grant added;
 * `profile` is a validated profile name ([A-Za-z0-9._-], never starting with
 * "-" or "."), so it is safe to paste into a shell.
 */
export function riskyGrantWarning(
  granted: readonly string[],
  profile: string
): string | undefined {
  const risky = riskyWriteTables(granted);
  if (risky.length === 0) return undefined;
  const wildcard = granted.includes("*");
  return (
    `WARNING: this grant gives write access on privilege-sensitive tables: ${risky.join(", ")}` +
    `${wildcard ? ' (through the "*" write wildcard, which covers every table)' : ""}.\n` +
    "  Writes to these tables change who holds roles, who is in a group, who\n" +
    "  approves, and what code or settings the instance runs. An agent using this\n" +
    "  profile could grant itself access, approve its own changes, or run code.\n" +
    "  The grant is still allowed: only this profile's table grant and field\n" +
    "  policy control these tables. Keep it only if you intend it, and review the\n" +
    `  result with: servicenow-mcp-setup policy show --profile ${profile}\n`
  );
}
