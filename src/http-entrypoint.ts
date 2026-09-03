#!/usr/bin/env node

/**
 * Dormant HTTP composition for @onlyflows/servicenow-mcp.
 *
 * **This is not the transport the product exposes.** stdio is — see
 * `src/index.ts`. Nothing on the CLI path reaches this module: it is not a
 * `bin` entry, `servicenow-mcp` never imports it, and setup never registers a
 * client against a URL.
 *
 * It stays in the tree, compiling and under test, because a listening service
 * is a planned enterprise deployment shape (shared host, reverse proxy, bearer
 * or delegated identity) that is deliberately out of scope for the
 * single-owner release. Deleting it would mean rebuilding the admission,
 * rate-limiting, Host/Origin, and per-request-server work it already carries.
 * See `docs/ENTERPRISE-RELEASE-BOUNDARY.md`.
 *
 * To re-expose it, give it its own `bin` entry in `package.json` pointing at
 * `dist/http-entrypoint.js`, or dispatch to {@link runHttpService} from
 * `src/index.ts` behind an explicit operator choice. Running this file
 * directly starts it today, which is how its tests drive it.
 *
 * @module http-entrypoint
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
  StaticBearerAuthenticationProvider,
  UnauthenticatedIdentityProvider,
  type HttpAuthenticationProvider,
  type HttpAuthenticationRequest,
} from "./http-auth.js";
import {
  createHttpRuntime,
  MAX_HTTP_CONNECTIONS,
  type AuthenticatedHttpRequestContext,
} from "./http-runtime.js";
import {
  createHttpObservability,
  createHttpRateLimiter,
  createBoundedJsonLinesEventSink,
  MAX_RATE_LIMIT_CAPACITY,
  MAX_RATE_LIMIT_ENTRIES,
  MAX_RATE_LIMIT_PERIOD_MS,
  type HttpObservability,
} from "./http-observability.js";
import { createHttpRequestPolicy } from "./http-request-policy.js";
import { ProfileManager, type ProfileManager as ProfileManagerType } from "./profile-manager.js";
import { registerSetupPrompts } from "./setup-prompts.js";
import { createMcpServer } from "./server.js";
import {
  DEFAULT_SHUTDOWN_GRACE_PERIOD_MS,
  createReadinessGate,
  installShutdownCoordinator,
} from "./startup.js";
import {
  createTableAccessPolicy,
  type TableAccessPolicyInput,
} from "./table-policy.js";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_OWNER_ID,
  optionalCommaSeparatedEnvironmentVariable,
  optionalEnvironmentVariable,
  optionalIntegerEnvironmentVariable,
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
 * A startup failure caused by configuration, safe to show the operator.
 *
 * The entrypoint deliberately swallows unexpected startup errors so nothing
 * from a credential path can reach the log. A misconfiguration is different:
 * its message is authored here, contains no secret, and is useless unless the
 * operator can read it. Only these are printed.
 */
class ServiceConfigurationError extends Error {
  public override readonly name = "ServiceConfigurationError";
}

/**
 * Loopback addresses, where "any process on this machine" is the whole reach.
 *
 * An unset host means the runtime's own loopback default, so absence is safe.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

function isLoopbackHost(host: string | undefined): boolean {
  return host === undefined || LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Select the HTTP authentication boundary.
 *
 * Authentication is opt-in. `MCP_BEARER_TOKEN` turns it on and the service then
 * requires and verifies that token on every request. With the variable absent
 * the service serves unauthenticated: any process on this machine that can
 * reach the listening socket is admitted, and the `Host`/`Origin` allowlists,
 * loopback binding, admission and rate limits, and the per-profile table policy
 * are what remain. The warning below is deliberately loud and unconditional;
 * this is a property of the deployment an operator must be able to see in the
 * service log.
 *
 * Setting `MCP_BEARER_TOKEN` to the empty string is a configuration error
 * rather than a way to disable authentication, so a half-applied env file fails
 * to start instead of silently opening the port.
 */
function createAuthenticationProvider(): HttpAuthenticationProvider<HttpAuthenticationRequest> {
  const identity = Object.freeze({
    ownerId: optionalEnvironmentVariable("MCP_OWNER_ID") ?? DEFAULT_OWNER_ID,
    clientId: optionalEnvironmentVariable("MCP_CLIENT_ID") ?? DEFAULT_CLIENT_ID,
  });
  const token = optionalEnvironmentVariable("MCP_BEARER_TOKEN");
  if (token === undefined) {
    // Unauthenticated is a deliberate local convenience: on loopback the reach
    // is this machine, which already holds the credential file. Off loopback it
    // is a ServiceNow proxy open to the network, and the failure mode is a
    // *working* deployment rather than a broken one, so refuse rather than warn.
    // The container image sets MCP_HOST=0.0.0.0, which is exactly this case.
    const host = optionalEnvironmentVariable("MCP_HOST");
    if (!isLoopbackHost(host)) {
      throw new ServiceConfigurationError(
        `MCP_HOST is "${host}", which is not loopback, and MCP_BEARER_TOKEN is not set. ` +
          "That would expose every table these profiles grant to anything that can " +
          "reach the port, with no authentication. Set MCP_BEARER_TOKEN to a random " +
          "value of 32 characters or more, or set MCP_HOST=127.0.0.1 to serve only " +
          "this machine."
      );
    }
    process.stderr.write(
      "[servicenow-mcp] WARNING: MCP_BEARER_TOKEN is not set, so this endpoint " +
        "is UNAUTHENTICATED. Any process on this machine that can reach it may " +
        "use every table these profiles grant. Host/Origin allowlists and the " +
        "listening address are the only remaining boundary. Set " +
        "MCP_BEARER_TOKEN to require a bearer token.\n"
    );
    return new UnauthenticatedIdentityProvider(identity);
  }
  return new StaticBearerAuthenticationProvider([{ token, ...identity }]);
}

/** Start the listening service. Reachable only by running this module. */
export async function runHttpService(): Promise<void> {
  const authenticationProvider = createAuthenticationProvider();
  const host = optionalEnvironmentVariable("MCP_HOST");
  const port = optionalIntegerEnvironmentVariable("MCP_PORT", 0, 65_535);
  const maxConcurrentRequests = optionalIntegerEnvironmentVariable(
    "MCP_MAX_CONCURRENT_REQUESTS",
    1,
    1_024
  );
  const maxConnections = optionalIntegerEnvironmentVariable(
    "MCP_MAX_CONNECTIONS",
    1,
    MAX_HTTP_CONNECTIONS
  );
  const gracePeriodMs =
    optionalIntegerEnvironmentVariable("MCP_SHUTDOWN_GRACE_MS", 1, 300_000) ??
    DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
  const profileManager = new ProfileManager();
  const effectivePolicyProvider = createRestrictedPolicyProvider(
    profileManager,
    encodedQueryAccessPolicyFromEnvironment()
  );
  const httpObservability = createHttpObservability({
    sink: createBoundedJsonLinesEventSink({
      writeLine: (line) => process.stderr.write(line),
      onDrain: (listener) => process.stderr.once("drain", listener),
      maxPendingLines: 256,
    }),
  });
  const httpRateLimiter = createHttpRateLimiter({
    preAuthentication: {
      capacity: optionalIntegerEnvironmentVariable(
        "MCP_PRE_AUTH_RATE_CAPACITY",
        1,
        MAX_RATE_LIMIT_CAPACITY
      ) ?? 240,
      refillPeriodMs: optionalIntegerEnvironmentVariable(
        "MCP_PRE_AUTH_RATE_REFILL_MS",
        1,
        MAX_RATE_LIMIT_PERIOD_MS
      ) ?? 60_000,
      maxEntries: optionalIntegerEnvironmentVariable(
        "MCP_PRE_AUTH_RATE_MAX_ENTRIES",
        1,
        MAX_RATE_LIMIT_ENTRIES
      ) ?? 4_096,
    },
    authenticatedIdentity: {
      capacity: optionalIntegerEnvironmentVariable(
        "MCP_IDENTITY_RATE_CAPACITY",
        1,
        MAX_RATE_LIMIT_CAPACITY
      ) ?? 120,
      refillPeriodMs: optionalIntegerEnvironmentVariable(
        "MCP_IDENTITY_RATE_REFILL_MS",
        1,
        MAX_RATE_LIMIT_PERIOD_MS
      ) ?? 60_000,
      maxEntries: optionalIntegerEnvironmentVariable(
        "MCP_IDENTITY_RATE_MAX_ENTRIES",
        1,
        MAX_RATE_LIMIT_ENTRIES
      ) ?? 128,
    },
  });
  const readiness = createReadinessGate();
  const allowedHosts = optionalCommaSeparatedEnvironmentVariable(
    "MCP_ALLOWED_HOSTS"
  );
  const allowedOrigins = optionalCommaSeparatedEnvironmentVariable(
    "MCP_ALLOWED_ORIGINS"
  );
  const requestPolicy = createHttpRequestPolicy({
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });

  const basicProfiles = profileManager.getBasicAuthProfileNames();
  if (basicProfiles.length > 0) {
    process.stderr.write(
      `[servicenow-mcp] WARNING: ${basicProfiles.length} configured profile(s) use ` +
        `ServiceNow basic authentication, which is being phased out (KB3096078).\n`
    );
  }

  const runtime = createHttpRuntime({
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
    ...(maxConnections === undefined ? {} : { maxConnections }),
    authenticationProvider,
    readinessCheck: readiness.check,
    observability: httpObservability,
    rateLimiter: httpRateLimiter,
    requestPolicy,
    createServer: (requestContext) =>
      createApplicationServer(
        profileManager,
        requestContext,
        effectivePolicyProvider,
        httpObservability
      ),
  });
  const shutdown = installShutdownCoordinator({
    runtime,
    gracePeriodMs,
    onComplete: (signal) => {
      readiness.markNotReady();
      process.stderr.write(`[servicenow-mcp] HTTP shutdown complete (${signal}).\n`);
      process.exit(0);
    },
    onError: (signal) => {
      readiness.markNotReady();
      process.stderr.write(`[servicenow-mcp] HTTP shutdown failed (${signal}).\n`);
      process.exit(1);
    },
  });

  try {
    const address = await runtime.start();
    readiness.markReady();
    process.stderr.write(
      `@onlyflows/servicenow-mcp v${VERSION} listening on ${address.url.href} -- ` +
        `${REGISTERED_TOOL_COUNT} tools; explicit profile required\n`
    );
  } catch {
    readiness.markNotReady();
    shutdown.dispose();
    await runtime.close({ gracePeriodMs: 0 }).catch(() => {});
    throw new Error("HTTP service startup failed");
  }
}

function createApplicationServer(
  profileManager: ProfileManager,
  requestContext: AuthenticatedHttpRequestContext,
  effectivePolicyProvider: EffectivePolicyProvider,
  httpObservability: HttpObservability
) {
  const executionContext: ExecutionContextDependencies = Object.freeze({
    requestMetadataProvider: requestContext.requestMetadataProvider,
    requestSignal: requestContext.signal,
    effectivePolicyProvider,
    auditSink: createHttpAuditSink(requestContext),
    toolAuditObserver: Object.freeze({
      begin: () => httpObservability.beginTool(),
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

function createHttpAuditSink(
  requestContext: AuthenticatedHttpRequestContext
): AuditSink {
  return Object.freeze({
    write(_record: ToolAuditRecord): void {
      requestContext.markToolAuditObserved();
    },
    writePreContext(_record: PreContextAuditRecord): void {
      requestContext.markToolAuditObserved();
    },
  });
}

if (require.main === module) {
  void runHttpService().catch((error: unknown) => {
    process.stderr.write(
      error instanceof ServiceConfigurationError
        ? `[servicenow-mcp] Refusing to start: ${error.message}\n`
        : "[servicenow-mcp] Fatal HTTP service startup error.\n"
    );
    process.exitCode = 1;
  });
}
