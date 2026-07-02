import { describe, expect, it, vi } from "vitest";
import {
  executeTool,
  getToolDefinitions,
  profileTools,
  tools,
} from "../src/tools/index.js";
import type { ProfileManager } from "../src/profile-manager.js";
import type { ServiceNowConfig } from "../src/config.js";
import { DEFAULT_FIELDS } from "../src/table-defaults.js";

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

describe("tool annotations", () => {
  const definitions = getToolDefinitions();

  /** Names of tools whose annotations declare a given boolean hint value. */
  function namesWhere(
    hint: "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint",
    value: boolean
  ): string[] {
    return definitions
      .filter((d) => d.annotations[hint] === value)
      .map((d) => d.name)
      .sort();
  }

  it("gives every tool a complete annotations object (all five hints defined)", () => {
    for (const def of definitions) {
      expect(def.annotations, def.name).toBeTypeOf("object");
      expect(typeof def.annotations.title, `${def.name} title`).toBe("string");
      expect(def.annotations.title.length, `${def.name} title`).toBeGreaterThan(0);
      expect(typeof def.annotations.readOnlyHint, `${def.name} readOnlyHint`).toBe("boolean");
      expect(typeof def.annotations.destructiveHint, `${def.name} destructiveHint`).toBe("boolean");
      expect(typeof def.annotations.idempotentHint, `${def.name} idempotentHint`).toBe("boolean");
      expect(typeof def.annotations.openWorldHint, `${def.name} openWorldHint`).toBe("boolean");
    }
  });

  it("gives every tool a human-friendly display title distinct from its name", () => {
    const titles = definitions.map((d) => d.annotations.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const def of definitions) {
      expect(def.annotations.title, def.name).not.toMatch(/^sn_/);
    }
  });

  it("marks exactly the pure-GET tools as read-only", () => {
    expect(namesWhere("readOnlyHint", true)).toEqual(
      [
        "sn_aggregate",
        "sn_codesearch",
        "sn_discover",
        "sn_get",
        "sn_health",
        "sn_query",
        "sn_relationships",
        "sn_schema",
        "sn_syslog",
      ].sort()
    );
  });

  it("marks exactly delete, batch, script, and nl as destructive", () => {
    // sn_nl is destructive because its BATCH intent executes PATCH/DELETE
    // against matching records when execute+confirm(+force) are set.
    expect(namesWhere("destructiveHint", true)).toEqual(
      ["sn_batch", "sn_delete", "sn_nl", "sn_script"].sort()
    );
  });

  it("never marks a read-only tool as destructive", () => {
    for (const def of definitions) {
      if (def.annotations.readOnlyHint) {
        expect(def.annotations.destructiveHint, def.name).toBe(false);
      }
    }
  });

  it("marks sn_atf as mutating (it executes tests) but not destructive", () => {
    const atf = definitions.find((d) => d.name === "sn_atf")!;
    expect(atf.annotations.readOnlyHint).toBe(false);
    expect(atf.annotations.destructiveHint).toBe(false);
  });

  it("marks only sn_profile as closed-world (mutates local config, no instance calls)", () => {
    expect(namesWhere("openWorldHint", false)).toEqual(["sn_profile"]);
    const profileDef = definitions.find((d) => d.name === "sn_profile")!;
    expect(profileDef.annotations.readOnlyHint).toBe(false);
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
      getWithMeta: vi.fn(async () => ({
        data: { result: [{ sys_id: "abc123" }] },
        status: 200,
        headers: new Headers(),
      })),
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
    expect(fakeClient.getWithMeta).toHaveBeenCalledWith("/api/now/table/incident", {
      sysparm_exclude_reference_link: "true",
      sysparm_fields: DEFAULT_FIELDS.incident,
      sysparm_limit: "20",
      sysparm_display_value: "true",
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      record_count: 1,
      has_more: false,
      results: [{ sys_id: "abc123" }],
    });
  });
});
