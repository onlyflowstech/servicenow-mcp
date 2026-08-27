import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MCP_LIVENESS_PATH,
  MCP_READINESS_PATH,
} from "../src/http-runtime.js";
import {
  MAX_RATE_LIMIT_CAPACITY,
  MAX_RATE_LIMIT_ENTRIES,
  MAX_RATE_LIMIT_PERIOD_MS,
} from "../src/http-observability.js";
import { DEFAULT_SHUTDOWN_GRACE_PERIOD_MS } from "../src/startup.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runbookPath = resolve(repositoryRoot, "docs/OPERATIONS-RUNBOOK.md");
const runbook = readFileSync(runbookPath, "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8")
) as { readonly files?: readonly string[] };

function section(start: string, end: string): string {
  const from = runbook.indexOf(start);
  const to = runbook.indexOf(end, from + start.length);
  expect(from, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing section ${end}`).toBeGreaterThan(from);
  return runbook.slice(from, to);
}

describe("SNSDK-41 remote operations runbook contract", () => {
  it("ships the runbook and links only to existing repository documents", () => {
    expect(packageJson.files).toContain("docs/OPERATIONS-RUNBOOK.md");
    const markdownLinks = [...runbook.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
      .map((match) => match[1])
      .filter((target) => !target.includes(":"));
    for (const target of markdownLinks) {
      expect(existsSync(resolve(dirname(runbookPath), target))).toBe(true);
    }
  });

  it("pins lifecycle paths and keeps ServiceNow out of readiness semantics", () => {
    expect(MCP_LIVENESS_PATH).toBe("/health/live");
    expect(MCP_READINESS_PATH).toBe("/health/ready");
    expect(runbook).toContain(MCP_LIVENESS_PATH);
    expect(runbook).toContain(MCP_READINESS_PATH);
    expect(runbook).toContain('{"status":"live"}');
    expect(runbook).toContain('{"status":"ready"}');
    expect(runbook).toContain('{"status":"not_ready"}');
    expect(runbook).toContain("Do not make ServiceNow availability part of liveness or readiness");
    expect(runbook).toContain("never feed this into readiness");
    expect(runbook).toContain("Health requests are unauthenticated lifecycle signals");
    expect(runbook).toContain("never construct an MCP server or contact ServiceNow");
  });

  it("defines actionable metrics without claiming a native or public metrics endpoint", () => {
    const metrics = section("### Derived metrics", "### Initial alerts");
    for (const name of [
      "servicenow_mcp_probe_live",
      "servicenow_mcp_probe_ready",
      "servicenow_mcp_http_requests_total",
      "servicenow_mcp_http_duration_ms",
      "servicenow_mcp_tool_calls_total",
      "servicenow_mcp_tool_duration_ms",
      "servicenow_mcp_telemetry_dropped_total",
      "servicenow_mcp_dependency_check_success",
      "servicenow_mcp_dependency_check_duration_ms",
      "servicenow_mcp_restarts_total",
    ]) {
      expect(metrics).toContain(name);
    }
    expect(runbook).toContain("There is no application `/metrics` endpoint");
    expect(runbook).toMatch(/Do not add a public scrape\s+endpoint/u);
    expect(metrics).toMatch(/Do not\s+use `correlationId`/u);
  });

  it("covers availability, latency, rejection, upstream, and telemetry-loss alerts", () => {
    const alerts = section("### Initial alerts", "### Dashboard layout");
    for (const signal of [
      "Liveness",
      "Readiness",
      "Availability",
      "Latency",
      "Authentication rejection",
      "Rate rejection",
      "Saturation",
      "Upstream failure",
      "Credential/ACL failure",
      "Internal tool failure",
      "Dependency synthetic",
      "Telemetry loss",
      "Certificate expiry",
    ]) {
      expect(alerts).toContain(`| ${signal} |`);
    }
    expect(alerts).toContain("percentage and a minimum count");
  });

  it("documents every safe structured event field and telemetry backpressure", () => {
    for (const field of [
      "schemaVersion",
      "observedAtMs",
      "latencyMs",
      "correlationId",
      "ownerIdHash",
      "clientIdHash",
      "outcome",
      "reason",
      "statusCode",
      "tool",
      "profile",
      "instance",
      "errorCategory",
      "retry",
      "retryAfterSeconds",
    ]) {
      expect(runbook).toContain(`\`${field}\``);
    }
    expect(runbook).toContain('{"type":"telemetry_dropped","count":N}');
    expect(runbook).toContain("at most 256 lines are pending");
  });

  it("covers deploy, rollback, rotation, rate tuning, incidents, and recovery", () => {
    for (const heading of [
      "## Deployment procedure",
      "## Rollback procedure",
      "## Credential and key rotation",
      "### ServiceNow credential or secret reference",
      "### Profile encryption key",
      "### MCP bearer token",
      "## Rate-limit and capacity tuning",
      "## Incident response",
      "## Recovery verification checklist",
    ]) {
      expect(runbook).toContain(heading);
    }
    expect(runbook).toContain(`greater than \`MCP_SHUTDOWN_GRACE_MS\``);
    expect(DEFAULT_SHUTDOWN_GRACE_PERIOD_MS).toBe(10_000);
    expect(runbook).toContain("npm run container:validate");
    expect(runbook).toContain("two independent MCP clients");
    expect(runbook).toContain(
      "release tool manifest/contract (names, schemas, and annotations)"
    );
    expect(runbook).not.toContain("exactly 18 tools");
  });

  it("keeps rate guidance aligned with validated runtime bounds", () => {
    expect(MAX_RATE_LIMIT_CAPACITY).toBe(1_000_000);
    expect(MAX_RATE_LIMIT_PERIOD_MS).toBe(86_400_000);
    expect(MAX_RATE_LIMIT_ENTRIES).toBe(100_000);
    expect(runbook).toContain("240 requests per 60 seconds");
    expect(runbook).toContain("4096 retained sources");
    expect(runbook).toContain("120 requests per 60 seconds");
    expect(runbook).toMatch(/128\s+retained identities/u);
    expect(runbook).toContain("Buckets are process-local and reset on restart");
    expect(runbook).toMatch(/never enable forwarded\s+IP trust/u);
    for (const setting of [
      "MCP_PRE_AUTH_RATE_CAPACITY",
      "MCP_PRE_AUTH_RATE_REFILL_MS",
      "MCP_PRE_AUTH_RATE_MAX_ENTRIES",
      "MCP_IDENTITY_RATE_CAPACITY",
      "MCP_IDENTITY_RATE_REFILL_MS",
      "MCP_IDENTITY_RATE_MAX_ENTRIES",
      "MCP_MAX_CONCURRENT_REQUESTS",
      "MCP_MAX_CONNECTIONS",
    ]) {
      expect(runbook).toContain(`\`${setting}\``);
    }
    expect(runbook).toContain("1–1000000");
    expect(runbook).toContain("1–86400000 ms");
    expect(runbook).toContain("1–100000");
  });

  it("defines bounded retention and a least-privilege support allowlist", () => {
    const retention = section("### Retention and access", "## Deployment procedure");
    expect(retention).toContain("searchable for 14 days");
    expect(retention).toMatch(/delete it after\s+30 days/u);
    expect(retention).toContain("for 90 days");

    const support = section(
      "## Least-privilege support collection",
      "## Recovery verification checklist"
    );
    for (const forbidden of [
      "bearer tokens",
      "Authorization/cookie/API-key headers",
      "passwords",
      "OAuth secrets",
      "API keys",
      "encryption keys",
      "secret references",
      "ciphertext",
      "environment dumps",
      "profile/configuration files",
      "docker container",
      "request/response bodies",
      "attachments",
      "raw URLs",
      "ServiceNow record payloads",
    ]) {
      expect(support).toContain(forbidden);
    }
    expect(support).toContain("Omit `profile`, `instance`, `ownerIdHash`, and `clientIdHash`");
    expect(support).toContain("second authorized person inspect it");
    expect(support).toContain("delete it according to the retention");
  });

  it("forbids public exposure and unsafe health-check writes", () => {
    expect(runbook).toContain("does not authorize a public tunnel, public endpoint");
    expect(runbook).toContain("Do not create a public tunnel");
    expect(runbook).toContain("Never use a create, update, delete, batch execution, ATF");
    expect(runbook).toMatch(
      /It performs no\s+ServiceNow write and does not create an external deployment/u
    );
  });
});
