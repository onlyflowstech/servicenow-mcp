#!/usr/bin/env node

/**
 * Interactive-safe local bootstrap for @onlyflows/servicenow-mcp.
 *
 * The server speaks stdio: a client spawns the packaged binary and talks to it
 * over the child's stdin/stdout. There is no service to start, no port, and no
 * endpoint, so setup's job ends at a registered client, a verified credential,
 * and a profile that grants exactly the tables the operator chose.
 *
 * Four subcommands, none of which ever accept, print, or log a secret value:
 *
 * - `init` (default) generates the owner-only local env file, registers the
 *   clients that have a CLI, and prints copy-pasteable configuration for the
 *   clients that do not.
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

import { createInterface } from "node:readline/promises";

import { ServiceNowClient } from "./client.js";
import type { AuthType, GrantType, ServiceNowConfig } from "./config.js";
import {
  createProtectedInputIO,
  materializeProfileSecret,
  requiredSecretFields,
  safeProfileView,
  validateCreateMetadata,
  type CapturedProfileSecret,
  type CredentialSourceMode,
  type ProfileAdminIO,
} from "./profile-admin.js";
import {
  credentialSourceKind,
  encryptionKeyProviderFromValue,
  type ProfileEncryptionKeyProvider,
  type ProfileSecretField,
} from "./profile-credentials.js";
import {
  ProfileManager,
  instanceHostError,
  normalizeInstanceUrl,
  type Profile,
} from "./profile-manager.js";
import { trustedToolErrorDescriptor } from "./tool-error.js";
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
  /** Injected for tests; defaults to a readline/TTY prompter. */
  readonly prompter?: WizardPrompter;
  /** Force the interactive decision; defaults to a TTY check. */
  readonly interactive?: boolean;
  /** Injected for tests; defaults to one bounded authenticated ServiceNow read. */
  readonly verifyCredential?: (
    config: ServiceNowConfig
  ) => Promise<CredentialVerification>;
  /** Injected for tests; defaults to reading sys_db_object.super_class. */
  readonly resolveParentTable?: (
    config: ServiceNowConfig,
    table: string
  ) => Promise<string | undefined>;
  /** Injected for tests; defaults to the environment key provider. */
  readonly keyProvider?: ProfileEncryptionKeyProvider;
  /** Injected for tests; defaults to the protected stdin/stderr reader. */
  readonly secretIo?: ProfileAdminIO;
}

export interface AskOptions {
  readonly default?: string;
  readonly choices?: readonly string[];
  /** Return a message to reject and re-prompt; return undefined to accept. */
  readonly validate?: (value: string) => string | undefined;
}

/** Terminal interaction surface. Secrets go through `secret`, never `ask`. */
export interface WizardPrompter {
  ask(question: string, options?: AskOptions): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /**
   * Read one secret without echoing it. The prompter owns stdin, so this is
   * the only correct place to do it: a reader attached elsewhere while this
   * runs will echo every keystroke.
   */
  secret(label: string): Promise<string>;
  note(text: string): void;
  close(): void;
}

/** Outcome of one bounded authenticated read against the target instance. */
export interface CredentialVerification {
  readonly ok: boolean;
  /** Short reason, shown to the operator. Never contains a secret. */
  readonly detail: string;
  /** What to change. Present only on failure. */
  readonly remedy?: string;
  /** True when the instance authenticated us but denied the probe read. */
  readonly authenticatedButDenied?: boolean;
}

/** Raised when the operator aborts; nothing has been written to the profile. */
export class WizardAbort extends Error {
  constructor() {
    super("Setup cancelled. No profile was written.");
    this.name = "WizardAbort";
  }
}

interface CommandResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
}

type Subcommand = "init" | "client" | "grant" | "doctor";

type ClientTarget =
  | "codex"
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "windsurf";

/** Clients this bootstrap can register non-interactively through their own CLI. */
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
  readonly json: boolean;
  readonly nonInteractive: boolean;
  readonly clients: readonly ClientTarget[];
}

interface ClientOptions {
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
  readonly json: boolean;
}

const CONFIG_RELATIVE_DIR = ".servicenow-mcp";
const SERVER_ENV_RELATIVE_PATH = `${CONFIG_RELATIVE_DIR}/server.env`;
const PROFILE_CONFIG_RELATIVE_PATH = `${CONFIG_RELATIVE_DIR}/config.json`;
const MCP_SERVER_NAME = "servicenow-mcp";
const ENCRYPTION_KEY_ENV = "SN_PROFILE_ENCRYPTION_KEY";
/** The command every registered client is told to spawn. */
const SERVER_COMMAND = "servicenow-mcp";
/**
 * What `server.env` must hold for a spawned server to attribute its audit
 * records to a stable identity. The server reads this file itself at startup:
 * the client that spawns it supplies its own environment and will not have
 * sourced anything.
 */
const REQUIRED_SERVER_ENV_VALUES: readonly string[] = Object.freeze([
  "MCP_OWNER_ID",
  "MCP_CLIENT_ID",
]);

/**
 * Stated wherever setup reports what it built.
 *
 * There is no port and nothing listening, so the boundary is not a network one
 * and saying "unauthenticated" would name the wrong risk. What is true is that
 * every client registered below can spawn a server that acts as you, with the
 * full reach of these profiles' grants. That is the sentence an operator has to
 * read without opening the docs first.
 */
const STDIO_BOUNDARY_NOTICE: readonly string[] = Object.freeze([
  "The server runs as you. Each registered client starts its own copy on",
  "demand and speaks to it over that process's stdin/stdout. Nothing listens",
  "on a port, and nothing off this machine can reach it.",
  "",
  "So the boundary is the client list and the grants: any client registered",
  "here can read and write every table your profiles allow, as your ServiceNow",
  "account. Keep the grants narrow, and remove a client you no longer use with",
  '"claude mcp remove servicenow-mcp" or "codex mcp remove servicenow-mcp".',
  "",
  "No ServiceNow credential is copied into a client configuration file. The",
  "spawned server reads the profile and its encryption key from the owner-only",
  "~/.servicenow-mcp directory.",
]);

/** Printed under every client recipe, because none of them carries a credential. */
const CREDENTIAL_FOOTNOTE =
  "Nothing above carries a ServiceNow credential. The spawned server reads the\n" +
  "profile and its encryption key from ~/.servicenow-mcp, which is owner-only,\n" +
  "so no secret reaches a client configuration file.\n";
const MINIMUM_NODE_MAJOR = 20;

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
      runClient(parseClientArguments(args), out);
      return;
    case "grant":
      runGrant(parseGrantArguments(args), home, dependencies, out);
      return;
    case "doctor":
      await runDoctor(parseDoctorArguments(args), home, env, dependencies, out);
      return;
    case "init": {
      const options = parseInitArguments(args);
      if (shouldRunWizard(options, args, dependencies)) {
        await runWizard(options, home, env, dependencies, out);
        return;
      }
      await runInit(options, home, env, dependencies, out, err);
      return;
    }
  }
}

// ── wizard ─────────────────────────────────────────────────────────

const WIZARD_PROBE_TABLE = "sys_user";
const DEFAULT_READ_TABLES = "incident";
const TABLE_ALLOWLIST_WILDCARD = "*";
const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/u;

/**
 * One command from nothing to a working connection.
 *
 * Order matters for safety: env files first (idempotent, no operator data),
 * then everything else collected in memory, and the profile written **once**
 * at the end with its table-access rules already attached. Nothing reaches the
 * profile file until the credential has been verified against the instance, so
 * an abort or a wrong password leaves no half-written profile behind.
 */
async function runWizard(
  options: InitOptions,
  home: string,
  env: NodeJS.ProcessEnv,
  dependencies: SetupCliDependencies,
  out: (value: string) => void
): Promise<void> {
  const paths = resolvePaths(home);
  const prompter =
    dependencies.prompter ??
    createTtyPrompter({
      input: process.stdin,
      output: process.stdout,
      ...(dependencies.secretIo ? { secretIo: dependencies.secretIo } : {}),
    });
  const manager = dependencies.profileManager ?? profileManagerFor(home);

  try {
    prompter.note(
      "ServiceNow MCP setup\n\n" +
        "This walks through one ServiceNow connection end to end. Nothing is\n" +
        "written to the profile until your credential is verified against the\n" +
        "instance. Press Ctrl+C at any point to stop; nothing will be saved.\n"
    );

    // 1. Local identity and key material. Idempotent, so this is silent.
    const values = loadOrCreateBootstrapValues(paths, options);
    writeSecureEnvFile(paths.serverEnv, values);

    // The key just written to server.env is not in this process's environment,
    // so it must be carried in memory. `values` already holds it, whether it
    // was generated now or loaded from an earlier bootstrap. Bound and
    // validated here so a corrupt key fails before anything is prompted for.
    const keyProvider =
      dependencies.keyProvider ?? encryptionKeyProviderFromValue(values[ENCRYPTION_KEY_ENV]);

    // 2. Re-run safety: never clobber an existing profile without being told.
    const existing = existingProfileNames(manager);
    if (existing.length > 0) {
      prompter.note(`Existing profiles: ${existing.join(", ")}\n`);
      const choice = await prompter.ask(
        "Add another profile, or just re-register MCP clients?",
        { default: "profile", choices: ["profile", "clients"] }
      );
      if (choice === "clients") {
        const only = await registerClientsInteractively(
          prompter,
          options,
          env,
          dependencies
        );
        out(renderClientOnlySummary(only, home));
        return;
      }
      prompter.note("Existing profiles are left untouched.\n");
    }

    const name = await askProfileName(prompter, existing);
    const instance = await askInstance(prompter);
    const authType = await askAuthType(prompter);
    const grantType: GrantType =
      authType === "oauth"
        ? ((await prompter.ask("OAuth grant type", {
            default: "client_credentials",
            choices: ["client_credentials", "password"],
          })) as GrantType)
        : "client_credentials";

    // Asked here, before any secret is in hand. A mistyped answer to a
    // question adjacent to a credential prompt echoes the credential, so the
    // last thing before the hidden prompts is deliberately not this question.
    const mode = (await prompter.ask("How should the credential be stored?", {
      default: "encrypted",
      choices: ["encrypted", "reference"],
    })) as CredentialSourceMode;
    const provider =
      mode === "reference"
        ? await prompter.ask("Secret provider", { default: "env", choices: ["env"] })
        : undefined;

    const profile: Profile = { instance, authType };
    if (authType === "basic" || grantType === "password") {
      profile.username = await prompter.ask("ServiceNow username", {
        validate: (value) =>
          value.trim() === "" ? "A username is required for this auth mode." : undefined,
      });
    }
    if (authType === "oauth") {
      profile.grantType = grantType;
      profile.clientId = await prompter.ask("OAuth client id (not a secret)", {
        validate: (value) =>
          value.trim() === "" ? "A client id is required for OAuth." : undefined,
      });
    }
    if (authType === "apikey") {
      profile.apiKeyHeader = await prompter.ask("API key header", {
        default: "x-sn-apikey",
      });
    }

    const fields = requiredSecretFields(authType, grantType);
    validateCreateMetadata(profile, fields);

    // 3. Capture the secrets. Never echoed, never in argv, never logged.
    prompter.note(
      mode === "reference"
        ? "\nEnter the NAME of the environment variable holding each secret.\n" +
            "Input is hidden."
        : "\nEnter each secret now. Input is hidden — nothing you type from here\n" +
            "is displayed."
    );
    const captured: CapturedProfileSecret[] = [];
    for (const field of fields) {
      captured.push(
        Object.freeze({ field, mode, value: await prompter.secret(field) })
      );
    }

    // 4. Verify against the live instance before anything is persisted.
    const config = wizardConfig(profile, captured, mode, env);
    const verify = dependencies.verifyCredential ?? verifyCredentialAgainstInstance;
    prompter.note("\nVerifying against the instance...");
    let verification = await verify(config);
    while (!verification.ok) {
      prompter.note(`\n  FAILED  ${verification.detail}`);
      if (verification.remedy) prompter.note(`  -> ${verification.remedy}`);
      if (!(await prompter.confirm("\nRetry with the same settings?", true))) {
        throw new WizardAbort();
      }
      verification = await verify(config);
    }
    prompter.note(`  ok  ${verification.detail}`);
    if (verification.authenticatedButDenied) {
      prompter.note(
        `  note  this account cannot read ${WIZARD_PROBE_TABLE}, so metadata\n` +
          "        caching will stay disabled for it. Not a setup failure."
      );
    }

    // 5. Table access. A profile without rules denies every call.
    const tableAccess = await askTableAccess(prompter, config, dependencies);

    // 6. One write, with the rules already attached — never a rules-less window.
    //
    // Retryable without re-prompting: everything needed is already in memory,
    // so a failure here must not cost the operator the instance, the auth
    // details, the secret they typed, or the verification round trip.
    profile.tableAccess = tableAccess;
    for (;;) {
      try {
        for (const secret of captured) {
          profile[secret.field] = materializeProfileSecret(
            secret,
            { mode, ...(provider === undefined ? {} : { provider }) },
            name,
            secret.field,
            keyProvider
          );
        }
        manager.addProfile(name, profile);
        break;
      } catch (error) {
        prompter.note(`\n  FAILED  could not save the profile: ${describeError(error)}`);
        prompter.note(
          "  Your answers are still held in memory, including the verified\n" +
            "  credential. Fix the cause and retry, and nothing needs re-typing."
        );
        if (!(await prompter.confirm("\nRetry saving the profile?", true))) {
          throw new WizardAbort();
        }
      }
    }

    prompter.note(
      `\nWrote profile ${name}.\n${JSON.stringify(safeProfileView(name, profile), null, 2)}\n`
    );

    // 7. Client configuration.
    const registered = await registerClientsInteractively(
      prompter,
      options,
      env,
      dependencies
    );

    // 8. Verify the install the way `doctor` does, so setup ends by reporting
    //    the same facts rather than commands for the operator to copy. There
    //    is nothing to start: a registered client spawns the server itself.
    const checks = runInstallChecks(paths, home, env, dependencies, name);
    prompter.note(`\n${renderDoctorText(checks)}`);

    out(renderWizardSummary(name, tableAccess, registered, home, checks));
  } finally {
    prompter.close();
  }
}

/**
 * The checks that decide whether this install actually works.
 *
 * Shared by the wizard's final report and by `doctor`, so what setup says and
 * what `doctor` says can never drift apart.
 */
function runInstallChecks(
  paths: ResolvedPaths,
  home: string,
  env: NodeJS.ProcessEnv,
  dependencies: SetupCliDependencies,
  profile: string | undefined
): readonly Check[] {
  return Object.freeze([
    checkNodeVersion(),
    checkServerCommand(dependencies),
    checkDirectoryMode(paths.configDir),
    ...checkEnvFile(paths.serverEnv, REQUIRED_SERVER_ENV_VALUES),
    ...checkProfiles(paths, home, env, dependencies, profile),
  ]);
}

function existingProfileNames(manager: ProfileManager): readonly string[] {
  try {
    return manager.listProfiles().map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function askProfileName(
  prompter: WizardPrompter,
  existing: readonly string[]
): Promise<string> {
  return prompter.ask("Profile name", {
    default: existing.includes("dev") ? "" : "dev",
    validate: (value) => {
      const name = value.trim();
      if (name === "") return "A profile name is required.";
      if (existing.includes(name)) {
        return `Profile "${name}" already exists. Choose another name, or remove it with servicenow-mcp-profile remove --name ${name}.`;
      }
      return undefined;
    },
  });
}

const SERVICENOW_SUFFIXES = Object.freeze([".service-now.com", ".servicenowservices.com"]);

async function askInstance(prompter: WizardPrompter): Promise<string> {
  const answer = await prompter.ask(
    "ServiceNow instance (for example dev12345.service-now.com)",
    { validate: instanceProblem }
  );
  return normalizeInstanceUrl(answer);
}

/**
 * Accept a bare host or a full URL. `.servicenow.com` is the common typo for
 * `.service-now.com` and is worth naming precisely rather than reporting as a
 * generic domain rejection after a failed probe.
 */
export function instanceProblem(value: string): string | undefined {
  let normalized: string;
  try {
    normalized = normalizeInstanceUrl(value);
  } catch (error) {
    return describeError(error);
  }
  const host = new URL(normalized).hostname.toLowerCase();
  if (SERVICENOW_SUFFIXES.some((suffix) => host.endsWith(suffix))) return undefined;
  if (/\.servicenow\.com$/u.test(host)) {
    return `"${host}" looks like a typo: ServiceNow instances are *.service-now.com, with a hyphen.`;
  }
  // Falls back to the server's own rule, which honors SN_ALLOWED_INSTANCE_HOSTS.
  const problem = instanceHostError(normalized);
  if (problem === undefined) return undefined;
  return (
    `"${host}" is not a ServiceNow domain. Expected *.service-now.com or ` +
    "*.servicenowservices.com. For a self-hosted or custom-domain instance, set " +
    "SN_ALLOWED_INSTANCE_HOSTS before running setup."
  );
}

async function askAuthType(prompter: WizardPrompter): Promise<AuthType> {
  return (await prompter.ask("Authentication", {
    default: "basic",
    choices: ["basic", "oauth", "apikey"],
  })) as AuthType;
}

/** Build a throwaway config for verification. Never persisted. */
function wizardConfig(
  profile: Profile,
  captured: readonly CapturedProfileSecret[],
  mode: CredentialSourceMode,
  env: NodeJS.ProcessEnv
): ServiceNowConfig {
  const plaintext = (field: ProfileSecretField): string => {
    const entry = captured.find((candidate) => candidate.field === field);
    if (entry === undefined) return "";
    // A reference stores a variable NAME; resolve it exactly as the server will.
    return mode === "reference" ? (env[entry.value] ?? "") : entry.value;
  };
  return {
    instance: profile.instance,
    user: profile.username ?? "",
    password: plaintext("credential"),
    displayValue: "true",
    relDepth: 1,
    ...(profile.authType ? { authType: profile.authType } : {}),
    ...(profile.clientId ? { clientId: profile.clientId } : {}),
    ...(profile.grantType ? { grantType: profile.grantType } : {}),
    ...(profile.apiKeyHeader ? { apiKeyHeader: profile.apiKeyHeader } : {}),
    clientSecret: plaintext("clientSecret"),
    apiKey: plaintext("apiKey"),
    timeoutMs: 15_000,
  };
}

/**
 * One bounded authenticated read. This is the check `doctor` structurally
 * cannot make: doctor resolves a credential locally, this proves ServiceNow
 * accepts it.
 */
async function verifyCredentialAgainstInstance(
  config: ServiceNowConfig
): Promise<CredentialVerification> {
  const client = new ServiceNowClient(config, { maxRetries: 0 });
  try {
    await client.get(`/api/now/table/${WIZARD_PROBE_TABLE}`, {
      sysparm_limit: "1",
      sysparm_fields: "user_name",
    });
    return Object.freeze({
      ok: true,
      detail: `${config.instance} accepted the credential.`,
    });
  } catch (error) {
    return classifyVerificationFailure(error, config);
  }
}

/** Map a probe failure onto the thing the operator must actually change. */
export function classifyVerificationFailure(
  error: unknown,
  config: ServiceNowConfig
): CredentialVerification {
  const descriptor = trustedToolErrorDescriptor(error);
  const host = safeHost(config.instance);

  if (descriptor?.category === "authentication") {
    return Object.freeze({
      ok: false,
      detail: `${host} rejected the credential (HTTP 401).`,
      remedy:
        config.authType === "oauth"
          ? "Check the OAuth client id and secret, and that the client is active on the instance."
          : "Check the username and password. A ServiceNow account locked out or requiring a password reset also returns 401.",
    });
  }
  if (descriptor?.category === "authorization") {
    // The credential authenticated; the instance refused this specific read.
    return Object.freeze({
      ok: true,
      authenticatedButDenied: true,
      detail: `${host} accepted the credential but denied reading ${WIZARD_PROBE_TABLE} (HTTP 403).`,
    });
  }
  if (descriptor?.category === "not_found") {
    return Object.freeze({
      ok: false,
      detail: `${host} has no Table API at the expected path (HTTP 404).`,
      remedy:
        "Confirm the instance URL. A hibernating developer instance and a mistyped subdomain both look like this.",
    });
  }
  if (descriptor?.category === "rate_limit") {
    return Object.freeze({
      ok: false,
      detail: `${host} rate-limited the request (HTTP 429).`,
      remedy: "Wait for the instance rate limit to clear, then retry.",
    });
  }
  if (descriptor?.category === "timeout") {
    return Object.freeze({
      ok: false,
      detail: `${host} did not respond before the timeout.`,
      remedy:
        "The instance may be waking from hibernation, or an IP access control list may be dropping this host. Retry, then check the instance's IP Address Access Control.",
    });
  }

  const message = describeError(error);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/iu.test(message)) {
    return Object.freeze({
      ok: false,
      detail: `${host} does not resolve in DNS.`,
      remedy: "Check the instance name for a typo. Enter just the host, for example dev12345.service-now.com.",
    });
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up/iu.test(message)) {
    return Object.freeze({
      ok: false,
      detail: `${host} refused or dropped the connection.`,
      remedy:
        "This is what an instance-side IP access control list looks like from here. Check the instance's IP Address Access Control, and any outbound proxy or firewall on this machine.",
    });
  }
  if (/certificate|self-signed|CERT_|unable to verify/iu.test(message)) {
    return Object.freeze({
      ok: false,
      detail: `${host} presented a TLS certificate this machine does not trust.`,
      remedy: "Install the issuing CA on this machine. Do not disable certificate verification.",
    });
  }
  return Object.freeze({
    ok: false,
    detail: `${host} could not be reached: ${message}`,
    remedy: "Check the instance URL and this machine's outbound network access.",
  });
}

function safeHost(instance: string): string {
  try {
    return new URL(instance).host;
  } catch {
    return "the instance";
  }
}

async function askTableAccess(
  prompter: WizardPrompter,
  config: ServiceNowConfig,
  dependencies: SetupCliDependencies
): Promise<TableAccessPolicyInput> {
  prompter.note(
    "\nTable access is deny-by-default: a profile with no rules denies every\n" +
      "tool call. Grant the narrowest set that does the job; you can add more\n" +
      "later with servicenow-mcp-setup grant.\n"
  );
  const read = await askTableSelection(prompter, "READS", DEFAULT_READ_TABLES);
  const write = await askTableSelection(prompter, "WRITES", "");

  const related = new Map<string, readonly string[]>();
  for (const table of new Set([...read, ...write])) {
    if (table === TABLE_ALLOWLIST_WILDCARD) continue;
    const parent = await lookupParentTable(config, table, dependencies);
    if (parent === undefined || parent === table) continue;
    prompter.note(`\n  ${table} extends ${parent}.`);
    const include = await prompter.confirm(
      `  Declare ${parent} as a backing table of ${table}? ` +
        `This adds ${parent} to the allowlist without making it directly readable.`,
      false
    );
    if (include) related.set(table, [parent]);
  }

  const options: GrantOptions = Object.freeze({
    profile: "",
    read,
    write,
    related,
    replace: true,
    dryRun: false,
    json: false,
  });
  return buildTableAccess(Object.freeze({}), options);
}

const COMMON_ITSM_TABLES = "incident,change_request,problem,task,sys_user";

/**
 * Offer the shapes operators actually want, including the wildcard. `*` is a
 * supported configuration, so it is presented plainly with its consequence
 * rather than hidden or argued against.
 */
async function askTableSelection(
  prompter: WizardPrompter,
  operation: "READS" | "WRITES",
  fallback: string
): Promise<readonly string[]> {
  const noneLabel = operation === "WRITES" ? "None" : "None";
  const choices = [
    "Just incident",
    `Common ITSM set (${COMMON_ITSM_TABLES})`,
    "All tables (*)",
    "Enter a custom list",
    noneLabel,
  ];
  const choice = await prompter.ask(`Tables to allow for ${operation}`, {
    default: fallback === "" ? noneLabel : choices[0],
    choices,
  });

  if (choice === noneLabel) return Object.freeze([]);
  if (choice === choices[0]) return Object.freeze(["incident"]);
  if (choice === choices[1]) return parseTableList(COMMON_ITSM_TABLES, operation);
  if (choice === choices[2]) {
    prompter.note(
      `\n  "*" grants every table for ${operation.toLowerCase()}. ServiceNow's own\n` +
        "  per-user ACLs are then the only remaining boundary, so the integration\n" +
        "  account's roles become the whole control. It also skips the per-tool\n" +
        "  binding and the related-table closure check.\n"
    );
    return Object.freeze(["*"]);
  }
  return askCustomTableList(prompter, operation);
}

async function askCustomTableList(
  prompter: WizardPrompter,
  operation: string
): Promise<readonly string[]> {
  const label = `Comma-separated tables for ${operation}`;
  const answer = await prompter.ask(label, {
    validate: (value) => {
      if (value.trim() === "") return "Enter at least one table name.";
      try {
        parseTableList(value, label);
        return undefined;
      } catch (error) {
        return describeError(error);
      }
    },
  });
  return parseTableList(answer, label);
}

/**
 * Report the table this one extends, so the operator is not required to know
 * ServiceNow's inheritance graph. Best effort: a failure here is not a setup
 * failure, because the self-only closure the wizard writes is valid on its own.
 */
async function lookupParentTable(
  config: ServiceNowConfig,
  table: string,
  dependencies: SetupCliDependencies
): Promise<string | undefined> {
  const resolve = dependencies.resolveParentTable ?? defaultParentTable;
  try {
    return await resolve(config, table);
  } catch {
    return undefined;
  }
}

async function defaultParentTable(
  config: ServiceNowConfig,
  table: string
): Promise<string | undefined> {
  if (!TABLE_NAME.test(table)) return undefined;
  const client = new ServiceNowClient(config, { maxRetries: 0 });
  const response = await client.get<{ result?: unknown[] }>(
    "/api/now/table/sys_db_object",
    {
      sysparm_query: `name=${table}`,
      sysparm_fields: "name,super_class",
      sysparm_limit: "1",
      sysparm_display_value: "true",
      sysparm_exclude_reference_link: "true",
    }
  );
  const row = Array.isArray(response?.result) ? response.result[0] : undefined;
  if (typeof row !== "object" || row === null) return undefined;
  const value = (row as Record<string, unknown>).super_class;
  const parent =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? (value as Record<string, unknown>).display_value
        : undefined;
  if (typeof parent !== "string") return undefined;
  const normalized = parent.trim().toLowerCase();
  return TABLE_NAME.test(normalized) ? normalized : undefined;
}

async function registerClientsInteractively(
  prompter: WizardPrompter,
  options: InitOptions,
  env: NodeJS.ProcessEnv,
  dependencies: SetupCliDependencies
): Promise<readonly string[]> {
  const commandExists = dependencies.commandExists ?? defaultCommandExists;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const available = AUTO_REGISTERED_CLIENTS.filter((client) =>
    commandExists(client === "codex" ? "codex" : "claude")
  );
  if (available.length === 0) return Object.freeze([]);
  if (
    !(await prompter.confirm(
      `\nRegister this server with ${available.join(" and ")}?`,
      true
    ))
  ) {
    return Object.freeze([]);
  }
  const context: RegistrationContext = { commandExists, runCommand, env };
  const configured: string[] = [];
  for (const client of available) {
    const result = registerClient(client, options.force, context);
    if (result.ok) configured.push(client);
    else prompter.note(`  skipped ${client}: ${result.reason}`);
  }
  return Object.freeze(configured);
}

function renderWizardSummary(
  profile: string,
  tableAccess: TableAccessPolicyInput,
  registered: readonly string[],
  home: string,
  checks: readonly Check[]
): string {
  const failed = checks.filter((check) => !check.ok).length;
  const lines = [
    "",
    "Setup complete.",
    "",
    `Profile   ${profile}`,
    `Reads     ${(tableAccess.readTables ?? []).join(", ") || "(none)"}`,
    `Writes    ${(tableAccess.writeTables ?? []).join(", ") || "(none)"}`,
    `Transport stdio (each client spawns its own ${SERVER_COMMAND})`,
    `Clients   ${registered.length > 0 ? registered.join(", ") : "(none registered)"}`,
    "",
  ];

  if (failed > 0) {
    lines.push(
      `${failed} check${failed === 1 ? "" : "s"} above still need attention; the`,
      "remedies are printed with them.",
      ""
    );
  } else if (registered.length > 0) {
    lines.push(
      `Start ${registered.join(" or ")} and it will launch the server itself.`,
      "There is nothing to keep running between sessions.",
      ""
    );
  }

  if (registered.length === 0) {
    lines.push(
      "Configure a client by hand:",
      "  servicenow-mcp-setup client --client all",
      ""
    );
  }

  lines.push(
    "Re-check everything at any time:",
    `  servicenow-mcp-setup doctor --profile ${profile}`,
    ""
  );
  lines.push(...STDIO_BOUNDARY_NOTICE, "");
  return `${lines.join("\n")}\n`;
}

function renderClientOnlySummary(
  registered: readonly string[],
  home: string
): string {
  void home;
  return (
    `\nClients   ${registered.length > 0 ? registered.join(", ") : "(none registered)"}\n` +
    `Transport stdio (each client spawns its own ${SERVER_COMMAND})\n\n` +
    `Configure any remaining client by hand:\n` +
    `  servicenow-mcp-setup client --client all\n`
  );
}

interface PrompterStreams {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  readonly secretIo?: ProfileAdminIO;
}

/**
 * Detach every reader currently attached to the input stream and return a
 * function that puts them back exactly as they were.
 *
 * readline installs its own data/keypress handling and echoes what it reads.
 * Leaving it attached during a hidden read renders the secret in the terminal
 * under a prompt that says input is hidden — reproduced against a pty, and the
 * reason this exists. Snapshot-and-restore rather than close-and-recreate so
 * later prompts continue on the same interface.
 */
function detachInputReaders(input: NodeJS.ReadStream): () => void {
  const saved: Array<[string, (...args: unknown[]) => void]> = [];
  for (const event of ["data", "keypress", "readable"]) {
    for (const listener of input.listeners(event)) {
      saved.push([event, listener as (...args: unknown[]) => void]);
    }
    input.removeAllListeners(event);
  }
  return () => {
    for (const [event, listener] of saved) input.on(event, listener);
  };
}

/** Readline prompter. It owns stdin, including the handoff for secrets. */
export function createTtyPrompter(streams: PrompterStreams): WizardPrompter {
  const { input, output } = streams;
  const rl = createInterface({ input, output });
  const secretIo = streams.secretIo ?? createProtectedInputIO(input, output);
  let closed = false;
  return {
    async ask(question: string, options: AskOptions = {}): Promise<string> {
      for (;;) {
        const answer = (await rl.question(renderQuestion(question, options))).trim();
        const resolved = resolveChoice(answer, options);
        if (resolved === undefined) {
          output.write(`  Enter a number, or one of: ${options.choices?.join(", ")}\n`);
          continue;
        }
        const problem = options.validate?.(resolved);
        if (problem !== undefined) {
          output.write(`  ${problem}\n`);
          continue;
        }
        return resolved;
      }
    },
    async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      const answer = (
        await rl.question(`${question} [${defaultYes ? "Y/n" : "y/N"}]: `)
      )
        .trim()
        .toLowerCase();
      if (answer === "") return defaultYes;
      return answer === "y" || answer === "yes";
    },
    async secret(label: string): Promise<string> {
      rl.pause();
      const restore = detachInputReaders(input);
      try {
        return await secretIo.readSensitive(label);
      } finally {
        restore();
        rl.resume();
      }
    },
    note(text: string): void {
      output.write(`${text}\n`);
    },
    close(): void {
      if (!closed) {
        closed = true;
        rl.close();
      }
    },
  };
}

/** Render a closed set as a numbered menu; everything else as one line. */
function renderQuestion(question: string, options: AskOptions): string {
  if (!options.choices || options.choices.length === 0) {
    return options.default ? `${question} [${options.default}]: ` : `${question}: `;
  }
  const lines = [`${question}:`];
  options.choices.forEach((choice, index) => {
    const marker = choice === options.default ? " (default)" : "";
    lines.push(`  ${index + 1}) ${choice}${marker}`);
  });
  const defaultIndex = options.default ? options.choices.indexOf(options.default) + 1 : 0;
  lines.push(defaultIndex > 0 ? `Choice [${defaultIndex}]: ` : "Choice: ");
  return lines.join("\n");
}

/** Accept either the ordinal or the literal value of a closed set. */
export function resolveChoice(answer: string, options: AskOptions): string | undefined {
  const raw = answer.trim();
  if (!options.choices || options.choices.length === 0) {
    return raw === "" ? (options.default ?? "") : raw;
  }
  if (raw === "") return options.default;
  if (/^\d+$/u.test(raw)) {
    const index = Number(raw) - 1;
    return options.choices[index];
  }
  return options.choices.includes(raw) ? raw : undefined;
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

  writeSecureEnvFile(paths.serverEnv, values);

  const commandExists = dependencies.commandExists ?? defaultCommandExists;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const configuredClients: string[] = [];
  const skippedClients: string[] = [];

  for (const client of options.clients) {
    if (!AUTO_REGISTERED_CLIENTS.includes(client)) {
      skippedClients.push(`${client} (no CLI to register with)`);
      continue;
    }
    const registration = registerClient(client, options.force, {
      commandExists,
      runCommand,
      env,
    });
    if (registration.ok) configuredClients.push(client);
    else skippedClients.push(`${client} (${registration.reason})`);
  }

  const manualClients = options.clients.filter(
    (client) => !configuredClients.includes(client)
  );

  const report = {
    status: "configured",
    files: { server_env: paths.serverEnv },
    transport: "stdio",
    server_command: SERVER_COMMAND,
    clients: configuredClients,
    skipped_clients: skippedClients,
    profile_command:
      "servicenow-mcp-profile create --name dev --instance https://yourinstance.service-now.com --auth-type oauth --client-id <client-id> --source reference --provider env",
    grant_command:
      "servicenow-mcp-setup grant --profile dev --read incident --write incident",
    doctor_command: "servicenow-mcp-setup doctor --profile dev",
    notes: [
      "Each registered client spawns its own server over stdio. Nothing listens on a port, and there is no service to start or keep running.",
      "Any registered client can read and write every table these profiles grant, as the configured ServiceNow account. The client list and the grants are the boundary.",
      "Generated owner/client IDs are stored in an owner-only env file, not in client config. They label audit records; they are not credentials.",
      "The spawned server reads that env file itself, so no secret is copied into a client configuration file.",
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

/**
 * Resolve the command a client should spawn.
 *
 * `servicenow-mcp` on PATH is the normal case and the one worth registering:
 * it survives a reinstall and reads the same in every client's config. When it
 * does not resolve — a project-local install, or a global bin directory the
 * client's own PATH will not have — registering it anyway would produce a
 * client that fails to launch with nothing to point at. So fall back to this
 * CLI's own sibling entrypoint, which is unambiguous and always correct.
 */
function resolveServerLaunch(
  commandExists: (command: string) => boolean
): { readonly command: string; readonly args: readonly string[] } {
  if (commandExists(SERVER_COMMAND)) {
    return Object.freeze({ command: SERVER_COMMAND, args: Object.freeze([]) });
  }
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([join(__dirname, "index.js")]),
  });
}

function registerClient(
  client: ClientTarget,
  force: boolean,
  context: RegistrationContext
): { ok: true } | { ok: false; reason: string } {
  const binary = client === "codex" ? "codex" : "claude";
  if (!context.commandExists(binary)) {
    return { ok: false, reason: `${binary} CLI not found` };
  }
  const launch = resolveServerLaunch(context.commandExists);
  const result =
    client === "codex"
      ? configureCodex(launch, force, context)
      : configureClaudeCode(launch, force, context);
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    reason: result.error?.message ?? result.stderr ?? "configuration command failed",
  };
}

/** `codex mcp add <name> -- <command> [args...]` registers a stdio server. */
function configureCodex(
  launch: { readonly command: string; readonly args: readonly string[] },
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
    ["mcp", "add", MCP_SERVER_NAME, "--", launch.command, ...launch.args],
    context.env
  );
}

/**
 * `claude mcp add <name> -- <command> [args...]` registers a stdio server;
 * stdio is the default transport, so `--transport` is deliberately omitted.
 */
function configureClaudeCode(
  launch: { readonly command: string; readonly args: readonly string[] },
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
    ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", launch.command, ...launch.args],
    context.env
  );
}

// ── client ─────────────────────────────────────────────────────────

function runClient(options: ClientOptions, out: (value: string) => void): void {
  const sections = options.clients.map((client) => renderClientConfiguration(client));
  out(`${sections.join("\n")}\n`);
}

interface ResolvedPaths {
  readonly configDir: string;
  readonly serverEnv: string;
  readonly profileConfig: string;
}

/**
 * Every client here speaks stdio natively, so each recipe is the same shape:
 * a command to spawn. The mcp-remote bridge that HTTP required is gone, and
 * with it the only reason a client config ever had to hold a bearer token.
 */
function renderClientConfiguration(client: ClientTarget): string {
  const heading = `## ${client}\n`;
  const jsonEntry = (key: "mcpServers" | "servers"): string =>
    indent(
      JSON.stringify(
        { [key]: { [MCP_SERVER_NAME]: { command: SERVER_COMMAND, args: [] } } },
        null,
        2
      )
    );
  switch (client) {
    case "codex":
      return (
        `${heading}\n` +
        `  codex mcp add ${MCP_SERVER_NAME} -- ${SERVER_COMMAND}\n\n` +
        `Equivalent ~/.codex/config.toml entry:\n\n` +
        `${indent(
          `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "${SERVER_COMMAND}"\nargs = []`
        )}\n\n` +
        `${CREDENTIAL_FOOTNOTE}`
      );
    case "claude-code":
      return (
        `${heading}\n` +
        `  claude mcp add --scope user ${MCP_SERVER_NAME} -- ${SERVER_COMMAND}\n\n` +
        `stdio is the default, so there is no transport flag to pass.\n\n` +
        `Equivalent .mcp.json entry:\n\n` +
        `${jsonEntry("mcpServers")}\n\n` +
        `${CREDENTIAL_FOOTNOTE}`
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
      return (
        `${heading}\n` +
        `Config file:\n  ${location}\n\n` +
        `${jsonEntry("mcpServers")}\n\n` +
        `${CREDENTIAL_FOOTNOTE}`
      );
    }
    case "vscode":
      return (
        `${heading}\n` +
        `Config file:\n  .vscode/mcp.json (workspace) or the user-level mcp.json\n\n` +
        `${indent(
          JSON.stringify(
            {
              servers: {
                [MCP_SERVER_NAME]: {
                  type: "stdio",
                  command: SERVER_COMMAND,
                  args: [],
                },
              },
            },
            null,
            2
          )
        )}\n\n` +
        `${CREDENTIAL_FOOTNOTE}`
      );
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

  const tableAccess = buildTableAccess(existing, options);

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
      `Restart the MCP client for the change to take effect: it reads the\n` +
      `profile when it launches the server.\n`
  );
}

/**
 * Build and validate one `tableAccess` object. Shared by `grant` and the
 * wizard so there is a single definition of what a grant means.
 */
function buildTableAccess(
  existing: TableAccessPolicyInput,
  options: GrantOptions
): TableAccessPolicyInput {
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
  return tableAccess;
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
    if (table === TABLE_ALLOWLIST_WILDCARD) continue;
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
  const checks = runInstallChecks(paths, home, env, dependencies, options.profile);
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

/**
 * Prove the command registered clients spawn can actually be found.
 *
 * This is the check a listening service did not need and a spawned one cannot
 * do without: a client that cannot resolve the command fails at launch with an
 * error that says nothing about why. It replaces the endpoint probe, and is
 * strictly more informative, because there is no running process whose absence
 * could be mistaken for a broken install.
 *
 * PATH here is this shell's, which is the best available proxy. A GUI client
 * launched from the desktop may hold a different one, so the remedy names the
 * absolute-path registration that removes the question entirely.
 */
function checkServerCommand(dependencies: SetupCliDependencies): Check {
  const name = "server command";
  const commandExists = dependencies.commandExists ?? defaultCommandExists;
  if (commandExists(SERVER_COMMAND)) {
    return {
      name,
      ok: true,
      detail: `${SERVER_COMMAND} resolves on PATH; clients spawn it over stdio`,
    };
  }
  const fallback = join(__dirname, "index.js");
  return {
    name,
    ok: false,
    detail: `${SERVER_COMMAND} is not on this PATH`,
    remedy:
      `Install the package globally (npm i -g @onlyflows/servicenow-mcp), or register ` +
      `the entrypoint by absolute path instead: claude mcp add --scope user ` +
      `${MCP_SERVER_NAME} -- ${process.execPath} ${fallback}`,
  };
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
    `this process and in the process the client spawns. Run "servicenow-mcp-profile inspect --name ` +
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

/**
 * The wizard is what a bare, interactive invocation does. Any flag keeps the
 * established non-interactive behavior byte for byte, so every documented
 * command and every CI caller is unaffected.
 */
function shouldRunWizard(
  options: InitOptions,
  args: readonly string[],
  dependencies: SetupCliDependencies
): boolean {
  if (options.nonInteractive) return false;
  if (dependencies.prompter !== undefined) return dependencies.interactive !== false;
  if (dependencies.interactive === false) return false;
  if (args.length > 0) return false;
  return dependencies.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
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
        "--non-interactive",
      ]),
      value: new Set(["--clients"]),
    },
    usage
  );
  return Object.freeze({
    dryRun: parsed.flags.has("--dry-run"),
    force: parsed.flags.has("--force"),
    rotateEncryptionKey: parsed.flags.has("--rotate-encryption-key"),
    json: parsed.flags.has("--json"),
    nonInteractive: parsed.flags.has("--non-interactive"),
    clients: parseClients(parsed.values.get("--clients") ?? "auto"),
  });
}

function parseClientArguments(args: readonly string[]): ClientOptions {
  const usage = renderClientHelp();
  const parsed = parseFlags(
    args,
    { boolean: new Set([]), value: new Set(["--client"]) },
    usage
  );
  return Object.freeze({
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
      boolean: new Set(["--json"]),
      value: new Set(["--profile"]),
    },
    usage
  );
  return Object.freeze({
    ...(parsed.values.has("--profile") ? { profile: parsed.values.get("--profile") } : {}),
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
    // Check the shape here so a typo is rejected at the prompt that produced
    // it, rather than by the policy loader after every question is answered.
    if (!TABLE_NAME.test(table)) {
      throw new Error(
        `"${table}" is not a ServiceNow table name. Names are lowercase, start with a ` +
          "letter, and contain only letters, digits, and underscores."
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

// ── file handling ──────────────────────────────────────────────────

function resolvePaths(home: string): ResolvedPaths {
  return Object.freeze({
    configDir: join(home, CONFIG_RELATIVE_DIR),
    serverEnv: join(home, SERVER_ENV_RELATIVE_PATH),
    profileConfig: join(home, PROFILE_CONFIG_RELATIVE_PATH),
  });
}

/**
 * Build a manager for an install this process did not create.
 *
 * `doctor` and `grant` inspect an existing install, so the encryption key is
 * normally only on disk in `server.env` — the same reason `doctor` reads that
 * file for its handshake probe. Falling back to it means a successful setup is
 * not immediately followed by `doctor` reporting the key as unavailable. When
 * neither source has a key the env-based provider still raises the original
 * error, so a genuinely missing key keeps its remedy.
 */
function profileManagerFor(home: string): ProfileManager {
  const configFilePath = join(home, PROFILE_CONFIG_RELATIVE_PATH);
  if (process.env[ENCRYPTION_KEY_ENV]) {
    return new ProfileManager({ configFilePath });
  }
  const serverEnv = join(home, SERVER_ENV_RELATIVE_PATH);
  if (existsSync(serverEnv)) {
    const stored = parseEnvFile(readFileSync(serverEnv, "utf8"))[ENCRYPTION_KEY_ENV];
    if (stored) {
      try {
        return new ProfileManager({
          configFilePath,
          encryptionKeyProvider: encryptionKeyProviderFromValue(stored),
        });
      } catch {
        // A corrupt stored key falls through to the environment provider so the
        // operator gets the existing remedy rather than a parse failure here.
      }
    }
  }
  return new ProfileManager({ configFilePath });
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

  // --force regenerates the owner/client identifiers but never the encryption key.
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

/**
 * The owner/client identifiers are not secrets. They label every audit record,
 * so they are generated per install to keep records from two installs
 * distinguishable.
 *
 * No listen address: nothing listens. A client spawns the server on demand and
 * the pipe between them is the whole transport.
 */
function generateBootstrapValues(): Readonly<Record<string, string>> {
  return Object.freeze({
    MCP_OWNER_ID: `owner-${randomToken(12)}`,
    MCP_CLIENT_ID: `client-${randomToken(12)}`,
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
 * world-readable file would keep its mode and then receive a fresh key.
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
    would_write: [paths.serverEnv],
    transport: "stdio",
    server_command: SERVER_COMMAND,
    clients: options.clients,
  };
}

function renderDryRunText(paths: ResolvedPaths, home: string, options: InitOptions): string {
  const short = (path: string): string => displayPath(path, home);
  return (
    `Dry run: nothing was written.\n\n` +
    `Would write\n` +
    `  ${short(paths.serverEnv)}\n\n` +
    `Transport stdio (each client spawns its own ${SERVER_COMMAND})\n` +
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
    "      owner/client IDs, profile encryption key",
    "      The spawned server reads this file itself; no client holds a secret.",
    "",
    `Transport stdio (each client spawns its own ${SERVER_COMMAND})`,
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
    "  3. Verify the install:",
    "       servicenow-mcp-setup doctor --profile dev",
    "",
    "     Then start a registered client; it launches the server itself.",
    ""
  );
  if (manual.length > 0) {
    lines.push(
      `Configure the remaining clients by hand:`,
      `  servicenow-mcp-setup client --client ${manual.join(",")}`,
      ""
    );
  }
  lines.push(...STDIO_BOUNDARY_NOTICE, "");
  lines.push("See docs/CLIENT-SETUP.md.", "");
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
    "  (default)  Walk through a complete setup: local auth material, a",
    "             ServiceNow profile with its credential verified against the",
    "             instance, table access, and client registration.",
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
    "Run bare on a terminal, this is a guided wizard: it generates the local",
    "auth material, prompts for the instance and credential, verifies that",
    "credential against the instance, prompts for table access, writes the",
    "profile with its grant attached, and registers supported clients.",
    "",
    "With any flag, or without a terminal, it only generates the env files and",
    "registers clients \u2014 the established non-interactive behavior.",
    "",
    "Options:",
    `  --clients LIST            auto | all | none | ${ALL_CLIENTS.join(",")}`,
    "  --force                   Regenerate the owner/client identifiers (keeps the encryption key)",
    "  --rotate-encryption-key   Also regenerate SN_PROFILE_ENCRYPTION_KEY; refused if profiles exist",
    "  --dry-run                 Report what would be written and exit",
    "  --json                    Machine-readable output",
    "  --non-interactive         Skip the guided wizard even on a terminal",
    "",
    "Run bare on a terminal to be walked through instance, credential,",
    "table access, and client registration in one command.",
  ].join("\n");
}

function renderClientHelp(): string {
  return [
    "Usage: servicenow-mcp-setup client [--client LIST]",
    "",
    "Prints copy-pasteable MCP client configuration. No file is written.",
    "Every client is configured as a stdio server: it spawns servicenow-mcp",
    "itself and speaks JSON-RPC over that process's stdin/stdout.",
    "",
    "Options:",
    `  --client LIST     all (default) | ${ALL_CLIENTS.join(",")}`,
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
    "Usage: servicenow-mcp-setup doctor [--profile NAME]",
    "",
    "Checks Node version, that the servicenow-mcp command clients spawn resolves",
    "on PATH, config file ownership and modes, profile completeness, credential",
    "resolution, and table access. Exits non-zero when any check fails. Never",
    "prints a secret value, and never touches the network.",
    "",
    "Options:",
    "  --profile NAME    Check only this profile (default: every configured profile)",
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
