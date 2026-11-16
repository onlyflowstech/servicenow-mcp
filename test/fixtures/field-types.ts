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
        .filter((name) => !fixture.absent.includes(name))
        .map((name) => {
          const row: Record<string, string> = { name };
          (fixture.parents[name] ?? []).forEach((parent, index) => {
            row[`${"super_class.".repeat(index + 1)}name`] = parent;
          });
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
  fieldTypesFromRows([], Object.fromEntries([...tables].map((table) => [table, [table]])));
