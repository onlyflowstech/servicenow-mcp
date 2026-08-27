import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { VERSION } from "../src/version.js";
import { REGISTERED_TOOL_COUNT } from "../src/tools/index.js";

function readRoot(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf-8");
}

describe("VERSION single-sourcing", () => {
  const pkg = JSON.parse(readRoot("package.json"));

  it("matches the package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("keeps the package.json tool-count claim in sync with the registry", () => {
    expect(pkg.description).toContain(`${REGISTERED_TOOL_COUNT} tools`);
  });

  it("keeps the README tool-count claim in sync with the registry", () => {
    expect(readRoot("README.md")).toContain(`${REGISTERED_TOOL_COUNT} tools`);
  });
});
