/**
 * Tool registry -- exports all ServiceNow tools.
 *
 * Each tool handler receives a resolved (client, config) pair.
 * The `executeTool` function accepts a `ProfileManager` and uses
 * the optional `profile` argument to select the right instance.
 *
 * @module tools
 */

import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ProfileManager } from "../profile-manager.js";

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
import * as profile from "./profile.js";

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

/**
 * Tools whose handler signature differs from ToolModule (e.g. sn_profile
 * receives ProfileManager directly). Handled as a special case in executeTool.
 */
export interface ProfileToolModule {
  definition: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  schema: import("zod").ZodType;
  handler: (
    args: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    profileManager: ProfileManager
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

/** Standard tools that receive (args, client, config). */
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

/** Tools that receive (args, profileManager) instead of (args, client, config). */
export const profileTools: ProfileToolModule[] = [
  profile,
];

/**
 * Get tool definitions for ListTools response.
 * Combines standard tools and profile-aware tools.
 */
export function getToolDefinitions() {
  return [
    ...tools.map((t) => t.definition),
    ...profileTools.map((t) => t.definition),
  ];
}

/**
 * Find a tool by name and execute it.
 *
 * - Extracts the optional `profile` argument to select the target instance.
 * - For standard tools: resolves (client, config) via ProfileManager and
 *   forwards the remaining args to the handler.
 * - For profile-management tools (sn_profile): passes ProfileManager directly.
 */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  profileManager: ProfileManager
) {
  // -- Check profile-aware tools first (sn_profile) --
  const profileTool = profileTools.find((t) => t.definition.name === name);
  if (profileTool) {
    const parsed = profileTool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const errors = parsed.error.issues
        .map((i: { path: (string | number)[]; message: string }) =>
          `${i.path.join(".")}: ${i.message}`
        )
        .join(", ");
      return {
        content: [{ type: "text", text: `Invalid arguments: ${errors}` }],
        isError: true,
      };
    }
    return profileTool.handler(parsed.data, profileManager);
  }

  // -- Standard tools --
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
      .map((i: { path: (string | number)[]; message: string }) =>
        `${i.path.join(".")}: ${i.message}`
      )
      .join(", ");
    return {
      content: [{ type: "text", text: `Invalid arguments: ${errors}` }],
      isError: true,
    };
  }

  // Extract and remove the optional `profile` selector before forwarding
  const { profile: profileName, ...cleanedArgs } = parsed.data as Record<string, unknown>;

  // Resolve client + config for the selected (or default) profile
  const client = profileManager.getClient(profileName as string | undefined);
  const config = profileManager.getConfig(profileName as string | undefined);

  return tool.handler(cleanedArgs, client, config);
}
