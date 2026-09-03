/** Canonical contract catalog for all published ServiceNow MCP tools. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ExecutionContext } from "../execution-context.js";
import { resolveToolTableAccess } from "../tool-table-access.js";

import * as aggregate from "./aggregate.js";
import * as atf from "./atf.js";
import * as attach from "./attach.js";
import * as batch from "./batch.js";
import * as codesearch from "./codesearch.js";
import { createToolModule } from "./create-module.js";
import * as del from "./delete.js";
import * as discover from "./discover.js";
import { getToolModule } from "./get-module.js";
import * as health from "./health.js";
import {
  incidentCommentToolModule,
  incidentWorkNoteToolModule,
} from "./incident-journal-module.js";
import * as nl from "./nl.js";
import * as profile from "./profile.js";
import { queryToolModule } from "./query-module.js";
import * as relationships from "./relationships.js";
import { schemaToolModule } from "./schema-module.js";
import * as syslog from "./syslog.js";
import { updateToolModule } from "./update-module.js";
import {
  envelopeCompatibilityResult,
  isProductionToolName,
  productionToolOutputSchemas,
} from "./result-envelope.js";
import {
  defineContextOnlyToolModule,
  defineServiceNowToolModule,
  withRequiredProfile,
  type ServiceNowToolHandlerServices,
  type ToolDefinition,
  type ToolModuleRequirements,
} from "./tool-module.js";

interface ExistingServiceNowTool<TSchema extends z.AnyZodObject> {
  readonly definition: ToolDefinition;
  readonly schema: TSchema;
  readonly handler: (
    args: z.output<TSchema>,
    client: ServiceNowToolHandlerServices["serviceNow"],
    settings: ServiceNowToolHandlerServices["settings"],
    context: ExecutionContext
  ) => Promise<CallToolResult>;
}

/**
 * Adapt the existing handler functions without exposing their positional
 * compatibility signature to the registry or to future module authors.
 */
function existingToolModule<TSchema extends z.AnyZodObject>(
  tool: ExistingServiceNowTool<TSchema>,
  requirements: ToolModuleRequirements
) {
  if (!isProductionToolName(tool.definition.name)) {
    throw new TypeError("production tool is missing a result-envelope contract");
  }
  const toolName = tool.definition.name;
  const inputSchema = withRequiredProfile(tool.schema);
  return defineServiceNowToolModule({
    runtime: "servicenow",
    definition: tool.definition,
    inputSchema,
    outputSchema: productionToolOutputSchemas[toolName],
    requirements,
    resolveAccess: (args, policy) =>
      resolveToolTableAccess(
        tool.definition.name,
        args,
        policy.encodedQueryAccess
    ),
    handler: async (args, services) =>
      envelopeCompatibilityResult(
        toolName,
        args,
        await tool.handler(
          args,
          services.serviceNow,
          services.settings,
          services.context
        )
      ),
  });
}

const dynamicTable = (description: string, names: readonly string[] = []) =>
  Object.freeze({ kind: "dynamic" as const, names, description });

const staticTables = (...names: string[]) =>
  Object.freeze({ kind: "static" as const, names: Object.freeze(names) });

const noTables = Object.freeze({ kind: "none" as const });

export const serviceNowToolModules = Object.freeze([
  queryToolModule,
  getToolModule,
  createToolModule,
  updateToolModule,
  incidentCommentToolModule,
  incidentWorkNoteToolModule,
  existingToolModule(del, {
    permissions: ["write"],
    tables: dynamicTable("Caller-selected policy-approved table."),
    apis: ["table"],
    fieldPolicies: [],
    capabilities: ["record:delete"],
  }),
  existingToolModule(batch, {
    permissions: ["read", "write"],
    tables: dynamicTable("Caller-selected table; dry-run reads and confirmation writes."),
    apis: ["table"],
    fieldPolicies: ["read", "write"],
    capabilities: ["records:batch"],
  }),
  existingToolModule(aggregate, {
    permissions: ["read"],
    tables: dynamicTable("Caller-selected policy-approved aggregate target."),
    apis: ["aggregate"],
    fieldPolicies: ["read"],
    capabilities: ["records:aggregate"],
  }),
  schemaToolModule,
  existingToolModule(health, {
    permissions: ["read"],
    tables: staticTables(
      "change_request",
      "incident",
      "problem",
      "sys_cluster_state",
      "sys_properties",
      "sys_semaphore",
      "sys_trigger"
    ),
    apis: ["aggregate", "table"],
    fieldPolicies: ["read"],
    capabilities: ["instance:health"],
  }),
  existingToolModule(attach, {
    permissions: ["read", "write"],
    tables: dynamicTable("Caller-selected owning table plus attachment metadata.", [
      "sys_attachment",
    ]),
    apis: ["attachment"],
    fieldPolicies: [],
    capabilities: ["attachment:manage"],
  }),
  existingToolModule(relationships, {
    permissions: ["read"],
    tables: staticTables("cmdb_ci", "cmdb_rel_ci"),
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["cmdb:relationships"],
  }),
  existingToolModule(syslog, {
    permissions: ["read"],
    tables: staticTables("syslog"),
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["logs:read"],
  }),
  existingToolModule(codesearch, {
    permissions: ["read"],
    tables: dynamicTable("Caller-selected approved code table or the fixed code-table set.", [
      "sys_script",
      "sys_script_client",
      "sys_script_include",
      "sys_ui_script",
      "sys_ws_operation",
    ]),
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["code:search"],
  }),
  existingToolModule(discover, {
    permissions: ["read"],
    tables: staticTables("sys_app", "sys_db_object", "sys_store_app", "v_plugin"),
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["metadata:discover"],
  }),
  existingToolModule(atf, {
    permissions: ["read", "write"],
    tables: staticTables(
      "sys_atf_test",
      "sys_atf_test_result",
      "sys_atf_test_suite",
      "sys_atf_test_suite_test",
      "sys_execution_tracker"
    ),
    apis: ["atf", "table"],
    fieldPolicies: ["read"],
    capabilities: ["atf:manage"],
  }),
  existingToolModule(nl, {
    permissions: ["read", "write"],
    tables: dynamicTable("Tables selected only after natural-language parsing."),
    apis: ["aggregate", "table"],
    fieldPolicies: ["read", "write"],
    capabilities: ["natural-language:compose"],
  }),
] as const);

const profileInputSchema = withRequiredProfile(profile.schema);
const EMPTY_REQUESTS = Object.freeze([]);

/** Client-free profile diagnostic still uses the same module contract. */
export const profileToolModules = Object.freeze([
  defineContextOnlyToolModule({
    runtime: "context-only",
    definition: profile.definition,
    inputSchema: profileInputSchema,
    outputSchema: productionToolOutputSchemas.sn_profile,
    requirements: {
      permissions: ["read"],
      tables: noTables,
      apis: [],
      fieldPolicies: [],
      capabilities: ["profile:inspect"],
    },
    resolveAccess: (args) => ({
      args: Object.freeze(profileInputSchema.parse(args)),
      requests: EMPTY_REQUESTS,
    }),
    handler: async (args, services) =>
      envelopeCompatibilityResult(
        "sn_profile",
        args,
        await profile.handler(services.profileMetadata, services.context)
      ),
  }),
] as const);

export const allToolModules = Object.freeze([
  ...serviceNowToolModules,
  ...profileToolModules,
] as const);
