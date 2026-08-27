/**
 * sn_profile -- Read-only, non-secret diagnostics for one named profile.
 *
 * Profile creation, modification, and named mapping are operator-owned
 * configuration operations. There is no default or active selection state,
 * and administration is intentionally not exposed to MCP tools.
 *
 * @module tools/profile
 */

import { z } from "zod";

import type { AuthType } from "../config.js";
import type { ExecutionContext } from "../execution-context.js";
import { ok } from "../utils.js";

export interface ProfileDiagnostic {
  instance: string;
  authType: AuthType;
}

export const definition = {
  name: "sn_profile",
  description:
    "Inspect non-secret metadata for an explicitly selected ServiceNow profile. " +
    "Profiles are created, modified, and selected out of band by the operator; " +
    "this tool never changes profile configuration or reveals credentials.",
  annotations: {
    title: "Inspect instance profile",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** sn_profile has no tool-specific input beyond the shared required profile. */
export const schema = z.object({});

/** Format the already-resolved, deliberately non-secret profile projection. */
export async function handler(
  profile: ProfileDiagnostic,
  context: ExecutionContext
) {
  return ok({
    name: context.profile.name,
    instance: profile.instance,
    auth_type: profile.authType,
  });
}
