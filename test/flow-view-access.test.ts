import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FieldPolicyError,
  fieldPolicyDenialMessage,
  isFieldPolicyError,
  preparedReadableFields,
  runWithFieldPolicyConfiguration,
} from "../src/field-policy.js";
import {
  TablePolicyError,
  authorizeTableAccessPlan,
  createTableAccessPolicy,
} from "../src/table-policy.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";
import {
  FLOW_TABLE_FIELDS,
  FLOW_VIEW_TABLES,
} from "../src/tools/flow-view-contracts.js";
import { canShow, flowFieldPlanFromArgs, inputsIncluded } from "../src/tools/flow-view-policy.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  withResolvedProfileOutput,
  type ServiceNowApiFamily,
} from "../src/tools/tool-module.js";

/** Tables a profile's "*" field-policy entry covers (everything but the system table). */
const STAR_TABLES = FLOW_VIEW_TABLES.filter((table) => table !== "sys_variable_value");

/** Every structural field any "*"-covered table requires. */
const STAR_REQUIRED = [...new Set(STAR_TABLES.flatMap((table) => FLOW_TABLE_FIELDS[table].required))];

function resolve(args: Record<string, unknown>) {
  return resolveToolTableAccess("sn_flow_view", { profile: "dev", ...args });
}

function withPolicy<T>(fieldPolicy: Record<string, unknown>, action: () => T): T {
  return runWithFieldPolicyConfiguration({ fieldPolicy }, action);
}

function deniedWith(action: () => unknown): FieldPolicyError {
  try {
    action();
  } catch (error) {
    expect(isFieldPolicyError(error)).toBe(true);
    return error as FieldPolicyError;
  }
  throw new Error("expected a field-policy denial");
}

describe("sn_flow_view access plan", () => {
  it("reads all 15 closure tables, frozen, with canonical defaults", () => {
    const access = resolve({ flow: "  Route incident  " });
    expect(access.requests).toEqual(FLOW_VIEW_TABLES.map((table) => ({ operation: "read", table })));
    expect(access.requests).toHaveLength(15);
    expect(access.requests.map((request) => request.table)).not.toContain("sys_hub_flow_version");
    expect(Object.isFrozen(access.requests)).toBe(true);
    expect(Object.isFrozen(access.args)).toBe(true);
    expect(access.args).toMatchObject({
      profile: "dev",
      flow: "Route incident",
      depth: 1,
      include_inputs: true,
      format: "both",
      max_nodes: 150,
      max_response_bytes: 100_000,
    });
    expect(Object.hasOwn(access.args, "source")).toBe(false);
  });

  it("prepares every table with required, optional and value fields under the open policy", () => {
    const access = resolve({ flow: "x" });
    for (const table of FLOW_VIEW_TABLES) {
      const spec = FLOW_TABLE_FIELDS[table];
      expect(preparedReadableFields(access.args, table)).toEqual([
        ...spec.required,
        ...spec.optional,
        ...spec.values,
      ]);
    }
    const plan = flowFieldPlanFromArgs(access.args);
    expect(inputsIncluded(plan)).toBe(true);
    expect(canShow(plan, "action_inputs")).toBe(true);
    expect(canShow(plan, "pill_labels")).toBe(true);
  });

  it("requests no value field at all when include_inputs is false", () => {
    const access = resolve({ flow: "x", include_inputs: false });
    expect(access.args.include_inputs).toBe(false);
    expect(access.requests).toHaveLength(15);
    for (const table of FLOW_VIEW_TABLES) {
      const fields = preparedReadableFields(access.args, table) ?? [];
      const values = FLOW_TABLE_FIELDS[table].values;
      expect(fields.filter((field) => values.includes(field)), table).toEqual([]);
      expect(fields).toEqual(expect.arrayContaining([...FLOW_TABLE_FIELDS[table].required]));
    }
    expect(inputsIncluded(flowFieldPlanFromArgs(access.args))).toBe(false);
  });

  it("is all or nothing: a missing table grant denies the whole call", () => {
    const access = resolve({ flow: "x" });
    const grant = (tables: readonly string[]) =>
      createTableAccessPolicy({
        readTables: [...tables],
        targets: tables.map((table) => ({
          table,
          kind: "canonical" as const,
          tools: ["sn_flow_view"],
          closureComplete: true as const,
          relatedTables: [table],
        })),
      });
    expect(
      authorizeTableAccessPlan(grant(FLOW_VIEW_TABLES), access.requests, "sn_flow_view")
    ).toHaveLength(15);
    const wildcard = createTableAccessPolicy({ readTables: ["*"] });
    expect(authorizeTableAccessPlan(wildcard, access.requests, "sn_flow_view")).toHaveLength(15);

    for (const missing of FLOW_VIEW_TABLES) {
      const partial = grant(FLOW_VIEW_TABLES.filter((table) => table !== missing));
      expect(
        () => authorizeTableAccessPlan(partial, access.requests, "sn_flow_view"),
        missing
      ).toThrow(TablePolicyError);
    }
  });

  it("honors targets[].tools: every table must name sn_flow_view", () => {
    const access = resolve({ flow: "x" });
    const targets = (tools: (table: string) => string[]) =>
      FLOW_VIEW_TABLES.map((table) => ({
        table,
        kind: "canonical" as const,
        tools: tools(table),
        closureComplete: true as const,
        relatedTables: [table],
      }));
    const scoped = createTableAccessPolicy({
      readTables: [...FLOW_VIEW_TABLES],
      targets: targets(() => ["sn_flow_view"]),
    });
    expect(authorizeTableAccessPlan(scoped, access.requests, "sn_flow_view")).toHaveLength(15);

    const oneMissing = createTableAccessPolicy({
      readTables: [...FLOW_VIEW_TABLES],
      targets: targets((table) => (table === "var_dictionary" ? ["sn_query"] : ["sn_flow_view"])),
    });
    expect(() => authorizeTableAccessPlan(oneMissing, access.requests, "sn_flow_view")).toThrow(
      TablePolicyError
    );
  });

  it("denies an unreadable required field with an actionable FieldPolicyError", () => {
    const readable = STAR_REQUIRED.filter((field) => field !== "connected_to");
    const error = withPolicy({ "*": { readable } }, () =>
      deniedWith(() => resolve({ flow: "x" }))
    );
    expect(error.reason).toBe("unreadable_field");
    expect(error.table).toBe("sys_hub_flow_logic");
    expect(error.field).toBe("connected_to");
    expect(fieldPolicyDenialMessage(error)).toContain(
      'field "connected_to" is not readable on "sys_hub_flow_logic"'
    );
    expect(fieldPolicyDenialMessage(error)).toContain("fieldPolicy.sys_hub_flow_logic.readable");
  });

  it("names the exact table when one table's own entry drops a required field", () => {
    const error = withPolicy(
      { sys_hub_flow_input: { readable: ["sys_id", "model", "label"] } },
      () => deniedWith(() => resolve({ flow: "x" }))
    );
    expect(error.reason).toBe("unreadable_field");
    expect(error.table).toBe("sys_hub_flow_input");
    expect(error.field).toBe("element");
  });

  it("intersects optional and value fields instead of denying them", () => {
    const access = withPolicy({ "*": { readable: STAR_REQUIRED } }, () =>
      resolve({ flow: "x" })
    );
    for (const table of STAR_TABLES) {
      const spec = FLOW_TABLE_FIELDS[table];
      expect(preparedReadableFields(access.args, table), table).toEqual([
        ...spec.required,
        // Only fields that some other table requires survive "*".
        ...[...spec.optional, ...spec.values].filter((field) => STAR_REQUIRED.includes(field)),
      ]);
    }
    const plan = flowFieldPlanFromArgs(access.args);
    expect(canShow(plan, "flow_name")).toBe(true);
    expect(canShow(plan, "flow_description")).toBe(false);
    expect(canShow(plan, "action_annotation")).toBe(false);
    expect(canShow(plan, "action_inputs")).toBe(false);
    expect(canShow(plan, "flow_inputs")).toBe(false);
  });

  it('narrows sys_hub_* and var_dictionary through "*", but never sys_variable_value', () => {
    const access = withPolicy({ "*": { readable: STAR_REQUIRED } }, () =>
      resolve({ flow: "x" })
    );
    expect(preparedReadableFields(access.args, "sys_hub_action_instance_v2")).not.toContain("values");
    expect(preparedReadableFields(access.args, "var_dictionary")).toEqual(["sys_id", "element"]);
    // The system table keeps its built-in entry, value included.
    expect(preparedReadableFields(access.args, "sys_variable_value")).toEqual([
      "sys_id",
      "document",
      "document_key",
      "variable",
      "order",
      "value",
    ]);
  });

  it("hides V1 values only when sys_variable_value is named", () => {
    const access = withPolicy(
      {
        sys_variable_value: {
          readable: ["sys_id", "document", "document_key", "variable", "order"],
        },
      },
      () => resolve({ flow: "x" })
    );
    expect(preparedReadableFields(access.args, "sys_variable_value")).not.toContain("value");
    const plan = flowFieldPlanFromArgs(access.args);
    // V2 blobs are still readable, but every input element needs both storages.
    expect(plan.readable.get("sys_hub_action_instance_v2")?.has("values")).toBe(true);
    for (const element of ["trigger_inputs", "action_inputs", "logic_inputs", "subflow_inputs"] as const) {
      expect(canShow(plan, element), element).toBe(false);
    }
    expect(canShow(plan, "action_title")).toBe(true);
  });

  it("hides every input when V1 input types are unreadable", () => {
    const access = withPolicy({ var_dictionary: { readable: ["sys_id", "element"] } }, () =>
      resolve({ flow: "x" })
    );
    const plan = flowFieldPlanFromArgs(access.args);
    expect(plan.readable.get("var_dictionary")?.has("internal_type")).toBe(false);
    expect(canShow(plan, "action_inputs")).toBe(false);
    expect(canShow(plan, "subflow_inputs")).toBe(false);
  });

  it("denies the call when sys_variable_value is not readable at all", () => {
    const error = withPolicy({ sys_variable_value: { readable: [] } }, () =>
      deniedWith(() => resolve({ flow: "x" }))
    );
    expect(error.table).toBe("sys_variable_value");
  });

  it("fails closed on arguments the input schema should have rejected", () => {
    for (const args of [{}, { flow: "" }, { flow: "x", depth: 9 }, { flow: "x", format: "html" }]) {
      expect(() => resolve(args), JSON.stringify(args)).toThrow(TablePolicyError);
    }
  });
});

describe("API families", () => {
  function probe(apis: readonly string[]) {
    return defineServiceNowToolModule({
      runtime: "servicenow",
      definition: {
        name: "sn_flow_view_probe",
        description: "Test-only probe for the API family enum.",
        annotations: {
          title: "Flow view probe",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      inputSchema: withRequiredProfile(z.object({})),
      outputSchema: withResolvedProfileOutput(z.object({})),
      requirements: {
        permissions: ["read"],
        tables: { kind: "static", names: [...FLOW_VIEW_TABLES] },
        apis: apis as readonly ServiceNowApiFamily[],
        fieldPolicies: ["read"],
        capabilities: ["flow:view"],
      },
      resolveAccess: (args) => ({ args: args as Record<string, unknown>, requests: [] }),
      handler: async (): Promise<CallToolResult> => ({ content: [] }),
    });
  }

  it("declares sn_flow_view as a Table API tool", () => {
    expect(probe(["table"]).requirements.apis).toEqual(["table"]);
  });

  it("has no processflow family", () => {
    expect(() => probe(["processflow"])).toThrow(TypeError);
    expect(() => probe(["processflow", "table"])).toThrow(TypeError);
  });
});
