import { Agent, request as nodeHttpRequest } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import {
  createHttpRequestPolicy,
  httpRequestPolicyLimits,
  INTERNAL_HEALTHCHECK_AUTHORITY,
  inspectHttpRequest,
  type HttpRequestPolicy,
  type HttpRequestPolicyInput,
} from "../src/http-request-policy.js";
import {
  createHttpRuntime,
  type AuthenticatedHttpRequestContext,
  type HttpRuntime,
} from "../src/http-runtime.js";
import type {
  HttpObservability,
  HttpRateLimiter,
} from "../src/http-observability.js";
import { createMcpServer } from "../src/server.js";

const DEFAULT_INPUT: HttpRequestPolicyInput = Object.freeze({
  rawHeaders: Object.freeze([
    "Host",
    "127.0.0.1:3000",
    "Content-Type",
    "application/json",
  ]),
  method: "POST",
  pathname: "/mcp",
  configuredHost: "127.0.0.1",
  localAddress: "127.0.0.1",
  localPort: 3000,
});
const TOKEN = "snsdk-24-request-policy-token-01234567890123456789";
const AUTHORIZATION = `Bearer ${TOKEN}`;

function inspect(
  rawHeaders: readonly string[],
  overrides: Partial<HttpRequestPolicyInput> = {},
  policy = createHttpRequestPolicy()
) {
  return inspectHttpRequest(policy, {
    ...DEFAULT_INPUT,
    rawHeaders,
    ...overrides,
  });
}

describe("SNSDK-24 HTTP request policy", () => {
  it("allows exact loopback authorities and absent browser Origin", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000"]) {
      const decision = inspect(["Host", host, "Content-Type", "application/json"]);
      expect(decision).toEqual({ kind: "allow", responseHeaders: {} });
    }
  });

  it.each([
    [[], 400, "invalid_host"],
    [["Host", "127.0.0.1:3000", "Host", "localhost:3000"], 400, "invalid_host"],
    [["Host", " user@example.test"], 400, "invalid_host"],
    [["Host", "127.0.0.1:abc"], 400, "invalid_host"],
    [["Host", "example.test:3000"], 421, "disallowed_host"],
    [["Host", "127.0.0.1:4444"], 421, "disallowed_host"],
  ])("rejects missing, duplicate, malformed, or disallowed Host %#", (headers, status, reason) => {
    expect(inspect(headers as string[], { method: undefined })).toMatchObject({
      kind: "reject",
      status,
      reason,
    });
  });

  it("supports exact deployment Host authorities without wildcard matching", () => {
    const policy = createHttpRequestPolicy({
      allowedHosts: ["mcp.internal.example:443"],
    });
    expect(
      inspect(
        ["Host", "mcp.internal.example:443", "Content-Type", "application/json"],
        {},
        policy
      ).kind
    ).toBe("allow");
    expect(
      inspect(
        ["Host", "sub.mcp.internal.example:443", "Content-Type", "application/json"],
        {},
        policy
      )
    ).toMatchObject({ kind: "reject", status: 421 });
  });

  it("admits the reserved health authority only for loopback lifecycle probes", () => {
    const policy = createHttpRequestPolicy({
      allowedHosts: ["mcp.internal.example:443"],
    });
    expect(
      inspect(
        ["Host", INTERNAL_HEALTHCHECK_AUTHORITY],
        {
          method: undefined,
          pathname: "/health/ready",
          remoteAddress: "127.0.0.1",
        },
        policy
      ).kind
    ).toBe("allow");
    for (const overrides of [
      { pathname: "/mcp", remoteAddress: "127.0.0.1" },
      { pathname: "/health/ready", remoteAddress: "192.0.2.10" },
      { pathname: "/health/ready", remoteAddress: undefined },
    ]) {
      expect(
        inspect(
          ["Host", INTERNAL_HEALTHCHECK_AUTHORITY],
          { method: undefined, ...overrides },
          policy
        )
      ).toMatchObject({ kind: "reject", status: 421, reason: "disallowed_host" });
    }
    expect(
      inspect(
        ["Host", "mcp.internal.example:443"],
        { method: undefined, pathname: "/health/ready", remoteAddress: "192.0.2.10" },
        policy
      ).kind
    ).toBe("allow");
  });

  it("preserves explicit default and non-default Host ports exactly", () => {
    const httpPolicy = createHttpRequestPolicy({
      allowedHosts: ["mcp.internal.example:80"],
    });
    expect(
      inspect(
        ["Host", "mcp.internal.example:80", "Content-Type", "application/json"],
        { localPort: 80 },
        httpPolicy
      ).kind
    ).toBe("allow");
    expect(
      inspect(
        ["Host", "mcp.internal.example:3000", "Content-Type", "application/json"],
        { localPort: 3000 },
        httpPolicy
      )
    ).toMatchObject({ kind: "reject", status: 421 });

    const tlsProxyPolicy = createHttpRequestPolicy({
      allowedHosts: ["mcp.internal.example:443"],
    });
    expect(
      inspect(
        ["Host", "mcp.internal.example:443", "Content-Type", "application/json"],
        { localPort: 443 },
        tlsProxyPolicy
      ).kind
    ).toBe("allow");
    expect(
      inspect(
        ["Host", "mcp.internal.example:80", "Content-Type", "application/json"],
        { localPort: 80 },
        tlsProxyPolicy
      )
    ).toMatchObject({ kind: "reject", status: 421 });
  });

  it("denies unconfigured, duplicate, null, and malformed Origins", () => {
    expect(
      inspect([
        "Host",
        "127.0.0.1:3000",
        "Origin",
        "https://client.example",
      ], { method: undefined })
    ).toMatchObject({ kind: "reject", status: 403, reason: "disallowed_origin" });
    expect(
      inspect([
        "Host",
        "127.0.0.1:3000",
        "Origin",
        "https://one.example",
        "Origin",
        "https://two.example",
      ], { method: undefined })
    ).toMatchObject({ kind: "reject", status: 400, reason: "invalid_origin" });
    for (const origin of ["null", "https://client.example/path", " https://client.example"]) {
      expect(
        inspect(["Host", "127.0.0.1:3000", "Origin", origin], {
          method: undefined,
        })
      ).toMatchObject({ kind: "reject", status: 400, reason: "invalid_origin" });
    }
  });

  it("returns exact non-reflective CORS headers only for configured Origins", () => {
    const policy = createHttpRequestPolicy({
      allowedOrigins: ["https://client.example"],
    });
    const decision = inspect(
      [
        "Host",
        "127.0.0.1:3000",
        "Origin",
        "https://client.example",
        "Content-Type",
        "application/json",
      ],
      {},
      policy
    );
    expect(decision).toMatchObject({
      kind: "allow",
      responseHeaders: {
        "access-control-allow-origin": "https://client.example",
        vary: "Origin",
      },
    });
  });

  it("accepts only configured POST preflights and the fixed MCP header set", () => {
    const policy = createHttpRequestPolicy({
      allowedOrigins: ["https://client.example"],
    });
    const headers = [
      "Host",
      "127.0.0.1:3000",
      "Origin",
      "https://client.example",
      "Access-Control-Request-Method",
      "POST",
      "Access-Control-Request-Headers",
      "authorization, content-type, mcp-protocol-version",
    ];
    expect(inspect(headers, { method: "OPTIONS" }, policy)).toMatchObject({
      kind: "preflight",
      status: 204,
      responseHeaders: {
        "access-control-allow-origin": "https://client.example",
        "access-control-allow-methods": "POST",
      },
    });
    expect(
      inspect(
        headers.map((value) => (value === "POST" ? "DELETE" : value)),
        { method: "OPTIONS" },
        policy
      )
    ).toMatchObject({ kind: "reject", status: 403, reason: "invalid_preflight" });
    expect(
      inspect(
        headers.map((value) =>
          value.includes("authorization") ? `${value}, x-unapproved` : value
        ),
        { method: "OPTIONS" },
        policy
      )
    ).toMatchObject({ kind: "reject", status: 403, reason: "invalid_preflight" });
  });

  it.each([
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    'application/json; charset="utf-8"',
  ])("accepts the supported JSON media type %s", (contentType) => {
    expect(
      inspect(["Host", "127.0.0.1:3000", "Content-Type", contentType]).kind
    ).toBe("allow");
  });

  it.each([
    undefined,
    "text/plain",
    "application/json, text/plain",
    "application/json; charset=latin1",
    "application/json; charset=utf-8; profile=x",
  ])("rejects unsupported or missing content type %s", (contentType) => {
    const headers = ["Host", "127.0.0.1:3000"];
    if (contentType !== undefined) headers.push("Content-Type", contentType);
    expect(inspect(headers)).toMatchObject({
      kind: "reject",
      status: 415,
      reason: "invalid_content_type",
    });
  });

  it("rejects duplicate media types and oversized declared bodies", () => {
    expect(
      inspect([
        "Host",
        "127.0.0.1:3000",
        "Content-Type",
        "application/json",
        "Content-Type",
        "application/json",
      ])
    ).toMatchObject({ kind: "reject", status: 415 });
    expect(
      inspect([
        "Host",
        "127.0.0.1:3000",
        "Content-Type",
        "application/json",
        "Content-Length",
        String(1024 * 1024 + 1),
      ])
    ).toMatchObject({ kind: "reject", status: 413, reason: "request_too_large" });
  });

  it("validates all injected bounds and snapshots them", () => {
    const policy = createHttpRequestPolicy({
      maxBodyBytes: 1024,
      bodyReadTimeoutMs: 50,
      requestDeadlineMs: 100,
      headersTimeoutMs: 25,
      requestTimeoutMs: 50,
      keepAliveTimeoutMs: 10,
    });
    expect(httpRequestPolicyLimits(policy)).toEqual({
      maxBodyBytes: 1024,
      bodyReadTimeoutMs: 50,
      requestDeadlineMs: 100,
      headersTimeoutMs: 25,
      requestTimeoutMs: 50,
      keepAliveTimeoutMs: 10,
    });
    expect(() =>
      createHttpRequestPolicy({ headersTimeoutMs: 101, requestTimeoutMs: 100 })
    ).toThrow(/headersTimeoutMs/u);
  });

  it("fails closed when an injected policy throws or returns a malformed decision", () => {
    const limits = createHttpRequestPolicy().limits;
    for (const policy of [
      { limits, inspect: () => { throw new Error("secret detail"); } },
      { limits, inspect: () => ({ kind: "allow", responseHeaders: { bad: "x\nleak" } }) },
      {
        limits,
        inspect: () => ({
          kind: "reject",
          status: 403,
          reason: "provider-secret-detail",
          responseHeaders: {},
        }),
      },
      {
        limits,
        inspect: () => ({
          kind: "reject",
          status: 400,
          reason: "disallowed_origin",
          responseHeaders: {},
        }),
      },
    ] as unknown as HttpRequestPolicy[]) {
      expect(inspectHttpRequest(policy, DEFAULT_INPUT)).toEqual({
        kind: "reject",
        status: 400,
        reason: "invalid_host",
        responseHeaders: {},
      });
    }
  });
});

async function emptyMcpServer(): Promise<McpServer> {
  return createMcpServer({ dependencies: {}, register: () => {} });
}

async function startPolicyRuntime(options: {
  readonly policy?: HttpRequestPolicy;
  readonly authenticate?: () => { ownerId: string; clientId: string } | Promise<{ ownerId: string; clientId: string }>;
  readonly createServer?: (
    context: AuthenticatedHttpRequestContext
  ) => McpServer | Promise<McpServer>;
  readonly observability?: HttpObservability;
  readonly rateLimiter?: HttpRateLimiter;
  readonly maxConnections?: number;
} = {}): Promise<{
  readonly runtime: HttpRuntime;
  readonly url: URL;
  readonly authenticate: ReturnType<typeof vi.fn>;
  readonly createServer: ReturnType<typeof vi.fn>;
}> {
  const authenticate = vi.fn(
    options.authenticate ?? (() => ({ ownerId: "snsdk-24-owner", clientId: "snsdk-24-client" }))
  );
  const createServer = vi.fn(options.createServer ?? emptyMcpServer);
  const runtime = createHttpRuntime({
    host: "127.0.0.1",
    port: 0,
    authenticationProvider: { authenticate },
    requestPolicy: options.policy ?? createHttpRequestPolicy(),
    observability: options.observability,
    rateLimiter: options.rateLimiter,
    maxConnections: options.maxConnections,
    createServer,
  });
  const { url } = await runtime.start();
  return { runtime, url, authenticate, createServer };
}

function validPostHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: AUTHORIZATION,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
    ...extra,
  };
}

async function rawTcpExchange(
  url: URL,
  fragments: readonly { readonly data: string | Buffer; readonly delayMs?: number }[],
  endAfterWrites = false
): Promise<string> {
  const port = Number(url.port);
  return new Promise<string>((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.setTimeout(2_000, () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("raw HTTP exchange timed out"));
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("connect", () => {
      void (async () => {
        for (const fragment of fragments) {
          if (fragment.delayMs) {
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, fragment.delayMs)
            );
          }
          if (!socket.destroyed) socket.write(fragment.data);
        }
        if (endAfterWrites && !socket.destroyed) socket.end();
      })().catch(reject);
    });
  });
}

function responseStatus(raw: string): number {
  const match = /^HTTP\/1\.1 (\d{3})/u.exec(raw);
  if (!match) throw new Error(`missing HTTP status in ${JSON.stringify(raw)}`);
  return Number(match[1]);
}

async function openPartialSocket(url: URL, data: string): Promise<Socket> {
  const socket = connectTcp({ host: "127.0.0.1", port: Number(url.port) });
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(data);
  return socket;
}

async function keepAliveMcpPost(
  url: URL,
  agent: Agent,
  id: number
): Promise<{ readonly status: number; readonly localPort: number | undefined }> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {},
  });
  return new Promise((resolve, reject) => {
    let localPort: number | undefined;
    const outgoing = nodeHttpRequest(
      url,
      {
        method: "POST",
        agent,
        headers: {
          authorization: AUTHORIZATION,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, localPort })
        );
      }
    );
    outgoing.once("socket", (socket) => {
      localPort = socket.localPort;
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

describe("SNSDK-24 HTTP runtime request boundary", () => {
  it("keeps the runtime correlation header authoritative over injected policy headers", async () => {
    const limits = createHttpRequestPolicy().limits;
    const policy: HttpRequestPolicy = {
      limits,
      inspect: () => ({
        kind: "allow",
        responseHeaders: { "x-request-id": "policy-controlled-value" },
      }),
    };
    const harness = await startPolicyRuntime({ policy });
    try {
      const response = await fetch(harness.url, {
        method: "POST",
        headers: validPostHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
      expect(response.headers.get("x-request-id")).not.toBe(
        "policy-controlled-value"
      );
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it.each([
    ["duplicate Host", (port: string) => `Host: 127.0.0.1:${port}\r\nHost: localhost:${port}\r\n`, 400],
    ["disallowed Host", (_port: string) => "Host: attacker.example\r\n", 421],
    [
      "duplicate Origin",
      (port: string) =>
        `Host: 127.0.0.1:${port}\r\nOrigin: https://one.example\r\nOrigin: https://two.example\r\n`,
      400,
    ],
  ])("rejects %s before authentication or server construction", async (_name, authority, expected) => {
    const harness = await startPolicyRuntime();
    try {
      const raw = await rawTcpExchange(
        harness.url,
        [
          {
            data:
              `POST /mcp HTTP/1.1\r\n${authority(harness.url.port)}` +
              "Authorization: Bearer never-inspected\r\n" +
              "Content-Type: application/json\r\n" +
              "Content-Length: 2\r\n" +
              "Connection: close\r\n\r\n{}",
          },
        ],
        true
      );
      expect(responseStatus(raw)).toBe(expected);
      expect(harness.authenticate).not.toHaveBeenCalled();
      expect(harness.createServer).not.toHaveBeenCalled();
      expect(raw).not.toContain("attacker.example");
      expect(raw).not.toContain("never-inspected");
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("bounds incomplete TCP admission while preserving keep-alive clients and shutdown", async () => {
    const harness = await startPolicyRuntime({ maxConnections: 4 });
    const sockets: Socket[] = [];
    const baselineHandles = process._getActiveHandles().length;
    const baselineHeap = process.memoryUsage().heapUsed;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let index = 0; index < 12; index++) {
        sockets.push(
          await openPartialSocket(
            harness.url,
            `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${harness.url.port}\r\nX-Stall-${index}: `
          )
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));

      const retained = sockets.filter((socket) => !socket.destroyed);
      expect(retained.length).toBeGreaterThan(0);
      expect(retained.length).toBeLessThanOrEqual(4);
      expect(process._getActiveHandles().length - baselineHandles).toBeLessThanOrEqual(
        12
      );
      expect(process.memoryUsage().heapUsed - baselineHeap).toBeLessThan(
        32 * 1024 * 1024
      );

      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const first = await keepAliveMcpPost(harness.url, agent, 1);
      const second = await keepAliveMcpPost(harness.url, agent, 2);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.localPort).toBeDefined();
      expect(second.localPort).toBe(first.localPort);

      sockets.push(
        await openPartialSocket(
          harness.url,
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${harness.url.port}\r\nX-Shutdown: `
        )
      );
      await harness.runtime.close({ gracePeriodMs: 0 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    } finally {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await harness.runtime.close({ gracePeriodMs: 0 }).catch(() => {});
    }
  });

  it("closes stalled rejected bodies after a bounded drain for every pre-body boundary", async () => {
    const deniedDecision = Object.freeze({
      allowed: false as const,
      scope: "pre_auth_source" as const,
      limit: 1,
      remaining: 0 as const,
      reason: "rate_limited" as const,
      retryAfterSeconds: 1,
    });
    const denyAllLimiter: HttpRateLimiter = Object.freeze({
      checkPreAuthentication: () => deniedDecision,
      checkAuthenticated: () => ({
        ...deniedDecision,
        scope: "authenticated_identity" as const,
      }),
    });
    const cases = [
      {
        name: "unauthorized",
        status: 401,
        options: { authenticate: async () => Promise.reject(new Error("denied")) },
        host: (port: string) => `127.0.0.1:${port}`,
        contentType: "application/json",
      },
      {
        name: "rate limited",
        status: 429,
        options: { rateLimiter: denyAllLimiter },
        host: (port: string) => `127.0.0.1:${port}`,
        contentType: "application/json",
      },
      {
        name: "invalid content type",
        status: 415,
        options: {},
        host: (port: string) => `127.0.0.1:${port}`,
        contentType: "text/plain",
      },
      {
        name: "invalid Host",
        status: 421,
        options: {},
        host: () => "attacker.example",
        contentType: "application/json",
      },
    ] as const;

    for (const probe of cases) {
      const harness = await startPolicyRuntime(probe.options);
      try {
        const startedAt = performance.now();
        const raw = await rawTcpExchange(harness.url, [
          {
            data:
              `POST /mcp HTTP/1.1\r\nHost: ${probe.host(harness.url.port)}\r\n` +
              `Authorization: ${AUTHORIZATION}\r\n` +
              `Content-Type: ${probe.contentType}\r\n` +
              "Content-Length: 1048576\r\nConnection: keep-alive\r\n\r\n{",
          },
        ]);
        expect(responseStatus(raw), probe.name).toBe(probe.status);
        expect(performance.now() - startedAt, probe.name).toBeLessThan(500);
        expect(harness.createServer, probe.name).not.toHaveBeenCalled();
      } finally {
        await harness.runtime.close({ gracePeriodMs: 0 }).catch(() => {});
      }
    }
  });

  it("allows non-browser requests without Origin and rejects unconfigured browser Origins", async () => {
    const harness = await startPolicyRuntime();
    try {
      const accepted = await fetch(harness.url, {
        method: "POST",
        headers: validPostHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(accepted.status).toBe(200);

      const rejected = await fetch(harness.url, {
        method: "POST",
        headers: validPostHeaders({ origin: "https://unconfigured.example" }),
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
      expect(harness.authenticate).toHaveBeenCalledTimes(1);
      expect(harness.createServer).toHaveBeenCalledTimes(1);
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("serves exact-origin restrictive preflight without authenticating", async () => {
    const policy = createHttpRequestPolicy({
      allowedOrigins: ["https://client.example"],
    });
    const harness = await startPolicyRuntime({ policy });
    try {
      const response = await fetch(harness.url, {
        method: "OPTIONS",
        headers: {
          origin: "https://client.example",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization, content-type, mcp-protocol-version",
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://client.example"
      );
      expect(response.headers.get("access-control-allow-methods")).toBe("POST");
      expect(response.headers.get("vary")).toBe("Origin");
      expect(response.headers.get("access-control-expose-headers")).toContain(
        "X-Request-Id"
      );
      expect(response.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/u
      );
      expect(await response.text()).toBe("");
      expect(harness.authenticate).not.toHaveBeenCalled();
      expect(harness.createServer).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("returns a deterministic 408 for a slow body and never constructs a server", async () => {
    const policy = createHttpRequestPolicy({
      bodyReadTimeoutMs: 25,
      requestDeadlineMs: 250,
      headersTimeoutMs: 100,
      requestTimeoutMs: 200,
    });
    const harness = await startPolicyRuntime({ policy });
    try {
      const raw = await rawTcpExchange(harness.url, [
        {
          data:
            `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${harness.url.port}\r\n` +
            `Authorization: ${AUTHORIZATION}\r\n` +
            "Content-Type: application/json\r\n" +
            "Content-Length: 32\r\n" +
            "Connection: close\r\n\r\n{",
        },
      ]);
      expect(responseStatus(raw)).toBe(408);
      expect(raw).toContain("Request timeout.");
      expect(raw.toLowerCase()).toMatch(/x-request-id: [0-9a-f-]{36}/u);
      expect(harness.authenticate).toHaveBeenCalledOnce();
      expect(harness.createServer).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("bounds a stalled authentication provider with the overall request deadline", async () => {
    const policy = createHttpRequestPolicy({
      requestDeadlineMs: 25,
      headersTimeoutMs: 100,
      requestTimeoutMs: 200,
    });
    const harness = await startPolicyRuntime({
      policy,
      authenticate: () => new Promise<never>(() => {}),
    });
    try {
      const response = await fetch(harness.url, {
        method: "POST",
        headers: validPostHeaders(),
        body: "{}",
      });
      expect(response.status).toBe(408);
      expect(await response.json()).toMatchObject({ error: { code: -32000 } });
      expect(harness.authenticate).toHaveBeenCalledOnce();
      expect(harness.createServer).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("uses the parser header deadline before the request callback runs", async () => {
    const policy = createHttpRequestPolicy({
      headersTimeoutMs: 25,
      requestTimeoutMs: 100,
      bodyReadTimeoutMs: 75,
      requestDeadlineMs: 200,
    });
    const finish = vi.fn();
    const harness = await startPolicyRuntime({
      policy,
      observability: {
        beginRequest: () => ({ finish }),
        beginTool: () => ({ finish: vi.fn() }),
      },
    });
    try {
      const raw = await rawTcpExchange(harness.url, [
        { data: "POST /mcp HTTP/1.1\r\nHost: " },
      ]);
      expect(responseStatus(raw)).toBe(408);
      expect(raw).toContain("Request timeout.");
      expect(raw.toLowerCase()).toMatch(/x-request-id: [0-9a-f-]{36}/u);
      expect(finish).toHaveBeenCalledWith({
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        outcome: "rejected",
        reason: "request_timeout",
        statusCode: 408,
      });
      expect(harness.authenticate).not.toHaveBeenCalled();
      expect(harness.createServer).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("correlates malformed raw headers without reflecting parser input", async () => {
    const finish = vi.fn();
    const harness = await startPolicyRuntime({
      observability: {
        beginRequest: () => ({ finish }),
        beginTool: () => ({ finish: vi.fn() }),
      },
    });
    try {
      const raw = await rawTcpExchange(
        harness.url,
        [
          {
            data:
              `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${harness.url.port}\r\n` +
              "malformed-header-without-colon\r\n\r\n",
          },
        ],
        true
      );
      expect(responseStatus(raw)).toBe(400);
      expect(raw.toLowerCase()).toMatch(/x-request-id: [0-9a-f-]{36}/u);
      expect(raw).not.toContain("malformed-header-without-colon");
      expect(finish).toHaveBeenCalledWith({
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        outcome: "rejected",
        reason: "malformed_request",
        statusCode: 400,
      });
      expect(harness.authenticate).not.toHaveBeenCalled();
      expect(harness.createServer).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("reuses the active request correlation for a post-callback parser error", async () => {
    const finish = vi.fn();
    const harness = await startPolicyRuntime({
      observability: {
        beginRequest: () => ({ finish }),
        beginTool: () => ({ finish: vi.fn() }),
      },
    });
    try {
      const raw = await rawTcpExchange(harness.url, [
        {
          data:
            `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${harness.url.port}\r\n` +
            `Authorization: ${AUTHORIZATION}\r\n` +
            "Content-Type: application/json\r\n" +
            "Transfer-Encoding: chunked\r\n" +
            "Connection: close\r\n\r\n",
        },
        { data: "Z\r\n", delayMs: 25 },
      ]);
      expect(responseStatus(raw)).toBe(400);
      const ids = [
        ...raw.toLowerCase().matchAll(/x-request-id: ([0-9a-f-]{36})/gu),
      ].map((match) => match[1]);
      expect(ids).toHaveLength(1);
      expect(finish).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledWith({
        correlationId: ids[0],
        identity: {
          ownerId: "snsdk-24-owner",
          clientId: "snsdk-24-client",
        },
        outcome: "rejected",
        reason: "malformed_request",
        statusCode: 400,
      });
      expect(harness.authenticate).toHaveBeenCalledOnce();
      expect(harness.createServer).not.toHaveBeenCalled();
    } finally {
      await harness.runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("cleans up an aborted body without dispatch or shutdown leakage", async () => {
    const harness = await startPolicyRuntime();
    const socket = connectTcp({ host: "127.0.0.1", port: Number(harness.url.port) });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${harness.url.port}\r\n` +
          `Authorization: ${AUTHORIZATION}\r\n` +
          "Content-Type: application/json\r\n" +
          "Content-Length: 100\r\n\r\n{"
      );
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(harness.createServer).not.toHaveBeenCalled();
      await expect(
        harness.runtime.close({ gracePeriodMs: 100 })
      ).resolves.toBeUndefined();
    } finally {
      socket.destroy();
      await harness.runtime.close({ gracePeriodMs: 0 }).catch(() => {});
    }
  });

  it("keeps server cleanup bounded after the response deadline is disposed", async () => {
    const policy = createHttpRequestPolicy({
      requestDeadlineMs: 40,
      headersTimeoutMs: 100,
      requestTimeoutMs: 200,
    });
    const close = vi.fn(() => new Promise<never>(() => {}));
    const harness = await startPolicyRuntime({
      policy,
      createServer: async () => {
        const server = await emptyMcpServer();
        Object.defineProperty(server, "close", {
          configurable: true,
          value: close,
        });
        return server;
      },
    });
    try {
      const response = await fetch(harness.url, {
        method: "POST",
        headers: validPostHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(close).toHaveBeenCalledOnce();

      const startedAt = performance.now();
      await harness.runtime.close({ gracePeriodMs: 50 });
      expect(performance.now() - startedAt).toBeLessThan(250);
      // Graceful runtime close retries and then clears the lingering resource.
      expect(close.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await harness.runtime.close({ gracePeriodMs: 0 }).catch(() => {});
    }
  });
});
