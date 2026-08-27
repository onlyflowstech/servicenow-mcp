import { describe, expect, it } from "vitest";

import {
  HttpAuthenticationError,
  PrivateBoundaryAuthenticationProvider,
  StaticBearerAuthenticationProvider,
  authenticateHttpRequest,
  correlationIdFromMcpRequest,
  createAuthenticatedRequestMetadataProvider,
  httpAuthenticationRequestFromRawHeaders,
  httpAuthenticationStatus,
  isHttpAuthenticationError,
  safeHttpAuthenticationFailure,
  type HttpAuthenticationProvider,
  type HttpAuthenticationRequest,
  type StaticBearerCredential,
} from "../src/http-auth.js";

const DIRECT_TOKEN = `direct_${"A".repeat(42)}`;
const TEST_TOKEN = `test_${"B".repeat(44)}`;

function staticProvider(
  credentials: readonly StaticBearerCredential[] = [
    { token: DIRECT_TOKEN, ownerId: "owner-one", clientId: "direct-client" },
    { token: TEST_TOKEN, ownerId: "owner-one", clientId: "test-client" },
  ]
): StaticBearerAuthenticationProvider {
  return new StaticBearerAuthenticationProvider(credentials);
}

function request(...authorizationHeaders: string[]): HttpAuthenticationRequest {
  return { authorizationHeaders };
}

function captureAuthenticationError(operation: () => unknown): HttpAuthenticationError {
  try {
    operation();
  } catch (error) {
    expect(isHttpAuthenticationError(error)).toBe(true);
    return error as HttpAuthenticationError;
  }
  throw new Error("expected authentication to fail");
}

describe("static bearer HTTP authentication", () => {
  it("authenticates explicitly configured clients under one immutable owner", async () => {
    const provider = staticProvider();

    const direct = await authenticateHttpRequest(
      provider,
      request(`Bearer ${DIRECT_TOKEN}`)
    );
    const test = await authenticateHttpRequest(
      provider,
      request(`bearer ${TEST_TOKEN}`)
    );

    expect(direct).toEqual({ ownerId: "owner-one", clientId: "direct-client" });
    expect(test).toEqual({ ownerId: "owner-one", clientId: "test-client" });
    expect(Object.isFrozen(direct)).toBe(true);
    expect(Object.isFrozen(test)).toBe(true);
    expect(Reflect.set(direct, "clientId", "spoofed-client")).toBe(false);
    expect(JSON.stringify(provider)).not.toContain(DIRECT_TOKEN);
    expect(JSON.stringify(provider)).not.toContain(TEST_TOKEN);
  });

  it.each([
    ["missing", request()],
    ["empty", request("")],
    ["wrong scheme", request(`Basic ${DIRECT_TOKEN}`)],
    ["scheme only", request("Bearer")],
    ["tab separator", request(`Bearer\t${DIRECT_TOKEN}`)],
    ["extra whitespace", request(`Bearer  ${DIRECT_TOKEN}`)],
    ["leading whitespace", request(` Bearer ${DIRECT_TOKEN}`)],
    ["trailing whitespace", request(`Bearer ${DIRECT_TOKEN} `)],
    ["comma joined duplicate", request(`Bearer ${DIRECT_TOKEN}, Bearer ${TEST_TOKEN}`)],
    ["duplicate", request(`Bearer ${DIRECT_TOKEN}`, `Bearer ${TEST_TOKEN}`)],
    ["unknown", request(`Bearer unknown_${"Z".repeat(40)}`)],
    ["control character", request(`Bearer direct_${"A".repeat(20)}\nrest`)],
  ])("rejects %s authorization uniformly", (_label, candidate) => {
    const error = captureAuthenticationError(() =>
      staticProvider().authenticate(candidate)
    );
    expect(error).toEqual(expect.objectContaining({ code: "unauthorized", status: 401 }));
    expect(safeHttpAuthenticationFailure(error)).toBe(
      safeHttpAuthenticationFailure(new Error("different internal failure"))
    );
  });

  it("handles candidate lengths through fixed-size digests without length errors", () => {
    const provider = staticProvider();
    const candidates = [
      "x",
      "x".repeat(31),
      "x".repeat(32),
      "x".repeat(256),
      "x".repeat(4096),
      "x".repeat(4097),
    ];

    for (const token of candidates) {
      const error = captureAuthenticationError(() =>
        provider.authenticate(request(`Bearer ${token}`))
      );
      expect(error.code).toBe("unauthorized");
      expect(error.message).not.toContain("length");
    }
  });

  it("does not trust forwarded auth or caller-supplied identity fields", () => {
    const hostileRequest = {
      authorizationHeaders: [`Bearer ${DIRECT_TOKEN}`],
      forwardedAuthorization: `Bearer ${TEST_TOKEN}`,
      ownerId: "spoofed-owner",
      clientId: "spoofed-client",
      headers: {
        "x-owner-id": "spoofed-owner",
        "x-client-id": "spoofed-client",
        "proxy-authorization": `Bearer ${TEST_TOKEN}`,
      },
    };

    expect(staticProvider().authenticate(hostileRequest)).toEqual({
      ownerId: "owner-one",
      clientId: "direct-client",
    });
  });

  it("fails closed on hostile request/header accessors", async () => {
    const hostile = Object.defineProperty({}, "authorizationHeaders", {
      get() {
        throw new Error(`Bearer ${DIRECT_TOKEN}`);
      },
    }) as HttpAuthenticationRequest;

    await expect(authenticateHttpRequest(staticProvider(), hostile)).rejects.toEqual(
      expect.objectContaining({ code: "unauthorized", status: 401 })
    );
  });

  it("validates bounded, unique, single-owner configuration", () => {
    expect(() => new StaticBearerAuthenticationProvider([])).toThrow(TypeError);
    expect(
      () =>
        new StaticBearerAuthenticationProvider([
          { token: "too-short", ownerId: "owner-one", clientId: "client-one" },
        ])
    ).toThrow(TypeError);
    expect(
      () =>
        staticProvider([
          { token: DIRECT_TOKEN, ownerId: "owner-one", clientId: "client-one" },
          { token: TEST_TOKEN, ownerId: "owner-two", clientId: "client-two" },
        ])
    ).toThrow(/one owner/u);
    expect(
      () =>
        staticProvider([
          { token: DIRECT_TOKEN, ownerId: "owner-one", clientId: "same-client" },
          { token: TEST_TOKEN, ownerId: "owner-one", clientId: "same-client" },
        ])
    ).toThrow(/clientId/u);
    expect(
      () =>
        staticProvider([
          { token: DIRECT_TOKEN, ownerId: "owner-one", clientId: "client-one" },
          { token: DIRECT_TOKEN, ownerId: "owner-one", clientId: "client-two" },
        ])
    ).toThrow(/tokens/u);
  });
});

describe("raw HTTP header boundary", () => {
  it("preserves mixed-case duplicate Authorization fields for rejection", () => {
    const authRequest = httpAuthenticationRequestFromRawHeaders([
      "Host",
      "127.0.0.1",
      "Authorization",
      `Bearer ${DIRECT_TOKEN}`,
      "authorization",
      `Bearer ${TEST_TOKEN}`,
    ]);

    expect(authRequest.authorizationHeaders).toEqual([
      `Bearer ${DIRECT_TOKEN}`,
      `Bearer ${TEST_TOKEN}`,
    ]);
    expect(Object.isFrozen(authRequest)).toBe(true);
    expect(Object.isFrozen(authRequest.authorizationHeaders)).toBe(true);
    expect(() => staticProvider().authenticate(authRequest)).toThrow(
      HttpAuthenticationError
    );
  });

  it("ignores proxy and identity headers rather than treating them as authority", () => {
    const authRequest = httpAuthenticationRequestFromRawHeaders([
      "Proxy-Authorization",
      `Bearer ${DIRECT_TOKEN}`,
      "X-Forwarded-Authorization",
      `Bearer ${DIRECT_TOKEN}`,
      "X-Owner-Id",
      "spoofed-owner",
      "X-Client-Id",
      "spoofed-client",
    ]);

    expect(authRequest.authorizationHeaders).toEqual([]);
    expect(() => staticProvider().authenticate(authRequest)).toThrow(
      HttpAuthenticationError
    );
  });

  it.each([[["Authorization"]], [["Authorization", 42] as unknown as string[]]])(
    "rejects malformed raw-header pairs",
    (rawHeaders) => {
      const error = captureAuthenticationError(() =>
        httpAuthenticationRequestFromRawHeaders(rawHeaders)
      );
      expect(httpAuthenticationStatus(error)).toBe(401);
    }
  );
});

describe("private-boundary adapter and safe failures", () => {
  it("accepts a validated immutable identity from an injected private boundary", async () => {
    const principal = { ownerId: "owner-one", clientId: "private-client" };
    const provider = new PrivateBoundaryAuthenticationProvider<{ principal: unknown }>({
      authenticate: ({ principal: candidate }) => candidate as typeof principal,
    });

    const identity = await authenticateHttpRequest(provider, { principal });
    principal.clientId = "mutated-client";

    expect(identity).toEqual({ ownerId: "owner-one", clientId: "private-client" });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("normalizes adapter exceptions and invalid identities to safe unauthorized", async () => {
    const secret = "adapter-secret-that-must-never-leak";
    const throwing = new PrivateBoundaryAuthenticationProvider<unknown>({
      authenticate: () => {
        throw new Error(secret);
      },
    });
    const invalid: HttpAuthenticationProvider<unknown> = {
      authenticate: () => ({ ownerId: "", clientId: secret }),
    };

    for (const provider of [throwing, invalid]) {
      let caught: unknown;
      try {
        await authenticateHttpRequest(provider, {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toEqual(
        expect.objectContaining({ code: "unauthorized", status: 401 })
      );
      expect(String(caught)).not.toContain(secret);
      expect(safeHttpAuthenticationFailure(caught).body).toBe(
        '{"error":"unauthorized"}\n'
      );
    }
  });

  it("preserves an explicit forbidden classification without exposing detail", async () => {
    const provider = new PrivateBoundaryAuthenticationProvider<unknown>({
      authenticate: () => {
        throw new HttpAuthenticationError("forbidden");
      },
    });

    let caught: unknown;
    try {
      await authenticateHttpRequest(provider, {});
    } catch (error) {
      caught = error;
    }

    expect(isHttpAuthenticationError(caught)).toBe(true);
    expect(httpAuthenticationStatus(caught)).toBe(403);
    const response = safeHttpAuthenticationFailure(caught);
    expect(response).toEqual({
      status: 403,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
      body: '{"error":"forbidden"}\n',
    });
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.headers)).toBe(true);
  });

  it("maps unknown and spoof-shaped errors to uniform unauthorized", () => {
    const hostileProxy = new Proxy(Object.create(HttpAuthenticationError.prototype), {
      getPrototypeOf() {
        throw new Error("hostile prototype");
      },
    });
    for (const candidate of [
      new Error("Bearer secret"),
      { code: "forbidden", status: 403 },
      hostileProxy,
      null,
      "forbidden",
    ]) {
      expect(isHttpAuthenticationError(candidate)).toBe(false);
      expect(httpAuthenticationStatus(candidate)).toBe(401);
      expect(safeHttpAuthenticationFailure(candidate)).toBe(
        safeHttpAuthenticationFailure(undefined)
      );
    }
  });
});

describe("SNSDK-19 request metadata bridge", () => {
  it("binds authenticated identity per request and ignores invocation spoofing", async () => {
    const identity = { ownerId: "owner-one", clientId: "direct-client" };
    const provider = createAuthenticatedRequestMetadataProvider(identity);
    identity.clientId = "mutated-after-binding";

    const first = await provider.resolve({
      tool: "sn_query",
      requestId: "rpc-1\nspoof",
      authenticatedClientId: "spoofed-client",
    });
    const second = await provider.resolve({
      tool: "sn_get",
      requestId: 2,
      authenticatedClientId: "another-spoof",
    });

    expect(first.identity).toEqual({ ownerId: "owner-one", clientId: "direct-client" });
    expect(second.identity).toEqual(first.identity);
    expect(first.correlationId).toMatch(/^mcp-[a-f0-9]{64}$/u);
    expect(second.correlationId).toMatch(/^mcp-[a-f0-9]{64}$/u);
    expect(first.correlationId).not.toBe(second.correlationId);
    expect(first.correlationId).not.toContain("rpc-1");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.identity)).toBe(true);
  });

  it("creates isolated providers for different authenticated HTTP requests", async () => {
    const direct = createAuthenticatedRequestMetadataProvider({
      ownerId: "owner-one",
      clientId: "direct-client",
    });
    const test = createAuthenticatedRequestMetadataProvider({
      ownerId: "owner-one",
      clientId: "test-client",
    });
    const invocation = { tool: "sn_query", requestId: "same-rpc-id" };

    expect((await direct.resolve(invocation)).identity.clientId).toBe("direct-client");
    expect((await test.resolve(invocation)).identity.clientId).toBe("test-client");
  });

  it("supports a runtime-owned correlation factory after authentication", async () => {
    const provider = createAuthenticatedRequestMetadataProvider(
      { ownerId: "owner-one", clientId: "direct-client" },
      ({ requestId }) => `request-${String(requestId)}`
    );

    expect(
      await provider.resolve({ tool: "sn_query", requestId: "custom-1" })
    ).toEqual({
      correlationId: "request-custom-1",
      identity: { ownerId: "owner-one", clientId: "direct-client" },
    });
  });

  it("hashes string and numeric JSON-RPC IDs into distinct correlations", () => {
    expect(
      correlationIdFromMcpRequest({ tool: "sn_query", requestId: "1" })
    ).not.toBe(
      correlationIdFromMcpRequest({ tool: "sn_query", requestId: 1 })
    );
  });
});
