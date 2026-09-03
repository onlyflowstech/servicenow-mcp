/**
 * Fail-closed HTTP request-boundary policy for the Streamable HTTP runtime.
 *
 * The policy sees only transport metadata. It never receives authentication
 * credentials, parsed MCP bodies, profile configuration, or tool data.
 */

export const DEFAULT_MAX_MCP_JSON_BODY_BYTES = 1024 * 1024;
export const DEFAULT_HTTP_BODY_READ_TIMEOUT_MS = 15_000;
export const DEFAULT_HTTP_REQUEST_DEADLINE_MS = 120_000;
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
/** Reserved Host authority accepted only for loopback lifecycle probes. */
export const INTERNAL_HEALTHCHECK_AUTHORITY = "mcp-health.internal";

const MAX_POLICY_TIMEOUT_MS = 300_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const SAFE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const ALLOWED_CORS_REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "mcp-protocol-version",
]);

export interface HttpRequestPolicyLimits {
  readonly maxBodyBytes: number;
  /** Deadline for consuming the JSON request body after admission. */
  readonly bodyReadTimeoutMs: number;
  /** End-to-end deadline for authentication, MCP dispatch, and response. */
  readonly requestDeadlineMs: number;
  /** Node HTTP parser deadline for receiving complete headers. */
  readonly headersTimeoutMs: number;
  /** Node HTTP parser deadline for receiving the complete request. */
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
}

export interface HttpRequestPolicyInput {
  readonly rawHeaders: readonly string[];
  readonly method: string | undefined;
  readonly pathname: string | undefined;
  readonly configuredHost: string;
  readonly localAddress: string | undefined;
  readonly localPort: number | undefined;
  readonly remoteAddress?: string | undefined;
}

export type HttpRequestPolicyRejectionReason =
  | "invalid_host"
  | "disallowed_host"
  | "invalid_origin"
  | "disallowed_origin"
  | "invalid_content_type"
  | "request_too_large"
  | "invalid_preflight";

export type HttpRequestPolicyDecision =
  | {
      readonly kind: "allow";
      readonly responseHeaders: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "preflight";
      readonly status: 204;
      readonly responseHeaders: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "reject";
      readonly status: 400 | 403 | 413 | 415 | 421;
      readonly reason: HttpRequestPolicyRejectionReason;
      readonly responseHeaders: Readonly<Record<string, string>>;
    };

export interface HttpRequestPolicy {
  readonly limits: HttpRequestPolicyLimits;
  inspect(input: HttpRequestPolicyInput): HttpRequestPolicyDecision;
}

export interface CreateHttpRequestPolicyOptions {
  /** Exact host authorities. Omission derives safe names from the bind/socket. */
  readonly allowedHosts?: readonly string[];
  /** Exact HTTP(S) origins. Omission denies every browser Origin. */
  readonly allowedOrigins?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly bodyReadTimeoutMs?: number;
  readonly requestDeadlineMs?: number;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
}

interface ParsedAuthority {
  readonly hostname: string;
  readonly port: string;
}

/** Construct a validated immutable request policy. */
export function createHttpRequestPolicy(
  options: CreateHttpRequestPolicyOptions = {}
): HttpRequestPolicy {
  if (!options || typeof options !== "object") {
    throw new TypeError("HTTP request policy options must be an object");
  }
  const limits = Object.freeze({
    maxBodyBytes: boundedInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_MCP_JSON_BODY_BYTES,
      1,
      MAX_BODY_BYTES,
      "maxBodyBytes"
    ),
    bodyReadTimeoutMs: boundedInteger(
      options.bodyReadTimeoutMs ?? DEFAULT_HTTP_BODY_READ_TIMEOUT_MS,
      1,
      MAX_POLICY_TIMEOUT_MS,
      "bodyReadTimeoutMs"
    ),
    requestDeadlineMs: boundedInteger(
      options.requestDeadlineMs ?? DEFAULT_HTTP_REQUEST_DEADLINE_MS,
      1,
      MAX_POLICY_TIMEOUT_MS,
      "requestDeadlineMs"
    ),
    headersTimeoutMs: boundedInteger(
      options.headersTimeoutMs ?? DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
      1,
      MAX_POLICY_TIMEOUT_MS,
      "headersTimeoutMs"
    ),
    requestTimeoutMs: boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
      1,
      MAX_POLICY_TIMEOUT_MS,
      "requestTimeoutMs"
    ),
    keepAliveTimeoutMs: boundedInteger(
      options.keepAliveTimeoutMs ?? DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS,
      1,
      MAX_POLICY_TIMEOUT_MS,
      "keepAliveTimeoutMs"
    ),
  });
  if (limits.headersTimeoutMs > limits.requestTimeoutMs) {
    throw new TypeError("headersTimeoutMs must not exceed requestTimeoutMs");
  }

  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);

  const policy: HttpRequestPolicy = {
    limits,
    inspect(input): HttpRequestPolicyDecision {
      const rawHeaders = snapshotRawHeaders(input.rawHeaders);
      const hostValues = rawHeaderValues(rawHeaders, "host");
      if (hostValues.length !== 1) return reject(400, "invalid_host");

      const requestedHost = parseAuthority(hostValues[0]);
      if (!requestedHost) return reject(400, "invalid_host");
      const effectiveAllowedHosts =
        allowedHosts ?? derivedAllowedHosts(input.configuredHost, input.localAddress);
      if (
        !isInternalLoopbackHealthProbe(requestedHost, input) &&
        !hostAllowed(requestedHost, effectiveAllowedHosts, input.localPort)
      ) {
        return reject(421, "disallowed_host");
      }

      const originValues = rawHeaderValues(rawHeaders, "origin");
      if (originValues.length > 1) return reject(400, "invalid_origin");
      let corsHeaders: Readonly<Record<string, string>> = EMPTY_HEADERS;
      if (originValues.length === 1) {
        const origin = normalizeOrigin(originValues[0]);
        if (!origin) return reject(400, "invalid_origin");
        if (!allowedOrigins.has(origin)) {
          return reject(403, "disallowed_origin");
        }
        corsHeaders = corsResponseHeaders(origin);
      }

      if (input.pathname !== "/mcp") {
        return allow(corsHeaders);
      }

      if (input.method === "OPTIONS") {
        if (originValues.length !== 1) {
          return reject(403, "invalid_preflight");
        }
        const methodValues = rawHeaderValues(
          rawHeaders,
          "access-control-request-method"
        );
        if (methodValues.length !== 1 || methodValues[0].trim().toUpperCase() !== "POST") {
          return reject(403, "invalid_preflight", corsHeaders);
        }
        const requestHeaderValues = rawHeaderValues(
          rawHeaders,
          "access-control-request-headers"
        );
        if (requestHeaderValues.length > 1) {
          return reject(400, "invalid_preflight", corsHeaders);
        }
        if (
          requestHeaderValues.length === 1 &&
          !validCorsRequestHeaders(requestHeaderValues[0])
        ) {
          return reject(403, "invalid_preflight", corsHeaders);
        }
        return Object.freeze({
          kind: "preflight",
          status: 204,
          responseHeaders: Object.freeze({
            ...corsHeaders,
            "access-control-allow-headers":
              "Accept, Authorization, Content-Type, Mcp-Protocol-Version",
            "access-control-allow-methods": "POST",
            "access-control-max-age": "600",
          }),
        });
      }

      if (input.method !== "POST") return allow(corsHeaders);

      const contentTypeValues = rawHeaderValues(rawHeaders, "content-type");
      if (
        contentTypeValues.length !== 1 ||
        !isSupportedJsonContentType(contentTypeValues[0])
      ) {
        return reject(415, "invalid_content_type", corsHeaders);
      }

      const contentLengthValues = rawHeaderValues(rawHeaders, "content-length");
      if (contentLengthValues.length > 1) {
        return reject(400, "request_too_large", corsHeaders);
      }
      if (contentLengthValues.length === 1) {
        const declared = contentLengthValues[0];
        if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
          return reject(400, "request_too_large", corsHeaders);
        }
        const length = Number(declared);
        if (!Number.isSafeInteger(length)) {
          return reject(413, "request_too_large", corsHeaders);
        }
        if (length > limits.maxBodyBytes) {
          return reject(413, "request_too_large", corsHeaders);
        }
      }

      return allow(corsHeaders);
    },
  };
  return Object.freeze(policy);
}

/** Invoke an injected policy and reject safely when it throws or misbehaves. */
export function inspectHttpRequest(
  policy: HttpRequestPolicy,
  input: HttpRequestPolicyInput
): HttpRequestPolicyDecision {
  try {
    return validateDecision(policy.inspect(input));
  } catch {
    return reject(400, "invalid_host");
  }
}

/** Snapshot and validate limits supplied by an injected policy. */
export function httpRequestPolicyLimits(
  policy: HttpRequestPolicy
): HttpRequestPolicyLimits {
  try {
    if (!policy || typeof policy !== "object" || typeof policy.inspect !== "function") {
      throw new TypeError("HTTP request policy must implement inspect");
    }
    const candidate = policy.limits;
    const limits = Object.freeze({
      maxBodyBytes: boundedInteger(candidate.maxBodyBytes, 1, MAX_BODY_BYTES, "maxBodyBytes"),
      bodyReadTimeoutMs: boundedInteger(
        candidate.bodyReadTimeoutMs,
        1,
        MAX_POLICY_TIMEOUT_MS,
        "bodyReadTimeoutMs"
      ),
      requestDeadlineMs: boundedInteger(
        candidate.requestDeadlineMs,
        1,
        MAX_POLICY_TIMEOUT_MS,
        "requestDeadlineMs"
      ),
      headersTimeoutMs: boundedInteger(
        candidate.headersTimeoutMs,
        1,
        MAX_POLICY_TIMEOUT_MS,
        "headersTimeoutMs"
      ),
      requestTimeoutMs: boundedInteger(
        candidate.requestTimeoutMs,
        1,
        MAX_POLICY_TIMEOUT_MS,
        "requestTimeoutMs"
      ),
      keepAliveTimeoutMs: boundedInteger(
        candidate.keepAliveTimeoutMs,
        1,
        MAX_POLICY_TIMEOUT_MS,
        "keepAliveTimeoutMs"
      ),
    });
    if (limits.headersTimeoutMs > limits.requestTimeoutMs) {
      throw new TypeError("headersTimeoutMs must not exceed requestTimeoutMs");
    }
    return limits;
  } catch {
    throw new TypeError("HTTP request policy limits are invalid");
  }
}

function normalizeAllowedHosts(
  candidates: readonly string[] | undefined
): readonly ParsedAuthority[] | undefined {
  if (candidates === undefined) return undefined;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 128) {
    throw new TypeError("allowedHosts must contain one to 128 exact authorities");
  }
  const seen = new Set<string>();
  const normalized: ParsedAuthority[] = [];
  for (const candidate of candidates) {
    const parsed = parseAuthority(candidate);
    if (!parsed) throw new TypeError("allowedHosts contains an invalid authority");
    const key = `${parsed.hostname}:${parsed.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(parsed);
    }
  }
  return Object.freeze(normalized);
}

function normalizeAllowedOrigins(candidates: readonly string[] | undefined): Set<string> {
  if (candidates === undefined) return new Set();
  if (!Array.isArray(candidates) || candidates.length > 128) {
    throw new TypeError("allowedOrigins must contain at most 128 exact origins");
  }
  const normalized = new Set<string>();
  for (const candidate of candidates) {
    const origin = normalizeOrigin(candidate);
    if (!origin) throw new TypeError("allowedOrigins contains an invalid origin");
    normalized.add(origin);
  }
  return normalized;
}

function snapshotRawHeaders(candidate: readonly string[]): readonly string[] {
  if (!Array.isArray(candidate) || candidate.length % 2 !== 0 || candidate.length > 512) {
    throw new TypeError("raw headers are invalid");
  }
  const snapshot: string[] = [];
  for (const value of candidate) {
    if (typeof value !== "string") throw new TypeError("raw header must be a string");
    snapshot.push(value);
  }
  return snapshot;
}

function rawHeaderValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === name) values.push(rawHeaders[index + 1]);
  }
  return values;
}

function parseAuthority(candidate: unknown): ParsedAuthority | undefined {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 255 ||
    candidate !== candidate.trim() ||
    /[\u0000-\u0020\u007f\\,/@]/u.test(candidate)
  ) {
    return undefined;
  }
  try {
    const explicitPort = authorityPort(candidate);
    if (explicitPort === undefined) return undefined;
    const url = new URL(`http://${candidate}/`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return undefined;
    }
    const hostname = normalizeHostname(url.hostname);
    if (!hostname) return undefined;
    return Object.freeze({ hostname, port: explicitPort });
  } catch {
    return undefined;
  }
}

/** Preserve an explicitly written default port that WHATWG URL normalizes away. */
function authorityPort(candidate: string): string | undefined {
  let suffix = "";
  if (candidate.startsWith("[")) {
    const closingBracket = candidate.indexOf("]");
    if (closingBracket < 0) return undefined;
    suffix = candidate.slice(closingBracket + 1);
    if (suffix === "") return "";
    if (!suffix.startsWith(":")) return undefined;
  } else {
    const firstColon = candidate.indexOf(":");
    if (firstColon < 0) return "";
    if (firstColon !== candidate.lastIndexOf(":")) return undefined;
    suffix = candidate.slice(firstColon);
  }

  const portText = suffix.slice(1);
  if (!/^[0-9]{1,5}$/u.test(portText)) return undefined;
  const port = Number(portText);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? String(port)
    : undefined;
}

function normalizeHostname(candidate: string): string | undefined {
  let hostname = candidate.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname.startsWith("::ffff:")) hostname = hostname.slice(7);
  return hostname.length > 0 && hostname.length <= 253 ? hostname : undefined;
}

function derivedAllowedHosts(
  configuredHost: string,
  localAddress: string | undefined
): readonly ParsedAuthority[] {
  const hostnames = new Set<string>();
  const configured = normalizeHostname(configuredHost);
  const local = localAddress ? normalizeHostname(localAddress) : undefined;
  if (configured && configured !== "0.0.0.0" && configured !== "::") {
    hostnames.add(configured);
  }
  if (local && local !== "0.0.0.0" && local !== "::") hostnames.add(local);
  if ([...hostnames].some(isLoopbackHostname)) {
    hostnames.add("127.0.0.1");
    hostnames.add("::1");
    hostnames.add("localhost");
  }
  return Object.freeze(
    [...hostnames].map((hostname) => Object.freeze({ hostname, port: "" }))
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isInternalLoopbackHealthProbe(
  authority: ParsedAuthority,
  input: HttpRequestPolicyInput
): boolean {
  const remote =
    input.remoteAddress === undefined
      ? undefined
      : normalizeHostname(input.remoteAddress);
  return (
    authority.hostname === INTERNAL_HEALTHCHECK_AUTHORITY &&
    authority.port === "" &&
    (input.pathname === "/health/live" || input.pathname === "/health/ready") &&
    remote !== undefined &&
    isLoopbackHostname(remote)
  );
}

function hostAllowed(
  candidate: ParsedAuthority,
  allowed: readonly ParsedAuthority[],
  localPort: number | undefined
): boolean {
  for (const entry of allowed) {
    if (candidate.hostname !== entry.hostname) continue;
    if (entry.port && candidate.port !== entry.port) continue;
    if (
      !entry.port &&
      candidate.port &&
      localPort !== undefined &&
      candidate.port !== String(localPort)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function normalizeOrigin(candidate: unknown): string | undefined {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 2048 ||
    candidate !== candidate.trim() ||
    /[\u0000-\u0020\u007f,]/u.test(candidate)
  ) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin === "null"
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isSupportedJsonContentType(candidate: string): boolean {
  if (candidate.length > 128 || /[\u0000-\u001f\u007f,]/u.test(candidate)) {
    return false;
  }
  const parts = candidate.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "application/json") return false;
  if (parts.length === 1) return true;
  return parts.length === 2 && /^charset\s*=\s*(?:"utf-8"|utf-8)$/u.test(parts[1]);
}

function validCorsRequestHeaders(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 1024) return false;
  const names = candidate.split(",").map((name) => name.trim().toLowerCase());
  return names.every(
    (name) => SAFE_HEADER_NAME.test(name) && ALLOWED_CORS_REQUEST_HEADERS.has(name)
  );
}

const EMPTY_HEADERS = Object.freeze({});

function corsResponseHeaders(origin: string): Readonly<Record<string, string>> {
  return Object.freeze({
    "access-control-allow-origin": origin,
    "access-control-expose-headers":
      "Mcp-Session-Id, Mcp-Protocol-Version, X-Request-Id",
    vary: "Origin",
  });
}

function allow(
  responseHeaders: Readonly<Record<string, string>> = EMPTY_HEADERS
): HttpRequestPolicyDecision {
  return Object.freeze({ kind: "allow", responseHeaders });
}

function reject(
  status: 400 | 403 | 413 | 415 | 421,
  reason: HttpRequestPolicyRejectionReason,
  responseHeaders: Readonly<Record<string, string>> = EMPTY_HEADERS
): HttpRequestPolicyDecision {
  return Object.freeze({ kind: "reject", status, reason, responseHeaders });
}

function validateDecision(candidate: unknown): HttpRequestPolicyDecision {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("HTTP request policy decision is invalid");
  }
  const decision = candidate as Partial<HttpRequestPolicyDecision>;
  if (!validHeaders(decision.responseHeaders)) {
    throw new TypeError("HTTP request policy response headers are invalid");
  }
  if (decision.kind === "allow") return allow(decision.responseHeaders);
  if (decision.kind === "preflight" && decision.status === 204) {
    return Object.freeze({
      kind: "preflight",
      status: 204,
      responseHeaders: Object.freeze({ ...decision.responseHeaders }),
    });
  }
  if (
    decision.kind === "reject" &&
    (decision.status === 400 ||
      decision.status === 403 ||
      decision.status === 413 ||
      decision.status === 415 ||
      decision.status === 421) &&
    validRejectionReason(decision.reason) &&
    rejectionStatusMatchesReason(decision.status, decision.reason)
  ) {
    return reject(decision.status, decision.reason, {
      ...decision.responseHeaders,
    });
  }
  throw new TypeError("HTTP request policy decision is invalid");
}

function validRejectionReason(
  candidate: unknown
): candidate is HttpRequestPolicyRejectionReason {
  return (
    candidate === "invalid_host" ||
    candidate === "disallowed_host" ||
    candidate === "invalid_origin" ||
    candidate === "disallowed_origin" ||
    candidate === "invalid_content_type" ||
    candidate === "request_too_large" ||
    candidate === "invalid_preflight"
  );
}

function rejectionStatusMatchesReason(
  status: 400 | 403 | 413 | 415 | 421,
  reason: HttpRequestPolicyRejectionReason
): boolean {
  switch (reason) {
    case "invalid_host":
    case "invalid_origin":
      return status === 400;
    case "disallowed_host":
      return status === 421;
    case "disallowed_origin":
      return status === 403;
    case "invalid_content_type":
      return status === 415;
    case "request_too_large":
      return status === 400 || status === 413;
    case "invalid_preflight":
      return status === 400 || status === 403;
  }
}

function validHeaders(candidate: unknown): candidate is Readonly<Record<string, string>> {
  if (typeof candidate !== "object" || candidate === null) return false;
  const entries = Object.entries(candidate);
  if (entries.length > 32) return false;
  return entries.every(
    ([name, value]) =>
      SAFE_HEADER_NAME.test(name) &&
      typeof value === "string" &&
      value.length <= 2048 &&
      !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}
