/**
 * Resolve and run the commands setup depends on, on POSIX and on Windows.
 *
 * Setup looks commands up in three places: doctor's server-command check,
 * deciding whether the Claude Code and Codex CLIs are installed, and running
 * those CLIs to register the server. It used to ask `/bin/sh`, which Windows
 * does not have, so every lookup failed there and a correct global install
 * read as missing.
 *
 * @module command-resolution
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { win32 } from "node:path";

export interface CommandResolutionOptions {
  /**
   * Defaults to `process.env`. Only Windows reads it (PATH, PATHEXT, COMSPEC);
   * the POSIX login shell builds its own PATH.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Injected for tests; defaults to a stat that accepts regular files only. */
  readonly isFile?: (path: string) => boolean;
}

/** What to spawn, and whether Node must pass the arguments through verbatim. */
export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/** What Windows itself assumes when PATHEXT is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Characters cmd.exe interprets outside quotes; each is escaped with `^`. */
const CMD_METACHARACTERS = /[()[\]%!^"`<>&|;, *?]/gu;

/**
 * The path a bare command name resolves to, or undefined when it does not
 * resolve.
 *
 * POSIX still asks a login shell, so PATH additions made in shell profiles
 * count exactly as they did before. Windows searches PATH × PATHEXT the way
 * cmd.exe does: each directory in order, and each extension in PATHEXT order
 * within a directory. npm writes an extensionless Git Bash script beside every
 * `.cmd` shim, and Windows cannot run it, so a match without a PATHEXT
 * extension is never returned.
 */
export function resolveCommand(
  command: string,
  options: CommandResolutionOptions = {}
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return resolveWithLoginShell(command);
  return searchWindowsPath(
    command,
    options.env ?? process.env,
    options.isFile ?? isRegularFile
  );
}

/**
 * How to spawn a command so its arguments arrive intact.
 *
 * POSIX spawns the name as given. On Windows, Node refuses to spawn a `.cmd`
 * or `.bat` file without a shell, and npm installs every global CLI as one:
 * `codex` always, and `claude` when it was installed through npm. Those run
 * through `cmd.exe /d /s /c` with every argument quoted and escaped, so
 * cmd.exe cannot reinterpret a path containing spaces, `&`, or `%`. An `.exe`
 * is spawned by its resolved path. A name that does not resolve is passed
 * through unchanged, so the spawn fails with ENOENT rather than failing here.
 */
export function commandInvocation(
  command: string,
  args: readonly string[],
  options: CommandResolutionOptions = {}
): CommandInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return invocation(command, args, false);

  const env = options.env ?? process.env;
  // An absolute path is a CLI found outside PATH; it is already the file.
  const file = win32.isAbsolute(command)
    ? command
    : (searchWindowsPath(command, env, options.isFile ?? isRegularFile) ?? command);
  if (!/\.(?:bat|cmd)$/iu.test(file)) return invocation(file, args, false);

  // /d skips AutoRun commands; /s strips exactly the outer pair of quotes, so
  // the quoted file path inside them survives.
  const line = [`"${file}"`, ...args.map(escapeCmdArgument)].join(" ");
  return invocation(
    environmentValue(env, "COMSPEC") ?? "cmd.exe",
    ["/d", "/s", "/c", `"${line}"`],
    true
  );
}

function invocation(
  command: string,
  args: readonly string[],
  windowsVerbatimArguments: boolean
): CommandInvocation {
  return Object.freeze({
    command,
    args: Object.freeze([...args]),
    windowsVerbatimArguments,
  });
}

/**
 * Quote one argument for the program cmd.exe starts, then escape the whole
 * quoted form for cmd.exe itself. Because even the quotes are escaped, cmd.exe
 * never enters a quoted state, and after it strips the carets the program
 * receives the quoted argument untouched. These are the rules cross-spawn uses
 * (https://qntm.org/cmd).
 *
 * An npm `.cmd` shim parses its arguments a second time when it forwards them
 * with `%*`. One level of escaping still suffices: by then every argument is
 * fully quoted, and the one character that could end that quoting early, `"`,
 * is refused here.
 */
function escapeCmdArgument(argument: string): string {
  // Windows paths cannot contain these, and there is no escaping that carries
  // a line break through cmd.exe, so refuse rather than approximate.
  if (/["\r\n\0]/u.test(argument)) {
    throw new Error("cannot pass an argument containing a quote or line break through cmd.exe");
  }
  // A trailing backslash would escape the closing quote, so double that run.
  let end = argument.length;
  while (end > 0 && argument[end - 1] === "\\") end -= 1;
  const quoted = `"${argument}${argument.slice(end)}"`;
  return quoted.replace(CMD_METACHARACTERS, "^$&");
}

function searchWindowsPath(
  command: string,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean
): string | undefined {
  const extensions = (environmentValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
  const lowered = command.toLowerCase();
  const names = extensions.some((extension) => lowered.endsWith(extension))
    ? [command]
    : extensions.map((extension) => `${command}${extension}`);

  for (const entry of (environmentValue(env, "PATH") ?? "").split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/u, "$1");
    if (directory === "") continue;
    for (const name of names) {
      const candidate = win32.join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Windows environment names are case-insensitive, and PATH is usually `Path`. */
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name && value) return value;
  }
  return undefined;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveWithLoginShell(command: string): string | undefined {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${posixQuote(command)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return undefined;
  // A login shell's profile can print before `command -v` does, so the
  // answer is the last line, not the first.
  const lines = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[lines.length - 1] ?? command;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
