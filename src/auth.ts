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
import {
  boundedRetryAfterSeconds,
  createToolError,
} from "./tool-error.js";

export type AuthKind = "basic" | "oauth" | "apikey";

export const DEFAULT_API_KEY_HEADER = "x-sn-apikey";

/** Refresh tokens this many ms before their reported expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export interface AuthProvider {
  /** Which auth scheme this provider implements. */
  readonly kind: AuthKind;
  /** Headers to attach to an outgoing request (may refresh credentials). */
  getAuthHeaders(signal?: AbortSignal): Promise<Record<string, string>>;
  /**
   * Called by the client when a request returns 401.
   * Returns true when credentials were refreshed and a single retry
   * of the original request makes sense.
   */
  onAuthFailure(signal?: AbortSignal): Promise<boolean>;
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

interface OAuthRefresh {
  readonly controller: AbortController;
  promise: Promise<string> | null;
  subscribers: number;
  settled: boolean;
}

interface OAuthToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

export class OAuthProvider implements AuthProvider {
  readonly kind = "oauth" as const;
  private token: string | null = null;
  private expiresAt = 0;
  private refresh: OAuthRefresh | null = null;

  constructor(private readonly options: OAuthProviderOptions) {
    const grantType = options.grantType ?? "client_credentials";
    if (grantType === "password" && (!options.username || !options.password)) {
      throw createToolError("authentication", "retry_after_correction");
    }
  }

  async getAuthHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    const token = await this.getToken(signal);
    return { Authorization: `Bearer ${token}` };
  }

  async onAuthFailure(signal?: AbortSignal): Promise<boolean> {
    // The instance rejected our token -- drop it, fetch a fresh one, and
    // let the client retry the original request exactly once.
    this.invalidate();
    await this.getToken(signal);
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
  private async getToken(signal?: AbortSignal): Promise<string> {
    throwIfOAuthCancelled(signal);
    if (this.token && Date.now() < this.expiresAt) {
      return this.token;
    }
    const refresh = this.refresh ?? this.startRefresh();
    return this.subscribeToRefresh(refresh, signal);
  }

  private startRefresh(): OAuthRefresh {
    const controller = new AbortController();
    const refresh: OAuthRefresh = {
      controller,
      promise: null,
      subscribers: 0,
      settled: false,
    };
    this.refresh = refresh;
    refresh.promise = this.fetchToken(controller.signal)
      .then((result) => {
        // A fetch implementation may ignore AbortSignal and resolve late. A
        // detached/aborted flight never gets to mutate the credential cache.
        if (controller.signal.aborted || this.refresh !== refresh) {
          throw oauthCancellationError();
        }
        this.token = result.accessToken;
        this.expiresAt = result.expiresAt;
        return result.accessToken;
      })
      .finally(() => {
        refresh.settled = true;
        if (this.refresh === refresh) this.refresh = null;
      });
    return refresh;
  }

  private subscribeToRefresh(
    refresh: OAuthRefresh,
    signal: AbortSignal | undefined
  ): Promise<string> {
    if (signal?.aborted) return Promise.reject(oauthCancellationError());
    const operation = refresh.promise;
    if (!operation) {
      return Promise.reject(createToolError("internal", "do_not_retry"));
    }
    refresh.subscribers += 1;
    return new Promise<string>((resolve, reject) => {
      let released = false;
      const release = (cancelled: boolean): void => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", onAbort);
        refresh.subscribers = Math.max(0, refresh.subscribers - 1);
        if (cancelled && refresh.subscribers === 0 && !refresh.settled) {
          // Detach first so a new caller can start a healthy flight while the
          // abandoned fetch is unwinding. Cache fencing above handles a fetch
          // implementation that resolves despite the abort.
          if (this.refresh === refresh) this.refresh = null;
          refresh.controller.abort(oauthCancellationError());
        }
      };
      const onAbort = (): void => {
        release(true);
        reject(oauthCancellationError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void operation.then(
        (token) => {
          if (released) return;
          release(false);
          resolve(token);
        },
        (error: unknown) => {
          if (released) return;
          release(false);
          reject(error);
        }
      );
    });
  }

  private async fetchToken(refreshSignal: AbortSignal): Promise<OAuthToken> {
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

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const tokenSignal = AbortSignal.any([refreshSignal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
        signal: tokenSignal,
      });
    } catch {
      if (refreshSignal.aborted) throw oauthCancellationError();
      if (timeoutSignal.aborted) {
        throw createToolError("timeout", "retry_if_safe_and_idempotent");
      }
      throw createToolError("upstream", "retry_if_safe_and_idempotent");
    }

    if (!response.ok) {
      try {
        await consumeTokenFailure(response, tokenSignal);
      } catch (error) {
        if (refreshSignal.aborted) throw oauthCancellationError();
        if (timeoutSignal.aborted) {
          throw createToolError("timeout", "retry_if_safe_and_idempotent");
        }
        throw error;
      }
      throw oauthHttpError(response);
    }

    let json: Record<string, unknown>;
    try {
      const text = await readBoundedResponseText(
        response,
        MAX_TOKEN_RESPONSE_BYTES,
        tokenSignal
      );
      const candidate: unknown = JSON.parse(text);
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new TypeError("OAuth token response must be a JSON object");
      }
      json = candidate as Record<string, unknown>;
    } catch {
      if (refreshSignal.aborted) throw oauthCancellationError();
      if (timeoutSignal.aborted) {
        throw createToolError("timeout", "retry_if_safe_and_idempotent");
      }
      // Never echo the raw body -- it may contain token material.
      throw createToolError("upstream", "retry_if_safe_and_idempotent");
    }

    const accessToken = json.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw createToolError("upstream", "retry_if_safe_and_idempotent");
    }

    const expiresIn =
      typeof json.expires_in === "number"
        ? json.expires_in
        : parseInt(String(json.expires_in ?? ""), 10);
    const expiresInMs = (isNaN(expiresIn) ? 1800 : expiresIn) * 1000;

    return Object.freeze({
      accessToken,
      expiresAt: Date.now() + expiresInMs - TOKEN_EXPIRY_MARGIN_MS,
    });
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
        throw createToolError("authentication", "retry_after_correction");
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
        throw createToolError("authentication", "retry_after_correction");
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

async function consumeTokenFailure(
  response: Response,
  signal: AbortSignal
): Promise<void> {
  try {
    await readBoundedResponseText(response, MAX_TOKEN_RESPONSE_BYTES, signal);
  } catch {
    if (signal.aborted) throw oauthCancellationError();
    // A bounded/unreadable error body never changes the structural HTTP map.
  }
}

function oauthHttpError(response: Response): Error {
  const status = response.status;
  if (status === 408) {
    return createToolError("timeout", "retry_if_safe_and_idempotent");
  }
  if (status === 409) {
    return createToolError("conflict", "retry_after_correction");
  }
  if (status === 429) {
    return createToolError(
      "rate_limit",
      "retry_later",
      boundedRetryAfterSeconds(parseOAuthRetryAfterMs(response.headers.get("retry-after")))
    );
  }
  if (status >= 500) {
    return createToolError("upstream", "retry_if_safe_and_idempotent");
  }
  if (status >= 400) {
    // Token-endpoint rejections are intentionally indistinguishable from a
    // locally unavailable credential reference at the public boundary.
    return createToolError("authentication", "retry_after_correction");
  }
  return createToolError("upstream", "do_not_retry");
}

function parseOAuthRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function oauthCancellationError(): Error {
  const error = new Error("OAuth token request cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfOAuthCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw oauthCancellationError();
}

async function readBoundedResponseText(
  response: Response,
  maximum: number,
  signal: AbortSignal
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = parseDeclaredLength(declaredLength);
    if (parsedLength === undefined || parsedLength > maximum) {
      await cancelResponseBody(response, "OAuth response exceeds byte limit");
      throw new RangeError("OAuth response exceeds configured byte limit");
    }
  }
  throwIfOAuthCancelled(signal);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel("OAuth request cancelled").catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      throwIfOAuthCancelled(signal);
      const next = await reader.read();
      throwIfOAuthCancelled(signal);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maximum) {
        await reader.cancel("OAuth response exceeds byte limit");
        throw new RangeError("OAuth response exceeds configured byte limit");
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  throwIfOAuthCancelled(signal);
  return Buffer.concat(chunks, total).toString("utf8");
}

function parseDeclaredLength(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function cancelResponseBody(response: Response, reason: string): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // Cancellation is best effort after rejecting a hostile declaration.
  }
}
