/**
 * Shared journal content bounds and the dedicated incident journal tools'
 * argument policy.
 *
 * The content schema bounds every journal write: the dedicated incident
 * tools, and `comments`/`work_notes` written through the generic write tools
 * on any table (see write-value-policy.ts). Generic journal writes are no
 * longer rejected by name; the configured field policy decides whether a
 * profile may write them.
 */

import { z } from "zod";

import { serviceNowSysIdSchema } from "./servicenow-identifiers.js";

export const INCIDENT_JOURNAL_MAX_CHARACTERS = 8_000;
export const INCIDENT_JOURNAL_MAX_UTF8_BYTES = 16_384;

export type IncidentJournalField = "comments" | "work_notes";

const JOURNAL_TOOLS: Readonly<Record<IncidentJournalField, string>> =
  Object.freeze({
    comments: "sn_incident_add_comment",
    work_notes: "sn_incident_add_work_note",
  });
const ISSUED_INCIDENT_JOURNAL_POLICY_ERRORS = new WeakSet<object>();
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const UNSAFE_JOURNAL_CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u;

export const incidentJournalContentSchema = z
  .string()
  // A cheap UTF-16 bound prevents an unnecessarily large character scan.
  .max(INCIDENT_JOURNAL_MAX_UTF8_BYTES)
  .superRefine((value, context) => {
    if (value.trim().length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content must contain a non-whitespace character",
      });
    }
    if (UNPAIRED_SURROGATE.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content must contain valid paired Unicode characters",
      });
    }
    if (UNSAFE_JOURNAL_CONTROL.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "content contains an unsafe control character; newline, carriage return, and tab are allowed",
      });
    }
    if ([...value].length > INCIDENT_JOURNAL_MAX_CHARACTERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `content must not exceed ${INCIDENT_JOURNAL_MAX_CHARACTERS} characters`,
      });
    }
    if (Buffer.byteLength(value, "utf8") > INCIDENT_JOURNAL_MAX_UTF8_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `content must not exceed ${INCIDENT_JOURNAL_MAX_UTF8_BYTES} UTF-8 bytes`,
      });
    }
  })
  .describe(
    `Journal text; 1-${INCIDENT_JOURNAL_MAX_CHARACTERS} characters and at most ` +
      `${INCIDENT_JOURNAL_MAX_UTF8_BYTES} UTF-8 bytes.`
  );

export class IncidentJournalPolicyError extends Error {
  /**
   * `generic_journal_update` is no longer issued: generic journal writes are
   * decided by field policy. The reason stays in the type so the dispatcher's
   * existing classification branches keep compiling.
   */
  readonly reason: "generic_journal_update" | "invalid_journal_content";
  readonly field?: IncidentJournalField;

  constructor(
    reason: "generic_journal_update" | "invalid_journal_content",
    field?: IncidentJournalField
  ) {
    super("Incident journal policy rejected the request");
    this.name = "IncidentJournalPolicyError";
    this.reason = reason;
    this.field = field;
    ISSUED_INCIDENT_JOURNAL_POLICY_ERRORS.add(this);
    Object.freeze(this);
  }
}

export function isIncidentJournalPolicyError(
  error: unknown
): error is IncidentJournalPolicyError {
  return (
    typeof error === "object" &&
    error !== null &&
    ISSUED_INCIDENT_JOURNAL_POLICY_ERRORS.has(error)
  );
}

/**
 * Safe fixed guidance; caller-controlled journal text is never interpolated.
 * Only the dispatcher's `generic_journal_update` branch uses it, and nothing
 * issues that reason any more.
 */
export function incidentJournalMigrationMessage(
  field: IncidentJournalField,
  tool?: string
): string {
  const rejected =
    typeof tool === "string" && tool.trim() !== ""
      ? `${tool.trim()} cannot write append-only incident field ${field}.`
      : `Generic writes cannot set append-only incident field ${field}.`;
  // At create time the record has no sys_id yet, so telling the caller to pass
  // one is advice they cannot follow. Sequence the two calls instead.
  const remedy =
    tool === "sn_create"
      ? `Create the record first, then use ${JOURNAL_TOOLS[field]} with the new sys_id and content.`
      : `Use ${JOURNAL_TOOLS[field]} with sys_id and content.`;
  return `${rejected} ${remedy}`;
}

/** Defense-in-depth normalization for the fixed incident journal modules. */
export function prepareIncidentJournalArguments(
  args: Readonly<Record<string, unknown>>
): Readonly<{ sys_id: string; content: string }> {
  const identity = serviceNowSysIdSchema.safeParse(args.sys_id);
  const content = incidentJournalContentSchema.safeParse(args.content);
  if (!identity.success || !content.success) {
    throw new IncidentJournalPolicyError("invalid_journal_content");
  }
  return Object.freeze({ sys_id: identity.data, content: content.data });
}
