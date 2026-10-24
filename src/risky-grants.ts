/**
 * Tables where a write changes who may do what: role assignments, group
 * membership, role inheritance, delegations, ACLs, and approvals.
 *
 * This list drives warnings only. It denies nothing: role and approval tables
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
]);

const RISKY_SET: ReadonlySet<string> = new Set(RISKY_WRITE_TABLES);

/** The risky tables among `writeTables`; `"*"` covers all of them. */
export function riskyWriteTables(writeTables: readonly string[]): readonly string[] {
  if (writeTables.includes("*")) return RISKY_WRITE_TABLES;
  return Object.freeze(writeTables.filter((table) => RISKY_SET.has(table)).sort());
}

/**
 * The warning printed when a grant gives write access on role or approval
 * tables, or undefined when it does not. `granted` is what the grant added.
 */
export function riskyGrantWarning(granted: readonly string[]): string | undefined {
  const risky = riskyWriteTables(granted);
  if (risky.length === 0) return undefined;
  const wildcard = granted.includes("*");
  return (
    `WARNING: this grant gives write access on role and approval tables: ${risky.join(", ")}` +
    `${wildcard ? ' (through the "*" write wildcard, which covers every table)' : ""}.\n` +
    "  Writes to these tables change who holds roles, who is in a group, and who\n" +
    "  approves. An agent using this profile could grant itself access or approve\n" +
    "  its own changes. The grant is still allowed: only this profile's table grant\n" +
    "  and field policy control these tables. Keep it only if you intend it, and\n" +
    "  review the result with: servicenow-mcp-setup policy show --profile <name>\n"
  );
}
