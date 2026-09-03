import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The dormant HTTP composition, which no `bin` entry and no CLI path reaches.
 * It is driven directly here so the enterprise deployment shape stays proven
 * while stdio is the only transport the product exposes.
 */
const ENTRYPOINT = new URL("../dist/http-entrypoint.js", import.meta.url);
const TEST_TOKEN = "entrypoint-contract-token-at-least-32-characters";
const children = new Set<ChildProcess>();
let temporaryHome: string;

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), "sn-mcp-entrypoint-test-"));
});

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      children.delete(child);
    })
  );
  rmSync(temporaryHome, { recursive: true, force: true });
});

describe("dormant HTTP entrypoint", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "listens and exits cleanly after bounded %s shutdown",
    async (signal) => {
      const child = startEntrypoint({
        MCP_BEARER_TOKEN: TEST_TOKEN,
        MCP_OWNER_ID: "entrypoint-owner",
        MCP_CLIENT_ID: "entrypoint-client",
        MCP_HOST: "127.0.0.1",
        MCP_PORT: "0",
        MCP_SHUTDOWN_GRACE_MS: "50",
        SN_INSTANCE: "https://example.service-now.com",
        SN_USER: "entrypoint-user",
        SN_PASSWORD: "unused-entrypoint-password",
      });
      const output = collectStderr(child);
      await waitForOutput(output, "listening on http://127.0.0.1:");

      const exited = waitForExitWithin(child, 1_000);
      const shutdownStartedAt = performance.now();
      expect(child.kill(signal)).toBe(true);
      const [exitCode, exitSignal] = await exited;
      const shutdownElapsedMs = performance.now() - shutdownStartedAt;
      children.delete(child);

      expect(exitCode).toBe(0);
      expect(exitSignal).toBeNull();
      expect(shutdownElapsedMs).toBeLessThan(1_000);
      expect(output.value).toContain(`HTTP shutdown complete (${signal}).`);
      expect(output.value).not.toContain(TEST_TOKEN);
    }
  );

  it("serves unauthenticated and says so when MCP_BEARER_TOKEN is absent", async () => {
    const child = startEntrypoint({
      MCP_HOST: "127.0.0.1",
      MCP_PORT: "0",
      SN_INSTANCE: "https://example.service-now.com",
      SN_USER: "entrypoint-user",
      SN_PASSWORD: "unused-entrypoint-password",
    });
    const output = collectStderr(child);
    const url = await waitForListeningUrl(output);

    // No Authorization header at all, and no MCP_OWNER_ID/MCP_CLIENT_ID either:
    // the identity that reaches the audit path is defaulted, not demanded.
    const accepted = await initialize(url);
    expect(accepted.status).toBe(200);
    await accepted.arrayBuffer();

    // A caller cannot nominate an identity by sending a token of its own.
    const withHeader = await initialize(url, "Bearer pretend-to-be-someone-else");
    expect(withHeader.status).toBe(200);
    await withHeader.arrayBuffer();

    // The operator has to be able to see this in the log, unprompted.
    expect(output.value).toContain("UNAUTHENTICATED");
    expect(output.value).toContain("MCP_BEARER_TOKEN is not set");
    expect(output.value).toContain("Host/Origin allowlists");

    const exited = waitForExitWithin(child, 1_000);
    expect(child.kill("SIGTERM")).toBe(true);
    const [exitCode] = await exited;
    children.delete(child);
    expect(exitCode).toBe(0);
  });

  it("requires and verifies the bearer when MCP_BEARER_TOKEN is set", async () => {
    const child = startEntrypoint({
      MCP_BEARER_TOKEN: TEST_TOKEN,
      MCP_OWNER_ID: "entrypoint-owner",
      MCP_CLIENT_ID: "entrypoint-client",
      MCP_HOST: "127.0.0.1",
      MCP_PORT: "0",
      SN_INSTANCE: "https://example.service-now.com",
      SN_USER: "entrypoint-user",
      SN_PASSWORD: "unused-entrypoint-password",
    });
    const output = collectStderr(child);
    const url = await waitForListeningUrl(output);

    expect((await initialize(url)).status).toBe(401);
    expect((await initialize(url, `Bearer wrong-${TEST_TOKEN}`)).status).toBe(401);
    const accepted = await initialize(url, `Bearer ${TEST_TOKEN}`);
    expect(accepted.status).toBe(200);
    await accepted.arrayBuffer();

    // The opt-in path must not carry the unauthenticated warning.
    expect(output.value).not.toContain("UNAUTHENTICATED");
    expect(output.value).not.toContain(TEST_TOKEN);

    const exited = waitForExitWithin(child, 1_000);
    expect(child.kill("SIGTERM")).toBe(true);
    const [exitCode] = await exited;
    children.delete(child);
    expect(exitCode).toBe(0);
  });

  it.each([
    ["too short to be a token", "short"],
    ["explicitly empty", ""],
  ])(
    "fails closed before listening when MCP_BEARER_TOKEN is %s",
    async (_label, token) => {
      // Opting in half-way must not silently fall back to serving open.
      const child = startEntrypoint({
        MCP_BEARER_TOKEN: token,
        MCP_HOST: "127.0.0.1",
        MCP_PORT: "0",
        SN_INSTANCE: "https://example.service-now.com",
        SN_USER: "entrypoint-user",
        SN_PASSWORD: "unused-entrypoint-password",
      });
      const output = collectStderr(child);
      const [exitCode] = (await once(child, "exit")) as [number | null];
      children.delete(child);

      expect(exitCode).toBe(1);
      expect(output.value).toBe(
        "[servicenow-mcp] Fatal HTTP service startup error.\n"
      );
      expect(output.value).not.toContain("listening on");
    }
  );

  it("fails closed before listening when concurrency admission is invalid", async () => {
    const child = startEntrypoint({
      MCP_BEARER_TOKEN: TEST_TOKEN,
      MCP_OWNER_ID: "entrypoint-owner",
      MCP_CLIENT_ID: "entrypoint-client",
      MCP_MAX_CONCURRENT_REQUESTS: "0",
      SN_INSTANCE: "https://example.service-now.com",
      SN_USER: "entrypoint-user",
      SN_PASSWORD: "unused-entrypoint-password",
    });
    const output = collectStderr(child);
    const [exitCode] = (await once(child, "exit")) as [number | null];
    children.delete(child);

    expect(exitCode).toBe(1);
    expect(output.value).toBe(
      "[servicenow-mcp] Fatal HTTP service startup error.\n"
    );
    expect(output.value).not.toContain("listening on");
  });

  it.each([
    ["MCP_MAX_CONNECTIONS", "0"],
    ["MCP_PRE_AUTH_RATE_CAPACITY", "0"],
    ["MCP_PRE_AUTH_RATE_REFILL_MS", "86400001"],
    ["MCP_PRE_AUTH_RATE_MAX_ENTRIES", "100001"],
    ["MCP_IDENTITY_RATE_CAPACITY", "1.5"],
    ["MCP_IDENTITY_RATE_REFILL_MS", "0"],
    ["MCP_IDENTITY_RATE_MAX_ENTRIES", "-1"],
  ])("fails closed before listening when %s=%s is invalid", async (name, value) => {
    const child = startEntrypoint({
      MCP_BEARER_TOKEN: TEST_TOKEN,
      MCP_OWNER_ID: "entrypoint-owner",
      MCP_CLIENT_ID: "entrypoint-client",
      [name]: value,
      SN_INSTANCE: "https://example.service-now.com",
      SN_USER: "entrypoint-user",
      SN_PASSWORD: "unused-entrypoint-password",
    });
    const output = collectStderr(child);
    const [exitCode] = (await once(child, "exit")) as [number | null];
    children.delete(child);

    expect(exitCode).toBe(1);
    expect(output.value).toBe(
      "[servicenow-mcp] Fatal HTTP service startup error.\n"
    );
    expect(output.value).not.toContain("listening on");
    expect(output.value).not.toContain(value);
  });

  it.each(["pre-authentication source", "authenticated identity"] as const)(
    "applies operator-configured %s rate limits and leaves health probes available",
    async (scope) => {
      const child = startEntrypoint({
        MCP_BEARER_TOKEN: TEST_TOKEN,
        MCP_OWNER_ID: "entrypoint-owner",
        MCP_CLIENT_ID: "entrypoint-client",
        MCP_HOST: "127.0.0.1",
        MCP_PORT: "0",
        MCP_PRE_AUTH_RATE_CAPACITY:
          scope === "pre-authentication source" ? "1" : "10",
        MCP_PRE_AUTH_RATE_REFILL_MS: "60000",
        MCP_PRE_AUTH_RATE_MAX_ENTRIES: "2",
        MCP_IDENTITY_RATE_CAPACITY:
          scope === "authenticated identity" ? "1" : "10",
        MCP_IDENTITY_RATE_REFILL_MS: "60000",
        MCP_IDENTITY_RATE_MAX_ENTRIES: "2",
        SN_INSTANCE: "https://example.service-now.com",
        SN_USER: "entrypoint-user",
        SN_PASSWORD: "unused-entrypoint-password",
      });
      const output = collectStderr(child);
      const url = await waitForListeningUrl(output);
      const post = () =>
        fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "entrypoint-rate-test", version: "1.0.0" },
            },
          }),
        });

      const accepted = await post();
      expect(accepted.status).toBe(200);
      await accepted.arrayBuffer();
      const rejected = await post();
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBe("60");
      expect(await rejected.json()).toEqual({
        error: "rate_limited",
        message:
          "Rate limited. Retry after the number of seconds in retry_after_seconds or the Retry-After header.",
        retry_after_seconds: 60,
      });

      const health = await fetch(new URL("/health/live", url));
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "live" });

      const exited = waitForExitWithin(child, 1_000);
      expect(child.kill("SIGTERM")).toBe(true);
      const [exitCode] = await exited;
      children.delete(child);
      expect(exitCode).toBe(0);
    }
  );
});

function initialize(url: URL, authorization?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "entrypoint-test", version: "1.0.0" },
      },
    }),
  });
}

function startEntrypoint(overrides: Record<string, string>): ChildProcess {
  const environment = { ...process.env };
  for (const name of [
    "MCP_BEARER_TOKEN",
    "MCP_OWNER_ID",
    "MCP_CLIENT_ID",
    "MCP_HOST",
    "MCP_PORT",
    "MCP_ALLOWED_HOSTS",
    "MCP_ALLOWED_ORIGINS",
    "MCP_MAX_CONCURRENT_REQUESTS",
    "MCP_MAX_CONNECTIONS",
    "MCP_SHUTDOWN_GRACE_MS",
    "MCP_PRE_AUTH_RATE_CAPACITY",
    "MCP_PRE_AUTH_RATE_REFILL_MS",
    "MCP_PRE_AUTH_RATE_MAX_ENTRIES",
    "MCP_IDENTITY_RATE_CAPACITY",
    "MCP_IDENTITY_RATE_REFILL_MS",
    "MCP_IDENTITY_RATE_MAX_ENTRIES",
  ]) {
    delete environment[name];
  }
  environment.HOME = temporaryHome;
  Object.assign(environment, overrides);
  const child = spawn(process.execPath, [ENTRYPOINT.pathname], {
    cwd: new URL("../", import.meta.url),
    env: environment,
  });
  children.add(child);
  return child;
}

function collectStderr(child: ChildProcess) {
  const output = { value: "" };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    output.value += chunk;
  });
  return output;
}

async function waitForOutput(
  output: { readonly value: string },
  expected: string
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!output.value.includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for entrypoint output: ${output.value}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForListeningUrl(
  output: { readonly value: string }
): Promise<URL> {
  const deadline = Date.now() + 3_000;
  while (true) {
    const match = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(
      output.value
    );
    if (match?.[1]) return new URL(match[1]);
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for entrypoint URL: ${output.value}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function waitForExitWithin(
  child: ChildProcess,
  maximumMs: number
): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      child.off("error", onError);
      resolve([code, signal]);
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      child.off("error", onError);
      reject(new Error(`Entrypoint did not exit within ${maximumMs}ms`));
    }, maximumMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

describe("non-loopback host requires a bearer", () => {
  /**
   * Unauthenticated is a deliberate local convenience, and on loopback the
   * reach is this machine, which already holds the credential file. Off
   * loopback the same configuration is a ServiceNow proxy open to the network,
   * and it *works* — so a warning would be read past. The container image sets
   * MCP_HOST=0.0.0.0, which is exactly this case.
   */
  it("refuses to start on 0.0.0.0 with no token, and says how to fix it", async () => {
    const child = startEntrypoint({ MCP_HOST: "0.0.0.0", MCP_PORT: "0" });
    const stderr = collectStderr(child);
    const [code] = await waitForExitWithin(child, 10_000);

    expect(code).not.toBe(0);
    expect(stderr.value).toContain("Refusing to start");
    expect(stderr.value).toContain("not loopback");
    // Both remedies, so the operator does not have to guess which applies.
    expect(stderr.value).toContain("MCP_BEARER_TOKEN");
    expect(stderr.value).toContain("MCP_HOST=127.0.0.1");
    // The specific message must survive, not collapse into the generic startup
    // error that exists to keep credential paths out of the log.
    expect(stderr.value).not.toContain("Fatal HTTP service startup error");
  });

  it("starts on 0.0.0.0 when a token is configured", async () => {
    const child = startEntrypoint({
      MCP_HOST: "0.0.0.0",
      MCP_PORT: "0",
      MCP_BEARER_TOKEN: "y".repeat(48),
    });
    const stderr = collectStderr(child);
    // waitForListeningUrl matches a 127.0.0.1 log line, so it cannot be used
    // for a 0.0.0.0 bind. Asserting the process is still alive and never
    // refused is the property under test.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));

    expect(stderr.value).not.toContain("Refusing to start");
    expect(child.exitCode).toBeNull();
  });
});
