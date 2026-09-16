import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type ServerResult,
} from "@modelcontextprotocol/sdk/types.js";

import { VERSION } from "./version.js";

export type LowLevelMcpRegistrationSurface = Pick<
  McpServer["server"],
  "registerCapabilities" | "setRequestHandler"
>;

/** Registration APIs exposed while the server is being constructed. */
export interface McpServerRegistrationSurface {
  readonly server: LowLevelMcpRegistrationSurface;
  readonly registerPrompt: McpServer["registerPrompt"];
  readonly registerResource: McpServer["registerResource"];
  readonly registerTool: McpServer["registerTool"];
}

/**
 * Registers application behavior on a newly constructed server.
 *
 * The dependency container is shallow-readonly at this boundary: the registrar
 * cannot replace services, while the injected service objects remain usable as
 * their own interfaces define. The generic deliberately does not prescribe the
 * future configuration, policy, logging, or lifecycle ports.
 */
export type McpServerRegistrar<TDependencies extends object> = (
  server: McpServerRegistrationSurface,
  dependencies: Readonly<TDependencies>
) => void | Promise<void>;

export interface CreateMcpServerOptions<TDependencies extends object> {
  /** Explicit application-owned dependencies; there are no factory defaults. */
  readonly dependencies: Readonly<TDependencies>;
  /** Registration that must complete before the server is returned. */
  readonly register: McpServerRegistrar<TDependencies>;
}

const REGISTRAR_CONNECTED_MESSAGE =
  "McpServer registrar must not connect the server during construction";

/** Build a runtime view that exposes registration but no lifecycle controls. */
function createRegistrationSurface(server: McpServer): McpServerRegistrationSurface {
  // Function.bind cannot preserve the SDK's generic/overloaded signatures in
  // TypeScript, so each assertion is intentionally limited to its source method.
  const lowLevelSurface: LowLevelMcpRegistrationSurface = Object.freeze({
    registerCapabilities: server.server.registerCapabilities.bind(
      server.server
    ) as McpServer["server"]["registerCapabilities"],
    setRequestHandler: server.server.setRequestHandler.bind(
      server.server
    ) as McpServer["server"]["setRequestHandler"],
  });

  return Object.freeze({
    server: lowLevelSurface,
    registerPrompt: server.registerPrompt.bind(server) as McpServer["registerPrompt"],
    registerResource: server.registerResource.bind(server) as McpServer["registerResource"],
    registerTool: server.registerTool.bind(server) as McpServer["registerTool"],
  });
}

/**
 * Serve every tool schema without a `$schema` dialect declaration.
 *
 * The SDK converts zod schemas with zod-to-json-schema, which stamps each one
 * `"$schema": "http://json-schema.org/draft-07/schema#"`. Clients built on the
 * current MCP spec validate with a JSON Schema 2020-12 validator and refuse a
 * schema that names draft-07, which disabled every tool (SNSDK-86). With no
 * declaration, those clients read a schema as 2020-12 and older ones read it
 * as draft-07. Ours use only keywords that mean the same in both, and a
 * contract test holds them to that. Declaring 2020-12 instead would break the
 * older clients.
 *
 * The SDK installs its tools/list handler through `setRequestHandler` when the
 * first tool is registered, so the handler is wrapped as it is installed; no
 * SDK internals are read.
 */
function serveDialectNeutralToolSchemas(server: McpServer): void {
  const lowLevel = server.server;
  const install = lowLevel.setRequestHandler.bind(lowLevel);
  const setRequestHandler: typeof lowLevel.setRequestHandler = (requestSchema, handler) => {
    // Identity against the SDK's own schema object, the one McpServer passes.
    if ((requestSchema as unknown) !== ListToolsRequestSchema) {
      install(requestSchema, handler);
      return;
    }
    install(requestSchema, async (request, extra) =>
      withoutSchemaDialects(await handler(request, extra))
    );
  };
  lowLevel.setRequestHandler = setRequestHandler;
}

function withoutSchemaDialects(result: ServerResult): ServerResult {
  if (!("tools" in result) || !Array.isArray(result.tools)) return result;
  return {
    ...result,
    tools: result.tools.map((tool) => ({
      ...tool,
      inputSchema: withoutDialect(tool.inputSchema),
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: withoutDialect(tool.outputSchema) }),
    })),
  };
}

function withoutDialect<TSchema extends object>(schema: TSchema): TSchema {
  if (!Object.hasOwn(schema, "$schema")) return schema;
  const copy: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  delete copy.$schema;
  return copy as TSchema;
}

/** Close a connected construction candidate and verify that it disconnected. */
async function closeConnectedCandidate(server: McpServer): Promise<void> {
  await server.close();
  if (server.isConnected()) {
    throw new TypeError("McpServer construction cleanup did not disconnect the server");
  }
}

/**
 * Construct and fully register a fresh, unconnected high-level server.
 *
 * Transport ownership belongs to the caller. This factory does not import,
 * construct, connect, listen, install process handlers, or orchestrate shutdown
 * for any transport or runtime.
 */
export async function createMcpServer<TDependencies extends object>(
  options: CreateMcpServerOptions<TDependencies>
): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "@onlyflows/servicenow-mcp",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    }
  );

  // Before registration: the SDK installs tools/list on the first registerTool.
  serveDialectNeutralToolSchemas(server);
  const registrationSurface = createRegistrationSurface(server);
  try {
    await options.register(registrationSurface, options.dependencies);
  } catch (registrationError) {
    if (server.isConnected()) {
      try {
        await closeConnectedCandidate(server);
      } catch (cleanupError) {
        throw new AggregateError(
          [registrationError, cleanupError],
          "McpServer registration and connected-server cleanup both failed"
        );
      }
    }
    throw registrationError;
  }

  if (server.isConnected()) {
    const lifecycleError = new TypeError(REGISTRAR_CONNECTED_MESSAGE);
    try {
      await closeConnectedCandidate(server);
    } catch (cleanupError) {
      throw new AggregateError(
        [lifecycleError, cleanupError],
        "McpServer registrar connected the server and cleanup failed"
      );
    }
    throw lifecycleError;
  }

  return server;
}
