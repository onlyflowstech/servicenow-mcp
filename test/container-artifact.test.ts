import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupArtifactOutput,
  createArtifactOutputReservation,
  publishArtifactOutput,
} from "../scripts/container-artifact-output.mjs";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = readFileSync(
  new URL("../.dockerignore", import.meta.url),
  "utf8"
);
const buildHook = readFileSync(
  new URL("../scripts/container-build.mjs", import.meta.url),
  "utf8"
);
const artifactOutputHook = readFileSync(
  new URL("../scripts/container-artifact-output.mjs", import.meta.url),
  "utf8"
);
const scannerHook = readFileSync(
  new URL("../scripts/container-scan.mjs", import.meta.url),
  "utf8"
);
const validateHook = readFileSync(
  new URL("../scripts/container-validate.mjs", import.meta.url),
  "utf8"
);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as {
  version: string;
  scripts: Record<string, string>;
};
const healthcheck = new URL("../deploy/container-healthcheck.mjs", import.meta.url);
const healthcheckSource = readFileSync(healthcheck, "utf8");
const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => closeServer(server)));
});

describe("SNSDK-39 production OCI artifact", () => {
  it("pins immutable multi-arch build/runtime bases and runtime dependencies only", () => {
    const buildDigest =
      "sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c";
    const runtimeDigest =
      "sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50";
    expect(dockerfile).toMatch(
      new RegExp(`^FROM node:22\\.21\\.1-bookworm-slim@${buildDigest} AS build$`, "mu")
    );
    expect(dockerfile).toMatch(
      new RegExp(`^FROM gcr\\.io/distroless/nodejs22-debian13:nonroot@${runtimeDigest} AS runtime$`, "mu")
    );
    expect(dockerfile).toContain(
      "npm ci --engine-strict --ignore-scripts --no-audit --no-fund"
    );
    expect(dockerfile).toContain("npm prune --omit=dev --ignore-scripts");
    expect(dockerfile).toContain(
      'find /runtime-root -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +'
    );
    expect(dockerfile).toContain("COPY --from=build /runtime-root/ /");
    expect(dockerfile).not.toMatch(/npm install|apt-get|apk add|curl|wget/u);
    expect(dockerfile).not.toMatch(/^\s*(?:ADD|COPY)\s+\.\s+/gmu);
    expect(dockerfile).toContain(
      'org.opencontainers.image.version="${VERSION}"'
    );
    expect(dockerfile).toContain(
      "if (!process.argv[1] || process.argv[1] !== actual) process.exit(1)"
    );
  });

  it("runs direct as numeric non-root with health, shutdown, and read-only-safe paths", () => {
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain(
      // dist/index.js is the stdio entrypoint and is meaningless in a
      // container. The image serves the dormant HTTP transport, so it must
      // launch that module; pointing at the stdio one starts a server with no
      // stdin and no listener, which looks healthy and does nothing.
      'ENTRYPOINT ["/nodejs/bin/node", "/app/dist/http-entrypoint.js"]'
    );
    expect(dockerfile).toContain("STOPSIGNAL SIGTERM");
    expect(dockerfile).toContain("EXPOSE 3000/tcp");
    expect(dockerfile).toContain(
      'CMD ["/nodejs/bin/node", "/app/container-healthcheck.mjs"]'
    );
    expect(dockerfile).toContain("HOME=/home/servicenow-mcp");
    expect(healthcheckSource).toContain(
      'const INTERNAL_HEALTHCHECK_AUTHORITY = "mcp-health.internal"'
    );
    expect(healthcheckSource).toContain("host: INTERNAL_HEALTHCHECK_AUTHORITY");
    expect(validateHook).toContain('"--read-only"');
    expect(validateHook).toContain('"--cap-drop=ALL"');
    expect(validateHook).toContain('"--security-opt=no-new-privileges"');
    expect(validateHook).toContain('"/health/live"');
    expect(validateHook).toContain('"/health/ready"');
    expect(validateHook).toContain('waitForDockerHealth(name, "healthy")');
    expect(validateHook).toContain(
      'waitForDockerHealth(unhealthyName, "unhealthy")'
    );
    expect(validateHook).toContain('"wrong.validation.invalid"');
    expect(validateHook).toContain("official MCP SDK");
    expect(validateHook).toContain("independent JSON-RPC fetch");
  });

  it("default-denies build context and never bakes credential configuration", () => {
    const included = dockerignore
      .split("\n")
      .filter((line) => line.startsWith("!"));
    expect(dockerignore.split("\n")).toContain("**");
    expect(included).toEqual([
      "!Dockerfile",
      "!.dockerignore",
      "!.npmrc",
      "!package.json",
      "!package-lock.json",
      "!tsconfig.json",
      "!src/",
      "!src/**",
      "!scripts/",
      "!scripts/clean-dist.mjs",
      "!scripts/set-bin-mode.mjs",
      "!deploy/",
      "!deploy/container-healthcheck.mjs",
    ]);
    expect(dockerfile).not.toMatch(
      /MCP_BEARER_TOKEN|SN_PROFILE_ENCRYPTION_KEY|SN_PASSWORD|(?:^|[/\s])\.env(?:[.\s/]|$)|(?:^|[/\s])config\.json(?:\s|$)/mu
    );
    expect(dockerfile).not.toMatch(/\bARG\s+.*(?:SECRET|PASSWORD|TOKEN|KEY)/iu);
    expect(dockerfile).not.toMatch(/\bENV\s+.*(?:SECRET|PASSWORD|TOKEN|KEY)/iu);
    expect(dockerfile.split("FROM").at(-1)).not.toMatch(/\bRUN\b|npm|corepack|yarn/u);
  });

  it("provides deterministic provenance and mandatory high/critical scan hooks", () => {
    expect(buildHook).toContain("SOURCE_DATE_EPOCH");
    expect(buildHook).toContain('`SOURCE_DATE_EPOCH=${epoch}`');
    expect(buildHook).toContain("MCP_CONTAINER_NO_CACHE");
    expect(buildHook).toContain('"--provenance=false"');
    expect(buildHook).toContain('"--provenance=mode=max"');
    expect(buildHook).toContain('"--sbom=true"');
    expect(buildHook).toContain(
      "`type=oci,dest=${reservation.stagingDestination},rewrite-timestamp=true`"
    );
    expect(buildHook).toContain("publishArtifactOutput(reservation)");
    expect(buildHook).not.toMatch(/\bgit\b|execSync|shell:\s*true/u);
    expect(scannerHook).toContain("trivy");
    expect(scannerHook).toContain("grype");
    expect(scannerHook).toContain("docker-scout");
    expect(scannerHook).toContain("A supported container scanner is required");
    expect(scannerHook).not.toMatch(/process\.exit\(0\)|allowFailure/u);
    expect(packageJson.scripts["container:build"]).toBe(
      "node scripts/container-build.mjs --local"
    );
    expect(packageJson.scripts["container:provenance"]).toBe(
      "node scripts/container-build.mjs --provenance"
    );
    expect(packageJson.scripts["container:validate"]).toBe(
      "node scripts/container-validate.mjs"
    );
    expect(packageJson.scripts["container:scan"]).toBe(
      "node scripts/container-scan.mjs"
    );
  });

  it("rejects symlinked artifact parents and exclusively refuses overwrite races", () => {
    const root = mkdtempSync(join(tmpdir(), "snsdk-39-artifact-"));
    try {
      const target = join(root, "target");
      mkdirSync(target);
      const targetMode = statSync(target).mode & 0o777;
      symlinkSync(target, join(root, "artifacts"), "dir");
      expect(() =>
        createArtifactOutputReservation(root, "release.oci.tar")
      ).toThrow("artifacts/ must be a real directory");
      expect(statSync(target).mode & 0o777).toBe(targetMode);
      rmSync(join(root, "artifacts"));

      mkdirSync(join(root, "artifacts"), { mode: 0o755 });
      expect(() =>
        createArtifactOutputReservation(root, "release.oci.tar")
      ).toThrow("private and owner-controlled");
      rmSync(join(root, "artifacts"), { recursive: true });

      const reservation = createArtifactOutputReservation(
        root,
        "release.oci.tar"
      );
      writeFileSync(reservation.stagingDestination, "safe archive");
      const victim = join(root, "victim");
      writeFileSync(victim, "must survive");
      symlinkSync(victim, reservation.destination);
      expect(() => publishArtifactOutput(reservation)).toThrow();
      expect(readFileSync(victim, "utf8")).toBe("must survive");
      expect(existsSync(reservation.destination)).toBe(true);
      rmSync(reservation.destination);
      cleanupArtifactOutput(reservation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects an artifact-parent swap and publishes a regular archive once", () => {
    const root = mkdtempSync(join(tmpdir(), "snsdk-39-artifact-"));
    try {
      const first = createArtifactOutputReservation(root, "first.oci.tar");
      writeFileSync(first.stagingDestination, "first archive");
      expect(publishArtifactOutput(first)).toBe(first.destination);
      expect(readFileSync(first.destination, "utf8")).toBe("first archive");
      expect(() =>
        createArtifactOutputReservation(root, "first.oci.tar")
      ).toThrow("new file");

      const swapped = createArtifactOutputReservation(root, "second.oci.tar");
      writeFileSync(swapped.stagingDestination, "second archive");
      renameSync(join(root, "artifacts"), join(root, "moved-artifacts"));
      mkdirSync(join(root, "replacement"));
      symlinkSync(join(root, "replacement"), join(root, "artifacts"), "dir");
      expect(() => publishArtifactOutput(swapped)).toThrow();
      expect(existsSync(join(root, "replacement", "second.oci.tar"))).toBe(false);
      cleanupArtifactOutput(swapped);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses held descriptors and detects injection at exact publication boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "snsdk-39-artifact-"));
    try {
      const victim = join(root, "victim");
      writeFileSync(victim, "must survive");

      const sourceSwap = createArtifactOutputReservation(
        root,
        "source-swap.oci.tar"
      );
      writeFileSync(sourceSwap.stagingDestination, "safe archive");
      expect(
        publishArtifactOutput(sourceSwap, {
          afterStagedArtifactOpened: () => {
            unlinkSync(sourceSwap.stagingDestination);
            symlinkSync(victim, sourceSwap.stagingDestination);
          },
        })
      ).toBe(sourceSwap.destination);
      expect(readFileSync(sourceSwap.destination, "utf8")).toBe("safe archive");
      expect(readFileSync(victim, "utf8")).toBe("must survive");
      expect(statSync(sourceSwap.destination).mode & 0o777).toBe(0o600);

      const concurrentFinal = createArtifactOutputReservation(
        root,
        "concurrent-final.oci.tar"
      );
      writeFileSync(concurrentFinal.stagingDestination, "safe archive");
      expect(() =>
        publishArtifactOutput(concurrentFinal, {
          beforeDestinationOpen: () => {
            writeFileSync(concurrentFinal.destination, "attacker final");
          },
        })
      ).toThrow();
      expect(readFileSync(concurrentFinal.destination, "utf8")).toBe(
        "attacker final"
      );
      rmSync(concurrentFinal.destination);
      cleanupArtifactOutput(concurrentFinal);

      const destinationSwap = createArtifactOutputReservation(
        root,
        "destination-swap.oci.tar"
      );
      writeFileSync(destinationSwap.stagingDestination, "safe archive");
      expect(() =>
        publishArtifactOutput(destinationSwap, {
          afterDestinationOpened: () => {
            unlinkSync(destinationSwap.destination);
            symlinkSync(victim, destinationSwap.destination);
          },
        })
      ).toThrow("publication identity check failed");
      expect(readFileSync(victim, "utf8")).toBe("must survive");
      expect(readFileSync(destinationSwap.destination, "utf8")).toBe(
        "must survive"
      );
      rmSync(destinationSwap.destination);
      cleanupArtifactOutput(destinationSwap);

      const injectedError = createArtifactOutputReservation(
        root,
        "injected-error.oci.tar"
      );
      writeFileSync(injectedError.stagingDestination, "safe archive");
      expect(() =>
        publishArtifactOutput(injectedError, {
          afterDestinationCopied: () => {
            throw new Error("injected publication failure");
          },
        })
      ).toThrow("injected publication failure");
      expect(existsSync(injectedError.destination)).toBe(false);
      cleanupArtifactOutput(injectedError);

      const parentRace = createArtifactOutputReservation(
        root,
        "parent-race.oci.tar"
      );
      writeFileSync(parentRace.stagingDestination, "safe archive");
      expect(() =>
        publishArtifactOutput(parentRace, {
          afterDestinationCopied: () => {
            renameSync(join(root, "artifacts"), join(root, "moved-artifacts"));
            mkdirSync(join(root, "artifacts"), { mode: 0o700 });
          },
        })
      ).toThrow(/artifacts\/ changed/u);
      expect(existsSync(join(root, "artifacts", "parent-race.oci.tar"))).toBe(
        false
      );
      expect(
        readFileSync(join(root, "moved-artifacts", "parent-race.oci.tar"), "utf8")
      ).toBe("safe archive");
      cleanupArtifactOutput(parentRace);

      expect(artifactOutputHook).toContain("constants.O_EXCL");
      expect(artifactOutputHook).toContain("constants.O_NOFOLLOW");
      expect(artifactOutputHook).not.toMatch(/\blinkSync\b/u);
      expect(artifactOutputHook).not.toContain(".oci-publish-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("container readiness probe", () => {
  it.each([
    [200, '{"status":"ready"}\n', 0],
    [503, '{"status":"not_ready"}\n', 1],
    [200, '{"status":"ready"}', 1],
    [200, "x".repeat(300), 1],
  ])("bounds and validates status/body (%s)", async (status, body, expectedCode) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const result = await runHealthcheck(address.port);
    expect(result.code).toBe(expectedCode);
    expect(result.stderr).not.toContain(body);
  });

  it("times out a hanging readiness response", async () => {
    const server = createServer(() => {});
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const started = performance.now();
    const result = await runHealthcheck(address.port, 100);
    expect(result.code).toBe(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

function runHealthcheck(port: number, timeoutMs = 500) {
  const child = spawn(process.execPath, [fileURLToPath(healthcheck)], {
    env: {
      ...process.env,
      MCP_PORT: String(port),
      MCP_HEALTHCHECK_TIMEOUT_MS: String(timeoutMs),
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

function closeServer(server: Server): Promise<void> {
  servers.delete(server);
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
