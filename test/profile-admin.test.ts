import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PROTECTED_INPUT_BYTES,
  MAX_PROTECTED_INPUT_VALUES,
  MAX_SENSITIVE_VALUE_CHARACTERS,
  createProtectedInputIO,
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
