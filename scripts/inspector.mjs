#!/usr/bin/env node

/** Launch a pinned, local-only MCP Inspector UI without putting secrets in argv. */
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INSPECTOR_VERSION = "2.0.0";
export const INSPECTOR_NODE_MINIMUM = Object.freeze([22, 19, 0]);

export function resolveInspectorOptions(environment) {
  const profile = environment.MCP_PROFILE;
  const endpointValue = environment.MCP_URL;
  if (
    typeof profile !== "string" ||
    profile.length === 0 ||
    profile.length > 128 ||
    profile !== profile.trim()
  ) {
    throw new Error("MCP_PROFILE must explicitly name one configured profile");
  }
  if (typeof endpointValue !== "string" || endpointValue.length === 0) {
    throw new Error("MCP_URL must explicitly identify the protected /mcp endpoint");
  }
  return Object.freeze({
    endpoint: validatedMcpEndpoint(endpointValue),
    profile,
  });
}

export function assertInspectorNodeVersion(version = process.versions.node) {
  const parts = version.split(".").map((part) => Number(part));
  if (
    parts.length !== 3 ||
    parts.some((part) => !Number.isInteger(part) || part < 0)
  ) {
    throw new Error("Could not determine the Node.js version for MCP Inspector");
  }
  for (let index = 0; index < INSPECTOR_NODE_MINIMUM.length; index += 1) {
    if (parts[index] > INSPECTOR_NODE_MINIMUM[index]) return;
    if (parts[index] < INSPECTOR_NODE_MINIMUM[index]) {
      throw new Error("MCP Inspector 2.0.0 requires Node.js 22.19.0 or newer");
    }
  }
}

export function inspectorLaunch(environment) {
  const childEnvironment = { ...environment };
  for (const name of Object.keys(childEnvironment)) {
    if (
      name.startsWith("MCP_") ||
      name.startsWith("SN_") ||
      /(?:AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ENCRYPTION_KEY)/iu.test(name)
    ) {
      delete childEnvironment[name];
    }
  }
  childEnvironment.HOST = "127.0.0.1";
  childEnvironment.MCP_AUTO_OPEN_ENABLED = "false";
  const executable = fileURLToPath(
    new URL(
      process.platform === "win32"
        ? "../tools/inspector/node_modules/.bin/mcp-inspector.cmd"
        : "../tools/inspector/node_modules/.bin/mcp-inspector",
      import.meta.url
    )
  );
  return Object.freeze({
    command: executable,
    args: Object.freeze([]),
    environment: Object.freeze(childEnvironment),
  });
}

export async function launchInspector(options, environment = process.env) {
  assertInspectorNodeVersion();
  const launch = inspectorLaunch(environment);
  try {
    accessSync(launch.command, fsConstants.X_OK);
  } catch {
    throw new Error(
      "Pinned Inspector is not installed; run npm ci --prefix tools/inspector --engine-strict"
    );
  }
  console.log("Starting the authenticated local-only MCP Inspector UI.");
  console.log(`Select Streamable HTTP and enter endpoint ${options.endpoint.href}`);
  console.log("Enter the MCP bearer in the local Inspector UI from the approved secret store.");
  console.log(
    `Invoke tools only with explicit profile ${JSON.stringify(options.profile)}; first verify tools/list, missing-profile rejection, and sn_profile.`
  );
  console.log("The launcher never creates or exposes a public tunnel.");

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(launch.command, launch.args, {
      env: launch.environment,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(
        new Error(
          `MCP Inspector exited unsuccessfully (${signal ?? `code ${String(code)}`})`
        )
      );
    });
  });
}

function validatedMcpEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("MCP_URL is invalid");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/mcp"
  ) {
    throw new Error("MCP_URL must be an exact credential-free /mcp URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    endpoint.hostname
  );
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("MCP_URL must use HTTPS unless it is loopback-only");
  }
  return endpoint;
}

function isMainModule() {
  return (
    typeof process.argv[1] === "string" &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  try {
    const options = resolveInspectorOptions(process.env);
    await launchInspector(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Inspector launch failed");
    process.exitCode = 2;
  }
}
