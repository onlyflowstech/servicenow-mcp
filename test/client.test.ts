import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RETRY_DELAY_MS,
  ServiceNowClient,
  parseRetryAfterMs,
  retryDelayMs,
  type ClientOptions,
} from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";

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
    await expect(client.get("/api/now/table/incident")).rejects.toMatchObject({
      message: "request timed out after 20ms",
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
      makeClient().post("/api/now/table/incident", { short_description: "x" })
    ).rejects.toMatchObject({ status: 503 });
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

    await expect(makeClient().get("/api/now/table/incident")).rejects.toMatchObject({
      status: 503,
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
    await expect(makeClient().post("/x", {})).rejects.toMatchObject({
      message: expect.stringContaining("network error"),
    });
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
