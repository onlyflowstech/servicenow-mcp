import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { err } from "../utils.js";

export const definition = {
  name: "sn_script",
  description:
    "NOT YET SUPPORTED: background script execution is not implemented in this release and every " +
    "call returns an error without executing anything. ServiceNow exposes no REST API for " +
    "background scripts; execution requires UI-endpoint (sys.scripts.do) session authentication, " +
    "which is tracked as separate work (SNS-39). Use sn_query/sn_get/sn_aggregate to read data " +
    "and sn_update/sn_batch to modify records instead.",
  annotations: {
    title: "Run background script (unavailable)",
    // Arbitrary server-side code execution by design: keep the destructive
    // hint even while the handler is a stub that always errors, so clients
    // gate it correctly if/when SNS-39 lands.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      code: {
        type: "string",
        description: "JavaScript code to execute (GlideRecord, GlideSystem, gs.print(), etc.)",
      },
      scope: {
        type: "string",
        description: "Application scope to run in (default: global)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default 30, max 300)",
      },
      confirm: {
        type: "boolean",
        description:
          "Required for scripts containing destructive keywords (deleteRecord, deleteMultiple, setWorkflow(false))",
      },
      profile: {
        type: "string",
        description: "Named profile to use. Defaults to active profile.",
      },
    },
    required: ["code"],
  },
};

export const schema = z.object({
  code: z.string(),
  scope: z.string().optional().default("global"),
  timeout: z.number().optional().default(30),
  confirm: z.boolean().optional().default(false),
  profile: z.string().optional().describe("Named profile to use. Defaults to active profile."),
});

export async function handler(
  _args: z.infer<typeof schema>,
  _client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  return err(
    "sn_script is not yet supported -- no script was executed. ServiceNow has no REST API for " +
      "background scripts; execution requires automating the sys.scripts.do UI endpoint with " +
      "session authentication, which is a separate work item (SNS-39). Alternatives: read data " +
      "with sn_query/sn_get/sn_aggregate; modify records with sn_update or sn_batch (dry-run by " +
      "default)."
  );
}
