/**
 * Tool registry — exports all 17 ServiceNow tools.
 *
 * @module tools
 */

import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";

import * as query from "./query.js";
import * as get from "./get.js";
import * as create from "./create.js";
import * as update from "./update.js";
import * as del from "./delete.js";
import * as batch from "./batch.js";
import * as aggregate from "./aggregate.js";
import * as schema from "./schema.js";
import * as health from "./health.js";
import * as attach from "./attach.js";
import * as relationships from "./relationships.js";
import * as syslog from "./syslog.js";
import * as codesearch from "./codesearch.js";
import * as discover from "./discover.js";
import * as atf from "./atf.js";
import * as nl from "./nl.js";
import * as script from "./script.js";

export interface ToolModule {
  definition: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  schema: import("zod").ZodType;
  handler: (
    args: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    client: ServiceNowClient,
    config: ServiceNowConfig
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

export const tools: ToolModule[] = [
  query,
  get,
  create,
  update,
  del,
  batch,
  aggregate,
  schema,
  health,
  attach,
  relationships,
  syslog,
  codesearch,
  discover,
  atf,
  nl,
  script,
];

/**
 * Get tool definitions for ListTools response.
 */
export function getToolDefinitions() {
  return tools.map((t) => t.definition);
}

/**
 * Find a tool by name and execute it.
 */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Validate args with Zod
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    return {
      content: [{ type: "text", text: `Invalid arguments: ${errors}` }],
      isError: true,
    };
  }

  return tool.handler(parsed.data, client, config);
}
