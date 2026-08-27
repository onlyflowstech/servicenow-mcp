import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_JSON_RESPONSE_BYTES,
  MAX_CUMULATIVE_RAW_RESPONSE_BYTES,
  MAX_CUMULATIVE_UPSTREAM_JSON_BYTES,
  MAX_RETRY_DELAY_MS,
  ServiceNowClient,
  parseRetryAfterMs,
  retryDelayMs,
  runWithServiceNowRequestSignal,
  type ClientOptions,
} from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import {
  trustedToolErrorDescriptor,
  type ToolErrorDescriptor,
} from "../src/tool-error.js";

const BASE_CONFIG: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

function makeClient(
  config: Partial<ServiceNowConfig> = {},
  options: ClientOptions = {}
): ServiceNowClient {
  return new ServiceNowClient(
    { ...BASE_CONFIG, ...config },
    { baseRetryDelayMs: 1, sleep: async () => {}, ...options }
  );
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

describe("timeouts", () => {
  it("aborts a hung request with a clear timeout error", async () => {
    // fetch that never resolves, but rejects when our timeout signal fires
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason ?? new Error("aborted"))
            );
          })
      )
    );

    const client = makeClient({ timeoutMs: 20 });
    await expect(rejectedToolError(client.get("/api/now/table/incident"))).resolves.toEqual({
      category: "timeout",
      message: "The ServiceNow request timed out.",
      retry: "retry_if_safe_and_idempotent",
    });
  });

  it("passes an AbortSignal to every fetch call", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ result: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await makeClient().get("/api/now/table/incident");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("request cancellation scope", () => {
  it("aborts the in-flight upstream write and performs no late retry", async () => {
    const upstreamAborted = vi.fn();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              upstreamAborted();
              reject(init.signal?.reason ?? new Error("aborted"));
            },
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const operation = runWithServiceNowRequestSignal(controller.signal, () =>
      makeClient().patch("/api/now/table/incident/abc", {
        short_description: "bounded write",
      })
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error("caller disconnected"));

    await expect(operation).rejects.toThrow("ServiceNow request cancelled");
    expect(upstreamAborted).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels retry backoff without issuing a later attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({}, 503, { "Retry-After": "30" })
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleepEntered = vi.fn();
    const controller = new AbortController();
    const operation = runWithServiceNowRequestSignal(controller.signal, () =>
      makeClient({}, {
        sleep: () => {
          sleepEntered();
          return new Promise<never>(() => {});
        },
      }).get("/api/now/table/incident")
    );

    await vi.waitFor(() => expect(sleepEntered).toHaveBeenCalledOnce());
    controller.abort();
    await expect(operation).rejects.toThrow("ServiceNow request cancelled");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("isolates concurrent profile signals around cached client instances", async () => {
    const pending = new Map<string, (response: Response) => void>();
    const aborted = new Set<string>();
    const fetchMock = vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const hostname = new URL(url).hostname;
          pending.set(hostname, resolve);
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted.add(hostname);
              reject(init.signal?.reason ?? new Error("aborted"));
            },
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const alphaController = new AbortController();
    const betaController = new AbortController();
    const alphaClient = makeClient({ instance: "https://alpha.service-now.com" });
    const betaClient = makeClient({ instance: "https://beta.service-now.com" });

    const alpha = runWithServiceNowRequestSignal(alphaController.signal, () =>
      alphaClient.get("/api/now/table/incident")
    );
    const beta = runWithServiceNowRequestSignal(betaController.signal, () =>
      betaClient.get("/api/now/table/incident")
    );
    await vi.waitFor(() => expect(pending.size).toBe(2));

    alphaController.abort();
    await expect(alpha).rejects.toThrow("ServiceNow request cancelled");
    expect(aborted).toEqual(new Set(["alpha.service-now.com"]));
    expect(betaController.signal.aborted).toBe(false);

    pending.get("beta.service-now.com")?.(jsonResponse({ result: ["beta"] }));
    await expect(beta).resolves.toEqual({ result: ["beta"] });
    expect(aborted).not.toContain("beta.service-now.com");
  });
});

describe("retries", () => {
  it("retries a 429 GET honoring Retry-After delta-seconds, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Rate limit" } }, 429, { "Retry-After": "7" })
      )
      .mockResolvedValueOnce(jsonResponse({ result: [{ sys_id: "abc" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const sleep = vi.fn(async () => {});

    const client = makeClient({}, { sleep });
    const data = await client.get("/api/now/table/incident");

    expect(data).toEqual({ result: [{ sys_id: "abc" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(7000);
  });

  it("retries a 429 POST (rejected before processing, safe to retry)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse({ result: { sys_id: "new" } }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const data = await makeClient().post("/api/now/table/incident", { short_description: "x" });
    expect(data).toEqual({ result: { sys_id: "new" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 5xx POST (side effects may have executed)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "Service Unavailable" } }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      rejectedToolError(
        makeClient().post("/api/now/table/incident", { short_description: "x" })
      )
    ).resolves.toMatchObject({ category: "upstream", retry: "do_not_retry" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx GET and succeeds within the retry budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({ result: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await makeClient().get("/api/now/table/incident");
    expect(data).toEqual({ result: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after 2 retries (3 attempts) on persistent 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      rejectedToolError(makeClient().get("/api/now/table/incident"))
    ).resolves.toMatchObject({
      category: "upstream",
      retry: "retry_if_safe_and_idempotent",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a transient network error on GET but not on POST", async () => {
    const networkError = new TypeError("fetch failed");

    const getMock = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(jsonResponse({ result: [] }));
    vi.stubGlobal("fetch", getMock);
    await expect(makeClient().get("/x")).resolves.toEqual({ result: [] });
    expect(getMock).toHaveBeenCalledTimes(2);

    const postMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal("fetch", postMock);
    await expect(
      rejectedToolError(makeClient().post("/x", {}))
    ).resolves.toMatchObject({ category: "upstream", retry: "do_not_retry" });
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("retries DELETE on 503 and returns the final status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeClient().delete("/api/now/table/incident/abc");
    expect(result).toEqual({ status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("retry delay computation", () => {
  it("parses Retry-After delta-seconds", () => {
    expect(parseRetryAfterMs("7")).toBe(7000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses Retry-After HTTP-date relative to now", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(11_000);
  });

  it("clamps past HTTP-dates to zero and rejects garbage", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
    expect(parseRetryAfterMs("soonish")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("caps any single wait at MAX_RETRY_DELAY_MS", () => {
    expect(retryDelayMs("3600", 1, 500)).toBe(MAX_RETRY_DELAY_MS);
  });

  it("falls back to exponential backoff with jitter", () => {
    const first = retryDelayMs(null, 1, 500);
    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThanOrEqual(1000);
    const second = retryDelayMs(null, 2, 500);
    expect(second).toBeGreaterThanOrEqual(1000);
    expect(second).toBeLessThanOrEqual(1500);
  });
});

describe("trusted HTTP error mapping", () => {
  it.each([
    [401, "authentication", "retry_after_correction"],
    [403, "authorization", "retry_after_correction"],
    [404, "not_found", "do_not_retry"],
    [408, "timeout", "retry_if_safe_and_idempotent"],
    [409, "conflict", "retry_after_correction"],
    [429, "rate_limit", "retry_later"],
    [422, "upstream", "do_not_retry"],
    [502, "upstream", "retry_if_safe_and_idempotent"],
  ] as const)(
    "maps HTTP %i without retaining response text",
    async (status, category, retry) => {
      const canary = `RAW_STATUS_${status}_SECRET`;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse(
            { error: { message: canary, detail: `sysparm_query=${canary}` } },
            status,
            status === 429 ? { "Retry-After": "17" } : {}
          )
        )
      );

      const failure = await rejectedToolError(
        makeClient({}, { maxRetries: 0 }).get("/api/now/table/incident")
      );
      expect(failure).toMatchObject({ category, retry });
      expect(JSON.stringify(failure)).not.toContain(canary);
      if (status === 429) expect(failure.retryAfterSeconds).toBe(17);
      else expect(failure.retryAfterSeconds).toBeUndefined();
    }
  );

  it("caps a hostile Retry-After before it becomes public", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 429, { "Retry-After": "999999999999" }))
    );
    await expect(
      rejectedToolError(
        makeClient({}, { maxRetries: 0 }).get("/api/now/table/incident")
      )
    ).resolves.toMatchObject({
      category: "rate_limit",
      retry: "retry_later",
      retryAfterSeconds: 3_600,
    });
  });

  it("maps a hostile network rejection without inspecting it", async () => {
    const get = vi.fn(() => {
      throw new Error("RAW_NETWORK_PROXY_SECRET");
    });
    const hostile = new Proxy({}, { get });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(hostile)));

    const failure = await rejectedToolError(
      makeClient({}, { maxRetries: 0 }).get("/api/now/table/incident")
    );

    expect(failure).toMatchObject({
      category: "upstream",
      retry: "retry_if_safe_and_idempotent",
    });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("response metadata", () => {
  it("exposes status and headers via requestWithMeta / getWithMeta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ result: [{ sys_id: "abc" }] }, 200, { "X-Total-Count": "1234" })
      )
    );

    const result = await makeClient().getWithMeta("/api/now/table/incident", {
      sysparm_limit: "1",
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("x-total-count")).toBe("1234");
    expect(result.data).toEqual({ result: [{ sys_id: "abc" }] });
  });

  it("returns null data with metadata on 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const result = await makeClient().requestWithMeta("PUT", "/api/now/table/incident/abc", {
      body: { state: "6" },
    });
    expect(result.data).toBeNull();
    expect(result.status).toBe(204);
  });
});

describe("bounded raw responses and path confinement", () => {
  it("cancels a streaming raw response as soon as it exceeds the byte cap", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );

    await expect(
      makeClient().getRaw("/api/now/attachment/file", { maxBytes: 10 })
    ).rejects.toThrow(/exceeds configured byte limit/u);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    "/api/now/table/incident/../oauth_token",
    "/api/now/table/incident/%2e%2e/oauth_token",
    "/api/now/table/incident/%2Foauth_token",
    "//attacker.invalid/api/now/table/oauth_token",
    "/api/now/table/incident?sysparm_query=secret",
    "/api/now/table/incident#fragment",
  ])("rejects unsafe API path %s before fetch", async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().get(path)).rejects.toThrow(/ServiceNow API path/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bounded ServiceNow JSON and error responses", () => {
  it("publishes separate 1 MiB JSON and 10 MiB raw response ceilings", () => {
    expect(DEFAULT_MAX_JSON_RESPONSE_BYTES).toBe(1024 * 1024);
    expect(MAX_CUMULATIVE_UPSTREAM_JSON_BYTES).toBe(1024 * 1024);
    expect(MAX_CUMULATIVE_RAW_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("cancels a hostile streamed success body before parsing 13 MiB", async () => {
    const cancel = vi.fn();
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (emitted >= 13) controller.close();
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    await expect(makeClient().get("/api/now/table/incident")).rejects.toThrow(
      /exceeds configured byte limit/u
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["1048577", "1, 2", "9007199254740992"])(
    "rejects hostile Content-Length %s and cancels without reading",
    async (declaredLength) => {
      const cancel = vi.fn();
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull, cancel });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Length": declaredLength },
          })
        )
      );

      await expect(makeClient().get("/api/now/table/incident")).rejects.toThrow(
        /exceeds configured byte limit/u
      );
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it("admits the observed 900001-byte 300k-object payload under the 64x model", async () => {
    const hostile = `[${"{},".repeat(299_999)}{}]`;
    expect(Buffer.byteLength(hostile, "utf8")).toBe(900_001);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(hostile, {
          status: 200,
          headers: { "Content-Length": "900001" },
        })
      )
    );

    const result = await makeClient().get<unknown[]>("/api/now/table/incident");
    expect(result).toHaveLength(300_000);
  });

  it("atomically enforces one cumulative JSON budget across parallel fan-out", async () => {
    const hostile = `[${"{},".repeat(299_999)}{}]`;
    const parse = vi.spyOn(JSON, "parse");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(hostile, {
          status: 200,
          headers: { "Content-Length": "900001" },
        })
      )
    );
    const controller = new AbortController();

    const outcomes = await runWithServiceNowRequestSignal(
      controller.signal,
      async () =>
        Promise.allSettled([
          makeClient().get("/api/now/table/incident"),
          makeClient().get("/api/now/table/problem"),
        ])
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          message: expect.stringContaining("cumulative upstream response"),
        }),
      }),
    ]);
    expect(parse).toHaveBeenCalledOnce();
  });

  it("keeps direct non-runtime calls individually bounded rather than cumulative", async () => {
    const payload = JSON.stringify({ result: "x".repeat(600_000) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(payload, {
          status: 200,
          headers: { "Content-Length": String(Buffer.byteLength(payload)) },
        })
      )
    );
    const client = makeClient();

    await expect(client.get("/api/now/table/incident")).resolves.toBeTruthy();
    await expect(client.get("/api/now/table/problem")).resolves.toBeTruthy();
  });

  it("atomically enforces the distinct 10 MiB raw budget", async () => {
    const raw = new Uint8Array(6 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(raw, {
          status: 200,
          headers: { "Content-Length": String(raw.byteLength) },
        })
      )
    );
    const controller = new AbortController();

    const outcomes = await runWithServiceNowRequestSignal(
      controller.signal,
      async () =>
        Promise.allSettled([
          makeClient().getRaw("/api/now/attachment/one/file"),
          makeClient().getRaw("/api/now/attachment/two/file"),
        ])
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("does not call JSON.parse when the declared body exceeds the cap", async () => {
    const cancel = vi.fn();
    const parse = vi.spyOn(JSON, "parse");
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Length": "1048577" },
        })
      )
    );

    await expect(makeClient().get("/api/now/table/incident")).rejects.toThrow(
      /exceeds configured byte limit/u
    );
    expect(parse).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("caps and safely discards an oversized streamed error body", async () => {
    const cancel = vi.fn();
    const secret = "hostile-upstream-secret-that-must-not-surface";
    const chunk = new TextEncoder().encode(secret.repeat(2_000));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 500 }))
    );

    let thrown: unknown;
    try {
      await makeClient({}, { maxRetries: 0 }).get("/api/now/table/incident");
    } catch (error) {
      thrown = error;
    }
    expect(trustedToolErrorDescriptor(thrown)).toMatchObject({
      category: "upstream",
      retry: "retry_if_safe_and_idempotent",
    });
    expect(String((thrown as Error).message)).not.toContain(secret);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("caps parsed upstream error fields before exposing them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: "m".repeat(5_000), detail: "d".repeat(5_000) } },
          400
        )
      )
    );

    let thrown: unknown;
    try {
      await makeClient().post("/api/now/table/incident", {});
    } catch (error) {
      thrown = error;
    }
    expect(trustedToolErrorDescriptor(thrown)).toMatchObject({
      category: "upstream",
      retry: "do_not_retry",
    });
    expect((thrown as { detail?: unknown }).detail).toBeUndefined();
    expect((thrown as Error).message).not.toContain("m".repeat(32));
  });

  it("redacts configured credentials before exposing upstream error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { message: `rejected ${BASE_CONFIG.password}` } },
          400
        )
      )
    );

    await expect(
      rejectedToolError(makeClient().get("/api/now/table/incident"))
    ).resolves.toMatchObject({
      category: "upstream",
      retry: "do_not_retry",
    });
  });

  it("cancels a pending success-body reader when the request scope ends", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":'));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const controller = new AbortController();
    const operation = runWithServiceNowRequestSignal(controller.signal, () =>
      makeClient().get("/api/now/table/incident")
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(operation).rejects.toThrow("ServiceNow request cancelled");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("auth headers", () => {
  it("sends the basic Authorization header by default", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ result: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await makeClient().get("/api/now/table/incident");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const expected =
      "Basic " +
      Buffer.from(`${BASE_CONFIG.user}:${BASE_CONFIG.password}`).toString("base64");
    expect(headers.Authorization).toBe(expected);
  });
});
