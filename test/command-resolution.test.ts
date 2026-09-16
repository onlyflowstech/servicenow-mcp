import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { commandInvocation, resolveCommand } from "../src/command-resolution.js";

const WINDOWS = process.platform === "win32";

/** npm's global prefix and the native Claude Code installer's directory. */
const NPM = "C:\\Users\\micha\\AppData\\Roaming\\npm";
const NATIVE = "C:\\Users\\micha\\.local\\bin";
const ENTRYPOINT = `${NPM}\\node_modules\\@onlyflows\\servicenow-mcp\\dist\\index.js`;

/** A case-insensitive fake filesystem, as NTFS behaves. */
function windowsFiles(...paths: string[]): (path: string) => boolean {
  const present = new Set(paths.map((path) => path.toLowerCase()));
  return (path) => present.has(path.toLowerCase());
}

describe("resolveCommand on Windows", () => {
  const env = { Path: `C:\\Windows\\system32;${NPM}` };

  it("finds npm's .cmd shim, never the extensionless script beside it", () => {
    // npm writes all three for every global bin. Only the .cmd runs on Windows.
    const isFile = windowsFiles(
      `${NPM}\\servicenow-mcp`,
      `${NPM}\\servicenow-mcp.cmd`,
      `${NPM}\\servicenow-mcp.ps1`
    );
    expect(resolveCommand("servicenow-mcp", { platform: "win32", env, isFile })).toBe(
      `${NPM}\\servicenow-mcp.cmd`
    );
    expect(
      resolveCommand("servicenow-mcp", {
        platform: "win32",
        env,
        isFile: windowsFiles(`${NPM}\\servicenow-mcp`),
      })
    ).toBeUndefined();
  });

  it("searches PATH in order, then PATHEXT order within a directory", () => {
    const isFile = windowsFiles(
      `${NPM}\\claude.cmd`,
      `${NATIVE}\\claude.cmd`,
      `${NATIVE}\\claude.exe`
    );
    expect(
      resolveCommand("claude", { platform: "win32", env: { Path: `${NATIVE};${NPM}` }, isFile })
    ).toBe(`${NATIVE}\\claude.exe`);
    expect(
      resolveCommand("claude", { platform: "win32", env: { Path: `${NPM};${NATIVE}` }, isFile })
    ).toBe(`${NPM}\\claude.cmd`);
  });

  it("honors a custom PATHEXT and otherwise falls back to Windows' default", () => {
    const isFile = windowsFiles(`${NPM}\\codex.cmd`, `${NPM}\\codex.vbs`);
    expect(resolveCommand("codex", { platform: "win32", env, isFile })).toBe(`${NPM}\\codex.cmd`);
    expect(
      resolveCommand("codex", { platform: "win32", env: { ...env, PATHEXT: ".VBS;.CMD" }, isFile })
    ).toBe(`${NPM}\\codex.vbs`);
  });

  it("reads PATH in any case, skips empty entries, and unquotes quoted ones", () => {
    expect(
      resolveCommand("node", {
        platform: "win32",
        env: { pAtH: ';;"C:\\Program Files\\nodejs";' },
        isFile: windowsFiles("C:\\Program Files\\nodejs\\node.exe"),
      })
    ).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("accepts a name that already carries a PATHEXT extension", () => {
    expect(
      resolveCommand("node.exe", {
        platform: "win32",
        env: { Path: "C:\\Program Files\\nodejs" },
        isFile: windowsFiles("C:\\Program Files\\nodejs\\node.exe"),
      })
    ).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("reports a command that is not installed", () => {
    expect(
      resolveCommand("claude", { platform: "win32", env, isFile: windowsFiles() })
    ).toBeUndefined();
    expect(
      resolveCommand("claude", { platform: "win32", env: {}, isFile: () => true })
    ).toBeUndefined();
  });

  it.runIf(WINDOWS)("resolves node on this Windows machine", () => {
    expect(resolveCommand("node")).toMatch(/\\node\.exe$/iu);
  });
});

describe.runIf(!WINDOWS)("resolveCommand on POSIX", () => {
  it("asks a login shell and returns the path it prints", () => {
    expect(resolveCommand("sh")).toMatch(/\/sh$/u);
  });

  it("reports a command that is not installed", () => {
    expect(resolveCommand("servicenow-mcp-no-such-command")).toBeUndefined();
  });
});

describe("commandInvocation", () => {
  const REGISTER = [
    "mcp",
    "add",
    "--scope",
    "user",
    "servicenow-mcp",
    "--",
    "C:\\Program Files\\nodejs\\node.exe",
    ENTRYPOINT,
  ];

  it("spawns the name as given on POSIX, without searching PATH", () => {
    const invocation = commandInvocation("claude", ["mcp", "get", "servicenow-mcp"], {
      platform: "linux",
      isFile: () => {
        throw new Error("POSIX must not search PATH itself");
      },
    });
    expect(invocation).toEqual({
      command: "claude",
      args: ["mcp", "get", "servicenow-mcp"],
      windowsVerbatimArguments: false,
    });
  });

  it("spawns a Windows .exe by its resolved path, with arguments untouched", () => {
    const invocation = commandInvocation("claude", REGISTER, {
      platform: "win32",
      env: { Path: `${NATIVE};${NPM}` },
      isFile: windowsFiles(`${NATIVE}\\claude.exe`, `${NPM}\\claude.cmd`),
    });
    expect(invocation).toEqual({
      command: `${NATIVE}\\claude.exe`,
      args: REGISTER,
      windowsVerbatimArguments: false,
    });
  });

  it("runs a Windows .cmd shim through cmd.exe with every argument quoted and escaped", () => {
    const invocation = commandInvocation("codex", REGISTER, {
      platform: "win32",
      env: { Path: NPM, ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      isFile: windowsFiles(`${NPM}\\codex.cmd`),
    });
    expect(invocation.command).toBe("C:\\Windows\\system32\\cmd.exe");
    // Node would otherwise re-quote the /c argument and break cmd.exe's parse.
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args).toEqual([
      "/d",
      "/s",
      "/c",
      `""${NPM}\\codex.cmd" ^"mcp^" ^"add^" ^"--scope^" ^"user^" ^"servicenow-mcp^" ^"--^" ` +
        `^"C:\\Program^ Files\\nodejs\\node.exe^" ^"${ENTRYPOINT}^""`,
    ]);
  });

  it("escapes cmd.exe metacharacters and doubles a trailing backslash", () => {
    const invocation = commandInvocation(
      "tool",
      ["a&b|c", "100%", "hi!", "x^y", "(z)", "C:\\dir\\"],
      { platform: "win32", env: { Path: NPM }, isFile: windowsFiles(`${NPM}\\tool.bat`) }
    );
    expect(invocation.command).toBe("cmd.exe");
    expect(invocation.args[3]).toBe(
      `""${NPM}\\tool.bat" ^"a^&b^|c^" ^"100^%^" ^"hi^!^" ^"x^^y^" ^"^(z^)^" ^"C:\\dir\\\\^""`
    );
  });

  it("refuses an argument that cmd.exe cannot carry intact", () => {
    const options = {
      platform: "win32" as const,
      env: { Path: NPM },
      isFile: windowsFiles(`${NPM}\\codex.cmd`),
    };
    expect(() => commandInvocation("codex", ['say "hi"'], options)).toThrow(/quote or line break/u);
    expect(() => commandInvocation("codex", ["one\ntwo"], options)).toThrow(/quote or line break/u);
  });

  it("passes an unresolved Windows command through, so the spawn reports ENOENT", () => {
    expect(
      commandInvocation("claude", ["--version"], {
        platform: "win32",
        env: { Path: NPM },
        isFile: windowsFiles(),
      })
    ).toEqual({ command: "claude", args: ["--version"], windowsVerbatimArguments: false });
  });

  it.runIf(WINDOWS)("round-trips hostile arguments through a real .cmd shim", () => {
    const directory = mkdtempSync(join(tmpdir(), "sn-mcp-cmd-"));
    const script = join(directory, "print-args.js");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(
      join(directory, "print-args.cmd"),
      `@"${process.execPath}" "${script}" %*\r\n`
    );
    const expected = [
      "mcp",
      "C:\\Program Files\\nodejs\\node.exe",
      "a&b|c",
      "100%",
      "hi!",
      "x^y",
      "(z)",
      "C:\\dir\\",
    ];

    const invocation = commandInvocation("print-args", expected, {
      env: { Path: directory, ComSpec: process.env.ComSpec },
    });
    expect(invocation.windowsVerbatimArguments).toBe(true);
    const result = spawnSync(invocation.command, [...invocation.args], {
      encoding: "utf8",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });
});
