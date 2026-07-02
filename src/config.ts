/**
 * Configuration types and env-value parse helpers for ServiceNow
 * connection settings. Loading (config file / environment variables)
 * lives in ProfileManager.
 *
 * @module config
 */

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
}

/**
 * Parse a timeout value (ms). Returns undefined for missing,
 * non-numeric, or non-positive values.
 */
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
