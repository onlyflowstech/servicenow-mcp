import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyProvider, OAuthProvider } from "../src/auth.js";
import { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { sniffPrefix, HTML_SNIFF_BYTES } from "../src/html-response.js";
import {
  createInstanceHibernatingError,
  formatToolError,
  safeToolErrorDescriptor,
  trustedToolErrorDescriptor,
} from "../src/tool-error.js";

const INSTANCE = "https://dev12345.service-now.com";
const HOST = "dev12345.service-now.com";
const LEAK = "SECRET-BODY-TEXT-7731";

const HIBERNATING_PAGE =
  `<!DOCTYPE html><html><head><title>Instance Hibernating</title></head>` +
  `<body><h1>Your instance is hibernating</h1><p>${LEAK}</p>` +
  `<a href="https://evil.example/wake">Wake</a></body></html>`;
const SSO_PAGE = `<html><head><title>Sign in</title></head><body>${LEAK}</body></html>`;

const HIBERNATING_MESSAGE =
  `The ServiceNow instance ${HOST} appears to be hibernating. Developer instances ` +
  "sleep when idle: wake it at https://developer.servicenow.com, wait a few " +
  "minutes, then retry.";
const HTML_MESSAGE =
  "The instance returned an HTML page instead of an API response. It may be " +
  "asleep, behind single sign-on, or under maintenance. Check that the " +
  "instance URL is reachable in a browser.";

const CONFIG: ServiceNowConfig = {
  instance: INSTANCE,
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

function html(body: string, contentType = "text/html; charset=utf-8", status = 200) {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

async function caught(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected rejection");
}

function client(): ServiceNowClient {
  return new ServiceNowClient(CONFIG, { baseRetryDelayMs: 1, sleep: async () => {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hibernating instance detection", () => {
  it("maps a hibernation page on a GET to the fixed hibernating error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(HIBERNATING_PAGE)));
    const error = await caught(client().get("/api/now/table/incident"));
    const descriptor = trustedToolErrorDescriptor(error)!;
    expect(descriptor.reason).toBe("instance_hibernating");
    expect(descriptor.category).toBe("upstream");
    expect(descriptor.retry).toBe("retry_later");
    expect(descriptor.message).toBe(HIBERNATING_MESSAGE);
    expect(error.message).toContain("Retry later.");
  });

  it.each(["post", "patch", "put"] as const)("maps a hibernation page on a %s", async (verb) => {
    const fetchMock = vi.fn(async () => html(HIBERNATING_PAGE));
    vi.stubGlobal("fetch", fetchMock);
    const error = await caught(client()[verb]("/api/now/table/incident", { a: "b" }));
    expect(trustedToolErrorDescriptor(error)?.reason).toBe("instance_hibernating");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("detects the page by a leading '<' when the content type lies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(HIBERNATING_PAGE, "application/json")));
    const error = await caught(client().get("/api/now/table/incident"));
    expect(trustedToolErrorDescriptor(error)?.reason).toBe("instance_hibernating");
  });

  it("maps the OAuth token fetch for every grant", async () => {
    for (const grantType of ["client_credentials", "password"] as const) {
      const fetchMock = vi.fn(async () => html(HIBERNATING_PAGE));
      vi.stubGlobal("fetch", fetchMock);
      const provider = new OAuthProvider({
        instance: INSTANCE,
        clientId: "id",
        clientSecret: "secret",
        grantType,
        ...(grantType === "password" ? { username: "u", password: "p" } : {}),
      });
      const error = await caught(provider.getAuthHeaders());
      expect(trustedToolErrorDescriptor(error)?.message).toBe(HIBERNATING_MESSAGE);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("uses the configured host, never a host found in the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => html(
          `<html><head><title> Instance Hibernating page </title></head>` +
            `<body>dev99999.service-now.com</body></html>`
        ))
    );
    const error = await caught(client().get("/api/now/table/incident"));
    expect(error.message).toContain(HOST);
    expect(error.message).not.toContain("dev99999");
  });

  it("drops a host that is not a plain host[:port]", () => {
    const error = createInstanceHibernatingError("evil.example/<script>");
    expect(error.message).not.toContain("evil.example");
    expect(error.message).toContain("The ServiceNow instance appears to be hibernating.");
  });

  it("only inspects a bounded prefix", async () => {
    const late = `<html><body>${"x".repeat(HTML_SNIFF_BYTES)} hibernating</body></html>`;
    expect(sniffPrefix(late).length).toBe(HTML_SNIFF_BYTES);
    vi.stubGlobal("fetch", vi.fn(async () => html(late)));
    const error = await caught(client().get("/api/now/table/incident"));
    expect(trustedToolErrorDescriptor(error)?.reason).toBe("html_response");
  });
});

describe("generic HTML responses", () => {
  it("maps an HTML page without markers to the fixed generic message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(SSO_PAGE)));
    const error = await caught(client().get("/api/now/table/incident"));
    const descriptor = trustedToolErrorDescriptor(error)!;
    expect(descriptor.reason).toBe("html_response");
    expect(descriptor.message).toBe(HTML_MESSAGE);
    expect(descriptor.retry).toBe("retry_after_correction");
  });

  it("maps the token fetch too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(SSO_PAGE)));
    const provider = new OAuthProvider({ instance: INSTANCE, clientId: "i", clientSecret: "s" });
    const error = await caught(provider.getAuthHeaders());
    expect(trustedToolErrorDescriptor(error)?.message).toBe(HTML_MESSAGE);
  });

  it("never leaks body text into the error, its message, or its serialization", async () => {
    for (const page of [HIBERNATING_PAGE, SSO_PAGE]) {
      vi.stubGlobal("fetch", vi.fn(async () => html(page)));
      const error = await caught(client().get("/api/now/table/incident"));
      const rendered = [
        error.message,
        formatToolError(error),
        JSON.stringify(trustedToolErrorDescriptor(error)),
        String(error.stack ?? "").split("\n")[0],
      ].join("\n");
      expect(rendered).not.toContain(LEAK);
      expect(rendered).not.toContain("evil.example");
    }
  });

  it("does not misread a JSON body or a real JSON 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"result":[]}', { headers: { "Content-Type": "application/json" } })
      )
    );
    expect(await client().get("/api/now/table/incident")).toEqual({ result: [] });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"error":{"message":"boom"}}', {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    const error = await caught(client().post("/api/now/table/incident", {}));
    const descriptor = trustedToolErrorDescriptor(error)!;
    expect(descriptor.reason).toBeUndefined();
    expect(descriptor.category).toBe("upstream");
    expect(descriptor.retry).toBe("do_not_retry");
  });
});

describe("no retry storm", () => {
  it("sends a GET exactly once when the instance is hibernating", async () => {
    const fetchMock = vi.fn(async () => html(HIBERNATING_PAGE));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn(async () => {});
    const c = new ServiceNowClient(CONFIG, { baseRetryDelayMs: 1, sleep, maxRetries: 5 });
    await caught(c.get("/api/now/table/incident"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("requests a token exactly once", async () => {
    const fetchMock = vi.fn(async () => html(HIBERNATING_PAGE));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OAuthProvider({ instance: INSTANCE, clientId: "i", clientSecret: "s" });
    await caught(provider.getAuthHeaders());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("tightened detection", () => {
  it("does not call an SSO page that mentions hibernation a hibernating instance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => html("<html><title>Sign in</title><body>hibernating soon</body></html>"))
    );
    const error = await caught(client().get("/api/now/table/incident"));
    expect(trustedToolErrorDescriptor(error)?.reason).toBe("html_response");
  });

  it("requires the title near the top of the page", async () => {
    const late = `<html><head>${" ".repeat(3000)}<title>Instance Hibernating page</title></head></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => html(late)));
    const error = await caught(client().get("/api/now/table/incident"));
    expect(trustedToolErrorDescriptor(error)?.reason).toBe("html_response");
  });

  it("matches the observed title with its surrounding whitespace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => html("<html><head>\n<title> Instance Hibernating page </title>"))
    );
    const error = await caught(client().get("/api/now/table/incident"));
    expect(trustedToolErrorDescriptor(error)?.reason).toBe("instance_hibernating");
  });

  it("parses JSON served as text/html without treating it as a page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => html('{"result":[{"short_description":"hibernation"}]}'))
    );
    expect(await client().get("/api/now/table/incident")).toEqual({
      result: [{ short_description: "hibernation" }],
    });
  });
});

describe("invalid non-HTML bodies", () => {
  it.each([
    ["text/plain", "\u001b[8m\u001b[2J LEAKED-TEXT"],
    ["application/json", "not json LEAKED-TEXT"],
    ["application/xml", "<?xml version='1.0'?><html>hibernating LEAKED-TEXT</html>"],
  ])("maps a %s body to a fixed error with no body text", async (type, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => html(body, type)));
    const error = await caught(client().get("/api/now/table/incident"));
    const descriptor = trustedToolErrorDescriptor(error)!;
    expect(descriptor.reason).toBe("invalid_response");
    const rendered = `${error.message}\n${formatToolError(error)}`;
    expect(rendered).not.toContain("LEAKED-TEXT");
    expect(rendered).not.toContain("\u001b");
  });
});

describe("redirects are never followed", () => {
  const REDIRECT_MESSAGE =
    "The instance redirected the request to another location. Check that the " +
    "profile's instance URL is the instance's canonical URL.";

  function redirect(status: number): Response {
    return new Response(null, {
      status,
      headers: { Location: "https://attacker.example/steal" },
    });
  }

  it.each([302, 307])("refuses a %i on an API call and sends one request", async (status) => {
    const fetchMock = vi.fn(async () => redirect(status));
    vi.stubGlobal("fetch", fetchMock);
    const error = await caught(client().post("/api/now/table/incident", { a: 1 }));
    expect(trustedToolErrorDescriptor(error)?.message).toBe(REDIRECT_MESSAGE);
    expect(error.message).not.toContain("attacker");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("manual");
  });

  it.each([302, 307])("refuses a %i on the token fetch without leaking the secret", async (status) => {
    const fetchMock = vi.fn(async () => redirect(status));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OAuthProvider({
      instance: INSTANCE,
      clientId: "id",
      clientSecret: "SECRET-VALUE",
    });
    const error = await caught(provider.getAuthHeaders());
    expect(trustedToolErrorDescriptor(error)?.message).toBe(REDIRECT_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("manual");
    expect(error.message).not.toContain("SECRET-VALUE");
  });

  it("makes one request with the API key when the instance redirects", async () => {
    const fetchMock = vi.fn(async () => redirect(302));
    vi.stubGlobal("fetch", fetchMock);
    const c = new ServiceNowClient(CONFIG, {
      auth: new ApiKeyProvider("API-KEY-VALUE"),
      sleep: async () => {},
    });
    await caught(c.get("/api/now/table/incident"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("write and boundary coverage", () => {
  it.each(["patch", "put"] as const)(
    "sends a journal %s exactly once with no sleep on a hibernation page",
    async (verb) => {
      const fetchMock = vi.fn(async () => html(HIBERNATING_PAGE));
      vi.stubGlobal("fetch", fetchMock);
      const sleep = vi.fn(async () => {});
      const c = new ServiceNowClient(CONFIG, { baseRetryDelayMs: 1, sleep, maxRetries: 5 });
      const error = await caught(c[verb]("/api/now/table/incident/abc", { work_notes: "note" }));
      expect(trustedToolErrorDescriptor(error)?.reason).toBe("instance_hibernating");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  );

  it("maps a hibernation page on a binary upload", async () => {
    const fetchMock = vi.fn(async () => html(HIBERNATING_PAGE));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn(async () => {});
    const c = new ServiceNowClient(CONFIG, { baseRetryDelayMs: 1, sleep, maxRetries: 5 });
    const error = await caught(
      c.postBinary("/api/now/attachment/file", Buffer.from("x"), "text/plain")
    );
    expect(trustedToolErrorDescriptor(error)?.reason).toBe("instance_hibernating");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("renders at the tool boundary as the fixed upstream text, with no body text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(HIBERNATING_PAGE)));
    const error = await caught(client().get("/api/now/table/incident"));
    // formatToolError is what the MCP callback boundary renders.
    const text = formatToolError(error);
    expect(text).toBe(`${HIBERNATING_MESSAGE} Error category: upstream. Retry later.`);
    expect(safeToolErrorDescriptor(error).reason).toBe("instance_hibernating");
    expect(text).not.toContain(LEAK);
  });
});
