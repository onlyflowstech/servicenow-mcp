/** Dedicated append-only incident journal tool modules. */

import { z } from "zod";

import {
  incidentJournalContentSchema,
  type IncidentJournalField,
} from "../incident-journal-policy.js";
import {
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";
import { resolveToolTableAccess } from "../tool-table-access.js";
import { ok } from "../utils.js";
import {
  envelopeCompatibilityResult,
  productionToolOutputSchemas,
} from "./result-envelope.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  type ToolDefinition,
} from "./tool-module.js";

const inputSchema = withRequiredProfile(
  z
    .object({
      sys_id: serviceNowSysIdSchema.describe(
        "The 32-hex sys_id of the incident to append to."
      ),
      content: incidentJournalContentSchema,
    })
    .strict()
);

type IncidentJournalToolName =
  | "sn_incident_add_comment"
  | "sn_incident_add_work_note";

type IncidentJournalToolDefinition = ToolDefinition & {
  readonly name: IncidentJournalToolName;
};

function definition(
  name: IncidentJournalToolName,
  title: string,
  description: string
): IncidentJournalToolDefinition {
  return Object.freeze({
    name,
    description,
    annotations: Object.freeze({
      title,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    }),
  });
}

function journalModule(
  field: IncidentJournalField,
  toolDefinition: IncidentJournalToolDefinition
) {
  const outputSchema =
    field === "comments"
      ? productionToolOutputSchemas.sn_incident_add_comment
      : productionToolOutputSchemas.sn_incident_add_work_note;
  return defineServiceNowToolModule({
    runtime: "servicenow",
    definition: toolDefinition,
    inputSchema,
    outputSchema,
    requirements: {
      permissions: ["write"],
      tables: { kind: "static", names: ["incident"] },
      apis: ["table"],
      fieldPolicies: ["write"],
      capabilities: [`incident:journal:${field}`],
    },
    resolveAccess: (args) =>
      resolveToolTableAccess(toolDefinition.name, args),
    handler: async (args, services) => {
      await services.serviceNow.patch(
        `/api/now/table/incident/${serviceNowSysIdPathSegment(args.sys_id)}`,
        { [field]: args.content }
      );
      return envelopeCompatibilityResult(
        toolDefinition.name,
        args,
        ok({
          status: "appended",
          sys_id: args.sys_id,
          journal_field: field,
        })
      );
    },
  });
}

export const incidentCommentToolModule = journalModule(
  "comments",
  definition(
    "sn_incident_add_comment",
    "Add incident comment",
    "Append one bounded customer-visible comment to an authorized incident."
  )
);

export const incidentWorkNoteToolModule = journalModule(
  "work_notes",
  definition(
    "sn_incident_add_work_note",
    "Add incident work note",
    "Append one bounded internal work note to an authorized incident."
  )
);

export const incidentJournalInputSchema = inputSchema;
