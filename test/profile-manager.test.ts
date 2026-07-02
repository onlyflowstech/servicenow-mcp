import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileManager } from "../src/profile-manager.js";
import { handler as profileHandler } from "../src/tools/profile.js";
import type { ServiceNowConfig } from "../src/config.js";

/**
 * These tests run a real ProfileManager against a throwaway HOME directory
 * so the host's ~/.servicenow-mcp/config.json and SN_* env vars are never
 * touched. os.homedir() resolves $HOME on darwin/linux.
 */

const ENV_KEYS = [
  "HOME",
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

describe("env-var fallback profile", () => {
  it("keeps existing basic-auth env setups working unchanged", () => {
    process.env.SN_INSTANCE = "https://legacy.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "placeholder-password";

    const config = new ProfileManager().getConfig();
    expect(config.instance).toBe("https://legacy.service-now.com");
    expect(config.user).toBe("admin");
    expect(config.password).toBe("placeholder-password");
    expect(config.authType).toBe("basic");
    expect(config.timeoutMs).toBeUndefined();
  });

  it("wires SN_AUTH_TYPE=oauth without requiring SN_PASSWORD", () => {
    process.env.SN_INSTANCE = "https://oauth.service-now.com";
    process.env.SN_AUTH_TYPE = "oauth";
    process.env.SN_CLIENT_ID = "my-client-id";
    process.env.SN_CLIENT_SECRET = "fake-oauth-secret";

    const config = new ProfileManager().getConfig();
    expect(config.authType).toBe("oauth");
    expect(config.grantType).toBe("client_credentials");
    expect(config.clientId).toBe("my-client-id");
    expect(config.clientSecret).toBe("fake-oauth-secret");
    expect(config.password).toBe("");
  });

  it("wires SN_AUTH_TYPE=apikey with SN_API_KEY_HEADER", () => {
    process.env.SN_INSTANCE = "https://apikey.service-now.com";
    process.env.SN_AUTH_TYPE = "apikey";
    process.env.SN_API_KEY = "fake-api-key";
    process.env.SN_API_KEY_HEADER = "x-custom-key";

    const config = new ProfileManager().getConfig();
    expect(config.authType).toBe("apikey");
    expect(config.apiKey).toBe("fake-api-key");
    expect(config.apiKeyHeader).toBe("x-custom-key");
  });

  it("parses SN_TIMEOUT_MS and ignores invalid values", () => {
    process.env.SN_INSTANCE = "https://x.service-now.com";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "placeholder-password";

    process.env.SN_TIMEOUT_MS = "5000";
    expect(new ProfileManager().getConfig().timeoutMs).toBe(5000);

    process.env.SN_TIMEOUT_MS = "not-a-number";
    expect(new ProfileManager().getConfig().timeoutMs).toBeUndefined();
  });
});

describe("config-file profiles", () => {
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

    const config = new ProfileManager().getConfig();
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

    expect(() => new ProfileManager().getConfig()).toThrow(/SN_CLIENT_SECRET.*not set/);
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

    const config = new ProfileManager().getConfig();
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

    const config = new ProfileManager().getConfig();
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

describe("addProfile secret hygiene", () => {
  it("rejects a plain-text credential via sn_profile add and persists nothing", async () => {
    const pm = new ProfileManager();
    const result = await profileHandler(
      {
        action: "add",
        name: "dev",
        instance: "https://dev.service-now.com",
        username: "admin",
        credential: "plain-text-password",
      },
      pm
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("env:VAR_NAME");
    // Nothing may reach disk -- not the profile, and not the secret.
    expect(fs.existsSync(pm.getConfigPath())).toBe(false);
  });

  it("rejects plain-text clientSecret and apiKey", () => {
    const pm = new ProfileManager();
    expect(() =>
      pm.addProfile("o", {
        instance: "https://x.service-now.com",
        authType: "oauth",
        clientId: "id",
        clientSecret: "plain-oauth-secret",
      })
    ).toThrow(/env:VAR_NAME/);
    expect(() =>
      pm.addProfile("k", {
        instance: "https://x.service-now.com",
        authType: "apikey",
        apiKey: "plain-api-key",
      })
    ).toThrow(/env:VAR_NAME/);
    expect(fs.existsSync(pm.getConfigPath())).toBe(false);
  });

  it('rejects a bare "env:" credential with no variable name', () => {
    const pm = new ProfileManager();
    expect(() =>
      pm.addProfile("dev", {
        instance: "https://x.service-now.com",
        credential: "env:",
      })
    ).toThrow(/env:VAR_NAME/);
  });

  it("accepts env: indirection and writes config.json owner-only", async () => {
    const pm = new ProfileManager();
    const result = await profileHandler(
      {
        action: "add",
        name: "dev",
        instance: "https://dev.service-now.com",
        username: "admin",
        credential: "env:SN_PASSWORD_DEV",
      },
      pm
    );
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.added).toBe("dev");
    expect(payload.credential_source).toBe("env:SN_PASSWORD_DEV");

    const configPath = pm.getConfigPath();
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(raw).toContain("env:SN_PASSWORD_DEV");
    if (process.platform !== "win32") {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
    }
  });

  it("tightens permissions on a pre-existing world-readable config file", async () => {
    writeConfigFile({
      version: 1,
      default_profile: "dev",
      profiles: {
        dev: { instance: "https://dev.service-now.com", credential: "env:SN_PASSWORD" },
      },
    });
    const pm = new ProfileManager();
    pm.addProfile("second", {
      instance: "https://second.service-now.com",
      credential: "env:SN_PASSWORD_SECOND",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(pm.getConfigPath()).mode & 0o777).toBe(0o600);
    }
  });
});

describe("sn_profile output redaction", () => {
  const SECRET_CONFIG: ServiceNowConfig = {
    instance: "https://dev.service-now.com",
    user: "integration.user",
    password: "fake-user-password",
    displayValue: "true",
    relDepth: 3,
    authType: "oauth",
    grantType: "password",
    clientId: "dev-client-id",
    clientSecret: "fake-oauth-secret",
    apiKey: "fake-api-key",
    apiKeyHeader: "x-sn-apikey",
    timeoutMs: 30_000,
  };

  function stubManager() {
    return {
      getConfig: vi.fn(() => SECRET_CONFIG),
      getActiveProfileName: vi.fn(() => "dev"),
      listProfiles: vi.fn(() => [
        {
          name: "dev",
          instance: SECRET_CONFIG.instance,
          authType: "oauth" as const,
          isActive: true,
        },
      ]),
    } as unknown as ProfileManager;
  }

  it("info reports auth_type but never password/clientSecret/apiKey", async () => {
    const result = await profileHandler({ action: "info", name: "dev" }, stubManager());
    const text = result.content[0].text;
    expect(text).toContain('"auth_type":"oauth"');
    expect(text).not.toContain("fake-user-password");
    expect(text).not.toContain("fake-oauth-secret");
    expect(text).not.toContain("fake-api-key");
  });

  it("list output contains no secret material", async () => {
    const result = await profileHandler({ action: "list" }, stubManager());
    const text = result.content[0].text;
    expect(text).toContain('"authType":"oauth"');
    expect(text).not.toContain("fake-user-password");
    expect(text).not.toContain("fake-oauth-secret");
    expect(text).not.toContain("fake-api-key");
  });
});
