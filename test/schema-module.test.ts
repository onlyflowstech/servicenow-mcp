import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import { createEncodedQueryAccessPolicy } from "../src/encoded-query-policy.js";
import {
  MAX_FIELDS_PER_OPERATION,
  fieldSelectionToSysparmFields,
  resolveReadableFields,
} from "../src/field-policy.js";
import {
  definition,
  handler,
  moduleInputSchema,
  schema,
  schemaToolModule,
} from "../src/tools/schema-module.js";
import {
  definition as compatibilityDefinition,
  handler as compatibilityHandler,
  schema as compatibilitySchema,
} from "../src/tools/schema.js";
import { serviceNowToolModules } from "../src/tools/catalog.js";
import {
  finalizeEnvelopeResult,
  productionToolOutputSchemas,
} from "../src/tools/result-envelope.js";
import type { ServiceNowToolHandlerServices } from "../src/tools/tool-module.js";
import {
  createToolError,
  trustedToolErrorDescriptor,
} from "../src/tool-error.js";

const dictionaryRows = [
  {
    sys_id: "3".repeat(32),
    element: "short_description",
    column_label: "Short description",
    internal_type: "string",
    max_length: "160",
    mandatory: "true",
    reference: "",
  },
  {
    sys_id: "2".repeat(32),
    element: "number",
    column_label: "Number",
    internal_type: "string",
    max_length: "40",
    mandatory: "false",
    reference: "",
  },
  {
    sys_id: "1".repeat(32),
    element: "caller_id",
    column_label: "Caller",
    internal_type: "reference",
    max_length: "32",
    mandatory: "false",
    reference: "sys_user",
  },
  {
    sys_id: "4".repeat(32),
    element: "password",
    column_label: "Must never be disclosed",
    internal_type: "string",
    max_length: "255",
    mandatory: "false",
    reference: "",
  },
  {
    sys_id: "5".repeat(32),
    element: "u_unapproved",
    column_label: "Unapproved",
    internal_type: "string",
    max_length: "255",
    mandatory: "false",
    reference: "",
  },
];

const incidentReadableFields = resolveReadableFields("incident", {
  fields: "all",
});
// An open readable set enumerates every column, so no `elementIN` clause is
// emitted. An operator-narrowed readable set still produces one.
const incidentElementClause = fieldSelectionToSysparmFields(incidentReadableFields)
  ? `^elementIN${incidentReadableFields.join(",")}`
  : "";
const dictionaryQuery =
  "name=incident^internal_type!=collection" +
  incidentElementClause +
  "^ORDERBYelement^ORDERBYsys_id";
const dictionaryRequest = {
  sysparm_query: dictionaryQuery,
  sysparm_fields:
    "sys_id,element,column_label,internal_type,max_length,mandatory,reference",
  sysparm_limit: String(MAX_FIELDS_PER_OPERATION + 1),
  sysparm_offset: "0",
  sysparm_display_value: "true",
};
const fullDictionaryRequest = {
  ...dictionaryRequest,
  sysparm_query: dictionaryQuery.replace("name=incident", "nameINincident"),
  sysparm_fields:
    "sys_id,name,element,column_label,internal_type,max_length,mandatory,reference",
};

function fakeOperations(result: unknown = dictionaryRows) {
  const get = vi.fn(async () => ({ result }));
  return {
    get,
    operations: { get } as unknown as ServiceNowOperations,
  };
}

function policy() {
  return {
    encodedQueryAccess: createEncodedQueryAccessPolicy(),
  } as Parameters<typeof schemaToolModule.resolveAccess>[1];
}

function services(
  serviceNow: ServiceNowOperations
): ServiceNowToolHandlerServices {
  return {
    serviceNow,
    settings: {
      instance: "https://schema-module.service-now.com",
      displayValue: "true",
      relDepth: 3,
    },
  } as ServiceNowToolHandlerServices;
}

function responseData(result: Awaited<ReturnType<typeof schemaToolModule.invoke>>) {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text response");
  return JSON.parse(first.text) as unknown;
}

describe("SNSDK-46 sn_schema module", () => {
  it("preserves the public name and compatible input contract", () => {
    expect(definition.name).toBe("sn_schema");
    expect(definition.annotations).toEqual({
      title: "Get table schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(schema.parse({ table: "incident" })).toEqual({
      table: "incident",
      fields_only: false,
      force_recache: false,
      limit: 500,
      offset: 0,
    });
    expect(
      moduleInputSchema.parse({
        table: "incident",
        fields_only: true,
        profile: "  production  ",
      })
    ).toEqual({
      table: "incident",
      fields_only: true,
      force_recache: false,
      limit: 500,
      offset: 0,
      profile: "production",
    });
    expect(moduleInputSchema.safeParse({ table: "incident" }).success).toBe(false);
    expect(
      moduleInputSchema.safeParse({
        table: "incident",
        profile: "production",
        limit: 0,
      }).success
    ).toBe(false);
    expect(
      moduleInputSchema.safeParse({
        table: "incident",
        profile: "production",
        limit: 501,
      }).success
    ).toBe(false);
    expect(
      moduleInputSchema.safeParse({
        table: "incident",
        profile: "production",
        offset: -1,
      }).success
    ).toBe(false);
    expect(
      moduleInputSchema.safeParse({
        table: "incident",
        profile: "production",
        offset: 10_001,
      }).success
    ).toBe(false);
    expect(compatibilityDefinition).toBe(definition);
    expect(compatibilitySchema).toBe(schema);
    expect(compatibilityHandler).toBe(handler);
  });

  it("declares and resolves the complete metadata access boundary", () => {
    expect(schemaToolModule.runtime).toBe("servicenow");
    expect(schemaToolModule.definition).toEqual(definition);
    expect(schemaToolModule.outputSchema).toBe(
      productionToolOutputSchemas.sn_schema
    );
    expect(
      serviceNowToolModules.find((module) => module.definition.name === "sn_schema")
    ).toBe(schemaToolModule);
    expect(schemaToolModule.requirements).toEqual({
      permissions: ["read"],
      tables: {
        kind: "dynamic",
        names: ["sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice"],
        description:
          "Caller-selected policy-approved target plus ServiceNow dictionary metadata, inheritance, labels, help, and choices.",
      },
      apis: ["table"],
      fieldPolicies: ["read"],
      capabilities: ["metadata:schema"],
    });

    const access = schemaToolModule.resolveAccess(
      {
        table: " INCIDENT ",
        fields_only: false,
        limit: 500,
        offset: 0,
        profile: "production",
      },
      policy()
    );
    expect(access.args).toMatchObject({
      table: "incident",
      fields_only: false,
      limit: 500,
      offset: 0,
      profile: "production",
    });
    expect(access.requests).toEqual([
      { operation: "read", table: "incident" },
      { operation: "read", table: "sys_dictionary" },
      { operation: "read", table: "sys_db_object" },
      { operation: "read", table: "sys_documentation" },
      { operation: "read", table: "sys_choice" },
    ]);
    expect(Object.isFrozen(access.args)).toBe(true);
    expect(Object.isFrozen(access.requests)).toBe(true);

    // A table with no field-policy entry is no longer denied here; whether it
    // is reachable is decided by the profile's tableAccess grant.
    expect(() =>
      schemaToolModule.resolveAccess(
        {
          table: "u_unclassified",
          fields_only: false,
          limit: 500,
          offset: 0,
          profile: "production",
        },
        policy()
      )
    ).not.toThrow();
  });

  it("returns sorted representative metadata and excludes unauthorized fields", async () => {
    const fake = fakeOperations();
    const access = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: false,
        limit: 500,
        offset: 0,
        profile: "production",
      },
      policy()
    );

    const result = await schemaToolModule.invoke(
      access.args,
      services(fake.operations)
    );

    expect(result.isError).toBeUndefined();
    expect(fake.get).toHaveBeenCalledWith(
      "/api/now/table/sys_dictionary",
      fullDictionaryRequest
    );
    expect(dictionaryQuery).not.toMatch(/password/u);
    expect(responseData(result)).toEqual([
      {
        field: "caller_id",
        label: "Caller",
        type: "reference",
        max_length: "32",
        mandatory: "false",
        reference: "sys_user",
      },
      {
        field: "number",
        label: "Number",
        type: "string",
        max_length: "40",
        mandatory: "false",
        reference: null,
      },
      {
        field: "short_description",
        label: "Short description",
        type: "string",
        max_length: "160",
        mandatory: "true",
        reference: null,
      },
      // Enumerated now that the built-in readable list no longer withholds
      // columns. Sensitive names are still removed.
      {
        field: "u_unapproved",
        label: "Unapproved",
        type: "string",
        max_length: "255",
        mandatory: "false",
        reference: null,
      },
    ]);
    expect(JSON.stringify(responseData(result))).not.toMatch(
      /password|Must never/u
    );
    expect(result.structuredContent).toEqual({
      data: { fields: responseData(result) },
      metadata: {
        kind: "collection",
        record_count: 4,
        limits: { max_records: 1000, max_bytes: 100000 },
        pagination: {
          mode: "offset",
          limit: 500,
          offset: 0,
          returned: 4,
          has_more: false,
          order_by: ["field", "sys_id"],
        },
        truncation: { truncated: false },
      },
    });
  });

  it("keeps fields_only compatible and returns only policy-approved names", async () => {
    const fake = fakeOperations();
    const access = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: true,
        limit: 500,
        offset: 0,
        profile: "production",
      },
      policy()
    );
    const result = await schemaToolModule.invoke(
      access.args,
      services(fake.operations)
    );

    // The built-in readable list no longer withholds columns, so an
    // unapproved-looking name is enumerated. Sensitive names are still removed.
    expect(responseData(result)).toEqual([
      "caller_id",
      "number",
      "short_description",
      "u_unapproved",
    ]);
  });

  it("pages the complete bounded authorized set without denied-leading gaps", async () => {
    const fake = fakeOperations();
    const access = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: true,
        limit: 2,
        offset: 0,
        profile: "production",
      },
      policy()
    );
    const result = await schemaToolModule.invoke(
      access.args,
      services(fake.operations)
    );

    expect(fake.get).toHaveBeenCalledWith(
      "/api/now/table/sys_dictionary",
      expect.objectContaining({
        sysparm_query: dictionaryQuery,
        sysparm_limit: String(MAX_FIELDS_PER_OPERATION + 1),
        sysparm_offset: "0",
      })
    );
    expect(responseData(result)).toEqual(["caller_id", "number"]);
    expect(result.structuredContent).toMatchObject({
      data: { fields: ["caller_id", "number"] },
      metadata: {
        record_count: 2,
        pagination: {
          mode: "offset",
          limit: 2,
          offset: 0,
          returned: 2,
          has_more: true,
          next_offset: 2,
          order_by: ["field", "sys_id"],
        },
        truncation: { truncated: false },
      },
    });
  });

  it("keeps mixed and ACL-thinned pages monotonic without replay or skip", async () => {
    const aclVisibleRows = [
      dictionaryRows[3],
      dictionaryRows[4],
      dictionaryRows[2],
      dictionaryRows[0],
    ];
    const fake = fakeOperations(aclVisibleRows);

    const firstAccess = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: true,
        limit: 1,
        offset: 0,
        profile: "production",
      },
      policy()
    );
    const first = await schemaToolModule.invoke(
      firstAccess.args,
      services(fake.operations)
    );
    expect(responseData(first)).toEqual(["caller_id"]);
    expect(first.structuredContent).toMatchObject({
      metadata: {
        pagination: {
          offset: 0,
          returned: 1,
          has_more: true,
          next_offset: 1,
        },
      },
    });

    const secondAccess = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: true,
        limit: 1,
        offset: 1,
        profile: "production",
      },
      policy()
    );
    const second = await schemaToolModule.invoke(
      secondAccess.args,
      services(fake.operations)
    );
    expect(responseData(second)).toEqual(["short_description"]);
    // `u_unapproved` is now an approved name, so the ACL-visible page set is
    // one longer and the walk continues rather than ending here.
    expect(second.structuredContent).toMatchObject({
      metadata: {
        pagination: {
          offset: 1,
          returned: 1,
          has_more: true,
          next_offset: 2,
        },
      },
    });

    const thirdAccess = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: true,
        limit: 1,
        offset: 2,
        profile: "production",
      },
      policy()
    );
    const third = await schemaToolModule.invoke(
      thirdAccess.args,
      services(fake.operations)
    );
    expect(responseData(third)).toEqual(["u_unapproved"]);
    expect(third.structuredContent).toMatchObject({
      metadata: {
        pagination: {
          offset: 2,
          returned: 1,
          has_more: false,
        },
      },
    });
    expect(JSON.stringify([first, second])).not.toMatch(
      /password|Must never|u_unapproved/u
    );
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(fake.get.mock.calls.every((call) => call[1]?.sysparm_offset === "0"))
      .toBe(true);
  });

  it("distinguishes exact-page exhaustion from continuation", async () => {
    const fake = fakeOperations([dictionaryRows[1], dictionaryRows[0]]);
    const access = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: true,
        limit: 2,
        offset: 0,
        profile: "production",
      },
      policy()
    );
    const result = await schemaToolModule.invoke(
      access.args,
      services(fake.operations)
    );

    expect(responseData(result)).toEqual(["number", "short_description"]);
    expect(result.structuredContent).toMatchObject({
      metadata: {
        record_count: 2,
        pagination: {
          offset: 0,
          returned: 2,
          has_more: false,
        },
      },
    });
    expect(
      (result.structuredContent?.metadata as { pagination: object }).pagination
    ).not.toHaveProperty("next_offset");
  });

  it("fails closed when upstream ignores the authorized row cap", async () => {
    const oversized = Array.from(
      { length: MAX_FIELDS_PER_OPERATION + 1 },
      (_, index) => ({
        ...dictionaryRows[index % 3],
        sys_id: String(index).padStart(32, "0"),
      })
    );
    const fake = fakeOperations(oversized);
    const access = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: false,
        limit: 500,
        offset: 0,
        profile: "production",
      },
      policy()
    );
    await expect(
      schemaToolModule.invoke(access.args, services(fake.operations))
    ).rejects.toThrow("dictionary result exceeded the authorized field bound");
    expect(fake.get).toHaveBeenCalledTimes(2);
  });

  it("fits successful module output to the shared production byte bound", async () => {
    const fake = fakeOperations(
      Array.from({ length: MAX_FIELDS_PER_OPERATION }, (_, index) => ({
        ...dictionaryRows[index % 3],
        sys_id: String(index).padStart(32, "0"),
        element: incidentReadableFields[index],
        column_label: `Field ${index} ${"x".repeat(4_000)}`,
      }))
    );
    const access = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: false,
        limit: 500,
        offset: 0,
        profile: "production",
      },
      policy()
    );
    const result = await schemaToolModule.invoke(
      access.args,
      services(fake.operations)
    );
    const finalized = finalizeEnvelopeResult({
      ...result,
      structuredContent: {
        ...(result.structuredContent as Record<string, unknown>),
        profile: "production",
      },
    });

    expect(finalized).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(finalized), "utf8")).toBeLessThanOrEqual(
      100_000
    );
    expect(finalized?.structuredContent).toMatchObject({
      profile: "production",
    });
  });

  it("uses the shared safe error convention without leaking upstream detail", async () => {
    const upstreamError = createToolError(
      "authorization",
      "retry_after_correction"
    );
    const upstream = {
      get: vi.fn(async () => {
        throw upstreamError;
      }),
    } as unknown as ServiceNowOperations;
    const access = schemaToolModule.resolveAccess(
      {
        table: "incident",
        fields_only: false,
        limit: 500,
        offset: 0,
        profile: "production",
      },
      policy()
    );

    let thrown: unknown;
    try {
      await schemaToolModule.invoke(access.args, services(upstream));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(upstreamError);
    expect(trustedToolErrorDescriptor(thrown)).toMatchObject({
      category: "authorization",
      retry: "retry_after_correction",
    });
    expect(JSON.stringify(trustedToolErrorDescriptor(thrown))).not.toContain(
      "secret-must-not-leak"
    );
  });
});
