// Adversarial inputs for the time-bound tests: each one aims at a pattern's
// anchor or reader, or at the XML reader's scanning, at the largest size the
// code accepts.

/** Deterministic PRNG (mulberry32), so fuzz runs repeat exactly. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fill(unit: string, size: number): string {
  return unit.repeat(Math.max(1, Math.floor(size / unit.length)));
}

function lead(prefix: string, unit: string, size: number): string {
  return prefix + fill(unit, size - prefix.length);
}

function randomText(size: number, alphabet: string, seed: number): string {
  const next = prng(seed);
  const out: string[] = [];
  for (let k = 0; k < size; k++) out.push(alphabet[Math.floor(next() * alphabet.length)]);
  return out.join("");
}

/** Hostile texts for the secret scanner, `size` characters each (or just under). */
export function hostileSecretInputs(size: number): Record<string, string> {
  return {
    "repeated setBasicAuth(": fill("setBasicAuth(", size),
    "setBasicAuth with a long first argument": lead("setBasicAuth(", "a", size),
    "repeated setBasicAuth('',": fill("setBasicAuth('',", size),
    "repeated Basic": fill("Basic ", size),
    "Basic and a long base64 run": lead("Basic ", "A", size),
    "repeated Basic a/": fill("Basic a/", size),
    "repeated Bearer": fill("Bearer ", size),
    "Bearer and a long token run": lead("Bearer ", "a.", size),
    "repeated setRequestHeader": fill("setRequestHeader('x-api-key', ", size),
    "repeated password =": fill("password = ", size),
    "repeated password = '": fill("password = '", size),
    "password and an unterminated literal": lead("password = '", "a", size),
    "password and an interpolated backtick literal": lead("password = `${", "a", size),
    "password and escapes": lead("password = '", "\\", size),
    "repeated keyword": fill("passwordpassword", size),
    "repeated keyword and quote": fill("api_key'", size),
    "repeated ://": fill("a://", size),
    "long userinfo": lead("a://", "b:", size),
    "repeated ?key=": fill("?key=", size),
    "long query value": lead("?api_key=", "v", size),
    "repeated BEGIN header": fill("-----BEGIN RSA PRIVATE KEY-----", size),
    "near-miss BEGIN header": fill("-----BEGIN A B C D E F PRIVATE KEY", size),
    "repeated AKIA": fill("AKIA", size),
    "repeated ghp_": fill("ghp_", size),
    "github_pat and a long run": lead("github_pat_", "a", size),
    "repeated xoxb-": fill("xoxb-", size),
    "repeated webhook prefix": fill("hooks.slack.com/services/", size),
    "repeated AIza": fill("AIza", size),
    "repeated sk_live_": fill("sk_live_", size),
    "repeated eyJ": fill("eyJ", size),
    "eyJ segments": fill("eyJaaaaaaaa.", size),
    "spaces": " ".repeat(size),
    "quotes": fill("'\"`", size),
    "random code characters": randomText(size, "pasword_key=:'\"`\\ \n(),.?&@/-BeriAKISxojtyJ", 0x5eed),
  };
}

/** Hostile texts for the XML reader, each at most `size` characters. */
export function hostileXmlInputs(size: number): Record<string, string> {
  const inner = (unit: string) => fill(unit, size - 20);
  const attributes = Array.from({ length: 64 }, (_, k) => `a${k}="v&amp;${k}"`).join(" ");
  return {
    "deep nesting": fill("<a>", size),
    "many elements": `<r>${inner("<a/>")}</r>`,
    "many elements with 64 attributes each": `<r>${inner(`<e ${attributes}/>`)}</r>`,
    "unclosed attribute quote": `<r a="${inner("x")}`,
    "many entity references": `<r>${inner("&amp;")}</r>`,
    "ampersands with no semicolon": `<r>${inner("&")}</r>`,
    "a far semicolon": `<r>&${inner("a")};</r>`,
    "many CDATA starts": `<r>${inner("<![CDATA[")}</r>`,
    "many comment starts": `<r>${inner("<!--")}</r>`,
    "one long comment": `<r><!--${inner("-")}`,
    "many less-than signs": `<r>${inner("<")}</r>`,
    "long name": `<${inner("a")}/>`,
    "many text nodes": `<r>${inner("x<b/>")}</r>`,
    "long attribute value": `<r a="${inner("&lt;")}"/>`,
    "random markup inside a root": `<r>${randomText(size - 20, "<>/?!-[]&;#x=\"' aAzZ:_.\n", 0xbeef)}</r>`,
  };
}
