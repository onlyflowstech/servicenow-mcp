import type { ServiceNowOperations } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { Profile } from "../src/profile-manager.js";

export const SNSDK53_PROFILE_NAME = "alpha";

export const SNSDK53_PROFILE: Profile = Object.freeze({
  instance: "https://alpha.service-now.com",
  username: "alpha-user",
  credential: Object.freeze({
    type: "secret_ref" as const,
    provider: "env",
    reference: "SN_SNSDK53_TEST_PASSWORD",
  }),
  authType: "basic" as const,
});

export const SNSDK53_CONFIG: Readonly<ServiceNowConfig> = Object.freeze({
  instance: "https://alpha.service-now.com",
  user: "alpha-user",
  password: "snsdk-53-runtime-secret",
  displayValue: "true",
  relDepth: 3,
  authType: "basic" as const,
});

export const SNSDK53_TABLE_ACCESS = Object.freeze({
  readTables: Object.freeze([]),
  writeTables: Object.freeze([]),
  targets: Object.freeze([]),
});

export const SNSDK53_SECRET_PROBES = Object.freeze({
  plaintext: "snsdk53-plaintext-credential-canary",
  reference: "snsdk53/opaque/secret-reference-canary",
});

/** A capability-complete client whose operation counters prove no SN access. */
export function createCountingServiceNowOperations() {
  const calls: string[] = [];
  const record = (operation: string): void => {
    calls.push(operation);
    throw new Error("SNSDK-53 ServiceNow access was not expected");
  };
  const operations: ServiceNowOperations = Object.freeze({
    get: async () => record("get") as never,
    getWithMeta: async () => record("getWithMeta") as never,
    post: async () => record("post") as never,
    patch: async () => record("patch") as never,
    delete: async () => record("delete") as never,
    postBinary: async () => record("postBinary") as never,
    getRaw: async () => record("getRaw") as never,
  });
  return { calls, operations };
}
