import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  XML_READER_LIMITS,
  XML_READER_MAX_BYTES,
  XML_READ_ERROR_CODES,
  XML_READ_ERROR_MESSAGES,
  childElements,
  firstChildElement,
  getAttribute,
  readXml,
  serializeXml,
  textContent,
  walkElements,
  type XmlDocument,
  type XmlElement,
  type XmlReadErrorCode,
  type XmlReadResult,
} from "../../src/update-set-eval/xml-reader.js";
import { SECRET_MASK, maskSecrets } from "../../src/update-set-eval/secret-patterns.js";

const fixture = (path: string): string =>
  readFileSync(new URL(`../fixtures/update-set-eval/${path}`, import.meta.url), "utf8");

const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function ok(result: XmlReadResult): XmlDocument {
  if (!result.ok) throw new Error(`expected a document, got ${result.code}`);
  return result.document;
}

function code(text: string, options?: Parameters<typeof readXml>[1]): XmlReadErrorCode | "ok" {
  const result = readXml(text, options);
  return result.ok ? "ok" : result.code;
}

function nest(depth: number): string {
  return "<a>".repeat(depth) + "</a>".repeat(depth);
}

describe("readXml: update-set payloads", () => {
  it("reads a business rule with its declaration and a CDATA script", () => {
    const doc = ok(readXml(fixture("payloads/business-rule.xml")));
    expect(doc.declaration).toEqual({ version: "1.0", encoding: "UTF-8", standalone: null });
    expect(doc.root.name).toBe("record_update");
    expect(getAttribute(doc.root, "table")).toBe("sys_script");
    const [record] = childElements(doc.root);
    expect(record.name).toBe("sys_script");
    expect(getAttribute(record, "action")).toBe("INSERT_OR_UPDATE");
    const script = firstChildElement(record, "script");
    expect(script && textContent(script)).toContain("current.priority = 1;");
    expect(script?.children[0]).toMatchObject({ kind: "text", cdata: true });
    const condition = firstChildElement(record, "condition");
    expect(condition && textContent(condition)).toBe("");
    const pkg = firstChildElement(record, "sys_package");
    expect(pkg && getAttribute(pkg, "display_value")).toBe("Global");
  });

  it("decodes the predefined entities and character references in an escaped script", () => {
    const doc = ok(readXml(fixture("payloads/script-include.xml")));
    const [record] = childElements(doc.root, "sys_script_include");
    const script = textContent(firstChildElement(record, "script") as XmlElement);
    expect(script).toContain(`gr.getValue('priority') <= 2 && gr.getValue('state') != "7";`);
    expect(script).toContain("type: 'PriorityUtils'");
    const description = textContent(firstChildElement(record, "description") as XmlElement);
    expect(description).toBe("Helpers for <priority> checks — ✓ reviewed");
  });

  it("reads a payload with two records, a comment and standalone", () => {
    const doc = ok(readXml(fixture("payloads/acl.xml")));
    expect(doc.declaration?.standalone).toBe("no");
    expect(childElements(doc.root).map((e) => e.name)).toEqual(["sys_security_acl", "sys_security_acl_role"]);
    // Comments are skipped and kept out of the tree.
    expect(serializeXml(doc.root)).not.toContain("<!--");
  });

  it("accepts a byte-order mark before the declaration", () => {
    const text = fixture("payloads/sys-properties.xml");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const doc = ok(readXml(text));
    expect(doc.declaration?.version).toBe("1.0");
    expect(textContent(firstChildElement(childElements(doc.root)[0], "value") as XmlElement)).toBe("30");
  });

  it("reports counts and the UTF-8 size", () => {
    const doc = ok(readXml(`${DECLARATION}<r><a>é</a><b/></r>`));
    expect(doc.elementCount).toBe(3);
    expect(doc.maxDepth).toBe(2);
    expect(doc.bytes).toBe(Buffer.byteLength(`${DECLARATION}<r><a>é</a><b/></r>`, "utf8"));
  });
});

describe("readXml: the leading XML declaration", () => {
  it.each([
    ['<?xml version="1.0"?><r/>', { version: "1.0", encoding: null, standalone: null }],
    ["<?xml version='1.1' encoding='utf-8' standalone='yes' ?><r/>", { version: "1.1", encoding: "utf-8", standalone: "yes" }],
    ['<?xml\n  version = "1.0"\n  encoding = "ISO-8859-1"?>\n<r/>', { version: "1.0", encoding: "ISO-8859-1", standalone: null }],
  ])("accepts %j at offset 0", (text, declaration) => {
    expect(ok(readXml(text)).declaration).toEqual(declaration);
  });

  it("accepts a payload with no declaration", () => {
    expect(ok(readXml("<r/>")).declaration).toBeNull();
  });

  it.each([
    ["an unknown pseudo-attribute", '<?xml version="1.0" foo="bar"?><r/>', "invalid_declaration"],
    ["encoding before version", '<?xml encoding="UTF-8" version="1.0"?><r/>', "invalid_declaration"],
    ["standalone before encoding", '<?xml version="1.0" standalone="yes" encoding="UTF-8"?><r/>', "invalid_declaration"],
    ["no version", '<?xml encoding="UTF-8"?><r/>', "invalid_declaration"],
    ["mismatched quotes", "<?xml version=\"1.0'?><r/>", "invalid_declaration"],
    ["a bad standalone value", '<?xml version="1.0" standalone="maybe"?><r/>', "invalid_declaration"],
    ["an unclosed declaration", '<?xml version="1.0" <r/>', "invalid_declaration"],
    ["leading whitespace", ' <?xml version="1.0"?><r/>', "processing_instruction"],
    ["a declaration after a comment", '<!-- x --><?xml version="1.0"?><r/>', "processing_instruction"],
    ["a target that only starts with xml", "<?xmlfoo bar?><r/>", "processing_instruction"],
    ["a bare <?xml?>", "<?xml?><r/>", "processing_instruction"],
    ["a second declaration inside the root", fixture("hostile/second-declaration.xml"), "processing_instruction"],
    ["a mid-document processing instruction", fixture("hostile/mid-document-pi.xml"), "processing_instruction"],
    ["a stylesheet instruction after the declaration", fixture("hostile/stylesheet-pi.xml"), "processing_instruction"],
    ["a processing instruction after the root", '<r/><?pi x?>', "processing_instruction"],
  ])("rejects %s", (_label, text, expected) => {
    expect(code(text)).toBe(expected);
  });
});

describe("readXml: no DTD, no entities, no external references", () => {
  it.each([
    ["billion laughs", "hostile/billion-laughs.xml", "doctype"],
    ["an external entity", "hostile/xxe-system.xml", "doctype"],
    ["a parameter entity", "hostile/xxe-parameter.xml", "doctype"],
    ["a lower-case external DOCTYPE", "hostile/doctype-external.xml", "doctype"],
    ["an ENTITY declaration without a DOCTYPE", "hostile/entity-in-content.xml", "entity_declaration"],
    ["an undeclared entity reference", "hostile/undeclared-entity.xml", "invalid_entity_reference"],
    ["an ELEMENT declaration", "hostile/element-declaration.xml", "markup_declaration"],
    ["an XInclude binding", "hostile/xinclude.xml", "external_reference"],
  ])("rejects %s", (_label, path, expected) => {
    expect(code(fixture(path))).toBe(expected);
  });

  it("rejects the XInclude namespace as a default namespace, and the 2003 namespace", () => {
    expect(code('<r xmlns="http://www.w3.org/2001/XInclude"/>')).toBe("external_reference");
    expect(code('<r xmlns:xi="http://www.w3.org/2003/XInclude"/>')).toBe("external_reference");
  });

  it("decodes only the five predefined entities and valid character references", () => {
    const doc = ok(readXml("<r a='&lt;&gt;&amp;&quot;&apos;'>&#65;&#x42;&#x1F600;&#9;</r>"));
    expect(getAttribute(doc.root, "a")).toBe(`<>&"'`);
    expect(textContent(doc.root)).toBe("AB\u{1F600}\t");
  });

  it.each([
    ["&nbsp;", "invalid_entity_reference"],
    ["&lt", "invalid_entity_reference"],
    ["& x", "invalid_entity_reference"],
    ["&;", "invalid_entity_reference"],
    ["&constructor;", "invalid_entity_reference"],
    ["&__proto__;", "invalid_entity_reference"],
    ["&#0;", "invalid_character_reference"],
    ["&#x1;", "invalid_character_reference"],
    ["&#xD800;", "invalid_character_reference"],
    ["&#xFFFE;", "invalid_character_reference"],
    ["&#x110000;", "invalid_character_reference"],
    ["&#;", "invalid_character_reference"],
    ["&#x;", "invalid_character_reference"],
    ["&#X41;", "invalid_character_reference"],
    ["&#12345678;", "invalid_character_reference"],
    ["&#-1;", "invalid_character_reference"],
  ])("rejects %j", (reference, expected) => {
    expect(code(`<r>${reference}</r>`)).toBe(expected);
    expect(code(`<r a="${reference}"/>`)).toBe(expected);
  });

  it("keeps CDATA content raw", () => {
    expect(textContent(ok(readXml("<r><![CDATA[&xxe; <b> &#0;]]></r>")).root)).toBe("&xxe; <b> &#0;");
  });

  it("normalizes whitespace in attribute values, but not character references", () => {
    expect(getAttribute(ok(readXml('<r a="x\ty\nz&#10;"/>')).root, "a")).toBe("x y z\n");
  });
});

describe("readXml: structure", () => {
  it.each([
    ["", "no_root"],
    ["   \n", "no_root"],
    [DECLARATION, "no_root"],
    ["<!-- only a comment -->", "no_root"],
    ["text<r/>", "content_outside_root"],
    ["<r/>text", "content_outside_root"],
    ["<![CDATA[x]]><r/>", "content_outside_root"],
    ["<r/><s/>", "multiple_roots"],
    ["<r><a></b></r>", "mismatched_tag"],
    ["<r></r></r>", "mismatched_tag"],
    ["<r><a>", "unclosed_element"],
    ["<r><!-- x </r>", "unclosed_comment"],
    ["<r><![CDATA[ x </r>", "unclosed_cdata"],
    ["<r a='1' a='2'/>", "duplicate_attribute"],
    ["<r a='<'/>", "invalid_attribute"],
    ["<r a=1/>", "invalid_attribute"],
    ["<r a/>", "invalid_attribute"],
    ["<r a='1/>", "invalid_attribute"],
    ["<r a='1'b='2'/>", "malformed_tag"],
    ["<r", "malformed_tag"],
    ["<r/ >", "malformed_tag"],
    ["< r/>", "malformed_tag"],
    ["<r></ r>", "malformed_tag"],
    ["<r></r x>", "malformed_tag"],
    ["<1r/>", "invalid_name"],
    ["<ré/>", "invalid_name"],
    ["<r><$/></r>", "invalid_name"],
    [`<${"n".repeat(XML_READER_LIMITS.maxNameLength + 1)}/>`, "name_too_long"],
    ["<r>&</r>", "invalid_entity_reference"],
  ])("%j gives %s", (text, expected) => {
    expect(code(text)).toBe(expected);
  });

  it("accepts a name at the length cap, and the full name grammar", () => {
    expect(code(`<${"n".repeat(XML_READER_LIMITS.maxNameLength)}/>`)).toBe("ok");
    expect(code("<a:b_c-d.e1 x:y='1'/>")).toBe("ok");
  });
});

describe("readXml: caps", () => {
  it("accepts depth 64 and rejects 65", () => {
    expect(code(nest(64))).toBe("ok");
    expect(code(nest(65))).toBe("depth_limit");
    expect(code(`<r>${"<a/>".repeat(5)}${nest(63)}</r>`)).toBe("ok");
    expect(code(nest(10), { maxDepth: 9 })).toBe("depth_limit");
  });

  it("rejects 100,000 open tags without recursing", () => {
    expect(code("<a>".repeat(100_000), { maxBytes: XML_READER_MAX_BYTES })).toBe("depth_limit");
  });

  it("accepts 20,000 elements and rejects 20,001", () => {
    expect(code(`<r>${"<a/>".repeat(19_999)}</r>`)).toBe("ok");
    expect(code(`<r>${"<a/>".repeat(20_000)}</r>`)).toBe("element_limit");
    expect(code(`<r>${"<a/>".repeat(10)}</r>`, { maxElements: 10 })).toBe("element_limit");
  });

  it("accepts 64 attributes and rejects 65", () => {
    const attrs = (n: number) => Array.from({ length: n }, (_, k) => `a${k}="1"`).join(" ");
    expect(code(`<r ${attrs(64)}/>`)).toBe("ok");
    expect(code(`<r ${attrs(65)}/>`)).toBe("attribute_limit");
    expect(code(`<r ${attrs(3)}/>`, { maxAttributesPerElement: 2 })).toBe("attribute_limit");
  });

  it("caps total size in UTF-8 bytes", () => {
    const pad = (bytes: number) => `<r>${"x".repeat(bytes - 7)}</r>`;
    expect(code(pad(XML_READER_LIMITS.maxBytes))).toBe("ok");
    expect(code(pad(XML_READER_LIMITS.maxBytes + 1))).toBe("too_large");
    // 3 bytes per character: fewer code units than the cap, more bytes.
    const wide = `<r>${"€".repeat(Math.ceil(XML_READER_LIMITS.maxBytes / 3))}</r>`;
    expect(wide.length).toBeLessThan(XML_READER_LIMITS.maxBytes);
    expect(code(wide)).toBe("too_large");
    expect(code(pad(XML_READER_LIMITS.maxBytes + 1), { maxBytes: XML_READER_MAX_BYTES })).toBe("ok");
    expect(code(pad(100), { maxBytes: 99 })).toBe("too_large");
  });

  it("refuses option values outside the caps, with a fixed message", () => {
    expect(() => readXml("<r/>", { maxDepth: 65 })).toThrow(RangeError);
    expect(() => readXml("<r/>", { maxElements: 0 })).toThrow(RangeError);
    expect(() => readXml("<r/>", { maxBytes: XML_READER_MAX_BYTES + 1 })).toThrow(RangeError);
    expect(() => readXml("<r/>", { maxAttributesPerElement: 1.5 })).toThrow(RangeError);
  });

  it("returns not_text for a value that is not a string", () => {
    expect(code(42 as unknown as string)).toBe("not_text");
    expect(code(null as unknown as string)).toBe("not_text");
  });
});

describe("readXml: no payload text in any failure", () => {
  const CANARY = "CANARY_7f3a9c";
  const failing: Array<[XmlReadErrorCode, string]> = [
    ["too_large", `<r>${CANARY.repeat(30_000)}</r>`],
    ["no_root", `<!-- ${CANARY} -->`],
    ["invalid_declaration", `<?xml version="1.0" ${CANARY}="1"?><r/>`],
    ["processing_instruction", `<r><?${CANARY} x?></r>`],
    ["doctype", `<!DOCTYPE ${CANARY}><r/>`],
    ["entity_declaration", `<r><!ENTITY ${CANARY} "x"></r>`],
    ["markup_declaration", `<!${CANARY}><r/>`],
    ["external_reference", `<r xmlns:${CANARY}="http://www.w3.org/2001/XInclude"/>`],
    ["invalid_entity_reference", `<r>&${CANARY};</r>`],
    ["invalid_character_reference", `<r>${CANARY}&#0;</r>`],
    ["malformed_tag", `<${CANARY}`],
    ["invalid_name", `<r><${CANARY}é/></r>`],
    ["name_too_long", `<${CANARY.repeat(30)}/>`],
    ["invalid_attribute", `<r ${CANARY}/>`],
    ["duplicate_attribute", `<r ${CANARY}="1" ${CANARY}="2"/>`],
    ["mismatched_tag", `<r></${CANARY}>`],
    ["unclosed_element", `<${CANARY}>`],
    ["unclosed_comment", `<r><!-- ${CANARY}`],
    ["unclosed_cdata", `<r><![CDATA[${CANARY}`],
    ["content_outside_root", `${CANARY}<r/>`],
    ["multiple_roots", `<r/><${CANARY}/>`],
    ["depth_limit", `<${CANARY}>`.repeat(65)],
    ["element_limit", `<r>${CANARY}${"<a/>".repeat(20_000)}</r>`],
    ["attribute_limit", `<r ${Array.from({ length: 65 }, (_, k) => `${CANARY}${k}="${CANARY}"`).join(" ")}/>`],
  ];

  it("covers every error code except not_text", () => {
    expect(new Set(failing.map(([c]) => c))).toEqual(new Set(XML_READ_ERROR_CODES.filter((c) => c !== "not_text")));
  });

  it.each(failing)("%s carries only its code and fixed message", (expected, text) => {
    const result = readXml(text);
    expect(result).toEqual({ ok: false, code: expected, message: XML_READ_ERROR_MESSAGES[expected] });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("has a fixed message for every code, none of them a template", () => {
    for (const c of XML_READ_ERROR_CODES) {
      expect(XML_READ_ERROR_MESSAGES[c]).toMatch(/^The payload(?:'s)? [^${}<>]+\.$/u);
    }
  });
});

describe("readXml: one text node per run of text", () => {
  it("joins text and CDATA that a comment or a CDATA boundary splits", () => {
    const comment = ok(readXml("<script>var password = '<!-- -->x9-value';</script>"));
    expect(comment.root.children).toEqual([{ kind: "text", value: "var password = 'x9-value';", cdata: false }]);
    const cdata = ok(readXml("<script><![CDATA[var password = 'ab]]]]><![CDATA[>x9-value';]]></script>"));
    expect(cdata.root.children).toEqual([{ kind: "text", value: "var password = 'ab]]>x9-value';", cdata: true }]);
    const mixed = ok(readXml("<script>var password = <![CDATA['x9-]]>&#x76;alue';</script>"));
    expect(mixed.root.children).toEqual([{ kind: "text", value: "var password = 'x9-value';", cdata: true }]);
  });

  it("masks a split value as one, through the text hook", () => {
    const mask = (value: string) => {
      const result = maskSecrets(value);
      return result.status === "ok" ? result.text : "";
    };
    for (const xml of [
      "<script>var password = '<!-- -->x9-value';</script>",
      "<script><![CDATA[var password = 'ab]]]]><![CDATA[>x9-value';]]></script>",
    ]) {
      const out = serializeXml(ok(readXml(xml)).root, { text: mask });
      expect(out).not.toContain("x9-value");
      expect(out).toContain(SECRET_MASK);
    }
  });

  it("keeps text on either side of a child element apart", () => {
    const doc = ok(readXml("<r>a<!-- -->b<c/>d<![CDATA[e]]></r>"));
    expect(doc.root.children.map((n) => (n.kind === "text" ? n.value : `<${n.name}>`))).toEqual(["ab", "<c>", "de"]);
  });

  it("bounds the text-node count by the element count", () => {
    const doc = ok(readXml(`<r>${"x<!---->".repeat(10_000)}</r>`));
    expect(doc.root.children).toHaveLength(1);
    expect(textContent(doc.root)).toBe("x".repeat(10_000));
  });
});

describe("tree helpers", () => {
  const doc = ok(readXml("<r><a k='1'>x<![CDATA[y]]><b>no</b>z</a><a/><c/></r>"));

  it("selects children and own text", () => {
    expect(childElements(doc.root).map((e) => e.name)).toEqual(["a", "a", "c"]);
    expect(childElements(doc.root, "a")).toHaveLength(2);
    const a = firstChildElement(doc.root, "a") as XmlElement;
    expect(textContent(a)).toBe("xyz");
    expect(getAttribute(a, "k")).toBe("1");
    expect(getAttribute(a, "missing")).toBeUndefined();
    expect(firstChildElement(doc.root, "missing")).toBeUndefined();
  });

  it("walks in document order with ancestors, and can skip a subtree", () => {
    const seen: string[] = [];
    walkElements(doc.root, (element, ancestors) => {
      seen.push([...ancestors.map((e) => e.name), element.name].join("/"));
    });
    expect(seen).toEqual(["r", "r/a", "r/a/b", "r/a", "r/c"]);
    const skipped: string[] = [];
    walkElements(doc.root, (element) => {
      skipped.push(element.name);
      return element.name === "a" ? "skip" : undefined;
    });
    expect(skipped).toEqual(["r", "a", "a", "c"]);
  });

  it("walks a tree at the depth cap", () => {
    let deepest = 0;
    walkElements(ok(readXml(nest(64))).root, (_e, ancestors) => {
      deepest = Math.max(deepest, ancestors.length + 1);
    });
    expect(deepest).toBe(64);
  });
});

describe("serializeXml", () => {
  it("round-trips every fixture payload to an equal tree", () => {
    for (const path of ["business-rule", "script-include", "acl", "sys-properties"]) {
      const first = ok(readXml(fixture(`payloads/${path}.xml`)));
      const written = serializeXml(first.root, { declaration: true });
      expect(written.startsWith(DECLARATION), path).toBe(true);
      const second = ok(readXml(written));
      const strip = (e: XmlElement): unknown => ({
        name: e.name,
        attributes: [...e.attributes],
        text: textContent(e),
        children: childElements(e).map(strip),
      });
      expect(strip(second.root), path).toEqual(strip(first.root));
    }
  });

  it("escapes text and attributes, and writes CDATA as escaped text", () => {
    const doc = ok(readXml(`<r a="&quot;&lt;&#9;&#10;&#13;"><![CDATA[a]]>b<c/>&lt;&amp;&#13;</r>`));
    expect(serializeXml(doc.root)).toBe(`<r a="&quot;&lt;&#9;&#10;&#13;">ab<c/>&lt;&amp;&#13;</r>`);
    const tricky = ok(readXml("<r><![CDATA[x]]>]]&gt;</r>"));
    expect(serializeXml(tricky.root)).toBe("<r>x]]&gt;</r>");
  });

  it("passes each text and attribute through the hooks with parent and ancestors", () => {
    const doc = ok(readXml("<record_update table='t'><t><name>n</name><password>p</password></t></record_update>"));
    const calls: string[] = [];
    const out = serializeXml(doc.root, {
      text: (value, parent, ancestors) => {
        calls.push(`${ancestors.map((e) => e.name).join("/")}:${value}`);
        expect(ancestors[ancestors.length - 1]).toBe(parent);
        return parent.name === "password" ? "[hidden]" : value;
      },
      attribute: (name, value, element, ancestors) => {
        expect(ancestors[ancestors.length - 1]).toBe(element);
        return name === "table" ? `${value}<&` : value;
      },
    });
    expect(calls).toEqual(["record_update/t/name:n", "record_update/t/password:p"]);
    expect(out).toBe(
      '<record_update table="t&lt;&amp;"><t><name>n</name><password>[hidden]</password></t></record_update>'
    );
  });

  it("writes a tree at the depth cap without recursing", () => {
    expect(serializeXml(ok(readXml(nest(64))).root)).toBe("<a>".repeat(63) + "<a/>" + "</a>".repeat(63));
  });
});
