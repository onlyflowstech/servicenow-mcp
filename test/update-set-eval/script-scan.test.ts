import { describe, expect, it } from "vitest";

import { TokenKind, callArguments, findCall, findMethod, lineAt, scriptLine, tokenize } from "../../src/update-set-eval/script-scan.js";
import { evaluateUpdateSets } from "../../src/update-set-eval/engine.js";
import { input, update } from "../fixtures/update-set-eval/rule-cases.js";

const values = (text: string) => tokenize(text).tokens.map((t) => t.value);

describe("tokenize", () => {
  it("skips comments and keeps literals as single tokens", () => {
    const scan = tokenize("// current.update();\n/* gs.sleep(1) */ var s = 'current.update()'; var t = `a ${b}`;");
    expect(scan.tokens.map((t) => t.value)).toEqual(["var", "s", "=", "current.update()", ";", "var", "t", "=", "a ${b}", ";"]);
    expect(findCall(scan, "current", "update")).toBe(-1);
    expect(scan.tokens[3].kind).toBe(TokenKind.String);
  });

  it("tells a regular expression from a division", () => {
    expect(values("var r = /current.update()/g; var x = a / b / c;")).toEqual([
      "var", "r", "=", "", ";", "var", "x", "=", "a", "/", "b", "/", "c", ";",
    ]);
    expect(values("return /[/]x/.test(s)")[1]).toBe("");
  });

  it("groups comparison and logical operators", () => {
    expect(values("a === b && c !== d || e => f <= g")).toEqual(["a", "===", "b", "&&", "c", "!==", "d", "||", "e", "=>", "f", "<=", "g"]);
  });

  it("matches brackets and marks loop bodies", () => {
    const scan = tokenize("while (gr.next()) { x.query(); } y.query();");
    const open = scan.tokens.findIndex((t) => t.value === "{");
    expect(scan.match[open]).toBe(scan.tokens.findIndex((t) => t.value === "}"));
    const queries = scan.tokens.flatMap((t, k) => (t.value === "query" ? [k] : []));
    expect(queries.map((k) => scan.loopDepth[k])).toEqual([1, 0]);
    expect(scan.loops).toHaveLength(1);
  });

  it("counts call arguments at the top level only", () => {
    const scan = tokenize("f(a, g(b, c), [d, e], {x: 1, y: 2})");
    expect(callArguments(scan, 1)).toHaveLength(4);
    expect(callArguments(tokenize("f()"), 1)).toHaveLength(0);
  });

  it("finds method calls on any receiver", () => {
    expect(findMethod(tokenize("a.b.getRowCount()"), "getRowCount")).toBe(4);
    expect(findMethod(tokenize("getRowCount()"), "getRowCount")).toBe(-1);
  });

  it("counts lines across LF, CRLF and CR", () => {
    expect(lineAt("a\nb\r\nc\rd", 7)).toBe(4);
    expect(lineAt("abc", 1)).toBe(1);
  });

  it("gives the same line from the precomputed line starts, for every offset", () => {
    const text = "a\nb\r\nc\rd\n\n\r\re\r\n";
    const scan = tokenize(text);
    for (let offset = 0; offset <= text.length; offset++) expect(scriptLine(scan, offset), String(offset)).toBe(lineAt(text, offset));
    expect(scriptLine(tokenize(""), 0)).toBe(1);
  });

  it("never throws on unbalanced or unterminated input", () => {
    for (const text of ["((((", "}}}}", "'unterminated", "`multi\nline", "/* open", "/unterminated regex", "\\", "a.b.(.)"]) {
      expect(() => tokenize(text)).not.toThrow();
    }
  });
});

describe("linear time on hostile scripts", () => {
  // A linear-time regression guard, as in fuzz-and-redos.test.ts: each input
  // is a 256 KiB script (the per-payload cap), and a quadratic loop over it
  // would take far longer than the bound.
  const BOUND_MS = 2_000;
  const SIZE = 250_000;
  const fill = (unit: string) => unit.repeat(Math.floor(SIZE / unit.length));
  const scripts: Record<string, string> = {
    "nested loops": fill("for(;;){") + fill("}"),
    "nested while loops with next()": fill("while(a.next()){"),
    "many new GlideRecord in a loop": `while(a.next()){${fill("new GlideRecord('x');")}}`,
    "many GlideRecord variables": fill("var g = new GlideRecord('x'); g.query();"),
    "many unmatched closers": fill(")]}"),
    "many unmatched openers": fill("([{"),
    "many getReference calls": fill("g_form.getReference('a', b);"),
    "many isPublic tokens": fill("isPublic isPublic : function"),
    "many string literals": fill("'0123456789abcdef0123456789abcdeg' "),
    "many regex-like slashes": fill("(/a/ / /b/ "),
    "many eval-like names": fill("x.eval(1); "),
    "many setMandatory calls with password": fill("g_form.setMandatory('password', 'true');\n"),
    "many open braced unicode escapes": fill("\\u{"),
    "many short unicode escapes": fill("\\u00"),
    "one long escaped identifier": fill("\\u0061"),
    "many bracketed eval strings": fill("gs['eval']"),
  };

  it.each(Object.entries(scripts))("%s", async (_name, script) => {
    const row = update("sys_script", { name: "BR", when: "before", action_query: "true", script });
    const start = performance.now();
    const result = await evaluateUpdateSets(input([row]));
    expect(performance.now() - start).toBeLessThan(BOUND_MS);
    expect(result.coverage.evaluated).toBe(1);
  });
});
