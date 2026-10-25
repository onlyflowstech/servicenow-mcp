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
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  encryptionKeyProviderFromValue,
  type ProfileEncryptionKeyProvider,
} from "../src/profile-credentials.js";
import { ProfileManager } from "../src/profile-manager.js";
import {
  authorizeTableAccess,
  authorizeTableAccessPlan,
  createTableAccessPolicy,
  type TableAccessPolicy,
  type TableAccessPolicyInput,
} from "../src/table-policy.js";
import { createToolError } from "../src/tool-error.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";
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
      // The bare command is registered only off Windows; see the next test.
      platform: "linux",
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

  it("registers node and the entrypoint on Windows, even with servicenow-mcp on PATH", async () => {
    const home = newHome("sn-mcp-setup-windows-");
    const entrypoint =
      "C:\\Users\\micha\\AppData\\Roaming\\npm\\node_modules\\@onlyflows\\servicenow-mcp\\dist\\index.js";
    const adds: Array<{ command: string; launch: readonly string[] }> = [];

    await runSetupCli({
      home,
      argv: ["setup", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
      platform: "win32",
      serverEntrypoint: entrypoint,
      // npm's servicenow-mcp.cmd resolves on PATH, but a client spawning
      // without a shell cannot run a .cmd shim, so it must not be registered.
      commandExists: () => true,
      runCommand: (command, args) => {
        if (args[1] === "add") {
          adds.push({ command, launch: args.slice(args.indexOf("--") + 1) });
        }
        return args[1] === "get" ? { status: 1 } : { status: 0 };
      },
    });

    expect(adds).toEqual([
      { command: "codex", launch: [process.execPath, entrypoint] },
      { command: "claude", launch: [process.execPath, entrypoint] },
    ]);
  });

  it("registers with a Windows npm shim that is installed but not on PATH", async () => {
    const home = newHome("sn-mcp-setup-offpath-");
    const appData = join(home, "AppData", "Roaming");
    const codex = join(appData, "npm", "codex.cmd");
    mkdirSync(dirname(codex), { recursive: true });
    writeFileSync(codex, "");
    const commands: string[] = [];
    const io = capture();

    await runSetupCli({
      home,
      argv: ["--clients", "codex,claude-code", "--json"],
      env: { HOME: home, APPDATA: appData },
      writeStdout: (value) => io.out.push(value),
      writeStderr: (value) => io.err.push(value),
      platform: "win32",
      commandExists: () => false,
      runCommand: (command, args) => {
        commands.push(`${command} ${args[1]}`);
        return args[1] === "get" ? { status: 1 } : { status: 0 };
      },
    });

    expect(commands).toEqual([`${codex} get`, `${codex} add`]);
    expect(JSON.parse(io.out.join(""))).toMatchObject({
      clients: ["codex"],
      skipped_clients: ["claude-code (claude CLI not found)"],
    });
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

  it("grants the ATF preset only to authoring and preserves ordinary tool bindings", async () => {
    await runSetupCli({ home, argv: ["grant", "--profile", "dev", "--atf", "--read", "incident"], profileManager: manager, writeStdout: () => undefined });
    const profile = manager.getProfile("dev");
    const targets = profile.tableAccess!.targets!;
    expect(profile.tableAccess!.readTables).toEqual(["incident", "sys_atf_step", "sys_atf_step_config", "sys_atf_test", "sys_atf_test_suite", "sys_element_mapping", "sys_variable_value", "var_dictionary"]);
    expect(profile.tableAccess!.writeTables).toEqual(["sys_atf_step", "sys_atf_test", "sys_atf_test_suite", "sys_atf_test_suite_test", "sys_element_mapping", "sys_variable_value"]);
    for (const target of targets.filter(target => target.table !== "incident")) expect(target.tools).toEqual(["sn_atf_author"]);
    expect(targets.find(target => target.table === "incident")!.tools).not.toContain("sn_atf_author");
    expect(profile.atf?.execute).not.toBe(true);
    expect(profile.atf?.allowScriptSteps).not.toBe(true);
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

  const JOURNAL_TOOLS = ["sn_incident_add_comment", "sn_incident_add_work_note"];
  const READ_DEFAULTS = ["sn_aggregate", "sn_get", "sn_query", "sn_schema"];

  async function grant(argv: readonly string[]): Promise<void> {
    await runSetupCli({
      home,
      argv: ["grant", "--profile", "dev", ...argv],
      profileManager: manager,
      writeStdout: () => undefined,
    });
  }

  function toolsOn(table: string): readonly string[] | undefined {
    return new ProfileManager({ configFilePath: profileConfigPath(home) })
      .getProfile("dev")
      .tableAccess?.targets?.find((target) => target.table === table)?.tools;
  }

  /** Load the persisted rules with the loader the server uses at request time. */
  function persistedPolicy(): TableAccessPolicy {
    const persisted = new ProfileManager({
      configFilePath: profileConfigPath(home),
    }).getProfile("dev");
    return createTableAccessPolicy(persisted.tableAccess!);
  }

  function expectDenied(
    operation: "read" | "write",
    table: string,
    tools: readonly string[]
  ): void {
    const policy = persistedPolicy();
    for (const tool of tools) {
      expect(() => authorizeTableAccess(policy, { operation, table }, tool)).toThrow(
        /denied by policy/u
      );
    }
  }

  describe("incident journal tools", () => {
    it("adds both journal tools to a default incident write grant, and the policy loads", async () => {
      await grant(["--write", "incident"]);

      expect(toolsOn("incident")).toEqual([
        "sn_create",
        "sn_incident_add_comment",
        "sn_incident_add_work_note",
        "sn_update",
      ]);
      const policy = persistedPolicy();
      for (const tool of JOURNAL_TOOLS) {
        expect(
          authorizeTableAccess(policy, { operation: "write", table: "incident" }, tool)
        ).toBe("incident");
      }
      // Destructive tools are still never granted implicitly.
      expect(() =>
        authorizeTableAccess(policy, { operation: "write", table: "incident" }, "sn_delete")
      ).toThrow(/denied by policy/u);
    });

    it("adds neither journal tool to a write grant on another table, or a read-only incident grant", async () => {
      await grant(["--read", "incident", "--write", "change_request"]);

      expect(toolsOn("change_request")).toEqual(["sn_create", "sn_update"]);
      for (const tool of JOURNAL_TOOLS) {
        expect(toolsOn("incident")).not.toContain(tool);
      }
    });

    it("honours an explicit --tools list without adding the journal tools", async () => {
      await grant(["--write", "incident", "--tools", "sn_update"]);

      expect(toolsOn("incident")).toEqual(["sn_update"]);
      expectDenied("write", "incident", JOURNAL_TOOLS);
    });

    it("keeps the existing tools when re-granting, and adds the journal tools to an older target", async () => {
      // A target written before the journal tools were a default, carrying a
      // tool the operator once named explicitly.
      await grant(["--write", "incident", "--tools", "sn_create,sn_delete,sn_update"]);
      expect(toolsOn("incident")).toEqual(["sn_create", "sn_delete", "sn_update"]);

      await grant(["--write", "incident"]);

      expect(toolsOn("incident")).toEqual([
        "sn_create",
        "sn_delete",
        "sn_incident_add_comment",
        "sn_incident_add_work_note",
        "sn_update",
      ]);
      persistedPolicy();
    });

    it("keeps the journal tools when a later grant names --tools", async () => {
      await grant(["--write", "incident"]);
      await grant(["--write", "incident", "--tools", "sn_batch"]);

      expect(toolsOn("incident")).toEqual([
        "sn_batch",
        "sn_create",
        "sn_incident_add_comment",
        "sn_incident_add_work_note",
        "sn_update",
      ]);
      persistedPolicy();
    });

    it("removes the journal tools from an existing profile under --replace with --tools", async () => {
      await grant(["--write", "incident"]);
      await grant(["--replace", "--write", "incident", "--tools", "sn_update"]);

      expect(toolsOn("incident")).toEqual(["sn_update"]);
      expectDenied("write", "incident", JOURNAL_TOOLS);
    });

    it("names the journal tools in the grant help", async () => {
      await expect(grant(["--help"])).rejects.toMatchObject({
        help: expect.stringContaining(JOURNAL_TOOLS.join(",")),
      });
    });
  });

  // The merged allowlists also hold the profile's earlier grants and the
  // related tables of other targets. Default tools must follow only the
  // tables this invocation names, or a later read grant widens writes.
  describe("defaults follow the tables this grant names", () => {
    it("adds no write or journal tool when a read grant follows a narrowed write grant", async () => {
      await grant(["--write", "incident", "--tools", "sn_update"]);
      await grant(["--read", "incident"]);

      expect(toolsOn("incident")).toEqual([...READ_DEFAULTS, "sn_update"].sort());
      expectDenied("write", "incident", ["sn_create", ...JOURNAL_TOOLS]);
      expect(
        authorizeTableAccess(persistedPolicy(), { operation: "write", table: "incident" }, "sn_update")
      ).toBe("incident");
    });

    it("keeps a table reachable only through another target unwritable after a read grant", async () => {
      await grant(["--write", "task", "--related", "task=incident"]);
      expect(toolsOn("incident")).toBeUndefined();
      expectDenied("write", "incident", ["sn_create", "sn_update", ...JOURNAL_TOOLS]);

      await grant(["--read", "incident"]);

      expect(toolsOn("incident")).toEqual(READ_DEFAULTS);
      expectDenied("write", "incident", ["sn_create", "sn_update", ...JOURNAL_TOOLS]);
      // The task target still reaches incident through its closure.
      expect(
        authorizeTableAccess(persistedPolicy(), { operation: "write", table: "task" }, "sn_update")
      ).toBe("task");
    });

    it("adds no read tool when a write grant names a table readable only through another target", async () => {
      await grant(["--read", "task", "--related", "task=incident"]);
      await grant(["--write", "incident"]);

      expect(toolsOn("incident")).toEqual([
        "sn_create",
        "sn_incident_add_comment",
        "sn_incident_add_work_note",
        "sn_update",
      ]);
      expectDenied("read", "incident", READ_DEFAULTS);
    });
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
    commandExists: (command: string) => boolean = () => true,
    overrides: Partial<SetupCliDependencies> = {}
  ): Promise<{ status: string; checks: Array<{ name: string; ok: boolean; detail: string; remedy?: string }> }> {
    const io = capture();
    await runSetupCli({
      home,
      argv,
      env,
      profileManager: override ?? manager,
      commandExists,
      // The PATH-based server command check; Windows is exercised explicitly.
      platform: "linux",
      writeStdout: (value) => io.out.push(value),
      ...overrides,
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

  it("on Windows, passes when node and the entrypoint exist, whatever PATH holds", async () => {
    await runSetupCli({
      home,
      argv: ["--clients", "none", "--json"],
      env: { HOME: home },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });
    const entrypoint = join(home, "index.js");
    writeFileSync(entrypoint, "");

    // The bare command is not on PATH, which is exactly what doctor reported as
    // a failure on a correct Windows install before clients were registered by
    // absolute path.
    const report = await doctor(["doctor", "--json"], { HOME: home }, undefined, () => false, {
      platform: "win32",
      serverEntrypoint: entrypoint,
    });
    const command = report.checks.find((check) => check.name === "server command");
    expect(command?.ok).toBe(true);
    expect(command?.detail).toContain(process.execPath);
    expect(command?.detail).toContain(entrypoint);
    expect(command?.detail).not.toContain("PATH");
  });

  it("on Windows, fails with a reinstall remedy when the entrypoint is missing", async () => {
    const entrypoint = join(home, "missing", "index.js");
    const report = await doctor(["doctor", "--json"], { HOME: home }, undefined, () => true, {
      platform: "win32",
      serverEntrypoint: entrypoint,
    });
    const command = report.checks.find((check) => check.name === "server command");
    expect(command?.ok).toBe(false);
    expect(command?.detail).toContain(entrypoint);
    expect(command?.remedy).toContain("npm i -g @onlyflows/servicenow-mcp");
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

/** Records notes and questions in the order the operator would see them. */
function transcriptOf(scripted: ScriptedPrompter): {
  prompter: ScriptedPrompter;
  events: string[];
} {
  const events: string[] = [];
  return {
    events,
    prompter: {
      ...scripted,
      ask: (question, options) => {
        events.push(`ask: ${question}`);
        return scripted.ask(question, options);
      },
      note: (text) => {
        events.push(`note: ${text}`);
        scripted.note(text);
      },
    },
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
  ): Promise<{ prompter: ScriptedPrompter; out: string; err: string }> {
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
    return { prompter, out: io.out.join(""), err: io.err.join("") };
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
    expect(incident?.tools).toContain("sn_incident_add_comment");
    expect(incident?.tools).toContain("sn_incident_add_work_note");
    expect(incident?.tools).not.toContain("sn_delete");

    expect(out).toContain("Setup complete.");
    expect(out).toContain("servicenow-mcp-setup doctor --profile dev");
    // Never echoes the secret anywhere.
    expect(out).not.toContain("hunter2");
  });

  it("says before the first question that no client CLI is installed", async () => {
    const { prompter, events } = transcriptOf(scriptedPrompter(HAPPY));
    const { out } = await runWizard([], { prompter });

    // Said up front, so the operator can install Claude Code before spending
    // time on a credential, not only in the summary's "(none registered)".
    const warned = events.findIndex((event) =>
      event.includes("No Claude Code (claude) or Codex (codex) CLI was found")
    );
    const firstQuestion = events.findIndex((event) => event.startsWith("ask: "));
    expect(warned).toBeGreaterThanOrEqual(0);
    expect(warned).toBeLessThan(firstQuestion);
    expect(events[warned]).toContain('servicenow-mcp-setup again (choose "clients")');
    expect(prompter.remaining()).toBe(0);
    expect(out).toContain("(none registered)");
  });

  it("registers with Claude Code installed off PATH, and says how to fix PATH", async () => {
    // The Windows native installer's location, in a terminal opened before
    // the install, whose PATH does not include it yet.
    const claude = join(home, ".local", "bin", "claude.exe");
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, "");
    const commands: string[] = [];

    const { prompter, out } = await runWizard([...HAPPY, "y"], {
      platform: "win32",
      serverEntrypoint: join(home, "index.js"),
      commandExists: () => false,
      runCommand: (command, args) => {
        commands.push(`${command} ${args[1]}`);
        return args[1] === "get" ? { status: 1 } : { status: 0 };
      },
    });

    const notes = prompter.notes.join("\n");
    expect(notes).toContain(`Found Claude Code (claude) at ${claude},`);
    expect(notes).toContain("not on this terminal's PATH");
    expect(notes).toContain(`add ${dirname(claude)} to your PATH`);
    expect(commands).toEqual([`${claude} get`, `${claude} add`]);
    expect(out).toContain("Clients   claude-code");
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

  it("refuses an unusable profile name where it is typed, and suggests one", async () => {
    // "my-dev" answers the same prompt again. Had the name been accepted, it
    // would be consumed as the instance and the script would fall out of step.
    const { prompter } = await runWizard(["my dev", "my-dev", ...HAPPY.slice(1)]);

    expect(prompter.rejections).toEqual([
      expect.stringContaining("Spaces aren't allowed"),
    ]);
    expect(prompter.rejections[0]).toContain("Use 1-64 letters, digits");
    expect(prompter.rejections[0]).toContain('Try "my-dev".');
    expect(prompter.remaining()).toBe(0);
    expect(
      new ProfileManager({ configFilePath: profileConfigPath(home) }).getProfile("my-dev").username
    ).toBe("integration.user");
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

  describe("parent tables, resolved by name", () => {
    /**
     * A stand-in sys_db_object. A table's super_class stores its parent; the
     * reference's display value is the parent's label, which differs from the
     * name across most of the CMDB and is what the wizard used to follow.
     */
    const TABLES: Readonly<Record<string, { readonly label: string; readonly parent?: string }>> = {
      cmdb: { label: "Base Configuration Item" },
      cmdb_ci: { label: "Configuration Item", parent: "cmdb" },
      cmdb_ci_hardware: { label: "Hardware", parent: "cmdb_ci" },
      cmdb_ci_computer: { label: "Computer", parent: "cmdb_ci_hardware" },
      cmdb_ci_server: { label: "Server", parent: "cmdb_ci_computer" },
      cmdb_ci_linux_server: { label: "Linux Server", parent: "cmdb_ci_server" },
      task: { label: "Task" },
      incident: { label: "Incident", parent: "task" },
      problem: { label: "Problem", parent: "task" },
      x_cycle: { label: "Cycle", parent: "x_cycle" },
      // A stored name no table can have, as a tampered or broken row would carry.
      x_bad_parent: { label: "Bad Parent", parent: "incident,sys_user" },
    };

    function ancestor(table: string, hops: number): string | undefined {
      let current: string | undefined = table;
      for (let hop = 0; hop < hops && current !== undefined; hop += 1) {
        current = TABLES[current]?.parent;
      }
      return current;
    }

    function json(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    /**
     * Serve sys_db_object reads and OAuth tokens, recording both and each
     * read's Authorization header. With
     * `ignoreFieldList`, every row carries the whole ancestor chain whatever
     * sysparm_fields asked for, so the walk's own depth limit is what holds.
     */
    function stubInstance(options: { readonly ignoreFieldList?: boolean } = {}) {
      const reads: URLSearchParams[] = [];
      const authorizations: string[] = [];
      const tokenBodies: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          const url = new URL(request.url);
          if (url.pathname === "/oauth_token.do") {
            const body = await request.text();
            tokenBodies.push(body);
            // Each token names the secret it was issued for, so a read shows
            // whose credential it carried.
            const secret = new URLSearchParams(body).get("client_secret") ?? "none";
            return json({
              access_token: `tok-${secret}-${tokenBodies.length}`,
              token_type: "Bearer",
              expires_in: 1800,
            });
          }
          if (url.pathname !== "/api/now/table/sys_db_object") return json({}, 404);
          reads.push(url.searchParams);
          authorizations.push(request.headers.get("authorization") ?? "");
          const name = /^name=(.*)$/u.exec(url.searchParams.get("sysparm_query") ?? "")?.[1] ?? "";
          if (name === "x_broken") return json({ error: { message: "boom" } }, 500);
          if (TABLES[name] === undefined) return json({ result: [] });
          const displayValues = url.searchParams.get("sysparm_display_value") === "true";
          const fields = options.ignoreFieldList
            ? ["name", "super_class", ...[1, 2, 3, 4, 5, 6].map((hops) => `${"super_class.".repeat(hops)}name`)]
            : (url.searchParams.get("sysparm_fields") ?? "").split(",");
          const row: Record<string, string> = {};
          for (const field of fields) {
            if (field === "name") row.name = name;
            else if (field === "super_class") {
              const parent = TABLES[name]?.parent;
              row.super_class =
                parent === undefined ? "" : displayValues ? (TABLES[parent]?.label ?? "") : "0".repeat(32);
            } else {
              const hops = field.split(".").length - 1;
              row[field] = ancestor(name, hops) ?? "";
            }
          }
          return json({ result: [row] });
        })
      );
      return { reads, authorizations, tokenBodies, tokens: () => tokenBodies.length };
    }

    const DEFAULT_RESOLVER: Partial<SetupCliDependencies> = { resolveParentTable: undefined };

    /** Every tool that can name a table, for checks that a table is unaddressable. */
    const EVERY_TABLE_TOOL = [
      "sn_query",
      "sn_get",
      "sn_aggregate",
      "sn_schema",
      "sn_create",
      "sn_update",
      "sn_delete",
      "sn_batch",
      "sn_attach",
      "sn_relationships",
      "sn_incident_add_comment",
      "sn_incident_add_work_note",
      "sn_atf_author",
    ];

    /** A basic-auth "dev" profile; `null` answers "None" for that operation. */
    function wizardGranting(
      reads: string | null,
      writes: string | null,
      ...confirms: string[]
    ): string[] {
      return [
        "dev",
        "dev00001.service-now.com",
        "basic",
        "encrypted",
        "integration.user",
        ...(reads === null ? [NONE] : [CUSTOM, reads]),
        ...(writes === null ? [NONE] : [CUSTOM, writes]),
        ...confirms,
      ];
    }

    function wizardReading(tables: string, ...confirms: string[]): string[] {
      return wizardGranting(tables, null, ...confirms);
    }

    function savedProfile() {
      return new ProfileManager({ configFilePath: profileConfigPath(home) }).getProfile("dev");
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("proposes a CMDB parent by its name, where the label differs", async () => {
      const instance = stubInstance();
      const { prompter } = await runWizard(
        wizardReading("cmdb_ci_linux_server,cmdb_ci_hardware", "y", "y"),
        DEFAULT_RESOLVER
      );

      const notes = prompter.notes.join("\n");
      expect(notes).toContain("cmdb_ci_linux_server extends cmdb_ci_server.");
      // "Configuration Item" has a space, so following the label offered nothing.
      expect(notes).toContain("cmdb_ci_hardware extends cmdb_ci.");
      expect(prompter.remaining()).toBe(0);
      expect(savedProfile().tableAccess?.readTables).toEqual([
        "cmdb_ci",
        "cmdb_ci_hardware",
        "cmdb_ci_linux_server",
        "cmdb_ci_server",
      ]);

      // One read per table, of stored values, asking for one ancestor only.
      expect(instance.reads).toHaveLength(2);
      for (const params of instance.reads) {
        expect(params.get("sysparm_display_value")).toBe("false");
        expect(params.get("sysparm_fields")).toBe("name,super_class.name");
        expect(params.get("sysparm_limit")).toBe("1");
      }
      expect(instance.reads.map((params) => params.get("sysparm_query"))).toEqual([
        "name=cmdb_ci_linux_server",
        "name=cmdb_ci_hardware",
      ]);
    });

    it("still proposes task for incident", async () => {
      stubInstance();
      const { prompter } = await runWizard(wizardReading("incident", "y"), DEFAULT_RESOLVER);
      expect(prompter.notes.join("\n")).toContain("incident extends task.");
      expect(savedProfile().tableAccess?.readTables).toEqual(["incident", "task"]);
    });

    it("proposes nothing for a root, unknown, unreadable, or invalid parent", async () => {
      const instance = stubInstance();
      // No confirm is scripted: a single backing-table question would exhaust it.
      const { prompter } = await runWizard(
        wizardReading("task,x_unknown,x_broken,x_bad_parent"),
        DEFAULT_RESOLVER
      );
      expect(prompter.notes.join("\n")).not.toContain(" extends ");
      expect(instance.reads).toHaveLength(4);
      const profile = savedProfile();
      expect(profile.tableAccess?.readTables).toEqual(["task", "x_bad_parent", "x_broken", "x_unknown"]);
      for (const target of profile.tableAccess?.targets ?? []) {
        expect(target.relatedTables).toEqual([target.table]);
      }
    });

    it.each(["Configuration Item", "incident,sys_user"])(
      "offers no injected parent that is not a table name: %s",
      async (parent) => {
        const { prompter } = await runWizard(wizardReading("change_request"), {
          resolveParentTable: async () => parent,
        });
        expect(prompter.notes.join("\n")).not.toContain(" extends ");
        expect(savedProfile().tableAccess?.readTables).toEqual(["change_request"]);
      }
    );

    it("stops at a table that names itself as its parent", async () => {
      stubInstance();
      const { prompter } = await runWizard(wizardReading("x_cycle"), DEFAULT_RESOLVER);
      expect(prompter.notes.join("\n")).not.toContain(" extends ");
      expect(savedProfile().tableAccess?.readTables).toEqual(["x_cycle"]);
    });

    it("proposes only the immediate parent when the row carries the whole chain", async () => {
      stubInstance({ ignoreFieldList: true });
      const { prompter } = await runWizard(
        wizardReading("cmdb_ci_linux_server", "y"),
        DEFAULT_RESOLVER
      );
      expect(prompter.notes.filter((note) => note.includes(" extends "))).toEqual([
        "\n  cmdb_ci_linux_server extends cmdb_ci_server.",
      ]);
      expect(savedProfile().tableAccess?.readTables).toEqual([
        "cmdb_ci_linux_server",
        "cmdb_ci_server",
      ]);
    });

    it("writes a grant the server's policy loader accepts, with the parent unaddressable", async () => {
      stubInstance();
      // The child is in both READS and WRITES, so the parent joins both allowlists.
      await runWizard(
        wizardGranting("cmdb_ci_hardware", "cmdb_ci_hardware", "y"),
        DEFAULT_RESOLVER
      );

      const tableAccess = savedProfile().tableAccess!;
      expect(tableAccess.readTables).toEqual(["cmdb_ci", "cmdb_ci_hardware"]);
      expect(tableAccess.writeTables).toEqual(["cmdb_ci", "cmdb_ci_hardware"]);
      expect(tableAccess.targets).toEqual([
        expect.objectContaining({
          table: "cmdb_ci_hardware",
          closureComplete: true,
          relatedTables: ["cmdb_ci", "cmdb_ci_hardware"],
        }),
      ]);
      // The loader the server uses at request time.
      const policy = createTableAccessPolicy(tableAccess);
      expect(
        authorizeTableAccess(policy, { operation: "read", table: "cmdb_ci_hardware" }, "sn_query")
      ).toBe("cmdb_ci_hardware");
      for (const tool of EVERY_TABLE_TOOL) {
        for (const operation of ["read", "write"] as const) {
          expect(() =>
            authorizeTableAccess(policy, { operation, table: "cmdb_ci" }, tool)
          ).toThrow(/denied by policy/u);
        }
      }
      // sn_relationships always plans a read of cmdb_ci; the parent is no way in.
      const plan = resolveToolTableAccess("sn_relationships", { sys_id: "a".repeat(32) });
      expect(() =>
        authorizeTableAccessPlan(policy, plan.requests, "sn_relationships")
      ).toThrow(/denied by policy/u);
    });

    it("writes the self-only closure when the operator declines the parent", async () => {
      stubInstance();
      await runWizard(wizardGranting("incident", "incident", "n"), DEFAULT_RESOLVER);

      const tableAccess = savedProfile().tableAccess!;
      expect(tableAccess).toEqual({
        readTables: ["incident"],
        writeTables: ["incident"],
        targets: [
          {
            table: "incident",
            kind: "canonical",
            tools: [
              "sn_aggregate",
              "sn_create",
              "sn_get",
              "sn_incident_add_comment",
              "sn_incident_add_work_note",
              "sn_query",
              "sn_schema",
              "sn_update",
            ],
            closureComplete: true,
            relatedTables: ["incident"],
          },
        ],
      } satisfies TableAccessPolicyInput);
      expect(() => createTableAccessPolicy(tableAccess)).not.toThrow();
    });

    describe("a parent selected for the other operation", () => {
      /**
       * Each tool's real access plan on `table`, as "tool operation:table" when
       * the policy allows the whole plan. A plan that fails to resolve fails the
       * test, so no tool drops out of the check unnoticed.
       */
      function reachable(policy: TableAccessPolicy, table: string): string[] {
        const id = "a".repeat(32);
        const fields = { short_description: "x" };
        const argsFor: Readonly<Record<string, Record<string, unknown>>> = {
          sn_query: { table },
          sn_get: { table, sys_id: id },
          sn_aggregate: { table, type: "COUNT" },
          sn_schema: { table },
          sn_create: { table, fields },
          sn_update: { table, sys_id: id, fields },
          sn_delete: { table, sys_id: id },
          sn_batch: {
            table,
            action: "update",
            structured_query: {
              filter: { type: "equality", field: "active", operator: "eq", value: "true" },
            },
            fields,
            confirm: true,
          },
          sn_attach: { action: "list", table, sys_id: id },
        };
        return Object.entries(argsFor).flatMap(([tool, args]) => {
          const plan = resolveToolTableAccess(tool, args);
          try {
            authorizeTableAccessPlan(policy, plan.requests, tool);
          } catch {
            return [];
          }
          return plan.requests.map((request) => `${tool} ${request.operation}:${request.table}`);
        });
      }

      it("reads the child and writes the parent: the parent stays unreadable", async () => {
        stubInstance();
        // incident extends task; task is granted for WRITES only.
        await runWizard(wizardGranting("incident", "task", "y"), DEFAULT_RESOLVER);

        const tableAccess = savedProfile().tableAccess!;
        expect(tableAccess.readTables).toEqual(["incident", "task"]);
        expect(tableAccess.writeTables).toEqual(["task"]);
        expect(tableAccess.targets?.find((target) => target.table === "task")?.tools).toEqual([
          "sn_create",
          "sn_update",
        ]);
        const policy = createTableAccessPolicy(tableAccess);
        expect(reachable(policy, "task")).toEqual(["sn_create write:task", "sn_update write:task"]);
        // Not vacuous: the same read plans resolve and pass on the child.
        expect(reachable(policy, "incident")).toEqual(
          expect.arrayContaining([
            "sn_query read:incident",
            "sn_get read:incident",
            "sn_aggregate read:incident",
          ])
        );
      });

      it("writes the child and reads the parent: the parent stays unwritable", async () => {
        stubInstance();
        await runWizard(wizardGranting("task", "incident", "y"), DEFAULT_RESOLVER);

        const tableAccess = savedProfile().tableAccess!;
        expect(tableAccess.readTables).toEqual(["task"]);
        expect(tableAccess.writeTables).toEqual(["incident", "task"]);
        expect(tableAccess.targets?.find((target) => target.table === "task")?.tools).toEqual([
          "sn_aggregate",
          "sn_get",
          "sn_query",
          "sn_schema",
        ]);
        const policy = createTableAccessPolicy(tableAccess);
        const task = reachable(policy, "task");
        expect(task.filter((entry) => entry.includes("write:task"))).toEqual([]);
        expect(task).toEqual(expect.arrayContaining(["sn_query read:task"]));
        expect(reachable(policy, "incident")).toEqual(
          expect.arrayContaining(["sn_create write:incident", "sn_update write:incident"])
        );
      });
    });

    it("fetches one OAuth token for every parent lookup in a run", async () => {
      const instance = stubInstance();
      await runWizard(
        [
          "dev",
          "dev00001.service-now.com",
          "oauth",
          "client_credentials",
          "encrypted",
          "abc123-client-id",
          CUSTOM,
          "incident,cmdb_ci_linux_server,cmdb_ci_hardware",
          NONE,
          "n",
          "n",
          "n",
        ],
        DEFAULT_RESOLVER,
        ["oauth-client-secret"]
      );
      expect(instance.reads).toHaveLength(3);
      expect(instance.tokens()).toBe(1);
    });

    describe("a client per configuration and per run", () => {
      function oauthScript(reads: string): string[] {
        return [
          "dev00001.service-now.com",
          "oauth",
          "client_credentials",
          "encrypted",
          "abc123-client-id",
          CUSTOM,
          reads,
          NONE,
          "n",
          "n",
        ];
      }

      it("sends each OAuth run's own secret, and each read that run's token", async () => {
        const instance = stubInstance();
        const consoleCalls = (["log", "error", "warn", "info", "debug"] as const).map((method) =>
          vi.spyOn(console, method).mockImplementation(() => undefined)
        );

        const first = await runWizard(["dev", ...oauthScript("incident,problem")], DEFAULT_RESOLVER, [
          "SECRET-A",
        ]);
        const second = await runWizard(
          ["profile", "staging", ...oauthScript("incident,problem")],
          DEFAULT_RESOLVER,
          ["SECRET-B"]
        );

        expect(
          instance.tokenBodies.map((body) => new URLSearchParams(body).get("client_secret"))
        ).toEqual(["SECRET-A", "SECRET-B"]);
        expect(instance.authorizations).toEqual([
          "Bearer tok-SECRET-A-1",
          "Bearer tok-SECRET-A-1",
          "Bearer tok-SECRET-B-2",
          "Bearer tok-SECRET-B-2",
        ]);
        const shown = [
          ...first.prompter.notes,
          first.out,
          first.err,
          ...second.prompter.notes,
          second.out,
          second.err,
          ...consoleCalls.flatMap((spy) => spy.mock.calls.flat().map(String)),
        ].join("\n");
        for (const secret of ["SECRET-A", "SECRET-B", "tok-SECRET"]) {
          expect(shown).not.toContain(secret);
        }
      });

      it("sends each basic run's own password", async () => {
        const instance = stubInstance();
        await runWizard(wizardReading("incident", "n"), DEFAULT_RESOLVER, ["pw-one"]);
        await runWizard(
          ["profile", "staging", ...wizardReading("incident", "n").slice(1)],
          DEFAULT_RESOLVER,
          ["pw-two"]
        );

        expect(
          instance.authorizations.map((header) =>
            Buffer.from(header.replace(/^Basic /u, ""), "base64").toString()
          )
        ).toEqual(["integration.user:pw-one", "integration.user:pw-two"]);
      });
    });
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
      platform: "linux",
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

describe("risky grant warning", () => {
  let home: string;
  let manager: ProfileManager;

  beforeEach(() => {
    home = newHome("sn-mcp-risky-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
    manager.addProfile("dev", {
      instance: "https://dev00001.service-now.com",
      authType: "basic",
      username: "integration.user",
      credential: "env:SN_PASSWORD",
    });
  });

  async function grantOutput(argv: readonly string[]): Promise<string> {
    const io = capture();
    await runSetupCli({
      home,
      argv: ["grant", "--profile", "dev", ...argv],
      profileManager: manager,
      writeStdout: (value) => io.out.push(value),
    });
    return io.out.join("");
  }

  async function wizard(script: readonly string[]) {
    const prompter = scriptedPrompter(script);
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
    });
    return { notes: prompter.notes.join("\n"), out: io.out.join("") };
  }

  it.each([
    "sys_user_has_role",
    "sys_user_grmember",
    "sys_group_has_role",
    "sys_user_role",
    "sysapproval_approver",
  ])("warns on a write grant on %s and still grants it", async (table) => {
    const out = await grantOutput(["--read", table, "--write", table]);
    expect(out).toContain("WARNING: this grant gives write access on privilege-sensitive tables");
    expect(out).toContain(table);
    expect(out).toContain("The grant is still allowed");
    expect(out).toContain("Granted table access on profile dev.");
    // Not blocked: the profile really holds the write grant.
    expect(manager.getProfile("dev").tableAccess?.writeTables).toEqual([table]);
  });

  it("warns on a dry run and in --json output, without blocking either", async () => {
    const dry = await grantOutput(["--write", "sys_user_has_role", "--dry-run"]);
    expect(dry).toContain("WARNING");
    expect(manager.getProfile("dev").tableAccess).toBeUndefined();

    const json = JSON.parse(
      await grantOutput(["--write", "sysapproval_approver", "--json"])
    ) as { status: string; warnings?: string[] };
    expect(json.status).toBe("granted");
    expect(json.warnings?.[0]).toContain("sysapproval_approver");
  });

  it("does not warn for ordinary tables or for a read-only grant on a role table", async () => {
    const ordinary = await grantOutput(["--read", "incident", "--write", "incident"]);
    expect(ordinary).not.toContain("WARNING");
    const readOnly = await grantOutput(["--read", "sys_user_has_role"]);
    expect(readOnly).not.toContain("WARNING");
    const json = JSON.parse(await grantOutput(["--read", "problem", "--json"])) as {
      warnings?: string[];
    };
    expect(json.warnings).toBeUndefined();
  });

  it("warns in the wizard, in the notes and the summary, and the profile is still written", async () => {
    const { notes, out } = await wizard([
      "profile",
      "dev2",
      "dev00002.service-now.com",
      "basic",
      "encrypted",
      "integration.user",
      "Just incident",
      "Enter a custom list",
      "sys_user_has_role",
    ]);
    expect(notes).toContain("WARNING: this grant gives write access");
    expect(out).toContain("WARNING: this grant gives write access");
    expect(manager.getProfile("dev2").tableAccess?.writeTables).toEqual(["sys_user_has_role"]);
  });

  it("does not warn in the wizard for an ordinary write grant", async () => {
    const { notes, out } = await wizard([
      "profile",
      "dev3",
      "dev00003.service-now.com",
      "basic",
      "encrypted",
      "integration.user",
      "Just incident",
      "Just incident",
    ]);
    expect(notes).not.toContain("WARNING");
    expect(out).not.toContain("WARNING");
  });
});

describe("setup policy show", () => {
  let home: string;
  let manager: ProfileManager;

  beforeEach(() => {
    home = newHome("sn-mcp-policy-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
    manager.addProfile("dev", {
      instance: "https://dev00001.service-now.com",
      authType: "oauth",
      grantType: "client_credentials",
      clientId: "client-id-canary",
      clientSecret: "env:SN_CLIENT_SECRET_REF_CANARY",
      credential: "env:SN_PASSWORD_REF_CANARY",
      fieldPolicy: { incident: { readable: ["sys_id", "number"], writable: ["short_description"] } },
      tableAccess: {
        readTables: ["incident"],
        writeTables: ["incident"],
        targets: [
          {
            table: "incident",
            kind: "canonical",
            tools: ["sn_query", "sn_update"],
            closureComplete: true,
            relatedTables: ["incident"],
          },
        ],
      },
    });
  });

  async function show(argv: readonly string[]): Promise<string> {
    const io = capture();
    await runSetupCli({
      home,
      argv: ["policy", "show", ...argv],
      env: { HOME: home },
      profileManager: manager,
      writeStdout: (value) => io.out.push(value),
    });
    return io.out.join("");
  }

  it("prints the effective policy as one table, matching the enforced field sets", async () => {
    const out = await show(["--profile", "dev"]);
    expect(out).toContain("Policy card: dev (https://dev00001.service-now.com)");
    expect(out).toContain("Auth: oauth (client_credentials)");
    expect(out).toMatch(/incident\s+yes\s+yes\s+sn_query,sn_update\s+number,sys_id\s+short_description/u);
    expect(out).toContain("Batch: dry run by default");
  });

  it("never prints a secret, a key, a client id, or a credential reference", async () => {
    const out = await show(["--profile", "dev"]);
    const json = await show(["--profile", "dev", "--json"]);
    for (const text of [out, json]) {
      expect(text).not.toContain("SN_CLIENT_SECRET_REF_CANARY");
      expect(text).not.toContain("SN_PASSWORD_REF_CANARY");
      expect(text).not.toContain("client-id-canary");
      expect(text).not.toMatch(/secret_ref|"credential"|clientSecret/iu);
    }
    expect((JSON.parse(json) as { policy: { profile: string } }).policy.profile).toBe("dev");
  });

  it("requires --profile and a known profile", async () => {
    await expect(show([])).rejects.toThrow(/--profile is required/u);
    await expect(show(["--profile", "nope"])).rejects.toThrow();
  });
});

describe("security review fixes in setup", () => {
  let home: string;
  let manager: ProfileManager;

  beforeEach(() => {
    home = newHome("sn-mcp-secfix-");
    mkdirSync(join(home, ".servicenow-mcp"), { recursive: true, mode: 0o700 });
    manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
  });

  async function run(argv: readonly string[]): Promise<string> {
    const io = capture();
    await runSetupCli({
      home,
      argv,
      env: { HOME: home },
      profileManager: manager,
      writeStdout: (value) => io.out.push(value),
    });
    return io.out.join("");
  }

  const target = (table: string, tools: string[]) => ({
    table,
    kind: "canonical" as const,
    tools,
    closureComplete: true as const,
    relatedTables: [table],
  });

  it("policy show sees a late-sorting write grant behind more than 100 read-only tables", async () => {
    const readOnly = Array.from({ length: 120 }, (_, i) => `a_tbl_${String(i).padStart(3, "0")}`);
    manager.addProfile("big", {
      instance: "https://dev00001.service-now.com",
      authType: "basic",
      username: "u",
      credential: "env:SN_PASSWORD",
      tableAccess: {
        readTables: [...readOnly, "sys_user_has_role"],
        writeTables: ["sys_user_has_role"],
        targets: [
          ...readOnly.map((table) => target(table, ["sn_query"])),
          target("sys_user_has_role", ["sn_query", "sn_create"]),
        ],
      },
    });
    const text = await run(["policy", "show", "--profile", "big"]);
    expect(text).not.toContain("cannot write");
    expect(text).toContain("WARNING: write access on privilege-sensitive tables: sys_user_has_role");
    const json = JSON.parse(await run(["policy", "show", "--profile", "big", "--json"])) as {
      policy: { can_write_anything: boolean; risky_write_tables: string[] };
    };
    expect(json.policy.can_write_anything).toBe(true);
    expect(json.policy.risky_write_tables).toEqual(["sys_user_has_role"]);
  });

  it("policy show prints a bare origin, never a password in the configured URL", async () => {
    // addProfile refuses such a URL, so write the file by hand, as an
    // operator editing config.json could.
    writeFileSync(
      profileConfigPath(home),
      JSON.stringify({
        version: 2,
        profiles: {
          p: {
            instance: "https://admin:canary-pw-123@dev00001.service-now.com",
            authType: "basic",
            username: "u",
            credential: "env:SN_PASSWORD",
            tableAccess: { readTables: ["incident"], targets: [target("incident", ["sn_query"])] },
          },
        },
      }),
      { mode: 0o600 }
    );
    manager = new ProfileManager({ configFilePath: profileConfigPath(home) });
    const text = await run(["policy", "show", "--profile", "p"]);
    const json = await run(["policy", "show", "--profile", "p", "--json"]);
    for (const out of [text, json]) {
      expect(out).not.toContain("canary-pw-123");
      expect(out).toContain("https://dev00001.service-now.com");
    }
  });

  it.each(["sys_script", "sysauto_script", "sys_properties", "sys_user"])(
    "warns on a write grant on %s, and names the real profile, not a placeholder",
    async (table) => {
      manager.addProfile("dev", {
        instance: "https://dev00001.service-now.com",
        authType: "basic",
        username: "u",
        credential: "env:SN_PASSWORD",
      });
      const out = await run(["grant", "--profile", "dev", "--write", table, "--dry-run"]);
      expect(out).toContain("WARNING: this grant gives write access on privilege-sensitive tables");
      expect(out).toContain("policy show --profile dev");
      expect(out).not.toContain("<name>");
    }
  );
});
