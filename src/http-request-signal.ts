/** Runtime-issued HTTP request cancellation provenance. */

export type HttpRequestAbortKind =
  | "deadline"
  | "client_disconnected"
  | "shutdown";

export type RequestCancellationAuditReason =
  | "request_cancelled"
  | "request_deadline_exceeded";

interface RequestSignalState {
  kind: HttpRequestAbortKind | undefined;
}

export interface HttpRequestSignalController {
  readonly signal: AbortSignal;
  abort(kind: HttpRequestAbortKind, reason: Error): void;
}

const ISSUED_REQUEST_SIGNALS = new WeakMap<AbortSignal, RequestSignalState>();

/** Create the only request signal whose abort provenance can affect audits. */
export function createHttpRequestSignalController(): HttpRequestSignalController {
  const controller = new AbortController();
  const state: RequestSignalState = { kind: undefined };
  ISSUED_REQUEST_SIGNALS.set(controller.signal, state);
  return Object.freeze({
    signal: controller.signal,
    abort(kind: HttpRequestAbortKind, reason: Error): void {
      if (state.kind !== undefined || controller.signal.aborted) return;
      state.kind = kind;
      controller.abort(reason);
    },
  });
}

/** Read only module-issued provenance; AbortSignal.reason is never inspected. */
export function issuedRequestCancellationAuditReason(
  signal: AbortSignal
): RequestCancellationAuditReason | undefined {
  try {
    if (!(signal instanceof AbortSignal) || !signal.aborted) return undefined;
    const kind = ISSUED_REQUEST_SIGNALS.get(signal)?.kind;
    if (kind === "deadline") return "request_deadline_exceeded";
    if (kind === "client_disconnected" || kind === "shutdown") {
      return "request_cancelled";
    }
    return undefined;
  } catch {
    return undefined;
  }
}
