#!/usr/bin/env node
/**
 * Opt-in live smoke test for an already-running V2 HTTP service.
 *
 * Have an approved supervisor inject MCP_BEARER_TOKEN out of band, set the
 * non-secret MCP_URL and MCP_PROFILE values, then run `npm run smoke`.
 * Writes additionally require `--write --confirm-write-profile=<MCP_PROFILE>`.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+={0,2}$/u;
const SYS_ID = /^[0-9a-f]{32}$/u;
const WRITE_CONFIRM_PREFIX = "--confirm-write-profile=";

export function resolveSmokeOptions(argv, environment) {
  const token = environment.MCP_BEARER_TOKEN;
  const profile = environment.MCP_PROFILE;
  const endpointValue = environment.MCP_URL;
  if (typeof token !== "string" || token.length < 32 || token.length > 4096) {
    throw new Error("MCP_BEARER_TOKEN must be injected and contain 32-4096 characters");
  }
  if (!BEARER_TOKEN.test(token)) {
    throw new Error("MCP_BEARER_TOKEN is invalid");
  }
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

  const endpoint = validatedMcpEndpoint(endpointValue);
  const timeoutMs = validatedTimeout(environment.MCP_SMOKE_TIMEOUT_MS);
  const writeFlags = argv.filter((argument) => argument === "--write");
  const confirmations = argv.filter((argument) =>
    argument.startsWith(WRITE_CONFIRM_PREFIX)
  );
  const knownArguments = argv.filter(
    (argument) =>
      argument === "--write" || argument.startsWith(WRITE_CONFIRM_PREFIX)
  );
  if (knownArguments.length !== argv.length || writeFlags.length > 1) {
    throw new Error("Smoke arguments are invalid");
  }
  if (confirmations.length > 1) {
    throw new Error("Only one write-profile confirmation is allowed");
  }

  const writeEnabled = writeFlags.length === 1;
  const confirmedProfile = confirmations[0]?.slice(WRITE_CONFIRM_PREFIX.length);
  if (writeEnabled && confirmedProfile !== profile) {
    throw new Error(
      "--write requires --confirm-write-profile=<exact MCP_PROFILE>"
    );
  }
  if (!writeEnabled && confirmedProfile !== undefined) {
    throw new Error("Write-profile confirmation requires --write");
  }

  return Object.freeze({
    endpoint,
    token,
    profile,
    writeEnabled,
    timeoutMs,
  });
}

export function extractCreatedSysId(result) {
  const structured = result?.structuredContent;
  const data =
    typeof structured === "object" && structured !== null
      ? Reflect.get(structured, "data")
      : undefined;
  const sysId =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "sys_id")
      : undefined;
  if (typeof sysId !== "string" || !SYS_ID.test(sysId)) {
    throw new Error("sn_create did not return a canonical structured sys_id");
  }
  return sysId;
}

export async function runSmoke(options) {
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    requestInit: { headers: { authorization: `Bearer ${options.token}` } },
  });
  const client = new Client({
    name: "servicenow-mcp-http-smoke",
    version: "2.0.0",
  });
  const checks = [];

  try {
    await client.connect(transport, requestOptions(options.timeoutMs));
    const discovered = await client.listTools(undefined, requestOptions(options.timeoutMs));
    record(
      checks,
      "tools/list",
      // Independent external check of the live server: deliberately a
      // literal, not an import of the local registry. Source of truth is
      // REGISTERED_TOOL_COUNT in src/tools/index.ts (derived from catalog.ts).
      discovered.tools.length === 19,
      `${discovered.tools.length} tools`
    );
    record(
      checks,
      "required profile schemas",
      discovered.tools.every(
        (tool) =>
          tool.inputSchema.required?.includes("profile") &&
          tool.inputSchema.properties?.profile?.minLength === 1
      )
    );

    const profileResult = await call(
      client,
      "sn_profile",
      { profile: options.profile },
      options.timeoutMs
    );
    record(
      checks,
      "sn_profile",
      !profileResult.isError &&
        profileResult.structuredContent?.profile === options.profile
    );

    const health = await call(
      client,
      "sn_health",
      { profile: options.profile, check: "version" },
      options.timeoutMs
    );
    record(
      checks,
      "sn_health version",
      !health.isError && health.structuredContent?.profile === options.profile,
      health.text.slice(0, 120)
    );

    const query = await call(
      client,
      "sn_query",
      { profile: options.profile, table: "incident", limit: 3 },
      options.timeoutMs
    );
    record(
      checks,
      "sn_query incident",
      !query.isError && query.structuredContent?.profile === options.profile,
      `${query.text.length} chars`
    );

    if (options.writeEnabled) {
      await writeRoundTrip(client, checks, options.profile, options.timeoutMs);
    }
  } finally {
    await client.close();
  }

  const failures = checks.filter((check) => !check.pass);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length > 0) process.exitCode = 1;
}

export async function writeRoundTrip(client, checks, profile, timeoutMs = 30_000) {
  const created = await call(client, "sn_create", {
    profile,
    table: "incident",
    fields: { short_description: "MCP V2 HTTP smoke test — safe to delete" },
  }, timeoutMs);
  if (created.isError) {
    record(checks, "sn_create incident", false, created.text.slice(0, 120));
    return;
  }

  const sysId = extractCreatedSysId(created);
  record(
    checks,
    "sn_create incident",
    created.structuredContent?.profile === profile
  );
  try {
    const journaled = await call(client, "sn_incident_add_work_note", {
      profile,
      sys_id: sysId,
      content: "tested through V2 Streamable HTTP",
    }, timeoutMs);
    record(
      checks,
      "sn_incident_add_work_note",
      !journaled.isError && journaled.structuredContent?.profile === profile
    );
  } finally {
    const deleted = await call(client, "sn_delete", {
      profile,
      table: "incident",
      sys_id: sysId,
      confirm: true,
    }, timeoutMs);
    record(
      checks,
      "sn_delete incident",
      !deleted.isError && deleted.structuredContent?.profile === profile
    );
  }
}

async function call(client, name, args, timeoutMs) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    requestOptions(timeoutMs)
  );
  return {
    isError: result.isError === true,
    structuredContent: result.structuredContent,
    text: result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  };
}

function requestOptions(timeoutMs) {
  return Object.freeze({
    signal: AbortSignal.timeout(timeoutMs),
    timeout: timeoutMs,
  });
}

function validatedTimeout(value) {
  if (value === undefined) return 30_000;
  if (!/^[0-9]+$/u.test(value)) {
    throw new Error("MCP_SMOKE_TIMEOUT_MS must be an integer from 1000 to 120000");
  }
  const timeoutMs = Number(value);
  if (timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("MCP_SMOKE_TIMEOUT_MS must be an integer from 1000 to 120000");
  }
  return timeoutMs;
}

function record(checks, name, pass, note = "") {
  checks.push({ name, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
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
    await runSmoke(resolveSmokeOptions(process.argv.slice(2), process.env));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Smoke validation failed");
    process.exitCode = 2;
  }
}
