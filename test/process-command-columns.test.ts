/**
 * Process command-line columns (`command` and `parameters` on
 * `cmdb_running_process`) follow the record payload column rules: no wildcard
 * covers them, for reads or writes. A column is read only where the profile's
 * own field-policy entry for that table lists it in `readable`, and written
 * only where that entry lists it in `writable`. A table that extends
 * `cmdb_running_process` has the same columns wherever the call knows its
 * extension chain.
 */
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import {
  authorizeRawEncodedRead,
  createEncodedQueryAccessPolicy,
  SUPPORTED_ENCODED_QUERY_OPERATORS,
} from "../src/encoded-query-policy.js";
import type { ExecutionContextDependencies, ToolAuditRecord } from "../src/execution-context.js";
import {
  COMMAND_LINE_ANY_TABLE_FIELD_NAMES,
  EXPLICIT_READ_FIELD_NAMES,
  FieldPolicyError,
  explicitReadColumns,
  fieldPolicyDenialMessage,
  filterAggregateResult,
  filterReadableRecord,
  queryDeniedFields,
  readableSelectionForTable,
  resolveReadableFields,
  runWithFieldPolicyConfiguration,
  validateFieldPolicyConfiguration,
  validateWritableFields,
  type FieldPolicyConfigurationInput,
} from "../src/field-policy.js";
import {
  fieldTypesFromRows,
  hiddenFieldScope,
  runWithHiddenFieldScope,
  type FieldTypeLoader,
} from "../src/hidden-values.js";
import type { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";
import { fieldTypeAnswer, noHiddenFieldTypes, type FieldTypeFixture } from "./fixtures/field-types.js";

const TABLE = "cmdb_running_process";
const COLUMNS = ["command", "parameters", "key_parameters"] as const;
/** Every guarded table and its columns, as the policy lists them. */
const GUARDED: Readonly<Record<string, readonly string[]>> = {
  cmdb_running_process: ["command", "parameters", "key_parameters"],
  cmdb_ci_appl: ["running_process_command", "running_process_key_parameters"],
  cmdb_tcp_connection: ["command"],
  cmdb_tcp_half: ["command"],
  cmdb_ci_docker_container: ["command"],
  cmdb_ci_oslv_image: ["command"],
  cmdb_ci_appl_rabbitmq_cluster: ["command_line"],
  cmdb_ci_appl_mongo_config_serv: ["command_line"],
  cmdb_ci_appl_ca_id_man: ["command_line"],
  cmdb_ci_appl_generic: ["command_line"],
  cmdb_ci_appl_rabbitmq: ["command_line"],
  cmdb_ci_appl_ca_ent_man: ["command_line"],
  cmdb_ci_appl_dot_net: ["command_line"],
  cmdb_ci_appl_mongos: ["command_line"],
  cmdb_ci_appl_ca_dir_server: ["command_line"],
  cmdb_ci_endpoint_mq_mem: ["cmd_line"],
  cmdb_ci_endpoint_wmb_depend: ["cmd_line"],
  cmdb_ci_endpoint_storf: ["args"],
  cmdb_ci_endpoint_xenapp_citrx: ["args"],
  cmdb_ci_endpoint_app: ["args"],
  cmdb_ci_appl_citrix_app: ["app_args"],
  cmdb_ci_docker_image: ["command"],
  related_servers: ["rp_command", "rp_parameters", "rp_key_parameters"],
  classified_apps: ["p_command", "p_parameters", "p_key_parameters", "a_running_process_command", "a_running_process_key_parameters"],
  application_on_servers: ["appl_running_process_command", "appl_running_process_key_parameters"],
  samp_lrb_to_instances_view: ["appl_running_process_command", "appl_running_process_key_parameters"],
};
/** The out-of-the-box database views in the list, and the subclass listed by name. */
const LISTED_VIEWS = ["related_servers", "classified_apps", "application_on_servers", "samp_lrb_to_instances_view"] as const;
/** Columns guarded by name on every table. */
const EVERYWHERE = ["running_process_command", "running_process_key_parameters"] as const;
const PAIRS = Object.entries(GUARDED).flatMap(([table, columns]) => columns.map((column) => [table, column] as const));
/** A table that extends cmdb_running_process (made-up name). */
const SUBCLASS = "u_example_process_ext";
const SUBSUBCLASS = "u_example_process_ext_child";
const CHAINS: Readonly<Record<string, readonly string[]>> = {
  [TABLE]: [TABLE, "cmdb_ci", "cmdb_ci_base"],
  [SUBCLASS]: [SUBCLASS, TABLE, "cmdb_ci", "cmdb_ci_base"],
  [SUBSUBCLASS]: [SUBSUBCLASS, SUBCLASS, TABLE, "cmdb_ci", "cmdb_ci_base"],
  cmdb_ci: ["cmdb_ci", "cmdb_ci_base"],
  cmdb_ci_appl: ["cmdb_ci_appl", "cmdb_ci"],
  cmdb_ci_appl_tomcat: ["cmdb_ci_appl_tomcat", "cmdb_ci_appl", "cmdb_ci"],
};

const SYS_ID = "c".repeat(32);
const MARKER = "PROCESS-COMMAND-MARKER-7e31";

/** A row carrying the marker in each column that is guarded on `table` (its chain's columns and the ones guarded everywhere). */
function rowFor(table: string): Record<string, string> {
  const names = new Set<string>(EVERYWHERE);
  for (const name of CHAINS[table] ?? [table]) for (const column of GUARDED[name] ?? []) names.add(column);
  return { sys_id: SYS_ID, name: "example-process", table, ...Object.fromEntries([...names].map((column) => [column, MARKER])) };
}

function withFieldPolicy<T>(configuration: FieldPolicyConfigurationInput, action: () => T): T {
  return runWithFieldPolicyConfiguration(configuration, action);
}

function reason(action: () => unknown): string {
  try {
    action();
    return "allowed";
  } catch (error) {
    if (error instanceof FieldPolicyError) return error.reason;
    throw error;
  }
}

/** Runs `action` in a call scope whose tables have the chains above. */
function inChainScope<T>(tables: readonly string[], action: () => T): T {
  const types = fieldTypesFromRows(
    [],
    Object.fromEntries(tables.map((table) => [table, { tables: CHAINS[table] ?? [table], complete: true }]))
  );
  const { scope } = hiddenFieldScope(types, tables, false);
  return runWithHiddenFieldScope(scope!, action);
}

describe("the process command-line column list", () => {
  it("names each table and its columns, on the list history reads", () => {
    for (const [table, columns] of Object.entries(GUARDED)) {
      expect(EXPLICIT_READ_FIELD_NAMES[table], table).toEqual(columns);
      for (const column of columns) expect(explicitReadColumns(table)?.has(column), `${table}.${column}`).toBe(true);
    }
    expect([...COMMAND_LINE_ANY_TABLE_FIELD_NAMES]).toEqual([...EVERYWHERE]);
    expect([...(explicitReadColumns("incident") ?? [])]).toEqual([...EVERYWHERE]);
    expect(explicitReadColumns("not a table")).toBeUndefined();
  });

  it("is listed in the README (every table) and summarized in the production security guide", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const guide = readFileSync(new URL("../docs/PRODUCTION-SECURITY.md", import.meta.url), "utf8");
    for (const [table, columns] of Object.entries(GUARDED)) {
      expect(readme, table).toContain(table);
      for (const column of columns) expect(readme, `${table}.${column}`).toContain(column);
    }
    for (const column of EVERYWHERE) expect(readme).toContain(column);
    for (const text of ["cmdb_running_process", "cmdb_ci_appl", ...EVERYWHERE]) expect(guide).toContain(text);
  });
});

describe("every guarded table and column", () => {
  it.each(PAIRS)("%s.%s is closed to reads, queries and writes, and opened by the table's own entry", (table, column) => {
    expect(reason(() => resolveReadableFields(table, { fields: `sys_id,${column}` }))).toBe("explicit_read_required");
    expect(reason(() => resolveReadableFields(table, { fields: column, purpose: "query" }))).toBe("explicit_read_required");
    expect(reason(() => validateWritableFields(table, { [column]: "x" }))).toBe("explicit_field_required");
    for (const selection of [
      resolveReadableFields(table, { fields: "all" }),
      resolveReadableFields(table, { responseFormat: "detailed" }),
      resolveReadableFields(table),
    ]) {
      expect(selection).not.toContain(column);
      expect(JSON.stringify(filterReadableRecord(rowFor(table), selection))).not.toContain(MARKER);
    }
    for (const fieldPolicy of [
      { [table]: { readable: "*", writable: "*" } },
      { "*": { readable: ["sys_id", column], writable: [column] } },
    ]) {
      withFieldPolicy({ fieldPolicy }, () => {
        expect(reason(() => resolveReadableFields(table, { fields: column }))).toBe("explicit_read_required");
        expect(reason(() => validateWritableFields(table, { [column]: "x" }))).toBe("explicit_field_required");
      });
    }
    withFieldPolicy({ fieldPolicy: { [table]: { readable: ["sys_id", column], writable: [column] } } }, () => {
      expect(resolveReadableFields(table, { fields: column })).toEqual([column]);
      expect(validateWritableFields(table, { [column]: "x" })).toEqual({ [column]: "x" });
    });
  });

  it("holds no other table's column", () => {
    for (const [table, columns] of Object.entries(GUARDED)) {
      for (const [other, otherColumns] of Object.entries(GUARDED)) {
        if (other === table) continue;
        for (const column of otherColumns.filter((name) => !columns.includes(name) && !(EVERYWHERE as readonly string[]).includes(name))) {
          expect(resolveReadableFields(table, { fields: column }), `${table}.${column}`).toEqual([column]);
        }
      }
    }
  });
});

describe("the columns guarded by name on every table", () => {
  const CUSTOM = "u_example_custom_table";
  it.each(EVERYWHERE)("%s is closed on a table that has no chain and no entry", (column) => {
    for (const table of [CUSTOM, "incident", "cmdb_ci", "sys_user", "cmdb_ci_server"]) {
      expect(reason(() => resolveReadableFields(table, { fields: column })), table).toBe("explicit_read_required");
      expect(reason(() => resolveReadableFields(table, { fields: column, purpose: "query" })), table).toBe(
        "explicit_read_required"
      );
      expect(reason(() => validateWritableFields(table, { [column]: "x" })), table).toBe("explicit_field_required");
      expect(resolveReadableFields(table, { fields: "all" })).not.toContain(column);
      expect(queryDeniedFields(table).has(column)).toBe(true);
      expect(JSON.stringify(filterReadableRecord(rowFor(table), readableSelectionForTable(table, ["sys_id", column])))).not.toContain(MARKER);
    }
  });

  it("holds when the call resolved no chain (names-only fallback) and for a table with a chain", () => {
    const { scope } = hiddenFieldScope(
      fieldTypesFromRows([], { [CUSTOM]: { tables: [CUSTOM], complete: false } }),
      [CUSTOM],
      true
    );
    runWithHiddenFieldScope(scope!, () => {
      for (const column of EVERYWHERE) {
        expect(reason(() => resolveReadableFields(CUSTOM, { fields: column }))).toBe("explicit_read_required");
      }
    });
    inChainScope([SUBCLASS], () => {
      expect(reason(() => resolveReadableFields(SUBCLASS, { fields: "running_process_command" }))).toBe(
        "explicit_read_required"
      );
    });
  });

  it("is opened only by the table's own entry", () => {
    withFieldPolicy({ fieldPolicy: { [CUSTOM]: { readable: ["sys_id", "running_process_command"] } } }, () => {
      expect(resolveReadableFields(CUSTOM, { fields: "running_process_command" })).toEqual(["running_process_command"]);
      expect(reason(() => resolveReadableFields(CUSTOM, { fields: "running_process_key_parameters" }))).toBe(
        "explicit_read_required"
      );
      expect(reason(() => resolveReadableFields("incident", { fields: "running_process_command" }))).toBe(
        "explicit_read_required"
      );
    });
    withFieldPolicy(
      { fieldPolicy: { "*": { readable: "*", writable: "*" }, [CUSTOM]: { readable: "*", writable: ["*"] } } },
      () => {
        expect(reason(() => resolveReadableFields(CUSTOM, { fields: "running_process_command" }))).toBe(
          "explicit_read_required"
        );
      }
    );
  });

  it("leaves a column of another name alone", () => {
    expect(resolveReadableFields("cmdb_ci_appl", { fields: "config_file,install_directory,rp_command_hash" })).toEqual([
      "config_file",
      "install_directory",
      "rp_command_hash",
    ]);
  });
});

describe("tables that extend a guarded table", () => {
  const CASES: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ["cmdb_ci_appl_tomcat", ["cmdb_ci_appl_tomcat", "cmdb_ci_appl", "cmdb_ci"], ["running_process_command", "running_process_key_parameters"]],
    ["u_example_app_ext", ["u_example_app_ext", "cmdb_ci_appl_generic", "cmdb_ci_appl", "cmdb_ci"], ["command_line", "running_process_command"]],
    ["u_example_image_ext", ["u_example_image_ext", "cmdb_ci_docker_image", "cmdb_ci_oslv_image", "cmdb_ci"], ["command"]],
    ["u_example_connection", ["u_example_connection", "cmdb_tcp_connection"], ["command"]],
  ];
  it.each(CASES)("%s has the columns of its chain, and only its own entry opens them", (table, chain, columns) => {
    const types = fieldTypesFromRows([], { [table]: { tables: chain, complete: true } });
    const { scope } = hiddenFieldScope(types, [table], false);
    for (const column of columns) {
      runWithHiddenFieldScope(scope!, () => {
        expect(reason(() => resolveReadableFields(table, { fields: column })), column).toBe("explicit_read_required");
        expect(reason(() => validateWritableFields(table, { [column]: "x" })), column).toBe("explicit_field_required");
        expect(resolveReadableFields(table, { fields: "all" })).not.toContain(column);
      });
      withFieldPolicy({ fieldPolicy: { [chain[1]!]: { readable: ["sys_id", column] } } }, () => {
        runWithHiddenFieldScope(scope!, () => {
          expect(reason(() => resolveReadableFields(table, { fields: column }))).toBe("explicit_read_required");
        });
      });
      withFieldPolicy({ fieldPolicy: { [table]: { readable: ["sys_id", column] } } }, () => {
        runWithHiddenFieldScope(scope!, () => {
          expect(resolveReadableFields(table, { fields: column })).toEqual([column]);
        });
      });
    }
  });

  it("does not take another branch's columns", () => {
    const types = fieldTypesFromRows([], {
      u_example_other_app: { tables: ["u_example_other_app", "cmdb_ci_appl", "cmdb_ci"], complete: true },
    });
    const { scope } = hiddenFieldScope(types, ["u_example_other_app"], false);
    runWithHiddenFieldScope(scope!, () => {
      for (const column of ["command", "command_line", "args"]) {
        expect(resolveReadableFields("u_example_other_app", { fields: column })).toEqual([column]);
      }
    });
  });
});

describe("with no field policy", () => {
  it.each(COLUMNS)("%s is refused by name, with the key that opens it", (column) => {
    try {
      resolveReadableFields(TABLE, { fields: `sys_id,${column}` });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FieldPolicyError);
      expect((error as FieldPolicyError).reason).toBe("explicit_read_required");
      const message = fieldPolicyDenialMessage(error as FieldPolicyError);
      expect(message).toBe(
        `Read denied by policy: field "${column}" on "${TABLE}" holds process command lines, so a readable ` +
          `wildcard never covers it. List it explicitly in fieldPolicy.${TABLE}.readable to allow this read.`
      );
    }
  });

  it.each(COLUMNS)("%s is refused to filter, order, group or aggregate", (column) => {
    expect(reason(() => resolveReadableFields(TABLE, { fields: column, purpose: "query" }))).toBe(
      "explicit_read_required"
    );
    expect(queryDeniedFields(TABLE).has(column)).toBe(true);
  });

  it.each(COLUMNS)("%s is left out of fields=all, detailed and default reads", (column) => {
    for (const selection of [
      resolveReadableFields(TABLE, { fields: "all" }),
      resolveReadableFields(TABLE, { responseFormat: "detailed" }),
      resolveReadableFields(TABLE),
    ]) {
      expect(selection).not.toContain(column);
      expect(JSON.stringify(filterReadableRecord(rowFor(TABLE), selection))).not.toContain(MARKER);
    }
  });

  it.each(COLUMNS)("%s is left out of a caller-built projection", (column) => {
    const selection = readableSelectionForTable(TABLE, ["sys_id", "name", column]);
    expect(selection).not.toContain(column);
    expect(JSON.stringify(filterReadableRecord(rowFor(TABLE), selection))).not.toContain(MARKER);
  });

  it.each(COLUMNS)("%s is dropped from an aggregate grouped on it", (column) => {
    const stats = { result: [{ stats: { count: "1" }, groupby_fields: [{ field: column, value: MARKER }] }] };
    const filtered = filterAggregateResult(stats, resolveReadableFields(TABLE, { fields: "all" }));
    expect(JSON.stringify(filtered)).not.toContain(MARKER);
  });

  it.each(COLUMNS)("%s is refused as a write key, with the key that opens it", (column) => {
    try {
      validateWritableFields(TABLE, { [column]: "x" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FieldPolicyError);
      expect((error as FieldPolicyError).reason).toBe("explicit_field_required");
      expect(fieldPolicyDenialMessage(error as FieldPolicyError)).toBe(
        `Write denied by policy: field "${column}" on "${TABLE}" holds process command lines, so a writable ` +
          `wildcard never covers it. List it explicitly in fieldPolicy.${TABLE}.writable to allow this write.`
      );
    }
    expect(validateWritableFields(TABLE, { name: "x" })).toEqual({ name: "x" });
  });

  it("is held to the call's tables for a projection built outside the policy", () => {
    inChainScope([TABLE], () => {
      const filtered = filterReadableRecord(rowFor(TABLE), ["*"]);
      expect(JSON.stringify(filtered)).not.toContain(MARKER);
      expect(filtered).toMatchObject({ sys_id: SYS_ID, name: "example-process" });
    });
  });

  it("leaves a same-named column on another table alone", () => {
    for (const table of ["u_example_widget", "sys_script", "cmdb_ci", "cmdb_running_process_x"]) {
      expect(resolveReadableFields(table, { fields: "command,parameters" }), table).toEqual(["command", "parameters"]);
      expect(validateWritableFields(table, { command: "x" }), table).toEqual({ command: "x" });
    }
  });

  it("still refuses a malformed selection the way it did", () => {
    expect(reason(() => resolveReadableFields(TABLE, { fields: "sys_id," }))).toBe("invalid_field_selection");
  });
});

describe("dot-walks and downcasts are never a field name", () => {
  it.each([
    `ref_${TABLE}.command`,
    `ref_${TABLE}.parameters`,
    "parent.command",
    "process.parameters",
    `${TABLE}.command`,
    "command.value",
  ])("%s is refused as a read, filter or group field, with or without the column opened", (path) => {
    const opened = { fieldPolicy: { [TABLE]: { readable: ["sys_id", "command", "parameters"] } } };
    for (const configuration of [{}, opened]) {
      for (const table of ["cmdb_ci", "cmdb_rel_ci", TABLE]) {
        withFieldPolicy(configuration, () => {
          expect(reason(() => resolveReadableFields(table, { fields: path })), `${table} ${path}`).toBe(
            "invalid_field_selection"
          );
          expect(reason(() => resolveReadableFields(table, { fields: `sys_id,${path}` })), `${table} ${path}`).toBe(
            "invalid_field_selection"
          );
          expect(
            reason(() => resolveReadableFields(table, { fields: path, purpose: "query" })),
            `${table} ${path}`
          ).toBe("invalid_field_selection");
        });
      }
      withFieldPolicy(configuration, () => {
        expect(reason(() => validateWritableFields("cmdb_ci", { [path]: "x" }))).toBe("unsupported_field_path");
      });
    }
  });
});

describe("only the table's own entry opens a column", () => {
  it.each(COLUMNS)("%s: listed in its own readable, it reads, filters and is returned", (column) => {
    const configuration = { fieldPolicy: { [TABLE]: { readable: ["sys_id", "name", column] } } };
    expect(() => validateFieldPolicyConfiguration(configuration)).not.toThrow();
    withFieldPolicy(configuration, () => {
      expect(resolveReadableFields(TABLE, { fields: column })).toEqual([column]);
      expect(resolveReadableFields(TABLE, { fields: column, purpose: "query" })).toEqual([column]);
      expect(resolveReadableFields(TABLE, { fields: "all" })).toContain(column);
      expect(
        JSON.stringify(filterReadableRecord(rowFor(TABLE), resolveReadableFields(TABLE, { fields: column })))
      ).toContain(MARKER);
      expect(queryDeniedFields(TABLE).has(column)).toBe(false);
      // Reading it does not open writing it, and does not open the other column.
      expect(reason(() => validateWritableFields(TABLE, { [column]: "x" }))).toBe("explicit_field_required");
      const other = COLUMNS.find((name) => name !== column)!;
      expect(reason(() => resolveReadableFields(TABLE, { fields: other }))).toBe("explicit_read_required");
    });
  });

  it.each(COLUMNS)("%s: listed in its own writable, it is written", (column) => {
    withFieldPolicy({ fieldPolicy: { [TABLE]: { writable: ["name", column] } } }, () => {
      expect(validateWritableFields(TABLE, { [column]: "x" })).toEqual({ [column]: "x" });
      // Writing it does not open reading it.
      expect(reason(() => resolveReadableFields(TABLE, { fields: column }))).toBe("explicit_read_required");
    });
  });

  it("the list forms (readableTableFields, writableTableFields) open them too", () => {
    withFieldPolicy(
      {
        readableTableFields: [{ table: TABLE, fields: ["sys_id", "command"] }],
        writableTableFields: [{ table: TABLE, fields: ["command"] }],
      },
      () => {
        expect(resolveReadableFields(TABLE, { fields: "command" })).toEqual(["command"]);
        expect(validateWritableFields(TABLE, { command: "x" })).toEqual({ command: "x" });
        expect(reason(() => resolveReadableFields(TABLE, { fields: "parameters" }))).toBe("explicit_read_required");
      }
    );
  });

  it.each([
    ['own "*"', { [TABLE]: { readable: "*", writable: "*" } }],
    ['own ["*"]', { [TABLE]: { readable: ["*"], writable: ["*"] } }],
    ['a "*" entry listing it', { "*": { readable: ["sys_id", "command", "parameters"], writable: ["command"] } }],
    ['a "*" entry of "*"', { "*": { readable: "*", writable: "*" } }],
    ["defaults alone", { [TABLE]: { defaults: ["sys_id", "name"] } }],
  ])("%s never opens it", (_label, fieldPolicy) => {
    withFieldPolicy({ fieldPolicy }, () => {
      for (const column of COLUMNS) {
        expect(reason(() => resolveReadableFields(TABLE, { fields: column }))).toBe("explicit_read_required");
        expect(reason(() => resolveReadableFields(TABLE, { fields: column, purpose: "query" }))).toBe(
          "explicit_read_required"
        );
        expect(reason(() => validateWritableFields(TABLE, { [column]: "x" }))).toBe("explicit_field_required");
      }
      expect(resolveReadableFields(TABLE, { fields: "all" })).not.toContain("command");
      expect(resolveReadableFields(TABLE, { responseFormat: "detailed" })).not.toContain("parameters");
    });
  });

  it('leaves a narrowing "*" entry as it was for the other columns', () => {
    withFieldPolicy({ fieldPolicy: { "*": { readable: ["sys_id", "name"] } } }, () => {
      expect(reason(() => resolveReadableFields(TABLE, { fields: "short_description" }))).toBe("unreadable_field");
      expect(resolveReadableFields(TABLE, { fields: "name" })).toEqual(["name"]);
      expect(reason(() => resolveReadableFields(TABLE, { fields: "command" }))).toBe("explicit_read_required");
    });
  });

  it("opens only the table and the column it names", () => {
    withFieldPolicy({ fieldPolicy: { [TABLE]: { readable: ["sys_id", "command"] } } }, () => {
      expect(resolveReadableFields(TABLE, { fields: "command" })).toEqual(["command"]);
      // The payload columns of other tables stay closed.
      expect(reason(() => resolveReadableFields("sys_update_xml", { fields: "payload" }))).toBe(
        "explicit_read_required"
      );
      // And a table of the same shape that is not listed has ordinary columns.
      expect(resolveReadableFields("cmdb_ci", { fields: "command" })).toEqual(["command"]);
    });
  });
});

describe("a table that extends cmdb_running_process", () => {
  it("has the columns where the call knows its chain, and only its own entry opens them", () => {
    for (const table of [SUBCLASS, SUBSUBCLASS]) {
      inChainScope([table], () => {
        for (const column of COLUMNS) {
          expect(reason(() => resolveReadableFields(table, { fields: column })), `${table}.${column}`).toBe(
            "explicit_read_required"
          );
          expect(reason(() => resolveReadableFields(table, { fields: column, purpose: "query" }))).toBe(
            "explicit_read_required"
          );
          expect(reason(() => validateWritableFields(table, { [column]: "x" }))).toBe("explicit_field_required");
        }
        expect(resolveReadableFields(table, { fields: "all" })).not.toContain("command");
        expect(resolveReadableFields(table)).not.toContain("parameters");
        expect(queryDeniedFields(table).has("command")).toBe(true);
        expect(JSON.stringify(filterReadableRecord(rowFor(table), ["*"]))).not.toContain(MARKER);
        expect(explicitReadColumns(table)).toBe(explicitReadColumns(TABLE));
      });
    }
  });

  it("names the subclass in the refusal", () => {
    inChainScope([SUBCLASS], () => {
      try {
        resolveReadableFields(SUBCLASS, { fields: "command" });
        throw new Error("expected a refusal");
      } catch (error) {
        expect(fieldPolicyDenialMessage(error as FieldPolicyError)).toContain(`fieldPolicy.${SUBCLASS}.readable`);
      }
    });
  });

  it("is opened by its own entry, not by the parent's", () => {
    withFieldPolicy({ fieldPolicy: { [TABLE]: { readable: ["sys_id", "command"] } } }, () => {
      inChainScope([SUBCLASS], () => {
        expect(reason(() => resolveReadableFields(SUBCLASS, { fields: "command" }))).toBe("explicit_read_required");
      });
      expect(resolveReadableFields(TABLE, { fields: "command" })).toEqual(["command"]);
    });
    withFieldPolicy({ fieldPolicy: { [SUBCLASS]: { readable: ["sys_id", "name", "command"] } } }, () => {
      inChainScope([SUBCLASS, SUBSUBCLASS, TABLE], () => {
        expect(resolveReadableFields(SUBCLASS, { fields: "command" })).toEqual(["command"]);
        expect(resolveReadableFields(SUBCLASS, { fields: "all" })).toContain("command");
        expect(reason(() => resolveReadableFields(SUBCLASS, { fields: "parameters" }))).toBe("explicit_read_required");
        expect(reason(() => resolveReadableFields(SUBSUBCLASS, { fields: "command" }))).toBe("explicit_read_required");
        expect(reason(() => resolveReadableFields(TABLE, { fields: "command" }))).toBe("explicit_read_required");
      });
    });
    withFieldPolicy({ fieldPolicy: { [SUBCLASS]: { writable: ["name", "parameters"] } } }, () => {
      inChainScope([SUBCLASS], () => {
        expect(validateWritableFields(SUBCLASS, { parameters: "x" })).toEqual({ parameters: "x" });
        expect(reason(() => validateWritableFields(SUBCLASS, { command: "x" }))).toBe("explicit_field_required");
      });
    });
  });

  it('is never opened by a wildcard, including a "*" entry that lists it', () => {
    withFieldPolicy({ fieldPolicy: { "*": { readable: ["sys_id", "command"], writable: ["command"] } } }, () => {
      inChainScope([SUBCLASS], () => {
        expect(reason(() => resolveReadableFields(SUBCLASS, { fields: "command" }))).toBe("explicit_read_required");
        expect(reason(() => validateWritableFields(SUBCLASS, { command: "x" }))).toBe("explicit_field_required");
      });
    });
    withFieldPolicy({ fieldPolicy: { [SUBCLASS]: { readable: "*", writable: ["*"] } } }, () => {
      inChainScope([SUBCLASS], () => {
        expect(reason(() => resolveReadableFields(SUBCLASS, { fields: "command" }))).toBe("explicit_read_required");
      });
    });
  });

  it("has the columns of every ancestor that has any", () => {
    const table = "u_example_mixed_ext";
    const types = fieldTypesFromRows([], {
      [table]: { tables: [table, "sys_update_xml", TABLE, "cmdb_ci"], complete: true },
    });
    const { scope } = hiddenFieldScope(types, [table], false);
    runWithHiddenFieldScope(scope!, () => {
      for (const column of ["payload", "payload_diff", "command", "parameters"]) {
        expect(reason(() => resolveReadableFields(table, { fields: column })), column).toBe("explicit_read_required");
      }
      expect(explicitReadColumns(table)).toBe(explicitReadColumns(table));
      expect(resolveReadableFields(table, { fields: "name" })).toEqual(["name"]);
    });
    withFieldPolicy({ fieldPolicy: { [table]: { readable: ["sys_id", "name", "command", "payload"] } } }, () => {
      runWithHiddenFieldScope(scope!, () => {
        expect(resolveReadableFields(table, { fields: "command,payload" })).toEqual(["command", "payload"]);
        expect(reason(() => resolveReadableFields(table, { fields: "parameters" }))).toBe("explicit_read_required");
        expect(reason(() => resolveReadableFields(table, { fields: "payload_diff" }))).toBe("explicit_read_required");
      });
    });
  });

  it("leaves a table whose chain does not include it alone, and a call that knows no chain", () => {
    inChainScope(["cmdb_ci"], () => {
      expect(resolveReadableFields("cmdb_ci", { fields: "command" })).toEqual(["command"]);
    });
    // Outside a dispatched call there is no chain to consult: the name decides.
    expect(resolveReadableFields(SUBCLASS, { fields: "command" })).toEqual(["command"]);
    // A scope that carries no chains (names-only fallback) behaves the same.
    const { scope } = hiddenFieldScope(
      fieldTypesFromRows([], { [SUBCLASS]: { tables: [SUBCLASS], complete: false } }),
      [SUBCLASS],
      true
    );
    runWithHiddenFieldScope(scope!, () => {
      expect(resolveReadableFields(SUBCLASS, { fields: "command" })).toEqual(["command"]);
    });
  });
});

describe("when the call has no extension chain (names-only fallback)", () => {
  const CUSTOM_IMAGE = "u_example_image_ext";
  const CUSTOM_VIEW = "u_example_process_view";
  const namesOnly = <T>(tables: readonly string[], action: () => T): T => {
    const incomplete = fieldTypesFromRows(
      [],
      Object.fromEntries(tables.map((table) => [table, { tables: [table], complete: false }]))
    );
    const { scope } = hiddenFieldScope(incomplete, tables, true);
    expect(scope?.hierarchies?.size ?? 0).toBe(0);
    expect(scope?.views?.size ?? 0).toBe(0);
    return runWithHiddenFieldScope(scope!, action);
  };

  it("keeps every listed table, subclass and view closed by its exact name", () => {
    const tables = Object.keys(GUARDED);
    namesOnly(tables, () => {
      for (const [table, columns] of Object.entries(GUARDED)) {
        for (const column of columns) {
          expect(reason(() => resolveReadableFields(table, { fields: column })), `${table}.${column}`).toBe("explicit_read_required");
          expect(reason(() => resolveReadableFields(table, { fields: column, purpose: "query" })), `${table}.${column}`).toBe(
            "explicit_read_required"
          );
          expect(reason(() => validateWritableFields(table, { [column]: "x" })), `${table}.${column}`).toBe("explicit_field_required");
        }
        expect(JSON.stringify(filterReadableRecord(rowFor(table), ["*"]))).not.toContain(MARKER);
      }
    });
  });

  it.each(LISTED_VIEWS)("%s: only its own entry opens a column", (view) => {
    const column = GUARDED[view]![0]!;
    withFieldPolicy({ fieldPolicy: { [view]: { readable: ["sys_id", column] } } }, () => {
      namesOnly([view], () => {
        expect(resolveReadableFields(view, { fields: column })).toEqual([column]);
        for (const other of GUARDED[view]!.slice(1)) {
          expect(reason(() => resolveReadableFields(view, { fields: other }))).toBe("explicit_read_required");
        }
      });
    });
  });

  it("leaves an unknown custom subclass and an unknown custom view open, except for the names guarded everywhere", () => {
    namesOnly([CUSTOM_IMAGE, CUSTOM_VIEW], () => {
      expect(resolveReadableFields(CUSTOM_IMAGE, { fields: "command" })).toEqual(["command"]);
      expect(resolveReadableFields(CUSTOM_VIEW, { fields: "rp_command" })).toEqual(["rp_command"]);
      for (const column of EVERYWHERE) {
        expect(reason(() => resolveReadableFields(CUSTOM_IMAGE, { fields: column }))).toBe("explicit_read_required");
        expect(reason(() => resolveReadableFields(CUSTOM_VIEW, { fields: column }))).toBe("explicit_read_required");
      }
    });
    // With the chain known, the same tables are closed.
    inChainScope([CUSTOM_IMAGE], () => undefined);
    const types = fieldTypesFromRows([], {
      [CUSTOM_IMAGE]: { tables: [CUSTOM_IMAGE, "cmdb_ci_docker_image", "cmdb_ci_oslv_image", "cmdb_ci"], complete: true },
    });
    const { scope } = hiddenFieldScope(types, [CUSTOM_IMAGE], false);
    runWithHiddenFieldScope(scope!, () => {
      expect(reason(() => resolveReadableFields(CUSTOM_IMAGE, { fields: "command" }))).toBe("explicit_read_required");
    });
  });

  it("through the dispatcher on a profile that does not require field types", async () => {
    const unreadable: FieldTypeLoader = async () => ({ state: "unavailable" });
    const connected = await connect(undefined, unreadable, "not_required");
    for (const [table, columns] of [
      ["cmdb_ci_docker_image", ["command"]],
      ["related_servers", ["rp_command", "rp_parameters", "rp_key_parameters"]],
      ["classified_apps", ["p_command", "a_running_process_command"]],
      ["application_on_servers", ["appl_running_process_key_parameters"]],
      ["samp_lrb_to_instances_view", ["appl_running_process_command"]],
    ] as const) {
      for (const column of columns) {
        const named = await call(connected, "sn_query", { table, fields: `sys_id,${column}` });
        expect(JSON.stringify(named), `${table}.${column}`).toMatch(/holds process command lines/u);
        await expectRefused(connected, "sn_query", { table, fields: `sys_id,${column}` });
        await expectRefused(connected, "sn_query", { table, structured_query: TEXT_FILTER(column) });
        await expectRefused(connected, "sn_aggregate", { table, type: "COUNT", group_by: column });
      }
      await expectServedWithout(connected, "sn_query", { table, fields: "all" });
    }
    // An unknown custom subclass is covered only by the names guarded everywhere.
    const custom = await call(connected, "sn_query", { table: "u_example_image_ext", fields: "sys_id,command" });
    expect(custom.isError).toBeFalsy();
    await expectRefused(connected, "sn_query", { table: "u_example_image_ext", fields: "running_process_command" });
  });
});

describe("raw encoded queries", () => {
  const rule = (fields: readonly string[]) => ({
    rules: [
      {
        tool: "sn_query" as const,
        table: TABLE,
        maxLength: 256,
        maxTerms: 4,
        fields,
        operators: SUPPORTED_ENCODED_QUERY_OPERATORS,
        maxLimit: 10,
        maxOffset: 0,
        maxResponseBytes: 10_000,
      },
    ],
  });
  const request = (query: string, outputFields: readonly string[]) => ({
    tool: "sn_query",
    table: TABLE,
    query,
    limit: 10,
    offset: 0,
    maxResponseBytes: 10_000,
    outputFields,
  });

  it("a rule cannot list a column its profile has not opened", () => {
    expect(() => createEncodedQueryAccessPolicy(rule(["sys_id", "command"]))).toThrow();
  });

  it("a rule that lists an opened column cannot filter or return it under a policy that has not", () => {
    const policy = withFieldPolicy({ fieldPolicy: { [TABLE]: { readable: ["sys_id", "name", "command"] } } }, () =>
      createEncodedQueryAccessPolicy(rule(["sys_id", "name", "command"]))
    );
    withFieldPolicy({ fieldPolicy: { [TABLE]: { readable: ["sys_id", "name", "command"] } } }, () => {
      expect(authorizeRawEncodedRead(policy, request("commandLIKEexample", ["sys_id"])).query).toBe(
        "commandLIKEexample"
      );
    });
    for (const configuration of [{}, { fieldPolicy: { "*": { readable: "*" } } }]) {
      withFieldPolicy(configuration, () => {
        expect(() => authorizeRawEncodedRead(policy, request("commandLIKEexample", ["sys_id"]))).toThrow();
        expect(() => authorizeRawEncodedRead(policy, request("name=example", ["command"]))).toThrow();
        expect(authorizeRawEncodedRead(policy, request("name=example", ["sys_id", "name"])).outputFields).toEqual([
          "sys_id",
          "name",
        ]);
      });
    }
  });

  it.each([`ref_${TABLE}.commandLIKEx`, "parent.commandLIKEx", `${TABLE}.commandLIKEx`])(
    "a dotted field in the query text (%s) is never accepted",
    (query) => {
      const policy = createEncodedQueryAccessPolicy(rule(["sys_id", "name"]));
      expect(() => authorizeRawEncodedRead(policy, request(query, ["sys_id"]))).toThrow();
    }
  );
});

// Through the dispatcher: a "*" grant for reads and writes.
const CONFIG: ServiceNowConfig = {
  instance: "https://process-command-test.service-now.com",
  user: "process-command-user",
  password: "unused-test-placeholder",
  displayValue: "true",
  relDepth: 3,
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

/** Each planned table resolves with the chain in CHAINS (a table not listed extends nothing). */
const chainedFieldTypes: FieldTypeLoader = async (_client, tables) =>
  fieldTypesFromRows(
    [],
    Object.fromEntries([...tables].map((table) => [table, { tables: CHAINS[table] ?? [table], complete: true }]))
  );

async function connect(
  fieldPolicy?: FieldPolicyConfigurationInput,
  fieldTypeLoader: FieldTypeLoader | FieldTypeFixture = noHiddenFieldTypes,
  dictionary?: "not_required"
) {
  // A fixture makes the dispatcher run its real type lookup against the fake
  // instance (chains, database views); a loader replaces the lookup.
  const fixture = typeof fieldTypeLoader === "function" ? undefined : fieldTypeLoader;
  const records: ToolAuditRecord[] = [];
  // `/api/now/(table|stats)/<table>[/<sys_id>]`.
  const tableOf = (path: string) => /^\/api\/now\/(?:table|stats)\/([a-z0-9_]+)/u.exec(path)?.[1] ?? "";
  const answer = (path: string) => {
    const table = tableOf(path);
    if (path.startsWith("/api/now/stats/")) {
      return { result: [{ stats: { count: "1" }, groupby_fields: [{ field: "command", value: MARKER }] }] };
    }
    return /^\/api\/now\/table\/[a-z0-9_]+\/[0-9a-f]{32}$/u.test(path)
      ? { result: rowFor(table) }
      : { result: [rowFor(table)] };
  };
  const serviceNowClient = {
    get: vi.fn(async (path: string, params?: Record<string, string>) =>
      (fixture === undefined ? undefined : fieldTypeAnswer(path, params, fixture)?.data) ?? answer(path)
    ),
    getWithMeta: vi.fn(
      async (path: string, params?: Record<string, string>) =>
        (fixture === undefined ? undefined : fieldTypeAnswer(path, params, fixture)) ?? {
          data: answer(path),
          status: 200,
          headers: new Headers(),
        }
    ),
    post: vi.fn(async (path: string) => ({ result: rowFor(tableOf(path)) })),
    patch: vi.fn(async (path: string) => ({ result: rowFor(tableOf(path)) })),
    put: vi.fn(async (path: string) => ({ result: rowFor(tableOf(path)) })),
  } as unknown as ServiceNowClient;
  const getClient = vi.fn(() => serviceNowClient);
  const profileManager = {
    getProfile: vi.fn(() => ({
      instance: CONFIG.instance,
      username: CONFIG.user,
      credential: "env:PROCESS_COMMAND_PLACEHOLDER_IS_NEVER_READ",
      authType: "basic" as const,
    })),
    getConfig: vi.fn(() => CONFIG),
    getClient,
  } as unknown as ProfileManager;
  const tableAccess = createTableAccessPolicy({ readTables: ["*"], writeTables: ["*"], targets: [] });
  const executionContext: ExecutionContextDependencies = {
    requestMetadataProvider: {
      resolve: ({ requestId }) => ({
        correlationId: `process-command-${String(requestId)}`,
        identity: { ownerId: "process-command-owner", clientId: "process-command-client" },
      }),
    },
    effectivePolicyProvider: {
      resolve: () => ({
        id: "process-command",
        revision: "process-command",
        tableAccess,
        ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
        ...(dictionary === undefined ? {} : { fieldTypes: { dictionary } }),
      }),
    },
    ...(fixture === undefined ? { fieldTypeLoader: fieldTypeLoader as FieldTypeLoader } : {}),
    auditSink: {
      write: (record) => records.push(record),
      writePreContext: () => {},
    },
  };
  const server = await createMcpServer({
    dependencies: { profileManager, executionContext },
    register: (surface, dependencies) =>
      registerServiceNowTools(surface, dependencies.profileManager, dependencies.executionContext),
  });
  const client = new Client({ name: "process-command-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    if (server.isConnected()) await server.close();
  });
  return { client, records, getClient, serviceNowClient };
}

type Connected = Awaited<ReturnType<typeof connect>>;

function call(connected: Connected, name: string, args: Record<string, unknown>) {
  return connected.client.callTool({ name, arguments: { profile: "process-command", ...args } });
}

/**
 * Refused by policy before any instance request. (A refusal that needs the
 * call's extension chains is made once the dispatcher has resolved them, which
 * takes the client but, with the injected loader, makes no request.)
 */
async function expectRefused(connected: Connected, name: string, args: Record<string, unknown>) {
  const client = connected.serviceNowClient as unknown as Record<string, ReturnType<typeof vi.fn>>;
  // The type lookup (dictionary, chains, views) is the dispatcher's own, before the tool.
  const lookup = /^\/api\/now\/table\/(sys_dictionary|sys_db_object|sys_db_view_table)$/u;
  const requests = () =>
    ["get", "getWithMeta", "post", "patch", "put"].reduce(
      (n, m) => n + client[m]!.mock.calls.filter(([path]) => !lookup.test(String(path))).length,
      0
    );
  const before = requests();
  const result = await call(connected, name, args);
  const label = `${name} ${JSON.stringify(args)}`;
  expect(result.isError, label).toBe(true);
  expect(connected.records.at(-1), label).toMatchObject({ outcome: "policy_rejected" });
  expect(requests(), label).toBe(before);
  expect(JSON.stringify(result), label).not.toContain(MARKER);
}

/** Served, with the column's content nowhere in the result. */
async function expectServedWithout(connected: Connected, name: string, args: Record<string, unknown>) {
  const result = await call(connected, name, args);
  const label = `${name} ${JSON.stringify(args)}`;
  expect(result.isError, label + " " + JSON.stringify(result).slice(0, 400)).toBeFalsy();
  expect(JSON.stringify(result), label).not.toContain(MARKER);
}

/** Every request the call made, as text (paths and parameters). */
function requestsOf(connected: Connected): string {
  const client = connected.serviceNowClient as unknown as {
    get: { mock: { calls: unknown[][] } };
    getWithMeta: { mock: { calls: unknown[][] } };
  };
  return JSON.stringify([...client.get.mock.calls, ...client.getWithMeta.mock.calls]);
}

const TEXT_FILTER = (field: string) => ({
  filter: { type: "text", field, operator: "contains", value: "example" },
});

describe.each([
  ["cmdb_running_process", TABLE, noHiddenFieldTypes, COLUMNS],
  ["a subclass whose chain the call resolved", SUBCLASS, chainedFieldTypes, COLUMNS],
  ["a sub-subclass", SUBSUBCLASS, chainedFieldTypes, COLUMNS],
  ["cmdb_ci_appl", "cmdb_ci_appl", chainedFieldTypes, EVERYWHERE],
  ["a subclass of cmdb_ci_appl", "cmdb_ci_appl_tomcat", chainedFieldTypes, EVERYWHERE],
  ["a custom table whose chain is not resolved", "u_example_custom_table", noHiddenFieldTypes, EVERYWHERE],
] as const)('the generic tools on %s under a "*" grant with no field policy', (_label, table, loader, columns) => {
  it("refuses each column as a field, filter, order, group or aggregate field", async () => {
    const connected = await connect(undefined, loader);
    for (const column of columns) {
      await expectRefused(connected, "sn_query", { table, fields: `sys_id,${column}` });
      await expectRefused(connected, "sn_get", { table, sys_id: SYS_ID, fields: column });
      await expectRefused(connected, "sn_query", { table, structured_query: TEXT_FILTER(column) });
      await expectRefused(connected, "sn_query", {
        table,
        structured_query: { order_by: [{ field: column, direction: "asc" }] },
      });
      await expectRefused(connected, "sn_query", { table, orderby: column });
      await expectRefused(connected, "sn_query", { table, orderby: `-${column}` });
      await expectRefused(connected, "sn_aggregate", { table, type: "COUNT", group_by: column });
      await expectRefused(connected, "sn_aggregate", { table, type: "MAX", field: column });
      await expectRefused(connected, "sn_aggregate", { table, type: "COUNT", field: column, group_by: "name" });
    }
  });

  it("returns neither column in a default, detailed or fields=all read", async () => {
    const connected = await connect(undefined, loader);
    await expectServedWithout(connected, "sn_query", { table });
    await expectServedWithout(connected, "sn_query", { table, fields: "all" });
    await expectServedWithout(connected, "sn_query", { table, response_format: "detailed" });
    await expectServedWithout(connected, "sn_query", { table, fields: "sys_id,name" });
    await expectServedWithout(connected, "sn_get", { table, sys_id: SYS_ID });
    await expectServedWithout(connected, "sn_get", { table, sys_id: SYS_ID, fields: "all" });
    await expectServedWithout(connected, "sn_get", { table, sys_id: SYS_ID, response_format: "detailed" });
    await expectServedWithout(connected, "sn_aggregate", { table, type: "COUNT", group_by: "name" });
    // The columns are not even requested from the instance.
    expect(requestsOf(connected)).not.toMatch(/command|parameters/u);
  });

  it("refuses a bulk filter or update on them and previews without them", async () => {
    const connected = await connect(undefined, loader);
    for (const column of columns) {
      await expectRefused(connected, "sn_batch", {
        table,
        action: "update",
        fields: { name: "renamed" },
        structured_query: TEXT_FILTER(column),
      });
      await expectRefused(connected, "sn_batch", { table, action: "delete", structured_query: TEXT_FILTER(column) });
      await expectRefused(connected, "sn_batch", {
        table,
        action: "update",
        fields: { [column]: "x" },
        structured_query: TEXT_FILTER("name"),
      });
    }
    const preview = await call(connected, "sn_batch", {
      table,
      action: "update",
      fields: { name: "renamed" },
      structured_query: TEXT_FILTER("name"),
    });
    expect(preview.isError).toBeFalsy();
    expect(JSON.stringify(preview)).not.toContain(MARKER);
    expect(requestsOf(connected)).not.toMatch(/command|parameters/u);
  });

  it("refuses a write of either column, and another write's echo omits them", async () => {
    const connected = await connect(undefined, loader);
    for (const column of columns) {
      await expectRefused(connected, "sn_update", { table, sys_id: SYS_ID, fields: { [column]: "x" } });
      await expectRefused(connected, "sn_create", { table, fields: { name: "p", [column]: "x" } });
    }
    await expectServedWithout(connected, "sn_update", { table, sys_id: SYS_ID, fields: { name: "renamed" } });
    await expectServedWithout(connected, "sn_create", { table, fields: { name: "created" } });
  });

  it("refuses them in sn_history fields (the audit rows are covered in history-module.test.ts)", async () => {
    const connected = await connect(undefined, loader);
    for (const column of columns) {
      await expectRefused(connected, "sn_history", { table, sys_id: SYS_ID, fields: [column] });
    }
  });
});

describe("the generic tools once the table's own entry lists a column", () => {
  it("sn_query returns it and may filter, order and group on it, and sn_get returns it", async () => {
    const connected = await connect({ fieldPolicy: { [TABLE]: { readable: ["sys_id", "name", "command"] } } });
    const named = await call(connected, "sn_query", { table: TABLE, fields: "sys_id,command" });
    expect(named.isError).toBeFalsy();
    expect(JSON.stringify(named)).toContain(MARKER);
    const all = await call(connected, "sn_query", { table: TABLE, fields: "all" });
    expect(JSON.stringify(all)).toContain(MARKER);
    const got = await call(connected, "sn_get", { table: TABLE, sys_id: SYS_ID, fields: "command" });
    expect(JSON.stringify(got)).toContain(MARKER);
    for (const args of [
      { fields: "sys_id", structured_query: TEXT_FILTER("command") },
      { fields: "sys_id", structured_query: { order_by: [{ field: "command", direction: "desc" }] } },
    ]) {
      const result = await call(connected, "sn_query", { table: TABLE, ...args });
      expect(result.isError, JSON.stringify(args)).toBeFalsy();
    }
    expect((await call(connected, "sn_aggregate", { table: TABLE, type: "COUNT", group_by: "command" })).isError).toBeFalsy();
    // The other column stays closed.
    await expectRefused(connected, "sn_query", { table: TABLE, fields: "parameters" });
  });

  it("sn_update writes a column only once the own entry lists it in writable", async () => {
    const connected = await connect({ fieldPolicy: { [TABLE]: { writable: ["name", "parameters"] } } });
    const written = await call(connected, "sn_update", { table: TABLE, sys_id: SYS_ID, fields: { parameters: "x" } });
    expect(written.isError).toBeFalsy();
    // The echo still leaves the columns out: only readable opens them.
    expect(JSON.stringify(written)).not.toContain(MARKER);
    await expectRefused(connected, "sn_update", { table: TABLE, sys_id: SYS_ID, fields: { command: "x" } });
  });

  it('a "*" field entry that lists the column still does not open it', async () => {
    const connected = await connect({ fieldPolicy: { "*": { readable: ["sys_id", "name", "command"] } } });
    await expectRefused(connected, "sn_query", { table: TABLE, fields: "command" });
    await expectServedWithout(connected, "sn_query", { table: TABLE, fields: "all" });
  });

  it("the subclass's own entry opens it for the subclass only", async () => {
    const connected = await connect(
      { fieldPolicy: { [SUBCLASS]: { readable: ["sys_id", "name", "command"] } } },
      chainedFieldTypes
    );
    const named = await call(connected, "sn_query", { table: SUBCLASS, fields: "sys_id,command" });
    expect(JSON.stringify(named)).toContain(MARKER);
    await expectRefused(connected, "sn_query", { table: TABLE, fields: "command" });
    await expectRefused(connected, "sn_query", { table: SUBSUBCLASS, fields: "command" });
  });
});

describe("dot-walks and downcasts through the generic tools", () => {
  const DOTTED = [`ref_${TABLE}.command`, `ref_${TABLE}.parameters`, "parent.command", `${TABLE}.parameters`];

  it.each(["cmdb_ci", "cmdb_rel_ci", TABLE])("%s refuses them as a field, filter, order or aggregate field", async (table) => {
    const connected = await connect();
    for (const path of DOTTED) {
      await expectRefused(connected, "sn_query", { table, fields: path });
      await expectRefused(connected, "sn_query", { table, fields: `sys_id,${path}` });
      await expectRefused(connected, "sn_get", { table, sys_id: SYS_ID, fields: path });
      await expectRefused(connected, "sn_query", { table, structured_query: TEXT_FILTER(path) });
      await expectRefused(connected, "sn_query", {
        table,
        structured_query: { order_by: [{ field: path, direction: "asc" }] },
      });
      await expectRefused(connected, "sn_query", { table, orderby: path });
      await expectRefused(connected, "sn_aggregate", { table, type: "COUNT", group_by: path });
      await expectRefused(connected, "sn_aggregate", { table, type: "MAX", field: path });
      await expectRefused(connected, "sn_batch", { table, action: "delete", structured_query: TEXT_FILTER(path) });
      await expectRefused(connected, "sn_update", { table, sys_id: SYS_ID, fields: { [path]: "x" } });
    }
  });

  it("refuses them the same when the profile has opened the columns", async () => {
    const connected = await connect({
      fieldPolicy: { [TABLE]: { readable: ["sys_id", "command", "parameters"] }, "*": { readable: "*" } },
    });
    for (const path of DOTTED) {
      await expectRefused(connected, "sn_query", { table: "cmdb_ci", fields: path });
      await expectRefused(connected, "sn_query", { table: "cmdb_ci", structured_query: TEXT_FILTER(path) });
    }
  });
});

describe("the other read tools", () => {
  it("sn_codesearch does not search the table or its columns", async () => {
    const connected = await connect();
    await expectRefused(connected, "sn_codesearch", { search_term: "example", table: TABLE });
    await expectRefused(connected, "sn_codesearch", { search_term: "example", table: TABLE, field: "command" });
    await expectRefused(connected, "sn_codesearch", { search_term: "example", field: "command" });
    await expectRefused(connected, "sn_codesearch", { search_term: "example", table: SUBCLASS, field: "command" });
  });

  it("sn_nl is not classified, so it reaches no table", async () => {
    const connected = await connect();
    await expectRefused(connected, "sn_nl", { text: `show command and parameters of every ${TABLE}` });
  });

  it("sn_relationships reads fixed columns and never asks for these", async () => {
    const connected = await connect();
    const result = await call(connected, "sn_relationships", { ci_name: "example-process" });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(requestsOf(connected)).not.toMatch(/command|parameters/u);
  });
});

describe("database views over guarded tables", () => {
  const VIEW = "u_example_process_view";
  const SOURCES = [
    { table: TABLE, prefix: "rp" },
    { table: "cmdb_ci_appl_tomcat", prefix: "app" },
    { table: "sys_update_xml", prefix: "ux" },
  ];
  const fixture = (views: FieldTypeFixture["views"] = { [VIEW]: SOURCES }): FieldTypeFixture => ({
    // The dictionary read must return a row, or the types count as unreadable.
    dictionary: [{ name: "sys_user", element: "user_password", internal_type: "password" }],
    parents: { cmdb_ci_appl_tomcat: ["cmdb_ci_appl", "cmdb_ci"] },
    absent: [VIEW],
    views,
  });
  const CLOSED = [
    "rp_command",
    "rp_parameters",
    "rp_key_parameters",
    "app_running_process_command",
    "app_running_process_key_parameters",
    "rp_running_process_command",
    "ux_payload",
    "ux_payload_diff",
    "running_process_command",
  ];
  const viewScope = {
    tables: new Map([[VIEW, new Set<string>()]]),
    unresolved: "deny" as const,
    views: new Map([
      [
        VIEW,
        [
          { prefix: "rp", hierarchy: [TABLE] },
          { prefix: "app", hierarchy: ["cmdb_ci_appl_tomcat", "cmdb_ci_appl", "cmdb_ci"] },
          { prefix: "ux", hierarchy: ["sys_update_xml", "sys_metadata"] },
        ],
      ],
    ]),
  };

  it("closes each joined table's columns under its prefix, and leaves the others alone", () => {
    runWithHiddenFieldScope(viewScope, () => {
      for (const column of CLOSED) {
        expect(reason(() => resolveReadableFields(VIEW, { fields: column })), column).toBe("explicit_read_required");
        expect(reason(() => resolveReadableFields(VIEW, { fields: column, purpose: "query" })), column).toBe(
          "explicit_read_required"
        );
        expect(reason(() => validateWritableFields(VIEW, { [column]: "x" })), column).toBe("explicit_field_required");
        expect(queryDeniedFields(VIEW).has(column), column).toBe(true);
      }
      for (const column of ["rp_name", "rp_pid", "app_name", "app_install_directory", "ux_name", "command", "payload", "app_command"]) {
        expect(resolveReadableFields(VIEW, { fields: column }), column).toEqual([column]);
      }
      const row = Object.fromEntries([...CLOSED, "rp_name"].map((name) => [name, MARKER]));
      expect(JSON.stringify(filterReadableRecord(row, ["*"]))).not.toContain(MARKER.repeat(2));
      expect(filterReadableRecord(row, ["*"])).toEqual({ rp_name: MARKER });
    });
  });

  it("is opened by the view's own entry only", () => {
    withFieldPolicy({ fieldPolicy: { [VIEW]: { readable: ["sys_id", "rp_command", "ux_payload"] } } }, () => {
      runWithHiddenFieldScope(viewScope, () => {
        expect(resolveReadableFields(VIEW, { fields: "rp_command,ux_payload" })).toEqual(["rp_command", "ux_payload"]);
        expect(reason(() => resolveReadableFields(VIEW, { fields: "rp_parameters" }))).toBe("explicit_read_required");
        expect(reason(() => resolveReadableFields(VIEW, { fields: "ux_payload_diff" }))).toBe("explicit_read_required");
      });
    });
    withFieldPolicy({ fieldPolicy: { [TABLE]: { readable: ["sys_id", "command"] }, "*": { readable: "*" } } }, () => {
      runWithHiddenFieldScope(viewScope, () => {
        expect(reason(() => resolveReadableFields(VIEW, { fields: "rp_command" }))).toBe("explicit_read_required");
      });
    });
  });

  it("through the dispatcher: refused, left out of every projection, and ordinary view columns still read", async () => {
    const connected = await connect(undefined, fixture());
    for (const column of ["rp_command", "rp_key_parameters", "app_running_process_command", "ux_payload"]) {
      // Refused for the column, not because the field types could not be read.
      const named = await call(connected, "sn_query", { table: VIEW, fields: `sys_id,${column}` });
      expect(JSON.stringify(named)).toMatch(/holds (process command lines|record payloads)/u);
      await expectRefused(connected, "sn_query", { table: VIEW, fields: `sys_id,${column}` });
      await expectRefused(connected, "sn_query", { table: VIEW, structured_query: TEXT_FILTER(column) });
      await expectRefused(connected, "sn_aggregate", { table: VIEW, type: "COUNT", group_by: column });
      await expectRefused(connected, "sn_get", { table: VIEW, sys_id: SYS_ID, fields: column });
    }
    await expectServedWithout(connected, "sn_query", { table: VIEW, fields: "all" });
    await expectServedWithout(connected, "sn_query", { table: VIEW });
    await expectServedWithout(connected, "sn_query", { table: VIEW, response_format: "detailed" });
    const ordinary = await call(connected, "sn_query", { table: VIEW, fields: "sys_id,rp_name,app_install_directory" });
    expect(ordinary.isError).toBeFalsy();
  });

  it("is refused outright when a joined table cannot be resolved, with no column name to go by", async () => {
    const connected = await connect(undefined, { ...fixture(), hiddenRows: [TABLE] });
    connected.records.length = 0;
    const result = await call(connected, "sn_query", { table: VIEW, fields: "sys_id,rp_name" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("field types could not be read");
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(connected.records.at(-1)).toMatchObject({ outcome: "policy_rejected" });
  });
});
