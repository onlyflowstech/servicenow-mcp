import { describe, expect, it } from "vitest";

import {
  TablePolicyError,
  authorizeTableAccess,
  authorizeTableAccessPlan,
  createTableAccessPolicy,
  isHardDeniedTable,
  normalizeTableName,
  tableAccessPolicyFromEnvironment,
} from "../src/table-policy.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";

function exactTargets(...tables: string[]) {
  return [...new Set(tables.map((table) => table.trim().toLowerCase()))].map(
    (table) => ({
      table,
      kind: "canonical" as const,
      tools: [
        "sn_batch",
        "sn_create",
        "sn_delete",
        "sn_get",
        "sn_incident_add_comment",
        "sn_incident_add_work_note",
        "sn_query",
        "sn_update",
      ] as const,
      closureComplete: true as const,
      relatedTables: [table],
    })
  );
}

describe("SNSDK-29 table policy", () => {
  it("normalizes exact read/write allowlists without implying either direction", () => {
    const policy = createTableAccessPolicy({
      readTables: [" Incident ", "incident", "problem"],
      writeTables: ["CHANGE_REQUEST"],
      targets: exactTargets("incident", "problem", "change_request"),
    });

    expect(policy).toEqual({
      readTables: ["incident", "problem"],
      writeTables: ["change_request"],
      targets: exactTargets("change_request", "incident", "problem"),
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.readTables)).toBe(true);
    expect(authorizeTableAccess(policy, { operation: "read", table: "INCIDENT" }, "sn_query")).toBe(
      "incident"
    );
    expect(() =>
      authorizeTableAccess(policy, { operation: "write", table: "incident" }, "sn_update")
    ).toThrow(TablePolicyError);
    expect(() =>
      authorizeTableAccess(policy, { operation: "read", table: "change_request" }, "sn_query")
    ).toThrow(TablePolicyError);
  });

  it.each([
    "sys_user_password",
    "SYS_AUTH_PROFILE",
    "oauth_token",
    "sys_encryption_key",
    "sys_security_acl_role",
    "discovery_credentials_custom",
  ])("hard-denies %s at configuration and decision time", (table) => {
    expect(isHardDeniedTable(table)).toBe(true);
    expect(() => createTableAccessPolicy({ readTables: [table] })).toThrow(
      /prohibited/u
    );
    expect(() => createTableAccessPolicy({ writeTables: [table] })).toThrow(
      /prohibited/u
    );
    expect(() =>
      authorizeTableAccess(
        { readTables: [table], writeTables: [] },
        { operation: "read", table },
        "sn_query"
      )
    ).toThrow(TablePolicyError);
  });

  it.each([
    "",
    " ",
    "1incident",
    "incident.do",
    "incident/../sys_user_password",
    "incident%2fsys_user_password",
    "incident-name",
    "åccount",
    "a".repeat(81),
  ])("rejects malformed table identifier %j", (table) => {
    expect(() => normalizeTableName(table)).toThrow(TypeError);
    expect(() =>
      authorizeTableAccess(
        createTableAccessPolicy({
          readTables: ["incident"],
          targets: exactTargets("incident"),
        }),
        { operation: "read", table },
        "sn_query"
      )
    ).toThrow(TablePolicyError);
  });

  it("fails the complete plan before returning partial authorization", () => {
    const policy = createTableAccessPolicy({
      readTables: ["incident"],
      targets: exactTargets("incident"),
    });
    expect(() =>
      authorizeTableAccessPlan(policy, [
        { operation: "read", table: "incident" },
        { operation: "read", table: "problem" },
      ], "sn_query")
    ).toThrow(TablePolicyError);
  });

  it("loads bounded comma-separated environment policy and defaults to deny-all", () => {
    expect(tableAccessPolicyFromEnvironment({})).toEqual({
      readTables: [],
      writeTables: [],
      targets: [],
    });
    expect(
      tableAccessPolicyFromEnvironment({
        SN_ALLOWED_READ_TABLES: "incident, problem",
        SN_ALLOWED_WRITE_TABLES: "change_request",
        SN_TABLE_ACCESS_TARGETS: JSON.stringify(
          exactTargets("incident", "problem", "change_request")
        ),
      })
    ).toEqual({
      readTables: ["incident", "problem"],
      writeTables: ["change_request"],
      targets: exactTargets("change_request", "incident", "problem"),
    });
    expect(() =>
      tableAccessPolicyFromEnvironment({ SN_ALLOWED_READ_TABLES: "incident,,problem" })
    ).toThrow(/empty table/u);
  });

  it("requires trusted complete target classification for non-empty allowlists", () => {
    expect(() =>
      createTableAccessPolicy({ readTables: ["incident"] })
    ).toThrow(/targets are required/u);
    expect(() =>
      tableAccessPolicyFromEnvironment({
        SN_ALLOWED_READ_TABLES: "incident",
      })
    ).toThrow(/targets are required/u);
  });

  it("rejects aliases, views, or extensions that reach denied/unlisted tables", () => {
    expect(() =>
      createTableAccessPolicy({
        readTables: ["incident_alias", "incident"],
        targets: [
          {
            table: "incident_alias",
            kind: "alias",
            tools: ["sn_query"],
            closureComplete: true,
            relatedTables: ["incident_alias", "sys_user_password"],
          },
          ...exactTargets("incident"),
        ],
      })
    ).toThrow(/prohibited/u);

    expect(() =>
      createTableAccessPolicy({
        readTables: ["incident_view"],
        targets: [
          {
            table: "incident_view",
            kind: "view",
            tools: ["sn_query"],
            closureComplete: true,
            relatedTables: ["incident_view", "incident"],
          },
        ],
      })
    ).toThrow(/same operation permission/u);
  });

  it("requires a complete descendant closure without making dependencies addressable", () => {
    expect(() =>
      createTableAccessPolicy({
        readTables: ["task"],
        targets: [
          {
            table: "task",
            kind: "canonical",
            tools: ["sn_query"],
            closureComplete: true,
            relatedTables: ["task", "incident"],
          },
        ],
      })
    ).toThrow(/same operation permission/u);

    expect(() =>
      createTableAccessPolicy({
        readTables: ["task", "sys_user_password"],
        targets: [
          {
            table: "task",
            kind: "canonical",
            tools: ["sn_query"],
            closureComplete: true,
            relatedTables: ["task", "sys_user_password"],
          },
        ],
      })
    ).toThrow(/prohibited/u);

    const policy = createTableAccessPolicy({
      readTables: ["task", "incident"],
      targets: [
        {
          table: "task",
          kind: "canonical",
          tools: ["sn_query"],
          closureComplete: true,
          relatedTables: ["task", "incident"],
        },
      ],
    });
    expect(authorizeTableAccess(policy, { operation: "read", table: "task" }, "sn_query")).toBe(
      "task"
    );
    expect(() =>
      authorizeTableAccess(policy, { operation: "read", table: "incident" }, "sn_query")
    ).toThrow(TablePolicyError);
  });

  it("rejects target catalogs that do not explicitly attest closure completeness", () => {
    expect(() =>
      createTableAccessPolicy({
        readTables: ["incident"],
        targets: [
          {
            table: "incident",
            kind: "canonical",
            tools: ["sn_query"],
            relatedTables: ["incident"],
          } as never,
        ],
      })
    ).toThrow(/explicitly complete/u);
  });

  it("does not widen one tool's table grant to a generic table tool", () => {
    const policy = createTableAccessPolicy({
      readTables: ["sys_properties"],
      targets: [
        {
          table: "sys_properties",
          kind: "canonical",
          tools: ["sn_health"],
          closureComplete: true,
          relatedTables: ["sys_properties"],
        },
      ],
    });
    expect(
      authorizeTableAccess(
        policy,
        { operation: "read", table: "sys_properties" },
        "sn_health"
      )
    ).toBe("sys_properties");
    expect(() =>
      authorizeTableAccess(
        policy,
        { operation: "read", table: "sys_properties" },
        "sn_query"
      )
    ).toThrow(TablePolicyError);
  });
});

describe("complete registered-tool table plans", () => {
  it.each([
    ["sn_query", { table: " Incident " }, [["read", "incident"]]],
    ["sn_get", { table: "incident" }, [["read", "incident"]]],
    ["sn_create", { table: "incident" }, [["write", "incident"]]],
    ["sn_update", { table: "incident" }, [["write", "incident"]]],
    [
      "sn_incident_add_comment",
      { sys_id: "11111111111111111111111111111111", content: "comment" },
      [["write", "incident"]],
    ],
    [
      "sn_incident_add_work_note",
      { sys_id: "11111111111111111111111111111111", content: "work note" },
      [["write", "incident"]],
    ],
    ["sn_delete", { table: "incident" }, [["write", "incident"]]],
    ["sn_aggregate", { table: "incident" }, [["read", "incident"]]],
    [
      "sn_batch",
      {
        table: "incident",
        confirm: true,
        structured_query: {
          filter: { type: "equality", field: "active", operator: "eq", value: true },
        },
      },
      [
        ["read", "incident"],
        ["write", "incident"],
      ],
    ],
    [
      "sn_schema",
      { table: "incident" },
      [
        ["read", "incident"],
        ["read", "sys_dictionary"],
        ["read", "sys_db_object"],
        ["read", "sys_documentation"],
        ["read", "sys_choice"],
      ],
    ],
    ["sn_syslog", {}, [["read", "syslog"]]],
    [
      "sn_relationships",
      {},
      [
        ["read", "cmdb_ci"],
        ["read", "cmdb_rel_ci"],
      ],
    ],
    ["sn_discover", { type: "plugins" }, [["read", "v_plugin"]]],
    ["sn_atf", { action: "results" }, [["read", "sys_atf_test_result"]]],
    ["sn_script", {}, []],
  ] as const)("classifies %s before handler access", (tool, args, expected) => {
    const plan = resolveToolTableAccess(tool, args);
    expect(plan.requests.map(({ operation, table }) => [operation, table])).toEqual(
      expected
    );
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.args)).toBe(true);
    expect(Object.isFrozen(plan.requests)).toBe(true);
  });

  it("classifies action-dependent attachment, health, code-search, and ATF paths", () => {
    expect(
      resolveToolTableAccess("sn_attach", { action: "upload", table: "incident" })
        .requests
    ).toEqual([
      { operation: "write", table: "sys_attachment" },
      { operation: "write", table: "incident" },
    ]);
    expect(resolveToolTableAccess("sn_health", { check: "stats" }).requests).toEqual([
      { operation: "read", table: "incident" },
      { operation: "read", table: "change_request" },
      { operation: "read", table: "problem" },
    ]);
    expect(resolveToolTableAccess("sn_codesearch", {}).requests).toHaveLength(5);
    expect(() => resolveToolTableAccess("sn_atf", { action: "run" })).toThrow(
      TablePolicyError
    );
    expect(() =>
      resolveToolTableAccess("sn_atf", { action: "run-suite" })
    ).toThrow(TablePolicyError);
    expect(
      resolveToolTableAccess("sn_attach", {
        action: "download",
        table: "incident",
      }).requests
    ).toEqual([
      { operation: "read", table: "sys_attachment" },
      { operation: "read", table: "incident" },
    ]);
  });

  it.each([
    ["sn_health", { check: "version" }, [["read", "sys_properties"]]],
    ["sn_health", { check: "nodes" }, [["read", "sys_cluster_state"]]],
    ["sn_health", { check: "jobs" }, [["read", "sys_trigger"]]],
    ["sn_health", { check: "semaphores" }, [["read", "sys_semaphore"]]],
    [
      "sn_health",
      { check: "all" },
      [
        ["read", "sys_properties"],
        ["read", "sys_cluster_state"],
        ["read", "sys_trigger"],
        ["read", "sys_semaphore"],
        ["read", "incident"],
        ["read", "change_request"],
        ["read", "problem"],
      ],
    ],
    ["sn_attach", { action: "list", table: "incident" }, [["read", "sys_attachment"], ["read", "incident"]]],
    ["sn_attach", { action: "download", table: "incident" }, [["read", "sys_attachment"], ["read", "incident"]]],
    ["sn_attach", { action: "upload", table: "incident" }, [["write", "sys_attachment"], ["write", "incident"]]],
    ["sn_codesearch", { table: "sys_script" }, [["read", "sys_script"]]],
    ["sn_discover", { type: "tables" }, [["read", "sys_db_object"]]],
    ["sn_discover", { type: "apps" }, [["read", "sys_app"], ["read", "sys_store_app"]]],
    ["sn_discover", { type: "plugins" }, [["read", "v_plugin"]]],
    ["sn_atf", { action: "list" }, [["read", "sys_atf_test"]]],
    [
      "sn_atf",
      { action: "list", suite_name: "smoke" },
      [
        ["read", "sys_atf_test"],
        ["read", "sys_atf_test_suite"],
        ["read", "sys_atf_test_suite_test"],
      ],
    ],
    ["sn_atf", { action: "suites" }, [["read", "sys_atf_test_suite"]]],
    ["sn_atf", { action: "results" }, [["read", "sys_atf_test_result"]]],
    [
      "sn_batch",
      {
        table: "incident",
        confirm: false,
        structured_query: {
          filter: { type: "equality", field: "active", operator: "eq", value: true },
        },
      },
      [["read", "incident"]],
    ],
  ] as const)("covers the %s action branch %#", (tool, args, expected) => {
    const access = resolveToolTableAccess(tool, args);
    expect(access.requests.map(({ operation, table }) => [operation, table])).toEqual(
      expected
    );
  });

  it("denies unclassified composed and unknown operations", () => {
    expect(() => resolveToolTableAccess("sn_nl", { input: "query incidents" })).toThrow(
      TablePolicyError
    );
    expect(() => resolveToolTableAccess("sn_future", {})).toThrow(TablePolicyError);
  });
});
