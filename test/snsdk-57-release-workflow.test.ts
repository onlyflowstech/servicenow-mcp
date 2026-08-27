import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INSPECTOR_NODE_MINIMUM,
  INSPECTOR_VERSION,
  assertInspectorNodeVersion,
  inspectorLaunch,
  resolveInspectorOptions,
} from "../scripts/inspector.mjs";
import {
  CONTAINER_RELEASE_GATES,
  PORTABLE_RELEASE_GATES,
  validateReleaseContract,
} from "../scripts/release-validate.mjs";
import {
  extractCreatedSysId,
  resolveSmokeOptions,
  writeRoundTrip,
} from "../scripts/smoke-test.mjs";
import { toolModules } from "../src/tools/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");
const token = "snsdk57-local-fake-token-0123456789";
const smokeEnvironment = Object.freeze({
  MCP_BEARER_TOKEN: token,
  MCP_PROFILE: "release-pdi",
  MCP_URL: "https://mcp.example.test/mcp",
});
const inspectorIntegrity =
  "sha512-uEoeEG7/+ZbrvccPF3EsgbfjcyJ3bWVJXT4pcZtpmDUhA0zdK4T4Tuj2oUphi2Huwl66LqVdo3Mx2PkS2SUHXA==";
const trivyChecksum =
  "8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SNSDK-57 explicit smoke profile and write boundary", () => {
  it("requires a protected URL, injected bearer, and explicit profile", () => {
    expect(() =>
      resolveSmokeOptions([], { ...smokeEnvironment, MCP_PROFILE: undefined })
    ).toThrow(/MCP_PROFILE/u);
    expect(() =>
      resolveSmokeOptions([], { ...smokeEnvironment, MCP_PROFILE: " " })
    ).toThrow(/MCP_PROFILE/u);
    expect(() =>
      resolveSmokeOptions([], { ...smokeEnvironment, MCP_URL: undefined })
    ).toThrow(/MCP_URL/u);
    expect(() =>
      resolveSmokeOptions([], {
        ...smokeEnvironment,
        MCP_BEARER_TOKEN: "short",
      })
    ).toThrow(/MCP_BEARER_TOKEN/u);
    expect(() =>
      resolveSmokeOptions([], {
        ...smokeEnvironment,
        MCP_URL: "http://mcp.example.test/mcp",
      })
    ).toThrow(/HTTPS/u);
    expect(() =>
      resolveSmokeOptions([], {
        ...smokeEnvironment,
        MCP_URL: "https://user:password@mcp.example.test/mcp",
      })
    ).toThrow(/credential-free/u);

    const remote = resolveSmokeOptions([], smokeEnvironment);
    const loopback = resolveSmokeOptions([], {
      ...smokeEnvironment,
      MCP_URL: "http://127.0.0.1:3000/mcp",
    });
    expect(remote).toMatchObject({
      profile: "release-pdi",
      writeEnabled: false,
      timeoutMs: 30_000,
    });
    expect(remote.endpoint.href).toBe("https://mcp.example.test/mcp");
    expect(loopback.endpoint.href).toBe("http://127.0.0.1:3000/mcp");
    expect(Object.isFrozen(remote)).toBe(true);
  });

  it("does not let --write alone enable mutation", () => {
    expect(() => resolveSmokeOptions(["--write"], smokeEnvironment)).toThrow(
      /confirm-write-profile/u
    );
    expect(() =>
      resolveSmokeOptions(
        ["--write", "--confirm-write-profile=another-profile"],
        smokeEnvironment
      )
    ).toThrow(/exact MCP_PROFILE/u);
    expect(() =>
      resolveSmokeOptions(
        ["--confirm-write-profile=release-pdi"],
        smokeEnvironment
      )
    ).toThrow(/requires --write/u);
    expect(() =>
      resolveSmokeOptions(["--write", "--unexpected"], smokeEnvironment)
    ).toThrow(/invalid/u);

    expect(
      resolveSmokeOptions(
        ["--write", "--confirm-write-profile=release-pdi"],
        smokeEnvironment
      ).writeEnabled
    ).toBe(true);
  });

  it("bounds every live operation timeout without exposing the token", () => {
    expect(
      resolveSmokeOptions([], {
        ...smokeEnvironment,
        MCP_SMOKE_TIMEOUT_MS: "1000",
      }).timeoutMs
    ).toBe(1_000);
    expect(
      resolveSmokeOptions([], {
        ...smokeEnvironment,
        MCP_SMOKE_TIMEOUT_MS: "120000",
      }).timeoutMs
    ).toBe(120_000);
    for (const value of ["999", "120001", "1.5", "-1", ""]) {
      expect(() =>
        resolveSmokeOptions([], {
          ...smokeEnvironment,
          MCP_SMOKE_TIMEOUT_MS: value,
        })
      ).toThrow(/1000 to 120000/u);
    }

    try {
      resolveSmokeOptions(["--unexpected"], smokeEnvironment);
      throw new Error("expected smoke option validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });

  it("accepts a canonical sys_id only from structured content", () => {
    const sysId = "0123456789abcdef0123456789abcdef";
    expect(
      extractCreatedSysId({ structuredContent: { data: { sys_id: sysId } } })
    ).toBe(sysId);
    expect(() =>
      extractCreatedSysId({
        content: [{ type: "text", text: JSON.stringify({ sys_id: sysId }) }],
      })
    ).toThrow(/structured sys_id/u);
    expect(() =>
      extractCreatedSysId({
        structuredContent: { data: { sys_id: sysId.toUpperCase() } },
      })
    ).toThrow(/canonical/u);
  });

  it("always attempts cleanup after a post-create journal failure", async () => {
    const sysId = "0123456789abcdef0123456789abcdef";
    const calls: Array<{
      readonly name: string;
      readonly options: { readonly signal?: AbortSignal; readonly timeout?: number };
    }> = [];
    const client = {
      callTool: vi.fn(
        async (
          request: { readonly name: string; readonly arguments: unknown },
          _schema?: unknown,
          options: {
            readonly signal?: AbortSignal;
            readonly timeout?: number;
          } = {}
        ) => {
          calls.push({ name: request.name, options });
          if (request.name === "sn_create") {
            return {
              content: [],
              structuredContent: {
                profile: "release-pdi",
                data: { sys_id: sysId },
              },
            };
          }
          if (request.name === "sn_incident_add_work_note") {
            throw new Error("synthetic journal failure");
          }
          return {
            content: [],
            structuredContent: { profile: "release-pdi" },
          };
        }
      ),
    };
    const checks: Array<{
      name: string;
      pass: boolean;
      note: string;
    }> = [];

    await expect(
      writeRoundTrip(client, checks, "release-pdi", 1_234)
    ).rejects.toThrow(/synthetic journal failure/u);
    expect(calls.map(({ name }) => name)).toEqual([
      "sn_create",
      "sn_incident_add_work_note",
      "sn_delete",
    ]);
    expect(calls.every(({ options }) => options.timeout === 1_234)).toBe(true);
    expect(calls.every(({ options }) => options.signal instanceof AbortSignal)).toBe(
      true
    );
    expect(checks).toEqual([
      { name: "sn_create incident", pass: true, note: "" },
      { name: "sn_delete incident", pass: true, note: "" },
    ]);
  });

  it("counts no write success when the resolved profile differs", async () => {
    const sysId = "0123456789abcdef0123456789abcdef";
    const client = {
      callTool: vi.fn(async (request: { readonly name: string }) => ({
        content: [],
        structuredContent: {
          profile: "wrong-profile",
          ...(request.name === "sn_create" ? { data: { sys_id: sysId } } : {}),
        },
      })),
    };
    const checks: Array<{
      name: string;
      pass: boolean;
      note: string;
    }> = [];

    await writeRoundTrip(client, checks, "release-pdi", 1_234);
    expect(checks.map(({ pass }) => pass)).toEqual([false, false, false]);
  });
});

describe("SNSDK-57 locked local Inspector contract", () => {
  it("uses the exact isolated Inspector version and Node floor", () => {
    expect(INSPECTOR_VERSION).toBe("2.0.0");
    expect(INSPECTOR_NODE_MINIMUM).toEqual([22, 19, 0]);
    expect(() => assertInspectorNodeVersion("22.18.9")).toThrow(/22\.19\.0/u);
    expect(() => assertInspectorNodeVersion("22.19.0")).not.toThrow();
    expect(() => assertInspectorNodeVersion("23.0.0")).not.toThrow();
    expect(() => assertInspectorNodeVersion("not-a-version")).toThrow(
      /determine/u
    );

    const packageJson = JSON.parse(read("package.json"));
    const inspectorPackage = JSON.parse(read("tools/inspector/package.json"));
    const inspectorLock = JSON.parse(read("tools/inspector/package-lock.json"));
    const locked =
      inspectorLock.packages["node_modules/@modelcontextprotocol/inspector"];
    expect(inspectorPackage).toMatchObject({
      private: true,
      engines: { node: ">=22.19.0" },
      dependencies: { "@modelcontextprotocol/inspector": "2.0.0" },
    });
    expect(locked).toMatchObject({
      version: "2.0.0",
      integrity: inspectorIntegrity,
      bin: { "mcp-inspector": "clients/launcher/build/index.js" },
      engines: { node: ">=22.19.0" },
    });
    expect(packageJson.dependencies).not.toHaveProperty(
      "@modelcontextprotocol/inspector"
    );
    expect(packageJson.devDependencies).not.toHaveProperty(
      "@modelcontextprotocol/inspector"
    );
  });

  it("passes no target or bearer in argv and removes inherited escape hatches", () => {
    const options = resolveInspectorOptions(smokeEnvironment);
    expect(options.profile).toBe("release-pdi");
    expect(options.endpoint.href).toBe("https://mcp.example.test/mcp");

    const launch = inspectorLaunch({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MCP_URL: smokeEnvironment.MCP_URL,
      MCP_PROFILE: smokeEnvironment.MCP_PROFILE,
      MCP_BEARER_TOKEN: token,
      MCP_PROXY_FULL_ADDRESS: "0.0.0.0:6277",
      SN_PASSWORD: "synthetic-password",
      GITHUB_TOKEN: "synthetic-token",
      AUTHORIZATION: "Bearer synthetic",
      DANGEROUSLY_OMIT_AUTH: "true",
    });

    expect(launch.command).toMatch(
      /tools\/inspector\/node_modules\/\.bin\/mcp-inspector(?:\.cmd)?$/u
    );
    expect(launch.args).toEqual([]);
    expect(JSON.stringify(launch.args)).not.toContain(token);
    expect(launch.environment).toMatchObject({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HOST: "127.0.0.1",
      MCP_AUTO_OPEN_ENABLED: "false",
    });
    for (const name of [
      "MCP_URL",
      "MCP_PROFILE",
      "MCP_BEARER_TOKEN",
      "MCP_PROXY_FULL_ADDRESS",
      "SN_PASSWORD",
      "GITHUB_TOKEN",
      "AUTHORIZATION",
      "DANGEROUSLY_OMIT_AUTH",
    ]) {
      expect(launch.environment).not.toHaveProperty(name);
    }
  });

  it("rejects unsafe target URL variants without network access", () => {
    const fetchProbe = vi.fn(() => {
      throw new Error("network access was not expected");
    });
    vi.stubGlobal("fetch", fetchProbe);
    for (const endpoint of [
      "http://mcp.example.test/mcp",
      "https://mcp.example.test/mcp?token=x",
      "https://mcp.example.test/another-path",
      "https://user:password@mcp.example.test/mcp",
    ]) {
      expect(() =>
        resolveInspectorOptions({
          MCP_URL: endpoint,
          MCP_PROFILE: "release-pdi",
        })
      ).toThrow();
    }
    expect(fetchProbe).not.toHaveBeenCalled();
  });
});

describe("SNSDK-57 deterministic CI and release contract", () => {
  it("runs every portable, profile, package, audit, and container gate", () => {
    const ci = read(".github/workflows/ci.yml");
    const publish = read(".github/workflows/publish.yml");
    for (const workflow of [ci, publish]) {
      for (const command of PORTABLE_RELEASE_GATES) {
        expect(workflow).toContain(`- run: ${command}`);
      }
      for (const command of [
        "npm ci --prefix tools/inspector --engine-strict --ignore-scripts",
        "npm audit --prefix tools/inspector --audit-level=moderate",
        CONTAINER_RELEASE_GATES[0],
        CONTAINER_RELEASE_GATES[1],
        "MCP_CONTAINER_SCANNER=trivy npm run container:scan",
      ]) {
        expect(workflow).toContain(`- run: ${command}`);
      }
      expect(workflow).toContain(
        "https://github.com/aquasecurity/trivy/releases/download/v0.70.0/" +
          "trivy_0.70.0_Linux-64bit.tar.gz"
      );
      expect(workflow).toContain(trivyChecksum);
      expect(workflow).not.toContain("setup-trivy@");
    }
    expect(ci).not.toContain("npm publish");
    expect(publish).toContain('tags:\n      - "v[0-9]+.[0-9]+.[0-9]+"');
    expect(publish).toContain("needs:\n      - portable-release");
  });

  it("locks every advertised tool into missing and resolved profile CI", () => {
    const packageJson = JSON.parse(read("package.json"));
    expect(toolModules).toHaveLength(20);
    expect(new Set(toolModules.map(({ definition }) => definition.name))).toHaveLength(
      20
    );
    expect(packageJson.scripts["test:protocol"]).toContain(
      "test/http-cross-client.test.ts"
    );
    expect(packageJson.scripts["test:protocol"]).toContain(
      "test/snsdk-53-contract.test.ts"
    );
    const profileContract = read("test/snsdk-53-contract.test.ts");
    expect(profileContract).toContain(
      "rejects every selector failure before handler, secret, client, or ServiceNow access"
    );
    expect(profileContract).toContain(
      "adds the resolved profile to every successful result and audit"
    );
  });

  it("fails closed on release tag drift and keeps version selection separate", () => {
    const packageJson = JSON.parse(read("package.json"));
    const packageLock = JSON.parse(read("package-lock.json"));
    const evidence = validateReleaseContract({ tag: `v${packageJson.version}` });
    expect(evidence).toMatchObject({
      version: "1.2.0",
      tag: "v1.2.0",
      inspectorVersion: "2.0.0",
      providerNeutral: true,
      publicTunnelCreated: false,
    });
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(() => validateReleaseContract({ tag: "v9.9.9" })).toThrow(
      /exactly match/u
    );
    expect(() =>
      validateReleaseContract({
        environment: { GITHUB_REF_TYPE: "tag" },
      })
    ).toThrow(/GITHUB_REF_NAME/u);
    expect(() =>
      validateReleaseContract({
        environment: {
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_NAME: "v1.2.0-beta.1",
        },
      })
    ).toThrow(/stable/u);

    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    expect(dependencies).not.toHaveProperty("semantic-release");
    for (const config of [
      ".releaserc",
      ".releaserc.json",
      ".releaserc.yml",
      "release.config.js",
      "release.config.mjs",
    ]) {
      expect(() => read(config)).toThrow();
    }
  });

  it("publishes the validation assets without provider or tunnel dependencies", () => {
    const packageJson = JSON.parse(read("package.json"));
    for (const path of [
      "scripts/inspector.mjs",
      "scripts/release-validate.mjs",
      "scripts/smoke-test.mjs",
      "docs/RELEASE-VALIDATION.md",
      "tools/inspector/package.json",
      "tools/inspector/package-lock.json",
    ]) {
      expect(packageJson.files).toContain(path);
    }
    expect(Object.keys(packageJson.dependencies)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/openai|anthropic|ngrok|tunnel|cloudflare/iu),
      ])
    );

    const inspector = read("scripts/inspector.mjs");
    const smoke = read("scripts/smoke-test.mjs");
    const release = read("docs/RELEASE-VALIDATION.md").toLowerCase();
    const migration = read("docs/V2-MIGRATION.md").toLowerCase();
    expect(inspector).not.toContain('"--header"');
    expect(inspector).not.toContain('command: "npx"');
    expect(inspector).not.toContain("0.0.0.0");
    expect(smoke).not.toContain("MCP_BEARER_TOKEN=");
    expect(release).toContain(
      "without changing `mcp_url`, `mcp_profile`, or the protected endpoint"
    );
    expect(release).toContain("does not create a tunnel");
    expect(release).toContain("previous immutable artifact digest");
    expect(release).toContain("package archive manifest");
    expect(release).toContain("production dependency audit");
    expect(release).toContain("container validation and scan");
    expect(release).toContain("rollback");
    expect(migration).toContain("no release, inspector, smoke, environment, or migration escape hatch");
  });
});
