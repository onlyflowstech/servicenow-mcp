#!/usr/bin/env node

/**
 * Interactive-safe local bootstrap for @onlyflows/servicenow-mcp.
 *
 * Four subcommands, none of which ever accept, print, or log a secret value:
 *
 * - `init` (default) generates owner-only local env files, registers the
 *   clients whose CLI can hold a bearer by reference, and prints
 *   copy-pasteable configuration for the clients that cannot.
 * - `client` prints that configuration for one named client on demand.
 * - `grant` writes least-privilege `tableAccess` rules onto an existing
 *   profile, which is otherwise only reachable by hand-editing the
 *   owner-only profile file.
 * - `doctor` diagnoses a local install end to end and reports the exact
 *   remedy for each failure.
 *
 * @module setup
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { credentialSourceKind } from "./profile-credentials.js";
import { ProfileManager } from "./profile-manager.js";
import {
  createTableAccessPolicy,
  type TableAccessPolicyInput,
  type TableAccessTargetInput,
} from "./table-policy.js";

export interface SetupCliDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly home?: string;
  readonly writeStdout?: (value: string) => void;
  readonly writeStderr?: (value: string) => void;
  readonly commandExists?: (command: string) => boolean;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv
  ) => CommandResult;
  /** Injected for tests; defaults to the real profile store under `home`. */
  readonly profileManager?: ProfileManager;
  /** Injected for tests; defaults to global fetch. */
  readonly probe?: (url: string, init: ProbeRequest) => Promise<ProbeResponse>;
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
}

export interface ProbeRequest {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export interface ProbeResponse {
  readonly status: number;
  readonly body: string;
}

type Subcommand = "init" | "client" | "grant" | "doctor";

type ClientTarget =
  | "codex"
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "windsurf";

/** Clients this bootstrap can register without putting a bearer in argv or client config. */
const AUTO_REGISTERED_CLIENTS: readonly ClientTarget[] = Object.freeze([
  "codex",
  "claude-code",
]);

const ALL_CLIENTS: readonly ClientTarget[] = Object.freeze([
  "codex",
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
  "windsurf",
]);

interface InitOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly rotateEncryptionKey: boolean;
  readonly allowInsecureHttp: boolean;
  readonly json: boolean;
  readonly endpoint: string;
  readonly clients: readonly ClientTarget[];
}

interface ClientOptions {
  readonly endpoint: string;
  readonly clients: readonly ClientTarget[];
}

interface GrantOptions {
  readonly profile: string;
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly tools?: readonly string[];
  readonly related: ReadonlyMap<string, readonly string[]>;
  readonly replace: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
}

interface DoctorOptions {
  readonly profile?: string;
  readonly endpoint: string;
  readonly offline: boolean;
  readonly json: boolean;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:3000/mcp";
const CONFIG_RELATIVE_DIR = ".servicenow-mcp";
const SERVER_ENV_RELATIVE_PATH = `${CONFIG_RELATIVE_DIR}/server.env`;
const CLIENT_ENV_RELATIVE_PATH = `${CONFIG_RELATIVE_DIR}/client.env`;
const HEADER_FILE_RELATIVE_PATH = `${CONFIG_RELATIVE_DIR}/client-headers.txt`;
const PROFILE_CONFIG_RELATIVE_PATH = `${CONFIG_RELATIVE_DIR}/config.json`;
const MCP_SERVER_NAME = "servicenow-mcp";
const CLIENT_BEARER_ENV = "SERVICENOW_MCP_BEARER_TOKEN";
const ENCRYPTION_KEY_ENV = "SN_PROFILE_ENCRYPTION_KEY";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const MINIMUM_NODE_MAJOR = 20;
const PROBE_TIMEOUT_MS = 5_000;

/** Tables addressable by a read grant when `--tools` is not given. */
const DEFAULT_READ_TOOLS: readonly string[] = Object.freeze([
  "sn_query",
  "sn_get",
  "sn_aggregate",
  "sn_schema",
]);

/**
 * Tables addressable by a write grant when `--tools` is not given.
 * Deliberately excludes `sn_delete` and `sn_batch`: those are
 * destructive or multi-table and should be named explicitly with `--tools`.
 */
const DEFAULT_WRITE_TOOLS: readonly string[] = Object.freeze([
  "sn_create",
  "sn_update",
]);

export async function runSetupCli(
  dependencies: SetupCliDependencies = {}
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const argv = normalizeArgv(dependencies.argv ?? process.argv.slice(2));
  const out = dependencies.writeStdout ?? ((value) => process.stdout.write(value));
  const err = dependencies.writeStderr ?? ((value) => process.stderr.write(value));
  const home = dependencies.home ?? env.HOME ?? homedir();
  const { subcommand, args } = splitSubcommand(argv);

  switch (subcommand) {
    case "client":
      runClient(parseClientArguments(args), home, out);
      return;
    case "grant":
      runGrant(parseGrantArguments(args), home, dependencies, out);
      return;
    case "doctor":
      await runDoctor(parseDoctorArguments(args), home, env, dependencies, out);
      return;
    case "init":
      await runInit(parseInitArguments(args), home, env, dependencies, out, err);
      return;
  }
}

// ── init ───────────────────────────────────────────────────────────

async function runInit(
  options: InitOptions,
  home: string,
  env: NodeJS.ProcessEnv,
  dependencies: SetupCliDependencies,
  out: (value: string) => void,
  err: (value: string) => void
): Promise<void> {
  const paths = resolvePaths(home);

  if (options.dryRun) {
    out(
      options.json
        ? `${JSON.stringify(renderDryRunReport(paths, options), null, 2)}\n`
        : renderDryRunText(paths, home, options)
    );
    return;
  }

  const values = loadOrCreateBootstrapValues(paths, options);
  const clientEnvValues = Object.freeze({
    [CLIENT_BEARER_ENV]: values.MCP_BEARER_TOKEN,
  });

  writeSecureEnvFile(paths.serverEnv, values);
  writeSecureEnvFile(paths.clientEnv, clientEnvValues);
  writeSecureFile(
    paths.headerFile,
    `# ServiceNow MCP bearer header for mcp-remote --header-file.\n` +
      `Authorization: Bearer ${values.MCP_BEARER_TOKEN}\n`
  );

  const commandExists = dependencies.commandExists ?? defaultCommandExists;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const configuredClients: string[] = [];
  const skippedClients: string[] = [];
  const childEnv = { ...env, ...clientEnvValues };

  for (const client of options.clients) {
    if (!AUTO_REGISTERED_CLIENTS.includes(client)) {
      skippedClients.push(`${client} (no CLI that keeps the bearer by reference)`);
      continue;
    }
    const registration = registerClient(client, options.endpoint, options.force, {
      commandExists,
      runCommand,
      env: childEnv,
    });
    if (registration.ok) configuredClients.push(client);
    else skippedClients.push(`${client} (${registration.reason})`);
  }

  const manualClients = options.clients.filter(
    (client) => !configuredClients.includes(client)
  );

  const report = {
    status: "configured",
    files: {
      server_env: paths.serverEnv,
      client_env: paths.clientEnv,
      client_header_file: paths.headerFile,
    },
    endpoint: options.endpoint,
    clients: configuredClients,
    skipped_clients: skippedClients,
    start_command: `set -a; source ${shellQuote(paths.serverEnv)}; set +a; servicenow-mcp`,
    client_env_command: `set -a; source ${shellQuote(paths.clientEnv)}; set +a`,
    profile_command:
      "servicenow-mcp-profile create --name dev --instance https://yourinstance.service-now.com --auth-type oauth --client-id <client-id> --source reference --provider env",
    grant_command:
      "servicenow-mcp-setup grant --profile dev --read incident --write incident",
    doctor_command: "servicenow-mcp-setup doctor --profile dev",
    notes: [
      "Generated bearer and owner/client IDs are stored in owner-only env files, not client config.",
      "A profile with no tableAccess rules denies every tool call; run the grant command before first use.",
      "Create ServiceNow profiles with servicenow-mcp-profile; protected values are prompted or read from bounded stdin, never argv.",
    ],
  } as const;

  out(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderInitText(paths, home, options, configuredClients, skippedClients, manualClients)
  );

  if (skippedClients.length > 0) {
    err(`[servicenow-mcp] skipped client setup: ${skippedClients.join(", ")}\n`);
  }
}

interface RegistrationContext {
  readonly commandExists: (command: string) => boolean;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv
  ) => CommandResult;
  readonly env: NodeJS.ProcessEnv;
}

function registerClient(
  client: ClientTarget,
  endpoint: string,
  force: boolean,
  context: RegistrationContext
): { ok: true } | { ok: false; reason: string } {
  const binary = client === "codex" ? "codex" : "claude";
  if (!context.commandExists(binary)) {
    return { ok: false, reason: `${binary} CLI not found` };
  }
  const result =
    client === "codex"
      ? configureCodex(endpoint, force, context)
      : configureClaudeCode(endpoint, force, context);
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    reason: result.error?.message ?? result.stderr ?? "configuration command failed",
  };
}

function configureCodex(
  endpoint: string,
  force: boolean,
  context: RegistrationContext
): CommandResult {
  const existing = context.runCommand("codex", ["mcp", "get", MCP_SERVER_NAME], context.env);
  if (existing.status === 0) {
    if (!force) return Object.freeze({ status: 0 });
    const removed = context.runCommand(
      "codex",
      ["mcp", "remove", MCP_SERVER_NAME],
      context.env
    );
    if (removed.status !== 0) return removed;
  }
  return context.runCommand(
    "codex",
    [
      "mcp",
      "add",
      MCP_SERVER_NAME,
      "--url",
      endpoint,
      "--bearer-token-env-var",
      CLIENT_BEARER_ENV,
    ],
    context.env
  );
}

/**
 * Claude Code stores the literal `${VAR}` text and expands it when the config
 * loads, so the bearer never enters argv, the config file, or shell history.
 */
function configureClaudeCode(
  endpoint: string,
  force: boolean,
  context: RegistrationContext
): CommandResult {
  const existing = context.runCommand(
    "claude",
    ["mcp", "get", MCP_SERVER_NAME],
    context.env
  );
  if (existing.status === 0) {
    if (!force) return Object.freeze({ status: 0 });
    const removed = context.runCommand(
      "claude",
      ["mcp", "remove", MCP_SERVER_NAME, "--scope", "user"],
      context.env
    );
    if (removed.status !== 0) return removed;
  }
  return context.runCommand(
    "claude",
    [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "--header",
      `Authorization: Bearer \${${CLIENT_BEARER_ENV}}`,
      MCP_SERVER_NAME,
      endpoint,
    ],
    context.env
  );
}

// ── client ─────────────────────────────────────────────────────────

function runClient(
  options: ClientOptions,
  home: string,
  out: (value: string) => void
): void {
  const paths = resolvePaths(home);
  const sections = options.clients.map((client) =>
    renderClientConfiguration(client, options.endpoint, paths)
  );
  out(`${sections.join("\n")}\n`);
}

interface ResolvedPaths {
  readonly configDir: string;
  readonly serverEnv: string;
  readonly clientEnv: string;
  readonly headerFile: string;
  readonly profileConfig: string;
}

function renderClientConfiguration(
  client: ClientTarget,
  endpoint: string,
  paths: ResolvedPaths
): string {
  const heading = `## ${client}\n`;
  switch (client) {
    case "codex":
      return (
        `${heading}\n` +
        `Export the bearer, then register by env-var reference:\n\n` +
        `  set -a; source ${shellQuote(paths.clientEnv)}; set +a\n` +
        `  codex mcp add ${MCP_SERVER_NAME} --url ${endpoint} --bearer-token-env-var ${CLIENT_BEARER_ENV}\n`
      );
    case "claude-code":
      return (
        `${heading}\n` +
        `Claude Code expands \${VAR} when the config loads, so the literal\n` +
        `placeholder below keeps the bearer out of argv and out of the config file.\n\n` +
        `  set -a; source ${shellQuote(paths.clientEnv)}; set +a\n` +
        `  claude mcp add --transport http --scope user \\\n` +
        `    --header 'Authorization: Bearer \${${CLIENT_BEARER_ENV}}' \\\n` +
        `    ${MCP_SERVER_NAME} ${endpoint}\n\n` +
        `Equivalent .mcp.json entry:\n\n` +
        `${indent(
          JSON.stringify(
            {
              mcpServers: {
                [MCP_SERVER_NAME]: {
                  type: "http",
                  url: endpoint,
                  headers: {
                    Authorization: `Bearer \${${CLIENT_BEARER_ENV}}`,
                  },
                },
              },
            },
            null,
            2
          )
        )}\n\n` +
        `${CLIENT_BEARER_ENV} must be present in Claude Code's own environment.\n` +
        `When it is missing, Claude Code loads the config, warns, and sends the\n` +
        `literal placeholder, which the server rejects with HTTP 401.\n`
      );
    case "claude-desktop":
    case "cursor":
    case "windsurf": {
      const location =
        client === "claude-desktop"
          ? "~/Library/Application Support/Claude/claude_desktop_config.json (macOS)\n" +
            "  %APPDATA%\\Claude\\claude_desktop_config.json (Windows)"
          : client === "cursor"
            ? "~/.cursor/mcp.json (global) or .cursor/mcp.json (per project)"
            : "~/.codeium/windsurf/mcp_config.json";
      const bridge = JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                endpoint,
                "--transport",
                "http-only",
                "--allow-http",
                "--header-file",
                paths.headerFile,
              ],
            },
          },
        },
        null,
        2
      );
      const native =
        client === "cursor"
          ? `\nCursor 1.0 and newer can also address the endpoint directly:\n\n${indent(
              JSON.stringify(
                {
                  mcpServers: {
                    [MCP_SERVER_NAME]: {
                      url: endpoint,
                      headers: {
                        Authorization: `Bearer \${env:${CLIENT_BEARER_ENV}}`,
                      },
                    },
                  },
                },
                null,
                2
              )
            )}\n`
          : "";
      return (
        `${heading}\n` +
        `Config file:\n  ${location}\n\n` +
        `This client speaks stdio, so bridge it with mcp-remote. --header-file\n` +
        `reads the bearer from the owner-only file, keeping it out of argv and\n` +
        `out of the client config:\n\n` +
        `${indent(bridge)}\n` +
        `Drop --allow-http once the endpoint is HTTPS.\n${native}`
      );
    }
    case "vscode": {
      const config = JSON.stringify(
        {
          inputs: [
            {
              type: "promptString",
              id: "servicenow-mcp-bearer",
              description: "ServiceNow MCP bearer token",
              password: true,
            },
          ],
          servers: {
            [MCP_SERVER_NAME]: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: "Bearer ${input:servicenow-mcp-bearer}",
              },
            },
          },
        },
        null,
        2
      );
      return (
        `${heading}\n` +
        `Config file:\n  .vscode/mcp.json (workspace) or the user-level mcp.json\n\n` +
        `${indent(config)}\n` +
        `VS Code prompts once and stores the value in its own secret storage.\n` +
        `Read the token from ${paths.clientEnv} when it prompts.\n`
      );
    }
  }
}

// ── grant ──────────────────────────────────────────────────────────

function runGrant(
  options: GrantOptions,
  home: string,
  dependencies: SetupCliDependencies,
  out: (value: string) => void
): void {
  const manager = dependencies.profileManager ?? profileManagerFor(home);
  const current = manager.getProfile(options.profile);
  const existing: TableAccessPolicyInput = options.replace
    ? Object.freeze({})
    : (current.tableAccess ?? Object.freeze({}));

  const readTables = new Set([...(existing.readTables ?? []), ...options.read]);
  const writeTables = new Set([...(existing.writeTables ?? []), ...options.write]);
  const targets = mergeTargets(existing.targets, options, readTables, writeTables);

  // A target asserts that relatedTables is its complete reachable closure, and
  // the policy loader requires every one of those tables to carry the same
  // operation permission. They stay out of `targets`, so they are reachable
  // through the target but never directly addressable by a caller.
  for (const target of targets) {
    if (readTables.has(target.table)) {
      for (const related of target.relatedTables) readTables.add(related);
    }
    if (writeTables.has(target.table)) {
      for (const related of target.relatedTables) writeTables.add(related);
    }
  }

  const tableAccess: TableAccessPolicyInput = Object.freeze({
    readTables: sorted(readTables),
    writeTables: sorted(writeTables),
    targets,
  });

  // Validate against the real decision-time policy loader rather than a copy
  // of its rules, so a rejected grant fails here instead of at first tool call.
  createTableAccessPolicy(tableAccess);

  if (options.dryRun) {
    out(
      options.json
        ? `${JSON.stringify({ status: "dry-run", profile: options.profile, tableAccess }, null, 2)}\n`
        : `Would write to profile ${options.profile}:\n${indent(JSON.stringify(tableAccess, null, 2))}\n`
    );
    return;
  }

  manager.addProfile(options.profile, { ...current, tableAccess });

  if (options.json) {
    out(`${JSON.stringify({ status: "granted", profile: options.profile, tableAccess }, null, 2)}\n`);
    return;
  }
  out(
    `Granted table access on profile ${options.profile}.\n\n` +
      `${indent(JSON.stringify(tableAccess, null, 2))}\n\n` +
      `Each target asserts closureComplete: true, meaning relatedTables lists every\n` +
      `backing, ancestor, and descendant table the operation can reach. Pass\n` +
      `--related "<table>=<t1>,<t2>" when a table extends or views another one;\n` +
      `related tables join the allowlist but get no target, so a caller cannot\n` +
      `address them directly.\n` +
      `Restart the service for the change to take effect.\n`
  );
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...values].sort());
}

function mergeTargets(
  existing: readonly TableAccessTargetInput[] | undefined,
  options: GrantOptions,
  readTables: ReadonlySet<string>,
  writeTables: ReadonlySet<string>
): readonly TableAccessTargetInput[] {
  const byTable = new Map<string, TableAccessTargetInput>();
  for (const target of existing ?? []) byTable.set(target.table, target);

  for (const table of new Set([...options.read, ...options.write])) {
    const tools = new Set(byTable.get(table)?.tools ?? []);
    if (options.tools) {
      for (const tool of options.tools) tools.add(tool);
    } else {
      if (readTables.has(table)) {
        for (const tool of DEFAULT_READ_TOOLS) tools.add(tool);
      }
      if (writeTables.has(table)) {
        for (const tool of DEFAULT_WRITE_TOOLS) tools.add(tool);
      }
    }
    const related = new Set([
      table,
      ...(byTable.get(table)?.relatedTables ?? []),
      ...(options.related.get(table) ?? []),
    ]);
    byTable.set(
      table,
      Object.freeze({
        table,
        kind: "canonical",
        tools: Object.freeze([...tools].sort()),
        closureComplete: true,
        relatedTables: Object.freeze([...related].sort()),
      })
    );
  }
  return Object.freeze([...byTable.values()]);
}

// ── doctor ─────────────────────────────────────────────────────────

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly remedy?: string;
}

async function runDoctor(
  options: DoctorOptions,
  home: string,
  env: NodeJS.ProcessEnv,
  dependencies: SetupCliDependencies,
  out: (value: string) => void
): Promise<void> {
  const paths = resolvePaths(home);
  const checks: Check[] = [];

  checks.push(checkNodeVersion());
  checks.push(checkDirectoryMode(paths.configDir));
  checks.push(...checkEnvFile(paths.serverEnv, ["MCP_BEARER_TOKEN", "MCP_OWNER_ID", "MCP_CLIENT_ID"]));
  checks.push(...checkProfiles(paths, home, env, dependencies, options.profile));

  if (!options.offline) {
    checks.push(...(await checkEndpoint(options.endpoint, paths, dependencies)));
  }

  const failed = checks.filter((check) => !check.ok);
  if (options.json) {
    out(
      `${JSON.stringify(
        { status: failed.length === 0 ? "ok" : "problems", checks },
        null,
        2
      )}\n`
    );
  } else {
    out(renderDoctorText(checks));
  }
  if (failed.length > 0) process.exitCode = 1;
}

function checkNodeVersion(): Check {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return major >= MINIMUM_NODE_MAJOR
    ? { name: "node", ok: true, detail: `v${process.versions.node}` }
    : {
        name: "node",
        ok: false,
        detail: `v${process.versions.node}`,
        remedy: `This package requires Node.js ${MINIMUM_NODE_MAJOR} or newer.`,
      };
}

function checkDirectoryMode(path: string): Check {
  if (!existsSync(path)) {
    return {
      name: "config directory",
      ok: false,
      detail: `${path} is missing`,
      remedy: "Run: servicenow-mcp-setup",
    };
  }
  const mode = statSync(path).mode & 0o777;
  if (process.platform === "win32" || mode === 0o700) {
    return { name: "config directory", ok: true, detail: `${path} (${formatMode(mode)})` };
  }
  return {
    name: "config directory",
    ok: false,
    detail: `${path} is ${formatMode(mode)}, expected 0700`,
    remedy: `Run: chmod 700 ${path}`,
  };
}

function checkEnvFile(path: string, required: readonly string[]): readonly Check[] {
  if (!existsSync(path)) {
    return [
      {
        name: "server env",
        ok: false,
        detail: `${path} is missing`,
        remedy: "Run: servicenow-mcp-setup",
      },
    ];
  }
  const checks: Check[] = [];
  const mode = statSync(path).mode & 0o777;
  if (process.platform === "win32" || mode === 0o600) {
    checks.push({ name: "server env", ok: true, detail: `${path} (${formatMode(mode)})` });
  } else {
    checks.push({
      name: "server env",
      ok: false,
      detail: `${path} is ${formatMode(mode)}, expected 0600`,
      remedy: `Run: chmod 600 ${path}`,
    });
  }
  const values = parseEnvFile(readFileSync(path, "utf8"));
  const missing = required.filter((key) => !values[key]);
  checks.push(
    missing.length === 0
      ? { name: "server env values", ok: true, detail: `${required.length} required values present` }
      : {
          name: "server env values",
          ok: false,
          detail: `missing ${missing.join(", ")}`,
          remedy: `Run: servicenow-mcp-setup --force (this preserves ${ENCRYPTION_KEY_ENV})`,
        }
  );
  return checks;
}

function checkProfiles(
  paths: ResolvedPaths,
  home: string,
  env: NodeJS.ProcessEnv,
  dependencies: SetupCliDependencies,
  only: string | undefined
): readonly Check[] {
  const checks: Check[] = [];
  if (!existsSync(paths.profileConfig) && dependencies.profileManager === undefined) {
    return [
      {
        name: "profiles",
        ok: false,
        detail: `${paths.profileConfig} does not exist`,
        remedy:
          "Create one: servicenow-mcp-profile create --name dev --instance https://yourinstance.service-now.com --auth-type oauth --client-id <id> --source reference --provider env",
      },
    ];
  }

  let manager: ProfileManager;
  try {
    manager = dependencies.profileManager ?? profileManagerFor(home);
  } catch (error) {
    return [
      {
        name: "profiles",
        ok: false,
        detail: describeError(error),
        remedy: `Inspect ${paths.profileConfig}; it must be owner-only JSON with mode 0600.`,
      },
    ];
  }

  const names = manager
    .listProfiles()
    .map((entry) => entry.name)
    .filter((name) => only === undefined || name === only);

  if (names.length === 0) {
    return [
      {
        name: "profiles",
        ok: false,
        detail: only ? `profile "${only}" is not configured` : "no profiles configured",
        remedy: "Create one with servicenow-mcp-profile create.",
      },
    ];
  }

  for (const name of names) {
    const profile = manager.getProfile(name);
    checks.push(checkInstanceUrl(name, profile.instance));
    checks.push(checkCredential(manager, name));
    checks.push(checkTableAccess(name, profile.tableAccess));
  }

  const envAllowlist =
    env.SN_ALLOWED_READ_TABLES ?? env.SN_ALLOWED_WRITE_TABLES ?? env.SN_TABLE_ACCESS_TARGETS;
  if (envAllowlist !== undefined) {
    checks.push({
      name: "env table allowlist",
      ok: false,
      detail:
        "SN_ALLOWED_READ_TABLES / SN_ALLOWED_WRITE_TABLES / SN_TABLE_ACCESS_TARGETS are set, but a profile file exists",
      remedy:
        "Those variables apply only when no profile file exists. Move the rules onto the profile: servicenow-mcp-setup grant --profile <name> --read <tables>",
    });
  }
  return checks;
}

function checkInstanceUrl(name: string, instance: string): Check {
  let url: URL;
  try {
    url = new URL(instance);
  } catch {
    return {
      name: `profile ${name}: instance`,
      ok: false,
      detail: `"${instance}" is not an absolute URL`,
      remedy: "Use the full origin, for example https://yourinstance.service-now.com",
    };
  }
  if (url.protocol !== "https:") {
    return {
      name: `profile ${name}: instance`,
      ok: false,
      detail: `"${instance}" is not https`,
      remedy: "ServiceNow instances are HTTPS; credentials must never travel in cleartext.",
    };
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return {
      name: `profile ${name}: instance`,
      ok: false,
      detail: `"${instance}" carries a path, query, or fragment`,
      remedy: `Use the bare origin: ${url.origin}`,
    };
  }
  return { name: `profile ${name}: instance`, ok: true, detail: url.origin };
}

function checkCredential(manager: ProfileManager, name: string): Check {
  const profile = manager.getProfile(name);
  const authType = profile.authType ?? "basic";
  const field =
    authType === "oauth" ? "clientSecret" : authType === "apikey" ? "apiKey" : "credential";
  const kind = credentialSourceKind(profile[field]);
  try {
    if (authType === "basic" || profile.grantType === "password") {
      manager.resolveCredential(profile);
    } else {
      manager.getConfig(name);
    }
    return {
      name: `profile ${name}: credential`,
      ok: true,
      detail: `${authType} ${field} resolves from its ${kind} source`,
    };
  } catch (error) {
    return {
      name: `profile ${name}: credential`,
      ok: false,
      detail: `${authType} ${field} (${kind} source): ${describeError(error)}`,
      remedy: credentialRemedy(kind, name, field, describeError(error)),
    };
  }
}

/**
 * The reference *name* is deliberately not printed: `servicenow-mcp-profile
 * inspect` reports source kinds only, and doctor keeps that boundary.
 */
function credentialRemedy(
  kind: "secret_ref" | "encrypted" | "missing",
  profile: string,
  field: string,
  message: string
): string {
  if (kind === "missing") {
    return `This profile has no ${field}. Add it: servicenow-mcp-profile rotate --name ${profile} --field ${field}`;
  }
  if (kind === "encrypted" || message.toLowerCase().includes("encryption key")) {
    return (
      `The value is an encrypted envelope. Inject the matching ${ENCRYPTION_KEY_ENV} ` +
      `(32 random bytes, base64 or base64url) into this process — it is in the server ` +
      `env file that setup wrote. A wrong key cannot be distinguished from a corrupt ` +
      `envelope, so re-enter the value with servicenow-mcp-profile rotate if the key is right.`
    );
  }
  return (
    `The value is a secret_ref, so the referenced environment variable must be set in ` +
    `this process and in the service process. Run "servicenow-mcp-profile inspect --name ` +
    `${profile}" to confirm the source, then export the variable your operator injects.`
  );
}

function checkTableAccess(
  name: string,
  tableAccess: TableAccessPolicyInput | undefined
): Check {
  const readCount = tableAccess?.readTables?.length ?? 0;
  const writeCount = tableAccess?.writeTables?.length ?? 0;
  if (readCount === 0 && writeCount === 0) {
    return {
      name: `profile ${name}: table access`,
      ok: false,
      detail: "no tableAccess rules; every tool call is denied",
      remedy: `Run: servicenow-mcp-setup grant --profile ${name} --read incident`,
    };
  }
  const targets = tableAccess?.targets ?? [];
  // A table is accounted for if it has its own target (caller-addressable) or
  // appears in some target's closure (reachable, deliberately not addressable).
  const accounted = new Set<string>();
  for (const target of targets) {
    accounted.add(target.table);
    for (const related of target.relatedTables) accounted.add(related);
  }
  const wildcard =
    tableAccess?.readTables?.includes("*") === true ||
    tableAccess?.writeTables?.includes("*") === true;
  const unaddressable = [
    ...(tableAccess?.readTables ?? []),
    ...(tableAccess?.writeTables ?? []),
  ].filter((table) => table !== "*" && !accounted.has(table));
  if (!wildcard && unaddressable.length > 0) {
    return {
      name: `profile ${name}: table access`,
      ok: false,
      detail: `allowlisted but unreachable — no target entry and in no target's closure: ${[...new Set(unaddressable)].join(", ")}`,
      remedy: `Run: servicenow-mcp-setup grant --profile ${name} --read ${[...new Set(unaddressable)].join(",")}`,
    };
  }
  return {
    name: `profile ${name}: table access`,
    ok: true,
    detail: `${readCount} read, ${writeCount} write, ${targets.length} target(s)`,
  };
}

async function checkEndpoint(
  endpoint: string,
  paths: ResolvedPaths,
  dependencies: SetupCliDependencies
): Promise<readonly Check[]> {
  const probe = dependencies.probe ?? defaultProbe;
  const readyUrl = new URL("/health/ready", endpoint).toString();
  const checks: Check[] = [];

  let ready: ProbeResponse;
  try {
    ready = await probe(readyUrl, { method: "GET", timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    return [
      {
        name: "service",
        ok: false,
        detail: `${readyUrl}: ${describeError(error)}`,
        remedy: `Start it: set -a; source ${shellQuote(paths.serverEnv)}; set +a; servicenow-mcp`,
      },
    ];
  }
  if (ready.status !== 200) {
    checks.push({
      name: "service",
      ok: false,
      detail: `${readyUrl} returned HTTP ${ready.status}`,
      remedy:
        ready.status === 503
          ? "The runtime is starting or draining. Retry, and check stderr for a startup failure."
          : "Check the service logs on stderr.",
    });
    return checks;
  }
  checks.push({ name: "service", ok: true, detail: `${readyUrl} ready` });

  const bearer = existsSync(paths.serverEnv)
    ? parseEnvFile(readFileSync(paths.serverEnv, "utf8")).MCP_BEARER_TOKEN
    : undefined;
  if (!bearer) {
    checks.push({
      name: "mcp handshake",
      ok: false,
      detail: "no MCP_BEARER_TOKEN available locally to test with",
      remedy: "Run: servicenow-mcp-setup",
    });
    return checks;
  }

  let handshake: ProbeResponse;
  try {
    handshake = await probe(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "servicenow-mcp-doctor", version: "2" },
        },
      }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    checks.push({
      name: "mcp handshake",
      ok: false,
      detail: `${endpoint}: ${describeError(error)}`,
      remedy: "Confirm the endpoint host and port match MCP_HOST/MCP_PORT in the server env file.",
    });
    return checks;
  }

  checks.push(describeHandshake(endpoint, handshake));
  return checks;
}

function describeHandshake(endpoint: string, response: ProbeResponse): Check {
  if (response.status === 200) {
    return { name: "mcp handshake", ok: true, detail: `${endpoint} initialized` };
  }
  const remedies: Readonly<Record<number, string>> = Object.freeze({
    401: "The bearer the service is running with differs from the one in the server env file. Restart the service from that file.",
    403: "The request Origin was rejected. Set MCP_ALLOWED_ORIGINS to the exact origin, or call without an Origin header.",
    421: "The Host authority was rejected. Add it to MCP_ALLOWED_HOSTS exactly, including the port.",
    429: "Rate limited. Wait for the Retry-After interval, or raise MCP_IDENTITY_RATE_CAPACITY.",
    503: "All request slots are busy. MCP_MAX_CONCURRENT_REQUESTS defaults to 2 and cannot safely be raised; the client must retry.",
  });
  return {
    name: "mcp handshake",
    ok: false,
    detail: `${endpoint} returned HTTP ${response.status}`,
    remedy: remedies[response.status] ?? "Check the JSON-RPC error body and the service logs on stderr.",
  };
}

async function defaultProbe(url: string, init: ProbeRequest): Promise<ProbeResponse> {
  const response = await fetch(url, {
    method: init.method,
    ...(init.headers ? { headers: { ...init.headers } } : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  return Object.freeze({ status: response.status, body: await response.text() });
}

// ── argument parsing ───────────────────────────────────────────────

function normalizeArgv(argv: readonly string[]): readonly string[] {
  const args = [...argv];
  if (args[0] === "setup") args.shift();
  return Object.freeze(args);
}

function splitSubcommand(argv: readonly string[]): {
  subcommand: Subcommand;
  args: readonly string[];
} {
  const first = argv[0];
  if (first === "client" || first === "grant" || first === "doctor") {
    return { subcommand: first, args: Object.freeze(argv.slice(1)) };
  }
  if (first === "init") return { subcommand: "init", args: Object.freeze(argv.slice(1)) };
  return { subcommand: "init", args: argv };
}

interface FlagSpec {
  readonly boolean: ReadonlySet<string>;
  readonly value: ReadonlySet<string>;
  readonly repeatable?: ReadonlySet<string>;
}

interface ParsedFlags {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
}

function parseFlags(args: readonly string[], spec: FlagSpec, usage: string): ParsedFlags {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") throw new SetupHelp(usage);
    if (spec.boolean.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (spec.value.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.\n\n${usage}`);
      }
      if (spec.repeatable?.has(arg)) {
        const list = repeated.get(arg) ?? [];
        list.push(value);
        repeated.set(arg, list);
      } else {
        values.set(arg, value);
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${arg}.\n\n${usage}`);
  }
  return Object.freeze({ flags, values, repeated });
}

function parseInitArguments(args: readonly string[]): InitOptions {
  const usage = renderInitHelp();
  const parsed = parseFlags(
    args,
    {
      boolean: new Set([
        "--dry-run",
        "--force",
        "--json",
        "--rotate-encryption-key",
        "--allow-insecure-http",
      ]),
      value: new Set(["--endpoint", "--clients"]),
    },
    usage
  );
  const endpoint = parsed.values.get("--endpoint") ?? DEFAULT_ENDPOINT;
  const allowInsecureHttp = parsed.flags.has("--allow-insecure-http");
  validateEndpoint(endpoint, allowInsecureHttp);
  return Object.freeze({
    dryRun: parsed.flags.has("--dry-run"),
    force: parsed.flags.has("--force"),
    rotateEncryptionKey: parsed.flags.has("--rotate-encryption-key"),
    allowInsecureHttp,
    json: parsed.flags.has("--json"),
    endpoint,
    clients: parseClients(parsed.values.get("--clients") ?? "auto"),
  });
}

function parseClientArguments(args: readonly string[]): ClientOptions {
  const usage = renderClientHelp();
  const parsed = parseFlags(
    args,
    { boolean: new Set(["--allow-insecure-http"]), value: new Set(["--endpoint", "--client"]) },
    usage
  );
  const endpoint = parsed.values.get("--endpoint") ?? DEFAULT_ENDPOINT;
  validateEndpoint(endpoint, parsed.flags.has("--allow-insecure-http"));
  return Object.freeze({
    endpoint,
    clients: parseClients(parsed.values.get("--client") ?? "all"),
  });
}

function parseGrantArguments(args: readonly string[]): GrantOptions {
  const usage = renderGrantHelp();
  const parsed = parseFlags(
    args,
    {
      boolean: new Set(["--replace", "--dry-run", "--json"]),
      value: new Set(["--profile", "--read", "--write", "--tools", "--related"]),
      repeatable: new Set(["--related"]),
    },
    usage
  );
  const profile = parsed.values.get("--profile");
  if (!profile) throw new Error(`--profile is required.\n\n${usage}`);
  const read = parseTableList(parsed.values.get("--read"), "--read");
  const write = parseTableList(parsed.values.get("--write"), "--write");
  if (read.length === 0 && write.length === 0) {
    throw new Error(`Give at least one of --read or --write.\n\n${usage}`);
  }
  return Object.freeze({
    profile,
    read,
    write,
    ...(parsed.values.has("--tools")
      ? { tools: parseToolList(parsed.values.get("--tools") as string) }
      : {}),
    related: parseRelated(parsed.repeated.get("--related") ?? []),
    replace: parsed.flags.has("--replace"),
    dryRun: parsed.flags.has("--dry-run"),
    json: parsed.flags.has("--json"),
  });
}

function parseDoctorArguments(args: readonly string[]): DoctorOptions {
  const usage = renderDoctorHelp();
  const parsed = parseFlags(
    args,
    {
      boolean: new Set(["--offline", "--json", "--allow-insecure-http"]),
      value: new Set(["--profile", "--endpoint"]),
    },
    usage
  );
  const endpoint = parsed.values.get("--endpoint") ?? DEFAULT_ENDPOINT;
  validateEndpoint(endpoint, parsed.flags.has("--allow-insecure-http"));
  return Object.freeze({
    ...(parsed.values.has("--profile") ? { profile: parsed.values.get("--profile") } : {}),
    endpoint,
    offline: parsed.flags.has("--offline"),
    json: parsed.flags.has("--json"),
  });
}

function parseClients(value: string): readonly ClientTarget[] {
  if (value === "none") return Object.freeze([]);
  if (value === "auto") return AUTO_REGISTERED_CLIENTS;
  if (value === "all") return ALL_CLIENTS;
  const clients: ClientTarget[] = [];
  for (const raw of value.split(",")) {
    const client = raw.trim();
    if (client.length === 0) continue;
    if (!(ALL_CLIENTS as readonly string[]).includes(client)) {
      throw new Error(
        `Unsupported client "${client}". Supported: ${ALL_CLIENTS.join(", ")}, all, auto, none.`
      );
    }
    if (!clients.includes(client as ClientTarget)) clients.push(client as ClientTarget);
  }
  return Object.freeze(clients);
}

function parseTableList(value: string | undefined, option: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const tables: string[] = [];
  for (const raw of value.split(",")) {
    const table = raw.trim().toLowerCase();
    if (table.length === 0) continue;
    if (table === "*") {
      throw new Error(
        `${option} does not accept "*". A wildcard grant skips the per-tool binding and the ` +
          "related-table closure check; configure it deliberately in the profile file and read " +
          "docs/PRODUCTION-SECURITY.md first."
      );
    }
    if (!tables.includes(table)) tables.push(table);
  }
  return Object.freeze(tables);
}

function parseToolList(value: string): readonly string[] {
  const tools: string[] = [];
  for (const raw of value.split(",")) {
    const tool = raw.trim();
    if (tool.length === 0) continue;
    if (!tool.startsWith("sn_")) {
      throw new Error(`"${tool}" is not a tool name; tool names start with sn_.`);
    }
    if (!tools.includes(tool)) tools.push(tool);
  }
  if (tools.length === 0) throw new Error("--tools requires at least one sn_* tool name.");
  return Object.freeze(tools);
}

function parseRelated(entries: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const related = new Map<string, readonly string[]>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new Error(`--related expects <table>=<related,tables>, received "${entry}".`);
    }
    const table = entry.slice(0, separator).trim().toLowerCase();
    const tables = parseTableList(entry.slice(separator + 1), "--related");
    related.set(table, Object.freeze([...(related.get(table) ?? []), ...tables]));
  }
  return related;
}

function validateEndpoint(endpoint: string, allowInsecureHttp: boolean): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `"${endpoint}" is not an absolute URL. Use the full endpoint, for example ${DEFAULT_ENDPOINT}.`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`"${endpoint}" must use http:// or https://.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`"${endpoint}" must not contain credentials, a query string, or a fragment.`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname) && !allowInsecureHttp) {
    throw new Error(
      `"${endpoint}" would send the MCP bearer token in cleartext to ${url.hostname}. ` +
        "Use https://, keep the endpoint on loopback, or pass --allow-insecure-http when a " +
        "trusted proxy terminates TLS in front of it."
    );
  }
}

// ── file handling ──────────────────────────────────────────────────

function resolvePaths(home: string): ResolvedPaths {
  return Object.freeze({
    configDir: join(home, CONFIG_RELATIVE_DIR),
    serverEnv: join(home, SERVER_ENV_RELATIVE_PATH),
    clientEnv: join(home, CLIENT_ENV_RELATIVE_PATH),
    headerFile: join(home, HEADER_FILE_RELATIVE_PATH),
    profileConfig: join(home, PROFILE_CONFIG_RELATIVE_PATH),
  });
}

function profileManagerFor(home: string): ProfileManager {
  return new ProfileManager({
    configFilePath: join(home, PROFILE_CONFIG_RELATIVE_PATH),
  });
}

/**
 * Preserve `SN_PROFILE_ENCRYPTION_KEY` across every regeneration. Losing it
 * makes every AES-256-GCM envelope in the profile file permanently
 * undecryptable, so rotation is opt-in and refused while a profile file exists.
 */
function loadOrCreateBootstrapValues(
  paths: ResolvedPaths,
  options: InitOptions
): Readonly<Record<string, string>> {
  const generated = generateBootstrapValues();
  const existing = existsSync(paths.serverEnv)
    ? parseEnvFile(readFileSync(paths.serverEnv, "utf8"))
    : Object.freeze({} as Record<string, string>);
  const hasProfiles = existsSync(paths.profileConfig);

  if (options.rotateEncryptionKey) {
    if (hasProfiles) {
      throw new Error(
        `Refusing to rotate ${ENCRYPTION_KEY_ENV} while ${paths.profileConfig} exists: every ` +
          "encrypted credential in it would become permanently unreadable. Re-enter each " +
          "credential with servicenow-mcp-profile rotate under the new key instead."
      );
    }
    return Object.freeze({ ...existing, ...generated });
  }

  if (existsSync(paths.serverEnv) && !existing[ENCRYPTION_KEY_ENV] && hasProfiles) {
    throw new Error(
      `${paths.serverEnv} exists but has no readable ${ENCRYPTION_KEY_ENV}, and ` +
        `${paths.profileConfig} may hold credentials encrypted under it. Restore the key line ` +
        "before rerunning setup; writing a fresh key would make those credentials unreadable."
    );
  }

  // --force regenerates the bearer and identifiers but never the encryption key.
  if (options.force) {
    return Object.freeze({
      ...generated,
      ...(existing[ENCRYPTION_KEY_ENV]
        ? { [ENCRYPTION_KEY_ENV]: existing[ENCRYPTION_KEY_ENV] }
        : {}),
    });
  }
  return Object.freeze({ ...generated, ...existing });
}

function generateBootstrapValues(): Readonly<Record<string, string>> {
  return Object.freeze({
    MCP_BEARER_TOKEN: randomToken(),
    MCP_OWNER_ID: `owner-${randomToken(12)}`,
    MCP_CLIENT_ID: `client-${randomToken(12)}`,
    MCP_HOST: "127.0.0.1",
    MCP_PORT: "3000",
    [ENCRYPTION_KEY_ENV]: randomBytes(32).toString("base64url"),
  });
}

function writeSecureEnvFile(path: string, values: Readonly<Record<string, string>>): void {
  const content = `${Object.entries(values)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n")}\n`;
  writeSecureFile(path, content);
}

/**
 * `mode` on writeFileSync applies only when the file is created, so an existing
 * world-readable file would keep its mode and then receive a fresh bearer.
 * chmod unconditionally after the write.
 */
function writeSecureFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
  writeFileSync(path, content, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function parseEnvFile(content: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = Object.create(null);
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator);
    const raw = trimmed.slice(separator + 1);
    values[key] = unquoteShellValue(raw);
  }
  return Object.freeze(values);
}

function unquoteShellValue(raw: string): string {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/'\\''/gu, "'");
  }
  return raw;
}

function defaultCommandExists(command: string): boolean {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${shellQuote(command)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return Object.freeze({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  });
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function indent(value: string, prefix = "  "): string {
  return value
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

/** Render a path under `home` as ~/… so long temp/home prefixes stay readable. */
function displayPath(path: string, home: string): string {
  return home.length > 0 && path.startsWith(`${home}/`)
    ? `~/${path.slice(home.length + 1)}`
    : path;
}

function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── rendering ──────────────────────────────────────────────────────

function renderDryRunReport(paths: ResolvedPaths, options: InitOptions): unknown {
  return {
    status: "dry-run",
    would_write: [paths.serverEnv, paths.clientEnv, paths.headerFile],
    endpoint: options.endpoint,
    clients: options.clients,
  };
}

function renderDryRunText(paths: ResolvedPaths, home: string, options: InitOptions): string {
  const short = (path: string): string => displayPath(path, home);
  return (
    `Dry run: nothing was written.\n\n` +
    `Would write\n` +
    `  ${short(paths.serverEnv)}\n  ${short(paths.clientEnv)}\n  ${short(paths.headerFile)}\n\n` +
    `Endpoint  ${options.endpoint}\n` +
    `Clients   ${options.clients.length > 0 ? options.clients.join(", ") : "(none)"}\n`
  );
}

function renderInitText(
  paths: ResolvedPaths,
  home: string,
  options: InitOptions,
  configured: readonly string[],
  skipped: readonly string[],
  manual: readonly ClientTarget[]
): string {
  const short = (path: string): string => displayPath(path, home);
  const lines = [
    "ServiceNow MCP setup",
    "",
    "Wrote (owner-only, mode 0600, directory 0700)",
    `  ${short(paths.serverEnv)}`,
    "      service bearer, owner/client IDs, profile encryption key",
    `  ${short(paths.clientEnv)}`,
    `      ${CLIENT_BEARER_ENV} for clients that read it from the environment`,
    `  ${short(paths.headerFile)}`,
    "      Authorization header for mcp-remote --header-file",
    "",
    `Endpoint  ${options.endpoint}`,
    "",
    "Clients",
  ];
  for (const client of configured) lines.push(`  ${client.padEnd(14)}configured`);
  for (const entry of skipped) lines.push(`  ${entry}`);
  if (configured.length === 0 && skipped.length === 0) lines.push("  (none requested)");
  lines.push(
    "",
    "Next steps",
    "  1. Create a ServiceNow profile. Secrets are prompted, never passed in argv:",
    "       servicenow-mcp-profile create --name dev \\",
    "         --instance https://yourinstance.service-now.com \\",
    "         --auth-type oauth --client-id <client-id> --source reference --provider env",
    "",
    "  2. Grant least-privilege table access. A profile with no rules denies every call:",
    "       servicenow-mcp-setup grant --profile dev --read incident,problem --write incident",
    "",
    "  3. Start the service:",
    `       set -a; source ${shellQuote(paths.serverEnv)}; set +a; servicenow-mcp`,
    "",
    "  4. Verify end to end:",
    "       servicenow-mcp-setup doctor --profile dev",
    ""
  );
  if (manual.length > 0) {
    lines.push(
      `Configure the remaining clients by hand:`,
      `  servicenow-mcp-setup client --client ${manual.join(",")}`,
      ""
    );
  }
  lines.push(
    "Every client should hold at most 2 requests in flight. The service admits",
    "MCP_MAX_CONCURRENT_REQUESTS (default 2) and answers the rest with HTTP 503;",
    "there is no queue. See docs/CLIENT-SETUP.md.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function renderDoctorText(checks: readonly Check[]): string {
  const lines = ["ServiceNow MCP doctor", ""];
  for (const check of checks) {
    lines.push(`${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
    if (!check.ok && check.remedy) lines.push(`      -> ${check.remedy}`);
  }
  const failed = checks.filter((check) => !check.ok).length;
  lines.push(
    "",
    failed === 0
      ? "All checks passed."
      : `${failed} check${failed === 1 ? "" : "s"} failed; see the remedies above.`,
    ""
  );
  return lines.join("\n");
}

function renderSetupHelp(): string {
  return [
    "Usage: servicenow-mcp-setup <command> [options]",
    "",
    "Commands:",
    "  (default)  Generate owner-only local env files and register clients.",
    "  client     Print copy-pasteable configuration for one or more MCP clients.",
    "  grant      Add least-privilege table access rules to an existing profile.",
    "  doctor     Diagnose a local install and print the remedy for each failure.",
    "",
    "Run any command with --help for its options.",
  ].join("\n");
}

function renderInitHelp(): string {
  return [
    "Usage: servicenow-mcp-setup [options]",
    "",
    "Generates owner-only env files under ~/.servicenow-mcp/ with a bearer token,",
    "owner/client identifiers, and a profile encryption key, then registers the",
    "clients whose CLI can reference the bearer instead of storing it.",
    "",
    "Options:",
    "  --endpoint URL            MCP endpoint to advertise (default http://127.0.0.1:3000/mcp)",
    `  --clients LIST            auto | all | none | ${ALL_CLIENTS.join(",")}`,
    "  --force                   Regenerate the bearer and identifiers (keeps the encryption key)",
    "  --rotate-encryption-key   Also regenerate SN_PROFILE_ENCRYPTION_KEY; refused if profiles exist",
    "  --allow-insecure-http     Permit a non-loopback http:// endpoint behind a trusted proxy",
    "  --dry-run                 Report what would be written and exit",
    "  --json                    Machine-readable output",
  ].join("\n");
}

function renderClientHelp(): string {
  return [
    "Usage: servicenow-mcp-setup client [--client LIST] [--endpoint URL]",
    "",
    "Prints copy-pasteable MCP client configuration. No file is written.",
    "",
    "Options:",
    `  --client LIST     all (default) | ${ALL_CLIENTS.join(",")}`,
    "  --endpoint URL    MCP endpoint (default http://127.0.0.1:3000/mcp)",
  ].join("\n");
}

function renderGrantHelp(): string {
  return [
    "Usage: servicenow-mcp-setup grant --profile NAME [--read TABLES] [--write TABLES]",
    "",
    "Writes tableAccess rules onto an existing profile in ~/.servicenow-mcp/config.json.",
    "A profile with no rules denies every tool call, so this is required before first use.",
    "Rules are additive unless --replace is given, and the result is validated with the",
    "same loader the server uses at request time.",
    "",
    "Options:",
    "  --profile NAME          Profile to modify (required)",
    "  --read TABLES           Comma-separated tables to allow for reads",
    "  --write TABLES          Comma-separated tables to allow for writes",
    `  --tools LIST            Tools permitted on these targets`,
    `                          (default read: ${DEFAULT_READ_TOOLS.join(",")};`,
    `                           default write adds: ${DEFAULT_WRITE_TOOLS.join(",")})`,
    "  --related TABLE=LIST    Backing/ancestor/descendant tables the target reaches;",
    "                          repeatable, and required whenever a table extends another",
    "  --replace               Discard existing rules instead of adding to them",
    "  --dry-run               Print the resulting rules without writing them",
    "  --json                  Machine-readable output",
    "",
    "Wildcards are refused here. A '*' allowlist skips the per-tool binding and the",
    "related-table closure check; configure it deliberately after reading",
    "docs/PRODUCTION-SECURITY.md.",
  ].join("\n");
}

function renderDoctorHelp(): string {
  return [
    "Usage: servicenow-mcp-setup doctor [--profile NAME] [--endpoint URL] [--offline]",
    "",
    "Checks Node version, config file ownership and modes, profile completeness,",
    "credential resolution, table access, and the live MCP endpoint. Exits non-zero",
    "when any check fails. Never prints a secret value.",
    "",
    "Options:",
    "  --profile NAME    Check only this profile (default: every configured profile)",
    "  --endpoint URL    MCP endpoint to probe (default http://127.0.0.1:3000/mcp)",
    "  --offline         Skip the network probes",
    "  --json            Machine-readable output",
  ].join("\n");
}

class SetupHelp extends Error {
  constructor(readonly help: string) {
    super("setup help requested");
  }
}

async function main(): Promise<void> {
  try {
    if (process.argv[2] === "--help" || process.argv[2] === "-h") {
      process.stdout.write(`${renderSetupHelp()}\n`);
      return;
    }
    await runSetupCli();
  } catch (error) {
    if (error instanceof SetupHelp) {
      process.stdout.write(`${error.help}\n`);
      return;
    }
    const message = error instanceof Error ? error.message : "Setup failed";
    process.stderr.write(`[servicenow-mcp] ${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
