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

/**
 * Files an earlier release wrote to carry the bearer to clients. Setup no
 * longer creates either. They are named here so their absence can be asserted:
 * a leftover credential file is worse than none, because it looks authoritative
 * while nothing reads it.
 */
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
  it("writes the owner-only server env and registers clients with no credential", async () => {
    const home = newHome("sn-mcp-setup-");
    const io = capture();
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    await runSetupCli({
      home,
      argv: ["setup", "--json"],
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
    }

    const server = readEnv(serverEnvPath(home));
    // Authentication is opt-in, so no token is generated and no file is left
    // behind claiming to hold one.
    expect(server.MCP_BEARER_TOKEN).toBeUndefined();
    expect(existsSync(clientEnvPath(home))).toBe(false);
    expect(existsSync(headerFilePath(home))).toBe(false);
    // The identity that labels every audit record, and the profile key, remain.
    expect(server.MCP_OWNER_ID).toMatch(/^owner-/u);
    expect(server.MCP_CLIENT_ID).toMatch(/^client-/u);
    expect(server.SN_PROFILE_ENCRYPTION_KEY).toBeTruthy();

    expect(calls.map((call) => [call.command, call.args[0], call.args[1]])).toEqual([
      ["codex", "mcp", "get"],
      ["codex", "mcp", "add"],
      ["claude", "mcp", "get"],
      ["claude", "mcp", "add"],
    ]);

    // Both clients are registered as stdio servers: a command to spawn after
    // "--", and no URL anywhere.
    const codexAdd = calls[1].args;
    const claudeAdd = calls[3].args;
    expect(codexAdd).toEqual([
      "mcp",
      "add",
      "servicenow-mcp",
      "--",
      "servicenow-mcp",
    ]);
    expect(claudeAdd).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "servicenow-mcp",
      "--",
      "servicenow-mcp",
    ]);
    // stdio is each CLI's default transport, so naming one would be noise.
    expect(claudeAdd).not.toContain("--transport");
    expect(codexAdd).not.toContain("--url");
    // Neither client is handed a credential, a header, or a variable to read
    // one from; the spawned server resolves its own.
    for (const call of calls) {
      expect(call.args.join(" ")).not.toMatch(/Authorization|BEARER_TOKEN|http:\/\//iu);
      expect(call.args).not.toContain("--header");
      expect(call.args).not.toContain("--bearer-token-env-var");
      expect(call.args).not.toContain("--env");
      expect(call.args).not.toContain("-e");
    }

    expect(JSON.parse(io.out.join(""))).toMatchObject({
      status: "configured",
      transport: "stdio",
      server_command: "servicenow-mcp",
      clients: ["codex", "claude-code"],
    });
    expect(JSON.stringify(JSON.parse(io.out.join("")))).not.toContain("endpoint");
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
    // No secret material in human output. The encryption key is now the only
    // secret in server.env, so it is what this has to prove.
    expect(text).not.toContain(readEnv(serverEnvPath(home)).SN_PROFILE_ENCRYPTION_KEY);
    // The operator is told, in the default output, what the boundary is: the
    // client list and the grants, not a port and not a bearer.
    expect(text).toContain("Transport stdio");
    expect(text).toContain("The server runs as you.");
    expect(text).toContain("any client registered");
    // Nothing suggests a listener, a start command, or a token.
    expect(text).not.toMatch(/UNAUTHENTICATED|MCP_BEARER_TOKEN|endpoint|Start the service/iu);
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
    expect(second.MCP_OWNER_ID).not.toBe(first.MCP_OWNER_ID);
    expect(second.MCP_CLIENT_ID).not.toBe(first.MCP_CLIENT_ID);
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

  /**
   * The 2.0 endpoint flags are refused rather than silently ignored.
   *
   * An operator or script carrying them forward is configuring a listener that
   * no longer exists; failing on the flag says so, where accepting it would
   * produce an install that looks configured and is not.
   */
  it("refuses the endpoint options a listening service needed", async () => {
    const home = newHome("sn-mcp-setup-http-");
    for (const argv of [
      ["--endpoint", "http://127.0.0.1:3000/mcp"],
      ["--endpoint", "http://mcp.internal/mcp", "--allow-insecure-http"],
      ["client", "--endpoint", "http://127.0.0.1:3000/mcp"],
      ["doctor", "--endpoint", "http://127.0.0.1:3000/mcp"],
      ["doctor", "--offline"],
    ]) {
      await expect(
        runSetupCli({
          home,
          argv,
          env: { HOME: home },
          writeStdout: () => undefined,
          writeStderr: () => undefined,
        })
      ).rejects.toThrow(/Unknown option --(?:endpoint|allow-insecure-http|offline)/u);
    }
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
    // The two CLIs get their exact stdio invocation.
    expect(text).toContain("claude mcp add --scope user servicenow-mcp -- servicenow-mcp");
    expect(text).toContain("codex mcp add servicenow-mcp -- servicenow-mcp");
    // The mcp-remote bridge existed only to reach an HTTP endpoint from a
    // stdio-only client. Every client speaks stdio directly now.
    expect(text).not.toContain("mcp-remote");
    expect(text).not.toContain("--transport");
    expect(text).not.toMatch(/https?:\/\//u);

    // Every recipe closes with the same note saying no credential is involved.
    // That note is the only place any of them may mention one.
    const FOOTNOTE =
      "Nothing above carries a ServiceNow credential. The spawned server reads the\n" +
      "profile and its encryption key from ~/.servicenow-mcp, which is owner-only,\n" +
      "so no secret reaches a client configuration file.\n";
    expect(text.split(FOOTNOTE).length - 1).toBe(6);
    const recipes = text.split(FOOTNOTE).join("");
    expect(recipes).not.toMatch(/Authorization/u);
    expect(recipes).not.toContain("--header");
    expect(recipes).not.toContain(headerFilePath(home));
    expect(recipes).not.toContain("servicenow-mcp-bearer");
    expect(existsSync(serverEnvPath(home))).toBe(false);

    // Every JSON/TOML recipe names the same command a client will spawn.
    expect(text.split('"command": "servicenow-mcp"').length - 1).toBe(5);
    expect(text).toContain('command = "servicenow-mcp"');
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
    env: NodeJS.ProcessEnv = { HOME: home },
    override?: ProfileManager,
    commandExists: (command: string) => boolean = () => true
  ): Promise<{ status: string; checks: Array<{ name: string; ok: boolean; detail: string; remedy?: string }> }> {
    const io = capture();
    await runSetupCli({
      home,
      argv,
      env,
      profileManager: override ?? manager,
      commandExists,
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

    const report = await doctor(["doctor", "--profile", "dev", "--json"]);
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
      ["doctor", "--profile", "bad", "--json"],
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

    const report = await doctor(["doctor", "--profile", "dev", "--json"]);
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

    const report = await doctor(["doctor", "--json"], {
      HOME: home,
      SN_ALLOWED_READ_TABLES: "incident",
    });
    const stale = report.checks.find((check) => check.name === "env table allowlist");
    expect(stale?.ok).toBe(false);
    expect(stale?.remedy).toContain("apply only when no profile file exists");
  });

  /**
   * The check that replaced the endpoint probe.
   *
   * A listening service could be probed; a spawned one cannot be, because it
   * does not exist until a client starts it. What can be checked, and what
   * actually breaks an install, is whether the command clients are told to
   * spawn resolves at all.
   */
  it("passes when the command clients spawn resolves on PATH", async () => {
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const report = await doctor(
      ["doctor", "--json"],
      { HOME: home },
      undefined,
      (command) => command === "servicenow-mcp"
    );
    const command = report.checks.find((check) => check.name === "server command");
    expect(command?.ok).toBe(true);
    expect(command?.detail).toContain("stdio");
  });

  it("fails with an absolute-path remedy when the command is not on PATH", async () => {
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const report = await doctor(["doctor", "--json"], { HOME: home }, undefined, () => false);
    const command = report.checks.find((check) => check.name === "server command");
    expect(command?.ok).toBe(false);
    expect(command?.detail).toContain("not on this PATH");
    // The remedy is a registration that cannot depend on the client's PATH.
    expect(command?.remedy).toContain("npm i -g @onlyflows/servicenow-mcp");
    expect(command?.remedy).toContain("index.js");
    expect(report.status).toBe("problems");
  });

  it("reports no service, endpoint, or bearer check at all", async () => {
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    const report = await doctor(["doctor", "--json"]);
    const names = report.checks.map((check) => check.name);
    // These described a listener. Keeping them would report a failure for a
    // process that is not supposed to be running.
    expect(names).not.toContain("service");
    expect(names).not.toContain("mcp handshake");
    expect(names).not.toContain("http authentication");
    expect(JSON.stringify(report)).not.toMatch(/MCP_BEARER_TOKEN|health\/ready|127\.0\.0\.1/u);
    // What remains is everything that can actually be checked locally.
    expect(names).toEqual(
      expect.arrayContaining(["node", "server command", "config directory", "server env"])
    );
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
    // The wizard's last step is a local check pass with nothing to confirm:
    // a client spawns the server, so there is no service to offer to start
    // and no endpoint whose reachability could make this suite depend on
    // whether something happened to be listening on this machine.
    const prompter = scriptedPrompter(script, secrets);
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

  it("bootstraps the owner-only server env and no credential files", async () => {
    await runWizard(HAPPY);
    if (POSIX) {
      expect(statSync(serverEnvPath(home)).mode & 0o777).toBe(0o600);
    }
    const values = readEnv(serverEnvPath(home));
    expect(values.MCP_OWNER_ID).toMatch(/^owner-/u);
    expect(values.MCP_CLIENT_ID).toMatch(/^client-/u);
    expect(values.MCP_BEARER_TOKEN).toBeUndefined();
    expect(existsSync(clientEnvPath(home))).toBe(false);
    expect(existsSync(headerFilePath(home))).toBe(false);
  });

  it("names the boundary a spawned server actually has", async () => {
    const { out } = await runWizard(HAPPY);
    // Not softened into "it's local, so it's fine": it names who is inside the
    // boundary, which under stdio is every client that can spawn the server.
    expect(out).toContain("The server runs as you.");
    expect(out).toContain("any client registered");
    expect(out).toContain("Keep the grants narrow");
    expect(out).toContain("claude mcp remove servicenow-mcp");
    // And it says where the credential is not: in any client's config.
    expect(out).toContain("No ServiceNow credential is copied into a client");

    // Nothing describes a listener, a port, or a token the operator must set.
    expect(out).not.toMatch(
      /UNAUTHENTICATED|MCP_BEARER_TOKEN|Host\/Origin|127\.0\.0\.1|Endpoint/u
    );
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
    const prompter = scriptedPrompter(SCRIPT, ["fresh-machine-secret"]);
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter,
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => false,
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
      prompter: scriptedPrompter(SCRIPT, ["returning-user-secret"]),
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

  it("registers clients with no credential in argv or their environment", async () => {
    const home = newHome("sn-mcp-fresh-register-");
    const adds: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter: scriptedPrompter([...SCRIPT, "y"], ["register-secret"]),
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => true,
      runCommand: (_command, args, env) => {
        if (args[1] === "add") adds.push({ args, env });
        return args[1] === "get" ? { status: 1 } : { status: 0 };
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(adds.length).toBe(2);
    for (const add of adds) {
      expect(add.args.join(" ")).not.toMatch(/Authorization|BEARER_TOKEN/iu);
      expect(add.env.SERVICENOW_MCP_BEARER_TOKEN).toBeUndefined();
    }
    // And nothing was written for a client to read one from.
    expect(existsSync(clientEnvPath(home))).toBe(false);
    expect(existsSync(headerFilePath(home))).toBe(false);
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

    const prompter = scriptedPrompter([...SCRIPT, "y"], ["retry-secret"]);
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

describe("setup wizard closing checks", () => {
  /**
   * The wizard used to end by starting a detached service and polling it for
   * readiness. There is nothing to start now, so it ends by running the same
   * checks `doctor` runs and printing them. These cover the two outcomes:
   * everything resolves, and the command clients spawn does not.
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

  async function wizard(
    home: string,
    overrides: Partial<SetupCliDependencies> & { prompter?: ScriptedPrompter } = {}
  ): Promise<{ prompter: ScriptedPrompter; out: string }> {
    const prompter = overrides.prompter ?? scriptedPrompter(SCRIPT, ["closing-secret"]);
    const io = capture();
    await runSetupCli({
      home,
      argv: [],
      env: { HOME: home },
      interactive: true,
      prompter,
      verifyCredential: async () => ({ ok: true, detail: "accepted" }),
      resolveParentTable: async () => undefined,
      commandExists: () => false,
      writeStdout: (value) => io.out.push(value),
      writeStderr: () => undefined,
      ...overrides,
    });
    return { prompter, out: io.out.join("") };
  }

  it("ends with doctor's own checks rather than a command to run", async () => {
    const home = newHome("sn-mcp-closing-");
    const { prompter, out } = await wizard(home, {
      // Both client CLIs and the server command resolve, so the wizard also
      // asks whether to register them; "y" is the only extra answer.
      prompter: scriptedPrompter([...SCRIPT, "y"], ["closing-secret"]),
      commandExists: () => true,
      runCommand: () => ({ status: 0 }),
    });

    // Nothing extra was asked: the script has no answer for a start prompt,
    // so a surviving one would exhaust it.
    expect(prompter.remaining()).toBe(0);

    const notes = prompter.notes.join("\n");
    expect(notes).toContain("ServiceNow MCP doctor");
    expect(notes).toMatch(/ok\s+server command/u);
    expect(notes).toMatch(/ok\s+profile dev: table access/u);
    expect(notes).toContain("All checks passed.");
    // No readiness poll, no log file, no endpoint.
    expect(notes).not.toMatch(/service\.log|did not become ready|health\/ready/u);

    expect(out).toContain("Setup complete.");
    expect(out).toContain("Transport stdio");
    expect(out).toContain("it will launch the server itself");
  });

  it("reports a server command that will not resolve, and keeps the profile", async () => {
    const home = newHome("sn-mcp-closing-nopath-");
    const { out, prompter } = await wizard(home);

    const notes = prompter.notes.join("\n");
    expect(notes).toMatch(/FAIL\s+server command/u);
    expect(notes).toContain("not on this PATH");
    expect(out).toContain("still need attention");

    // The profile survives: a command that is not on PATH must not discard a
    // credential the instance already accepted.
    const manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
    expect(manager.getProfile("dev").instance).toBe("https://dev00001.service-now.com");
    expect(manager.getProfile("dev").tableAccess?.readTables).toEqual(["incident"]);
  });
});

describe("stdio has no authentication boundary to configure", () => {
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
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    return prompter;
  }

  async function runDoctor(
    home: string,
    argv: readonly string[] = ["doctor"]
  ): Promise<string> {
    const io = capture();
    await runSetupCli({
      home,
      argv,
      env: { HOME: home },
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
    });
    return io.out.join("");
  }

  it("leaves the shell profile alone and asks nothing about exporting a token", async () => {
    const home = newHome("sn-mcp-shell-");
    const zshrc = join(home, ".zshrc");
    writeFileSync(zshrc, "# existing content\n");

    // One answer for "register clients?" and nothing else. A surviving export
    // or start prompt would exhaust the script, so this proves both are gone.
    const prompter = await wizardWith(home, [...SCRIPT, "y"], "shell-secret");

    expect(prompter.remaining()).toBe(0);
    const body = readFileSync(zshrc, "utf8");
    expect(body).toBe("# existing content\n");
    expect(body).not.toContain(SHELL_MARKER);
  });

  it("generates no bearer token, and doctor reports none to configure", async () => {
    const home = newHome("sn-mcp-no-token-");
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    // Setup never wrote one, and never wrote a listen address either.
    const values = readEnv(serverEnvPath(home));
    expect(values.MCP_BEARER_TOKEN).toBeUndefined();
    expect(values.MCP_HOST).toBeUndefined();
    expect(values.MCP_PORT).toBeUndefined();
    expect(values.MCP_OWNER_ID).toMatch(/^owner-/u);
    expect(values.SN_PROFILE_ENCRYPTION_KEY).toBeTruthy();

    // doctor reports no boundary to configure, because there is none: no
    // check named for authentication or an endpoint, and no token anywhere.
    const text = await runDoctor(home);
    expect(text).not.toMatch(/^(?:ok|FAIL)\s+(?:http authentication|service|mcp handshake):/mu);
    expect(text).not.toContain("MCP_BEARER_TOKEN");
    expect(text).not.toMatch(/unauthenticated|Authorization/iu);
  });

  /**
   * A bearer left in `server.env` by a 2.0 install is inert rather than
   * honored. There is no request to attach it to, so reporting it as an active
   * boundary would tell an operator they are protected by something that is
   * not running.
   */
  it("ignores a bearer an earlier install left behind", async () => {
    const home = newHome("sn-mcp-stale-token-");
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    const token = `stale-token-${"a".repeat(32)}`;
    writeFileSync(
      serverEnvPath(home),
      `${readFileSync(serverEnvPath(home), "utf8")}MCP_BEARER_TOKEN='${token}'\n`,
      { mode: 0o600 }
    );

    const text = await runDoctor(home);
    expect(text).not.toContain(token);
    expect(text).not.toContain("MCP_BEARER_TOKEN");
    expect(text).not.toMatch(/^(?:ok|FAIL)\s+http authentication:/mu);
    // And the checks that do exist still ran.
    expect(text).toContain("ServiceNow MCP doctor");
    expect(text).toMatch(/^ok\s+server env:/mu);
  });
});
