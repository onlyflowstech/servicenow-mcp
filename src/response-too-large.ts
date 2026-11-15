/**
 * The error for a response that passed its byte limit, kept apart from the
 * client so the error mapper can recognize it without importing the client.
 *
 * @module response-too-large
 */

const ISSUED_TOO_LARGE_ERRORS = new WeakSet<object>();

/**
 * A response, or a request scope's cumulative upstream JSON, passed its byte
 * limit. A RangeError, as before, so existing handling is unchanged; the
 * class lets callers tell it apart from any other RangeError.
 */
export class ServiceNowResponseTooLargeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "ServiceNowResponseTooLargeError";
    ISSUED_TOO_LARGE_ERRORS.add(this);
  }
}

/** True when a request failed because a response or its scope passed a byte limit. */
export function isServiceNowResponseTooLarge(error: unknown): boolean {
  return error instanceof ServiceNowResponseTooLargeError;
}

/**
 * True only for an error this module's class constructed. A WeakSet lookup
 * runs no code of the candidate, so a hostile Proxy or getter-laden object
 * cannot be mistaken for one or made to run while it is classified.
 */
export function isIssuedResponseTooLargeError(candidate: unknown): boolean {
  if (
    (typeof candidate !== "object" && typeof candidate !== "function") ||
    candidate === null
  ) {
    return false;
  }
  return ISSUED_TOO_LARGE_ERRORS.has(candidate);
}
