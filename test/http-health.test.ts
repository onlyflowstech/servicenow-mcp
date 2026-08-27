import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type {
  HttpAuthenticationProvider,
  HttpAuthenticationRequest,
} from "../src/http-auth.js";
import {
  MCP_LIVENESS_PATH,
  MCP_READINESS_PATH,
  createHttpRuntime,
  type AuthenticatedHttpRequestContext,
  type HttpRuntime,
} from "../src/http-runtime.js";
import { createMcpServer } from "../src/server.js";
import { createReadinessGate } from "../src/startup.js";

const TOKEN = "snsdk-health-test-token-012345678901234567890123456789";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const IDENTITY = Object.freeze({ ownerId: "health-owner", clientId: "health-client" });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function emptyMcpServer(): Promise<McpServer> {
  return createMcpServer({ dependencies: {}, register: () => {} });
}

async function startRuntime(options: {
  readonly readinessCheck?: () => boolean;
  readonly authenticationProvider?: HttpAuthenticationProvider<HttpAuthenticationRequest>;
  readonly createServer?: (
    context: AuthenticatedHttpRequestContext
  ) => McpServer | Promise<McpServer>;
} = {}): Promise<{ runtime: HttpRuntime; url: URL }> {
  const runtime = createHttpRuntime({
    host: "127.0.0.1",
    port: 0,
    authenticationProvider:
      options.authenticationProvider ?? { authenticate: () => IDENTITY },
    ...(options.readinessCheck ? { readinessCheck: options.readinessCheck } : {}),
    createServer: options.createServer ?? emptyMcpServer,
  });
  const address = await runtime.start();
  return { runtime, url: address.url };
}

describe("HTTP health and readiness", () => {
  it("serves unauthenticated liveness without touching runtime dependencies", async () => {
    const authenticate = vi.fn(() => IDENTITY);
    const createServer = vi.fn(emptyMcpServer);
    const readinessCheck = vi.fn(() => {
      throw new Error("readiness dependency must not run for liveness");
    });
    const { runtime, url } = await startRuntime({
      authenticationProvider: { authenticate },
      createServer,
      readinessCheck,
    });

    try {
      const response = await fetch(new URL(MCP_LIVENESS_PATH, url));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe(
        "application/json; charset=utf-8"
      );
      expect(await response.json()).toEqual({ status: "live" });
      expect(authenticate).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();
      expect(readinessCheck).not.toHaveBeenCalled();
    } finally {
      await runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("reports a local dependency gate and lifecycle state truthfully", async () => {
    const gate = createReadinessGate();
    const readinessCheck = vi.fn(gate.check);
    const { runtime, url } = await startRuntime({ readinessCheck });
    const endpoint = new URL(`${MCP_READINESS_PATH}?probe=orchestrator`, url);

    try {
      expect(runtime.isReady()).toBe(false);
      const unavailable = await fetch(endpoint);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ status: "not_ready" });

      gate.markReady();
      expect(runtime.isReady()).toBe(true);
      const ready = await fetch(endpoint);
      expect(ready.status).toBe(200);
      expect(ready.headers.get("cache-control")).toBe("no-store");
      expect(await ready.json()).toEqual({ status: "ready" });

      gate.markNotReady();
      expect(runtime.isReady()).toBe(false);
      const dependencyFailed = await fetch(endpoint);
      expect(dependencyFailed.status).toBe(503);
      expect(await dependencyFailed.json()).toEqual({ status: "not_ready" });
      // One check for each direct call plus one per readiness HTTP request.
      expect(readinessCheck).toHaveBeenCalledTimes(6);
    } finally {
      await runtime.close({ gracePeriodMs: 100 });
    }
    expect(runtime.isReady()).toBe(false);
  });

  it("fails readiness closed on missing, throwing, and async-like checks", async () => {
    const missing = await startRuntime();
    try {
      expect(missing.runtime.isReady()).toBe(false);
      const response = await fetch(new URL(MCP_READINESS_PATH, missing.url));
      expect(response.status).toBe(503);
    } finally {
      await missing.runtime.close({ gracePeriodMs: 100 });
    }

    for (const readinessCheck of [
      () => {
        throw new Error("secret dependency detail");
      },
      () => new Promise<never>(() => {}) as unknown as boolean,
      () => ({ then: () => {} }) as unknown as boolean,
    ]) {
      const harness = await startRuntime({ readinessCheck });
      try {
        const response = await fetch(new URL(MCP_READINESS_PATH, harness.url));
        expect(response.status).toBe(503);
        expect(await response.text()).toBe('{"status":"not_ready"}\n');
      } finally {
        await harness.runtime.close({ gracePeriodMs: 100 });
      }
    }
  });

  it("supports HEAD and rejects unsupported health methods without authentication", async () => {
    const authenticate = vi.fn(() => IDENTITY);
    const { runtime, url } = await startRuntime({
      readinessCheck: () => true,
      authenticationProvider: { authenticate },
    });

    try {
      for (const [path, expectedBody] of [
        [MCP_LIVENESS_PATH, '{"status":"live"}\n'],
        [MCP_READINESS_PATH, '{"status":"ready"}\n'],
      ] as const) {
        const response = await fetch(new URL(path, url), { method: "HEAD" });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).toBe(
          String(Buffer.byteLength(expectedBody))
        );
        expect(await response.text()).toBe("");
      }

      const rejected = await fetch(new URL(MCP_LIVENESS_PATH, url), {
        method: "POST",
      });
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get("allow")).toBe("GET, HEAD");
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await runtime.close({ gracePeriodMs: 100 });
    }
  });

  it("flips readiness synchronously and rejects new work while draining", async () => {
    const gate = createReadinessGate();
    gate.markReady();
    const entered = deferred();
    const release = deferred();
    const { runtime, url } = await startRuntime({
      readinessCheck: gate.check,
      createServer: async () =>
        createMcpServer({
          dependencies: {},
          register: (surface) => {
            surface.registerTool("sn_drain_health_probe", {}, async () => {
              entered.resolve();
              await release.promise;
              return { content: [{ type: "text", text: "complete" }] };
            });
          },
        }),
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: AUTHORIZATION } },
    });
    const client = new Client({ name: "health-drain-test", version: "1.0.0" });
    await client.connect(transport);
    const call = client.callTool({ name: "sn_drain_health_probe", arguments: {} });
    await entered.promise;

    const closing = runtime.close({ gracePeriodMs: 1_000 });
    expect(runtime.isReady()).toBe(false);

    const readinessAttempt = fetch(new URL(MCP_READINESS_PATH, url)).then(
      (response) => response.status,
      () => "connection-rejected" as const
    );
    const mcpAttempt = fetch(url, {
      method: "POST",
      headers: {
        authorization: AUTHORIZATION,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
    }).then(
      (response) => response.status,
      () => "connection-rejected" as const
    );

    release.resolve();
    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "complete" }],
    });
    await closing;
    expect(await readinessAttempt).not.toBe(200);
    expect(await mcpAttempt).not.toBe(200);
    await client.close();
  });
});
