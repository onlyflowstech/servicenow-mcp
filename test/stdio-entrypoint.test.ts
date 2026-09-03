import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The shipped entrypoint, spawned exactly as an MCP client spawns it.
 *
 * These are the assertions that cannot be made any other way: that stdout
 * carries nothing but JSON-RPC, that the handshake completes over a pipe, and
 * that the identity and audit records a real session produces are well formed.
 */
const ENTRYPOINT = new URL("../dist/index.js", import.meta.url);
const PROTOCOL_VERSION = "2025-06-18";

const children = new Set<ChildProcessWithoutNullStreams>();
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sn-mcp-stdio-entrypoint-"));
});

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      children.delete(child);
    })
  );
  rmSync(home, { recursive: true, force: true });
});

interface Session {
  readonly child: ChildProcessWithoutNullStreams;
  send(message: unknown): void;
  /** Resolves with the response carrying this JSON-RPC id. */
  response(id: number): Promise<Record<string, unknown>>;
  /** Every complete line stdout has produced, parsed. */
  readonly stdoutFrames: Record<string, unknown>[];
  /** Complete stdout lines that were not JSON at all. */
  readonly nonProtocolLines: string[];
  /** Raw stdout bytes, so a non-JSON byte is still observable. */
  stdoutText(): string;
  stderrText(): string;
}

function startSession(environment: NodeJS.ProcessEnv = {}): Session {
  const child = spawn(process.execPath, [ENTRYPOINT.pathname], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  children.add(child);

  let stdout = "";
  let stderr = "";
  const frames: Record<string, unknown>[] = [];
  const nonProtocolLines: string[] = [];
  let consumed = 0;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    for (let index = consumed; index < lines.length - 1; index += 1) {
      const line = lines[index];
      if (line.length === 0) continue;
      // A line that is not JSON is exactly the corruption these tests exist to
      // catch. Skip it here so the purity assertion reports it precisely,
      // rather than throwing inside a stream handler and timing the test out.
      try {
        frames.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        nonProtocolLines.push(line);
      }
    }
    consumed = lines.length - 1;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    send: (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    response: async (id: number) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const match = frames.find((frame) => frame.id === id);
        if (match) return match;
        if (Date.now() > deadline) {
          throw new Error(
            `no response for id ${id}; stdout=${JSON.stringify(stdout)} stderr=${stderr}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    stdoutFrames: frames,
    nonProtocolLines,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function initialize(session: Session): Promise<Record<string, unknown>> {
  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "stdio-entrypoint-test", version: "1" },
    },
  });
  const result = await session.response(1);
  session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return result;
}

function writeServerEnv(values: Readonly<Record<string, string>>): void {
  const directory = join(home, ".servicenow-mcp");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "server.env");
  writeFileSync(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}='${value}'`)
      .join("\n")}\n`,
    { mode: 0o600 }
  );
  chmodSync(path, 0o600);
}

describe("packaged stdio entrypoint", () => {
  it("completes an initialize handshake and lists every tool over stdio", async () => {
    const session = startSession();

    const initialized = await initialize(session);
    const result = initialized.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.serverInfo).toMatchObject({
      name: "@onlyflows/servicenow-mcp",
    });

    session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = (await session.response(2)).result as {
      tools: { name: string; inputSchema: { required?: string[] } }[];
    };
    expect(listed.tools).toHaveLength(19);
    // The transport changed; the profile requirement did not.
    expect(
      listed.tools.every((tool) => tool.inputSchema.required?.includes("profile"))
    ).toBe(true);
  });

  it("writes nothing but JSON-RPC frames to stdout", async () => {
    // A profile using basic auth makes the server emit its deprecation
    // warning, and an env file with a loose mode would add another: both are
    // exactly the kind of diagnostic that must never reach stdout.
    writeServerEnv({ MCP_OWNER_ID: "owner-purity", MCP_CLIENT_ID: "client-purity" });
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    const configPath = join(home, ".servicenow-mcp/config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        profiles: {
          dev: {
            instance: "https://dev00001.service-now.com",
            authType: "basic",
            username: "someone",
            credential: "env:SN_UNUSED_PASSWORD",
          },
        },
      }),
      { mode: 0o600 }
    );
    chmodSync(configPath, 0o600);

    const session = startSession();
    await initialize(session);
    session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await session.response(2);
    session.send({ jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} });
    await session.response(3);
    // A rejected call produces an error response, not a log line.
    session.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "sn_query", arguments: { profile: "absent", table: "incident" } },
    });
    await session.response(4);

    // Every complete line on stdout parses as a JSON-RPC message, and there is
    // no trailing partial line of anything else.
    expect(session.nonProtocolLines).toEqual([]);
    const lines = session.stdoutText().split("\n");
    const remainder = lines.pop();
    expect(remainder).toBe("");
    for (const line of lines) {
      expect(
        (JSON.parse(line) as { jsonrpc?: string }).jsonrpc,
        `stdout line is not a JSON-RPC frame: ${line}`
      ).toBe("2.0");
    }
    expect(session.stdoutText()).not.toMatch(/\[servicenow-mcp\]/u);
    // The structured event stream must not leak onto stdout either.
    expect(session.stdoutText()).not.toContain('"type":"mcp_tool"');
    expect(session.stdoutFrames.length).toBeGreaterThanOrEqual(4);

    // The diagnostics did happen — they went to stderr, where they belong.
    expect(session.stderrText()).toContain("ready on stdio");
    expect(session.stderrText()).toContain("basic authentication");
  });

  it("attributes audit records to the configured identity and one session", async () => {
    writeServerEnv({
      MCP_OWNER_ID: "owner-from-env-file",
      MCP_CLIENT_ID: "client-from-env-file",
    });
    const session = startSession();
    await initialize(session);

    // Two calls naming a profile that does not exist: rejected before any
    // ServiceNow contact, so this exercises the audit path without an instance.
    for (const id of [2, 3]) {
      session.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "sn_query", arguments: { profile: "absent", table: "incident" } },
      });
      await session.response(id);
    }

    const events = session
      .stderrText()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "mcp_tool");

    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.tool).toBe("sn_query");
      expect(typeof event.correlationId).toBe("string");
      // Identity is pseudonymized in the event stream, never echoed raw.
      expect(typeof event.ownerIdHash).toBe("string");
      expect(typeof event.clientIdHash).toBe("string");
      expect(event.outcome).toBe("profile_rejected");
      expect(event.reason).toBe("unknown_profile");
      // The invariant that a rejected profile carries no profile or instance
      // holds identically on stdio; nothing about it is transport-specific.
      expect(event.profile).toBeNull();
      expect(event.instance).toBeNull();
      // The name the caller supplied is never echoed into the event stream.
      expect(JSON.stringify(event)).not.toContain("absent");
    }
    expect(session.stderrText()).not.toContain("owner-from-env-file");

    // One session, two invocations: same owner pseudonym, distinct correlation.
    const [first, second] = events;
    expect(second.ownerIdHash).toBe(first.ownerIdHash);
    expect(second.correlationId).not.toBe(first.correlationId);
  });

  it("prefers an identity the spawning client supplied over the env file", async () => {
    writeServerEnv({ MCP_OWNER_ID: "owner-from-file", MCP_CLIENT_ID: "client-from-file" });
    const fromFile = startSession();
    await initialize(fromFile);
    fromFile.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "sn_query", arguments: { profile: "absent", table: "incident" } },
    });
    await fromFile.response(2);

    const fromParent = startSession({ MCP_OWNER_ID: "owner-from-parent" });
    await initialize(fromParent);
    fromParent.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "sn_query", arguments: { profile: "absent", table: "incident" } },
    });
    await fromParent.response(2);

    const ownerHash = (session: Session): unknown =>
      session
        .stderrText()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.type === "mcp_tool")?.ownerIdHash;

    expect(ownerHash(fromFile)).toBeTypeOf("string");
    expect(ownerHash(fromParent)).toBeTypeOf("string");
    expect(ownerHash(fromParent)).not.toBe(ownerHash(fromFile));
  });

  /**
   * A known, deliberate difference from the HTTP runtime, pinned so it cannot
   * change silently.
   *
   * The SDK rejects arguments that fail the tool's Zod schema before any
   * handler runs, so the execution context never opens and no audit record is
   * issued. Over HTTP the runtime reconstructs one (`input_validation_failed`)
   * by inspecting the raw request body, which it can do because it parses that
   * body itself. A stdio session has no such seam: the SDK owns the framing,
   * and correlating a response back to its request at the transport layer
   * would have to guess which of several in-flight calls a record belonged to.
   *
   * The caller still learns the call was refused. What is missing is only the
   * operator-side evidence, and only for arguments that never reached a tool.
   */
  it("leaves no audit record for arguments the SDK rejects before the handler", async () => {
    const session = startSession();
    await initialize(session);

    session.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      // No `profile`, which the schema requires.
      params: { name: "sn_query", arguments: { table: "incident" } },
    });
    const rejected = (await session.response(2)).result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toContain("Input validation error");

    const events = session
      .stderrText()
      .split("\n")
      .filter((line) => line.startsWith("{"));
    expect(events).toEqual([]);
  });

  it("exits when the client closes the pipe", async () => {
    const session = startSession();
    await initialize(session);

    session.child.stdin.end();
    const [code] = (await once(session.child, "exit")) as [number | null];
    children.delete(session.child);
    expect(code).toBe(0);
  });
});
