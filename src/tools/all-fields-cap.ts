/**
 * Bounded field projection for an unrestricted read selection.
 *
 * `fields="all"` and `response_format: "detailed"` resolve to the wildcard
 * selection, which drops `sysparm_fields` entirely and makes ServiceNow return
 * every column. On a wide table that breaches the cumulative upstream JSON
 * bound and the read *errors* rather than returning a trimmed record.
 *
 * This module bounds the **upstream request** instead. Truncating locally after
 * receipt would not help: the bytes have already crossed the wire and already
 * breached the cap. So the table's columns are resolved from sys_dictionary --
 * already a cached metadata table -- and at most MAX_ALL_FIELDS names are sent.
 *
 * Every failure path falls back to the table's bounded default projection,
 * never to dropping sysparm_fields. Failing back to "every column" would
 * reinstate exactly the defect this exists to prevent.
 *
 * @module tools/all-fields-cap
 */

import type { ServiceNowOperations } from "../client.js";
import { isSensitiveFieldName } from "../field-policy.js";
import { FORCE_RECACHE_PARAM } from "../metadata-cache.js";
import { escapeQueryValue } from "../utils.js";

/** Upper bound on columns requested for an unrestricted selection. */
export const MAX_ALL_FIELDS = 100;

const MAX_HIERARCHY_DEPTH = 12;
const MAX_DICTIONARY_ROWS = 10_000;
const ELEMENT_NAME = /^[a-z][a-z0-9_]{0,79}$/u;

export interface BoundedAllFields {
  /** Field names to send as sysparm_fields; never empty, never a wildcard. */
  readonly fields: readonly string[];
  /** True when the table has more columns than were requested. */
  readonly capped: boolean;
  /** Total columns discovered, present only when the lookup succeeded. */
  readonly total?: number;
}

/**
 * Resolve a bounded projection for a wildcard selection.
 *
 * Ordering is deterministic and stable: the table's curated default projection
 * first, in its declared order, then every remaining column alphabetically. The
 * defaults lead because they are the fields a caller almost always wants, so a
 * capped result stays useful rather than returning whichever hundred columns
 * happened to sort first; alphabetical afterwards because dictionary row order
 * is not stable across instances and would make the same call return different
 * fields on different deployments.
 */
export async function boundedAllFields(
  client: ServiceNowOperations,
  table: string,
  defaults: readonly string[],
  forceRecache = false
): Promise<BoundedAllFields> {
  const fallback = Object.freeze({
    fields: Object.freeze([...defaults]),
    capped: true,
  });
  if (defaults.length === 0) return fallback;
  try {
    const columns = await dictionaryColumns(client, table, forceRecache);
    if (columns.length === 0) return fallback;
    const ordered = orderColumns(columns, defaults);
    return Object.freeze({
      fields: Object.freeze(ordered.slice(0, MAX_ALL_FIELDS)),
      capped: ordered.length > MAX_ALL_FIELDS,
      total: ordered.length,
    });
  } catch {
    // A dictionary read that fails must not widen the request. The default
    // projection is bounded and always safe to send.
    return fallback;
  }
}

/** Defaults first in declared order, then the rest alphabetically. */
function orderColumns(
  columns: readonly string[],
  defaults: readonly string[]
): readonly string[] {
  const available = new Set(columns);
  const leading = defaults.filter((field) => available.has(field));
  const led = new Set(leading);
  const trailing = columns.filter((field) => !led.has(field)).sort();
  return [...leading, ...trailing];
}

async function dictionaryColumns(
  client: ServiceNowOperations,
  table: string,
  forceRecache: boolean
): Promise<readonly string[]> {
  const hierarchy = await tableHierarchy(client, table, forceRecache);
  const response = await client.get<{ result?: unknown[] }>(
    "/api/now/table/sys_dictionary",
    {
      sysparm_query:
        `nameIN${hierarchy.map((name) => escapeQueryValue(name)).join(",")}` +
        "^internal_type!=collection^ORDERBYelement",
      sysparm_fields: "element",
      sysparm_limit: String(MAX_DICTIONARY_ROWS),
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
      ...(forceRecache ? { [FORCE_RECACHE_PARAM]: "true" } : {}),
    }
  );
  const rows = Array.isArray(response?.result) ? response.result : [];
  const columns = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const element = (row as Record<string, unknown>).element;
    if (typeof element !== "string") continue;
    const normalized = element.trim().toLowerCase();
    // A sensitive name must never be *requested*. Under a wildcard selection
    // the value was scrubbed from the response after arriving; naming it in
    // sysparm_fields would pull it over the wire on purpose, which is worse.
    if (ELEMENT_NAME.test(normalized) && !isSensitiveFieldName(normalized)) {
      columns.add(normalized);
    }
  }
  return [...columns];
}

/** Walk super_class so an extended table contributes its inherited columns. */
async function tableHierarchy(
  client: ServiceNowOperations,
  table: string,
  forceRecache: boolean
): Promise<readonly string[]> {
  const hierarchy: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = table;
  for (let depth = 0; current && depth < MAX_HIERARCHY_DEPTH; depth += 1) {
    const normalized = current.trim().toLowerCase();
    if (!ELEMENT_NAME.test(normalized) || seen.has(normalized)) break;
    seen.add(normalized);
    hierarchy.push(normalized);
    const response = await client.get<{ result?: unknown[] }>(
      "/api/now/table/sys_db_object",
      {
        sysparm_query: `name=${escapeQueryValue(normalized)}`,
        sysparm_fields: "name,super_class",
        sysparm_limit: "1",
        sysparm_display_value: "true",
        sysparm_exclude_reference_link: "true",
        ...(forceRecache ? { [FORCE_RECACHE_PARAM]: "true" } : {}),
      }
    );
    const row = Array.isArray(response?.result) ? response.result[0] : undefined;
    current = superClassName(row);
  }
  return hierarchy.length > 0 ? hierarchy : [table];
}

function superClassName(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const value = (row as Record<string, unknown>).super_class;
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "object" && value !== null) {
    const display = (value as Record<string, unknown>).display_value;
    if (typeof display === "string" && display.trim() !== "") return display;
  }
  return undefined;
}

/** Caller-visible notice explaining a capped projection. */
export function allFieldsCapNotice(bounded: BoundedAllFields, table: string): string {
  return bounded.total === undefined
    ? `Field selection "all" could not be resolved for ${table}; returned the ` +
        `default ${bounded.fields.length}-field projection. Name fields explicitly to choose others.`
    : `Field selection "all" was capped at ${bounded.fields.length} of ` +
        `${bounded.total} columns on ${table}. Other columns exist and are ` +
        `readable -- name them explicitly to retrieve them.`;
}
