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
import {
  trustedToolErrorDescriptor,
  type ToolErrorDescriptor,
} from "../src/tool-error.js";

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

async function rejectedToolError(operation: Promise<unknown>): Promise<ToolErrorDescriptor> {
  try {
    await operation;
  } catch (error) {
    const descriptor = trustedToolErrorDescriptor(error);
    expect(descriptor).toBeDefined();
    return descriptor!;
  }
  throw new Error("expected operation to reject");
}

function thrownToolError(operation: () => unknown): ToolErrorDescriptor {
  try {
    operation();
  } catch (error) {
    const descriptor = trustedToolErrorDescriptor(error);
    expect(descriptor).toBeDefined();
    return descriptor!;
  }
  throw new Error("expected operation to throw");
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

  it("keeps a shared refresh alive while one uncancelled subscriber remains", async () => {
    let release!: (value: Response) => void;
    let tokenSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      tokenSignal = init.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = oauthProvider();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = provider.getAuthHeaders(firstController.signal);
    const second = provider.getAuthHeaders(secondController.signal);

    firstController.abort();
    await expect(first).rejects.toThrow("OAuth token request cancelled");
    expect(tokenSignal?.aborted).toBe(false);
    release(tokenResponse("surviving-subscriber-token"));
    await expect(second).resolves.toEqual({
      Authorization: "Bearer surviving-subscriber-token",
    });
    await expect(provider.getAuthHeaders()).resolves.toEqual({
      Authorization: "Bearer surviving-subscriber-token",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts an abandoned token POST and fences a late completion from cache", async () => {
    const releases: Array<(value: Response) => void> = [];
    const tokenSignals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      tokenSignals.push(init.signal as AbortSignal);
      return new Promise<Response>((resolve) => releases.push(resolve));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = oauthProvider();
    const controller = new AbortController();
    const abandoned = provider.getAuthHeaders(controller.signal);
    controller.abort();

    await expect(abandoned).rejects.toThrow("OAuth token request cancelled");
    expect(tokenSignals[0]?.aborted).toBe(true);
    releases[0]?.(tokenResponse("must-never-be-cached"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const replacement = provider.getAuthHeaders();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releases[1]?.(tokenResponse("replacement-token"));
    await expect(replacement).resolves.toEqual({
      Authorization: "Bearer replacement-token",
    });
  });

  it("cancels a streamed token response that exceeds its byte ceiling", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );

    await expect(
      rejectedToolError(oauthProvider().getAuthHeaders())
    ).resolves.toMatchObject({
      category: "upstream",
      retry: "retry_if_safe_and_idempotent",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds token-endpoint error bodies before extracting detail", async () => {
    const cancel = vi.fn();
    const secret = FAKE_CLIENT_SECRET;
    const chunk = new TextEncoder().encode(secret.repeat(3_000));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 401 }))
    );

    const thrown = await rejectedToolError(oauthProvider().getAuthHeaders());
    expect(thrown).toMatchObject({
      category: "authentication",
      retry: "retry_after_correction",
    });
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a hostile declared token response length without parsing", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Length": "9007199254740992" },
        })
      )
    );

    await expect(
      rejectedToolError(oauthProvider().getAuthHeaders())
    ).resolves.toMatchObject({
      category: "upstream",
      retry: "retry_if_safe_and_idempotent",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out and cancels a stalled token response body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );

    await expect(
      rejectedToolError(oauthProvider({ timeoutMs: 20 }).getAuthHeaders())
    ).resolves.toMatchObject({
      category: "timeout",
      retry: "retry_if_safe_and_idempotent",
    });
    expect(cancel).toHaveBeenCalledOnce();
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

    const thrown = await rejectedToolError(oauthProvider().getAuthHeaders());
    expect(thrown).toMatchObject({ category: "authentication" });
    expect(JSON.stringify(thrown)).not.toContain("access_denied");
    expect(JSON.stringify(thrown)).not.toContain(FAKE_CLIENT_SECRET);
  });

  it("redacts a secret that straddles the 300-char truncation boundary", async () => {
    // If truncation ran BEFORE redaction, a secret starting near char 300
    // would be cut mid-string, the redaction would no longer match, and
    // the secret's prefix would leak into the thrown error message.
    const padding = "x".repeat(290);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: "access_denied",
            error_description: `${padding}${FAKE_CLIENT_SECRET} rejected`,
          },
          401
        )
      )
    );

    const thrown = await rejectedToolError(oauthProvider().getAuthHeaders());
    expect(thrown).toMatchObject({ category: "authentication" });
    expect(JSON.stringify(thrown)).not.toContain(FAKE_CLIENT_SECRET);
    // No partial prefix of the secret may survive truncation either.
    expect(thrown!.message).not.toContain(FAKE_CLIENT_SECRET.slice(0, 8));
  });

  it("rejects a password grant without username/credential", () => {
    expect(
      thrownToolError(() => oauthProvider({ grantType: "password" }))
    ).toMatchObject({
      category: "authentication",
      retry: "retry_after_correction",
    });
  });

  it.each([
    [400, "authentication", "retry_after_correction"],
    [401, "authentication", "retry_after_correction"],
    [403, "authentication", "retry_after_correction"],
    [408, "timeout", "retry_if_safe_and_idempotent"],
    [409, "conflict", "retry_after_correction"],
    [429, "rate_limit", "retry_later"],
    [503, "upstream", "retry_if_safe_and_idempotent"],
  ] as const)(
    "maps token endpoint HTTP %i to trusted %s",
    async (status, category, retry) => {
      const canary = `RAW_OAUTH_${status}_SECRET`;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(
            { error: "token_error", error_description: canary },
            status,
            status === 429 ? { "Retry-After": "19" } : {}
          )
        )
      );
      const failure = await rejectedToolError(oauthProvider().getAuthHeaders());
      expect(failure).toMatchObject({ category, retry });
      expect(JSON.stringify(failure)).not.toContain(canary);
      if (status === 429) expect(failure.retryAfterSeconds).toBe(19);
    }
  );

  it("maps a hostile token-network rejection without inspecting it", async () => {
    const get = vi.fn(() => {
      throw new Error("RAW_OAUTH_PROXY_SECRET");
    });
    const hostile = new Proxy({}, { get });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(hostile)));

    const failure = await rejectedToolError(oauthProvider().getAuthHeaders());

    expect(failure).toMatchObject({
      category: "upstream",
      retry: "retry_if_safe_and_idempotent",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps missing local OAuth material existence-equivalent to HTTP 401", async () => {
    const locallyUnavailable = thrownToolError(() =>
      createAuthProvider({
        instance: INSTANCE,
        user: "",
        password: "",
        displayValue: "true",
        relDepth: 3,
        authType: "oauth",
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: "invalid_client",
            error_description: "RAW_PRESENT_BUT_WRONG_SECRET",
          },
          401
        )
      )
    );
    const remotelyRejected = await rejectedToolError(
      oauthProvider().getAuthHeaders()
    );

    expect(remotelyRejected).toEqual(locallyUnavailable);
    expect(JSON.stringify(remotelyRejected)).not.toContain(
      "RAW_PRESENT_BUT_WRONG_SECRET"
    );
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
    expect(trustedToolErrorDescriptor(thrown)).toMatchObject({
      category: "authentication",
      retry: "retry_after_correction",
    });
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

describe("basic-auth 401 safety", () => {
  it("returns the fixed authentication contract without upstream text", async () => {
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
    expect(trustedToolErrorDescriptor(thrown)).toMatchObject({
      category: "authentication",
      retry: "retry_after_correction",
    });
    const message = (thrown as Error).message;
    expect(message).not.toContain("User Not Authenticated");
    expect(message).not.toContain("KB3096078");
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
    expect(
      thrownToolError(() => createAuthProvider({ ...BASE, authType: "oauth" }))
    ).toMatchObject({ category: "authentication" });

    expect(createAuthProvider({ ...BASE, authType: "apikey", apiKey: "fake-key" }).kind).toBe(
      "apikey"
    );
    expect(
      thrownToolError(() => createAuthProvider({ ...BASE, authType: "apikey" }))
    ).toMatchObject({ category: "authentication" });
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
