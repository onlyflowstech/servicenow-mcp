import { describe, expect, it } from "vitest";

import * as secretPatterns from "../../src/update-set-eval/secret-patterns.js";
import {
  SECRET_MASK,
  SECRET_PATTERN_IDS,
  SECRET_SCAN_MAX_CHARS,
  maskSecrets,
  scanSecrets,
  type SecretMatch,
  type SecretPatternId,
} from "../../src/update-set-eval/secret-patterns.js";
import { SECRET_CASES } from "../fixtures/update-set-eval/secret-cases.js";

function matchesOf(text: string): readonly SecretMatch[] {
  const result = scanSecrets(text);
  if (result.status !== "ok") throw new Error("scan refused the text");
  return result.matches;
}

function masked(text: string): string {
  const result = maskSecrets(text);
  if (result.status !== "ok") throw new Error("mask refused the text");
  return result.text;
}

describe("secret patterns: one positive and one negative fixture per pattern", () => {
  it("has fixtures for exactly the exported ids, each with both kinds", () => {
    expect(Object.keys(SECRET_CASES).sort()).toEqual([...SECRET_PATTERN_IDS].sort());
    for (const id of SECRET_PATTERN_IDS) {
      expect(SECRET_CASES[id].positive.length, id).toBeGreaterThan(0);
      expect(SECRET_CASES[id].negative.length, id).toBeGreaterThan(0);
    }
  });

  describe.each(SECRET_PATTERN_IDS.map((id) => [id] as [SecretPatternId]))("%s", (id) => {
    it.each(SECRET_CASES[id].positive.map((c, index) => [index, c] as const))(
      "positive %i: reports the exact value and masking removes it",
      (_index, { text, secret }) => {
        const spans = matchesOf(text)
          .filter((m) => m.id === id)
          .map((m) => text.slice(m.start, m.end));
        expect(spans).toContain(secret);
        const out = masked(text);
        expect(out).not.toContain(secret);
        expect(out).toContain(SECRET_MASK);
      }
    );

    it.each(SECRET_CASES[id].negative.map((text, index) => [index, text] as const))(
      "negative %i: does not match",
      (_index, text) => {
        expect(matchesOf(text).filter((m) => m.id === id)).toEqual([]);
      }
    );
  });
});

describe("scanSecrets", () => {
  it("returns ids and offsets only, sorted by offset", () => {
    const first = SECRET_CASES.credential_assignment.positive[0];
    const second = SECRET_CASES.aws_access_key_id.positive[0];
    const text = `${first.text}\n${second.text}`;
    const result = scanSecrets(text);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.truncated).toBe(false);
    expect(result.matches.map((m) => m.id)).toEqual(["credential_assignment", "aws_access_key_id"]);
    for (const match of result.matches) expect(Object.keys(match).sort()).toEqual(["end", "id", "start"]);
    expect(result.matches[0].start).toBeLessThan(result.matches[1].start);
  });

  it("stops at maxMatches and says so", () => {
    const text = Array.from({ length: 10 }, (_, k) => `var password = 'value${k}';`).join("\n");
    const result = scanSecrets(text, { maxMatches: 3 });
    expect(result).toMatchObject({ status: "ok", truncated: true });
    if (result.status === "ok") expect(result.matches).toHaveLength(3);
    expect(() => scanSecrets(text, { maxMatches: 0 })).toThrow(RangeError);
  });

  it("refuses text over the cap rather than scanning part of it", () => {
    expect(scanSecrets("a".repeat(SECRET_SCAN_MAX_CHARS + 1))).toEqual({ status: "too_large" });
    expect(maskSecrets("a".repeat(SECRET_SCAN_MAX_CHARS + 1))).toEqual({ status: "too_large" });
    expect(scanSecrets("a".repeat(SECRET_SCAN_MAX_CHARS)).status).toBe("ok");
  });

  it("finds nothing in ordinary server code", () => {
    const code = [
      "(function executeRule(current, previous) {",
      "  var gr = new GlideRecord('incident');",
      "  gr.addQuery('active', true);",
      "  gr.query();",
      "  var rm = new sn_ws.RESTMessageV2('Vendor', 'get');",
      "  rm.setAuthenticationProfile('basic', gs.getProperty('x.vendor.profile'));",
      "  rm.setRequestHeader('Accept', 'application/json');",
      "  var password = current.u_password.getDecryptedValue();",
      "  gs.info('Basic flow done for ' + current.number);",
      "})(current, previous);",
    ].join("\n");
    expect(matchesOf(code)).toEqual([]);
  });
});

describe("maskSecrets", () => {
  it("masks only the value and keeps the code around it", () => {
    expect(masked("r.setBasicAuth('admin', 'hunter2');")).toBe(`r.setBasicAuth('admin', '${SECRET_MASK}');`);
    expect(masked("var password = 'x1'; var y = 2;")).toBe(`var password = '${SECRET_MASK}'; var y = 2;`);
  });

  it("merges overlapping matches into one mask", () => {
    // The header value is a credential (key_header) and holds a bearer
    // token (bearer_token): two overlapping spans, one mask.
    const text = "rm.setRequestHeader('Authorization', 'Bearer 8f2c1e9a7b6d5c4e3f2a1b0c9d8e7f6a');";
    const result = maskSecrets(text);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ids).toEqual(["bearer_token", "key_header"]);
    expect(result.masked).toBe(1);
    expect(result.text).toBe(`rm.setRequestHeader('Authorization', '${SECRET_MASK}');`);
  });

  it("is idempotent and reports nothing for clean text", () => {
    for (const id of SECRET_PATTERN_IDS) {
      for (const { text } of SECRET_CASES[id].positive) {
        const once = masked(text);
        expect(masked(once), id).toBe(once);
      }
    }
    expect(maskSecrets("var x = 1;")).toEqual({ status: "ok", text: "var x = 1;", masked: 0, ids: [] });
  });

  it("masks a cut-off literal to the end of the text", () => {
    expect(masked("var password = 'abcdef")).toBe(`var password = '${SECRET_MASK}`);
  });
});

describe("no pattern text leaves the module", () => {
  it("exports no regular expression", () => {
    const exported = Object.values(secretPatterns).flatMap((value) =>
      Array.isArray(value) ? value : [value]
    );
    for (const value of exported) expect(value).not.toBeInstanceOf(RegExp);
  });

  it("puts no matched text into a result", () => {
    for (const id of SECRET_PATTERN_IDS) {
      for (const { text, secret } of SECRET_CASES[id].positive) {
        const scan = JSON.stringify(scanSecrets(text));
        expect(scan, id).not.toContain(secret);
        const mask = maskSecrets(text);
        if (mask.status === "ok") expect(JSON.stringify({ ...mask, text: "" }), id).not.toContain(secret);
      }
    }
  });
});
