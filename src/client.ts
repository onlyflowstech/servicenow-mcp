/**
 * ServiceNow HTTP client — native fetch-based, zero external dependencies.
 *
 * Every request is bounded by an AbortSignal timeout and retried with
 * exponential backoff + jitter on rate-limit / transient failures:
 *   - GET/PATCH/PUT/DELETE retry on 429, 502, 503, 504 and transient
 *     network errors (max 2 retries).
 *   - POST retries ONLY on 429 — a 429 is rejected before processing, so
 *     a retry is safe; a 5xx POST may have executed side effects.
 *   - Retry-After headers (delta-seconds and HTTP-date) are honored,
 *     capped at MAX_RETRY_DELAY_MS per wait.
 *   - A 401 triggers at most one AuthProvider refresh + retry.
 *
 * @module client
 */

import { ServiceNowConfig } from "./config.js";
import { AuthProvider, createAuthProvider } from "./auth.js";

export interface ServiceNowError {
  message: string;
  detail?: string;
  status?: number;
}

/** A parsed response body plus the HTTP status and headers it came with. */
export interface RequestResult {
  data: any;
  status: number;
  headers: Headers;
}

export interface ClientOptions {
  /** Auth provider override (defaults to one derived from the config). */
  auth?: AuthProvider;
  /** Max retries after the initial attempt (default 2). */
  maxRetries?: number;
  /** Base backoff delay in ms (default 500). */
  baseRetryDelayMs?: number;
  /** Sleep implementation override (for tests). */
  sleep?: (ms: number) => Promise<void>;
}

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUSES = [429, 502, 503, 504];

export class ServiceNowClient {
  private baseUrl: string;
  private auth: AuthProvider;
  private timeoutMs: number;
  private maxRetries: number;
  private baseRetryDelayMs: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private config: ServiceNowConfig, options: ClientOptions = {}) {
    this.baseUrl = config.instance;
    this.auth = options.auth ?? createAuthProvider(config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── Core HTTP methods ──────────────────────────────────────────

  async get(path: string, params?: Record<string, string>): Promise<any> {
    return (await this.requestWithMeta("GET", path, { params })).data;
  }

  /** GET that also exposes the response status + headers (e.g. X-Total-Count). */
  async getWithMeta(
    path: string,
    params?: Record<string, string>
  ): Promise<RequestResult> {
    return this.requestWithMeta("GET", path, { params });
  }

  async post(path: string, body?: unknown): Promise<any> {
    return (await this.requestWithMeta("POST", path, { body })).data;
  }

  async patch(path: string, body?: unknown): Promise<any> {
    return (await this.requestWithMeta("PATCH", path, { body })).data;
  }

  async put(path: string, body?: unknown): Promise<any> {
    return (await this.requestWithMeta("PUT", path, { body })).data;
  }

  async delete(path: string): Promise<{ status: number }> {
    const url = this.buildUrl(path);
    const response = await this.fetchWithPolicy("DELETE", url, {
      Accept: "application/json",
    });

    if (!response.ok && response.status !== 204) {
      const errorBody = await this.parseErrorBody(response);
      throw this.buildHttpError(
        response.status,
        errorBody?.message || `Delete failed with HTTP ${response.status}`,
        errorBody?.detail
      );
    }

    return { status: response.status };
  }

  /**
   * POST binary data (for attachment uploads).
   */
  async postBinary(
    path: string,
    data: Buffer,
    contentType: string,
    params?: Record<string, string>
  ): Promise<any> {
    const url = this.buildUrl(path, params);
    const response = await this.fetchWithPolicy(
      "POST",
      url,
      {
        Accept: "application/json",
        "Content-Type": contentType,
      },
      new Uint8Array(data)
    );

    if (!response.ok) {
      const errorBody = await this.parseErrorBody(response);
      throw this.buildHttpError(
        response.status,
        errorBody?.message || `Request failed with HTTP ${response.status}`,
        errorBody?.detail
      );
    }

    return response.json();
  }

  /**
   * GET raw response (for attachment downloads).
   */
  async getRaw(path: string): Promise<{ data: Buffer; contentType: string }> {
    const url = this.buildUrl(path);
    const response = await this.fetchWithPolicy("GET", url, {});

    if (!response.ok) {
      throw this.buildHttpError(
        response.status,
        `Download failed with HTTP ${response.status}`
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    return { data: buffer, contentType };
  }

  /**
   * Perform a JSON request and return the parsed body together with the
   * response status and headers. The convenience methods above delegate here.
   */
  async requestWithMeta(
    method: HttpMethod,
    path: string,
    options: { params?: Record<string, string>; body?: unknown } = {}
  ): Promise<RequestResult> {
    const url = this.buildUrl(path, options.params);
    const response = await this.fetchWithPolicy(
      method,
      url,
      {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      options.body !== undefined ? JSON.stringify(options.body) : undefined
    );

    if (!response.ok) {
      const errorBody = await this.parseErrorBody(response);
      throw this.buildHttpError(
        response.status,
        errorBody?.message || `Request failed with HTTP ${response.status}`,
        errorBody?.detail
      );
    }

    // 204 No Content
    if (response.status === 204) {
      return { data: null, status: response.status, headers: response.headers };
    }

    return {
      data: await response.json(),
      status: response.status,
      headers: response.headers,
    };
  }

  // ── Internal helpers ───────────────────────────────────────────

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  /**
   * fetch() with the full request policy applied: auth headers, timeout,
   * bounded retries with backoff, Retry-After, and a single 401
   * refresh-and-retry via the AuthProvider.
   */
  private async fetchWithPolicy(
    method: HttpMethod,
    url: string,
    headers: Record<string, string>,
    body?: BodyInit
  ): Promise<Response> {
    let attempt = 0;
    let authRetried = false;

    for (;;) {
      const authHeaders = await this.auth.getAuthHeaders();

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: { ...authHeaders, ...headers },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // The only abort source is our own timeout signal.
        if (isAbortError(error)) {
          throw this.createError(
            `request timed out after ${this.timeoutMs}ms`,
            `${method} ${url}`
          );
        }
        // Transient network error (DNS, reset, refused...). Never retry a
        // POST -- the request may have reached the server before failing.
        if (method !== "POST" && attempt < this.maxRetries) {
          attempt++;
          await this.sleep(retryDelayMs(null, attempt, this.baseRetryDelayMs));
          continue;
        }
        throw this.createError(
          `network error: ${describeNetworkError(error)}`,
          `${method} ${url}`
        );
      }

      // 401: give the auth provider one chance to refresh and retry.
      if (response.status === 401 && !authRetried) {
        const shouldRetry = await this.auth.onAuthFailure();
        if (shouldRetry) {
          authRetried = true;
          drainBody(response);
          continue;
        }
      }

      if (
        isRetryableStatus(response.status, method) &&
        attempt < this.maxRetries
      ) {
        attempt++;
        const delay = retryDelayMs(
          response.headers.get("retry-after"),
          attempt,
          this.baseRetryDelayMs
        );
        drainBody(response);
        await this.sleep(delay);
        continue;
      }

      return response;
    }
  }

  private async parseErrorBody(
    response: Response
  ): Promise<{ message?: string; detail?: string } | null> {
    try {
      const text = await response.text();
      const json = JSON.parse(text);
      // ServiceNow error format
      if (json.error) {
        return {
          message: json.error.message || json.error,
          detail: json.error.detail,
        };
      }
      return { message: text };
    } catch {
      return null;
    }
  }

  private buildHttpError(
    status: number,
    message: string,
    detail?: string
  ): ServiceNowError {
    return this.createError(message, detail, status);
  }

  private createError(
    message: string,
    detail?: string,
    status?: number
  ): ServiceNowError {
    return { message, detail, status };
  }
}

// ── Retry helpers (exported for tests) ─────────────────────────────

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both delta-seconds ("120") and HTTP-date forms.
 * Returns undefined when the value is absent or unparseable.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/**
 * Delay before retry `attempt` (1-based): the Retry-After header when
 * present, otherwise exponential backoff with jitter. Capped at
 * MAX_RETRY_DELAY_MS either way.
 */
export function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  baseDelayMs: number
): number {
  const fromHeader = parseRetryAfterMs(retryAfter);
  if (fromHeader !== undefined) {
    return Math.min(fromHeader, MAX_RETRY_DELAY_MS);
  }
  const backoff = baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs;
  return Math.min(backoff, MAX_RETRY_DELAY_MS);
}

// ── Module-level helpers ───────────────────────────────────────────

function isRetryableStatus(status: number, method: HttpMethod): boolean {
  if (status === 429) return true;
  // A 5xx POST may have executed side effects on the instance -- never retry.
  if (method === "POST") return false;
  return RETRYABLE_STATUSES.includes(status);
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: string }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}

/** Release an unread response body so retried connections don't leak. */
function drainBody(response: Response): void {
  try {
    void response.body?.cancel();
  } catch {
    // ignore -- best-effort cleanup
  }
}
