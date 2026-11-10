import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AtfConfigurationError,
  DEFAULT_ATF_RESULT_CACHE_SIZE,
  atfConfigFromEnvironment,
  atfHandlerSettings,
  resolveAtfConfig,
  validateAtfConfigInput,
} from "../src/atf-config.js";
import { parseBooleanEnv } from "../src/config.js";
import { ProfileManager } from "../src/profile-manager.js";

const ENV_KEYS = [
  "HOME",
  "SN_PROFILE_NAME",
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH_TYPE",
  "SN_ATF_EXECUTE",
  "SN_ATF_RESULT_CACHE_SIZE",
  "SN_ATF_RESULT_CACHE_DIR",
  "SN_ATF_ALLOW_SCRIPT_STEPS",
  "SN_METADATA_CACHE_TTL_MS",
  "SN_METADATA_CACHE_TABLES",
  "SN_PROFILE_ENCRYPTION_KEY",
  "SN_TEST_USER_PW",
];

let savedEnv: Record<string, string | undefined>;
let tempHome: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sn-mcp-atf-config-"));
  process.env.HOME = tempHome;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tempHome, ".servicenow-mcp", "config.json");
}

function writeConfigFile(config: unknown): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config), "utf-8");
}

const BASE_PROFILE = Object.freeze({
  instance: "https://atf.service-now.com",
  username: "atf-user",
  credential: "env:SN_TEST_USER_PW",
});

describe("parseBooleanEnv", () => {
  it("treats unset and blank values as absent", () => {
    expect(parseBooleanEnv(undefined, "SN_FLAG")).toBeUndefined();
    expect(parseBooleanEnv("  ", "SN_FLAG")).toBeUndefined();
  });

  it("accepts true/false/1/0 in any case", () => {
    expect(parseBooleanEnv("true", "SN_FLAG")).toBe(true);
    expect(parseBooleanEnv(" TRUE ", "SN_FLAG")).toBe(true);
    expect(parseBooleanEnv("1", "SN_FLAG")).toBe(true);
    expect(parseBooleanEnv("False", "SN_FLAG")).toBe(false);
    expect(parseBooleanEnv("0", "SN_FLAG")).toBe(false);
  });

  it.each(["yes", "on", "enabled", "2", "truee"])(
    "rejects %j instead of reading it as false",
    (value) => {
      expect(() => parseBooleanEnv(value, "SN_FLAG")).toThrow(
        "SN_FLAG must be true or false"
      );
    }
  );
});

describe("atfConfigFromEnvironment", () => {
  it("returns only the keys that are set", () => {
    expect(atfConfigFromEnvironment({})).toEqual({});
    expect(
      atfConfigFromEnvironment({ SN_ATF_RESULT_CACHE_SIZE: "25" })
    ).toEqual({ resultCacheSize: 25 });
  });

  it("parses every SN_ATF_* variable", () => {
    expect(
      atfConfigFromEnvironment({
        SN_ATF_EXECUTE: "true",
        SN_ATF_RESULT_CACHE_SIZE: "5",
        SN_ATF_RESULT_CACHE_DIR: "/var/tmp/atf-results",
        SN_ATF_ALLOW_SCRIPT_STEPS: "false",
      })
    ).toEqual({
      execute: true,
      resultCacheSize: 5,
      resultCacheDir: "/var/tmp/atf-results",
      allowScriptSteps: false,
    });
  });

  it.each([
    [{ SN_ATF_RESULT_CACHE_SIZE: "0" }, "SN_ATF_RESULT_CACHE_SIZE must be between 1 and 100"],
    [{ SN_ATF_RESULT_CACHE_SIZE: "101" }, "SN_ATF_RESULT_CACHE_SIZE must be between 1 and 100"],
    [{ SN_ATF_RESULT_CACHE_SIZE: "ten" }, "SN_ATF_RESULT_CACHE_SIZE must be a positive integer"],
    [{ SN_ATF_EXECUTE: "yes" }, "SN_ATF_EXECUTE must be true or false"],
    [{ SN_ATF_ALLOW_SCRIPT_STEPS: "maybe" }, "SN_ATF_ALLOW_SCRIPT_STEPS must be true or false"],
    [{ SN_ATF_RESULT_CACHE_DIR: "atf-results" }, "SN_ATF_RESULT_CACHE_DIR must be an absolute path"],
    [{ SN_ATF_RESULT_CACHE_DIR: "/tmp/\u0001atf" }, "SN_ATF_RESULT_CACHE_DIR must not contain control characters"],
    [{ SN_ATF_RESULT_CACHE_DIR: "/tmp/../etc" }, 'SN_ATF_RESULT_CACHE_DIR must not contain ".." segments'],
  ])("rejects %j with a clear error", (environment, message) => {
    expect(() => atfConfigFromEnvironment(environment)).toThrow(message);
  });
});

describe("validateAtfConfigInput", () => {
  it("returns a frozen copy of the stated keys", () => {
    const validated = validateAtfConfigInput({
      execute: true,
      resultCacheSize: 100,
      resultCacheDir: "/srv/atf",
    });
    expect(validated).toEqual({
      execute: true,
      resultCacheSize: 100,
      resultCacheDir: "/srv/atf",
    });
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it.each([
    [null, "atf must be an object"],
    [[], "atf must be an object"],
    ["execute", "atf must be an object"],
    [{ run: true }, "atf supports only execute, resultCacheSize, resultCacheDir, allowScriptSteps"],
    [{ execute: "true" }, "atf.execute must be true or false"],
    [{ allowScriptSteps: 1 }, "atf.allowScriptSteps must be true or false"],
    [{ resultCacheSize: 0 }, "atf.resultCacheSize must be an integer between 1 and 100"],
    [{ resultCacheSize: 101 }, "atf.resultCacheSize must be an integer between 1 and 100"],
    [{ resultCacheSize: 2.5 }, "atf.resultCacheSize must be an integer between 1 and 100"],
    [{ resultCacheSize: "10" }, "atf.resultCacheSize must be an integer between 1 and 100"],
    [{ resultCacheDir: "" }, "atf.resultCacheDir must be a non-empty string"],
    [{ resultCacheDir: "relative/dir" }, "atf.resultCacheDir must be an absolute path"],
    [{ resultCacheDir: "/srv/\u0001atf" }, "atf.resultCacheDir must not contain control characters"],
    [{ resultCacheDir: `/${"a".repeat(1100)}` }, "atf.resultCacheDir must not exceed 1024 characters"],
  ])("rejects %j", (candidate, message) => {
    expect(() => validateAtfConfigInput(candidate)).toThrow(AtfConfigurationError);
    expect(() => validateAtfConfigInput(candidate)).toThrow(message);
  });

  it("never echoes the rejected value", () => {
    const value = "relative-canary-value";
    try {
      validateAtfConfigInput({ resultCacheDir: value });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });
});

describe("resolveAtfConfig", () => {
  it("denies both grants and uses the default size when nothing is stated", () => {
    expect(resolveAtfConfig(undefined, {})).toEqual({
      execute: false,
      allowScriptSteps: false,
      resultCacheSize: DEFAULT_ATF_RESULT_CACHE_SIZE,
    });
  });

  it("never takes a grant from the environment", () => {
    expect(
      resolveAtfConfig(undefined, {
        execute: true,
        allowScriptSteps: true,
        resultCacheSize: 7,
        resultCacheDir: "/env/atf",
      })
    ).toEqual({
      execute: false,
      allowScriptSteps: false,
      resultCacheSize: 7,
      resultCacheDir: "/env/atf",
    });
  });

  it("lets the profile win over the environment", () => {
    expect(
      resolveAtfConfig(
        { execute: true, resultCacheSize: 20, resultCacheDir: "/profile/atf" },
        { resultCacheSize: 7, resultCacheDir: "/env/atf" }
      )
    ).toEqual({
      execute: true,
      allowScriptSteps: false,
      resultCacheSize: 20,
      resultCacheDir: "/profile/atf",
    });
  });

  it("projects only cache settings onto handler settings", () => {
    expect(atfHandlerSettings(undefined)).toEqual({ resultCacheSize: 10 });
    expect(
      atfHandlerSettings(
        resolveAtfConfig({ execute: true, resultCacheDir: "/p" }, {})
      )
    ).toEqual({ resultCacheSize: 10, resultCacheDir: "/p" });
  });
});

describe("ProfileManager atf block", () => {
  it("round-trips through config.json", () => {
    const atf = {
      execute: true,
      resultCacheSize: 25,
      resultCacheDir: "/var/tmp/atf-results",
      allowScriptSteps: false,
    };
    new ProfileManager().addProfile("atf", { ...BASE_PROFILE, atf });

    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as {
      profiles: Record<string, { atf?: unknown }>;
    };
    expect(raw.profiles.atf?.atf).toEqual(atf);

    const reloaded = new ProfileManager();
    expect(reloaded.getProfile("atf").atf).toEqual(atf);
    expect(Object.isFrozen(reloaded.getProfile("atf").atf)).toBe(true);
    expect(reloaded.getAtfConfig("atf")).toEqual(atf);

    process.env.SN_TEST_USER_PW = "atf-password";
    expect(reloaded.getConfig("atf").atf).toEqual(atf);
  });

  it("rejects an invalid block on add without writing the file", () => {
    expect(() =>
      new ProfileManager().addProfile("atf", {
        ...BASE_PROFILE,
        atf: { resultCacheSize: 500 },
      })
    ).toThrow("atf.resultCacheSize must be an integer between 1 and 100");
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it.each([
    [{ resultCacheSize: 0 }, "atf.resultCacheSize must be an integer between 1 and 100"],
    [{ execute: "yes" }, "atf.execute must be true or false"],
    [{ resultCacheDir: "cache" }, "atf.resultCacheDir must be an absolute path"],
    [{ schedule: true }, "atf supports only"],
  ])("explains an invalid block %j in config.json", (atf, message) => {
    writeConfigFile({ version: 2, profiles: { atf: { ...BASE_PROFILE, atf } } });
    expect(() => new ProfileManager()).toThrow(
      `Profile configuration is invalid: ${message}`
    );
  });

  it("gives file profiles environment cache settings but never environment grants", () => {
    writeConfigFile({ version: 2, profiles: { atf: { ...BASE_PROFILE } } });
    process.env.SN_ATF_EXECUTE = "true";
    process.env.SN_ATF_ALLOW_SCRIPT_STEPS = "true";
    process.env.SN_ATF_RESULT_CACHE_SIZE = "7";

    expect(new ProfileManager().getAtfConfig("atf")).toEqual({
      execute: false,
      allowScriptSteps: false,
      resultCacheSize: 7,
    });
  });

  it("prefers the profile's cache size over the environment's", () => {
    writeConfigFile({
      version: 2,
      profiles: { atf: { ...BASE_PROFILE, atf: { resultCacheSize: 20 } } },
    });
    process.env.SN_ATF_RESULT_CACHE_SIZE = "7";
    expect(new ProfileManager().getAtfConfig("atf").resultCacheSize).toBe(20);
  });

  it("builds the environment-only profile's atf block from SN_ATF_*", () => {
    process.env.SN_PROFILE_NAME = "env-atf";
    process.env.SN_INSTANCE = "https://env-atf.service-now.com";
    process.env.SN_USER = "env-user";
    process.env.SN_ATF_EXECUTE = "1";
    process.env.SN_ATF_RESULT_CACHE_SIZE = "3";
    process.env.SN_ATF_RESULT_CACHE_DIR = "/var/tmp/env-atf";

    const manager = new ProfileManager();
    expect(manager.getProfile("env-atf").atf).toEqual({
      execute: true,
      resultCacheSize: 3,
      resultCacheDir: "/var/tmp/env-atf",
    });
    expect(manager.getAtfConfig("env-atf")).toEqual({
      execute: true,
      allowScriptSteps: false,
      resultCacheSize: 3,
      resultCacheDir: "/var/tmp/env-atf",
    });
  });

  it("refuses to build the environment-only profile from a malformed grant", () => {
    process.env.SN_PROFILE_NAME = "env-atf";
    process.env.SN_INSTANCE = "https://env-atf.service-now.com";
    process.env.SN_ATF_EXECUTE = "yes";
    expect(() => new ProfileManager()).toThrow("SN_ATF_EXECUTE must be true or false");
  });

  it("omits the block from profiles that do not state one", () => {
    process.env.SN_PROFILE_NAME = "env-plain";
    process.env.SN_INSTANCE = "https://env-plain.service-now.com";
    const manager = new ProfileManager();
    expect(manager.getProfile("env-plain").atf).toBeUndefined();
    expect(manager.getAtfConfig("env-plain")).toEqual({
      execute: false,
      allowScriptSteps: false,
      resultCacheSize: DEFAULT_ATF_RESULT_CACHE_SIZE,
    });
  });
});
