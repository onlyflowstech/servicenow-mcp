import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guidePath = resolve(
  repositoryRoot,
  "docs/PRIVATE-CHATGPT-CONNECTIVITY.md"
);
const guide = readFileSync(guidePath, "utf8");
const readme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8")
) as {
  readonly files?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
};

function section(start: string, end: string): string {
  const from = guide.indexOf(start);
  const to = guide.indexOf(end, from + start.length);
  expect(from, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing section ${end}`).toBeGreaterThan(from);
  return guide.slice(from, to);
}

function sourceText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return [sourceText(path)];
      return extname(entry.name) === ".ts" ? [readFileSync(path, "utf8")] : [];
    })
    .join("\n");
}

describe("SNSDK-42 private ChatGPT connectivity guide", () => {
  it("ships and links the provider-adapter guide", () => {
    expect(packageJson.files).toContain(
      "docs/PRIVATE-CHATGPT-CONNECTIVITY.md"
    );
    expect(readme).toContain(
      "[Private ChatGPT connectivity](docs/PRIVATE-CHATGPT-CONNECTIVITY.md)"
    );
    const repositoryLinks = [...guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
      .map((match) => match[1])
      .filter((target) => !target.includes(":"))
      // A link may carry a fragment; resolve the document, not the anchor.
      .map((target) => target.split("#")[0])
      .filter((target) => target !== "");
    for (const target of repositoryLinks) {
      expect(existsSync(resolve(dirname(guidePath), target))).toBe(true);
    }
  });

  it("anchors setup in the current primary OpenAI sources", () => {
    for (const url of [
      "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
      "https://github.com/openai/tunnel-client/blob/master/docs/configuration.md",
      "https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta",
      "https://platform.openai.com/settings/organization/tunnels",
      "https://github.com/openai/tunnel-client/releases/latest",
    ]) {
      expect(guide).toContain(url);
    }
    expect(guide).toContain("Review the current versions before every live validation");
  });

  it("defines the exact permission, workspace, and network gates", () => {
    const permissions = section(
      "## Preconditions and permissions",
      "## Network requirements"
    );
    expect(permissions).toContain("Tunnels **Read + Manage**");
    expect(permissions).toContain("Tunnels **Read + Use**");
    expect(permissions).toContain("Platform organization level");
    expect(permissions).toContain("Connected Data/developer-mode permission");
    expect(permissions).toContain("Settings → Apps → Advanced Settings");
    expect(permissions).toContain("exact Platform organization and target");
    expect(permissions).toContain("read and write actions");

    const network = section("## Network requirements", "## Prepare the private MCP server");
    expect(network).toContain("api.openai.com:443");
    expect(network).toContain("mtls.api.openai.com:443");
    expect(network).toContain("/v1/tunnel/*");
    expect(network).toContain("http://127.0.0.1:3000/mcp");
    expect(network).toContain("requires no new inbound internet rule");
    expect(network).toContain("Do not use");
    expect(network).toContain("--allow-remote-ui");
  });

  it("uses secret-backed scoped MCP authorization with conflict checks", () => {
    const profile = section(
      "## Create the secret-backed adapter profile",
      "## Doctor and run"
    );
    expect(profile).toContain("mcp.extra_headers");
    expect(guide).toContain("--mcp.extra-headers");
    expect(guide).toContain("MCP_EXTRA_HEADERS");
    expect(profile).toContain("Authorization: env:MCP_BEARER_TOKEN");
    expect(profile).toContain("only to the configured MCP origin");
    expect(profile).toContain("Connector-forwarded headers are applied last");
    expect(profile).toMatch(/override static headers\s+case-insensitively/u);
    expect(profile).toContain("never silently allow a connector header");
    expect(profile).not.toMatch(/Authorization:\s+Bearer\s+(?:sk-|[A-Za-z0-9_-]{16})/u);
    expect(guide).not.toContain('CONTROL_PLANE_API_KEY="sk-');
    expect(profile).toContain("or enable `--log.http-raw-unsafe`");
  });

  it("pins version verification, init, doctor, run, and ChatGPT draft setup", () => {
    for (const command of [
      "tunnel-client --version",
      "tunnel-client help quickstart",
      "tunnel-client profiles samples list",
      "tunnel-client init",
      "tunnel-client doctor --profile servicenow-mcp-private --explain",
      "tunnel-client run --profile servicenow-mcp-private",
    ]) {
      expect(guide).toContain(command);
    }
    expect(guide).toMatch(/If any\s+required option is absent, stop/u);
    const chatgpt = section(
      "## Create the ChatGPT developer-mode app",
      "## Live validation and redacted evidence"
    );
    expect(chatgpt).toContain("Choose **Tunnel** under **Connection**");
    expect(chatgpt).toContain("Select **Scan Tools**");
    expect(chatgpt).toContain("names, input/output schemas, and annotations");
    expect(chatgpt).not.toContain("exactly 18 tools");
    expect(chatgpt).toContain("Do not publish");
  });

  it("requires live evidence for every SNSDK-42 acceptance path", () => {
    const evidence = section(
      "## Live validation and redacted evidence",
      "## Teardown and rollback"
    );
    for (const row of [
      "| Private path |",
      "| Initialization and discovery |",
      "| Required-profile rejection |",
      "| Representative read |",
      "| Controlled write |",
      "| Result and audit binding |",
      "| Provider-neutral second client |",
      "| Teardown and decoupling |",
    ]) {
      expect(evidence).toContain(row);
    }
    expect(evidence).toContain("**PASS**, **FAIL**, or **BLOCKED**");
    expect(evidence).toContain("sn_query");
    expect(evidence).toContain("sn_incident_add_comment");
    expect(evidence).toContain("sn_incident_add_work_note");
    expect(evidence).toContain("npm run container:validate");
    expect(evidence).toContain("official MCP SDK and independent JSON-RPC Fetch client");
    expect(evidence).toContain("second authorized reviewer");
  });

  it("keeps evidence redacted and the live blocker explicit", () => {
    expect(guide).toContain("not live-validation evidence");
    expect(guide).toContain("remains blocked on an authorized private live run");
    for (const forbidden of [
      "CONTROL_PLANE_API_KEY",
      "MCP_BEARER_TOKEN",
      "ServiceNow credentials",
      "Authorization",
      "raw environment/config/profile files",
      "tunnel IDs",
      "organization/workspace IDs or names",
      "prompts",
      "journal text",
      "sys_ids",
      "raw HTTP logs",
    ]) {
      expect(guide).toContain(forbidden);
    }
    expect(guide).toContain("Use approved aliases, hashes produced for this evidence purpose");
  });

  it("defines teardown and forbids public or core coupling", () => {
    const teardown = section("## Teardown and rollback", "The tunnel is not a public-submission mechanism");
    for (const action of [
      "disable or delete the private draft app",
      "Stop `tunnel-client`",
      "Revoke the dedicated control-plane runtime API key",
      "no inbound/public listener",
      "Re-run the provider-neutral local client/container validation",
    ]) {
      expect(teardown).toContain(action);
    }
    expect(teardown).toMatch(
      /removes the temporary\s+organization\/workspace association/u
    );
    expect(guide).toMatch(/must never create\s+or claim a public endpoint/u);
    expect(guide).toContain("No file under `src/`");
    expect(packageJson.dependencies).not.toHaveProperty("tunnel-client");
    expect(sourceText(resolve(repositoryRoot, "src"))).not.toMatch(
      /tunnel-client|Secure MCP Tunnel|chatgpt\.com/iu
    );
  });
});
