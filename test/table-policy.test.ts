import { describe, expect, it } from "vitest";

import {
  TablePolicyError,
  authorizeTableAccess,
  authorizeTableAccessPlan,
  createTableAccessPolicy,
  normalizeTableName,
  tableAccessPolicyFromEnvironment,
  tablePolicyDenialMessage,
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

  it("supports wildcard read allowlists without per-table target babysitting", () => {
    const policy = createTableAccessPolicy({
      readTables: [" * "],
      writeTables: [],
    });

    expect(policy).toEqual({ readTables: ["*"], writeTables: [], targets: [] });
    expect(
      authorizeTableAccess(
        policy,
        { operation: "read", table: "u_custom_table" },
        "sn_query"
      )
    ).toBe("u_custom_table");
    expect(
      authorizeTableAccess(policy, { operation: "read", table: "problem" }, "sn_get")
    ).toBe("problem");
    // "*" means every table. The MCP keeps no built-in denials; ServiceNow
    // evaluates its own ACLs per authenticated user on the read itself.
    expect(
      authorizeTableAccess(policy, { operation: "read", table: "sys_user_password" }, "sn_query")
    ).toBe("sys_user_password");
    // Read access still never implies write access.
    expect(() =>
      authorizeTableAccess(policy, { operation: "write", table: "u_custom_table" }, "sn_update")
    ).toThrow(TablePolicyError);
  });

  it("supports wildcard write allowlists without implying read access", () => {
    const policy = createTableAccessPolicy({
      readTables: [],
      writeTables: ["*"],
    });

    expect(
      authorizeTableAccess(
        policy,
        { operation: "write", table: "u_custom_table" },
        "sn_update"
      )
    ).toBe("u_custom_table");
    expect(() =>
      authorizeTableAccess(policy, { operation: "read", table: "u_custom_table" }, "sn_query")
    ).toThrow(TablePolicyError);
    expect(
      authorizeTableAccess(policy, { operation: "write", table: "oauth_token" }, "sn_update")
    ).toBe("oauth_token");
  });

  it("lets explicit wildcard targets narrow tools and related-table closure", () => {
    const policy = createTableAccessPolicy({
      readTables: ["*"],
      targets: [
        {
          table: "incident",
          kind: "canonical",
          tools: ["sn_get"],
          closureComplete: true,
          relatedTables: ["incident", "task"],
        },
      ],
    });

    expect(
      authorizeTableAccess(policy, { operation: "read", table: "incident" }, "sn_get")
    ).toBe("incident");
    expect(() =>
      authorizeTableAccess(policy, { operation: "read", table: "incident" }, "sn_query")
    ).toThrow(TablePolicyError);
    expect(
      authorizeTableAccess(policy, { operation: "read", table: "problem" }, "sn_query")
    ).toBe("problem");
  });

  it("loads wildcard table allowlists from environment", () => {
    expect(
      tableAccessPolicyFromEnvironment({
        SN_ALLOWED_READ_TABLES: "*",
        SN_ALLOWED_WRITE_TABLES: "incident,*",
      })
    ).toEqual({
      readTables: ["*"],
      writeTables: ["*", "incident"],
      targets: [],
    });
  });

  // The MCP carries no built-in table denials: the per-profile tableAccess
  // config is the sole MCP-side authority, and ServiceNow's own per-user ACLs
  // are the real boundary. These tables were formerly denied unconditionally;
  // they now follow exactly the same rules as every other table.
  it.each([
    "sys_user_password",
    "sys_auth_profile",
    "oauth_token",
    "sys_encryption_key",
    "sys_security_acl_role",
    "discovery_credentials_custom",
  ])("lets tableAccess alone decide %s", (table) => {
    // Not granted -> denied, like any unlisted table.
    expect(() =>
      authorizeTableAccess(
        createTableAccessPolicy({ readTables: ["incident"], targets: exactTargets("incident") }),
        { operation: "read", table },
        "sn_query"
      )
    ).toThrow(TablePolicyError);

    // Explicitly granted -> allowed. Configuration is accepted, not rejected.
    const granted = createTableAccessPolicy({
      readTables: [table],
      targets: exactTargets(table),
    });
    expect(granted.readTables).toEqual([table]);
    expect(
      authorizeTableAccess(granted, { operation: "read", table }, "sn_query")
    ).toBe(table);

    // A read grant still never implies a write grant.
    expect(() =>
      authorizeTableAccess(granted, { operation: "write", table }, "sn_update")
    ).toThrow(TablePolicyError);
  });

  it("still rejects a forged policy object that was never issued here", () => {
    // Removing the deny list must not weaken the issued-policy check.
    expect(() =>
      authorizeTableAccess(
        { readTables: ["incident"], writeTables: [] },
        { operation: "read", table: "incident" },
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
    ).toThrow(/same operation permission/u);

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

  it("requires each declared related table to carry the operation, without making it addressable", () => {
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

    // Formerly rejected because sys_user_password was hard-denied. The closure
    // check survives on its own terms: both tables carry the read grant, so the
    // target is now accepted.
    const closure = createTableAccessPolicy({
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
    });
    expect(closure.readTables).toEqual(["sys_user_password", "task"]);

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

  it("rejects a target that does not set closureComplete: true", () => {
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
    ).toThrow(/must set closureComplete: true/u);
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
    expect(resolveToolTableAccess("sn_codesearch", {}).requests).toHaveLength(6);
    expect(resolveToolTableAccess("sn_atf", { action: "run" }).requests).toEqual([]);
    expect(resolveToolTableAccess("sn_atf", { action: "run-suite" }).requests).toEqual([]);
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

describe("denial detail", () => {
  const policy = createTableAccessPolicy({
    readTables: ["sys_script_include", "incident"],
    targets: [
      {
        table: "sys_script_include",
        kind: "canonical",
        tools: ["sn_query"],
        closureComplete: true,
        relatedTables: ["sys_script_include"],
      },
      {
        table: "incident",
        kind: "canonical",
        tools: ["sn_query"],
        closureComplete: true,
        relatedTables: ["incident"],
      },
    ],
  });

  function denial(request: Parameters<typeof authorizeTableAccess>[1], tool: string) {
    try {
      authorizeTableAccess(policy, request, tool);
    } catch (error) {
      return error as TablePolicyError;
    }
    throw new Error("expected a denial");
  }

  it("says whether the table is missing or only the tool is", () => {
    expect(denial({ operation: "read", table: "problem" }, "sn_codesearch").detail).toEqual({
      reason: "not_granted",
      operation: "read",
      table: "problem",
      tool: "sn_codesearch",
    });
    expect(
      denial({ operation: "read", table: "SYS_SCRIPT_INCLUDE" }, "sn_codesearch").detail
    ).toEqual({
      reason: "tool_not_bound",
      operation: "read",
      table: "sys_script_include",
      tool: "sn_codesearch",
    });
    expect(denial({ operation: "write", table: "incident" }, "sn_update").detail?.reason).toBe(
      "not_granted"
    );
  });

  it("renders text that names the table, the tool and the grant, and only those", () => {
    const text = tablePolicyDenialMessage(
      denial({ operation: "read", table: "sys_script_include" }, "sn_codesearch")
    );
    expect(text).toBe(
      'Table access was denied by policy: "sys_script_include" is granted to this profile, ' +
        "but not for sn_codesearch. To allow it, run: servicenow-mcp-setup grant --profile " +
        "<profile> --read sys_script_include --tools sn_codesearch, then restart the MCP " +
        "client. The tools already allowed on that table stay allowed."
    );
    expect(text).not.toContain("incident");
  });

  it("keeps the fixed sentence without detail, and drops a malformed detail", () => {
    expect(tablePolicyDenialMessage(new TablePolicyError())).toBe(
      "Table access was denied by policy."
    );
    const hostile = new TablePolicyError({
      reason: "not_granted",
      operation: "read",
      table: "Bad Table; <script>",
      tool: "sn_codesearch ; rm",
    });
    expect(tablePolicyDenialMessage(hostile)).toBe("Table access was denied by policy.");
    const unknown = new TablePolicyError({ reason: "other" as never });
    expect(unknown.detail).toBeUndefined();
    expect(Object.isFrozen(hostile)).toBe(true);
  });

  it("describes a search that may read none of its fixed tables", () => {
    const text = tablePolicyDenialMessage(
      new TablePolicyError({
        reason: "none_granted",
        operation: "read",
        tool: "sn_codesearch",
        tables: ["sys_script", "sys_script_include"],
      })
    );
    expect(text).toContain("does not allow sn_codesearch to read any of the tables it searches");
    expect(text).toContain("(sys_script, sys_script_include)");
    expect(text).toContain("--read <table> --tools sn_codesearch");
  });
});

describe("the code search plan under a partial grant", () => {
  const policy = createTableAccessPolicy({
    readTables: ["sys_script_include", "sys_ui_script", "sys_script"],
    targets: [
      { table: "sys_script_include", kind: "canonical", tools: ["sn_codesearch"], closureComplete: true, relatedTables: ["sys_script_include"] },
      { table: "sys_ui_script", kind: "canonical", tools: ["sn_codesearch", "sn_query"], closureComplete: true, relatedTables: ["sys_ui_script"] },
      { table: "sys_script", kind: "canonical", tools: ["sn_query"], closureComplete: true, relatedTables: ["sys_script"] },
    ],
  });
  const reads = (access: ReturnType<typeof resolveToolTableAccess>) =>
    access.requests.map(({ operation, table }) => `${operation}:${table}`);

  it("asks for every code table when no policy is given, as before", () => {
    expect(reads(resolveToolTableAccess("sn_codesearch", { search_term: "x" }))).toEqual([
      "read:sys_script_include",
      "read:sys_script",
      "read:sys_ui_script",
      "read:sys_script_client",
      "read:sys_ws_operation",
      "read:sys_module",
    ]);
  });

  it("asks only for the tables the profile holds for the tool, which the dispatcher then authorizes", () => {
    const access = resolveToolTableAccess("sn_codesearch", { search_term: "x" }, undefined, policy);
    expect(reads(access)).toEqual(["read:sys_script_include", "read:sys_ui_script"]);
    expect(() => authorizeTableAccessPlan(policy, access.requests, "sn_codesearch")).not.toThrow();
  });

  it("fails, saying none of the tables is allowed, when the profile holds none for the tool", () => {
    const none = createTableAccessPolicy({
      readTables: ["sys_script"],
      targets: [
        { table: "sys_script", kind: "canonical", tools: ["sn_query"], closureComplete: true, relatedTables: ["sys_script"] },
      ],
    });
    try {
      resolveToolTableAccess("sn_codesearch", { search_term: "x" }, undefined, none);
      throw new Error("expected a denial");
    } catch (error) {
      expect((error as TablePolicyError).detail).toMatchObject({
        reason: "none_granted",
        operation: "read",
        tool: "sn_codesearch",
      });
    }
  });

  it("decides a named table by the table policy as before", () => {
    expect(() =>
      resolveToolTableAccess("sn_codesearch", { search_term: "x", table: "sys_script" }, undefined, policy)
    ).not.toThrow();
    const denied = resolveToolTableAccess("sn_codesearch", { search_term: "x", table: "sys_script" }, undefined, policy);
    expect(() => authorizeTableAccessPlan(policy, denied.requests, "sn_codesearch")).toThrow(TablePolicyError);
  });
});
