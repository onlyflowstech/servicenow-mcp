#!/usr/bin/env node

/**
 * @onlyflows/servicenow-mcp -- The most comprehensive ServiceNow MCP server.
 *
 * Supports multi-instance profiles: configure named profiles via environment
 * variables (SN_PROFILES JSON or SN_PROFILE_<name>_* vars) and select them
 * per-tool-call with the `profile` parameter, or use `sn_profile` to
 * list / switch / inspect profiles at runtime.
 *
 * Published by OnlyFlows (https://onlyflows.tech)
 *
 * @module index
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ProfileManager } from "./profile-manager.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";

async function main() {
  // Initialise profile manager (loads all profiles from env)
  const profileManager = new ProfileManager();

  // Basic-auth deprecation nudge (stderr; stdout is reserved for MCP).
  // ServiceNow's inbound Basic Auth restriction program can hard-401
  // basic-auth API requests per instance at any time.
  const basicProfiles = profileManager.getBasicAuthProfileNames();
  if (basicProfiles.length > 0) {
    console.error(
      `[servicenow-mcp] WARNING: profile(s) ${basicProfiles.map((n) => `"${n}"`).join(", ")} ` +
        `use basic auth, which ServiceNow's inbound Basic Auth restriction program ` +
        `is phasing out (KB3096078). Recommended: set authType "oauth" on these profiles.`
    );
  }

  // Create MCP server
  const server = new Server(
    {
      name: "@onlyflows/servicenow-mcp",
      version: "1.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getToolDefinitions() };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return executeTool(name, args ?? {}, profileManager);
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  const activeProfile = profileManager.getActiveProfileName();
  const activeConfig = profileManager.getConfig();
  const profileNames = profileManager.listProfiles();
  const profileInfo =
    profileNames.length > 1
      ? ` [${profileNames.length} profiles, active: ${activeProfile}]`
      : "";
  console.error(
    `@onlyflows/servicenow-mcp v1.1.0 started -- ${activeConfig.instance} (${getToolDefinitions().length} tools)${profileInfo}`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
