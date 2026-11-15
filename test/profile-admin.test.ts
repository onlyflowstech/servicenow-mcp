import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_TYPE_OMITTED_NOTICE,
  MAX_PROTECTED_INPUT_BYTES,
  MAX_PROTECTED_INPUT_VALUES,
  MAX_SENSITIVE_VALUE_CHARACTERS,
  createProtectedInputIO,
  defaultNotice,
  parseProfileAdminArguments,
  runProfileAdmin,
  type ProfileAdminIO,
} from "../src/profile-admin.js";
import type { ProfileEncryptionKeyProvider } from "../src/profile-credentials.js";
import { ProfileManager } from "../src/profile-manager.js";

let temporaryDirectory: string;
let configPath: string;

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sn-profile-admin-"));
  configPath = path.join(temporaryDirectory, "config.json");
});

afterEach(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

const keyProvider: ProfileEncryptionKeyProvider = {
  getKey: () => Buffer.alloc(32, 0x63),
};

describe("profile administration argument boundary", () => {
  it.each([
    ["--credential", "history-secret"],
    ["--password", "history-secret"],
    ["--secret", "history-secret"],
    ["--client-secret", "history-secret"],
    ["--api-key", "history-secret"],
    ["--reference", "sensitive/path"],
  ])("rejects credential-bearing argv option %s", (flag, value) => {
    expect(() =>
      parseProfileAdminArguments([
        "create",
        "--name",
        "dev",
        "--instance",
        "https://dev.service-now.com",
        flag,
        value,
      ])
    ).toThrow("Unsupported profile administration option");
  });

  it("rejects inline option values that can be copied into shell history", () => {
    expect(() =>
      parseProfileAdminArguments([
        "create",
        "--name=dev",
        "--instance=https://dev.service-now.com",
      ])
    ).toThrow("arguments are invalid");
  });

  it("reads non-TTY values from protected standard input without echoing", async () => {
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const io = createProtectedInputIO(Readable.from(["protected-value\n"]), sink);
    expect(await io.readSensitive("credential")).toBe("protected-value");
    expect(output).toBe("");
  });

  it("bounds protected stdin bytes, values, value length, and control data", async () => {
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const oversizedBytes = createProtectedInputIO(
      Readable.from([Buffer.alloc(MAX_PROTECTED_INPUT_BYTES + 1, 0x61)]),
      sink
    );
    await expect(oversizedBytes.readSensitive("credential")).rejects.toThrow(
      /size limit/
    );

    const tooMany = createProtectedInputIO(
      Readable.from([
        `${Array.from({ length: MAX_PROTECTED_INPUT_VALUES + 1 }, () => "v").join("\n")}\n`,
      ]),
      sink
    );
    await expect(tooMany.readSensitive("credential")).rejects.toThrow(
      /too many values/
    );

    const longValue = createProtectedInputIO(
      Readable.from([`${"x".repeat(MAX_SENSITIVE_VALUE_CHARACTERS + 1)}\n`]),
      sink
    );
    await expect(longValue.readSensitive("credential")).rejects.toThrow(
      /size limit/
    );

    const control = createProtectedInputIO(
      Readable.from(["before\u0000after\n"]),
      sink
    );
    await expect(control.readSensitive("credential")).rejects.toThrow(
      /control characters/
    );
  });
});

describe("create, inspect, rotate, and remove", () => {
  it("never writes plaintext, ciphertext, keys, or references to CLI output", async () => {
    const manager = new ProfileManager({ configFilePath: configPath, encryptionKeyProvider: keyProvider });
    const output: string[] = [];
    const encryptedIO = scriptedIO(["first-plaintext"], output);
    await runProfileAdmin(
      [
        "create", "--name", "dev", "--instance", "https://dev.service-now.com",
        "--auth-type", "basic", "--username", "admin", "--source", "encrypted",
      ],
      { manager, keyProvider, io: encryptedIO }
    );

    const rawAfterCreate = fs.readFileSync(configPath, "utf8");
    const envelope = JSON.parse(rawAfterCreate).profiles.dev.credential;
    expect(rawAfterCreate).not.toContain("first-plaintext");
    expect(output.join("")).not.toContain("first-plaintext");
    expect(output.join("")).not.toContain(envelope.ciphertext);

    await runProfileAdmin(
      ["inspect", "--name", "dev"],
      { manager, keyProvider, io: encryptedIO }
    );
    expect(output.at(-1)).toContain('"credential":"encrypted"');
    expect(output.at(-1)).not.toContain(envelope.ciphertext);

    const referenceIO = scriptedIO(["opaque/secret/reference"], output);
    await runProfileAdmin(
      [
        "rotate", "--name", "dev", "--field", "credential",
        "--source", "reference", "--provider", "testvault",
      ],
      { manager, keyProvider, io: referenceIO }
    );
    expect(output.join("")).not.toContain("opaque/secret/reference");
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).profiles.dev.credential).toEqual({
      type: "secret_ref",
      provider: "testvault",
      reference: "opaque/secret/reference",
    });

    await runProfileAdmin(
      ["remove", "--name", "dev"],
      { manager, keyProvider, io: referenceIO }
    );
    expect(() => new ProfileManager({ configFilePath: configPath }).getProfile("dev")).toThrow(
      /not found/
    );
  });

  it("refuses an unusable --name before reading any secret", async () => {
    const manager = new ProfileManager({ configFilePath: configPath, encryptionKeyProvider: keyProvider });
    const reads: string[] = [];
    const io: ProfileAdminIO = {
      async readSensitive(label) {
        reads.push(label);
        return "never-used";
      },
      write() {},
    };

    await expect(
      runProfileAdmin(
        [
          "create", "--name", "my dev", "--instance", "https://dev.service-now.com",
          "--auth-type", "basic", "--username", "admin", "--source", "encrypted",
        ],
        { manager, keyProvider, io }
      )
    ).rejects.toThrow(/^Profile name is invalid\. Spaces aren't allowed\. Use 1-64/u);
    expect(reads).toEqual([]);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("prompts separately for OAuth password-grant secrets", async () => {
    const cachedKey = Buffer.alloc(32, 0x63);
    const cachedProvider: ProfileEncryptionKeyProvider = {
      getKey: () => cachedKey,
    };
    const manager = new ProfileManager({
      configFilePath: configPath,
      encryptionKeyProvider: cachedProvider,
    });
    const reads: string[] = [];
    const io: ProfileAdminIO = {
      async readSensitive(label) {
        reads.push(label);
        return label === "credential" ? "user-password" : "oauth-secret";
      },
      write() {},
    };
    await runProfileAdmin(
      [
        "create", "--name", "oauth", "--instance", "https://oauth.service-now.com",
        "--auth-type", "oauth", "--grant-type", "password", "--username", "user",
        "--client-id", "client", "--source", "encrypted",
      ],
      { manager, keyProvider: cachedProvider, io }
    );

    expect(reads).toEqual(["credential", "clientSecret"]);
    expect(manager.getConfig("oauth")).toMatchObject({
      password: "user-password",
      clientSecret: "oauth-secret",
    });
    expect(cachedKey).toEqual(Buffer.alloc(32, 0x63));
  });

  it("rotates encrypted credentials to fresh ciphertext without exposing either revision", async () => {
    const manager = new ProfileManager({
      configFilePath: configPath,
      encryptionKeyProvider: keyProvider,
    });
    const output: string[] = [];
    const io = scriptedIO(["first-encrypted-revision", "second-encrypted-revision"], output);

    await runProfileAdmin(
      [
        "create", "--name", "dev", "--instance", "https://dev.service-now.com",
        "--auth-type", "basic", "--username", "admin", "--source", "encrypted",
      ],
      { manager, keyProvider, io }
    );
    const firstRaw = fs.readFileSync(configPath, "utf8");
    const firstCiphertext = JSON.parse(firstRaw).profiles.dev.credential.ciphertext;

    await runProfileAdmin(
      [
        "rotate", "--name", "dev", "--field", "credential",
        "--source", "encrypted",
      ],
      { manager, keyProvider, io }
    );
    const secondRaw = fs.readFileSync(configPath, "utf8");
    const secondCiphertext = JSON.parse(secondRaw).profiles.dev.credential.ciphertext;

    expect(secondCiphertext).not.toBe(firstCiphertext);
    expect(manager.getConfig("dev").password).toBe("second-encrypted-revision");
    for (const serialized of [firstRaw, secondRaw, output.join("")]) {
      expect(serialized).not.toContain("first-encrypted-revision");
      expect(serialized).not.toContain("second-encrypted-revision");
    }
    expect(output.join("")).not.toContain(firstCiphertext);
    expect(output.join("")).not.toContain(secondCiphertext);
  });
});

describe("create without --auth-type (scripted setup)", () => {
  const BASE = ["create", "--name", "dev", "--instance", "https://dev.service-now.com"];

  async function create(
    args: readonly string[],
    secrets: string[]
  ): Promise<{ notices: string[]; output: string[] }> {
    const manager = new ProfileManager({
      configFilePath: configPath,
      encryptionKeyProvider: keyProvider,
    });
    const notices: string[] = [];
    const output: string[] = [];
    await runProfileAdmin([...BASE, ...args], {
      manager,
      keyProvider,
      io: scriptedIO(secrets, output),
      notice: (text) => notices.push(text),
    });
    return { notices, output };
  }

  const savedProfile = () => JSON.parse(fs.readFileSync(configPath, "utf8")).profiles.dev;

  it("keeps creating a Basic profile, so an existing script does not break", async () => {
    const { output } = await create(
      ["--username", "admin", "--source", "encrypted"],
      ["script-password"]
    );
    expect(JSON.parse(output.join("")).auth_type).toBe("basic");
    expect(savedProfile().username).toBe("admin");
    expect(savedProfile().credential).toMatchObject({ type: "encrypted" });
  });

  it("says so on the notice channel, never in the command's own output", async () => {
    const { notices, output } = await create(
      ["--username", "admin", "--source", "encrypted"],
      ["script-password"]
    );
    expect(notices).toEqual([AUTH_TYPE_OMITTED_NOTICE]);
    expect(AUTH_TYPE_OMITTED_NOTICE).toMatch(/Deprecated/u);
    expect(AUTH_TYPE_OMITTED_NOTICE).toContain("--auth-type oauth");
    expect(AUTH_TYPE_OMITTED_NOTICE).toContain("--auth-type basic");
    // The output stays one JSON document that a script can parse.
    expect(() => JSON.parse(output.join(""))).not.toThrow();
    expect(output.join("")).not.toContain("Deprecated");
    expect(notices.join("")).not.toContain("script-password");
  });

  it.each([
    ["basic", ["--username", "admin"], "credential"],
    ["oauth", ["--client-id", "client-1"], "clientSecret"],
  ])("an explicit --auth-type %s wins and prints no notice", async (authType, extra, field) => {
    const { notices, output } = await create(
      ["--auth-type", authType, ...extra, "--source", "encrypted"],
      ["explicit-secret"]
    );
    expect(notices).toEqual([]);
    expect(JSON.parse(output.join("")).auth_type).toBe(authType);
    expect(savedProfile().authType).toBe(authType);
    expect(savedProfile()[field]).toMatchObject({ type: "encrypted" });
  });

  it("creates an OAuth client-credentials profile with no username", async () => {
    await create(
      ["--auth-type", "oauth", "--client-id", "client-1", "--source", "encrypted"],
      ["client-secret"]
    );
    expect(savedProfile().grantType).toBe("client_credentials");
    expect(savedProfile().clientId).toBe("client-1");
    expect(savedProfile().username).toBeUndefined();
  });

  it("writes the default notice only when the stream is a terminal", () => {
    const written: string[] = [];
    const stream = (isTTY: boolean | undefined) => ({
      ...(isTTY === undefined ? {} : { isTTY }),
      write: (text: string) => written.push(text),
    });
    defaultNotice(stream(true))(AUTH_TYPE_OMITTED_NOTICE);
    expect(written).toEqual([AUTH_TYPE_OMITTED_NOTICE]);
    written.length = 0;
    defaultNotice(stream(false))(AUTH_TYPE_OMITTED_NOTICE);
    defaultNotice(stream(undefined))(AUTH_TYPE_OMITTED_NOTICE);
    expect(written).toEqual([]);
  });

  it("uses the terminal-gated sink when none is injected, so captured stderr stays JSON", async () => {
    const manager = new ProfileManager({
      configFilePath: configPath,
      encryptionKeyProvider: keyProvider,
    });
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // Under the test runner stderr is not a terminal.
      await runProfileAdmin(
        [...BASE, "--username", "admin", "--source", "encrypted"],
        { manager, keyProvider, io: scriptedIO(["pw"], []) }
      );
    } finally {
      process.stderr.write = original;
    }
    expect(written).toEqual([]);
  });

  describe("the real built command", () => {
    const CLI = fileURLToPath(new URL("../dist/profile-admin.js", import.meta.url));
    const KEY = Buffer.alloc(32, 0x42).toString("base64");

    function runCli(args: readonly string[], secret: string) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "sn-profile-cli-home-"));
      try {
        const result = spawnSync(process.execPath, [CLI, ...args], {
          input: `${secret}\n`,
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, SN_PROFILE_ENCRYPTION_KEY: KEY },
        });
        const saved = JSON.parse(
          fs.readFileSync(path.join(home, ".servicenow-mcp", "config.json"), "utf8")
        ).profiles.dev;
        return { ...result, saved };
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }

    it("leaves captured output a single JSON document when --auth-type is omitted", () => {
      const result = runCli(
        [...BASE, "--username", "admin", "--source", "encrypted"],
        "cli-password-value"
      );
      expect(result.status).toBe(0);
      // The result goes to stderr; a script that parses it must still succeed.
      const parsed = JSON.parse(result.stderr);
      expect(parsed).toMatchObject({ name: "dev", auth_type: "basic" });
      expect(result.stderr).not.toContain("Deprecated");
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("cli-password-value");
      expect(result.saved.authType).toBe("basic");
    });

    it("gives the same output when --auth-type is explicit", () => {
      const result = runCli(
        [...BASE, "--auth-type", "basic", "--username", "admin", "--source", "encrypted"],
        "cli-password-value"
      );
      expect(JSON.parse(result.stderr)).toMatchObject({ auth_type: "basic" });
    });
  });
});

function scriptedIO(values: string[], output: string[]): ProfileAdminIO {
  return {
    async readSensitive() {
      const value = values.shift();
      if (!value) throw new Error("missing scripted value");
      return value;
    },
    write(value) {
      output.push(value);
    },
  };
}
