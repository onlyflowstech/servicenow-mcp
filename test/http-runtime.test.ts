import { request as nodeHttpRequest } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  HttpAuthenticationError,
  StaticBearerAuthenticationProvider,
  type HttpAuthenticationProvider,
  type HttpAuthenticationRequest,
} from "../src/http-auth.js";
import { requestCancellationAuditReason } from "../src/execution-context.js";
import {
  BODY_MEMORY_SAFETY_FACTOR,
  DEFAULT_HTTP_CLOSE_GRACE_PERIOD_MS,
  DEFAULT_MAX_HTTP_CONNECTIONS,
  DEFAULT_MAX_CONCURRENT_MCP_REQUESTS,
  MAX_HTTP_CONNECTIONS,
  MAX_REJECTED_BODY_DRAIN_BYTES,
  MAX_ESTIMATED_CONCURRENT_BODY_MEMORY_BYTES,
  MCP_HTTP_PATH,
  RAW_RESPONSE_MEMORY_SAFETY_FACTOR,
  REJECTED_BODY_DRAIN_TIMEOUT_MS,
  createHttpRuntime,
  type AuthenticatedHttpRequestContext,
  type CreateHttpRuntimeOptions,
  type HttpRuntime,
} from "../src/http-runtime.js";
import { createHttpRequestPolicy } from "../src/http-request-policy.js";
import { createMcpServer } from "../src/server.js";

const TOKEN = "snsdk-http-test-token-012345678901234567890123456789";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const IDENTITY = Object.freeze({ ownerId: "owner-test", clientId: "client-test" });

function bearerProvider(): StaticBearerAuthenticationProvider {
  return new StaticBearerAuthenticationProvider([{ token: TOKEN, ...IDENTITY }]);
}

async function emptyMcpServer(): Promise<McpServer> {
  return createMcpServer({ dependencies: {}, register: () => {} });
}

async function startRuntime(
  createServer: (context: AuthenticatedHttpRequestContext) => McpServer | Promise<McpServer>,
  authenticationProvider: HttpAuthenticationProvider<HttpAuthenticationRequest> =
    bearerProvider(),
  options: Pick<
    CreateHttpRuntimeOptions,
    "maxConcurrentRequests" | "maxConnections" | "observability" | "requestPolicy"
  > = {}
): Promise<{ runtime: HttpRuntime; url: URL }> {
  const runtime = createHttpRuntime({
    host: "127.0.0.1",
    port: 0,
    authenticationProvider,
    createServer,
    ...options,
  });
  const address = await runtime.start();
  return { runtime, url: address.url };
}

function authenticatedHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    authorization: AUTHORIZATION,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...extra,
  };
}

async function rawMcpPost(url: URL, body: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: authenticatedHeaders({ "mcp-protocol-version": "2025-06-18" }),
    body,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("stateless Streamable HTTP runtime", () => {
  it("is inert until start, returns its fixed endpoint, and cannot restart", async () => {
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: bearerProvider(),
      createServer: emptyMcpServer,
    });

    const first = await runtime.start();
    const second = await runtime.start();
    expect(second).toBe(first);
    expect(first.url.pathname).toBe(MCP_HTTP_PATH);
    expect(first.host).toBe("127.0.0.1");
    expect(first.port).toBeGreaterThan(0);

    await runtime.close({ gracePeriodMs: 0 });
    await expect(runtime.start()).rejects.toThrow("cannot restart");
  });

  it("coalesces close during startup without returning to the listening state", async () => {
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: bearerProvider(),
      createServer: emptyMcpServer,
    });

    const starting = runtime.start();
    const closing = runtime.close({ gracePeriodMs: 0 });
    const address = await starting;
    await closing;

    await expect(runtime.start()).rejects.toThrow("cannot restart");
    await expect(fetch(address.url)).rejects.toThrow();
  });

  it("supports official-client initialize, discovery, and invocation across fresh requests", async () => {
    const contexts: AuthenticatedHttpRequestContext[] = [];
    const servers = new Set<McpServer>();
    const metadata: Array<{ ownerId: string; clientId: string; correlationId: string }> = [];
    const { runtime, url } = await startRuntime(async (context) => {
      contexts.push(context);
      const server = await createMcpServer({
        dependencies: { context },
        register: (surface, dependencies) => {
          surface.registerTool(
            "sn_http_probe",
            {
              description: "SNSDK-22 transport probe",
              inputSchema: { value: z.string() },
            },
            async ({ value }, extra) => {
              const requestMetadata = await dependencies.context.requestMetadataProvider.resolve({
                tool: "sn_http_probe",
                requestId: extra.requestId,
              });
              metadata.push({
                ...requestMetadata.identity,
                correlationId: requestMetadata.correlationId,
              });
              return { content: [{ type: "text", text: value }] };
            }
          );
        },
      });
      servers.add(server);
      return server;
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: AUTHORIZATION } },
    });
    const client = new Client({ name: "snsdk-22-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["sn_http_probe"]);

      const result = await client.callTool({
        name: "sn_http_probe",
        arguments: { value: "independent-request-ok" },
      });
      expect(result.content).toContainEqual({
        type: "text",
        text: "independent-request-ok",
      });
      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toMatchObject(IDENTITY);
      expect(metadata[0].correlationId).toMatch(
        /^mcp-[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
      );

      // Initialize, initialized notification, list, and call are independent
      // POSTs; every accepted POST receives a different server and context.
      expect(contexts.length).toBeGreaterThanOrEqual(4);
      expect(new Set(contexts).size).toBe(contexts.length);
      expect(servers.size).toBe(contexts.length);
    } finally {
      await client.close();
      await runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("namespaces the same MCP request ID uniquely across concurrent HTTP requests", async () => {
    const correlations: string[] = [];
    const { runtime, url } = await startRuntime(async (context) =>
      createMcpServer({
        dependencies: { context },
        register: (surface, dependencies) => {
          surface.registerTool(
            "sn_correlation_probe",
            { inputSchema: { nonce: z.string().optional() } },
            async (_args, extra) => {
              const metadata = await dependencies.context.requestMetadataProvider.resolve({
                tool: "sn_correlation_probe",
                requestId: extra.requestId,
              });
              correlations.push(metadata.correlationId);
              return { content: [{ type: "text", text: "ok" }] };
            }
          );
        },
      })
    );
    const transports = [0, 1].map(
      () =>
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: AUTHORIZATION } },
        })
    );
    const clients = transports.map(
      (_transport, index) =>
        new Client({ name: `correlation-client-${index}`, version: "1.0.0" })
    );

    try {
      await Promise.all(
        clients.map((client, index) => client.connect(transports[index]))
      );
      await Promise.all(
        clients.map((client) =>
          client.callTool({ name: "sn_correlation_probe", arguments: {} })
        )
      );
      expect(correlations).toHaveLength(2);
      expect(new Set(correlations).size).toBe(2);
      // Identical client request sequences produce the same hashed MCP ID;
      // only the authenticated HTTP request namespace differs.
      expect(new Set(correlations.map((value) => value.slice(0, 68))).size).toBe(1);
      for (const correlation of correlations) {
        expect(correlation.length).toBeLessThanOrEqual(128);
        expect(correlation).toMatch(/^mcp-[a-f0-9]{64}-/u);
      }
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("returns protocol errors for unsupported methods and malformed payloads", async () => {
    const { runtime, url } = await startRuntime(emptyMcpServer);
    try {
      const unsupported = await rawMcpPost(
        url,
        JSON.stringify({ jsonrpc: "2.0", id: 41, method: "not/a/method" })
      );
      expect(unsupported.status).toBe(200);
      expect(await unsupported.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 41,
        error: { code: -32601 },
      });

      const malformed = await rawMcpPost(url, "{not-json");
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700 },
      });

      const wrongContentType = await fetch(url, {
        method: "POST",
        headers: {
          ...authenticatedHeaders(),
          "content-type": "text/plain",
        },
        body: "{}",
      });
      expect(wrongContentType.status).toBe(415);
      expect(await wrongContentType.json()).toMatchObject({ error: { code: -32000 } });
    } finally {
      await runtime.close({ gracePeriodMs: 100 });
    }
  });

  it.each([
    {
      name: "declared",
      headers: { "content-length": String(1024 * 1024 + 1) },
      body: Buffer.from("{}"),
    },
    {
      name: "chunked",
      headers: { "transfer-encoding": "chunked" },
      body: Buffer.alloc(1024 * 1024 + 1, 0x20),
    },
  ])(
    "rejects $name bodies over 1 MiB before server construction",
    async ({ headers, body }) => {
      const createServer = vi.fn(emptyMcpServer);
      const { runtime, url } = await startRuntime(createServer);
      try {
        const result = await new Promise<{ status: number; body: string }>(
          (resolve, reject) => {
            const outgoing = nodeHttpRequest(
              url,
              {
                method: "POST",
                headers: {
                  Authorization: AUTHORIZATION,
                  "Content-Type": "application/json",
                  "Mcp-Protocol-Version": "2025-06-18",
                  ...headers,
                },
              },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () =>
                  resolve({
                    status: response.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString("utf8"),
                  })
                );
              }
            );
            outgoing.on("error", reject);
            outgoing.end(body);
          }
        );

        expect(result.status).toBe(413);
        expect(JSON.parse(result.body)).toMatchObject({
          error: { code: -32600 },
        });
        expect(createServer).not.toHaveBeenCalled();
      } finally {
        await runtime.close({ gracePeriodMs: 100 });
      }
    }
  );

  it("rejects path, method, and authentication before server construction", async () => {
    const authenticate = vi.fn(() => IDENTITY);
    const createServer = vi.fn(emptyMcpServer);
    const { runtime, url } = await startRuntime(createServer, { authenticate });
    try {
      const wrongPath = new URL("/other", url);
      const notFound = await fetch(wrongPath, { method: "POST", body: "{not-json" });
      expect(notFound.status).toBe(404);

      const methodNotAllowed = await fetch(url, {
        method: "GET",
        headers: { authorization: AUTHORIZATION },
      });
      expect(methodNotAllowed.status).toBe(405);
      expect(methodNotAllowed.headers.get("allow")).toBe("POST");

      expect(authenticate).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();

      authenticate.mockImplementation(() => {
        throw new HttpAuthenticationError("forbidden");
      });
      const rejected = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("cache-control")).toBe("no-store");
      expect(await rejected.json()).toEqual({ error: "forbidden" });
      expect(createServer).not.toHaveBeenCalled();
    } finally {
      await runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("preserves duplicate Authorization fields so authentication fails closed", async () => {
    const authenticate = vi.fn((request: HttpAuthenticationRequest) => {
      expect(request.authorizationHeaders).toEqual([AUTHORIZATION, AUTHORIZATION]);
      throw new HttpAuthenticationError("unauthorized");
    });
    const createServer = vi.fn(emptyMcpServer);
    const { runtime, url } = await startRuntime(createServer, { authenticate });

    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = nodeHttpRequest(
          url,
          {
            method: "POST",
            headers: {
              Authorization: [AUTHORIZATION, AUTHORIZATION],
              "Content-Type": "application/json",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              })
            );
          }
        );
        outgoing.on("error", reject);
        outgoing.end("{}");
      });

      expect(result.status).toBe(401);
      expect(JSON.parse(result.body)).toEqual({ error: "unauthorized" });
      expect(authenticate).toHaveBeenCalledOnce();
      expect(createServer).not.toHaveBeenCalled();
    } finally {
      await runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("never adopts or closes an invalid factory return", async () => {
    const invalidClose = vi.fn(() => new Promise<never>(() => {}));
    const invalidCandidate = { close: invalidClose } as unknown as McpServer;
    const { runtime, url } = await startRuntime(() => invalidCandidate);

    const response = await rawMcpPost(
      url,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: -32603 } });
    expect(invalidClose).not.toHaveBeenCalled();

    const startedAt = performance.now();
    await runtime.close({ gracePeriodMs: 1_000 });
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(invalidClose).not.toHaveBeenCalled();
  });

  it("rejects an already-connected factory server without taking ownership", async () => {
    const connectedServer = await emptyMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await connectedServer.connect(serverTransport);
    const closeSpy = vi.spyOn(connectedServer, "close");
    const { runtime, url } = await startRuntime(() => connectedServer);

    try {
      const response = await rawMcpPost(
        url,
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: -32603 } });
      expect(closeSpy).not.toHaveBeenCalled();
      expect(connectedServer.isConnected()).toBe(true);

      await runtime.close({ gracePeriodMs: 100 });
      expect(closeSpy).not.toHaveBeenCalled();
      expect(connectedServer.isConnected()).toBe(true);
    } finally {
      await connectedServer.close();
      await clientTransport.close();
    }
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("drains an accepted request during the grace period", async () => {
    const entered = deferred();
    const release = deferred();
    const { runtime, url } = await startRuntime(async () =>
      createMcpServer({
        dependencies: {},
        register: (surface) => {
          surface.registerTool("sn_slow_probe", {}, async () => {
            entered.resolve();
            await release.promise;
            return { content: [{ type: "text", text: "drained" }] };
          });
        },
      })
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: AUTHORIZATION } },
    });
    const client = new Client({ name: "drain-test", version: "1.0.0" });

    await client.connect(transport);
    const call = client.callTool({ name: "sn_slow_probe", arguments: {} });
    await entered.promise;
    const closing = runtime.close({ gracePeriodMs: 1_000 });
    release.resolve();

    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "drained" }],
    });
    await expect(closing).resolves.toBeUndefined();
    await client.close();
  });

  it("forces sockets and resolves at the deadline when admission never settles", async () => {
    const entered = deferred();
    const cancelled = deferred();
    const authenticate = vi.fn(async (_request, signal?: AbortSignal) => {
      entered.resolve();
      signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
      await new Promise<never>(() => {});
      return IDENTITY;
    });
    const createServer = vi.fn(emptyMcpServer);
    const { runtime, url } = await startRuntime(createServer, { authenticate });
    const pendingFetch = fetch(url, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: "{}",
    });
    void pendingFetch.catch(() => {});
    await entered.promise;

    const startedAt = performance.now();
    await runtime.close({ gracePeriodMs: 20 });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(10);
    expect(elapsedMs).toBeLessThan(500);
    await expect(pendingFetch).rejects.toThrow();
    await cancelled.promise;
    expect(createServer).not.toHaveBeenCalled();
  });

  it("releases listeners across repeated forced-close lifecycles", async () => {
    const closedUrls: URL[] = [];
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const entered = deferred();
      const createServer = vi.fn(emptyMcpServer);
      const { runtime, url } = await startRuntime(createServer, {
        authenticate: async () => {
          entered.resolve();
          await new Promise<never>(() => {});
          return IDENTITY;
        },
      });
      const pendingFetch = fetch(url, {
        method: "POST",
        headers: authenticatedHeaders(),
        body: "{}",
      });
      void pendingFetch.catch(() => {});
      await entered.promise;

      await runtime.close({ gracePeriodMs: 5 });
      await expect(pendingFetch).rejects.toThrow();
      expect(createServer).not.toHaveBeenCalled();
      closedUrls.push(url);
    }

    for (const url of closedUrls) {
      await expect(fetch(url)).rejects.toThrow();
    }
  });

  it("continues forced cleanup when an active server close throws synchronously", async () => {
    const entered = deferred();
    const { runtime, url } = await startRuntime(async () => {
      const server = await createMcpServer({
        dependencies: {},
        register: (surface) => {
          surface.registerTool("sn_never_settles", {}, async () => {
            entered.resolve();
            await new Promise<never>(() => {});
            return { content: [{ type: "text", text: "unreachable" }] };
          });
        },
      });
      Object.defineProperty(server, "close", {
        configurable: true,
        value: () => {
          throw new Error("hostile synchronous close");
        },
      });
      return server;
    });
    const pendingFetch = rawMcpPost(
      url,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "sn_never_settles", arguments: {} },
      })
    );
    void pendingFetch.catch(() => {});
    await entered.promise;

    await expect(runtime.close({ gracePeriodMs: 5 })).resolves.toBeUndefined();
    await expect(pendingFetch).rejects.toThrow();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("publishes a bounded default shutdown contract", () => {
    expect(DEFAULT_HTTP_CLOSE_GRACE_PERIOD_MS).toBe(10_000);
    expect(DEFAULT_MAX_CONCURRENT_MCP_REQUESTS).toBe(2);
    expect(DEFAULT_MAX_HTTP_CONNECTIONS).toBe(128);
    expect(MAX_HTTP_CONNECTIONS).toBe(4_096);
    expect(MAX_REJECTED_BODY_DRAIN_BYTES).toBe(16 * 1024);
    expect(REJECTED_BODY_DRAIN_TIMEOUT_MS).toBe(100);
    expect(BODY_MEMORY_SAFETY_FACTOR).toBe(64);
    expect(RAW_RESPONSE_MEMORY_SAFETY_FACTOR).toBe(8);
    expect(MAX_ESTIMATED_CONCURRENT_BODY_MEMORY_BYTES).toBe(512 * 1024 * 1024);
    const defaultPerRequestEstimate =
      (1024 * 1024 + 1024 * 1024) * BODY_MEMORY_SAFETY_FACTOR +
      10 * 1024 * 1024 * RAW_RESPONSE_MEMORY_SAFETY_FACTOR;
    expect(defaultPerRequestEstimate).toBe(208 * 1024 * 1024);
    expect(defaultPerRequestEstimate * 2).toBe(416 * 1024 * 1024);
    expect(defaultPerRequestEstimate * 3).toBeGreaterThan(
      MAX_ESTIMATED_CONCURRENT_BODY_MEMORY_BYTES
    );
    expect(() =>
      createHttpRuntime({
        host: "bad host",
        port: 0,
        authenticationProvider: bearerProvider(),
        createServer: emptyMcpServer,
      })
    ).toThrow(/host/u);
    expect(() =>
      createHttpRuntime({
        port: 65_536,
        authenticationProvider: bearerProvider(),
        createServer: emptyMcpServer,
      })
    ).toThrow(/port/u);
    expect(() =>
      createHttpRuntime({
        maxConnections: 0,
        authenticationProvider: bearerProvider(),
        createServer: emptyMcpServer,
      })
    ).toThrow(/maxConnections/u);
    expect(() =>
      createHttpRuntime({
        maxConnections: MAX_HTTP_CONNECTIONS + 1,
        authenticationProvider: bearerProvider(),
        createServer: emptyMcpServer,
      })
    ).toThrow(/maxConnections/u);
    expect(() =>
      createHttpRuntime({
        maxConcurrentRequests: 0,
        authenticationProvider: bearerProvider(),
        createServer: emptyMcpServer,
      })
    ).toThrow(/maxConcurrentRequests/u);
    expect(() =>
      createHttpRuntime({
        maxConcurrentRequests: 2,
        authenticationProvider: bearerProvider(),
        createServer: emptyMcpServer,
      })
    ).not.toThrow();
    expect(() =>
      createHttpRuntime({
        maxConcurrentRequests: 3,
        authenticationProvider: bearerProvider(),
        createServer: emptyMcpServer,
      })
    ).toThrow(/estimated body-memory ceiling/u);
    expect(() =>
      createHttpRuntime({
        maxConcurrentRequests: 2,
        requestPolicy: createHttpRequestPolicy({
          maxBodyBytes: 2 * 1024 * 1024,
        }),
        authenticationProvider: bearerProvider(),
        createServer: emptyMcpServer,
      })
    ).toThrow(/estimated body-memory ceiling/u);
  });

  it("cancels hung authentication on disconnect and drains without waiting for its promise", async () => {
    const entered = deferred();
    const cancelled = deferred();
    const authenticationProvider: HttpAuthenticationProvider<HttpAuthenticationRequest> = {
      authenticate: (_request, signal) => {
        entered.resolve();
        signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
        return new Promise<never>(() => {});
      },
    };
    const { runtime, url } = await startRuntime(
      emptyMcpServer,
      authenticationProvider
    );
    const controller = new AbortController();
    const request = fetch(url, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: "{}",
      signal: controller.signal,
    });

    await entered.promise;
    controller.abort();
    await expect(request).rejects.toThrow();
    await cancelled.promise;
    const startedAt = performance.now();
    await runtime.close({ gracePeriodMs: 100 });
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("cancels a hung factory on disconnect and releases concurrency admission", async () => {
    const factoryEntered = deferred();
    const factoryCancelled = deferred();
    let cancellationReason: string | undefined;
    let first = true;
    const createServer = vi.fn((context: AuthenticatedHttpRequestContext) => {
      if (first) {
        first = false;
        factoryEntered.resolve();
        context.signal.addEventListener(
          "abort",
          () => {
            cancellationReason = requestCancellationAuditReason(context.signal);
            factoryCancelled.resolve();
          },
          { once: true }
        );
        return new Promise<McpServer>(() => {});
      }
      return emptyMcpServer();
    });
    const { runtime, url } = await startRuntime(
      createServer,
      bearerProvider(),
      { maxConcurrentRequests: 1 }
    );
    const controller = new AbortController();
    const firstRequest = fetch(url, {
      method: "POST",
      headers: authenticatedHeaders({ "mcp-protocol-version": "2025-06-18" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: controller.signal,
    });
    await factoryEntered.promise;

    const rejected = await rawMcpPost(
      url,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    );
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect(rejected.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(createServer).toHaveBeenCalledOnce();

    controller.abort();
    await expect(firstRequest).rejects.toThrow();
    await factoryCancelled.promise;
    expect(cancellationReason).toBe("request_cancelled");
    const accepted = await rawMcpPost(
      url,
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    );
    expect(accepted.status).toBe(200);
    expect(createServer).toHaveBeenCalledTimes(2);
    await runtime.close({ gracePeriodMs: 100 });
  });

  it("adopts and closes an unconnected server returned after factory cancellation", async () => {
    const factoryEntered = deferred();
    const lateResult = deferred<McpServer>();
    const { runtime, url } = await startRuntime(() => {
      factoryEntered.resolve();
      return lateResult.promise;
    });
    const controller = new AbortController();
    const request = fetch(url, {
      method: "POST",
      headers: authenticatedHeaders({ "mcp-protocol-version": "2025-06-18" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 77, method: "tools/list" }),
      signal: controller.signal,
    });
    await factoryEntered.promise;
    controller.abort();
    await expect(request).rejects.toThrow();

    const lateServer = await emptyMcpServer();
    const closeSpy = vi.spyOn(lateServer, "close");
    lateResult.resolve(lateServer);
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledOnce());
    expect(lateServer.isConnected()).toBe(false);
    await runtime.close({ gracePeriodMs: 100 });
  });

  it("retains a failed late close and retries it during shutdown", async () => {
    const factoryEntered = deferred();
    const lateResult = deferred<McpServer>();
    const { runtime, url } = await startRuntime(() => {
      factoryEntered.resolve();
      return lateResult.promise;
    });
    const controller = new AbortController();
    const request = fetch(url, {
      method: "POST",
      headers: authenticatedHeaders({ "mcp-protocol-version": "2025-06-18" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 78, method: "tools/list" }),
      signal: controller.signal,
    });
    await factoryEntered.promise;
    controller.abort();
    await expect(request).rejects.toThrow();

    const lateServer = await emptyMcpServer();
    const closeSpy = vi
      .spyOn(lateServer, "close")
      .mockRejectedValueOnce(new Error("first late close failed"))
      .mockResolvedValueOnce();
    lateResult.resolve(lateServer);
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledOnce());

    await runtime.close({ gracePeriodMs: 100 });
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  it("releases concurrency admission exactly once after the request deadline", async () => {
    let authenticationCalls = 0;
    let deadlineReason: string | undefined;
    const authenticationProvider: HttpAuthenticationProvider<HttpAuthenticationRequest> = {
      authenticate: (_request, signal) => {
        authenticationCalls += 1;
        if (authenticationCalls === 1) {
          signal?.addEventListener(
            "abort",
            () => {
              deadlineReason = requestCancellationAuditReason(signal);
            },
            { once: true }
          );
        }
        return authenticationCalls === 1
          ? new Promise<never>(() => {})
          : IDENTITY;
      },
    };
    const { runtime, url } = await startRuntime(
      emptyMcpServer,
      authenticationProvider,
      {
        maxConcurrentRequests: 1,
        requestPolicy: createHttpRequestPolicy({
          requestDeadlineMs: 25,
          headersTimeoutMs: 100,
          requestTimeoutMs: 200,
        }),
      }
    );

    const timedOut = await rawMcpPost(url, "{}");
    expect(timedOut.status).toBe(408);
    expect(timedOut.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    const accepted = await rawMcpPost(
      url,
      JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" })
    );
    expect(accepted.status).toBe(200);
    expect(authenticationCalls).toBe(2);
    expect(deadlineReason).toBe("request_deadline_exceeded");
    await runtime.close({ gracePeriodMs: 100 });
  });

  it("cancels a hung tool on disconnect and bounds forced shutdown", async () => {
    const toolEntered = deferred();
    const toolCancelled = deferred();
    const { runtime, url } = await startRuntime((context) =>
      createMcpServer({
        dependencies: {},
        register: (surface) => {
          surface.registerTool("sn_hung", {}, async () => {
            toolEntered.resolve();
            await new Promise<never>((_resolve, reject) => {
              context.signal.addEventListener(
                "abort",
                () => {
                  toolCancelled.resolve();
                  reject(context.signal.reason);
                },
                { once: true }
              );
            });
            return { content: [{ type: "text", text: "unreachable" }] };
          });
        },
      })
    );
    const controller = new AbortController();
    const request = fetch(url, {
      method: "POST",
      headers: authenticatedHeaders({ "mcp-protocol-version": "2025-06-18" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "sn_hung", arguments: {} },
      }),
      signal: controller.signal,
    });
    await toolEntered.promise;
    controller.abort();
    await expect(request).rejects.toThrow();
    await toolCancelled.promise;

    const startedAt = performance.now();
    await runtime.close({ gracePeriodMs: 20 });
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
