/**
 * Background script execution -- FUTURE WORK, INTENTIONALLY NOT REGISTERED.
 *
 * This module is deliberately absent from the published tool catalog in
 * `./catalog.ts`, so `sn_script` is neither advertised by `tools/list` nor
 * callable via `tools/call`; the MCP SDK answers an unknown-tool call with a
 * standard JSON-RPC "Tool sn_script not found" error. Shipping a tool whose
 * only behaviour is an error -- while carrying `destructiveHint: true` -- is a
 * usability and trust problem, so 2.0 does not expose it at all.
 *
 * The implementation is kept in the tree so the design work is not lost.
 * ServiceNow exposes no REST API for background scripts; execution requires
 * automating the `sys.scripts.do` UI endpoint with session authentication,
 * tracked as SNS-39. When that lands, re-register the module in
 * `./catalog.ts`, restore its `sn_script` entries in `./result-envelope.ts`
 * and `../tool-table-access.ts`, and bump the published tool count.
 *
 * `test/script-stub.test.ts` pins this module as unregistered.
 */

import { z } from "zod";
import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
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
};

export const schema = z.object({
  code: z.string().describe("JavaScript code to execute (GlideRecord, GlideSystem, gs.print(), etc.)"),
  scope: z.string().optional().default("global").describe("Application scope to run in (default: global)"),
  timeout: z.number().optional().default(30).describe("Timeout in seconds (default 30, max 300)"),
  confirm: z.boolean().optional().default(false).describe("Required for scripts containing destructive keywords (deleteRecord, deleteMultiple, setWorkflow(false))"),
});

export async function handler(
  _args: z.infer<typeof schema>,
  _client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  return err(
    "sn_script is not yet supported -- no script was executed. ServiceNow has no REST API for " +
      "background scripts; execution requires automating the sys.scripts.do UI endpoint with " +
      "session authentication, which is a separate work item (SNS-39). Alternatives: read data " +
      "with sn_query/sn_get/sn_aggregate; modify records with sn_update or sn_batch (dry-run by " +
      "default)."
  );
}
