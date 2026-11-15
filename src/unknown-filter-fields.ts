/**
 * Refuse a filter or order on a field the table does not have.
 *
 * ServiceNow drops a condition on a column it does not know, unless the
 * instance sets glide.invalid_query.returns_no_rows (off by default and not a
 * setting this server can rely on). A misspelt field therefore does not match
 * nothing: the rest of the query runs and unrelated rows come back.
 *
 * The check costs no request. A column named in sysparm_fields that the table
 * does not have, or that the integration user may not read, is left out of
 * every row, so the filter's own fields are asked for on the read that is
 * made anyway and the rows that come back show which of them exist.
 *
 *  - A field counts as present when any returned row carries the key, not only
 *    the first: a field-level rule that depends on the record can hide a real
 *    column on some rows, never on a column that is absent from the table.
 *  - An existing column with no value is still returned (as an empty string),
 *    so an empty field is never mistaken for a missing one.
 *  - With no rows there is nothing to check. That is harmless: a read returns
 *    nothing, and a step that acts on the rows has nothing to act on.
 *  - Raw encoded queries are not parsed. They are only accepted through an
 *    owner-written policy rule that pins the query and its field names, so
 *    there is no caller-typed field to verify.
 *
 * The extra columns are asked for only when the caller's own field list does
 * not already hold them, and callers drop them from the result.
 */

import { isServiceNowResponseTooLarge } from "./client.js";
import { CANONICAL_FIELD_PATTERN } from "./tool-error.js";

const CANONICAL_FIELD = CANONICAL_FIELD_PATTERN;

export interface FilterFieldEcho {
  /** The sysparm_fields value to send; undefined keeps "every column". */
  readonly sysparmFields: string | undefined;
  /** The fields whose presence in the returned rows is checked. */
  readonly probe: readonly string[];
  /** True when the request asks for columns the caller did not select. */
  readonly extended: boolean;
}

/**
 * The sysparm_fields to send, and the fields to look for in the rows.
 *
 * `requested` is the caller's own selection, comma separated, or undefined
 * when the read asks for every column. A read for every column already
 * returns each column of the table, so nothing is added; a dot-walked name is
 * not returned by such a read, so it cannot be checked there and is skipped.
 */
export function echoFilterFields(
  requested: string | undefined,
  referenced: readonly string[]
): FilterFieldEcho {
  const names = [...new Set(referenced)].filter((field) =>
    CANONICAL_FIELD.test(field)
  );
  if (requested === undefined) {
    return {
      sysparmFields: undefined,
      probe: Object.freeze(names.filter((field) => !field.includes("."))),
      extended: false,
    };
  }
  const listed = new Set(requested.split(","));
  const extra = names.filter((field) => !listed.has(field));
  return {
    sysparmFields: extra.length === 0 ? requested : `${requested},${extra.join(",")}`,
    probe: Object.freeze(names),
    extended: extra.length > 0,
  };
}

/**
 * The first probed field that no returned row carries, or undefined when
 * every field is present or there is no row to look at.
 */
export function firstMissingFilterField(
  rows: unknown,
  probe: readonly string[]
): string | undefined {
  if (!Array.isArray(rows) || rows.length === 0 || probe.length === 0) {
    return undefined;
  }
  const pending = new Set(probe);
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    for (const field of pending) {
      if (Object.hasOwn(row, field)) pending.delete(field);
    }
    if (pending.size === 0) return undefined;
  }
  // Set order is insertion order, so this is the first field in probe order.
  return pending.values().next().value;
}

/** True when the request was extended for the check and then came back too large. */
export function isFilterEchoTooLarge(error: unknown, echo: FilterFieldEcho): boolean {
  return echo.extended && isServiceNowResponseTooLarge(error);
}
