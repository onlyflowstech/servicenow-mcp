import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStdioCorrelationIdFactory,
  createStdioRequestMetadataProvider,
  loadServerEnvironmentFile,
  SERVER_ENV_RELATIVE_PATH,
  startStdioRuntime,
} from "../src/stdio-runtime.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sn-mcp-stdio-runtime-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeServerEnv(contents: string, mode = 0o600): string {
  const path = join(home, SERVER_ENV_RELATIVE_PATH);
  mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
}

/**
 * A transport that records what the server writes without touching stdio.
 * `close` fires `onclose` as a real transport does, which is what lets the
 * SDK's Protocol drop its reference and report the server as disconnected.
 */
function recordingTransport(): Transport & { readonly sent: unknown[] } {
  const sent: unknown[] = [];
  const transport: Transport & { readonly sent: unknown[] } = {
    sent,
    start: async () => {},
    send: async (message: unknown) => {
      sent.push(message);
    },
    close: async () => {
      transport.onclose?.();
    },
  } as Transport & { readonly sent: unknown[] };
  return transport;
}

describe("stdio request metadata", () => {
  it("binds one identity and issues a fresh correlation ID per invocation", async () => {
    const provider = createStdioRequestMetadataProvider({
      ownerId: "owner-a",
      clientId: "client-a",
    });

    const first = await provider.resolve({ tool: "sn_query", requestId: 1 });
    const second = await provider.resolve({ tool: "sn_query", requestId: 1 });

    expect(first.identity).toEqual({ ownerId: "owner-a", clientId: "client-a" });
    expect(second.identity).toEqual(first.identity);
    // Same request ID, different correlation: stdio derives nothing from the
    // caller's payload, so a replayed ID cannot collide two audit records.
    expect(first.correlationId).not.toBe(second.correlationId);
    expect(first.correlationId).toMatch(/^stdio-[0-9a-f-]{36}-[0-9a-f-]{36}$/u);

    // Bounded for the execution context's 128-character identifier limit.
    expect(first.correlationId.length).toBeLessThanOrEqual(128);
  });

  it("groups a session's records under one session identifier", async () => {
    const provider = createStdioRequestMetadataProvider(
      { ownerId: "owner-a", clientId: "client-a" },
      createStdioCorrelationIdFactory("fixed-session")
    );
    const first = await provider.resolve({ tool: "sn_get", requestId: "a" });
    const second = await provider.resolve({ tool: "sn_get", requestId: "b" });

    expect(first.correlationId.startsWith("stdio-fixed-session-")).toBe(true);
    expect(second.correlationId.startsWith("stdio-fixed-session-")).toBe(true);
    expect(first.correlationId).not.toBe(second.correlationId);
  });

  it("ignores invocation hints, so a payload cannot nominate an identity", async () => {
    const provider = createStdioRequestMetadataProvider({
      ownerId: "owner-a",
      clientId: "client-a",
    });
    const metadata = await provider.resolve({
      tool: "sn_query",
      requestId: 1,
      // A hostile client sending its own identity must change nothing.
      authenticatedClientId: "attacker",
      ownerId: "attacker",
    } as never);

    expect(metadata.identity).toEqual({ ownerId: "owner-a", clientId: "client-a" });
  });

  it("rejects an identity the audit path could not encode", () => {
    for (const identity of [
      { ownerId: "", clientId: "client-a" },
      { ownerId: "owner-a", clientId: "bad\u0000client" },
      { ownerId: "o".repeat(129), clientId: "client-a" },
      { ownerId: 7 as unknown as string, clientId: "client-a" },
    ]) {
      expect(() => createStdioRequestMetadataProvider(identity)).toThrow(TypeError);
    }
  });

  it("snapshots the identity, so later mutation cannot re-attribute records", async () => {
    const identity = { ownerId: "owner-a", clientId: "client-a" };
    const provider = createStdioRequestMetadataProvider(identity);
    identity.ownerId = "someone-else";

    const metadata = await provider.resolve({ tool: "sn_query", requestId: 1 });
    expect(metadata.identity.ownerId).toBe("owner-a");
    expect(Object.isFrozen(metadata.identity)).toBe(true);
  });
});

describe("server environment file", () => {
  it("adopts values the spawning client did not supply", () => {
    const path = writeServerEnv(
      [
        "MCP_OWNER_ID='owner-from-file'",
        "MCP_CLIENT_ID='client-from-file'",
        "SN_PROFILE_ENCRYPTION_KEY='key-from-file'",
      ].join("\n")
    );
    const env: NodeJS.ProcessEnv = {};

    const result = loadServerEnvironmentFile({ home, env, warn: () => {} });

    expect(result).toMatchObject({ path, loaded: true });
    expect(result.applied).toEqual([
      "MCP_OWNER_ID",
      "MCP_CLIENT_ID",
      "SN_PROFILE_ENCRYPTION_KEY",
    ]);
    expect(env.SN_PROFILE_ENCRYPTION_KEY).toBe("key-from-file");
  });

  it("never overrides a value the parent process supplied", () => {
    writeServerEnv("MCP_OWNER_ID='owner-from-file'\nMCP_CLIENT_ID='client-from-file'\n");
    const env: NodeJS.ProcessEnv = { MCP_OWNER_ID: "owner-from-parent" };

    const result = loadServerEnvironmentFile({ home, env, warn: () => {} });

    expect(env.MCP_OWNER_ID).toBe("owner-from-parent");
    expect(env.MCP_CLIENT_ID).toBe("client-from-file");
    expect(result.applied).toEqual(["MCP_CLIENT_ID"]);
  });

  it("treats a missing file as configuration coming from elsewhere", () => {
    const env: NodeJS.ProcessEnv = {};
    const warn = vi.fn();

    const result = loadServerEnvironmentFile({ home, env, warn });

    expect(result.loaded).toBe(false);
    expect(result.applied).toEqual([]);
    expect(env).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a loose mode on the file that holds the encryption key", () => {
    writeServerEnv("MCP_OWNER_ID='owner'\n", 0o644);
    const warn = vi.fn();

    loadServerEnvironmentFile({ home, env: {}, warn });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("0644");
    expect(message).toContain("chmod 600");
    // The warning names the file, never anything it contains.
    expect(message).not.toContain("owner");
  });

  it("ignores comments, blank lines, and names it would not accept", () => {
    writeServerEnv(
      [
        "# a comment",
        "",
        "  MCP_OWNER_ID='owner-from-file'  ",
        "no-equals-sign",
        "=leading-equals",
        "BAD-NAME='ignored'",
        "PATH_LIKE='kept'",
      ].join("\n")
    );
    const env: NodeJS.ProcessEnv = {};

    loadServerEnvironmentFile({ home, env, warn: () => {} });

    expect(env).toEqual({ MCP_OWNER_ID: "owner-from-file", PATH_LIKE: "kept" });
  });

  it("round-trips a single quote through the shell quoting setup writes", () => {
    writeServerEnv(`SN_PROFILE_ENCRYPTION_KEY='ab'\\''cd'\n`);
    const env: NodeJS.ProcessEnv = {};

    loadServerEnvironmentFile({ home, env, warn: () => {} });

    expect(env.SN_PROFILE_ENCRYPTION_KEY).toBe("ab'cd");
  });
});

describe("stdio runtime lifecycle", () => {
  const identity = Object.freeze({ ownerId: "owner-a", clientId: "client-a" });

  it("connects the server it was given and exposes the session context", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const transport = recordingTransport();

    const runtime = await startStdioRuntime({
      identity,
      createServer: () => server,
      createTransport: () => transport,
    });

    expect(runtime.server).toBe(server);
    expect(server.isConnected()).toBe(true);
    expect(runtime.context.identity).toEqual(identity);
    expect(Object.isFrozen(runtime.context)).toBe(true);

    await runtime.close();
    expect(server.isConnected()).toBe(false);
  });

  it("hands the factory a metadata provider bound to the process identity", async () => {
    const transport = recordingTransport();
    let captured: Awaited<ReturnType<typeof startStdioRuntime>>["context"] | undefined;

    const runtime = await startStdioRuntime({
      identity,
      createServer: (context) => {
        captured = context;
        return new McpServer({ name: "test", version: "0.0.0" });
      },
      createTransport: () => transport,
    });

    const metadata = await captured?.requestMetadataProvider.resolve({
      tool: "sn_query",
      requestId: 1,
    });
    expect(metadata?.identity).toEqual(identity);

    await runtime.close();
  });

  it("refuses a factory that returns a server it already connected", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    await server.connect(recordingTransport());

    await expect(
      startStdioRuntime({
        identity,
        createServer: () => server,
        createTransport: () => recordingTransport(),
      })
    ).rejects.toThrow(/unconnected/u);

    await server.close();
  });

  it("refuses a factory that does not return an McpServer", async () => {
    await expect(
      startStdioRuntime({
        identity,
        createServer: () => ({}) as never,
        createTransport: () => recordingTransport(),
      })
    ).rejects.toThrow(/McpServer/u);
  });

  it("closes the server it built when the transport refuses to start", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const failing: Transport = {
      start: async () => {
        throw new Error("transport unavailable");
      },
      send: async () => {},
      close: async () => {
        failing.onclose?.();
      },
    } as Transport;

    await expect(
      startStdioRuntime({
        identity,
        createServer: () => server,
        createTransport: () => failing,
      })
    ).rejects.toThrow(/transport unavailable/u);
    expect(server.isConnected()).toBe(false);
  });
});
