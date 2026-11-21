import { describe, expect, it } from "vitest";

import { inertText, quotedInertText } from "../src/inert-text.js";
import { encodeMermaidLabel } from "../src/tools/flow-view-mermaid.js";

/** Characters that render as nothing or reorder text, written as escapes so the file stays readable. */
const TAGS = String.fromCodePoint(0xe0041, 0xe0042, 0xe007f);
const BIDI = "‮⁦‏؜";
const ZERO_WIDTH = "​‌‍⁠﻿­";
const CONTROLS = "\u0000\u0007\u001B\u007F\u009F";

describe("inertText", () => {
  it("removes tag, bidi, zero-width and control characters", () => {
    expect(inertText(`a${TAGS}b${BIDI}c${ZERO_WIDTH}d${CONTROLS}e`)).toBe("abcde");
  });

  it("turns line breaks, tabs, LS and PS into one space, collapses runs and trims", () => {
    expect(inertText("  a\r\nb\tc d e   f  ")).toBe("a b c d e f");
  });

  it("removes unpaired surrogates and keeps well-formed pairs", () => {
    expect(inertText("a\uD800b\uDC00c\u{1F600}")).toBe("abc\u{1F600}");
  });

  it("bounds the result in code points and marks a cut, examining only a bounded prefix", () => {
    expect(inertText("x".repeat(500), 10)).toBe(`${"x".repeat(10)}…`);
    expect(inertText("y".repeat(1_000_000), 10)).toBe(`${"y".repeat(10)}…`);
    expect(inertText("short", 10)).toBe("short");
    expect(inertText(undefined)).toBe("");
    expect(inertText(42)).toBe("");
  });

  it("neutralizes double quotes only in the quoted form", () => {
    expect(inertText('say "hi"')).toBe('say "hi"');
    expect(quotedInertText('say "hi"')).toBe("say 'hi'");
  });

  it("removes the characters encodeMermaidLabel removes", () => {
    const hostile = `a${TAGS}${BIDI}${ZERO_WIDTH}${CONTROLS}b`;
    expect(encodeMermaidLabel(hostile)).toBe("ab");
    expect(inertText(hostile)).toBe("ab");
  });
});
