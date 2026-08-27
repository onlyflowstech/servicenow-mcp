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

import { AsyncLocalStorage } from "node:async_hooks";

import { ServiceNowConfig } from "./config.js";
import { AuthProvider, createAuthProvider } from "./auth.js";
import {
  boundedRetryAfterSeconds,
  createToolError,
  type ToolErrorCategory,
  type ToolErrorRetry,
} from "./tool-error.js";

/** @deprecated Inspect trusted tool-error provenance instead of raw fields. */
export type ServiceNowError = Error;

type ParsedJson = Awaited<ReturnType<Response["json"]>>;

/** A parsed response body plus the HTTP status and headers it came with. */
export interface RequestResult<T = ParsedJson> {
  data: T | null;
  status: number;
  headers: Headers;
}

/**
 * Narrow ServiceNow operation capability exposed to tool modules.
 *
 * The facade deliberately omits client configuration, authentication,
 * retry internals, and the generic request primitive. Implementations are
 * closure-bound so a module cannot recover the underlying credential-bearing
 * client through `this`, own properties, or the prototype chain.
 */
export interface ServiceNowOperations {
  get<T = ParsedJson>(
    path: string,
    params?: Record<string, string>
  ): Promise<T | null>;
  getWithMeta<T = ParsedJson>(
    path: string,
    params?: Record<string, string>
  ): Promise<RequestResult<T>>;
  post<T = ParsedJson>(path: string, body?: unknown): Promise<T | null>;
  patch<T = ParsedJson>(path: string, body?: unknown): Promise<T | null>;
  delete(path: string): Promise<{ status: number }>;
  postBinary<T = ParsedJson>(
    path: string,
    data: Buffer,
    contentType: string,
    params?: Record<string, string>
  ): Promise<T>;
  getRaw(
    path: string,
    options?: { readonly maxBytes?: number }
  ): Promise<{ data: Buffer; contentType: string }>;
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
export const MAX_CUMULATIVE_UPSTREAM_JSON_BYTES = 1024 * 1024;
export const MAX_CUMULATIVE_RAW_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_JSON_RESPONSE_BYTES =
  MAX_CUMULATIVE_UPSTREAM_JSON_BYTES;
export const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

/** Guidance appended to 401 errors on basic-auth profiles. */
export const BASIC_AUTH_401_HINT =
  "ServiceNow may be enforcing Basic Auth restrictions on this instance " +
  "(see KB3096078). Exemptions: Web-Service-Access-Only account or " +
  "snc_basic_auth_api_access role. Recommended: switch this profile to " +
  "OAuth (authType: 'oauth').";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_RETRY_DELAY_MS = 500;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const MAX_CONFIGURED_CONCURRENT_REQUESTS = 32;
const RETRYABLE_STATUSES = [429, 502, 503, 504];
interface ServiceNowRequestScope {
  readonly signal: AbortSignal;
  readonly upstreamJsonBytes: CumulativeResponseByteBudget;
  readonly upstreamRawBytes: CumulativeResponseByteBudget;
}

const REQUEST_SCOPE = new AsyncLocalStorage<ServiceNowRequestScope>();

/**
 * Bind one immutable execution-context signal and fresh atomic upstream byte
 * budgets to cached clients without adding mutable state to the client/cache.
 */
export function runWithServiceNowRequestSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  if (!(signal instanceof AbortSignal)) {
    return Promise.reject(new TypeError("request signal must be an AbortSignal"));
  }
  if (typeof operation !== "function") {
    return Promise.reject(new TypeError("request operation must be a function"));
  }
  try {
    const scope: ServiceNowRequestScope = Object.freeze({
      signal,
      upstreamJsonBytes: new CumulativeResponseByteBudget(
        MAX_CUMULATIVE_UPSTREAM_JSON_BYTES
      ),
      upstreamRawBytes: new CumulativeResponseByteBudget(
        MAX_CUMULATIVE_RAW_RESPONSE_BYTES
      ),
    });
    return Promise.resolve(REQUEST_SCOPE.run(scope, operation));
  } catch (error) {
    return Promise.reject(error);
  }
}

export class ServiceNowClient {
  readonly #baseUrl: string;
  readonly #auth: AuthProvider;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #baseRetryDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #limiter: UpstreamConcurrencyLimiter;

  constructor(config: ServiceNowConfig, options: ClientOptions = {}) {
    this.#baseUrl = config.instance;
    this.#auth = options.auth ?? createAuthProvider(config);
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#limiter = limiterForOrigin(
      new URL(this.#baseUrl).origin,
      config.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
    );
  }

  // ── Core HTTP methods ──────────────────────────────────────────

  async get<T = ParsedJson>(
    path: string,
    params?: Record<string, string>
  ): Promise<T | null> {
    return (await this.requestWithMeta<T>("GET", path, { params })).data;
  }

  /** GET that also exposes the response status + headers (e.g. X-Total-Count). */
  async getWithMeta<T = ParsedJson>(
    path: string,
    params?: Record<string, string>
  ): Promise<RequestResult<T>> {
    return this.requestWithMeta<T>("GET", path, { params });
  }

  async post<T = ParsedJson>(path: string, body?: unknown): Promise<T | null> {
    return (await this.requestWithMeta<T>("POST", path, { body })).data;
  }

  async patch<T = ParsedJson>(path: string, body?: unknown): Promise<T | null> {
    return (await this.requestWithMeta<T>("PATCH", path, { body })).data;
  }

  async put<T = ParsedJson>(path: string, body?: unknown): Promise<T | null> {
    return (await this.requestWithMeta<T>("PUT", path, { body })).data;
  }

  async delete(path: string): Promise<{ status: number }> {
    const url = this.buildUrl(path);
    const response = await this.fetchWithPolicy("DELETE", url, {
      Accept: "application/json",
    });

    if (!response.ok && response.status !== 204) {
      await this.consumeErrorBody(response);
      throw this.buildHttpError(
        "DELETE",
        response.status,
        response.headers
      );
    }

    drainBody(response);
    return { status: response.status };
  }

  /**
   * POST binary data (for attachment uploads).
   */
  async postBinary<T = ParsedJson>(
    path: string,
    data: Buffer,
    contentType: string,
    params?: Record<string, string>
  ): Promise<T> {
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
      await this.consumeErrorBody(response);
      throw this.buildHttpError(
        "POST",
        response.status,
        response.headers
      );
    }

    return readJsonResponse<T>(response, currentRequestSignal());
  }

  /**
   * GET raw response (for attachment downloads).
   */
  async getRaw(
    path: string,
    options: { readonly maxBytes?: number } = {}
  ): Promise<{ data: Buffer; contentType: string }> {
    const url = this.buildUrl(path);
    const response = await this.fetchWithPolicy("GET", url, {});

    if (!response.ok) {
      drainBody(response);
      throw this.buildHttpError(
        "GET",
        response.status,
        response.headers
      );
    }

    const maximum = validateRawResponseLimit(
      options.maxBytes ?? MAX_CUMULATIVE_RAW_RESPONSE_BYTES
    );
    const buffer = await readBoundedResponseBody(
      response,
      maximum,
      currentRequestSignal(),
      currentRawByteBudget()
    );
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    return { data: buffer, contentType };
  }

  /**
   * Perform a JSON request and return the parsed body together with the
   * response status and headers. The convenience methods above delegate here.
   */
  async requestWithMeta<T = ParsedJson>(
    method: HttpMethod,
    path: string,
    options: { params?: Record<string, string>; body?: unknown } = {}
  ): Promise<RequestResult<T>> {
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
      await this.consumeErrorBody(response);
      throw this.buildHttpError(
        method,
        response.status,
        response.headers
      );
    }

    // 204 No Content
    if (response.status === 204) {
      return { data: null, status: response.status, headers: response.headers };
    }

    return {
      data: await readJsonResponse<T>(response, currentRequestSignal()),
      status: response.status,
      headers: response.headers,
    };
  }

  // ── Internal helpers ───────────────────────────────────────────

  private buildUrl(path: string, params?: Record<string, string>): string {
    validateServiceNowApiPath(path);
    const url = new URL(path, this.#baseUrl);
    const configuredOrigin = new URL(this.#baseUrl).origin;
    if (url.origin !== configuredOrigin) {
      throw new TypeError("ServiceNow API path must remain on the configured origin");
    }
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
      const requestSignal = currentRequestSignal();
      throwIfRequestCancelled(requestSignal);
      const authHeaders = await waitForRequestCancellation(
        this.#auth.getAuthHeaders(requestSignal),
        requestSignal
      );

      let response: Response;
      const attemptTimeout = AbortSignal.timeout(this.#timeoutMs);
      const attemptSignal = requestSignal
        ? AbortSignal.any([requestSignal, attemptTimeout])
        : attemptTimeout;
      try {
        response = await this.#limiter.run(() =>
          fetch(url, {
            method,
            headers: { ...authHeaders, ...headers },
            body,
            signal: attemptSignal,
          })
        );
      } catch {
        if (requestSignal?.aborted) throw requestCancellationError();
        if (attemptTimeout.aborted) {
          throw requestPolicyError("timeout", method);
        }
        // Transient network error (DNS, reset, refused...). Never retry a
        // POST -- the request may have reached the server before failing.
        if (method !== "POST" && attempt < this.#maxRetries) {
          attempt++;
          throwIfRequestCancelled(requestSignal);
          await waitForRequestCancellation(
            this.#sleep(retryDelayMs(null, attempt, this.#baseRetryDelayMs)),
            requestSignal
          );
          continue;
        }
        throw requestPolicyError("upstream", method);
      }

      // 401: give the auth provider one chance to refresh and retry.
      if (response.status === 401 && !authRetried) {
        throwIfRequestCancelled(requestSignal);
        const shouldRetry = await waitForRequestCancellation(
          this.#auth.onAuthFailure(requestSignal),
          requestSignal
        );
        if (shouldRetry) {
          authRetried = true;
          drainBody(response);
          continue;
        }
      }

      if (
        isRetryableStatus(response.status, method) &&
        attempt < this.#maxRetries
      ) {
        attempt++;
        const delay = retryDelayMs(
          response.headers.get("retry-after"),
          attempt,
          this.#baseRetryDelayMs
        );
        drainBody(response);
        throwIfRequestCancelled(requestSignal);
        await waitForRequestCancellation(this.#sleep(delay), requestSignal);
        continue;
      }

      return response;
    }
  }

  private async consumeErrorBody(response: Response): Promise<void> {
    try {
      await readBoundedResponseText(
        response,
        MAX_ERROR_RESPONSE_BYTES,
        currentRequestSignal(),
        currentUpstreamByteBudget()
      );
    } catch (error) {
      if (error instanceof ServiceNowRequestCancelledError) throw error;
      // A bounded/unreadable body never changes the structural HTTP map.
    }
  }

  private buildHttpError(
    method: HttpMethod,
    status: number,
    headers: Headers
  ): ServiceNowError {
    const classification = classifyHttpFailure(status, method);
    const retryAfterSeconds =
      classification.retry === "retry_later"
        ? boundedRetryAfterSeconds(
            parseRetryAfterMs(headers.get("retry-after"))
          )
        : undefined;
    return createToolError(
      classification.category,
      classification.retry,
      retryAfterSeconds
    );
  }

}

/** Build an immutable, reflection-safe capability around a resolved client. */
export function createServiceNowOperations(
  client: ServiceNowOperations
): ServiceNowOperations {
  const operations = Object.create(null) as ServiceNowOperations;
  Object.defineProperties(operations, {
    get: {
      value: <T = ParsedJson>(path: string, params?: Record<string, string>) =>
        client.get<T>(path, params),
    },
    getWithMeta: {
      value: <T = ParsedJson>(path: string, params?: Record<string, string>) =>
        client.getWithMeta<T>(path, params),
    },
    post: {
      value: <T = ParsedJson>(path: string, body?: unknown) =>
        client.post<T>(path, body),
    },
    patch: {
      value: <T = ParsedJson>(path: string, body?: unknown) =>
        client.patch<T>(path, body),
    },
    delete: {
      value: (path: string) => client.delete(path),
    },
    postBinary: {
      value: <T = ParsedJson>(
        path: string,
        data: Buffer,
        contentType: string,
        params?: Record<string, string>
      ) => client.postBinary<T>(path, data, contentType, params),
    },
    getRaw: {
      value: (
        path: string,
        options?: { readonly maxBytes?: number }
      ) => client.getRaw(path, options),
    },
  });
  return Object.freeze(operations);
}


class UpstreamConcurrencyLimiter {
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.#active -= 1;
    const next = this.#queue.shift();
    if (next) next();
  }
}

const UPSTREAM_LIMITERS = new Map<string, UpstreamConcurrencyLimiter>();

function limiterForOrigin(origin: string, configuredLimit: number): UpstreamConcurrencyLimiter {
  if (
    !Number.isSafeInteger(configuredLimit) ||
    configuredLimit < 1 ||
    configuredLimit > MAX_CONFIGURED_CONCURRENT_REQUESTS
  ) {
    throw new TypeError(
      `maxConcurrentRequests must be between 1 and ${MAX_CONFIGURED_CONCURRENT_REQUESTS}`
    );
  }
  const cached = UPSTREAM_LIMITERS.get(origin);
  if (cached?.limit === configuredLimit) return cached;
  const limiter = new UpstreamConcurrencyLimiter(configuredLimit);
  UPSTREAM_LIMITERS.set(origin, limiter);
  return limiter;
}

function validateRawResponseLimit(candidate: unknown): number {
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > MAX_CUMULATIVE_RAW_RESPONSE_BYTES
  ) {
    throw new TypeError("raw response maxBytes is invalid");
  }
  return candidate;
}

async function readBoundedResponseBody(
  response: Response,
  maximum: number,
  signal: AbortSignal | undefined,
  cumulativeBudget?: CumulativeResponseByteBudget
): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  let reserved = 0;
  let total = 0;
  if (declaredLength !== null) {
    const parsedLength = parseDeclaredContentLength(declaredLength);
    if (parsedLength === undefined || parsedLength > maximum) {
      try {
        await response.body?.cancel("response exceeds configured byte limit");
      } catch {
        // Cancellation is best effort after the response is rejected.
      }
      throw new RangeError("raw response exceeds configured byte limit");
    }
    if (cumulativeBudget) {
      try {
        cumulativeBudget.reserve(parsedLength);
        reserved = parsedLength;
      } catch (error) {
        try {
          await response.body?.cancel("cumulative upstream byte limit exceeded");
        } catch {
          // Cancellation is best effort after the response is rejected.
        }
        throw error;
      }
    }
  }

  if (!response.body) {
    if (cumulativeBudget && reserved > 0) cumulativeBudget.release(reserved);
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      throwIfRequestCancelled(signal);
      const next = await waitForRequestCancellation(reader.read(), signal, () => {
        void reader.cancel("request cancelled").catch(() => {});
      });
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maximum) {
        await reader.cancel("response exceeds configured byte limit");
        throw new RangeError("raw response exceeds configured byte limit");
      }
      if (cumulativeBudget && total > reserved) {
        try {
          cumulativeBudget.reserve(total - reserved);
          reserved = total;
        } catch (error) {
          await reader.cancel("cumulative upstream byte limit exceeded");
          throw error;
        }
      }
      chunks.push(chunk);
    }
  } finally {
    if (cumulativeBudget && reserved > total) {
      cumulativeBudget.release(reserved - total);
    }
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

class ServiceNowRequestCancelledError extends Error {
  constructor() {
    super("ServiceNow request cancelled");
    this.name = "ServiceNowRequestCancelledError";
  }
}

function currentRequestSignal(): AbortSignal | undefined {
  return REQUEST_SCOPE.getStore()?.signal;
}

function currentUpstreamByteBudget(): CumulativeResponseByteBudget | undefined {
  return REQUEST_SCOPE.getStore()?.upstreamJsonBytes;
}

function currentRawByteBudget(): CumulativeResponseByteBudget | undefined {
  return REQUEST_SCOPE.getStore()?.upstreamRawBytes;
}

function requestCancellationError(): ServiceNowRequestCancelledError {
  return new ServiceNowRequestCancelledError();
}

function throwIfRequestCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw requestCancellationError();
}

function waitForRequestCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(requestCancellationError());
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      onAbort?.();
      reject(requestCancellationError());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      }
    );
  });
}

function readJsonResponse<T>(
  response: Response,
  signal: AbortSignal | undefined
): Promise<T> {
  return readBoundedResponseText(
    response,
    DEFAULT_MAX_JSON_RESPONSE_BYTES,
    signal,
    currentUpstreamByteBudget()
  ).then((text) => JSON.parse(text) as T);
}

async function readBoundedResponseText(
  response: Response,
  maximum: number,
  signal: AbortSignal | undefined,
  cumulativeBudget?: CumulativeResponseByteBudget
): Promise<string> {
  const body = await readBoundedResponseBody(
    response,
    maximum,
    signal,
    cumulativeBudget
  );
  throwIfRequestCancelled(signal);
  return body.toString("utf8");
}

class CumulativeResponseByteBudget {
  #consumed = 0;

  constructor(private readonly maximum: number) {}

  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError("upstream byte reservation is invalid");
    }
    if (this.#consumed + bytes > this.maximum) {
      throw new RangeError("cumulative upstream response exceeds configured byte limit");
    }
    this.#consumed += bytes;
  }

  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#consumed) {
      throw new TypeError("upstream byte release is invalid");
    }
    this.#consumed -= bytes;
  }
}

function parseDeclaredContentLength(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateServiceNowApiPath(candidate: unknown): asserts candidate is string {
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    candidate.includes("?") ||
    candidate.includes("#")
  ) {
    throw new TypeError("ServiceNow API path must be an absolute path only");
  }
  const segments = candidate.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0)) {
    throw new TypeError("ServiceNow API path contains an empty segment");
  }
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new TypeError("ServiceNow API path contains invalid encoding");
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      /[\u0000-\u001F\u007F]/u.test(decoded)
    ) {
      throw new TypeError("ServiceNow API path contains an unsafe segment");
    }
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

interface HttpFailureClassification {
  readonly category: ToolErrorCategory;
  readonly retry: ToolErrorRetry;
}

/** Map only trusted response status and request method into the public contract. */
function classifyHttpFailure(
  status: number,
  method: HttpMethod
): HttpFailureClassification {
  switch (status) {
    case 401:
      return { category: "authentication", retry: "retry_after_correction" };
    case 403:
      return { category: "authorization", retry: "retry_after_correction" };
    case 404:
      return { category: "not_found", retry: "do_not_retry" };
    case 408:
      return requestPolicyClassification("timeout", method);
    case 409:
      return { category: "conflict", retry: "retry_after_correction" };
    case 429:
      return { category: "rate_limit", retry: "retry_later" };
    default:
      // Other 4xx/3xx statuses are upstream rejections, but repeating the
      // exact request is unsafe. 5xx failures may be retried only when the
      // request method does not have ambiguous POST side effects.
      return status >= 500
        ? requestPolicyClassification("upstream", method)
        : { category: "upstream", retry: "do_not_retry" };
  }
}

function requestPolicyError(
  category: "timeout" | "upstream",
  method: HttpMethod
): Error {
  const classification = requestPolicyClassification(category, method);
  return createToolError(classification.category, classification.retry);
}

function requestPolicyClassification(
  category: "timeout" | "upstream",
  method: HttpMethod
): HttpFailureClassification {
  return {
    category,
    retry:
      method === "POST"
        ? "do_not_retry"
        : "retry_if_safe_and_idempotent",
  };
}

/** Release an unread response body so retried connections don't leak. */
function drainBody(response: Response): void {
  try {
    void response.body?.cancel();
  } catch {
    // ignore -- best-effort cleanup
  }
}
