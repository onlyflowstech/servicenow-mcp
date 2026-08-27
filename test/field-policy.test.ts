import { describe, expect, it } from "vitest";

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
  resolveReadableFields,
  snapshotPlainDataArguments,
  validateWritableFields,
} from "../src/field-policy.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";

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

  it("maps detailed and fields=all to the finite readable allowlist", () => {
    const detailed = resolveReadableFields("incident", {
      responseFormat: "detailed",
    });
    const all = resolveReadableFields("incident", { fields: " ALL " });

    expect(all).toEqual(detailed);
    expect(all).toContain("description");
    expect(all.length).toBeLessThanOrEqual(MAX_FIELDS_PER_OPERATION);
    expect(all).not.toContain("comments");
    expect(all).not.toContain("work_notes");
    expect(all).not.toContain("password");
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

  it("rejects unsupported tables, invalid names, sensitive fields, and unknown fields", () => {
    expectPolicyReason(
      () => resolveReadableFields("u_unclassified"),
      "unsupported_table"
    );
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "sys_id,bad-field" }),
      "invalid_field_selection"
    );
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "sys_id,client_secret" }),
      "sensitive_field"
    );
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: "sys_id,u_unknown" }),
      "unreadable_field"
    );
  });

  it("checks the maximum before inspecting an excessive selection", () => {
    const excessive = Array.from(
      { length: MAX_FIELDS_PER_OPERATION + 1 },
      (_, index) => `field_${index}`
    ).join(",");
    expectPolicyReason(
      () => resolveReadableFields("incident", { fields: excessive }),
      "excessive_field_selection"
    );
  });
});

describe("SNSDK-30 writable field policy", () => {
  it("keeps read and write allowlists separate", () => {
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

  it("rejects empty, non-writable, journal, sensitive, and unsupported writes", () => {
    expectPolicyReason(
      () => validateWritableFields("incident", {}),
      "invalid_write_payload"
    );
    expectPolicyReason(
      () => validateWritableFields("incident", { sys_created_on: "now" }),
      "non_writable_field"
    );
    expectPolicyReason(
      () => validateWritableFields("incident", { comments: "unsafe generic journal" }),
      "non_writable_field"
    );
    expectPolicyReason(
      () => validateWritableFields("incident", { access_token: "not-a-token" }),
      "sensitive_field"
    );
    expectPolicyReason(
      () => validateWritableFields("change_request", { state: "2" }),
      "non_writable_field"
    );
    expectPolicyReason(
      () => validateWritableFields("u_unclassified", { name: "x" }),
      "unsupported_table"
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
    expect(
      filterSchemaEntries(
        [
          { element: "number", column_label: "Number" },
          { element: "comments", column_label: "Additional comments" },
          { element: "client_secret", column_label: "Secret" },
          { element: "u_unknown", column_label: "Unknown" },
        ],
        resolveReadableFields("incident", { fields: "all" })
      )
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
    expect(preparedReadableFields(prepared, "incident")).toContain("sys_id");
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
    ["sn_atf", { action: "list", fields: "output" }, "unreadable_field"],
    ["sn_atf", { action: "suites", fields: "output" }, "unreadable_field"],
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
