/**
 * Resolve the complete table-access plan for one registered tool invocation.
 *
 * The dispatcher evaluates this plan before profile credentials, a cached
 * ServiceNow client, or a tool handler can be reached. Every registered V2
 * tool is classified explicitly; an unknown or intentionally unclassified
 * composed operation fails closed.
 *
 * @module tool-table-access
 */

import {
  TablePolicyError,
  normalizeTableName,
  type TableAccessRequest,
} from "./table-policy.js";
import {
  FieldPolicyError,
  isFieldPolicyError,
  prepareAdditionalReadFieldArguments,
  prepareReadFieldArguments,
  prepareWriteFieldArguments,
  preparedReadableFields,
  resolveReadableFields,
  snapshotPlainDataArguments,
  withFieldPolicyArgumentValues,
} from "./field-policy.js";
import {
  authorizeRawEncodedRead,
  createEncodedQueryAccessPolicy,
  EncodedQueryPolicyError,
  isEncodedQueryPolicyError,
  rejectRawEncodedWrite,
  type EncodedQueryAccessPolicy,
} from "./encoded-query-policy.js";
import { compileStructuredQuery, StructuredQueryError } from "./structured-query.js";
import {
  isIncidentJournalPolicyError,
  prepareIncidentJournalArguments,
  rejectGenericIncidentJournalFields,
} from "./incident-journal-policy.js";

export interface ToolTableAccessResolution {
  readonly args: Record<string, unknown>;
  readonly requests: readonly TableAccessRequest[];
}

const CODE_TABLES = Object.freeze([
  "sys_script",
  "sys_script_include",
  "sys_ui_script",
  "sys_script_client",
  "sys_ws_operation",
]);

const CODE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  sys_script: "script",
  sys_script_include: "script",
  sys_ui_script: "script",
  sys_script_client: "script",
  sys_ws_operation: "operation_script",
});

const HEALTH_TABLES = Object.freeze({
  version: ["sys_properties"],
  nodes: ["sys_cluster_state"],
  jobs: ["sys_trigger"],
  semaphores: ["sys_semaphore"],
  stats: ["incident", "change_request", "problem"],
});

const DENY_ALL_ENCODED_QUERIES = createEncodedQueryAccessPolicy();

/** Build a normalized, immutable preflight plan for one known tool. */
export function resolveToolTableAccess(
  tool: string,
  candidateArgs: unknown,
  encodedQueryAccess: EncodedQueryAccessPolicy = DENY_ALL_ENCODED_QUERIES
): ToolTableAccessResolution {
  try {
    const args = snapshotPlainDataArguments(candidateArgs);
    switch (tool) {
      case "sn_query": {
        const table = requiredTable(args.table);
        let prepared = prepareReadFieldArguments(args, table, {
          exposeFieldsArgument: true,
        });
        if (args.structured_query !== undefined && args.orderby !== undefined) {
          throw new StructuredQueryError("invalid_shape");
        }
        const orderby = canonicalLegacyReadOrderBy(args.orderby, table);
        if (orderby !== undefined) {
          prepared = withFieldPolicyArgumentValues(prepared, { orderby });
        }
        if (args.query !== undefined) {
          const rawPlan = authorizeReadQuery(
            encodedQueryAccess,
            "sn_query",
            table,
            prepared,
            preparedReadableFields(prepared, table)
          );
          prepared = withFieldPolicyArgumentValues(prepared, {
            query: rawPlan?.query,
            fields: rawPlan?.outputFields.join(","),
          });
        }
        if (args.structured_query !== undefined) {
          if (args.query !== undefined || args.orderby !== undefined) {
            throw new StructuredQueryError("invalid_shape");
          }
          const structuredPlan = compileStructuredQuery(
            args.structured_query,
            resolveReadableFields(table, { fields: "all" })
          );
          prepared = withFieldPolicyArgumentValues(prepared, {
            structured_query: structuredPlan.structuredQuery,
          });
        }
        return resolution(
          prepared,
          [read(table)]
        );
      }
      case "sn_get": {
        const table = requiredTable(args.table);
        return resolution(
          prepareReadFieldArguments(args, table, {
            exposeFieldsArgument: true,
          }),
          [read(table)]
        );
      }
      case "sn_aggregate":
        return aggregateResolution(args, encodedQueryAccess);
      case "sn_create": {
        rejectRawEncodedWrite(args.query);
        const table = requiredTable(args.table);
        // High-level SDK validation requires the write payload. Keeping the
        // table-only classification helper usable without one preserves its
        // narrow plan-inspection contract; registered invocations always take
        // the validated branch below before client construction.
        if (!Object.hasOwn(args, "fields")) {
          return resolution(withFieldPolicyArgumentValues(args, { table }), [write(table)]);
        }
        return resolution(prepareWriteFieldArguments(args, table), [write(table)]);
      }
      case "sn_update": {
        rejectRawEncodedWrite(args.query);
        rejectGenericIncidentJournalFields(args.fields);
        const table = requiredTable(args.table);
        if (!Object.hasOwn(args, "fields")) {
          return resolution(withFieldPolicyArgumentValues(args, { table }), [write(table)]);
        }
        return resolution(prepareWriteFieldArguments(args, table), [write(table)]);
      }
      case "sn_incident_add_comment":
      case "sn_incident_add_work_note": {
        rejectRawEncodedWrite(args.query);
        const prepared = prepareIncidentJournalArguments(args);
        return resolution(
          withFieldPolicyArgumentValues(args, prepared),
          [write("incident")]
        );
      }
      case "sn_delete":
        rejectRawEncodedWrite(args.query);
        return withNamedTable(args, ["write"]);
      case "sn_batch":
        return batchResolution(args);
      case "sn_schema": {
        const target = requiredTable(args.table);
        return resolution(
          prepareReadFieldArguments(args, target, {
            exposeFieldsArgument: false,
            allReadable: true,
          }),
          [
            read(target),
            read("sys_dictionary"),
            read("sys_db_object"),
            read("sys_documentation"),
            read("sys_choice"),
          ]
        );
      }
      case "sn_health":
        return healthResolution(args);
      case "sn_attach":
        return attachmentResolution(args);
      case "sn_relationships":
        return resolution(args, [read("cmdb_ci"), read("cmdb_rel_ci")]);
      case "sn_syslog":
        authorizeReadQuery(encodedQueryAccess, "sn_syslog", "syslog", args);
        return resolution(
          prepareReadFieldArguments(args, "syslog", {
            exposeFieldsArgument: true,
          }),
          [read("syslog")]
        );
      case "sn_codesearch":
        return codeSearchResolution(args);
      case "sn_discover":
        return discoveryResolution(args);
      case "sn_atf":
        return atfResolution(args, encodedQueryAccess);
      case "sn_script":
        // The published compatibility stub performs no ServiceNow access.
        return resolution(args, []);
      case "sn_nl":
        // Natural-language composition can select reads or writes only after
        // parsing inside the handler. Until that parser emits a typed access
        // plan, the operation is deliberately unclassified and denied.
        throw new TablePolicyError();
      default:
        throw new TablePolicyError();
    }
  } catch (error) {
    if (
      error instanceof TablePolicyError ||
      isFieldPolicyError(error) ||
      isEncodedQueryPolicyError(error) ||
      isIncidentJournalPolicyError(error)
    ) {
      throw error;
    }
    throw new TablePolicyError();
  }
}

function healthResolution(
  args: Record<string, unknown>
): ToolTableAccessResolution {
  const check = typeof args.check === "string" ? args.check : "all";
  if (check === "all") {
    return resolution(
      args,
      Object.values(HEALTH_TABLES).flat().map(read)
    );
  }
  if (!Object.hasOwn(HEALTH_TABLES, check)) throw new TablePolicyError();
  return resolution(
    args,
    HEALTH_TABLES[check as keyof typeof HEALTH_TABLES].map(read)
  );
}

function attachmentResolution(
  args: Record<string, unknown>
): ToolTableAccessResolution {
  switch (args.action) {
    case "list": {
      const target = requiredTable(args.table);
      return resolution(
        withFieldPolicyArgumentValues(args, { table: target }),
        [read("sys_attachment"), read(target)]
      );
    }
    case "download":
      {
        const target = requiredTable(args.table);
        return resolution(
          withFieldPolicyArgumentValues(args, { table: target }),
          [read("sys_attachment"), read(target)]
        );
      }
    case "upload": {
      const target = requiredTable(args.table);
      return resolution(
        withFieldPolicyArgumentValues(args, { table: target }),
        [write("sys_attachment"), write(target)]
      );
    }
    default:
      throw new TablePolicyError();
  }
}

function codeSearchResolution(
  args: Record<string, unknown>
): ToolTableAccessResolution {
  if (args.table !== undefined) {
    const target = requiredTable(args.table);
    if (!Object.hasOwn(CODE_FIELDS, target)) throw new TablePolicyError();
    const field = resolveReadableFields(target, {
      fields: args.field ?? CODE_FIELDS[target],
    })[0];
    const fields = resolveReadableFields(target, {
      fields: `sys_id,name,${field}`,
    });
    return resolution(
      prepareAdditionalReadFieldArguments(
        withFieldPolicyArgumentValues(args, { table: target, field }),
        target,
        fields.join(",")
      ),
      [read(target)]
    );
  }
  if (args.field !== undefined) {
    throw new FieldPolicyError("invalid_field_selection");
  }
  let prepared = args;
  for (const target of CODE_TABLES) {
    prepared = prepareAdditionalReadFieldArguments(
      prepared,
      target,
      `sys_id,name,${CODE_FIELDS[target]}`
    );
  }
  return resolution(prepared, CODE_TABLES.map(read));
}

function discoveryResolution(
  args: Record<string, unknown>
): ToolTableAccessResolution {
  switch (args.type) {
    case "tables": {
      const prepared = prepareAdditionalReadFieldArguments(
        args,
        "sys_db_object",
        "sys_id,name,label,super_class,sys_scope,is_extendable"
      );
      return resolution(prepared, [read("sys_db_object")]);
    }
    case "apps": {
      let prepared = prepareAdditionalReadFieldArguments(
        args,
        "sys_app",
        "sys_id,name,version,scope,active"
      );
      prepared = prepareAdditionalReadFieldArguments(
        prepared,
        "sys_store_app",
        "sys_id,name,version,scope,active"
      );
      return resolution(prepared, [read("sys_app"), read("sys_store_app")]);
    }
    case "plugins": {
      const prepared = prepareAdditionalReadFieldArguments(
        args,
        "v_plugin",
        "sys_id,name,active"
      );
      return resolution(prepared, [read("v_plugin")]);
    }
    default:
      throw new TablePolicyError();
  }
}

function atfResolution(
  args: Record<string, unknown>,
  encodedQueryAccess: EncodedQueryAccessPolicy
): ToolTableAccessResolution {
  switch (args.action) {
    case "list": {
      authorizeReadQuery(encodedQueryAccess, "sn_atf", "sys_atf_test", args);
      let prepared = prepareReadFieldArguments(args, "sys_atf_test", {
        exposeFieldsArgument: true,
      });
      if (args.suite_name) {
        prepared = prepareAdditionalReadFieldArguments(
          prepared,
          "sys_atf_test_suite",
          "sys_id,name"
        );
        prepared = prepareAdditionalReadFieldArguments(
          prepared,
          "sys_atf_test_suite_test",
          "test"
        );
      }
      return resolution(
        prepared,
        args.suite_name
          ? [
              read("sys_atf_test"),
              read("sys_atf_test_suite"),
              read("sys_atf_test_suite_test"),
            ]
          : [read("sys_atf_test")]
      );
    }
    case "suites":
      authorizeReadQuery(
        encodedQueryAccess,
        "sn_atf",
        "sys_atf_test_suite",
        args
      );
      return resolution(
        prepareReadFieldArguments(args, "sys_atf_test_suite", {
          exposeFieldsArgument: true,
        }),
        [read("sys_atf_test_suite")]
      );
    case "results":
      authorizeReadQuery(
        encodedQueryAccess,
        "sn_atf",
        "sys_atf_test_result",
        args
      );
      return resolution(
        prepareReadFieldArguments(args, "sys_atf_test_result", {
          exposeFieldsArgument: true,
        }),
        [read("sys_atf_test_result")]
      );
    case "run":
    case "run-suite":
      // ATF definitions can mutate arbitrary application tables. The static
      // request does not carry a complete trusted side-effect manifest, so a
      // table-only policy cannot safely authorize execution.
      throw new TablePolicyError();
    default:
      throw new TablePolicyError();
  }
}

function aggregateResolution(
  args: Record<string, unknown>,
  encodedQueryAccess: EncodedQueryAccessPolicy
): ToolTableAccessResolution {
  const table = requiredTable(args.table);
  authorizeReadQuery(encodedQueryAccess, "sn_aggregate", table, args);
  const type = typeof args.type === "string" ? args.type.toUpperCase() : "";
  if (!type) {
    return resolution(
      prepareAdditionalReadFieldArguments(
        withFieldPolicyArgumentValues(args, { table }),
        table,
        "sys_id"
      ),
      [read(table)]
    );
  }
  if (!["COUNT", "AVG", "MIN", "MAX", "SUM"].includes(type)) {
    throw new FieldPolicyError("invalid_field_selection");
  }
  if (type !== "COUNT" && args.field === undefined) {
    throw new FieldPolicyError("invalid_field_selection");
  }

  const selected: string[] = [];
  let field: string | undefined;
  let groupBy: string | undefined;
  if (args.field !== undefined) {
    field = resolveReadableFields(table, { fields: args.field })[0];
    selected.push(field);
  }
  if (args.group_by !== undefined) {
    groupBy = resolveReadableFields(table, { fields: args.group_by })[0];
    if (!selected.includes(groupBy)) selected.push(groupBy);
  }
  if (selected.length === 0) selected.push("sys_id");

  const canonical: Record<string, unknown> = { table, type };
  if (field) canonical.field = field;
  if (groupBy) canonical.group_by = groupBy;
  const prepared = prepareAdditionalReadFieldArguments(
    withFieldPolicyArgumentValues(args, canonical),
    table,
    selected.join(",")
  );
  return resolution(prepared, [read(table)]);
}

function batchResolution(
  args: Record<string, unknown>
): ToolTableAccessResolution {
  const table = requiredTable(args.table);
  rejectRawEncodedWrite(args.query);
  if (args.structured_query === undefined) {
    throw new EncodedQueryPolicyError("encoded_write_prohibited");
  }
  if (
    args.action !== undefined &&
    args.action !== "update" &&
    args.action !== "delete"
  ) {
    throw new TablePolicyError();
  }
  let prepared = prepareAdditionalReadFieldArguments(
    withFieldPolicyArgumentValues(args, { table }),
    table,
    "sys_id"
  );
  const structuredPlan = compileStructuredQuery(
    args.structured_query,
    resolveReadableFields(table, { fields: "all" })
  );
  if (structuredPlan.structuredQuery.filter === undefined) {
    throw new EncodedQueryPolicyError("encoded_write_prohibited");
  }
  prepared = withFieldPolicyArgumentValues(prepared, {
    structured_query: structuredPlan.structuredQuery,
  });
  if (args.action === "update") {
    prepared = prepareWriteFieldArguments(prepared, table);
  }
  return resolution(
    prepared,
    args.confirm === true ? [read(table), write(table)] : [read(table)]
  );
}

function authorizeReadQuery(
  policy: EncodedQueryAccessPolicy,
  tool: string,
  table: string,
  args: Record<string, unknown>,
  outputFields: unknown = []
) {
  if (args.query === undefined) return undefined;
  return authorizeRawEncodedRead(policy, {
    tool,
    table,
    query: args.query,
    limit: args.limit ?? 20,
    offset: args.offset ?? 0,
    maxResponseBytes: args.max_response_bytes ?? 100_000,
    orderBy: args.orderby,
    outputFields,
  });
}

function withNamedTable(
  args: Record<string, unknown>,
  operations: readonly ("read" | "write")[]
): ToolTableAccessResolution {
  const table = requiredTable(args.table);
  return resolution(
    withFieldPolicyArgumentValues(args, { table }),
    operations.map((operation) => ({ operation, table }))
  );
}

function requiredTable(candidate: unknown): string {
  return normalizeTableName(candidate);
}

/** Validate and canonicalize the compatibility sort before any client work. */
function canonicalLegacyReadOrderBy(
  candidate: unknown,
  table: string
): string | undefined {
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") {
    throw new FieldPolicyError("invalid_field_selection");
  }
  const trimmed = candidate.trim();
  const descending = trimmed.startsWith("-");
  const requestedField = descending ? trimmed.slice(1) : trimmed;
  const fields = resolveReadableFields(table, { fields: requestedField });
  if (fields.length !== 1) {
    throw new FieldPolicyError("invalid_field_selection");
  }
  const [field] = fields;
  return `${descending ? "-" : ""}${field}`;
}

function read(table: string): TableAccessRequest {
  return Object.freeze({ operation: "read", table });
}

function write(table: string): TableAccessRequest {
  return Object.freeze({ operation: "write", table });
}

function resolution(
  args: Record<string, unknown>,
  requests: readonly TableAccessRequest[]
): ToolTableAccessResolution {
  const deduplicated = new Map<string, TableAccessRequest>();
  for (const request of requests) {
    const table = normalizeTableName(request.table);
    const normalized = Object.freeze({ operation: request.operation, table });
    deduplicated.set(`${request.operation}:${table}`, normalized);
  }
  return Object.freeze({
    args: Object.freeze(withFieldPolicyArgumentValues(args)),
    requests: Object.freeze([...deduplicated.values()]),
  });
}
