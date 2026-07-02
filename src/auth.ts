/**
 * Authentication providers for the ServiceNow HTTP client.
 *
 * Each provider produces the auth headers for a request and decides
 * whether a 401 response is worth retrying after a credential refresh.
 *
 * Supported schemes:
 *   - basic:  Authorization: Basic <user:password> (deprecated by
 *             ServiceNow's inbound Basic Auth restriction program)
 *   - oauth:  Authorization: Bearer <token> from {instance}/oauth_token.do
 *             (grant_type client_credentials or password), with token
 *             caching, expiry tracking, and single-flight refresh
 *   - apikey: the key in a configurable header (default "x-sn-apikey")
 *
 * SECURITY: token responses and secrets are never logged; error messages
 * from the token endpoint are redacted before being thrown.
 *
 * @module auth
 */

import { GrantType, ServiceNowConfig } from "./config.js";

export type AuthKind = "basic" | "oauth" | "apikey";

export const DEFAULT_API_KEY_HEADER = "x-sn-apikey";

/** Refresh tokens this many ms before their reported expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
/** Max chars of a token-endpoint error body to surface. */
const MAX_ERROR_DETAIL_CHARS = 300;

export interface AuthProvider {
  /** Which auth scheme this provider implements. */
  readonly kind: AuthKind;
  /** Headers to attach to an outgoing request (may refresh credentials). */
  getAuthHeaders(): Promise<Record<string, string>>;
  /**
   * Called by the client when a request returns 401.
   * Returns true when credentials were refreshed and a single retry
   * of the original request makes sense.
   */
  onAuthFailure(): Promise<boolean>;
}

// ── Basic ──────────────────────────────────────────────────────────

export class BasicAuthProvider implements AuthProvider {
  readonly kind = "basic" as const;
  private readonly header: string;

  constructor(user: string, password: string) {
    this.header =
      "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    return { Authorization: this.header };
  }

  async onAuthFailure(): Promise<boolean> {
    // Basic credentials cannot be refreshed -- a 401 is final.
    return false;
  }
}

// ── OAuth ──────────────────────────────────────────────────────────

export interface OAuthProviderOptions {
  /** Instance base URL (e.g. "https://myinstance.service-now.com") */
  instance: string;
  clientId: string;
  clientSecret: string;
  /** Defaults to "client_credentials". */
  grantType?: GrantType;
  /** Required for the "password" grant. */
  username?: string;
  /** Required for the "password" grant. */
  password?: string;
  /** Timeout for the token request itself (default 30000). */
  timeoutMs?: number;
}

export class OAuthProvider implements AuthProvider {
  readonly kind = "oauth" as const;
  private token: string | null = null;
  private expiresAt = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(private readonly options: OAuthProviderOptions) {
    const grantType = options.grantType ?? "client_credentials";
    if (grantType === "password" && (!options.username || !options.password)) {
      throw new Error(
        'OAuth grantType "password" requires username and credential to be configured'
      );
    }
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}` };
  }

  async onAuthFailure(): Promise<boolean> {
    // The instance rejected our token -- drop it, fetch a fresh one, and
    // let the client retry the original request exactly once.
    this.invalidate();
    await this.getToken();
    return true;
  }

  private invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  /**
   * Return a cached, unexpired token or refresh it. Concurrent callers
   * share a single in-flight refresh (single-flight).
   */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) {
      return this.token;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchToken().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async fetchToken(): Promise<string> {
    const grantType = this.options.grantType ?? "client_credentials";
    const url = new URL("/oauth_token.do", this.options.instance).toString();
    const timeoutMs = this.options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;

    const form = new URLSearchParams({
      grant_type: grantType,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    if (grantType === "password") {
      form.set("username", this.options.username ?? "");
      form.set("password", this.options.password ?? "");
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`OAuth token request timed out after ${timeoutMs}ms`);
      }
      throw new Error(
        `OAuth token request failed: ${this.redact(describeError(error))}`
      );
    }

    if (!response.ok) {
      const detail = await this.describeTokenFailure(response);
      throw new Error(
        `OAuth token request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
      );
    }

    let json: Record<string, unknown>;
    try {
      json = await response.json();
    } catch {
      // Never echo the raw body -- it may contain token material.
      throw new Error(
        `OAuth token response was not valid JSON (HTTP ${response.status})`
      );
    }

    const accessToken = json.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error(
        `OAuth token response missing access_token (HTTP ${response.status})`
      );
    }

    const expiresIn =
      typeof json.expires_in === "number"
        ? json.expires_in
        : parseInt(String(json.expires_in ?? ""), 10);
    const expiresInMs = (isNaN(expiresIn) ? 1800 : expiresIn) * 1000;

    this.token = accessToken;
    this.expiresAt = Date.now() + expiresInMs - TOKEN_EXPIRY_MARGIN_MS;
    return accessToken;
  }

  /**
   * Extract the ServiceNow error text from a failed token response,
   * redacting any secret material before it can reach an error message.
   */
  private async describeTokenFailure(response: Response): Promise<string> {
    let detail = "";
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        if (typeof json.error === "object" && json.error !== null) {
          detail = String(json.error.message ?? JSON.stringify(json.error));
        } else {
          detail = String(json.error_description ?? json.error ?? text);
        }
      } catch {
        detail = text;
      }
    } catch {
      // body unreadable -- status alone will have to do
    }
    // Redact BEFORE truncating: slicing first can cut a secret at the
    // boundary so the redaction no longer matches, leaking its prefix.
    return this.redact(detail).slice(0, MAX_ERROR_DETAIL_CHARS);
  }

  private redact(text: string): string {
    return redactSecrets(text, [
      this.options.clientSecret,
      this.options.password,
      this.token ?? undefined,
    ]);
  }
}

// ── API key ────────────────────────────────────────────────────────

export class ApiKeyProvider implements AuthProvider {
  readonly kind = "apikey" as const;

  constructor(
    private readonly key: string,
    private readonly headerName: string = DEFAULT_API_KEY_HEADER
  ) {}

  async getAuthHeaders(): Promise<Record<string, string>> {
    return { [this.headerName]: this.key };
  }

  async onAuthFailure(): Promise<boolean> {
    // A static key cannot be refreshed -- a 401 is final.
    return false;
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Build the right AuthProvider for a resolved profile config.
 * Defaults to basic auth for full backward compatibility.
 */
export function createAuthProvider(config: ServiceNowConfig): AuthProvider {
  const authType = config.authType ?? "basic";

  switch (authType) {
    case "oauth": {
      if (!config.clientId || !config.clientSecret) {
        throw new Error(
          'authType "oauth" requires clientId and clientSecret to be configured'
        );
      }
      return new OAuthProvider({
        instance: config.instance,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        grantType: config.grantType,
        username: config.user || undefined,
        password: config.password || undefined,
        timeoutMs: config.timeoutMs,
      });
    }

    case "apikey": {
      if (!config.apiKey) {
        throw new Error('authType "apikey" requires apiKey to be configured');
      }
      return new ApiKeyProvider(
        config.apiKey,
        config.apiKeyHeader || DEFAULT_API_KEY_HEADER
      );
    }

    default:
      return new BasicAuthProvider(config.user, config.password);
  }
}

// ── Module-level helpers ───────────────────────────────────────────

/** Replace every occurrence of the given secrets in text with "[redacted]". */
function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: string }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
