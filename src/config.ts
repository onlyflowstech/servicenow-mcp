/**
 * Configuration types and env-value parse helpers for ServiceNow
 * connection settings. Loading (config file / environment variables)
 * lives in ProfileManager.
 *
 * @module config
 */

import type { MetadataCacheConfigInput } from "./metadata-cache.js";

export type AuthType = "basic" | "oauth" | "apikey";
export type GrantType = "client_credentials" | "password";

export interface ServiceNowConfig {
  instance: string;
  user: string;
  password: string;
  displayValue: string;
  relDepth: number;
  /** Auth scheme (default "basic"). */
  authType?: AuthType;
  /** OAuth client id (authType "oauth"). */
  clientId?: string;
  /** OAuth client secret, already resolved (authType "oauth"). */
  clientSecret?: string;
  /** OAuth grant type (default "client_credentials"). */
  grantType?: GrantType;
  /** API key, already resolved (authType "apikey"). */
  apiKey?: string;
  /** Header the API key is sent in (default "x-sn-apikey"). */
  apiKeyHeader?: string;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Per-instance upstream REST concurrency cap (default 4). */
  maxConcurrentRequests?: number;
  /** Schema metadata cache TTL in milliseconds (default 300000). */
  schemaCacheTtlMs?: number;
  /** Per-instance metadata read-through cache configuration. */
  metadataCache?: MetadataCacheConfigInput;
}

/**
 * Parse a timeout value (ms). Returns undefined for missing,
 * non-numeric, or non-positive values.
 */
export function parsePositiveIntegerEnv(
  value: string | undefined,
  name: string,
  options: { readonly min?: number; readonly max?: number } = {}
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value.trim());
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

export function parseTimeoutMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/**
 * Parse an auth type. Returns undefined for missing or unknown values.
 */
export function parseAuthType(value: string | undefined): AuthType | undefined {
  if (value === "basic" || value === "oauth" || value === "apikey") {
    return value;
  }
  return undefined;
}

/**
 * Parse an OAuth grant type. Returns undefined for missing or unknown values.
 */
export function parseGrantType(value: string | undefined): GrantType | undefined {
  if (value === "client_credentials" || value === "password") {
    return value;
  }
  return undefined;
}
