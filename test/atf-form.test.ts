import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAtfForm, type AtfFormInput } from "../src/atf-form.js";
import { ServiceNowClient } from "../src/client.js";
const id = (n: number) => n.toString(16).padStart(32,"0");
const args: AtfFormInput = {stepId:id(1),testId:id(2),configId:id(3),scope:"global",inputs:{script:'gs.info("<ok>&");'}};
const origin="https://example.service-now.com";
function form(){return `<form name="sys_atf_step.do" method="POST" action="sys_atf_step.do">
<input name="sys_target" value="sys_atf_step"><input name="sys_uniqueValue" value="${args.stepId}">
<input name="sysparm_ck" value="private-csrf"><input name="sys_atf_step.sys_scope" value="global">
<input name="sys_atf_step.test" value="${args.testId}"><input name="sys_atf_step.step_config" value="${args.configId}">
<input name="sys_atf_step.unrequested" value="must-not-send">
<textarea name="sys_atf_step.inputs.var__m_atf_input_variable_${args.configId}.script">old &amp; value</textarea></form>`;}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("native ATF form",()=>{
 it("submits only the verified target and requested inputs",()=>{
  const fields=prepareAtfForm(form(),origin,args);
  expect(fields.get(`sys_atf_step.inputs.var__m_atf_input_variable_${args.configId}.script`)).toBe(args.inputs.script);
  expect(fields.get("sys_action")).toBe("sysverb_update");expect(fields.has("sys_atf_step.unrequested")).toBe(false);
 });
 it("saves output pills in native mapping controls and refuses missing mapping support",()=>{
  const control=`sys_atf_step.inputs.var__m_atf_input_variable_${args.configId}.script`;
  const pill=`{{step['${id(8)}'].first_record}}`;
  const input={...args,inputs:{script:pill}};
  expect(()=>prepareAtfForm(form(),origin,input)).toThrow();
  const html=form().replace('</form>', ['sys_mapping.','sys_mapping_display.','sys_mapping.original.'].map(prefix=>`<input name="${prefix+control}" value="">`).join('')+'</form>');
  const fields=prepareAtfForm(html,origin,input);
  expect(fields.get(control)).toBe('');expect(fields.get('sys_mapping.'+control)).toBe(pill);
  expect(fields.get('sys_mapping.original.'+control)).toBe('');
 });
 it.each([
  (html:string)=>html.replace('action="sys_atf_step.do"','action="https://other.example/sys_atf_step.do"'),
  (html:string)=>html.replace('value="global"','value="different"'),
  (html:string)=>html.replace(args.testId,id(9)),
  (html:string)=>html.replace('name="sysparm_ck"','name="missing"'),
  (html:string)=>html.replace('<textarea','<textarea readonly'),
  (html:string)=>html+html,
 ])("rejects changed, ambiguous or unwritable forms",change=>{expect(()=>prepareAtfForm(change(form()),origin,args)).toThrow();});
 it("keeps session material in one same-origin pair and never follows redirects",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(form(),{headers:{'set-cookie':'JSESSIONID=private-session; Secure; HttpOnly'}})).mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'/sys_atf_step_list.do'}}));vi.stubGlobal('fetch',fetch);
  const client=new ServiceNowClient({instance:origin,user:'test',password:'test',displayValue:'false',relDepth:1});
  await client.saveAtfStepInputs(args);
  expect(fetch).toHaveBeenCalledTimes(2);
  const [url,request]=fetch.mock.calls[1];expect(url).toBe(origin+'/sys_atf_step.do');expect(request.redirect).toBe('manual');
  expect(request.headers.Cookie).toBe('JSESSIONID=private-session');expect(request.body.get('sysparm_ck')).toBe('private-csrf');
 });
 it("does not retry an uncertain form POST",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(form())).mockRejectedValueOnce(new Error('network loss'));vi.stubGlobal('fetch',fetch);
  const client=new ServiceNowClient({instance:origin,user:'test',password:'test',displayValue:'false',relDepth:1});
  await expect(client.saveAtfStepInputs(args)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
 });
});
