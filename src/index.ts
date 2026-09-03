#!/usr/bin/env node

/**
 * Executable composition for @onlyflows/servicenow-mcp.
 *
 * The transport is stdio, always. An MCP client spawns this binary and speaks
 * JSON-RPC over the child's stdin/stdout; there is no port, no endpoint, and
 * nothing to start or keep running between sessions.
 *
 * **stdout carries the protocol.** Everything this process reports — warnings,
 * structured tool events, startup failures — goes to stderr, which the client
 * captures as a log. A single stray byte on stdout desynchronizes the client's
 * JSON-RPC parser and ends the session, so there is no such thing as a harmless
 * `console.log` anywhere on the startup or request path.
 *
 * A listening HTTP service still exists in `src/http-entrypoint.ts` and stays
 * under test, but nothing here reaches it and setup never registers a client
 * against a URL. It is a dormant enterprise deployment shape; see
 * `docs/ENTERPRISE-RELEASE-BOUNDARY.md` for what re-exposing it would mean.
 *
 * @module index
 */

import type {
  AuditSink,
  EffectivePolicyProvider,
  ExecutionContextDependencies,
  PreContextAuditRecord,
  ToolAuditRecord,
} from "./execution-context.js";
import {
  encodedQueryAccessPolicyFromEnvironment,
  type EncodedQueryAccessPolicy,
} from "./encoded-query-policy.js";
import {
  createHttpObservability,
  createBoundedJsonLinesEventSink,
  type HttpObservability,
} from "./http-observability.js";
import { ProfileManager, type ProfileManager as ProfileManagerType } from "./profile-manager.js";
import { registerSetupPrompts } from "./setup-prompts.js";
import { createMcpServer } from "./server.js";
import {
  loadServerEnvironmentFile,
  startStdioRuntime,
  stderrWrite,
  type StdioSessionContext,
} from "./stdio-runtime.js";
import {
  createTableAccessPolicy,
  type TableAccessPolicyInput,
} from "./table-policy.js";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_OWNER_ID,
  optionalEnvironmentVariable,
} from "./runtime-environment.js";
import {
  REGISTERED_TOOL_COUNT,
  registerServiceNowTools,
} from "./tools/index.js";
import { VERSION } from "./version.js";

function createRestrictedPolicyProvider(
  profileManager: ProfileManagerType,
  encodedQueryAccess: EncodedQueryAccessPolicy
): EffectivePolicyProvider {
  return Object.freeze({
    resolve: ({ profile }: { profile: { name: string } }) => {
      const configuredProfile = profileManager.getProfile(profile.name);
      const tableAccess: TableAccessPolicyInput =
        configuredProfile.tableAccess ?? Object.freeze({});
      return Object.freeze({
        id: `restricted-table-policy:${profile.name}`,
        revision: "snsdk-32-v2-profile-scoped",
        tableAccess: createTableAccessPolicy(tableAccess),
        // Only keys the profile actually states are materialized. A key
        // present with an `undefined` value is not the same input as an
        // absent key to consumers that branch on key presence.
        fieldPolicy: {
          ...(configuredProfile.fieldPolicy === undefined
            ? {}
            : { fieldPolicy: configuredProfile.fieldPolicy }),
          ...(configuredProfile.readableTableFields === undefined
            ? {}
            : { readableTableFields: configuredProfile.readableTableFields }),
          ...(configuredProfile.writableTableFields === undefined
            ? {}
            : { writableTableFields: configuredProfile.writableTableFields }),
        },
        encodedQueryAccess,
      });
    },
  });
}

/**
 * The identity every audit record from this session is attributed to.
 *
 * Under stdio there is nothing to authenticate: the client already had to be
 * able to spawn this process, and it runs as whoever did. `MCP_OWNER_ID` and
 * `MCP_CLIENT_ID` are therefore labels an operator chooses, and setup generates
 * a per-install pair so records from two installs stay distinguishable.
 */
function resolveIdentity(): { readonly ownerId: string; readonly clientId: string } {
  return Object.freeze({
    ownerId: optionalEnvironmentVariable("MCP_OWNER_ID") ?? DEFAULT_OWNER_ID,
    clientId: optionalEnvironmentVariable("MCP_CLIENT_ID") ?? DEFAULT_CLIENT_ID,
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === "setup") {
    const { runSetupCli } = await import("./setup.js");
    await runSetupCli({ argv: process.argv.slice(2) });
    return;
  }

  // The client chose this process's environment, so the owner-only file setup
  // wrote is the only place the profile encryption key can come from. Values
  // already in the environment always win.
  loadServerEnvironmentFile();

  const profileManager = new ProfileManager();
  const effectivePolicyProvider = createRestrictedPolicyProvider(
    profileManager,
    encodedQueryAccessPolicyFromEnvironment()
  );

  // The same structured `mcp_tool` JSONL records the HTTP runtime emits, on the
  // same stream. Under stdio, stderr is the only channel that exists.
  const observability = createHttpObservability({
    sink: createBoundedJsonLinesEventSink({
      writeLine: (line) => process.stderr.write(line),
      onDrain: (listener) => process.stderr.once("drain", listener),
      maxPendingLines: 256,
    }),
  });

  const basicProfiles = profileManager.getBasicAuthProfileNames();
  if (basicProfiles.length > 0) {
    stderrWrite(
      `[servicenow-mcp] WARNING: ${basicProfiles.length} configured profile(s) use ` +
        `ServiceNow basic authentication, which is being phased out (KB3096078).\n`
    );
  }

  await startStdioRuntime({
    identity: resolveIdentity(),
    createServer: (session) =>
      createApplicationServer(
        profileManager,
        session,
        effectivePolicyProvider,
        observability
      ),
  });

  stderrWrite(
    `@onlyflows/servicenow-mcp v${VERSION} ready on stdio -- ` +
      `${REGISTERED_TOOL_COUNT} tools; explicit profile required\n`
  );
}

function createApplicationServer(
  profileManager: ProfileManager,
  session: StdioSessionContext,
  effectivePolicyProvider: EffectivePolicyProvider,
  observability: HttpObservability
) {
  const executionContext: ExecutionContextDependencies = Object.freeze({
    requestMetadataProvider: session.requestMetadataProvider,
    effectivePolicyProvider,
    auditSink: createStdioAuditSink(),
    toolAuditObserver: Object.freeze({
      begin: () => observability.beginTool(),
    }),
  });
  return createMcpServer({
    dependencies: { profileManager, executionContext },
    register: async (surface, dependencies) => {
      registerSetupPrompts(surface);
      await registerServiceNowTools(
        surface,
        dependencies.profileManager,
        dependencies.executionContext
      );
    },
  });
}

/**
 * Records reach stderr through the tool observer, which pseudonymizes the
 * identity and bounds every field. This sink exists because the port is
 * required, and stays inert so one record is never emitted twice.
 *
 * The HTTP sink is not inert for the same reason: it marks that a request
 * produced an audit record, which is a property of a request boundary that
 * stdio does not have.
 */
function createStdioAuditSink(): AuditSink {
  return Object.freeze({
    write(_record: ToolAuditRecord): void {},
    writePreContext(_record: PreContextAuditRecord): void {},
  });
}

/**
 * Say why, on stderr.
 *
 * A client that spawned this process shows its stderr and nothing else, so a
 * bare "startup failed" leaves an operator with no thread to pull. Every error
 * that can land here is authored by this codebase — an environment variable
 * that failed validation, or a profile file that could not be read — and names
 * a setting or a path, never a credential value.
 */
void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown startup error";
  stderrWrite(`[servicenow-mcp] Fatal stdio startup error: ${reason}\n`);
  stderrWrite("[servicenow-mcp] Run servicenow-mcp-setup doctor to diagnose it.\n");
  process.exitCode = 1;
});
