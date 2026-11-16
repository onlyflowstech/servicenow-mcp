/**
 * The payload view's masking (R6), on its own: what of one change's XML may be
 * shown, and how it is masked. The type lookup runs the real plan-bounded
 * loader against a recording instance, and every read it makes is judged
 * against the two metadata tables. Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import { PLAN_FIELD_TYPE_DOT_WALKS, loadFieldTypesInPlan } from "../src/hidden-values.js";
import {
  HIDDEN_MARK,
  PAYLOAD_HINTS,
  PAYLOAD_LIMITS,
  PAYLOAD_NOTE,
  payloadCharsFor,
  preparePayload,
  rowTables,
  type PayloadOutcome,
} from "../src/tools/platform-view-payload.js";
import { SECRET_MASK } from "../src/update-set-eval/secret-patterns.js";
import { CANARY, FAKE_SECRET, fake, payloadOf, world, type World } from "./fixtures/update-set-views.js";
import { expectReadsWithin } from "./platform-view-harness.js";

const META_PLAN = ["sys_db_object", "sys_dictionary"];
const DEFAULT_CHARS = payloadCharsFor(100_000);

async function prepare(payload: string, tables: string[], model: World = world(), maxChars = DEFAULT_CHARS) {
  const { instance, ops } = fake(model);
  let loaded: string[] | undefined;
  const outcome = await preparePayload(
    payload,
    tables,
    (written) => {
      loaded = [...written];
      return loadFieldTypesInPlan(ops, written);
    },
    maxChars
  );
  expectReadsWithin(instance, META_PLAN, PLAN_FIELD_TYPE_DOT_WALKS);
  return { outcome, instance, loaded };
}

function shown(outcome: PayloadOutcome) {
  expect(outcome.status).toBe("shown");
  if (outcome.status !== "shown") throw new Error("not shown");
  return outcome;
}

describe("payload view: masking", () => {
  it("replaces a password2-typed element with [hidden], inherited from the parent table", async () => {
    const payload = payloadOf("u_vendor_child", { u_name: "Acme", u_api_key_value: FAKE_SECRET });
    const out = shown((await prepare(payload, ["u_vendor_child"])).outcome);
    expect(out.text).toContain(`<u_api_key_value>${HIDDEN_MARK}</u_api_key_value>`);
    expect(out.text).toContain("<u_name>Acme</u_name>");
    expect(out.text).not.toContain(FAKE_SECRET);
    expect(out.hidden_by_type).toBe(1);
    expect(out.note).toBe(PAYLOAD_NOTE);
  });

  it("hides every attribute of a hidden field, including a display value", async () => {
    const payload = payloadOf("u_vendor_child", {}, "").replace(
      "<u_vendor_child action=\"INSERT_OR_UPDATE\">",
      `<u_vendor_child action="INSERT_OR_UPDATE"><u_api_key_value display_value="${FAKE_SECRET}">${FAKE_SECRET}</u_api_key_value>`
    );
    const out = shown((await prepare(payload, ["u_vendor_child"])).outcome);
    expect(out.text).not.toContain(FAKE_SECRET);
    expect(out.text).toContain(`display_value="${HIDDEN_MARK}"`);
    expect(out.hidden_by_type).toBe(1);
  });

  it("masks a credential literal in a script (SEC005), and keeps the code around it", async () => {
    const script = `var r = new sn_ws.RESTMessageV2();\nr.setBasicAuth('svc_user', '${FAKE_SECRET}');\nvar password = '${CANARY}';`;
    const out = shown((await prepare(payloadOf("sys_script_include", { name: "Caller", script }), ["sys_script_include"])).outcome);
    expect(out.text).not.toContain(FAKE_SECRET);
    expect(out.text).not.toContain(CANARY);
    expect(out.text).toContain(`r.setBasicAuth('svc_user', '${SECRET_MASK}');`);
    expect(out.masked).toBeGreaterThanOrEqual(2);
  });

  it("masks a credential literal in an attribute value", async () => {
    const payload = payloadOf("sys_script_include", { name: "Caller" }).replace(
      "<name>",
      `<note value="Authorization: Bearer 8f2c1e9a7b6d5c4e3f2a1b0c9d8e7f6a"/><name>`
    );
    const out = shown((await prepare(payload, ["sys_script_include"])).outcome);
    expect(out.text).not.toContain("8f2c1e9a7b6d5c4e3f2a1b0c9d8e7f6a");
    expect(out.masked).toBeGreaterThanOrEqual(1);
  });

  it("scrubs a field with a sensitive name, whatever its type, and a sensitive attribute", async () => {
    const payload = payloadOf("sys_script_include", { name: "Caller", u_client_secret: FAKE_SECRET }).replace(
      "<name>",
      `<u_note password="${FAKE_SECRET}">x</u_note><name>`
    );
    const out = shown((await prepare(payload, ["sys_script_include"])).outcome);
    expect(out.text).toContain(`<u_client_secret>${HIDDEN_MARK}</u_client_secret>`);
    // Hidden by name; the final pass over the whole text may then read it as an assignment and mask it.
    expect(out.text).toMatch(/password="\[(?:hidden|masked)\]"/u);
    expect(out.text).not.toContain(FAKE_SECRET);
    expect(out.hidden_by_name).toBe(1);
  });

  it("checks each nested record against its own table's types", async () => {
    const nested = `<sys_user action="INSERT_OR_UPDATE"><user_name>pat</user_name><user_password>${FAKE_SECRET}</user_password></sys_user>`;
    const { outcome, loaded } = await prepare(payloadOf("sys_ui_section", { name: "Section" }, nested), ["sys_ui_section"]);
    const out = shown(outcome);
    expect(new Set(loaded)).toEqual(new Set(["sys_ui_section", "sys_user"]));
    expect(out.text).toContain(`<user_password>${HIDDEN_MARK}</user_password>`);
    expect(out.text).toContain("<user_name>pat</user_name>");
    expect(out.text).not.toContain(FAKE_SECRET);
  });

  it("type-checks the root's record even when a payload leaves out its action", async () => {
    const payload = `<record_update table="u_vendor_child"><u_vendor_child><u_api_key_value>${FAKE_SECRET}</u_api_key_value></u_vendor_child></record_update>`;
    const out = shown((await prepare(payload, ["u_vendor_child"])).outcome);
    expect(out.text).toContain(`<u_api_key_value>${HIDDEN_MARK}</u_api_key_value>`);
    expect(out.text).not.toContain(FAKE_SECRET);
  });

  it("keeps the leading XML declaration, and decodes and re-escapes markup", async () => {
    const out = shown((await prepare(payloadOf("sys_script_include", { script: "if (a &lt; b &amp;&amp; c) {}" }), ["sys_script_include"])).outcome);
    expect(out.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(out.text).toContain("if (a &lt; b &amp;&amp; c) {}");
  });

  it("cuts the text at the cap only after masking, and says so", async () => {
    const script = `${"x".repeat(200)}var password = '${FAKE_SECRET}';${"y".repeat(5_000)}`;
    const out = shown((await prepare(payloadOf("sys_script_include", { script }), ["sys_script_include"], world(), 260)).outcome);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(260);
    expect(out.chars).toBeGreaterThan(5_000);
    expect(out.text).not.toContain(FAKE_SECRET);
    expect(out.text).not.toContain("fake-not");
  });

  it("sizes the text from max_response_bytes: 32 KiB by default, at most 200 KiB", () => {
    expect(payloadCharsFor(100_000)).toBe(PAYLOAD_LIMITS.DEFAULT_CHARS);
    expect(payloadCharsFor(1_000_000)).toBe(PAYLOAD_LIMITS.MAX_CHARS);
    expect(payloadCharsFor(10_000)).toBe(5_000);
    expect(payloadCharsFor(1_000)).toBe(500);
  });

  it("finds the row's own tables from its table column and its update name", () => {
    expect(rowTables({ table: "sys_script", name: `sys_script_include_${"a".repeat(32)}` })).toEqual(["sys_script", "sys_script_include"]);
    expect(rowTables({ table: "Bad Table", name: "not an update name" })).toEqual([]);
  });
});

describe("payload view: unexpected layouts", () => {
  /** `u_vendor.u_vendor_code` is password2, under a name the sensitive-name check does not catch. */
  const CODED = world({ dictionary: [...world().dictionary, { name: "u_vendor", element: "u_vendor_code", internal_type: "password2" }] });
  const record = (open: string, body: string, close: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><record_update table="u_vendor">${open}${body}${close}</record_update>`;

  it("withholds payloads whose record elements are not lower-case table names", async () => {
    for (const payload of [
      record('<U_VENDOR action="INSERT_OR_UPDATE">', `<u_vendor_code>${FAKE_SECRET}</u_vendor_code>`, "</U_VENDOR>"),
      record('<SYS_PROPERTIES action="INSERT_OR_UPDATE">', `<value>${FAKE_SECRET}</value>`, "</SYS_PROPERTIES>"),
      record('<u_vendor action="INSERT_OR_UPDATE">', `<Wrapper><u_vendor_code>${FAKE_SECRET}</u_vendor_code></Wrapper>`, "</u_vendor>"),
    ]) {
      const { outcome, instance } = await prepare(payload, ["u_vendor"], CODED);
      expect(outcome).toEqual({ status: "withheld", reason: "unreadable", hint: PAYLOAD_HINTS.unreadable });
      expect(JSON.stringify(outcome)).not.toContain(FAKE_SECRET);
      expect(instance.calls).toEqual([]);
    }
  });

  it("hides a record's attribute named like one of its hidden-typed fields", async () => {
    const payload = record(`<u_vendor action="INSERT_OR_UPDATE" u_vendor_code="${FAKE_SECRET}">`, "<u_name>Acme</u_name>", "</u_vendor>");
    const out = shown((await prepare(payload, ["u_vendor"], CODED)).outcome);
    expect(out.text).toContain(`u_vendor_code="${HIDDEN_MARK}"`);
    expect(out.text).toContain('action="INSERT_OR_UPDATE"');
    expect(out.text).not.toContain(FAKE_SECRET);
  });

  it("checks an element that holds elements inside a record as a record of its own", async () => {
    const nested = `<u_name>Acme</u_name><u_vendor_child><u_vendor_code>${FAKE_SECRET}</u_vendor_code></u_vendor_child>`;
    const { outcome, loaded } = await prepare(record('<u_vendor action="INSERT_OR_UPDATE">', nested, "</u_vendor>"), ["u_vendor"], CODED);
    const out = shown(outcome);
    expect(new Set(loaded)).toEqual(new Set(["u_vendor", "u_vendor_child"]));
    expect(out.text).toContain(`<u_vendor_code>${HIDDEN_MARK}</u_vendor_code>`);
    expect(out.text).not.toContain(FAKE_SECRET);
    // One whose name is not a known table withholds the payload.
    const unknown = `<u_wrapper><u_vendor_code>${FAKE_SECRET}</u_vendor_code></u_wrapper>`;
    const withheld = (await prepare(record('<u_vendor action="INSERT_OR_UPDATE">', unknown, "</u_vendor>"), ["u_vendor"], CODED)).outcome;
    expect(withheld).toMatchObject({ status: "withheld", reason: "hierarchy_unknown" });
  });

  it("hides text that sits in a record or the root outside any field", async () => {
    const payload = `<record_update table="u_vendor">${FAKE_SECRET}<u_vendor action="INSERT_OR_UPDATE">${FAKE_SECRET}<u_name>Acme</u_name></u_vendor></record_update>`;
    const out = shown((await prepare(payload, ["u_vendor"], CODED)).outcome);
    expect(out.text).not.toContain(FAKE_SECRET);
    expect(out.text).toContain("<u_name>Acme</u_name>");
  });

  it("still hides a hidden-typed field that holds elements, and checks what it holds", async () => {
    const payload = record('<u_vendor action="INSERT_OR_UPDATE">', `<u_vendor_code><u_vendor_child><u_name>${FAKE_SECRET}</u_name></u_vendor_child></u_vendor_code>`, "</u_vendor>");
    const { outcome } = await prepare(payload, ["u_vendor"], world({ ...CODED, tables: { ...CODED.tables, u_vendor_code: null } }));
    const out = shown(outcome);
    expect(out.text).toContain(`<u_vendor_code><u_vendor_child><u_name>${HIDDEN_MARK}</u_name></u_vendor_child></u_vendor_code>`);
    expect(out.hidden_by_type).toBe(1);
    expect(out.text).not.toContain(FAKE_SECRET);
  });
});

describe("payload view: refused and withheld", () => {
  const refused = (outcome: PayloadOutcome, status: string, reason: keyof typeof PAYLOAD_HINTS) => {
    expect(outcome).toEqual({ status, reason, hint: PAYLOAD_HINTS[reason] });
    expect(JSON.stringify(outcome)).not.toContain(FAKE_SECRET);
  };

  it("refuses a credential table by name, before any type read", async () => {
    for (const table of ["sys_properties", "discovery_credentials", "sys_auth_profile_basic", "sys_rest_message"]) {
      const { outcome, instance } = await prepare(payloadOf(table, { value: FAKE_SECRET }), [table]);
      refused(outcome, "refused", "credential_table");
      expect(instance.calls, table).toEqual([]);
    }
  });

  it("refuses a table that extends a credential table, and a nested credential record", async () => {
    refused((await prepare(payloadOf("ssh_credentials", { u_key: FAKE_SECRET }), ["ssh_credentials"])).outcome, "refused", "credential_table");
    const nested = `<sys_properties action="INSERT_OR_UPDATE"><value>${FAKE_SECRET}</value></sys_properties>`;
    refused(
      (await prepare(payloadOf("sys_script_include", { name: "x" }, nested), ["sys_script_include"])).outcome,
      "refused",
      "credential_table"
    );
  });

  it("withholds a payload whose table has no known hierarchy, or whose field types could not be read", async () => {
    refused((await prepare(payloadOf("u_unknown", { u_value: FAKE_SECRET }), ["u_unknown"])).outcome, "withheld", "hierarchy_unknown");
    // Every child of the root is a record of its own: one that is not a known table withholds the payload.
    const wrapped = `<record_update table="sys_script_include"><u_wrapper><u_vendor_child><u_api_key_value>${FAKE_SECRET}</u_api_key_value></u_vendor_child></u_wrapper></record_update>`;
    refused((await prepare(wrapped, ["sys_script_include"])).outcome, "withheld", "hierarchy_unknown");
    const noTypes = world({ dictionary: [] });
    refused(
      (await prepare(payloadOf("sys_script_include", { script: "x" }), ["sys_script_include"], noTypes)).outcome,
      "withheld",
      "field_types_unavailable"
    );
  });

  it("withholds XML it cannot read: a DOCTYPE, an entity, a processing instruction, malformed markup", async () => {
    for (const payload of [
      `<!DOCTYPE x [<!ENTITY e "${FAKE_SECRET}">]><record_update/>`,
      `<record_update><a>&e;</a></record_update>`,
      `<record_update><?php echo 1 ?></record_update>`,
      `<record_update><a>${FAKE_SECRET}</b></record_update>`,
      FAKE_SECRET,
    ]) {
      const { outcome, instance } = await prepare(payload, ["sys_script_include"]);
      refused(outcome, "withheld", "unreadable");
      expect(instance.calls).toEqual([]);
    }
  });

  it("withholds a payload that writes too many tables, or is too large", async () => {
    const many = Array.from({ length: PAYLOAD_LIMITS.MAX_TABLES + 1 }, (_, n) => `<u_t${n} action="INSERT_OR_UPDATE"><a>1</a></u_t${n}>`).join("");
    refused((await prepare(`<record_update>${many}</record_update>`, [])).outcome, "withheld", "too_many_tables");
    const huge = payloadOf("sys_script_include", { script: "z".repeat(PAYLOAD_LIMITS.MAX_BYTES + 1) });
    refused((await prepare(huge, ["sys_script_include"])).outcome, "withheld", "too_large");
  });

  it("answers empty for an empty payload, without reading", async () => {
    const { outcome, instance } = await prepare("  ", ["sys_script_include"]);
    expect(outcome).toEqual({ status: "empty" });
    expect(instance.calls).toEqual([]);
  });
});
