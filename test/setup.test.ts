import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProfileManager } from "../src/profile-manager.js";
import { runSetupCli, type ProbeRequest, type ProbeResponse } from "../src/setup.js";

const POSIX = process.platform !== "win32";

function newHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function serverEnvPath(home: string): string {
  return join(home, ".servicenow-mcp/server.env");
}

function clientEnvPath(home: string): string {
  return join(home, ".servicenow-mcp/client.env");
}

function headerFilePath(home: string): string {
  return join(home, ".servicenow-mcp/client-headers.txt");
}

function profileConfigPath(home: string): string {
  return join(home, ".servicenow-mcp/config.json");
}

function readEnv(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const raw = line.slice(separator + 1);
    values[line.slice(0, separator)] =
      raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return values;
}

function capture(): { out: string[]; err: string[] } {
  return { out: [], err: [] };
}

describe("setup init", () => {
  it("writes owner-only files and configures Codex and Claude Code by reference", async () => {
    const home = newHome("sn-mcp-setup-");
    const io = capture();
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    await runSetupCli({
      home,
      argv: ["setup", "--endpoint", "http://127.0.0.1:4444/mcp", "--json"],
      env: { HOME: home },
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
      commandExists: () => true,
      runCommand: (command, args) => {
        calls.push({ command, args });
        if (args[0] === "mcp" && args[1] === "get") return { status: 1 };
        return { status: 0 };
      },
    });

    if (POSIX) {
      expect(statSync(join(home, ".servicenow-mcp")).mode & 0o777).toBe(0o700);
      expect(statSync(serverEnvPath(home)).mode & 0o777).toBe(0o600);
      expect(statSync(clientEnvPath(home)).mode & 0o777).toBe(0o600);
      expect(statSync(headerFilePath(home)).mode & 0o777).toBe(0o600);
    }

    const server = readEnv(serverEnvPath(home));
    expect(server.MCP_BEARER_TOKEN).toBeTruthy();
    expect(server.SN_PROFILE_ENCRYPTION_KEY).toBeTruthy();
    expect(readFileSync(headerFilePath(home), "utf8")).toContain(
      `Authorization: Bearer ${server.MCP_BEARER_TOKEN}`
    );

    expect(calls.map((call) => [call.command, call.args[0], call.args[1]])).toEqual([
      ["codex", "mcp", "get"],
      ["codex", "mcp", "add"],
      ["claude", "mcp", "get"],
      ["claude", "mcp", "add"],
    ]);

    const claudeAdd = calls[3].args;
    expect(claudeAdd).toContain("--transport");
    expect(claudeAdd).toContain("http");
    // The literal placeholder, never the token itself.
    expect(claudeAdd).toContain("Authorization: Bearer ${SERVICENOW_MCP_BEARER_TOKEN}");
    expect(claudeAdd.join(" ")).not.toContain(server.MCP_BEARER_TOKEN);

    expect(JSON.parse(io.out.join(""))).toMatchObject({
      status: "configured",
      endpoint: "http://127.0.0.1:4444/mcp",
      clients: ["codex", "claude-code"],
    });
    expect(io.err.join("")).toBe("");
  });

  it("prints human-readable next steps by default", async () => {
    const home = newHome("sn-mcp-setup-text-");
    const io = capture();

    await runSetupCli({
      home,
      argv: ["--clients", "none"],
      env: { HOME: home },
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
    });

    const text = io.out.join("");
    expect(text).toContain("servicenow-mcp-profile create");
    expect(text).toContain("servicenow-mcp-setup grant");
    expect(text).toContain("servicenow-mcp-setup doctor");
    expect(text).toContain("MCP_MAX_CONCURRENT_REQUESTS");
    // No secret material in human output.
    expect(text).not.toContain(readEnv(serverEnvPath(home)).MCP_BEARER_TOKEN);
  });

  it("restores 0600 on a pre-existing world-readable env file", async () => {
    if (!POSIX) return;
    const home = newHome("sn-mcp-setup-mode-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true });
    writeFileSync(serverEnvPath(home), "MCP_HOST='127.0.0.1'\n");
    chmodSync(serverEnvPath(home), 0o644);

    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(statSync(serverEnvPath(home)).mode & 0o777).toBe(0o600);
  });

  it("keeps the profile encryption key across --force", async () => {
    const home = newHome("sn-mcp-setup-force-");
    const run = async (argv: readonly string[]): Promise<void> => {
      await runSetupCli({
        home,
        argv,
        env: { HOME: home },
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      });
    };

    await run(["--clients", "none", "--json"]);
    const first = readEnv(serverEnvPath(home));

    await run(["--clients", "none", "--json", "--force"]);
    const second = readEnv(serverEnvPath(home));

    expect(second.SN_PROFILE_ENCRYPTION_KEY).toBe(first.SN_PROFILE_ENCRYPTION_KEY);
    expect(second.MCP_BEARER_TOKEN).not.toBe(first.MCP_BEARER_TOKEN);
  });

  it("refuses to rotate the encryption key while a profile file exists", async () => {
    const home = newHome("sn-mcp-setup-rotate-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true });
    writeFileSync(profileConfigPath(home), '{"version":2,"profiles":{}}\n', { mode: 0o600 });

    await expect(
      runSetupCli({
        home,
        argv: ["--clients", "none", "--rotate-encryption-key"],
        env: { HOME: home },
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      })
    ).rejects.toThrow(/permanently unreadable/u);
  });

  it("refuses to mint a new encryption key over an existing profile file", async () => {
    const home = newHome("sn-mcp-setup-keyloss-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true });
    writeFileSync(serverEnvPath(home), "MCP_HOST='127.0.0.1'\n", { mode: 0o600 });
    writeFileSync(profileConfigPath(home), '{"version":2,"profiles":{}}\n', { mode: 0o600 });

    await expect(
      runSetupCli({
        home,
        argv: ["--clients", "none"],
        env: { HOME: home },
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      })
    ).rejects.toThrow(/no readable SN_PROFILE_ENCRYPTION_KEY/u);
  });

  it("rejects a cleartext http endpoint that is not loopback", async () => {
    const home = newHome("sn-mcp-setup-http-");
    await expect(
      runSetupCli({
        home,
        argv: ["--endpoint", "http://mcp.internal/mcp"],
        env: { HOME: home },
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      })
    ).rejects.toThrow(/cleartext/u);

    await expect(
      runSetupCli({
        home,
        argv: ["--endpoint", "http://mcp.internal/mcp", "--allow-insecure-http", "--dry-run"],
        env: { HOME: home },
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      })
    ).resolves.toBeUndefined();
  });

  it("names the offending option in an unknown-option error", async () => {
    const home = newHome("sn-mcp-setup-arg-");
    await expect(
      runSetupCli({
        home,
        argv: ["--clientz", "codex"],
        env: { HOME: home },
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      })
    ).rejects.toThrow(/Unknown option --clientz/u);
  });

  it("dry-runs without writing or executing client commands", async () => {
    const home = newHome("sn-mcp-setup-dry-");
    const io = capture();
    let executed = false;

    await runSetupCli({
      home,
      argv: ["setup", "--dry-run", "--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: (value) => io.out.push(value),
      commandExists: () => true,
      runCommand: () => {
        executed = true;
        return { status: 0 };
      },
    });

    expect(executed).toBe(false);
    expect(existsSync(serverEnvPath(home))).toBe(false);
    expect(JSON.parse(io.out.join(""))).toMatchObject({ status: "dry-run", clients: [] });
  });
});

describe("setup client", () => {
  it("emits configuration for every supported client without a secret", async () => {
    const home = newHome("sn-mcp-client-");
    const io = capture();

    await runSetupCli({
      home,
      argv: ["client", "--client", "all"],
      env: { HOME: home },
      writeStdout: (value) => io.out.push(value),
    });

    const text = io.out.join("");
    for (const client of [
      "codex",
      "claude-code",
      "claude-desktop",
      "cursor",
      "vscode",
      "windsurf",
    ]) {
      expect(text).toContain(`## ${client}`);
    }
    expect(text).toContain("claude mcp add --transport http --scope user");
    expect(text).toContain("mcp-remote");
    expect(text).toContain("--header-file");
    expect(text).toContain(headerFilePath(home));
    expect(text).toContain("${input:servicenow-mcp-bearer}");
    expect(existsSync(serverEnvPath(home))).toBe(false);
  });

  it("rejects an unknown client by name", async () => {
    await expect(
      runSetupCli({
        home: newHome("sn-mcp-client-bad-"),
        argv: ["client", "--client", "emacs"],
        writeStdout: () => undefined,
      })
    ).rejects.toThrow(/Unsupported client "emacs"/u);
  });
});

describe("setup grant", () => {
  let home: string;
  let manager: ProfileManager;

  beforeEach(() => {
    home = newHome("sn-mcp-grant-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
    manager.addProfile("dev", {
      instance: "https://dev00001.service-now.com",
      authType: "basic",
      username: "integration.user",
      credential: "env:SN_PASSWORD",
    });
  });

  it("writes validated table access rules onto an existing profile", async () => {
    const io = capture();
    await runSetupCli({
      home,
      argv: ["grant", "--profile", "dev", "--read", "incident,problem", "--write", "incident", "--json"],
      profileManager: manager,
      writeStdout: (value) => io.out.push(value),
    });

    const report = JSON.parse(io.out.join("")) as {
      status: string;
      tableAccess: {
        readTables: string[];
        writeTables: string[];
        targets: Array<{ table: string; tools: string[]; closureComplete: boolean }>;
      };
    };
    expect(report.status).toBe("granted");
    expect(report.tableAccess.readTables).toEqual(["incident", "problem"]);
    expect(report.tableAccess.writeTables).toEqual(["incident"]);

    const incident = report.tableAccess.targets.find((target) => target.table === "incident");
    expect(incident?.closureComplete).toBe(true);
    expect(incident?.tools).toContain("sn_query");
    expect(incident?.tools).toContain("sn_update");
    // Destructive tools are never granted implicitly.
    expect(incident?.tools).not.toContain("sn_delete");
    expect(incident?.tools).not.toContain("sn_batch");

    const problem = report.tableAccess.targets.find((target) => target.table === "problem");
    expect(problem?.tools).not.toContain("sn_update");

    // Persisted, and the credential source survived the rewrite.
    const reloaded = new ProfileManager({ configFilePath: profileConfigPath(home) });
    expect(reloaded.getProfile("dev").tableAccess?.readTables).toEqual(["incident", "problem"]);
    expect(reloaded.getProfile("dev").credential).toMatchObject({
      type: "secret_ref",
      provider: "env",
      reference: "SN_PASSWORD",
    });
  });

  it("adds to existing rules and records related tables", async () => {
    const run = async (argv: readonly string[]): Promise<string> => {
      const io = capture();
      await runSetupCli({
        home,
        argv,
        profileManager: manager,
        writeStdout: (value) => io.out.push(value),
      });
      return io.out.join("");
    };

    await run(["grant", "--profile", "dev", "--read", "incident", "--json"]);
    const second = JSON.parse(
      await run([
        "grant",
        "--profile",
        "dev",
        "--read",
        "change_request",
        "--related",
        "change_request=task",
        "--json",
      ])
    ) as { tableAccess: { readTables: string[]; targets: Array<{ table: string; relatedTables: string[] }> } };

    // `task` joins the allowlist because the closure requires it, but it gets
    // no target entry, so it stays unaddressable.
    expect(second.tableAccess.readTables).toEqual(["change_request", "incident", "task"]);
    expect(second.tableAccess.targets.map((target) => target.table).sort()).toEqual([
      "change_request",
      "incident",
    ]);
    expect(
      second.tableAccess.targets.find((target) => target.table === "change_request")?.relatedTables
    ).toEqual(["change_request", "task"]);
  });

  it("replaces rules under --replace", async () => {
    const io = capture();
    await runSetupCli({
      home,
      argv: ["grant", "--profile", "dev", "--read", "incident", "--json"],
      profileManager: manager,
      writeStdout: () => undefined,
    });
    await runSetupCli({
      home,
      argv: ["grant", "--profile", "dev", "--read", "problem", "--replace", "--json"],
      profileManager: manager,
      writeStdout: (value) => io.out.push(value),
    });
    const report = JSON.parse(io.out.join("")) as { tableAccess: { readTables: string[] } };
    expect(report.tableAccess.readTables).toEqual(["problem"]);
  });

  it("writes only tableAccess, so it cannot widen past the built-in policies", async () => {
    const io = capture();
    await runSetupCli({
      home,
      argv: ["grant", "--profile", "dev", "--read", "incident", "--write", "incident", "--json"],
      profileManager: manager,
      writeStdout: (value) => io.out.push(value),
    });

    // The grant payload touches exactly one profile key.
    const report = JSON.parse(io.out.join("")) as { tableAccess: Record<string, unknown> };
    expect(Object.keys(report.tableAccess).sort()).toEqual([
      "readTables",
      "targets",
      "writeTables",
    ]);

    // The field-policy keys are the ones that can relax the built-in field
    // policies. grant must never introduce them, so a granted profile stays
    // bounded by the built-ins exactly as an ungranted one is.
    const persisted = new ProfileManager({
      configFilePath: profileConfigPath(home),
    }).getProfile("dev");
    expect(persisted.fieldPolicy).toBeUndefined();
    expect(persisted.readableTableFields).toBeUndefined();
    expect(persisted.writableTableFields).toBeUndefined();
    expect(JSON.parse(readFileSync(profileConfigPath(home), "utf8"))).not.toHaveProperty(
      "profiles.dev.fieldPolicy"
    );
  });

  it("refuses a wildcard grant", async () => {
    await expect(
      runSetupCli({
        home,
        argv: ["grant", "--profile", "dev", "--read", "*"],
        profileManager: manager,
        writeStdout: () => undefined,
      })
    ).rejects.toThrow(/does not accept "\*"/u);
  });

  // The hard-deny list was removed for 2.0: profile `tableAccess` is the
  // MCP-side authority and ServiceNow's per-user ACLs are the real boundary.
  // A table an operator deliberately grants is therefore accepted, including
  // the credential/auth families that were previously refused outright.
  it("grants a previously hard-denied table when named deliberately", async () => {
    await runSetupCli({
      home,
      argv: ["grant", "--profile", "dev", "--read", "sys_user_password"],
      profileManager: manager,
      writeStdout: () => undefined,
    });
    expect(
      manager.getProfile("dev").tableAccess?.readTables
    ).toContain("sys_user_password");
  });

  it("requires an existing profile", async () => {
    await expect(
      runSetupCli({
        home,
        argv: ["grant", "--profile", "nope", "--read", "incident"],
        profileManager: manager,
        writeStdout: () => undefined,
      })
    ).rejects.toThrow(/not found/u);
  });

  it("does not persist under --dry-run", async () => {
    await runSetupCli({
      home,
      argv: ["grant", "--profile", "dev", "--read", "incident", "--dry-run"],
      profileManager: manager,
      writeStdout: () => undefined,
    });
    const reloaded = new ProfileManager({ configFilePath: profileConfigPath(home) });
    expect(reloaded.getProfile("dev").tableAccess).toBeUndefined();
  });
});

describe("setup doctor", () => {
  let home: string;
  let manager: ProfileManager;

  beforeEach(() => {
    home = newHome("sn-mcp-doctor-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
  });

  async function doctor(
    argv: readonly string[],
    probe?: (url: string, init: ProbeRequest) => Promise<ProbeResponse>,
    env: NodeJS.ProcessEnv = { HOME: home },
    override?: ProfileManager
  ): Promise<{ status: string; checks: Array<{ name: string; ok: boolean; detail: string; remedy?: string }> }> {
    const io = capture();
    await runSetupCli({
      home,
      argv,
      env,
      profileManager: override ?? manager,
      ...(probe ? { probe } : {}),
      writeStdout: (value) => io.out.push(value),
    });
    return JSON.parse(io.out.join(""));
  }

  it("reports a profile with no table access as denying every call", async () => {
    manager.addProfile("dev", {
      instance: "https://dev00001.service-now.com",
      authType: "basic",
      username: "u",
      credential: "env:SN_PASSWORD",
    });
    vi.stubEnv("SN_PASSWORD", "not-a-real-value");

    const report = await doctor(["doctor", "--profile", "dev", "--offline", "--json"]);
    const access = report.checks.find((check) => check.name === "profile dev: table access");
    expect(access?.ok).toBe(false);
    expect(access?.detail).toContain("denied");
    expect(access?.remedy).toContain("servicenow-mcp-setup grant --profile dev");
  });

  it("names a malformed instance URL precisely", async () => {
    // ProfileManager.addProfile rejects this shape, so a hand-edited config
    // file is the only way it reaches the server. doctor must catch it there.
    writeFileSync(
      profileConfigPath(home),
      `${JSON.stringify({
        version: 2,
        profiles: {
          bad: {
            instance: "https://dev00001.service-now.com/nav/ui",
            authType: "basic",
            username: "u",
            credential: "env:SN_PASSWORD",
          },
        },
      })}\n`,
      { mode: 0o600 }
    );
    vi.stubEnv("SN_PASSWORD", "not-a-real-value");

    const report = await doctor(
      ["doctor", "--profile", "bad", "--offline", "--json"],
      undefined,
      { HOME: home },
      new ProfileManager({ configFilePath: profileConfigPath(home) })
    );
    const instance = report.checks.find((check) => check.name === "profile bad: instance");
    expect(instance?.ok).toBe(false);
    expect(instance?.detail).toContain("path, query, or fragment");
    expect(instance?.remedy).toContain("https://dev00001.service-now.com");
  });

  it("reports an unresolvable secret reference", async () => {
    manager.addProfile("dev", {
      instance: "https://dev00001.service-now.com",
      authType: "basic",
      username: "u",
      credential: "env:SN_MISSING_SECRET",
    });

    const report = await doctor(["doctor", "--profile", "dev", "--offline", "--json"]);
    const credential = report.checks.find((check) => check.name === "profile dev: credential");
    expect(credential?.ok).toBe(false);
    expect(credential?.detail).toContain("secret_ref source");
    expect(credential?.remedy).toContain("environment variable must be set");
    // The reference name is never printed; inspect reports source kinds only.
    expect(JSON.stringify(report)).not.toContain("SN_MISSING_SECRET");
  });

  it("flags env table allowlists that no longer apply to a profile file", async () => {
    manager.addProfile("dev", {
      instance: "https://dev00001.service-now.com",
      authType: "basic",
      username: "u",
      credential: "env:SN_PASSWORD",
      tableAccess: {
        readTables: ["incident"],
        targets: [
          {
            table: "incident",
            kind: "canonical",
            tools: ["sn_query"],
            closureComplete: true,
            relatedTables: ["incident"],
          },
        ],
      },
    });
    vi.stubEnv("SN_PASSWORD", "not-a-real-value");

    const report = await doctor(["doctor", "--offline", "--json"], undefined, {
      HOME: home,
      SN_ALLOWED_READ_TABLES: "incident",
    });
    const stale = report.checks.find((check) => check.name === "env table allowlist");
    expect(stale?.ok).toBe(false);
    expect(stale?.remedy).toContain("apply only when no profile file exists");
  });

  it("explains a 401 handshake as a bearer mismatch", async () => {
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const report = await doctor(["doctor", "--json"], async (url) =>
      url.endsWith("/health/ready")
        ? { status: 200, body: "" }
        : { status: 401, body: "" }
    );
    const handshake = report.checks.find((check) => check.name === "mcp handshake");
    expect(handshake?.ok).toBe(false);
    expect(handshake?.remedy).toContain("differs from the one in the server env file");
    expect(report.status).toBe("problems");
  });

  it("explains a 503 handshake as the concurrency cap", async () => {
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const report = await doctor(["doctor", "--json"], async (url) =>
      url.endsWith("/health/ready")
        ? { status: 200, body: "" }
        : { status: 503, body: "" }
    );
    expect(
      report.checks.find((check) => check.name === "mcp handshake")?.remedy
    ).toContain("MCP_MAX_CONCURRENT_REQUESTS");
  });

  it("tells the operator to start the service when nothing is listening", async () => {
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const report = await doctor(["doctor", "--json"], async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    });
    const service = report.checks.find((check) => check.name === "service");
    expect(service?.ok).toBe(false);
    expect(service?.remedy).toContain("servicenow-mcp");
  });
});
