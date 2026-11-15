import { z } from "zod";
import {
  isServiceNowResponseTooLarge,
  runWithServiceNowRequestSignal,
  type ServiceNowOperations,
} from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
  type FieldSelection,
} from "../field-policy.js";
import { ok, escapeQueryValue, formatError, withWarnings } from "../utils.js";
import { createCommonToolError } from "../tool-error.js";
import {
  CODE_SEARCH_TARGETS,
  codeSearchTarget,
  searchProjection,
  type CodeSearchTarget,
} from "../code-search-targets.js";
import { snippetAround } from "../code-search-snippet.js";
import { normalizeTableName } from "../table-policy.js";

export const definition = {
  name: "sn_codesearch",
  description:
    "Search across ServiceNow code artifacts — business rules, script includes, UI scripts, client scripts, and scripted REST operations. Returns matching records with code snippets.",
  annotations: {
    title: "Search code artifacts",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z.object({
  search_term: z.string().describe("Text to search for in script fields"),
  table: z.string().optional().describe("Search a specific table only (default: searches all code tables). Options: sys_script, sys_script_include, sys_ui_script, sys_script_client, sys_ws_operation"),
  field: z.string().optional().describe("Specific field to search (default: script)"),
  limit: z.number().int().min(1).max(1000).optional().default(20).describe("Max total results (default 20, max 1000)"),
  offset: z.number().int().min(0).max(10000).optional().default(0).describe("Deterministic combined-result offset (default 0)"),
});

/**
 * A single-table search of at most this many rows (the page and its sentinel)
 * reads each script in the same request that finds it. A bigger page, or a
 * search across tables, first finds the rows without their scripts and then
 * reads the scripts of the rows it returns. Bodies run to kilobytes, so reading
 * a window of them from every table was what passed the response cap.
 */
const INLINE_MAX_ROWS = 50;
/** Scripts read in one request. A batch that is still too large is halved. */
const BODY_BATCH_ROWS = 50;
/** Body requests in flight; the client's per-origin limiter is 4 as well. */
const BODY_CONCURRENCY = 4;
const SYS_ID = /^[0-9a-f]{32}$/u;
const TOO_LARGE_NOTE = "script too large to preview";

interface Selected {
  readonly target: CodeSearchTarget;
  /** The field searched, and the one a snippet is cut from. */
  readonly field: string;
}

/** One matching row, found before its script is read. */
interface Match {
  readonly selected: Selected;
  /** Position among this table's matches, in sys_id order. */
  readonly rank: number;
  readonly sysId: string;
  readonly name: string;
  /** The fields the policy lets this call read from the table. */
  readonly readable: FieldSelection;
  /** The searched value, once read: `undefined` until then. */
  body?: string;
  /** Set when the script alone passed the response cap. */
  tooLarge?: boolean;
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  context: ExecutionContext
) {
  const signal = context?.signal;
  const term = escapeQueryValue(args.search_term);
  const selection = selectTargets(args);
  const single = selection.length === 1;
  const warnings: string[] = [];

  // A search of one table reads exactly the page asked for (the instance
  // applies the offset). A search of several takes turns through the tables,
  // and where a row falls in that order depends on how many rows the others
  // have, so each table is read from the start, as far as the page can reach.
  const windowLimit = single ? args.limit + 1 : args.offset + args.limit + 1;
  const windowOffset = single ? args.offset : 0;
  const inline = single && args.limit + 1 <= INLINE_MAX_ROWS;

  // The reads are independent, so they run together instead of one round trip
  // after another (each also costs a watermark read when the table is cached).
  // The client's per-origin limiter bounds how many are in flight. Each read has
  // its own response-byte scope, so one table's large answer cannot spend the
  // budget of another. Results, warnings and failures are merged in target
  // order after the join, so the output does not depend on which finished first.
  const outcomes = await Promise.all(
    selection.map(async (selected) => {
      try {
        return {
          matches: await findWithFallback(
            client,
            signal,
            args,
            selected,
            term,
            windowOffset,
            windowLimit,
            inline
          ),
        } as const;
      } catch (error) {
        // Tables can fail (ACL issues, etc.) -- report, don't hide
        if (signal?.aborted) throw error;
        return { error } as const;
      }
    })
  );

  const found: Match[][] = [];
  const failures: unknown[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    if ("error" in outcome) {
      failures.push(outcome.error);
      warnings.push(`${selection[index]!.target.table}: ${formatError(outcome.error)}`);
    } else {
      found.push(outcome.matches);
    }
  }

  // Every sub-search failed: that is a failure, not "no matches" --
  // an empty success here would read as "nothing references this".
  if (failures.length === selection.length) {
    throw createCommonToolError(failures);
  }

  // One more row than the page holds says whether there is a next page.
  const page = single
    ? (found[0] ?? [])
    : interleave(found).slice(args.offset, args.offset + args.limit + 1);

  await readBodies(client, signal, page.slice(0, args.limit), warnings);

  return ok(
    withWarnings(
      page.map((match) => toRow(match, term)),
      warnings
    )
  );
}

/** The tables this call searches: all, or the one named. */
function selectTargets(args: z.infer<typeof schema>): Selected[] {
  if (args.table !== undefined) {
    const target = codeSearchTarget(normalizeTableName(args.table));
    if (target === undefined) throw new TypeError("table is not searchable");
    return [{ target, field: args.field || target.defaultField }];
  }
  const all = CODE_SEARCH_TARGETS.map((target) => ({ target, field: target.defaultField }));
  return all;
}

/**
 * Find a table's matches. A page read with its scripts that still passes the
 * response cap (a few very large scripts) is read again without them, in its own
 * fresh scope, so the scripts are read in batches afterwards instead.
 */
async function findWithFallback(
  client: ServiceNowOperations,
  signal: AbortSignal | undefined,
  args: z.infer<typeof schema>,
  selected: Selected,
  term: string,
  offset: number,
  limit: number,
  inline: boolean
): Promise<Match[]> {
  try {
    return await inFreshBudget(signal, () =>
      findMatches(client, args, selected, term, offset, limit, inline)
    );
  } catch (error) {
    if (!inline || signal?.aborted || !isServiceNowResponseTooLarge(error)) throw error;
    return inFreshBudget(signal, () =>
      findMatches(client, args, selected, term, offset, limit, false)
    );
  }
}

/**
 * The rows of one table that match, in sys_id order. With `inline`, each row
 * carries the searched value too; otherwise only its identifier and name.
 */
async function findMatches(
  client: ServiceNowOperations,
  args: z.infer<typeof schema>,
  selected: Selected,
  term: string,
  offset: number,
  limit: number,
  inline: boolean
): Promise<Match[]> {
  const { target, field } = selected;
  const wanted = inline
    ? searchProjection(target.nameField, field)
    : searchProjection(target.nameField, target.nameField);
  const fallback = resolveReadableFields(target.table, {
    fields: searchProjection(target.nameField, field).join(","),
  });
  const readableFields = preparedReadableFields(args, target.table) ?? fallback;
  const resp = await client.get(`/api/now/table/${target.table}`, {
    // `sysparm_orderby` is not a Table API parameter; ordering is part of the
    // encoded query. Without it the window is not a stable prefix of the
    // table, and an offset can skip or repeat a record.
    sysparm_query: `${escapeQueryValue(field)}LIKE${term}^ORDERBYsys_id`,
    sysparm_fields: wanted.join(","),
    sysparm_limit: String(limit),
    sysparm_offset: String(offset),
    sysparm_no_count: "true",
  });

  const filtered = filterReadableRecord(rowsOf(resp), readableFields);
  const matches: Match[] = [];
  for (const candidate of Array.isArray(filtered) ? filtered : []) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    // The name column is also what was searched when the caller searches it.
    const searched = inline || field === target.nameField || field === "sys_id";
    matches.push({
      selected,
      rank: matches.length,
      sysId: String(record.sys_id ?? ""),
      name: String(record[target.nameField] || "unnamed"),
      readable: readableFields,
      ...(searched && record[field] !== undefined ? { body: String(record[field]) } : {}),
    });
  }
  return matches;
}

/**
 * Take turns through the tables: each table's first match (script includes
 * first), then each table's second, and so on, so no table crowds the others
 * off the first page. The order depends only on the rows and the fixed table
 * order, never on which read finished first.
 */
function interleave(perTable: readonly (readonly Match[])[]): Match[] {
  return perTable
    .flatMap((matches, order) => matches.map((match) => ({ match, order })))
    .sort((left, right) => left.match.rank - right.match.rank || left.order - right.order)
    .map(({ match }) => match);
}

/**
 * Read the script of each row that has none yet, a table at a time in batches
 * of ids, each batch in its own response scope. A batch that passes the cap is
 * halved until it fits, and a single script that does not is marked, so one
 * large script costs its own snippet and not the page. Any other failure
 * leaves those rows without a snippet and says why.
 */
async function readBodies(
  client: ServiceNowOperations,
  signal: AbortSignal | undefined,
  page: readonly Match[],
  warnings: string[]
): Promise<void> {
  const batches: Array<{ readonly selected: Selected; readonly matches: Match[] }> = [];
  const byTable = new Map<string, Match[]>();
  for (const match of page) {
    if (match.body !== undefined || !SYS_ID.test(match.sysId)) continue;
    const group = byTable.get(match.selected.target.table);
    if (group === undefined) byTable.set(match.selected.target.table, [match]);
    else group.push(match);
  }
  for (const group of byTable.values()) {
    for (let at = 0; at < group.length; at += BODY_BATCH_ROWS) {
      batches.push({ selected: group[0]!.selected, matches: group.slice(at, at + BODY_BATCH_ROWS) });
    }
  }

  const failed = new Map<string, unknown>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batch = batches[next]!;
      next += 1;
      try {
        await readBatch(client, signal, batch.selected, batch.matches);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!failed.has(batch.selected.target.table)) {
          failed.set(batch.selected.target.table, error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BODY_CONCURRENCY, batches.length) }, worker));
  for (const [table, error] of failed) {
    warnings.push(`${table}: snippets unavailable for some results. ${formatError(error)}`);
  }
}

async function readBatch(
  client: ServiceNowOperations,
  signal: AbortSignal | undefined,
  selected: Selected,
  matches: readonly Match[]
): Promise<void> {
  const { target, field } = selected;
  try {
    const resp = await inFreshBudget(signal, () =>
      client.get(`/api/now/table/${target.table}`, {
        sysparm_query: `sys_idIN${matches.map((match) => match.sysId).join(",")}`,
        sysparm_fields: searchProjection("sys_id", field).join(","),
        sysparm_limit: String(matches.length),
        sysparm_no_count: "true",
      })
    );
    const filtered = filterReadableRecord(rowsOf(resp), matches[0]!.readable);
    const bodies = new Map<string, string>();
    for (const candidate of Array.isArray(filtered) ? filtered : []) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const record = candidate as Record<string, unknown>;
      if (typeof record.sys_id === "string" && record[field] !== undefined) {
        bodies.set(record.sys_id, String(record[field]));
      }
    }
    for (const match of matches) {
      const body = bodies.get(match.sysId);
      if (body !== undefined) match.body = body;
    }
  } catch (error) {
    if (signal?.aborted || !isServiceNowResponseTooLarge(error)) throw error;
    if (matches.length === 1) {
      matches[0]!.tooLarge = true;
      return;
    }
    const half = Math.ceil(matches.length / 2);
    await readBatch(client, signal, selected, matches.slice(0, half));
    await readBatch(client, signal, selected, matches.slice(half));
  }
}

function toRow(match: Match, term: string): Record<string, unknown> {
  const { target } = match.selected;
  const row: Record<string, unknown> = {
    table: target.table,
    table_label: target.label,
    sys_id: match.sysId,
    name: match.name,
  };
  if (match.body) {
    const { text, line } = snippetAround(match.body, term);
    row.snippet = text;
    if (line !== undefined) row.line = line;
  } else {
    row.snippet = "";
    if (match.tooLarge) row.note = TOO_LARGE_NOTE;
  }
  return row;
}

function rowsOf(response: unknown): unknown {
  if (typeof response !== "object" || response === null) return [];
  const result = (response as { result?: unknown }).result;
  return result || [];
}

/**
 * Run `operation` in its own response-byte scope, bound to the call's signal.
 * A read that passes the cap then costs only its own scope, and the next read
 * starts with a full budget. Without a signal (a direct handler call) it runs in
 * the caller's scope.
 */
function inFreshBudget<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return signal instanceof AbortSignal
    ? runWithServiceNowRequestSignal(signal, operation)
    : operation();
}
