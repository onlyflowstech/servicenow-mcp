/**
 * Fixture rows that behave like ServiceNow for a column the table has: every
 * field named in sysparm_fields comes back on the row, with a value.
 *
 * A fake upstream that answers a read with fixed rows must do this once the
 * server asks for the filter's own fields, because a filter field missing from
 * every returned row is read as a field the table does not have.
 */

type Row = Record<string, unknown>;

/** The field names a request asks for, or none when it asks for every column. */
export function requestedFields(params: unknown): readonly string[] {
  if (typeof params !== "object" || params === null) return [];
  const raw = (params as Record<string, unknown>).sysparm_fields;
  return typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
}

/** The same row with every requested field present; a value already there wins. */
export function echoFields(row: Row, params: unknown): Row {
  const echoed: Row = {};
  for (const field of requestedFields(params)) echoed[field] = "1";
  return { ...echoed, ...row };
}

/** `echoFields` for a list of rows. */
export function echoRows(rows: readonly Row[], params: unknown): Row[] {
  return rows.map((row) => echoFields(row, params));
}

/** The fields an encoded query filters or orders on, in order of appearance. */
export function queryFields(query: unknown): readonly string[] {
  if (typeof query !== "string") return [];
  const fields: string[] = [];
  for (const term of query.split("^")) {
    const match = /^(?:OR|NQ)?(?:ORDERBY(?:DESC)?)?([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)/u.exec(term);
    if (match?.[1] !== undefined && !fields.includes(match[1])) fields.push(match[1]);
  }
  return fields;
}

/**
 * A row as a table that has the filter's columns returns it: every column the
 * query filters or orders on is present, with a value when the fixture did not
 * set one.
 */
export function withQueryFields(row: unknown, params: unknown): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
  const query =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>).sysparm_query
      : undefined;
  const added: Row = {};
  for (const field of queryFields(query)) added[field] = "1";
  return { ...added, ...(row as Row) };
}
