import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const boundaryPath = resolve(
  repositoryRoot,
  "docs/ENTERPRISE-RELEASE-BOUNDARY.md"
);
const boundary = readFileSync(boundaryPath, "utf8");
const roadmap = readFileSync(
  resolve(repositoryRoot, "docs/MODERNIZATION-ROADMAP.md"),
  "utf8"
);
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8")
) as {
  readonly files?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
};

function sourceText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return [sourceText(path)];
      return extname(entry.name) === ".ts" ? [readFileSync(path, "utf8")] : [];
    })
    .join("\n");
}

describe("SNSDK-43 enterprise release boundary", () => {
  it("ships the boundary and links it from the approved modernization scope", () => {
    expect(packageJson.files).toContain(
      "docs/ENTERPRISE-RELEASE-BOUNDARY.md"
    );
    expect(roadmap).toContain(
      "[V2 and future enterprise release boundary](ENTERPRISE-RELEASE-BOUNDARY.md)"
    );
  });

  it("makes enterprise unknowns non-blocking for the single-owner V2 release", () => {
    expect(boundary).toContain("private, single-owner developer service");
    expect(boundary).toContain("independently releasable");
    expect(boundary).toContain(
      "Undecided enterprise requirements do not block a V2 implementation"
    );
    expect(boundary).toContain(
      "must not acquire an enterprise dependency or be held open"
    );
    expect(boundary).toContain("not\nrequired for release");
  });

  it("excludes every enterprise capability required by SNSDK-43", () => {
    for (const excluded of [
      "| Shared deployments |",
      "| User and group administration |",
      "| RBAC and per-profile access control |",
      "| Tenant isolation |",
      "| Delegated ServiceNow identity |",
      "| Compliance administration |",
      "| Public distribution |",
    ]) {
      expect(boundary).toContain(excluded);
    }
    expect(boundary).toContain("Multiple ServiceNow profiles are routing targets, not tenants");
    expect(boundary).toContain("does not impersonate or delegate");
  });

  it("requires a separate multi-user authorization design for public ChatGPT", () => {
    expect(boundary).toContain("authenticated **public ChatGPT** offering");
    expect(boundary).toContain(
      "separately designed multi-user\nauthorization/OAuth architecture"
    );
    expect(boundary).toContain("token lifecycle, consent and revocation model");
    expect(boundary).toContain("not implicit in V2");
  });

  it("identifies only concrete existing V2 seams and their non-enterprise meaning", () => {
    for (const seam of [
      "Request owner/client authentication",
      "Explicit request/profile context",
      "Policy-provider boundary",
      "Secret references",
      "Provider-neutral MCP construction",
    ]) {
      expect(boundary).toContain(`| [${seam}]`);
    }
    for (const target of [
      "../src/http-auth.ts",
      "../src/execution-context.ts",
      "../src/profile-credentials.ts",
      "../src/server.ts",
    ]) {
      expect(existsSync(resolve(dirname(boundaryPath), target))).toBe(true);
    }
    expect(boundary).toContain("none is an enterprise feature");
    expect(boundary).toContain("does **not** authorize new tenant");
  });

  it("keeps future planning and commitments outside the V2 gate", () => {
    expect(boundary).toContain("may seed its own PRD");
    expect(boundary).toContain("It is not\nthat PRD");
    expect(boundary).toContain(
      "No enterprise estimate, milestone, acceptance\ncriterion, funding promise, or delivery date belongs in the V2 roadmap"
    );
    expect(boundary).not.toMatch(/\b(?:Q[1-4]|20\d{2}-\d{2}-\d{2}|sprint\s+\d+)\b/iu);
  });

  it("adds no enterprise runtime or dependency coupling", () => {
    expect(packageJson.dependencies).not.toHaveProperty("tunnel-client");
    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
      expect(dependency).not.toMatch(/(?:auth0|keycloak|openid|rbac|tenant)/iu);
    }
    const source = sourceText(resolve(repositoryRoot, "src"));
    expect(source).not.toContain("ENTERPRISE-RELEASE-BOUNDARY");
    expect(source).not.toMatch(
      /(?:interface|class|type)\s+(?:TenantContext|UserDirectory|RbacProvider|ComplianceAdministrator)\b/u
    );
  });
});
