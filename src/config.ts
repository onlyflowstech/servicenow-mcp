/**
 * Configuration — reads ServiceNow credentials from environment variables.
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

/**
 * Load and validate configuration from environment variables.
 * Throws descriptive errors when required variables are missing.
 */
export function loadConfig(): ServiceNowConfig {
  const instance = process.env.SN_INSTANCE;
  const user = process.env.SN_USER;
  const password = process.env.SN_PASSWORD;
  const displayValue = process.env.SN_DISPLAY_VALUE ?? "true";
  const relDepth = parseInt(process.env.SN_REL_DEPTH ?? "3", 10);
  const authType = parseAuthType(process.env.SN_AUTH_TYPE) ?? "basic";
  const grantType = parseGrantType(process.env.SN_GRANT_TYPE) ?? "client_credentials";
  const clientId = process.env.SN_CLIENT_ID;
  const clientSecret = process.env.SN_CLIENT_SECRET;
  const apiKey = process.env.SN_API_KEY;

  const needsUserPassword =
    authType === "basic" || (authType === "oauth" && grantType === "password");

  const missing: string[] = [];
  if (!instance) missing.push("SN_INSTANCE");
  if (needsUserPassword && !user) missing.push("SN_USER");
  if (needsUserPassword && !password) missing.push("SN_PASSWORD");
  if (authType === "oauth" && !clientId) missing.push("SN_CLIENT_ID");
  if (authType === "oauth" && !clientSecret) missing.push("SN_CLIENT_SECRET");
  if (authType === "apikey" && !apiKey) missing.push("SN_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}\n\n` +
        "Set them in your MCP client configuration:\n" +
        '  SN_INSTANCE  — ServiceNow instance URL (e.g. https://yourinstance.service-now.com)\n' +
        '  SN_USER      — ServiceNow username\n' +
        '  SN_PASSWORD  — ServiceNow password\n' +
        "For OAuth (SN_AUTH_TYPE=oauth): SN_CLIENT_ID + SN_CLIENT_SECRET\n" +
        "For API keys (SN_AUTH_TYPE=apikey): SN_API_KEY (+ optional SN_API_KEY_HEADER)\n"
    );
  }

  // Normalize instance URL: strip trailing slash, ensure https://
  let normalizedInstance = instance!.replace(/\/+$/, "");
  if (!normalizedInstance.startsWith("http")) {
    normalizedInstance = `https://${normalizedInstance}`;
  }

  return {
    instance: normalizedInstance,
    user: user ?? "",
    password: password ?? "",
    displayValue,
    relDepth: isNaN(relDepth) ? 3 : relDepth,
    authType,
    grantType,
    clientId,
    clientSecret,
    apiKey,
    apiKeyHeader: process.env.SN_API_KEY_HEADER,
    timeoutMs: parseTimeoutMs(process.env.SN_TIMEOUT_MS),
  };
}
