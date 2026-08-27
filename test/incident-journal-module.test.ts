import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import type { ServiceNowToolHandlerServices } from "../src/tools/index.js";
import {
  incidentCommentToolModule,
  incidentJournalInputSchema,
  incidentWorkNoteToolModule,
} from "../src/tools/incident-journal-module.js";

const PROFILE = "journal-prod";
const SYS_ID = "1234567890abcdef1234567890abcdef";
const modules = [incidentCommentToolModule, incidentWorkNoteToolModule] as const;

function services(patch: ReturnType<typeof vi.fn>): ServiceNowToolHandlerServices {
  return {
    serviceNow: { patch } as unknown as ServiceNowOperations,
    settings: {
      instance: "https://journal.service-now.com",
      displayValue: "true",
      relDepth: 3,
    },
    context: {
      correlationId: "snsdk-35-module",
      identity: { ownerId: "owner", clientId: "client" },
      profile: {
        name: PROFILE,
        instance: "https://journal.service-now.com",
      },
      effectivePolicy: {
        id: "journal-policy",
        revision: "v1",
        tableAccess: { readTables: [], writeTables: [], targets: [] },
      },
      signal: new AbortController().signal,
    },
    policy: {
      id: "journal-policy",
      revision: "v1",
      tableAccess: { readTables: [], writeTables: [], targets: [] },
    },
    logger: { write: () => {} },
  };
}

describe("SNSDK-35 dedicated incident journal modules", () => {
  it("publishes exact append-only contracts and fixed incident access plans", () => {
    expect(modules.map(({ definition }) => definition.name)).toEqual([
      "sn_incident_add_comment",
      "sn_incident_add_work_note",
    ]);
    for (const module of modules) {
      expect(module.definition.annotations).toEqual({
        title: expect.any(String),
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(module.requirements).toEqual({
        permissions: ["write"],
        tables: { kind: "static", names: ["incident"] },
        apis: ["table"],
        fieldPolicies: ["write"],
        capabilities: [
          `incident:journal:${
            module.definition.name === "sn_incident_add_comment"
              ? "comments"
              : "work_notes"
          }`,
        ],
      });
      const access = module.resolveAccess({
        profile: PROFILE,
        sys_id: SYS_ID.toUpperCase(),
        content: "append once",
      }, {
        id: "ignored",
        revision: "ignored",
        tableAccess: { readTables: [], writeTables: [], targets: [] },
      });
      expect(access.args).toMatchObject({
        profile: PROFILE,
        sys_id: SYS_ID,
        content: "append once",
      });
      expect(access.requests).toEqual([
        { operation: "write", table: "incident" },
      ]);
    }
  });

  it("exposes only profile, sys_id, and bounded content in the strict input", () => {
    expect(
      incidentJournalInputSchema.parse({
        profile: PROFILE,
        sys_id: SYS_ID,
        content: "allowed\n\tcontent",
      })
    ).toEqual({ profile: PROFILE, sys_id: SYS_ID, content: "allowed\n\tcontent" });
    for (const extra of [
      { table: "incident" },
      { fields: { comments: "bypass" } },
      { query: "sys_idISNOTEMPTY" },
    ]) {
      expect(
        incidentJournalInputSchema.safeParse({
          profile: PROFILE,
          sys_id: SYS_ID,
          content: "append",
          ...extra,
        }).success
      ).toBe(false);
    }
  });

  it.each([
    [incidentCommentToolModule, "comments"],
    [incidentWorkNoteToolModule, "work_notes"],
  ] as const)(
    "appends %s twice through the fixed path and never returns journal content",
    async (module, field) => {
      const canary = `SNSDK-35-${field}-must-not-return`;
      const patch = vi.fn(async () => ({
        result: {
          sys_id: SYS_ID,
          [field]: canary,
          password: "upstream-secret",
        },
      }));
      const servicePorts = services(patch);

      const first = await module.invoke(
        { profile: PROFILE, sys_id: SYS_ID, content: canary },
        servicePorts
      );
      const second = await module.invoke(
        { profile: PROFILE, sys_id: SYS_ID, content: canary },
        servicePorts
      );

      expect(patch).toHaveBeenCalledTimes(2);
      for (const call of patch.mock.calls) {
        expect(call[0]).toBe(`/api/now/table/incident/${SYS_ID}`);
        expect(call[1]).toEqual({ [field]: canary });
        expect(Reflect.ownKeys(call[1] as object)).toEqual([field]);
      }
      for (const result of [first, second]) {
        expect(result.isError).toBeUndefined();
        expect(result.content).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain(canary);
        expect(JSON.stringify(result)).not.toContain("upstream-secret");
        expect(JSON.parse(result.content[0].text)).toEqual({
          status: "appended",
          sys_id: SYS_ID,
          journal_field: field,
        });
      }
    }
  );

  it("keeps access validation within a bounded local budget", () => {
    const started = performance.now();
    for (let index = 0; index < 5_000; index += 1) {
      incidentCommentToolModule.resolveAccess({
        profile: PROFILE,
        sys_id: SYS_ID,
        content: `bounded-${index}`,
      }, {
        id: "ignored",
        revision: "ignored",
        tableAccess: { readTables: [], writeTables: [], targets: [] },
      });
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
