import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PingRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import {
  createMcpServer,
  type McpServerRegistrationSurface,
} from "../src/server.js";

class FakeTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];

  constructor(private readonly closeFailure?: Error) {}

  readonly start = vi.fn(async (): Promise<void> => {});
  readonly send = vi.fn(async (_message: JSONRPCMessage): Promise<void> => {});
  readonly close = vi.fn(async (): Promise<void> => {
    if (this.closeFailure) throw this.closeFailure;
    this.onclose?.();
  });
}

function createDeferred() {
  let resolve = () => {};
  let reject = (_reason?: unknown) => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Test-only instrumentation that observes the receiver used while the factory
 * binds registerTool. It does not add a raw-server escape to production code.
 */
function captureNextRawServer(): { get: () => McpServer; restore: () => void } {
  const descriptor = Object.getOwnPropertyDescriptor(McpServer.prototype, "registerTool");
  if (!descriptor || typeof descriptor.value !== "function") {
    throw new Error("Expected McpServer.registerTool method descriptor");
  }
  let captured: McpServer | undefined;
  const capture = (server: McpServer): void => {
    captured = server;
  };
  Object.defineProperty(McpServer.prototype, "registerTool", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get: function (this: McpServer): unknown {
      capture(this);
      return descriptor.value;
    },
  });

  return {
    get: () => {
      if (!captured) throw new Error("Expected factory to bind registerTool receiver");
      return captured;
    },
    restore: () => Object.defineProperty(McpServer.prototype, "registerTool", descriptor),
  };
}

describe("createMcpServer", () => {
  it("constructs independent servers with isolated injected containers", async () => {
    const dependenciesA = { service: { name: "a", calls: [] as string[] } };
    const dependenciesB = { service: { name: "b", calls: [] as string[] } };
    const observed: Array<{
      surface: McpServerRegistrationSurface;
      dependencies: Readonly<typeof dependenciesA>;
    }> = [];

    const [serverA, serverB] = await Promise.all([
      createMcpServer({
        dependencies: dependenciesA,
        register: (surface, dependencies) => {
          dependencies.service.calls.push("registered-a");
          observed.push({ surface, dependencies });
        },
      }),
      createMcpServer({
        dependencies: dependenciesB,
        register: (surface, dependencies) => {
          dependencies.service.calls.push("registered-b");
          observed.push({ surface, dependencies });
        },
      }),
    ]);

    expect(serverA).toBeInstanceOf(McpServer);
    expect(serverB).toBeInstanceOf(McpServer);
    expect(serverA).not.toBe(serverB);
    expect(observed).toHaveLength(2);
    expect(observed[0].surface).not.toBe(observed[1].surface);
    expect(observed[0].dependencies).toBe(dependenciesA);
    expect(observed[1].dependencies).toBe(dependenciesB);
    expect(dependenciesA.service.calls).toEqual(["registered-a"]);
    expect(dependenciesB.service.calls).toEqual(["registered-b"]);
  });

  it("passes a registration surface and exact dependency container once", async () => {
    const dependencies = { marker: { value: "injected" } };
    let calls = 0;
    let observedSurface: McpServerRegistrationSurface | undefined;
    let observedDependencies: Readonly<typeof dependencies> | undefined;

    const server = await createMcpServer({
      dependencies,
      register: (candidate, injected) => {
        calls += 1;
        observedSurface = candidate;
        observedDependencies = injected;
      },
    });

    expect(calls).toBe(1);
    expect(observedSurface).toBeDefined();
    expect(observedSurface).not.toBe(server);
    expect(observedDependencies).toBe(dependencies);
  });

  it("exposes only frozen registration APIs with working bound receivers", async () => {
    type TopLevelLifecycleKeys = Extract<
      keyof McpServerRegistrationSurface,
      "close" | "connect" | "isConnected"
    >;
    type LowLevelLifecycleKeys = Extract<
      keyof McpServerRegistrationSurface["server"],
      "close" | "connect" | "transport"
    >;
    const lifecycleKeysAreExcluded: [TopLevelLifecycleKeys, LowLevelLifecycleKeys] extends [
      never,
      never,
    ]
      ? true
      : false = true;
    const surfaces: McpServerRegistrationSurface[] = [];

    const server = await createMcpServer({
      dependencies: {},
      register: (surface) => {
        surfaces.push(surface);
      },
    });
    const surface = surfaces[0];
    expect(surface).toBeDefined();
    if (!surface) throw new Error("Expected registration surface");

    expect(lifecycleKeysAreExcluded).toBe(true);
    expect(Object.keys(surface)).toEqual([
      "server",
      "registerPrompt",
      "registerResource",
      "registerTool",
    ]);
    expect(Reflect.ownKeys(surface)).toEqual([
      "server",
      "registerPrompt",
      "registerResource",
      "registerTool",
    ]);
    expect(Object.keys(surface.server)).toEqual([
      "registerCapabilities",
      "setRequestHandler",
    ]);
    expect(Reflect.ownKeys(surface.server)).toEqual([
      "registerCapabilities",
      "setRequestHandler",
    ]);
    expect(Object.isFrozen(surface)).toBe(true);
    expect(Object.isFrozen(surface.server)).toBe(true);

    for (const property of [
      "close",
      "connect",
      "isConnected",
      "sendLoggingMessage",
      "sendToolListChanged",
      "experimental",
    ]) {
      expect(property in surface).toBe(false);
      expect(Reflect.get(surface, property)).toBeUndefined();
    }
    for (const property of [
      "close",
      "connect",
      "transport",
      "ping",
      "getClientCapabilities",
      "sendLoggingMessage",
      "setNotificationHandler",
    ]) {
      expect(property in surface.server).toBe(false);
      expect(Reflect.get(surface.server, property)).toBeUndefined();
    }

    expect(() =>
      surface.registerTool("facade-tool", {}, async () => ({
        content: [{ type: "text", text: "ok" }],
      }))
    ).not.toThrow();
    expect(() =>
      surface.registerPrompt("facade-prompt", {}, async () => ({ messages: [] }))
    ).not.toThrow();
    expect(() =>
      surface.registerResource("facade-resource", "test://facade", {}, async (uri) => ({
        contents: [{ uri: uri.href, text: "ok" }],
      }))
    ).not.toThrow();
    expect(() => surface.server.registerCapabilities({ logging: {} })).not.toThrow();
    expect(() =>
      surface.server.setRequestHandler(PingRequestSchema, async () => ({}))
    ).not.toThrow();
    expect(server.isConnected()).toBe(false);
  });

  it("returns disconnected and does not start a transport during construction", async () => {
    const transport = new FakeTransport();
    const server = await createMcpServer({ dependencies: {}, register: () => {} });

    expect(server.isConnected()).toBe(false);
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("lets an external caller connect and own the transport lifecycle", async () => {
    const transport = new FakeTransport();
    const server = await createMcpServer({ dependencies: {}, register: () => {} });

    await server.connect(transport);

    expect(transport.start).toHaveBeenCalledOnce();
    expect(server.isConnected()).toBe(true);

    await server.close();

    expect(transport.close).toHaveBeenCalledOnce();
    expect(server.isConnected()).toBe(false);
  });

  it("propagates synchronous registrar failure without touching a transport", async () => {
    const transport = new FakeTransport();
    const failure = new Error("registration failed");

    await expect(
      createMcpServer({
        dependencies: {},
        register: () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("waits for delayed asynchronous registration before resolving", async () => {
    const registrationGate = createDeferred();
    let registrationComplete = false;
    let factoryResolved = false;

    const factoryPromise = createMcpServer({
      dependencies: {},
      register: async () => {
        await registrationGate.promise;
        registrationComplete = true;
      },
    });
    void factoryPromise.then(() => {
      factoryResolved = true;
    });

    await Promise.resolve();
    expect(registrationComplete).toBe(false);
    expect(factoryResolved).toBe(false);

    registrationGate.resolve();
    const server = await factoryPromise;

    expect(registrationComplete).toBe(true);
    expect(factoryResolved).toBe(true);
    expect(server.isConnected()).toBe(false);
  });

  it("propagates delayed async rejection without returning or leaking work", async () => {
    const registrationGate = createDeferred();
    const transport = new FakeTransport();
    const failure = new Error("delayed registration failed");
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    let candidateSurface: McpServerRegistrationSurface | undefined;
    let returnedServer: McpServer | undefined;

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const factoryPromise = createMcpServer({
        dependencies: {},
        register: async (surface) => {
          candidateSurface = surface;
          await registrationGate.promise;
        },
      });
      void factoryPromise.then(
        (server) => {
          returnedServer = server;
        },
        () => {}
      );
      const rejection = expect(factoryPromise).rejects.toBe(failure);

      registrationGate.reject(failure);
      await rejection;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(returnedServer).toBeUndefined();
      expect(candidateSurface).toBeDefined();
      if (!candidateSurface) throw new Error("Expected registration surface");
      expect(Reflect.get(candidateSurface.server, "transport")).toBeUndefined();
      expect(transport.start).not.toHaveBeenCalled();
      expect(transport.close).not.toHaveBeenCalled();
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("closes and rejects when the construction candidate is connected", async () => {
    const transport = new FakeTransport();
    const capture = captureNextRawServer();
    let candidate: McpServer | undefined;
    let returnedServer: McpServer | undefined;
    let observedError: unknown;
    let factoryPromise: Promise<McpServer>;

    try {
      factoryPromise = createMcpServer({
        dependencies: {},
        register: async () => {
          candidate = capture.get();
          await candidate.connect(transport);
        },
      });
    } finally {
      capture.restore();
    }

    try {
      returnedServer = await factoryPromise;
    } catch (error) {
      observedError = error;
    }

    expect(returnedServer).toBeUndefined();
    expect(observedError).toBeInstanceOf(TypeError);
    if (!(observedError instanceof Error)) throw new Error("Expected lifecycle error");
    expect(observedError.message).toBe(
      "McpServer registrar must not connect the server during construction"
    );
    expect(transport.start).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(candidate).toBeDefined();
    expect(candidate?.isConnected()).toBe(false);
  });

  it("closes before propagating a connect-then-reject registrar error", async () => {
    const transport = new FakeTransport();
    const registrationFailure = new Error("connected registration failed");
    const capture = captureNextRawServer();
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    let candidate: McpServer | undefined;
    let returnedServer: McpServer | undefined;

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      let factoryPromise: Promise<McpServer>;
      try {
        factoryPromise = createMcpServer({
          dependencies: {},
          register: async () => {
            candidate = capture.get();
            await candidate.connect(transport);
            throw registrationFailure;
          },
        });
      } finally {
        capture.restore();
      }
      void factoryPromise.then(
        (server) => {
          returnedServer = server;
        },
        () => {}
      );

      await expect(factoryPromise).rejects.toBe(registrationFailure);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(returnedServer).toBeUndefined();
      expect(transport.start).toHaveBeenCalledOnce();
      expect(transport.close).toHaveBeenCalledOnce();
      expect(candidate).toBeDefined();
      expect(candidate?.isConnected()).toBe(false);
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("reports both registrar and connected-server cleanup failures", async () => {
    const registrationFailure = new Error("registration failed after connect");
    const cleanupFailure = new Error("transport close failed");
    const transport = new FakeTransport(cleanupFailure);
    const capture = captureNextRawServer();
    let candidate: McpServer | undefined;
    let returnedServer: McpServer | undefined;
    let observedError: unknown;
    let factoryPromise: Promise<McpServer>;

    try {
      factoryPromise = createMcpServer({
        dependencies: {},
        register: async () => {
          candidate = capture.get();
          await candidate.connect(transport);
          throw registrationFailure;
        },
      });
    } finally {
      capture.restore();
    }

    try {
      returnedServer = await factoryPromise;
    } catch (error) {
      observedError = error;
    }

    expect(returnedServer).toBeUndefined();
    expect(observedError).toBeInstanceOf(AggregateError);
    if (!(observedError instanceof AggregateError)) {
      throw new Error("Expected aggregate registration/cleanup error");
    }
    expect(observedError.message).toBe(
      "McpServer registration and connected-server cleanup both failed"
    );
    expect(observedError.errors).toEqual([registrationFailure, cleanupFailure]);
    expect(transport.start).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(candidate).toBeDefined();
    expect(candidate?.isConnected()).toBe(true);
  });

  it("keeps transport, listener, and process lifecycle imports out of the factory", () => {
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/server\/(?:stdio|streamableHttp)/);
    expect(source).not.toMatch(/from\s+["']node:(?:http|https|net|tls)["']/);
    expect(source).not.toContain("profile-manager");
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\.listen\s*\(/);
    expect(source).not.toMatch(/\.connect\s*\(/);
  });
});
