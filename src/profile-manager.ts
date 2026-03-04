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
import { ServiceNowConfig } from "./config.js";
import { ServiceNowClient } from "./client.js";

// ── Interfaces ─────────────────────────────────────────────────────

export interface Profile {
  /** ServiceNow instance URL (e.g. "https://myinstance.service-now.com") */
  instance: string;
  /** ServiceNow username */
  username: string;
  /** Credential: "env:VAR_NAME" to read from env, or a plain string */
  credential: string;
  /** Application scope (e.g. "x_knowd_know_drago") */
  scope?: string;
  /** Scope sys_id */
  scope_sys_id?: string;
  /** Vendor code (e.g. "knowd", "1105906") */
  vendor_code?: string;
  /** Human-readable description of this profile */
  description?: string;
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

    if (credential.startsWith("env:")) {
      const varName = credential.slice(4);
      const value = process.env[varName];
      if (!value) {
        throw new Error(
          `Profile credential references environment variable "${varName}" which is not set`
        );
      }
      return value;
    }

    // Plain-text credential -- warn the user
    process.stderr.write(
      `[servicenow-mcp] WARNING: Profile "${this.getProfileNameFor(profile)}" ` +
        `uses a plain-text credential. Consider using "env:VAR_NAME" instead.\n`
    );
    return credential;
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
      description: profile.description,
      isActive: name === this.activeProfile,
    }));
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
    const password = this.resolveCredential(profile);

    return {
      instance: normalizeInstanceUrl(profile.instance),
      user: profile.username,
      password,
      displayValue: process.env.SN_DISPLAY_VALUE ?? "true",
      relDepth: parseRelDepth(process.env.SN_REL_DEPTH),
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
   * and SN_PASSWORD.
   */
  private buildConfigFromEnv(): ProfileConfig {
    const instance = process.env.SN_INSTANCE;
    const user = process.env.SN_USER;
    const password = process.env.SN_PASSWORD;

    // If env vars are set, create a synthetic profile.
    // If they aren't, still create the config structure -- the error
    // will surface when getConfig() tries to resolve credentials.
    const profile: Profile = {
      instance: instance ?? "",
      username: user ?? "",
      credential: password ? password : "env:SN_PASSWORD",
    };

    // If all env vars are present, use the password directly to avoid
    // double-indirection. If password is missing, reference env var so
    // resolveCredential() gives a clear error message.
    if (password) {
      // Store as plain value but since this is from env vars (ephemeral),
      // suppress the warning by marking it as env-sourced.
      profile.credential = `env:SN_PASSWORD`;
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
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = JSON.stringify(this.config, null, 2) + "\n";
    fs.writeFileSync(this.configFilePath, json, "utf-8");
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
