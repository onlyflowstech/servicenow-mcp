import { describe, expect, it } from "vitest";

import { SNIPPET_WIDTH, snippetAround } from "../src/code-search-snippet.js";

const filler = (count: number, char = "x") => char.repeat(count);

describe("the snippet around a match", () => {
  it("centres a window of about 200 characters on the first match and says where it is", () => {
    const body = `${filler(1_000)}\ngs.info('needle');\n${filler(1_000)}`;
    const { text, line } = snippetAround(body, "needle");
    expect(text).toContain("needle");
    expect(text.startsWith("...")).toBe(true);
    expect(text.endsWith("...")).toBe(true);
    // 200 characters of the script, plus a marker at each cut end.
    expect(text.length).toBe(SNIPPET_WIDTH + 6);
    const at = text.indexOf("needle");
    expect(Math.abs(at - 3 - (SNIPPET_WIDTH - 6) / 2)).toBeLessThanOrEqual(2);
    expect(line).toBe(2);
  });

  it("matches without regard to case and reports the first of several matches", () => {
    const { text, line } = snippetAround("a\nb\nvar Needle = 1; var NEEDLE = 2;", "needle");
    expect(text).toBe("a\nb\nvar Needle = 1; var NEEDLE = 2;");
    expect(line).toBe(3);
  });

  it("leaves a short script whole, with no markers", () => {
    expect(snippetAround("short script", "script")).toEqual({ text: "short script", line: 1 });
  });

  it("starts at the head when the match is near it, and ends at the tail when it is near that", () => {
    const head = snippetAround(`needle ${filler(500)}`, "needle");
    expect(head.text.startsWith("needle")).toBe(true);
    expect(head.text.endsWith("...")).toBe(true);
    expect(head.text.length).toBe(SNIPPET_WIDTH + 3);
    const tail = snippetAround(`${filler(500)} needle`, "needle");
    expect(tail.text.startsWith("...")).toBe(true);
    expect(tail.text.endsWith("needle")).toBe(true);
    expect(tail.text.length).toBe(SNIPPET_WIDTH + 3);
  });

  it("counts lines whichever way they end", () => {
    expect(snippetAround("a\r\nb\r\nneedle", "needle").line).toBe(3);
    expect(snippetAround("needle", "needle").line).toBe(1);
  });

  it("reads the term literally, never as a pattern", () => {
    expect(snippetAround("x = a.b + (c) * $1 [0]", "a.b").text).toContain("a.b");
    expect(snippetAround("axb and a.b", "a.b").line).toBe(1);
    expect(snippetAround("axb only", "a.b").line).toBeUndefined();
    expect(snippetAround("v = (c) * $1 [0] \\d", "(c) * $1 [0] \\d").line).toBe(1);
    // A pattern that backtracks without end if it were one.
    const started = Date.now();
    snippetAround(`${filler(50_000, "a")}!`, "(a+)+$");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("starts a long match at the match, keeping the width", () => {
    const term = filler(300, "q");
    const { text } = snippetAround(`${filler(1_000)}${term}${filler(1_000)}`, term);
    expect(text.startsWith("...")).toBe(true);
    expect(text.slice(3, 3 + SNIPPET_WIDTH)).toBe(filler(SNIPPET_WIDTH, "q"));
  });

  it("falls back to the head, with no line, when the term is not found", () => {
    const body = `${filler(300)}`;
    const missing = snippetAround(body, "needle");
    expect(missing.text).toBe(`${filler(SNIPPET_WIDTH)}...`);
    expect(missing.line).toBeUndefined();
    expect(snippetAround(body, "").line).toBeUndefined();
    expect(snippetAround("", "needle")).toEqual({ text: "" });
  });

  it("does not split a surrogate pair at either end of the window", () => {
    const emoji = "\u{1F600}";
    for (let pad = 90; pad < 110; pad += 1) {
      const body = `${emoji.repeat(pad)}needle${emoji.repeat(pad)}`;
      const { text } = snippetAround(body, "needle");
      for (const char of text.replace(/\.\.\./gu, "")) {
        expect(char === emoji || /^[needle]$/u.test(char), `pad ${pad}`).toBe(true);
      }
    }
  });
});
