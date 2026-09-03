import { describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import {
  createEncodedQueryAccessPolicy,
} from "../src/encoded-query-policy.js";
import type { ExecutionContext } from "../src/execution-context.js";
import { resolveReadableFields } from "../src/field-policy.js";
import {
  compileStructuredQuery,
  MAX_STRUCTURED_QUERY_BYTES,
  MAX_STRUCTURED_QUERY_CLAUSES,
  MAX_STRUCTURED_QUERY_CONDITIONS,
  MAX_STRUCTURED_QUERY_NESTING,
  MAX_STRUCTURED_QUERY_ORDER_COUNT,
  MAX_STRUCTURED_QUERY_SET_VALUES,
  MAX_STRUCTURED_QUERY_TERMS,
  MAX_STRUCTURED_QUERY_VALUE_LENGTH,
  StructuredQueryError,
  structuredQuerySchema,
} from "../src/structured-query.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";
import {
  handler as queryHandler,
  schema as queryToolSchema,
} from "../src/tools/query.js";

const incidentReadable = resolveReadableFields("incident", { fields: "all" });
const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

const approvedRawReadContext = {
  effectivePolicy: {
    encodedQueryAccess: createEncodedQueryAccessPolicy({
      rules: [
        {
          tool: "sn_query",
          table: "incident",
          maxLength: 128,
          maxTerms: 4,
          fields: ["active", "priority", "sys_updated_on"],
          operators: ["="],
          maxLimit: 20,
          maxOffset: 0,
          maxResponseBytes: 100_000,
        },
      ],
    }),
  },
} as ExecutionContext;

function compile(candidate: unknown) {
  return compileStructuredQuery(candidate, incidentReadable);
}

function expectReason(operation: () => unknown, reason: StructuredQueryError["reason"]) {
  try {
    operation();
    throw new Error("expected structured query rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredQueryError);
    expect((error as StructuredQueryError).reason).toBe(reason);
  }
}

function leaf(field: string, value: string) {
  return { type: "equality" as const, field, operator: "eq" as const, value };
}

function nestedFilter(groupDepth: number): unknown {
  let nested: unknown = leaf("active", "true");
  for (let depth = 0; depth < groupDepth; depth += 1) {
    nested = { type: "group", operator: "and", conditions: [nested] };
  }
  return nested;
}

function metaClient(records: unknown[] = []) {
  const getWithMeta = vi.fn(async () => ({
    data: { result: records },
    status: 200,
    headers: new Headers(),
  }));
  return { client: { getWithMeta } as unknown as ServiceNowClient, getWithMeta };
}

describe("SNSDK-31 structured query operators", () => {
  it.each([
    [leaf("active", "true"), "active=true"],
    [
      { type: "equality", field: "state", operator: "neq", value: 7 },
      "state!=7",
    ],
    [
      { type: "set", field: "state", operator: "in", values: [1, 2, 3] },
      "stateIN1,2,3",
    ],
    [
      { type: "set", field: "state", operator: "not_in", values: [6, 7] },
      "stateNOT IN6,7",
    ],
    [
      { type: "range", field: "priority", operator: "gt", value: 1 },
      "priority>1",
    ],
    [
      { type: "range", field: "priority", operator: "gte", value: 2 },
      "priority>=2",
    ],
    [
      { type: "range", field: "priority", operator: "lt", value: 4 },
      "priority<4",
    ],
    [
      { type: "range", field: "priority", operator: "lte", value: 5 },
      "priority<=5",
    ],
    [
      {
        type: "range",
        field: "opened_at",
        operator: "between",
        lower: "2026-01-01",
        upper: "2026-01-31",
      },
      "opened_atBETWEEN2026-01-01@2026-01-31",
    ],
    [
      {
        type: "text",
        field: "short_description",
        operator: "contains",
        value: "database",
      },
      "short_descriptionLIKEdatabase",
    ],
    [
      {
        type: "text",
        field: "short_description",
        operator: "not_contains",
        value: "test",
      },
      "short_descriptionNOT LIKEtest",
    ],
    [
      {
        type: "text",
        field: "number",
        operator: "starts_with",
        value: "INC",
      },
      "numberSTARTSWITHINC",
    ],
    [
      {
        type: "text",
        field: "number",
        operator: "ends_with",
        value: "001",
      },
      "numberENDSWITH001",
    ],
    [
      { type: "null", field: "assigned_to", operator: "is_null" },
      "assigned_toISEMPTY",
    ],
    [
      { type: "null", field: "assigned_to", operator: "is_not_null" },
      "assigned_toISNOTEMPTY",
    ],
  ])("compiles %#", (filter, encoded) => {
    expect(compile({ filter }).encodedQuery).toBe(encoded);
  });

  it("compiles bounded ordering with a default ascending direction", () => {
    expect(
      compile({
        filter: leaf("active", "true"),
        order_by: [
          { field: "priority" },
          { field: "sys_updated_on", direction: "desc" },
        ],
      }).encodedQuery
    ).toBe("active=true^ORDERBYpriority^ORDERBYDESCsys_updated_on");
  });

  it("preserves nested AND/OR semantics through bounded DNF clauses", () => {
    const plan = compile({
      filter: {
        type: "group",
        operator: "and",
        conditions: [
          {
            type: "group",
            operator: "or",
            conditions: [leaf("active", "true"), leaf("priority", "1")],
          },
          { type: "null", field: "assigned_to", operator: "is_null" },
        ],
      },
    });
    expect(plan.encodedQuery).toBe(
      "active=true^assigned_toISEMPTY^NQpriority=1^assigned_toISEMPTY"
    );
  });
});

describe("SNSDK-31 escaping and field policy", () => {
  it("neutralizes encoded-query, set, BETWEEN, and javascript separators", () => {
    expect(
      compile({
        filter: {
          type: "group",
          operator: "and",
          conditions: [
            leaf("short_description", "x^ORactive=false"),
            {
              type: "set",
              field: "state",
              operator: "in",
              values: [
                "1,7^NQactive=false",
                "javascript:gs.getUserID()",
                "javas,cript:gs.getSession()",
              ],
            },
            {
              type: "range",
              field: "opened_at",
              operator: "between",
              lower: "java@script:bad()",
              upper: "javascript:gs.now()^NQactive=false",
            },
          ],
        },
      }).encodedQuery
    ).toBe(
      "short_description=xORactive=false^stateIN17NQactive=false,gs.getUserID(),gs.getSession()^" +
        "opened_atBETWEENbad()@gs.now()NQactive=false"
    );
  });

  it("rejects unsupported operators, unsafe field syntax, and unreadable fields", () => {
    expectReason(
      () => compile({ filter: { ...leaf("active", "true"), operator: "matches" } }),
      "invalid_shape"
    );
    expectReason(
      () => compile({ filter: leaf("active^ORpassword", "true") }),
      "invalid_shape"
    );
    expectReason(
      () => compile({ filter: leaf("password", "secret") }),
      "unauthorized_field"
    );
    expectReason(
      () => compile({ order_by: [{ field: "password" }] }),
      "unauthorized_field"
    );
    expectReason(
      () => compile({ filter: leaf("short_description", "^") }),
      "invalid_shape"
    );
  });

  it("preserves well-formed multilingual and emoji values through wire encoding", () => {
    const value = "数据库故障 café العربية 🚨";
    const plan = compile({ filter: leaf("short_description", value) });
    expect(plan.encodedQuery).toBe(`short_description=${value}`);

    const wire = new URLSearchParams({ sysparm_query: plan.encodedQuery }).toString();
    expect(new URLSearchParams(wire).get("sysparm_query")).toBe(plan.encodedQuery);
  });

  it.each([
    ["C0", "x\u001fy"],
    ["DEL", "x\u007fy"],
    ["C1", "x\u0085y"],
    ["format", "x\u200by"],
    ["line separator", "x\u2028y"],
    ["paragraph separator", "x\u2029y"],
    ["lone high surrogate", "x\ud800y"],
    ["lone low surrogate", "x\udc00y"],
  ])("rejects %s characters and ill-formed Unicode", (_category, value) => {
    expectReason(
      () => compile({ filter: leaf("short_description", value) }),
      "invalid_shape"
    );
  });

  it("validates filter and ordering fields through pre-client table resolution", () => {
    expect(() =>
      resolveToolTableAccess("sn_query", {
        table: "incident",
        structured_query: { filter: leaf("password", "secret") },
      })
    ).toThrow("Table access denied by policy");

    const resolved = resolveToolTableAccess("sn_query", {
      table: "incident",
      structured_query: {
        filter: leaf("active", "true"),
        order_by: [{ field: "priority", direction: "desc" }],
      },
    });
    const structured = resolved.args.structured_query as {
      filter: object;
      order_by: object[];
    };
    expect(Object.isFrozen(structured)).toBe(true);
    expect(Object.isFrozen(structured.filter)).toBe(true);
    expect(Object.isFrozen(structured.order_by)).toBe(true);
  });
});

describe("SNSDK-31 policy bounds", () => {
  it("rejects excessive leaf count and nesting", () => {
    expectReason(
      () =>
        compile({
          filter: {
            type: "group",
            operator: "and",
            conditions: Array.from(
              { length: MAX_STRUCTURED_QUERY_CONDITIONS + 1 },
              (_, index) => leaf("number", `INC${index}`)
            ),
          },
        }),
      "limit_exceeded"
    );

    expectReason(
      () => compile({ filter: nestedFilter(MAX_STRUCTURED_QUERY_NESTING + 1) }),
      "invalid_shape"
    );
  });

  it("statically accepts the nesting boundary and rejects boundary plus one", () => {
    expect(
      structuredQuerySchema.safeParse({
        filter: nestedFilter(MAX_STRUCTURED_QUERY_NESTING),
      }).success
    ).toBe(true);
    const overDepth = structuredQuerySchema.safeParse({
      filter: nestedFilter(MAX_STRUCTURED_QUERY_NESTING + 1),
    });
    expect(overDepth.success).toBe(false);
    if (!overDepth.success) {
      expect(overDepth.error.issues[0]?.code).toBe("invalid_union");
    }
  });

  it.each([1_000, 2_000])(
    "rejects depth %i through direct and composed Zod schemas in bounded time",
    (depth) => {
      const filter = nestedFilter(depth);
      const started = performance.now();
      const direct = structuredQuerySchema.safeParse({ filter });
      const directElapsed = performance.now() - started;
      expect(direct.success).toBe(false);
      if (!direct.success) expect(direct.error.issues[0]?.code).toBe("invalid_union");
      expect(directElapsed).toBeLessThan(250);

      const composedStarted = performance.now();
      const composed = queryToolSchema.safeParse({
        table: "incident",
        structured_query: { filter },
      });
      const composedElapsed = performance.now() - composedStarted;
      expect(composed.success).toBe(false);
      if (!composed.success) expect(composed.error.issues[0]?.code).toBe("invalid_union");
      expect(composedElapsed).toBeLessThan(250);
    }
  );

  it("rejects excessive values, set members, and ordering", () => {
    expectReason(
      () =>
        compile({
          filter: leaf(
            "short_description",
            "x".repeat(MAX_STRUCTURED_QUERY_VALUE_LENGTH + 1)
          ),
        }),
      "limit_exceeded"
    );
    expectReason(
      () =>
        compile({
          filter: {
            type: "set",
            field: "state",
            operator: "in",
            values: Array.from(
              { length: MAX_STRUCTURED_QUERY_SET_VALUES + 1 },
              (_, index) => index
            ),
          },
        }),
      "invalid_shape"
    );
    expectReason(
      () =>
        compile({
          order_by: Array.from(
            { length: MAX_STRUCTURED_QUERY_ORDER_COUNT + 1 },
            () => ({ field: "priority" })
          ),
        }),
      "invalid_shape"
    );
  });

  it("caps DNF product expansion during compilation", () => {
    const alternatives = Array.from({ length: 5 }, (_, index) => ({
      type: "group" as const,
      operator: "or" as const,
      conditions: [leaf("number", `INC${index}A`), leaf("number", `INC${index}B`)],
    }));
    expect(2 ** alternatives.length).toBeGreaterThan(MAX_STRUCTURED_QUERY_CLAUSES);
    expectReason(
      () =>
        compile({
          filter: { type: "group", operator: "and", conditions: alternatives },
        }),
      "expansion_limit"
    );
  });

  it("caps duplicated DNF terms even when the clause count is allowed", () => {
    const alternatives = {
      type: "group" as const,
      operator: "or" as const,
      conditions: Array.from({ length: MAX_STRUCTURED_QUERY_CLAUSES }, (_, index) =>
        leaf("number", `INC${index}`)
      ),
    };
    const common = [
      leaf("active", "true"),
      leaf("priority", "1"),
      leaf("state", "2"),
      leaf("assigned_to", "user"),
    ];
    expect(MAX_STRUCTURED_QUERY_CLAUSES * (common.length + 1)).toBeGreaterThan(
      MAX_STRUCTURED_QUERY_TERMS
    );
    expectReason(
      () =>
        compile({
          filter: {
            type: "group",
            operator: "and",
            conditions: [alternatives, ...common],
          },
        }),
      "expansion_limit"
    );
  });

  it("caps the final encoded query after bounded expansion", () => {
    const conditions = Array.from({ length: MAX_STRUCTURED_QUERY_CLAUSES }, (_, index) =>
      leaf("description", `${index}${"x".repeat(MAX_STRUCTURED_QUERY_VALUE_LENGTH - 2)}`)
    );
    expectReason(
      () =>
        compile({
          filter: { type: "group", operator: "or", conditions },
        }),
      "limit_exceeded"
    );
    expect(MAX_STRUCTURED_QUERY_BYTES).toBe(8_192);
  });
});

describe("SNSDK-31 hostile input and immutability", () => {
  it("rejects proxies without executing get or reflection traps", () => {
    const calls = { get: 0, getPrototypeOf: 0, ownKeys: 0, descriptor: 0 };
    const proxy = new Proxy(
      { filter: leaf("active", "true") },
      {
        get: (target, key, receiver) => {
          calls.get += 1;
          return Reflect.get(target, key, receiver);
        },
        getPrototypeOf: (target) => {
          calls.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          calls.ownKeys += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor: (target, key) => {
          calls.descriptor += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }
    );
    expectReason(() => compileStructuredQuery(proxy, incidentReadable), "invalid_shape");
    expect(calls).toEqual({ get: 0, getPrototypeOf: 0, ownKeys: 0, descriptor: 0 });
  });

  it("never evaluates accessors and freezes the canonical plan deeply", () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "filter", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return leaf("active", "true");
      },
    });
    expectReason(() => compile(hostile), "invalid_shape");
    expect(getterCalls).toBe(0);

    const plan = compile({
      filter: {
        type: "group",
        operator: "and",
        conditions: [leaf("active", "true")],
      },
      order_by: [{ field: "priority" }],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.referencedFields)).toBe(true);
    expect(Object.isFrozen(plan.structuredQuery)).toBe(true);
    const filter = plan.structuredQuery.filter;
    expect(filter && Object.isFrozen(filter)).toBe(true);
    if (filter?.type === "group") expect(Object.isFrozen(filter.conditions)).toBe(true);
  });

  it("normalizes revoked readable-field proxies to StructuredQueryError", () => {
    const readableFields = Proxy.revocable([...incidentReadable], {});
    readableFields.revoke();
    expectReason(
      () =>
        compileStructuredQuery(
          { filter: leaf("active", "true") },
          readableFields.proxy
        ),
      "invalid_shape"
    );
  });

  it("bounds a 100k-key plain object before reading its accessor", () => {
    let getterCalls = 0;
    const huge: Record<string, unknown> = {};
    Object.defineProperty(huge, "key_0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "unsafe";
      },
    });
    for (let index = 1; index < 100_000; index += 1) huge[`key_${index}`] = index;
    expectReason(() => compile(huge), "limit_exceeded");
    expect(getterCalls).toBe(0);
  });
});

describe("SNSDK-31 sn_query integration", () => {
  it("publishes the reusable structured schema and sends its compiled query", async () => {
    const structured_query = structuredQuerySchema.parse({
      filter: {
        type: "group",
        operator: "and",
        conditions: [
          leaf("active", "true"),
          {
            type: "text",
            field: "short_description",
            operator: "contains",
            value: "database",
          },
        ],
      },
      order_by: [{ field: "priority", direction: "desc" }],
    });
    const { client, getWithMeta } = metaClient([]);
    const result = await queryHandler(
      queryToolSchema.parse({ table: "incident", structured_query }),
      client,
      config
    );
    expect(result.isError).not.toBe(true);
    const params = getWithMeta.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_query).toBe(
      "active=true^short_descriptionLIKEdatabase^ORDERBYDESCpriority^ORDERBYsys_id"
    );
    expect(params).not.toHaveProperty("sysparm_orderby");
  });

  it("preserves explicitly approved bounded raw read compatibility", async () => {
    const { client, getWithMeta } = metaClient([]);
    await queryHandler(
      queryToolSchema.parse({
        table: "incident",
        query: "active=true^priority=1",
        fields: "active,priority,sys_updated_on",
        orderby: "-sys_updated_on",
      }),
      client,
      config,
      approvedRawReadContext
    );
    expect(getWithMeta.mock.calls[0][1]).toMatchObject({
      sysparm_query:
        "active=true^priority=1^ORDERBYDESCsys_updated_on^ORDERBYsys_id",
      sysparm_fields: "active,priority,sys_updated_on",
    });
  });

  it("preserves the authorized projection across prepared arguments and responses", async () => {
    const { client, getWithMeta } = metaClient([
      {
        active: true,
        priority: "1",
        short_description: "must not cross the projection boundary",
      },
    ]);
    const parsed = queryToolSchema.parse({
      table: "incident",
      query: "active=true",
      fields: "active",
    });
    const prepared = resolveToolTableAccess(
      "sn_query",
      parsed,
      approvedRawReadContext.effectivePolicy.encodedQueryAccess
    ).args;

    const result = await queryHandler(
      prepared as ReturnType<typeof queryToolSchema.parse>,
      client,
      config,
      approvedRawReadContext
    );

    expect(result.isError).toBeUndefined();
    expect(getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/incident",
      expect.objectContaining({
        sysparm_query: "active=true^ORDERBYsys_id",
        sysparm_fields: "active",
      })
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      results: [{ active: true }],
    });
  });

  it("rejects an exotic raw-read projection before direct client access", async () => {
    const { client, getWithMeta } = metaClient([]);
    const getTrap = vi.fn();
    const ownKeysTrap = vi.fn();
    const fields = new Proxy(["active"], {
      get: getTrap,
      ownKeys: ownKeysTrap,
    });
    await expect(
      queryHandler(
        {
          ...queryToolSchema.parse({
            table: "incident",
            query: "active=true",
            fields: "active",
          }),
          fields,
        } as never,
        client,
        config,
        approvedRawReadContext
      )
    ).rejects.toThrow("Field access denied by policy");
    expect(getWithMeta).not.toHaveBeenCalled();
    expect(getTrap).not.toHaveBeenCalled();
    expect(ownKeysTrap).not.toHaveBeenCalled();
  });

  it("fails closed when structured and raw modes are mixed", async () => {
    const { client, getWithMeta } = metaClient([]);
    await expect(
      queryHandler(
        queryToolSchema.parse({
          table: "incident",
          query: "active=true",
          structured_query: { filter: leaf("priority", "1") },
        }),
        client,
        config
      )
    ).rejects.toBeInstanceOf(StructuredQueryError);
    expect(getWithMeta).not.toHaveBeenCalled();
    expect(() =>
      resolveToolTableAccess("sn_query", {
        table: "incident",
        orderby: "priority",
        structured_query: { filter: leaf("active", "true") },
      })
    ).toThrow("Table access denied by policy");
  });
});
