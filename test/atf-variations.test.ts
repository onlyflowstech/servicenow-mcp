import { describe, expect, it } from "vitest";
import definitions from "../src/tools/atf-step-definitions.json";
import fixture from "./fixtures/atf/step-catalog.json";
import { prepareSteps } from "../src/tools/atf-step-catalog.js";
const id="1".repeat(32);
function example(type: keyof typeof definitions):Record<string,unknown> {
 const values:Record<string,unknown>={...fixture.catalog[type].example_values};
 for(const input of definitions[type].inputs){
  if(input.internal_type==="boolean" && values[input.element]!==undefined)values[input.element]=["true","1",true].includes(values[input.element] as string);
  if(input.internal_type==="integer" && values[input.element]!==undefined)values[input.element]=Number(values[input.element]);
  if(input.mandatory&&input.internal_type==="document_id"&&values[input.element]===undefined)values[input.element]=id;
 }
 return values;
}
const prepare=(type:string,inputs:Record<string,unknown>)=>prepareSteps({test_sys_id:id,steps:[{type,inputs}]},true);
describe("ATF catalog variation boundaries",()=>{
 for(const [type,definition]of Object.entries(definitions)){
  const base=example(type as keyof typeof definitions);
  for(const input of definition.inputs){
   if("choices"in input) for(const choice of input.choices) it(`${type}.${input.element} accepts ${choice}`,()=>{
    expect(prepare(type,{...base,[input.element]:choice}).args.preparedSteps[0].inputs[input.element]).toBe(choice);
   });
   if("choices"in input) it(`${type}.${input.element} rejects unknown choices`,()=>{expect(()=>prepare(type,{...base,[input.element]:"not-a-choice"})).toThrow();});
   if(input.internal_type==="boolean") it.each([true,false])(`${type}.${input.element} accepts boolean %s`,value=>{expect(prepare(type,{...base,[input.element]:value}).args.preparedSteps[0].inputs[input.element]).toBe(String(value));});
  }
 }
 it.each(["headers","query_params"])("preserves nonempty %s maps and rejects malformed encodings",field=>{
  const map={alpha:"spaces & unicode Ω",beta:"a=b?c=d"};
  expect(JSON.parse(prepare("rest_send_request_inbound",{end_point:"/api/now/table/sys_atf_test",[field]:map}).args.preparedSteps[0].inputs[field])).toEqual(map);
  for(const invalid of ["alpha=x",{alpha:3},{"bad\r\nname":"value"},Object.fromEntries(Array.from({length:51},(_,i)=>["key"+i,"v"]))])expect(()=>prepare("rest_send_request_inbound",{end_point:"/api/now/table/sys_atf_test",[field]:invalid})).toThrow();
 });
 it("requires script authoring permission separately from ordinary steps",()=>{
  expect(()=>prepareSteps({test_sys_id:id,steps:[{type:"run_server_side_script",inputs:{jasmine_version:"3.1",script:""}}]},false)).toThrow();
  expect(()=>prepareSteps({test_sys_id:id,steps:[{type:"record_query",inputs:{table:"sys_atf_test",field_values:"active=true"}}]},false)).not.toThrow();
 });
});
