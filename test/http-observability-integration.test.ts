import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { StaticBearerAuthenticationProvider } from "../src/http-auth.js";
import {
  createHttpObservability,
  createHttpRateLimiter,
  type HttpObservability,
  type StructuredHttpEvent,
} from "../src/http-observability.js";
import { createHttpRuntime, type HttpRuntime } from "../src/http-runtime.js";
import { createMcpServer } from "../src/server.js";

const TOKEN = "snsdk-26-integration-token-long-enough";
const IDENTITY = { ownerId: "configured-owner", clientId: "configured-client" };
const openRuntimes: HttpRuntime[] = [];

function authenticationProvider() {
  return new StaticBearerAuthenticationProvider([
    { token: TOKEN, ...IDENTITY },
  ]);
}

function observabilityHarness() {
  const events: StructuredHttpEvent[] = [];
  return {
    events,
    observability: createHttpObservability({
      sink: { write: (event) => events.push(event) },
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    openRuntimes.splice(0).map((runtime) =>
      runtime.close({ gracePeriodMs: 100 })
    )
  );
});

describe("SNSDK-26 HTTP runtime wiring", () => {
  it("classifies admission pressure and client disconnect without internal errors", async () => {
    const observed = observabilityHarness();
    let markAuthenticationEntered!: () => void;
    const authenticationEntered = new Promise<void>((resolve) => {
      markAuthenticationEntered = resolve;
    });
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      maxConcurrentRequests: 1,
      authenticationProvider: {
        authenticate: () => {
          markAuthenticationEntered();
          return new Promise<never>(() => {});
        },
      },
      observability: observed.observability,
      createServer: () => {
        throw new Error("hung authentication must not construct a server");
      },
    });
    openRuntimes.push(runtime);
    const address = await runtime.start();
    const controller = new AbortController();
    const first = fetch(address.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    await authenticationEntered;

    const limited = await fetch(address.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(limited.status).toBe(503);
    expect(limited.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);

    controller.abort();
    await expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(observed.events).toHaveLength(2));
    expect(observed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "http_request",
          outcome: "rejected",
          reason: "concurrency_limited",
          statusCode: 503,
        }),
        expect.objectContaining({
          type: "http_request",
          outcome: "rejected",
          reason: "client_disconnected",
          statusCode: 499,
        }),
      ])
    );
    expect(observed.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "internal_error" }),
      ])
    );
  });

  it.each(["throws synchronously", "returns a rejected thenable"] as const)(
    "keeps HTTP responses and the runtime stable when request observation finish %s",
    async (failureMode) => {
      const finish = vi.fn(() => {
        if (failureMode === "throws synchronously") {
          throw new Error("hostile synchronous observation failure");
        }
        return Promise.reject(new Error("hostile asynchronous observation failure"));
      });
      const observability = {
        beginRequest: () => ({ finish }),
        beginTool: () => ({ finish: () => undefined }),
      } as unknown as HttpObservability;
      const runtime = createHttpRuntime({
        host: "127.0.0.1",
        port: 0,
        authenticationProvider: authenticationProvider(),
        readinessCheck: () => true,
        observability,
        createServer: () => {
          throw new Error("health requests must not construct an MCP server");
        },
      });
      openRuntimes.push(runtime);
      const address = await runtime.start();

      const first = await fetch(new URL("/health/live", address.url));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ status: "live" });

      // A rejected thenable is handled asynchronously. Yield once so Vitest
      // observes any accidental unhandled rejection before the second probe.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const second = await fetch(new URL("/health/ready", address.url));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ status: "ready" });
      expect(finish).toHaveBeenCalledTimes(2);
    }
  );

  it("emits one safe correlated event for every health, routing, and auth response", async () => {
    const observed = observabilityHarness();
    const createServer = vi.fn(() => {
      throw new Error("server factory must not run");
    });
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: authenticationProvider(),
      readinessCheck: () => true,
      observability: observed.observability,
      createServer,
    });
    openRuntimes.push(runtime);
    const address = await runtime.start();

    const [live, missing, unauthorized] = await Promise.all([
      fetch(new URL("/health/live", address.url)),
      fetch(new URL("/missing", address.url)),
      fetch(address.url, { method: "POST", body: "{}" }),
    ]);

    expect([live.status, missing.status, unauthorized.status]).toEqual([
      200, 404, 401,
    ]);
    expect(createServer).not.toHaveBeenCalled();
    expect(observed.events).toHaveLength(3);
    expect(observed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "http_request",
          outcome: "success",
          reason: null,
          statusCode: 200,
        }),
        expect.objectContaining({
          type: "http_request",
          outcome: "rejected",
          reason: "not_found",
          statusCode: 404,
        }),
        expect.objectContaining({
          type: "http_request",
          outcome: "rejected",
          reason: "unauthorized",
          statusCode: 401,
        }),
      ])
    );
    for (const event of observed.events) {
      expect(event.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(Object.isFrozen(event)).toBe(true);
    }
    const serialized = JSON.stringify(observed.events);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(IDENTITY.ownerId);
    expect(serialized).not.toContain(IDENTITY.clientId);
  });

  it("rate-limits a pre-auth source before authentication or server creation", async () => {
    const authenticate = vi.fn(() => {
      throw new Error("invalid bearer");
    });
    const createServer = vi.fn(() => {
      throw new Error("server factory must not run");
    });
    const observed = observabilityHarness();
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: { authenticate },
      observability: observed.observability,
      rateLimiter: createHttpRateLimiter({
        preAuthentication: {
          capacity: 1,
          refillPeriodMs: 60_000,
          maxEntries: 4,
        },
        authenticatedIdentity: {
          capacity: 10,
          refillPeriodMs: 60_000,
          maxEntries: 4,
        },
      }),
      createServer,
    });
    openRuntimes.push(runtime);
    const address = await runtime.start();

    const first = await fetch(address.url, { method: "POST", body: "{}" });
    const second = await fetch(address.url, { method: "POST", body: "{}" });
    const live = await fetch(new URL("/health/live", address.url));

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "live" });
    expect(second.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(await second.json()).toEqual({
      error: "rate_limited",
      message:
        "Rate limited. Retry after the number of seconds in retry_after_seconds or the Retry-After header.",
      retry_after_seconds: Number(second.headers.get("retry-after")),
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(createServer).not.toHaveBeenCalled();
    expect(
      observed.events.find(
        (event) =>
          event.type === "http_request" &&
          event.reason === "pre_auth_rate_limited"
      )
    ).toMatchObject({
      type: "http_request",
      outcome: "rejected",
      reason: "pre_auth_rate_limited",
      statusCode: 429,
      ownerIdHash: null,
      clientIdHash: null,
    });
  });

  it("fails closed when an authenticated limiter returns a malformed decision", async () => {
    const createServer = vi.fn(() => {
      throw new Error("server factory must not run");
    });
    const observed = observabilityHarness();
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: authenticationProvider(),
      observability: observed.observability,
      rateLimiter: {
        checkPreAuthentication: () => ({
          allowed: true,
          scope: "pre_auth_source",
          limit: 1,
          remaining: 0,
          reason: null,
          retryAfterSeconds: null,
        }),
        checkAuthenticated: () => null as never,
      },
      createServer,
    });
    openRuntimes.push(runtime);
    const address = await runtime.start();

    const response = await fetch(address.url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "{}",
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "rate_limited",
      message:
        "Rate limited. Retry after the number of seconds in retry_after_seconds or the Retry-After header.",
      retry_after_seconds: Number(response.headers.get("retry-after")),
    });
    expect(createServer).not.toHaveBeenCalled();
    expect(observed.events.at(-1)).toMatchObject({
      type: "http_request",
      outcome: "rejected",
      reason: "identity_rate_limited",
      statusCode: 429,
    });
  });

  it("rate-limits an authenticated identity before MCP server construction", async () => {
    const createServer = vi.fn(() => {
      throw new Error("bounded factory failure");
    });
    const observed = observabilityHarness();
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: authenticationProvider(),
      observability: observed.observability,
      rateLimiter: createHttpRateLimiter({
        preAuthentication: {
          capacity: 10,
          refillPeriodMs: 60_000,
          maxEntries: 4,
        },
        authenticatedIdentity: {
          capacity: 1,
          refillPeriodMs: 60_000,
          maxEntries: 4,
        },
      }),
      createServer,
    });
    openRuntimes.push(runtime);
    const address = await runtime.start();
    const headers = { authorization: `Bearer ${TOKEN}` };

    const first = await fetch(address.url, {
      method: "POST",
      headers,
      body: "{}",
    });
    const second = await fetch(address.url, {
      method: "POST",
      headers,
      body: "{}",
    });

    // Fetch assigns text/plain;charset=UTF-8 when a string body has no
    // explicit media type. SNSDK-24 rejects it after authenticated limiting
    // but before MCP server construction.
    expect(first.status).toBe(415);
    expect(second.status).toBe(429);
    expect(createServer).not.toHaveBeenCalled();
    expect(observed.events.at(-2)).toMatchObject({
      type: "http_request",
      outcome: "rejected",
      reason: "invalid_content_type",
      statusCode: 415,
    });
    expect(observed.events.at(-1)).toMatchObject({
      type: "http_request",
      outcome: "rejected",
      reason: "identity_rate_limited",
      statusCode: 429,
      ownerIdHash: expect.stringMatching(/^sha256:/u),
      clientIdHash: expect.stringMatching(/^sha256:/u),
    });
    expect(JSON.stringify(observed.events)).not.toContain(TOKEN);
  });

  it("records SDK input rejection as one correlated rejected tool call", async () => {
    const observed = observabilityHarness();
    const runtime = createHttpRuntime({
      host: "127.0.0.1",
      port: 0,
      authenticationProvider: authenticationProvider(),
      observability: observed.observability,
      createServer: () =>
        createMcpServer({
          dependencies: {},
          register: (surface) => {
            surface.registerTool(
              "sn_validation_probe",
              { inputSchema: { profile: z.string().min(1) } },
              async () => ({ content: [{ type: "text", text: "unexpected" }] })
            );
          },
        }),
    });
    openRuntimes.push(runtime);
    const address = await runtime.start();
    const transport = new StreamableHTTPClientTransport(address.url, {
      requestInit: {
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    });
    const client = new Client({ name: "validation-audit-client", version: "1.0.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "sn_validation_probe",
        arguments: {},
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }

    const toolEvents = observed.events.filter((event) => event.type === "mcp_tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({
      tool: "sn_validation_probe",
      outcome: "context_rejected",
      reason: "input_validation_failed",
      profile: null,
      instance: null,
    });
    const rejectedRequest = observed.events.find(
      (event) =>
        event.type === "http_request" && event.reason === "tool_input_rejected"
    );
    expect(rejectedRequest).toMatchObject({
      outcome: "rejected",
      statusCode: 200,
    });
    expect(toolEvents[0].correlationId).toContain(
      rejectedRequest?.correlationId ?? "missing-request-correlation"
    );
  });
});
