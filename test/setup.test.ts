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

import {
  encryptionKeyProviderFromValue,
  type ProfileEncryptionKeyProvider,
} from "../src/profile-credentials.js";
import { ProfileManager } from "../src/profile-manager.js";
import { createToolError } from "../src/tool-error.js";
import {
  classifyVerificationFailure,
  runSetupCli,
  type ProbeRequest,
  type ProbeResponse,
  type SetupCliDependencies,
  type WizardPrompter,
} from "../src/setup.js";

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

// ── wizard ─────────────────────────────────────────────────────────

interface ScriptedPrompter extends WizardPrompter {
  readonly notes: string[];
  readonly rejections: string[];
  remaining(): number;
}

/**
 * Replays a scripted set of answers through the real validation and choice
 * logic, so a rejected answer consumes the next scripted line exactly as a
 * re-prompt would at a terminal.
 */
function scriptedPrompter(
  script: readonly string[],
  secrets: readonly string[] = ["hunter2"]
): ScriptedPrompter {
  const queue = [...script];
  const secretQueue = [...secrets];
  const notes: string[] = [];
  const rejections: string[] = [];
  const next = (): string => {
    const value = queue.shift();
    if (value === undefined) throw new Error("prompter script exhausted");
    return value;
  };
  return {
    notes,
    rejections,
    remaining: () => queue.length,
    async ask(_question, options = {}) {
      for (;;) {
        const raw = next();
        const value = raw === "" ? (options.default ?? "") : raw;
        if (options.choices && !options.choices.includes(value)) {
          rejections.push(`not a choice: ${value}`);
          continue;
        }
        const problem = options.validate?.(value);
        if (problem !== undefined) {
          rejections.push(problem);
          continue;
        }
        return value;
      }
    },
    async confirm(_question, defaultYes) {
      const raw = next().trim().toLowerCase();
      if (raw === "") return defaultYes;
      return raw === "y" || raw === "yes";
    },
    async secret() {
      const value = secretQueue.shift();
      if (value === undefined) throw new Error("secret script exhausted");
      return value;
    },
    note(text) {
      notes.push(text);
    },
    close() {},
  };
}

const FIXED_KEY: ProfileEncryptionKeyProvider = {
  getKey: () => Buffer.alloc(32, 7),
};

const ACCEPTS: SetupCliDependencies["verifyCredential"] = async (config) => ({
  ok: true,
  detail: `${config.instance} accepted the credential.`,
});

/** Answer for the wizard's closing "start the service?" confirmation. */
const DECLINE_START = "n";

/** Nothing is listening, so the wizard offers to start rather than reusing. */
const NOT_LISTENING: SetupCliDependencies["probe"] = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
};

describe("setup wizard", () => {
  let home: string;
  let manager: ProfileManager;

  beforeEach(() => {
    home = newHome("sn-mcp-wizard-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
  });

  async function runWizard(
    script: readonly string[],
    overrides: Partial<SetupCliDependencies> = {},
    secrets: readonly string[] = ["hunter2"]
  ): Promise<{ prompter: ScriptedPrompter; out: string }> {
    // The wizard ends by offering to start the service. These cases are about
    // everything before that, so decline it, and report the endpoint as not
    // ready. Both are explicit: without the injected probe the wizard would
    // reach the real 127.0.0.1:3000, and the suite would pass or fail
    // depending on whether a server happened to be running on this machine.
    const prompter = scriptedPrompter([...script, DECLINE_START], secrets);
    const io = capture();
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter,
      profileManager: manager,
      keyProvider: FIXED_KEY,
      verifyCredential: ACCEPTS,
      resolveParentTable: async () => undefined,
      commandExists: () => false,
      probe: NOT_LISTENING,
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
      ...overrides,
    });
    return { prompter, out: io.out.join("") };
  }

  const CUSTOM = "Enter a custom list";
  const JUST_INCIDENT = "Just incident";
  const NONE = "None";

  const HAPPY = [
    "dev",                          // profile name
    "dev00001.service-now.com",     // instance
    "basic",                        // auth
    "encrypted",                    // credential storage, asked before secrets
    "integration.user",             // username
    CUSTOM,                         // READS selection
    "incident,problem",             // custom read list
    JUST_INCIDENT,                  // WRITES selection
  ];

  it("walks from nothing to a written, granted, verified profile", async () => {
    const { out } = await runWizard(HAPPY);

    const profile = new ProfileManager({
      configFilePath: profileConfigPath(home),
    }).getProfile("dev");

    expect(profile.instance).toBe("https://dev00001.service-now.com");
    expect(profile.authType).toBe("basic");
    expect(profile.username).toBe("integration.user");
    expect(profile.credential).toMatchObject({ type: "encrypted" });

    // The grant is written with the profile, so there is never a window in
    // which the profile exists with no table rules.
    expect(profile.tableAccess?.readTables).toEqual(["incident", "problem"]);
    expect(profile.tableAccess?.writeTables).toEqual(["incident"]);
    const incident = profile.tableAccess?.targets?.find((t) => t.table === "incident");
    expect(incident?.closureComplete).toBe(true);
    expect(incident?.tools).toContain("sn_update");
    expect(incident?.tools).not.toContain("sn_delete");

    expect(out).toContain("Setup complete.");
    expect(out).toContain("servicenow-mcp-setup doctor --profile dev");
    // Never echoes the secret anywhere.
    expect(out).not.toContain("hunter2");
  });

  it("bootstraps owner-only env files as part of the flow", async () => {
    await runWizard(HAPPY);
    if (POSIX) {
      expect(statSync(serverEnvPath(home)).mode & 0o777).toBe(0o600);
      expect(statSync(clientEnvPath(home)).mode & 0o777).toBe(0o600);
      expect(statSync(headerFilePath(home)).mode & 0o777).toBe(0o600);
    }
    expect(readEnv(serverEnvPath(home)).MCP_BEARER_TOKEN).toBeTruthy();
  });

  it("re-prompts on a bad instance instead of exiting", async () => {
    const { prompter } = await runWizard([
      "dev",
      "not a url",                   // rejected: not an absolute URL
      "dev12345.servicenow.com",     // rejected: the missing-hyphen typo
      "https://evil.example.com",    // rejected: not a ServiceNow domain
      "dev00001.service-now.com",    // accepted
      "basic",
      "encrypted",
      "integration.user",
      JUST_INCIDENT,
      NONE,
    ]);
    expect(prompter.rejections.length).toBe(3);
    expect(prompter.rejections[1]).toMatch(/looks like a typo/u);
    expect(prompter.rejections[2]).toMatch(/not a ServiceNow domain/u);
    expect(prompter.remaining()).toBe(0);
  });

  it("re-prompts on an unusable table name", async () => {
    const { prompter } = await runWizard([
      "dev",
      "dev00001.service-now.com",
      "basic",
      "encrypted",
      "integration.user",
      CUSTOM,
      "Incident Table",              // rejected: not a table name
      "*",                           // rejected: wildcard in a custom list
      "incident",                    // accepted
      NONE,
    ]);
    expect(prompter.rejections[0]).toMatch(/is not a ServiceNow table name/u);
    expect(prompter.rejections[1]).toMatch(/does not accept "\*"/u);
  });

  it("writes nothing when the credential is rejected and the operator stops", async () => {
    const attempts: string[] = [];
    await expect(
      runWizard(
        [...HAPPY.slice(0, 5), "n"],
        {
          verifyCredential: async (config) => {
            attempts.push(config.instance);
            return {
              ok: false,
              detail: "dev00001.service-now.com rejected the credential (HTTP 401).",
              remedy: "Check the username and password.",
            };
          },
        }
      )
    ).rejects.toThrow(/No profile was written/u);

    expect(attempts).toHaveLength(1);
    expect(() =>
      new ProfileManager({ configFilePath: profileConfigPath(home) }).getProfile("dev")
    ).toThrow(/not found/u);
  });

  it("retries verification and continues once it succeeds", async () => {
    let calls = 0;
    const { out } = await runWizard(
      [...HAPPY.slice(0, 5), "y", ...HAPPY.slice(5)],
      {
        verifyCredential: async (config) => {
          calls += 1;
          return calls === 1
            ? { ok: false, detail: "rejected", remedy: "check it" }
            : { ok: true, detail: `${config.instance} accepted the credential.` };
        },
      }
    );
    expect(calls).toBe(2);
    expect(out).toContain("Setup complete.");
  });

  it("treats an authenticated-but-denied probe as success and says why", async () => {
    const { prompter } = await runWizard(HAPPY, {
      verifyCredential: async () => ({
        ok: true,
        authenticatedButDenied: true,
        detail: "accepted the credential but denied reading sys_user (HTTP 403).",
      }),
    });
    expect(prompter.notes.join("\n")).toMatch(/metadata\n\s*caching will stay disabled/u);
    expect(
      new ProfileManager({ configFilePath: profileConfigPath(home) }).getProfile("dev")
    ).toBeTruthy();
  });

  it("refuses to clobber an existing profile and re-prompts for a name", async () => {
    manager.addProfile("dev", {
      instance: "https://dev00001.service-now.com",
      authType: "basic",
      username: "existing",
      credential: "env:SN_PASSWORD",
    });

    const { prompter } = await runWizard([
      "profile",                      // add another profile
      "dev",                          // rejected: already exists
      "staging",                      // accepted
      "dev00001.service-now.com",
      "basic",
      "encrypted",
      "integration.user",
      JUST_INCIDENT,
      NONE,
    ]);

    expect(prompter.rejections[0]).toMatch(/already exists/u);
    const reloaded = new ProfileManager({ configFilePath: profileConfigPath(home) });
    expect(reloaded.getProfile("dev").username).toBe("existing");
    expect(reloaded.getProfile("staging").username).toBe("integration.user");
  });

  it("offers the parent table without requiring the operator to know it", async () => {
    await runWizard(
      [
        "dev",
        "dev00001.service-now.com",
        "basic",
        "encrypted",
        "integration.user",
        CUSTOM,
        "change_request",
        NONE,
        "y",                          // yes, declare task as a backing table
      ],
      { resolveParentTable: async (_config, table) => (table === "change_request" ? "task" : undefined) }
    );

    const profile = new ProfileManager({
      configFilePath: profileConfigPath(home),
    }).getProfile("dev");
    // The parent joins the allowlist because the closure requires it, but it
    // gets no target, so it never becomes directly readable.
    expect(profile.tableAccess?.readTables).toEqual(["change_request", "task"]);
    expect(profile.tableAccess?.targets?.map((t) => t.table)).toEqual(["change_request"]);
  });

  it("declining the parent still produces a valid self-only closure", async () => {
    await runWizard(
      [
        "dev",
        "dev00001.service-now.com",
        "basic",
        "encrypted",
        "integration.user",
        CUSTOM,
        "change_request",
        NONE,
        "n",
      ],
      { resolveParentTable: async () => "task" }
    );
    const profile = new ProfileManager({
      configFilePath: profileConfigPath(home),
    }).getProfile("dev");
    expect(profile.tableAccess?.readTables).toEqual(["change_request"]);
  });

  it("captures an OAuth client secret without a username", async () => {
    await runWizard(
      [
        "dev",
        "dev00001.service-now.com",
        "oauth",
        "client_credentials",
        "encrypted",
        "abc123-client-id",
        JUST_INCIDENT,
        NONE,
      ],
      {},
      ["oauth-client-secret"]
    );
    const profile = new ProfileManager({
      configFilePath: profileConfigPath(home),
    }).getProfile("dev");
    expect(profile.authType).toBe("oauth");
    expect(profile.clientId).toBe("abc123-client-id");
    expect(profile.clientSecret).toMatchObject({ type: "encrypted" });
    expect(profile.username).toBeUndefined();
  });

  it("stores a secret_ref when the operator chooses a reference", async () => {
    await runWizard(
      [
        "dev",
        "dev00001.service-now.com",
        "basic",
        "reference",
        "env",
        "integration.user",
        JUST_INCIDENT,
        NONE,
      ],
      {},
      ["SN_DEV_PASSWORD"]
    );
    const profile = new ProfileManager({
      configFilePath: profileConfigPath(home),
    }).getProfile("dev");
    expect(profile.credential).toMatchObject({
      type: "secret_ref",
      provider: "env",
      reference: "SN_DEV_PASSWORD",
    });
  });

  it("leaves no profile behind when the operator aborts mid-flow", async () => {
    await expect(
      runWizard(["dev", "dev00001.service-now.com", "basic"])
    ).rejects.toThrow(/script exhausted/u);
    expect(
      new ProfileManager({ configFilePath: profileConfigPath(home) }).listProfiles()
    ).toEqual([]);
  });
});

describe("setup wizard opt-out", () => {
  it("keeps the non-interactive path when stdin is not a terminal", async () => {
    const home = newHome("sn-mcp-wizard-tty-");
    const io = capture();
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: false,
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
      commandExists: () => false,
    });
    // The established bootstrap output, not the wizard.
    expect(io.out.join("")).toContain("Next steps");
    expect(io.out.join("")).not.toContain("Setup complete.");
    expect(existsSync(serverEnvPath(home))).toBe(true);
  });

  it("keeps the non-interactive path under --non-interactive on a terminal", async () => {
    const home = newHome("sn-mcp-wizard-flag-");
    const io = capture();
    await runSetupCli({
      home,
      argv: ["--non-interactive"],
      env: { HOME: home },
      interactive: true,
      prompter: scriptedPrompter([]),
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
      commandExists: () => false,
    });
    expect(io.out.join("")).toContain("Next steps");
  });

  it("keeps the non-interactive path whenever any other flag is present", async () => {
    const home = newHome("sn-mcp-wizard-flags-");
    const io = capture();
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
    });
    expect(JSON.parse(io.out.join(""))).toMatchObject({ status: "configured" });
  });
});

describe("credential verification diagnosis", () => {
  const config = {
    instance: "https://dev00001.service-now.com",
    user: "integration.user",
    password: "s3cr3t-zx9-value",
    displayValue: "true",
    relDepth: 1,
  } as const;

  const diagnose = (error: unknown, overrides: Record<string, unknown> = {}) =>
    classifyVerificationFailure(error, { ...config, ...overrides } as never);

  it("names a rejected credential and keeps the host, not the secret", () => {
    const result = diagnose(createToolError("authentication", "retry_after_correction"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("dev00001.service-now.com");
    expect(result.detail).toContain("401");
    expect(result.remedy).toMatch(/username and password/u);
    expect(JSON.stringify(result)).not.toContain("s3cr3t-zx9-value");
  });

  it("tailors the 401 remedy to OAuth", () => {
    const result = diagnose(createToolError("authentication", "retry_after_correction"), {
      authType: "oauth",
    });
    expect(result.remedy).toMatch(/OAuth client id and secret/u);
  });

  it("treats an ACL denial as a successful authentication", () => {
    const result = diagnose(createToolError("authorization", "retry_after_correction"));
    expect(result.ok).toBe(true);
    expect(result.authenticatedButDenied).toBe(true);
    expect(result.detail).toContain("accepted the credential");
  });

  it("points a 404 at the instance name rather than the credential", () => {
    const result = diagnose(createToolError("not_found", "do_not_retry"));
    expect(result.ok).toBe(false);
    expect(result.remedy).toMatch(/hibernating developer instance|mistyped subdomain/u);
  });

  it("names DNS failure as a typo", () => {
    const result = diagnose(new Error("getaddrinfo ENOTFOUND dev00001.service-now.com"));
    expect(result.detail).toMatch(/does not resolve in DNS/u);
    expect(result.remedy).toMatch(/typo/u);
  });

  it("names a dropped connection as a likely IP access control list", () => {
    const result = diagnose(new Error("connect ECONNREFUSED 10.0.0.1:443"));
    expect(result.remedy).toMatch(/IP access control/u);
  });

  it("names an untrusted certificate without suggesting it be disabled", () => {
    const result = diagnose(new Error("unable to verify the first certificate"));
    expect(result.detail).toMatch(/certificate/u);
    expect(result.remedy).toMatch(/Install the issuing CA/u);
    expect(result.remedy).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized/u);
  });

  it("falls back to the raw reason when nothing matches", () => {
    const result = diagnose(new Error("something unusual"));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("something unusual");
    expect(result.remedy).toBeTruthy();
  });
});

describe("setup wizard re-run", () => {
  it("re-registers clients without touching an existing profile", async () => {
    const home = newHome("sn-mcp-wizard-rerun-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    const manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
    manager.addProfile("dev", {
      instance: "https://dev00001.service-now.com",
      authType: "basic",
      username: "existing",
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
    const before = readFileSync(profileConfigPath(home), "utf8");

    const io = capture();
    const calls: string[] = [];
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter: scriptedPrompter(["clients", "y"]),
      profileManager: manager,
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
      commandExists: (command) => command === "codex",
      runCommand: (command, args) => {
        calls.push(`${command} ${args[1]}`);
        return args[1] === "get" ? { status: 1 } : { status: 0 };
      },
    });

    expect(calls).toEqual(["codex get", "codex add"]);
    expect(io.out.join("")).toContain("Clients   codex");
    // The profile file is untouched, byte for byte.
    expect(readFileSync(profileConfigPath(home), "utf8")).toBe(before);
  });
});

describe("setup wizard on a genuinely fresh machine", () => {
  /**
   * The wizard writes SN_PROFILE_ENCRYPTION_KEY to server.env and then needs it
   * in the same run. It previously built an environment-backed key provider,
   * which cannot see a key this process never exported, so every first run
   * failed with "Profile encryption key is unavailable" after the operator had
   * already typed everything. No keyProvider is injected here on purpose:
   * injecting one is what hid the defect.
   */
  const SCRIPT = [
    "dev",
    "dev00001.service-now.com",
    "basic",
    "encrypted",
    "integration.user",
    "Just incident",
    "None",
  ];

  it("provisions the encryption key and uses it, with nothing in the environment", async () => {
    const home = newHome("sn-mcp-fresh-");
    vi.stubEnv("SN_PROFILE_ENCRYPTION_KEY", "");

    const io = capture();
    const prompter = scriptedPrompter([...SCRIPT, DECLINE_START], ["fresh-machine-secret"]);
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter,
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => false,
      probe: NOT_LISTENING,
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
    });

    // Names the exact regression: the wizard must never report the key it just
    // wrote as unavailable.
    expect(prompter.notes.join("\n")).not.toContain(
      "Profile encryption key is unavailable"
    );

    // The profile exists and its credential decrypts under the key that the
    // same run wrote to server.env.
    const key = readEnv(serverEnvPath(home)).SN_PROFILE_ENCRYPTION_KEY;
    expect(key).toBeTruthy();
    const manager = new ProfileManager({
      configFilePath: profileConfigPath(home),
      encryptionKeyProvider: encryptionKeyProviderFromValue(key),
    });
    expect(manager.resolveCredential(manager.getProfile("dev"))).toBe(
      "fresh-machine-secret"
    );
    expect(io.out.join("")).toContain("Setup complete.");
  });

  it("reuses the key from an earlier bootstrap rather than minting a new one", async () => {
    const home = newHome("sn-mcp-fresh-existing-");
    vi.stubEnv("SN_PROFILE_ENCRYPTION_KEY", "");

    // An earlier non-interactive bootstrap, as a returning user would have.
    await runSetupCli({
      home,
      argv: ["--non-interactive", "--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    const before = readEnv(serverEnvPath(home)).SN_PROFILE_ENCRYPTION_KEY;

    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter: scriptedPrompter([...SCRIPT, DECLINE_START], ["returning-user-secret"]),
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => false,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const after = readEnv(serverEnvPath(home)).SN_PROFILE_ENCRYPTION_KEY;
    expect(after).toBe(before);
    const manager = new ProfileManager({
      configFilePath: profileConfigPath(home),
      encryptionKeyProvider: encryptionKeyProviderFromValue(after),
    });
    expect(manager.resolveCredential(manager.getProfile("dev"))).toBe(
      "returning-user-secret"
    );
  });

  it("hands client registration the bearer it just provisioned", async () => {
    // Same write-then-read shape as the key. Verified rather than assumed.
    const home = newHome("sn-mcp-fresh-bearer-");
    const seen: Array<string | undefined> = [];
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter: scriptedPrompter([...SCRIPT, "y", DECLINE_START], ["bearer-check-secret"]),
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => true,
      runCommand: (_command, args, env) => {
        if (args[1] === "add") seen.push(env.SERVICENOW_MCP_BEARER_TOKEN);
        return args[1] === "get" ? { status: 1 } : { status: 0 };
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const onDisk = readEnv(clientEnvPath(home)).SERVICENOW_MCP_BEARER_TOKEN;
    expect(seen.length).toBe(2);
    expect(seen.every((value) => value === onDisk)).toBe(true);
    expect(onDisk).toBeTruthy();
  });

  it("retries the save without re-prompting and keeps the verified answers", async () => {
    const home = newHome("sn-mcp-fresh-retry-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    const manager = new ProfileManager({ configFilePath: profileConfigPath(home) });

    let attempts = 0;
    const failOnce = {
      ...manager,
      listProfiles: () => manager.listProfiles(),
      getProfile: (name: string) => manager.getProfile(name),
      addProfile: (name: string, profile: never) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient filesystem failure");
        manager.addProfile(name, profile);
      },
    } as unknown as ProfileManager;

    const prompter = scriptedPrompter([...SCRIPT, "y", DECLINE_START], ["retry-secret"]);
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter,
      profileManager: failOnce,
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => false,
      probe: NOT_LISTENING,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(attempts).toBe(2);
    // The retry consumed only the confirm, so no answer was asked for twice.
    expect(prompter.remaining()).toBe(0);
    expect(prompter.notes.join("\n")).toMatch(/nothing needs re-typing/u);
    const key = readEnv(serverEnvPath(home)).SN_PROFILE_ENCRYPTION_KEY;
    const reloaded = new ProfileManager({
      configFilePath: profileConfigPath(home),
      encryptionKeyProvider: encryptionKeyProviderFromValue(key),
    });
    expect(reloaded.resolveCredential(reloaded.getProfile("dev"))).toBe("retry-secret");
  });
});

describe("setup wizard start-and-verify", () => {
  /**
   * The wizard used to end by printing two commands for the operator to run.
   * It now starts the service and verifies it, so these cover the three
   * outcomes: nothing listening and the operator accepts, something already
   * listening, and a start that never becomes ready.
   */
  const SCRIPT = [
    "dev",
    "dev00001.service-now.com",
    "basic",
    "encrypted",
    "integration.user",
    "Just incident",
    "None",
  ];

  function readyProbe(readyAfter: number): {
    probe: NonNullable<SetupCliDependencies["probe"]>;
    calls: () => number;
  } {
    let seen = 0;
    return {
      calls: () => seen,
      probe: async (url: string): Promise<ProbeResponse> => {
        seen += 1;
        if (seen <= readyAfter) throw new Error("connect ECONNREFUSED");
        return { status: 200, headers: {}, body: "", url } as ProbeResponse;
      },
    };
  }

  it("starts the service and reports it ready", async () => {
    const home = newHome("sn-mcp-start-");
    const started: Array<{ hasBearer: boolean; hasKey: boolean }> = [];
    const { probe } = readyProbe(1);

    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter: scriptedPrompter([...SCRIPT, "y"], ["start-secret"]),
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => false,
      probe,
      startService: (env) => {
        started.push({
          hasBearer: Boolean(env.MCP_BEARER_TOKEN),
          hasKey: Boolean(env.SN_PROFILE_ENCRYPTION_KEY),
        });
        return { pid: 4242 };
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    // Started exactly once, and handed the values setup just provisioned —
    // the service must not depend on the operator sourcing server.env first.
    expect(started).toEqual([{ hasBearer: true, hasKey: true }]);
  });

  it("reuses a service that is already listening instead of starting another", async () => {
    const home = newHome("sn-mcp-start-existing-");
    let startCalls = 0;

    const prompter = scriptedPrompter(SCRIPT, ["existing-secret"]);
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter,
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => false,
      probe: async (url: string) =>
        ({ status: 200, headers: {}, body: "", url }) as ProbeResponse,
      startService: () => {
        startCalls += 1;
        return { pid: 1 };
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    // Nothing was started, and the operator was never asked — the script has
    // no answer for a start confirmation, so a prompt here would throw.
    expect(startCalls).toBe(0);
    expect(prompter.remaining()).toBe(0);
    expect(prompter.notes.join("\n")).toContain("already running");
  });

  it("reports a start that never becomes ready, and names the log", async () => {
    const home = newHome("sn-mcp-start-stuck-");

    const prompter = scriptedPrompter([...SCRIPT, "y"], ["stuck-secret"]);
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter,
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => false,
      probe: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      startService: () => ({ pid: 99 }),
      readyTimeoutMs: 50,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const notes = prompter.notes.join("\n");
    expect(notes).toContain("did not become ready");
    expect(notes).toContain("service.log");
    // The profile still exists: a service that will not start must not
    // discard a credential the instance already accepted.
    const manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
    expect(manager.getProfile("dev").instance).toBe("https://dev00001.service-now.com");
  });
});

describe("bearer reaches the client's environment", () => {
  const SHELL_MARKER = "# servicenow-mcp: bearer for MCP clients";
  const SCRIPT = [
    "dev",
    "dev00001.service-now.com",
    "basic",
    "encrypted",
    "integration.user",
    "Just incident",
    "None",
  ];

  async function wizardWith(
    home: string,
    script: readonly string[],
    secret: string
  ): Promise<ScriptedPrompter> {
    const prompter = scriptedPrompter(script, [secret]);
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home, SHELL: "/bin/zsh" },
      interactive: true,
      prompter,
      profileManager: new ProfileManager({
        configFilePath: profileConfigPath(home),
      }),
      keyProvider: FIXED_KEY,
      verifyCredential: ACCEPTS,
      resolveParentTable: async () => undefined,
      commandExists: () => true,
      runCommand: () => ({ status: 0 }),
      probe: NOT_LISTENING,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    return prompter;
  }

  it("appends the export to the shell profile, preserving what is there", async () => {
    const home = newHome("sn-mcp-shell-");
    const zshrc = join(home, ".zshrc");
    writeFileSync(zshrc, "# existing content\n");

    await wizardWith(home, [...SCRIPT, "y", "y", DECLINE_START], "shell-secret");

    const body = readFileSync(zshrc, "utf8");
    expect(body).toContain("# existing content");
    expect(body).toContain('"$HOME/.servicenow-mcp/client.env"');
    expect(body.split(SHELL_MARKER).length - 1).toBe(1);
  });

  it("does not offer again when the profile already exports it", async () => {
    const home = newHome("sn-mcp-shell-present-");
    const zshrc = join(home, ".zshrc");
    writeFileSync(zshrc, `${SHELL_MARKER}\n# already wired\n`);

    // No answer for the export question: if it were asked, the script would
    // run out and the prompter would throw.
    const prompter = await wizardWith(
      home,
      [...SCRIPT, "y", DECLINE_START],
      "already-secret"
    );
    expect(prompter.remaining()).toBe(0);
    expect(readFileSync(zshrc, "utf8").split(SHELL_MARKER).length - 1).toBe(1);
  });

  it("doctor fails when the bearer is absent and passes when it is present", async () => {
    const home = newHome("sn-mcp-doctor-bearer-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true });
    writeFileSync(clientEnvPath(home), "SERVICENOW_MCP_BEARER_TOKEN='abc'\n", {
      mode: 0o600,
    });

    const runDoctor = async (env: NodeJS.ProcessEnv): Promise<string> => {
      const io = capture();
      await runSetupCli({
        home,
        argv: ["doctor", "--offline"],
        env,
        writeStdout: (value) => io.out.push(value),
        writeStderr: (value) => io.err.push(value),
      });
      return io.out.join("");
    };

    const without = await runDoctor({ HOME: home });
    expect(without).toContain("client bearer");
    expect(without).toMatch(/FAIL\s+client bearer/u);
    // The remedy must name the fix, not merely the symptom.
    expect(without).toContain("client.env");

    const with_ = await runDoctor({ HOME: home, SERVICENOW_MCP_BEARER_TOKEN: "abc" });
    expect(with_).toMatch(/ok\s+client bearer/u);
  });
});
