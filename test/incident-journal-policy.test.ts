import { describe, expect, it, vi } from "vitest";

import {
  INCIDENT_JOURNAL_MAX_CHARACTERS,
  INCIDENT_JOURNAL_MAX_UTF8_BYTES,
  IncidentJournalPolicyError,
  incidentJournalContentSchema,
  incidentJournalMigrationMessage,
  isIncidentJournalPolicyError,
  prepareIncidentJournalArguments,
  rejectGenericIncidentJournalFields,
} from "../src/incident-journal-policy.js";

describe("SNSDK-35 incident journal content policy", () => {
  it("accepts exact character and UTF-8 byte boundaries", () => {
    expect(
      incidentJournalContentSchema.parse(
        "a".repeat(INCIDENT_JOURNAL_MAX_CHARACTERS)
      )
    ).toHaveLength(INCIDENT_JOURNAL_MAX_CHARACTERS);
    const utf8Boundary = "😀".repeat(INCIDENT_JOURNAL_MAX_UTF8_BYTES / 4);
    expect(Buffer.byteLength(utf8Boundary, "utf8")).toBe(
      INCIDENT_JOURNAL_MAX_UTF8_BYTES
    );
    expect(incidentJournalContentSchema.parse(utf8Boundary)).toBe(utf8Boundary);
    expect(
      incidentJournalContentSchema.parse("line one\r\n\tline two")
    ).toBe("line one\r\n\tline two");
  });

  it.each([
    ["empty", ""],
    ["whitespace", " \r\n\t "],
    ["character overflow", "a".repeat(INCIDENT_JOURNAL_MAX_CHARACTERS + 1)],
    [
      "UTF-8 overflow",
      "😀".repeat(INCIDENT_JOURNAL_MAX_UTF8_BYTES / 4 + 1),
    ],
    ["unpaired high surrogate", "unsafe-\uD800-text"],
    ["unpaired low surrogate", "unsafe-\uDC00-text"],
    ["NUL control", "unsafe-\u0000-text"],
    ["escape control", "unsafe-\u001b-text"],
    ["format control", "unsafe-\u202e-text"],
    ["line separator", "unsafe-\u2028-text"],
  ])("rejects %s", (_label, value) => {
    expect(incidentJournalContentSchema.safeParse(value).success).toBe(false);
  });

  it("normalizes one fixed sys_id/content pair and rejects invalid inputs", () => {
    expect(
      prepareIncidentJournalArguments({
        sys_id: " ABCDEFABCDEFABCDEFABCDEFABCDEFAB ",
        content: "bounded journal entry",
      })
    ).toEqual({
      sys_id: "abcdefabcdefabcdefabcdefabcdefab",
      content: "bounded journal entry",
    });
    expect(() =>
      prepareIncidentJournalArguments({
        sys_id: "not-an-id",
        content: "bounded journal entry",
      })
    ).toThrow(IncidentJournalPolicyError);
  });
});

describe("SNSDK-35 generic update migration policy", () => {
  it.each([
    ["comments", "sn_incident_add_comment"],
    ["work_notes", "sn_incident_add_work_note"],
  ] as const)("rejects %s with fixed dedicated-tool guidance", (field, tool) => {
    expect(() =>
      rejectGenericIncidentJournalFields({ [` ${field.toUpperCase()} `]: "canary" })
    ).toThrow(IncidentJournalPolicyError);
    expect(incidentJournalMigrationMessage(field)).toContain(tool);
    expect(incidentJournalMigrationMessage(field)).not.toContain("canary");
  });

  it("does not invoke journal value getters while rejecting the key", () => {
    const getter = vi.fn(() => "must-not-be-read");
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, "comments", { enumerable: true, get: getter });
    expect(() => rejectGenericIncidentJournalFields(payload)).toThrow(
      IncidentJournalPolicyError
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("recognizes only module-issued errors without touching hostile proxies", () => {
    const issued = new IncidentJournalPolicyError(
      "generic_journal_update",
      "comments"
    );
    expect(isIncidentJournalPolicyError(issued)).toBe(true);

    let traps = 0;
    const hostile = new Proxy(Object.create(null), {
      get() {
        traps += 1;
        throw new Error("trap must not run");
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error("trap must not run");
      },
    });
    expect(isIncidentJournalPolicyError(hostile)).toBe(false);
    expect(traps).toBe(0);

    const revocable = Proxy.revocable(Object.create(null), {});
    revocable.revoke();
    expect(() => isIncidentJournalPolicyError(revocable.proxy)).not.toThrow();
    expect(isIncidentJournalPolicyError(revocable.proxy)).toBe(false);
  });
});
