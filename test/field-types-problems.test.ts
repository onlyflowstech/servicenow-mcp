/**
 * What the loaders report for a table or a read that gave no answer, and the
 * one builder that words it. No table name is guessed, no upstream text is
 * kept, and "Access denied by policy" is left to this server's own policy.
 * Synthetic data only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", async (original) => ({
  ...(await original<typeof import("../src/client.js")>()),
  pauseUnlessServiceNowRequestCancelled: async () => {},
}));

import type { ServiceNowOperations } from "../src/client.js";
import {
  fieldTypesProblemText,
  fieldTypesRefusal,
  loadFieldTypes,
  loadFieldTypesInPlan,
  planHierarchyProblem,
  planTypesProblem,
  type FieldTypes,
  type FieldTypesProblemInput,
  type FieldTypesReadFailure,
  type FieldTypesTableProblem,
} from "../src/hidden-values.js";
import { createCachedServiceNowOperations } from "../src/metadata-cache.js";
import { createToolError, recordTrustedHttpStatus } from "../src/tool-error.js";
import { payloadRefusal, preparePayload } from "../src/tools/platform-view-payload.js";
import { fieldTypeAnswer, type FieldTypeFixture } from "./fixtures/field-types.js";

const FIXTURE: FieldTypeFixture = {
  dictionary: [{ name: "u_vault", element: "key", internal_type: "password2" }],
  parents: { u_vault_child: ["u_vault"] },
  absent: ["u_ghost"],
  views: {},
};

function http(status: number): Error {
  return recordTrustedHttpStatus(
    createToolError(status === 403 ? "authorization" : "upstream", status === 403 ? "retry_after_correction" : "do_not_retry"),
    status
  );
}

/** A getWithMeta/get double over the fixture; `fail` may throw for a read. */
function double(fixture: FieldTypeFixture, fail?: (path: string, params: Record<string, string>, n: number) => Error | undefined) {
  const reads: { path: string; params: Record<string, string> }[] = [];
  const answer = (path: string, params: Record<string, string> = {}) => {
    reads.push({ path, params });
    const failure = fail?.(path, params, reads.filter((read) => read.path === path).length);
    if (failure !== undefined) throw failure;
    return fieldTypeAnswer(path, params, fixture) ?? { data: { result: [] }, status: 200, headers: new Headers() };
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
  return { ops, reads, count: (suffix: string) => reads.filter((read) => read.path.endsWith(suffix)).length };
}

describe("loadFieldTypes: why a table is unresolved", () => {
  it("says a table does not exist when sys_db_object showed rows and has none for it", async () => {
    const { ops } = double(FIXTURE);
    const types = await loadFieldTypes(ops, ["u_vault", "u_ghost"]);
    expect(types.state).toBe("available");
    expect(types.problems?.get("u_ghost")).toEqual({ kind: "not_found" });
    expect(types.problems?.has("u_vault")).toBe(false);
  });

  it("does not say so when the read showed no rows at all: it could not see them", async () => {
    const { ops } = double({ ...FIXTURE, absent: ["u_ghost", "sys_db_object", "u_vault"] });
    const types = await loadFieldTypes(ops, ["u_vault", "u_ghost"]);
    for (const table of ["u_vault", "u_ghost"]) {
      expect(types.problems?.get(table), table).toEqual({ kind: "read", read: "sys_db_object", failure: { kind: "refused", status: 200 } });
    }
  });

  it("asks for sys_db_object's own row in the same read: one more name, one more row", async () => {
    const { ops, reads } = double(FIXTURE);
    await loadFieldTypes(ops, ["u_vault"]);
    const read = reads.find((entry) => entry.path.endsWith("/sys_db_object"))!;
    expect(read.params.sysparm_query).toBe("nameINu_vault,sys_db_object");
    expect(read.params.sysparm_limit).toBe("2");
    // Asked for itself, it is not asked for twice.
    const own = double(FIXTURE);
    await loadFieldTypes(own.ops, ["sys_db_object"]);
    expect(own.reads.find((entry) => entry.path.endsWith("/sys_db_object"))!.params.sysparm_query).toBe("nameINsys_db_object");
  });

  it("says a read failed, not that a table is missing, and does not remember the failure", async () => {
    const { ops, count } = double(FIXTURE, (path, _params, n) => (path.endsWith("/sys_db_object") && n === 1 ? http(403) : undefined));
    const scope = `problems-${Math.random()}`;
    const cached = createCachedServiceNowOperations(ops as never, scope, { ttlMs: 60_000, smallReadBytes: 0 });
    const first = await loadFieldTypes(cached, ["u_vault"]);
    expect(first.problems?.get("u_vault")).toEqual({ kind: "read", failure: { kind: "refused", status: 403 } });
    const second = await loadFieldTypes(cached, ["u_vault"]);
    expect(second.problems).toBeUndefined();
    expect(count("/sys_db_object")).toBe(2);
  });

  it("keeps where an incomplete chain stopped, and why, when it remembers the verdict", async () => {
    const { ops, count } = double({ ...FIXTURE, hiddenRows: ["u_vault"] });
    const cached = createCachedServiceNowOperations(ops as never, `problems-${Math.random()}`, { ttlMs: 60_000, smallReadBytes: 0 });
    const expected = { kind: "chain", at: "u_vault_child", gap: "parent_unreadable" };
    expect((await loadFieldTypes(cached, ["u_vault_child"])).problems?.get("u_vault_child")).toEqual(expected);
    expect((await loadFieldTypes(cached, ["u_vault_child"])).problems?.get("u_vault_child")).toEqual(expected);
    expect(count("/sys_db_object")).toBe(1);
  });

  it("gives the dictionary's cause when it is unavailable", async () => {
    const { ops } = double(FIXTURE, (path) => (path.endsWith("/sys_dictionary") ? http(403) : undefined));
    expect(await loadFieldTypes(ops, ["u_vault"])).toMatchObject({ state: "unavailable", cause: { kind: "refused", status: 403 } });
  });
});

describe("loadFieldTypes: chains are kept while the dictionary is unavailable", () => {
  const cached = (ops: ServiceNowOperations) =>
    createCachedServiceNowOperations(ops as never, `kept-${Math.random()}`, { ttlMs: 60_000, smallReadBytes: 0 });

  it("reads sys_db_object once across calls while a refusal of the dictionary is remembered, and still returns the cause", async () => {
    const { ops, count } = double(FIXTURE, (path) => (path.endsWith("/sys_dictionary") ? http(403) : undefined));
    const scoped = cached(ops);
    for (let call = 0; call < 3; call += 1) {
      expect(await loadFieldTypes(scoped, ["u_vault"])).toMatchObject({ state: "unavailable", cause: { kind: "refused", status: 403 } });
    }
    expect(count("/sys_dictionary")).toBe(1);
    expect(count("/sys_db_object")).toBe(1);
  });

  it("keeps an incomplete chain, with where it stopped, and returns nothing resolved", async () => {
    const { ops, count } = double({ ...FIXTURE, hiddenRows: ["u_vault"] }, (path) => (path.endsWith("/sys_dictionary") ? http(403) : undefined));
    const scoped = cached(ops);
    const first = await loadFieldTypes(scoped, ["u_vault_child"]);
    expect(first.state).toBe("unavailable");
    expect(first.problems).toBeUndefined();
    await loadFieldTypes(scoped, ["u_vault_child"]);
    expect(count("/sys_db_object")).toBe(1);
    // Once the dictionary reads, the kept verdict is what the table's problem says.
    const { ops: later } = double({ ...FIXTURE, hiddenRows: ["u_vault"] });
    const withDictionary = await loadFieldTypes(createCachedServiceNowOperations(later as never, "unused", { ttlMs: 60_000, smallReadBytes: 0 }), ["u_vault_child"]);
    expect(withDictionary.problems?.get("u_vault_child")).toEqual({ kind: "chain", at: "u_vault_child", gap: "parent_unreadable" });
  });

  it("never keeps a failed chain read: it is read again, and kept once it answers", async () => {
    // The first call's read and its one retry both fail.
    const { ops, count } = double(FIXTURE, (path, _p, n) => {
      if (path.endsWith("/sys_dictionary")) return http(403);
      return path.endsWith("/sys_db_object") && n <= 2 ? http(500) : undefined;
    });
    const scoped = cached(ops);
    await loadFieldTypes(scoped, ["u_vault"]);
    expect(count("/sys_db_object")).toBe(2);
    await loadFieldTypes(scoped, ["u_vault"]);
    expect(count("/sys_db_object")).toBe(3);
    await loadFieldTypes(scoped, ["u_vault"]);
    expect(count("/sys_db_object")).toBe(3);
  });

  it("never keeps a table that is not there, or the anchor's own chain", async () => {
    const { ops, count } = double(FIXTURE, (path) => (path.endsWith("/sys_dictionary") ? http(403) : undefined));
    const scoped = cached(ops);
    await loadFieldTypes(scoped, ["u_ghost"]);
    await loadFieldTypes(scoped, ["u_ghost"]);
    expect(count("/sys_db_object")).toBe(2);
    // The anchor was asked for beside u_ghost but is not remembered: asking for it reads again.
    await loadFieldTypes(scoped, ["sys_db_object"]);
    expect(count("/sys_db_object")).toBe(3);
  });
});

describe("loadFieldTypesInPlan: causes", () => {
  const WORLD_FIXTURE: FieldTypeFixture = { ...FIXTURE, parents: { u_vault_child: ["u_vault"] } };

  it("retries a blip on the dictionary once, and the chain levels share one retry", async () => {
    const dictionary = double(WORLD_FIXTURE, (path, _p, n) => (path.endsWith("/sys_dictionary") && n === 1 ? http(500) : undefined));
    const loaded = await loadFieldTypesInPlan(dictionary.ops, ["u_vault_child"]);
    expect(dictionary.count("/sys_dictionary")).toBe(2);
    expect(loaded.types.state).toBe("available");
    expect(loaded.typesFailure).toBeUndefined();

    // Both levels of the chain would fail once; only the first is retried.
    const chains = double(WORLD_FIXTURE, (path, _p, n) => (path.endsWith("/sys_db_object") && n % 2 === 1 ? http(500) : undefined));
    const partial = await loadFieldTypesInPlan(chains.ops, ["u_vault_child"]);
    expect(chains.count("/sys_db_object")).toBe(3);
    expect(partial.hierarchyRead).toBe(false);
    expect(partial.chainsFailure).toEqual({ kind: "transient", status: 500 });
  });

  it("says why the dictionary is unavailable", async () => {
    const refused = await loadFieldTypesInPlan(double(FIXTURE, (path) => (path.endsWith("/sys_dictionary") ? http(403) : undefined)).ops, ["u_vault"]);
    expect(refused.typesFailure).toEqual({ kind: "refused", status: 403 });
    expect(refused.types).toMatchObject({ state: "unavailable", cause: { kind: "refused", status: 403 } });
    const empty = await loadFieldTypesInPlan(double({ ...FIXTURE, dictionary: [] }).ops, ["u_vault"]);
    expect(empty.typesFailure).toEqual({ kind: "refused", status: 200 });
    const bad = await loadFieldTypesInPlan(double(FIXTURE, (path) => (path.endsWith("/sys_dictionary") ? http(400) : undefined)).ops, ["u_vault"]);
    expect(bad.typesFailure).toEqual({ kind: "failed", status: 400 });
  });

  it("says field policy kept a read from being made as a policy cause", async () => {
    const off = await loadFieldTypesInPlan(double(FIXTURE).ops, ["u_vault"], { readChains: false, readTypes: false });
    expect(off.typesFailure).toEqual({ kind: "policy", table: "sys_dictionary" });
    expect(off.chainsFailure).toEqual({ kind: "policy", table: "sys_db_object" });
    expect(off.hierarchyRead).toBe(false);
  });

  it("names a missing table only when the anchor row came back", async () => {
    const seen = await loadFieldTypesInPlan(double(FIXTURE).ops, ["u_vault", "u_ghost"]);
    expect([...(seen.missing ?? [])]).toEqual(["u_ghost"]);
    expect(seen.chainsFailure).toBeUndefined();
    const blind = await loadFieldTypesInPlan(double({ ...FIXTURE, absent: ["u_ghost", "sys_db_object"] }).ops, ["u_ghost"]);
    expect(blind.missing).toBeUndefined();
    expect(blind.chainsFailure).toEqual({ kind: "refused", status: 200 });
  });

  it("marks the chains it ran out of levels for as too long", async () => {
    const tables = Object.fromEntries(Array.from({ length: 14 }, (_, n) => [`u_level_${n}`, n === 13 ? [] : [`u_level_${n + 1}`]]));
    const fixture: FieldTypeFixture = {
      ...FIXTURE,
      parents: Object.fromEntries(Object.entries(tables).map(([name]) => [name, chainFrom(name)])),
    };
    function chainFrom(name: string): string[] {
      const n = Number(name.replace("u_level_", ""));
      return Array.from({ length: 13 - n }, (_, i) => `u_level_${n + i + 1}`);
    }
    const loaded = await loadFieldTypesInPlan(double(fixture).ops, ["u_level_0"]);
    expect(loaded.hierarchyRead).toBe(false);
    expect(loaded.chains.get("u_level_0")).toMatchObject({ complete: false, gap: "too_long" });
  });
});

describe("the causes the surfaces report", () => {
  const unavailable = (cause: FieldTypesReadFailure | undefined, problems?: Map<string, FieldTypesTableProblem>): FieldTypes =>
    ({ state: "unavailable", ...(cause === undefined ? {} : { cause }), ...(problems === undefined ? {} : { problems }) }) as FieldTypes;

  it("picks a missing table first, then the dictionary, then a failed chain read, then a gap", () => {
    const problems = new Map<string, FieldTypesTableProblem>([
      ["u_a", { kind: "chain", at: "u_a", gap: "too_long" }],
      ["u_b", { kind: "read", failure: { kind: "failed" } }],
      ["u_c", { kind: "not_found" }],
    ]);
    const text = (types: FieldTypes) => fieldTypesRefusal(types, ["u_a", "u_b", "u_c"]).message;
    expect(text({ state: "available", tables: new Map(), problems })).toContain('Table "u_c" does not exist');
    problems.delete("u_c");
    expect(text(unavailable({ kind: "refused", status: 403 }, problems))).toContain("refused the sys_dictionary read (HTTP 403)");
    expect(text({ state: "available", tables: new Map(), problems })).toContain("the sys_db_object read failed");
    problems.delete("u_b");
    expect(text({ state: "available", tables: new Map(), problems })).toContain("12 tables deep");
    expect(text(unavailable(undefined))).toBe("Field types could not be read from the instance, so no values are returned.");
  });

  it("audits a policy cause as a policy rejection, and nothing else", () => {
    expect(fieldTypesRefusal(unavailable({ kind: "policy", table: "sys_dictionary" }), ["u_a"]).policy).toBe(true);
    for (const cause of [
      { kind: "refused", status: 403 },
      { kind: "transient", status: 503, retried: true },
      { kind: "incomplete" },
      { kind: "failed" },
    ] as const) {
      expect(fieldTypesRefusal(unavailable(cause), ["u_a"]).policy, cause.kind).toBe(false);
    }
  });

  const failures: FieldTypesReadFailure[] = [
    { kind: "policy", table: "sys_dictionary" },
    { kind: "refused", status: 401 },
    { kind: "refused", status: 200 },
    { kind: "transient", status: 503, retried: true },
    { kind: "transient", timeout: true, retried: true },
    { kind: "transient" },
    { kind: "incomplete" },
    { kind: "failed", status: 400 },
    { kind: "failed" },
  ];
  const problems: FieldTypesTableProblem[] = [
    { kind: "not_found" },
    { kind: "chain", at: "u_a_table_name_that_is_long", gap: "parent_unreadable" },
    { kind: "chain", at: "u_a", gap: "too_long" },
    { kind: "chain", at: "u_a", gap: "malformed" },
    { kind: "chain", at: "u_a", gap: "no_row" },
    { kind: "read", failure: { kind: "refused", status: 403 }, read: "sys_db_object" },
  ];
  const inputs: Omit<FieldTypesProblemInput, "surface">[] = [
    ...failures.map((failure) => ({ failure })),
    ...problems.map((problem) => ({ problem })),
    {},
  ];

  it("says 'Access denied by policy' for a policy cause only, on every surface", () => {
    for (const surface of ["dispatcher", "history", "payload", "evaluate"] as const) {
      for (const input of inputs) {
        const text = fieldTypesProblemText({ surface, optIn: surface === "dispatcher", ...input });
        const policy = input.failure?.kind === "policy";
        expect(text.startsWith("Access denied by policy"), `${surface} ${text}`).toBe(policy && surface === "dispatcher");
        if (!policy) expect(text).not.toContain("Access denied by policy");
      }
    }
  });

  it("stays within the contract's bounds, and names no table where the table is untrusted", () => {
    for (const surface of ["history", "payload", "evaluate"] as const) {
      for (const about of ["types", "hierarchy"] as const) {
        for (const input of inputs) {
          const text = fieldTypesProblemText({ surface, about, table: "u_secret_customer_table", ...input });
          expect(text.length, text).toBeLessThanOrEqual(surface === "payload" ? 500 : 300);
          if (surface !== "history") expect(text, text).not.toMatch(/u_a|u_secret/u);
          expect(text).toMatch(/\.$/u);
        }
      }
    }
  });

  it("interpolates only a valid table name and an integer status", () => {
    const hostile = 'x"; DROP TABLE';
    const text = fieldTypesProblemText({
      surface: "dispatcher",
      table: hostile,
      problem: { kind: "chain", at: hostile, gap: "parent_unreadable" },
    });
    expect(text).not.toContain("DROP");
    for (const status of [99, 600, 403.5, Number.NaN]) {
      const refused = fieldTypesProblemText({ surface: "dispatcher", failure: { kind: "refused", status } });
      expect(refused).not.toMatch(/HTTP (99|600|403\.5|NaN)/u);
    }
  });

  it("words the dispatcher's causes", () => {
    const text = (input: Omit<FieldTypesProblemInput, "surface">) => fieldTypesProblemText({ surface: "dispatcher", optIn: true, ...input });
    expect(text({ failure: { kind: "refused", status: 403 } })).toMatch(/^Field types could not be read: the instance refused the sys_dictionary read \(HTTP 403\)/u);
    expect(text({ failure: { kind: "transient", status: 503, retried: true } })).toBe(
      "Field types are temporarily unavailable: the sys_dictionary request returned HTTP 503 after retrying. No values were returned. Retry the call."
    );
    expect(text({ failure: { kind: "transient", status: 429 } })).not.toContain("after retrying");
    expect(text({ failure: { kind: "incomplete" } })).toContain('Set "fieldTypes": { "dictionary": "not_required" }');
    expect(text({ failure: { kind: "failed", status: 400 } })).toBe(
      "Field types could not be read: the sys_dictionary read failed (HTTP 400). No values were returned."
    );
    expect(text({ table: "u_a", problem: { kind: "chain", at: "u_a", gap: "malformed" } })).toBe(
      'Field types for "u_a" could not be confirmed: the sys_db_object row of "u_a" does not name a valid parent. No values were returned. Set "fieldTypes": { "dictionary": "not_required" } on this profile to hide fields by name only.'
    );
  });
});

describe("the payload view's hints", () => {
  const payload = '<record_update table="u_secret_customer_table"><u_secret_customer_table action="INSERT_OR_UPDATE"><a>1</a></u_secret_customer_table></record_update>';
  const loaded = (extra: Record<string, unknown>) => ({
    types: { state: "unavailable" },
    chains: new Map(),
    hierarchyRead: false,
    ...extra,
  });

  it("carries the cause and no table name, for a hierarchy and for the types", async () => {
    const hierarchy = await preparePayload(payload, [], async () => loaded({ chainsFailure: { kind: "transient", status: 503, retried: true } }) as never, 1000);
    expect(hierarchy).toMatchObject({
      status: "withheld",
      reason: "hierarchy_unknown",
      hint: "Table hierarchies could not be read: the sys_db_object request returned HTTP 503 after retrying, so the payload is not shown.",
    });
    const types = await preparePayload(
      payload,
      [],
      async () =>
        ({
          types: { state: "unavailable", cause: { kind: "policy", table: "sys_dictionary" } },
          chains: new Map([["u_secret_customer_table", { tables: ["u_secret_customer_table"], complete: true }]]),
          hierarchyRead: true,
          typesFailure: { kind: "policy", table: "sys_dictionary" },
        }) as never,
      1000
    );
    expect(types).toMatchObject({
      reason: "field_types_unavailable",
      hint: "This profile does not grant read on sys_db_object and sys_dictionary (name, element, internal_type), so password-type fields cannot be hidden; the payload is not shown.",
    });
    expect(JSON.stringify([hierarchy, types])).not.toContain("u_secret_customer_table");
  });

  it("keeps the reason's fixed sentence when the loader names no cause", async () => {
    const outcome = await preparePayload(payload, [], async () => loaded({}) as never, 1000);
    expect(outcome).toEqual(payloadRefusal("withheld", "hierarchy_unknown"));
  });

  it("reads the same cause helpers the other surfaces use", () => {
    const plan = { types: { state: "unavailable" }, chains: new Map(), hierarchyRead: true, typesFailure: { kind: "failed" } } as never;
    expect(planTypesProblem(plan)).toEqual({ failure: { kind: "failed" }, read: "sys_dictionary" });
    expect(planHierarchyProblem(plan, ["u_a"])).toBeUndefined();
  });
});
