import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err } from "../utils.js";

export const definition = {
  name: "sn_script",
  description:
    "Execute a background script on the ServiceNow instance. Runs server-side GlideRecord/GlideSystem JavaScript and returns output from gs.print() calls. Requires admin role. NOTE: This tool requires the optional Playwright dependency.",
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
    },
    required: ["code"],
  },
};

export const schema = z.object({
  code: z.string(),
  scope: z.string().optional().default("global"),
  timeout: z.number().optional().default(30),
  confirm: z.boolean().optional().default(false),
});

export async function handler(
  _args: z.infer<typeof schema>,
  _client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  return ok({
    status: "unavailable",
    message:
      "sn_script requires the optional Playwright dependency for browser-based script execution.\n\n" +
      "ServiceNow does not expose a REST API for background scripts — execution requires\n" +
      "automating the sys.scripts.do page via a headless browser.\n\n" +
      "To enable this tool, install Playwright:\n" +
      "  npm install playwright\n" +
      "  npx playwright install chromium\n\n" +
      "This will be fully implemented in a future release (SNS-39).",
  });
}
