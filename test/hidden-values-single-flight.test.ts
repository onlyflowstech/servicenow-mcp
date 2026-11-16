/**
 * Concurrent calls in one credential scope share one field-type read.
 *
 * Each "call" gets its own cached wrapper over the same scope, as the
 * dispatcher builds one per call. The double counts the lookup reads and can
 * hold them open, fail them, or cancel them. A cancellation is a test error
 * the client's own predicate is told to recognise (the real class is private).
 * Synthetic data only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", async (original) => ({
  ...(await original<typeof import("../src/client.js")>()),
  isServiceNowRequestCancellation: (error: unknown) =>
    error instanceof Error && error.name === "TestCancellation",
}));

import { loadFieldTypes, hiddenTypedFields, type FieldTypes } from "../src/hidden-values.js";
import { createCachedServiceNowOperations } from "../src/metadata-cache.js";
import { fieldTypeAnswer, type FieldTypeFixture } from "./fixtures/field-types.js";

const FIXTURE: FieldTypeFixture = {
  dictionary: [{ name: "u_vault", element: "key", internal_type: "password2" }],
  parents: {},
  absent: [],
  views: {},
};

type Behaviour = "answer" | "fail" | "cancel";

function instance(dictionary: () => Behaviour, delayMs = 20) {
  const reads: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const operations = {
    getWithMeta: async (path: string, params: Record<string, string> = {}) => {
      reads.push(path);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (path.endsWith("/sys_dictionary")) {
          const behaviour = dictionary();
          if (behaviour === "fail") throw Object.assign(new Error("Forbidden"), { status: 403 });
          if (behaviour === "cancel") throw Object.assign(new Error("cancelled"), { name: "TestCancellation" });
        }
        return fieldTypeAnswer(path, params, FIXTURE) ?? { data: { result: [] }, status: 200, headers: new Headers() };
      } finally {
        inFlight -= 1;
      }
    },
    get: async () => null,
    post: async () => null,
    patch: async () => null,
    delete: async () => ({ status: 204 }),
    postBinary: async () => null,
    getRaw: async () => {
      throw new Error("unused");
    },
  };
  const scope = `single-flight-${Math.random()}`;
  // One wrapper per call, one scope for all of them.
  const call = (config: Parameters<typeof createCachedServiceNowOperations>[2] = { ttlMs: 200, smallReadBytes: 0 }) =>
    loadFieldTypes(createCachedServiceNowOperations(operations as never, scope, config), ["u_vault"]);
  return {
    reads,
    call,
    count: (suffix: string) => reads.filter((path) => path.endsWith(suffix)).length,
    maxInFlight: () => maxInFlight,
  };
}

const hidesKey = (types: FieldTypes) => hiddenTypedFields(types, "u_vault")?.has("key") === true;

describe("field-type single flight", () => {
  it("20 concurrent cold calls make exactly one dictionary read and one chain read, in parallel", async () => {
    const h = instance(() => "answer");
    const results = await Promise.all(Array.from({ length: 20 }, () => h.call()));
    expect(results.every(hidesKey)).toBe(true);
    expect(h.count("/sys_dictionary")).toBe(1);
    expect(h.count("/sys_db_object")).toBe(1);
    // The two reads are independent and overlap: one round trip, not two.
    expect(h.maxInFlight()).toBe(2);
    // Warm: no request.
    await h.call();
    expect(h.reads).toHaveLength(2);
  });

  it("shares a refused read as the unavailable state, then retries once that state expires", async () => {
    let refuse = true;
    const h = instance(() => (refuse ? "fail" : "answer"));
    const results = await Promise.all(Array.from({ length: 20 }, () => h.call()));
    expect(results.every((types) => types.state === "unavailable")).toBe(true);
    expect(h.count("/sys_dictionary")).toBe(1);
    refuse = false;
    // Within the profile's TTL (200 ms here) the refusal is remembered...
    expect((await h.call()).state).toBe("unavailable");
    expect(h.count("/sys_dictionary")).toBe(1);
    // ...and after it the next call reads again, and succeeds.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(hidesKey(await h.call())).toBe(true);
    expect(h.count("/sys_dictionary")).toBe(2);
  });

  it("does not hand a cancelled read to waiters: they read once more for themselves", async () => {
    let first = true;
    const h = instance(() => {
      if (first) {
        first = false;
        return "cancel";
      }
      return "answer";
    });
    const initiator = h.call();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const waiters = Array.from({ length: 19 }, () => h.call());
    await expect(initiator).rejects.toThrow("cancelled");
    const results = await Promise.all(waiters);
    expect(results.every(hidesKey)).toBe(true);
    // The cancelled read plus one shared retry; nothing failed was kept.
    expect(h.count("/sys_dictionary")).toBe(2);
    await h.call();
    expect(h.count("/sys_dictionary")).toBe(2);
  });

  it("memoizes whatever the profile's cache table list says", async () => {
    for (const tables of [[], ["syslog"]]) {
      const h = instance(() => "answer");
      await h.call({ ttlMs: 60_000, smallReadBytes: 0, tables });
      await h.call({ ttlMs: 60_000, smallReadBytes: 0, tables });
      expect(h.reads, JSON.stringify(tables)).toHaveLength(2);
    }
  });
});
