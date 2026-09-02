import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

describe("HTTP-only package contract", () => {
  it("has no stdio transport import or legacy startup helper in source", () => {
    const source = sourceFiles(new URL("../src/", import.meta.url))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toContain("StdioServerTransport");
    expect(source).not.toMatch(/server\/stdio(?:\.js)?/u);
    expect(source).not.toContain("createLegacyStdioExecutionContextDependencies");
    expect(source).not.toContain("legacy-stdio-");
  });

  it("publishes production and development commands for the HTTP entrypoint", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
      engines?: Record<string, string>;
      files?: string[];
      overrides?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(packageJson.bin).toEqual({
      "servicenow-mcp": "./dist/index.js",
      "servicenow-mcp-profile": "./dist/profile-admin.js",
      "servicenow-mcp-setup": "./dist/setup.js",
    });
    expect(packageJson.scripts?.start).toBe("node dist/index.js");
    expect(packageJson.scripts?.dev).toBe(
      "npm run build && node --enable-source-maps dist/index.js"
    );
    expect(packageJson.scripts?.prebuild).toBe("node scripts/clean-dist.mjs");
    expect(packageJson.engines?.node).toBe(">=20");
    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBe("1.30.0");
    expect(packageJson.dependencies?.["@hono/node-server"]).toBe("2.0.12");
    expect(packageJson.overrides?.["@hono/node-server"]).toBe("2.0.12");
    expect(packageJson.files).toContain("docs/V2-MIGRATION.md");
    expect(packageJson.files).toContain("docs/PROFILE-CREDENTIALS.md");
    expect(packageJson.files).toContain("docs/CONTAINER-DEPLOYMENT.md");
    expect(JSON.stringify(packageJson)).not.toMatch(/stdio/iu);
  });

  it("aligns the supported Node floor with Hono 2 and continuous integration", () => {
    const lock = JSON.parse(
      readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")
    ) as { packages?: Record<string, { engines?: { node?: string } }> };
    const hono = JSON.parse(
      readFileSync(
        new URL("../node_modules/@hono/node-server/package.json", import.meta.url),
        "utf8"
      )
    ) as { engines?: { node?: string } };
    const ci = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );
    const npmConfiguration = readFileSync(
      new URL("../.npmrc", import.meta.url),
      "utf8"
    );
    expect(lock.packages?.[""]?.engines?.node).toBe(">=20");
    expect(hono.engines?.node).toBe(">=20");
    expect(npmConfiguration.trim()).toBe("engine-strict=true");
    expect(ci).toContain("node-version: [20.x, 22.x]");
    expect(ci).toContain("node-version: 18.x");
    expect(ci).toContain("expected: reject");
    expect(ci).toContain("node-version: 20.x");
    expect(ci).toContain("expected: accept");
    expect(ci).toContain("npm ci --engine-strict");
  });

  it("cleans only dist and leaves no unsupported legacy deep imports", () => {
    const cleanScript = readFileSync(
      new URL("../scripts/clean-dist.mjs", import.meta.url),
      "utf8"
    );

    expect(cleanScript).toContain('new URL("../dist/", import.meta.url)');
    expect(cleanScript).toContain('basename(distDirectory) !== "dist"');
    expect(cleanScript).toContain("isSymbolicLink()");
    expect(cleanScript).not.toMatch(/process\.env|glob|homedir/iu);
    for (const unsupportedOutput of [
      "../dist/flow/",
      "../dist/tools/flow-create.js",
      "../dist/tools/flow-deploy.js",
    ]) {
      expect(existsSync(new URL(unsupportedOutput, import.meta.url))).toBe(false);
    }
  });

  it("does not document a command/arguments client launch as V2 setup", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const smokeClient = readFileSync(
      new URL("../scripts/smoke-test.mjs", import.meta.url),
      "utf8"
    );

    expect(readme).not.toContain('"command": "npx"');
    expect(readme).toContain("http://127.0.0.1:3000/mcp");
    expect(readme).toContain("local Claude stdio configuration is not supported");
    expect(readme).toContain(
      "profile configuration is operator-managed out of band"
    );
    expect(smokeClient).toContain("StreamableHTTPClientTransport");
    expect(smokeClient).not.toContain("node:child_process");
  });

  it("pins the Node server adapter without importing its static-file subpath", () => {
    const sdkTransport = readFileSync(
      new URL(
        "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js",
        import.meta.url
      ),
      "utf8"
    );
    const applicationSource = sourceFiles(new URL("../src/", import.meta.url))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(sdkTransport).toContain("from '@hono/node-server'");
    expect(sdkTransport).not.toMatch(/serve-?static|serveStatic/u);
    expect(applicationSource).not.toMatch(
      /@hono\/node-server\/serve-static/u
    );
  });
});

function sourceFiles(directoryUrl: URL): URL[] {
  return readdirSync(directoryUrl, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) return sourceFiles(child);
    return extname(join(directoryUrl.pathname, entry.name)) === ".ts" ? [child] : [];
  });
}
