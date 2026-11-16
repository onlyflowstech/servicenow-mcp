// Positive and negative cases for every pattern in
// src/update-set-eval/secret-patterns.ts.
//
// Every secret-shaped value is fake, and the vendor-shaped ones are assembled
// at run time from parts, so that no complete token shape sits in the
// repository for a secret scanner to flag.

import type { SecretPatternId } from "../../../src/update-set-eval/secret-patterns.js";

const j = (...parts: string[]): string => parts.join("");
const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

export interface PositiveCase {
  /** The text to scan. */
  readonly text: string;
  /** The exact value the pattern must report, and masking must remove. */
  readonly secret: string;
}

export interface PatternCases {
  readonly positive: readonly PositiveCase[];
  /** Texts in which this pattern must not match. */
  readonly negative: readonly string[];
}

const p = (before: string, secret: string, after = ""): PositiveCase => ({ text: before + secret + after, secret });

const AWS_ID = j("AK", "IA", "IOSFODNN7EXAMPLE");
const AWS_SESSION_ID = j("AS", "IA", "Q3EXAMPLE7KEY123");
const GH_CLASSIC = j("gh", "p_", "aB3".repeat(12));
const GH_FINE = j("github", "_pat_", "11ABCDEFG0", "_", "abcdefghij0123456789");
const SLACK = j("xo", "xb-", "1234567890-", "abcdefABCDEF");
const SLACK_HOOK_PATH = j("T0000000", "/B0000000/", "X".repeat(24));
const GOOGLE = j("AI", "za", "SyA", "b".repeat(32));
const STRIPE = j("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc");
const JWT = j(
  "eyJ",
  "hbGciOiJIUzI1NiJ9",
  ".",
  "eyJ",
  "zdWIiOiIxMjM0NTY3ODkwIn0",
  ".",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
);
const PEM_BODY = "\nMIIEowIBAAKCAQEAfakefakefakefakefakefake\nfakefakefakefakefakefakefakefake==\n";
const pemBegin = (kind: string) => j("-----BEGIN ", kind, "PRIVATE", " KEY-----");
const pemEnd = (kind: string) => j("-----END ", kind, "PRIVATE", " KEY-----");

export const SECRET_CASES: Readonly<Record<SecretPatternId, PatternCases>> = {
  basic_auth_call: {
    positive: [
      p("r.setBasicAuth('admin', '", "Tr0ub4dor&3", "');"),
      p('request.setBasicAuth(user, "', "pa55word", '");'),
      p("rm.setBasicAuth(\n    'svc_integration',\n    '", "hunter2", "'\n);"),
      p("rm.setBasicAuth(this.user, `", "plain-template", "`);"),
    ],
    negative: [
      "r.setBasicAuth(user, pass);",
      "r.setBasicAuth('admin', gs.getProperty('x.integration.password'));",
      "r.setBasicAuth('admin', '');",
      "r.setBasicAuth(user, `${secretFromVault}`);",
      "r.setBasicAuth(getUser(), pass);",
    ],
  },
  authorization_basic: {
    positive: [
      p("Authorization: Basic ", b64("svc:S3cret!x")),
      p("headers.Authorization = 'Basic ", b64("admin:admin"), "';"),
    ],
    negative: [
      "// Basic settings for the incident form",
      "'Basic ' + GlideStringUtil.base64Encode(user + ':' + pass)",
      `Authorization: Basic ${b64("testtest")}`,
      "Basic configuration",
    ],
  },
  bearer_token: {
    positive: [
      p("Authorization: Bearer ", "8f2c1e9a7b6d5c4e3f2a1b0c9d8e7f6a"),
      p("authorization: bearer\t", "ya29.a0AfH6SMBx9k2-Ld8_q~w+e/r==", " trailing"),
    ],
    negative: [
      "'Bearer ' + token",
      "The bearer of the token decides.",
      "Bearer abcdefghijklmnopq",
      "Bearer 12345",
    ],
  },
  key_header: {
    positive: [
      p("rm.setRequestHeader('X-API-Key', '", "k3y-9f8e7d6c5b4a", "');"),
      p('rm.setRequestHeader("Ocp-Apim-Subscription-Key", "', "0123456789abcdef", '");'),
      p("rm.setRequestHeader('Authorization', '", "SSWS 00abcDEF123456789", "');"),
    ],
    negative: [
      "rm.setRequestHeader('Content-Type', 'application/json');",
      "rm.setRequestHeader('X-API-Key', apiKey);",
      "rm.setRequestHeader('Authorization', 'Bearer ' + token);",
      "rm.setRequestHeader('X-Auth-Token', 'short');",
    ],
  },
  credential_assignment: {
    positive: [
      p("var password = '", "Winter2026!", "';"),
      p('{"client_secret": "', "s3cr3t-value", '"}'),
      p("headers['x-api-key'] = \"", "abc123def456", '";'),
      p('this.userPassword="', "p@ss", '";'),
      p("if (pwd === '", "letmein", "') {"),
      p("var aws_secret_access_key = '", j("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYFAKEKEY"), "';"),
      // ServiceNow call shapes: the key is a call's first argument.
      p("gr.setValue('password', '", "Zq9-set-value-1", "');"),
      p('gr.setValue("user_password", "', "Zq9-set-value-2", '");'),
      p("gr.setValue('password',\n    '", "Zq9-set-value-3", "');"),
      p("gs.setProperty('x_acme.integration.password', '", "Zq9-property", "');"),
      p("r.setStringParameterNoEscape('client_secret', '", "Zq9-client-secret", "');"),
      p("r.setQueryParameter('api_key', '", "Zq9-query-key", "');"),
      p('params.put("apiKey", "', "Zq9-map-put", '");'),
      // Escaped JSON inside a string.
      p('r.setRequestBody("{\\"password\\":\\"', "Zq9-escaped-json", '\\"}");'),
      p("r.setRequestBody('{\\'client_secret\\': \\'", "Zq9-escaped-single", "\\'}');"),
    ],
    negative: [
      "var password = gs.getProperty('my.integration.password');",
      "var passwordField = 'u_password';",
      "var password = '';",
      "var check = password => 'x';",
      "if (password != 'x') {}",
      "var tokenType = 'Bearer';",
      "g_form.setValue('password', newValue);",
      "password: '****'",
      // The value is a variable, not a literal.
      "gr.setValue('password', newValue);",
      "gs.setProperty('x_acme.integration.password', current.u_value);",
      "r.setStringParameterNoEscape('client_secret', secret);",
      "r.setQueryParameter('api_key', this.key);",
      'params.put("apiKey", apiKey);',
      'r.setRequestBody("{\\"password\\":\\"" + pw + "\\"}");',
      "gr.setValue('password', '');",
      // A comma only separates a call's first argument from its value.
      "var fields = ['user_name', 'password', 'email'];",
      "var pair = ['password', 'shown'];",
    ],
  },
  url_credentials: {
    positive: [
      p("var url = 'https://svc_user:", "Pa55w0rd", "@example.com/api';"),
      p("jdbc:mysql://root:", "toor", "@db.internal:3306/cmdb"),
    ],
    negative: [
      "https://example.com/api",
      "https://user@example.com/",
      "mailto:someone@example.com",
      "https://example.com:8443/path@thing",
      "ssh://git@host.example:22/repo",
    ],
  },
  url_query_secret: {
    positive: [
      p("'https://api.example.com/v1/items?api_key=", "9f8e7d6c5b4a", "&limit=10'"),
      p("'https://graph.example.com/me?fields=id&access_token=", "EAAB1234xyz", "'"),
      p("https://acct.blob.core.windows.net/c?sv=2022-11-02&sig=", "abcd%2Bef%3D", " "),
      // key=value strings that start at their quote, and connection strings.
      p("r.setRequestBody('password=", "Zq9-form-first", "&username=svc');"),
      p('r.setRequestBody("client_secret=', "Zq9-form-secret", '&grant_type=client_credentials");'),
      p("var url = 'jdbc:sqlserver://db:1433;databaseName=x;user=sa;password=", "Zq9-jdbc", ";';"),
      p('var cs = "Driver={x};Server=db;UID=sa;PWD=', "Zq9-odbc", ';";'),
    ],
    negative: [
      "'https://api.example.com/v1?api_key=' + key",
      "'https://api.example.com/v1?limit=10&offset=0'",
      "`https://api.example.com/v1?key=${apiKey}`",
      "'https://api.example.com/v1?token=abc'",
      "r.setRequestBody('password=' + pw + '&username=svc');",
      'var cs = "Server=db;UID=sa;PWD=" + pwd + ";";',
      "var cs = 'Server=db;Trusted_Connection=yes;';",
    ],
  },
  private_key_block: {
    positive: [
      p(pemBegin("RSA "), PEM_BODY, pemEnd("RSA ")),
      p(pemBegin(""), PEM_BODY, pemEnd("")),
      p(pemBegin("OPENSSH "), PEM_BODY, pemEnd("OPENSSH ")),
      p(j("-----BEGIN PGP ", "PRIVATE", " KEY BLOCK-----"), PEM_BODY, j("-----END PGP ", "PRIVATE", " KEY BLOCK-----")),
      // No END line: everything after the header is masked.
      p(pemBegin("EC "), PEM_BODY),
    ],
    negative: [
      "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----",
      "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE\n-----END CERTIFICATE-----",
      j("// BEGIN ", "PRIVATE", " KEY handling is done by the MID server"),
    ],
  },
  aws_access_key_id: {
    positive: [p("var id = '", AWS_ID, "';"), p("key=", AWS_SESSION_ID, "\n")],
    negative: [
      AWS_ID.slice(0, -1),
      `${AWS_ID}Z`,
      `x${AWS_ID}`,
      `${AWS_ID.slice(0, -1)}a`,
    ],
  },
  github_token: {
    positive: [p("token: ", GH_CLASSIC), p("'", GH_FINE, "'")],
    negative: [j("gh", "p_short"), `x${GH_CLASSIC}`, j("gh", "p_", "aB3".repeat(11), "_ab")],
  },
  slack_token: {
    positive: [p("var t = '", SLACK, "';")],
    negative: [j("xo", "xb-short"), j("xo", "xz-1234567890abcdef"), `my${SLACK}`],
  },
  slack_webhook: {
    positive: [p(j("https://hooks.", "slack.com/services/"), SLACK_HOOK_PATH, "'")],
    negative: [
      j("https://hooks.", "slack.com/services/", "T0/B0"),
      j("https://hooks.example.com/services/", SLACK_HOOK_PATH),
    ],
  },
  google_api_key: {
    positive: [p("key: '", GOOGLE, "'")],
    negative: [GOOGLE.slice(0, -1), `x${GOOGLE}`, `${GOOGLE}x`],
  },
  stripe_secret_key: {
    positive: [p("stripe(", STRIPE, ")")],
    negative: [j("sk", "_test_", "4eC39HqLyjWDarjtT1zdp7dc"), j("sk", "_live_short"), `x${STRIPE}`],
  },
  jwt: {
    positive: [p("id_token=", JWT, "&state=1"), p('"', JWT, '"')],
    negative: [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJabc.eyJdef.ghi",
      `x${JWT}`,
      j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "abcdefghijkl", ".", "abcdefghijkl"),
    ],
  },
};
