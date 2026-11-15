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
import { ok, escapeQueryValue, formatError, withWarnings, MAX_RESPONSE_BYTES_DEFAULT } from "../utils.js";
import { createCommonToolError } from "../tool-error.js";
import {
  CODE_SEARCH_TARGETS,
  codeSearchReads,
  codeSearchTarget,
  searchProjection,
  type CodeSearchTarget,
} from "../code-search-targets.js";
import { snippetAround } from "../code-search-snippet.js";
import { normalizeTableName } from "../table-policy.js";

export const definition = {
  name: "sn_codesearch",
  description:
    "Search across ServiceNow code artifacts — business rules, script includes, UI scripts, client scripts, scripted REST operations, ES modules and ATF step scripts. Returns matches with a snippet around the first hit; with no table, tables take turns so each is on page 1.",
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
  table: z.string().optional().describe("Search one table only (default: all code tables you may read). Options: sys_script, sys_script_include, sys_ui_script, sys_script_client, sys_ws_operation, sys_module, sys_atf_step"),
  field: z.string().optional().describe("Specific field to search (default: the table's script field)"),
  limit: z.number().int().min(1).max(1000).optional().default(20).describe("Max total results (default 20, max 1000)"),
  offset: z.number().int().min(0).max(10000).optional().default(0).describe("Offset into the combined results (default 0)"),
});

/**
 * A single-table search of at most this many rows (the page and its sentinel)
 * reads each script in the same request that finds it. A bigger page, or a
 * search across tables, first finds the rows without their scripts and then
 * reads the scripts of the rows it returns. Bodies run to kilobytes, so reading
 * a window of them from every table was what passed the response cap.
 */
const INLINE_MAX_ROWS = 50;
/** Records read in one request by id. A batch that is still too large is halved. */
const BATCH_ROWS = 50;
/** Requests by id in flight; the client's per-origin limiter is 4 as well. */
const BATCH_CONCURRENCY = 4;
/**
 * What one search may spend on reading scripts by id, whatever the scripts'
 * sizes: requests (a retry after a too-large answer counts), and bytes pulled,
 * with an answer that passed the cap counted at the cap.
 */
/** A first batch of more rows than this is read alone before the others start. */
const PROBE_ROWS = 4;
const BODY_MAX_REQUESTS = 12;
const BODY_MAX_BYTES = 8 * 1024 * 1024;
/** The client's cap on one response, which a failed attempt may have pulled in full. */
const RESPONSE_CAP_BYTES = 1024 * 1024;
/** A snippet's length (the window plus its two markers), and room for an ATF row's longer name. */
const SNIPPET_ROOM = 206;
const ATF_NAME_ROOM = 40;
const SYS_ID = /^[0-9a-f]{32}$/u;
const TOO_LARGE_NOTE = "script too large to preview";
const UNNAMED = "unnamed";

interface Selected {
  readonly target: CodeSearchTarget;
  /** The field searched, and the one a snippet is cut from. */
  readonly field: string;
  /** Named by the caller; its rows carry the table name as their label, as they always have. */
  readonly named: boolean;
}

/** One matching row, found before its script is read. */
interface Match {
  readonly selected: Selected;
  /** Position among this table's matches, in sys_id order. */
  readonly rank: number;
  /** The row's id in the table that was searched. */
  readonly sysId: string;
  /** The record the row is about, which is `sysId` unless a lookup finds it. */
  readonly recordId: string;
  name: string;
  /** The fields the policy lets this call read from the searched table. */
  readonly readable: FieldSelection;
  /** The searched value, once read: `undefined` until then. */
  body?: string;
  /** Set when the script alone passed the response cap. */
  tooLarge?: boolean;
  /** The most rows a batch holding this one may have, once a batch with it passed the cap. */
  ceiling?: number;
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  context: ExecutionContext
) {
  const signal = context?.signal;
  const term = escapeQueryValue(args.search_term);
  const { selection, skipped } = selectTargets(args);
  const single = selection.length === 1;
  const warnings: string[] = [];
  if (skipped.length > 0) warnings.push(skippedWarning(skipped));

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

  // The row that only says "there is more" is cut from the page, and so are the
  // rows past what one response holds, so neither their scripts nor their names
  // are read.
  const returned = rowsTheResponseCanHold(page.slice(0, args.limit));
  await Promise.all([
    readBodies(client, signal, returned, warnings),
    nameAtfSteps(client, signal, args, returned, warnings),
  ]);

  return ok(
    withWarnings(
      page.map((match) => toRow(match, term)),
      warnings
    )
  );
}

/**
 * The tables this call searches: the one named, or every code table the
 * profile may read. The dispatcher's access plan marks only the tables it
 * authorized, with the fields it approved, so a table without that mark was
 * refused by the table policy or the field policy and is skipped. A call that
 * did not come through the dispatcher carries no marks and searches all of them.
 */
function selectTargets(args: z.infer<typeof schema>): {
  readonly selection: Selected[];
  readonly skipped: CodeSearchTarget[];
} {
  if (args.table !== undefined) {
    const target = codeSearchTarget(normalizeTableName(args.table));
    if (target === undefined) throw new TypeError("table is not searchable");
    return {
      selection: [
        {
          target,
          field: target.fixedField ? target.defaultField : args.field || target.defaultField,
          named: true,
        },
      ],
      skipped: [],
    };
  }
  const all = CODE_SEARCH_TARGETS.map((target) => ({
    target,
    field: target.defaultField,
    named: false,
  }));
  const authorized = all.filter((entry) =>
    codeSearchReads(entry.target).every(
      (table) => preparedReadableFields(args, table) !== undefined
    )
  );
  if (authorized.length === 0) return { selection: all, skipped: [] };
  return {
    selection: authorized,
    skipped: all.filter((entry) => !authorized.includes(entry)).map((entry) => entry.target),
  };
}

/**
 * Name the tables a search left out. Fixed table names and one fixed command:
 * nothing of the profile's rules, and nothing the caller sent. A target that
 * reads several tables says which, since a grant on its own table is not enough.
 */
function skippedWarning(targets: readonly CodeSearchTarget[]): string {
  const names = targets.map((target) => {
    const reads = codeSearchReads(target);
    return reads.length > 1 ? `${target.table} (needs read on ${reads.join(", ")})` : target.table;
  });
  return (
    `Not searched, because this profile does not allow sn_codesearch to read ` +
    `${names.length === 1 ? "it" : "them"}: ${names.join(", ")}. ` +
    `To include ${names.length === 1 ? "it" : "one"}, run servicenow-mcp-setup grant ` +
    `--profile <profile> --read <table> --tools sn_codesearch.`
  );
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
  const fallback = resolveReadableFields(target.queryTable, {
    fields: searchProjection(target.nameField, field).join(","),
  });
  const readableFields = preparedReadableFields(args, target.queryTable) ?? fallback;
  const likeField = `${escapeQueryValue(field)}LIKE${term}`;
  const resp = await client.get(`/api/now/table/${target.queryTable}`, {
    // `sysparm_orderby` is not a Table API parameter; ordering is part of the
    // encoded query. Without it the window is not a stable prefix of the
    // table, and an offset can skip or repeat a record.
    sysparm_query: `${target.fixedQuery === undefined ? "" : `${target.fixedQuery}^`}${likeField}^ORDERBYsys_id`,
    sysparm_fields: wanted.join(","),
    sysparm_limit: String(limit),
    sysparm_offset: String(offset),
    sysparm_no_count: "true",
    // A reference or document field (an ATF value's `document_key`) arrives as
    // `{ link, value }` unless asked for as its value alone.
    sysparm_exclude_reference_link: "true",
  });

  const filtered = filterReadableRecord(rowsOf(resp), readableFields);
  const matches: Match[] = [];
  for (const candidate of Array.isArray(filtered) ? filtered : []) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    // The name column is also what was searched when the caller searches it.
    const searched = inline || field === target.nameField || field === "sys_id";
    const sysId = String(record.sys_id ?? "");
    // A target named by a lookup keeps the record it is about in its name field.
    const named = target.lookups.length === 0;
    matches.push({
      selected,
      rank: matches.length,
      sysId,
      recordId: named ? sysId : (referenceId(record[target.nameField]) ?? ""),
      name: named ? String(record[target.nameField] || UNNAMED) : UNNAMED,
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
 * Read the script of each row that has none yet, in batches of ids, each batch
 * in its own response scope, within a budget for the whole call.
 *
 * Each batch has its own 1 MiB scope, so nothing else bounds the work: with
 * large scripts every batch can pass the cap and be retried smaller. The budget
 * does (BODY_MAX_REQUESTS requests, BODY_MAX_BYTES pulled, a failed attempt
 * counted at the response cap, in-flight requests reserved at it). When it is
 * spent the remaining rows keep an empty snippet and one warning says how many.
 *
 * A first batch of more than a few rows is read alone, and what it learns is kept: a batch that
 * passes the cap makes the next ones half its size (a clean, small answer lets
 * the size grow again), instead of every batch starting at 50 and failing. A
 * batch of one that passes the cap marks its row. Rows are read in page order,
 * so a spent budget leaves the later rows without a snippet. Any other failure
 * leaves those rows without a snippet and says why.
 */
async function readBodies(
  client: ServiceNowOperations,
  signal: AbortSignal | undefined,
  page: readonly Match[],
  warnings: string[]
): Promise<void> {
  const queue = page.filter((match) => match.body === undefined && SYS_ID.test(match.sysId));
  if (queue.length === 0) return;
  const state = { requests: 0, bytes: 0, size: BATCH_ROWS };
  const failed = new Map<string, unknown>();
  const spent = (): boolean =>
    state.requests >= BODY_MAX_REQUESTS || state.bytes + RESPONSE_CAP_BYTES > BODY_MAX_BYTES;

  const readOne = async (): Promise<boolean> => {
    if (queue.length === 0 || spent()) return false;
    const batch = takeBatch(queue, state.size);
    state.requests += 1;
    state.bytes += RESPONSE_CAP_BYTES;
    try {
      const pulled = await readBatch(client, signal, batch);
      state.bytes += pulled - RESPONSE_CAP_BYTES;
      if (pulled < RESPONSE_CAP_BYTES / 4) state.size = Math.min(BATCH_ROWS, state.size * 2);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isServiceNowResponseTooLarge(error)) {
        // The attempt may have pulled up to the cap: keep it counted.
        if (batch.length === 1) batch[0]!.tooLarge = true;
        else {
          const half = Math.max(1, Math.ceil(batch.length / 2));
          state.size = Math.max(1, Math.min(state.size, half));
          // These rows are read again in halves, and never regrouped into a
          // batch as large as the one that failed: a later success must not
          // bring one large script back into a big batch.
          for (const match of batch) match.ceiling = Math.min(match.ceiling ?? half, half);
          queue.unshift(...batch);
        }
      } else {
        state.bytes -= RESPONSE_CAP_BYTES;
        const table = batch[0]!.selected.target.table;
        if (!failed.has(table)) failed.set(table, error);
      }
    }
    return true;
  };
  const worker = async (): Promise<void> => {
    while (await readOne()) {
      // keep going until the queue or the budget is spent
    }
  };

  // A batch of a few rows cannot pass the cap (the largest script seen is about
  // a quarter of it), so only a larger first batch is read alone to learn from.
  const firstTable = queue[0]!.selected.target.table;
  if (queue.filter((match) => match.selected.target.table === firstTable).length > PROBE_ROWS) {
    await readOne();
  }
  await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, worker));

  for (const [table, error] of failed) {
    warnings.push(`${table}: snippets unavailable for some results. ${formatError(error)}`);
  }
  const unread = queue.filter((match) => match.body === undefined && !match.tooLarge).length;
  if (unread > 0 && failed.size === 0) {
    warnings.push(
      `Script bodies were not read for ${unread} result${unread === 1 ? "" : "s"}: the read ` +
        `budget for one search (${BODY_MAX_REQUESTS} requests, ${BODY_MAX_BYTES / (1024 * 1024)} MiB) was reached, ` +
        `so their snippets are empty. Lower limit to read them.`
    );
  }
}

/**
 * The next batch: up to `size` rows of the table of the first queued row, in
 * order, and no more than any row in it can take (see `ceiling`).
 */
function takeBatch(queue: Match[], size: number): Match[] {
  const table = queue[0]!.selected.target.table;
  const batch: Match[] = [];
  let room = size;
  for (let at = 0; at < queue.length && batch.length < room; ) {
    const candidate = queue[at]!;
    if (candidate.selected.target.table !== table) {
      at += 1;
      continue;
    }
    const next = Math.min(room, candidate.ceiling ?? room);
    if (batch.length + 1 > next) break;
    room = next;
    batch.push(...queue.splice(at, 1));
  }
  return batch;
}

/** Read one batch of scripts by id and return about how many bytes it pulled. */
async function readBatch(
  client: ServiceNowOperations,
  signal: AbortSignal | undefined,
  matches: readonly Match[]
): Promise<number> {
  const { target, field } = matches[0]!.selected;
  const resp = await inFreshBudget(signal, () =>
    client.get(`/api/now/table/${target.queryTable}`, {
      sysparm_query: `sys_idIN${matches.map((match) => match.sysId).join(",")}`,
      sysparm_fields: searchProjection("sys_id", field).join(","),
      sysparm_limit: String(matches.length),
      sysparm_no_count: "true",
      sysparm_exclude_reference_link: "true",
    })
  );
  const filtered = filterReadableRecord(rowsOf(resp), matches[0]!.readable);
  const bodies = new Map<string, string>();
  let pulled = 0;
  for (const candidate of Array.isArray(filtered) ? filtered : []) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.sys_id === "string" && record[field] !== undefined) {
      const body = String(record[field]);
      bodies.set(record.sys_id, body);
      pulled += body.length + 64;
    }
  }
  for (const match of matches) {
    const body = bodies.get(match.sysId);
    if (body !== undefined) match.body = body;
  }
  return pulled;
}

/**
 * The rows of the page that the response can hold. The envelope keeps rows
 * while their serialized size fits its byte limit and drops the rest, so a
 * script read for a row past that point is a script nobody sees. Each row is
 * counted at its size with a full-length snippet, a little over what it will be.
 */
function rowsTheResponseCanHold(page: readonly Match[]): Match[] {
  let used = 0;
  const held: Match[] = [];
  for (const match of page) {
    used += JSON.stringify({
      table: match.selected.target.table,
      table_label: match.selected.target.label,
      sys_id: match.recordId,
      name: match.name,
      snippet: "x".repeat(SNIPPET_ROOM),
      line: 99_999,
    }).length + (match.selected.target.lookups.length > 0 ? ATF_NAME_ROOM : 0);
    if (used > MAX_RESPONSE_BYTES_DEFAULT) break;
    held.push(match);
  }
  return held;
}

/**
 * Say which test and step each ATF match belongs to. The match is a value that
 * belongs to a step (its `document_key`); the steps are read by id for their
 * test and order, then the tests for their names. Both are tables the access
 * plan already authorized, read with the fields it approved. A step or test that
 * cannot be read leaves the row with the name "unnamed" and says why.
 */
async function nameAtfSteps(
  client: ServiceNowOperations,
  signal: AbortSignal | undefined,
  args: z.infer<typeof schema>,
  page: readonly Match[],
  warnings: string[]
): Promise<void> {
  const matches = page.filter(
    (match) => match.selected.target.lookups.length > 0 && SYS_ID.test(match.recordId)
  );
  if (matches.length === 0) return;
  const [stepLookup, testLookup] = matches[0]!.selected.target.lookups;

  const steps = new Map<string, { test: string | undefined; order: string | undefined }>();
  const stepIds = [...new Set(matches.map((match) => match.recordId))];
  const stepFailures = await runJobs(
    signal,
    chunks(stepIds, BATCH_ROWS).map((ids) => ({
      table: stepLookup!.table,
      run: async () => {
        for (const record of await readByIds(client, signal, args, stepLookup!, ids)) {
          if (typeof record.sys_id === "string") {
            steps.set(record.sys_id, {
              test: referenceId(record.test),
              order: scalar(record.order),
            });
          }
        }
      },
    }))
  );

  const tests = new Map<string, string>();
  const testIds = [
    ...new Set([...steps.values()].flatMap((step) => (step.test === undefined ? [] : [step.test]))),
  ];
  const testFailures = await runJobs(
    signal,
    chunks(testIds, BATCH_ROWS).map((ids) => ({
      table: testLookup!.table,
      run: async () => {
        for (const record of await readByIds(client, signal, args, testLookup!, ids)) {
          if (typeof record.sys_id === "string" && typeof record.name === "string" && record.name) {
            tests.set(record.sys_id, record.name);
          }
        }
      },
    }))
  );

  for (const match of matches) {
    const step = steps.get(match.recordId);
    if (step === undefined) continue;
    const test = step.test === undefined ? undefined : tests.get(step.test);
    const position = step.order === undefined ? "step" : `step ${step.order}`;
    match.name = test === undefined ? position : `${test} > ${position}`;
  }
  for (const [table, error] of [...stepFailures, ...testFailures]) {
    warnings.push(`${table}: names unavailable for some results. ${formatError(error)}`);
  }
}

/** The records of a lookup table with these ids, with only the fields the access plan approved. */
async function readByIds(
  client: ServiceNowOperations,
  signal: AbortSignal | undefined,
  args: z.infer<typeof schema>,
  lookup: { readonly table: string; readonly fields: readonly string[] },
  ids: readonly string[]
): Promise<Record<string, unknown>[]> {
  const readable =
    preparedReadableFields(args, lookup.table) ??
    resolveReadableFields(lookup.table, { fields: lookup.fields.join(",") });
  const resp = await inFreshBudget(signal, () =>
    client.get(`/api/now/table/${lookup.table}`, {
      sysparm_query: `sys_idIN${ids.join(",")}`,
      sysparm_fields: lookup.fields.join(","),
      sysparm_limit: String(ids.length),
      sysparm_no_count: "true",
      sysparm_exclude_reference_link: "true",
    })
  );
  const filtered = filterReadableRecord(rowsOf(resp), readable);
  return (Array.isArray(filtered) ? filtered : []).filter(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
  );
}

/** A reference's id, whether the instance sent it bare or as `{ value }`. */
function referenceId(value: unknown): string | undefined {
  const candidate =
    typeof value === "object" && value !== null ? (value as { value?: unknown }).value : value;
  return typeof candidate === "string" && SYS_ID.test(candidate) ? candidate : undefined;
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function toRow(match: Match, term: string): Record<string, unknown> {
  const { target } = match.selected;
  const row: Record<string, unknown> = {
    table: target.table,
    table_label: match.selected.named ? target.table : target.label,
    sys_id: match.recordId,
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

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/**
 * Run jobs with a few in flight, in the order given. A job that fails does not
 * stop the others; the first failure of each table is returned. A cancelled
 * call rethrows, since nothing after it should run.
 */
async function runJobs(
  signal: AbortSignal | undefined,
  jobs: ReadonlyArray<{ readonly table: string; readonly run: () => Promise<void> }>
): Promise<Map<string, unknown>> {
  const failed = new Map<string, unknown>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next]!;
      next += 1;
      try {
        await job.run();
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!failed.has(job.table)) failed.set(job.table, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, jobs.length) }, worker));
  return failed;
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
