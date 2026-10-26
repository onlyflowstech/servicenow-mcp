import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  FieldPolicyError,
  isFieldPolicyError,
  prepareAdditionalReadFieldArguments,
  runWithFieldPolicyConfiguration,
} from "../src/field-policy.js";
import { resolveToolTableAccess } from "../src/tool-table-access.js";
import {
  FLOW_ELEMENT_SOURCES,
  FLOW_TABLE_FIELDS,
  FLOW_VIEW_LIMITS,
  FLOW_VIEW_TABLES,
  flowInputValueSchema,
  flowTextSchema,
  rawFlowInputListSchema,
  rawFlowInputSchema,
  rawFlowLogicValuesSchema,
  type FlowElementKey,
  type FlowTableName,
} from "../src/tools/flow-view-contracts.js";
import {
  canShow,
  flowFieldPlanFromArgs,
  flowViewFieldSelection,
  inputsIncluded,
  isSensitivePolicyName,
  policyIdentifier,
  policyInput,
  policyText,
  scrubNestedKeys,
  sysparmFieldsFor,
  type FlowFieldPlan,
} from "../src/tools/flow-view-policy.js";

function planFor(
  args: Record<string, unknown> = {},
  fieldPolicy?: Record<string, unknown>
): FlowFieldPlan {
  const run = () =>
    flowFieldPlanFromArgs(
      resolveToolTableAccess("sn_flow_view", { profile: "dev", flow: "x", ...args }).args
    );
  return fieldPolicy === undefined ? run() : runWithFieldPolicyConfiguration({ fieldPolicy }, run);
}

/** A hand-built plan, as a loader test would build one. */
function handPlan(entries: Partial<Record<FlowTableName, readonly string[]>>): FlowFieldPlan {
  return {
    readable: new Map(
      Object.entries(entries).map(([table, fields]) => [table as FlowTableName, new Set(fields)])
    ),
  };
}

const OPEN = planFor();
const NO_INPUTS = planFor({ include_inputs: false });

type Cell = { value: string; display_value: string };
type Capture = Record<string, { rows: Record<string, Cell>[] }>;

function capture(name: string): Capture {
  const url = new URL(`./fixtures/flow-view/table/brazil-patch0/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Capture;
}

/** Decoded V2 inputs of one table/column, flattened like the loader does. */
function decodedInputs(file: string, table: string, column: string) {
  const entries: unknown[] = [];
  for (const row of capture(file)[table]?.rows ?? []) {
    const blob = row[column]?.value;
    if (!blob) continue;
    const decoded: unknown = JSON.parse(gunzipSync(Buffer.from(blob, "base64")).toString("utf8"));
    if (Array.isArray(decoded)) entries.push(...rawFlowInputListSchema.parse(decoded));
    else entries.push(...(rawFlowLogicValuesSchema.parse(decoded).inputs ?? []));
  }
  return entries.map((entry) => {
    const input = rawFlowInputSchema.parse(entry);
    return {
      name: input.name,
      label: input.parameter?.label ?? input.label,
      type: input.parameter?.type ?? input.internalType,
      value: input.value,
      displayValue: input.displayValue,
      script: input.scriptActive,
    };
  });
}

describe("flowFieldPlanFromArgs", () => {
  it("recovers one readable set per closure table", () => {
    expect([...OPEN.readable.keys()]).toEqual([...FLOW_VIEW_TABLES]);
    expect(Object.isFrozen(OPEN)).toBe(true);
    expect(OPEN.readable.get("sys_hub_flow")).toEqual(
      new Set([
        "sys_id",
        "name",
        "type",
        "active",
        "status",
        "version",
        "description",
        "sys_scope",
        "label_cache",
      ])
    );
    expect(NO_INPUTS.include_inputs).toBe(false);
    expect(NO_INPUTS.readable.get("sys_variable_value")?.has("value")).toBe(false);
  });

  it("throws when no marker was prepared", () => {
    expect(() => flowFieldPlanFromArgs({ profile: "dev", flow: "x" })).toThrow(FieldPolicyError);
  });

  it("throws when any one table's marker is missing", () => {
    let args: Record<string, unknown> = { profile: "dev", flow: "x" };
    for (const table of FLOW_VIEW_TABLES.slice(0, -1)) {
      args = prepareAdditionalReadFieldArguments(args, table, flowViewFieldSelection(table, true).join(","));
    }
    try {
      flowFieldPlanFromArgs(args);
      throw new Error("expected a denial");
    } catch (error) {
      expect(isFieldPolicyError(error)).toBe(true);
      expect((error as FieldPolicyError).table).toBe(FLOW_VIEW_TABLES.at(-1));
    }
  });

  it("throws when a marker lacks a required field", () => {
    let args: Record<string, unknown> = { profile: "dev", flow: "x" };
    for (const table of FLOW_VIEW_TABLES) {
      const fields = flowViewFieldSelection(table, true).filter(
        (field) => !(table === "sys_hub_flow_logic" && field === "parent_ui_id")
      );
      args = prepareAdditionalReadFieldArguments(args, table, fields.join(","));
    }
    expect(() => flowFieldPlanFromArgs(args)).toThrow(FieldPolicyError);
  });

  it("drops value fields when include_inputs is false, even if a marker carries them", () => {
    let args: Record<string, unknown> = { profile: "dev", flow: "x", include_inputs: false };
    for (const table of FLOW_VIEW_TABLES) {
      args = prepareAdditionalReadFieldArguments(args, table, flowViewFieldSelection(table, true).join(","));
    }
    const plan = flowFieldPlanFromArgs(args);
    expect(plan.readable.get("sys_hub_action_instance_v2")?.has("values")).toBe(false);
    expect(sysparmFieldsFor(plan, "sys_variable_value")).toBe(
      "sys_id,document,document_key,variable,order"
    );
    expect(sysparmFieldsFor(plan, "var_dictionary")).toBe("sys_id");
  });
});

describe("canShow (intersection rule)", () => {
  it("shows every element under the open policy", () => {
    for (const element of Object.keys(FLOW_ELEMENT_SOURCES) as FlowElementKey[]) {
      expect(canShow(OPEN, element), element).toBe(true);
    }
  });

  it("hides an element when any one of its V1/V2 sources is unreadable", () => {
    const plan = planFor(
      {},
      {
        sys_hub_action_instance_v2: {
          readable: ["sys_id", "flow", "order", "ui_id", "parent_ui_id", "action_type", "values"],
        },
      }
    );
    // V1 comment is readable, V2 comment is not: fail closed for both storages.
    expect(plan.readable.get("sys_hub_action_instance")?.has("comment")).toBe(true);
    expect(canShow(plan, "action_annotation")).toBe(false);
    expect(canShow(plan, "action_title")).toBe(true);
    expect(canShow(plan, "logic_annotation")).toBe(true);
  });

  it("hides every value element when inputs were not requested", () => {
    for (const element of ["trigger_inputs", "action_inputs", "logic_inputs", "subflow_inputs"] as const) {
      expect(canShow(NO_INPUTS, element)).toBe(false);
    }
    expect(canShow(NO_INPUTS, "action_title")).toBe(true);
  });

  it("rejects an unknown element key", () => {
    expect(canShow(OPEN, "toString" as FlowElementKey)).toBe(false);
    expect(canShow(OPEN, "__proto__" as FlowElementKey)).toBe(false);
  });

  it("works on hand-built plans", () => {
    const plan = handPlan({ sys_hub_flow: ["sys_id", "name"] });
    expect(canShow(plan, "flow_name")).toBe(true);
    expect(canShow(plan, "flow_description")).toBe(false);
    expect(canShow(plan, "action_title")).toBe(false);
  });
});

describe("sysparmFieldsFor", () => {
  it("lists readable fields in declaration order", () => {
    expect(sysparmFieldsFor(OPEN, "sys_hub_action_instance_v2")).toBe(
      "sys_id,flow,order,ui_id,parent_ui_id,action_type,comment,values"
    );
    expect(sysparmFieldsFor(NO_INPUTS, "sys_hub_action_instance_v2")).toBe(
      "sys_id,flow,order,ui_id,parent_ui_id,action_type,comment"
    );
  });

  it("drops undeclared fields and never returns an empty list", () => {
    const plan = handPlan({
      sys_hub_flow: ["label_cache", "sys_id", "u_extra", "password"],
      sys_hub_flow_input: [],
    });
    expect(sysparmFieldsFor(plan, "sys_hub_flow")).toBe("sys_id,label_cache");
    expect(() => sysparmFieldsFor(plan, "sys_hub_flow_input")).toThrow(FieldPolicyError);
    expect(() => sysparmFieldsFor(plan, "sys_hub_flow_output")).toThrow(FieldPolicyError);
    expect(() => sysparmFieldsFor(plan, "incident" as FlowTableName)).toThrow(FieldPolicyError);
  });
});

describe("policyText", () => {
  it("redacts an element the plan cannot show", () => {
    const plan = handPlan({ sys_hub_flow: ["sys_id", "name"] });
    expect(policyText(plan, "flow_description", "secret plan", 200)).toEqual({
      text: null,
      redacted: "field_policy",
    });
  });

  it("unwraps display values, strips controls and maps empty to null", () => {
    expect(policyText(OPEN, "flow_name", { display_value: "Route", value: "route" }, 200)).toEqual({
      text: "Route",
    });
    expect(policyText(OPEN, "flow_name", { display_value: "", value: "route" }, 200)).toEqual({
      text: "route",
    });
    expect(policyText(OPEN, "flow_name", "a\u0000b\u001bc\u009fd\n", 200)).toEqual({
      text: "abcd\n",
    });
    expect(policyText(OPEN, "flow_name", "   ", 200)).toEqual({ text: null });
    expect(policyText(OPEN, "flow_name", undefined, 200)).toEqual({ text: null });
    expect(policyText(OPEN, "flow_name", { nested: { x: 1 } }, 200)).toEqual({ text: null });
    expect(policyText(OPEN, "flow_active", true, 200)).toEqual({ text: "true" });
  });

  it("truncates with original_length and never splits a surrogate pair", () => {
    const long = policyText(OPEN, "flow_name", "x".repeat(250), 200);
    expect(long).toEqual({ text: "x".repeat(200), original_length: 250 });

    const emoji = policyText(OPEN, "flow_name", `${"a".repeat(9)}😀tail`, 10);
    expect(emoji.text).toBe("a".repeat(9));
    expect(emoji.original_length).toBe(15);

    const capped = policyText(OPEN, "flow_description", "y".repeat(5_000), 1_000_000);
    expect(capped.text).toHaveLength(FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS);
    expect(flowTextSchema.safeParse(capped).success).toBe(true);
  });
});

describe("policyIdentifier and sensitivity", () => {
  it("sanitizes names into policy identifiers", () => {
    expect(policyIdentifier("clientSecret")).toBe("client_secret");
    expect(policyIdentifier("API Key")).toBe("api_key");
    expect(policyIdentifier("APIKey")).toBe("api_key");
    expect(policyIdentifier("password2")).toBe("password_2");
    expect(policyIdentifier("2fa code")).toBe("x2fa_code");
    expect(policyIdentifier("Ｐａｓｓｗｏｒｄ")).toBe("password");
    expect(policyIdentifier("Café  Number")).toBe("cafe_number");
    expect(policyIdentifier("  Short description ")).toBe("short_description");
    expect(policyIdentifier("--__--")).toBe("");
    expect(policyIdentifier(42)).toBe("");
  });

  it("finds sensitive terms anywhere, including past 80 characters", () => {
    expect(isSensitivePolicyName("clientSecret", false)).toBe(true);
    expect(isSensitivePolicyName("API Key", false)).toBe(true);
    expect(isSensitivePolicyName("oauthToken", false)).toBe(true);
    expect(isSensitivePolicyName("Private Key (PEM)", false)).toBe(true);
    expect(isSensitivePolicyName(`${"segment_".repeat(15)}password`, false)).toBe(true);
    expect(isSensitivePolicyName("short_description", false)).toBe(false);
    expect(isSensitivePolicyName("Record", false)).toBe(false);
    expect(isSensitivePolicyName("パスワード", false)).toBe(false);
    expect(isSensitivePolicyName("パスワード", true)).toBe(true);
  });
});

describe("policyInput", () => {
  it("shows a plain input, preferring the display value", () => {
    const input = policyInput(OPEN, "action_inputs", {
      name: "record",
      label: "Record",
      type: "reference",
      value: "0123456789abcdef0123456789abcdef",
      displayValue: "INC0010001",
    });
    expect(input).toEqual({ name: "record", label: "Record", type: "reference", value: "INC0010001" });
    expect(flowInputValueSchema.safeParse(input).success).toBe(true);
  });

  it("redacts by camelCase name, label and type", () => {
    expect(policyInput(OPEN, "action_inputs", { name: "clientSecret", value: "s3cr3t" })).toMatchObject({
      name: "clientSecret",
      value: null,
      redacted: "sensitive_name",
    });
    expect(
      policyInput(OPEN, "action_inputs", { name: "u_header", label: "API Key", value: "abc" })
    ).toMatchObject({ label: "API Key", value: null, redacted: "sensitive_name" });
    for (const type of ["password2", "password", "Masked", "encrypted_text"]) {
      expect(
        policyInput(OPEN, "subflow_inputs", { name: "u_value", type, value: "abc" }),
        type
      ).toMatchObject({ value: null, redacted: "sensitive_type" });
    }
  });

  it("fails closed on a name with no ASCII identifier, not on a localized label", () => {
    expect(policyInput(OPEN, "action_inputs", { name: "名前", value: "x" }).redacted).toBe(
      "sensitive_name"
    );
    expect(policyInput(OPEN, "action_inputs", { name: { x: 1 }, value: "x" })).toMatchObject({
      name: "",
      value: null,
      redacted: "sensitive_name",
    });
    expect(
      policyInput(OPEN, "action_inputs", { name: "u_note", label: "メモ", value: "x" })
    ).toMatchObject({ value: "x" });
    expect(
      policyInput(OPEN, "action_inputs", { name: "u_note", label: " Short description", value: "x" })
    ).toMatchObject({ value: "x" });
  });

  it("reports not_requested before field_policy", () => {
    expect(policyInput(NO_INPUTS, "action_inputs", { name: "record", value: "x" })).toEqual({
      name: "record",
      label: null,
      type: null,
      value: null,
      redacted: "not_requested",
    });
    const hidden = planFor(
      {},
      { sys_variable_value: { readable: ["sys_id", "document", "document_key", "variable", "order"] } }
    );
    for (const element of ["action_inputs", "logic_inputs"] as const) {
      expect(policyInput(hidden, element, { name: "record", value: "x" }).redacted).toBe(
        "field_policy"
      );
    }
    const untyped = planFor({}, { var_dictionary: { readable: ["sys_id", "element"] } });
    expect(policyInput(untyped, "subflow_inputs", { name: "record", value: "x" }).redacted).toBe(
      "field_policy"
    );
  });

  it("exposes the omit rule through inputsIncluded and policyText", () => {
    expect(inputsIncluded(OPEN)).toBe(true);
    expect(inputsIncluded(NO_INPUTS)).toBe(false);
    // Trigger table and condition come from inputs: not requested, not denied.
    expect(policyText(NO_INPUTS, "trigger_inputs", "incident", 200)).toEqual({
      text: null,
      redacted: "not_requested",
    });
    expect(policyText(OPEN, "trigger_inputs", "incident", 200)).toEqual({ text: "incident" });
    expect(policyText(NO_INPUTS, "trigger_type", "record_create", 200)).toEqual({
      text: "record_create",
    });
  });

  it("derives not_requested on a hand-built plan with no value fields", () => {
    const plan = handPlan({ sys_hub_flow: ["sys_id", "name", "type"] });
    expect(policyInput(plan, "action_inputs", { name: "record", value: "x" }).redacted).toBe(
      "not_requested"
    );
    const withValues = handPlan({
      sys_hub_action_instance_v2: ["values"],
      sys_variable_value: ["value"],
      var_dictionary: ["element", "internal_type"],
    });
    expect(policyInput(withValues, "action_inputs", { name: "record", value: "x" }).value).toBe("x");
    expect(policyInput(withValues, "logic_inputs", { name: "record", value: "x" }).redacted).toBe(
      "field_policy"
    );
  });

  it("truncates long values and marks scripts", () => {
    const script = "x".repeat(5_000);
    const input = policyInput(OPEN, "action_inputs", { name: "script", value: script, script: true });
    expect(input.script).toBe(true);
    expect(input.value).toHaveLength(FLOW_VIEW_LIMITS.MAX_INPUT_VALUE_CHARS);
    expect(input.original_length).toBe(5_000);
    expect(flowInputValueSchema.safeParse(input).success).toBe(true);
  });

  it("bounds and cleans name, label and type", () => {
    const input = policyInput(OPEN, "action_inputs", {
      name: `u_${"n".repeat(500)}\u0000`,
      label: `Label\n${"l".repeat(500)}`,
      type: "t".repeat(500),
      value: "v",
    });
    expect(input.name).toHaveLength(FLOW_VIEW_LIMITS.MAX_NAME_CHARS);
    expect(input.label).toHaveLength(FLOW_VIEW_LIMITS.MAX_TITLE_CHARS);
    expect(input.label).not.toContain("\n");
    expect(input.type).toHaveLength(FLOW_VIEW_LIMITS.MAX_NAME_CHARS);
    expect(flowInputValueSchema.safeParse(input).success).toBe(true);
  });

  it("scrubs nested JSON in objects and JSON text", () => {
    const fromObject = policyInput(OPEN, "action_inputs", {
      name: "u_payload",
      value: { url: "https://x", headers: { Authorization: "a", apiKey: "k", accept: "json" } },
    });
    expect(JSON.parse(fromObject.value!)).toEqual({
      url: "https://x",
      headers: { Authorization: "a", accept: "json" },
    });

    const pairs = JSON.stringify([
      { name: "client_secret", value: "s", label: "Secret" },
      { name: "endpoint", value: "https://x" },
    ]);
    const fromText = policyInput(OPEN, "action_inputs", { name: "u_params", value: pairs });
    expect(JSON.parse(fromText.value!)).toEqual([
      { name: "client_secret", label: "Secret" },
      { name: "endpoint", value: "https://x" },
    ]);

    const clean = '{ "a": 1 }';
    expect(policyInput(OPEN, "action_inputs", { name: "u_x", value: clean }).value).toBe(clean);
    expect(policyInput(OPEN, "action_inputs", { name: "u_x", value: "{not json" }).value).toBe(
      "{not json"
    );
  });
});

describe("policyInput on deeply nested JSON text", () => {
  const deepArray = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
  const deepObject = (depth: number) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;

  it.each([
    ["a 10,000-deep array", deepArray(10_000)],
    ["a 131,072-deep array", deepArray(131_072)],
    ["a 40,000-deep object", deepObject(40_000)],
    ["nesting one past the decoder's bound", deepArray(25)],
  ])("withholds %s as limit, never shown raw and never throwing", (_name, text) => {
    for (const raw of [{ value: text }, { value: "x", displayValue: text }]) {
      expect(policyInput(OPEN, "action_inputs", { name: "payload", ...raw })).toEqual({
        name: "payload",
        label: null,
        type: null,
        value: null,
        redacted: "limit",
      });
    }
  });

  it("withholds JSON-looking text too long to parse within bounds", () => {
    const long = `[${"1,".repeat(140_000)}1]`;
    expect(policyInput(OPEN, "action_inputs", { name: "payload", value: long })).toMatchObject({
      value: null,
      redacted: "limit",
    });
  });

  it("still scrubs nested JSON within the bounds and shows other text as is", () => {
    expect(policyInput(OPEN, "action_inputs", { name: "payload", value: deepArray(24) })).toMatchObject({
      value: deepArray(24),
    });
    expect(
      policyInput(OPEN, "action_inputs", { name: "payload", value: '{"user":"a","password":"p","n":[1]}' })
    ).toMatchObject({ value: '{"user":"a","n":[1]}' });
    expect(policyInput(OPEN, "action_inputs", { name: "payload", value: "[Draft] notes {" })).toMatchObject({
      value: "[Draft] notes {",
    });
  });
});

describe("scrubNestedKeys", () => {
  it("drops sensitive keys at any depth and keeps the rest", () => {
    expect(
      scrubNestedKeys({ a: 1, password: "p", nested: [{ db_password: "x", ok: true }], userToken: "t" })
    ).toEqual({ a: 1, nested: [{ ok: true }] });
  });

  it("bounds depth", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    let cursor = scrubNestedKeys(deep) as Record<string, unknown> | null;
    let depth = 0;
    while (cursor && typeof cursor === "object") {
      cursor = cursor.child as Record<string, unknown> | null;
      depth += 1;
    }
    expect(cursor).toBeNull();
    expect(depth).toBe(FLOW_VIEW_LIMITS.MAX_DECODED_JSON_DEPTH);
  });

  it("bounds node count", () => {
    const wide = Array.from({ length: FLOW_VIEW_LIMITS.MAX_DECODED_JSON_NODES * 2 }, (_, i) => i);
    const output = scrubNestedKeys(wide) as unknown[];
    expect(output.length).toBeLessThan(FLOW_VIEW_LIMITS.MAX_DECODED_JSON_NODES);
  });

  it("never runs accessors, follows proxies or keeps non-plain objects", () => {
    let touched = false;
    const accessor = Object.defineProperty({ ok: 1 }, "trap", {
      enumerable: true,
      get() {
        touched = true;
        return "x";
      },
    });
    expect(scrubNestedKeys(accessor)).toEqual({ ok: 1 });
    expect(touched).toBe(false);
    expect(scrubNestedKeys(new Proxy({}, {}))).toBeNull();
    expect(scrubNestedKeys({ when: new Date(0), fn: () => 1, n: Number.NaN })).toEqual({
      when: null,
      n: null,
    });
  });

  it("keeps a __proto__ key as data without touching the prototype", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    const output = scrubNestedKeys(parsed) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("flowViewFieldSelection", () => {
  it("returns required, then intersected optional, then values only on request", () => {
    expect(flowViewFieldSelection("sys_hub_flow_logic_instance_v2", true)).toEqual([
      ...FLOW_TABLE_FIELDS.sys_hub_flow_logic_instance_v2.required,
      "comment",
      "values",
    ]);
    expect(flowViewFieldSelection("sys_hub_flow_logic_instance_v2", false)).toEqual([
      ...FLOW_TABLE_FIELDS.sys_hub_flow_logic_instance_v2.required,
      "comment",
    ]);
    // V1 logic reads no value column: its values are in sys_variable_value.
    expect(flowViewFieldSelection("sys_hub_flow_logic", true)).toEqual([
      ...FLOW_TABLE_FIELDS.sys_hub_flow_logic.required,
      "comment",
    ]);
    expect(flowViewFieldSelection("var_dictionary", false)).toEqual(["sys_id"]);
    expect(flowViewFieldSelection("var_dictionary", true)).toEqual(["sys_id", "element", "internal_type"]);
    expect(() => flowViewFieldSelection("incident" as FlowTableName, true)).toThrow(FieldPolicyError);
  });
});

describe("policyInput on the captured V2 inputs", () => {
  const all = [
    ...decodedInputs("tables-F1.json", "sys_hub_action_instance_v2", "values"),
    ...decodedInputs("tables-F1.json", "sys_hub_flow_logic_instance_v2", "values"),
    ...decodedInputs("tables-F1.json", "sys_hub_trigger_instance_v2", "trigger_inputs"),
    ...decodedInputs("tables-F4.json", "sys_hub_action_instance_v2", "values"),
    ...decodedInputs("tables-F4.json", "sys_hub_sub_flow_instance_v2", "subflow_inputs"),
    ...decodedInputs("tables-F2F3p.json", "sys_hub_sub_flow_instance_v2", "subflow_inputs"),
  ];

  it("projects every captured input into a valid FlowInputValue", () => {
    expect(all.length).toBeGreaterThan(50);
    for (const raw of all) {
      expect(flowInputValueSchema.safeParse(policyInput(OPEN, "action_inputs", raw)).success).toBe(true);
    }
  });

  it("never shows a password2 value, masked or not", () => {
    const passwords = all.filter((raw) => raw.type === "password2");
    expect(passwords.length).toBeGreaterThan(0);
    for (const raw of passwords) {
      const input = policyInput(OPEN, "action_inputs", raw);
      expect(input.value).toBeNull();
      expect(["sensitive_type", "sensitive_name"]).toContain(input.redacted);
    }
  });

  it("shows ordinary values, preferring the display value", () => {
    const condition = all.find(
      (raw) => raw.name === "condition_name" && raw.displayValue === "synthetic condition label one"
    );
    expect(condition).toBeDefined();
    expect(policyInput(OPEN, "logic_inputs", condition!)).toMatchObject({
      name: "condition_name",
      label: "Condition Label",
      type: "string",
      value: "synthetic condition label one",
    });
  });

  it("redacts everything as not_requested on the fail-safe path", () => {
    for (const raw of all.slice(0, 20)) {
      expect(policyInput(NO_INPUTS, "action_inputs", raw).redacted).toBe("not_requested");
    }
  });
});
