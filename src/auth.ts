/**
 * Authentication providers for the ServiceNow HTTP client.
 *
 * Each provider produces the auth headers for a request and decides
 * whether a 401 response is worth retrying after a credential refresh.
 *
 * @module auth
 */

import { ServiceNowConfig } from "./config.js";

export type AuthKind = "basic" | "oauth" | "apikey";

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

// ── Factory ────────────────────────────────────────────────────────

/**
 * Build the right AuthProvider for a resolved profile config.
 * Defaults to basic auth for full backward compatibility.
 */
export function createAuthProvider(config: ServiceNowConfig): AuthProvider {
  return new BasicAuthProvider(config.user, config.password);
}
