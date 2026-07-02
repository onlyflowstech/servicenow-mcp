/**
 * Multi-instance profile manager for ServiceNow MCP server.
 *
 * Supports named profiles stored in ~/.servicenow-mcp/config.json.
 * Falls back to environment variables (SN_INSTANCE, SN_USER, SN_PASSWORD)
 * when no config file exists, preserving full backward compatibility.
 *
 * @module profiles
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  AuthType,
  GrantType,
  ServiceNowConfig,
  parseAuthType,
  parseGrantType,
  parseTimeoutMs,
} from "./config.js";
import { ServiceNowClient } from "./client.js";

// ── Interfaces ─────────────────────────────────────────────────────

export interface Profile {
  /** ServiceNow instance URL (e.g. "https://myinstance.service-now.com") */
  instance: string;
  /** ServiceNow username (basic auth and OAuth "password" grant) */
  username?: string;
  /** Credential: "env:VAR_NAME" to read from env, or a plain string */
  credential?: string;
  /** Application scope (e.g. "x_knowd_know_drago") */
  scope?: string;
  /** Scope sys_id */
  scope_sys_id?: string;
  /** Vendor code (e.g. "knowd", "1105906") */
  vendor_code?: string;
  /** Human-readable description of this profile */
  description?: string;
  /** Auth scheme: "basic" (default), "oauth", or "apikey" */
  authType?: AuthType;
  /** OAuth client id (authType "oauth") */
  clientId?: string;
  /** OAuth client secret: "env:VAR_NAME" or a plain string (authType "oauth") */
  clientSecret?: string;
  /** OAuth grant type: "client_credentials" (default) or "password" */
  grantType?: GrantType;
  /** API key: "env:VAR_NAME" or a plain string (authType "apikey") */
  apiKey?: string;
  /** Header the API key is sent in (default "x-sn-apikey") */
  apiKeyHeader?: string;
  /** Per-request timeout in ms (default 30000; env fallback SN_TIMEOUT_MS) */
  timeoutMs?: number;
}

export interface ProfileConfig {
  /** Config file schema version */
  version: number;
  /** Name of the default profile */
  default_profile: string;
  /** Map of profile name to profile definition */
  profiles: Record<string, Profile>;
}

export interface ProfileListEntry {
  name: string;
  instance: string;
  authType: AuthType;
  description?: string;
  isActive: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

const CONFIG_DIR = ".servicenow-mcp";
const CONFIG_FILE = "config.json";
const ENV_PROFILE_NAME = "default";
const CONFIG_VERSION = 1;

// ── ProfileManager ─────────────────────────────────────────────────

export class ProfileManager {
  private config: ProfileConfig;
  private activeProfile: string;
  private clientCache: Map<string, ServiceNowClient> = new Map();
  private configFilePath: string;
  private loadedFromFile: boolean;

  constructor() {
    this.configFilePath = path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE);
    this.loadedFromFile = false;

    const fileConfig = this.loadConfigFile();
    if (fileConfig) {
      this.config = fileConfig;
      this.loadedFromFile = true;
    } else {
      this.config = this.buildConfigFromEnv();
    }

    this.activeProfile = this.config.default_profile;
  }

  /**
   * Get a profile by name. If no name is provided, returns the active profile.
   * Throws if the profile does not exist.
   */
  getProfile(name?: string): Profile {
    const profileName = name ?? this.activeProfile;
    const profile = this.config.profiles[profileName];
    if (!profile) {
      const available = Object.keys(this.config.profiles).join(", ");
      throw new Error(
        `Profile "${profileName}" not found. Available profiles: ${available || "(none)"}`
      );
    }
    return profile;
  }

  /**
   * Resolve the credential for a profile.
   * If the credential starts with "env:", reads the value from the named
   * environment variable. Otherwise returns the plain string and emits
   * a warning to stderr about storing credentials in plain text.
   */
  resolveCredential(profile: Profile): string {
    const { credential } = profile;

    if (!credential) {
      throw new Error(
        `Profile "${this.getProfileNameFor(profile)}" has no credential configured`
      );
    }

    return this.resolveSecret(
      credential,
      `Profile "${this.getProfileNameFor(profile)}" credential`
    );
  }

  /**
   * Resolve a secret value that supports "env:VAR_NAME" indirection
   * (credential, clientSecret, apiKey). Plain values are returned as-is
   * with a stderr warning.
   */
  private resolveSecret(raw: string, description: string): string {
    if (raw.startsWith("env:")) {
      const varName = raw.slice(4);
      const value = process.env[varName];
      if (!value) {
        throw new Error(
          `${description} references environment variable "${varName}" which is not set`
        );
      }
      return value;
    }

    // Plain-text secret -- warn the user
    process.stderr.write(
      `[servicenow-mcp] WARNING: ${description} ` +
        `is stored as plain text. Consider using "env:VAR_NAME" instead.\n`
    );
    return raw;
  }

  /**
   * Switch the active profile for the current session (in-memory only).
   * Does not persist to disk.
   */
  switchProfile(name: string): void {
    if (!this.config.profiles[name]) {
      const available = Object.keys(this.config.profiles).join(", ");
      throw new Error(
        `Cannot switch to profile "${name}": not found. Available profiles: ${available || "(none)"}`
      );
    }
    this.activeProfile = name;
    // Invalidate client cache for the old profile is not necessary --
    // cached clients remain valid, we just change what "active" means.
  }

  /**
   * List all profiles with their name, instance, description, and
   * whether they are the currently active profile.
   */
  listProfiles(): ProfileListEntry[] {
    return Object.entries(this.config.profiles).map(([name, profile]) => ({
      name,
      instance: profile.instance,
      authType: profile.authType ?? "basic",
      description: profile.description,
      isActive: name === this.activeProfile,
    }));
  }

  /**
   * Names of configured profiles that authenticate with basic auth.
   * Used for the startup deprecation warning (ServiceNow's inbound
   * Basic Auth restriction program). Unconfigured placeholder profiles
   * (empty instance) are skipped.
   */
  getBasicAuthProfileNames(): string[] {
    return Object.entries(this.config.profiles)
      .filter(
        ([, profile]) =>
          (profile.authType ?? "basic") === "basic" && profile.instance
      )
      .map(([name]) => name);
  }

  /**
   * Return the name of the currently active profile.
   */
  getActiveProfileName(): string {
    return this.activeProfile;
  }

  /**
   * Return a ServiceNowClient for the named profile (or the active profile).
   * Clients are cached per profile name -- the same instance is returned on
   * subsequent calls for the same profile.
   */
  getClient(name?: string): ServiceNowClient {
    const profileName = name ?? this.activeProfile;
    const cached = this.clientCache.get(profileName);
    if (cached) {
      return cached;
    }

    const config = this.getConfig(profileName);
    const client = new ServiceNowClient(config);
    this.clientCache.set(profileName, client);
    return client;
  }

  /**
   * Return a ServiceNowConfig for the named profile (or the active profile).
   * Compatible with existing tool handlers that expect ServiceNowConfig.
   */
  getConfig(name?: string): ServiceNowConfig {
    const profile = this.getProfile(name);
    const profileName = name ?? this.activeProfile;
    const authType = profile.authType ?? "basic";
    const grantType = profile.grantType ?? "client_credentials";

    // The user password is only needed for basic auth and the OAuth
    // "password" grant -- don't demand a credential for other schemes.
    const needsPassword =
      authType === "basic" || (authType === "oauth" && grantType === "password");
    const password = needsPassword ? this.resolveCredential(profile) : "";

    return {
      instance: normalizeInstanceUrl(profile.instance),
      user: profile.username ?? "",
      password,
      displayValue: process.env.SN_DISPLAY_VALUE ?? "true",
      relDepth: parseRelDepth(process.env.SN_REL_DEPTH),
      authType,
      grantType,
      clientId: profile.clientId,
      clientSecret: profile.clientSecret
        ? this.resolveSecret(
            profile.clientSecret,
            `Profile "${profileName}" clientSecret`
          )
        : undefined,
      apiKey: profile.apiKey
        ? this.resolveSecret(profile.apiKey, `Profile "${profileName}" apiKey`)
        : undefined,
      apiKeyHeader: profile.apiKeyHeader,
      timeoutMs: profile.timeoutMs ?? parseTimeoutMs(process.env.SN_TIMEOUT_MS),
    };
  }

  /**
   * Add a new profile at runtime and persist the updated config to disk.
   * If a profile with the same name already exists, it is overwritten.
   */
  addProfile(name: string, profile: Profile): void {
    if (!name || typeof name !== "string") {
      throw new Error("Profile name must be a non-empty string");
    }

    // Never persist plain-text secrets: everything addProfile writes to
    // disk must reference an environment variable via "env:VAR_NAME".
    requireEnvIndirection(profile.credential, "credential");
    requireEnvIndirection(profile.clientSecret, "clientSecret");
    requireEnvIndirection(profile.apiKey, "apiKey");

    this.config.profiles[name] = profile;

    // If this was built from env vars and we're adding a real profile,
    // keep the version and default_profile intact.
    this.persistConfig();

    // Invalidate cached client for this profile if it existed
    this.clientCache.delete(name);
  }

  /**
   * Return the path to the config file on disk.
   */
  getConfigPath(): string {
    return this.configFilePath;
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Attempt to load the config file from disk.
   * Returns null if the file does not exist or is not valid JSON.
   */
  private loadConfigFile(): ProfileConfig | null {
    try {
      if (!fs.existsSync(this.configFilePath)) {
        return null;
      }

      const raw = fs.readFileSync(this.configFilePath, "utf-8");
      const parsed = JSON.parse(raw);

      // Basic validation
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.version !== "number" ||
        typeof parsed.default_profile !== "string" ||
        typeof parsed.profiles !== "object" ||
        parsed.profiles === null
      ) {
        process.stderr.write(
          `[servicenow-mcp] WARNING: Config file at ${this.configFilePath} has invalid structure. ` +
            `Falling back to environment variables.\n`
        );
        return null;
      }

      // Validate that default_profile references an existing profile
      if (!parsed.profiles[parsed.default_profile]) {
        process.stderr.write(
          `[servicenow-mcp] WARNING: default_profile "${parsed.default_profile}" ` +
            `not found in profiles. Falling back to environment variables.\n`
        );
        return null;
      }

      return parsed as ProfileConfig;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[servicenow-mcp] WARNING: Could not load config file at ${this.configFilePath}: ${message}. ` +
          `Falling back to environment variables.\n`
      );
      return null;
    }
  }

  /**
   * Build a synthetic ProfileConfig from environment variables.
   * This preserves backward compatibility: if no config file exists,
   * the server works exactly as before using SN_INSTANCE, SN_USER,
   * and SN_PASSWORD. Additional env vars configure the auth scheme:
   * SN_AUTH_TYPE, SN_CLIENT_ID, SN_CLIENT_SECRET, SN_GRANT_TYPE,
   * SN_API_KEY, SN_API_KEY_HEADER, SN_TIMEOUT_MS.
   */
  private buildConfigFromEnv(): ProfileConfig {
    const instance = process.env.SN_INSTANCE;
    const user = process.env.SN_USER;

    // If env vars are set, create a synthetic profile.
    // If they aren't, still create the config structure -- the error
    // will surface when getConfig() tries to resolve credentials.
    // Secrets always use env: indirection so they are never persisted
    // in plain text if this synthetic config is later written to disk.
    const profile: Profile = {
      instance: instance ?? "",
      username: user ?? "",
      credential: "env:SN_PASSWORD",
    };

    const authType = parseAuthType(process.env.SN_AUTH_TYPE);
    if (authType) {
      profile.authType = authType;
    } else if (process.env.SN_AUTH_TYPE) {
      process.stderr.write(
        `[servicenow-mcp] WARNING: Unknown SN_AUTH_TYPE "${process.env.SN_AUTH_TYPE}" ` +
          `(expected basic, oauth, or apikey). Falling back to basic auth.\n`
      );
    }
    if (process.env.SN_CLIENT_ID) {
      profile.clientId = process.env.SN_CLIENT_ID;
    }
    if (process.env.SN_CLIENT_SECRET) {
      profile.clientSecret = "env:SN_CLIENT_SECRET";
    }
    const grantType = parseGrantType(process.env.SN_GRANT_TYPE);
    if (grantType) {
      profile.grantType = grantType;
    }
    if (process.env.SN_API_KEY) {
      profile.apiKey = "env:SN_API_KEY";
    }
    if (process.env.SN_API_KEY_HEADER) {
      profile.apiKeyHeader = process.env.SN_API_KEY_HEADER;
    }
    const timeoutMs = parseTimeoutMs(process.env.SN_TIMEOUT_MS);
    if (timeoutMs !== undefined) {
      profile.timeoutMs = timeoutMs;
    }

    return {
      version: CONFIG_VERSION,
      default_profile: ENV_PROFILE_NAME,
      profiles: {
        [ENV_PROFILE_NAME]: profile,
      },
    };
  }

  /**
   * Persist the current config to disk, creating the directory if needed.
   */
  private persistConfig(): void {
    const dir = path.dirname(this.configFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const json = JSON.stringify(this.config, null, 2) + "\n";
    // The config may reference credential material -- keep it owner-only.
    // Creation modes are masked by umask and don't apply to pre-existing
    // files, so chmod explicitly as well.
    fs.writeFileSync(this.configFilePath, json, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(this.configFilePath, 0o600);
    fs.chmodSync(dir, 0o700);
    this.loadedFromFile = true;
  }

  /**
   * Find the profile name for a given Profile object.
   * Used for warning messages.
   */
  private getProfileNameFor(profile: Profile): string {
    for (const [name, p] of Object.entries(this.config.profiles)) {
      if (p === profile) {
        return name;
      }
    }
    return "(unknown)";
  }
}

// ── Module-level helpers ───────────────────────────────────────────

/**
 * Require "env:VAR_NAME" indirection for a secret that is about to be
 * persisted to the config file. Plain-text secrets are never written
 * to disk (they would be readable by other local users and survive in
 * backups indefinitely).
 */
function requireEnvIndirection(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!value.startsWith("env:") || value.slice(4).length === 0) {
    throw new Error(
      `Profile ${field} must use "env:VAR_NAME" indirection -- plain-text ` +
        `secrets are never persisted to config.json. Set the secret in an ` +
        `environment variable and pass e.g. "env:SN_PASSWORD_MYINSTANCE".`
    );
  }
}

/**
 * Normalize an instance URL: strip trailing slashes, ensure https://.
 */
function normalizeInstanceUrl(instance: string): string {
  let url = instance.replace(/\/+$/, "");
  if (url && !url.startsWith("http")) {
    url = `https://${url}`;
  }
  return url;
}

/**
 * Parse the SN_REL_DEPTH env var with a default of 3.
 */
function parseRelDepth(value: string | undefined): number {
  if (!value) return 3;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 3 : parsed;
}
