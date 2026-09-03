/**
 * stdio transport composition.
 *
 * This is the transport the product exposes. A client spawns the packaged
 * binary and speaks JSON-RPC over the child's stdin/stdout, so there is no
 * listening socket, no request admission boundary, and no network identity to
 * authenticate: the operating system already decided who may spawn this
 * process, and it runs as that person.
 *
 * Two consequences shape everything below.
 *
 * 1. **stdout belongs to the protocol.** Every framed JSON-RPC message the
 *    server sends travels on stdout. One stray byte written there by anything
 *    else desynchronizes the client's parser and breaks the session. All
 *    diagnostics therefore go to stderr, which the client captures as a log.
 *
 * 2. **The environment is the client's, not the operator's.** The client
 *    spawns this process with whatever environment it happens to hold, so the
 *    values setup wrote to the owner-only `server.env` are not present unless
 *    this process reads them itself. {@link loadServerEnvironmentFile} does
 *    exactly that, and never overrides a value the parent did supply.
 *
 * @module stdio-runtime
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  immutableRequestMetadata,
  type OwnerClientIdentity,
  type RequestMetadataProvider,
  type ToolInvocationMetadata,
} from "./execution-context.js";

/** Owner-only file setup writes; the only place the encryption key is stored. */
export const SERVER_ENV_RELATIVE_PATH = ".servicenow-mcp/server.env";

/**
 * Environment names this process will adopt from `server.env`.
 *
 * A conservative shape rather than an allowlist of exact names: an operator may
 * legitimately add `SN_ALLOWED_INSTANCE_HOSTS`, a `secret_ref` target, or a
 * future setting to that file, and refusing to load it would be a silent
 * misconfiguration. Anything that is not a plain uppercase identifier is
 * ignored, so a malformed line cannot introduce a strangely named variable.
 */
const ADOPTABLE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface LoadServerEnvironmentOptions {
  /** Defaults to `os.homedir()`. */
  readonly home?: string;
  /** Defaults to `process.env`; mutated in place for names it does not hold. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to a stderr write; diagnostics must never reach stdout. */
  readonly warn?: (message: string) => void;
}

export interface LoadedServerEnvironment {
  readonly path: string;
  /** False when the file does not exist or could not be read. */
  readonly loaded: boolean;
  /** Names taken from the file, in file order. Never their values. */
  readonly applied: readonly string[];
}

/**
 * Merge the owner-only `server.env` into this process's environment.
 *
 * An explicitly supplied value always wins. That keeps container deployments,
 * CI, and tests — all of which pass configuration directly — behaving exactly
 * as they did, and makes the file a fallback rather than an override.
 *
 * A missing file is not an error. A profile whose credential is a `secret_ref`
 * needs nothing from it, and the resulting failure (if any) belongs to the
 * credential resolver, which explains what is missing far better than a
 * startup abort could.
 */
export function loadServerEnvironmentFile(
  options: LoadServerEnvironmentOptions = {}
): LoadedServerEnvironment {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => stderrWrite(message));
  const path = join(options.home ?? homedir(), SERVER_ENV_RELATIVE_PATH);

  if (!existsSync(path)) {
    return Object.freeze({ path, loaded: false, applied: Object.freeze([]) });
  }

  let content: string;
  try {
    warnOnLooseMode(path, warn);
    content = readFileSync(path, "utf8");
  } catch (error) {
    warn(
      `[servicenow-mcp] WARNING: could not read ${path}: ${describeError(error)}. ` +
        "Configuration must come from the environment instead.\n"
    );
    return Object.freeze({ path, loaded: false, applied: Object.freeze([]) });
  }

  const applied: string[] = [];
  for (const [name, value] of parseEnvironmentFile(content)) {
    if (!ADOPTABLE_ENVIRONMENT_NAME.test(name)) continue;
    if (env[name] !== undefined) continue;
    env[name] = value;
    applied.push(name);
  }
  return Object.freeze({ path, loaded: true, applied: Object.freeze(applied) });
}

/**
 * The file holds the profile encryption key. A mode wider than owner-only means
 * that key has already been readable by others, which refusing to start would
 * not undo — so this reports rather than aborts, and `doctor` fails on it.
 */
function warnOnLooseMode(path: string, warn: (message: string) => void): void {
  if (process.platform === "win32") return;
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    return;
  }
  if (mode === 0o600) return;
  warn(
    `[servicenow-mcp] WARNING: ${path} is mode 0${mode.toString(8).padStart(3, "0")}, ` +
      "expected 0600. It holds this install's profile encryption key. " +
      `Run: chmod 600 ${path}\n`
  );
}

/**
 * Parse the `KEY='value'` form {@link writeSecureEnvFile} produces in setup.
 *
 * Deliberately not a general dotenv implementation: no interpolation, no
 * `export` prefix, no multi-line values. It reads back exactly what setup
 * wrote, and ignores anything else rather than guessing.
 */
function parseEnvironmentFile(content: string): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    entries.push([
      trimmed.slice(0, separator),
      unquoteShellValue(trimmed.slice(separator + 1)),
    ]);
  }
  return entries;
}

function unquoteShellValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/'\\''/gu, "'");
  }
  return raw;
}

/**
 * Correlation identity for one stdio session.
 *
 * Under HTTP a correlation ID is derived from the request, because one process
 * serves many callers. Under stdio the process *is* the session: one client
 * spawned it and no other caller can reach it. So the session gets a random
 * identifier at startup and each invocation gets a fresh random suffix — the
 * pair groups a session's audit records together without deriving anything from
 * caller-supplied text, which under HTTP is what the hash was defending
 * against.
 */
export function createStdioCorrelationIdFactory(
  sessionId: string = randomUUID()
): (invocation: ToolInvocationMetadata) => string {
  const session = sessionId;
  return () => `stdio-${session}-${randomUUID()}`;
}

/**
 * Bind the process identity into the tool execution context.
 *
 * Invocation hints are ignored for the same reason the HTTP provider ignores
 * them: an MCP payload must never be able to nominate the identity that lands
 * in an audit record.
 */
export function createStdioRequestMetadataProvider(
  identity: OwnerClientIdentity,
  correlationIdFactory: (
    invocation: ToolInvocationMetadata
  ) => string = createStdioCorrelationIdFactory()
): RequestMetadataProvider {
  if (typeof correlationIdFactory !== "function") {
    throw new TypeError("correlation ID factory must be a function");
  }
  // Validated and frozen once, so a later mutation of the caller's object
  // cannot change what subsequent audit records are attributed to.
  const bound = immutableRequestMetadata({
    correlationId: "stdio-identity-probe",
    identity,
  }).identity;
  return Object.freeze({
    resolve: (invocation: ToolInvocationMetadata) =>
      immutableRequestMetadata({
        correlationId: correlationIdFactory(invocation),
        identity: bound,
      }),
  });
}

/** The one long-lived session an stdio process serves. */
export interface StdioSessionContext {
  readonly identity: OwnerClientIdentity;
  readonly requestMetadataProvider: RequestMetadataProvider;
}

export interface StdioRuntimeOptions {
  readonly identity: OwnerClientIdentity;
  /** Builds the server for this session. Must return an unconnected server. */
  readonly createServer: (
    context: StdioSessionContext
  ) => McpServer | Promise<McpServer>;
  /** Injected for tests; defaults to this process's stdin/stdout. */
  readonly createTransport?: () => Transport;
}

export interface StdioRuntime {
  readonly server: McpServer;
  readonly context: StdioSessionContext;
  close(): Promise<void>;
}

/**
 * Build the server for this session and connect it to stdio.
 *
 * Unlike the HTTP runtime there is no per-request server: the transport is the
 * process, so one server lives for as long as the client keeps the pipe open.
 * The unconnected-server check mirrors the HTTP factory's, so a registrar that
 * connects during construction fails the same way on both transports.
 */
export async function startStdioRuntime(
  options: StdioRuntimeOptions
): Promise<StdioRuntime> {
  const context: StdioSessionContext = Object.freeze({
    identity: Object.freeze({ ...options.identity }),
    requestMetadataProvider: createStdioRequestMetadataProvider(options.identity),
  });

  const server = await options.createServer(context);
  if (typeof server?.connect !== "function" || typeof server.isConnected !== "function") {
    throw new TypeError("stdio server factory must return an McpServer");
  }
  if (server.isConnected()) {
    throw new TypeError("stdio server factory must return an unconnected McpServer");
  }

  const transport = (options.createTransport ?? defaultStdioTransport)();
  try {
    await server.connect(transport);
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }

  return Object.freeze({
    server,
    context,
    close: async (): Promise<void> => {
      await server.close();
    },
  });
}

function defaultStdioTransport(): Transport {
  return new StdioServerTransport();
}

/** Diagnostics channel. Never stdout: stdout carries JSON-RPC frames. */
export function stderrWrite(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    // A closed or broken stderr must not take the protocol session down.
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
