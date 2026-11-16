import { createHash } from "node:crypto";

import { fieldTypesFromRows, type FieldTypeLoader } from "../../src/hidden-values.js";

/**
 * Synthetic answers to the field-type lookup the dispatcher makes before a
 * field-policy tool call (hidden-values.ts): the instance-wide sys_dictionary
 * read of hidden types, the sys_db_object chain read, the sys_db_view_table
 * read, and the metadata-cache watermarks of those tables. Test doubles that
 * turn the metadata cache on route their reads through this first, so the
 * lookup is answered and their own assertions see only the tool's reads.
 * Synthetic data only.
 */

export interface FieldTypeFixture {
  /** Hidden-typed dictionary rows: { name (table), element, internal_type }. */
  readonly dictionary: readonly { name: string; element: string; internal_type: string }[];
  /** Table -> parents, nearest first. A table not listed has no parents. */
  readonly parents: Readonly<Record<string, readonly string[]>>;
  /** Names with no sys_db_object row (database views or unknown names). */
  readonly absent: readonly string[];
  /** View -> joined tables with their prefixes. */
  readonly views: Readonly<Record<string, readonly { table: string; prefix: string }[]>>;
  /**
   * Tables whose own sys_db_object row this account cannot read: the row is
   * not returned, and where a child's dot-walk reaches it, its name comes
   * back empty beside a stored reference that is still set.
   */
  readonly hiddenRows?: readonly string[];
  /** Tables whose rows come back without the stored `super_class` references (names only). */
  readonly withoutParentLinks?: readonly string[];
}

/** One hidden-typed field on a table no ordinary test reads. */
export const DEFAULT_FIELD_TYPES: FieldTypeFixture = {
  dictionary: [{ name: "sys_user", element: "user_password", internal_type: "password" }],
  parents: {},
  absent: [],
  views: {},
};

type Answer = { data: unknown; status: number; headers: Headers };

const LOOKUP_TABLES = /^\/api\/now\/table\/(sys_dictionary|sys_db_object|sys_db_view_table)$/u;

/**
 * The answer to one field-type lookup read, or undefined when the read is not
 * one (the caller then answers it as usual).
 */
export function fieldTypeAnswer(
  path: string,
  params: Record<string, string> | undefined,
  fixture: FieldTypeFixture = DEFAULT_FIELD_TYPES
): Answer | undefined {
  const table = LOOKUP_TABLES.exec(path)?.[1];
  if (table === undefined) return undefined;
  const query = params?.sysparm_query ?? "";
  const fields = params?.sysparm_fields ?? "";
  if (table === "sys_dictionary" && query.startsWith("internal_typeIN")) {
    return answer(fixture.dictionary.map((row) => ({ ...row })));
  }
  if (table === "sys_db_object" && query.startsWith("nameIN") && fields.includes("super_class.name")) {
    const names = query.slice("nameIN".length).split(",");
    return answer(
      names
        .filter((name) => !fixture.absent.includes(name) && !(fixture.hiddenRows ?? []).includes(name))
        .map((name) => {
          const row = sysDbObjectRow(name, fixture.parents[name] ?? [], fields, fixture.hiddenRows);
          if ((fixture.withoutParentLinks ?? []).includes(name)) {
            for (const key of Object.keys(row)) if (key.endsWith("super_class")) delete row[key];
          }
          return row;
        })
    );
  }
  if (table === "sys_db_view_table" && query.startsWith("view.nameIN")) {
    const names = query.slice("view.nameIN".length).split(",");
    return answer(
      names.flatMap((view) =>
        (fixture.views[view] ?? []).map((source) => ({
          "view.name": view,
          table: source.table,
          variable_prefix: source.prefix,
        }))
      )
    );
  }
  return undefined;
}

/** A stand-in sys_id for a table's sys_db_object row. */
export function fakeTableSysId(table: string): string {
  return createHash("md5").update(`fake-table:${table}`).digest("hex");
}

/**
 * A `sys_db_object` row as the instance returns it with stored values: every
 * requested field present, `<hops>super_class` the stored reference (a sys_id,
 * or empty past the chain's end), `<hops>super_class.name` that parent's name.
 * A parent in `hidden` keeps its reference but loses its name, and every
 * field read through its row comes back empty.
 */
export function sysDbObjectRow(
  name: string,
  parents: readonly string[],
  fields: string,
  hidden: readonly string[] = []
): Record<string, string> {
  const row: Record<string, string> = {};
  for (const field of fields.split(",")) {
    if (field === "name") {
      row.name = name;
      continue;
    }
    const link = /^((?:super_class\.)*)super_class$/u.exec(field);
    if (link !== null) {
      const hops = link[1]!.length / "super_class.".length;
      const parent = parents[hops];
      // Read from the row of the table `hops` levels up: empty past a hidden one.
      const blocked = parents.slice(0, hops).some((entry) => hidden.includes(entry));
      row[field] = parent === undefined || blocked ? "" : fakeTableSysId(parent);
      continue;
    }
    const parentName = /^((?:super_class\.)+)name$/u.exec(field);
    if (parentName !== null) {
      const parent = parents[parentName[1]!.length / "super_class.".length - 1];
      // A dot-walk past a hidden row comes back empty.
      const index = parent === undefined ? -1 : parents.indexOf(parent);
      const blocked = parents.slice(0, index + 1).some((entry) => hidden.includes(entry));
      row[field] = parent === undefined || blocked ? "" : parent;
    }
  }
  return row;
}

function answer(result: unknown[]): Answer {
  return {
    data: { result },
    status: 200,
    headers: new Headers({ "x-total-count": String(result.length) }),
  };
}

/**
 * {@link fieldTypeAnswer} for a stubbed global fetch: a Response for a
 * field-type lookup GET, or undefined for any other request.
 */
export function fieldTypeResponse(
  input: string | URL | Request,
  init?: RequestInit,
  fixture: FieldTypeFixture = DEFAULT_FIELD_TYPES
): Response | undefined {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET") return undefined;
  const typed = fieldTypeAnswer(url.pathname, Object.fromEntries(url.searchParams), fixture);
  if (typed === undefined) return undefined;
  const headers = new Headers(typed.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(typed.data), { status: typed.status, headers });
}

/**
 * An injected `fieldTypeLoader` for a test double that does not serve the
 * lookup: every planned table resolves, with no hidden-typed field. The type
 * step still runs (the plan is prepared again in its scope); it only finds
 * nothing to hide. Set through the execution-context dependencies, which no
 * profile, configuration or environment variable can reach.
 */
export const noHiddenFieldTypes: FieldTypeLoader = async (_client, tables) =>
  fieldTypesFromRows([], Object.fromEntries([...tables].map((table) => [table, { tables: [table], complete: true }])));
