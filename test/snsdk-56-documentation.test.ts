import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function fencedBlocks(markdown: string): readonly string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map(
    (match) => match[1]
  );
}

const publishedDocumentation = [
  "README.md",
  "docs/ADDING-TOOLS.md",
  "docs/CLIENT-SETUP.md",
  "docs/CONTAINER-DEPLOYMENT.md",
  "docs/CROSS-CLIENT-RELEASE-MATRIX.md",
  "docs/ENTERPRISE-RELEASE-BOUNDARY.md",
  "docs/OPERATIONS-RUNBOOK.md",
  "docs/PRIVATE-CHATGPT-CONNECTIVITY.md",
  "docs/PRODUCTION-SECURITY.md",
  "docs/PROFILE-CREDENTIALS.md",
  "docs/TESTING-OAUTH.md",
  "docs/V2-MIGRATION.md",
] as const;

describe("SNSDK-56 documentation contract", () => {
  it("ships a fail-closed non-secret environment inventory", () => {
    const example = read(".env.example");
    for (const secret of [
      "SN_PASSWORD",
      "SN_CLIENT_SECRET",
      "SN_API_KEY",
      "SN_PROFILE_ENCRYPTION_KEY",
    ]) {
      expect(example, secret).toMatch(new RegExp(`^${secret}=$`, "mu"));
      expect(example, secret).not.toMatch(new RegExp(`^${secret}=.+$`, "mu"));
    }

    // Nothing about a listener belongs in the inventory any more: there is no
    // bind address, port, allowlist, or bearer to configure, and a reader who
    // finds one here would configure something that is never read.
    for (const absent of [
      "MCP_BEARER_TOKEN",
      "MCP_HOST",
      "MCP_PORT",
      "MCP_ALLOWED_HOSTS",
      "MCP_MAX_CONCURRENT_REQUESTS",
      "MCP_SHUTDOWN_GRACE_MS",
    ]) {
      expect(example, absent).not.toContain(absent);
    }

    // It says what the transport is, and where the server actually reads this
    // configuration from when a client spawns it.
    expect(example).toContain("The transport is stdio");
    expect(example).toContain("~/.servicenow-mcp/server.env");
    expect(example).toMatch(/^MCP_OWNER_ID=example-owner$/mu);
    expect(example).toMatch(/^MCP_CLIENT_ID=example-client$/mu);

    expect(example).toContain("supervisor, orchestrator, OS keychain, or secret manager");
    expect(example).toContain("SN_PROFILE_NAME=example-dev");
    expect(example).toContain("SN_INSTANCE=https://example.invalid");
    expect(example.match(/^SN_PROFILE_NAME=/gmu)).toHaveLength(1);
    expect(example).toContain("SN_ALLOWED_WRITE_TABLES=");
    expect(example).not.toMatch(/^SN_ALLOWED_WRITE_TABLES=.+$/mu);
    expect(example).not.toMatch(/^MCP_ALLOWED_ORIGINS=/mu);
    expect(example).not.toMatch(/^SN_ENCODED_QUERY_READ_POLICY=/mu);
    expect(example).not.toContain("CONTROL_PLANE_API_KEY=");
    expect(example).not.toMatch(/SN_(?:PASSWORD|CLIENT_SECRET|API_KEY)_(?:DEV|STAGING)=/u);
    expect(example).not.toContain("default_profile");
  });

  it("documents the complete provider-neutral service and profile lifecycle", () => {
    const guide = read("docs/CLIENT-SETUP.md");
    for (const evidence of [
      "http://127.0.0.1:3000/mcp",
      "MCP_BEARER_TOKEN",
      "operator-managed TLS boundary",
      "On SIGINT",
      "or SIGTERM",
      "no default",
      "active",
      "switch-profile",
      "--name dev",
      "--source reference",
      "--name staging",
      "--source encrypted",
      "separate from the profile file",
      "Rotation, backup, and recovery",
      "matching key",
      "version separately",
      "official MCP SDK",
      "independent Fetch JSON-RPC",
      "structuredContent.profile",
      "bounded audit events",
      "sn_incident_add_comment",
      "Table access is deny-by-default",
      // Renamed from "Optional AI-platform setup paths" for 2.0: the section
      // now documents all six supported clients rather than optional extras.
      "MCP client configuration",
      "no stdio fallback",
      "provider-neutral module contract",
    ]) {
      expect(guide, evidence).toContain(evidence);
    }

    for (const related of [
      "CONTAINER-DEPLOYMENT.md",
      "OPERATIONS-RUNBOOK.md",
      "PRODUCTION-SECURITY.md",
      "PROFILE-CREDENTIALS.md",
      "TESTING-OAUTH.md",
      "V2-MIGRATION.md",
      "PRIVATE-CHATGPT-CONNECTIVITY.md",
      "CROSS-CLIENT-RELEASE-MATRIX.md",
      "ADDING-TOOLS.md",
    ]) {
      expect(guide, related).toContain(related);
    }
  });

  it("uses one endpoint and an explicit profile in every client tool example", () => {
    const guide = read("docs/CLIENT-SETUP.md");
    expect(guide.match(/process\.env\.MCP_URL/gu)).toHaveLength(2);
    expect(guide.match(/process\.env\.MCP_BEARER_TOKEN/gu)).toHaveLength(2);
    expect(guide.match(/process\.env\.MCP_PROFILE/gu)).toHaveLength(2);

    const toolExamples = [...guide.matchAll(/name:\s*"(sn_[a-z0-9_]+)"/gu)];
    expect(toolExamples).toHaveLength(5);
    for (const match of toolExamples) {
      const following = guide.slice(match.index, match.index + 360);
      expect(following, match[1]).toMatch(/arguments:\s*\{[\s\S]*?\bprofile(?:\s*:|\s*,)/u);
    }

    const fetchCalls = [...guide.matchAll(/rpc\("tools\/call",\s*\{([\s\S]*?)\n\}\);/gu)];
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0][1]).toMatch(/arguments:\s*\{[\s\S]*?\bprofile\s*,/u);

    expect(guide).toContain('profile: "dev"');
    expect(guide).toContain('profile: "staging"');
    expect(guide).toContain('devResult.structuredContent.profile === "dev"');
    expect(guide).toContain('stagingResult.structuredContent.profile === "staging"');
  });

  it("names the boundary a spawned server actually has", () => {
    const readme = read("README.md");
    // Not "it's local, so it's fine": the sentence has to say who is inside
    // the boundary, which under stdio is every client that can spawn it.
    expect(readme).toContain("**The server runs as you, and the client list is the boundary.**");
    expect(readme).toContain("every MCP client\n> registered here can spawn the server");
    expect(readme).toContain("claude mcp remove servicenow-mcp");
    expect(readme).toContain("No ServiceNow credential is copied into a");

    // The variable table is where an integrator looks first. It must not still
    // advertise a listener's settings.
    expect(readme).toMatch(/\| `MCP_OWNER_ID` \| ❌ \| `local-owner` \|/u);
    expect(readme).toMatch(/\| `MCP_CLIENT_ID` \| ❌ \| `local-client` \|/u);
    expect(readme).not.toMatch(/\| `MCP_BEARER_TOKEN` \|/u);
    expect(readme).not.toMatch(/\| `MCP_HOST` \|/u);
    expect(readme).not.toMatch(/\| `MCP_PORT` \|/u);
    // And it must name the fallback that makes a spawned server work at all.
    expect(readme).toContain("~/.servicenow-mcp/server.env");
  });

  /**
   * The HTTP-shaped operator guides have not been rewritten for stdio yet.
   * Each one must therefore say so at the top, so a reader cannot follow a
   * procedure that no longer has anything to act on.
   */
  it("marks every still-HTTP guide as describing the dormant transport", () => {
    for (const path of [
      "docs/CLIENT-SETUP.md",
      "docs/PRODUCTION-SECURITY.md",
      "docs/OPERATIONS-RUNBOOK.md",
      "docs/PRIVATE-CHATGPT-CONNECTIVITY.md",
      "docs/CONTAINER-DEPLOYMENT.md",
    ]) {
      const guide = read(path);
      expect(guide, path).toContain(
        "**This document describes the dormant HTTP transport, not the shipped one.**"
      );
      expect(guide, path).toContain(
        "ENTERPRISE-RELEASE-BOUNDARY.md#the-dormant-http-transport"
      );
      // The banner belongs above the content it qualifies.
      expect(guide.indexOf("dormant HTTP transport"), path).toBeLessThan(400);
    }
  });

  it("still tells the setup reader what the opt-in HTTP bearer would do", () => {
    const guide = read("docs/CLIENT-SETUP.md");
    expect(guide).toContain("### Authentication is opt-in");
    expect(guide).toContain("**The endpoint is unauthenticated by default**");
    // Names the threat it does not cover, rather than only the ones it does.
    expect(guide).toContain("It is not safe against other software running as");
    expect(guide).toContain("Authorization: Bearer <the MCP_BEARER_TOKEN value>");
    // The bootstrap inventory must no longer promise files it stopped writing.
    expect(guide).not.toContain("| `~/.servicenow-mcp/client.env` |");
    expect(guide).not.toContain("| `~/.servicenow-mcp/client-headers.txt` |");
  });

  it("warns the deployment guides that the boundary they assume is opt-in", () => {
    // Each of these paths still uses a bearer, and each is now responsible for
    // saying that the service will not insist on one.
    expect(read("docs/CONTAINER-DEPLOYMENT.md")).toContain(
      "**`MCP_BEARER_TOKEN` is required for a container deployment, but the process"
    );
    expect(read("docs/PRIVATE-CHATGPT-CONNECTIVITY.md")).toContain(
      "HTTP authentication is opt-in as of 2.0"
    );
    expect(read("docs/OPERATIONS-RUNBOOK.md")).toContain(
      "**Unsetting `MCP_BEARER_TOKEN` does not revoke access — it removes the check.**"
    );
    expect(read("docs/TESTING-OAUTH.md")).toContain(
      "the rejection checks\nbelow cannot fire"
    );
    expect(read("docs/V2-MIGRATION.md")).toContain(
      "The `/mcp` endpoint is unauthenticated unless you set `MCP_BEARER_TOKEN`."
    );
  });

  it("keeps ChatGPT and Claude Code optional, secret-backed, and explicit-profile", () => {
    const guide = read("docs/CLIENT-SETUP.md");
    expect(guide).toContain("ChatGPT developer-mode app through Secure MCP Tunnel");
    expect(guide).toContain("https://chatgpt.com/plugins");
    expect(guide).toContain("https://developers.openai.com/api/docs/guides/secure-mcp-tunnels");
    expect(guide).toContain("env:MCP_BEARER_TOKEN");
    expect(guide).toContain('profile: "staging"');

    expect(guide).toContain("Claude Code over Streamable HTTP");
    expect(guide).toContain('"type": "http"');
    expect(guide).toContain('"url": "${SERVICENOW_MCP_URL}"');
    // Client config must reference the CLIENT-side variable. `MCP_BEARER_TOKEN`
    // lives in server.env beside SN_PROFILE_ENCRYPTION_KEY; setup writes the
    // client copy as SERVICENOW_MCP_BEARER_TOKEN (src/setup.ts:145,218).
    // Documenting the server name here set an unset variable client-side and
    // invited users to source server.env — leaking the encryption key.
    expect(guide).toContain(
      '"Authorization": "Bearer ${SERVICENOW_MCP_BEARER_TOKEN}"'
    );
    expect(guide).toContain("https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson");
    expect(guide).toContain(
      "logs a warning and leaves the `${VAR}` placeholder unexpanded"
    );
    expect(guide).toContain("the MCP configuration still loads");
    expect(guide).not.toContain(
      "fails configuration expansion when a required variable is absent"
    );
    expect(guide).toContain('profile: "dev"');
    expect(guide).toContain("same reviewed `/mcp` origin used by");
    expect(guide).toContain("must not redefine the core server");
  });

  it("documents the exact opt-in OAuth smoke write sequence", () => {
    const oauthGuide = read("docs/TESTING-OAUTH.md");
    expect(oauthGuide).toContain(
      "create / incident work-note append / delete round trip"
    );
    expect(oauthGuide).not.toContain("create/update/delete round trip");

    const smokeClient = read("scripts/smoke-test.mjs");
    const writeRoundTrip = smokeClient.match(
      /async function writeRoundTrip\([\s\S]*?\n\}\n\nasync function call/u
    )?.[0];
    expect(writeRoundTrip).toBeDefined();
    expect(
      [...(writeRoundTrip ?? "").matchAll(/await call\(client, "(sn_[a-z0-9_]+)"/gu)].map(
        (match) => match[1]
      )
    ).toEqual(["sn_create", "sn_incident_add_work_note", "sn_delete"]);
  });

  it("never puts protected values or references in tool or CLI arguments", () => {
    const guide = read("docs/CLIENT-SETUP.md");
    const code = fencedBlocks(guide).join("\n");
    for (const forbidden of [
      "--password",
      "--credential",
      "--client-secret",
      "--api-key",
      "--reference",
      "SN_PROFILE_ENCRYPTION_KEY=",
      "SN_CLIENT_SECRET=",
      "SN_PASSWORD=",
      "MCP_BEARER_TOKEN=",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).not.toMatch(/arguments:\s*\{[\s\S]{0,300}(?:password|credential|clientSecret|apiKey|encryptionKey)\s*:/u);
  });

  it("keeps every published fenced block free of live secrets and secret argv", () => {
    const secretAssignment = /^\s*(?:export\s+)?(MCP_BEARER_TOKEN|SN_PASSWORD(?:_[A-Z0-9_]+)?|SN_CLIENT_SECRET(?:_[A-Z0-9_]+)?|SN_API_KEY(?:_[A-Z0-9_]+)?|SN_PROFILE_ENCRYPTION_KEY|CONTROL_PLANE_API_KEY)\s*=\s*(.*?)\s*$/gmu;
    for (const path of publishedDocumentation) {
      const code = fencedBlocks(read(path)).join("\n");
      for (const match of code.matchAll(secretAssignment)) {
        const value = match[2].replace(/^['"]|['"]$/gu, "");
        const safePlaceholder =
          value.length === 0 ||
          /^<[^>\r\n]+>$/u.test(value) ||
          /^env:[A-Z][A-Z0-9_]*$/u.test(value) ||
          /^\$\{[A-Z][A-Z0-9_]*\}$/u.test(value);
        expect(safePlaceholder, `${path}: ${match[1]} must be injected`).toBe(true);
      }
      expect(code, path).not.toMatch(/--(?:password|credential|client-secret|api-key|reference)(?:\s|=)/u);
      expect(code, path).not.toMatch(/Authorization[^\n]*Bearer\s+(?:sk-|[A-Za-z0-9_-]{24,})/u);
    }
  });

  it("connects the focused guide to existing migration and credential contracts", () => {
    const credentials = read("docs/PROFILE-CREDENTIALS.md");
    expect(credentials).toContain("Two-profile isolation and recovery");
    expect(credentials).toContain("CLIENT-SETUP.md");
    expect(credentials).toContain("separate approved key system");
    expect(credentials).toContain("Back up only the owner-only encrypted/reference profile file");
    expect(credentials).toContain("Never serve mixed envelopes");

    expect(read("docs/V2-MIGRATION.md")).toContain("CLIENT-SETUP.md");
    expect(read("docs/CROSS-CLIENT-RELEASE-MATRIX.md")).toContain("CLIENT-SETUP.md");

    const readme = read("README.md");
    expect(readme).toContain("[`.env.example`](.env.example)");
    expect(readme).toContain("docs/CLIENT-SETUP.md");
    expect(readme).toContain("no prior call creates default, active, or switch-profile state");
    for (const profile of ['profile: "dev"', 'profile: "staging"', 'profile: "prod"']) {
      expect(readme).toContain(profile);
    }
  });

  it("includes the safe examples in the published package contract", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      readonly files: readonly string[];
    };
    expect(packageJson.files).toContain(".env.example");
    for (const guide of [
      "docs/ADDING-TOOLS.md",
      "docs/CLIENT-SETUP.md",
      "docs/PRODUCTION-SECURITY.md",
      "docs/TESTING-OAUTH.md",
    ]) {
      expect(packageJson.files).toContain(guide);
    }
    for (const path of publishedDocumentation.filter((path) => path !== "README.md")) {
      expect(packageJson.files).toContain(path);
    }
  });
});
