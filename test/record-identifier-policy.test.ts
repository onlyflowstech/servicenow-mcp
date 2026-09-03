import { describe, expect, it, vi } from "vitest";

import {
  configuredRecordIdentifierFields,
  MAX_RECORD_IDENTIFIER_VALUE_BYTES,
  RecordIdentifierPolicyError,
  recordIdentifierSchema,
  resolveRecordLookupSelector,
} from "../src/record-identifier-policy.js";

const SYS_ID = "ABCDEF0123456789ABCDEF0123456789";

describe("SNSDK-48 record identifier policy", () => {
  it("publishes only immutable explicit readable table-to-field pairs", () => {
    const pairs = {
      incident: ["number"],
      change_request: ["number"],
      problem: ["number"],
      sc_request: ["number"],
      sc_req_item: ["number"],
      sc_task: ["number"],
      task: ["number"],
      kb_knowledge: ["number"],
      sys_user: ["user_name"],
      sys_user_group: ["name"],
      cmdb_ci: ["name"],
      cmdb_ci_server: ["name", "host_name"],
      cmdb_ci_computer: ["name", "host_name", "serial_number"],
    } as const;
    for (const [table, fields] of Object.entries(pairs)) {
      expect(configuredRecordIdentifierFields(table)).toEqual(fields);
      expect(Object.isFrozen(configuredRecordIdentifierFields(table))).toBe(true);
      for (const field of fields) {
        expect(
          resolveRecordLookupSelector(table, {
            identifier: { field, value: "bounded-identifier" },
          })
        ).toEqual({ kind: "identifier", field, value: "bounded-identifier" });
      }
    }
    for (const unsupported of [
      "sys_user_password",
      "constructor",
      "toString",
      "__proto__",
    ]) {
      for (const operation of [
        () => configuredRecordIdentifierFields(unsupported),
        () =>
          resolveRecordLookupSelector(unsupported, {
            identifier: { field: "name", value: "must-not-cross" },
          }),
      ]) {
        expect(operation).toThrow(
          expect.objectContaining({ reason: "unsupported_table" })
        );
      }
    }
  });

  it("canonicalizes a strict sys_id selector", () => {
    expect(
      resolveRecordLookupSelector(" INCIDENT ", { sys_id: SYS_ID })
    ).toEqual({
      kind: "sys_id",
      sysId: SYS_ID.toLowerCase(),
    });
  });

  it("canonicalizes one configured readable human identifier", () => {
    expect(
      resolveRecordLookupSelector("incident", {
        identifier: { field: " NUMBER ", value: " INC0010001 " },
      })
    ).toEqual({
      kind: "identifier",
      field: "number",
      value: "INC0010001",
    });
  });

  it("requires exactly one selector", () => {
    for (const selector of [
      {},
      {
        sys_id: SYS_ID,
        identifier: { field: "number", value: "INC0010001" },
      },
    ]) {
      expect(() => resolveRecordLookupSelector("incident", selector)).toThrow(
        expect.objectContaining({ reason: "invalid_selector" })
      );
    }
  });

  it("denies unconfigured tables and fields even when the field is readable", () => {
    expect(() =>
      resolveRecordLookupSelector("syslog", {
        identifier: { field: "source", value: "node-1" },
      })
    ).toThrow(expect.objectContaining({ reason: "unsupported_table" }));
    expect(() =>
      resolveRecordLookupSelector("incident", {
        identifier: { field: "short_description", value: "Database down" },
      })
    ).toThrow(expect.objectContaining({ reason: "unauthorized_field" }));
  });

  it.each([
    "",
    "   ",
    "INC1^ORactive=true",
    "javascript:gs.getUserID()",
    "JavaScript:gs.now()",
    "INC\u0000BAD",
    "\ud800",
    "x".repeat(257),
    "界".repeat(Math.floor(MAX_RECORD_IDENTIFIER_VALUE_BYTES / 3) + 1),
  ])("rejects malformed or excessive identifier value %j", (value) => {
    expect(
      recordIdentifierSchema.safeParse({ field: "number", value }).success
    ).toBe(false);
  });

  it("accepts values at the character and UTF-8 byte boundaries", () => {
    expect(
      recordIdentifierSchema.safeParse({ field: "number", value: "x".repeat(256) })
        .success
    ).toBe(true);
    expect(
      recordIdentifierSchema.safeParse({ field: "number", value: "界".repeat(170) })
        .success
    ).toBe(true);
  });

  it("rejects accessors, Proxies, and revoked Proxies without evaluating traps", () => {
    const getter = vi.fn(() => SYS_ID);
    const accessor = Object.defineProperty({}, "sys_id", { get: getter });
    expect(() => resolveRecordLookupSelector("incident", accessor)).toThrow(
      RecordIdentifierPolicyError
    );
    expect(getter).not.toHaveBeenCalled();

    const getTrap = vi.fn(() => {
      throw new Error("must-not-run-proxy-trap");
    });
    const proxy = new Proxy({}, { get: getTrap });
    expect(() => resolveRecordLookupSelector("incident", proxy)).toThrow(
      RecordIdentifierPolicyError
    );
    expect(getTrap).not.toHaveBeenCalled();

    const nestedProxy = new Proxy({}, { get: getTrap });
    expect(() =>
      resolveRecordLookupSelector("incident", { identifier: nestedProxy })
    ).toThrow(RecordIdentifierPolicyError);
    expect(getTrap).not.toHaveBeenCalled();

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => resolveRecordLookupSelector("incident", revoked.proxy)).toThrow(
      RecordIdentifierPolicyError
    );
    const nestedRevoked = Proxy.revocable({}, {});
    nestedRevoked.revoke();
    expect(() =>
      resolveRecordLookupSelector("incident", {
        identifier: nestedRevoked.proxy,
      })
    ).toThrow(RecordIdentifierPolicyError);
  });
});
