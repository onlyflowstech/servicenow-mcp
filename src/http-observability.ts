/**
 * Bounded, provider-neutral HTTP observability and rate-limit primitives.
 *
 * The public event inputs deliberately contain no request headers, URL/query,
 * body, exception, credential, or token field. Identity values are represented
 * by one-way digests in emitted events and rate-limit keys are retained only as
 * digests. This makes accidental serialization of the HTTP authentication or
 * ServiceNow credential surfaces structurally unavailable here.
 *
 * @module http-observability
 */

import { createHash } from "node:crypto";

import type {
  OwnerClientIdentity,
  PreContextAuditRecord,
  ToolAuditRecord,
} from "./execution-context.js";
import {
  MAX_TOOL_ERROR_RETRY_AFTER_SECONDS,
  type ToolErrorCategory,
  type ToolErrorRetry,
} from "./tool-error.js";

const EVENT_SCHEMA_VERSION = 1;
const MAX_LABEL_LENGTH = 128;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_LATENCY_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_RATE_LIMIT_CAPACITY = 1_000_000;
export const MAX_RATE_LIMIT_PERIOD_MS = 24 * 60 * 60 * 1_000;
export const MAX_RATE_LIMIT_ENTRIES = 100_000;
const MAX_RATE_LIMIT_KEY_LENGTH = 512;
const SAFE_TOOL_NAME = /^sn_[a-z0-9_]{1,61}$/u;
const UNSAFE_LOG_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ISSUED_STRUCTURED_EVENTS = new WeakSet<object>();
const ISSUED_RATE_LIMIT_DECISIONS = new WeakSet<object>();

/** Injectable wall/monotonic clock. Tests can advance it deterministically. */
export interface HttpObservabilityClock {
  now(): number;
}

/** Synchronous, bounded event destination. Delivery failures are isolated. */
export interface StructuredHttpEventSink {
  write(event: StructuredHttpEvent): void;
}

export type HttpRequestOutcome = "success" | "rejected" | "error";

/** Finite request reasons; arbitrary exception or request text is impossible. */
export type HttpRequestReason =
  | "not_found"
  | "method_not_allowed"
  | "unauthorized"
  | "forbidden"
  | "pre_auth_rate_limited"
  | "identity_rate_limited"
  | "invalid_content_type"
  | "invalid_protocol"
  | "malformed_request"
  | "request_too_large"
  | "request_timeout"
  | "client_disconnected"
  | "concurrency_limited"
  | "tool_input_rejected"
  | "service_unavailable"
  | "internal_error";

interface StructuredEventBase {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly observedAtMs: number;
  readonly latencyMs: number;
  readonly correlationId: string | null;
  /** SHA-256 pseudonyms, never raw configured identifiers. */
  readonly ownerIdHash: string | null;
  readonly clientIdHash: string | null;
}

/** Safe, bounded completion event for one HTTP request. */
export interface StructuredHttpRequestEvent extends StructuredEventBase {
  readonly type: "http_request";
  readonly outcome: HttpRequestOutcome;
  readonly reason: HttpRequestReason | null;
  readonly statusCode: number;
}

export type StructuredToolOutcome =
  | ToolAuditRecord["outcome"]
  | PreContextAuditRecord["outcome"];

export type StructuredToolReason =
  | ToolAuditRecord["reason"]
  | PreContextAuditRecord["reason"];

/** Safe, bounded completion event derived from an issued tool audit record. */
export interface StructuredHttpToolEvent extends StructuredEventBase {
  readonly type: "mcp_tool";
  readonly tool: string;
  readonly profile: string | null;
  readonly instance: string | null;
  readonly outcome: StructuredToolOutcome;
  readonly reason: StructuredToolReason;
  readonly errorCategory: ToolErrorCategory | null;
  readonly retry: ToolErrorRetry | null;
  readonly retryAfterSeconds: number | null;
}

export type StructuredHttpEvent =
  | StructuredHttpRequestEvent
  | StructuredHttpToolEvent;

export interface HttpRequestObservationCompletion {
  readonly correlationId?: string;
  readonly identity?: OwnerClientIdentity;
  readonly outcome: HttpRequestOutcome;
  readonly reason: HttpRequestReason | null;
  readonly statusCode: number;
}

export interface HttpRequestObservation {
  /** Emits at most once. Invalid/hostile inputs fail closed without throwing. */
  finish(
    completion: HttpRequestObservationCompletion
  ): StructuredHttpRequestEvent | undefined;
}

export interface HttpToolObservation {
  /** Emits at most once. Invalid/hostile records fail closed without throwing. */
  finish(
    record: ToolAuditRecord | PreContextAuditRecord
  ): StructuredHttpToolEvent | undefined;
}

/**
 * Request/tool span factory. Spans own their start time and emit exactly one
 * deeply frozen event through the supplied non-blocking sink.
 */
export interface HttpObservability {
  beginRequest(): HttpRequestObservation;
  beginTool(): HttpToolObservation;
}

export interface CreateHttpObservabilityOptions {
  readonly sink: StructuredHttpEventSink;
  readonly clock?: HttpObservabilityClock;
}

/** Create an observability boundary with deterministic, failure-isolated spans. */
export function createHttpObservability(
  options: CreateHttpObservabilityOptions
): HttpObservability {
  if (!options || typeof options !== "object") {
    throw new TypeError("HTTP observability options must be an object");
  }
  const sink = options.sink;
  if (!sink || typeof sink.write !== "function") {
    throw new TypeError("HTTP observability sink must implement write");
  }
  const clock = options.clock ?? SYSTEM_CLOCK;
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("HTTP observability clock must implement now");
  }

  return Object.freeze({
    beginRequest(): HttpRequestObservation {
      const startedAt = safeNow(clock);
      let finished = false;
      return Object.freeze({
        finish(
          completion: HttpRequestObservationCompletion
        ): StructuredHttpRequestEvent | undefined {
          if (finished) return undefined;
          finished = true;
          const endedAt = safeNow(clock, startedAt);
          let event: StructuredHttpRequestEvent;
          try {
            event = createRequestEvent(
              completion,
              endedAt,
              boundedLatency(startedAt, endedAt)
            );
          } catch {
            return undefined;
          }
          emitEvent(sink, event);
          return event;
        },
      });
    },

    beginTool(): HttpToolObservation {
      const startedAt = safeNow(clock);
      let finished = false;
      return Object.freeze({
        finish(
          record: ToolAuditRecord | PreContextAuditRecord
        ): StructuredHttpToolEvent | undefined {
          if (finished) return undefined;
          finished = true;
          const endedAt = safeNow(clock, startedAt);
          let event: StructuredHttpToolEvent;
          try {
            event = createToolEvent(
              record,
              endedAt,
              boundedLatency(startedAt, endedAt)
            );
          } catch {
            return undefined;
          }
          emitEvent(sink, event);
          return event;
        },
      });
    },
  });
}

/** A small JSON-lines adapter; only structured events can enter this port. */
export function createJsonLinesEventSink(
  writeLine: (line: string) => unknown
): StructuredHttpEventSink {
  if (typeof writeLine !== "function") {
    throw new TypeError("JSON-lines destination must be a function");
  }
  return Object.freeze({
    write(event: StructuredHttpEvent): void {
      if (!ISSUED_STRUCTURED_EVENTS.has(event)) return;
      suppressUnexpectedThenable(writeLine(`${JSON.stringify(event)}\n`));
    },
  });
}

export interface BoundedJsonLinesEventSinkOptions {
  readonly writeLine: (line: string) => boolean;
  readonly onDrain: (listener: () => void) => void;
  readonly maxPendingLines?: number;
}

/**
 * Drop-aware nonblocking JSONL sink for streams such as stderr. Node already
 * owns the line whose write returned false; later lines are retained only up
 * to a fixed bound and excess volume is coalesced into one count record.
 */
export function createBoundedJsonLinesEventSink(
  options: BoundedJsonLinesEventSinkOptions
): StructuredHttpEventSink {
  if (
    !options ||
    typeof options !== "object" ||
    typeof options.writeLine !== "function" ||
    typeof options.onDrain !== "function"
  ) {
    throw new TypeError("bounded JSON-lines sink options are invalid");
  }
  const maximum = options.maxPendingLines ?? 256;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 100_000) {
    throw new TypeError("bounded JSON-lines pending limit is invalid");
  }
  const pending: string[] = [];
  let dropped = 0;
  let blocked = false;
  let waitingForDrain = false;

  const waitForDrain = (): void => {
    if (waitingForDrain) return;
    waitingForDrain = true;
    options.onDrain(() => {
      waitingForDrain = false;
      blocked = false;
      flush();
    });
  };

  const write = (line: string): void => {
    try {
      if (!options.writeLine(line)) {
        blocked = true;
        waitForDrain();
      }
    } catch {
      blocked = true;
      waitForDrain();
    }
  };

  const flush = (): void => {
    if (blocked) return;
    if (dropped > 0) {
      const count = dropped;
      dropped = 0;
      write(`${JSON.stringify({ type: "telemetry_dropped", count })}\n`);
    }
    while (!blocked && pending.length > 0) write(pending.shift()!);
  };

  return Object.freeze({
    write(event: StructuredHttpEvent): void {
      if (!ISSUED_STRUCTURED_EVENTS.has(event)) return;
      const line = `${JSON.stringify(event)}\n`;
      if (!blocked) {
        write(line);
      } else if (pending.length < maximum) {
        pending.push(line);
      } else {
        dropped++;
      }
    },
  });
}

export interface TokenBucketRateLimitPolicy {
  /** Maximum burst and tokens replenished during one refill period. */
  readonly capacity: number;
  readonly refillPeriodMs: number;
  /** Hard bound on retained digested principals/sources. */
  readonly maxEntries: number;
}

export interface CreateHttpRateLimiterOptions {
  readonly preAuthentication: TokenBucketRateLimitPolicy;
  readonly authenticatedIdentity: TokenBucketRateLimitPolicy;
  readonly clock?: HttpObservabilityClock;
}

export type HttpRateLimitScope = "pre_auth_source" | "authenticated_identity";

export type HttpRateLimitRejectionReason =
  | "rate_limited"
  | "key_capacity_exhausted"
  | "invalid_key"
  | "clock_unavailable";

export type HttpRateLimitDecision =
  | {
      readonly allowed: true;
      readonly scope: HttpRateLimitScope;
      readonly limit: number;
      readonly remaining: number;
      readonly reason: null;
      readonly retryAfterSeconds: null;
    }
  | {
      readonly allowed: false;
      readonly scope: HttpRateLimitScope;
      readonly limit: number;
      readonly remaining: 0;
      readonly reason: HttpRateLimitRejectionReason;
      readonly retryAfterSeconds: number;
    };

export interface HttpRateLimiter {
  /** Call before authentication; raw keys are digested and never retained. */
  checkPreAuthentication(sourceKey: string): HttpRateLimitDecision;
  /** Call after authentication; raw owner/client identifiers are never retained. */
  checkAuthenticated(identity: OwnerClientIdentity): HttpRateLimitDecision;
}

/** Independent, bounded token buckets for pre-auth sources and identities. */
export function createHttpRateLimiter(
  options: CreateHttpRateLimiterOptions
): HttpRateLimiter {
  if (!options || typeof options !== "object") {
    throw new TypeError("HTTP rate limiter options must be an object");
  }
  const clock = options.clock ?? SYSTEM_CLOCK;
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("HTTP rate limiter clock must implement now");
  }
  const preAuthentication = new BoundedTokenBucketLimiter(
    "pre_auth_source",
    options.preAuthentication,
    clock
  );
  const authenticatedIdentity = new BoundedTokenBucketLimiter(
    "authenticated_identity",
    options.authenticatedIdentity,
    clock
  );

  return Object.freeze({
    checkPreAuthentication(sourceKey: string): HttpRateLimitDecision {
      const key = digestSourceKey(sourceKey);
      return key
        ? preAuthentication.check(key)
        : preAuthentication.rejectInvalidKey();
    },
    checkAuthenticated(identity: OwnerClientIdentity): HttpRateLimitDecision {
      const key = digestIdentityKey(identity);
      return key
        ? authenticatedIdentity.check(key)
        : authenticatedIdentity.rejectInvalidKey();
    },
  });
}

export interface SafeHttpRateLimitRejection {
  readonly status: 429;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Convert only an issued rejection into a generic HTTP 429 response. */
export function safeHttpRateLimitRejection(
  decision: HttpRateLimitDecision
): SafeHttpRateLimitRejection {
  let retryAfterSeconds = 1;
  try {
    if (
      ISSUED_RATE_LIMIT_DECISIONS.has(decision as object) &&
      decision.allowed === false
    ) {
      retryAfterSeconds = boundedRetryAfter(decision.retryAfterSeconds);
    }
  } catch {
    // Forged/hostile decisions receive the same generic minimum delay.
  }
  return Object.freeze({
    status: 429,
    headers: Object.freeze({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfterSeconds),
    }),
    body: '{"error":"rate_limited"}\n',
  });
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

class BoundedTokenBucketLimiter {
  readonly #scope: HttpRateLimitScope;
  readonly #policy: Readonly<TokenBucketRateLimitPolicy>;
  readonly #clock: HttpObservabilityClock;
  readonly #entries = new Map<string, BucketState>();
  #lastNow = 0;
  #nextPruneAt = Number.POSITIVE_INFINITY;

  constructor(
    scope: HttpRateLimitScope,
    policy: TokenBucketRateLimitPolicy,
    clock: HttpObservabilityClock
  ) {
    this.#scope = scope;
    this.#policy = immutableRateLimitPolicy(policy);
    this.#clock = clock;
  }

  check(digestedKey: string): HttpRateLimitDecision {
    const now = this.#readNow();
    if (now === undefined) return this.#reject("clock_unavailable", 1);

    let state = this.#entries.get(digestedKey);
    if (!state) {
      if (
        this.#entries.size >= this.#policy.maxEntries &&
        now >= this.#nextPruneAt
      ) {
        this.#pruneFullAndSchedule(now);
      }
      if (this.#entries.size >= this.#policy.maxEntries) {
        return this.#reject(
          "key_capacity_exhausted",
          millisecondsToRetrySeconds(this.#nextPruneAt - now)
        );
      }
      state = { tokens: this.#policy.capacity, updatedAt: now };
      this.#entries.set(digestedKey, state);
    } else {
      this.#refill(state, now);
    }

    if (state.tokens >= 1) {
      state.tokens -= 1;
      this.#scheduleFullState(state);
      return issuedRateLimitDecision({
        allowed: true,
        scope: this.#scope,
        limit: this.#policy.capacity,
        remaining: Math.max(0, Math.floor(state.tokens)),
        reason: null,
        retryAfterSeconds: null,
      });
    }

    const millisecondsPerToken =
      this.#policy.refillPeriodMs / this.#policy.capacity;
    const waitMs = (1 - state.tokens) * millisecondsPerToken;
    this.#scheduleFullState(state);
    return this.#reject("rate_limited", millisecondsToRetrySeconds(waitMs));
  }

  rejectInvalidKey(): HttpRateLimitDecision {
    return this.#reject("invalid_key", 1);
  }

  #readNow(): number | undefined {
    let candidate: unknown;
    try {
      candidate = this.#clock.now();
    } catch {
      return undefined;
    }
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      return undefined;
    }
    const monotonic = Math.max(this.#lastNow, candidate);
    this.#lastNow = monotonic;
    return monotonic;
  }

  #refill(state: BucketState, now: number): void {
    const elapsed = Math.max(0, now - state.updatedAt);
    state.tokens = Math.min(
      this.#policy.capacity,
      state.tokens +
        (elapsed * this.#policy.capacity) / this.#policy.refillPeriodMs
    );
    state.updatedAt = now;
  }

  /**
   * Full-map cleanup is scheduled at the earliest possible full refill.
   * New-key floods before that instant remain O(1) instead of scanning every
   * retained entry on every rejected attempt.
   */
  #pruneFullAndSchedule(now: number): void {
    this.#nextPruneAt = Number.POSITIVE_INFINITY;
    for (const [key, state] of this.#entries) {
      const available =
        state.tokens +
        (Math.max(0, now - state.updatedAt) * this.#policy.capacity) /
          this.#policy.refillPeriodMs;
      if (available >= this.#policy.capacity) {
        this.#entries.delete(key);
      } else {
        const missingTokens = this.#policy.capacity - available;
        const fullAt =
          now +
          (missingTokens * this.#policy.refillPeriodMs) /
            this.#policy.capacity;
        this.#nextPruneAt = Math.min(this.#nextPruneAt, fullAt);
      }
    }
  }

  #scheduleFullState(state: BucketState): void {
    const missingTokens = Math.max(0, this.#policy.capacity - state.tokens);
    const fullAt =
      state.updatedAt +
      (missingTokens * this.#policy.refillPeriodMs) / this.#policy.capacity;
    this.#nextPruneAt = Math.min(this.#nextPruneAt, fullAt);
  }

  #reject(
    reason: HttpRateLimitRejectionReason,
    retryAfterSeconds: number
  ): HttpRateLimitDecision {
    return issuedRateLimitDecision({
      allowed: false,
      scope: this.#scope,
      limit: this.#policy.capacity,
      remaining: 0,
      reason,
      retryAfterSeconds: boundedRetryAfter(retryAfterSeconds),
    });
  }
}

const SYSTEM_CLOCK: HttpObservabilityClock = Object.freeze({
  now: () => Date.now(),
});

function createRequestEvent(
  completion: HttpRequestObservationCompletion,
  observedAtMs: number,
  latencyMs: number
): StructuredHttpRequestEvent {
  if (typeof completion !== "object" || completion === null) {
    throw new TypeError("request completion must be an object");
  }
  const outcome = Reflect.get(completion, "outcome");
  const reason = Reflect.get(completion, "reason");
  const statusCode = Reflect.get(completion, "statusCode");
  const correlationCandidate = Reflect.get(completion, "correlationId");
  const identityCandidate = Reflect.get(completion, "identity");

  if (
    outcome !== "success" &&
    outcome !== "rejected" &&
    outcome !== "error"
  ) {
    throw new TypeError("request outcome is invalid");
  }
  if (
    (outcome === "success" && reason !== null) ||
    (outcome !== "success" && !isHttpRequestReason(reason))
  ) {
    throw new TypeError("request outcome and reason are inconsistent");
  }
  if (
    typeof statusCode !== "number" ||
    !Number.isInteger(statusCode) ||
    statusCode < 100 ||
    statusCode > 599
  ) {
    throw new TypeError("request status is invalid");
  }
  if (
    (outcome === "success" && statusCode >= 400) ||
    (outcome === "rejected" &&
      statusCode < 400 &&
      reason !== "tool_input_rejected") ||
    (outcome === "error" && statusCode < 500)
  ) {
    throw new TypeError("request outcome and status are inconsistent");
  }

  const identity = optionalIdentityHashes(identityCandidate);
  return issuedStructuredEvent({
    schemaVersion: EVENT_SCHEMA_VERSION,
    type: "http_request",
    observedAtMs,
    latencyMs,
    correlationId: optionalCorrelationId(correlationCandidate),
    ownerIdHash: identity?.ownerIdHash ?? null,
    clientIdHash: identity?.clientIdHash ?? null,
    outcome,
    reason,
    statusCode,
  });
}

function createToolEvent(
  record: ToolAuditRecord | PreContextAuditRecord,
  observedAtMs: number,
  latencyMs: number
): StructuredHttpToolEvent {
  if (typeof record !== "object" || record === null) {
    throw new TypeError("tool audit record must be an object");
  }
  const scope = Reflect.get(record, "scope");
  const outcome = Reflect.get(record, "outcome");
  const reason = Reflect.get(record, "reason");
  const tool = safeToolName(Reflect.get(record, "tool"));
  const correlationId = requiredCorrelationId(
    Reflect.get(record, "correlationId")
  );
  const identity = requiredIdentityHashes(Reflect.get(record, "identity"));

  let profile: string | null;
  let instance: string | null;
  let errorCategory: ToolErrorCategory | null = null;
  let retry: ToolErrorRetry | null = null;
  let retryAfterSeconds: number | null = null;
  if (scope === "pre_context") {
    const validPreContextDisposition =
      (outcome === "context_rejected" &&
        (reason === "request_metadata_unavailable" ||
          reason === "input_validation_failed")) ||
      (outcome === "cancelled" &&
        (reason === "request_cancelled" ||
          reason === "request_deadline_exceeded"));
    if (!validPreContextDisposition) {
      throw new TypeError("pre-context audit disposition is invalid");
    }
    profile = null;
    instance = null;
  } else {
    const profileCandidate = Reflect.get(record, "profile");
    const instanceCandidate = Reflect.get(record, "instance");
    validateToolDisposition(outcome, reason, profileCandidate, instanceCandidate);
    profile =
      profileCandidate === null ? null : safeConfiguredLabel(profileCandidate);
    instance =
      instanceCandidate === null ? null : safeCanonicalOrigin(instanceCandidate);
    if (outcome === "client_rejected" || outcome === "handler_error") {
      errorCategory = safeToolErrorCategory(
        Reflect.get(record, "errorCategory")
      );
      retry = safeToolErrorRetry(Reflect.get(record, "retry"));
      retryAfterSeconds = safeToolRetryAfter(
        Reflect.get(record, "retryAfterSeconds"),
        retry
      );
    }
  }

  return issuedStructuredEvent({
    schemaVersion: EVENT_SCHEMA_VERSION,
    type: "mcp_tool",
    observedAtMs,
    latencyMs,
    correlationId,
    ownerIdHash: identity.ownerIdHash,
    clientIdHash: identity.clientIdHash,
    tool,
    profile,
    instance,
    outcome,
    reason,
    errorCategory,
    retry,
    retryAfterSeconds,
  });
}

function safeToolErrorCategory(value: unknown): ToolErrorCategory {
  if (
    value !== "authentication" &&
    value !== "authorization" &&
    value !== "not_found" &&
    value !== "conflict" &&
    value !== "rate_limit" &&
    value !== "timeout" &&
    value !== "upstream" &&
    value !== "internal"
  ) {
    throw new TypeError("tool error category is invalid");
  }
  return value;
}

function safeToolErrorRetry(value: unknown): ToolErrorRetry {
  if (
    value !== "do_not_retry" &&
    value !== "retry_after_correction" &&
    value !== "retry_if_safe_and_idempotent" &&
    value !== "retry_later"
  ) {
    throw new TypeError("tool error retry decision is invalid");
  }
  return value;
}

function safeToolRetryAfter(
  value: unknown,
  retry: ToolErrorRetry
): number | null {
  if (value === null) return null;
  if (
    retry !== "retry_later" ||
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TOOL_ERROR_RETRY_AFTER_SECONDS
  ) {
    throw new TypeError("tool error retry-after is invalid");
  }
  return value;
}

function validateToolDisposition(
  outcome: unknown,
  reason: unknown,
  profile: unknown,
  instance: unknown
): void {
  const unresolved = profile === null && instance === null;
  const resolved = typeof profile === "string" && typeof instance === "string";
  const valid =
    (outcome === "success" && reason === null && resolved) ||
    (outcome === "profile_rejected" &&
      (reason === "missing_profile" ||
        reason === "unknown_profile" ||
        reason === "invalid_profile") &&
      unresolved) ||
    (outcome === "context_rejected" &&
      reason === "policy_context_unavailable" &&
      resolved) ||
    (outcome === "policy_rejected" &&
      reason === "table_access_denied" &&
      resolved) ||
    (outcome === "client_rejected" &&
      (reason === "client_initialization_failed" ||
        reason === "profile_binding_changed") &&
      resolved) ||
    (outcome === "cancelled" &&
      (reason === "request_cancelled" ||
        reason === "request_deadline_exceeded") &&
      resolved) ||
    (outcome === "handler_error" &&
      (reason === "handler_threw" || reason === "handler_returned_error") &&
      resolved);
  if (!valid) throw new TypeError("tool audit disposition is invalid");
}

function optionalIdentityHashes(value: unknown):
  | { readonly ownerIdHash: string; readonly clientIdHash: string }
  | undefined {
  return value === undefined ? undefined : requiredIdentityHashes(value);
}

function requiredIdentityHashes(value: unknown): {
  readonly ownerIdHash: string;
  readonly clientIdHash: string;
} {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("identity is invalid");
  }
  const ownerId = safeRateLimitKeyPart(Reflect.get(value, "ownerId"));
  const clientId = safeRateLimitKeyPart(Reflect.get(value, "clientId"));
  return Object.freeze({
    ownerIdHash: digestParts("owner", [ownerId]),
    clientIdHash: digestParts("client", [clientId]),
  });
}

function optionalCorrelationId(value: unknown): string | null {
  return value === undefined ? null : requiredCorrelationId(value);
}

function requiredCorrelationId(value: unknown): string {
  return safeBoundedString(value, "correlation ID", MAX_LABEL_LENGTH);
}

function safeToolName(value: unknown): string {
  const tool = safeBoundedString(value, "tool name", MAX_LABEL_LENGTH);
  if (!SAFE_TOOL_NAME.test(tool)) throw new TypeError("tool name is invalid");
  return tool;
}

function safeConfiguredLabel(value: unknown): string {
  return safeBoundedString(value, "configured label", MAX_LABEL_LENGTH);
}

function safeCanonicalOrigin(value: unknown): string {
  const candidate = safeBoundedString(value, "instance", MAX_ORIGIN_LENGTH);
  const parsed = new URL(candidate);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new TypeError("instance must be a canonical HTTPS origin");
  }
  return parsed.origin;
}

function safeBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    UNSAFE_LOG_CHARACTER.test(normalized)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function digestSourceKey(value: unknown): string | undefined {
  try {
    return digestParts("pre-auth", [safeRateLimitKeyPart(value)]);
  } catch {
    return undefined;
  }
}

function digestIdentityKey(value: unknown): string | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const ownerId = safeRateLimitKeyPart(Reflect.get(value, "ownerId"));
    const clientId = safeRateLimitKeyPart(Reflect.get(value, "clientId"));
    return digestParts("authenticated", [ownerId, clientId]);
  } catch {
    return undefined;
  }
}

function safeRateLimitKeyPart(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("rate-limit key is invalid");
  // Raw key material is hashed immediately and is never emitted, so accepting
  // the full bounded string domain avoids narrowing the authentication
  // identity contract merely because an identifier contains Unicode format
  // characters. Empty and oversized values still fail closed.
  if (value.length === 0 || value.length > MAX_RATE_LIMIT_KEY_LENGTH) {
    throw new TypeError("rate-limit key is invalid");
  }
  return value;
}

/** Length-prefix every part so different owner/client splits cannot collide. */
function digestParts(namespace: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(`${namespace}\0`, "utf8");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.length), "ascii").update(":", "ascii").update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function immutableRateLimitPolicy(
  policy: TokenBucketRateLimitPolicy
): Readonly<TokenBucketRateLimitPolicy> {
  if (typeof policy !== "object" || policy === null) {
    throw new TypeError("rate-limit policy must be an object");
  }
  const capacity = Reflect.get(policy, "capacity");
  const refillPeriodMs = Reflect.get(policy, "refillPeriodMs");
  const maxEntries = Reflect.get(policy, "maxEntries");
  if (
    typeof capacity !== "number" ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_RATE_LIMIT_CAPACITY
  ) {
    throw new TypeError("rate-limit capacity is invalid");
  }
  if (
    typeof refillPeriodMs !== "number" ||
    !Number.isSafeInteger(refillPeriodMs) ||
    refillPeriodMs < 1 ||
    refillPeriodMs > MAX_RATE_LIMIT_PERIOD_MS
  ) {
    throw new TypeError("rate-limit refillPeriodMs is invalid");
  }
  if (
    typeof maxEntries !== "number" ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_RATE_LIMIT_ENTRIES
  ) {
    throw new TypeError("rate-limit maxEntries is invalid");
  }
  return Object.freeze({ capacity, refillPeriodMs, maxEntries });
}

function issuedRateLimitDecision<T extends HttpRateLimitDecision>(
  decision: T
): T {
  const issued = Object.freeze(decision);
  ISSUED_RATE_LIMIT_DECISIONS.add(issued);
  return issued;
}

function issuedStructuredEvent<T extends StructuredHttpEvent>(event: T): T {
  const issued = Object.freeze(event);
  ISSUED_STRUCTURED_EVENTS.add(issued);
  return issued;
}

function emitEvent(sink: StructuredHttpEventSink, event: StructuredHttpEvent): void {
  try {
    suppressUnexpectedThenable(sink.write(event) as unknown);
  } catch {
    // Observability must not alter request/tool behavior.
  }
}

function suppressUnexpectedThenable(value: unknown): void {
  if (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    safeThen(value)
  ) {
    void Promise.resolve(value).catch(() => {});
  }
}

function safeThen(value: object | ((...args: unknown[]) => unknown)): boolean {
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

function safeNow(clock: HttpObservabilityClock, fallback = 0): number {
  try {
    const value = clock.now();
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.max(fallback, value)
      : fallback;
  } catch {
    return fallback;
  }
}

function boundedLatency(startedAt: number, endedAt: number): number {
  return Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(endedAt - startedAt)));
}

function isHttpRequestReason(value: unknown): value is HttpRequestReason {
  return (
    value === "not_found" ||
    value === "method_not_allowed" ||
    value === "unauthorized" ||
    value === "forbidden" ||
    value === "pre_auth_rate_limited" ||
    value === "identity_rate_limited" ||
    value === "invalid_content_type" ||
    value === "invalid_protocol" ||
    value === "malformed_request" ||
    value === "request_too_large" ||
    value === "request_timeout" ||
    value === "client_disconnected" ||
    value === "concurrency_limited" ||
    value === "tool_input_rejected" ||
    value === "service_unavailable" ||
    value === "internal_error"
  );
}

function millisecondsToRetrySeconds(milliseconds: number): number {
  return boundedRetryAfter(Math.ceil(Math.max(0, milliseconds) / 1_000));
}

function boundedRetryAfter(value: number): number {
  return Math.min(86_400, Math.max(1, Math.ceil(value)));
}
