#!/usr/bin/env node

/** Adversarial local validation of the built production container. */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createServer as createTcpServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const version = String(packageJson.version);
const image = process.env.MCP_CONTAINER_IMAGE ?? `servicenow-mcp:${version}`;
if (
  image.length === 0 ||
  image.length > 255 ||
  !/^[A-Za-z0-9][A-Za-z0-9./:_-]*$/u.test(image)
) {
  throw new Error("MCP_CONTAINER_IMAGE is invalid");
}

const token = "container-validation-token-012345678901234567890123456789";
const profileSecret = "container-validation-secret-never-baked";
const profileName = "validation";
const name = `snsdk-39-${randomBytes(8).toString("hex")}`;
const unhealthyName = `${name}-unhealthy`;
const startedAt = performance.now();
let created = false;
let unhealthyCreated = false;
let officialClient;

try {
  const [metadata] = JSON.parse(docker(["image", "inspect", image]).stdout);
  assertImageMetadata(metadata);
  const hostPort = await availableHostPort();
  const endpoint = new URL(`http://127.0.0.1:${hostPort}/mcp`);

  docker([
    "run", "--detach", "--name", name,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--health-interval=1s",
    "--health-retries=3",
    "--health-start-period=0s",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=1700",
    "--publish", `127.0.0.1:${hostPort}:3000/tcp`,
    "--env", `MCP_BEARER_TOKEN=${token}`,
    "--env", "MCP_OWNER_ID=container-validation-owner",
    "--env", "MCP_CLIENT_ID=container-validation-client",
    "--env", `MCP_ALLOWED_HOSTS=127.0.0.1:${hostPort}`,
    "--env", "SN_PROFILE_NAME=validation",
    "--env", "SN_INSTANCE=https://validation.service-now.com",
    "--env", "SN_USER=container-validation-user",
    "--env", `SN_PASSWORD=${profileSecret}`,
    image,
  ]);
  created = true;

  await waitUntilReady(name, endpoint);
  await waitForDockerHealth(name, "healthy");
  await verifyHostBoundary(endpoint);
  verifyRuntimeIsolation(name);
  const officialManifest = await verifyOfficialClient(endpoint, token);
  const independentManifest = await verifyIndependentClient(endpoint, token);
  assert(
    JSON.stringify(officialManifest) === JSON.stringify(independentManifest),
    "official and independent clients discovered different tool contracts"
  );

  const live = await fetch(new URL("/health/live", endpoint));
  const ready = await fetch(new URL("/health/ready", endpoint));
  assert(live.status === 200, "liveness failed");
  assert(ready.status === 200, "readiness failed");

  docker(["stop", "--time", "3", name]);
  const [stopped] = JSON.parse(docker(["container", "inspect", name]).stdout);
  assert(stopped.State.ExitCode === 0, "SIGTERM shutdown was not clean");
  const logs = docker(["logs", name]).stdout;
  assert(logs.includes("HTTP shutdown complete (SIGTERM)."), "shutdown evidence missing");
  assert(!logs.includes(token) && !logs.includes(profileSecret), "runtime logs leaked a secret");

  docker([
    "run", "--detach", "--name", unhealthyName,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--health-interval=1s",
    "--health-retries=2",
    "--health-start-period=0s",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=1700",
    "--env", `MCP_BEARER_TOKEN=${token}`,
    "--env", "MCP_OWNER_ID=container-validation-owner",
    "--env", "MCP_CLIENT_ID=container-validation-client",
    "--env", "MCP_ALLOWED_HOSTS=mcp.validation.example:443",
    "--env", "MCP_HEALTHCHECK_TIMEOUT_MS=invalid",
    "--env", "SN_PROFILE_NAME=validation",
    "--env", "SN_INSTANCE=https://validation.service-now.com",
    "--env", "SN_USER=container-validation-user",
    "--env", `SN_PASSWORD=${profileSecret}`,
    image,
  ]);
  unhealthyCreated = true;
  await waitForDockerHealth(unhealthyName, "unhealthy");

  process.stdout.write(JSON.stringify({
    image,
    image_id: metadata.Id,
    version,
    architecture: metadata.Architecture,
    size_bytes: metadata.Size,
    startup_and_two_client_validation_ms: Math.round(performance.now() - startedAt),
    non_root_uid: 10001,
    read_only_root: true,
    clients: ["official MCP SDK", "independent JSON-RPC fetch"],
    exact_cross_client_tool_contract: true,
    explicit_profile_boundary: true,
    docker_health_healthy: true,
    docker_health_unhealthy: true,
    external_host_boundary: true,
    graceful_sigterm: true,
  }) + "\n");
} finally {
  if (officialClient) await officialClient.close().catch(() => {});
  if (created) docker(["rm", "--force", name], true);
  if (unhealthyCreated) docker(["rm", "--force", unhealthyName], true);
}

function assertImageMetadata(metadata) {
  const config = metadata.Config ?? {};
  assert(config.User === "10001:10001", "image user must be numeric non-root");
  assert(
    JSON.stringify(config.Entrypoint) ===
      JSON.stringify(["/nodejs/bin/node", "/app/dist/index.js"]),
    "image entrypoint is invalid"
  );
  assert(config.StopSignal === "SIGTERM", "image stop signal is invalid");
  assert(
    JSON.stringify(config.Healthcheck?.Test) ===
      JSON.stringify(["CMD", "/nodejs/bin/node", "/app/container-healthcheck.mjs"]),
    "image healthcheck is invalid"
  );
  assert(
    config.Labels?.["org.opencontainers.image.version"] === version,
    "OCI version label does not match package version"
  );
  for (const entry of config.Env ?? []) {
    const name = entry.split("=", 1)[0];
    assert(
      !/^(?:MCP_BEARER_TOKEN|MCP_OWNER_ID|MCP_CLIENT_ID|SN_|.*SECRET.*|.*PASSWORD.*|.*TOKEN.*)$/u.test(name),
      `image contains forbidden environment setting ${name}`
    );
  }
  assert(metadata.Size < 300 * 1024 * 1024, "image exceeds the 300 MiB release ceiling");
}

async function waitUntilReady(containerName, endpoint) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health/ready", endpoint), {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {
      // Startup is expected to reject connections briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const logs = docker(["logs", containerName], true).stdout;
  throw new Error(`Container did not become ready; sanitized logs length=${logs.length}`);
}

async function waitForDockerHealth(containerName, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [container] = JSON.parse(
      docker(["container", "inspect", containerName]).stdout
    );
    const status = container.State?.Health?.Status;
    if (status === expected) return;
    assert(container.State?.Running === true, "container exited before health settled");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Docker health did not reach ${expected}`);
}

async function verifyHostBoundary(endpoint) {
  const exact = await fetch(new URL("/health/ready", endpoint), {
    signal: AbortSignal.timeout(1_000),
  });
  assert(exact.status === 200, "exact external Host authority was rejected");
  for (const host of ["wrong.validation.invalid", "mcp-health.internal"]) {
    const status = await requestStatus(new URL("/health/ready", endpoint), host);
    assert(status === 421, "an external unapproved Host authority was accepted");
  }
}

function requestStatus(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: "GET",
      headers: { connection: "close", host },
      timeout: 1_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("timeout", () => request.destroy(new Error("Host probe timed out")));
    request.once("error", reject);
    request.end();
  });
}

function availableHostPort() {
  const server = createTcpServer();
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a container validation port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function verifyRuntimeIsolation(containerName) {
  docker([
    "exec", containerName, "/nodejs/bin/node", "-e",
    "if(process.getuid?.()!==10001||process.getgid?.()!==10001)process.exit(1);require('node:fs').writeFileSync('/tmp/runtime-probe','ok');require('node:fs').unlinkSync('/tmp/runtime-probe')",
  ]);
  const developmentDependency = docker([
    "exec", containerName, "/nodejs/bin/node", "-e",
    "try{require.resolve('eslint');process.exit(1)}catch(error){if(error?.code!=='MODULE_NOT_FOUND')process.exit(1)}",
  ], true);
  assert(developmentDependency.status === 0, "runtime image contains a development dependency");
  const readOnly = docker([
    "exec", containerName, "/nodejs/bin/node", "-e",
    "require('node:fs').writeFileSync('/home/servicenow-mcp/rootfs-probe','must-fail')",
  ], true);
  assert(readOnly.status !== 0, "container root filesystem accepted a write");
}

async function verifyOfficialClient(endpoint, bearerToken) {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${bearerToken}` } },
  });
  officialClient = new Client({
    name: "snsdk-39-official-sdk",
    version: "1.0.0",
  });
  await officialClient.connect(transport);
  const listed = await officialClient.listTools();
  const manifest = normalizeToolManifest(listed.tools, "official client");
  await verifyProfileCalls(
    (name, args) => officialClient.callTool({ name, arguments: args }),
    "official client"
  );
  await officialClient.close();
  officialClient = undefined;
  return manifest;
}

async function verifyIndependentClient(endpoint, bearerToken) {
  let requestId = 0;
  let protocolVersion;
  const call = async (method, params) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearerToken}`,
        "content-type": "application/json",
        ...(protocolVersion === undefined
          ? {}
          : { "mcp-protocol-version": protocolVersion }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    });
    const body = await response.json();
    assert(response.status === 200 && !body.error, "independent client request failed");
    return body.result;
  };
  const initialized = await call("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "snsdk-39-independent-fetch", version: "1.0.0" },
  });
  protocolVersion = initialized.protocolVersion;
  const notification = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert(notification.status === 202, "independent client initialization failed");
  const listed = await call("tools/list", {});
  const manifest = normalizeToolManifest(listed.tools, "independent client");
  await verifyProfileCalls(
    (name, args) => call("tools/call", { name, arguments: args }),
    "independent client"
  );
  return manifest;
}

async function verifyProfileCalls(callTool, label) {
  const valid = await callTool("sn_profile", { profile: profileName });
  assert(valid?.isError !== true, `${label} rejected the configured profile`);
  assert(
    valid?.structuredContent?.profile === profileName &&
      valid?.structuredContent?.data?.name === profileName &&
      valid?.structuredContent?.data?.instance ===
        "https://validation.service-now.com",
    `${label} returned the wrong resolved profile binding`
  );

  const missing = await callTool("sn_profile", {});
  assert(
    missing?.isError === true && missing?.structuredContent === undefined,
    `${label} did not reject a missing profile before execution`
  );
  const unknown = await callTool("sn_profile", {
    profile: "unknown-container-validation-profile",
  });
  assert(
    unknown?.isError === true && unknown?.structuredContent === undefined,
    `${label} did not reject an unknown profile before execution`
  );

  const serialized = JSON.stringify({ valid, missing, unknown });
  assert(
    !serialized.includes(token) && !serialized.includes(profileSecret),
    `${label} profile results leaked a secret`
  );
}

function normalizeToolManifest(tools, label) {
  // Independent external check of the built container: deliberately a literal,
  // not an import of the local registry. Source of truth is
  // REGISTERED_TOOL_COUNT in src/tools/index.ts (derived from catalog.ts).
  assert(Array.isArray(tools) && tools.length === 19, `${label} did not discover 19 tools`);
  const names = new Set();
  const manifest = tools.map((tool) => {
    assert(typeof tool?.name === "string" && tool.name.length > 0, `${label} exposed an invalid tool name`);
    assert(!names.has(tool.name), `${label} exposed a duplicate tool name`);
    names.add(tool.name);
    assert(
      tool.inputSchema?.properties?.profile?.type === "string" &&
        tool.inputSchema?.properties?.profile?.minLength === 1 &&
        Array.isArray(tool.inputSchema?.required) &&
        tool.inputSchema.required.includes("profile"),
      `${label} exposed a tool without an explicit required profile`
    );
    assert(tool.outputSchema?.type === "object", `${label} exposed a tool without an output schema`);
    assert(tool.annotations && typeof tool.annotations === "object", `${label} exposed a tool without annotations`);
    return canonicalizeJson({
      name: tool.name,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    });
  });
  return manifest.sort((left, right) => left.name.localeCompare(right.name));
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeJson(child)])
  );
}

function docker(args, allowFailure = false) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error("Docker validation command failed");
  }
  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
