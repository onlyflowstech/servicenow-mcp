// A synthetic instance for the `evaluate` view: it answers each read the view
// makes (sets, descendants, row counts, row pages, preview problems, update
// versions, table hierarchy and hidden field types) from an in-memory model,
// and records every call through the platform-view harness so a test can
// judge the reads against the view's plan. Synthetic data only.

import type { ServiceNowOperations } from "../../../src/client.js";
import { ServiceNowResponseTooLargeError } from "../../../src/client.js";
import type { EvaluateUpdate } from "../../../src/update-set-eval/types.js";
import { recordingInstance, type RecordedCall, type RecordingInstance } from "../../platform-view-harness.js";
import { APP_GLOBAL, SET_ID, sid } from "./rule-cases.js";

export type Row = Record<string, unknown>;

export interface InstanceModel {
  /** `sys_update_set` rows. */
  localSets: Row[];
  /** `sys_remote_update_set` rows. */
  remoteSets: Row[];
  /** `sys_update_xml` rows, with `update_set` or `remote_update_set`. */
  rows: Row[];
  /** `sys_update_preview_problem` rows, with `remote_update_set`. */
  problems: Row[];
  /** `sys_update_version`: name -> its versions' source tables. */
  versions: Record<string, string[]>;
  /** Update name -> rows in other open sets. */
  otherOpen: Record<string, number>;
  /** Table -> parent table, or null when it extends nothing. A table not listed has no row. */
  tables: Record<string, string | null>;
  /** Hidden-typed dictionary rows. */
  dictionary: { name: string; element: string; internal_type: string }[];
}

/** Metadata tables most fixtures write to, and two data tables. */
export const STANDARD_TABLES: Record<string, string | null> = {
  sys_metadata: null,
  sys_script: "sys_metadata",
  sys_script_include: "sys_metadata",
  sys_script_client: "sys_metadata",
  catalog_script_client: "sys_script_client",
  sys_security_acl: "sys_metadata",
  sys_user_role: "sys_metadata",
  sys_user_role_contains: "sys_metadata",
  sys_properties: "sys_metadata",
  sys_scope_privilege: "sys_metadata",
  sys_ui_page: "sys_metadata",
  sys_ws_operation: "sys_metadata",
  sys_processor: "sys_metadata",
  sys_rest_message: "sys_metadata",
  sp_widget: "sys_metadata",
  sys_ui_policy: "sys_metadata",
  task: null,
  incident: "task",
  sys_user: null,
  cmdb_ci: null,
  u_vendor: null,
  u_vendor_child: "u_vendor",
  discovery_credentials: null,
  ssh_credentials: "discovery_credentials",
  oauth_entity: null,
  sys_auth_profile_basic: null,
};

export const STANDARD_DICTIONARY = [
  { name: "sys_user", element: "user_password", internal_type: "password" },
  { name: "u_vendor", element: "u_api_password", internal_type: "password2" },
  { name: "discovery_credentials", element: "password", internal_type: "password2" },
];

export function model(overrides: Partial<InstanceModel> = {}): InstanceModel {
  return {
    localSets: [localSet()],
    remoteSets: [],
    rows: [],
    problems: [],
    versions: {},
    otherOpen: {},
    tables: { ...STANDARD_TABLES },
    dictionary: [...STANDARD_DICTIONARY],
    ...overrides,
  };
}

export function localSet(overrides: Row = {}): Row {
  return {
    sys_id: SET_ID,
    name: "Release 1",
    state: "in progress",
    is_default: "false",
    application: APP_GLOBAL,
    parent: "",
    description: "Ships the release",
    ...overrides,
  };
}

export function remoteSet(overrides: Row = {}): Row {
  return { sys_id: sid(0x7e3073), name: "Retrieved release", state: "previewed", parent: "", description: "From dev", ...overrides };
}

/** An engine row as the instance stores it. */
export function xmlRow(update: EvaluateUpdate, overrides: Row = {}): Row {
  return {
    sys_id: update.sys_id,
    name: update.name,
    type: update.type ?? "",
    target_name: update.target_name ?? "",
    update_set: update.update_set,
    action: update.action ?? "INSERT_OR_UPDATE",
    table: update.table ?? "",
    application: update.application ?? "",
    replace_on_upgrade: update.replace_on_upgrade === true ? "true" : "false",
    payload: update.payload ?? "",
    ...overrides,
  };
}

const rows = (result: Row[]) => ({ result });

function project(row: Row, fields: string | undefined): Row {
  if (fields === undefined) return { ...row };
  return Object.fromEntries(fields.split(",").filter((field) => field in row).map((field) => [field, row[field]]));
}

/** The conditions of a simple encoded query: `field=value`, `fieldIN a,b`, `field>value`. */
function conditions(query: string): { field: string; op: string; value: string }[] {
  return query
    .split("^")
    .filter((clause) => clause !== "" && !clause.startsWith("ORDERBY"))
    .map((clause) => {
      const match = /^(?:OR)?([a-z0-9_.]+)(NOT IN|IN|>|=)(.*)$/u.exec(clause);
      if (match === null) throw new Error(`fixture cannot read clause ${clause}`);
      return { field: match[1]!, op: match[2]!, value: match[3]! };
    });
}

function matches(row: Row, query: string): boolean {
  return conditions(query).every(({ field, op, value }) => {
    const actual = String(row[field] ?? "");
    if (op === "=") return actual === value;
    if (op === ">") return actual > value;
    if (op === "IN") return value.split(",").includes(actual);
    return !value.split(",").includes(actual);
  });
}

export interface ScriptedInstance {
  readonly instance: RecordingInstance;
  readonly ops: ServiceNowOperations;
}

export interface ScriptOptions {
  /** Throw this for a read before it is answered (or undefined to answer it). */
  readonly fail?: (call: RecordedCall) => Error | undefined;
  /** A row page whose payload characters exceed this is too large for its scope. */
  readonly pageBytes?: number;
}

/** A recording instance that answers from `world`. */
export function scripted(world: InstanceModel, options: ScriptOptions = {}): ScriptedInstance {
  const instance = recordingInstance();
  const answer = (call: RecordedCall): unknown => {
    const failure = options.fail?.(call);
    if (failure !== undefined) throw failure;
    const { path, params } = call;
    const query = params.sysparm_query ?? "";
    const limit = Number(params.sysparm_limit ?? "10000");
    const table = path.split("/").at(-1)!;
    const isStats = path.startsWith("/api/now/stats/");
    if (isStats && table === "sys_update_xml") {
      const group = params.sysparm_group_by!;
      if (group === "name") {
        const names = conditions(query).find((c) => c.field === "name")!.value.split(",");
        return rows(
          names
            .filter((name) => (world.otherOpen[name] ?? 0) > 0)
            .map((name) => ({ stats: { count: String(world.otherOpen[name]) }, groupby_fields: [{ field: "name", value: name }] }))
        );
      }
      const counts = new Map<string, number>();
      for (const row of world.rows.filter((r) => matches(r, query))) {
        const key = String(row[group]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return rows([...counts].map(([value, count]) => ({ stats: { count: String(count) }, groupby_fields: [{ field: group, value }] })));
    }
    if (isStats && table === "sys_update_version") {
      const names = conditions(query).find((c) => c.field === "name")!.value.split(",");
      const groups: Row[] = [];
      for (const name of names) {
        const sources = new Map<string, number>();
        for (const source of world.versions[name] ?? []) sources.set(source, (sources.get(source) ?? 0) + 1);
        for (const [source, count] of sources) {
          groups.push({ stats: { count: String(count) }, groupby_fields: [{ field: "name", value: name }, { field: "source_table", value: source }] });
        }
      }
      return rows(groups);
    }
    if (isStats) throw new Error(`fixture has no stats for ${table}`);
    switch (table) {
      case "sys_update_set":
      case "sys_remote_update_set": {
        const sets = table === "sys_update_set" ? world.localSets : world.remoteSets;
        return rows(sets.filter((row) => matches(row, query)).slice(0, limit).map((row) => project(row, params.sysparm_fields)));
      }
      case "sys_update_xml": {
        const page = world.rows
          .filter((row) => matches(row, query))
          .sort((a, b) => (String(a.sys_id) < String(b.sys_id) ? -1 : 1))
          .slice(0, limit)
          .map((row) => project(row, params.sysparm_fields));
        if (options.pageBytes !== undefined && params.sysparm_fields?.split(",").includes("payload")) {
          const bytes = page.reduce((sum, row) => sum + String(row.payload ?? "").length, 0);
          if (bytes > options.pageBytes) throw new ServiceNowResponseTooLargeError("cumulative upstream response exceeds configured byte limit");
        }
        return rows(page);
      }
      case "sys_update_preview_problem":
        return rows(world.problems.filter((row) => matches(row, query)).slice(0, limit).map((row) => project(row, params.sysparm_fields)));
      case "sys_db_object": {
        const names = conditions(query).find((c) => c.field === "name")!.value.split(",");
        return rows(
          names
            .filter((name) => name in world.tables)
            .map((name) => ({ name, "super_class.name": world.tables[name] ?? "" }))
        );
      }
      case "sys_dictionary":
        return rows(world.dictionary.map((row) => ({ ...row })));
      default:
        throw new Error(`fixture has no table ${table}`);
    }
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

/** The path's table, and whether it is a stats read: `table:sys_update_xml`, `stats:sys_update_xml`. */
export function callLabel(call: RecordedCall): string {
  return `${call.path.startsWith("/api/now/stats/") ? "stats" : "table"}:${call.path.split("/").at(-1)}`;
}
