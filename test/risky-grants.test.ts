import { describe, expect, it } from "vitest";

import {
  MID_SERVER_QUEUE_NOTE,
  RISKY_WRITE_TABLES,
  isMidServerQueue,
  riskyGrantWarning,
  riskyWriteTables,
} from "../src/risky-grants.js";

describe("server-side script tables in the risky-write list", () => {
  it.each([
    "sysevent_script_action",
    "sys_script_fix",
    "sys_script_email",
    "sys_ui_action",
    "sys_ui_page",
    "sys_ui_macro",
    "sp_widget",
    "sysevent_in_email_action",
    "sys_transform_map",
    "sys_transform_script",
    "ecc_agent_script_include",
  ])("flags %s when named, and under a write wildcard", (table) => {
    expect(riskyWriteTables([table, "incident"])).toEqual([table]);
    expect(riskyWriteTables(["*"])).toContain(table);
    expect(riskyGrantWarning([table], "dev")).toContain(`privilege-sensitive tables: ${table}`);
  });

  it("has no duplicates", () => {
    expect(new Set(RISKY_WRITE_TABLES).size).toBe(RISKY_WRITE_TABLES.length);
  });
});

describe("the MID Server queue in the risky-write list", () => {
  it("lists ecc_queue, and a write wildcard covers it", () => {
    expect(RISKY_WRITE_TABLES).toContain("ecc_queue");
    expect(riskyWriteTables(["*"])).toContain("ecc_queue");
  });

  it("flags ecc_queue and its numbered rotation shards when named", () => {
    expect(riskyWriteTables(["incident", "ecc_queue"])).toEqual(["ecc_queue"]);
    expect(riskyWriteTables(["ecc_queue0003", "ecc_queue0000", "incident"])).toEqual([
      "ecc_queue0000",
      "ecc_queue0003",
    ]);
  });

  it.each(["ecc_queue_0001", "ecc_queue_example", "xecc_queue0001", "ecc_queue0001a", "ecc_queuex", "ecc_event"])(
    "does not flag %s",
    (table) => {
      expect(isMidServerQueue(table)).toBe(false);
      expect(riskyWriteTables([table])).toEqual([]);
    }
  );

  it("says what a write there can do, only when the grant reaches it", () => {
    const named = riskyGrantWarning(["ecc_queue0001"], "dev");
    expect(named).toContain("privilege-sensitive tables: ecc_queue0001");
    expect(named).toContain(MID_SERVER_QUEUE_NOTE);
    expect(riskyGrantWarning(["*"], "dev")).toContain(MID_SERVER_QUEUE_NOTE);
    expect(riskyGrantWarning(["sys_script"], "dev")).not.toContain(MID_SERVER_QUEUE_NOTE);
    expect(riskyGrantWarning(["incident"], "dev")).toBeUndefined();
    expect(MID_SERVER_QUEUE_NOTE).toBe("Records written to ecc_queue can run commands on MID Server hosts.");
  });
});
