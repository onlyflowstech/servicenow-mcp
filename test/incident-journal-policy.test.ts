import { describe, expect, it } from "vitest";

import * as incidentJournalPolicy from "../src/incident-journal-policy.js";
import {
  INCIDENT_JOURNAL_MAX_CHARACTERS,
  INCIDENT_JOURNAL_MAX_UTF8_BYTES,
  IncidentJournalPolicyError,
  incidentJournalContentSchema,
  incidentJournalMigrationMessage,
  isIncidentJournalPolicyError,
  prepareIncidentJournalArguments,
} from "../src/incident-journal-policy.js";
import { prepareWriteFieldValues } from "../src/write-value-policy.js";

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

describe("generic journal writes", () => {
  it("no longer rejects journal fields by name", () => {
    // The name-based deny ran ahead of field policy and could not be lifted
    // by configuration. Field policy now decides; the value policy applies
    // the journal bounds.
    expect(Object.keys(incidentJournalPolicy)).not.toContain(
      "rejectGenericIncidentJournalFields"
    );
    for (const field of ["comments", "work_notes"] as const) {
      expect(
        prepareWriteFieldValues("update", "incident", {
          [` ${field.toUpperCase()} `]: "appended entry",
        })
      ).toEqual({ [field]: "appended entry" });
    }
  });

  it("applies the same content bounds as the dedicated journal tools", () => {
    for (const value of [
      "a".repeat(INCIDENT_JOURNAL_MAX_CHARACTERS + 1),
      "unsafe-\u0000-text",
      " \r\n\t ",
    ]) {
      expect(incidentJournalContentSchema.safeParse(value).success).toBe(false);
      expect(() =>
        prepareWriteFieldValues("update", "problem", { work_notes: value })
      ).toThrow(expect.objectContaining({ reason: "invalid_value" }));
    }
  });

  it.each([
    ["comments", "sn_incident_add_comment"],
    ["work_notes", "sn_incident_add_work_note"],
  ] as const)(
    "keeps fixed %s migration text for the dispatcher's legacy branch",
    (field, tool) => {
      expect(incidentJournalMigrationMessage(field)).toContain(tool);
    }
  );

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
