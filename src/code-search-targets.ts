/**
 * What `sn_codesearch` can search, in one place for the access resolver (which
 * decides what a profile may read before any client exists) and the handler
 * (which reads it), so the two cannot drift.
 *
 * @module code-search-targets
 */

/** A table read besides the searched one, to say more about a match. */
export interface CodeSearchLookup {
  readonly table: string;
  /** The fields read from it. */
  readonly fields: readonly string[];
}

export interface CodeSearchTarget {
  /** The table argument that selects it, and the `table` of each result row. */
  readonly table: string;
  /** Human label carried on each result row. */
  readonly label: string;
  /** The field searched when the caller names none. */
  readonly defaultField: string;
  /**
   * The field of the searched table that names a row: `name` for most, `path`
   * for an ES module. For a target whose rows are named by a lookup it is the
   * field that points at the record the lookup reads.
   */
  readonly nameField: string;
  /** The table the matching query runs on. It is `table` unless a lookup names the row. */
  readonly queryTable: string;
  /**
   * Conditions the search always adds, fixed here and never taken from the
   * caller, so a search cannot be widened past the rows it is meant to cover.
   */
  readonly fixedQuery?: string;
  /** Tables read afterwards to name the matches. The profile needs a read grant on each. */
  readonly lookups: readonly CodeSearchLookup[];
  /** The searched field cannot be chosen: a caller's `field` is refused. */
  readonly fixedField: boolean;
  /**
   * A field every row must carry this value in, checked on the rows returned.
   * The fixed query already says so; this is the same condition read back, so a
   * row the instance returned in spite of it is dropped, not shown.
   */
  readonly guard?: { readonly field: string; readonly value: string };
}

/**
 * The searchable targets, in the order a search with no `table` takes turns
 * through them: script includes first, since they are what a caller most often
 * wants to find and are the table the others are read against.
 */
export const CODE_SEARCH_TARGETS: readonly CodeSearchTarget[] = Object.freeze([
  tableTarget("sys_script_include", "Script Includes", "script"),
  tableTarget("sys_script", "Business Rules", "script"),
  tableTarget("sys_ui_script", "UI Scripts", "script"),
  tableTarget("sys_script_client", "Client Scripts", "script"),
  tableTarget("sys_ws_operation", "Scripted REST", "operation_script"),
  tableTarget("sys_module", "ES Modules", "content", "path"),
  // The script of an ATF step is not a column of the step: it is the value of
  // the step's script input, a row of sys_variable_value owned by the step. The
  // rows searched are those of document sys_atf_step whose variable ends with
  // "script" (a reference compares by its display value), a condition fixed here. The steps and their tests are
  // then read to say which test and step each match is.
  Object.freeze({
    table: "sys_atf_step",
    label: "ATF Step Scripts",
    defaultField: "value",
    nameField: "document_key",
    queryTable: "sys_variable_value",
    fixedQuery: "document=sys_atf_step^variableENDSWITHscript",
    lookups: Object.freeze([
      Object.freeze({ table: "sys_atf_step", fields: Object.freeze(["sys_id", "test", "order"]) }),
      Object.freeze({ table: "sys_atf_test", fields: Object.freeze(["sys_id", "name"]) }),
    ]),
    fixedField: true,
    guard: Object.freeze({ field: "document", value: "sys_atf_step" }),
  }),
]);

function tableTarget(
  table: string,
  label: string,
  defaultField: string,
  nameField = "name"
): CodeSearchTarget {
  return Object.freeze({
    table,
    label,
    defaultField,
    nameField,
    queryTable: table,
    lookups: Object.freeze([]),
    fixedField: false,
  });
}

const BY_TABLE: ReadonlyMap<string, CodeSearchTarget> = new Map(
  CODE_SEARCH_TARGETS.map((entry) => [entry.table, entry])
);

/** The target for a canonical table name, or undefined when it is not searchable. */
export function codeSearchTarget(table: string): CodeSearchTarget | undefined {
  return BY_TABLE.get(table);
}

/** Every table a search of the target reads, each needing a read grant for the tool. */
export function codeSearchReads(target: CodeSearchTarget): readonly string[] {
  return [...new Set([target.queryTable, ...target.lookups.map((lookup) => lookup.table)])];
}

/**
 * The fields one search reads from the searched table: the identifier, the
 * name and the searched field, each once. The searched field may be the name or
 * the identifier itself, and a repeated field is a malformed selection.
 */
export function searchProjection(nameField: string, field: string): readonly string[] {
  return Object.freeze([...new Set(["sys_id", nameField, field])]);
}

/** What a find reads: the projection above, and the guard field when the target has one. */
export function findProjection(
  target: CodeSearchTarget,
  nameField: string,
  field: string
): readonly string[] {
  const base = searchProjection(nameField, field);
  return target.guard === undefined
    ? base
    : Object.freeze([...new Set([...base, target.guard.field])]);
}
