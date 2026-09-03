import { describe, expect, it, vi } from "vitest";

import {
  createAuditRecord,
  createPreContextAuditRecord,
} from "../src/execution-context.js";
import {
  createHttpObservability,
  createHttpRateLimiter,
  createBoundedJsonLinesEventSink,
  createJsonLinesEventSink,
  safeHttpRateLimitRejection,
  type HttpObservabilityClock,
  type HttpRateLimitDecision,
  type StructuredHttpEvent,
} from "../src/http-observability.js";
import { createToolError } from "../src/tool-error.js";

class FakeClock implements HttpObservabilityClock {
  value = 0;

  now(): number {
    return this.value;
  }
}

function eventHarness(clock = new FakeClock()) {
  const events: StructuredHttpEvent[] = [];
  const observability = createHttpObservability({
    clock,
    sink: { write: (event) => events.push(event) },
  });
  return { clock, events, observability };
}

function rateLimiter(
  clock = new FakeClock(),
  overrides: {
    preCapacity?: number;
    preEntries?: number;
    identityCapacity?: number;
    identityEntries?: number;
  } = {}
) {
  return {
    clock,
    limiter: createHttpRateLimiter({
      clock,
      preAuthentication: {
        capacity: overrides.preCapacity ?? 2,
        refillPeriodMs: 10_000,
        maxEntries: overrides.preEntries ?? 4,
      },
      authenticatedIdentity: {
        capacity: overrides.identityCapacity ?? 2,
        refillPeriodMs: 10_000,
        maxEntries: overrides.identityEntries ?? 4,
      },
    }),
  };
}

describe("structured bounded HTTP observability", () => {
  it("emits one immutable request completion with pseudonymous identity", () => {
    const { clock, events, observability } = eventHarness();
    clock.value = 1_000;
    const observation = observability.beginRequest();
    clock.value = 1_037;

    const event = observation.finish({
      correlationId: "request-correlation",
      identity: { ownerId: "configured-owner", clientId: "configured-client" },
      outcome: "success",
      reason: null,
      statusCode: 200,
    });

    expect(event).toEqual({
      schemaVersion: 1,
      type: "http_request",
      observedAtMs: 1_037,
      latencyMs: 37,
      correlationId: "request-correlation",
      ownerIdHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      clientIdHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      outcome: "success",
      reason: null,
      statusCode: 200,
    });
    expect(events).toEqual([event]);
    expect(Object.isFrozen(event)).toBe(true);
    expect(JSON.stringify(event)).not.toContain("configured-owner");
    expect(JSON.stringify(event)).not.toContain("configured-client");
    expect(observation.finish({ outcome: "success", reason: null, statusCode: 200 })).toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it("records bounded pre-auth rejection without request material", () => {
    const { clock, events, observability } = eventHarness();
    clock.value = 10;
    const observation = observability.beginRequest();
    clock.value = 12;
    const event = observation.finish({
      outcome: "rejected",
      reason: "unauthorized",
      statusCode: 401,
    });

    expect(event).toMatchObject({
      type: "http_request",
      latencyMs: 2,
      correlationId: null,
      ownerIdHash: null,
      clientIdHash: null,
      outcome: "rejected",
      reason: "unauthorized",
      statusCode: 401,
    });
    expect(Object.keys(events[0]).sort()).toEqual([
      "clientIdHash",
      "correlationId",
      "latencyMs",
      "observedAtMs",
      "outcome",
      "ownerIdHash",
      "reason",
      "schemaVersion",
      "statusCode",
      "type",
    ]);
  });

  it("maps issued tool and pre-context audits with measured latency", () => {
    const { clock, events, observability } = eventHarness();
    const request = {
      correlationId: "tool-correlation",
      identity: { ownerId: "owner-one", clientId: "client-one" },
    };

    clock.value = 100;
    const toolObservation = observability.beginTool();
    clock.value = 145;
    const success = toolObservation.finish(
      createAuditRecord({
        outcome: "success",
        reason: null,
        tool: "sn_query",
        request,
        profile: {
          name: "QA West 東京",
          instance: "https://example.service-now.com",
        },
      })
    );

    clock.value = 200;
    const preContextObservation = observability.beginTool();
    clock.value = 207;
    const preContext = preContextObservation.finish(
      createPreContextAuditRecord({
        tool: "sn_get",
        request,
        reason: "request_metadata_unavailable",
      })
    );

    clock.value = 300;
    const cancellationObservation = observability.beginTool();
    clock.value = 309;
    const cancellation = cancellationObservation.finish(
      createAuditRecord({
        outcome: "cancelled",
        reason: "request_deadline_exceeded",
        tool: "sn_query",
        request,
        profile: {
          name: "alpha",
          instance: "https://example.service-now.com",
        },
      })
    );
    clock.value = 400;
    const preContextCancellation = observability.beginTool().finish(
      createPreContextAuditRecord({
        tool: "sn_get",
        request,
        reason: "request_cancelled",
      })
    );

    expect(success).toMatchObject({
      type: "mcp_tool",
      latencyMs: 45,
      correlationId: "tool-correlation",
      tool: "sn_query",
      profile: "QA West 東京",
      instance: "https://example.service-now.com",
      outcome: "success",
      reason: null,
    });
    expect(preContext).toMatchObject({
      type: "mcp_tool",
      latencyMs: 7,
      tool: "sn_get",
      profile: null,
      instance: null,
      outcome: "context_rejected",
      reason: "request_metadata_unavailable",
    });
    expect(cancellation).toMatchObject({
      type: "mcp_tool",
      latencyMs: 9,
      outcome: "cancelled",
      reason: "request_deadline_exceeded",
    });
    expect(preContextCancellation).toMatchObject({
      type: "mcp_tool",
      profile: null,
      instance: null,
      outcome: "cancelled",
      reason: "request_cancelled",
    });
    expect(events).toHaveLength(4);
    expect(JSON.stringify(events)).not.toContain("owner-one");
    expect(JSON.stringify(events)).not.toContain("client-one");
  });

  it("emits policy denials and pre-validation rejections as tool events", () => {
    const { events, observability } = eventHarness();
    const request = {
      correlationId: "policy-correlation",
      identity: { ownerId: "owner-one", clientId: "client-one" },
    };
    observability.beginTool().finish(
      createAuditRecord({
        outcome: "policy_rejected",
        reason: "table_access_denied",
        tool: "sn_query",
        request,
        profile: {
          name: "alpha",
          instance: "https://example.service-now.com",
        },
      })
    );
    observability.beginTool().finish(
      createPreContextAuditRecord({
        tool: "sn_get",
        request,
        reason: "input_validation_failed",
      })
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "mcp_tool",
        tool: "sn_query",
        outcome: "policy_rejected",
        reason: "table_access_denied",
      }),
      expect.objectContaining({
        type: "mcp_tool",
        tool: "sn_get",
        outcome: "context_rejected",
        reason: "input_validation_failed",
        profile: null,
      }),
    ]);
  });

  it("emits only bounded error category and retry metadata for tool failures", () => {
    const { events, observability } = eventHarness();
    const secret = "RAW_RATE_LIMIT_RESPONSE_SECRET";
    const trusted = createToolError("rate_limit", "retry_later", 17);
    const record = createAuditRecord({
      outcome: "handler_error",
      reason: "handler_threw",
      tool: "sn_query",
      request: {
        correlationId: "rate-limit-correlation",
        identity: { ownerId: "owner-one", clientId: "client-one" },
      },
      profile: {
        name: "alpha",
        instance: "https://example.service-now.com",
      },
      error: trusted,
    });

    const event = observability.beginTool().finish(record);

    expect(event).toMatchObject({
      outcome: "handler_error",
      reason: "handler_threw",
      errorCategory: "rate_limit",
      retry: "retry_later",
      retryAfterSeconds: 17,
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("drops hostile or inconsistent event inputs without leaking or throwing", () => {
    const secret = "Bearer event-secret-that-must-not-leak";
    const lines: string[] = [];
    const observability = createHttpObservability({
      sink: createJsonLinesEventSink((line) => lines.push(line)),
      clock: { now: () => 1 },
    });
    const hostile = Object.defineProperty({}, "outcome", {
      get() {
        throw new Error(secret);
      },
    });

    expect(() =>
      observability
        .beginRequest()
        .finish(hostile as never)
    ).not.toThrow();
    expect(
      observability.beginRequest().finish({
        outcome: "success",
        reason: "internal_error",
        statusCode: 200,
      })
    ).toBeUndefined();
    expect(
      observability.beginRequest().finish({
        outcome: "success",
        reason: null,
        statusCode: 500,
      })
    ).toBeUndefined();
    expect(lines).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(secret);
  });

  it("isolates throwing and never-settling sinks from completed spans", async () => {
    const throwing = createHttpObservability({
      sink: {
        write() {
          throw new Error("sink-secret");
        },
      },
      clock: { now: () => 5 },
    });
    expect(() =>
      throwing.beginRequest().finish({
        outcome: "error",
        reason: "internal_error",
        statusCode: 500,
      })
    ).not.toThrow();

    const rejection = vi.fn();
    const asynchronous = createHttpObservability({
      sink: {
        write: (() => Promise.reject(new Error("async-sink-secret"))) as never,
      },
      clock: { now: () => 5 },
    });
    const event = asynchronous.beginRequest().finish({
      outcome: "success",
      reason: null,
      statusCode: 202,
    });
    expect(event).toBeDefined();
    await Promise.resolve().catch(rejection);
    expect(rejection).not.toHaveBeenCalled();

    const neverSettling = createHttpObservability({
      sink: {
        write: (() => new Promise<never>(() => {})) as never,
      },
      clock: { now: () => 5 },
    });
    expect(
      neverSettling.beginRequest().finish({
        outcome: "success",
        reason: null,
        statusCode: 200,
      })
    ).toBeDefined();

    const jsonLines = createHttpObservability({
      sink: createJsonLinesEventSink(() =>
        Promise.reject(new Error("json-destination-secret"))
      ),
      clock: { now: () => 6 },
    });
    expect(() =>
      jsonLines.beginRequest().finish({
        outcome: "success",
        reason: null,
        statusCode: 200,
      })
    ).not.toThrow();
    await Promise.resolve();
  });

  it("writes one compact JSON object per line from the safe event shape", () => {
    const lines: string[] = [];
    const observability = createHttpObservability({
      sink: createJsonLinesEventSink((line) => lines.push(line)),
      clock: { now: () => 25 },
    });
    observability.beginRequest().finish({
      correlationId: "json-line-correlation",
      outcome: "rejected",
      reason: "malformed_request",
      statusCode: 400,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(lines[0]).not.toContain("\n\n");
    expect(JSON.parse(lines[0])).toMatchObject({
      type: "http_request",
      reason: "malformed_request",
    });

    // The serialization port ignores structurally similar values that were
    // not issued by the observability boundary.
    const jsonSink = createJsonLinesEventSink((line) => lines.push(line));
    jsonSink.write({
      ...JSON.parse(lines[0]),
      correlationId: "forged-secret",
    } as StructuredHttpEvent);
    expect(lines).toHaveLength(1);
  });

  it("bounds pending JSON lines and coalesces drops across backpressure", () => {
    const lines: string[] = [];
    let drain: (() => void) | undefined;
    let writable = false;
    const sink = createBoundedJsonLinesEventSink({
      maxPendingLines: 1,
      writeLine: (line) => {
        lines.push(line);
        return writable;
      },
      onDrain: (listener) => {
        drain = listener;
      },
    });
    const observability = createHttpObservability({
      sink,
      clock: { now: () => 1 },
    });
    for (let index = 0; index < 4; index++) {
      observability.beginRequest().finish({
        correlationId: `bounded-${index}`,
        outcome: "success",
        reason: null,
        statusCode: 200,
      });
    }

    expect(lines).toHaveLength(1);
    writable = true;
    drain?.();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toEqual({ type: "telemetry_dropped", count: 2 });
    expect(JSON.parse(lines[2])).toMatchObject({
      type: "http_request",
      correlationId: "bounded-1",
    });
  });
});

describe("bounded dual-scope HTTP rate limiting", () => {
  it("enforces deterministic token refill and Retry-After for pre-auth sources", () => {
    const { clock, limiter } = rateLimiter();

    expect(limiter.checkPreAuthentication("192.0.2.10")).toMatchObject({
      allowed: true,
      scope: "pre_auth_source",
      limit: 2,
      remaining: 1,
    });
    expect(limiter.checkPreAuthentication("192.0.2.10")).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.checkPreAuthentication("192.0.2.10")).toMatchObject({
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: 5,
    });

    clock.value = 4_999;
    expect(limiter.checkPreAuthentication("192.0.2.10")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    clock.value = 5_000;
    expect(limiter.checkPreAuthentication("192.0.2.10")).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("keeps authenticated identities isolated with collision-safe digests", () => {
    const { limiter } = rateLimiter(undefined, { identityCapacity: 1 });
    const first = { ownerId: "a", clientId: "bc" };
    const second = { ownerId: "ab", clientId: "c" };

    expect(limiter.checkAuthenticated(first).allowed).toBe(true);
    expect(limiter.checkAuthenticated(second).allowed).toBe(true);
    expect(limiter.checkAuthenticated(first)).toMatchObject({
      allowed: false,
      scope: "authenticated_identity",
      reason: "rate_limited",
    });
  });

  it("fails closed at the retained-key bound and reclaims fully refilled entries", () => {
    const { clock, limiter } = rateLimiter(undefined, {
      preCapacity: 1,
      preEntries: 1,
    });

    expect(limiter.checkPreAuthentication("source-a").allowed).toBe(true);
    expect(limiter.checkPreAuthentication("source-b")).toMatchObject({
      allowed: false,
      reason: "key_capacity_exhausted",
      retryAfterSeconds: 10,
    });

    clock.value = 10_000;
    expect(limiter.checkPreAuthentication("source-b")).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("reschedules bounded cleanup when the earliest bucket becomes active", () => {
    const { clock, limiter } = rateLimiter(undefined, {
      preCapacity: 2,
      preEntries: 1,
    });
    expect(limiter.checkPreAuthentication("active-source").allowed).toBe(true);

    clock.value = 4_000;
    expect(limiter.checkPreAuthentication("active-source").allowed).toBe(true);
    clock.value = 5_000;
    expect(limiter.checkPreAuthentication("new-source")).toMatchObject({
      allowed: false,
      reason: "key_capacity_exhausted",
      retryAfterSeconds: 5,
    });
    expect(limiter.checkPreAuthentication("another-source")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 5,
    });

    clock.value = 10_000;
    expect(limiter.checkPreAuthentication("new-source").allowed).toBe(true);
  });

  it("never exposes or retains raw rate-limit keys in decisions", () => {
    const { limiter } = rateLimiter();
    const sourceSecret = "Bearer-source-secret-0123456789";
    const ownerSecret = "configured-owner-secret";
    const clientSecret = "configured-client-secret";
    const decisions = [
      limiter.checkPreAuthentication(sourceSecret),
      limiter.checkAuthenticated({ ownerId: ownerSecret, clientId: clientSecret }),
    ];

    const serialized = JSON.stringify(decisions);
    expect(serialized).not.toContain(sourceSecret);
    expect(serialized).not.toContain(ownerSecret);
    expect(serialized).not.toContain(clientSecret);
    expect(Object.isFrozen(decisions[0])).toBe(true);
    expect(Object.isFrozen(decisions[1])).toBe(true);
  });

  it("rejects invalid/hostile keys and unavailable clocks without throwing", () => {
    const secret = "identity-getter-secret";
    const { limiter } = rateLimiter();
    const hostileIdentity = Object.defineProperty({}, "ownerId", {
      get() {
        throw new Error(secret);
      },
    });

    expect(
      limiter.checkAuthenticated(hostileIdentity as never)
    ).toMatchObject({
      allowed: false,
      reason: "invalid_key",
      retryAfterSeconds: 1,
    });
    expect(limiter.checkPreAuthentication("")).toMatchObject({
      allowed: false,
      reason: "invalid_key",
    });

    // Accepted authentication identifiers remain usable even when their raw
    // representation contains a Unicode format character; the limiter keeps
    // only the digest and never emits the raw value.
    expect(
      limiter.checkAuthenticated({ ownerId: "owner\u200Djoin", clientId: "client" })
    ).toMatchObject({ allowed: true });

    const unavailable = createHttpRateLimiter({
      clock: { now: () => Number.NaN },
      preAuthentication: { capacity: 1, refillPeriodMs: 1_000, maxEntries: 1 },
      authenticatedIdentity: { capacity: 1, refillPeriodMs: 1_000, maxEntries: 1 },
    });
    expect(unavailable.checkPreAuthentication("source")).toMatchObject({
      allowed: false,
      reason: "clock_unavailable",
      retryAfterSeconds: 1,
    });
    expect(JSON.stringify(unavailable.checkAuthenticated({ ownerId: "o", clientId: "c" }))).not.toContain(secret);
  });

  it("does not refill when an injected clock moves backwards", () => {
    const clock = new FakeClock();
    clock.value = 100;
    const { limiter } = rateLimiter(clock, { preCapacity: 1 });
    expect(limiter.checkPreAuthentication("source").allowed).toBe(true);

    clock.value = 50;
    expect(limiter.checkPreAuthentication("source")).toMatchObject({
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: 10,
    });
  });

  it("builds a generic frozen 429 response with integer Retry-After", () => {
    const { limiter } = rateLimiter(undefined, { preCapacity: 1 });
    limiter.checkPreAuthentication("source");
    const denied = limiter.checkPreAuthentication("source");
    const response = safeHttpRateLimitRejection(denied);

    expect(response).toEqual({
      status: 429,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "retry-after": "10",
      },
      body: '{"error":"rate_limited","message":"Rate limited. Retry after the number of seconds in retry_after_seconds or the Retry-After header.","retry_after_seconds":10}\n',
    });
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.headers)).toBe(true);

    const forged = new Proxy({ allowed: false, retryAfterSeconds: 86_400 }, {
      get() {
        throw new Error("forged-secret");
      },
    }) as unknown as HttpRateLimitDecision;
    expect(safeHttpRateLimitRejection(forged).headers["retry-after"]).toBe("1");
  });

  it("rejects invalid policy bounds during startup composition", () => {
    for (const preAuthentication of [
      { capacity: 0, refillPeriodMs: 1_000, maxEntries: 1 },
      { capacity: 1, refillPeriodMs: 0, maxEntries: 1 },
      { capacity: 1, refillPeriodMs: 1_000, maxEntries: 0 },
    ]) {
      expect(() =>
        createHttpRateLimiter({
          preAuthentication,
          authenticatedIdentity: {
            capacity: 1,
            refillPeriodMs: 1_000,
            maxEntries: 1,
          },
        })
      ).toThrow(TypeError);
    }
  });
});
