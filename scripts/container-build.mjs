#!/usr/bin/env node

/** Deterministic local-image and provenance-enabled OCI archive build hook. */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  cleanupArtifactOutput,
  createArtifactOutputReservation,
  publishArtifactOutput,
} from "./container-artifact-output.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const version = exactValue("package version", packageJson.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u, 64);
const image = exactValue(
  "MCP_CONTAINER_IMAGE",
  process.env.MCP_CONTAINER_IMAGE ?? `servicenow-mcp:${version}`,
  /^[A-Za-z0-9][A-Za-z0-9./:_-]*$/u,
  255
);
const revision = exactValue(
  "MCP_CONTAINER_REVISION",
  process.env.MCP_CONTAINER_REVISION ?? "local",
  /^[0-9A-Za-z._-]+$/u,
  128
);
const epoch = sourceDateEpoch(process.env.SOURCE_DATE_EPOCH);
const created = new Date(epoch * 1000).toISOString();
const mode = process.argv[2] ?? "--local";
const noCache = optionalBoolean("MCP_CONTAINER_NO_CACHE", process.env.MCP_CONTAINER_NO_CACHE);

if (!["--local", "--provenance"].includes(mode) || process.argv.length > 3) {
  throw new Error("Expected --local or --provenance container build mode");
}

const common = [
  "--file", "Dockerfile",
  "--build-arg", `SOURCE_DATE_EPOCH=${epoch}`,
  "--build-arg", `VERSION=${version}`,
  "--build-arg", `REVISION=${revision}`,
  "--build-arg", `CREATED=${created}`,
  "--tag", image,
];
const childEnvironment = {
  ...process.env,
  SOURCE_DATE_EPOCH: String(epoch),
};

if (mode === "--local") {
  const platform = optionalPlatform(process.env.MCP_CONTAINER_PLATFORM);
  run("docker", [
    "build",
    ...common,
    "--provenance=false",
    ...(noCache ? ["--no-cache"] : []),
    ...(platform === undefined ? [] : ["--platform", platform]),
    ".",
  ], childEnvironment);
  process.stdout.write(`${image}\n`);
} else {
  const platform = optionalPlatformSet(
    process.env.MCP_CONTAINER_PLATFORMS ?? "linux/amd64,linux/arm64"
  );
  const outputName = exactValue(
    "MCP_CONTAINER_OCI_NAME",
    process.env.MCP_CONTAINER_OCI_NAME ?? `servicenow-mcp-${version}.oci.tar`,
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.oci\.tar$/u,
    200
  );
  const reservation = createArtifactOutputReservation(repositoryRoot, outputName);
  try {
    run("docker", [
      "buildx", "build",
      ...common,
      ...(noCache ? ["--no-cache"] : []),
      "--platform", platform,
      "--provenance=mode=max",
      "--sbom=true",
      "--output", `type=oci,dest=${reservation.stagingDestination},rewrite-timestamp=true`,
      ".",
    ], childEnvironment);
    process.stdout.write(`${publishArtifactOutput(reservation)}\n`);
  } catch (error) {
    cleanupArtifactOutput(reservation);
    throw error;
  }
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw new Error("Container build command could not start");
  if (result.status !== 0) throw new Error("Container build failed");
}

function sourceDateEpoch(value) {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]{0,11})$/u.test(value)) {
    throw new Error("SOURCE_DATE_EPOCH must be a bounded Unix timestamp");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 253_402_300_799) {
    throw new Error("SOURCE_DATE_EPOCH must be a bounded Unix timestamp");
  }
  return parsed;
}

function optionalPlatform(value) {
  if (value === undefined) return undefined;
  return optionalPlatformSet(value);
}

function optionalPlatformSet(value) {
  const platforms = value.split(",");
  if (
    platforms.length === 0 ||
    platforms.length > 2 ||
    platforms.some((platform) => !["linux/amd64", "linux/arm64"].includes(platform)) ||
    new Set(platforms).size !== platforms.length
  ) {
    throw new Error("Container platforms must be linux/amd64 and/or linux/arm64");
  }
  return platforms.join(",");
}

function exactValue(name, value, pattern, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    !pattern.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalBoolean(name, value) {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 0 or 1`);
}
