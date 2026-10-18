import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FieldPolicyConfigurationError,
  FieldPolicyError,
  fieldPolicyInputFromEnvironment,
  resolveReadableFields,
  resolveWriteResponseFields,
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

  /** Wildcard look-alikes: none of them may mean "every field". */
  const sparseOne = (): unknown[] => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    return sparse;
  };
  const lookAlikes: ReadonlyArray<[string, () => unknown]> = [
    ['["*","number"]', () => ["*", "number"]],
    ['["*","*"]', () => ["*", "*"]],
    ['[" * "]', () => [" * "]],
    ['[["*"]]', () => [["*"]]],
    ["[null]", () => [null]],
    ["a sparse length-1 array", sparseOne],
    ['{0:"*",length:1}', () => ({ 0: "*", length: 1 })],
    ['"**"', () => "**"],
    ['"ALL"', () => "ALL"],
  ];

  it.each(lookAlikes)("does not widen writableTableFields fields %s", (_label, make) => {
    const configuration = { writableTableFields: [{ table: "change_request", fields: make() }] };
    expect(() => validateFieldPolicyConfiguration(configuration)).toThrow(
      FieldPolicyConfigurationError
    );
    runWithFieldPolicyConfiguration(configuration, () => {
      expect(policyReason(() => validateWritableFields("change_request", { u_x: "1" })))
        .not.toBe("allowed");
    });
  });

  it.each(lookAlikes)("does not widen fieldPolicy writable %s", (_label, make) => {
    const configuration = { fieldPolicy: { change_request: { writable: make() } } };
    expect(() => validateFieldPolicyConfiguration(configuration)).toThrow(
      FieldPolicyConfigurationError
    );
    runWithFieldPolicyConfiguration(configuration, () => {
      expect(policyReason(() => validateWritableFields("change_request", { u_x: "1" })))
        .not.toBe("allowed");
    });
  });

  it.each(lookAlikes)("does not widen fieldPolicy readable %s", (_label, make) => {
    const configuration = { fieldPolicy: { change_request: { readable: make() } } };
    expect(() => validateFieldPolicyConfiguration(configuration)).toThrow(
      FieldPolicyConfigurationError
    );
    runWithFieldPolicyConfiguration(configuration, () => {
      expect(policyReason(() => resolveReadableFields("change_request", { fields: "u_x" })))
        .not.toBe("allowed");
      expect(policyReason(() => resolveReadableFields("change_request", { fields: "all" })))
        .not.toBe("allowed");
    });
  });

  it.each(lookAlikes)("does not widen fieldPolicy defaults %s", (_label, make) => {
    const configuration = { fieldPolicy: { change_request: { defaults: make() } } };
    expect(() => validateFieldPolicyConfiguration(configuration)).toThrow(
      FieldPolicyConfigurationError
    );
    runWithFieldPolicyConfiguration(configuration, () => {
      expect(policyReason(() => resolveReadableFields("change_request"))).not.toBe(
        "allowed"
      );
    });
  });

  it('does not accept ["*"] as a table name in the list form', () => {
    expect(() =>
      validateFieldPolicyConfiguration({
        writableTableFields: [{ table: ["*"], fields: ["*"] }],
      })
    ).toThrow(/^writableTableFields\[0\]\.table is not a valid table name/u);
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
    [
      'defaults "*" with a narrowed readable set',
      { fieldPolicy: { u_card: { defaults: "*", readable: ["sys_id", "status"] } } },
      'fieldPolicy.u_card.defaults is "*" (every field), which fieldPolicy.u_card.readable does not allow',
    ],
    [
      'defaults ["*"] with a narrowed readable set',
      { fieldPolicy: { u_card: { defaults: ["*"], readable: ["sys_id", "status"] } } },
      'fieldPolicy.u_card.defaults is "*" (every field), which fieldPolicy.u_card.readable does not allow',
    ],
    ["a non-list readableTableFields", { readableTableFields: { table: "incident" } }, "readableTableFields must be a list"],
    ["a list entry without a table", { readableTableFields: [{ fields: "*" }] }, "readableTableFields[0].table is not a valid table name"],
    ["a list entry that is not an object", { writableTableFields: ["incident"] }, "writableTableFields[0] must be an object with table and fields"],
  ])("rejects %s", (_label, profile, expected) => {
    writeProfiles({ broken: profile });

    const error = loadError();
    expect(error.message).toContain('Profile configuration is invalid: profile "broken": ');
    expect(error.message).toContain(expected);
  });

  it('rejects defaults "*" beside a narrowed readable set, at load and on the request path', () => {
    // A concise read under this policy used to ask ServiceNow for every
    // column, which the narrowed readable set does not allow.
    writeProfiles({
      card: {
        fieldPolicy: {
          u_card: { defaults: "*", readable: ["sys_id", "status"], writable: ["status"] },
        },
      },
    });
    expect(loadError().message).toBe(
      'Profile configuration is invalid: profile "card": fieldPolicy.u_card.defaults is "*" ' +
        '(every field), which fieldPolicy.u_card.readable does not allow. List the default ' +
        'fields, or make readable "*".'
    );

    expect(() =>
      fieldPolicyInputFromEnvironment({
        SN_FIELD_POLICY_DEFINITIONS: JSON.stringify({
          u_card: { defaults: ["*"], readable: ["sys_id"] },
        }),
      })
    ).toThrow(/^SN_FIELD_POLICY_DEFINITIONS\.u_card\.defaults is "\*" \(every field\)/u);

    // A scope that never went through a profile load fails closed.
    runWithFieldPolicyConfiguration(
      { fieldPolicy: { u_card: { defaults: "*", readable: ["sys_id", "status"] } } },
      () => {
        expect(policyReason(() => resolveReadableFields("u_card"))).toBe(
          "invalid_argument_shape"
        );
      }
    );

    // A wildcard default stays valid wherever readable is open.
    for (const fieldPolicy of [
      { u_card: { defaults: "*" } },
      { u_card: { defaults: ["*"], readable: "*" } },
      { incident: { defaults: "*" } },
    ]) {
      expect(() => validateFieldPolicyConfiguration({ fieldPolicy })).not.toThrow();
      runWithFieldPolicyConfiguration({ fieldPolicy }, () => {
        const table = Object.keys(fieldPolicy)[0]!;
        expect(resolveReadableFields(table)).toEqual(["*"]);
      });
    }
  });

  /** Malformed shapes that each carry a canary in the rejected part. */
  const CANARY = "zqxcanary";
  const canaryShapes: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["a table key with a space", { fieldPolicy: { [`${CANARY} table`]: {} } }],
    ["a table key with punctuation", { fieldPolicy: { [`${CANARY}!`]: { writable: [] } } }],
    ["a pattern entry", { fieldPolicy: { incident: { writable: [`${CANARY}*`] } } }],
    [
      "an upper-case pattern entry",
      { writableTableFields: [{ table: "incident", fields: [`u_${CANARY.toUpperCase()}*`] }] },
    ],
    ["a dotted entry", { fieldPolicy: { incident: { writable: ["u_x", `${CANARY}.x`] } } }],
    ["an object field set", { fieldPolicy: { incident: { writable: { [CANARY]: 1 } } } }],
    [
      "a non-string entry beside a pattern",
      { fieldPolicy: { incident: { readable: [1, CANARY], defaults: [`${CANARY}*`] } } },
    ],
    ["a string table entry", { fieldPolicy: { incident: CANARY } }],
    ["a string fieldPolicy", { fieldPolicy: CANARY }],
    ["a list fieldPolicy", { fieldPolicy: [CANARY] }],
    ["an invalid list-form table", { readableTableFields: [{ table: `${CANARY}/x`, fields: "*" }] }],
    [
      "an invalid list-form field",
      { readableTableFields: [{ table: "incident", fields: [`${CANARY}-x`] }] },
    ],
    ["a string list entry", { readableTableFields: [CANARY] }],
    ["a string list", { readableTableFields: CANARY }],
    ["a string list-form fields", { writableTableFields: [{ table: "incident", fields: CANARY }] }],
  ];

  it.each(canaryShapes)("never repeats the rejected value for %s", (_label, shape) => {
    let direct = "";
    try {
      validateFieldPolicyConfiguration(shape);
    } catch (error) {
      expect(error).toBeInstanceOf(FieldPolicyConfigurationError);
      direct = (error as Error).message;
    }
    expect(direct).not.toBe("");
    expect(direct.toLowerCase()).not.toContain(CANARY);

    writeProfiles({ broken: shape });
    const loaded = loadError().message;
    expect(loaded).toContain('Profile configuration is invalid: profile "broken": ');
    expect(loaded.toLowerCase()).not.toContain(CANARY);
  });

  it.each<[string, string]>([
    ["invalid JSON", `{"${CANARY}": `],
    ["a JSON list", JSON.stringify([CANARY])],
    ["an invalid table key", JSON.stringify({ [`${CANARY} t`]: {} })],
    [
      "a pattern in the profile-key form",
      JSON.stringify({ fieldPolicy: { a: { writable: [`${CANARY}*`] } } }),
    ],
  ])("never repeats the SN_FIELD_POLICY_DEFINITIONS value for %s", (_label, value) => {
    let parsed = "";
    try {
      fieldPolicyInputFromEnvironment({ SN_FIELD_POLICY_DEFINITIONS: value });
    } catch (error) {
      expect(error).toBeInstanceOf(FieldPolicyConfigurationError);
      parsed = (error as Error).message;
    }
    expect(parsed).toMatch(/^SN_FIELD_POLICY_DEFINITIONS/u);
    expect(parsed.toLowerCase()).not.toContain(CANARY);

    // The same value on the environment profile fails startup just as cleanly.
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", value);
    vi.stubEnv("SN_PROFILE_NAME", "env-profile");
    vi.stubEnv("SN_INSTANCE", "https://env-profile.service-now.com");
    expect(loadError().message.toLowerCase()).not.toContain(CANARY);
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

describe("fieldPolicy beside a table list is rejected (A2)", () => {
  const ONE_FORM =
    "State the field policy in one form: fieldPolicy alone, or readableTableFields " +
    "and writableTableFields without fieldPolicy.";
  // Values carry a canary; only key names may appear in a message.
  const narrowing = { incident: { writable: ["state"], readable: ["sys_id", "zqxcanary"] } };
  const userList = [{ table: "sys_user", fields: ["sys_id", "zqxcanary"] }];

  it.each<[string, Record<string, unknown>, string]>([
    ["readableTableFields", { fieldPolicy: narrowing, readableTableFields: userList }, "readableTableFields"],
    ["writableTableFields", { fieldPolicy: narrowing, writableTableFields: userList }, "writableTableFields"],
    [
      "both lists",
      { fieldPolicy: narrowing, readableTableFields: userList, writableTableFields: userList },
      "readableTableFields and writableTableFields",
    ],
    ["an empty list", { fieldPolicy: narrowing, writableTableFields: [] }, "writableTableFields"],
  ])("rejects fieldPolicy with %s at load", (_label, profile, lists) => {
    writeProfiles({ mixed: profile });

    const message = loadError().message;
    expect(message).toBe(
      `Profile configuration is invalid: profile "mixed": fieldPolicy cannot be combined ` +
        `with ${lists}. ${ONE_FORM}`
    );
    expect(message.toLowerCase()).not.toContain("canary");
  });

  it("rejects the combination in the variable's profile-key form", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ fieldPolicy: narrowing, writableTableFields: userList })
    );
    vi.stubEnv("SN_PROFILE_NAME", "env-profile");
    vi.stubEnv("SN_INSTANCE", "https://env-profile.service-now.com");

    const message = loadError().message;
    expect(message).toBe(
      "SN_FIELD_POLICY_DEFINITIONS.fieldPolicy cannot be combined with " +
        `SN_FIELD_POLICY_DEFINITIONS.writableTableFields. ${ONE_FORM}`
    );
    expect(message.toLowerCase()).not.toContain("canary");
  });

  it("fails closed on the request path when the combination skipped profile load", () => {
    // Before: the lists applied and the incident narrowing was dropped, so
    // this write was allowed and caller_id was readable.
    runWithFieldPolicyConfiguration(
      { fieldPolicy: narrowing, readableTableFields: userList },
      () => {
        expect(
          policyReason(() => validateWritableFields("incident", { short_description: "x" }))
        ).toBe("invalid_argument_shape");
        expect(
          policyReason(() => resolveReadableFields("incident", { fields: "caller_id" }))
        ).toBe("invalid_argument_shape");
      }
    );
  });

  it("still applies each form on its own", () => {
    writeProfiles({
      mapped: { fieldPolicy: { incident: { writable: ["state"] } } },
      listed: {
        readableTableFields: [{ table: "sys_user", fields: ["sys_id", "name"] }],
        writableTableFields: [{ table: "sys_user", fields: ["name"] }],
      },
    });
    const manager = new ProfileManager({ configFilePath });

    runWithFieldPolicyConfiguration(profileScope(manager.getProfile("mapped")), () => {
      expect(policyReason(() => validateWritableFields("incident", { state: "2" }))).toBe(
        "allowed"
      );
      expect(
        policyReason(() => validateWritableFields("incident", { short_description: "x" }))
      ).toBe("non_writable_field");
    });
    runWithFieldPolicyConfiguration(profileScope(manager.getProfile("listed")), () => {
      expect(policyReason(() => validateWritableFields("sys_user", { name: "x" }))).toBe(
        "allowed"
      );
      expect(policyReason(() => resolveReadableFields("sys_user", { fields: "email" }))).toBe(
        "unreadable_field"
      );
    });
  });
});

describe("configurations that used to fail open are rejected (finding 4)", () => {
  it.each<[string, Record<string, unknown>, string]>([
    [
      "an unknown key in a table entry",
      { fieldPolicy: { incident: { writeable: [] } } },
      'fieldPolicy.incident has an unknown key "writeable". A table entry accepts only ' +
        "defaults, readable, and writable.",
    ],
    [
      "a misspelled readable",
      { fieldPolicy: { incident: { readable: ["number"], readble: ["sys_id"] } } },
      'fieldPolicy.incident has an unknown key "readble".',
    ],
    [
      "an unknown key that is not an identifier",
      { fieldPolicy: { incident: { writable: [], "zqx canary": true } } },
      "fieldPolicy.incident has an unknown key at position 2.",
    ],
    [
      "a comment key",
      { fieldPolicy: { incident: { _comment: "zqxcanary", writable: [] } } },
      "fieldPolicy.incident has an unknown key at position 1.",
    ],
    [
      "an unknown key in a list entry",
      { writableTableFields: [{ table: "incident", fields: "*", writable: [] }] },
      'writableTableFields[0] (table "incident") has an unknown key "writable". A list ' +
        "entry accepts only table and fields.",
    ],
    [
      "table keys that differ only in case",
      { fieldPolicy: { INCIDENT: { writable: [] }, incident: { writable: "*" } } },
      'fieldPolicy key 2 names table "incident" again (table names are case-insensitive); ' +
        "it repeats key 1. State each table once.",
    ],
    [
      "a table repeated in a list",
      {
        writableTableFields: [
          { table: "incident", fields: [] },
          { table: "change_request", fields: "*" },
          { table: "INCIDENT", fields: "*" },
        ],
      },
      'writableTableFields[2] (table "incident") repeats a table already listed at ' +
        "writableTableFields[0]. List each table once.",
    ],
  ])("rejects %s at load and fails closed on the request path", (_label, profile, expected) => {
    writeProfiles({ loose: profile });
    const message = loadError().message;
    expect(message).toContain(`Profile configuration is invalid: profile "loose": ${expected}`);
    expect(message.toLowerCase()).not.toContain("canary");

    expect(() => validateFieldPolicyConfiguration(profile)).toThrow(
      FieldPolicyConfigurationError
    );
    // Each of these left incident open before. A scope that skipped the
    // load now fails closed instead.
    runWithFieldPolicyConfiguration(profile, () => {
      expect(
        policyReason(() => validateWritableFields("incident", { short_description: "x" }))
      ).toBe("invalid_argument_shape");
    });
  });

  it("rejects table keys mixed with profile keys in the variable", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        zqxcanary_table: { writable: [] },
        writableTableFields: [{ table: "incident", fields: "*" }],
      })
    );
    vi.stubEnv("SN_PROFILE_NAME", "env-profile");
    vi.stubEnv("SN_INSTANCE", "https://env-profile.service-now.com");

    const message = loadError().message;
    expect(message).toBe(
      "SN_FIELD_POLICY_DEFINITIONS mixes table keys with the profile keys " +
        "writableTableFields. Use either a table map or the profile keys (fieldPolicy, " +
        "readableTableFields, writableTableFields), not both."
    );
    expect(message.toLowerCase()).not.toContain("canary");
  });

  it("still loads well-formed configurations that sit close to the rejected ones", () => {
    writeProfiles({
      // The same table in both lists is one table, once per list.
      bothLists: {
        readableTableFields: [
          { table: "incident", fields: ["sys_id", "number"] },
          { table: "sys_user", fields: "*" },
        ],
        writableTableFields: [{ table: "incident", fields: ["state"] }],
      },
      // Distinct tables, the "*" fallback, and every table-entry key.
      mapped: {
        fieldPolicy: {
          "*": { defaults: ["sys_id"], readable: "*", writable: [] },
          incident: { defaults: ["number"], readable: ["sys_id", "number"], writable: ["state"] },
          Change_Request: { writable: "*" },
          u_audit: { readable: [] },
        },
      },
    });
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ writableTableFields: [{ table: "incident", fields: ["state"] }] })
    );
    expect(() => new ProfileManager({ configFilePath })).toThrow(FieldPolicyConfigurationError);
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", undefined);

    const manager = new ProfileManager({ configFilePath });
    expect(manager.listProfiles().map(({ name }) => name).sort()).toEqual([
      "bothLists",
      "mapped",
    ]);
    runWithFieldPolicyConfiguration(profileScope(manager.getProfile("bothLists")), () => {
      expect(resolveReadableFields("incident", { fields: "number" })).toEqual(["number"]);
      expect(policyReason(() => validateWritableFields("incident", { state: "2" }))).toBe(
        "allowed"
      );
    });
    runWithFieldPolicyConfiguration(profileScope(manager.getProfile("mapped")), () => {
      expect(validateWritableFields("change_request", { u_x: "1" })).toEqual({ u_x: "1" });
      expect(policyReason(() => validateWritableFields("u_custom", { u_x: "1" }))).toBe(
        "non_writable_field"
      );
    });

    // The variable's profile-key form alone still maps onto the env profile.
    expect(
      fieldPolicyInputFromEnvironment({
        SN_FIELD_POLICY_DEFINITIONS: JSON.stringify({
          readableTableFields: [{ table: "incident", fields: "*" }],
          writableTableFields: [{ table: "incident", fields: ["state"] }],
        }),
      })
    ).toEqual({
      readableTableFields: [{ table: "incident", fields: "*" }],
      writableTableFields: [{ table: "incident", fields: ["state"] }],
    });
  });
});

/**
 * A JSON own key "__proto__" used to become the prototype of the copy the
 * unknown-key checks inspect, so it was ignored, or failed with a raw
 * TypeError. It is now an unknown key like any other. It is not a valid
 * identifier, so the message identifies it by position, as for _comment.
 * Computed keys below create an own "__proto__" property, as JSON.parse does.
 */
describe('a "__proto__" key is rejected like any other unknown key (RR1)', () => {
  it.each<[string, Record<string, unknown>, string]>([
    [
      "alone in a table entry",
      { fieldPolicy: { incident: { ["__proto__"]: { writable: [] } } } },
      "fieldPolicy.incident has an unknown key at position 1. A table entry accepts only " +
        "defaults, readable, and writable.",
    ],
    [
      "beside a real key in a table entry",
      { fieldPolicy: { incident: { ["__proto__"]: { writable: [] }, writable: ["state"] } } },
      "fieldPolicy.incident has an unknown key at position 1. A table entry accepts only " +
        "defaults, readable, and writable.",
    ],
    [
      "in a list entry",
      {
        writableTableFields: [
          { table: "incident", fields: "*", ["__proto__"]: { fields: [] } },
        ],
      },
      'writableTableFields[0] (table "incident") has an unknown key at position 3. A list ' +
        "entry accepts only table and fields.",
    ],
  ])("rejects one %s at load and fails closed on the request path", (_label, profile, expected) => {
    writeProfiles({ proto: profile });
    expect(fs.readFileSync(configFilePath, "utf8")).toContain('"__proto__"');

    // Named, not the generic "could not be loaded safely" failure.
    expect(loadError().message).toBe(
      `Profile configuration is invalid: profile "proto": ${expected}`
    );

    const parsed = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
    expect(() => validateFieldPolicyConfiguration(parsed)).toThrow(
      FieldPolicyConfigurationError
    );
    runWithFieldPolicyConfiguration(parsed, () => {
      expect(
        policyReason(() => validateWritableFields("incident", { short_description: "x" }))
      ).toBe("invalid_argument_shape");
    });
  });

  it("rejects it in SN_FIELD_POLICY_DEFINITIONS, in a table entry and beside profile keys", () => {
    expect(() =>
      fieldPolicyInputFromEnvironment({
        SN_FIELD_POLICY_DEFINITIONS: '{"incident":{"__proto__":{"writable":[]}}}',
      })
    ).toThrow(
      "SN_FIELD_POLICY_DEFINITIONS.incident has an unknown key at position 1. A table " +
        "entry accepts only defaults, readable, and writable."
    );
    // It used to become the copy's prototype, so the variable escaped the
    // mixed-key check.
    expect(() =>
      fieldPolicyInputFromEnvironment({
        SN_FIELD_POLICY_DEFINITIONS:
          '{"__proto__":{"incident":{"writable":[]}},' +
          '"writableTableFields":[{"table":"incident","fields":"*"}]}',
      })
    ).toThrow(
      "SN_FIELD_POLICY_DEFINITIONS mixes table keys with the profile keys writableTableFields."
    );
  });
});

describe("SN_FIELD_POLICY_DEFINITIONS configures only the environment profile (#9)", () => {
  function environmentProfile(name = "env-profile"): void {
    vi.stubEnv("SN_PROFILE_NAME", name);
    vi.stubEnv("SN_INSTANCE", "https://env-profile.service-now.com");
    vi.stubEnv("SN_USER", "env-user");
  }

  it("is never read on the request path", () => {
    // Only the environment profile carries the variable, as its own keys. A
    // scope without a field policy stays open even with the variable set.
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", README_READ_ONLY_POLICY);

    runWithFieldPolicyConfiguration({}, () => {
      for (const table of ["u_custom", "change_task", "hr_case", "x_acme_app_table"]) {
        expect(validateWritableFields(table, { u_note: "x" }), table).toEqual({
          u_note: "x",
        });
      }
    });
    expect(validateWritableFields("u_custom", { u_note: "x" })).toEqual({ u_note: "x" });
  });

  it("leaves a config-file profile with no field policy open on custom tables", () => {
    writeProfiles({ full: { tableAccess: { readTables: ["*"], writeTables: ["*"] } } });

    const profile = new ProfileManager({ configFilePath }).getProfile("full");
    expect(profile.fieldPolicy).toBeUndefined();
    runWithFieldPolicyConfiguration(profileScope(profile), () => {
      expect(validateWritableFields("u_custom", { u_note: "x" })).toEqual({ u_note: "x" });
    });
  });

  it("still applies to the SN_PROFILE_NAME environment profile when there is no config file", () => {
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", README_READ_ONLY_POLICY);
    environmentProfile();
    expect(fs.existsSync(configFilePath)).toBe(false);

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

  it.each<[string, string]>([
    ["the README recipe", README_READ_ONLY_POLICY],
    ["a narrowing", JSON.stringify({ zqxcanary_table: { writable: ["zqxcanary_field"] } })],
    ["invalid JSON", "{zqxcanary"],
  ])("refuses to start when a config file supplies the profiles and it holds %s", (_label, value) => {
    // Up to 2.1.0 this value narrowed the file profiles. Ignoring it now would
    // silently widen them, so startup stops and names the remedy.
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", value);
    writeProfiles({ full: { tableAccess: { readTables: ["*"], writeTables: ["*"] } } });

    let error: unknown;
    try {
      new ProfileManager({ configFilePath });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FieldPolicyConfigurationError);
    const message = (error as Error).message;
    expect(message).toBe(
      "SN_FIELD_POLICY_DEFINITIONS is set, but profiles are loaded from the config " +
        "file; it now applies only to the SN_PROFILE_NAME environment profile. Move " +
        "the policy into each profile's fieldPolicy, or unset the variable."
    );
    expect(message).not.toContain(value);
    expect(message.toLowerCase()).not.toContain("canary");

    // A mapped environment profile does not change that: the file wins.
    environmentProfile();
    expect(() => new ProfileManager({ configFilePath })).toThrow(FieldPolicyConfigurationError);
  });

  it("starts with a config file when the variable is blank", () => {
    vi.stubEnv("SN_FIELD_POLICY_DEFINITIONS", "  ");
    writeProfiles({ full: {} });

    const manager = new ProfileManager({ configFilePath });
    expect(manager.listProfiles().map(({ name }) => name)).toEqual(["full"]);
  });
});

describe("validated policy maps are built once and reused", () => {
  function deepFrozenClone<T>(value: T): T {
    const freeze = (node: unknown): unknown => {
      if (typeof node === "object" && node !== null) {
        for (const child of Object.values(node)) freeze(child);
        Object.freeze(node);
      }
      return node;
    };
    return freeze(JSON.parse(JSON.stringify(value))) as T;
  }

  /** A fresh outer object per call, as the dispatcher's policy provider builds. */
  function scopeOf(profile: Profile): FieldPolicyConfigurationInput {
    return profileScope(profile);
  }

  it("reuses the map built at profile load for every request on that profile", () => {
    writeProfiles({
      narrowed: {
        fieldPolicy: { incident: { readable: ["sys_id", "number"], writable: ["state"] } },
      },
    });
    const profile = new ProfileManager({ configFilePath }).getProfile("narrowed");

    const first = runWithFieldPolicyConfiguration(scopeOf(profile), () =>
      resolveReadableFields("incident")
    );
    const second = runWithFieldPolicyConfiguration(scopeOf(profile), () =>
      resolveReadableFields("incident")
    );
    expect(first).toEqual(["sys_id", "number"]);
    // The same frozen projection object: the map was not rebuilt.
    expect(second).toBe(first);
    runWithFieldPolicyConfiguration(scopeOf(profile), () => {
      expect(resolveReadableFields("u_custom")).toBe(resolveReadableFields("u_custom"));
      expect(policyReason(() => validateWritableFields("incident", { short_description: "x" })))
        .toBe("non_writable_field");
    });

    // The same content, never validated, is rebuilt on every lookup.
    const unvalidated = { fieldPolicy: JSON.parse(JSON.stringify(profile.fieldPolicy)) };
    const rebuiltA = runWithFieldPolicyConfiguration(unvalidated, () =>
      resolveReadableFields("incident")
    );
    const rebuiltB = runWithFieldPolicyConfiguration(unvalidated, () =>
      resolveReadableFields("incident")
    );
    expect(rebuiltA).toEqual(first);
    expect(rebuiltA).not.toBe(rebuiltB);
  });

  it("keeps two profiles' policies apart", () => {
    writeProfiles({
      stateOnly: { fieldPolicy: { incident: { writable: ["state"] } } },
      readNarrow: {
        fieldPolicy: { incident: { readable: ["sys_id", "number"], writable: "*" } },
      },
      // Same content as stateOnly, separate snapshot.
      stateOnlyTwin: { fieldPolicy: { incident: { writable: ["state"] } } },
    });
    const manager = new ProfileManager({ configFilePath });
    const stateOnly = scopeOf(manager.getProfile("stateOnly"));
    const readNarrow = scopeOf(manager.getProfile("readNarrow"));
    const twin = scopeOf(manager.getProfile("stateOnlyTwin"));

    for (let round = 0; round < 3; round += 1) {
      runWithFieldPolicyConfiguration(stateOnly, () => {
        expect(
          policyReason(() => validateWritableFields("incident", { short_description: "x" }))
        ).toBe("non_writable_field");
        expect(resolveReadableFields("incident", { fields: "caller_id" })).toEqual([
          "caller_id",
        ]);
      });
      runWithFieldPolicyConfiguration(readNarrow, () => {
        expect(validateWritableFields("incident", { short_description: "x" })).toEqual({
          short_description: "x",
        });
        expect(
          policyReason(() => resolveReadableFields("incident", { fields: "caller_id" }))
        ).toBe("unreadable_field");
      });
      runWithFieldPolicyConfiguration(twin, () => {
        expect(
          policyReason(() => validateWritableFields("incident", { short_description: "x" }))
        ).toBe("non_writable_field");
      });
    }
    const projectionOf = (scope: FieldPolicyConfigurationInput) =>
      runWithFieldPolicyConfiguration(scope, () => resolveReadableFields("incident"));
    expect(projectionOf(readNarrow)).not.toBe(projectionOf(stateOnly));
    expect(projectionOf(twin)).not.toBe(projectionOf(stateOnly));
  });

  it("never caches an unvalidated policy, which still fails closed on every call", () => {
    // Malformed, deep-frozen, never validated.
    const malformed = deepFrozenClone({ fieldPolicy: { incident: { writable: ["u_*"] } } });
    for (let round = 0; round < 3; round += 1) {
      runWithFieldPolicyConfiguration(malformed, () => {
        expect(policyReason(() => validateWritableFields("incident", { state: "2" }))).toBe(
          "invalid_field_selection"
        );
      });
    }

    // Validated parts in a combination that was never validated (A2).
    const fieldPolicyOnly = deepFrozenClone({ fieldPolicy: { incident: { writable: ["state"] } } });
    const listsOnly = deepFrozenClone({
      writableTableFields: [{ table: "incident", fields: "*" }],
    });
    validateFieldPolicyConfiguration(fieldPolicyOnly);
    validateFieldPolicyConfiguration(listsOnly);
    const recombined = {
      fieldPolicy: fieldPolicyOnly.fieldPolicy,
      writableTableFields: listsOnly.writableTableFields,
    };
    for (let round = 0; round < 3; round += 1) {
      runWithFieldPolicyConfiguration(recombined, () => {
        expect(policyReason(() => validateWritableFields("incident", { state: "2" }))).toBe(
          "invalid_argument_shape"
        );
      });
    }

    // Validated but still mutable: not cached, so a later change is seen.
    const mutable = { fieldPolicy: { incident: { writable: ["state"] } } };
    validateFieldPolicyConfiguration(mutable);
    runWithFieldPolicyConfiguration(mutable, () => {
      expect(
        policyReason(() => validateWritableFields("incident", { short_description: "x" }))
      ).toBe("non_writable_field");
    });
    mutable.fieldPolicy.incident.writable.push("short_description");
    runWithFieldPolicyConfiguration(mutable, () => {
      expect(validateWritableFields("incident", { short_description: "x" })).toEqual({
        short_description: "x",
      });
    });
  });

  it("resolves exactly as the uncached path does across the field-policy test configurations", () => {
    const wide = ["sys_id", ...Array.from({ length: 299 }, (_, index) => `u_f${index}`)];
    const corpus: FieldPolicyConfigurationInput[] = [
      { fieldPolicy: { incident: { readable: ["sys_id", "number"] } } },
      { fieldPolicy: { "*": { defaults: ["sys_id", "name"], readable: "*", writable: [] } } },
      {
        fieldPolicy: {
          incident: { defaults: ["sys_id", "u_public"], readable: ["sys_id", "u_public"], writable: ["u_public"] },
        },
      },
      { readableTableFields: [{ table: "incident", fields: "*" }] },
      { fieldPolicy: { incident: { readable: ["sys_id"], writable: ["state"] } } },
      { fieldPolicy: { "*": { defaults: ["sys_id"], readable: "*", writable: "*" } } },
      { writableTableFields: [{ table: "incident", fields: "*" }] },
      { fieldPolicy: { incident: { writable: ["state"] } } },
      { fieldPolicy: { incident: { readable: ["number"] } } },
      { fieldPolicy: { sys_atf_test: { readable: ["sys_id", "name"] } } },
      { fieldPolicy: { sys_script: { writable: [] }, sys_user_grmember: { writable: [] } } },
      { fieldPolicy: { u_write_only: { readable: [], writable: ["u_note"] } } },
      { fieldPolicy: { incident: { defaults: "*" } } },
      { fieldPolicy: { incident: { readable: ["number"], writable: ["number"] } } },
      { writableTableFields: [{ table: "incident", fields: ["state"] }] },
      { fieldPolicy: { "*": { writable: [] } } },
      { fieldPolicy: { "*": { writable: [] }, incident: { writable: "*" } } },
      { fieldPolicy: { "*": { writable: [] }, incident: { writable: ["state"] } } },
      { fieldPolicy: { "*": { writable: [] }, incident: { readable: ["sys_id", "number"] } } },
      { fieldPolicy: { "*": { readable: ["sys_id", "number", "state", "u_custom"] } } },
      { fieldPolicy: { "*": { defaults: ["sys_id"], readable: ["sys_id"], writable: [] } } },
      { fieldPolicy: { "*": { writable: [] }, u_x: { readable: ["sys_id", "u_note"] } } },
      { fieldPolicy: { "*": { readable: ["sys_id", "name"] }, u_x: { writable: "*" } } },
      { fieldPolicy: { u_x: { defaults: ["sys_id", "name"] } } },
      {
        fieldPolicy: {
          "*": { defaults: ["sys_id", "u_f7"], readable: wide },
          u_named: { writable: ["u_f1"] },
        },
      },
      { fieldPolicy: { incident: { writable: ["state", "sys_class_name", "sys_domain"] } } },
      { fieldPolicy: { "*": { writable: ["sys_domain"] } } },
      { fieldPolicy: { u_audit: { readable: [], writable: "*" } } },
      {
        readableTableFields: [{ table: "u_x", fields: ["sys_id"] }],
        writableTableFields: [{ table: "*", fields: [] }],
      },
    ];
    const tables = [
      "incident", "change_request", "problem", "task", "u_custom", "u_x", "u_named",
      "u_audit", "u_write_only", "sys_script", "sys_script_include", "sys_user",
      "sys_user_grmember", "sys_atf_test",
    ];
    const readFields = ["sys_id", "number", "state", "name", "u_note", "u_public", "caller_id", "script"];
    const writeFields = [
      "state", "short_description", "u_note", "u_public", "number", "script",
      "sys_domain", "sys_class_name", "user",
    ];
    const outcome = (action: () => unknown): unknown => {
      try {
        return { value: action() };
      } catch (error) {
        if (error instanceof FieldPolicyError) return { reason: error.reason };
        throw error;
      }
    };
    const probe = (): unknown[] =>
      tables.flatMap((table) => [
        outcome(() => resolveReadableFields(table)),
        outcome(() => resolveReadableFields(table, { fields: "all" })),
        outcome(() => resolveWriteResponseFields(table)),
        ...readFields.map((field) => outcome(() => resolveReadableFields(table, { fields: field }))),
        ...writeFields.map((field) =>
          outcome(() => validateWritableFields(table, { [field]: "x" }))
        ),
      ]);

    for (const [index, configuration] of corpus.entries()) {
      const uncached = JSON.parse(JSON.stringify(configuration)) as FieldPolicyConfigurationInput;
      const cached = deepFrozenClone(configuration);
      validateFieldPolicyConfiguration(cached);

      const expected = runWithFieldPolicyConfiguration(uncached, probe);
      const actual = runWithFieldPolicyConfiguration(cached, probe);
      expect(actual, `configuration ${index}`).toEqual(expected);
      // And the cached run really used the cache.
      runWithFieldPolicyConfiguration(cached, () => {
        const once = outcome(() => resolveReadableFields("incident"));
        const twice = outcome(() => resolveReadableFields("incident"));
        if ("value" in (once as object)) {
          expect((twice as { value: unknown }).value, `configuration ${index}`).toBe(
            (once as { value: unknown }).value
          );
        }
      });
    }
  });
});
