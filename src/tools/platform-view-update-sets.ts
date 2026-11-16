/**
 * `sn_platform_view`, the update set views: `update_sets`, `update_set`,
 * `changes` (with the masked payload of one change), `batch` and
 * `remote_update_sets`.
 *
 * Reads, each group in its own 1 MiB response scope, at most
 * {@link UPDATE_SET_VIEW_LIMITS}.MAX_SCOPES (6) scopes per call, never cached:
 * - `update_sets`: one page of `sys_update_set`, then one Aggregate API count
 *   of `sys_update_xml` grouped by `update_set` for that page (a set with no
 *   rows has no group: its count is 0). 2 requests.
 * - `update_set`: the set (by sys_id or exact name), then together: its row
 *   counts grouped by `type` and `action`, its children (at most 50 shown),
 *   and the retrieved set it came from (`remote_sys_id`). At most 4 requests.
 * - `changes`: the set (local, or retrieved with `remote_update_set`), its
 *   descendants one level per read when `include_children` (depth and count
 *   capped, cycle-safe), then one page of `sys_update_xml` metadata. With
 *   `change` and `payload: true`, the one change's payload, then the
 *   hierarchies and field types of the tables it writes (see
 *   `platform-view-payload.ts`).
 * - `batch`: the member, its batch root (`base_update_set`, else the
 *   member's parents), the tree under the root one level per read (depth at
 *   most 10, at most 200 sets, cycle-safe), and the row counts per set (one
 *   Aggregate API read per 100 sets).
 * - `remote_update_sets`: one page of `sys_remote_update_set`; with
 *   `remote_update_set` and `problems: true`, that set, one page of its
 *   preview problems and their counts by type and status.
 *
 * Every read names its fields. `sys_update_xml.payload` is asked for only by
 * the payload read, and only when field policy lets the profile read it;
 * `payload_diff` never. Every field the views filter or order on must be
 * readable, or the call is `denied` before it reads. Every row passes the
 * field access before it is projected.
 *
 * Queries are built from canonical selectors (escaped by the dispatcher) and
 * validated sys_ids only; no instance text ever shapes a query. A 403 on a
 * view's first table is `status: "denied"`, and a missing table
 * `status: "unavailable"`, each with a fixed hint, never an empty success.
 *
 * Text: instance strings are bounded here and rendered by
 * {@link renderUpdateSetViewText} inside an `untrustedBlock`.
 *
 * @module tools/platform-view-update-sets
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { isServiceNowRequestCancellation, isServiceNowResponseTooLarge, type ServiceNowOperations } from "../client.js";
import { isCredentialTable } from "../credential-tables.js";
import { PLAN_FIELD_TYPE_DOT_WALKS, PLAN_FIELD_TYPE_FIELDS, loadFieldTypesInPlan } from "../hidden-values.js";
import { uncachedOperations } from "../metadata-cache.js";
import { createToolError } from "../tool-error.js";
import { FlowViewScopeBudget } from "./flow-view-module.js";
import { bulletList, headline, renderMarkdown, text, untrustedBlock, type MarkdownFragment } from "./markdown.js";
import type { CanonicalPlatformViewArgs, PlatformView } from "./platform-view-contracts.js";
import {
  PAYLOAD_HINTS,
  payloadCharsFor,
  payloadRefusal,
  preparePayload,
  rowTables,
  type PayloadOutcome,
} from "./platform-view-payload.js";
import {
  FIELD_POLICY_HINT,
  STATS_PATH,
  SYS_ID,
  TABLE_PATH,
  asRecord,
  cleanText,
  errorCategory,
  firstUnreadable,
  flag,
  inOwnScope,
  isMissingTable,
  listParams,
  liveFieldAccess,
  memoizedFieldAccess,
  pageOf,
  readableOf,
  readableRow,
  rowsOf,
  scalar,
  viewResult,
  wholeNumber,
  type FieldAccessHandler,
  type PlatformViewFieldAccess,
} from "./platform-view-upgrades.js";
import type { ServiceNowToolHandlerServices } from "./tool-module.js";

// ---------------------------------------------------------------------------
// Limits, fields and fixed text
// ---------------------------------------------------------------------------

export const UPDATE_SET_VIEW_LIMITS = Object.freeze({
  /** Response scopes per call, each under the client's 1 MiB cap. */
  MAX_SCOPES: 6,
  /** Levels of descendants read through `parent`. */
  MAX_DEPTH: 10,
  /** Sets in a batch tree, the root included. */
  MAX_BATCH_NODES: 200,
  /** Sets whose changes one `changes` call lists, the selected one included. */
  MAX_SCOPE_SETS: 100,
  /** Children listed by `update_set`. */
  MAX_CHILDREN: 50,
  /** Sets per Aggregate API read. */
  STATS_CHUNK: 100,
  /** `type`/`action` groups read for one set's counts. */
  MAX_COUNT_GROUPS: 500,
  DESCRIPTION_CHARS: 200,
  PROBLEM_DESCRIPTION_CHARS: 300,
  NAME_CHARS: 200,
});

const L = UPDATE_SET_VIEW_LIMITS;

/** `sys_update_set`, as the list and the detail views read it. */
export const UPDATE_SET_FIELDS = Object.freeze([
  "sys_id", "name", "state", "application", "is_default", "parent", "base_update_set",
  "sys_created_by", "sys_updated_on", "completed_on", "description",
]);
const UPDATE_SET_DETAIL_FIELDS = Object.freeze([
  ...UPDATE_SET_FIELDS, "completed_by", "remote_sys_id", "sys_created_on",
]);
/** A set as a node of a tree or a child list. */
const UPDATE_SET_NODE_FIELDS = Object.freeze(["sys_id", "name", "state", "parent", "base_update_set"]);
const REMOTE_NODE_FIELDS = Object.freeze(["sys_id", "name", "state", "parent"]);
/** `sys_update_xml` metadata. Never `payload` or `payload_diff`: the payload read adds `payload` alone. */
export const CHANGE_FIELDS = Object.freeze([
  "sys_id", "type", "name", "target_name", "table", "action", "application",
  "sys_updated_by", "sys_updated_on", "replace_on_upgrade", "update_set", "remote_update_set",
]);
/** `sys_remote_update_set`. */
export const REMOTE_SET_FIELDS = Object.freeze([
  "sys_id", "name", "state", "application_scope", "collisions", "inserted", "updated", "deleted",
  "parent", "remote_base_update_set", "update_source", "commit_date", "sys_created_on",
]);
/** `sys_update_preview_problem`. */
export const PROBLEM_FIELDS = Object.freeze([
  "sys_id", "type", "status", "missing_item", "missing_item_table", "remote_update", "description",
  "remote_update_set",
]);

/**
 * Every field these views may request or filter on, by table: what the
 * module prepares (intersected with what the profile may read). The payload
 * read adds `sys_update_xml.payload`; the payload's type lookup reads the two
 * metadata tables through `loadFieldTypesInPlan`.
 */
export const UPDATE_SET_VIEWS_FIELD_PLAN: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sys_update_set: [...UPDATE_SET_DETAIL_FIELDS],
  sys_update_xml: [...CHANGE_FIELDS, "payload"],
  sys_remote_update_set: [...REMOTE_SET_FIELDS],
  sys_update_preview_problem: [...PROBLEM_FIELDS],
  ...PLAN_FIELD_TYPE_FIELDS,
});

/** The dot-walks these views make: only the payload's type lookup, one hop into its own table. */
export const UPDATE_SET_VIEW_DOT_WALKS = PLAN_FIELD_TYPE_DOT_WALKS;

export const UPDATE_SETS_DENIED_HINT = "Reading update sets was denied for this account.";
export const UPDATE_SETS_UNAVAILABLE_HINT = "The update set tables are not available on this instance.";
export const REMOTE_SETS_DENIED_HINT = "Reading retrieved update sets was denied for this account.";
export const REMOTE_SETS_UNAVAILABLE_HINT = "The retrieved update set tables are not available on this instance.";
export const NOT_FOUND_HINT = "No update set matches. Pass its sys_id, or check the name.";
export const REMOTE_NOT_FOUND_HINT = "No retrieved update set has this sys_id.";
export const AMBIGUOUS_HINT = "More than one update set has this name. Pass update_set as a sys_id.";

/** Fixed warnings; nothing in them comes from the instance. */
export const UPDATE_SET_VIEW_WARNINGS = Object.freeze({
  counts_unavailable: "Row counts were not readable; update_count is null.",
  counts_truncated: `More than ${L.MAX_COUNT_GROUPS} type and action groups; the counts cover the first ones.`,
  children_unreadable: "Field policy hides the parent field, so child sets were not read.",
  children_unavailable: "Child sets could not be read.",
  remote_unavailable: "The retrieved set this one came from could not be read.",
  sets_capped: `The scope has more than ${L.MAX_SCOPE_SETS} sets or is deeper than ${L.MAX_DEPTH} levels; changes of the first sets only.`,
  depth_capped: `The batch is deeper than ${L.MAX_DEPTH} levels; deeper sets were not read.`,
  nodes_capped: `The batch has more than ${L.MAX_BATCH_NODES} sets; the rest were not read.`,
  cycles: "Some sets point back to a set already in the tree; each is shown once.",
  root_unresolved: `The batch root was not found within ${L.MAX_DEPTH} parents; the tree starts at the highest set found.`,
  problems_denied: "Reading preview problems was denied for this account.",
  problem_counts_unavailable: "Preview problem counts were not readable.",
});

export type UpdateSetViewWarning = keyof typeof UPDATE_SET_VIEW_WARNINGS;

const UPDATE_SET_VIEWS = Object.freeze(["update_sets", "update_set", "changes", "batch", "remote_update_sets"] as const);
export type UpdateSetView = (typeof UPDATE_SET_VIEWS)[number];

// ---------------------------------------------------------------------------
// Shared reading
// ---------------------------------------------------------------------------

interface Ctx {
  readonly args: CanonicalPlatformViewArgs;
  readonly access: PlatformViewFieldAccess;
  readonly ops: ServiceNowOperations;
  readonly signal: AbortSignal | undefined;
  readonly scopes: FlowViewScopeBudget;
  readonly warnings: Set<UpdateSetViewWarning>;
}

/** Raised inside a view for a fixed `denied` or `unavailable` result. */
class ViewStop {
  constructor(readonly status: "denied" | "unavailable", readonly hint: string) {}
}

function isCancellation(ctx: Ctx, error: unknown): boolean {
  return ctx.signal?.aborted === true || isServiceNowRequestCancellation(error);
}

/** Run `operation` in a new response scope. The views use at most MAX_SCOPES by construction. */
async function scoped<T>(ctx: Ctx, operation: () => Promise<T>): Promise<T> {
  if (!ctx.scopes.take()) throw createToolError("internal", "do_not_retry");
  return inOwnScope(ctx.signal, operation);
}

/** A first read of a view's own table: a 403 is `denied`, a missing table `unavailable`. */
async function firstRead<T>(ctx: Ctx, remote: boolean, operation: () => Promise<T>): Promise<T> {
  try {
    return await scoped(ctx, operation);
  } catch (error) {
    if (errorCategory(error) === "authorization") {
      throw new ViewStop("denied", remote ? REMOTE_SETS_DENIED_HINT : UPDATE_SETS_DENIED_HINT);
    }
    if (isMissingTable(error)) {
      throw new ViewStop("unavailable", remote ? REMOTE_SETS_UNAVAILABLE_HINT : UPDATE_SETS_UNAVAILABLE_HINT);
    }
    throw error;
  }
}

function requireReadable(ctx: Ctx, table: string, fields: readonly string[]): void {
  if (firstUnreadable(ctx.access, table, fields) !== undefined) throw new ViewStop("denied", FIELD_POLICY_HINT);
}

async function readRows(
  ctx: Ctx,
  table: string,
  fields: readonly string[],
  query: string,
  limit: number,
  offset = 0
): Promise<Record<string, unknown>[]> {
  const asked = readableOf(ctx.access, table, fields);
  return rowsOf(await ctx.ops.get(`${TABLE_PATH}${table}`, listParams({ fields: asked, query, limit, offset }))).map(
    (row) => readableRow(ctx.access, table, row, asked)
  );
}

const lowerId = (value: unknown): string | undefined => {
  const id = scalar(value)?.trim().toLowerCase();
  return id !== undefined && SYS_ID.test(id) ? id : undefined;
};

function optionalText(key: string, value: unknown, max: number): Record<string, string> {
  const clean = cleanText(value, max);
  return clean === undefined ? {} : { [key]: clean };
}

function optionalId(key: string, value: unknown): Record<string, string | null> {
  if (value === undefined) return {};
  return { [key]: lowerId(value) ?? null };
}

function optionalCount(key: string, value: unknown): Record<string, number> {
  const count = wholeNumber(value);
  return count === undefined ? {} : { [key]: count };
}

function optionalFlag(key: string, value: unknown): Record<string, boolean> {
  const bool = flag(value);
  return bool === undefined ? {} : { [key]: bool };
}

/** Aggregate API groups: each group's fields by name and its count. */
function statGroups(response: unknown): { fields: Map<string, string>; count: number }[] {
  const result = (response as { result?: unknown } | null | undefined)?.result;
  const groups = Array.isArray(result) ? result : typeof result === "object" && result !== null ? [result] : [];
  const out: { fields: Map<string, string>; count: number }[] = [];
  for (const entry of groups) {
    const group = asRecord(entry);
    const fields = new Map<string, string>();
    for (const field of Array.isArray(group.groupby_fields) ? group.groupby_fields : []) {
      const record = asRecord(field);
      const name = scalar(record.field);
      if (name !== undefined) fields.set(name, scalar(record.value) ?? "");
    }
    const count = wholeNumber(asRecord(group.stats).count);
    if (count !== undefined && count >= 0) out.push({ fields, count });
  }
  return out;
}

/**
 * Rows per set, from Aggregate API reads grouped by `field`, one read per
 * {@link UPDATE_SET_VIEW_LIMITS}.STATS_CHUNK sets. A set with no rows has no
 * group: its count is 0. Undefined when a read failed or the field is hidden.
 */
async function countRows(ctx: Ctx, field: "update_set" | "remote_update_set", ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, number>();
  if (!ctx.access.canRead("sys_update_xml", field)) return undefined;
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += L.STATS_CHUNK) chunks.push(ids.slice(start, start + L.STATS_CHUNK));
  try {
    const responses = await scoped(ctx, () =>
      Promise.all(
        chunks.map((chunk) =>
          ctx.ops.get(`${STATS_PATH}sys_update_xml`, {
            sysparm_query: `${field}IN${chunk.join(",")}`,
            sysparm_group_by: field,
            sysparm_count: "true",
          })
        )
      )
    );
    const counts = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const response of responses) {
      for (const group of statGroups(response)) {
        const id = lowerId(group.fields.get(field));
        if (id !== undefined && counts.has(id)) counts.set(id, group.count);
      }
    }
    return counts;
  } catch (error) {
    if (isCancellation(ctx, error)) throw error;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function projectSet(row: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const id = lowerId(row.sys_id);
  if (id === undefined) return undefined;
  return {
    sys_id: id,
    ...optionalText("name", row.name, L.NAME_CHARS),
    ...optionalText("state", row.state, 40),
    ...("application" in row ? { application: cleanText(row.application, 40) ?? null } : {}),
    ...optionalFlag("is_default", row.is_default),
    ...optionalId("parent", row.parent),
    ...optionalId("base_update_set", row.base_update_set),
    ...optionalText("created_by", row.sys_created_by, 100),
    ...optionalText("created_on", row.sys_created_on, 40),
    ...optionalText("updated_on", row.sys_updated_on, 40),
    ...optionalText("completed_on", row.completed_on, 40),
    ...optionalText("completed_by", row.completed_by, 100),
    ...optionalId("remote_sys_id", row.remote_sys_id),
    ...optionalText("description", row.description, L.DESCRIPTION_CHARS),
  };
}

function projectNode(row: Readonly<Record<string, unknown>>): { sys_id: string; name?: string; state?: string } | undefined {
  const id = lowerId(row.sys_id);
  if (id === undefined) return undefined;
  return { sys_id: id, ...optionalText("name", row.name, L.NAME_CHARS), ...optionalText("state", row.state, 40) };
}

function projectChange(row: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const id = lowerId(row.sys_id);
  if (id === undefined) return undefined;
  return {
    sys_id: id,
    ...optionalText("type", row.type, 80),
    ...optionalText("name", row.name, L.NAME_CHARS),
    ...optionalText("target_name", row.target_name, L.NAME_CHARS),
    ...optionalText("table", row.table, 80),
    ...optionalText("action", row.action, 40),
    ...("application" in row ? { application: cleanText(row.application, 40) ?? null } : {}),
    ...optionalText("updated_by", row.sys_updated_by, 100),
    ...optionalText("updated_on", row.sys_updated_on, 40),
    ...optionalFlag("replace_on_upgrade", row.replace_on_upgrade),
    ...optionalId("update_set", row.update_set),
    ...optionalId("remote_update_set", row.remote_update_set),
  };
}

function projectRemoteSet(row: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const id = lowerId(row.sys_id);
  if (id === undefined) return undefined;
  return {
    sys_id: id,
    ...optionalText("name", row.name, L.NAME_CHARS),
    ...optionalText("state", row.state, 40),
    ...optionalText("application_scope", row.application_scope, 100),
    ...optionalCount("collisions", row.collisions),
    ...optionalCount("inserted", row.inserted),
    ...optionalCount("updated", row.updated),
    ...optionalCount("deleted", row.deleted),
    ...optionalId("parent", row.parent),
    ...optionalId("remote_base_update_set", row.remote_base_update_set),
    ...optionalId("update_source", row.update_source),
    ...optionalText("commit_date", row.commit_date, 40),
    ...optionalText("created_on", row.sys_created_on, 40),
  };
}

function projectProblem(row: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const id = lowerId(row.sys_id);
  if (id === undefined) return undefined;
  return {
    sys_id: id,
    ...optionalText("type", row.type, 40),
    ...optionalText("status", row.status, 40),
    ...optionalText("missing_item", row.missing_item, L.NAME_CHARS),
    ...optionalText("missing_item_table", row.missing_item_table, 80),
    ...optionalId("remote_update", row.remote_update),
    ...optionalText("description", row.description, L.PROBLEM_DESCRIPTION_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Resolving a set and its descendants
// ---------------------------------------------------------------------------

type Found =
  | { readonly kind: "found"; readonly row: Record<string, unknown>; readonly id: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous"; readonly candidates: Record<string, unknown>[] };

/** A local set by sys_id or exact name, in its own scope (the view's first read). */
async function findLocalSet(ctx: Ctx, selector: string, fields: readonly string[]): Promise<Found> {
  const byId = SYS_ID.test(selector);
  requireReadable(ctx, "sys_update_set", byId ? ["sys_id"] : ["sys_id", "name"]);
  const rows = await firstRead(ctx, false, () =>
    readRows(ctx, "sys_update_set", fields, byId ? `sys_id=${selector}` : `name=${selector}^ORDERBYsys_id`, byId ? 1 : 2)
  );
  return found(rows);
}

/** A retrieved set by sys_id, in its own scope (the view's first read). */
async function findRemoteSet(ctx: Ctx, id: string, fields: readonly string[]): Promise<Found> {
  requireReadable(ctx, "sys_remote_update_set", ["sys_id"]);
  return found(await firstRead(ctx, true, () => readRows(ctx, "sys_remote_update_set", fields, `sys_id=${id}`, 1)));
}

function found(rows: readonly Record<string, unknown>[]): Found {
  const valid = rows.filter((row) => lowerId(row.sys_id) !== undefined);
  if (valid.length === 0) return { kind: "not_found" };
  if (valid.length > 1) {
    return {
      kind: "ambiguous",
      candidates: valid.flatMap((row) => {
        const node = projectNode(row);
        return node === undefined ? [] : [node];
      }),
    };
  }
  return { kind: "found", row: valid[0]!, id: lowerId(valid[0]!.sys_id)! };
}

interface Tree {
  /** Every set read, the start first, then each level in sys_id order. */
  readonly nodes: Map<string, { readonly row: Record<string, unknown>; readonly depth: number }>;
  readonly depthCapped: boolean;
  readonly nodesCapped: boolean;
  readonly cycles: number;
}

/**
 * The children of `parents`, in sys_id order: one read per
 * {@link UPDATE_SET_VIEW_LIMITS}.STATS_CHUNK parents (so a level's query stays
 * well under URL limits), read together and merged as one read would return
 * them. Each read asks for at most `limit` rows.
 */
async function childrenOf(
  ctx: Ctx,
  table: "sys_update_set" | "sys_remote_update_set",
  parents: readonly string[],
  fields: readonly string[],
  limit: number
): Promise<Record<string, unknown>[]> {
  const chunks: string[][] = [];
  for (let start = 0; start < parents.length; start += L.STATS_CHUNK) chunks.push(parents.slice(start, start + L.STATS_CHUNK));
  const reads = await Promise.all(
    chunks.map((chunk) => readRows(ctx, table, fields, `parentIN${chunk.join(",")}^ORDERBYsys_id`, limit))
  );
  if (reads.length === 1) return reads[0]!;
  const key = (row: Record<string, unknown>) => lowerId(row.sys_id) ?? "";
  return reads.flat().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * The descendants of `root` through `parent`, one read per level (per 100
 * sets of a level), in the caller's scope. Stops at `maxDepth` levels (reading one row past the last
 * level to know whether it was the last) and at `maxNodes` sets; a set seen
 * twice is a cycle, counted once and not followed.
 */
async function descend(
  ctx: Ctx,
  table: "sys_update_set" | "sys_remote_update_set",
  root: { readonly id: string; readonly row: Record<string, unknown> },
  fields: readonly string[],
  maxNodes: number
): Promise<Tree> {
  const nodes = new Map<string, { row: Record<string, unknown>; depth: number }>([[root.id, { row: root.row, depth: 0 }]]);
  let frontier = [root.id];
  let depthCapped = false;
  let nodesCapped = false;
  let cycles = 0;
  for (let depth = 1; frontier.length > 0 && !nodesCapped; depth += 1) {
    if (depth > L.MAX_DEPTH) {
      // One row is enough to know whether the tree goes deeper.
      const deeper = await childrenOf(ctx, table, frontier, ["sys_id"], 1);
      depthCapped = deeper.length > 0;
      break;
    }
    const level = await childrenOf(ctx, table, frontier, fields, maxNodes + 1);
    const next: string[] = [];
    for (const row of level) {
      const id = lowerId(row.sys_id);
      if (id === undefined) continue;
      if (nodes.has(id)) {
        cycles += 1;
        continue;
      }
      if (nodes.size >= maxNodes) {
        nodesCapped = true;
        break;
      }
      nodes.set(id, { row, depth });
      next.push(id);
    }
    frontier = next;
  }
  return { nodes, depthCapped, nodesCapped, cycles };
}

// ---------------------------------------------------------------------------
// update_sets
// ---------------------------------------------------------------------------

async function viewUpdateSets(ctx: Ctx): Promise<CallToolResult> {
  const { args, access } = ctx;
  if (args.application !== undefined && args.application !== "global" && !SYS_ID.test(args.application.toLowerCase())) {
    // A scope is matched by its sys_id (or "global"); its name would need a read outside this view's plan.
    throw createToolError("conflict", "retry_after_correction");
  }
  const clauses: string[] = [];
  const filterFields = ["sys_id"];
  if (args.state !== undefined) {
    clauses.push(`state=${args.state}`);
    filterFields.push("state");
  }
  if (args.name_contains !== undefined) {
    clauses.push(`nameLIKE${args.name_contains}`);
    filterFields.push("name");
  }
  if (args.application !== undefined) {
    clauses.push(`application=${args.application.toLowerCase()}`);
    filterFields.push("application");
  }
  if (args.updated_since !== undefined) {
    clauses.push(`sys_updated_on>=${args.updated_since}`);
    filterFields.push("sys_updated_on");
  }
  if (args.batch_root !== undefined) {
    // The root and every set whose batch root it is.
    clauses.push(`base_update_set=${args.batch_root}^ORsys_id=${args.batch_root}`);
    filterFields.push("base_update_set");
  }
  requireReadable(ctx, "sys_update_set", filterFields);
  const order = access.canRead("sys_update_set", "sys_updated_on") ? "ORDERBYDESCsys_updated_on^ORDERBYsys_id" : "ORDERBYsys_id";
  const query = [...clauses, order].join("^");

  const rows = await firstRead(ctx, false, () =>
    readRows(ctx, "sys_update_set", UPDATE_SET_FIELDS, query, args.limit + 1, args.offset)
  );
  const { page, hasMore } = pageOf(rows, args.limit);
  const sets = page.flatMap((row) => {
    const set = projectSet(row);
    return set === undefined ? [] : [set];
  });
  const counts = await countRows(ctx, "update_set", sets.map((set) => String(set.sys_id)));
  if (counts === undefined && sets.length > 0) ctx.warnings.add("counts_unavailable");
  const results = sets.map((set) => ({ ...set, update_count: counts?.get(String(set.sys_id)) ?? null }));
  return result(ctx, "update_sets", {
    summary: {
      filters: {
        ...(args.state === undefined ? {} : { state: args.state }),
        ...(args.name_contains === undefined ? {} : { name_contains: args.name_contains }),
        ...(args.application === undefined ? {} : { application: args.application.toLowerCase() }),
        ...(args.updated_since === undefined ? {} : { updated_since: args.updated_since }),
        ...(args.batch_root === undefined ? {} : { batch_root: args.batch_root }),
      },
    },
    results,
    record_count: results.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: args.offset + page.length } : {}),
  });
}

// ---------------------------------------------------------------------------
// update_set
// ---------------------------------------------------------------------------

async function viewUpdateSet(ctx: Ctx): Promise<CallToolResult> {
  const selector = requiredSelector(ctx.args.update_set);
  const set = await findLocalSet(ctx, selector, UPDATE_SET_DETAIL_FIELDS);
  if (set.kind !== "found") return notFound(ctx, "update_set", set);
  const detail = projectSet(set.row)!;

  // Counts, children and the origin, together: none depends on another.
  const countsRead = async () => {
    if (firstUnreadable(ctx.access, "sys_update_xml", ["update_set"]) !== undefined) return undefined;
    const fields = ["type", "action"].filter((field) => ctx.access.canRead("sys_update_xml", field));
    try {
      const response = await scoped(ctx, () =>
        ctx.ops.get(`${STATS_PATH}sys_update_xml`, {
          sysparm_query: `update_set=${set.id}`,
          sysparm_count: "true",
          ...(fields.length > 0 ? { sysparm_group_by: fields.join(",") } : {}),
          sysparm_limit: String(L.MAX_COUNT_GROUPS + 1),
        })
      );
      return { groups: statGroups(response), fields };
    } catch (error) {
      if (isCancellation(ctx, error)) throw error;
      return undefined;
    }
  };
  const childrenRead = async () => {
    if (!ctx.access.canRead("sys_update_set", "parent")) {
      ctx.warnings.add("children_unreadable");
      return undefined;
    }
    try {
      return await scoped(ctx, () =>
        readRows(ctx, "sys_update_set", UPDATE_SET_NODE_FIELDS, `parent=${set.id}^ORDERBYsys_id`, L.MAX_CHILDREN + 1)
      );
    } catch (error) {
      if (isCancellation(ctx, error)) throw error;
      ctx.warnings.add("children_unavailable");
      return undefined;
    }
  };
  const remoteId = lowerId(set.row.remote_sys_id);
  const originRead = async () => {
    if (remoteId === undefined || !ctx.access.canRead("sys_remote_update_set", "sys_id")) return undefined;
    try {
      const rows = await scoped(ctx, () => readRows(ctx, "sys_remote_update_set", REMOTE_SET_FIELDS, `sys_id=${remoteId}`, 1));
      return rows[0] === undefined ? null : projectRemoteSet(rows[0]) ?? null;
    } catch (error) {
      if (isCancellation(ctx, error)) throw error;
      ctx.warnings.add("remote_unavailable");
      return undefined;
    }
  };
  const [counts, children, origin] = await Promise.all([countsRead(), childrenRead(), originRead()]);

  let countSummary: Record<string, unknown> | null = null;
  if (counts === undefined) ctx.warnings.add("counts_unavailable");
  else {
    const byType = new Map<string, number>();
    const byAction = new Map<string, number>();
    let total = 0;
    for (const group of counts.groups.slice(0, L.MAX_COUNT_GROUPS)) {
      total += group.count;
      const type = cleanText(group.fields.get("type"), 80) ?? "";
      const action = cleanText(group.fields.get("action"), 40) ?? "";
      if (counts.fields.includes("type")) byType.set(type, (byType.get(type) ?? 0) + group.count);
      if (counts.fields.includes("action")) byAction.set(action, (byAction.get(action) ?? 0) + group.count);
    }
    if (counts.groups.length > L.MAX_COUNT_GROUPS) ctx.warnings.add("counts_truncated");
    const listed = (map: Map<string, number>, key: string) =>
      [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([value, count]) => ({ [key]: value, count }));
    countSummary = {
      // A set with no rows has no group: 0.
      total,
      ...(counts.fields.includes("type") ? { by_type: listed(byType, "type") } : {}),
      ...(counts.fields.includes("action") ? { by_action: listed(byAction, "action") } : {}),
    };
  }
  const childNodes = (children ?? []).slice(0, L.MAX_CHILDREN).flatMap((row) => {
    const node = projectNode(row);
    return node === undefined ? [] : [node];
  });
  const base = lowerId(set.row.base_update_set);
  return result(ctx, "update_set", {
    summary: {
      set: detail,
      counts: countSummary,
      batch: {
        root: base ?? (childNodes.length > 0 ? set.id : null),
        parent: lowerId(set.row.parent) ?? null,
        ...(children === undefined ? { children: null } : { children: childNodes }),
        ...(children !== undefined && children.length > L.MAX_CHILDREN ? { children_more: true } : {}),
      },
      remote_origin: origin ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

async function viewChanges(ctx: Ctx): Promise<CallToolResult> {
  const { args, access } = ctx;
  const given = [args.update_set, args.remote_update_set].filter((value) => value !== undefined);
  if (given.length !== 1) throw createToolError("conflict", "retry_after_correction");
  // A payload is one named change's.
  if (args.payload === true && args.change === undefined) throw createToolError("conflict", "retry_after_correction");
  const remote = args.remote_update_set !== undefined;
  const setTable = remote ? "sys_remote_update_set" : "sys_update_set";
  const setField = remote ? "remote_update_set" : "update_set";

  // Every field the row read filters or orders on.
  const filterFields = ["sys_id", setField];
  if (args.type !== undefined) filterFields.push("type");
  if (args.action !== undefined) filterFields.push("action");
  requireReadable(ctx, "sys_update_xml", filterFields);

  // 1. The set and, when asked, its descendants: one scope.
  const children = args.include_children === true;
  const selector = remote ? args.remote_update_set! : args.update_set!;
  const byId = SYS_ID.test(selector);
  requireReadable(ctx, setTable, [...(byId ? ["sys_id"] : ["sys_id", "name"]), ...(children ? ["parent"] : [])]);
  const fields = remote ? REMOTE_NODE_FIELDS : UPDATE_SET_NODE_FIELDS;
  const resolved = await firstRead(ctx, remote, async () => {
    const set = found(
      await readRows(ctx, setTable, fields, byId ? `sys_id=${selector}` : `name=${selector}^ORDERBYsys_id`, byId ? 1 : 2)
    );
    if (set.kind !== "found") return set;
    const tree: Tree = children
      ? await descend(ctx, setTable, set, fields, L.MAX_SCOPE_SETS)
      : { nodes: new Map([[set.id, { row: set.row, depth: 0 }]]), depthCapped: false, nodesCapped: false, cycles: 0 };
    return { root: set.id, tree };
  });
  if ("kind" in resolved) return notFound(ctx, "changes", resolved, remote);
  const { root: rootId, tree: scopeTree } = resolved;
  if (scopeTree.depthCapped || scopeTree.nodesCapped) ctx.warnings.add("sets_capped");
  const ids = [...scopeTree.nodes.keys()];

  // 2. One page of change metadata.
  const clauses = [`${setField}IN${ids.join(",")}`];
  if (args.change !== undefined) clauses.push(`sys_id=${args.change}`);
  if (args.type !== undefined) clauses.push(`type=${args.type}`);
  if (args.action !== undefined) clauses.push(`action=${args.action}`);
  const order = access.canRead("sys_update_xml", "sys_updated_on") ? "ORDERBYDESCsys_updated_on^ORDERBYsys_id" : "ORDERBYsys_id";
  const metadata = CHANGE_FIELDS.filter((field) => field !== (remote ? "update_set" : "remote_update_set"));
  let rows: Record<string, unknown>[];
  try {
    rows = await scoped(ctx, () =>
      readRows(ctx, "sys_update_xml", metadata, [...clauses, order].join("^"), args.limit + 1, args.offset)
    );
  } catch (error) {
    if (errorCategory(error) === "authorization") throw new ViewStop("denied", UPDATE_SETS_DENIED_HINT);
    throw error;
  }
  const { page, hasMore } = pageOf(rows, args.limit);
  const results = page.flatMap((row) => {
    const change = projectChange(row);
    return change === undefined ? [] : [change];
  });

  // 3. The payload of the one named change.
  let payload: PayloadOutcome | undefined;
  if (args.payload === true) {
    const row = page.find((candidate) => lowerId(candidate.sys_id) === args.change);
    payload = row === undefined ? payloadRefusal("withheld", "not_found") : await readPayload(ctx, setField, row);
  }

  return result(ctx, "changes", {
    summary: {
      scope: {
        source: remote ? "remote" : "local",
        root: rootId,
        sets: ids.length,
        ...(children ? { include_children: true } : {}),
      },
      filters: {
        ...(args.change === undefined ? {} : { change: args.change }),
        ...(args.type === undefined ? {} : { type: args.type }),
        ...(args.action === undefined ? {} : { action: args.action }),
      },
      ...(payload === undefined ? {} : { payload }),
    },
    results,
    record_count: results.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: args.offset + page.length } : {}),
    ...(args.change !== undefined && results.length === 0 ? { hint: PAYLOAD_HINTS.not_found } : {}),
  });
}

/**
 * Read and mask one change's payload (R6). Its metadata is already read: a
 * row on a credential table is refused before its payload is read.
 */
async function readPayload(
  ctx: Ctx,
  setField: string,
  row: Readonly<Record<string, unknown>>
): Promise<PayloadOutcome> {
  if (!ctx.access.canRead("sys_update_xml", "payload")) return payloadRefusal("not_readable", "field_policy");
  const tables = rowTables({ table: scalar(row.table), name: scalar(row.name) });
  if (tables.some((table) => isCredentialTable(table))) {
    // Checked again, on every table the payload writes and their hierarchies, once it is read.
    return payloadRefusal("refused", "credential_table");
  }
  const id = lowerId(row.sys_id)!;
  const set = lowerId(row[setField]);
  let raw: unknown;
  try {
    const read = await scoped(ctx, () =>
      ctx.ops.get(
        `${TABLE_PATH}sys_update_xml`,
        listParams({
          fields: ["sys_id", "payload"],
          query: `sys_id=${id}${set === undefined ? "" : `^${setField}=${set}`}`,
          limit: 1,
        })
      )
    );
    raw = readableRow(ctx.access, "sys_update_xml", rowsOf(read)[0] ?? {}, ["sys_id", "payload"]).payload;
  } catch (error) {
    if (isServiceNowResponseTooLarge(error) || errorCategory(error) === "too_large") return payloadRefusal("withheld", "too_large");
    throw error;
  }
  const loaderOptions = {
    readChains: firstUnreadable(ctx.access, "sys_db_object", PLAN_FIELD_TYPE_FIELDS.sys_db_object) === undefined,
    readTypes: firstUnreadable(ctx.access, "sys_dictionary", PLAN_FIELD_TYPE_FIELDS.sys_dictionary) === undefined,
    filterDictionaryRow: (entry: Readonly<Record<string, unknown>>) =>
      readableRow(ctx.access, "sys_dictionary", entry, PLAN_FIELD_TYPE_FIELDS.sys_dictionary),
    signal: ctx.signal,
  };
  return preparePayload(
    scalar(raw),
    tables,
    (written) => scoped(ctx, () => loadFieldTypesInPlan(ctx.ops, written, loaderOptions)),
    payloadCharsFor(ctx.args.max_response_bytes)
  );
}

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

async function viewBatch(ctx: Ctx): Promise<CallToolResult> {
  const { args } = ctx;
  const selector = requiredSelector(args.update_set);
  requireReadable(ctx, "sys_update_set", ["sys_id", "parent"]);

  // 1. The member, then its root: one scope.
  const resolved = await firstRead(ctx, false, async () => {
    const byId = SYS_ID.test(selector);
    if (!byId) requireReadable(ctx, "sys_update_set", ["name"]);
    const member = found(
      await readRows(ctx, "sys_update_set", UPDATE_SET_NODE_FIELDS, byId ? `sys_id=${selector}` : `name=${selector}^ORDERBYsys_id`, byId ? 1 : 2)
    );
    if (member.kind !== "found") return member;
    // The root: the member's batch root, or else the top of its parents.
    const base = lowerId(member.row.base_update_set);
    if (base !== undefined && base !== member.id) {
      const rows = await readRows(ctx, "sys_update_set", UPDATE_SET_NODE_FIELDS, `sys_id=${base}`, 1);
      const root = rows[0] === undefined ? undefined : lowerId(rows[0].sys_id);
      if (root !== undefined) return { member: member.id, root: { id: root, row: rows[0]! }, rootFound: true };
    }
    let current = { id: member.id, row: member.row };
    const seen = new Set([member.id]);
    for (let step = 0; step < L.MAX_DEPTH; step += 1) {
      const parent = lowerId(current.row.parent);
      if (parent === undefined) return { member: member.id, root: current, rootFound: true };
      if (seen.has(parent)) {
        ctx.warnings.add("cycles");
        return { member: member.id, root: current, rootFound: true };
      }
      seen.add(parent);
      const rows = await readRows(ctx, "sys_update_set", UPDATE_SET_NODE_FIELDS, `sys_id=${parent}`, 1);
      if (rows[0] === undefined || lowerId(rows[0].sys_id) === undefined) {
        return { member: member.id, root: current, rootFound: true };
      }
      current = { id: parent, row: rows[0] };
    }
    return { member: member.id, root: current, rootFound: false };
  });
  if ("kind" in resolved) return notFound(ctx, "batch", resolved);
  if (!resolved.rootFound) ctx.warnings.add("root_unresolved");

  // 2. The tree under the root: one scope.
  const { root, member } = resolved;
  const tree = await scoped(ctx, () => descend(ctx, "sys_update_set", root, UPDATE_SET_NODE_FIELDS, L.MAX_BATCH_NODES));
  if (tree.depthCapped) ctx.warnings.add("depth_capped");
  if (tree.nodesCapped) ctx.warnings.add("nodes_capped");
  if (tree.cycles > 0) ctx.warnings.add("cycles");

  // 3. Row counts per set.
  const ids = [...tree.nodes.keys()];
  const counts = await countRows(ctx, "update_set", ids);
  if (counts === undefined) ctx.warnings.add("counts_unavailable");
  const childCount = new Map<string, number>();
  for (const { row } of tree.nodes.values()) {
    const parent = lowerId(row.parent);
    if (parent !== undefined) childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
  }
  const nodes = [...tree.nodes].map(([id, { row, depth }]) => ({
    ...projectNode(row)!,
    parent: id === root.id ? null : lowerId(row.parent) ?? null,
    depth,
    children: childCount.get(id) ?? 0,
    update_count: counts?.get(id) ?? null,
  }));
  const states: Record<string, number> = {};
  for (const node of nodes) states[node.state ?? ""] = (states[node.state ?? ""] ?? 0) + 1;
  const page = nodes.slice(args.offset, args.offset + args.limit);
  const hasMore = args.offset + page.length < nodes.length;
  return result(ctx, "batch", {
    summary: {
      root: projectNode(root.row)!,
      member,
      sets: nodes.length,
      depth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
      depth_capped: tree.depthCapped,
      sets_capped: tree.nodesCapped,
      cycles: tree.cycles,
      states,
      update_count: counts === undefined ? null : nodes.reduce((sum, node) => sum + (node.update_count ?? 0), 0),
    },
    results: page,
    record_count: page.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: args.offset + page.length } : {}),
  });
}

// ---------------------------------------------------------------------------
// remote_update_sets
// ---------------------------------------------------------------------------

async function viewRemoteUpdateSets(ctx: Ctx): Promise<CallToolResult> {
  const { args, access } = ctx;
  // Problems belong to one retrieved set.
  if (args.problems === true && args.remote_update_set === undefined) {
    throw createToolError("conflict", "retry_after_correction");
  }
  if (args.problems === true) return viewProblems(ctx, args.remote_update_set!);

  const clauses: string[] = [];
  const filterFields = ["sys_id"];
  if (args.state !== undefined) {
    clauses.push(`state=${args.state}`);
    filterFields.push("state");
  }
  if (args.remote_update_set !== undefined) clauses.push(`sys_id=${args.remote_update_set}`);
  requireReadable(ctx, "sys_remote_update_set", filterFields);
  const order = access.canRead("sys_remote_update_set", "sys_created_on") ? "ORDERBYDESCsys_created_on^ORDERBYsys_id" : "ORDERBYsys_id";
  const rows = await firstRead(ctx, true, () =>
    readRows(ctx, "sys_remote_update_set", REMOTE_SET_FIELDS, [...clauses, order].join("^"), args.limit + 1, args.offset)
  );
  const { page, hasMore } = pageOf(rows, args.limit);
  const results = page.flatMap((row) => {
    const set = projectRemoteSet(row);
    return set === undefined ? [] : [set];
  });
  return result(ctx, "remote_update_sets", {
    summary: { filters: { ...(args.state === undefined ? {} : { state: args.state }) } },
    results,
    record_count: results.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: args.offset + page.length } : {}),
    ...(args.remote_update_set !== undefined && results.length === 0 ? { hint: REMOTE_NOT_FOUND_HINT } : {}),
  });
}

async function viewProblems(ctx: Ctx, id: string): Promise<CallToolResult> {
  const { args, access } = ctx;
  const set = await findRemoteSet(ctx, id, REMOTE_SET_FIELDS);
  if (set.kind !== "found") return notFound(ctx, "remote_update_sets", set, true);
  if (firstUnreadable(access, "sys_update_preview_problem", ["sys_id", "remote_update_set"]) !== undefined) {
    throw new ViewStop("denied", FIELD_POLICY_HINT);
  }
  const groupFields = ["type", "status"].filter((field) => access.canRead("sys_update_preview_problem", field));
  let rows: Record<string, unknown>[] | undefined;
  let groups: ReturnType<typeof statGroups> | undefined;
  try {
    [rows, groups] = await Promise.all([
      scoped(ctx, () =>
        readRows(
          ctx,
          "sys_update_preview_problem",
          PROBLEM_FIELDS,
          `remote_update_set=${set.id}^ORDERBYsys_id`,
          args.limit + 1,
          args.offset
        )
      ),
      scoped(ctx, () =>
        ctx.ops.get(`${STATS_PATH}sys_update_preview_problem`, {
          sysparm_query: `remote_update_set=${set.id}`,
          sysparm_count: "true",
          ...(groupFields.length > 0 ? { sysparm_group_by: groupFields.join(",") } : {}),
        })
      ).then(statGroups, (error: unknown) => {
        if (isCancellation(ctx, error)) throw error;
        ctx.warnings.add("problem_counts_unavailable");
        return undefined;
      }),
    ]);
  } catch (error) {
    if (errorCategory(error) !== "authorization") throw error;
    ctx.warnings.add("problems_denied");
    rows = undefined;
  }
  const remoteSet = projectRemoteSet(set.row)!;
  if (rows === undefined) {
    return result(ctx, "remote_update_sets", { summary: { remote_set: remoteSet, problems: "denied" } });
  }
  const { page, hasMore } = pageOf(rows, args.limit);
  const results = page.flatMap((row) => {
    const problem = projectProblem(row);
    return problem === undefined ? [] : [problem];
  });
  const tally = (field: string) => {
    if (groups === undefined || !groupFields.includes(field)) return undefined;
    const out: Record<string, number> = {};
    for (const group of groups) {
      const key = cleanText(group.fields.get(field), 40) ?? "";
      out[key] = (out[key] ?? 0) + group.count;
    }
    return out;
  };
  const byStatus = tally("status");
  const byType = tally("type");
  return result(ctx, "remote_update_sets", {
    summary: {
      remote_set: remoteSet,
      problems: "read",
      ...(groups === undefined
        ? {}
        : {
            problem_counts: {
              // No problems has no group: 0.
              total: groups.reduce((sum, group) => sum + group.count, 0),
              ...(byStatus === undefined ? {} : { by_status: byStatus }),
              ...(byType === undefined ? {} : { by_type: byType }),
            },
          }),
    },
    results,
    record_count: results.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: args.offset + page.length } : {}),
  });
}

// ---------------------------------------------------------------------------
// Results and the handler
// ---------------------------------------------------------------------------

function requiredSelector(value: string | undefined): string {
  if (value === undefined) throw createToolError("conflict", "retry_after_correction");
  return value;
}

function notFound(ctx: Ctx, view: UpdateSetView, set: Found, remote = false): CallToolResult {
  return result(ctx, view, {
    summary: { set: null, ...(set.kind === "ambiguous" ? { candidates: set.candidates } : {}) },
    results: [],
    hint: set.kind === "ambiguous" ? AMBIGUOUS_HINT : remote ? REMOTE_NOT_FOUND_HINT : NOT_FOUND_HINT,
  });
}

function result(
  ctx: Ctx,
  view: UpdateSetView,
  data: {
    summary?: Record<string, unknown>;
    results?: Record<string, unknown>[];
    record_count?: number;
    has_more?: boolean;
    next_offset?: number;
    hint?: string;
  }
): CallToolResult {
  const warnings = [...ctx.warnings].map((key) => UPDATE_SET_VIEW_WARNINGS[key]);
  return viewResult(ctx.args, {
    view,
    status: "ok",
    ...data,
    summary: { ...data.summary, upstream_scopes: ctx.scopes.opened },
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

export interface UpdateSetViewsHandlerOptions {
  readonly fieldAccess?: PlatformViewFieldAccess;
}

/**
 * Build the handler of the five update set views. `handleUpdateSetViews` is
 * the one the module registers; a test builds its own with a fixed field
 * access.
 */
export function createUpdateSetViewsHandler(defaults: UpdateSetViewsHandlerOptions = {}): FieldAccessHandler {
  return async (
    args: CanonicalPlatformViewArgs,
    services: ServiceNowToolHandlerServices,
    fieldAccess?: PlatformViewFieldAccess
  ): Promise<CallToolResult> => {
    if (!(UPDATE_SET_VIEWS as readonly PlatformView[]).includes(args.view)) throw createToolError("internal", "do_not_retry");
    const ctx: Ctx = {
      args,
      access: memoizedFieldAccess(fieldAccess ?? defaults.fieldAccess ?? liveFieldAccess),
      ops: uncachedOperations(services.serviceNow),
      signal: services.context?.signal,
      scopes: new FlowViewScopeBudget(L.MAX_SCOPES),
      warnings: new Set(),
    };
    const view = args.view as UpdateSetView;
    try {
      switch (view) {
        case "update_sets":
          return await viewUpdateSets(ctx);
        case "update_set":
          return await viewUpdateSet(ctx);
        case "changes":
          return await viewChanges(ctx);
        case "batch":
          return await viewBatch(ctx);
        case "remote_update_sets":
          return await viewRemoteUpdateSets(ctx);
      }
    } catch (error) {
      if (error instanceof ViewStop) return viewResult(args, { view, status: error.status, hint: error.hint });
      throw error;
    }
  };
}

/** The handler the dispatcher registers for the five update set views. */
export const handleUpdateSetViews: FieldAccessHandler = createUpdateSetViewsHandler();

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function shown(value: unknown): string {
  return scalar(value) ?? "-";
}

const TITLES: Readonly<Record<UpdateSetView, string>> = Object.freeze({
  update_sets: "Update sets",
  update_set: "Update set",
  changes: "Update set changes",
  batch: "Update set batch",
  remote_update_sets: "Retrieved update sets",
});

/** One line per row, `key: value` pairs joined; every value is instance text. */
function lines(rows: readonly Record<string, unknown>[]): string {
  return rows
    .map((row) =>
      Object.entries(row)
        .map(([key, value]) => `${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : shown(value)}`)
        .join(" | ")
    )
    .join("\n");
}

/**
 * The readable text of an update set view's result. Counts, statuses and the
 * fixed hints, warnings and notes are plain text; every value read from the
 * instance (names, descriptions, types, payload text) sits inside an
 * `untrustedBlock`.
 */
export function renderUpdateSetViewText(data: unknown): string | undefined {
  const record = asRecord(data);
  const view = record.view as UpdateSetView;
  if (!(UPDATE_SET_VIEWS as readonly unknown[]).includes(view)) return undefined;
  const title = TITLES[view];
  if (record.status !== "ok") {
    return renderMarkdown(headline(title, { status: "fail", detail: scalar(record.hint) ?? "not available" }));
  }
  const summary = asRecord(record.summary);
  const rows = Array.isArray(record.results) ? record.results.map(asRecord) : [];
  const blocks: (MarkdownFragment | undefined)[] = [
    headline(title, { status: "pass", detail: `${rows.length} row(s)${record.has_more === true ? ", more available" : ""}` }),
  ];
  if (typeof record.hint === "string") blocks.push(text(record.hint));
  const { payload, ...rest } = summary;
  const details = Object.entries(rest).filter(([key, value]) => key !== "upstream_scopes" && value !== undefined);
  if (details.length > 0) blocks.push(untrustedBlock("Summary", lines([Object.fromEntries(details)])));
  if (rows.length > 0) blocks.push(untrustedBlock("Rows", lines(rows), 20_000));
  const outcome = asRecord(payload);
  if (outcome.status === "shown") {
    blocks.push(text(scalar(outcome.note)));
    blocks.push(untrustedBlock("Payload (masked)", shown(outcome.text), 210_000));
  } else if (typeof outcome.status === "string") {
    blocks.push(text(`Payload ${outcome.status}${typeof outcome.hint === "string" ? `: ${outcome.hint}` : "."}`));
  }
  if (record.has_more === true) blocks.push(text(`More rows: next_offset ${shown(record.next_offset)}.`));
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  if (warnings.length > 0) blocks.push(bulletList(warnings.map((warning) => String(scalar(warning) ?? ""))));
  return renderMarkdown(...blocks);
}
