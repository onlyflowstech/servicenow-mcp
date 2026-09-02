import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FieldPolicyError,
  MAX_FIELD_ARRAY_LENGTH,
  MAX_FIELD_OBJECT_OWN_KEYS,
  MAX_FIELD_VALUE_DEPTH,
  MAX_FIELDS_PER_OPERATION,
  MAX_TOOL_ARGUMENT_OWN_KEYS,
  SAFE_DEFAULT_FIELDS,
  filterReadableRecord,
  filterAggregateResult,
  filterSchemaEntries,
  isSensitiveFieldName,
  prepareReadFieldArguments,
  prepareWriteFieldArguments,
  preparedReadableFields,
  fieldPolicyDenialMessage,
  fieldSelectionToSysparmFields,
  resolveReadableFields,
  runWithFieldPolicyConfiguration,
  snapshotPlainDataArguments,
  validateWritableFields,
  type FieldPolicyConfigurationInput,
} from "../src/field-policy.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function expectPolicyReason(
  action: () => unknown,
  reason: FieldPolicyError["reason"]
): void {
  try {
    action();
    throw new Error("Expected field policy rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(FieldPolicyError);
    expect((error as FieldPolicyError).reason).toBe(reason);
    expect((error as Error).message).toBe("Field access denied by policy");
  }
}

describe("SNSDK-30 readable field policy", () => {
  it("uses finite safe defaults when fields are omitted", () => {
    const selected = resolveReadableFields(" INCIDENT ");

    expect(selected).toEqual(SAFE_DEFAULT_FIELDS.incident);
    expect(selected).toContain("sys_id");
    expect(selected).not.toContain("description");
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it("maps detailed and fields=all to the full selection, and narrows under config", () => {
    // Field policy no longer denies at table granularity, so "all" on a
    // granted table means every field. The bounded projection lives in
    // `defaults`, which is what an unspecified read still gets.
    const detailed = resolveReadableFields("incident", {
      responseFormat: "detailed",
    });
    const all = resolveReadableFields("incident", { fields: " ALL " });

    expect(all).toEqual(detailed);
    expect(all).toEqual(["*"]);
    expect(resolveReadableFields("incident")).toEqual(SAFE_DEFAULT_FIELDS.incident);

    // An explicit operator list still bounds "all" to exactly that list.
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ incident: { readable: ["sys_id", "number"] } })
    );
    expect(resolveReadableFields("incident", { fields: "all" })).toEqual([
      "sys_id",
      "number",
    ]);
  });

  it("normalizes approved explicit fields and rejects duplicates", () => {
    expect(
      resolveReadableFields("incident", {
        fields: " SYS_ID, number,short_description ",
      })
    ).toEqual(["sys_id", "number", "short_description"]);

    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "sys_id,SYS_ID" }),
      "invalid_field_selection"
    );
  });


  it("supports operator-configured generic readable field fallback", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        "*": { defaults: ["sys_id", "name"], readable: "*", writable: [] },
      })
    );

    expect(resolveReadableFields("u_unclassified")).toEqual(["sys_id", "name"]);
    expect(
      resolveReadableFields("u_unclassified", { fields: "sys_id,u_custom_safe" })
    ).toEqual(["sys_id", "u_custom_safe"]);
    expectPolicyReason(
      () => resolveReadableFields("u_unclassified", { fields: "sys_id,password" }),
      "sensitive_field"
    );
  });

  it("supports operator-configured exact table field overrides", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        incident: {
          defaults: ["sys_id", "u_public"],
          readable: ["sys_id", "u_public"],
          writable: ["u_public"],
        },
      })
    );

    expect(resolveReadableFields("incident")).toEqual(["sys_id", "u_public"]);
    expect(validateWritableFields("incident", { u_public: "ok" })).toEqual({
      u_public: "ok",
    });
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "number" }),
      "unreadable_field"
    );
  });

  it("keeps readableTableFields wildcard selections as policy wildcards", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        readableTableFields: [{ table: "incident", fields: "*" }],
      })
    );

    expect(
      resolveReadableFields("incident", { fields: "number,u_custom_safe" })
    ).toEqual(["number", "u_custom_safe"]);
    expect(resolveReadableFields("incident", { fields: "all" })).toEqual(["*"]);
    expect(resolveReadableFields("sys_user", { fields: "user_name" })).toEqual([
      "user_name",
    ]);
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "password" }),
      "sensitive_field"
    );
  });

  it("accepts unmapped tables and unknown fields, and still rejects malformed and sensitive names", () => {
    // A table with no built-in entry is readable: reachability is decided by
    // tableAccess, not here. It gets the bounded generic default projection.
    expect(resolveReadableFields("u_unclassified")).toEqual(["sys_id"]);
    expect(
      resolveReadableFields("incident", { fields: "sys_id,u_unknown" })
    ).toEqual(["sys_id", "u_unknown"]);

    // Shape validation and the sensitive-name filter are field-level and
    // survive: neither is a table-granularity denial.
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "sys_id,bad-field" }),
      "invalid_field_selection"
    );
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "sys_id,client_secret" }),
      "sensitive_field"
    );
  });

  it("does not cap explicit field selections", () => {
    const count = MAX_FIELDS_PER_OPERATION + 1;
    const excessive = Array.from(
      { length: count },
      (_, index) => `field_${index}`
    ).join(",");

    expect(resolveReadableFields("incident", { fields: excessive })).toHaveLength(
      count
    );
  });
});

describe("SNSDK-30 writable field policy", () => {
  it("keeps read and write allowlists separate when an operator states both", () => {
    // Separation is now something configuration expresses, not something the
    // built-ins impose: an unconfigured table is open for both operations.
    expect(validateWritableFields("incident", { sys_id: "a".repeat(32) })).toEqual(
      { sys_id: "a".repeat(32) }
    );

    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ incident: { readable: ["sys_id"], writable: ["state"] } })
    );
    expect(resolveReadableFields("incident", { fields: "sys_id" })).toEqual([
      "sys_id",
    ]);
    expectPolicyReason(
      () => validateWritableFields("incident", { sys_id: "a".repeat(32) }),
      "non_writable_field"
    );
  });

  it("normalizes and clones approved incident fields", () => {
    const input = { " Short_Description ": "Disk unavailable", state: "2" };
    const validated = validateWritableFields("incident", input);

    expect(validated).toEqual({
      short_description: "Disk unavailable",
      state: "2",
    });
    expect(validated).not.toBe(input);
    expect(Object.isFrozen(validated)).toBe(true);
  });

  it("deep-clones and freezes JSON-safe values while preserving aliases safely", () => {
    const shared = { safe: ["before"] };
    const input = { description: shared, short_description: shared };
    const validated = validateWritableFields("incident", input);
    const description = validated.description as Record<string, unknown>;
    const shortDescription = validated.short_description as Record<string, unknown>;

    expect(description).toEqual({ safe: ["before"] });
    expect(shortDescription).toEqual({ safe: ["before"] });
    expect(description).not.toBe(shared);
    expect(description).not.toBe(shortDescription);
    expect(Object.isFrozen(description)).toBe(true);
    expect(Object.isFrozen(description.safe)).toBe(true);

    shared.safe[0] = "after";
    expect(description.safe).toEqual(["before"]);
  });

  it("rejects cycles, accessors, excessive depth/arrays, and exotic prototypes", () => {
    const cycle: Record<string, unknown> = {};
    cycle.safe = cycle;
    expectPolicyReason(
      () => validateWritableFields("incident", { description: cycle }),
      "invalid_write_payload"
    );

    let getterCalls = 0;
    const accessorPayload: Record<string, unknown> = {};
    Object.defineProperty(accessorPayload, "description", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "unsafe";
      },
    });
    expectPolicyReason(
      () => validateWritableFields("incident", accessorPayload),
      "invalid_write_payload"
    );
    expect(getterCalls).toBe(0);

    let deep: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_FIELD_VALUE_DEPTH + 1; index += 1) {
      deep = { safe: deep };
    }
    expectPolicyReason(
      () => validateWritableFields("incident", { description: deep }),
      "traversal_limit_exceeded"
    );
    expectPolicyReason(
      () =>
        validateWritableFields("incident", {
          description: new Array(MAX_FIELD_ARRAY_LENGTH + 1).fill("x"),
        }),
      "traversal_limit_exceeded"
    );
    expectPolicyReason(
      () =>
        validateWritableFields("incident", {
          description: Object.create({ inherited: "unsafe" }),
        }),
      "invalid_write_payload"
    );
  });


  it("supports operator-configured generic writable field fallback", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        "*": { defaults: ["sys_id"], readable: "*", writable: "*" },
      })
    );

    expect(
      validateWritableFields("u_unclassified", { u_safe_text: "ok", state: "2" })
    ).toEqual({ u_safe_text: "ok", state: "2" });
    expectPolicyReason(
      () => validateWritableFields("u_unclassified", { client_secret: "no" }),
      "sensitive_field"
    );
  });

  it("applies writableTableFields wildcards only to the named table", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        writableTableFields: [{ table: "incident", fields: "*" }],
      })
    );

    expect(
      validateWritableFields("incident", { u_custom_safe: "ok", state: "2" })
    ).toEqual({ u_custom_safe: "ok", state: "2" });
    // sys_user is not named by the configuration, so it keeps the open base.
    // Whether it is reachable at all is a tableAccess question, not this one.
    expect(validateWritableFields("sys_user", { user_name: "ok" })).toEqual({
      user_name: "ok",
    });
    expectPolicyReason(
      () => validateWritableFields("incident", { client_secret: "no" }),
      "sensitive_field"
    );
  });

  it("rejects empty payloads and sensitive names; accepts everything a config does not narrow", () => {
    expectPolicyReason(
      () => validateWritableFields("incident", {}),
      "invalid_write_payload"
    );
    expectPolicyReason(
      () => validateWritableFields("incident", { access_token: "not-a-token" }),
      "sensitive_field"
    );

    // Formerly denied by the built-in writable lists. Those no longer deny:
    // reachability is tableAccess plus the instance ACLs.
    expect(validateWritableFields("incident", { sys_created_on: "now" })).toEqual(
      { sys_created_on: "now" }
    );
    expect(validateWritableFields("change_request", { state: "2" })).toEqual({
      state: "2",
    });
    expect(validateWritableFields("u_unclassified", { name: "x" })).toEqual({
      name: "x",
    });

    // An explicit operator narrowing still denies, which is the only thing
    // that does.
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ incident: { writable: ["state"] } })
    );
    expectPolicyReason(
      () => validateWritableFields("incident", { sys_created_on: "now" }),
      "non_writable_field"
    );
  });
});

describe("SNSDK-30 response filtering", () => {
  it("removes unapproved top-level and sensitive nested fields from objects and arrays", () => {
    const filtered = filterReadableRecord(
      [
        {
          sys_id: "1".repeat(32),
          number: "INC0010001",
          short_description: {
            value: "Disk unavailable",
            display_value: "Disk unavailable",
            access_token: "must disappear",
            nested: {
              client_secret: "must disappear",
              safe: "kept",
            },
          },
          comments: "must disappear",
          u_unapproved: "must disappear",
        },
      ],
      ["sys_id", "number", "short_description"]
    );

    expect(filtered).toEqual([
      {
        sys_id: "1".repeat(32),
        number: "INC0010001",
        short_description: {
          value: "Disk unavailable",
          display_value: "Disk unavailable",
          nested: { safe: "kept" },
        },
      },
    ]);
  });

  it("filters schema metadata to the readable target fields", () => {
    const entries = [
      { element: "number", column_label: "Number" },
      { element: "comments", column_label: "Additional comments" },
      { element: "client_secret", column_label: "Secret" },
      { element: "u_unknown", column_label: "Unknown" },
    ];

    // Under the open base, "all" enumerates every non-sensitive column. The
    // sensitive-name filter is the only thing still removing an entry.
    expect(
      filterSchemaEntries(entries, resolveReadableFields("incident", { fields: "all" }))
    ).toEqual([
      { element: "number", column_label: "Number" },
      { element: "comments", column_label: "Additional comments" },
      { element: "u_unknown", column_label: "Unknown" },
    ]);

    // An operator-narrowed readable set still bounds the enumeration.
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ incident: { readable: ["number"] } })
    );
    expect(
      filterSchemaEntries(entries, resolveReadableFields("incident", { fields: "all" }))
    ).toEqual([{ element: "number", column_label: "Number" }]);
  });

  it("handles response cycles, aliases, accessors, and prototype keys without leakage", () => {
    let getterCalls = 0;
    const shared: Record<string, unknown> = { safe: "kept" };
    shared.loop = shared;
    const record: Record<string, unknown> = {
      short_description: shared,
      description: shared,
    };
    Object.defineProperty(record, "number", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "INC-GETTER";
      },
    });
    const polluted = JSON.parse(
      '{"safe":"kept","__proto__":{"polluted":true},"client_secret":"drop"}'
    );
    record.assigned_to = polluted;

    const filtered = filterReadableRecord(record, [
      "number",
      "short_description",
      "description",
      "assigned_to",
    ]) as Record<string, unknown>;

    expect(getterCalls).toBe(0);
    expect(filtered.number).toBeUndefined();
    expect(filtered.short_description).toEqual({ safe: "kept", loop: null });
    expect(filtered.description).toEqual({ safe: "kept", loop: null });
    expect(filtered.short_description).not.toBe(filtered.description);
    expect(filtered.assigned_to).toEqual({ safe: "kept" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("filters aggregate envelopes to approved fields and fixed statistics keys", () => {
    expect(
      filterAggregateResult(
        [
          {
            groupby_fields: [
              { field: "priority", value: "1", display_value: "Critical" },
              { field: "password", value: "secret" },
            ],
            stats: { count: "4", client_secret: "drop" },
            u_unapproved: "drop",
          },
        ],
        ["priority"]
      )
    ).toEqual([
      {
        groupby_fields: [
          { field: "priority", value: "1", display_value: "Critical" },
        ],
        stats: { count: "4" },
      },
    ]);
  });

  it("recognizes bounded sensitive key families", () => {
    for (const field of [
      "password",
      "user_password",
      "client_secret",
      "refresh_token",
      "api_key",
      "private_key",
      "ssn",
    ]) {
      expect(isSensitiveFieldName(field), field).toBe(true);
    }
    for (const field of ["key", "value", "sys_updated_by", "description"]) {
      expect(isSensitiveFieldName(field), field).toBe(false);
    }
  });
});

describe("SNSDK-30 dispatcher preparation", () => {
  it("carries an internal read projection without exposing the marker to JSON", () => {
    const prepared = prepareReadFieldArguments(
      { table: "incident", response_format: "concise" },
      "incident",
      { exposeFieldsArgument: true }
    );
    const fields = preparedReadableFields(prepared, "incident");

    expect(prepared.fields).toBe(SAFE_DEFAULT_FIELDS.incident.join(","));
    expect(fields).toEqual(SAFE_DEFAULT_FIELDS.incident);
    expect(JSON.stringify(prepared)).not.toContain("PreparedFieldAccess");
    expect(preparedReadableFields(prepared, "problem")).toBeUndefined();
  });

  it("prepares validated write fields and the safe response projection", () => {
    const prepared = prepareWriteFieldArguments(
      { table: "incident", fields: { short_description: "Safe" } },
      "incident"
    );

    expect(prepared.fields).toEqual({ short_description: "Safe" });
    // The issued read projection is now the open selection for a granted table.
    expect(preparedReadableFields(prepared, "incident")).toEqual(["*"]);
  });

  it("rejects a structurally valid but non-issued prepared marker", () => {
    const prepared = prepareReadFieldArguments(
      { table: "incident" },
      "incident",
      { exposeFieldsArgument: true }
    );
    const markerSymbol = Object.getOwnPropertySymbols(prepared)[0];
    expect(markerSymbol).toBeDefined();
    const issuedMarker = Reflect.get(prepared, markerSymbol!);
    const forgedMarker = Object.freeze({
      entries: Object.freeze([
        Object.freeze({
          table: "incident",
          readableFields: Object.freeze(["sys_id"]),
        }),
      ]),
    });
    const forged = { ...prepared, [markerSymbol!]: forgedMarker };

    expect(issuedMarker).not.toBe(forgedMarker);
    expect(preparedReadableFields(forged, "incident")).toBeUndefined();
  });

  it.each([
    [
      "sn_aggregate",
      { table: "incident", type: "COUNT", group_by: "password" },
      "sensitive_field",
    ],
    ["sn_syslog", { fields: "sys_id,password" }, "sensitive_field"],
    [
      "sn_codesearch",
      { table: "sys_script", field: "client_secret" },
      "sensitive_field",
    ],
    [
      "sn_atf",
      { action: "results", fields: "sys_id,password" },
      "sensitive_field",
    ],
  ] as const)("preflights caller-controlled fields for %s", (tool, args, reason) => {
    expectPolicyReason(
      () => resolveToolTableAccess(tool, args),
      reason
    );
  });

  it.each([
    ["list", "sys_atf_test"],
    ["suites", "sys_atf_test_suite"],
  ] as const)(
    "preflights an operator-narrowed readable set for sn_atf %s",
    (action, table) => {
      // `output` used to be denied by the built-in readable list. Built-ins no
      // longer deny, so it is now accepted -- and denied again only when an
      // operator narrows that table explicitly. The preflight itself, which is
      // what this covers, runs either way.
      expect(() => resolveToolTableAccess("sn_atf", { action, fields: "output" })).not.toThrow();

      vi.stubEnv(
        "SN_FIELD_POLICY_DEFINITIONS",
        JSON.stringify({ [table]: { readable: ["sys_id", "name"] } })
      );
      expectPolicyReason(
        () => resolveToolTableAccess("sn_atf", { action, fields: "output" }),
        "unreadable_field"
      );
    }
  );

  it("carries independent issued projections for every multi-table branch", () => {
    const apps = resolveToolTableAccess("sn_discover", { type: "apps" });
    const code = resolveToolTableAccess("sn_codesearch", {});

    expect(preparedReadableFields(apps.args, "sys_app")).toEqual([
      "sys_id",
      "name",
      "version",
      "scope",
      "active",
    ]);
    expect(preparedReadableFields(apps.args, "sys_store_app")).toEqual([
      "sys_id",
      "name",
      "version",
      "scope",
      "active",
    ]);
    expect(preparedReadableFields(code.args, "sys_script")).toContain("script");
    expect(preparedReadableFields(code.args, "sys_ws_operation")).toContain(
      "operation_script"
    );
  });

  it("never evaluates enumerable argument accessors in snapshots or preparation", () => {
    let getterCalls = 0;
    const args: Record<string, unknown> = { table: "incident" };
    Object.defineProperty(args, "fields", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "sys_id";
      },
    });

    expectPolicyReason(
      () => snapshotPlainDataArguments(args),
      "invalid_argument_shape"
    );
    expectPolicyReason(
      () =>
        prepareReadFieldArguments(args, "incident", {
          exposeFieldsArgument: true,
        }),
      "invalid_argument_shape"
    );
    expectPolicyReason(
      () => resolveToolTableAccess("sn_query", args),
      "invalid_argument_shape"
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects normal-size proxies before any get or reflection meta-trap", () => {
    const probe = <T extends object>(target: T) => {
      const calls = {
        get: 0,
        getPrototypeOf: 0,
        ownKeys: 0,
        getOwnPropertyDescriptor: 0,
      };
      const proxy = new Proxy(target, {
        get: (inner, key, receiver) => {
          calls.get += 1;
          return Reflect.get(inner, key, receiver);
        },
        getPrototypeOf: (inner) => {
          calls.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(inner);
        },
        ownKeys: (inner) => {
          calls.ownKeys += 1;
          return Reflect.ownKeys(inner);
        },
        getOwnPropertyDescriptor: (inner, key) => {
          calls.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(inner, key);
        },
      });
      return { proxy, calls };
    };
    const expectNoTraps = (calls: ReturnType<typeof probe>["calls"]) => {
      expect(calls).toEqual({
        get: 0,
        getPrototypeOf: 0,
        ownKeys: 0,
        getOwnPropertyDescriptor: 0,
      });
    };

    const args = probe({ table: "incident" });
    expectPolicyReason(
      () => snapshotPlainDataArguments(args.proxy),
      "invalid_argument_shape"
    );
    expectPolicyReason(
      () =>
        prepareReadFieldArguments(args.proxy, "incident", {
          exposeFieldsArgument: true,
        }),
      "invalid_argument_shape"
    );
    expectPolicyReason(
      () => resolveToolTableAccess("sn_delete", args.proxy),
      "invalid_argument_shape"
    );
    expect(preparedReadableFields(args.proxy, "incident")).toBeUndefined();
    expectPolicyReason(
      () => validateWritableFields("incident", args.proxy),
      "invalid_write_payload"
    );
    expectNoTraps(args.calls);

    const selection = probe({ fields: "sys_id" });
    expectPolicyReason(
      () => resolveReadableFields("incident", selection.proxy),
      "invalid_argument_shape"
    );
    expectNoTraps(selection.calls);

    const options = probe({ exposeFieldsArgument: true });
    expectPolicyReason(
      () =>
        prepareReadFieldArguments(
          { table: "incident" },
          "incident",
          options.proxy
        ),
      "invalid_argument_shape"
    );
    expectNoTraps(options.calls);

    const nestedWrite = probe({ safe: "value" });
    expectPolicyReason(
      () =>
        validateWritableFields("incident", {
          description: nestedWrite.proxy,
        }),
      "invalid_write_payload"
    );
    expectNoTraps(nestedWrite.calls);

    const response = probe({ sys_id: "safe" });
    expect(filterReadableRecord(response.proxy, ["sys_id"])).toBeNull();
    expect(
      filterReadableRecord({ description: response.proxy }, ["description"])
    ).toEqual({ description: null });
    expect(filterAggregateResult(response.proxy, ["sys_id"])).toBeNull();
    expectNoTraps(response.calls);

    const projection = probe(["sys_id"]);
    expect(filterReadableRecord({ sys_id: "safe" }, projection.proxy)).toBeNull();
    expect(filterSchemaEntries([], projection.proxy)).toEqual([]);
    expect(filterAggregateResult({}, projection.proxy)).toBeNull();
    expectNoTraps(projection.calls);

    const schemaResponse = probe([{ element: "number" }]);
    expect(
      filterSchemaEntries(schemaResponse.proxy, ["number"])
    ).toEqual([]);
    expectNoTraps(schemaResponse.calls);
  });

  it("rejects symbols, exotic prototypes, and arguments beyond the own-key budget", () => {
    const symbolArgs = { table: "incident", [Symbol("hidden")]: "unsafe" };
    expectPolicyReason(
      () => snapshotPlainDataArguments(symbolArgs),
      "invalid_argument_shape"
    );
    expectPolicyReason(
      () => snapshotPlainDataArguments(Object.create({ table: "incident" })),
      "invalid_argument_shape"
    );

    const atBoundary: Record<string, unknown> = { table: "incident" };
    for (let index = 1; index < MAX_TOOL_ARGUMENT_OWN_KEYS; index += 1) {
      atBoundary[`arg_${index}`] = index;
    }
    expect(Reflect.ownKeys(snapshotPlainDataArguments(atBoundary))).toHaveLength(
      MAX_TOOL_ARGUMENT_OWN_KEYS
    );
    expect(
      preparedReadableFields(
        resolveToolTableAccess("sn_query", atBoundary).args,
        "incident"
      )
    ).toEqual(SAFE_DEFAULT_FIELDS.incident);
    atBoundary.one_too_many = true;
    expectPolicyReason(
      () => snapshotPlainDataArguments(atBoundary),
      "invalid_argument_shape"
    );
  });

  it("stops a plain 100k-key argument set before reading values", () => {
    let getterCalls = 0;
    const candidate: Record<string, unknown> = {};
    Object.defineProperty(candidate, "arg_0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "unsafe";
      },
    });
    for (let index = 1; index < 100_000; index += 1) {
      candidate[`arg_${index}`] = index;
    }

    expectPolicyReason(
      () => snapshotPlainDataArguments(candidate),
      "invalid_argument_shape"
    );
    expect(getterCalls).toBe(0);
  });
});

describe("SNSDK-30 descriptor budgets", () => {
  it("bounds nested write keys before descriptor/value traversal", () => {
    const atBoundary: Record<string, unknown> = {};
    for (let index = 0; index < MAX_FIELD_OBJECT_OWN_KEYS; index += 1) {
      atBoundary[`key_${index}`] = index;
    }
    const accepted = validateWritableFields("incident", {
      description: atBoundary,
    });
    expect(Object.keys(accepted.description as object)).toHaveLength(
      MAX_FIELD_OBJECT_OWN_KEYS
    );

    atBoundary.one_too_many = true;
    expectPolicyReason(
      () => validateWritableFields("incident", { description: atBoundary }),
      "traversal_limit_exceeded"
    );

    let getterCalls = 0;
    const huge: Record<string, unknown> = {};
    Object.defineProperty(huge, "key_0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "unsafe";
      },
    });
    for (let index = 1; index < 100_000; index += 1) {
      huge[`key_${index}`] = index;
    }
    expectPolicyReason(
      () => validateWritableFields("incident", { description: huge }),
      "traversal_limit_exceeded"
    );
    expect(getterCalls).toBe(0);
  });

  it("fails closed on oversized response objects before reading descriptors", () => {
    const atBoundary: Record<string, unknown> = {};
    for (let index = 0; index < MAX_FIELD_OBJECT_OWN_KEYS; index += 1) {
      atBoundary[`key_${index}`] = index;
    }
    expect(
      filterReadableRecord({ description: atBoundary }, ["description"])
    ).toEqual({ description: atBoundary });

    atBoundary.one_too_many = true;
    expect(
      filterReadableRecord({ description: atBoundary }, ["description"])
    ).toEqual({ description: null });

    let getterCalls = 0;
    const huge: Record<string, unknown> = {};
    Object.defineProperty(huge, "key_0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "unsafe";
      },
    });
    for (let index = 1; index < 100_000; index += 1) {
      huge[`key_${index}`] = index;
    }
    expect(filterReadableRecord(huge, ["sys_id"])).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it("never evaluates values for unapproved response keys", () => {
    let getterCalls = 0;
    const candidate: Record<string, unknown> = { sys_id: "safe" };
    for (const key of ["password", "u_unapproved"]) {
      Object.defineProperty(candidate, key, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "must-not-be-read";
        },
      });
    }

    expect(filterReadableRecord(candidate, ["sys_id"])).toEqual({
      sys_id: "safe",
    });
    expect(getterCalls).toBe(0);
  });
});

describe("field policy narrows only where an operator says so", () => {
  /** The exact object src/index.ts builds for a profile-scoped policy. */
  function scopedFieldPolicy(profile: {
    fieldPolicy?: unknown;
    readableTableFields?: unknown;
    writableTableFields?: unknown;
  }): FieldPolicyConfigurationInput {
    return {
      ...(profile.fieldPolicy === undefined
        ? {}
        : { fieldPolicy: profile.fieldPolicy }),
      ...(profile.readableTableFields === undefined
        ? {}
        : { readableTableFields: profile.readableTableFields }),
      ...(profile.writableTableFields === undefined
        ? {}
        : { writableTableFields: profile.writableTableFields }),
    };
  }

  it("treats a key present with an undefined value as an absent key", () => {
    const narrowing = { incident: { writable: ["state"] } };
    // The pre-fix provider materialized all three keys unconditionally, which
    // routed every profile down the list branch and discarded its narrowing.
    // A policy must mean the same thing however the caller assembled it.
    const materialized: FieldPolicyConfigurationInput = {
      fieldPolicy: narrowing,
      readableTableFields: undefined,
      writableTableFields: undefined,
    };
    const omitted = scopedFieldPolicy({ fieldPolicy: narrowing });

    for (const configuration of [materialized, omitted]) {
      runWithFieldPolicyConfiguration(configuration, () => {
        // The configured narrowing is honored, not discarded.
        expect(validateWritableFields("incident", { state: "2" })).toEqual({
          state: "2",
        });
        expectPolicyReason(
          () => validateWritableFields("incident", { short_description: "no" }),
          "non_writable_field"
        );
        // A table the profile did not name is unaffected in either direction.
        expect(validateWritableFields("problem", { state: "2" })).toEqual({
          state: "2",
        });
      });
    }
  });

  it("narrows exactly the named table under every configuration form", () => {
    // The shape of the configuration must never decide the posture. Each form
    // below narrows `incident` writes to `state` and says nothing about
    // `problem`; every one must behave identically.
    const forms: readonly FieldPolicyConfigurationInput[] = [
      scopedFieldPolicy({ fieldPolicy: { incident: { writable: ["state"] } } }),
      {
        fieldPolicy: { incident: { writable: ["state"] } },
        readableTableFields: undefined,
        writableTableFields: undefined,
      },
      scopedFieldPolicy({
        writableTableFields: [{ table: "incident", fields: ["state"] }],
      }),
    ];

    for (const [index, configuration] of forms.entries()) {
      runWithFieldPolicyConfiguration(configuration, () => {
        expect(
          validateWritableFields("incident", { state: "2" }),
          `form ${index}`
        ).toEqual({ state: "2" });
        expectPolicyReason(
          () => validateWritableFields("incident", { short_description: "no" }),
          "non_writable_field"
        );
        expect(
          validateWritableFields("problem", { state: "2" }),
          `form ${index}`
        ).toEqual({ state: "2" });
      });
    }
  });

  it("permits writes to script and membership tables that a profile has granted", () => {
    // Recorded deliberately. Field policy no longer denies at table
    // granularity: `tableAccess` decides reachability and ServiceNow's
    // per-user ACLs are the real boundary. An integration account without
    // the roles to write these tables is refused by the instance.
    const scriptWrite = { script: "gs.print('x')" };
    const membershipWrite = { user: "a".repeat(32), group: "b".repeat(32) };

    for (const table of [
      "sys_script",
      "sys_script_include",
      "sys_ui_script",
      "sys_script_client",
      "sys_ws_operation",
    ]) {
      expect(validateWritableFields(table, scriptWrite)).toEqual(scriptWrite);
    }
    expect(validateWritableFields("sys_user_grmember", membershipWrite)).toEqual(
      membershipWrite
    );
  });

  it("still denies those tables when an operator narrows them explicitly", () => {
    // The control an operator retains: name the table, state the writable set.
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        sys_script: { writable: [] },
        sys_user_grmember: { writable: [] },
      })
    );

    expectPolicyReason(
      () => validateWritableFields("sys_script", { script: "gs.print('x')" }),
      "non_writable_field"
    );
    expectPolicyReason(
      () => validateWritableFields("sys_user_grmember", { user: "a".repeat(32) }),
      "non_writable_field"
    );
    // Naming one table leaves every other table alone.
    expect(validateWritableFields("sys_script_include", { script: "x" })).toEqual(
      { script: "x" }
    );
  });

  it("denies reads only when a configured readable set is empty", () => {
    // An empty selection would serialize to an empty sysparm_fields, which
    // ServiceNow reads as "every field". That guard is a wire-format footgun,
    // not a policy denial, and it survives.
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ u_write_only: { readable: [], writable: ["u_note"] } })
    );

    expectPolicyReason(
      () => resolveReadableFields("u_write_only"),
      "unreadable_field"
    );
    expectPolicyReason(
      () => resolveReadableFields("u_write_only", { fields: "all" }),
      "unreadable_field"
    );
    expect(validateWritableFields("u_write_only", { u_note: "x" })).toEqual({
      u_note: "x",
    });
  });

  it("keeps the bounded default projection for both built-in and unmapped tables", () => {
    // `defaults` is ergonomics, not a denial, and is untouched by the move to
    // an open base: an unspecified read must not become "every column".
    expect(resolveReadableFields("incident")).toEqual([
      ...SAFE_DEFAULT_FIELDS.incident!,
    ]);
    expect(fieldSelectionToSysparmFields(resolveReadableFields("incident"))).toContain(
      "sys_id,number"
    );
    expect(resolveReadableFields("u_unmapped")).toEqual(["sys_id"]);

    // An explicit wildcard default is still honoured as stated intent.
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ incident: { defaults: "*" } })
    );
    expect(resolveReadableFields("incident")).toEqual(["*"]);
  });

  it("narrows a built-in table without restating its defaults", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ incident: { readable: ["number"], writable: ["number"] } })
    );

    // Pre-fix this threw a raw TypeError on every request, because the
    // built-in default projection survived the readable override.
    expect(resolveReadableFields("incident")).toEqual(["number"]);
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "caller_id" }),
      "unreadable_field"
    );
    expect(validateWritableFields("incident", { number: "INC1" })).toEqual({
      number: "INC1",
    });
  });

  it("rejects a contradictory policy as a branded denial, not a TypeError", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({
        incident: { defaults: ["caller_id"], readable: ["number"] },
      })
    );

    expectPolicyReason(
      () => resolveReadableFields("incident"),
      "invalid_argument_shape"
    );
  });
});

describe("field-policy denials explain themselves to an operator", () => {
  function denial(action: () => unknown): FieldPolicyError {
    try {
      action();
    } catch (error) {
      if (error instanceof FieldPolicyError) return error;
      throw error;
    }
    throw new Error("Expected a field policy rejection");
  }

  it("names the table, the field, and the config key for a non-writable field", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ sys_script: { writable: [] } })
    );
    const error = denial(() => validateWritableFields("sys_script", { script: "x" }));

    expect(error.reason).toBe("non_writable_field");
    expect(error.table).toBe("sys_script");
    expect(error.field).toBe("script");
    const message = fieldPolicyDenialMessage(error);
    expect(message).toContain('"script"');
    expect(message).toContain('"sys_script"');
    expect(message).toContain("fieldPolicy.sys_script.writable");
    // Callers classify denials on this substring.
    expect(message).toContain("denied by policy");
  });

  it("names the config key for an unreadable field", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ incident: { readable: ["number"] } })
    );
    const unreadable = denial(() =>
      resolveReadableFields("incident", { fields: "u_unknown" })
    );

    expect(unreadable.reason).toBe("unreadable_field");
    expect(fieldPolicyDenialMessage(unreadable)).toContain(
      "fieldPolicy.incident.readable"
    );
  });

  it("never reflects a sensitive field name back to the caller", () => {
    // The name itself is the signal here, so echoing it would both reflect
    // caller input into a response and hand back an oracle for the
    // sensitive-name list. A sensitive name cannot be granted by config either.
    const error = denial(() =>
      validateWritableFields("incident", { client_secret: "x" })
    );

    expect(error.reason).toBe("sensitive_field");
    expect(error.field).toBeUndefined();
    expect(fieldPolicyDenialMessage(error)).not.toContain("client_secret");
  });

  it("never carries a field value", () => {
    vi.stubEnv(
      "SN_FIELD_POLICY_DEFINITIONS",
      JSON.stringify({ sys_script: { writable: [] } })
    );
    const error = denial(() =>
      validateWritableFields("sys_script", { script: "SECRET-CANARY-VALUE" })
    );

    expect(fieldPolicyDenialMessage(error)).not.toContain("SECRET-CANARY-VALUE");
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
      "SECRET-CANARY-VALUE"
    );
  });
});
