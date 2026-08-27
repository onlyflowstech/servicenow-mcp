/**
 * High-level ServiceNow tool registry.
 *
 * Tool-local Zod schemas describe handler inputs. Registration composes each
 * one with the required profile selector, making the resulting Zod object the
 * single source for both MCP discovery and runtime validation.
 *
 * @module tools
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { types as utilTypes } from "node:util";

import {
  createServiceNowOperations,
  runWithServiceNowRequestSignal,
  type ServiceNowClient,
} from "../client.js";
import type { ServiceNowConfig } from "../config.js";
import {
  ENCODED_QUERY_MIGRATION_MESSAGE,
  isEncodedQueryPolicyError,
} from "../encoded-query-policy.js";
import { isCredentialSourceDescriptor } from "../profile-credentials.js";
import {
  incidentJournalMigrationMessage,
  isIncidentJournalPolicyError,
} from "../incident-journal-policy.js";
import {
  createAuditRecord,
  createExecutionContext,
  createPreContextAuditRecord,
  emitAudit,
  emitPreContextAudit,
  fallbackRequestMetadata,
  immutableRequestMetadata,
  requestCancellationAuditReason,
  type ExecutionContext,
  type ExecutionContextDependencies,
  type PreContextAuditRecord,
  type RequestMetadata,
  type ToolAuditRecord,
  type ToolAuditDisposition,
} from "../execution-context.js";
import {
  normalizeInstanceUrl,
  type Profile,
  type ProfileManager,
} from "../profile-manager.js";
import type { McpServerRegistrationSurface } from "../server.js";
import { authorizeTableAccessPlan } from "../table-policy.js";
import { createToolError, formatToolError } from "../tool-error.js";
import { err } from "../utils.js";

import { allToolModules } from "./catalog.js";

import * as aggregate from "./aggregate.js";
import * as atf from "./atf.js";
import * as attach from "./attach.js";
import * as batch from "./batch.js";
import * as codesearch from "./codesearch.js";
import * as create from "./create.js";
import * as del from "./delete.js";
import * as discover from "./discover.js";
import * as get from "./get.js";
import * as health from "./health.js";
import * as nl from "./nl.js";
import * as profile from "./profile.js";
import * as query from "./query.js";
import * as relationships from "./relationships.js";
import * as schema from "./schema.js";
import * as script from "./script.js";
import * as syslog from "./syslog.js";
import * as update from "./update.js";
import { finalizeEnvelopeResult } from "./result-envelope.js";
import { guardedHandlerResult } from "./handler-result.js";
import {
  profileNameSchema,
  SILENT_TOOL_MODULE_LOGGER,
  snapshotIssuedToolSchema,
  snapshotToolModuleCatalog,
  type ContextOnlyToolModuleContract,
  type ServiceNowToolHandlerServices,
  type ServiceNowToolModuleContract,
  type ToolModuleContract,
  type ToolModuleLogger,
} from "./tool-module.js";

export {
  defineContextOnlyToolModule,
  defineServiceNowToolModule,
  profileNameSchema,
  profileOutputSchema,
  validateToolModuleCatalog,
  withRequiredProfile,
  withResolvedProfileOutput,
} from "./tool-module.js";
export type {
  ContextOnlyToolHandlerServices,
  RequiredToolAnnotations,
  ServiceNowToolHandlerServices,
  ServiceNowToolSettings,
  ToolDefinition,
  ToolModuleContract,
  ToolModuleLogger,
  ToolModuleRequirements,
} from "./tool-module.js";
export {
  envelopeCompatibilityResult,
  finalizeEnvelopeResult,
  productionToolOutputSchemas,
  resultMetadataSchema,
  resultPaginationSchema,
  withStructuredResultEnvelope,
} from "./result-envelope.js";

type RegistrationServer = Pick<McpServerRegistrationSurface, "registerTool">;

type ProfileResolution =
  | {
      kind: "resolved";
      metadata: { readonly authType?: Profile["authType"] };
      canonicalInstance: string;
    }
  | { kind: "unknown" }
  | { kind: "invalid" };

/** Standard tools that resolve a client/config only after profile validation. */
export const tools = [
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
] as const;

/** Read-only diagnostic tool; it deliberately never resolves credentials. */
export const profileTools = [profile] as const;

/** Contract-bearing modules consumed by the registration dispatcher. */
export const toolModules = allToolModules;

export const REGISTERED_TOOL_COUNT = toolModules.length;

/**
 * Register all 20 published tools through the SDK's high-level API.
 *
 * The contract factory retains each module's inferred Zod type while this
 * dispatcher consumes its deliberately erased, runtime-validated boundary.
 */
export async function registerServiceNowTools(
  mcpServer: RegistrationServer,
  profileManager: ProfileManager,
  contextDependencies: ExecutionContextDependencies,
  logger: ToolModuleLogger = SILENT_TOOL_MODULE_LOGGER
): Promise<void> {
  await registerServiceNowToolModules(
    mcpServer,
    profileManager,
    contextDependencies,
    toolModules,
    logger
  );
}

/** Register an explicit catalog after an all-or-nothing contract preflight. */
export async function registerServiceNowToolModules(
  mcpServer: RegistrationServer,
  profileManager: ProfileManager,
  contextDependencies: ExecutionContextDependencies,
  modules: readonly ToolModuleContract[],
  logger: ToolModuleLogger = SILENT_TOOL_MODULE_LOGGER
): Promise<void> {
  if (!logger || typeof logger.write !== "function") {
    throw new TypeError("tool module logger must implement write");
  }
  const catalog = snapshotToolModuleCatalog(modules);
  const plans = Object.freeze(
    catalog.map((module) =>
      Object.freeze({ module, config: toolRegistrationConfig(module) })
    )
  );
  await preflightSdkToolConfigurations(plans);
  for (const { module, config } of plans) {
    if (module.runtime === "servicenow") {
      registerStandardTool(
        mcpServer,
        profileManager,
        contextDependencies,
        module,
        logger,
        config
      );
    } else {
      registerProfileDiagnostic(
        mcpServer,
        profileManager,
        contextDependencies,
        module,
        logger,
        config
      );
    }
  }
}

function toolRegistrationConfig(tool: ToolModuleContract) {
  return Object.freeze({
    description: tool.definition.description,
    inputSchema: snapshotIssuedToolSchema(tool.inputSchema, "input"),
    outputSchema: snapshotIssuedToolSchema(tool.outputSchema, "output"),
    annotations: tool.definition.annotations,
  });
}

type ToolRegistrationPlan = Readonly<{
  module: ToolModuleContract;
  config: ReturnType<typeof toolRegistrationConfig>;
}>;

/** Materialize and discover every frozen config before target writes. */
async function preflightSdkToolConfigurations(
  plans: readonly ToolRegistrationPlan[]
): Promise<void> {
  const preflight = new McpServer(
    { name: "servicenow-tool-catalog-preflight", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  for (const { module, config } of plans) {
    preflight.registerTool(module.definition.name, config, async () => ({
      content: [{ type: "text", text: "registration preflight only" }],
      structuredContent: { profile: "registration-preflight" },
    }));
  }
  const client = new Client({
    name: "servicenow-tool-catalog-preflight-client",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await preflight.connect(serverTransport);
    await client.connect(clientTransport);
    const discovered = (await client.listTools()).tools;
    validateDiscoveredToolConfigurations(plans, discovered);
  } finally {
    await client.close().catch(() => {});
    if (preflight.isConnected()) await preflight.close().catch(() => {});
  }
}

function validateDiscoveredToolConfigurations(
  plans: readonly ToolRegistrationPlan[],
  discovered: readonly unknown[]
): void {
  if (discovered.length !== plans.length) {
    throw new TypeError("SDK tool catalog preflight returned an incomplete catalog");
  }
  const byName = new Map<string, Readonly<Record<string, unknown>>>();
  for (const candidate of discovered) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new TypeError("SDK tool catalog preflight returned an invalid tool");
    }
    const record = candidate as Readonly<Record<string, unknown>>;
    if (typeof record.name !== "string" || byName.has(record.name)) {
      throw new TypeError("SDK tool catalog preflight returned an invalid tool name");
    }
    byName.set(record.name, record);
  }
  for (const { module } of plans) {
    const discoveredTool = byName.get(module.definition.name);
    if (!discoveredTool) {
      throw new TypeError("SDK tool catalog preflight omitted a tool");
    }
    validateDiscoveryObjectSchema(
      module.definition.name,
      "input",
      discoveredTool.inputSchema
    );
    validateDiscoveryObjectSchema(
      module.definition.name,
      "output",
      discoveredTool.outputSchema
    );
  }
}

function validateDiscoveryObjectSchema(
  toolName: string,
  kind: "input" | "output",
  candidate: unknown
): void {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`${toolName}: SDK ${kind} discovery schema is invalid`);
  }
  const schema = candidate as Readonly<Record<string, unknown>>;
  const properties = schema.properties;
  const required = schema.required;
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties) ||
    !Array.isArray(required) ||
    !required.includes("profile")
  ) {
    throw new TypeError(`${toolName}: SDK ${kind} discovery schema is incomplete`);
  }
  const profileProperty = Reflect.get(properties, "profile");
  if (
    typeof profileProperty !== "object" ||
    profileProperty === null ||
    Reflect.get(profileProperty, "type") !== "string"
  ) {
    throw new TypeError(`${toolName}: SDK ${kind} discovery profile is invalid`);
  }
  try {
    JSON.stringify(schema);
  } catch {
    throw new TypeError(`${toolName}: SDK ${kind} discovery schema is not materializable`);
  }
}

function registerStandardTool(
  mcpServer: RegistrationServer,
  profileManager: ProfileManager,
  sharedContextDependencies: ExecutionContextDependencies,
  tool: ServiceNowToolModuleContract,
  logger: ToolModuleLogger,
  registrationConfig: ReturnType<typeof toolRegistrationConfig>
): void {
  mcpServer.registerTool(
    tool.definition.name,
    registrationConfig,
    async (args, extra) => {
      const contextDependencies = dependenciesForToolInvocation(
        sharedContextDependencies
      );
      const request = await resolveRequestMetadata(
        tool.definition.name,
        extra,
        contextDependencies
      );
      if (request.kind === "cancelled") {
        auditPreContextCancellation(
          contextDependencies,
          tool.definition.name,
          request.metadata,
          request.reason
        );
        return err(
          `Tool ${JSON.stringify(tool.definition.name)} was cancelled. ` +
            `Correlation ID: ${request.metadata.correlationId}.`
        );
      }
      if (request.kind === "unavailable") {
        auditPreContextRejection(
          contextDependencies,
          tool.definition.name,
          request.metadata
        );
        return err(
          `Request metadata could not be initialized. Correlation ID: ${request.metadata.correlationId}.`
        );
      }

      // The SDK has already validated and transformed this composed schema.
      // Reassert the shared selector type because the SDK's generic callback
      // widens an extended AnyZodObject property to unknown in TypeScript.
      const profileName = profileNameSchema.parse(args.profile);
      const resolution = resolveProfile(profileManager, profileName);
      if (resolution.kind === "unknown") {
        auditInvocation(
          contextDependencies,
          { outcome: "profile_rejected", reason: "unknown_profile" },
          tool.definition.name,
          request.metadata
        );
        return correlateErrorResult(
          unknownProfile(profileName),
          request.metadata.correlationId
        );
      }
      if (resolution.kind === "invalid") {
        auditInvocation(
          contextDependencies,
          { outcome: "profile_rejected", reason: "invalid_profile" },
          tool.definition.name,
          request.metadata
        );
        return correlateErrorResult(
          invalidProfile(profileName),
          request.metadata.correlationId
        );
      }

      const binding = Object.freeze({
        name: profileName,
        instance: resolution.canonicalInstance,
      });
      let context: ExecutionContext;
      try {
        context = await createExecutionContext(
          request.metadata,
          binding,
          tool.definition.name,
          contextDependencies.effectivePolicyProvider,
          contextDependencies.requestSignal
        );
      } catch {
        const cancellation = cancellationResultIfIssued(
          contextDependencies,
          contextDependencies.requestSignal,
          binding,
          tool.definition.name,
          request.metadata
        );
        if (cancellation) return cancellation;
        auditInvocation(
          contextDependencies,
          {
            outcome: "context_rejected",
            reason: "policy_context_unavailable",
            profile: binding,
          },
          tool.definition.name,
          request.metadata
        );
        return err(
          `Request context could not be initialized. Correlation ID: ${request.metadata.correlationId}.`
        );
      }
      const contextCancellation = cancellationResultIfIssued(
        contextDependencies,
        context.signal,
        binding,
        tool.definition.name,
        request.metadata
      );
      if (contextCancellation) return contextCancellation;

      // Resolve and authorize the complete table plan before configuration,
      // credential-bearing client construction, or handler execution. The
      // resolver also canonicalizes caller-selected table identifiers so the
      // value evaluated by policy is the value used by the handler.
      let authorizedArgs: Record<string, unknown>;
      try {
        const access = tool.resolveAccess(args, context.effectivePolicy);
        authorizeTableAccessPlan(
          context.effectivePolicy.tableAccess,
          access.requests,
          tool.definition.name
        );
        authorizedArgs = access.args;
      } catch (error) {
        const cancellation = cancellationResultIfIssued(
          contextDependencies,
          context.signal,
          binding,
          tool.definition.name,
          request.metadata
        );
        if (cancellation) return cancellation;
        const encodedQueryDenied = isEncodedQueryPolicyError(error);
        const journalUpdateDenied =
          isIncidentJournalPolicyError(error) &&
          error.reason === "generic_journal_update" &&
          error.field !== undefined;
        auditInvocation(
          contextDependencies,
          {
            outcome: "policy_rejected",
            reason: encodedQueryDenied
              ? "encoded_query_denied"
              : journalUpdateDenied
                ? "journal_update_denied"
                : "table_access_denied",
            profile: binding,
          },
          tool.definition.name,
          request.metadata
        );
        return err(
          encodedQueryDenied
            ? `${ENCODED_QUERY_MIGRATION_MESSAGE} Correlation ID: ${context.correlationId}.`
            : journalUpdateDenied
              ? `${incidentJournalMigrationMessage(error.field!)} Correlation ID: ${context.correlationId}.`
            : `Table access was denied by policy. Correlation ID: ${context.correlationId}.`
        );
      }

      // Profile existence is established before these credential-bearing
      // paths. Initialization errors are sanitized at this trust boundary.
      let config: ServiceNowConfig;
      try {
        config = profileManager.getConfig(context.profile.name);
      } catch {
        return clientInitializationFailure(
          contextDependencies,
          "client_initialization_failed",
          binding,
          tool.definition.name,
          request.metadata,
          context.correlationId
        );
      }
      let configInstance: string;
      try {
        configInstance = normalizeInstanceUrl(config.instance);
      } catch {
        return clientInitializationFailure(
          contextDependencies,
          "client_initialization_failed",
          binding,
          tool.definition.name,
          request.metadata,
          context.correlationId
        );
      }
      if (configInstance !== context.profile.instance) {
        return clientInitializationFailure(
          contextDependencies,
          "profile_binding_changed",
          binding,
          tool.definition.name,
          request.metadata,
          context.correlationId
        );
      }

      let client: ServiceNowClient;
      try {
        // Use the exact immutable configuration resolved and bound above.
        // A second resolver read here could select different rotating secret
        // material from the values the handler and preflight authorized.
        client = profileManager.getClient(context.profile.name, config);
      } catch {
        return clientInitializationFailure(
          contextDependencies,
          "client_initialization_failed",
          binding,
          tool.definition.name,
          request.metadata,
          context.correlationId
        );
      }

      let result: unknown;
      try {
        const services: ServiceNowToolHandlerServices = Object.freeze({
          serviceNow: createServiceNowOperations(client),
          settings: Object.freeze({
            instance: context.profile.instance,
            displayValue: config.displayValue,
            relDepth: config.relDepth,
          }),
          context,
          policy: context.effectivePolicy,
          logger,
        });
        result = await runWithServiceNowRequestSignal(context.signal, () =>
          tool.invoke(authorizedArgs, services)
        );
      } catch (error) {
        const cancellation = cancellationResultIfIssued(
          contextDependencies,
          context.signal,
          binding,
          tool.definition.name,
          request.metadata
        );
        if (cancellation) return cancellation;
        auditInvocation(
          contextDependencies,
          {
            outcome: "handler_error",
            reason: "handler_threw",
            profile: binding,
            error,
          },
          tool.definition.name,
          request.metadata
        );
        return correlatedToolError(error, context.correlationId);
      }

      const completionCancellation = cancellationResultIfIssued(
        contextDependencies,
        context.signal,
        binding,
        tool.definition.name,
        request.metadata
      );
      if (completionCancellation) return completionCancellation;
      return finalizeHandlerInvocation(
        result,
        registrationConfig.outputSchema,
        context.profile.name,
        contextDependencies,
        binding,
        tool.definition.name,
        request.metadata,
        context.correlationId
      );
    }
  );
}

function registerProfileDiagnostic(
  mcpServer: RegistrationServer,
  profileManager: ProfileManager,
  sharedContextDependencies: ExecutionContextDependencies,
  tool: ContextOnlyToolModuleContract,
  logger: ToolModuleLogger,
  registrationConfig: ReturnType<typeof toolRegistrationConfig>
): void {
  mcpServer.registerTool(
    tool.definition.name,
    registrationConfig,
    async (args, extra) => {
      const contextDependencies = dependenciesForToolInvocation(
        sharedContextDependencies
      );
      const request = await resolveRequestMetadata(
        tool.definition.name,
        extra,
        contextDependencies
      );
      if (request.kind === "cancelled") {
        auditPreContextCancellation(
          contextDependencies,
          tool.definition.name,
          request.metadata,
          request.reason
        );
        return err(
          `Tool ${JSON.stringify(tool.definition.name)} was cancelled. ` +
            `Correlation ID: ${request.metadata.correlationId}.`
        );
      }
      if (request.kind === "unavailable") {
        auditPreContextRejection(
          contextDependencies,
          tool.definition.name,
          request.metadata
        );
        return err(
          `Request metadata could not be initialized. Correlation ID: ${request.metadata.correlationId}.`
        );
      }

      const profileName = args.profile;
      const resolution = resolveProfile(profileManager, profileName);
      if (resolution.kind === "unknown") {
        auditInvocation(
          contextDependencies,
          { outcome: "profile_rejected", reason: "unknown_profile" },
          tool.definition.name,
          request.metadata
        );
        return correlateErrorResult(
          unknownProfile(profileName),
          request.metadata.correlationId
        );
      }
      if (resolution.kind === "invalid") {
        auditInvocation(
          contextDependencies,
          { outcome: "profile_rejected", reason: "invalid_profile" },
          tool.definition.name,
          request.metadata
        );
        return correlateErrorResult(
          invalidProfile(profileName),
          request.metadata.correlationId
        );
      }

      const binding = Object.freeze({
        name: profileName,
        instance: resolution.canonicalInstance,
      });
      let context: ExecutionContext;
      try {
        context = await createExecutionContext(
          request.metadata,
          binding,
          tool.definition.name,
          contextDependencies.effectivePolicyProvider,
          contextDependencies.requestSignal
        );
      } catch {
        const cancellation = cancellationResultIfIssued(
          contextDependencies,
          contextDependencies.requestSignal,
          binding,
          tool.definition.name,
          request.metadata
        );
        if (cancellation) return cancellation;
        auditInvocation(
          contextDependencies,
          {
            outcome: "context_rejected",
            reason: "policy_context_unavailable",
            profile: binding,
          },
          tool.definition.name,
          request.metadata
        );
        return err(
          `Request context could not be initialized. Correlation ID: ${request.metadata.correlationId}.`
        );
      }
      const contextCancellation = cancellationResultIfIssued(
        contextDependencies,
        context.signal,
        binding,
        tool.definition.name,
        request.metadata
      );
      if (contextCancellation) return contextCancellation;

      let authorizedArgs: Record<string, unknown>;
      try {
        const access = tool.resolveAccess(args, context.effectivePolicy);
        authorizeTableAccessPlan(
          context.effectivePolicy.tableAccess,
          access.requests,
          tool.definition.name
        );
        authorizedArgs = access.args;
      } catch {
        const cancellation = cancellationResultIfIssued(
          contextDependencies,
          context.signal,
          binding,
          tool.definition.name,
          request.metadata
        );
        if (cancellation) return cancellation;
        auditInvocation(
          contextDependencies,
          {
            outcome: "policy_rejected",
            reason: "table_access_denied",
            profile: binding,
          },
          tool.definition.name,
          request.metadata
        );
        return err(
          `Table access was denied by policy. Correlation ID: ${context.correlationId}.`
        );
      }

      let result: unknown;
      try {
        const services = Object.freeze({
          context,
          policy: context.effectivePolicy,
          logger,
          profileMetadata: Object.freeze({
            instance: context.profile.instance,
            authType: resolution.metadata.authType ?? "basic",
          }),
        });
        result = await runWithServiceNowRequestSignal(context.signal, () =>
          tool.invoke(authorizedArgs, services)
        );
      } catch (error) {
        const cancellation = cancellationResultIfIssued(
          contextDependencies,
          context.signal,
          binding,
          tool.definition.name,
          request.metadata
        );
        if (cancellation) return cancellation;
        auditInvocation(
          contextDependencies,
          {
            outcome: "handler_error",
            reason: "handler_threw",
            profile: binding,
            error,
          },
          tool.definition.name,
          request.metadata
        );
        return correlatedToolError(error, context.correlationId);
      }

      const completionCancellation = cancellationResultIfIssued(
        contextDependencies,
        context.signal,
        binding,
        tool.definition.name,
        request.metadata
      );
      if (completionCancellation) return completionCancellation;
      return finalizeHandlerInvocation(
        result,
        registrationConfig.outputSchema,
        context.profile.name,
        contextDependencies,
        binding,
        tool.definition.name,
        request.metadata,
        context.correlationId
      );
    }
  );
}

/** Provider-neutral subset of the official SDK callback extra. */
interface StableToolCallbackExtra {
  readonly requestId: string | number;
  readonly sessionId?: string;
  readonly authInfo?: { readonly clientId: string };
}

/**
 * Begin timing before metadata/profile/policy work and finish from the same
 * issued audit record already used by the tool boundary. The wrapper is local
 * to one callback, so concurrent calls cannot finish each other's span.
 */
function dependenciesForToolInvocation(
  dependencies: ExecutionContextDependencies
): ExecutionContextDependencies {
  const observer = dependencies.toolAuditObserver;
  if (!observer) return dependencies;

  let observation: ReturnType<typeof observer.begin>;
  try {
    observation = observer.begin();
    if (!observation || typeof observation.finish !== "function") {
      return dependencies;
    }
  } catch {
    return dependencies;
  }

  return Object.freeze({
    ...dependencies,
    auditSink: Object.freeze({
      write(record: ToolAuditRecord): void {
        try {
          suppressObserverThenable(observation.finish(record) as unknown);
        } catch {
          // Timing/telemetry is isolated from the authoritative audit sink.
        }
        dependencies.auditSink.write(record);
      },
      writePreContext(record: PreContextAuditRecord): void {
        try {
          suppressObserverThenable(observation.finish(record) as unknown);
        } catch {
          // Pre-context rejection behavior cannot depend on telemetry.
        }
        dependencies.auditSink.writePreContext(record);
      },
    }),
  });
}

function suppressObserverThenable(value: unknown): void {
  if (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  ) {
    void Promise.resolve(value).catch(() => {});
  }
}

type RequestMetadataResolution =
  | { readonly kind: "resolved"; readonly metadata: RequestMetadata }
  | {
      readonly kind: "cancelled";
      readonly metadata: RequestMetadata;
      readonly reason: "request_cancelled" | "request_deadline_exceeded";
    }
  | { readonly kind: "unavailable"; readonly metadata: RequestMetadata };

/** Resolve safe request identity before any profile lookup or context creation. */
async function resolveRequestMetadata(
  toolName: string,
  extra: StableToolCallbackExtra,
  dependencies: ExecutionContextDependencies
): Promise<RequestMetadataResolution> {
  const invocation = Object.freeze({
    tool: toolName,
    requestId: extra.requestId,
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    ...(extra.authInfo?.clientId === undefined
      ? {}
      : { authenticatedClientId: extra.authInfo.clientId }),
  });

  try {
    const candidate = await dependencies.requestMetadataProvider.resolve(invocation);
    const metadata = immutableRequestMetadata(candidate);
    const cancellationReason = dependencies.requestSignal
      ? requestCancellationAuditReason(dependencies.requestSignal)
      : undefined;
    return cancellationReason === undefined
      ? { kind: "resolved", metadata }
      : { kind: "cancelled", metadata, reason: cancellationReason };
  } catch {
    const cancellationReason = dependencies.requestSignal
      ? requestCancellationAuditReason(dependencies.requestSignal)
      : undefined;
    if (cancellationReason !== undefined) {
      return {
        kind: "cancelled",
        metadata: fallbackRequestMetadata(),
        reason: cancellationReason,
      };
    }
    return {
      kind: "unavailable",
      metadata: fallbackRequestMetadata(),
    };
  }
}

function auditInvocation(
  dependencies: ExecutionContextDependencies,
  disposition: ToolAuditDisposition,
  tool: string,
  request: RequestMetadata
): void {
  try {
    const record = createAuditRecord({
      ...disposition,
      tool,
      request,
    });
    emitAudit(dependencies.auditSink, record);
  } catch {
    // Even record construction is isolated from the caller's tool result.
  }
}

function cancellationResultIfIssued(
  dependencies: ExecutionContextDependencies,
  signal: AbortSignal | undefined,
  profile: ExecutionContext["profile"],
  tool: string,
  request: RequestMetadata
): CallToolResult | undefined {
  if (!signal) return undefined;
  const reason = requestCancellationAuditReason(signal);
  if (reason === undefined) return undefined;
  auditInvocation(
    dependencies,
    { outcome: "cancelled", reason, profile },
    tool,
    request
  );
  return err(
    `Tool ${JSON.stringify(tool)} was cancelled. ` +
      `Correlation ID: ${request.correlationId}.`
  );
}

function auditPreContextRejection(
  dependencies: ExecutionContextDependencies,
  tool: string,
  request: RequestMetadata
): void {
  try {
    const record = createPreContextAuditRecord({
      tool,
      request,
      reason: "request_metadata_unavailable",
    });
    emitPreContextAudit(dependencies.auditSink, record);
  } catch {
    // Operational audit construction/delivery cannot alter safe rejection.
  }
}

function auditPreContextCancellation(
  dependencies: ExecutionContextDependencies,
  tool: string,
  request: RequestMetadata,
  reason: "request_cancelled" | "request_deadline_exceeded"
): void {
  try {
    const record = createPreContextAuditRecord({ tool, request, reason });
    emitPreContextAudit(dependencies.auditSink, record);
  } catch {
    // Cancellation audit construction/delivery cannot alter safe rejection.
  }
}

function clientInitializationFailure(
  dependencies: ExecutionContextDependencies,
  reason: "client_initialization_failed" | "profile_binding_changed",
  profile: ExecutionContext["profile"],
  tool: string,
  request: RequestMetadata,
  correlationId: string
): CallToolResult {
  // Every credential source/provider/decryption/client-construction failure is
  // intentionally identical to a final upstream authentication rejection.
  const error = createToolError("authentication", "retry_after_correction");
  auditInvocation(
    dependencies,
    { outcome: "client_rejected", reason, profile, error },
    tool,
    request
  );
  return correlatedToolError(error, correlationId);
}

function finalizeHandlerInvocation(
  candidate: unknown,
  outputSchema: ReturnType<typeof toolRegistrationConfig>["outputSchema"],
  canonicalProfile: string,
  dependencies: ExecutionContextDependencies,
  profile: ExecutionContext["profile"],
  tool: string,
  request: RequestMetadata,
  correlationId: string
): CallToolResult {
  try {
    const guarded = guardedHandlerResult(candidate);
    if (guarded.kind === "error") {
      return handlerResultFailure(
        dependencies,
        profile,
        tool,
        request,
        correlationId
      );
    }
    const enriched = validateSuccessfulModuleResult(
      outputSchema,
      guarded.result,
      canonicalProfile
    );
    if (!enriched) {
      return handlerResultFailure(
        dependencies,
        profile,
        tool,
        request,
        correlationId
      );
    }
    auditInvocation(
      dependencies,
      { outcome: "success", reason: null, profile },
      tool,
      request
    );
    return enriched;
  } catch {
    return handlerResultFailure(
      dependencies,
      profile,
      tool,
      request,
      correlationId
    );
  }
}

function handlerResultFailure(
  dependencies: ExecutionContextDependencies,
  profile: ExecutionContext["profile"],
  tool: string,
  request: RequestMetadata,
  correlationId: string
): CallToolResult {
  const error = createToolError("internal", "do_not_retry");
  auditInvocation(
    dependencies,
    {
      outcome: "handler_error",
      reason: "handler_returned_error",
      profile,
      error,
    },
    tool,
    request
  );
  return correlatedToolError(error, correlationId);
}

function correlatedToolError(
  error: unknown,
  correlationId: string
): CallToolResult {
  return err(`${formatToolError(error)}\nCorrelation ID: ${correlationId}.`);
}

/** Preserve handler output and centrally attach the canonical profile envelope. */
export function enrichSuccessfulResult(
  result: CallToolResult,
  canonicalProfile: string
): CallToolResult {
  return {
    ...result,
    structuredContent: {
      ...result.structuredContent,
      profile: canonicalProfile,
    },
  };
}

/** Validate the exact canonical envelope before either MCP client can see it. */
function validateSuccessfulModuleResult(
  outputSchema: ReturnType<typeof toolRegistrationConfig>["outputSchema"],
  result: CallToolResult,
  canonicalProfile: string
): CallToolResult | undefined {
  try {
    const enriched = enrichSuccessfulResult(result, canonicalProfile);
    const parsed = outputSchema.safeParse(enriched.structuredContent);
    if (!parsed.success) return undefined;
    const validated = {
      ...enriched,
      structuredContent: parsed.data,
    };
    const finalized = finalizeEnvelopeResult(validated);
    if (!finalized) return undefined;
    const finalParsed = outputSchema.safeParse(finalized.structuredContent);
    if (!finalParsed.success) return undefined;
    const block = finalized.content[0];
    if (
      finalized.content.length !== 1 ||
      !block ||
      block.type !== "text"
    ) {
      return undefined;
    }
    return {
      content: [{ type: "text", text: block.text }],
      structuredContent: finalParsed.data,
    };
  } catch {
    return undefined;
  }
}

/** Add safe correlation to callback-reachable errors and drop structured data. */
function correlateErrorResult(
  result: CallToolResult,
  correlationId: string
): CallToolResult {
  const safeResult = { ...result };
  delete safeResult.structuredContent;
  return {
    ...safeResult,
    isError: true,
    content: result.content.map((block) =>
      block.type === "text"
        ? { ...block, text: `${block.text}\nCorrelation ID: ${correlationId}.` }
        : block
    ),
  };
}

/** Existence-only resolution: getProfile does not resolve credentials. */
function resolveProfile(
  profileManager: ProfileManager,
  profileName: string
): ProfileResolution {
  let candidate: unknown;
  try {
    candidate = profileManager.getProfile(profileName);
  } catch {
    return { kind: "unknown" };
  }

  let snapshot: ProfileValidationSnapshot | undefined;
  try {
    snapshot = snapshotProfileRecord(candidate);
  } catch {
    return { kind: "invalid" };
  }
  if (!snapshot || !isValidProfileRecord(snapshot)) {
    return { kind: "invalid" };
  }
  const canonicalInstance = canonicalProfileInstance(snapshot.instance);
  if (!canonicalInstance) {
    return { kind: "invalid" };
  }
  return {
    kind: "resolved",
    metadata: Object.freeze({ authType: snapshot.authType }),
    canonicalInstance,
  };
}

interface ProfileValidationSnapshot {
  readonly instance: unknown;
  readonly username: unknown;
  readonly credential: unknown;
  readonly scope: unknown;
  readonly scope_sys_id: unknown;
  readonly vendor_code: unknown;
  readonly description: unknown;
  readonly authType: unknown;
  readonly clientId: unknown;
  readonly clientSecret: unknown;
  readonly grantType: unknown;
  readonly apiKey: unknown;
  readonly apiKeyHeader: unknown;
  readonly timeoutMs: unknown;
}

const INVALID_PROFILE_FIELD = Symbol("invalid-profile-field");

/** Snapshot own data descriptors without invoking getters or proxy traps. */
function snapshotProfileRecord(candidate: unknown): ProfileValidationSnapshot | undefined {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    utilTypes.isProxy(candidate)
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const read = (key: keyof ProfileValidationSnapshot): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor) return undefined;
    return "value" in descriptor ? descriptor.value : INVALID_PROFILE_FIELD;
  };
  return Object.freeze({
    instance: read("instance"),
    username: read("username"),
    credential: read("credential"),
    scope: read("scope"),
    scope_sys_id: read("scope_sys_id"),
    vendor_code: read("vendor_code"),
    description: read("description"),
    authType: read("authType"),
    clientId: read("clientId"),
    clientSecret: read("clientSecret"),
    grantType: read("grantType"),
    apiKey: read("apiKey"),
    apiKeyHeader: read("apiKeyHeader"),
    timeoutMs: read("timeoutMs"),
  });
}

/** Validate a plain snapshot without resolving or exposing credentials. */
function isValidProfileRecord(
  profile: ProfileValidationSnapshot
): profile is ProfileValidationSnapshot & {
  readonly authType: Profile["authType"] | undefined;
} {
  if (!canonicalProfileInstance(profile.instance)) return false;
  const timeoutMs = profile.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    return false;
  }

  const authType = profile.authType ?? "basic";
  switch (authType) {
    case "basic":
      return (
        isNonEmptyString(profile.username) &&
        isCredentialSourceDescriptor(profile.credential)
      );
    case "oauth": {
      const grantType = profile.grantType ?? "client_credentials";
      if (
        !isNonEmptyString(profile.clientId) ||
        !isCredentialSourceDescriptor(profile.clientSecret) ||
        (grantType !== "client_credentials" && grantType !== "password")
      ) {
        return false;
      }
      return (
        grantType !== "password" ||
        (isNonEmptyString(profile.username) &&
          isCredentialSourceDescriptor(profile.credential))
      );
    }
    case "apikey":
      return (
        isCredentialSourceDescriptor(profile.apiKey) &&
        (profile.apiKeyHeader === undefined || isNonEmptyString(profile.apiKeyHeader))
      );
    default:
      return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Return a safe canonical origin, rejecting URL credential/metadata channels. */
function canonicalProfileInstance(instance: unknown): string | undefined {
  if (typeof instance !== "string") return undefined;
  try {
    return normalizeInstanceUrl(instance);
  } catch {
    return undefined;
  }
}

function unknownProfile(profileName: string): CallToolResult {
  return err(`Unknown profile ${JSON.stringify(profileName)}.`);
}

function invalidProfile(profileName: string): CallToolResult {
  return err(`Profile ${JSON.stringify(profileName)} is invalid or incomplete.`);
}
