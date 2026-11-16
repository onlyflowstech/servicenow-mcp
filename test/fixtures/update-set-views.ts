// A synthetic instance for the update set views of `sn_platform_view`: it
// answers each Table and Aggregate API read the views make from an in-memory
// model, and records every call through the platform-view harness, so a test
// judges the reads against the view's plan. Synthetic data only; every
// credential-like value is plainly fake.

import type { ServiceNowOperations } from "../../src/client.js";
import { recordingInstance, type RecordedCall, type RecordingInstance } from "../platform-view-harness.js";
import { sysDbObjectRow } from "./field-types.js";

export type Row = Record<string, unknown>;

/** A 32-hex sys_id from a number. */
export const sid = (n: number): string => n.toString(16).padStart(32, "0");

export const SET_ID = sid(0x5e7);
export const CHILD_ID = sid(0x5e8);
export const REMOTE_ID = sid(0x7e3073);
export const SCOPE_ID = sid(0x5c0);

export const FAKE_SECRET = "fake-not-a-secret";
export const CANARY = "CANARY_update_set_views";

export interface World {
  localSets: Row[];
  remoteSets: Row[];
  /** `sys_update_xml` rows, payload included. */
  changes: Row[];
  problems: Row[];
  /** Table -> parent, or null when it extends nothing. A table not listed has no row. */
  tables: Record<string, string | null>;
  dictionary: { name: string; element: string; internal_type: string }[];
  /** Tables whose sys_db_object row this account cannot read (see `sysDbObjectRow`). */
  hiddenRows?: string[];
  /** Tables whose row comes back without the stored `super_class` reference. */
  withoutParentLinks?: string[];
}

export const STANDARD_TABLES: Record<string, string | null> = {
  sys_metadata: null,
  sys_script_include: "sys_metadata",
  sys_script: "sys_metadata",
  sys_ui_section: "sys_metadata",
  sys_ui_element: null,
  sys_user: null,
  u_vendor: null,
  u_vendor_child: "u_vendor",
  discovery_credentials: null,
  ssh_credentials: "discovery_credentials",
  sys_properties: "sys_metadata",
};

export const STANDARD_DICTIONARY = [
  { name: "sys_user", element: "user_password", internal_type: "password" },
  { name: "u_vendor", element: "u_api_key_value", internal_type: "password2" },
  { name: "discovery_credentials", element: "password", internal_type: "password2" },
];

export function localSet(overrides: Row = {}): Row {
  return {
    sys_id: SET_ID,
    name: "Release 1",
    state: "in progress",
    application: "global",
    is_default: "false",
    parent: "",
    base_update_set: "",
    sys_created_by: "dev.user",
    sys_created_on: "2026-11-01 10:00:00",
    sys_updated_on: "2026-11-02 10:00:00",
    completed_on: "",
    completed_by: "",
    remote_sys_id: "",
    description: "Ships the release",
    ...overrides,
  };
}

export function remoteSet(overrides: Row = {}): Row {
  return {
    sys_id: REMOTE_ID,
    name: "Retrieved release",
    state: "previewed",
    application_scope: "global",
    collisions: "0",
    inserted: "2",
    updated: "1",
    deleted: "0",
    parent: "",
    remote_base_update_set: "",
    update_source: sid(0x50c),
    commit_date: "",
    sys_created_on: "2026-11-03 10:00:00",
    ...overrides,
  };
}

/** A payload for one record element of `table` with `fields`. */
export function payloadOf(table: string, fields: Record<string, string>, extra = ""): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><record_update table="${table}"><${table} action="INSERT_OR_UPDATE">${body}</${table}>${extra}</record_update>`;
}

export function change(n: number, overrides: Row = {}): Row {
  const id = sid(0xc000 + n);
  return {
    sys_id: id,
    type: "Script Include",
    name: `sys_script_include_${id}`,
    target_name: `Util${n}`,
    table: "sys_script_include",
    action: "INSERT_OR_UPDATE",
    application: "global",
    sys_updated_by: "dev.user",
    sys_updated_on: `2026-11-02 10:${String(n % 60).padStart(2, "0")}:00`,
    replace_on_upgrade: "false",
    update_set: SET_ID,
    remote_update_set: "",
    payload: payloadOf("sys_script_include", { name: `Util${n}`, script: `gs.info(${n});` }),
    payload_diff: `${CANARY}_diff`,
    ...overrides,
  };
}

export function world(overrides: Partial<World> = {}): World {
  return {
    localSets: [localSet()],
    remoteSets: [],
    changes: [],
    problems: [],
    tables: { ...STANDARD_TABLES },
    dictionary: [...STANDARD_DICTIONARY],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface Condition {
  readonly field: string;
  readonly op: string;
  readonly value: string;
}

/** The conditions of an encoded query, as AND groups of OR alternatives, and its order. */
function parse(query: string): { groups: Condition[][]; order: { field: string; desc: boolean }[] } {
  const groups: Condition[][] = [];
  const order: { field: string; desc: boolean }[] = [];
  for (const clause of query.split("^").filter((part) => part !== "")) {
    const sort = /^ORDERBY(DESC)?([a-z0-9_.]+)$/u.exec(clause);
    if (sort !== null) {
      order.push({ field: sort[2]!, desc: sort[1] === "DESC" });
      continue;
    }
    const match = /^(OR)?([a-z0-9_.]+)(ISNOTEMPTY|ISEMPTY|LIKE|NOT IN|IN|>=|<=|!=|=|>|<)(.*)$/u.exec(clause);
    if (match === null) throw new Error(`fixture cannot read clause ${clause}`);
    const condition = { field: match[2]!, op: match[3]!, value: match[4]! };
    if (match[1] === "OR" && groups.length > 0) groups[groups.length - 1]!.push(condition);
    else groups.push([condition]);
  }
  return { groups, order };
}

function holds(row: Row, { field, op, value }: Condition): boolean {
  const actual = String(row[field] ?? "");
  switch (op) {
    case "=":
      return actual === value;
    case "!=":
      return actual !== value;
    case "IN":
      return value.split(",").includes(actual);
    case "NOT IN":
      return !value.split(",").includes(actual);
    case "LIKE":
      return actual.toLowerCase().includes(value.toLowerCase());
    case ">=":
      return actual >= value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case "<":
      return actual < value;
    case "ISNOTEMPTY":
      return actual !== "";
    default:
      return actual === "";
  }
}

export function select(rows: readonly Row[], query: string): Row[] {
  const { groups, order } = parse(query);
  const matched = rows.filter((row) => groups.every((group) => group.some((condition) => holds(row, condition))));
  return matched.sort((a, b) => {
    for (const { field, desc } of order) {
      const left = String(a[field] ?? "");
      const right = String(b[field] ?? "");
      if (left !== right) return (left < right ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
}

function project(row: Row, fields: string | undefined): Row {
  if (fields === undefined || fields === "") return { ...row };
  return Object.fromEntries(fields.split(",").filter((field) => field in row).map((field) => [field, row[field]]));
}

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

export interface FakeOptions {
  /** Throw this for a read before it is answered (or undefined to answer it). */
  readonly fail?: (call: RecordedCall) => Error | undefined;
}

export interface FakeInstance {
  readonly instance: RecordingInstance;
  readonly ops: ServiceNowOperations;
}

/** The table a recorded call addressed, and whether it is a stats read: `table:sys_update_set`, `stats:sys_update_xml`. */
export function callLabel(call: RecordedCall): string {
  return `${call.path.startsWith("/api/now/stats/") ? "stats" : "table"}:${call.path.split("/").at(-1)}`;
}

/** A recording instance that answers from `model`. */
export function fake(model: World, options: FakeOptions = {}): FakeInstance {
  const instance = recordingInstance();
  const tableRows: Record<string, () => Row[]> = {
    sys_update_set: () => model.localSets,
    sys_remote_update_set: () => model.remoteSets,
    sys_update_xml: () => model.changes,
    sys_update_preview_problem: () => model.problems,
  };
  const answer = (call: RecordedCall): unknown => {
    const failure = options.fail?.(call);
    if (failure !== undefined) throw failure;
    const { path, params } = call;
    const table = path.split("/").at(-1)!;
    const query = params.sysparm_query ?? "";
    if (path.startsWith("/api/now/stats/")) {
      const rows = select(tableRows[table]?.() ?? [], query);
      const groupBy = (params.sysparm_group_by ?? "").split(",").filter(Boolean);
      if (groupBy.length === 0) return { result: { stats: { count: String(rows.length) } } };
      const groups = new Map<string, { values: string[]; count: number }>();
      for (const row of rows) {
        const values = groupBy.map((field) => String(row[field] ?? ""));
        const key = JSON.stringify(values);
        const entry = groups.get(key) ?? { values, count: 0 };
        entry.count += 1;
        groups.set(key, entry);
      }
      return {
        result: [...groups.values()].map(({ values, count }) => ({
          stats: { count: String(count) },
          groupby_fields: groupBy.map((field, index) => ({ field, value: values[index] })),
        })),
      };
    }
    if (table === "sys_db_object") {
      const names = /^nameIN([^^]*)/u.exec(query)![1]!.split(",");
      return {
        result: names
          .filter((name) => name in model.tables && !(model.hiddenRows ?? []).includes(name))
          .map((name) => {
            const row = sysDbObjectRow(name, chainOf(model.tables, name), params.sysparm_fields ?? "name", model.hiddenRows);
            if ((model.withoutParentLinks ?? []).includes(name)) {
              for (const key of Object.keys(row)) if (key.endsWith("super_class")) delete row[key];
            }
            return row;
          }),
      };
    }
    if (table === "sys_dictionary") {
      const types = /internal_typeIN([^^]*)/u.exec(query)?.[1]?.split(",");
      return { result: model.dictionary.filter((row) => types === undefined || types.includes(row.internal_type)).map((row) => ({ ...row })) };
    }
    const rows = tableRows[table];
    if (rows === undefined) throw new Error(`fixture has no table ${table}`);
    const offset = Number(params.sysparm_offset ?? "0");
    const limit = Number(params.sysparm_limit ?? "10000");
    return { result: select(rows(), query).slice(offset, offset + limit).map((row) => project(row, params.sysparm_fields)) };
  };
  const ops = {
    ...instance.ops,
    get: async (path: string, params?: Record<string, string>) => {
      await instance.ops.get(path, params);
      return answer({ operation: "get", path, params: { ...params } });
    },
    getWithMeta: async (path: string, params?: Record<string, string>) => {
      await instance.ops.getWithMeta(path, params);
      return { data: answer({ operation: "getWithMeta", path, params: { ...params } }), status: 200, headers: new Headers() };
    },
  } as unknown as ServiceNowOperations;
  return { instance, ops };
}

/** `name`'s ancestors in a table -> parent model, nearest first. */
function chainOf(tables: Record<string, string | null>, name: string): string[] {
  const chain: string[] = [];
  for (let parent = tables[name]; parent !== null && parent !== undefined && !chain.includes(parent); parent = tables[parent]) {
    chain.push(parent);
  }
  return chain;
}
