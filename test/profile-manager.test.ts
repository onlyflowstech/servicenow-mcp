import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeInstanceUrl,
  type Profile,
  ProfileManager,
} from "../src/profile-manager.js";
import {
  encryptCredential,
  type ProfileEncryptionKeyProvider,
} from "../src/profile-credentials.js";

/**
 * These tests run a real ProfileManager against a throwaway HOME directory
 * so the host's ~/.servicenow-mcp/config.json and SN_* env vars are never
 * touched. os.homedir() resolves $HOME on darwin/linux.
 */

const ENV_KEYS = [
  "HOME",
  "SN_PROFILE_NAME",
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH_TYPE",
  "SN_CLIENT_ID",
  "SN_CLIENT_SECRET",
  "SN_GRANT_TYPE",
  "SN_API_KEY",
  "SN_API_KEY_HEADER",
  "SN_TIMEOUT_MS",
  "SN_DISPLAY_VALUE",
  "SN_REL_DEPTH",
  "SN_ALLOWED_INSTANCE_HOSTS",
  "SN_PROFILE_ENCRYPTION_KEY",
  "UNSET_PROFILE_SECRET",
  // Test-only variables referenced by sn_profile add round-trip tests
  "SN_TEST_USER_PW",
  "SN_TEST_CLIENT_SECRET",
  "SN_TEST_API_KEY",
];

let savedEnv: Record<string, string | undefined>;
let tempHome: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "sn-mcp-test-"));
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

function writeConfigFile(config: unknown): void {
  const dir = path.join(tempHome, ".servicenow-mcp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf-8");
}

describe("explicit named SN_* environment profile", () => {
  it("does not create a routing target from bare canonical SN_* values", () => {
    process.env.SN_INSTANCE = "https://unmapped.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "must-not-be-resolved";

    const manager = new ProfileManager();
    expect(manager.listProfiles()).toEqual([]);
    expect(() => manager.getProfile("default")).toThrow(/not found/u);
    expect(() => manager.getConfig("default")).toThrow(/not found/u);
  });

  it("maps basic-auth SN_* values only under SN_PROFILE_NAME", () => {
    process.env.SN_PROFILE_NAME = "legacy-env";
    process.env.SN_INSTANCE = "https://legacy.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "placeholder-password";
    process.env.SN_AUTH_TYPE = "basic";

    const manager = new ProfileManager();
    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["legacy-env"]);
    expect(() => manager.getConfig("default")).toThrow(/not found/u);
    const config = manager.getConfig("legacy-env");
    expect(config.instance).toBe("https://legacy.service-now.com");
    expect(config.user).toBe("admin");
    expect(config.password).toBe("placeholder-password");
    expect(config.authType).toBe("basic");
    expect(config.timeoutMs).toBeUndefined();
  });

  it("wires SN_AUTH_TYPE=oauth without requiring SN_PASSWORD", () => {
    process.env.SN_PROFILE_NAME = "oauth-env";
    process.env.SN_INSTANCE = "https://oauth.service-now.com";
    process.env.SN_AUTH_TYPE = "oauth";
    process.env.SN_CLIENT_ID = "my-client-id";
    process.env.SN_CLIENT_SECRET = "fake-oauth-secret";

    const config = new ProfileManager().getConfig("oauth-env");
    expect(config.authType).toBe("oauth");
    expect(config.grantType).toBe("client_credentials");
    expect(config.clientId).toBe("my-client-id");
    expect(config.clientSecret).toBe("fake-oauth-secret");
    expect(config.password).toBe("");
  });

  it("wires SN_AUTH_TYPE=apikey with SN_API_KEY_HEADER", () => {
    process.env.SN_PROFILE_NAME = "apikey-env";
    process.env.SN_INSTANCE = "https://apikey.service-now.com";
    process.env.SN_AUTH_TYPE = "apikey";
    process.env.SN_API_KEY = "fake-api-key";
    process.env.SN_API_KEY_HEADER = "x-custom-key";

    const config = new ProfileManager().getConfig("apikey-env");
    expect(config.authType).toBe("apikey");
    expect(config.apiKey).toBe("fake-api-key");
    expect(config.apiKeyHeader).toBe("x-custom-key");
  });

  it("parses SN_TIMEOUT_MS and ignores invalid values", () => {
    process.env.SN_PROFILE_NAME = "timeout-env";
    process.env.SN_INSTANCE = "https://x.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "placeholder-password";

    process.env.SN_TIMEOUT_MS = "5000";
    expect(new ProfileManager().getConfig("timeout-env").timeoutMs).toBe(5000);

    process.env.SN_TIMEOUT_MS = "not-a-number";
    expect(new ProfileManager().getConfig("timeout-env").timeoutMs).toBeUndefined();
  });

  it("maps the complete canonical SN_* OAuth password-grant configuration", () => {
    process.env.SN_PROFILE_NAME = "oauth-password-env";
    process.env.SN_INSTANCE = "https://oauth-password.service-now.com";
    process.env.SN_USER = "oauth-user";
    process.env.SN_PASSWORD = "oauth-user-password";
    process.env.SN_AUTH_TYPE = "oauth";
    process.env.SN_CLIENT_ID = "oauth-client";
    process.env.SN_CLIENT_SECRET = "oauth-client-secret";
    process.env.SN_GRANT_TYPE = "password";
    process.env.SN_TIMEOUT_MS = "7654";
    process.env.SN_DISPLAY_VALUE = "all";
    process.env.SN_REL_DEPTH = "5";

    expect(new ProfileManager().getConfig("oauth-password-env")).toEqual({
      instance: "https://oauth-password.service-now.com",
      user: "oauth-user",
      password: "oauth-user-password",
      displayValue: "all",
      relDepth: 5,
      authType: "oauth",
      clientId: "oauth-client",
      clientSecret: "oauth-client-secret",
      grantType: "password",
      timeoutMs: 7654,
    });
  });

  it("gives a named file profile precedence without creating an implicit env profile", () => {
    writeConfigFile({
      version: 2,
      default_profile: "ignored-file-default",
      profiles: {
        dev: {
          instance: "https://file-dev.service-now.com",
          username: "file-user",
          credential: "env:SN_TEST_USER_PW",
          timeoutMs: 4321,
        },
      },
    });
    process.env.SN_INSTANCE = "https://environment.service-now.com";
    process.env.SN_PROFILE_NAME = "environment";
    process.env.SN_USER = "environment-user";
    process.env.SN_PASSWORD = "environment-password";
    process.env.SN_AUTH_TYPE = "apikey";
    process.env.SN_API_KEY = "environment-api-key";
    process.env.SN_TIMEOUT_MS = "9876";
    process.env.SN_DISPLAY_VALUE = "false";
    process.env.SN_REL_DEPTH = "4";
    process.env.SN_TEST_USER_PW = "file-profile-password";

    const manager = new ProfileManager();
    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["dev"]);
    expect(() => manager.getConfig("default")).toThrow(/not found/);
    expect(() => manager.getConfig("environment")).toThrow(/not found/);
    expect(() => manager.getConfig("ignored-file-default")).toThrow(/not found/);
    expect(manager.getConfig("dev")).toEqual({
      instance: "https://file-dev.service-now.com",
      user: "file-user",
      password: "file-profile-password",
      displayValue: "false",
      relDepth: 4,
      authType: "basic",
      grantType: "client_credentials",
      timeoutMs: 4321,
    });
  });

  it("rejects an invalid or incomplete explicit environment mapping", () => {
    process.env.SN_PROFILE_NAME = "bad profile name";
    process.env.SN_INSTANCE = "https://bad.service-now.com";
    expect(() => new ProfileManager()).toThrow(/Profile name is invalid/u);

    process.env.SN_PROFILE_NAME = "missing-instance";
    delete process.env.SN_INSTANCE;
    expect(() => new ProfileManager()).toThrow(
      /SN_PROFILE_NAME requires SN_INSTANCE/u
    );
  });

  it.each([
    ["SN_AUTH_TYPE", "digest", /SN_AUTH_TYPE must be basic, oauth, or apikey/u],
    [
      "SN_GRANT_TYPE",
      "device_code",
      /SN_GRANT_TYPE must be client_credentials or password/u,
    ],
  ] as const)(
    "fails closed before secrets or clients for an invalid %s mapping",
    (key, value, expected) => {
      process.env.SN_PROFILE_NAME = "invalid-auth-mapping";
      process.env.SN_INSTANCE = "https://invalid-auth.service-now.com";
      process.env.SN_USER = "must-not-authenticate";
      process.env.SN_PASSWORD = "must-not-resolve";
      process.env.SN_CLIENT_ID = "must-not-authenticate";
      process.env.SN_CLIENT_SECRET = "must-not-resolve";
      if (key === "SN_GRANT_TYPE") process.env.SN_AUTH_TYPE = "oauth";
      process.env[key] = value;
      const resolveSecret = vi.fn(() => {
        throw new Error("secret resolution must not run");
      });
      const fetchProbe = vi.spyOn(globalThis, "fetch");

      expect(
        () =>
          new ProfileManager({
            secretResolvers: [
              {
                provider: "env",
                resolve: resolveSecret,
              },
            ],
          })
      ).toThrow(expected);
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(fetchProbe).not.toHaveBeenCalled();
      fetchProbe.mockRestore();
    }
  );

  it("never persists the mapped SN_* plaintext when administration creates a file", () => {
    const plaintext = "environment-only-secret-must-not-persist";
    process.env.SN_PROFILE_NAME = "environment-prod";
    process.env.SN_INSTANCE = "https://environment-prod.service-now.com";
    process.env.SN_USER = "environment-user";
    process.env.SN_PASSWORD = plaintext;
    process.env.SN_TEST_USER_PW = "second-profile-secret";

    const manager = new ProfileManager();
    manager.addProfile("second", {
      instance: "https://second.service-now.com",
      username: "second-user",
      credential: "env:SN_TEST_USER_PW",
    });

    const raw = fs.readFileSync(manager.getConfigPath(), "utf8");
    const persisted = JSON.parse(raw);
    expect(raw).not.toContain(plaintext);
    expect(persisted).not.toHaveProperty("default_profile");
    expect(persisted.profiles["environment-prod"].credential).toEqual({
      type: "secret_ref",
      provider: "env",
      reference: "SN_PASSWORD",
    });
  });
});

describe("explicit V2 profile selection", () => {
  it("requires a profile name at every accessor type boundary", () => {
    type RequiresArgument<T extends (...args: never[]) => unknown> =
      [] extends Parameters<T> ? false : true;
    const accessorsRequireName: {
      getProfile: RequiresArgument<ProfileManager["getProfile"]>;
      getConfig: RequiresArgument<ProfileManager["getConfig"]>;
      getClient: RequiresArgument<ProfileManager["getClient"]>;
    } = {
      getProfile: true,
      getConfig: true,
      getClient: true,
    };

    expect(accessorsRequireName).toEqual({
      getProfile: true,
      getConfig: true,
      getClient: true,
    });
  });

  it("never routes omitted runtime calls through default_profile", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          username: "admin",
          credential: "env:SN_PASSWORD",
        },
      },
    });
    process.env.SN_PASSWORD = "placeholder-password";
    const profileManager = new ProfileManager();

    expect(() => Reflect.apply(profileManager.getProfile, profileManager, [])).toThrow(
      'Profile "undefined" not found'
    );
    expect(() => Reflect.apply(profileManager.getConfig, profileManager, [])).toThrow(
      'Profile "undefined" not found'
    );
    expect(() => Reflect.apply(profileManager.getClient, profileManager, [])).toThrow(
      'Profile "undefined" not found'
    );
    expect("switchProfile" in profileManager).toBe(false);
    expect("getActiveProfileName" in profileManager).toBe(false);
    expect(profileManager.listProfiles()).toEqual([
      {
        name: "dev",
        instance: "https://dev.service-now.com",
        authType: "basic",
        description: undefined,
      },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["stale", "removed-profile"],
  ])(
    "keeps named profiles when legacy default_profile metadata is %s",
    (_label, defaultProfile) => {
      writeConfigFile({
        version: 1,
        ...(defaultProfile === undefined
          ? {}
          : { default_profile: defaultProfile }),
        profiles: {
          dev: {
            instance: "https://dev.service-now.com",
            username: "admin",
            credential: "env:SN_PASSWORD",
          },
        },
      });
      process.env.SN_PASSWORD = "placeholder-password";

      const profileManager = new ProfileManager();
      expect(profileManager.getConfig("dev")).toMatchObject({
        instance: "https://dev.service-now.com",
        user: "admin",
        password: "placeholder-password",
      });
      expect(() => profileManager.getConfig("default")).toThrow(/not found/);
    }
  );
});

describe("config-file profiles", () => {
  it.each([
    ["  https://dev.service-now.com", "https://dev.service-now.com"],
    ["HTTPS://DEV.SERVICE-NOW.COM/", "https://dev.service-now.com"],
    ["httpdev.service-now.com", "https://httpdev.service-now.com"],
  ])("uses one canonical instance URL for validation and execution", (raw, expected) => {
    expect(normalizeInstanceUrl(raw)).toBe(expected);
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: raw,
          username: "admin",
          credential: "env:SN_PASSWORD",
        },
      },
    });
    process.env.SN_PASSWORD = "placeholder-password";
    expect(new ProfileManager().getConfig("dev").instance).toBe(expected);
  });

  it("rejects an invalid instance before resolving its credential", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "",
          username: "admin",
          credential: "env:UNSET_PROFILE_SECRET",
        },
      },
    });

    expect(() => new ProfileManager().getConfig("dev")).toThrow(/URL must not be empty/);
  });

  it("resolves an oauth profile with env: indirection for clientSecret", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          authType: "oauth",
          clientId: "dev-client-id",
          clientSecret: "env:SN_CLIENT_SECRET",
          timeoutMs: 10_000,
        },
      },
    });
    process.env.SN_CLIENT_SECRET = "fake-secret-from-env";

    const config = new ProfileManager().getConfig("dev");
    expect(config.authType).toBe("oauth");
    expect(config.clientSecret).toBe("fake-secret-from-env");
    expect(config.timeoutMs).toBe(10_000);
  });

  it("throws a clear error when the clientSecret env var is unset", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          authType: "oauth",
          clientId: "dev-client-id",
          clientSecret: "env:SN_CLIENT_SECRET",
        },
      },
    });

    expect(() => new ProfileManager().getConfig("dev")).toThrow(
      "Credential resolution failed"
    );
  });

  it("supports oauth password grant profiles (credential still resolved)", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          username: "integration.user",
          credential: "env:SN_PASSWORD",
          authType: "oauth",
          grantType: "password",
          clientId: "dev-client-id",
          clientSecret: "env:SN_CLIENT_SECRET",
        },
      },
    });
    process.env.SN_PASSWORD = "fake-user-password";
    process.env.SN_CLIENT_SECRET = "fake-secret-from-env";

    const config = new ProfileManager().getConfig("dev");
    expect(config.grantType).toBe("password");
    expect(config.user).toBe("integration.user");
    expect(config.password).toBe("fake-user-password");
  });

  it("resolves apikey profiles with env: indirection", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          authType: "apikey",
          apiKey: "env:SN_API_KEY",
          apiKeyHeader: "x-sn-apikey",
        },
      },
    });
    process.env.SN_API_KEY = "fake-api-key-from-env";

    const config = new ProfileManager().getConfig("dev");
    expect(config.authType).toBe("apikey");
    expect(config.apiKey).toBe("fake-api-key-from-env");
  });

  it("lists profiles with their auth type and reports basic-auth profiles", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          username: "admin",
          credential: "env:SN_PASSWORD",
        },
        prod: {
          instance: "https://prod.service-now.com",
          authType: "oauth",
          clientId: "prod-client-id",
          clientSecret: "env:SN_CLIENT_SECRET",
        },
      },
    });

    const pm = new ProfileManager();
    const entries = pm.listProfiles();
    expect(entries.map((e) => [e.name, e.authType])).toEqual([
      ["dev", "basic"],
      ["prod", "oauth"],
    ]);
    expect(pm.getBasicAuthProfileNames()).toEqual(["dev"]);
  });
});

describe("out-of-band addProfile safeguards", () => {
  it("rejects plain-text and empty env secret references without persisting", () => {
    const pm = new ProfileManager();
    expect(() =>
      pm.addProfile("basic", {
        instance: "https://dev.service-now.com",
        credential: "plain-text-password",
      })
    ).toThrow(/secret reference.*encrypted envelope/);
    expect(() =>
      pm.addProfile("oauth", {
        instance: "https://dev.service-now.com",
        authType: "oauth",
        clientSecret: "plain-oauth-secret",
      })
    ).toThrow(/secret reference.*encrypted envelope/);
    expect(() =>
      pm.addProfile("key", {
        instance: "https://dev.service-now.com",
        authType: "apikey",
        apiKey: "plain-api-key",
      })
    ).toThrow(/secret reference.*encrypted envelope/);
    expect(() =>
      pm.addProfile("empty", {
        instance: "https://dev.service-now.com",
        authType: "apikey",
        apiKey: "env:",
      })
    ).toThrow(/secret reference.*encrypted envelope/);
    expect(fs.existsSync(pm.getConfigPath())).toBe(false);
  });

  it("treats inherited object keys as unknown unless explicitly configured", () => {
    const pm = new ProfileManager();
    for (const inheritedName of [
      "toString",
      "constructor",
      "__proto__",
      "valueOf",
      "hasOwnProperty",
    ]) {
      expect(() => pm.getProfile(inheritedName)).toThrow(/not found/);
    }

    pm.addProfile("__proto__", {
      instance: "https://special.service-now.com",
      username: "tester",
      credential: "env:SN_TEST_USER_PW",
    });
    expect(pm.getProfile("__proto__").instance).toBe(
      "https://special.service-now.com"
    );
  });

  it("copies and freezes profile snapshots instead of retaining mutable aliases", () => {
    const manager = new ProfileManager();
    const reference = {
      type: "secret_ref",
      provider: "env",
      reference: "SN_TEST_USER_PW",
    };
    const supplied = {
      instance: "https://immutable.service-now.com",
      username: "before",
      credential: reference,
    } as Profile;

    manager.addProfile("immutable", supplied);
    supplied.instance = "https://changed.service-now.com";
    reference.reference = "SN_PASSWORD";

    const snapshot = manager.getProfile("immutable");
    expect(snapshot.instance).toBe("https://immutable.service-now.com");
    expect(snapshot.credential).toMatchObject({ reference: "SN_TEST_USER_PW" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.credential)).toBe(true);
    expect(() => {
      snapshot.instance = "https://mutated.service-now.com";
    }).toThrow();
  });

  it("persists only env references with owner-only permissions", () => {
    const pm = new ProfileManager();
    pm.addProfile("dev", {
      instance: "https://dev.service-now.com",
      username: "admin",
      credential: "env:SN_TEST_USER_PW",
    });

    const raw = fs.readFileSync(pm.getConfigPath(), "utf8");
    expect(JSON.parse(raw).profiles.dev.credential).toEqual({
      type: "secret_ref",
      provider: "env",
      reference: "SN_TEST_USER_PW",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(pm.getConfigPath()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(pm.getConfigPath())).mode & 0o777).toBe(0o700);
    }
  });

  it("tightens permissions on a pre-existing world-readable config file", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: { instance: "https://dev.service-now.com", credential: "env:SN_PASSWORD" },
      },
    });
    fs.chmodSync(path.join(tempHome, ".servicenow-mcp", "config.json"), 0o644);
    const pm = new ProfileManager();
    pm.addProfile("second", {
      instance: "https://second.service-now.com",
      credential: "env:SN_TEST_USER_PW",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(pm.getConfigPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips basic, OAuth, and API-key profiles", () => {
    process.env.SN_TEST_USER_PW = "fake-user-password";
    process.env.SN_TEST_CLIENT_SECRET = "fake-oauth-secret";
    process.env.SN_TEST_API_KEY = "fake-api-key";
    const pm = new ProfileManager();
    pm.addProfile("basic", {
      instance: "https://basic.service-now.com",
      username: "admin",
      credential: "env:SN_TEST_USER_PW",
    });
    pm.addProfile("oauth", {
      instance: "https://oauth.service-now.com",
      authType: "oauth",
      clientId: "client-id",
      clientSecret: "env:SN_TEST_CLIENT_SECRET",
    });
    pm.addProfile("key", {
      instance: "https://key.service-now.com",
      authType: "apikey",
      apiKey: "env:SN_TEST_API_KEY",
      apiKeyHeader: "x-custom-key",
      timeoutMs: 5000,
    });

    const reloaded = new ProfileManager();
    expect(reloaded.getConfig("basic").password).toBe("fake-user-password");
    expect(reloaded.getConfig("oauth")).toMatchObject({
      authType: "oauth",
      clientId: "client-id",
      clientSecret: "fake-oauth-secret",
      password: "",
    });
    expect(reloaded.getConfig("key")).toMatchObject({
      authType: "apikey",
      apiKey: "fake-api-key",
      apiKeyHeader: "x-custom-key",
      timeoutMs: 5000,
    });
  });

  it("rejects non-ServiceNow, lookalike, and plain-http hosts", () => {
    const pm = new ProfileManager();
    for (const instance of [
      "https://evil.example",
      "https://evilservice-now.com",
      "http://dev.service-now.com",
    ]) {
      expect(() =>
        pm.addProfile("blocked", {
          instance,
          credential: "env:SN_TEST_USER_PW",
        })
      ).toThrow();
    }
    expect(fs.existsSync(pm.getConfigPath())).toBe(false);
  });

  it("accepts ServiceNow domains and operator-allowlisted custom hosts only", () => {
    process.env.SN_ALLOWED_INSTANCE_HOSTS = "sn.corp.example.com,*.snow.example.org";
    const pm = new ProfileManager();
    for (const [name, instance] of [
      ["commercial", "https://dev.service-now.com"],
      ["government", "https://agency.servicenowservices.com"],
      ["exact", "https://sn.corp.example.com"],
      ["wildcard", "https://eu1.snow.example.org"],
    ] as const) {
      expect(() =>
        pm.addProfile(name, { instance, credential: "env:SN_TEST_USER_PW" })
      ).not.toThrow();
    }
    expect(() =>
      pm.addProfile("other", {
        instance: "https://other.example.com",
        credential: "env:SN_TEST_USER_PW",
      })
    ).toThrow(/SN_ALLOWED_INSTANCE_HOSTS/);
  });
});

describe("getConfig resolves only the secrets the auth scheme uses", () => {
  // Regression (review fix): a hand-written oauth profile with a stray
  // apiKey pointing at an unset env var must not brick getConfig.
  it("ignores a stray apiKey on an oauth profile", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          authType: "oauth",
          clientId: "dev-client-id",
          clientSecret: "env:SN_CLIENT_SECRET",
          apiKey: "env:SN_UNSET_STRAY_KEY",
        },
      },
    });
    process.env.SN_CLIENT_SECRET = "fake-secret-from-env";

    const config = new ProfileManager().getConfig("dev");
    expect(config.authType).toBe("oauth");
    expect(config.clientSecret).toBe("fake-secret-from-env");
    expect(config.apiKey).toBeUndefined();
  });

  it("ignores a stray clientSecret on an apikey profile", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          authType: "apikey",
          apiKey: "env:SN_API_KEY",
          clientSecret: "env:SN_UNSET_STRAY_SECRET",
        },
      },
    });
    process.env.SN_API_KEY = "fake-api-key-from-env";

    const config = new ProfileManager().getConfig("dev");
    expect(config.authType).toBe("apikey");
    expect(config.apiKey).toBe("fake-api-key-from-env");
    expect(config.clientSecret).toBeUndefined();
  });

  it("ignores clientSecret and apiKey entirely on a basic profile", () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          username: "admin",
          credential: "env:SN_PASSWORD",
          clientSecret: "env:SN_UNSET_A",
          apiKey: "env:SN_UNSET_B",
        },
      },
    });
    process.env.SN_PASSWORD = "fake-password";

    const config = new ProfileManager().getConfig("dev");
    expect(config.authType).toBe("basic");
    expect(config.clientSecret).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
  });
});

describe("SNSDK-38 secure profile persistence", () => {
  it("uses an explicitly named environment mapping only for absent configuration", () => {
    process.env.SN_PROFILE_NAME = "fallback-env";
    process.env.SN_INSTANCE = "https://fallback.service-now.com";
    process.env.SN_USER = "fallback-user";
    process.env.SN_PASSWORD = "fallback-secret";
    const missingPath = path.join(tempHome, "missing", "nested", "config.json");

    expect(
      new ProfileManager({ configFilePath: missingPath }).getConfig("fallback-env")
    ).toMatchObject({
      instance: "https://fallback.service-now.com",
      user: "fallback-user",
      password: "fallback-secret",
    });
  });

  it("rejects legacy plaintext configuration instead of falling back to env", () => {
    writeConfigFile({
      version: 1,
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          username: "admin",
          credential: "plaintext-must-never-load",
        },
      },
    });
    process.env.SN_INSTANCE = "https://fallback.service-now.com";
    process.env.SN_PROFILE_NAME = "fallback-env";
    process.env.SN_PASSWORD = "fallback-secret";

    expect(() => new ProfileManager()).toThrow(/Legacy plaintext.*rejected/);
  });

  it("rejects unknown credential-shaped fields and config symlinks", () => {
    writeConfigFile({
      version: 2,
      profiles: {
        dev: {
          instance: "https://dev.service-now.com",
          username: "admin",
          credential: "env:SN_PASSWORD",
          password: "hidden-in-an-unknown-field",
        },
      },
    });
    expect(() => new ProfileManager()).toThrow(/could not be loaded safely/);

    if (process.platform !== "win32") {
      const configPath = path.join(tempHome, ".servicenow-mcp", "config.json");
      const targetPath = path.join(tempHome, "outside-config.json");
      fs.unlinkSync(configPath);
      fs.writeFileSync(targetPath, JSON.stringify({ version: 2, profiles: {} }));
      fs.symlinkSync(targetPath, configPath);
      expect(() => new ProfileManager()).toThrow(/could not be loaded safely/);
    }
  });

  it("rejects broken final symlinks and parent-component symlinks", () => {
    if (process.platform === "win32") return;
    process.env.SN_INSTANCE = "https://fallback.service-now.com";
    process.env.SN_PASSWORD = "fallback-secret";
    const configDirectory = path.join(tempHome, ".servicenow-mcp");
    fs.mkdirSync(configDirectory, { recursive: true });
    const configPath = path.join(configDirectory, "config.json");
    fs.symlinkSync(path.join(tempHome, "does-not-exist.json"), configPath);
    expect(() => new ProfileManager()).toThrow(/could not be loaded safely/);

    fs.unlinkSync(configPath);
    const realDirectory = path.join(tempHome, "real-config-directory");
    fs.mkdirSync(realDirectory);
    fs.writeFileSync(
      path.join(realDirectory, "config.json"),
      JSON.stringify({ version: 2, profiles: {} })
    );
    const linkedDirectory = path.join(tempHome, "linked-config-directory");
    fs.symlinkSync(realDirectory, linkedDirectory, "dir");
    expect(
      () =>
        new ProfileManager({
          configFilePath: path.join(linkedDirectory, "config.json"),
        })
    ).toThrow(/could not be loaded safely/);

    const brokenDirectory = path.join(tempHome, "broken-config-directory");
    fs.symlinkSync(path.join(tempHome, "missing-directory"), brokenDirectory, "dir");
    expect(
      () =>
        new ProfileManager({
          configFilePath: path.join(brokenDirectory, "config.json"),
        })
    ).toThrow(/could not be loaded safely/);
  });

  it("rejects non-regular and oversized configuration files", () => {
    if (process.platform !== "win32") {
      const configPath = path.join(tempHome, "directory-as-config");
      fs.mkdirSync(configPath);
      expect(() => new ProfileManager({ configFilePath: configPath })).toThrow(
        /could not be loaded safely/
      );
    }

    const oversizedPath = path.join(tempHome, "oversized-config.json");
    fs.writeFileSync(oversizedPath, " ".repeat(1024 * 1024 + 1));
    expect(() => new ProfileManager({ configFilePath: oversizedPath })).toThrow(
      /could not be loaded safely/
    );
  });

  it.each(["", "bad\nname", "x".repeat(65)])(
    "rejects an invalid loaded profile name %j",
    (name) => {
      const profiles: Record<string, unknown> = Object.create(null);
      Object.defineProperty(profiles, name, {
        value: {
          instance: "https://dev.service-now.com",
          credential: "env:SN_PASSWORD",
        },
        enumerable: true,
      });
      writeConfigFile({ version: 2, profiles });
      expect(() => new ProfileManager()).toThrow(/could not be loaded safely/);
    }
  );

  it("loads an intentionally valid __proto__ profile without prototype mutation", () => {
    const profiles: Record<string, unknown> = Object.create(null);
    Object.defineProperty(profiles, "__proto__", {
      value: {
        instance: "https://special.service-now.com",
        credential: "env:SN_PASSWORD",
      },
      enumerable: true,
    });
    writeConfigFile({ version: 2, profiles });
    const manager = new ProfileManager();
    expect(manager.getProfile("__proto__").instance).toBe(
      "https://special.service-now.com"
    );
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("does not apply POSIX permission operations on the Windows branch", async () => {
    const canonicalDirectory = fs.realpathSync(tempHome);
    const windowsConfigPath = path.join(canonicalDirectory, "windows-config.json");
    fs.writeFileSync(
      windowsConfigPath,
      JSON.stringify({ version: 2, profiles: {} }),
      { mode: 0o644 }
    );
    fs.chmodSync(windowsConfigPath, 0o644);
    fs.chmodSync(canonicalDirectory, 0o755);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.resetModules();
      const windowsModule = await import("../src/profile-manager.js");
      const windowsManager = new windowsModule.ProfileManager({
        configFilePath: windowsConfigPath,
      });
      expect(fs.statSync(windowsConfigPath).mode & 0o777).toBe(0o644);
      expect(fs.statSync(canonicalDirectory).mode & 0o777).toBe(0o755);
      windowsManager.addProfile("windows", {
        instance: "https://windows.service-now.com",
        credential: "env:SN_TEST_USER_PW",
      });
      expect(windowsManager.getProfile("windows").instance).toBe(
        "https://windows.service-now.com"
      );
      // Persistence exercises the Windows no-op directory-sync branch while
      // retaining the enclosing directory's non-POSIX-managed mode.
      expect(fs.statSync(canonicalDirectory).mode & 0o777).toBe(0o755);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      vi.resetModules();
    }
  });

  it("tightens permissions immediately when loading a profile file", () => {
    writeConfigFile({ version: 2, profiles: {} });
    const configPath = path.join(tempHome, ".servicenow-mcp", "config.json");
    if (process.platform !== "win32") {
      fs.chmodSync(configPath, 0o644);
      fs.chmodSync(path.dirname(configPath), 0o755);
    }
    new ProfileManager();
    if (process.platform !== "win32") {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
    }
  });

  it("stores ciphertext atomically without plaintext or the separate key", () => {
    const key = Buffer.alloc(32, 0x51);
    const provider: ProfileEncryptionKeyProvider = {
      getKey: () => Buffer.from(key),
    };
    const manager = new ProfileManager({ encryptionKeyProvider: provider });
    manager.addProfile("encrypted", {
      instance: "https://encrypted.service-now.com",
      username: "admin",
      credential: encryptCredential(
        "unique-plaintext-value",
        "encrypted",
        "credential",
        provider
      ),
    });

    const raw = fs.readFileSync(manager.getConfigPath(), "utf8");
    expect(raw).not.toContain("unique-plaintext-value");
    expect(raw).not.toContain(key.toString("base64"));
    expect(raw).toContain('"algorithm": "aes-256-gcm"');
    expect(manager.getConfig("encrypted").password).toBe("unique-plaintext-value");
    expect(
      fs.readdirSync(path.dirname(manager.getConfigPath())).filter((name) =>
        name.endsWith(".tmp") || name.endsWith(".lock")
      )
    ).toEqual([]);
  });

  it("cannot reuse a cached client after the separate key becomes unavailable", () => {
    const key = Buffer.alloc(32, 0x37);
    let available = true;
    const provider: ProfileEncryptionKeyProvider = {
      getKey: () => {
        if (!available) throw new Error("Profile encryption key is unavailable");
        return Buffer.from(key);
      },
    };
    const manager = new ProfileManager({ encryptionKeyProvider: provider });
    manager.addProfile("dev", {
      instance: "https://dev.service-now.com",
      username: "admin",
      credential: encryptCredential("credential-value", "dev", "credential", provider),
    });
    manager.getClient("dev");
    available = false;
    expect(() => manager.getClient("dev")).toThrow(
      "Profile encryption key is unavailable"
    );
  });

  it("merges stale concurrent manager updates under the atomic write lock", () => {
    const first = new ProfileManager();
    const second = new ProfileManager();
    first.addProfile("dev", {
      instance: "https://dev.service-now.com",
      username: "dev-user",
      credential: "env:SN_TEST_USER_PW",
    });
    second.addProfile("prod", {
      instance: "https://prod.service-now.com",
      username: "prod-user",
      credential: "env:SN_TEST_USER_PW",
    });

    expect(new ProfileManager().listProfiles().map(({ name }) => name)).toEqual([
      "dev",
      "prod",
    ]);
    const parsed = JSON.parse(fs.readFileSync(first.getConfigPath(), "utf8"));
    expect(parsed.version).toBe(2);
    if (process.platform !== "win32") {
      expect(fs.statSync(first.getConfigPath()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(first.getConfigPath())).mode & 0o777).toBe(0o700);
    }
  });
});
