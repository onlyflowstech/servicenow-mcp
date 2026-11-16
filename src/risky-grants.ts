/**
 * Tables where a write changes who may do what or what runs: role
 * assignments, group membership, role inheritance, delegations, ACLs,
 * approvals, server-side scripts, system properties, users and groups,
 * authentication settings, and the MID Server queue.
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
  // Server-side code: a write to their script fields is code execution, on
  // the instance (or, for ecc_agent_script_include and sa_pattern, on MID
  // Server hosts). Flows and flow actions can carry script steps, and
  // dictionary entries can carry calculated-field scripts.
  "sys_script",
  "sys_script_include",
  "sysauto_script",
  "sys_trigger",
  "sys_ui_script",
  "sys_script_client",
  "sys_ws_operation",
  "sys_module",
  "sys_processor",
  "sysevent_script_action",
  "sys_script_fix",
  "sys_script_email",
  "sys_ui_action",
  "sys_ui_page",
  "sys_ui_macro",
  "sp_widget",
  "sysevent_in_email_action",
  "sys_transform_map",
  "sys_transform_script",
  "ecc_agent_script_include",
  "sysevent_email_action",
  "sys_dictionary",
  "sa_pattern",
  "sys_hub_flow",
  "sys_hub_action_type_definition",
  // Configuration, identity and authentication.
  "sys_properties",
  "sys_user",
  "sys_user_group",
  "oauth_entity",
  "oauth_credential",
  "sys_certificate",
  "sys_auth_profile",
  "sys_auth_profile_basic",
  // The MID Server queue: an output record can run commands on MID Server
  // hosts. Its numbered rotation shards (ecc_queue0000, ...) count too.
  "ecc_queue",
]);

const RISKY_SET: ReadonlySet<string> = new Set(RISKY_WRITE_TABLES);

/** Risky tables the platform rotates into shards: the base name, then digits only. */
const RISKY_SHARD_BASES: ReadonlySet<string> = new Set(["ecc_queue"]);

/**
 * `table` without its trailing digits, or undefined when it has none or is
 * all digits. A single backward scan, so it is linear in the name's length.
 */
function withoutShardSuffix(table: string): string | undefined {
  let end = table.length;
  while (end > 0) {
    const code = table.charCodeAt(end - 1);
    if (code < 48 || code > 57) break;
    end -= 1;
  }
  return end === table.length || end === 0 ? undefined : table.slice(0, end);
}

function isRiskyTable(table: string): boolean {
  if (RISKY_SET.has(table)) return true;
  const base = withoutShardSuffix(table);
  return base !== undefined && RISKY_SHARD_BASES.has(base);
}

/** True for `ecc_queue` and its numbered rotation shards. */
export function isMidServerQueue(table: string): boolean {
  return table === "ecc_queue" || withoutShardSuffix(table) === "ecc_queue";
}

/** The note shown wherever a risky write grant reaches the MID Server queue. */
export const MID_SERVER_QUEUE_NOTE = "Records written to ecc_queue can run commands on MID Server hosts.";

/** The risky tables among `writeTables`; `"*"` covers all of them. */
export function riskyWriteTables(writeTables: readonly string[]): readonly string[] {
  if (writeTables.includes("*")) return RISKY_WRITE_TABLES;
  return Object.freeze(writeTables.filter(isRiskyTable).sort());
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
    (risky.some(isMidServerQueue) ? `  ${MID_SERVER_QUEUE_NOTE}\n` : "") +
    "  The grant is still allowed: only this profile's table grant and field\n" +
    "  policy control these tables. Keep it only if you intend it, and review the\n" +
    `  result with: servicenow-mcp-setup policy show --profile ${profile}\n`
  );
}
