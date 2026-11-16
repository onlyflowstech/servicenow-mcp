import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SECRET_PATTERN_IDS,
  SECRET_SCAN_MAX_CHARS,
  maskSecrets,
  scanSecrets,
} from "../../src/update-set-eval/secret-patterns.js";
import {
  XML_READER_MAX_BYTES,
  XML_READ_ERROR_CODES,
  XML_READ_ERROR_MESSAGES,
  readXml,
  serializeXml,
} from "../../src/update-set-eval/xml-reader.js";
import { hostileSecretInputs, hostileXmlInputs, prng } from "../fixtures/update-set-eval/hostile-inputs.js";

// The evaluator's CPU budget for a whole call is 250 ms. One hostile input at the
// largest size each module accepts (four times the evaluator's per-payload
// cap) must fit inside it. Measured locally: under 15 ms for the secret scan
// and under 25 ms for the XML reader, so the bound leaves room for a slow,
// loaded runner while still failing on anything super-linear.
const TIME_BOUND_MS = 250;

function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const PAYLOADS = ["business-rule", "script-include", "acl", "sys-properties"].map((name) =>
  readFileSync(new URL(`../fixtures/update-set-eval/payloads/${name}.xml`, import.meta.url), "utf8")
);

const FRAGMENTS = [
  "<",
  ">",
  "/",
  "?",
  "!",
  "&",
  ";",
  "'",
  '"',
  "=",
  " ",
  "\n",
  "<a>",
  "</a>",
  "<a/>",
  "<![CDATA[",
  "]]>",
  "<!--",
  "-->",
  "<!DOCTYPE x>",
  "<!ENTITY e 'x'>",
  "<?pi x?>",
  '<?xml version="1.0"?>',
  "&amp;",
  "&e;",
  "&#0;",
  "&#x1F600;",
  "é",
  "﻿",
];

function mutate(text: string, next: () => number): string {
  let out = text;
  const edits = 1 + Math.floor(next() * 4);
  for (let k = 0; k < edits; k++) {
    const at = Math.floor(next() * (out.length + 1));
    const kind = next();
    if (kind < 0.4) {
      out = out.slice(0, at) + FRAGMENTS[Math.floor(next() * FRAGMENTS.length)] + out.slice(at);
    } else if (kind < 0.7) {
      out = out.slice(0, at) + out.slice(at + 1 + Math.floor(next() * 8));
    } else {
      const from = Math.floor(next() * out.length);
      out = out.slice(0, at) + out.slice(from, from + Math.floor(next() * 40)) + out.slice(at);
    }
  }
  return out;
}

describe("XML reader fuzz", () => {
  it("never throws, and returns a document or a known code with its fixed message", () => {
    const next = prng(0x0d1);
    const codes = new Set<string>(XML_READ_ERROR_CODES);
    const seen = new Map<string, number>();
    let worst = 0;
    for (let round = 0; round < 4_000; round++) {
      const text = mutate(PAYLOADS[round % PAYLOADS.length], next);
      let result: ReturnType<typeof readXml> | undefined;
      worst = Math.max(worst, elapsed(() => (result = readXml(text))));
      expect(result).toBeDefined();
      if (!result) continue;
      const key = result.ok ? "ok" : result.code;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (result.ok) {
        // Whatever it accepted, it writes back to something it accepts again.
        expect(readXml(serializeXml(result.document.root)).ok).toBe(true);
      } else {
        expect(codes.has(result.code)).toBe(true);
        expect(result.message).toBe(XML_READ_ERROR_MESSAGES[result.code]);
      }
    }
    expect(worst).toBeLessThan(TIME_BOUND_MS);
    // The mutations reach both outcomes and a spread of rejections.
    expect(seen.get("ok") ?? 0).toBeGreaterThan(100);
    expect(seen.size).toBeGreaterThan(8);
  });

  it("never throws on random tag soup", () => {
    const next = prng(0x50);
    for (let round = 0; round < 500; round++) {
      const parts: string[] = [];
      const count = 1 + Math.floor(next() * 200);
      for (let k = 0; k < count; k++) parts.push(FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]);
      const result = readXml(parts.join(""));
      if (!result.ok) expect(result.message).toBe(XML_READ_ERROR_MESSAGES[result.code]);
    }
  });
});

describe("secret scanner fuzz", () => {
  it("never throws, keeps spans in bounds and masks idempotently", () => {
    const next = prng(0x5ec);
    const alphabet = "pasword_key=:'\"`\\ \n(),.?&@/-+BeriAKISxojtyJ0123456789ghp";
    const ids = new Set<string>(SECRET_PATTERN_IDS);
    for (let round = 0; round < 300; round++) {
      const size = 1 + Math.floor(next() * 4_096);
      let text = "";
      for (let k = 0; k < size; k++) text += alphabet[Math.floor(next() * alphabet.length)];
      const scan = scanSecrets(text);
      expect(scan.status).toBe("ok");
      if (scan.status !== "ok") continue;
      for (const match of scan.matches) {
        expect(ids.has(match.id)).toBe(true);
        expect(match.start).toBeGreaterThanOrEqual(0);
        expect(match.end).toBeGreaterThan(match.start);
        expect(match.end).toBeLessThanOrEqual(text.length);
      }
      const once = maskSecrets(text);
      if (once.status !== "ok") throw new Error("mask refused fuzz text");
      const twice = maskSecrets(once.text);
      expect(twice.status === "ok" && twice.text).toBe(once.text);
    }
  });
});

describe("ReDoS: hostile inputs at the largest accepted size", () => {
  it.each(Object.entries(hostileSecretInputs(SECRET_SCAN_MAX_CHARS)))(
    "secret scan and mask: %s",
    (_name, text) => {
      expect(text.length).toBeLessThanOrEqual(SECRET_SCAN_MAX_CHARS);
      expect(elapsed(() => scanSecrets(text))).toBeLessThan(TIME_BOUND_MS);
      expect(elapsed(() => maskSecrets(text))).toBeLessThan(TIME_BOUND_MS);
    }
  );

  it.each(Object.entries(hostileXmlInputs(XML_READER_MAX_BYTES)))("XML reader: %s", (_name, text) => {
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(XML_READER_MAX_BYTES);
    let result: ReturnType<typeof readXml> | undefined;
    expect(elapsed(() => (result = readXml(text, { maxBytes: XML_READER_MAX_BYTES })))).toBeLessThan(TIME_BOUND_MS);
    expect(result).toBeDefined();
  });
});
