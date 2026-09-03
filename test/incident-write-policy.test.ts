import { describe, expect, it, vi } from "vitest";

import {
  INCIDENT_LONG_TEXT_MAX_CHARACTERS,
  INCIDENT_SHORT_DESCRIPTION_MAX_CHARACTERS,
  IncidentWritePolicyError,
  prepareIncidentWriteFields,
} from "../src/incident-write-policy.js";
import { FieldPolicyError } from "../src/field-policy.js";

const SYS_ID = "ABCDEF0123456789ABCDEF0123456789";

describe("SNSDK-49 incident write-value policy", () => {
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
    const prepared = prepareIncidentWriteFields("create", " INCIDENT ", source);

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

  it("requires incident and a nonblank create short_description", () => {
    for (const operation of [
      () => prepareIncidentWriteFields("create", "problem", { short_description: "x" }),
      () => prepareIncidentWriteFields("create", "incident", { description: "x" }),
      () => prepareIncidentWriteFields("create", "incident", { short_description: "  " }),
    ]) {
      expect(operation).toThrow(IncidentWritePolicyError);
    }
    expect(() =>
      prepareIncidentWriteFields("update", "incident", {})
    ).toThrow(FieldPolicyError);
    expect(() =>
      Reflect.apply(prepareIncidentWriteFields, undefined, [
        "delete",
        "incident",
        { short_description: "must-not-cross" },
      ])
    ).toThrow(expect.objectContaining({ reason: "invalid_mode" }));
  });

  it("accepts exact text boundaries and rejects character or byte overflow", () => {
    expect(
      prepareIncidentWriteFields("create", "incident", {
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
        prepareIncidentWriteFields("create", "incident", fields)
      ).toThrow(expect.objectContaining({ reason: "invalid_value" }));
    }
  });

  it("canonicalizes bounded numeric choices and signed state tokens", () => {
    expect(
      prepareIncidentWriteFields("update", "incident", {
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
        prepareIncidentWriteFields("update", "incident", fields)
      ).toThrow(IncidentWritePolicyError);
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
        prepareIncidentWriteFields("update", "incident", fields)
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
        prepareIncidentWriteFields("create", "incident", fields)
      ).toThrow();
    }
    expect(trap).not.toHaveBeenCalled();
    expect({}.constructor).toBe(Object);
  });
});
