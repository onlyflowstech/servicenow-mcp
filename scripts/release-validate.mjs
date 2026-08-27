#!/usr/bin/env node

/** Deterministic, provider-neutral SNSDK-57 release-contract validation. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INSPECTOR_INTEGRITY =
  "sha512-uEoeEG7/+ZbrvccPF3EsgbfjcyJ3bWVJXT4pcZtpmDUhA0zdK4T4Tuj2oUphi2Huwl66LqVdo3Mx2PkS2SUHXA==";
const TRIVY_RELEASE =
  "https://github.com/aquasecurity/trivy/releases/download/v0.70.0/trivy_0.70.0_Linux-64bit.tar.gz";
const TRIVY_SHA256 =
  "8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9";

export const PORTABLE_RELEASE_GATES = Object.freeze([
  "npm run release:contract",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run test:unit",
  "npm run test:protocol",
  "npm run test:profile",
  "npm run test:release",
  "npm pack --dry-run --json --ignore-scripts",
  "npm audit --omit=dev --audit-level=moderate",
]);

export const CONTAINER_RELEASE_GATES = Object.freeze([
  "npm run container:build",
  "npm run container:validate",
  "npm run container:scan",
]);

export function validateReleaseContract(options = {}) {
  const root = options.root ?? fileURLToPath(new URL("..", import.meta.url));
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const inspectorPackage = JSON.parse(read("tools/inspector/package.json"));
  const inspectorLock = JSON.parse(read("tools/inspector/package-lock.json"));
  const ci = read(".github/workflows/ci.yml");
  const publish = read(".github/workflows/publish.yml");
  const inspectorSource = read("scripts/inspector.mjs");
  const releaseGuide = read("docs/RELEASE-VALIDATION.md");

  assert(/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(packageJson.version), "package version is not stable semver");
  assert(packageLock.version === packageJson.version, "package-lock version differs from package version");
  assert(
    packageLock.packages?.[""]?.version === packageJson.version,
    "root lock package version differs from package version"
  );
  const tag = options.tag ?? releaseTagFromEnvironment(options.environment ?? process.env);
  if (tag !== undefined) {
    assert(tag === `v${packageJson.version}`, "release tag must exactly match package version");
  }

  for (const script of [
    "inspector",
    "smoke",
    "test:unit",
    "test:protocol",
    "test:profile",
    "test:release",
    "release:contract",
    "release:check",
    "release:container",
    "container:build",
    "container:validate",
    "container:scan",
  ]) {
    assert(typeof packageJson.scripts?.[script] === "string", `missing package script ${script}`);
  }
  assert(
    packageJson.scripts["test:protocol"].includes("test/http-cross-client.test.ts") &&
      packageJson.scripts["test:protocol"].includes("test/snsdk-53-contract.test.ts"),
    "protocol gate must cover every missing and resolved profile contract"
  );

  for (const path of [
    "scripts/inspector.mjs",
    "scripts/release-validate.mjs",
    "scripts/smoke-test.mjs",
    "docs/RELEASE-VALIDATION.md",
    "tools/inspector/package.json",
    "tools/inspector/package-lock.json",
  ]) {
    assert(packageJson.files?.includes(path), `published package omits ${path}`);
  }

  assert(
    inspectorPackage.dependencies?.["@modelcontextprotocol/inspector"] === "2.0.0",
    "Inspector dependency must be exactly pinned"
  );
  assert(
    inspectorPackage.engines?.node === ">=22.19.0",
    "Inspector toolchain Node floor is invalid"
  );
  const lockedInspector =
    inspectorLock.packages?.["node_modules/@modelcontextprotocol/inspector"];
  assert(lockedInspector?.version === "2.0.0", "Inspector lock version is invalid");
  assert(lockedInspector?.integrity === INSPECTOR_INTEGRITY, "Inspector lock integrity is invalid");
  assert(!packageJson.dependencies?.["@modelcontextprotocol/inspector"], "Inspector must remain outside runtime dependencies");
  assert(!packageJson.devDependencies?.["@modelcontextprotocol/inspector"], "Inspector must remain outside root development dependencies");

  for (const workflow of [ci, publish]) {
    for (const gate of [
      "npm run release:contract",
      "npm run typecheck",
      "npm run lint",
      "npm run build",
      "npm run test:unit",
      "npm run test:protocol",
      "npm run test:profile",
      "npm run test:release",
      "npm pack --dry-run --json --ignore-scripts",
      "npm audit --omit=dev --audit-level=moderate",
      "npm ci --prefix tools/inspector --engine-strict --ignore-scripts",
      "npm audit --prefix tools/inspector --audit-level=moderate",
      "npm run container:build",
      "npm run container:validate",
      "MCP_CONTAINER_SCANNER=trivy npm run container:scan",
    ]) {
      assert(hasRunStep(workflow, gate), `workflow omits run step ${gate}`);
    }
    assert(workflow.includes(TRIVY_RELEASE), "workflow omits pinned Trivy release");
    assert(workflow.includes(TRIVY_SHA256), "workflow omits Trivy checksum");
    assert(!workflow.includes("setup-trivy@"), "workflow uses a mutable Trivy action");
  }
  assert(publish.includes("needs:"), "publish must depend on validation jobs");
  assert(publish.includes("npm publish --access public"), "publish action is missing");

  assert(inspectorSource.includes('childEnvironment.HOST = "127.0.0.1"'), "Inspector must bind to loopback");
  assert(inspectorSource.includes('MCP_AUTO_OPEN_ENABLED = "false"'), "Inspector auto-open must be disabled");
  assert(!inspectorSource.includes('"--header"'), "Inspector bearer must not enter argv");
  assert(!inspectorSource.includes("0.0.0.0"), "Inspector must not expose a public listener");
  assert(!inspectorSource.includes('command: "npx"'), "Inspector must use the locked local binary");

  const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
  assert(
    runtimeDependencies.every(
      (name) => !/(?:openai|anthropic|tunnel|ngrok|cloudflare)/iu.test(name)
    ),
    "release artifact contains an AI-provider or tunnel dependency"
  );
  for (const evidence of [
    "previous immutable artifact digest",
    "package archive manifest",
    "production dependency audit",
    "container validation and scan",
    "rollback",
    "does not create a tunnel",
  ]) {
    assert(releaseGuide.toLowerCase().includes(evidence), `release guide omits ${evidence}`);
  }

  return Object.freeze({
    version: packageJson.version,
    tag: tag ?? null,
    inspectorVersion: inspectorPackage.dependencies["@modelcontextprotocol/inspector"],
    portableGateCount: PORTABLE_RELEASE_GATES.length,
    containerGateCount: CONTAINER_RELEASE_GATES.length,
    providerNeutral: true,
    publicTunnelCreated: false,
  });
}

function releaseTagFromEnvironment(environment) {
  if (environment.GITHUB_REF_TYPE !== "tag") return undefined;
  const tag = environment.GITHUB_REF_NAME;
  if (typeof tag !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(tag)) {
    throw new Error("tag release is missing a valid stable GITHUB_REF_NAME");
  }
  return tag;
}

function hasRunStep(workflow, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*-\\s+run:\\s+${escaped}\\s*$`, "mu").test(workflow);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isMainModule() {
  return (
    typeof process.argv[1] === "string" &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  try {
    process.stdout.write(`${JSON.stringify(validateReleaseContract())}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Release contract validation failed"}\n`
    );
    process.exitCode = 1;
  }
}
