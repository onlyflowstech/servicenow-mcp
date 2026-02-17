#!/usr/bin/env node

/**
 * @onlyflows/servicenow-mcp — The most comprehensive ServiceNow MCP server.
 *
 * 17 tools for full CRUD, CMDB graph traversal, background scripts,
 * ATF testing, and more.
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

import { loadConfig } from "./config.js";
import { ServiceNowClient } from "./client.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";

async function main() {
  // Load configuration
  const config = loadConfig();
  const client = new ServiceNowClient(config);

  // Create MCP server
  const server = new Server(
    {
      name: "@onlyflows/servicenow-mcp",
      version: "1.0.0",
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
    return executeTool(name, args ?? {}, client, config);
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(
    `@onlyflows/servicenow-mcp v1.0.0 started — ${config.instance} (${getToolDefinitions().length} tools)`
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
