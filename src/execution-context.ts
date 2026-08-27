/**
 * Provider-neutral request metadata, resolved execution context, and audit
 * contracts for ServiceNow tool invocations.
 *
 * Request metadata exists before profile resolution. An ExecutionContext can
 * only be constructed after a configured profile has been resolved and its
 * instance URL canonicalized. This distinction prevents handlers from ever
 * observing a partial or inferred profile binding.
 *
 * @module execution-context
 */

import { randomUUID } from "node:crypto";

import {
  createEncodedQueryAccessPolicy,
  type EncodedQueryAccessPolicy,
  type EncodedQueryAccessPolicyInput,
} from "./encoded-query-policy.js";
import {
  createTableAccessPolicy,
  type TableAccessPolicy,
} from "./table-policy.js";
import { issuedRequestCancellationAuditReason } from "./http-request-signal.js";
import {
  safeToolErrorDescriptor,
  type ToolErrorCategory,
  type ToolErrorRetry,
} from "./tool-error.js";

/** Stable, non-secret request fields projected from the MCP callback extra. */
export interface ToolInvocationMetadata {
  readonly tool: string;
  readonly requestId: string | number;
  readonly sessionId?: string;
  readonly authenticatedClientId?: string;
}

/** Single-owner identity and the client acting for that owner. */
export interface OwnerClientIdentity {
  readonly ownerId: string;
  readonly clientId: string;
}

/** Metadata that is safe to create before profile resolution. */
export interface RequestMetadata {
  readonly correlationId: string;
  readonly identity: OwnerClientIdentity;
}

/** Injectable identity/correlation bridge supplied by the owning runtime. */
export interface RequestMetadataProvider {
  resolve(input: ToolInvocationMetadata): RequestMetadata | Promise<RequestMetadata>;
}

/** Non-secret, canonical binding for one resolved configured profile. */
export interface ResolvedProfileBinding {
  readonly name: string;
  readonly instance: string;
}

/**
 * Complete table-policy slice selected for this invocation. Later security
 * tickets add fields, filters, bounds, and non-table capabilities without
 * weakening this required fail-closed table boundary.
 */
export interface EffectivePolicyReference {
  readonly id: string;
  readonly revision: string;
  readonly tableAccess: TableAccessPolicy;
  /** Omission is the universal deny-all raw encoded-query policy. */
  readonly encodedQueryAccess?: EncodedQueryAccessPolicyInput;
}

export interface ResolvedEffectivePolicyReference {
  readonly id: string;
  readonly revision: string;
  readonly tableAccess: TableAccessPolicy;
  readonly encodedQueryAccess: EncodedQueryAccessPolicy;
}

/** Injectable policy-selection port; it does not itself authorize a tool. */
export interface EffectivePolicyProvider {
  resolve(input: {
    readonly request: RequestMetadata;
    readonly profile: ResolvedProfileBinding;
    readonly tool: string;
  }): EffectivePolicyReference | Promise<EffectivePolicyReference>;
}

/** Complete immutable context passed to exactly one tool handler invocation. */
export interface ExecutionContext {
  readonly correlationId: string;
  readonly identity: OwnerClientIdentity;
  readonly profile: ResolvedProfileBinding;
  readonly effectivePolicy: ResolvedEffectivePolicyReference;
  /** Authoritative cancellation signal for this one tool invocation. */
  readonly signal: AbortSignal;
}

export type AuditOutcome =
  | "success"
  | "cancelled"
  | "handler_error"
  | "profile_rejected"
  | "policy_rejected"
  | "context_rejected"
  | "client_rejected";

/** Bounded tool-audit reasons; arbitrary exception text is never an audit field. */
export type ToolAuditReason =
  | "missing_profile"
  | "unknown_profile"
  | "invalid_profile"
  | "policy_context_unavailable"
  | "table_access_denied"
  | "encoded_query_denied"
  | "journal_update_denied"
  | "client_initialization_failed"
  | "profile_binding_changed"
  | "request_cancelled"
  | "request_deadline_exceeded"
  | "handler_threw"
  | "handler_returned_error";

const TOOL_AUDIT_RECORD_BRAND: unique symbol = Symbol("ToolAuditRecord");
const PRE_CONTEXT_AUDIT_RECORD_BRAND: unique symbol = Symbol("PreContextAuditRecord");
const ISSUED_TOOL_AUDIT_RECORDS = new WeakSet<object>();
const ISSUED_PRE_CONTEXT_AUDIT_RECORDS = new WeakSet<object>();

interface ToolAuditRecordBrand {
  readonly [TOOL_AUDIT_RECORD_BRAND]: true;
}

interface PreContextAuditRecordBrand {
  readonly [PRE_CONTEXT_AUDIT_RECORD_BRAND]: true;
}

interface ToolAuditRecordBase extends ToolAuditRecordBrand {
  readonly tool: string;
  readonly correlationId: string;
  readonly identity: OwnerClientIdentity;
}

type ResolvedToolAuditRecord = ToolAuditRecordBase & {
  readonly profile: string;
  readonly instance: string;
};

interface ToolAuditErrorFields {
  readonly errorCategory: ToolErrorCategory;
  readonly retry: ToolErrorRetry;
  readonly retryAfterSeconds: number | null;
}

/**
 * Exact safe tool-audit envelope. Invalid outcome/reason/profile combinations
 * are not representable and records can only be branded by this module.
 */
export type ToolAuditRecord =
  | (ResolvedToolAuditRecord & {
      readonly outcome: "success";
      readonly reason: null;
    })
  | (ToolAuditRecordBase & {
      readonly outcome: "profile_rejected";
      readonly reason: "missing_profile" | "unknown_profile" | "invalid_profile";
      readonly profile: null;
      readonly instance: null;
    })
  | (ResolvedToolAuditRecord & {
      readonly outcome: "context_rejected";
      readonly reason: "policy_context_unavailable";
    })
  | (ResolvedToolAuditRecord & {
      readonly outcome: "policy_rejected";
      readonly reason:
        | "table_access_denied"
        | "encoded_query_denied"
        | "journal_update_denied";
    })
  | (ResolvedToolAuditRecord & ToolAuditErrorFields & {
      readonly outcome: "client_rejected";
      readonly reason: "client_initialization_failed" | "profile_binding_changed";
    })
  | (ResolvedToolAuditRecord & {
      readonly outcome: "cancelled";
      readonly reason: "request_cancelled" | "request_deadline_exceeded";
    })
  | (ResolvedToolAuditRecord & ToolAuditErrorFields & {
      readonly outcome: "handler_error";
      readonly reason: "handler_threw" | "handler_returned_error";
    });

/**
 * Operational evidence for failures that occur before a profile can safely be
 * inspected. It intentionally has no profile or instance field, preventing a
 * missing identity provider from becoming a profile-existence oracle.
 */
interface PreContextAuditRecordBase extends PreContextAuditRecordBrand {
  readonly scope: "pre_context";
  readonly tool: string;
  readonly correlationId: string;
  readonly identity: OwnerClientIdentity;
}

export type PreContextAuditRecord = PreContextAuditRecordBase &
  (
    | {
        readonly outcome: "context_rejected";
        readonly reason:
          | "request_metadata_unavailable"
          | "input_validation_failed";
      }
    | {
        readonly outcome: "cancelled";
        readonly reason: "request_cancelled" | "request_deadline_exceeded";
      }
  );

/** Audit destinations must not affect invocation behavior when they fail. */
export interface AuditSink {
  /** Synchronously enqueue a record; delivery/flush belongs to the runtime. */
  write(record: ToolAuditRecord): void;
  /** Synchronously enqueue profile-free evidence from before context creation. */
  writePreContext(record: PreContextAuditRecord): void;
}

/** Provider-neutral lifecycle hook for timing one complete tool invocation. */
export interface ToolAuditObservation {
  finish(record: ToolAuditRecord | PreContextAuditRecord): void;
}

export interface ToolAuditObserver {
  begin(): ToolAuditObservation;
}

export interface ExecutionContextDependencies {
  readonly requestMetadataProvider: RequestMetadataProvider;
  readonly effectivePolicyProvider: EffectivePolicyProvider;
  readonly auditSink: AuditSink;
  readonly toolAuditObserver?: ToolAuditObserver;
  /** Runtime request signal; omission is a non-cancellable local/test invocation. */
  readonly requestSignal?: AbortSignal;
}

/** Printable bounded identifiers; JSON encoding makes punctuation log-safe. */
const SAFE_IDENTIFIER = /^[^\u0000-\u001F\u007F]{1,128}$/u;

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!SAFE_IDENTIFIER.test(normalized)) {
    throw new TypeError(`${label} contains unsupported characters or length`);
  }
  return normalized;
}

/** Validate, clone, and deeply freeze runtime-provided request metadata. */
export function immutableRequestMetadata(candidate: RequestMetadata): RequestMetadata {
  // Snapshot each untrusted property exactly once before validation. Provider
  // objects may be Proxies or expose time-varying getters.
  const correlationIdCandidate = candidate.correlationId;
  const identityCandidate = candidate.identity;
  if (typeof identityCandidate !== "object" || identityCandidate === null) {
    throw new TypeError("identity must be an object");
  }
  const ownerIdCandidate = identityCandidate.ownerId;
  const clientIdCandidate = identityCandidate.clientId;
  const identity = Object.freeze({
    ownerId: safeIdentifier(ownerIdCandidate, "ownerId"),
    clientId: safeIdentifier(clientIdCandidate, "clientId"),
  });
  return Object.freeze({
    correlationId: safeIdentifier(correlationIdCandidate, "correlationId"),
    identity,
  });
}

/**
 * Produce auditable metadata when an injected metadata provider rejects.
 * Sentinels are explicit and non-attributive; they never impersonate an owner.
 */
export function fallbackRequestMetadata(): RequestMetadata {
  return immutableRequestMetadata({
    correlationId: randomUUID(),
    identity: {
      ownerId: "unavailable-owner",
      clientId: "unavailable-client",
    },
  });
}

/** Resolve policy and construct the full context only after profile validation. */
export async function createExecutionContext(
  request: RequestMetadata,
  profile: ResolvedProfileBinding,
  tool: string,
  policyProvider: EffectivePolicyProvider,
  signal: AbortSignal = NEVER_ABORTED_SIGNAL
): Promise<ExecutionContext> {
  const requestSignal = validatedAbortSignal(signal);
  const immutableRequest = immutableRequestMetadata(request);
  const immutableProfile = Object.freeze({
    name: canonicalProfileName(profile.name),
    instance: canonicalOrigin(profile.instance),
  });

  const selectedPolicy = await waitForSignal(
    Promise.resolve(
      policyProvider.resolve({
        request: immutableRequest,
        profile: immutableProfile,
        tool,
      })
    ),
    requestSignal
  );
  const effectivePolicy = Object.freeze({
    id: safeIdentifier(selectedPolicy.id, "policy id"),
    revision: safeIdentifier(selectedPolicy.revision, "policy revision"),
    tableAccess: createTableAccessPolicy(selectedPolicy.tableAccess),
    encodedQueryAccess: createEncodedQueryAccessPolicy(
      selectedPolicy.encodedQueryAccess
    ),
  });

  return Object.freeze({
    correlationId: immutableRequest.correlationId,
    identity: immutableRequest.identity,
    profile: immutableProfile,
    effectivePolicy,
    signal: requestSignal,
  });
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function validatedAbortSignal(candidate: AbortSignal): AbortSignal {
  if (!(candidate instanceof AbortSignal)) {
    throw new TypeError("execution context signal must be an AbortSignal");
  }
  return candidate;
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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

interface AuditRecordCommonInput {
  readonly tool: string;
  readonly request: RequestMetadata;
}

export type ToolAuditDisposition =
  | {
      readonly outcome: "success";
      readonly reason: null;
      readonly profile: ResolvedProfileBinding;
    }
  | {
      readonly outcome: "profile_rejected";
      readonly reason: "missing_profile" | "unknown_profile" | "invalid_profile";
      readonly profile?: never;
    }
  | {
      readonly outcome: "context_rejected";
      readonly reason: "policy_context_unavailable";
      readonly profile: ResolvedProfileBinding;
    }
  | {
      readonly outcome: "policy_rejected";
      readonly reason:
        | "table_access_denied"
        | "encoded_query_denied"
        | "journal_update_denied";
      readonly profile: ResolvedProfileBinding;
    }
  | {
      readonly outcome: "client_rejected";
      readonly reason: "client_initialization_failed" | "profile_binding_changed";
      readonly profile: ResolvedProfileBinding;
      readonly error?: unknown;
    }
  | {
      readonly outcome: "cancelled";
      readonly reason: "request_cancelled" | "request_deadline_exceeded";
      readonly profile: ResolvedProfileBinding;
    }
  | {
      readonly outcome: "handler_error";
      readonly reason: "handler_threw" | "handler_returned_error";
      readonly profile: ResolvedProfileBinding;
      readonly error?: unknown;
    };

export type CreateToolAuditRecordInput = AuditRecordCommonInput & ToolAuditDisposition;

/** Construct the only value exposed to audit hooks and freeze it recursively. */
export function createAuditRecord(input: CreateToolAuditRecordInput): ToolAuditRecord {
  // Snapshot every caller-controlled field once. Validation and construction
  // below never read from input again, preventing time-varying getter TOCTOU.
  const outcome = input.outcome;
  const reason = input.reason;
  const profileSnapshot = snapshotProfileBinding(input.profile);
  const toolCandidate = input.tool;
  const requestCandidate = input.request;
  const errorDescriptor =
    outcome === "client_rejected" || outcome === "handler_error"
      ? safeToolErrorDescriptor(input.error)
      : undefined;

  validateAuditInvariant(outcome, reason, profileSnapshot);
  const request = immutableRequestMetadata(requestCandidate);
  const common = {
    tool: safeIdentifier(toolCandidate, "tool name"),
    correlationId: request.correlationId,
    identity: request.identity,
  };

  if (outcome === "profile_rejected") {
    if (
      reason === "missing_profile" ||
      reason === "unknown_profile" ||
      reason === "invalid_profile"
    ) {
      return brandToolAuditRecord({
        ...common,
        outcome,
        reason,
        profile: null,
        instance: null,
      });
    }
    throw new TypeError("audit outcome, reason, and profile are inconsistent");
  }

  if (!profileSnapshot) {
    throw new TypeError("resolved audit records require a profile");
  }
  const profile = Object.freeze({
    name: canonicalProfileName(profileSnapshot.name),
    instance: canonicalOrigin(profileSnapshot.instance),
  });
  switch (outcome) {
    case "success":
      if (reason !== null) break;
      return brandToolAuditRecord({
        ...common,
        outcome,
        reason,
        profile: profile.name,
        instance: profile.instance,
      });
    case "context_rejected":
      if (reason !== "policy_context_unavailable") break;
      return brandToolAuditRecord({
        ...common,
        outcome,
        reason,
        profile: profile.name,
        instance: profile.instance,
      });
    case "policy_rejected":
      if (
        reason !== "table_access_denied" &&
        reason !== "encoded_query_denied" &&
        reason !== "journal_update_denied"
      ) {
        break;
      }
      return brandToolAuditRecord({
        ...common,
        outcome,
        reason,
        profile: profile.name,
        instance: profile.instance,
      });
    case "client_rejected":
      if (
        reason !== "client_initialization_failed" &&
        reason !== "profile_binding_changed"
      ) {
        break;
      }
      return brandToolAuditRecord({
        ...common,
        outcome,
        reason,
        profile: profile.name,
        instance: profile.instance,
        errorCategory: errorDescriptor!.category,
        retry: errorDescriptor!.retry,
        retryAfterSeconds: errorDescriptor!.retryAfterSeconds ?? null,
      });
    case "cancelled":
      if (
        reason !== "request_cancelled" &&
        reason !== "request_deadline_exceeded"
      ) {
        break;
      }
      return brandToolAuditRecord({
        ...common,
        outcome,
        reason,
        profile: profile.name,
        instance: profile.instance,
      });
    case "handler_error":
      if (reason !== "handler_threw" && reason !== "handler_returned_error") break;
      return brandToolAuditRecord({
        ...common,
        outcome,
        reason,
        profile: profile.name,
        instance: profile.instance,
        errorCategory: errorDescriptor!.category,
        retry: errorDescriptor!.retry,
        retryAfterSeconds: errorDescriptor!.retryAfterSeconds ?? null,
      });
  }
  throw new TypeError("audit outcome, reason, and profile are inconsistent");
}

/** Construct immutable operational evidence without any profile claim. */
export function createPreContextAuditRecord(input: {
  readonly tool: string;
  readonly request: RequestMetadata;
  readonly reason:
    | "request_metadata_unavailable"
    | "input_validation_failed"
    | "request_cancelled"
    | "request_deadline_exceeded";
}): PreContextAuditRecord {
  const reason = input.reason;
  const toolCandidate = input.tool;
  const requestCandidate = input.request;
  if (
    reason !== "request_metadata_unavailable" &&
    reason !== "input_validation_failed" &&
    reason !== "request_cancelled" &&
    reason !== "request_deadline_exceeded"
  ) {
    throw new TypeError("pre-context audit reason is inconsistent");
  }
  const request = immutableRequestMetadata(requestCandidate);
  const common = {
    scope: "pre_context" as const,
    tool: safeIdentifier(toolCandidate, "tool name"),
    correlationId: request.correlationId,
    identity: request.identity,
  };
  if (reason === "request_cancelled" || reason === "request_deadline_exceeded") {
    return brandPreContextAuditRecord({
      ...common,
      outcome: "cancelled",
      reason,
    });
  }
  return brandPreContextAuditRecord({
    ...common,
    outcome: "context_rejected",
    reason,
  });
}

function brandToolAuditRecord<T extends object>(record: T): T & ToolAuditRecordBrand {
  Object.defineProperty(record, TOOL_AUDIT_RECORD_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  // defineProperty establishes the private brand, which TypeScript cannot
  // infer from the runtime descriptor operation.
  const issued = Object.freeze(record) as T & ToolAuditRecordBrand;
  ISSUED_TOOL_AUDIT_RECORDS.add(issued);
  return issued;
}

function brandPreContextAuditRecord<T extends object>(
  record: T
): T & PreContextAuditRecordBrand {
  Object.defineProperty(record, PRE_CONTEXT_AUDIT_RECORD_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const issued = Object.freeze(record) as T & PreContextAuditRecordBrand;
  ISSUED_PRE_CONTEXT_AUDIT_RECORDS.add(issued);
  return issued;
}

/** Audit failures are isolated from tool results and application state. */
export function emitAudit(
  sink: AuditSink,
  record: ToolAuditRecord
): void {
  if (!isIssuedToolAuditRecord(record)) return;
  try {
    // The port contract is a synchronous bounded enqueue. If a runtime
    // violates it by returning a thenable, suppress rejection without awaiting
    // settlement so tool results and post-side-effect responses cannot hang.
    suppressUnexpectedThenable(sink.write(record) as unknown);
  } catch {
    // Auditing must not let an optional sink mutate or replace a tool result.
    // Operational reporting for sink failures belongs to SNSDK-26.
  }
}

/** Profile-free counterpart to emitAudit with identical non-blocking behavior. */
export function emitPreContextAudit(
  sink: AuditSink,
  record: PreContextAuditRecord
): void {
  if (!isIssuedPreContextAuditRecord(record)) return;
  try {
    suppressUnexpectedThenable(sink.writePreContext(record) as unknown);
  } catch {
    // Pre-context operational auditing cannot affect the safe rejection.
  }
}

function suppressUnexpectedThenable(value: unknown): void {
  if (isThenable(value)) {
    void Promise.resolve(value).catch(() => {});
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

function isIssuedToolAuditRecord(candidate: unknown): candidate is ToolAuditRecord {
  try {
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      Object.isFrozen(candidate) &&
      ISSUED_TOOL_AUDIT_RECORDS.has(candidate)
    );
  } catch {
    return false;
  }
}

function isIssuedPreContextAuditRecord(
  candidate: unknown
): candidate is PreContextAuditRecord {
  try {
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      Object.isFrozen(candidate) &&
      ISSUED_PRE_CONTEXT_AUDIT_RECORDS.has(candidate)
    );
  } catch {
    return false;
  }
}

interface ProfileBindingSnapshot {
  readonly name: unknown;
  readonly instance: unknown;
}

function snapshotProfileBinding(candidate: unknown): ProfileBindingSnapshot | undefined {
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("profile binding must be an object");
  }
  const name = Reflect.get(candidate, "name");
  const instance = Reflect.get(candidate, "instance");
  return Object.freeze({ name, instance });
}

function canonicalProfileName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("profile name must be a string");
  }
  const canonical = value.trim();
  if (!canonical) {
    throw new TypeError("profile name must not be empty");
  }
  return canonical;
}

function validateAuditInvariant(
  outcome: unknown,
  reason: unknown,
  profile: unknown
): void {
  const hasProfile = profile !== undefined;
  const valid =
    (outcome === "success" && reason === null && hasProfile) ||
    (outcome === "profile_rejected" &&
      (reason === "missing_profile" ||
        reason === "unknown_profile" ||
        reason === "invalid_profile") &&
      !hasProfile) ||
    (outcome === "context_rejected" &&
      reason === "policy_context_unavailable" &&
      hasProfile) ||
    (outcome === "policy_rejected" &&
      (reason === "table_access_denied" ||
        reason === "encoded_query_denied" ||
        reason === "journal_update_denied") &&
      hasProfile) ||
    (outcome === "client_rejected" &&
      (reason === "client_initialization_failed" ||
        reason === "profile_binding_changed") &&
      hasProfile) ||
    (outcome === "cancelled" &&
      (reason === "request_cancelled" ||
        reason === "request_deadline_exceeded") &&
      hasProfile) ||
    (outcome === "handler_error" &&
      (reason === "handler_threw" || reason === "handler_returned_error") &&
      hasProfile);
  if (!valid) {
    throw new TypeError("audit outcome, reason, and profile are inconsistent");
  }
}

/**
 * Classify only an authoritative aborted request signal into bounded audit
 * vocabulary. Exception text and other reason fields are never inspected.
 */
export function requestCancellationAuditReason(
  signal: AbortSignal
): "request_cancelled" | "request_deadline_exceeded" | undefined {
  return issuedRequestCancellationAuditReason(signal);
}

function canonicalOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("profile instance must be a URL string");
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new TypeError("profile instance must be a canonical HTTPS origin");
  }
  return parsed.origin;
}
