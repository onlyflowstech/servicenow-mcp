/**
 * ATF execution grant carried on the resolved effective policy, and the
 * classified denial a tool raises from its access resolver when the profile
 * withholds that grant.
 *
 * Running an ATF suite executes its steps on the instance, and a step can
 * change any table the test touches. No table-only plan can describe that
 * side effect, so execution is its own opt-in: omission denies it.
 *
 * @module atf-policy
 */

import type { ResolvedEffectivePolicyReference } from "./execution-context.js";

/** The ATF slice an EffectivePolicyProvider may state. */
export interface AtfExecutionPolicyInput {
  readonly execute?: boolean;
  readonly allowScriptSteps?: boolean;
}

/** Normalized, frozen ATF grants on a resolved policy. */
export interface AtfExecutionPolicy {
  readonly execute: boolean;
  readonly allowScriptSteps: boolean;
}

export const DENY_ALL_ATF_EXECUTION: AtfExecutionPolicy = Object.freeze({
  execute: false,
  allowScriptSteps: false,
});

/**
 * Normalize a provider-supplied ATF policy. Each property is read once, and
 * anything other than an explicit boolean `true` leaves the grant off. A
 * non-boolean value is a provider defect, so it fails context creation.
 */
export function createAtfExecutionPolicy(
  candidate: AtfExecutionPolicyInput | undefined
): AtfExecutionPolicy {
  if (candidate === undefined) return DENY_ALL_ATF_EXECUTION;
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("ATF execution policy must be an object");
  }
  const execute: unknown = candidate.execute;
  const allowScriptSteps: unknown = candidate.allowScriptSteps;
  if (
    (execute !== undefined && typeof execute !== "boolean") ||
    (allowScriptSteps !== undefined && typeof allowScriptSteps !== "boolean")
  ) {
    throw new TypeError("ATF execution policy grants must be booleans");
  }
  return Object.freeze({
    execute: execute === true,
    allowScriptSteps: allowScriptSteps === true,
  });
}

export type AtfPolicyFailureReason = "execution_not_enabled";

const ISSUED_ATF_POLICY_ERRORS = new WeakSet<object>();

export class AtfPolicyError extends Error {
  readonly reason: AtfPolicyFailureReason;

  constructor(reason: AtfPolicyFailureReason) {
    super("ATF operation denied by policy");
    this.name = "AtfPolicyError";
    this.reason = reason;
    ISSUED_ATF_POLICY_ERRORS.add(this);
    Object.freeze(this);
  }
}

export function isAtfPolicyError(error: unknown): error is AtfPolicyError {
  return (
    typeof error === "object" &&
    error !== null &&
    ISSUED_ATF_POLICY_ERRORS.has(error)
  );
}

/**
 * Fixed operator guidance. It names the configuration key that grants the
 * operation, and keeps the "denied by policy" phrase other denials share.
 */
export function atfPolicyDenialMessage(
  _error: AtfPolicyError,
  tool?: string
): string {
  const subject =
    typeof tool === "string" && tool.trim() !== "" ? tool.trim() : "This tool";
  return (
    `ATF execution denied by policy: ${subject} runs ATF tests, and this profile ` +
    `does not enable ATF execution. Running a suite executes its steps on the ` +
    `instance and can change any data those steps touch. To allow it, set ` +
    `"atf": { "execute": true } on the profile (or SN_ATF_EXECUTE=true for an ` +
    `environment-only profile), then restart the MCP client.`
  );
}

/**
 * Call from a module's resolveAccess before returning its plan, so a profile
 * without the grant is rejected before any configuration or client exists.
 */
export function requireAtfExecution(
  policy: Pick<ResolvedEffectivePolicyReference, "atf">
): void {
  if (policy.atf?.execute !== true) {
    throw new AtfPolicyError("execution_not_enabled");
  }
}
