import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiKeyProvider,
  BasicAuthProvider,
  DEFAULT_API_KEY_HEADER,
  OAuthProvider,
  createAuthProvider,
} from "../src/auth.js";
import { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";

const INSTANCE = "https://example.service-now.com";
const FAKE_CLIENT_ID = "mcp-client-id";
const FAKE_CLIENT_SECRET = "fake-client-secret-do-not-log";
const FAKE_TOKEN = "fake-access-token-abc123-never-log-me";

function oauthProvider(overrides: Partial<ConstructorParameters<typeof OAuthProvider>[0]> = {}) {
  return new OAuthProvider({
    instance: INSTANCE,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    ...overrides,
  });
}

function tokenResponse(token = FAKE_TOKEN, expiresIn: number | string = 1800) {
  return new Response(
    JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: expiresIn }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BasicAuthProvider", () => {
  it("produces the expected Authorization header and never retries a 401", async () => {
    const provider = new BasicAuthProvider("admin", "placeholder-password");
    const headers = await provider.getAuthHeaders();
    expect(headers).toEqual({
      Authorization:
        "Basic " + Buffer.from("admin:placeholder-password").toString("base64"),
    });
    await expect(provider.onAuthFailure()).resolves.toBe(false);
  });
});

describe("ApiKeyProvider", () => {
  it("sends the key in the default x-sn-apikey header", async () => {
    const provider = new ApiKeyProvider("fake-api-key");
    await expect(provider.getAuthHeaders()).resolves.toEqual({
      [DEFAULT_API_KEY_HEADER]: "fake-api-key",
    });
    await expect(provider.onAuthFailure()).resolves.toBe(false);
  });

  it("supports a configurable header name", async () => {
    const provider = new ApiKeyProvider("fake-api-key", "x-custom-key");
    await expect(provider.getAuthHeaders()).resolves.toEqual({
      "x-custom-key": "fake-api-key",
    });
  });
});

describe("OAuthProvider", () => {
  it("POSTs a form-encoded client_credentials grant to /oauth_token.do", async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    const headers = await oauthProvider().getAuthHeaders();
    expect(headers).toEqual({ Authorization: `Bearer ${FAKE_TOKEN}` });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${INSTANCE}/oauth_token.do`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(FAKE_CLIENT_ID);
    expect(form.get("client_secret")).toBe(FAKE_CLIENT_SECRET);
    expect(form.get("username")).toBeNull();
  });

  it("includes username/password for the password grant", async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    await oauthProvider({
      grantType: "password",
      username: "integration.user",
      password: "fake-user-password",
    }).getAuthHeaders();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("password");
    expect(form.get("username")).toBe("integration.user");
    expect(form.get("password")).toBe("fake-user-password");
  });

  it("caches the token across calls until it expires", async () => {
    const fetchMock = vi.fn(async () => tokenResponse(FAKE_TOKEN, 1800));
    vi.stubGlobal("fetch", fetchMock);

    const provider = oauthProvider();
    await provider.getAuthHeaders();
    await provider.getAuthHeaders();
    await provider.getAuthHeaders();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired token", async () => {
    // expires_in 60s minus the 60s safety margin -> expires immediately
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("token-one", 60))
      .mockResolvedValueOnce(tokenResponse("token-two", 1800));
    vi.stubGlobal("fetch", fetchMock);

    const provider = oauthProvider();
    expect(await provider.getAuthHeaders()).toEqual({ Authorization: "Bearer token-one" });
    expect(await provider.getAuthHeaders()).toEqual({ Authorization: "Bearer token-two" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent refreshes", async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(() => gate);
    vi.stubGlobal("fetch", fetchMock);

    const provider = oauthProvider();
    const first = provider.getAuthHeaders();
    const second = provider.getAuthHeaders();
    release(tokenResponse());

    expect(await first).toEqual({ Authorization: `Bearer ${FAKE_TOKEN}` });
    expect(await second).toEqual({ Authorization: `Bearer ${FAKE_TOKEN}` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts the client secret from token-endpoint error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: "invalid_client",
            error_description: `access_denied for secret ${FAKE_CLIENT_SECRET}`,
          },
          401
        )
      )
    );

    let thrown: Error | undefined;
    try {
      await oauthProvider().getAuthHeaders();
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("HTTP 401");
    expect(thrown!.message).toContain("access_denied");
    expect(thrown!.message).not.toContain(FAKE_CLIENT_SECRET);
  });

  it("rejects a password grant without username/credential", () => {
    expect(() => oauthProvider({ grantType: "password" })).toThrow(/username and credential/);
  });
});

describe("client + OAuth integration", () => {
  const OAUTH_CONFIG: ServiceNowConfig = {
    instance: INSTANCE,
    user: "",
    password: "",
    displayValue: "true",
    relDepth: 3,
    authType: "oauth",
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
  };

  function makeClient() {
    return new ServiceNowClient(OAUTH_CONFIG, {
      baseRetryDelayMs: 1,
      sleep: async () => {},
    });
  }

  it("on 401 it refreshes the token and retries the request exactly once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("stale-token", 1800))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "User Not Authenticated" } }, 401))
      .mockResolvedValueOnce(tokenResponse("fresh-token", 1800))
      .mockResolvedValueOnce(jsonResponse({ result: [{ sys_id: "abc" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await makeClient().get("/api/now/table/incident");
    expect(data).toEqual({ result: [{ sys_id: "abc" }] });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // The retried request must carry the fresh token.
    const retryHeaders = fetchMock.mock.calls[3][1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer fresh-token");
  });

  it("gives up after one refresh on persistent 401 and never leaks the token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse(FAKE_TOKEN, 1800))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "User Not Authenticated" } }, 401))
      .mockResolvedValueOnce(tokenResponse(FAKE_TOKEN, 1800))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "User Not Authenticated" } }, 401));
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await makeClient().get("/api/now/table/incident");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 401 });
    // exactly one refresh + one retry: token, 401, token, 401 -- no fifth call
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const message = JSON.stringify(thrown);
    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).not.toContain(FAKE_CLIENT_SECRET);
  });

  it("does not append the basic-auth 401 hint for oauth profiles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse(FAKE_TOKEN, 1800))
      .mockResolvedValue(jsonResponse({ error: { message: "User Not Authenticated" } }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().get("/x")).rejects.toMatchObject({
      message: expect.not.stringContaining("KB3096078"),
    });
  });
});

describe("basic-auth 401 guidance", () => {
  it("appends the KB3096078 hint to 401 errors on basic-auth profiles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "User Not Authenticated" } }, 401))
    );

    const client = new ServiceNowClient({
      instance: INSTANCE,
      user: "admin",
      password: "placeholder-password",
      displayValue: "true",
      relDepth: 3,
    });

    let thrown: unknown;
    try {
      await client.get("/api/now/table/incident");
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as { message: string }).message;
    expect(message).toContain("User Not Authenticated");
    expect(message).toContain(
      "ServiceNow may be enforcing Basic Auth restrictions on this instance (see KB3096078)."
    );
    expect(message).toContain(
      "Exemptions: Web-Service-Access-Only account or snc_basic_auth_api_access role."
    );
    expect(message).toContain(
      "Recommended: switch this profile to OAuth (authType: 'oauth')."
    );
  });
});

describe("createAuthProvider", () => {
  const BASE: ServiceNowConfig = {
    instance: INSTANCE,
    user: "admin",
    password: "placeholder-password",
    displayValue: "true",
    relDepth: 3,
  };

  it("defaults to basic auth", () => {
    expect(createAuthProvider(BASE).kind).toBe("basic");
  });

  it("builds oauth/apikey providers and validates required fields", () => {
    expect(
      createAuthProvider({
        ...BASE,
        authType: "oauth",
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
      }).kind
    ).toBe("oauth");
    expect(() => createAuthProvider({ ...BASE, authType: "oauth" })).toThrow(
      /clientId and clientSecret/
    );

    expect(createAuthProvider({ ...BASE, authType: "apikey", apiKey: "fake-key" }).kind).toBe(
      "apikey"
    );
    expect(() => createAuthProvider({ ...BASE, authType: "apikey" })).toThrow(/apiKey/);
  });
});

describe("client + API key integration", () => {
  it("sends the api key header on requests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ result: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ServiceNowClient({
      instance: INSTANCE,
      user: "",
      password: "",
      displayValue: "true",
      relDepth: 3,
      authType: "apikey",
      apiKey: "fake-api-key",
      apiKeyHeader: "x-sn-apikey",
    });

    await client.get("/api/now/table/incident");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-sn-apikey"]).toBe("fake-api-key");
    expect(headers.Authorization).toBeUndefined();
  });
});
