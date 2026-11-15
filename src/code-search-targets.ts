/**
 * What `sn_codesearch` can search, in one place for the access resolver (which
 * decides what a profile may read before any client exists) and the handler
 * (which reads it), so the two cannot drift.
 *
 * @module code-search-targets
 */

export interface CodeSearchTarget {
  /** The table argument that selects it, and the `table` of each result row. */
  readonly table: string;
  /** Human label carried on each result row. */
  readonly label: string;
  /** The field searched when the caller names none. */
  readonly defaultField: string;
  /** The field that names a row: `name` for most, `path` for an ES module. */
  readonly nameField: string;
}

/**
 * The searchable tables, in the order a search with no `table` takes turns
 * through them: script includes first, since they are what a caller most often
 * wants to find and are the table the others are read against.
 */
export const CODE_SEARCH_TARGETS: readonly CodeSearchTarget[] = Object.freeze([
  target("sys_script_include", "Script Includes", "script"),
  target("sys_script", "Business Rules", "script"),
  target("sys_ui_script", "UI Scripts", "script"),
  target("sys_script_client", "Client Scripts", "script"),
  target("sys_ws_operation", "Scripted REST", "operation_script"),
  target("sys_module", "ES Modules", "content", "path"),
]);

function target(
  table: string,
  label: string,
  defaultField: string,
  nameField = "name"
): CodeSearchTarget {
  return Object.freeze({ table, label, defaultField, nameField });
}

const BY_TABLE: ReadonlyMap<string, CodeSearchTarget> = new Map(
  CODE_SEARCH_TARGETS.map((entry) => [entry.table, entry])
);

/** The target for a canonical table name, or undefined when it is not searchable. */
export function codeSearchTarget(table: string): CodeSearchTarget | undefined {
  return BY_TABLE.get(table);
}

/**
 * The fields one search reads from a table: the identifier, the name and the
 * searched field, each once. The searched field may be the name or the
 * identifier itself, and a repeated field is a malformed selection.
 */
export function searchProjection(nameField: string, field: string): readonly string[] {
  return Object.freeze([...new Set(["sys_id", nameField, field])]);
}
