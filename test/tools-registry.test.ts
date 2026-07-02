import { describe, expect, it, vi } from "vitest";
import {
  executeTool,
  getToolDefinitions,
  profileTools,
  tools,
} from "../src/tools/index.js";
import type { ProfileManager } from "../src/profile-manager.js";
import type { ServiceNowConfig } from "../src/config.js";

/**
 * A ProfileManager stub that fails loudly if the registry touches it.
 * Unknown-tool and invalid-argument paths must never resolve a profile.
 */
function untouchableProfileManager(): ProfileManager {
  return {
    getClient: vi.fn(() => {
      throw new Error("getClient must not be called");
    }),
    getConfig: vi.fn(() => {
      throw new Error("getConfig must not be called");
    }),
  } as unknown as ProfileManager;
}

describe("getToolDefinitions", () => {
  const definitions = getToolDefinitions();

  it("returns one definition per registered tool module (18 total)", () => {
    expect(definitions).toHaveLength(tools.length + profileTools.length);
    expect(definitions).toHaveLength(18);
  });

  it("has a unique name for every definition", () => {
    const names = definitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every definition a name, description, and object inputSchema", () => {
    for (const def of definitions) {
      expect(def.name, JSON.stringify(def)).toMatch(/^sn_[a-z_]+$/);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema).toBeTypeOf("object");
      expect((def.inputSchema as Record<string, unknown>).type).toBe("object");
      expect((def.inputSchema as Record<string, unknown>).properties).toBeTypeOf("object");
    }
  });

  it("backs every tool module with a zod schema and a handler function", () => {
    for (const mod of [...tools, ...profileTools]) {
      expect(typeof mod.schema.safeParse).toBe("function");
      expect(typeof mod.handler).toBe("function");
    }
  });
});

describe("executeTool", () => {
  it("returns isError for an unknown tool without touching profiles", async () => {
    const pm = untouchableProfileManager();
    const result = await executeTool("sn_does_not_exist", {}, pm);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown tool: sn_does_not_exist");
    expect(pm.getClient).not.toHaveBeenCalled();
    expect(pm.getConfig).not.toHaveBeenCalled();
  });

  it("returns isError with field paths for invalid arguments", async () => {
    const pm = untouchableProfileManager();
    const result = await executeTool("sn_query", {}, pm);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid arguments");
    expect(result.content[0].text).toContain("table:");
    expect(pm.getClient).not.toHaveBeenCalled();
  });

  it("returns isError for wrongly-typed arguments", async () => {
    const pm = untouchableProfileManager();
    const result = await executeTool("sn_query", { table: "incident", limit: "20" }, pm);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid arguments");
    expect(result.content[0].text).toContain("limit:");
  });

  it("resolves the requested profile and strips it from handler args", async () => {
    const fakeClient = {
      get: vi.fn(async () => ({ result: [{ sys_id: "abc123" }] })),
    };
    const fakeConfig: ServiceNowConfig = {
      instance: "https://example.service-now.com",
      user: "tester",
      password: "placeholder-not-a-real-credential",
      displayValue: "true",
      relDepth: 3,
    };
    const pm = {
      getClient: vi.fn(() => fakeClient),
      getConfig: vi.fn(() => fakeConfig),
    } as unknown as ProfileManager;

    const result = await executeTool(
      "sn_query",
      { table: "incident", profile: "secondary" },
      pm
    );

    expect(pm.getClient).toHaveBeenCalledWith("secondary");
    expect(pm.getConfig).toHaveBeenCalledWith("secondary");
    expect(fakeClient.get).toHaveBeenCalledWith("/api/now/table/incident", {
      sysparm_limit: "20",
      sysparm_display_value: "true",
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      record_count: 1,
      results: [{ sys_id: "abc123" }],
    });
  });
});
