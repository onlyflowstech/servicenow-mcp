/** Native ATF form contract. HTML is parsed as data and never executed. */
import { parse, type DefaultTreeAdapterTypes as Html } from "parse5";
import { z } from "zod";
import { serviceNowSysIdSchema as id } from "./servicenow-identifiers.js";
import { createToolError } from "./tool-error.js";

export const atfFormInputSchema = z.object({
  stepId: id, testId: id, configId: id, scope: z.union([id, z.literal("global")]),
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), z.string().max(100000)).refine(value => Object.keys(value).length <= 50),
}).strict();
export type AtfFormInput = z.infer<typeof atfFormInputSchema>;
export const ATF_STEP_REFERENCE = /^\{\{step\['[a-f0-9]{32}'\]\.[a-z][a-z0-9_]*\}\}$/u;
const reject = () => createToolError("upstream", "do_not_retry");
function elements(node: Html.Node): Html.Element[] {
  const result: Html.Element[] = [];
  function visit(child: Html.Node) {
    if ("tagName" in child) result.push(child);
    if ("childNodes" in child) for (const next of child.childNodes) visit(next);
  }
  visit(node); return result;
}
function attr(node: Html.Element, key: string): string | undefined { return node.attrs.find(a => a.name === key)?.value; }
function contents(node: Html.Node): string {
  if (node.nodeName === "#text") return (node as Html.TextNode).value;
  return "childNodes" in node ? node.childNodes.map(contents).join("") : "";
}
/** Return only the required protocol fields and requested input controls. */
export function prepareAtfForm(html: string, origin: string, candidate: AtfFormInput): URLSearchParams {
  const input = atfFormInputSchema.parse(candidate);
  const forms = elements(parse(html)).filter(e => e.tagName === "form" && attr(e, "name") === "sys_atf_step.do");
  if (forms.length !== 1) throw reject();
  const form = forms[0];
  const target = new URL(attr(form, "action") ?? "", origin + "/sys_atf_step.do");
  if (target.origin !== origin || target.pathname !== "/sys_atf_step.do" || target.search || target.hash || target.username || target.password || attr(form, "method")?.toLowerCase() !== "post") throw reject();
  const controls = new Map<string, { value: string; writable: boolean }>();
  for (const element of elements(form)) {
    if (!["input", "textarea", "select"].includes(element.tagName)) continue;
    const name = attr(element, "name"); if (!name) continue;
    const type = attr(element, "type")?.toLowerCase() ?? "text";
    if (["button", "submit", "file", "reset"].includes(type)) continue;
    const disabled = attr(element, "disabled") !== undefined;
    if (["checkbox", "radio"].includes(type) && attr(element, "checked") === undefined) continue;
    let value = attr(element, "value") ?? "";
    if (element.tagName === "textarea") value = contents(element);
    if (element.tagName === "select") {
      const options = elements(element).filter(e => e.tagName === "option");
      const option = options.find(e => attr(e, "selected") !== undefined) ?? options[0];
      value = option ? attr(option, "value") ?? contents(option) : "";
    }
    const old = controls.get(name);
    if (old && old.value !== value) throw reject();
    controls.set(name, { value, writable: !disabled && attr(element, "readonly") === undefined });
  }
  const expected: Record<string, string> = {
    sys_target: "sys_atf_step", sys_uniqueValue: input.stepId,
    "sys_atf_step.sys_scope": input.scope, "sys_atf_step.test": input.testId,
    "sys_atf_step.step_config": input.configId,
  };
  for (const [name, value] of Object.entries(expected)) if (controls.get(name)?.value !== value) throw reject();
  const token = controls.get("sysparm_ck")?.value;
  if (!token || token.length > 1024 || /[\r\n]/.test(token)) throw reject();
  const fields = new URLSearchParams({ sys_target: "sys_atf_step", sys_uniqueValue: input.stepId, sys_action: "sysverb_update", sysparm_ck: token });
  // Existing step identity is verified above; do not replay other writable fields.
  for (const [name, value] of Object.entries(input.inputs)) {
    const control = `sys_atf_step.inputs.var__m_atf_input_variable_${input.configId}.${name}`;
    if (!controls.get(control)?.writable) throw reject();
    if (ATF_STEP_REFERENCE.test(value)) {
      for (const prefix of ["sys_mapping.", "sys_mapping_display.", "sys_mapping.original."]) {
        if (!controls.get(prefix + control)?.writable) throw reject();
      }
      fields.set(control, "");
      fields.set("sys_mapping." + control, value);
      fields.set("sys_mapping_display." + control, value);
      fields.set("sys_mapping.original." + control, controls.get("sys_mapping.original." + control)!.value);
    } else fields.set(control, value);
  }
  return fields;
}
/** Cookies live only for one form load/save pair and never leave the exact origin. */
export function atfFormCookies(headers: Headers): string {
  const cookies = headers.getSetCookie().map(header => header.split(";", 1)[0]);
  if (cookies.length > 30 || cookies.join(";").length > 16384 || cookies.some(cookie => !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+=[^\x00-\x20\x7f;]*$/.test(cookie))) throw reject();
  return cookies.join("; ");
}
