import { Buffer } from "node:buffer";
import { types as nodeUtilTypes } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type {
  RequestResult,
  ServiceNowClient,
  ServiceNowOperations,
} from "../../src/client.js";
import type { ServiceNowConfig } from "../../src/config.js";
import type {
  ExecutionContextDependencies,
  ToolAuditRecord,
} from "../../src/execution-context.js";
import type { Profile, ProfileManager } from "../../src/profile-manager.js";
import { createMcpServer } from "../../src/server.js";
import {
  createTableAccessPolicy,
  type TableAccessPolicy,
} from "../../src/table-policy.js";
import {
  registerServiceNowToolModules,
  toolModules,
  type ToolModuleContract,
} from "../../src/tools/index.js";

export type MockServiceNowOperation =
  | "get"
  | "getWithMeta"
  | "post"
  | "patch"
  | "delete"
  | "postBinary"
  | "getRaw";

export interface MockServiceNowCall {
  readonly operation: MockServiceNowOperation;
  readonly path: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly data?: Buffer;
  readonly contentType?: string;
  readonly options?: Readonly<{ maxBytes?: number }>;
}

export type MockServiceNowStep = Readonly<{
  operation: MockServiceNowOperation;
  response?: unknown;
  error?: unknown;
}>;

export interface MockServiceNowFixture {
  readonly operations: ServiceNowOperations;
  readonly calls: readonly MockServiceNowCall[];
  pendingCount(): number;
  assertConsumed(): void;
}

/**
 * Create a deterministic FIFO ServiceNow facade.
 *
 * Every operation must have one matching step. Calls are snapshotted before a
 * configured response is returned or error is thrown, so tests can assert the
 * exact target, query parameters, and write body without relying on spy APIs.
 */
export function createMockServiceNowFixture(
  steps: readonly MockServiceNowStep[] = []
): MockServiceNowFixture {
  const pending = steps.map(normalizeStep);
  const calls: MockServiceNowCall[] = [];

  async function invoke<T>(call: MockServiceNowCall): Promise<T> {
    calls.push(snapshotCall(call));
    const step = pending.shift();
    if (!step) {
      throw new Error("Mock ServiceNow fixture was exhausted");
    }
    if (step.operation !== call.operation) {
      throw new Error(
        `Mock ServiceNow fixture expected ${step.operation}; received ${call.operation}`
      );
    }
    if (Object.hasOwn(step, "error")) throw step.error;
    return step.response as T;
  }

  const operations: ServiceNowOperations = Object.freeze({
    get: <T>(path: string, params?: Record<string, string>) =>
      invoke<T | null>({ operation: "get", path, params }),
    getWithMeta: <T>(path: string, params?: Record<string, string>) =>
      invoke<RequestResult<T>>({ operation: "getWithMeta", path, params }),
    post: <T>(path: string, body?: unknown) =>
      invoke<T | null>({ operation: "post", path, body }),
    patch: <T>(path: string, body?: unknown) =>
      invoke<T | null>({ operation: "patch", path, body }),
    delete: (path: string) =>
      invoke<{ status: number }>({ operation: "delete", path }),
    postBinary: <T>(
      path: string,
      data: Buffer,
      contentType: string,
      params?: Record<string, string>
    ) => invoke<T>({ operation: "postBinary", path, data, contentType, params }),
    getRaw: (path: string, options?: { readonly maxBytes?: number }) =>
      invoke<{ data: Buffer; contentType: string }>({
        operation: "getRaw",
        path,
        options,
      }),
  });

  return {
    operations,
    get calls() {
      return Object.freeze(calls.map(snapshotCall));
    },
    pendingCount: () => pending.length,
    assertConsumed(): void {
      if (pending.length !== 0) {
        throw new Error("Mock ServiceNow fixture has unconsumed steps");
      }
    },
  };
}

export const SNSDK54_PROFILE_NAME = "snsdk-54";
export const SNSDK54_INSTANCE = "https://snsdk-54.service-now.com";
export const SNSDK54_SYS_ID = "1234567890abcdef1234567890abcdef";
export const SNSDK54_FAILURE_CANARIES = Object.freeze({
  credential: "snsdk54-credential-must-not-leak",
  token: "snsdk54-token-must-not-leak",
  upstreamBody: "snsdk54-upstream-body-must-not-leak",
  selector: "snsdk54-selector-must-not-leak",
  journal: "snsdk54-journal-must-not-leak",
});

export const SNSDK54_REFERENCE_TOOLS = Object.freeze([
  "sn_query",
  "sn_get",
  "sn_create",
  "sn_update",
  "sn_incident_add_comment",
  "sn_incident_add_work_note",
] as const);

export interface MockServiceNowHarnessOptions {
  readonly steps?: readonly MockServiceNowStep[];
  readonly tableAccess?: TableAccessPolicy;
  readonly modules?: readonly ToolModuleContract[];
}

/** Shared MCP boundary harness for future ServiceNow domain-module tests. */
export async function createMockServiceNowHarness(
  options: MockServiceNowHarnessOptions = {}
) {
  const fixture = createMockServiceNowFixture(options.steps);
  const audits: ToolAuditRecord[] = [];
  const managerCalls = {
    profile: [] as string[],
    config: [] as string[],
    client: [] as string[],
  };
  const profile: Profile = Object.freeze({
    instance: SNSDK54_INSTANCE,
    username: "snsdk-54-user",
    credential: "env:SNSDK54_TEST_SECRET",
    authType: "basic" as const,
  });
  const config: ServiceNowConfig = Object.freeze({
    instance: SNSDK54_INSTANCE,
    user: "snsdk-54-user",
    password: SNSDK54_FAILURE_CANARIES.credential,
    displayValue: "true",
    relDepth: 3,
    authType: "basic" as const,
  });
  const manager = {
    getProfile(name: string): Profile {
      managerCalls.profile.push(name);
      if (name !== SNSDK54_PROFILE_NAME) throw new Error("unknown profile");
      return profile;
    },
    getConfig(name: string): ServiceNowConfig {
      managerCalls.config.push(name);
      if (name !== SNSDK54_PROFILE_NAME) throw new Error("unknown profile");
      return config;
    },
    getClient(name: string): ServiceNowClient {
      managerCalls.client.push(name);
      if (name !== SNSDK54_PROFILE_NAME) throw new Error("unknown profile");
      return fixture.operations as unknown as ServiceNowClient;
    },
  } as unknown as ProfileManager;
  const tableAccess = options.tableAccess ?? referenceTableAccessPolicy();
  const dependencies: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `snsdk-54-${String(requestId)}`,
        identity: { ownerId: "snsdk-54-owner", clientId: "snsdk-54-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "snsdk-54-mocked-policy",
        revision: "v1",
        tableAccess,
      }),
    },
    auditSink: {
      write: (record) => audits.push(record),
      writePreContext: () => {},
    },
  };
  const server = await createMcpServer({
    dependencies: {},
    register: (surface) =>
      registerServiceNowToolModules(
        surface,
        manager,
        dependencies,
        options.modules ?? toolModules
      ),
  });
  const client = new Client({ name: "snsdk-54-fixture", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    fixture,
    audits,
    managerCalls,
    async close(): Promise<void> {
      try {
        await client.close();
      } finally {
        if (server.isConnected()) await server.close();
      }
    },
  };
}

export function referenceTableAccessPolicy(): TableAccessPolicy {
  return createTableAccessPolicy({
    readTables: ["incident"],
    writeTables: ["incident"],
    targets: [
      {
        table: "incident",
        kind: "canonical",
        tools: SNSDK54_REFERENCE_TOOLS,
        closureComplete: true,
        relatedTables: ["incident"],
      },
    ],
  });
}

function snapshotCall(call: MockServiceNowCall): MockServiceNowCall {
  return Object.freeze({
    ...call,
    ...(call.params === undefined
      ? {}
      : { params: snapshotStringRecord(call.params) }),
    ...(call.body === undefined ? {} : { body: snapshotValue(call.body) }),
    ...(call.data === undefined ? {} : { data: snapshotBuffer(call.data) }),
    ...(call.options === undefined
      ? {}
      : { options: snapshotMaxBytes(call.options) }),
  });
}

function snapshotValue(value: unknown): unknown {
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    nodeUtilTypes.isProxy(value)
  ) {
    throw new TypeError("Mock ServiceNow call data must not contain proxies");
  }
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return snapshotArray(value);
  if (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    const output: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw new TypeError(
          "Mock ServiceNow call data must contain enumerable data properties"
        );
      }
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          "Mock ServiceNow call data must contain enumerable data properties"
        );
      }
      Object.defineProperty(output, key, {
        value: snapshotValue(descriptor.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(output);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new TypeError("Mock ServiceNow call data must be JSON-compatible");
}

function snapshotBuffer(value: Buffer): Buffer {
  if (nodeUtilTypes.isProxy(value)) {
    throw new TypeError("Mock ServiceNow call data must not contain proxies");
  }
  if (!Buffer.isBuffer(value)) {
    throw new TypeError("Mock ServiceNow binary data must be a Buffer");
  }
  return Buffer.from(value);
}

function snapshotArray(value: unknown[]): readonly unknown[] {
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new TypeError("Mock ServiceNow call array length is invalid");
  }
  const length = lengthDescriptor.value as number;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Mock ServiceNow call arrays must be dense data arrays");
    }
    output.push(snapshotValue(descriptor.value));
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= length
    ) {
      throw new TypeError("Mock ServiceNow call arrays must not have extra properties");
    }
  }
  return Object.freeze(output);
}

function snapshotStringRecord(
  value: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const snapshot = snapshotValue(value);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError("Mock ServiceNow call parameters must be a plain object");
  }
  for (const item of Object.values(snapshot)) {
    if (typeof item !== "string") {
      throw new TypeError("Mock ServiceNow call parameters must contain strings");
    }
  }
  return snapshot as Readonly<Record<string, string>>;
}

function snapshotMaxBytes(
  value: Readonly<{ maxBytes?: number }>
): Readonly<{ maxBytes?: number }> {
  const snapshot = snapshotValue(value);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError("Mock ServiceNow raw options must be a plain object");
  }
  const candidate = Reflect.get(snapshot, "maxBytes");
  if (candidate !== undefined && typeof candidate !== "number") {
    throw new TypeError("Mock ServiceNow raw maxBytes must be a number");
  }
  return snapshot as Readonly<{ maxBytes?: number }>;
}

function normalizeStep(step: MockServiceNowStep): MockServiceNowStep {
  if (
    typeof step !== "object" ||
    step === null ||
    nodeUtilTypes.isProxy(step) ||
    Object.getPrototypeOf(step) !== Object.prototype
  ) {
    throw new TypeError("Mock ServiceNow fixture step must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(step);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError("Mock ServiceNow fixture step is invalid");
    }
    const descriptor = descriptors[key];
    if (
      !["operation", "response", "error"].includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Mock ServiceNow fixture step is invalid");
    }
  }
  const operation = descriptors.operation?.value as unknown;
  if (!isMockOperation(operation)) {
    throw new TypeError("Mock ServiceNow fixture operation is invalid");
  }
  const hasResponse = Object.hasOwn(descriptors, "response");
  const hasError = Object.hasOwn(descriptors, "error");
  if (hasResponse === hasError) {
    throw new TypeError(
      "Mock ServiceNow fixture step must define exactly one response or error"
    );
  }
  return Object.freeze(
    hasError
      ? { operation, error: descriptors.error!.value }
      : { operation, response: descriptors.response!.value }
  );
}

function isMockOperation(value: unknown): value is MockServiceNowOperation {
  return (
    typeof value === "string" &&
    [
      "get",
      "getWithMeta",
      "post",
      "patch",
      "delete",
      "postBinary",
      "getRaw",
    ].includes(value)
  );
}
