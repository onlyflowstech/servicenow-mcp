/**
 * Test-worker coverage of the ways the classifier, the status and the cause
 * texts could be steered by a hostile or unusual input, and of the loaders'
 * handling of a cancellation. The pause is NOT mocked here: a cancellation
 * during the real pause must end it at once, with no second read.
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import {
  isServiceNowRequestCancellation,
  pauseUnlessServiceNowRequestCancelled,
  runWithServiceNowRequestSignal,
  type ServiceNowOperations,
} from "../src/client.js";
import { FieldPolicyError, fieldPolicyDenialMessage, isFieldPolicyError, typeHiddenFieldNames } from "../src/field-policy.js";
import {
  classifyReadFailure,
  fieldTypesProblemText,
  loadFieldTypes,
  loadFieldTypesInPlan,
  retryTransientOnce,
  runWithHiddenFieldScope,
  type FieldTypesReadFailure,
} from "../src/hidden-values.js";
import {
  createInstanceHibernatingError,
  createRedirectedError,
  createToolError,
  recordTrustedHttpStatus,
  trustedHttpStatus,
  trustedToolErrorDescriptor,
} from "../src/tool-error.js";
import { fieldTypeAnswer, type FieldTypeFixture } from "./fixtures/field-types.js";

const FIXTURE: FieldTypeFixture = {
  dictionary: [{ name: "u_vault", element: "key", internal_type: "password2" }],
  parents: { u_vault_child: ["u_vault"] },
  absent: ["u_ghost"],
  views: {},
};

function http(status: number, category: "upstream" | "authorization" = "upstream"): Error {
  return recordTrustedHttpStatus(
    createToolError(category, category === "authorization" ? "retry_after_correction" : "do_not_retry"),
    status
  );
}

/** A getWithMeta/get double over the fixture; `fail` may throw for a read (its read number counts from 1). */
function double(fail?: (path: string, n: number) => Error | undefined) {
  const reads: string[] = [];
  const answer = (path: string, params: Record<string, string> = {}) => {
    reads.push(path);
    const failure = fail?.(path, reads.filter((read) => read === path).length);
    if (failure !== undefined) throw failure;
    return fieldTypeAnswer(path, params, FIXTURE) ?? { data: { result: [] }, status: 200, headers: new Headers() };
  };
  const ops = {
    getWithMeta: async (path: string, params?: Record<string, string>) => answer(path, params),
    get: async (path: string, params?: Record<string, string>) => answer(path, params).data,
    post: async () => null,
    patch: async () => null,
    delete: async () => ({ status: 204 }),
    postBinary: async () => null,
    getRaw: async () => {
      throw new Error("unused");
    },
  } as unknown as ServiceNowOperations;
  return { ops, count: (suffix: string) => reads.filter((read) => read.endsWith(suffix)).length };
}

describe("a forged error is never trusted", () => {
  const trusted = http(403, "authorization");

  it("reads nothing from an object that only looks like an issued error", () => {
    const lookalikes: unknown[] = [
      { status: 403, category: "authorization", kind: "refused" },
      Object.assign(new Error(trusted.message), { name: "ServiceNowToolError", status: 403 }),
      Object.freeze(Object.assign(new Error(trusted.message), { name: "ServiceNowToolError" })),
      // Inheriting from an issued error carries no provenance: it is not the object that was issued.
      Object.create(trusted),
      { ...trusted },
      JSON.parse(JSON.stringify({ name: trusted.name, message: trusted.message })),
      "authorization",
      403,
      null,
    ];
    for (const candidate of lookalikes) {
      expect(trustedToolErrorDescriptor(candidate), String(candidate)).toBeUndefined();
      expect(trustedHttpStatus(candidate), String(candidate)).toBeUndefined();
      expect(classifyReadFailure(candidate)).toEqual({ kind: "failed" });
    }
  });

  it("is not made trusted by recording a status on it", () => {
    const forged = recordTrustedHttpStatus(Object.assign(new Error("x"), { name: "ServiceNowToolError" }), 403);
    expect(trustedHttpStatus(forged)).toBeUndefined();
    expect(classifyReadFailure(forged)).toEqual({ kind: "failed" });
  });

  it("is read as failed by the loaders, which then refuse rather than guess a cause", async () => {
    const forged = Object.assign(new Error("Forbidden"), { status: 403, category: "authorization" });
    const dispatcher = await loadFieldTypes(
      double((path) => (path.endsWith("/sys_dictionary") ? forged : undefined)).ops,
      ["u_vault"]
    );
    expect(dispatcher).toMatchObject({ state: "unavailable", cause: { kind: "failed" } });
    const plan = await loadFieldTypesInPlan(double((path) => (path.endsWith("/sys_dictionary") ? forged : undefined)).ops, ["u_vault"]);
    expect(plan.typesFailure).toEqual({ kind: "failed" });
    expect(plan.types.state).toBe("unavailable");
  });

  it("is not retried, whatever it claims to be", async () => {
    const forged = Object.assign(new Error("Service Unavailable"), { status: 503, category: "upstream" });
    const reads = double((path) => (path.endsWith("/sys_dictionary") ? forged : undefined));
    await loadFieldTypes(reads.ops, ["u_vault"]);
    expect(reads.count("/sys_dictionary")).toBe(1);
  });
});

describe("the status in a text", () => {
  it("is kept only as an integer from 100 to 599, at the edges too", () => {
    for (const status of [100, 101, 599]) {
      expect(trustedHttpStatus(http(status)), String(status)).toBe(status);
    }
    for (const status of [0, 99, 600, 1000, -403, 403.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(trustedHttpStatus(http(status)), String(status)).toBeUndefined();
    }
    for (const status of ["403", "403; DROP", null, undefined, {}, [403], 403n] as unknown[]) {
      expect(trustedHttpStatus(recordTrustedHttpStatus(createToolError("upstream", "do_not_retry"), status as number))).toBeUndefined();
    }
  });

  it("is interpolated by the builder only when it is such an integer, whatever a caller passes", () => {
    for (const status of ["403", "403; DROP TABLE", 99, 600, Number.NaN, Number.POSITIVE_INFINITY, -1, 403.5, {}, [403]] as unknown[]) {
      for (const kind of ["refused", "failed", "transient"] as const) {
        const text = fieldTypesProblemText({ surface: "dispatcher", failure: { kind, status } as unknown as FieldTypesReadFailure });
        expect(text, `${kind} ${String(status)}`).not.toMatch(/HTTP/u);
        expect(text).not.toContain("DROP");
      }
    }
    const text = fieldTypesProblemText({ surface: "dispatcher", failure: { kind: "refused", status: 100 } });
    expect(text).toContain("(HTTP 100)");
    expect(fieldTypesProblemText({ surface: "dispatcher", failure: { kind: "transient", status: 599, retried: true } })).toContain("HTTP 599 after one retry");
  });

  it("is carried by the error the retry gives up on, beside the fact that it was retried", async () => {
    const thrown = await retryTransientOnce(
      async () => {
        throw http(502);
      },
      { pauseMs: 0 }
    ).catch((e: unknown) => e);
    expect(classifyReadFailure(thrown)).toEqual({ kind: "transient", status: 502, retried: true });
  });
});

describe("an upstream error with no status and no reason", () => {
  /**
   * Only an error whose issuer allows the request to be sent again is read as
   * a network failure. One marked `do_not_retry` (the shape of the client's
   * cross-origin-redirect error on the ATF form path) is a failed read, is not
   * retried, and is worded as a read that failed.
   */
  it("is a failed read, and is not retried, when its retry advice is do_not_retry", async () => {
    const crossOrigin = createToolError("upstream", "do_not_retry");
    expect(classifyReadFailure(crossOrigin)).toEqual({ kind: "failed" });
    let calls = 0;
    const thrown = await retryTransientOnce(
      async () => {
        calls += 1;
        throw crossOrigin;
      },
      { pauseMs: 0 }
    ).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(classifyReadFailure(thrown)).toEqual({ kind: "failed" });
    expect(fieldTypesProblemText({ surface: "dispatcher", failure: classifyReadFailure(thrown) })).toBe(
      "Field types could not be read: the sys_dictionary read failed. No values were returned."
    );
  });

  it("is a network failure when its retry advice allows another try", () => {
    expect(classifyReadFailure(createToolError("upstream", "retry_if_safe_and_idempotent"))).toMatchObject({ kind: "transient" });
  });

  it("is not so for an upstream error that has a reason (a redirect, a hibernating instance)", () => {
    expect(classifyReadFailure(createRedirectedError())).toEqual({ kind: "failed" });
    expect(classifyReadFailure(createInstanceHibernatingError())).toEqual({ kind: "transient" });
  });
});

describe("a cancellation is not a cause", () => {
  it("rethrows from loadFieldTypes when the call is cancelled during the retry's pause, with no second read", async () => {
    const reads = double((path) => (path.endsWith("/sys_dictionary") ? http(503) : undefined));
    const controller = new AbortController();
    const pending = runWithServiceNowRequestSignal(controller.signal, () => loadFieldTypes(reads.ops, ["u_vault"]));
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const started = Date.now();
    const thrown = await pending.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(isServiceNowRequestCancellation(thrown)).toBe(true);
    // The pause is 300 ms: ended at once by the abort, not waited out.
    expect(Date.now() - started).toBeLessThan(250);
    expect(reads.count("/sys_dictionary")).toBe(1);
  });

  it("is not read as a cause when a read itself throws one: it rethrows, and nothing is remembered", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const cancellation = await pauseUnlessServiceNowRequestCancelled(0, aborted.signal).catch((error: unknown) => error);
    expect(isServiceNowRequestCancellation(cancellation)).toBe(true);
    const reads = double((path, n) => (path.endsWith("/sys_dictionary") && n === 1 ? (cancellation as Error) : undefined));
    const first = await loadFieldTypes(reads.ops, ["u_vault"]).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(first).toBe(cancellation);
    expect(reads.count("/sys_dictionary")).toBe(1);
    const plan = await loadFieldTypesInPlan(reads.ops, ["u_vault"]);
    expect(plan.types.state).toBe("available");
  });

  it("skips the retry when the call was cancelled while the plan loader's read was in flight, and rethrows", async () => {
    const controller = new AbortController();
    const reads = double((path, n) => {
      if (path.endsWith("/sys_dictionary") && n === 1) {
        // The call is cancelled while the first read is in flight and the read fails.
        controller.abort();
        return http(503);
      }
      return undefined;
    });
    const thrown = await loadFieldTypesInPlan(reads.ops, ["u_vault"], { signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => error
    );
    // The call was cancelled: the loader rethrows rather than report the read's failure as a cause, and makes no retry.
    expect(thrown).toBeDefined();
    expect(reads.count("/sys_dictionary")).toBe(1);
  });

  it("rethrows a cancellation during the plan loader's chain retry pause", async () => {
    const controller = new AbortController();
    const reads = double((path) => (path.endsWith("/sys_db_object") ? http(500) : undefined));
    const pending = loadFieldTypesInPlan(reads.ops, ["u_vault_child"], { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const thrown = await pending.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(isServiceNowRequestCancellation(thrown)).toBe(true);
    expect(reads.count("/sys_db_object")).toBe(1);
  });
});

describe("a table outside the call's resolved plan (the one cause that is this server's own plan)", () => {
  it("is refused with a policy error naming the table, in a scope that denies unresolved tables", () => {
    const scope = { tables: new Map([["u_vault", new Set(["key"])]]), unresolved: "deny" as const };
    runWithHiddenFieldScope(scope, () => {
      expect([...typeHiddenFieldNames("u_vault")]).toEqual(["key"]);
      let thrown: unknown;
      try {
        typeHiddenFieldNames("u_elsewhere");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(FieldPolicyError);
      expect(isFieldPolicyError(thrown)).toBe(true);
      expect(fieldPolicyDenialMessage(thrown as FieldPolicyError)).toBe(
        "Access denied by policy: \"u_elsewhere\" is not part of this call's plan, so its field types were not read."
      );
    });
  });

  it("falls back to names only under the opt-in, with no refusal", () => {
    const scope = { tables: new Map<string, ReadonlySet<string>>(), unresolved: "names_only" as const };
    runWithHiddenFieldScope(scope, () => {
      expect([...typeHiddenFieldNames("u_elsewhere")]).toEqual([]);
    });
  });
});
