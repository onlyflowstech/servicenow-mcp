import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  INTERNAL_HEALTHCHECK_AUTHORITY,
  createHttpRequestPolicy,
} from "../src/http-request-policy.js";
import { instanceHostError } from "../src/profile-manager.js";

const root = new URL("../", import.meta.url);
const guide = readFileSync(new URL("docs/PRODUCTION-SECURITY.md", root), "utf8");
const runtimeSource = readFileSync(new URL("src/http-runtime.ts", root), "utf8");
const entrypointSource = readFileSync(new URL("src/index.ts", root), "utf8");
const profileSource = readFileSync(new URL("src/profile-manager.ts", root), "utf8");

const originalAllowedInstanceHosts = process.env.SN_ALLOWED_INSTANCE_HOSTS;

afterEach(() => {
  if (originalAllowedInstanceHosts === undefined) {
    delete process.env.SN_ALLOWED_INSTANCE_HOSTS;
  } else {
    process.env.SN_ALLOWED_INSTANCE_HOSTS = originalAllowedInstanceHosts;
  }
});

describe("SNSDK-40 production security documentation", () => {
  it("covers every production boundary and the explicit denied patterns", () => {
    for (const heading of [
      "## TLS termination",
      "## Reverse proxy and client identity contract",
      "### Exact `Host` behavior",
      "### Exact `Origin` behavior",
      "## Secret injection and storage",
      "### Rotation procedure",
      "## Network and DNS boundaries",
      "## Canonical deployment example",
      "## Denied exposure patterns",
    ]) {
      expect(guide).toContain(heading);
    }

    expect(guide).toMatch(/TLS 1\.2 or TLS 1\.3 only/u);
    expect(guide).toMatch(/no trusted-proxy mode/iu);
    expect(guide).toMatch(/direct TCP peer/iu);
    expect(guide).toMatch(/No installation command[\s\S]*creates a tunnel or public endpoint/u);
    expect(guide).toMatch(/default-deny ingress and egress/iu);
    expect(guide).toMatch(/cloud metadata/iu);
    expect(guide).toMatch(/does not promise live environment[\s\S]*file watching/iu);
  });

  it("uses canonical runtime names without embedding example secret values", () => {
    for (const name of [
      "SN_PROFILE_NAME",
      "SN_INSTANCE",
      "SN_AUTH_TYPE",
      "SN_GRANT_TYPE",
      "SN_CLIENT_ID",
      "SN_CLIENT_SECRET",
      "SN_PROFILE_ENCRYPTION_KEY",
      "SN_ALLOWED_INSTANCE_HOSTS",
      "SN_ALLOWED_READ_TABLES",
      "SN_ALLOWED_WRITE_TABLES",
      "SN_TABLE_ACCESS_TARGETS",
    ]) {
      expect(guide).toContain(name);
    }

    for (const assignment of [
      "MCP_BEARER_TOKEN=<runtime-secret:MCP_BEARER_TOKEN>",
      "SN_CLIENT_SECRET=<runtime-secret:SN_CLIENT_SECRET>",
      "SN_PROFILE_ENCRYPTION_KEY=<runtime-secret:SN_PROFILE_ENCRYPTION_KEY>",
    ]) {
      expect(guide).toContain(assignment);
    }
    expect(guide).not.toMatch(/(?:MCP_BEARER_TOKEN|SN_PASSWORD|SN_CLIENT_SECRET|SN_API_KEY)=(?:password|secret|token|changeme)/iu);
  });

  it("stays aligned with direct-peer and configured Host/Origin runtime behavior", () => {
    expect(runtimeSource).toContain("request.socket.remoteAddress");
    expect(runtimeSource).not.toMatch(/x-forwarded-for|x-real-ip|forwarded\s*:/iu);
    expect(entrypointSource).toContain('"MCP_ALLOWED_HOSTS"');
    expect(entrypointSource).toContain('"MCP_ALLOWED_ORIGINS"');

    const policy = createHttpRequestPolicy({
      allowedHosts: ["mcp.example.com:443"],
      allowedOrigins: ["https://approved-browser.example"],
    });
    const inspect = (
      rawHeaders: string[],
      remoteAddress = "192.0.2.10",
      pathname = "/mcp"
    ) =>
      policy.inspect({
        rawHeaders,
        method: "POST",
        pathname,
        configuredHost: "127.0.0.1",
        localAddress: "127.0.0.1",
        localPort: 3000,
        remoteAddress,
      });

    expect(
      inspect([
        "Host",
        "mcp.example.com:443",
        "Origin",
        "https://approved-browser.example",
        "Content-Type",
        "application/json",
      ])
    ).toMatchObject({ kind: "allow" });
    expect(inspect(["Host", "mcp.example.com"])).toMatchObject({
      kind: "reject",
      status: 421,
      reason: "disallowed_host",
    });
    expect(
      inspect([
        "Host",
        "mcp.example.com:443",
        "Origin",
        "https://attacker.example",
        "Content-Type",
        "application/json",
      ])
    ).toMatchObject({ kind: "reject", status: 403, reason: "disallowed_origin" });

    expect(
      inspect(
        [
          "Host",
          INTERNAL_HEALTHCHECK_AUTHORITY,
          "X-Forwarded-For",
          "127.0.0.1",
        ],
        "192.0.2.10",
        "/health/ready"
      )
    ).toMatchObject({ kind: "reject", status: 421, reason: "disallowed_host" });
  });

  it("distinguishes the runtime-added hostname gate from authoritative egress policy", () => {
    expect(profileSource).toContain('process.env.SN_ALLOWED_INSTANCE_HOSTS');
    expect(profileSource).toMatch(/Profiles hand-written into config\.json are not affected/u);
    expect(guide).toMatch(/runtime-added profiles only/iu);
    expect(guide).toMatch(/It is not a firewall/u);

    delete process.env.SN_ALLOWED_INSTANCE_HOSTS;
    expect(instanceHostError("https://acme.service-now.com")).toBeUndefined();
    expect(instanceHostError("https://snow.corp.example")).toMatch(
      /not a ServiceNow domain/u
    );
    process.env.SN_ALLOWED_INSTANCE_HOSTS = "snow.corp.example";
    expect(instanceHostError("https://snow.corp.example")).toBeUndefined();
  });
});
