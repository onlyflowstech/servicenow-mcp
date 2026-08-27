#!/usr/bin/env node

/** Required vulnerability scanner hook; missing scanners fail the gate. */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const image = process.env.MCP_CONTAINER_IMAGE ??
  `servicenow-mcp:${String(packageJson.version)}`;
if (
  image.length === 0 ||
  image.length > 255 ||
  !/^[A-Za-z0-9][A-Za-z0-9./:_-]*$/u.test(image)
) {
  throw new Error("MCP_CONTAINER_IMAGE is invalid");
}

const scanners = {
  trivy: {
    command: "trivy",
    versionArgs: ["--version"],
    args: [
      "image", "--scanners", "vuln", "--severity", "HIGH,CRITICAL",
      "--exit-code", "1", "--no-progress", image,
    ],
  },
  grype: {
    command: "grype",
    versionArgs: ["version"],
    args: [image, "--fail-on", "high"],
  },
  "docker-scout": {
    command: "docker",
    versionArgs: ["scout", "version"],
    args: [
      "scout", "cves", "--exit-code", "--only-severity", "critical,high", image,
    ],
  },
};

const requested = process.env.MCP_CONTAINER_SCANNER;
if (requested !== undefined && !Object.hasOwn(scanners, requested)) {
  throw new Error("MCP_CONTAINER_SCANNER must be trivy, grype, or docker-scout");
}
const selected = requested === undefined
  ? Object.entries(scanners).find(([, scanner]) => available(scanner))
  : [requested, scanners[requested]];
if (!selected || !available(selected[1])) {
  throw new Error(
    "A supported container scanner is required (trivy, grype, or docker scout)"
  );
}

const [name, scanner] = selected;
process.stderr.write(`Running required ${name} high/critical vulnerability gate\n`);
const result = spawnSync(scanner.command, scanner.args, { stdio: "inherit" });
if (result.error || result.status !== 0) {
  throw new Error("Container vulnerability scan failed");
}

function available(scanner) {
  const result = spawnSync(scanner.command, scanner.versionArgs, {
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}
