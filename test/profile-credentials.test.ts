import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_ENCRYPTION_KEY_ENV,
  decryptCredential,
  encryptCredential,
  isCredentialSourceDescriptor,
  secretReference,
  type EncryptedCredentialEnvelope,
  type ProfileEncryptionKeyProvider,
  type SecretResolver,
} from "../src/profile-credentials.js";
import { ProfileManager } from "../src/profile-manager.js";

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);

let temporaryDirectory: string;
let savedKey: string | undefined;

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sn-credentials-"));
  savedKey = process.env[PROFILE_ENCRYPTION_KEY_ENV];
  delete process.env[PROFILE_ENCRYPTION_KEY_ENV];
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env[PROFILE_ENCRYPTION_KEY_ENV];
  else process.env[PROFILE_ENCRYPTION_KEY_ENV] = savedKey;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

const keyProvider = (key: Buffer): ProfileEncryptionKeyProvider => ({
  getKey: () => Buffer.from(key),
});

describe("versioned authenticated profile encryption", () => {
  it("round-trips with unique nonces and authenticated profile/field metadata", () => {
    const first = encryptCredential("test-password", "dev", "credential", keyProvider(KEY_A));
    const second = encryptCredential("test-password", "dev", "credential", keyProvider(KEY_A));

    expect(first).toMatchObject({
      type: "encrypted",
      version: 1,
      algorithm: "aes-256-gcm",
    });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decryptCredential(first, "dev", "credential", keyProvider(KEY_A))).toBe(
      "test-password"
    );
    expect(() =>
      decryptCredential(first, "prod", "credential", keyProvider(KEY_A))
    ).toThrow("Credential decryption failed");
    expect(() =>
      decryptCredential(first, "dev", "clientSecret", keyProvider(KEY_A))
    ).toThrow("Credential decryption failed");
  });

  it.each(["nonce", "ciphertext", "authTag"] as const)(
    "fails safely when %s is modified",
    (field) => {
      const envelope = encryptCredential(
        "do-not-leak-this",
        "dev",
        "credential",
        keyProvider(KEY_A)
      );
      const tampered = {
        ...envelope,
        [field]: mutateBase64Url(envelope[field]),
      } as EncryptedCredentialEnvelope;
      expect(() =>
        decryptCredential(tampered, "dev", "credential", keyProvider(KEY_A))
      ).toThrow("Credential decryption failed");
    }
  );

  it("fails with wrong, missing, and malformed keys without leaking material", () => {
    const envelope = encryptCredential("redacted-value", "dev", "credential", keyProvider(KEY_A));
    expect(() =>
      decryptCredential(envelope, "dev", "credential", keyProvider(KEY_B))
    ).toThrow("Credential decryption failed");
    expect(() => decryptCredential(envelope, "dev", "credential")).toThrow(
      "Profile encryption key is unavailable"
    );

    process.env[PROFILE_ENCRYPTION_KEY_ENV] = Buffer.alloc(16).toString("base64");
    expect(() => decryptCredential(envelope, "dev", "credential")).toThrow(
      "Profile encryption key is invalid"
    );
    for (const error of captureErrors(() =>
      decryptCredential(envelope, "dev", "credential", keyProvider(KEY_B))
    )) {
      expect(error).not.toContain("redacted-value");
      expect(error).not.toContain(envelope.ciphertext);
      expect(error).not.toContain(KEY_A.toString("base64"));
    }
  });

  it("never zeroes or otherwise mutates a provider-owned cached key", () => {
    const cachedKey = Buffer.alloc(32, 0x4d);
    const original = Buffer.from(cachedKey);
    const provider: ProfileEncryptionKeyProvider = { getKey: () => cachedKey };

    const first = encryptCredential("first-value", "dev", "credential", provider);
    const second = encryptCredential("second-value", "dev", "clientSecret", provider);
    expect(decryptCredential(first, "dev", "credential", provider)).toBe("first-value");
    expect(decryptCredential(second, "dev", "clientSecret", provider)).toBe(
      "second-value"
    );
    expect(cachedKey).toEqual(original);

    const invalidCachedKey = Buffer.alloc(16, 0x6e);
    const invalidOriginal = Buffer.from(invalidCachedKey);
    expect(() =>
      encryptCredential("value", "dev", "credential", {
        getKey: () => invalidCachedKey,
      })
    ).toThrow("Profile encryption key is invalid");
    expect(invalidCachedKey).toEqual(invalidOriginal);
  });

  it("rejects accessor and proxy credential descriptors without executing them", () => {
    const getter = vi.fn(() => "sensitive");
    const accessor = Object.defineProperty(
      { type: "secret_ref", provider: "env" },
      "reference",
      { enumerable: true, get: getter }
    );
    const traps = { get: vi.fn(), ownKeys: vi.fn() };
    const proxy = new Proxy(
      { type: "secret_ref", provider: "env", reference: "SN_TEST" },
      traps
    );

    expect(isCredentialSourceDescriptor(accessor)).toBe(false);
    expect(isCredentialSourceDescriptor(proxy)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();
  });
});

describe("runtime-only provider-neutral resolution", () => {
  it("fails closed for unavailable, throwing, empty, and malformed resolvers", () => {
    const reference = "opaque/snsdk-53/reference";
    const configPath = path.join(temporaryDirectory, "negative-resolvers.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        profiles: {
          dev: {
            instance: "https://dev.service-now.com",
            username: "dev-user",
            credential: secretReference("testvault", reference),
          },
        },
      })
    );

    const cases: Array<{
      label: string;
      resolvers: SecretResolver[];
      expected: string;
    }> = [
      {
        label: "unavailable",
        resolvers: [],
        expected: "Credential resolver is unavailable",
      },
      {
        label: "throwing",
        resolvers: [
          {
            provider: "testvault",
            resolve: () => {
              throw new Error(`provider leaked ${reference}`);
            },
          },
        ],
        expected: "Credential resolution failed",
      },
      {
        label: "empty",
        resolvers: [{ provider: "testvault", resolve: () => "" }],
        expected: "Credential resolution failed",
      },
      {
        label: "malformed",
        resolvers: [
          {
            provider: "testvault",
            resolve: (() => 42) as unknown as SecretResolver["resolve"],
          },
        ],
        expected: "Credential resolution failed",
      },
    ];

    for (const { label, resolvers, expected } of cases) {
      let thrown = "";
      try {
        new ProfileManager({ configFilePath: configPath, secretResolvers: resolvers })
          .getConfig("dev");
      } catch (error) {
        thrown = String(error);
      }
      expect(thrown, label).toContain(expected);
      expect(thrown, label).not.toContain(reference);
      expect(thrown, label).not.toContain("provider leaked");
      expect(thrown, label).not.toContain("testvault");
    }
  });

  it("isolates two profiles and resolves references only from getConfig", () => {
    const references = new Map([
      ["path/dev", "dev-secret"],
      ["path/prod", "prod-secret"],
    ]);
    const resolve = vi.fn((reference: string) => references.get(reference) ?? "");
    const resolver: SecretResolver = { provider: "testvault", resolve };
    const configPath = path.join(temporaryDirectory, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        profiles: {
          dev: {
            instance: "https://dev.service-now.com",
            username: "dev-user",
            credential: secretReference("testvault", "path/dev"),
          },
          prod: {
            instance: "https://prod.service-now.com",
            username: "prod-user",
            credential: secretReference("testvault", "path/prod"),
          },
        },
      })
    );
    const manager = new ProfileManager({ configFilePath: configPath, secretResolvers: [resolver] });

    manager.getProfile("dev");
    manager.listProfiles();
    expect(resolve).not.toHaveBeenCalled();
    expect(manager.getConfig("dev").password).toBe("dev-secret");
    expect(manager.getConfig("prod").password).toBe("prod-secret");
    expect(resolve.mock.calls.map(([reference]) => reference)).toEqual([
      "path/dev",
      "path/prod",
    ]);

    resolve.mockClear();
    const firstClient = manager.getClient("dev");
    const cachedClient = manager.getClient("dev");
    expect(cachedClient).toBe(firstClient);
    expect(resolve).toHaveBeenCalledTimes(2);
    references.set("path/dev", "rotated-dev-secret");
    expect(manager.getClient("dev")).not.toBe(firstClient);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("constructs a non-reflectable client from one exact immutable resolver revision", async () => {
    let revision = 0;
    const resolve = vi.fn(() => `secret-revision-${++revision}`);
    const resolver: SecretResolver = { provider: "testvault", resolve };
    const configPath = path.join(temporaryDirectory, "alternating-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 2,
        profiles: {
          dev: {
            instance: "https://dev.service-now.com",
            username: "dev-user",
            credential: secretReference("testvault", "path/dev"),
          },
        },
      })
    );
    const manager = new ProfileManager({
      configFilePath: configPath,
      secretResolvers: [resolver],
    });

    const exactConfig = manager.getConfig("dev");
    expect(Object.isFrozen(exactConfig)).toBe(true);
    const client = manager.getClient("dev", exactConfig);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(Reflect.ownKeys(client)).not.toContain("config");
    expect(Reflect.ownKeys(client)).not.toContain("auth");
    expect(JSON.stringify(client)).not.toContain("secret-revision-1");

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({
        Authorization:
          "Basic " +
          Buffer.from("dev-user:secret-revision-1").toString("base64"),
      });
      return new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await client.get("/api/now/table/incident");
    expect(fetchMock).toHaveBeenCalledOnce();

    manager.getClient("dev");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

function mutateBase64Url(value: string): string {
  if (!value) return "A";
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function captureErrors(action: () => unknown): string[] {
  try {
    action();
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
