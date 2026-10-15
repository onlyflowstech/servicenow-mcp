import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FieldPolicyConfigurationError,
  FieldPolicyError,
  fieldPolicyInputFromEnvironment,
  resolveReadableFields,
  runWithFieldPolicyConfiguration,
  validateFieldPolicyConfiguration,
  validateWritableFields,
  type FieldPolicyConfigurationInput,
} from "../src/field-policy.js";
import { ProfileManager, type Profile } from "../src/profile-manager.js";

/**
 * Field-policy configuration: wildcard spellings, load-time validation, and
 * the scope of SN_FIELD_POLICY_DEFINITIONS. Every ProfileManager here reads a
 * throwaway config path, never the host's ~/.servicenow-mcp.
 */

const ENV_KEYS = [
  "SN_PROFILE_NAME",
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH_TYPE",
  "SN_ALLOWED_READ_TABLES",
  "SN_ALLOWED_WRITE_TABLES",
  "SN_TABLE_ACCESS_TARGETS",
  "SN_FIELD_POLICY_DEFINITIONS",
] as const;

/** The README's read-only custom-table recipe for the variable. */
const README_READ_ONLY_POLICY = JSON.stringify({
  "*": { defaults: ["sys_id"], readable: "*", writable: [] },
});

let directory: string;
let configFilePath: string;

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "sn-field-policy-config-"));
  configFilePath = path.join(directory, "config.json");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeProfiles(profiles: Record<string, Record<string, unknown>>): void {
  fs.writeFileSync(
    configFilePath,
    JSON.stringify({
      version: 2,
      profiles: Object.fromEntries(
        Object.entries(profiles).map(([name, profile]) => [
          name,
          {
            instance: "https://config-test.service-now.com",
            username: "config-test-user",
            credential: "env:SN_PASSWORD",
            ...profile,
          },
        ])
      ),
    }),
    { encoding: "utf8", mode: 0o600 }
  );
}

function loadError(): Error {
  try {
    new ProfileManager({ configFilePath });
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected the profile configuration to be rejected");
}

/** The scoped object src/index.ts builds from a profile. */
function profileScope(profile: Profile): FieldPolicyConfigurationInput {
  return {
    ...(profile.fieldPolicy === undefined ? {} : { fieldPolicy: profile.fieldPolicy }),
    ...(profile.readableTableFields === undefined
      ? {}
      : { readableTableFields: profile.readableTableFields }),
    ...(profile.writableTableFields === undefined
      ? {}
      : { writableTableFields: profile.writableTableFields }),
  };
}

function policyReason(action: () => unknown): FieldPolicyError["reason"] | "allowed" {
  try {
    action();
    return "allowed";
  } catch (error) {
    if (error instanceof FieldPolicyError) return error.reason;
    throw error;
  }
}

describe('["*"] means "*" (#8)', () => {
  const customWrite = { u_custom: "v", state: "2" };

  it.each<[string, FieldPolicyConfigurationInput, FieldPolicyConfigurationInput]>([
    [
      "writableTableFields fields",
      { writableTableFields: [{ table: "change_request", fields: ["*"] }] },
      { writableTableFields: [{ table: "change_request", fields: "*" }] },
    ],
    [
      "fieldPolicy writable",
      { fieldPolicy: { change_request: { writable: ["*"] } } },
      { fieldPolicy: { change_request: { writable: "*" } } },
    ],
  ])("treats %s [\"*\"] exactly like \"*\"", (_label, arrayForm, stringForm) => {
    for (const configuration of [arrayForm, stringForm]) {
      expect(() => validateFieldPolicyConfiguration(configuration)).not.toThrow();
      runWithFieldPolicyConfiguration(configuration, () => {
        expect(validateWritableFields("change_request", customWrite)).toEqual(customWrite);
        // Pre-fix, the array form denied every call on the profile, reads and
        // unrelated tables included.
        expect(resolveReadableFields("change_request", { fields: "number" })).toEqual([
          "number",
        ]);
        expect(validateWritableFields("problem", { state: "2" })).toEqual({ state: "2" });
      });
    }
  });

  it("accepts [\"*\"] for readable and defaults too", () => {
    const configuration = {
      fieldPolicy: { u_custom: { defaults: ["*"], readable: ["*"], writable: ["*"] } },
    };
    expect(() => validateFieldPolicyConfiguration(configuration)).not.toThrow();
    runWithFieldPolicyConfiguration(configuration, () => {
      expect(resolveReadableFields("u_custom")).toEqual(["*"]);
      expect(resolveReadableFields("u_custom", { fields: "all" })).toEqual(["*"]);
      expect(validateWritableFields("u_custom", { u_anything: "v" })).toEqual({
        u_anything: "v",
      });
    });
  });

  it("does not widen a list that merely contains \"*\"", () => {
    for (const fields of [["*", "number"], ["*", "*"], [" * "]]) {
      runWithFieldPolicyConfiguration(
        { writableTableFields: [{ table: "change_request", fields }] },
        () => {
          expect(
            policyReason(() => validateWritableFields("change_request", { state: "2" })),
            JSON.stringify(fields)
          ).not.toBe("allowed");
        }
      );
      expect(() =>
        validateFieldPolicyConfiguration({
          writableTableFields: [{ table: "change_request", fields }],
        })
      ).toThrow(FieldPolicyConfigurationError);
    }
  });

  it("loads a profile that spells the wildcard as a list", () => {
    writeProfiles({
      listed: { writableTableFields: [{ table: "change_request", fields: ["*"] }] },
      mapped: { fieldPolicy: { change_request: { writable: ["*"] } } },
    });
    const manager = new ProfileManager({ configFilePath });

    for (const name of ["listed", "mapped"]) {
      runWithFieldPolicyConfiguration(profileScope(manager.getProfile(name)), () => {
        expect(validateWritableFields("change_request", customWrite)).toEqual(customWrite);
      });
    }
  });
});

describe("malformed field policy fails at profile load (#8)", () => {
  it('rejects writable ["u_*"] naming the table and the key', () => {
    writeProfiles({
      audit: { fieldPolicy: { u_audit: { writable: ["u_*"] } } },
    });

    const error = loadError();
    expect(error.message).toMatch(/^Profile configuration is invalid: /u);
    expect(error.message).toContain('profile "audit"');
    expect(error.message).toContain("fieldPolicy.u_audit.writable[0]");
    expect(error.message).toContain("is not a field name");
    expect(error.message).toContain('use "*" on its own');
  });

  it("rejects a writableTableFields pattern naming the entry and its table", () => {
    writeProfiles({
      change: { writableTableFields: [{ table: "change_request", fields: ["u_*"] }] },
    });

    const error = loadError();
    expect(error.message).toContain(
      'writableTableFields[0].fields[0] (table "change_request") is not a field name'
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a non-object fieldPolicy", { fieldPolicy: ["incident"] }, "fieldPolicy must be an object"],
    ["a non-object table entry", { fieldPolicy: { incident: "state" } }, "fieldPolicy.incident must be an object"],
    ["a non-list field set", { fieldPolicy: { incident: { writable: "state" } } }, 'fieldPolicy.incident.writable must be "*" or a list'],
    ["a repeated field", { fieldPolicy: { incident: { readable: ["number", "NUMBER"] } } }, 'fieldPolicy.incident.readable[1] repeats the field "number"'],
    ["an invalid table key", { fieldPolicy: { incident: {}, "bad table": {} } }, "fieldPolicy key 2 is not a valid table name"],
    [
      "defaults outside the readable set",
      { fieldPolicy: { incident: { defaults: ["caller_id"], readable: ["number"] } } },
      'fieldPolicy.incident.defaults lists "caller_id", which fieldPolicy.incident.readable does not allow',
    ],
    ["a non-list readableTableFields", { readableTableFields: { table: "incident" } }, "readableTableFields must be a list"],
    ["a list entry without a table", { readableTableFields: [{ fields: "*" }] }, "readableTableFields[0].table is not a valid table name"],
    ["a list entry that is not an object", { writableTableFields: ["incident"] }, "writableTableFields[0] must be an object with table and fields"],
    [
      "a shadowed fieldPolicy",
      {
        fieldPolicy: { u_audit: { writable: ["u_*"] } },
        writableTableFields: [{ table: "incident", fields: "*" }],
      },
      "fieldPolicy.u_audit.writable[0] is not a field name",
    ],
  ])("rejects %s", (_label, profile, expected) => {
    writeProfiles({ broken: profile });

    const error = loadError();
    expect(error.message).toContain('Profile configuration is invalid: profile "broken": ');
    expect(error.message).toContain(expected);
  });

  it("never repeats a rejected configured value", () => {
    writeProfiles({
      canary: {
        fieldPolicy: {
          "u_canary table": {},
        },
      },
      other: { writableTableFields: [{ table: "incident", fields: ["u_CANARY*"] }] },
    });
    expect(loadError().message.toLowerCase()).not.toContain("canary table");

    writeProfiles({
      other: { writableTableFields: [{ table: "incident", fields: ["u_CANARY*"] }] },
    });
    expect(loadError().message.toLowerCase()).not.toContain("canary");
  });

  it("rejects a malformed field policy on addProfile without persisting it", () => {
    const manager = new ProfileManager({ configFilePath });

    expect(() =>
      manager.addProfile("audit", {
        instance: "https://config-test.service-now.com",
        username: "config-test-user",
        credential: "env:SN_PASSWORD",
        fieldPolicy: { u_audit: { writable: ["u_*"] } },
      })
    ).toThrow(/fieldPolicy\.u_audit\.writable\[0\] is not a field name/u);
    expect(fs.existsSync(configFilePath)).toBe(false);
  });

  it("still loads every well-formed configuration form", () => {
    writeProfiles({
      none: {},
      mapped: {
        fieldPolicy: {
          "*": { defaults: ["sys_id"], readable: "*", writable: [] },
          incident: { readable: ["sys_id", "number"], writable: ["state"] },
          u_audit: { readable: [], writable: "*" },
        },
      },
      listed: {
        readableTableFields: [{ table: "incident", fields: ["sys_id", "number"] }],
        writableTableFields: [{ table: "*", fields: "*" }],
      },
    });

    const manager = new ProfileManager({ configFilePath });
    expect(manager.listProfiles().map(({ name }) => name).sort()).toEqual([
      "listed",
      "mapped",
      "none",
    ]);
  });

  it("accepts nothing the request path would then fail to normalize", () => {
    const accepted: FieldPolicyConfigurationInput[] = [
      {},
      { fieldPolicy: {} },
      { fieldPolicy: { incident: { readable: ["number"], writable: ["number"] } } },
      { fieldPolicy: { u_audit: { readable: [], writable: "*" } } },
      { readableTableFields: [], writableTableFields: [] },
      { writableTableFields: [{ table: "*", fields: ["*"] }] },
    ];
    for (const configuration of accepted) {
      validateFieldPolicyConfiguration(configuration);
      runWithFieldPolicyConfiguration(configuration, () => {
        expect(policyReason(() => validateWritableFields("change_request", { state: "2" })))
          .not.toBe("invalid_argument_shape");
        expect(policyReason(() => validateWritableFields("change_request", { state: "2" })))
          .not.toBe("invalid_field_selection");
      });
    }
  });
});

describe("SN_FIELD_POLICY_DEFINITIONS configures only the environment profile (#9)", () => {
  function environmentProfile(name = "env-profile"): void {
    vi.stubEnv("SN_PROFILE_NAME", name);
    vi.stubEnv("SN_INSTANCE", "https://env-profile.service-now.com");
    vi.stubEnv("SN_USER", "env-user");
  }

  it("leaves a profile with no field policy open on custom tables", () => {
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", README_READ_ONLY_POLICY);
    writeProfiles({ full: { tableAccess: { readTables: ["*"], writeTables: ["*"] } } });

    const manager = new ProfileManager({ configFilePath });
    const profile = manager.getProfile("full");
    expect(profile.fieldPolicy).toBeUndefined();

    runWithFieldPolicyConfiguration(profileScope(profile), () => {
      for (const table of ["u_custom", "change_task", "hr_case", "x_acme_app_table"]) {
        expect(validateWritableFields(table, { u_note: "x" }), table).toEqual({
          u_note: "x",
        });
      }
    });
    // Outside any profile scope the variable is not read either.
    expect(validateWritableFields("u_custom", { u_note: "x" })).toEqual({ u_note: "x" });
  });

  it("still applies to the SN_PROFILE_NAME environment profile", () => {
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", README_READ_ONLY_POLICY);
    environmentProfile();

    const manager = new ProfileManager({ configFilePath });
    const profile = manager.getProfile("env-profile");
    expect(profile.fieldPolicy).toEqual(JSON.parse(README_READ_ONLY_POLICY));

    runWithFieldPolicyConfiguration(profileScope(profile), () => {
      expect(policyReason(() => validateWritableFields("u_custom", { u_note: "x" }))).toBe(
        "non_writable_field"
      );
      expect(resolveReadableFields("u_custom", { fields: "u_note" })).toEqual(["u_note"]);
    });
  });

  it("maps the profile-key form onto the same profile keys", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        writableTableFields: [{ table: "incident", fields: ["state"] }],
      })
    );
    environmentProfile();

    const profile = new ProfileManager({ configFilePath }).getProfile("env-profile");
    expect(profile.fieldPolicy).toBeUndefined();
    expect(profile.writableTableFields).toEqual([{ table: "incident", fields: ["state"] }]);
    runWithFieldPolicyConfiguration(profileScope(profile), () => {
      expect(
        policyReason(() => validateWritableFields("incident", { short_description: "x" }))
      ).toBe("non_writable_field");
    });
  });

  it("states no field policy when the variable is unset or blank", () => {
    environmentProfile();
    expect(new ProfileManager({ configFilePath }).getProfile("env-profile").fieldPolicy)
      .toBeUndefined();

    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", "   ");
    expect(fieldPolicyInputFromEnvironment({ SN_FIELD_POLICY_DEFINITIONS: "   " })).toEqual({});
    expect(new ProfileManager({ configFilePath }).getProfile("env-profile").fieldPolicy)
      .toBeUndefined();
  });

  it.each<[string, string, RegExp]>([
    ["invalid JSON", "{not json", /^SN_FIELD_POLICY_DEFINITIONS is not valid JSON\.$/u],
    ["a non-object", "[]", /^SN_FIELD_POLICY_DEFINITIONS must be a JSON object\.$/u],
    ["an oversized value", JSON.stringify({ "*": { readable: "*", u: "x".repeat(70_000) } }), /exceeds 65536 characters/u],
    [
      "a pattern",
      JSON.stringify({ u_audit: { writable: ["u_*"] } }),
      /^SN_FIELD_POLICY_DEFINITIONS\.u_audit\.writable\[0\] is not a field name/u,
    ],
    [
      "a pattern in the profile-key form",
      JSON.stringify({ writableTableFields: [{ table: "incident", fields: ["u_*"] }] }),
      /^SN_FIELD_POLICY_DEFINITIONS\.writableTableFields\[0\]\.fields\[0\] \(table "incident"\)/u,
    ],
  ])("fails the environment profile at startup on %s", (_label, value, expected) => {
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", value);
    environmentProfile();

    expect(() => new ProfileManager({ configFilePath })).toThrow(expected);
  });

  it("is not read at all when a config file supplies the profiles", () => {
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", "{not json");
    environmentProfile();
    writeProfiles({ full: {} });

    const manager = new ProfileManager({ configFilePath });
    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["full"]);
  });
});
