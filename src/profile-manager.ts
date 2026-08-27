/**
 * Multi-instance profile manager for ServiceNow MCP server.
 *
 * Supports named profiles stored in ~/.servicenow-mcp/config.json.
 * When no file exists, canonical SN_* connection values are available only
 * through an explicitly named out-of-band SN_PROFILE_NAME mapping. Bare SN_*
 * values never create a synthetic/default routing target.
 *
 * @module profiles
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash, randomUUID } from "node:crypto";
import {
  AuthType,
  GrantType,
  ServiceNowConfig,
  parseAuthType,
  parseGrantType,
  parsePositiveIntegerEnv,
  parseTimeoutMs,
} from "./config.js";
import { ServiceNowClient } from "./client.js";
import {
  EnvironmentProfileEncryptionKeyProvider,
  EnvironmentSecretResolver,
  type CredentialSource,
  type ProfileEncryptionKeyProvider,
  type ProfileSecretField,
  type SecretResolver,
  isCredentialSourceDescriptor,
  legacyEnvironmentReference,
  resolveCredentialSource,
} from "./profile-credentials.js";

// ── Interfaces ─────────────────────────────────────────────────────

export interface Profile {
  /** ServiceNow instance URL (e.g. "https://myinstance.service-now.com") */
  instance: string;
  /** ServiceNow username (basic auth and OAuth "password" grant) */
  username?: string;
  /** Password credential source for basic auth or OAuth password grant. */
  credential?: CredentialSource;
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
  /** OAuth client-secret source (authType "oauth"). */
  clientSecret?: CredentialSource;
  /** OAuth grant type: "client_credentials" (default) or "password" */
  grantType?: GrantType;
  /** API-key source (authType "apikey"). */
  apiKey?: CredentialSource;
  /** Header the API key is sent in (default "x-sn-apikey") */
  apiKeyHeader?: string;
  /** Per-request timeout in ms (default 30000; env fallback SN_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Per-instance upstream REST concurrency cap (default 4; env fallback SN_MAX_CONCURRENT_REQUESTS) */
  maxConcurrentRequests?: number;
  /** Schema cache TTL in ms (default 300000; env fallback SN_SCHEMA_CACHE_TTL_MS) */
  schemaCacheTtlMs?: number;
}

export interface ProfileConfig {
  /** Config file schema version */
  version: number;
  /** Map of profile name to profile definition */
  profiles: Record<string, Profile>;
}

export interface ProfileListEntry {
  name: string;
  instance: string;
  authType: AuthType;
  description?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const CONFIG_DIR = ".servicenow-mcp";
const CONFIG_FILE = "config.json";
const CONFIG_VERSION = 2;
const LOCK_WAIT_MS = 2_000;
const MAX_PROFILE_CONFIG_BYTES = 1024 * 1024;
const POSIX_PERMISSIONS = process.platform !== "win32";
const PROFILE_KEYS = new Set([
  "instance", "username", "credential", "scope", "scope_sys_id",
  "vendor_code", "description", "authType", "clientId", "clientSecret",
  "grantType", "apiKey", "apiKeyHeader", "timeoutMs", "maxConcurrentRequests", "schemaCacheTtlMs",
]);

export interface ProfileManagerOptions {
  configFilePath?: string;
  secretResolvers?: readonly SecretResolver[];
  encryptionKeyProvider?: ProfileEncryptionKeyProvider;
}

// ── ProfileManager ─────────────────────────────────────────────────

export class ProfileManager {
  private config: ProfileConfig;
  private clientCache: Map<
    string,
    { fingerprint: string; client: ServiceNowClient }
  > = new Map();
  private configFilePath: string;
  private readonly secretResolvers: ReadonlyMap<string, SecretResolver>;
  private readonly encryptionKeyProvider: ProfileEncryptionKeyProvider;

  constructor(options: ProfileManagerOptions = {}) {
    this.configFilePath = normalizeConfigFilePath(
      options.configFilePath ?? path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE)
    );
    const resolvers = options.secretResolvers ?? [new EnvironmentSecretResolver()];
    const resolverMap = new Map<string, SecretResolver>();
    for (const resolver of resolvers) {
      if (
        !resolver ||
        typeof resolver.provider !== "string" ||
        !/^[a-z][a-z0-9_-]{0,31}$/u.test(resolver.provider) ||
        typeof resolver.resolve !== "function" ||
        resolverMap.has(resolver.provider)
      ) {
        throw new Error("Credential resolver configuration is invalid");
      }
      resolverMap.set(resolver.provider, resolver);
    }
    this.secretResolvers = resolverMap;
    this.encryptionKeyProvider =
      options.encryptionKeyProvider ??
      new EnvironmentProfileEncryptionKeyProvider();

    const fileConfig = this.loadConfigFile();
    if (fileConfig) {
      this.config = fileConfig;
    } else {
      this.config = this.buildExplicitEnvironmentProfile();
    }
  }

  /**
   * Get a profile by its explicit configured name.
   * Throws if the profile does not exist.
   */
  getProfile(name: string): Profile {
    if (!Object.hasOwn(this.config.profiles, name)) {
      const available = Object.keys(this.config.profiles).join(", ");
      throw new Error(
        `Profile "${name}" not found. Available profiles: ${available || "(none)"}`
      );
    }
    return this.config.profiles[name];
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
      this.getProfileNameFor(profile),
      "credential"
    );
  }

  /**
   * Resolve a secret value that supports "env:VAR_NAME" indirection
   * (credential, clientSecret, apiKey). Plain values are returned as-is
   * with a stderr warning.
   */
  private resolveSecret(
    source: CredentialSource,
    profile: string,
    field: ProfileSecretField
  ): string {
    return resolveCredentialSource(
      source,
      Object.freeze({ profile, field }),
      this.secretResolvers,
      this.encryptionKeyProvider
    );
  }

  /** List all configured profiles without selecting or activating one. */
  listProfiles(): ProfileListEntry[] {
    return Object.entries(this.config.profiles).map(([name, profile]) => ({
      name,
      instance: profile.instance,
      authType: profile.authType ?? "basic",
      description: profile.description,
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
   * Return a ServiceNowClient for an explicitly named profile.
   * Clients are cached per profile name -- the same instance is returned on
   * subsequent calls for the same profile.
   */
  getClient(
    name: string,
    resolvedConfig?: Readonly<ServiceNowConfig>
  ): ServiceNowClient {
    // The dispatcher supplies its one request-local resolution. Direct callers
    // resolve here. In both cases the bounded cache is reusable only when the
    // resolved authentication material is unchanged, so missing keys and
    // provider-side rotations cannot be bypassed by a previously used client.
    const config = resolvedConfig ?? this.getConfig(name);
    const fingerprint = credentialFingerprint(config);
    const cached = this.clientCache.get(name);
    if (cached?.fingerprint === fingerprint) return cached.client;
    const client = new ServiceNowClient(config);
    this.clientCache.set(name, { fingerprint, client });
    return client;
  }

  /** Return a ServiceNowConfig for an explicitly named profile. */
  getConfig(name: string): ServiceNowConfig {
    const profile = this.getProfile(name);
    const authType = profile.authType ?? "basic";
    const grantType = profile.grantType ?? "client_credentials";
    // Canonicalize the destination before resolving any credential material.
    // Tool preflight uses this same function, preventing validation/use drift.
    const instance = normalizeInstanceUrl(profile.instance);

    // The user password is only needed for basic auth and the OAuth
    // "password" grant -- don't demand a credential for other schemes.
    const needsPassword =
      authType === "basic" || (authType === "oauth" && grantType === "password");
    const password = needsPassword ? this.resolveCredential(profile) : "";

    return Object.freeze({
      instance,
      user: profile.username ?? "",
      password,
      displayValue: process.env.SN_DISPLAY_VALUE ?? "true",
      relDepth: parseRelDepth(process.env.SN_REL_DEPTH),
      authType,
      grantType,
      clientId: profile.clientId,
      // Only resolve the secrets the chosen auth scheme actually uses: a
      // stray reference for another scheme (e.g. apiKey on an oauth
      // profile) pointing at an unset env var must not break auth that
      // never needed it.
      clientSecret:
        authType === "oauth" && profile.clientSecret
          ? this.resolveSecret(
              profile.clientSecret,
              name,
              "clientSecret"
            )
          : undefined,
      apiKey:
        authType === "apikey" && profile.apiKey
          ? this.resolveSecret(profile.apiKey, name, "apiKey")
          : undefined,
      apiKeyHeader: profile.apiKeyHeader,
      timeoutMs: profile.timeoutMs ?? parseTimeoutMs(process.env.SN_TIMEOUT_MS),
      maxConcurrentRequests:
        profile.maxConcurrentRequests ??
        parsePositiveIntegerEnv(process.env.SN_MAX_CONCURRENT_REQUESTS, "SN_MAX_CONCURRENT_REQUESTS", { max: 32 }),
      schemaCacheTtlMs:
        profile.schemaCacheTtlMs ??
        parsePositiveIntegerEnv(process.env.SN_SCHEMA_CACHE_TTL_MS, "SN_SCHEMA_CACHE_TTL_MS", { max: 3_600_000 }),
    });
  }

  /**
   * Add a new profile at runtime and persist the updated config to disk.
   * If a profile with the same name already exists, it is overwritten.
   */
  addProfile(name: string, profile: Profile): void {
    validateProfileName(name);
    validateProfileKeys(profile);

    // A profile binds secret env-var references (SN_PASSWORD, SN_CLIENT_
    // SECRET, SN_API_KEY, ...) to an instance URL: on the next call the
    // resolved secret is TRANSMITTED to that host. Runtime-added profiles
    // may therefore only target ServiceNow domains (or hosts the operator
    // explicitly allowlisted via SN_ALLOWED_INSTANCE_HOSTS) -- otherwise a
    // prompt-injected add + switch would silently exfiltrate a real secret
    // to an attacker-controlled host.
    const hostProblem = instanceHostError(profile.instance);
    if (hostProblem) {
      throw new Error(hostProblem);
    }

    // Never persist plain-text secrets: everything addProfile writes to
    // disk must reference an environment variable via "env:VAR_NAME".
    validatePersistedCredentialSource(profile.credential, "credential");
    validatePersistedCredentialSource(profile.clientSecret, "clientSecret");
    validatePersistedCredentialSource(profile.apiKey, "apiKey");

    this.mutateConfig((config) => {
      Object.defineProperty(config.profiles, name, {
        value: canonicalizeProfile(profile),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });

    // Invalidate cached client for this profile if it existed
    this.clientCache.delete(name);
  }

  /** Replace one credential source without exposing it through an MCP tool. */
  rotateCredential(
    name: string,
    field: ProfileSecretField,
    source: CredentialSource
  ): void {
    validateProfileName(name);
    validatePersistedCredentialSource(source, field);
    this.mutateConfig((config) => {
      if (!Object.hasOwn(config.profiles, name)) {
        throw new Error(`Profile "${name}" not found`);
      }
      const current = config.profiles[name];
      config.profiles[name] = canonicalizeProfile({ ...current, [field]: source });
    });
    this.clientCache.delete(name);
  }

  /** Remove one named profile through the out-of-band administration boundary. */
  removeProfile(name: string): void {
    validateProfileName(name);
    this.mutateConfig((config) => {
      if (!Object.hasOwn(config.profiles, name)) {
        throw new Error(`Profile "${name}" not found`);
      }
      delete config.profiles[name];
    });
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
    let descriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    try {
      const parentsBefore = inspectParentComponents(this.configFilePath);
      if (parentsBefore.missing) {
        assertParentPathRemainsAbsent(this.configFilePath, parentsBefore);
        return null;
      }
      directoryDescriptor = openSecureConfigDirectory(
        path.dirname(this.configFilePath)
      );
      descriptor = openExistingConfigFile(this.configFilePath);
      if (descriptor === undefined) {
        assertConfigEntryRemainsAbsent(this.configFilePath, parentsBefore);
        return null;
      }

      secureConfigFileDescriptor(descriptor);
      const status = fs.fstatSync(descriptor);
      if (status.size > MAX_PROFILE_CONFIG_BYTES) {
        throw new Error("Profile configuration exceeds the size limit");
      }
      const raw = fs.readFileSync(descriptor, { encoding: "utf8" });
      assertPathIdentity(this.configFilePath, status, parentsBefore);
      const parsed: unknown = JSON.parse(raw);

      // Basic validation
      if (
        typeof parsed !== "object" || parsed === null ||
        !("version" in parsed) || typeof parsed.version !== "number" ||
        !("profiles" in parsed) || typeof parsed.profiles !== "object" ||
        parsed.profiles === null || Array.isArray(parsed.profiles)
      ) {
        throw new Error("Profile configuration has invalid structure");
      }

      const profiles = validateLoadedProfiles(parsed.profiles);

      return {
        version: parsed.version,
        profiles,
      };
    } catch (err) {
      const reason =
        err instanceof Error && err.message.includes("legacy plaintext")
          ? "Legacy plaintext profile credentials are rejected; replace them through the profile administration CLI"
          : "Profile configuration could not be loaded safely";
      throw new Error(reason);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
    }
  }

  /**
   * Build one explicitly named, process-local profile from canonical SN_*
   * variables. SN_PROFILE_NAME is the required out-of-band mapping: without
   * it, even fully populated connection variables produce no profile. This
   * preserves SN_* support without a default/active/omitted routing path.
   * Additional env vars configure the auth scheme:
   * SN_AUTH_TYPE, SN_CLIENT_ID, SN_CLIENT_SECRET, SN_GRANT_TYPE,
   * SN_API_KEY, SN_API_KEY_HEADER, SN_TIMEOUT_MS.
   */
  private buildExplicitEnvironmentProfile(): ProfileConfig {
    const profileName = process.env.SN_PROFILE_NAME;
    if (profileName === undefined) {
      return { version: CONFIG_VERSION, profiles: Object.create(null) };
    }
    validateProfileName(profileName);
    const instance = process.env.SN_INSTANCE;
    const user = process.env.SN_USER;
    if (!instance?.trim()) {
      throw new Error("SN_PROFILE_NAME requires SN_INSTANCE");
    }

    // Secret values remain environment references. If later persisted by an
    // operator administration action, no plaintext credential is written.
    const profile: Profile = {
      instance,
      username: user ?? "",
      credential: "env:SN_PASSWORD",
    };

    const authTypeValue = process.env.SN_AUTH_TYPE;
    const authType = parseAuthType(authTypeValue);
    if (authTypeValue !== undefined && authType === undefined) {
      throw new Error("SN_AUTH_TYPE must be basic, oauth, or apikey");
    }
    if (authType) {
      profile.authType = authType;
    }
    if (process.env.SN_CLIENT_ID) {
      profile.clientId = process.env.SN_CLIENT_ID;
    }
    if (process.env.SN_CLIENT_SECRET) {
      profile.clientSecret = "env:SN_CLIENT_SECRET";
    }
    const grantTypeValue = process.env.SN_GRANT_TYPE;
    const grantType = parseGrantType(grantTypeValue);
    if (grantTypeValue !== undefined && grantType === undefined) {
      throw new Error(
        "SN_GRANT_TYPE must be client_credentials or password"
      );
    }
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
    const maxConcurrentRequests = parsePositiveIntegerEnv(
      process.env.SN_MAX_CONCURRENT_REQUESTS,
      "SN_MAX_CONCURRENT_REQUESTS",
      { max: 32 }
    );
    if (maxConcurrentRequests !== undefined) {
      profile.maxConcurrentRequests = maxConcurrentRequests;
    }
    const schemaCacheTtlMs = parsePositiveIntegerEnv(
      process.env.SN_SCHEMA_CACHE_TTL_MS,
      "SN_SCHEMA_CACHE_TTL_MS",
      { max: 3_600_000 }
    );
    if (schemaCacheTtlMs !== undefined) {
      profile.schemaCacheTtlMs = schemaCacheTtlMs;
    }

    return {
      version: CONFIG_VERSION,
      profiles: Object.assign(Object.create(null), {
        [profileName]: canonicalizeProfile(profile),
      }),
    };
  }

  /**
   * Persist the current config to disk, creating the directory if needed.
   */
  private persistConfig(config: ProfileConfig = this.config): void {
    const dir = path.dirname(this.configFilePath);
    const parentsBefore = ensureSecureConfigDirectory(this.configFilePath);
    const directoryDescriptor = openSecureConfigDirectory(dir);

    const canonical: ProfileConfig = {
      version: CONFIG_VERSION,
      profiles: Object.fromEntries(
        Object.entries(config.profiles).map(([name, profile]) => [
          name,
          canonicalizeProfile(profile),
        ])
      ),
    };
    const json = JSON.stringify(canonical, null, 2) + "\n";
    const temporary = path.join(dir, `.${CONFIG_FILE}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let persistedDescriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          noFollowFlag(),
        0o600
      );
      if (POSIX_PERMISSIONS) fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, json, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.configFilePath);
      persistedDescriptor = openExistingConfigFile(this.configFilePath);
      if (persistedDescriptor === undefined) {
        throw new Error("Persisted profile configuration disappeared");
      }
      secureConfigFileDescriptor(persistedDescriptor);
      const persistedStatus = fs.fstatSync(persistedDescriptor);
      assertPathIdentity(this.configFilePath, persistedStatus, parentsBefore);
      syncDirectoryDescriptor(directoryDescriptor);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (persistedDescriptor !== undefined) fs.closeSync(persistedDescriptor);
      if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
      unlinkIfPresent(temporary);
    }
    this.config = canonical;
  }

  private mutateConfig(mutator: (config: ProfileConfig) => void): void {
    const release = acquireConfigLock(this.configFilePath);
    try {
      const onDisk = this.loadConfigFile();
      const next = cloneConfig(onDisk ?? this.config);
      mutator(next);
      this.persistConfig(next);
    } finally {
      release();
    }
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

function validatePersistedCredentialSource(
  value: CredentialSource | undefined,
  field: string
): void {
  if (value === undefined) return;
  if (
    typeof value === "string" &&
    !/^env:SN_[A-Z0-9_]+$/u.test(value)
  ) {
    throw new Error(
      `Profile ${field} must use a canonical SN_* environment reference, a ` +
        "secret reference, or an encrypted envelope"
    );
  }
  if (!isCredentialSourceDescriptor(value)) {
    throw new Error(
      `Profile ${field} must use a valid secret reference or encrypted envelope; ` +
        "legacy plaintext secrets are never persisted"
    );
  }
}

function validateLoadedProfiles(value: object): Record<string, Profile> {
  const profiles: Record<string, Profile> = Object.create(null);
  for (const [name, candidate] of Object.entries(value)) {
    validateProfileName(name);
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error("Profile configuration has invalid structure");
    }
    const profile = candidate as Profile;
    validateProfileKeys(profile);
    for (const field of ["credential", "clientSecret", "apiKey"] as const) {
      const source = profile[field];
      if (source === undefined) continue;
      if (typeof source === "string" && !legacyEnvironmentReference(source)) {
        throw new Error("Profile configuration contains legacy plaintext credentials");
      }
      if (!isCredentialSourceDescriptor(source)) {
        throw new Error("Profile configuration contains an invalid credential source");
      }
    }
    Object.defineProperty(profiles, name, {
      value: canonicalizeProfile(profile),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return profiles;
}

function canonicalizeProfile(profile: Profile): Profile {
  validateProfileKeys(profile);
  const canonical: Profile = { ...profile };
  for (const field of ["credential", "clientSecret", "apiKey"] as const) {
    const source = canonical[field];
    if (typeof source === "string") {
      const migrated = legacyEnvironmentReference(source);
      if (!migrated) {
        throw new Error("Legacy plaintext profile credentials are rejected");
      }
      // Preserve readable non-canonical V1 env references until the operator
      // explicitly rotates them. Canonical SN_* refs migrate to V2 objects.
      if (/^SN_[A-Z0-9_]+$/u.test(migrated.reference)) {
        canonical[field] = migrated;
      }
    }
  }
  return immutableProfileSnapshot(canonical);
}

function immutableProfileSnapshot(profile: Profile): Profile {
  const snapshot: Profile = { ...profile };
  for (const field of ["credential", "clientSecret", "apiKey"] as const) {
    const source = snapshot[field];
    if (source !== undefined && typeof source !== "string") {
      snapshot[field] = Object.freeze({ ...source });
    }
  }
  return Object.freeze(snapshot);
}

function validateProfileName(name: string): void {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u.test(name)
  ) {
    throw new Error("Profile name is invalid");
  }
}

function validateProfileKeys(profile: Profile): void {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new Error("Profile configuration has invalid structure");
  }
  for (const key of Object.keys(profile)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new Error("Profile configuration contains an unsupported field");
    }
  }
}

interface PathIdentity {
  readonly target: string;
  readonly device: number;
  readonly inode: number;
}

interface ParentInspection {
  readonly missing: boolean;
  readonly identities: readonly PathIdentity[];
}

function normalizeConfigFilePath(candidate: string): string {
  const resolved = path.resolve(candidate);
  // Darwin exposes /var and /tmp as stable OS-managed aliases into /private.
  // Canonicalize only these platform roots before applying the no-symlink
  // policy so ordinary temporary HOME directories remain testable without
  // accepting operator-created parent symlinks.
  if (process.platform === "darwin") {
    if (resolved === "/var" || resolved.startsWith("/var/")) {
      return `/private${resolved}`;
    }
    if (resolved === "/tmp" || resolved.startsWith("/tmp/")) {
      return `/private${resolved}`;
    }
  }
  return resolved;
}

function inspectParentComponents(configPath: string): ParentInspection {
  const directory = path.dirname(configPath);
  const root = path.parse(directory).root;
  const relative = path.relative(root, directory);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  const identities: PathIdentity[] = [];
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let status: fs.Stats;
    try {
      status = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({
          missing: true,
          identities: Object.freeze(identities),
        });
      }
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("Profile configuration parent path is unsafe");
    }
    identities.push(
      Object.freeze({
        target: current,
        device: status.dev,
        inode: status.ino,
      })
    );
  }
  return Object.freeze({
    missing: false,
    identities: Object.freeze(identities),
  });
}

function ensureSecureConfigDirectory(configPath: string): ParentInspection {
  let inspection = inspectParentComponents(configPath);
  if (inspection.missing) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    inspection = inspectParentComponents(configPath);
    if (inspection.missing) {
      throw new Error("Profile configuration directory could not be created safely");
    }
  }
  const descriptor = openSecureConfigDirectory(path.dirname(configPath));
  try {
    syncDirectoryDescriptor(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return inspectParentComponents(configPath);
}

function openSecureConfigDirectory(directory: string): number | undefined {
  if (!POSIX_PERMISSIONS) return undefined;
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | directoryFlag() | noFollowFlag()
  );
  try {
    let status = fs.fstatSync(descriptor);
    if (!status.isDirectory()) {
      throw new Error("Profile configuration parent is not a directory");
    }
    assertOwnedByCurrentUser(status, "Profile configuration directory");
    if ((status.mode & 0o777) !== 0o700) {
      fs.fchmodSync(descriptor, 0o700);
      status = fs.fstatSync(descriptor);
    }
    if ((status.mode & 0o777) !== 0o700) {
      throw new Error("Profile configuration directory permissions are unsafe");
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function openExistingConfigFile(configPath: string): number | undefined {
  if (!POSIX_PERMISSIONS) {
    try {
      const status = fs.lstatSync(configPath);
      if (status.isSymbolicLink()) {
        throw new Error("Profile configuration symlinks are not allowed");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  try {
    return fs.openSync(configPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A broken symlink is not a truly absent configuration. lstat distinguishes
    // it from a missing directory entry even on platforms without O_NOFOLLOW.
    try {
      fs.lstatSync(configPath);
    } catch (lstatError) {
      if ((lstatError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    }
    throw new Error("Profile configuration path is unsafe");
  }
}

function secureConfigFileDescriptor(descriptor: number): void {
  let status = fs.fstatSync(descriptor);
  if (!status.isFile()) {
    throw new Error("Profile configuration is not a regular file");
  }
  if (status.size > MAX_PROFILE_CONFIG_BYTES) {
    throw new Error("Profile configuration exceeds the size limit");
  }
  if (!POSIX_PERMISSIONS) return;
  assertOwnedByCurrentUser(status, "Profile configuration");
  if ((status.mode & 0o777) !== 0o600) {
    fs.fchmodSync(descriptor, 0o600);
    status = fs.fstatSync(descriptor);
  }
  if ((status.mode & 0o777) !== 0o600) {
    throw new Error("Profile configuration permissions are unsafe");
  }
}

function assertOwnedByCurrentUser(status: fs.Stats, subject: string): void {
  const userId = process.getuid?.();
  if (userId !== undefined && status.uid !== userId) {
    throw new Error(`${subject} is not owned by the current user`);
  }
}

function assertPathIdentity(
  configPath: string,
  descriptorStatus: fs.Stats,
  parentsBefore: ParentInspection
): void {
  const parentsAfter = inspectParentComponents(configPath);
  if (
    parentsAfter.missing ||
    parentsBefore.missing ||
    parentsAfter.identities.length !== parentsBefore.identities.length
  ) {
    throw new Error("Profile configuration parent changed during access");
  }
  for (let index = 0; index < parentsBefore.identities.length; index += 1) {
    const before = parentsBefore.identities[index];
    const after = parentsAfter.identities[index];
    if (
      before.target !== after.target ||
      before.device !== after.device ||
      before.inode !== after.inode
    ) {
      throw new Error("Profile configuration parent changed during access");
    }
  }

  let pathStatus: fs.Stats;
  try {
    pathStatus = fs.lstatSync(configPath);
  } catch {
    throw new Error("Profile configuration changed during access");
  }
  if (
    pathStatus.isSymbolicLink() ||
    !pathStatus.isFile() ||
    pathStatus.dev !== descriptorStatus.dev ||
    pathStatus.ino !== descriptorStatus.ino
  ) {
    throw new Error("Profile configuration changed during access");
  }
}

function assertParentPathRemainsAbsent(
  configPath: string,
  parentsBefore: ParentInspection
): void {
  const parentsAfter = inspectParentComponents(configPath);
  if (
    !parentsBefore.missing ||
    !parentsAfter.missing ||
    !samePathIdentities(parentsBefore.identities, parentsAfter.identities)
  ) {
    throw new Error("Profile configuration parent changed during access");
  }
}

function assertConfigEntryRemainsAbsent(
  configPath: string,
  parentsBefore: ParentInspection
): void {
  const parentsAfter = inspectParentComponents(configPath);
  if (
    parentsBefore.missing ||
    parentsAfter.missing ||
    !samePathIdentities(parentsBefore.identities, parentsAfter.identities)
  ) {
    throw new Error("Profile configuration parent changed during access");
  }
  try {
    fs.lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Profile configuration appeared during access");
}

function samePathIdentities(
  before: readonly PathIdentity[],
  after: readonly PathIdentity[]
): boolean {
  return before.length === after.length && before.every((identity, index) => {
    const candidate = after[index];
    return (
      identity.target === candidate.target &&
      identity.device === candidate.device &&
      identity.inode === candidate.inode
    );
  });
}

function noFollowFlag(): number {
  if (!POSIX_PERMISSIONS) return 0;
  return (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

function directoryFlag(): number {
  return (fs.constants as typeof fs.constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
}

function syncDirectoryDescriptor(descriptor: number | undefined): void {
  if (POSIX_PERMISSIONS && descriptor !== undefined) fs.fsyncSync(descriptor);
}

function unlinkIfPresent(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function cloneConfig(config: ProfileConfig): ProfileConfig {
  const profiles: Record<string, Profile> = Object.create(null);
  for (const [name, profile] of Object.entries(config.profiles)) {
    Object.defineProperty(profiles, name, {
      value: { ...profile },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return { version: config.version, profiles };
}

function acquireConfigLock(configPath: string): () => void {
  const lockPath = `${configPath}.lock`;
  ensureSecureConfigDirectory(configPath);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          noFollowFlag(),
        0o600
      );
      if (POSIX_PERMISSIONS) fs.fchmodSync(descriptor, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error("Profile configuration is busy");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return () => {
    try {
      fs.closeSync(descriptor);
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
}

/**
 * Hostname suffixes runtime-added profiles may target without operator
 * opt-in: ServiceNow's commercial and government SaaS domains.
 */
const ALLOWED_INSTANCE_SUFFIXES = [".service-now.com", ".servicenowservices.com"];

/**
 * Validate the instance URL of a profile that is being added at runtime
 * (sn_profile add). Returns an error message, or undefined when the URL
 * is acceptable.
 *
 * Secrets configured for one instance must not be redirectable to an
 * arbitrary host: a profile stores env-var REFERENCES, and the resolved
 * secret is sent to the profile's instance on the next authenticated
 * call. So runtime adds require https and a *.service-now.com /
 * *.servicenowservices.com host. Self-hosted or custom-domain instances
 * are supported via the SN_ALLOWED_INSTANCE_HOSTS environment variable
 * (comma-separated hostnames; a "*.example.com" entry allows any
 * subdomain) -- set by the operator, never by the model.
 *
 * Profiles hand-written into config.json are not affected: the operator
 * edits that file directly and this check only runs in addProfile.
 */
export function instanceHostError(instance: string): string | undefined {
  let url: URL;
  try {
    url = new URL(normalizeInstanceUrl(instance));
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "ServiceNow instance URL is invalid";
  }

  const host = url.hostname.toLowerCase();
  if (ALLOWED_INSTANCE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return undefined;
  }

  const allowlist = (process.env.SN_ALLOWED_INSTANCE_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  for (const entry of allowlist) {
    if (entry.startsWith("*.")) {
      if (host.endsWith(entry.slice(1))) return undefined;
    } else if (host === entry) {
      return undefined;
    }
  }

  return (
    `instance host "${host}" is not a ServiceNow domain ` +
    `(*.service-now.com, *.servicenowservices.com). Profiles bind secret ` +
    `environment-variable references to an instance, so runtime-added ` +
    `profiles may only target allowlisted hosts. For a self-hosted or ` +
    `custom-domain instance, set SN_ALLOWED_INSTANCE_HOSTS in the MCP ` +
    `server's environment (comma-separated hostnames; "*.corp.example.com" ` +
    `wildcards allowed).`
  );
}

/**
 * Normalize an instance URL: strip trailing slashes, ensure https://.
 */
export function normalizeInstanceUrl(instance: string): string {
  const raw = instance.trim();
  if (!raw) {
    throw new Error("ServiceNow instance URL must not be empty");
  }

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("ServiceNow instance URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new Error("ServiceNow instance URL must use https://");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "ServiceNow instance URL must not contain credentials, query parameters, or a fragment"
    );
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error("ServiceNow instance URL must identify the instance origin only");
  }
  return url.origin;
}

/**
 * Parse the SN_REL_DEPTH env var with a default of 3.
 */
function parseRelDepth(value: string | undefined): number {
  if (!value) return 3;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 3 : parsed;
}

function credentialFingerprint(config: ServiceNowConfig): string {
  const hash = createHash("sha256");
  for (const value of [
    config.instance,
    config.authType ?? "basic",
    config.grantType ?? "client_credentials",
    config.user,
    config.password,
    config.clientId ?? "",
    config.clientSecret ?? "",
    config.apiKey ?? "",
    config.apiKeyHeader ?? "",
  ]) {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.byteLength);
    hash.update(length);
    hash.update(encoded);
    length.fill(0);
    encoded.fill(0);
  }
  return hash.digest("base64url");
}
