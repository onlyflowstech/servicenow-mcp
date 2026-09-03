/**
 * Platform-neutral HTTP authentication boundary for the private, single-owner
 * V2 service.
 *
 * Authentication happens before MCP parsing, profile lookup, tool dispatch, or
 * ServiceNow credential access. This module deliberately does not implement a
 * user directory, authorization policy, tenant isolation, or an OAuth server.
 *
 * Authentication is optional and off by default: the composition root selects
 * {@link StaticBearerAuthenticationProvider} when `MCP_BEARER_TOKEN` is set and
 * {@link UnauthenticatedIdentityProvider} when it is not. Every provider here
 * returns a validated identity, so the rest of the request path cannot tell
 * which one is installed.
 *
 * @module http-auth
 */

import { createHash, timingSafeEqual } from "node:crypto";

import {
  immutableRequestMetadata,
  type OwnerClientIdentity,
  type RequestMetadataProvider,
  type ToolInvocationMetadata,
} from "./execution-context.js";

const MIN_STATIC_TOKEN_LENGTH = 32;
const MAX_STATIC_TOKEN_LENGTH = 4096;
const MAX_STATIC_CREDENTIALS = 128;
const BEARER_TOKEN = /^[A-Za-z0-9._~+\/-]+={0,2}$/u;
const ISSUED_AUTHENTICATION_ERRORS = new WeakSet<object>();

/** Raw Authorization values, preserved separately so duplicates fail closed. */
export interface HttpAuthenticationRequest {
  readonly authorizationHeaders: readonly string[];
}

/** Authentication result safe to attach to an SNSDK-19 request context. */
export type AuthenticatedOwnerClientIdentity = OwnerClientIdentity;

/** Injectable boundary used by HTTP runtimes before constructing an MCP server. */
export interface HttpAuthenticationProvider<in TRequest = HttpAuthenticationRequest> {
  authenticate(
    request: TRequest,
    signal?: AbortSignal
  ):
    | AuthenticatedOwnerClientIdentity
    | Promise<AuthenticatedOwnerClientIdentity>;
}

export type HttpAuthenticationFailureCode = "unauthorized" | "forbidden";

/**
 * The only authentication failures that may affect the HTTP status. Messages
 * remain intentionally generic and never include credentials or adapter data.
 */
export class HttpAuthenticationError extends Error {
  readonly code: HttpAuthenticationFailureCode;
  readonly status: 401 | 403;

  constructor(code: HttpAuthenticationFailureCode) {
    super("HTTP authentication failed");
    this.name = "HttpAuthenticationError";
    this.code = code;
    this.status = code === "forbidden" ? 403 : 401;
    ISSUED_AUTHENTICATION_ERRORS.add(this);
    Object.freeze(this);
  }
}

export interface SafeHttpAuthenticationFailure {
  readonly status: 401 | 403;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Narrow an unknown failure without inspecting arbitrary error properties. */
export function isHttpAuthenticationError(
  error: unknown
): error is HttpAuthenticationError {
  try {
    return (
      error instanceof HttpAuthenticationError &&
      Object.isFrozen(error) &&
      ISSUED_AUTHENTICATION_ERRORS.has(error)
    );
  } catch {
    return false;
  }
}

const UNAUTHORIZED_FAILURE: SafeHttpAuthenticationFailure = Object.freeze({
  status: 401,
  headers: Object.freeze({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": "Bearer",
  }),
  body: '{"error":"unauthorized"}\n',
});

const FORBIDDEN_FAILURE: SafeHttpAuthenticationFailure = Object.freeze({
  status: 403,
  headers: Object.freeze({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  }),
  body: '{"error":"forbidden"}\n',
});

/** Map all unexpected provider failures to the same safe fail-closed response. */
export function safeHttpAuthenticationFailure(
  error: unknown
): SafeHttpAuthenticationFailure {
  return isHttpAuthenticationError(error) && error.code === "forbidden"
    ? FORBIDDEN_FAILURE
    : UNAUTHORIZED_FAILURE;
}

/** Status-only counterpart for runtimes that construct their own response. */
export function httpAuthenticationStatus(error: unknown): 401 | 403 {
  return safeHttpAuthenticationFailure(error).status;
}

/**
 * Preserve every Authorization field from Node's alternating rawHeaders list.
 * Using `IncomingMessage.headers.authorization` alone can hide duplicates on
 * runtimes that join or discard repeated singleton headers.
 */
export function httpAuthenticationRequestFromRawHeaders(
  rawHeaders: readonly string[]
): HttpAuthenticationRequest {
  try {
    if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
      throw new TypeError("raw headers must contain name/value pairs");
    }
    const values: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index];
      const value = rawHeaders[index + 1];
      if (typeof name !== "string" || typeof value !== "string") {
        throw new TypeError("raw header entries must be strings");
      }
      if (name.toLowerCase() === "authorization") values.push(value);
    }
    return Object.freeze({ authorizationHeaders: Object.freeze(values) });
  } catch {
    throw new HttpAuthenticationError("unauthorized");
  }
}

/**
 * Run an injected provider and validate/freeze its identity. Provider bugs and
 * hostile return objects fail closed without crossing the HTTP boundary.
 */
export async function authenticateHttpRequest<TRequest>(
  provider: HttpAuthenticationProvider<TRequest>,
  request: TRequest,
  signal?: AbortSignal
): Promise<AuthenticatedOwnerClientIdentity> {
  try {
    const identity = await waitForAuthentication(
      Promise.resolve(provider.authenticate(request, signal)),
      signal
    );
    return immutableIdentity(identity);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (isHttpAuthenticationError(error)) throw error;
    throw new HttpAuthenticationError("unauthorized");
  }
}

export interface StaticBearerCredential {
  /** Secret bearer value. It is hashed during construction and never retained. */
  readonly token: string;
  readonly ownerId: string;
  readonly clientId: string;
}

interface StaticBearerEntry {
  readonly digest: Buffer;
  readonly identity: AuthenticatedOwnerClientIdentity;
}

/**
 * Fixed-token provider for explicitly approved direct or test clients.
 *
 * Every configured client must belong to the same owner. Candidate and stored
 * tokens are SHA-256 digests before timing-safe comparison, avoiding
 * secret-length-dependent comparisons. Every entry is compared before a result
 * is returned, so the matching entry's position is not exposed by early exit.
 */
export class StaticBearerAuthenticationProvider
  implements HttpAuthenticationProvider<HttpAuthenticationRequest>
{
  readonly #entries: readonly StaticBearerEntry[];

  constructor(credentials: readonly StaticBearerCredential[]) {
    if (
      !Array.isArray(credentials) ||
      credentials.length === 0 ||
      credentials.length > MAX_STATIC_CREDENTIALS
    ) {
      throw new TypeError(
        `one to ${MAX_STATIC_CREDENTIALS} static bearer credentials are required`
      );
    }

    const entries: StaticBearerEntry[] = [];
    const tokenDigests = new Set<string>();
    const clientIds = new Set<string>();
    let ownerId: string | undefined;

    for (const candidate of credentials) {
      if (typeof candidate !== "object" || candidate === null) {
        throw new TypeError("static bearer credential must be an object");
      }
      // Snapshot every externally supplied property once. In particular, do
      // not retain the candidate object or plaintext token after construction.
      const token = candidate.token;
      const identity = immutableIdentity({
        ownerId: candidate.ownerId,
        clientId: candidate.clientId,
      });
      validateConfiguredToken(token);

      if (ownerId === undefined) ownerId = identity.ownerId;
      if (ownerId !== identity.ownerId) {
        throw new TypeError("static bearer credentials must have one owner");
      }
      if (clientIds.has(identity.clientId)) {
        throw new TypeError("static bearer clientId values must be unique");
      }

      const digest = digestToken(token);
      const digestKey = digest.toString("base64");
      if (tokenDigests.has(digestKey)) {
        throw new TypeError("static bearer tokens must be unique");
      }
      clientIds.add(identity.clientId);
      tokenDigests.add(digestKey);
      entries.push(Object.freeze({ digest, identity }));
    }

    this.#entries = Object.freeze(entries);
    Object.freeze(this);
  }

  authenticate(
    request: HttpAuthenticationRequest
  ): AuthenticatedOwnerClientIdentity {
    let token: string;
    try {
      token = parseSingleBearerToken(request);
    } catch {
      throw new HttpAuthenticationError("unauthorized");
    }

    const candidateDigest = digestToken(token);
    let selected: AuthenticatedOwnerClientIdentity | undefined;
    for (const entry of this.#entries) {
      if (timingSafeEqual(candidateDigest, entry.digest)) {
        selected = entry.identity;
      }
    }
    if (!selected) throw new HttpAuthenticationError("unauthorized");
    return selected;
  }
}

/**
 * Identity-only provider for an installation configured without HTTP
 * authentication. Every request is admitted.
 *
 * This is not a weaker authentication scheme; it is none. It exists so that a
 * local single-owner install can run without provisioning a secret, and it is
 * selected by the composition root only when no bearer is configured.
 *
 * What it preserves: the boundary still yields exactly one validated, frozen
 * `OwnerClientIdentity` per request, so audit records, identity rate limiting,
 * and the SNSDK-19 request-metadata contract behave exactly as they do under a
 * bearer. The Authorization header is not read at all, so a caller cannot
 * nominate an identity by sending one, and neither can any other request field.
 *
 * What it gives up: the identity attributes a request to the configured owner
 * without proving it came from them. Any process that can reach the listening
 * socket is admitted under it, which leaves the `Host`/`Origin` allowlists,
 * loopback binding, rate limiting, and the profile table policy as the whole of
 * the remaining boundary.
 */
export class UnauthenticatedIdentityProvider
  implements HttpAuthenticationProvider<HttpAuthenticationRequest>
{
  readonly #identity: AuthenticatedOwnerClientIdentity;

  constructor(identity: OwnerClientIdentity) {
    // Validated and frozen once, at construction: a malformed configured
    // identity is a startup failure, never a per-request surprise that would
    // reach the audit sink through the fallback sentinel.
    this.#identity = immutableIdentity(identity);
    Object.freeze(this);
  }

  authenticate(): AuthenticatedOwnerClientIdentity {
    return this.#identity;
  }
}

/**
 * Adapter contract for deployments whose approved private boundary authenticates
 * requests upstream. Implementations must derive identity from trusted runtime
 * state, not owner/client headers supplied by the remote caller.
 */
export interface PrivateBoundaryAuthenticationAdapter<in TRequest> {
  authenticate(
    request: TRequest,
    signal?: AbortSignal
  ):
    | AuthenticatedOwnerClientIdentity
    | Promise<AuthenticatedOwnerClientIdentity>;
}

/** Fail-closed wrapper for an optional deployment-specific private boundary. */
export class PrivateBoundaryAuthenticationProvider<TRequest>
  implements HttpAuthenticationProvider<TRequest>
{
  readonly #authenticate: PrivateBoundaryAuthenticationAdapter<TRequest>["authenticate"];

  constructor(adapter: PrivateBoundaryAuthenticationAdapter<TRequest>) {
    const authenticate = adapter?.authenticate;
    if (typeof authenticate !== "function") {
      throw new TypeError("private-boundary adapter must implement authenticate");
    }
    this.#authenticate = authenticate.bind(adapter);
    Object.freeze(this);
  }

  async authenticate(
    request: TRequest,
    signal?: AbortSignal
  ): Promise<AuthenticatedOwnerClientIdentity> {
    try {
      return immutableIdentity(await this.#authenticate(request, signal));
    } catch (error) {
      if (isHttpAuthenticationError(error)) throw error;
      throw new HttpAuthenticationError("unauthorized");
    }
  }
}

function waitForAuthentication<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Bind already-authenticated request identity/correlation metadata into the
 * SNSDK-19 tool context. Invocation hints (including authenticatedClientId)
 * are intentionally ignored, preventing an MCP payload from replacing the
 * identity established by the HTTP boundary.
 */
export function createAuthenticatedRequestMetadataProvider(
  identity: AuthenticatedOwnerClientIdentity,
  correlationIdFactory: (
    invocation: ToolInvocationMetadata
  ) => string = correlationIdFromMcpRequest
): RequestMetadataProvider {
  const boundIdentity = immutableIdentity(identity);
  if (typeof correlationIdFactory !== "function") {
    throw new TypeError("correlation ID factory must be a function");
  }
  return Object.freeze({
    resolve: (invocation: ToolInvocationMetadata) =>
      immutableRequestMetadata({
        correlationId: correlationIdFactory(invocation),
        identity: boundIdentity,
      }),
  });
}

/**
 * Bounded opaque correlation derived from the JSON-RPC request ID. Hashing
 * prevents caller-controlled IDs from injecting log text or exceeding the
 * execution-context identifier limit.
 */
export function correlationIdFromMcpRequest(
  invocation: ToolInvocationMetadata
): string {
  const requestId = invocation.requestId;
  const kind = typeof requestId;
  if (kind !== "string" && kind !== "number") {
    throw new TypeError("MCP request ID must be a string or number");
  }
  return `mcp-${createHash("sha256")
    .update(`${kind}:`, "utf8")
    .update(String(requestId), "utf8")
    .digest("hex")}`;
}

function immutableIdentity(
  candidate: OwnerClientIdentity
): AuthenticatedOwnerClientIdentity {
  return immutableRequestMetadata({
    correlationId: "http-auth-identity-validation",
    identity: candidate,
  }).identity;
}

function validateConfiguredToken(token: unknown): asserts token is string {
  if (
    typeof token !== "string" ||
    token.length < MIN_STATIC_TOKEN_LENGTH ||
    token.length > MAX_STATIC_TOKEN_LENGTH ||
    !BEARER_TOKEN.test(token)
  ) {
    throw new TypeError(
      `static bearer token must be ${MIN_STATIC_TOKEN_LENGTH}-${MAX_STATIC_TOKEN_LENGTH} visible bearer characters`
    );
  }
}

function parseSingleBearerToken(request: HttpAuthenticationRequest): string {
  if (typeof request !== "object" || request === null) {
    throw new TypeError("authentication request must be an object");
  }
  const values = request.authorizationHeaders;
  if (!Array.isArray(values) || values.length !== 1) {
    throw new TypeError("exactly one Authorization header is required");
  }
  const header = values[0];
  if (typeof header !== "string" || header.length > MAX_STATIC_TOKEN_LENGTH + 7) {
    throw new TypeError("Authorization header is malformed");
  }
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+={0,2})$/iu.exec(header);
  if (!match) throw new TypeError("Authorization header is malformed");
  return match[1];
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
