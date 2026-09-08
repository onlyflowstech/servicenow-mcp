import { describe, expect, it, vi } from "vitest";

import {
  INCIDENT_LONG_TEXT_MAX_CHARACTERS,
  GENERIC_WRITE_VALUE_MAX_CHARACTERS,
  INCIDENT_SHORT_DESCRIPTION_MAX_CHARACTERS,
  WriteValuePolicyError,
  writeValueDenialMessage,
  isWriteValuePolicyError,
  prepareWriteFieldValues,
} from "../src/write-value-policy.js";
import { FieldPolicyError } from "../src/field-policy.js";

const SYS_ID = "ABCDEF0123456789ABCDEF0123456789";

describe("SNSDK-49 bounded write-value policy", () => {
  it("canonicalizes the complete approved incident value surface immutably", () => {
    const source = {
      short_description: "  Database unavailable  ",
      description: "First line\nSecond line ^ literal text",
      caller_id: SYS_ID,
      assignment_group: SYS_ID,
      assigned_to: SYS_ID,
      impact: 1,
      urgency: "2",
      priority: "05",
      category: " software ",
      subcategory: "database-client",
      state: "-01",
      close_code: "Solved (Permanently)",
      close_notes: "First line\r\nSecond line\tindented",
      contact_type: "self-service",
    };
    const before = JSON.stringify(source);
    const prepared = prepareWriteFieldValues("create", " INCIDENT ", source);

    expect(prepared).toEqual({
      short_description: "Database unavailable",
      description: "First line\nSecond line ^ literal text",
      caller_id: SYS_ID.toLowerCase(),
      assignment_group: SYS_ID.toLowerCase(),
      assigned_to: SYS_ID.toLowerCase(),
      impact: "1",
      urgency: "2",
      priority: "5",
      category: "software",
      subcategory: "database-client",
      state: "-1",
      close_code: "Solved (Permanently)",
      close_notes: "First line\r\nSecond line\tindented",
      contact_type: "self-service",
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("requires a nonblank create short_description on incident only", () => {
    for (const operation of [
      () => prepareWriteFieldValues("create", "incident", { description: "x" }),
      () => prepareWriteFieldValues("create", "incident", { short_description: "  " }),
    ]) {
      expect(operation).toThrow(WriteValuePolicyError);
    }
    // Table identity is the configured table policy's decision, not this
    // module's: another table simply gets the generic value bounds.
    expect(
      prepareWriteFieldValues("create", "problem", { short_description: "x" })
    ).toEqual({ short_description: "x" });
    expect(
      prepareWriteFieldValues("create", "sys_script_include", { name: "Probe" })
    ).toEqual({ name: "Probe" });
    expect(() =>
      prepareWriteFieldValues("update", "incident", {})
    ).toThrow(FieldPolicyError);
    expect(() =>
      Reflect.apply(prepareWriteFieldValues, undefined, [
        "delete",
        "incident",
        { short_description: "must-not-cross" },
      ])
    ).toThrow(expect.objectContaining({ reason: "invalid_mode" }));
  });

  it("accepts exact text boundaries and rejects character or byte overflow", () => {
    expect(
      prepareWriteFieldValues("create", "incident", {
        short_description: "x".repeat(INCIDENT_SHORT_DESCRIPTION_MAX_CHARACTERS),
        description: "界".repeat(INCIDENT_LONG_TEXT_MAX_CHARACTERS),
      })
    ).toBeDefined();
    for (const fields of [
      {
        short_description: "x".repeat(
          INCIDENT_SHORT_DESCRIPTION_MAX_CHARACTERS + 1
        ),
      },
      { short_description: "🚨".repeat(161) },
      {
        short_description: "safe",
        description: "x".repeat(INCIDENT_LONG_TEXT_MAX_CHARACTERS + 1),
      },
    ]) {
      expect(() =>
        prepareWriteFieldValues("create", "incident", fields)
      ).toThrow(expect.objectContaining({ reason: "invalid_value" }));
    }
  });

  it("canonicalizes bounded numeric choices and signed state tokens", () => {
    expect(
      prepareWriteFieldValues("update", "incident", {
        impact: "03",
        urgency: 2,
        priority: "005",
        state: "-0007",
      })
    ).toEqual({ impact: "3", urgency: "2", priority: "5", state: "-7" });
    for (const fields of [
      { impact: 0 },
      { urgency: 4 },
      { priority: 6 },
      { state: "10000" },
      { state: "1.5" },
    ]) {
      expect(() =>
        prepareWriteFieldValues("update", "incident", fields)
      ).toThrow(WriteValuePolicyError);
    }
  });

  it("rejects empty, control, hostile choice, reference, and non-string values", () => {
    for (const fields of [
      { description: "" },
      { close_notes: "line\u0000secret" },
      { short_description: "line\nsecond" },
      { category: "x^ORactive=true" },
      { category: "javascript:gs.getUserID()" },
      { caller_id: "not-a-sys-id" },
      { assignment_group: null },
      { assigned_to: { value: SYS_ID } },
      { contact_type: false },
      { description: "\ud800" },
    ]) {
      expect(() =>
        prepareWriteFieldValues("update", "incident", fields)
      ).toThrow();
    }
  });

  it("rejects accessors, Proxies, constructor, and __proto__ keys without traps", () => {
    const trap = vi.fn(() => {
      throw new Error("must-not-run-write-policy-trap");
    });
    const accessor = Object.defineProperty({}, "short_description", { get: trap });
    const nestedProxy = new Proxy({}, { get: trap });
    const outerProxy = new Proxy({ short_description: "safe" }, { get: trap });
    const inheritedKeys = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inheritedKeys, "short_description", {
      value: "safe",
      enumerable: true,
    });
    Object.defineProperty(inheritedKeys, "constructor", {
      value: "must-not-cross",
      enumerable: true,
    });
    Object.defineProperty(inheritedKeys, "__proto__", {
      value: "must-not-cross",
      enumerable: true,
    });

    for (const fields of [
      accessor,
      outerProxy,
      { short_description: "safe", description: nestedProxy },
      inheritedKeys,
    ]) {
      expect(() =>
        prepareWriteFieldValues("create", "incident", fields)
      ).toThrow();
    }
    expect(trap).not.toHaveBeenCalled();
    expect({}.constructor).toBe(Object);
  });
});

describe("write-value denial classification", () => {
  it("recognizes only errors this module issued", () => {
    let issued: unknown;
    try {
      prepareWriteFieldValues("update", "sys_script_include", {
        script: "line\u0000hidden",
      });
    } catch (error) {
      issued = error;
    }
    expect(isWriteValuePolicyError(issued)).toBe(true);
    expect((issued as WriteValuePolicyError).reason).toBe("invalid_value");

    for (const impostor of [
      undefined,
      null,
      "WriteValuePolicyError",
      new Error("Write denied by the bounded value policy"),
      Object.assign(new Error("x"), { name: "WriteValuePolicyError" }),
      new FieldPolicyError("non_writable_field"),
      Object.create(WriteValuePolicyError.prototype) as unknown,
    ]) {
      expect(isWriteValuePolicyError(impostor)).toBe(false);
    }
  });

  it("reports a malformed table name without echoing it back", () => {
    let unnamed: WriteValuePolicyError | undefined;
    try {
      prepareWriteFieldValues("create", "not a table^name", {
        short_description: "probe",
      });
    } catch (error) {
      unnamed = error as WriteValuePolicyError;
    }
    expect(unnamed?.reason).toBe("unsupported_table");
    expect(unnamed?.table).toBeUndefined();
    expect(writeValueDenialMessage(unnamed!, "sn_create")).not.toContain(
      "not a table^name"
    );
    // Only an already-normalized identifier is ever interpolated.
    expect(
      writeValueDenialMessage(
        new WriteValuePolicyError("unsupported_table", "Robert'); DROP--")
      )
    ).not.toContain("DROP");
  });

  it("distinguishes every failure reason instead of flattening them", () => {
    const messages = (
      [
        "unsupported_table",
        "missing_short_description",
        "invalid_value",
        "invalid_mode",
      ] as const
    ).map((reason) =>
      writeValueDenialMessage(
        new WriteValuePolicyError(reason, "sys_script_include"),
        "sn_update"
      )
    );
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message).toContain("Write denied by policy:");
      expect(message).toContain("sn_update");
      // The regression this locks down: a value denial must never be reported
      // as a table denial, and must never name the table-access config key.
      expect(message).not.toMatch(/Table access was denied by policy/u);
      expect(message).not.toContain("writeTables");
    }
    expect(messages[0]).toContain('Table "sys_script_include" is not usable');
    expect(messages[1]).toContain("short_description");
    expect(messages[2]).toContain("field policy");
  });

  it("falls back to a neutral subject when no tool name is supplied", () => {
    const message = writeValueDenialMessage(
      new WriteValuePolicyError("invalid_value", "problem")
    );
    expect(message).toContain("This tool");
  });

  it("bounds generic values without gating which table is written", () => {
    expect(
      prepareWriteFieldValues("update", "sys_script_include", {
        script: "var X = Class.create();\n\tX.prototype = {};",
        active: true,
        order: 100,
        description: "",
      })
    ).toEqual({
      script: "var X = Class.create();\n\tX.prototype = {};",
      active: "true",
      order: "100",
      description: "",
    });

    for (const fields of [
      { script: "x".repeat(GENERIC_WRITE_VALUE_MAX_CHARACTERS + 1) },
      { script: "line\u0000hidden" },
      { script: "\ud800" },
      { script: null },
      { order: 1.5 },
    ]) {
      expect(() =>
        prepareWriteFieldValues("update", "sys_script_include", fields)
      ).toThrow(WriteValuePolicyError);
    }
    // A non-scalar payload is rejected by the shared field policy before the
    // value bounds are reached, and stays classified as a field denial.
    expect(() =>
      prepareWriteFieldValues("update", "sys_script_include", {
        script: { toString: () => "hostile" },
      })
    ).toThrow(FieldPolicyError);
  });
});
