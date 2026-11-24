/**
 * Why a field-types read gave no answer: the classifier and the one retry.
 *
 * Both read only what this server issued (a trusted error's category, reason
 * and recorded HTTP status), never the text of an error. Synthetic errors only.
 */
import { describe, expect, it } from "vitest";

import { isServiceNowRequestCancellation, pauseUnlessServiceNowRequestCancelled } from "../src/client.js";
import {
  FIELD_TYPES_RETRY_PAUSE_MS,
  classifyReadFailure,
  retryTransientOnce,
  type FieldTypesRetryBudget,
} from "../src/hidden-values.js";
import {
  createBasicAuthRestrictedError,
  createHtmlResponseError,
  createInstanceHibernatingError,
  createRedirectedError,
  createToolError,
  recordTrustedHttpStatus,
  trustedHttpStatus,
  type ToolErrorCategory,
} from "../src/tool-error.js";

/** An error as the client issues it for an HTTP status. */
function http(status: number, category: ToolErrorCategory = "upstream"): Error {
  return recordTrustedHttpStatus(
    createToolError(category, category === "authentication" || category === "authorization" ? "retry_after_correction" : "do_not_retry"),
    status
  );
}

describe("trusted HTTP status", () => {
  it("is kept only for an error this server issued, and only as an integer from 100 to 599", () => {
    expect(trustedHttpStatus(http(503))).toBe(503);
    for (const status of [99, 600, 503.5, Number.NaN, -1]) {
      expect(trustedHttpStatus(recordTrustedHttpStatus(createToolError("upstream", "do_not_retry"), status)), String(status)).toBeUndefined();
    }
    // A look-alike carries no provenance, whatever fields it has.
    expect(trustedHttpStatus(Object.assign(new Error("x"), { status: 403 }))).toBeUndefined();
    expect(trustedHttpStatus(recordTrustedHttpStatus(new Error("x"), 403))).toBeUndefined();
    expect(trustedHttpStatus(null)).toBeUndefined();
    expect(trustedHttpStatus("403")).toBeUndefined();
  });
});

describe("classifyReadFailure", () => {
  it("reads a 401 or 403 as refused, with the recorded status", () => {
    expect(classifyReadFailure(http(401, "authentication"))).toEqual({ kind: "refused", status: 401 });
    expect(classifyReadFailure(http(403, "authorization"))).toEqual({ kind: "refused", status: 403 });
    expect(classifyReadFailure(recordTrustedHttpStatus(createBasicAuthRestrictedError(), 401))).toEqual({ kind: "refused", status: 401 });
    // Without a recorded status the category says which.
    expect(classifyReadFailure(createToolError("authorization", "retry_after_correction"))).toEqual({ kind: "refused", status: 403 });
  });

  it("reads a timeout, a 429, a 5xx and a network failure as transient", () => {
    expect(classifyReadFailure(createToolError("timeout", "retry_if_safe_and_idempotent"))).toEqual({ kind: "transient", timeout: true });
    expect(classifyReadFailure(http(429, "rate_limit"))).toEqual({ kind: "transient", status: 429 });
    expect(classifyReadFailure(http(500))).toEqual({ kind: "transient", status: 500 });
    expect(classifyReadFailure(http(503))).toEqual({ kind: "transient", status: 503 });
    // No status and no reason: the request never got an answer.
    expect(classifyReadFailure(createToolError("upstream", "retry_if_safe_and_idempotent"))).toEqual({ kind: "transient" });
    expect(classifyReadFailure(createInstanceHibernatingError("x.service-now.com"))).toEqual({ kind: "transient" });
  });

  it("reads anything else as failed, with the status when there is one", () => {
    expect(classifyReadFailure(http(400))).toEqual({ kind: "failed", status: 400 });
    expect(classifyReadFailure(http(404, "not_found"))).toEqual({ kind: "failed", status: 404 });
    expect(classifyReadFailure(createHtmlResponseError())).toEqual({ kind: "failed" });
    expect(classifyReadFailure(createRedirectedError())).toEqual({ kind: "failed" });
    expect(classifyReadFailure(createToolError("internal", "do_not_retry"))).toEqual({ kind: "failed" });
    // An error nothing here issued is not trusted for anything, its fields included.
    expect(classifyReadFailure(Object.assign(new Error("Forbidden"), { status: 403, category: "authorization" }))).toEqual({
      kind: "failed",
    });
    expect(classifyReadFailure(undefined)).toEqual({ kind: "failed" });
  });

  it("never carries text of the error", () => {
    const hostile = Object.assign(new Error("password=hunter2 https://x.example/secret"), { status: 500 });
    expect(JSON.stringify(classifyReadFailure(hostile))).toBe('{"kind":"failed"}');
  });
});

describe("retryTransientOnce", () => {
  const pauseMs = 0;
  const reads = (...outcomes: Array<"ok" | Error>) => {
    let calls = 0;
    return {
      read: async () => {
        const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!;
        calls += 1;
        if (outcome !== "ok") throw outcome;
        return "answer";
      },
      calls: () => calls,
    };
  };

  it("keeps the pause short", () => {
    expect(FIELD_TYPES_RETRY_PAUSE_MS).toBe(300);
  });

  it("reads once when the first read answers", async () => {
    const h = reads("ok");
    expect(await retryTransientOnce(h.read, { pauseMs })).toBe("answer");
    expect(h.calls()).toBe(1);
  });

  it("retries a timeout, a 5xx and a network failure once, and returns the retry's answer", async () => {
    for (const first of [
      createToolError("timeout", "retry_if_safe_and_idempotent"),
      http(500),
      http(503),
      createToolError("upstream", "retry_if_safe_and_idempotent"),
    ]) {
      const h = reads(first, "ok");
      expect(await retryTransientOnce(h.read, { pauseMs })).toBe("answer");
      expect(h.calls()).toBe(2);
    }
  });

  it("gives up after one retry, throws the second failure, and has it classified as retried", async () => {
    const h = reads(http(503), http(502));
    const error = await retryTransientOnce(h.read, { pauseMs }).catch((thrown: unknown) => thrown);
    expect(h.calls()).toBe(2);
    expect(classifyReadFailure(error)).toEqual({ kind: "transient", status: 502, retried: true });
  });

  it("never retries a 429, a 4xx, a refusal, a hibernating instance or an unissued error", async () => {
    for (const failure of [
      http(429, "rate_limit"),
      http(400),
      http(401, "authentication"),
      http(403, "authorization"),
      http(404, "not_found"),
      createInstanceHibernatingError(),
      createHtmlResponseError(),
      new Error("anything else"),
    ]) {
      const h = reads(failure, "ok");
      await expect(retryTransientOnce(h.read, { pauseMs })).rejects.toBe(failure);
      expect(h.calls()).toBe(1);
    }
  });

  it("is spent once for every read that shares its budget", async () => {
    const budget: FieldTypesRetryBudget = { spent: false };
    const first = reads(http(500), "ok");
    expect(await retryTransientOnce(first.read, { pauseMs, budget })).toBe("answer");
    expect(budget.spent).toBe(true);
    const second = reads(http(500), "ok");
    await expect(retryTransientOnce(second.read, { pauseMs, budget })).rejects.toThrow();
    expect(second.calls()).toBe(1);
  });

  it("skips the retry when the signal is already aborted, and throws the first error", async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = http(500);
    const h = reads(failure, "ok");
    await expect(retryTransientOnce(h.read, { pauseMs, signal: controller.signal })).rejects.toBe(failure);
    expect(h.calls()).toBe(1);
  });

  it("rethrows a cancellation during the pause, and makes no second read", async () => {
    const controller = new AbortController();
    const h = reads(http(500), "ok");
    const pending = retryTransientOnce(h.read, { pauseMs: 60_000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const thrown = await pending.catch((error: unknown) => error);
    expect(isServiceNowRequestCancellation(thrown)).toBe(true);
    expect(h.calls()).toBe(1);
  });

  it("rethrows a cancellation from the read itself, without a retry", async () => {
    const aborted = new AbortController();
    aborted.abort();
    let calls = 0;
    const cancelled = async () => {
      calls += 1;
      // The client's own cancellation error, as a read that was cancelled throws it.
      await pauseUnlessServiceNowRequestCancelled(0, aborted.signal);
    };
    const thrown = await retryTransientOnce(cancelled, { pauseMs, signal: new AbortController().signal }).catch((error: unknown) => error);
    expect(isServiceNowRequestCancellation(thrown)).toBe(true);
    expect(calls).toBe(1);
  });
});
