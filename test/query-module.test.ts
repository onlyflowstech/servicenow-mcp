import { describe, expect, it, vi } from "vitest";

import type { ServiceNowOperations } from "../src/client.js";
import {
  createEncodedQueryAccessPolicy,
  SUPPORTED_ENCODED_QUERY_OPERATORS,
  type EncodedQueryAccessPolicy,
} from "../src/encoded-query-policy.js";
import {
  definition,
  handler,
  moduleInputSchema,
  queryToolModule,
  schema,
} from "../src/tools/query-module.js";
import {
  definition as compatibilityDefinition,
  handler as compatibilityHandler,
  moduleInputSchema as compatibilityModuleInputSchema,
  queryToolModule as compatibilityToolModule,
  schema as compatibilitySchema,
} from "../src/tools/query.js";
import { serviceNowToolModules } from "../src/tools/catalog.js";
import { productionToolOutputSchemas } from "../src/tools/result-envelope.js";
import type { ServiceNowToolHandlerServices } from "../src/tools/tool-module.js";

const PROFILE = "production";

function policy(encodedQueryAccess = createEncodedQueryAccessPolicy()) {
  return { encodedQueryAccess } as Parameters<
    typeof queryToolModule.resolveAccess
  >[1];
}

function services(
  serviceNow: ServiceNowOperations,
  encodedQueryAccess = createEncodedQueryAccessPolicy()
): ServiceNowToolHandlerServices {
  return {
    serviceNow,
    settings: {
      instance: "https://query-module.service-now.com",
      displayValue: "true",
      relDepth: 3,
    },
    context: { effectivePolicy: { encodedQueryAccess } },
  } as ServiceNowToolHandlerServices;
}

function responseData(
  result: Awaited<ReturnType<typeof queryToolModule.invoke>>
): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text response");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function fakeOperations(
  implementation: (
    path: string,
    params: Record<string, string>
  ) => Promise<{
    data: { result: unknown[] };
    status: number;
    headers: Headers;
  }>
) {
  const getWithMeta = vi.fn(implementation);
  return {
    getWithMeta,
    operations: { getWithMeta } as unknown as ServiceNowOperations,
  };
}

function parsedInput(overrides: Record<string, unknown> = {}) {
  return moduleInputSchema.parse({
    profile: PROFILE,
    table: "incident",
    ...overrides,
  });
}

describe("SNSDK-47 sn_query module", () => {
  it("owns the exact public contract while preserving compatibility exports", () => {
    expect(definition.name).toBe("sn_query");
    expect(definition.annotations).toEqual({
      title: "Query records",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(schema.parse({ table: "incident" })).toMatchObject({
      table: "incident",
      limit: 20,
      response_format: "concise",
      max_response_bytes: 100_000,
    });
    expect(moduleInputSchema.safeParse({ table: "incident" }).success).toBe(
      false
    );
    expect(
      moduleInputSchema.safeParse({
        profile: PROFILE,
        table: "incident",
        sysparm_query: "active=true",
      }).success
    ).toBe(false);
    expect(compatibilityDefinition).toBe(definition);
    expect(compatibilitySchema).toBe(schema);
    expect(compatibilityModuleInputSchema).toBe(moduleInputSchema);
    expect(compatibilityHandler).toBe(handler);
    expect(compatibilityToolModule).toBe(queryToolModule);
  });

  it("declares one exact module and resolves its complete access boundary", () => {
    expect(queryToolModule.runtime).toBe("servicenow");
    expect(queryToolModule.outputSchema).toBe(
      productionToolOutputSchemas.sn_query
    );
    expect(
      serviceNowToolModules.find(
        (module) => module.definition.name === "sn_query"
      )
    ).toBe(queryToolModule);
    expect(queryToolModule.requirements).toEqual({
      permissions: ["read"],
      tables: {
        kind: "dynamic",
        names: [],
        description: "Caller-selected policy-approved table.",
      },
      apis: ["table"],
      fieldPolicies: ["read"],
      capabilities: ["records:query"],
    });

    const access = queryToolModule.resolveAccess(
      parsedInput({ table: " INCIDENT ", fields: "sys_id,number" }),
      policy()
    );
    expect(access.args).toMatchObject({
      profile: PROFILE,
      table: "incident",
      fields: "sys_id,number",
      limit: 20,
    });
    expect(access.requests).toEqual([{ operation: "read", table: "incident" }]);
    expect(Object.isFrozen(access.args)).toBe(true);
    expect(Object.isFrozen(access.requests)).toBe(true);
  });

  it("compiles structured filters, stabilizes ordering, and filters output", async () => {
    const fake = fakeOperations(async () => ({
      data: {
        result: [
          {
            sys_id: "1".repeat(32),
            number: "INC0010001",
            priority: "1",
            password: "must-not-cross",
          },
          {
            sys_id: "2".repeat(32),
            number: "INC0010002",
            priority: "1",
            u_unapproved: "must-not-cross",
          },
        ],
      },
      status: 200,
      headers: new Headers({ "x-total-count": "3" }),
    }));
    const access = queryToolModule.resolveAccess(
      parsedInput({
        fields: "sys_id,number,priority",
        limit: 2,
        offset: 0,
        structured_query: {
          filter: {
            type: "equality",
            field: "priority",
            operator: "eq",
            value: "1",
          },
          order_by: [{ field: "number", direction: "asc" }],
        },
      }),
      policy()
    );
    const result = await queryToolModule.invoke(
      access.args,
      services(fake.operations)
    );

    expect(fake.getWithMeta).toHaveBeenCalledWith("/api/now/table/incident", {
      sysparm_exclude_reference_link: "true",
      sysparm_limit: "3",
      sysparm_query: "priority=1^ORDERBYnumber^ORDERBYsys_id",
      sysparm_fields: "sys_id,number,priority",
      sysparm_offset: "0",
      sysparm_display_value: "true",
      sysparm_no_count: "true",
    });
    expect(responseData(result)).toEqual({
      record_count: 2,
      total: 3,
      has_more: true,
      next_offset: 2,
      hint: "More records available. Call sn_query again with offset=2.",
      results: [
        { sys_id: "1".repeat(32), number: "INC0010001", priority: "1" },
        { sys_id: "2".repeat(32), number: "INC0010002", priority: "1" },
      ],
    });
    expect(result.structuredContent).toMatchObject({
      metadata: {
        record_count: 2,
        pagination: {
          mode: "offset",
          limit: 2,
          offset: 0,
          returned: 2,
          has_more: true,
          next_offset: 2,
          order_by: ["number", "sys_id"],
        },
        truncation: { truncated: false },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/password|u_unapproved/u);
  });

  it("continues after an ACL-thinned full upstream window without replay", async () => {
    const fake = fakeOperations(async (_path, params) => {
      const offset = params.sysparm_offset ?? "0";
      return {
        data: {
          result:
            offset === "0"
              ? [
                  null,
                  "policy-filtered-upstream-row",
                  { sys_id: "sentinel-must-not-be-returned" },
                ]
              : [{ sys_id: "3".repeat(32) }],
        },
        status: 200,
        headers: new Headers(),
      };
    });

    const firstAccess = queryToolModule.resolveAccess(
      parsedInput({ fields: "sys_id", limit: 2, offset: 0 }),
      policy()
    );
    const first = await queryToolModule.invoke(
      firstAccess.args,
      services(fake.operations)
    );
    expect(responseData(first)).toMatchObject({
      record_count: 0,
      has_more: true,
      next_offset: 2,
      results: [],
    });
    expect(first.structuredContent).toMatchObject({
      metadata: {
        pagination: {
          offset: 0,
          returned: 0,
          has_more: true,
          next_offset: 2,
        },
      },
    });

    const secondAccess = queryToolModule.resolveAccess(
      parsedInput({ fields: "sys_id", limit: 2, offset: 2 }),
      policy()
    );
    const second = await queryToolModule.invoke(
      secondAccess.args,
      services(fake.operations)
    );
    expect(responseData(second)).toMatchObject({
      record_count: 1,
      has_more: false,
      results: [{ sys_id: "3".repeat(32) }],
    });
    expect(responseData(second)).not.toHaveProperty("next_offset");
    expect(fake.getWithMeta).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an exact full no-header page from a sentinel page", async () => {
    const exactRows = [
      { sys_id: "1".repeat(32) },
      { sys_id: "2".repeat(32) },
    ];
    const sentinelRows = [...exactRows, { sys_id: "3".repeat(32) }];
    const fake = fakeOperations(async (_path, params) => ({
      data: {
        result: params.sysparm_offset === "0" ? exactRows : sentinelRows,
      },
      status: 200,
      headers: new Headers(),
    }));

    const exactAccess = queryToolModule.resolveAccess(
      parsedInput({ fields: "sys_id", limit: 2, offset: 0 }),
      policy()
    );
    const exact = await queryToolModule.invoke(
      exactAccess.args,
      services(fake.operations)
    );
    expect(responseData(exact)).toMatchObject({
      record_count: 2,
      has_more: false,
      results: exactRows,
    });
    expect(responseData(exact)).not.toHaveProperty("next_offset");

    const sentinelAccess = queryToolModule.resolveAccess(
      parsedInput({ fields: "sys_id", limit: 2, offset: 5 }),
      policy()
    );
    const sentinel = await queryToolModule.invoke(
      sentinelAccess.args,
      services(fake.operations)
    );
    expect(responseData(sentinel)).toMatchObject({
      record_count: 2,
      has_more: true,
      next_offset: 7,
      results: exactRows,
    });
    expect(JSON.stringify(responseData(sentinel))).not.toContain(
      "33333333333333333333333333333333"
    );
    expect(
      fake.getWithMeta.mock.calls.every(
        (call) => call[1]?.sysparm_limit === "3"
      )
    ).toBe(true);
  });

  it("fails closed for sensitive fields, unsupported operators, and mixed modes", () => {
    expect(() =>
      queryToolModule.resolveAccess(
        parsedInput({ fields: "sys_id,password" }),
        policy()
      )
    ).toThrow("Field access denied by policy");
    expect(
      moduleInputSchema.safeParse({
        profile: PROFILE,
        table: "incident",
        structured_query: {
          filter: {
            type: "text",
            field: "short_description",
            operator: "javascript",
            value: "unsafe",
          },
        },
      }).success
    ).toBe(false);
    expect(() =>
      queryToolModule.resolveAccess(
        parsedInput({
          query: "active=true",
          structured_query: {
            filter: {
              type: "equality",
              field: "priority",
              operator: "eq",
              value: "1",
            },
          },
        }),
        policy()
      )
    ).toThrow();
    for (const orderby of [
      "password",
      "-",
      "priority^ORDERBYpassword",
      "priority,number",
    ]) {
      expect(() =>
        queryToolModule.resolveAccess(parsedInput({ orderby }), policy())
      ).toThrow("Field access denied by policy");
    }
  });

  it("normalizes approved legacy ascending and descending order fields in preflight", () => {
    const ascending = queryToolModule.resolveAccess(
      parsedInput({ orderby: " PRIORITY " }),
      policy()
    );
    const descending = queryToolModule.resolveAccess(
      parsedInput({ orderby: " -Priority " }),
      policy()
    );

    expect(ascending.args.orderby).toBe("priority");
    expect(descending.args.orderby).toBe("-priority");
  });

  it("denies legacy raw queries by default before upstream access", () => {
    expect(() =>
      queryToolModule.resolveAccess(
        parsedInput({ query: "active=true", fields: "active" }),
        policy()
      )
    ).toThrow("Raw encoded query denied by policy");
  });

  it("preserves an explicitly approved bounded legacy query", async () => {
    const encodedQueryAccess: EncodedQueryAccessPolicy =
      createEncodedQueryAccessPolicy({
        rules: [
          {
            tool: "sn_query",
            table: "incident",
            maxLength: 128,
            maxTerms: 4,
            fields: ["active", "priority"],
            operators: SUPPORTED_ENCODED_QUERY_OPERATORS,
            maxLimit: 20,
            maxOffset: 0,
            maxResponseBytes: 100_000,
          },
        ],
      });
    const fake = fakeOperations(async () => ({
      data: { result: [{ active: true, priority: "1" }] },
      status: 200,
      headers: new Headers(),
    }));
    const access = queryToolModule.resolveAccess(
      parsedInput({
        query: "active=true^priority=1",
        fields: "active,priority",
        orderby: " -Priority ",
      }),
      policy(encodedQueryAccess)
    );
    const result = await queryToolModule.invoke(
      access.args,
      services(fake.operations, encodedQueryAccess)
    );

    expect(fake.getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({
        sysparm_query:
          "active=true^priority=1^ORDERBYDESCpriority^ORDERBYsys_id",
        sysparm_fields: "active,priority",
      })
    );
    expect(responseData(result)).toMatchObject({
      results: [{ active: true, priority: "1" }],
    });
  });
});
