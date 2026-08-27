/** Secure, provider-neutral credential sources for named ServiceNow profiles. */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { types as utilTypes } from "node:util";

export const PROFILE_ENCRYPTION_KEY_ENV = "SN_PROFILE_ENCRYPTION_KEY";
export const PROFILE_ENCRYPTION_VERSION = 1 as const;
export const PROFILE_ENCRYPTION_ALGORITHM = "aes-256-gcm" as const;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type ProfileSecretField = "credential" | "clientSecret" | "apiKey";

export interface SecretReference {
  readonly type: "secret_ref";
  /** Resolver identifier. The core ships only the provider-neutral `env` adapter. */
  readonly provider: string;
  /** Opaque provider reference. Treat this as sensitive metadata. */
  readonly reference: string;
}

export interface EncryptedCredentialEnvelope {
  readonly type: "encrypted";
  readonly version: typeof PROFILE_ENCRYPTION_VERSION;
  readonly algorithm: typeof PROFILE_ENCRYPTION_ALGORITHM;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

/** `env:SN_*` remains readable only as a legacy, non-plaintext migration form. */
export type CredentialSource =
  | SecretReference
  | EncryptedCredentialEnvelope
  | `env:${string}`;

export interface SecretResolutionContext {
  readonly profile: string;
  readonly field: ProfileSecretField;
}

/**
 * Synchronous by design: ProfileManager's established runtime configuration
 * boundary is synchronous. Provider adapters may use a protected local agent,
 * cache, keychain, or sidecar, but the core does not bind to a cloud SDK.
 */
export interface SecretResolver {
  readonly provider: string;
  resolve(reference: string, context: SecretResolutionContext): string;
}

export interface ProfileEncryptionKeyProvider {
  getKey(): Buffer;
}

export class EnvironmentSecretResolver implements SecretResolver {
  readonly provider = "env";

  resolve(reference: string): string {
    if (!isCanonicalEnvironmentName(reference)) {
      throw new Error("Credential reference is invalid");
    }
    const value = process.env[reference];
    if (!value) {
      throw new Error("Referenced credential is unavailable");
    }
    return value;
  }
}

/** Reads the one canonical profile key setting; it never persists the key. */
export class EnvironmentProfileEncryptionKeyProvider
  implements ProfileEncryptionKeyProvider
{
  getKey(): Buffer {
    const encoded = process.env[PROFILE_ENCRYPTION_KEY_ENV];
    if (!encoded) {
      throw new Error("Profile encryption key is unavailable");
    }
    return decodeEncryptionKey(encoded);
  }
}

export function secretReference(
  provider: string,
  reference: string
): SecretReference {
  const candidate = Object.freeze({ type: "secret_ref", provider, reference });
  if (!isSecretReference(candidate)) {
    throw new Error("Credential reference is invalid");
  }
  return candidate;
}

export function encryptCredential(
  plaintext: string,
  profile: string,
  field: ProfileSecretField,
  keyProvider: ProfileEncryptionKeyProvider =
    new EnvironmentProfileEncryptionKeyProvider()
): EncryptedCredentialEnvelope {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Credential value must not be empty");
  }
  assertBinding(profile, field);

  const key = ownedEncryptionKey(keyProvider);
  const nonce = randomBytes(NONCE_BYTES);
  const input = Buffer.from(plaintext, "utf8");
  try {
    const cipher = createCipheriv(PROFILE_ENCRYPTION_ALGORITHM, key, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(authenticatedMetadata(profile, field), {
      plaintextLength: input.byteLength,
    });
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Object.freeze({
      type: "encrypted",
      version: PROFILE_ENCRYPTION_VERSION,
      algorithm: PROFILE_ENCRYPTION_ALGORITHM,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: authTag.toString("base64url"),
    });
  } finally {
    input.fill(0);
    key.fill(0);
  }
}

export function decryptCredential(
  envelope: EncryptedCredentialEnvelope,
  profile: string,
  field: ProfileSecretField,
  keyProvider: ProfileEncryptionKeyProvider =
    new EnvironmentProfileEncryptionKeyProvider()
): string {
  assertBinding(profile, field);
  if (!isEncryptedCredentialEnvelope(envelope)) {
    throw new Error("Encrypted credential envelope is invalid");
  }

  const key = ownedEncryptionKey(keyProvider);
  try {
    const nonce = decodeBase64Url(envelope.nonce, NONCE_BYTES);
    const ciphertext = decodeBase64Url(envelope.ciphertext);
    const authTag = decodeBase64Url(envelope.authTag, AUTH_TAG_BYTES);
    try {
      const decipher = createDecipheriv(
        PROFILE_ENCRYPTION_ALGORITHM,
        key,
        nonce,
        { authTagLength: AUTH_TAG_BYTES }
      );
      decipher.setAAD(authenticatedMetadata(profile, field), {
        plaintextLength: ciphertext.byteLength,
      });
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      authTag.fill(0);
    }
  } catch {
    // Wrong keys, modified metadata, tags, nonces, and ciphertext deliberately
    // share one redacted failure so errors do not become a credential oracle.
    throw new Error("Credential decryption failed");
  } finally {
    key.fill(0);
  }
}

export function resolveCredentialSource(
  source: CredentialSource,
  context: SecretResolutionContext,
  resolvers: ReadonlyMap<string, SecretResolver>,
  keyProvider: ProfileEncryptionKeyProvider
): string {
  if (typeof source === "string") {
    const migrated = legacyEnvironmentReference(source);
    if (!migrated) throw new Error("Legacy plaintext credentials are not supported");
    const value = process.env[migrated.reference];
    if (!value) throw new Error("Credential resolution failed");
    return value;
  }

  if (isEncryptedCredentialEnvelope(source)) {
    return decryptCredential(source, context.profile, context.field, keyProvider);
  }
  if (!isSecretReference(source)) {
    throw new Error("Credential source is invalid");
  }

  const resolver = resolvers.get(source.provider);
  if (!resolver) throw new Error("Credential resolver is unavailable");
  try {
    const resolved = resolver.resolve(source.reference, context);
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new Error("empty");
    }
    return resolved;
  } catch {
    // Do not include provider names or opaque references in errors.
    throw new Error("Credential resolution failed");
  }
}

/** Validate untrusted descriptor data without invoking accessors or proxy traps. */
export function isCredentialSourceDescriptor(
  value: unknown
): value is CredentialSource {
  if (typeof value === "string") return legacyEnvironmentReference(value) !== undefined;
  return isSecretReference(value) || isEncryptedCredentialEnvelope(value);
}

export function isSecretReference(value: unknown): value is SecretReference {
  const record = ownDataRecord(value);
  if (!record || record.type !== "secret_ref") return false;
  if (!hasExactKeys(record, ["type", "provider", "reference"])) return false;
  if (
    typeof record.provider !== "string" ||
    !/^[a-z][a-z0-9_-]{0,31}$/u.test(record.provider) ||
    typeof record.reference !== "string" ||
    record.reference.length === 0 ||
    record.reference.length > 2048 ||
    /[\r\n\0]/u.test(record.reference)
  ) {
    return false;
  }
  return record.provider !== "env" || isCanonicalEnvironmentName(record.reference);
}

export function isEncryptedCredentialEnvelope(
  value: unknown
): value is EncryptedCredentialEnvelope {
  const record = ownDataRecord(value);
  if (!record || record.type !== "encrypted") return false;
  if (
    !hasExactKeys(record, [
      "type",
      "version",
      "algorithm",
      "nonce",
      "ciphertext",
      "authTag",
    ]) ||
    record.version !== PROFILE_ENCRYPTION_VERSION ||
    record.algorithm !== PROFILE_ENCRYPTION_ALGORITHM ||
    typeof record.nonce !== "string" ||
    typeof record.ciphertext !== "string" ||
    typeof record.authTag !== "string"
  ) {
    return false;
  }
  try {
    decodeBase64Url(record.nonce, NONCE_BYTES);
    decodeBase64Url(record.ciphertext);
    decodeBase64Url(record.authTag, AUTH_TAG_BYTES);
    return true;
  } catch {
    return false;
  }
}

export function legacyEnvironmentReference(
  value: string
): SecretReference | undefined {
  if (!value.startsWith("env:")) return undefined;
  const reference = value.slice(4);
  // Existing V1 profiles may use a non-SN_* variable. It remains readable as
  // an explicit migration compatibility form, while all newly constructed
  // structured env references must use the canonical SN_* namespace.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(reference)) return undefined;
  return Object.freeze({ type: "secret_ref", provider: "env", reference });
}

export function credentialSourceKind(
  source: CredentialSource | undefined
): "secret_ref" | "encrypted" | "missing" {
  if (source === undefined) return "missing";
  return typeof source === "string" || isSecretReference(source)
    ? "secret_ref"
    : "encrypted";
}

function authenticatedMetadata(
  profile: string,
  field: ProfileSecretField
): Buffer {
  return Buffer.from(
    JSON.stringify({
      domain: "servicenow-mcp/profile-credential",
      version: PROFILE_ENCRYPTION_VERSION,
      algorithm: PROFILE_ENCRYPTION_ALGORITHM,
      profile,
      field,
    }),
    "utf8"
  );
}

function assertBinding(profile: string, field: ProfileSecretField): void {
  if (
    typeof profile !== "string" ||
    profile.trim().length === 0 ||
    !["credential", "clientSecret", "apiKey"].includes(field)
  ) {
    throw new Error("Credential binding is invalid");
  }
}

function decodeEncryptionKey(encoded: string): Buffer {
  const value = encoded.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) {
    throw new Error("Profile encryption key is invalid");
  }
  const encoding = value.includes("-") || value.includes("_") ? "base64url" : "base64";
  const key = Buffer.from(value, encoding);
  if (key.byteLength !== KEY_BYTES) {
    key.fill(0);
    throw new Error("Profile encryption key is invalid");
  }
  return key;
}

/**
 * Copy provider-owned key material before validation or zeroization. Providers
 * may deliberately cache their Buffer; cryptographic callers must never mutate
 * that storage while cleaning up an operation-local key copy.
 */
function ownedEncryptionKey(provider: ProfileEncryptionKeyProvider): Buffer {
  const provided = provider.getKey();
  if (!Buffer.isBuffer(provided)) {
    throw new Error("Profile encryption key is invalid");
  }
  const owned = Buffer.from(provided);
  if (owned.byteLength !== KEY_BYTES) {
    owned.fill(0);
    throw new Error("Profile encryption key is invalid");
  }
  return owned;
}

function decodeBase64Url(value: string, expectedLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("invalid encoding");
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedLength !== undefined && decoded.byteLength !== expectedLength)
  ) {
    throw new Error("invalid encoding");
  }
  return decoded;
}

function isCanonicalEnvironmentName(value: string): boolean {
  return /^SN_[A-Z0-9_]+$/u.test(value);
}

function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length) return false;
  const actualBytes = Buffer.from(actual.join("\0"));
  const wantedBytes = Buffer.from(wanted.join("\0"));
  return (
    actualBytes.byteLength === wantedBytes.byteLength &&
    timingSafeEqual(actualBytes, wantedBytes)
  );
}
