import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

describe("stdio-only package contract", () => {
  it("connects stdio from the shipped entrypoint and nowhere else", () => {
    const stdioRuntime = readFileSync(
      new URL("../src/stdio-runtime.ts", import.meta.url),
      "utf8"
    );
    const entrypoint = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8"
    );

    // Exactly one module owns the transport, and the entrypoint reaches it.
    expect(stdioRuntime).toContain(
      'from "@modelcontextprotocol/sdk/server/stdio.js"'
    );
    expect(stdioRuntime).toContain("new StdioServerTransport()");
    expect(entrypoint).toContain('from "./stdio-runtime.js"');
    expect(entrypoint).toContain("startStdioRuntime");

    // The legacy 1.0 stdio composition is gone; this is not a revert to it.
    const source = sourceFiles(new URL("../src/", import.meta.url))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(source).not.toContain("createLegacyStdioExecutionContextDependencies");
    expect(source).not.toContain("legacy-stdio-");

    // No other module opens a transport of its own.
    const stdioImporters = sourceFiles(new URL("../src/", import.meta.url)).filter(
      (file) =>
        readFileSync(file, "utf8").includes(
          "@modelcontextprotocol/sdk/server/stdio.js"
        )
    );
    expect(stdioImporters.map((file) => file.pathname.split("/").pop())).toEqual([
      "stdio-runtime.ts",
    ]);
  });

  it("keeps the HTTP implementation compiling but off every CLI path", () => {
    const entrypoint = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8"
    );
    const setup = readFileSync(new URL("../src/setup.ts", import.meta.url), "utf8");
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { bin?: Record<string, string> };

    // The dormant composition still exists and still builds.
    expect(
      existsSync(new URL("../src/http-entrypoint.ts", import.meta.url))
    ).toBe(true);
    expect(existsSync(new URL("../src/http-runtime.ts", import.meta.url))).toBe(true);

    // Nothing published can start it: it is not a bin, and the stdio
    // entrypoint neither imports it nor branches to it on an env switch.
    expect(Object.values(packageJson.bin ?? {})).not.toContain(
      "./dist/http-entrypoint.js"
    );
    // A prose pointer to the dormant module is wanted; an import of it is not.
    expect(entrypoint).not.toMatch(/from\s+"\.\/http-entrypoint\.js"/u);
    expect(entrypoint).not.toContain("runHttpService");
    expect(entrypoint).not.toContain("createHttpRuntime");
    // No env switch either: the owner asked for dormant, not configurable.
    expect(entrypoint).not.toContain("MCP_TRANSPORT");

    // Setup never registers a client against a URL, and never advertises one.
    // A transport flag may be named in a comment explaining why it is absent;
    // what must not exist is one in an argv array setup actually runs.
    expect(setup).not.toMatch(/"--transport"/u);
    expect(setup).not.toMatch(/"mcp-remote"|npx\b/u);
    expect(setup).not.toMatch(/"--url"/u);
    expect(setup).not.toMatch(/http:\/\/127\.0\.0\.1:\d+/u);
  });

  it("publishes production and development commands for the stdio entrypoint", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
      description?: string;
      engines?: Record<string, string>;
      files?: string[];
      keywords?: string[];
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
    // The published description and keywords must name the transport clients
    // actually get, not the one 2.0 briefly shipped.
    expect(packageJson.description).toContain("stdio");
    expect(packageJson.description).not.toMatch(/HTTP-only/iu);
    expect(packageJson.keywords).toContain("stdio");
    expect(packageJson.keywords).not.toContain("streamable-http");
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

  it("documents the stdio client launch that setup actually registers", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const smokeClient = readFileSync(
      new URL("../scripts/smoke-test.mjs", import.meta.url),
      "utf8"
    );

    expect(readme).toContain("claude mcp add servicenow-mcp -- servicenow-mcp");
    expect(readme).toContain("codex mcp add servicenow-mcp -- servicenow-mcp");
    expect(readme).toContain(
      "profile configuration is operator-managed out of band"
    );
    // The README must not still promise a listening endpoint.
    expect(readme).not.toContain("http://127.0.0.1:3000/mcp");

    // The smoke client spawns the server the way a client does.
    expect(smokeClient).toContain("StdioClientTransport");
    expect(smokeClient).not.toContain("StreamableHTTPClientTransport");
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
