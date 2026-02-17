import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";

export const definition = {
  name: "sn_schema",
  description:
    "Get the schema (field definitions) for a ServiceNow table. Returns field names, types, max lengths, mandatory flags, and reference targets.",
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name (e.g. incident)",
      },
      fields_only: {
        type: "boolean",
        description: "If true, return only a sorted list of field names",
      },
    },
    required: ["table"],
  },
};

export const schema = z.object({
  table: z.string(),
  fields_only: z.boolean().optional().default(false),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    const resp = await client.get("/api/now/table/sys_dictionary", {
      sysparm_query: `name=${args.table}^internal_type!=collection`,
      sysparm_fields: "element,column_label,internal_type,max_length,mandatory,reference",
      sysparm_limit: "500",
      sysparm_display_value: "true",
    });

    const results = (resp.result || []).filter(
      (r: Record<string, string>) => r.element && r.element !== ""
    );

    if (args.fields_only) {
      const fieldNames = results
        .map((r: Record<string, string>) => r.element)
        .sort();
      return ok(fieldNames);
    }

    const fields = results
      .map((r: Record<string, string>) => ({
        field: r.element,
        label: r.column_label,
        type: r.internal_type,
        max_length: r.max_length,
        mandatory: r.mandatory,
        reference: r.reference || null,
      }))
      .sort((a: { field: string }, b: { field: string }) => a.field.localeCompare(b.field));

    return ok(fields);
  } catch (error) {
    return err(formatError(error));
  }
}
