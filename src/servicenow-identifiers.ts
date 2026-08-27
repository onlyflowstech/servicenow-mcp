/** Safe canonical identifiers for dynamic ServiceNow URL path segments. */

import { z } from "zod";

const SYS_ID = /^[0-9a-f]{32}$/u;

export const serviceNowSysIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SYS_ID, "must be an exact 32-character hexadecimal ServiceNow sys_id");

/** Validate upstream-derived identifiers before interpolating a URL path. */
export function normalizeServiceNowSysId(candidate: unknown): string {
  return serviceNowSysIdSchema.parse(candidate);
}

/** Encode only after semantic validation, preserving one path segment. */
export function serviceNowSysIdPathSegment(candidate: unknown): string {
  return encodeURIComponent(normalizeServiceNowSysId(candidate));
}
