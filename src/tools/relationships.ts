import { z } from "zod";
import { quotedInertText } from "../inert-text.js";
import {
  createAmbiguousCiNameError,
  createArgumentTooLongError,
  createStartCiRequiredError,
  createToolError,
} from "../tool-error.js";
import { isServiceNowRequestCancellation, isServiceNowResponseTooLarge, type ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  ok,
  MAX_RESPONSE_BYTES_DEFAULT,
  MAX_RESPONSE_BYTES_MAX,
  MAX_RESPONSE_BYTES_MIN,
  buildTableParams,
  escapeQueryValue,
  formatError,
  serializedBytes,
  withWarnings,
} from "../utils.js";
import {
  filterReadableRecord,
  isFieldPolicyError,
  resolveReadableFields,
} from "../field-policy.js";
import {
  normalizeServiceNowSysId,
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";
import {
  buildRelationshipMap,
  type MapEdge,
  type MapNode,
} from "./relationships-map.js";

export const definition = {
  name: "sn_relationships",
  description:
    "Traverse CMDB CI relationships breadth first: each CI once, at its shortest depth, upstream, downstream or both. Lists only CIs the profile can read. A limit that stops the walk sets meta.traversal_truncated and warns, naming the CIs not fully read. For impact analysis and dependency mapping.",
  annotations: {
    title: "Traverse CI relationships",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const schema = z.object({
  ci_name: z.string().optional().describe("Name of the CI to start from (several matches: pass sys_id instead)"),
  sys_id: serviceNowSysIdSchema.optional().describe("32-hex sys_id of the CI to start from (alternative to ci_name)"),
  depth: z.number().int().min(1).max(5).optional().describe("How many levels deep to traverse (1-5, default from SN_REL_DEPTH or 3)"),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe("Maximum relationships to return (default 100, max 1000)"),
  offset: z.number().int().min(0).max(1000).optional().default(0).describe("Deterministic traversal offset (default 0, max 1000)"),
  direction: z.enum(["upstream", "downstream", "both"]).optional().default("both").describe("Traversal direction (default: both)"),
  type: z.string().optional().describe("Filter by relationship type name (substring match)"),
  class: z.string().optional().describe("Filter displayed CIs by class name (substring match)"),
  impact: z.boolean().optional().default(false).describe("Impact analysis mode -- walks upstream only"),
  max_response_bytes: z
    .number()
    .int()
    .min(MAX_RESPONSE_BYTES_MIN)
    .max(MAX_RESPONSE_BYTES_MAX)
    .optional()
    .default(MAX_RESPONSE_BYTES_DEFAULT)
    .describe("Byte budget (default 100000, min 1000, max 1000000); list and map are cut to fit"),
  map: z.boolean().optional().default(false).describe("Also return nodes, edges (with types) and a Mermaid diagram"),
});

/**
 * The bounds of one traversal. Every one is documented in the README, and one
 * that stops a walk is reported in `meta.truncated_by` and in a warning that
 * names the CIs whose relationships were not fully read.
 */
export interface TraversalLimits {
  readonly maxRequests: number;
  readonly ciReadReserve: number;
  readonly maxCis: number;
  readonly maxRelationshipRows: number;
  readonly relationshipPage: number;
  readonly relationshipChunk: number;
  readonly ciChunk: number;
  readonly ambiguousListed: number;
  readonly namedInWarning: number;
  readonly relationshipBytes: number;
  readonly ciBytes: number;
  readonly mapShare: number;
}

export const TRAVERSAL_LIMITS: TraversalLimits = Object.freeze({
  /**
   * Upstream requests of one call, root lookup, relationship pages and CI
   * reads together. A batched walk needs about one request per 50 CIs of a
   * level: at the other limits' worst case, about 45 in all.
   */
  maxRequests: 50,
  /** Of those, the requests kept back for reading the CIs a level finds. */
  ciReadReserve: 15,
  /** Distinct CIs read, the start CI aside. */
  maxCis: 1_000,
  /** Relationship rows read, duplicates (a row read from each end) included. */
  maxRelationshipRows: 2_000,
  /** Rows per relationship page. */
  relationshipPage: 500,
  /** CIs per relationship query (both directions: 2 x 50 sys_ids in the URL). */
  relationshipChunk: 50,
  /** CIs per `cmdb_ci` read. */
  ciChunk: 100,
  /** Matches an ambiguous `ci_name` error lists. */
  ambiguousListed: 5,
  /** CIs named in a warning. */
  namedInWarning: 5,
  /**
   * The client allows 1 MiB of upstream JSON per call, all requests together.
   * The walk keeps its own estimate of what it has read and stops short of it:
   * this much for relationship rows, and this much for CI reads.
   */
  relationshipBytes: 640 * 1024,
  ciBytes: 180 * 1024,
  /** Share of `max_response_bytes` the map (nodes, edges and diagram) may take; the list gets the rest. */
  mapShare: 0.48,
});

/** Longest `ci_name`, `type` and `class` a call may carry, in characters. */
export const ARGUMENT_BOUNDS = Object.freeze({ ci_name: 255, type: 255, class: 80 });

type Direction = "upstream" | "downstream";
type Cap = "requests" | "relationship_rows" | "response_bytes" | "cis" | "error";

interface ListedCi {
  readonly sys_id: string;
  readonly name?: string;
  readonly class?: string;
  readonly depth: number;
  readonly type: string;
  readonly direction: Direction;
  readonly via: string;
}

interface RelNode {
  name?: string;
  class?: string;
  type: string;
  direction: Direction;
  sys_id: string;
  via: string;
  depth: number;
}

interface RelRow {
  readonly id: string | undefined;
  readonly parent: string;
  readonly child: string;
  readonly type: string;
}

interface Found {
  readonly sys_id: string;
  readonly type: string;
  readonly direction: Direction;
  readonly via: string;
}

interface CiView {
  readonly name?: string;
  readonly class?: string;
}

const RELATED_TO = "Related to";
const SYS_ID_FIELD = "sys_id";

/** The fields of `table`, of those named, that the profile can read. */
function readableAmong(table: string, names: readonly string[]): string[] {
  const readable: string[] = [];
  for (const name of names) {
    try {
      resolveReadableFields(table, { fields: name });
      readable.push(name);
    } catch (error) {
      if (!isFieldPolicyError(error)) throw error;
    }
  }
  return readable;
}

function extractValue(field: unknown): string {
  if (!field) return "";
  if (typeof field === "string") return field;
  if (typeof field === "object" && field !== null) {
    const f = field as Record<string, unknown>;
    if (f.value && typeof f.value === "string") return f.value;
    if (f.link && typeof f.link === "string") {
      // Extract sys_id from link URL
      const parts = (f.link as string).split("/");
      return parts[parts.length - 1] ?? "";
    }
  }
  return "";
}

function extractDisplay(field: unknown): string {
  if (!field) return "";
  if (typeof field === "string") {
    // If it's a 32-char hex string, it's a sys_id not a display value
    if (/^[a-f0-9]{32}$/.test(field)) return "";
    return field;
  }
  if (typeof field === "object" && field !== null) {
    const f = field as Record<string, unknown>;
    if (f.display_value && typeof f.display_value === "string") return f.display_value;
  }
  return "";
}

/** The relationship row's sys_id; `display_value=all` returns it as a value object. */
function relationshipId(field: unknown): string | undefined {
  const value = extractValue(field);
  return /^[0-9a-f]{32}$/u.test(value) ? value : undefined;
}

function rowsOf(response: unknown): unknown[] {
  const result =
    typeof response === "object" && response !== null
      ? (response as { result?: unknown }).result
      : undefined;
  return Array.isArray(result) ? result : [];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * The start CI does not exist, or is not readable. A result the handler marks
 * as an error reaches the caller only as a generic failure, so this is the
 * trusted error that says what happened.
 */
function ciNotFound(): Error {
  return createToolError("not_found", "retry_after_correction");
}

function quantity(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  config: ServiceNowToolSettings,
  _context?: ExecutionContext
) {
  return traverseRelationships(args, client, config, TRAVERSAL_LIMITS);
}

/** The traversal with its bounds given, for tests that exercise each one. */
export async function traverseRelationships(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  config: ServiceNowToolSettings,
  limits: TraversalLimits
) {
  if (!args.ci_name && !args.sys_id) {
    throw createStartCiRequiredError();
  }

  const maxDepth = Math.min(Math.max(args.depth ?? config.relDepth, 1), 5);
  let direction = args.direction;
  if (args.impact) direction = "upstream";
  const wantDown = direction !== "upstream";
  const wantUp = direction !== "downstream";

  // ── Field policy: both ends of a relationship must be readable ──
  // Lengths are bound here, not in the schema, to keep the tool's description small.
  if (args.ci_name !== undefined && args.ci_name.length > ARGUMENT_BOUNDS.ci_name) {
    throw createArgumentTooLongError("ci_name", ARGUMENT_BOUNDS.ci_name);
  }
  if (args.type !== undefined && args.type.length > ARGUMENT_BOUNDS.type) {
    throw createArgumentTooLongError("type", ARGUMENT_BOUNDS.type);
  }
  if (args.class !== undefined && args.class.length > ARGUMENT_BOUNDS.class) {
    throw createArgumentTooLongError("class", ARGUMENT_BOUNDS.class);
  }

  // Refuse before any request, and show only what the profile can read.
  // Both ends and the type of a relationship, and the sys_id of a CI, are what
  // a walk is made of: without them there is nothing to walk or to show.
  resolveReadableFields("cmdb_rel_ci", { fields: "parent,child,type" });
  resolveReadableFields("cmdb_ci", { fields: SYS_ID_FIELD });
  const relIdReadable = readableAmong("cmdb_rel_ci", [SYS_ID_FIELD]).length > 0;
  const relFields = [...(relIdReadable ? [SYS_ID_FIELD] : []), "parent", "child", "type"];
  const relSelection = resolveReadableFields("cmdb_rel_ci", { fields: relFields.join(",") });
  const ciShown = readableAmong("cmdb_ci", ["name", "sys_class_name"]);
  const nameShown = ciShown.includes("name");
  const classShown = ciShown.includes("sys_class_name");
  if (args.ci_name) resolveReadableFields("cmdb_ci", { fields: "name", purpose: "query" });
  if (args.class) resolveReadableFields("cmdb_ci", { fields: "sys_class_name", purpose: "query" });
  const ciFields = [SYS_ID_FIELD, ...ciShown].join(",");
  const ciSelection = resolveReadableFields("cmdb_ci", { fields: ciFields });

  // ── Request accounting: every upstream request this call makes ──
  let requests = 0;
  const warnings: string[] = [];

  async function request(path: string, params: Record<string, string>): Promise<unknown> {
    requests += 1;
    return client.get(path, params);
  }

  /** What the profile may see of one `cmdb_ci` row. */
  function viewOf(row: Record<string, unknown>): CiView {
    const shown = recordOf(filterReadableRecord(row, ciSelection));
    const name = shown?.name;
    const cls = shown?.sys_class_name;
    return {
      ...(nameShown ? { name: typeof name === "string" && name !== "" ? name : undefined } : {}),
      ...(classShown ? { class: typeof cls === "string" && cls !== "" ? cls : "unknown" } : {}),
    } as CiView;
  }

  // ── Resolve the start CI ──
  let rootId: string;
  let rootView: CiView;
  if (args.sys_id) {
    const response = await request(`/api/now/table/cmdb_ci/${serviceNowSysIdPathSegment(args.sys_id)}`, {
      sysparm_fields: ciFields,
      sysparm_display_value: "true",
    });
    const row = recordOf((response as { result?: unknown } | null)?.result);
    if (!row || (!row.sys_id && !row.name)) throw ciNotFound();
    rootId = normalizeServiceNowSysId(args.sys_id);
    rootView = viewOf(row);
  } else {
    const response = await request("/api/now/table/cmdb_ci", {
      sysparm_query: `name=${escapeQueryValue(args.ci_name!)}^ORDERBYsys_id`,
      sysparm_fields: ciFields,
      sysparm_display_value: "true",
      sysparm_limit: String(limits.ambiguousListed + 1),
    });
    const matches = rowsOf(response).map(recordOf).filter((row): row is Record<string, unknown> => row !== undefined);
    if (matches.length === 0) throw ciNotFound();
    if (matches.length > 1) {
      throw createAmbiguousCiNameError(
        args.ci_name!,
        matches.slice(0, limits.ambiguousListed).map((row) => {
          const view = viewOf(row);
          return {
            sys_id: String(row.sys_id ?? ""),
            ...(view.name === undefined ? {} : { name: view.name }),
            ...(view.class === undefined ? {} : { class: view.class }),
          };
        }),
        matches.length > limits.ambiguousListed
      );
    }
    const row = matches[0]!;
    try {
      rootId = normalizeServiceNowSysId(row.sys_id);
    } catch {
      throw ciNotFound();
    }
    rootView = viewOf(row);
  }

  // ── Traverse, level by level ──
  const known = new Map<string, CiView>([[rootId, rootView]]);
  const unreadable = new Set<string>();
  const notRead = new Set<string>();
  const listed: ListedCi[] = [];
  /** Relationships among readable CIs, by row sys_id, for the map. */
  const edges = new Map<string, MapEdge & { readonly rank: number }>();
  const leftOut = new Set<string>();
  const skippedVia = new Set<string>();
  const wantedShown = args.offset + args.limit;
  let shownCount = 0;
  let rowsRead = 0;
  let relBytes = 0;
  let ciBytes = 0;
  let ciRequested = 0;
  let stop: { cap: Cap; depth: number; unread: string[]; detail?: string } | undefined;
  let ciStop: { cap: Cap; depth: number; count: number } | undefined;
  let invalidIdentifier = false;

  const matchesClass = (view: CiView): boolean =>
    !args.class || (view.class ?? "").toLowerCase().includes(args.class.toLowerCase());
  const matchesType = (type: string): boolean =>
    !args.type || type.toLowerCase().includes(args.type.toLowerCase());

  /** How many rows the next relationship page may ask for, or the cap that forbids one. */
  function nextPage(wanted: number): { limit: number } | { cap: Cap } {
    if (requests + 1 > limits.maxRequests - limits.ciReadReserve) return { cap: "requests" };
    const rowsLeft = limits.maxRelationshipRows - rowsRead;
    if (rowsLeft < 1) return { cap: "relationship_rows" };
    const perRow = rowsRead > 0 ? Math.max(relBytes / rowsRead, 100) : 250;
    const byBytes = Math.floor((limits.relationshipBytes - relBytes) / (perRow * 1.25));
    if (byBytes < 10) return { cap: "response_bytes" };
    // Ask for about twice the CIs still needed, so a short page is rare.
    const asked = Math.min(limits.relationshipPage, Math.max(wanted * 2, 100));
    return { limit: Math.min(asked, rowsLeft, byBytes) };
  }

  /** The type filter goes in the query too; `escapeQueryValue` keeps the value one literal. */
  const typeCondition = args.type ? `^type.nameLIKE${escapeQueryValue(args.type)}` : "";

  let frontier: string[] = [rootId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    // A level is read only as far as the page asked for needs: the CIs are
    // found in the order of the frontier's chunks, then of the relationship
    // rows, so what one call reads is a prefix of what a longer one reads.
    const inFrontier = new Set(frontier);
    const chunked = chunks(frontier, limits.relationshipChunk);
    const cursor = { chunk: 0, offset: 0 };
    const found = new Map<string, Found>();
    const pending: Found[] = [];
    let pendingStart = 0;
    const levelEdges: Array<{ key: string; row: RelRow }> = [];
    const readOrder: Found[] = [];
    let levelShown = 0;
    let rowsDone = false;
    let levelReadStopped: Cap | undefined;

    const needed = (): number => wantedShown + 1 - (shownCount + levelShown);

    async function fetchPage(wanted: number): Promise<void> {
      const page = nextPage(wanted);
      if ("cap" in page) {
        stop = { cap: page.cap, depth, unread: frontier.slice(cursor.chunk * limits.relationshipChunk) };
        rowsDone = true;
        return;
      }
      const ids = chunked[cursor.chunk]!.join(",");
      const condition =
        wantDown && wantUp ? `parentIN${ids}^ORchildIN${ids}` : wantDown ? `parentIN${ids}` : `childIN${ids}`;
      let response: unknown;
      try {
        response = await request(
          "/api/now/table/cmdb_rel_ci",
          buildTableParams({
            query: `${condition}${typeCondition}^ORDERBYsys_id`,
            // The ends come back as bare sys_ids, and the type's own name by
            // a dot-walk of `type`: no display value of a CI is ever asked for.
            fields: [...relFields, "type.name"].join(","),
            limit: page.limit,
            offset: cursor.offset,
            displayValue: "false",
            noCount: true,
          })
        );
      } catch (error) {
        if (isServiceNowRequestCancellation(error)) throw error;
        const unread = frontier.slice(cursor.chunk * limits.relationshipChunk);
        if (isServiceNowResponseTooLarge(error)) {
          stop = { cap: "response_bytes", depth, unread };
        } else {
          // A failed hop truncates the walk -- report, don't hide
          warnings.push(`cmdb_rel_ci (traversal at depth ${depth}): ${formatError(error)}`);
          stop = { cap: "error", depth, unread };
        }
        rowsDone = true;
        return;
      }
      relBytes += serializedBytes(response);
      const raw = rowsOf(response);
      const filtered = filterReadableRecord(raw, relSelection);
      const rows = Array.isArray(filtered) ? filtered : [];
      const received = raw.length;
      rowsRead += received;
      for (const [position, entry] of rows.entries()) {
        const row = recordOf(entry);
        if (!row) continue;
        // Rows keep their order and count, so the raw row at the same place carries the type's name.
        const typeName = rows.length === raw.length ? recordOf(raw[position])?.["type.name"] : undefined;
        let parent: string;
        let child: string;
        try {
          parent = normalizeServiceNowSysId(extractValue(row.parent));
          child = normalizeServiceNowSysId(extractValue(row.child));
        } catch {
          invalidIdentifier = true;
          continue;
        }
        const rel: RelRow = {
          id: relationshipId(row.sys_id),
          parent,
          child,
          type: (typeof typeName === "string" && typeName !== "" ? typeName : extractDisplay(row.type)) || RELATED_TO,
        };
        if (rel.parent === rel.child || !matchesType(rel.type)) continue;
        const reached: Array<{ other: string; direction: Direction; via: string }> = [];
        if (wantDown && inFrontier.has(rel.parent)) {
          reached.push({ other: rel.child, direction: "downstream", via: rel.parent });
        }
        if (wantUp && inFrontier.has(rel.child)) {
          reached.push({ other: rel.parent, direction: "upstream", via: rel.child });
        }
        if (reached.length === 0) continue;
        levelEdges.push({ key: rel.id ?? `${rel.parent}>${rel.child}>${rel.type}`, row: rel });
        for (const entry of reached) {
          if (known.has(entry.other) || unreadable.has(entry.other) || notRead.has(entry.other) || found.has(entry.other)) {
            continue;
          }
          const fresh: Found = { sys_id: entry.other, type: rel.type, direction: entry.direction, via: entry.via };
          found.set(entry.other, fresh);
          pending.push(fresh);
        }
      }
      if (received < page.limit) {
        cursor.chunk += 1;
        cursor.offset = 0;
        if (cursor.chunk >= chunked.length) rowsDone = true;
      } else {
        cursor.offset += received;
      }
    }

    while (needed() > 0) {
      const waiting = (): number => pending.length - pendingStart;
      // Read relationship rows until they name the CIs still needed.
      while (!rowsDone && waiting() < needed()) await fetchPage(needed() - waiting());
      if (waiting() === 0) break;
      // Read the CIs, from cmdb_ci, under the profile's field policy.
      // Relationship rows are not domain separated, so nothing shown about a
      // CI comes from them: a CI this read does not return is not shown, and
      // is not walked through.
      const size = Math.min(limits.ciChunk, args.class ? waiting() : Math.min(waiting(), needed()));
      const group = pending.slice(pendingStart, pendingStart + size);
      if (limits.maxCis - ciRequested < 1) levelReadStopped = "cis";
      else if (requests + 1 > limits.maxRequests) levelReadStopped = "requests";
      else if (ciBytes >= limits.ciBytes) levelReadStopped = "response_bytes";
      if (levelReadStopped !== undefined) break;
      const take = group.slice(0, limits.maxCis - ciRequested);
      pendingStart += take.length;
      ciRequested += take.length;
      let response: unknown;
      try {
        response = await request(
          "/api/now/table/cmdb_ci",
          buildTableParams({
            query: `sys_idIN${take.map((entry) => entry.sys_id).join(",")}`,
            fields: ciFields,
            limit: take.length,
            displayValue: "true",
            noCount: true,
          })
        );
      } catch (error) {
        if (isServiceNowRequestCancellation(error)) throw error;
        if (isServiceNowResponseTooLarge(error)) {
          levelReadStopped = "response_bytes";
        } else {
          warnings.push(`cmdb_ci (reading CIs at depth ${depth}): ${formatError(error)}`);
          levelReadStopped = "error";
        }
        for (const entry of take) {
          notRead.add(entry.sys_id);
          skippedVia.add(entry.via);
        }
        break;
      }
      ciBytes += serializedBytes(response);
      const returned = new Map<string, Record<string, unknown>>();
      for (const entry of rowsOf(response)) {
        const row = recordOf(entry);
        if (!row) continue;
        try {
          returned.set(normalizeServiceNowSysId(row.sys_id), row);
        } catch {
          // A row without a usable sys_id cannot be matched to a relationship.
        }
      }
      for (const entry of take) {
        const row = returned.get(entry.sys_id);
        if (!row) {
          unreadable.add(entry.sys_id);
          continue;
        }
        const view = viewOf(row);
        known.set(entry.sys_id, view);
        readOrder.push(entry);
        if (matchesClass(view)) levelShown += 1;
      }
    }
    // CIs found that a cap kept from being read, when the page still needed them.
    if (levelReadStopped !== undefined) {
      const missed = pending.slice(pendingStart).filter((entry) => !notRead.has(entry.sys_id));
      for (const entry of missed) {
        notRead.add(entry.sys_id);
        skippedVia.add(entry.via);
      }
      ciStop = {
        cap: levelReadStopped,
        depth,
        count: [...notRead].filter((id) => found.has(id)).length,
      };
    }

    // Relationships among CIs the profile can read; the others are counted.
    for (const { key, row } of levelEdges) {
      const ends = [row.parent, row.child];
      if (ends.some((id) => unreadable.has(id))) {
        leftOut.add(key);
      } else if (ends.every((id) => known.has(id))) {
        if (!edges.has(key)) {
          edges.set(key, {
            ...(row.id === undefined || !relIdReadable ? {} : { sys_id: row.id }),
            parent: row.parent,
            child: row.child,
            type: row.type,
            rank: depth,
          });
        }
      }
    }

    for (const entry of readOrder) {
      const view = known.get(entry.sys_id)!;
      listed.push({
        sys_id: entry.sys_id,
        ...(view.name === undefined ? {} : { name: view.name }),
        ...(view.class === undefined ? {} : { class: view.class }),
        depth,
        type: entry.type,
        direction: entry.direction,
        via: entry.via,
      });
    }
    shownCount += levelShown;

    if (stop !== undefined || ciStop !== undefined) break;
    // The page asked for is full, with one more CI known to exist: deeper
    // levels would only add CIs after it.
    if (shownCount > wantedShown) break;
    frontier = readOrder.map((entry) => entry.sys_id);
  }

  // ── Report ──
  // A CI is named by its policy-filtered name, made inert and in quotes, or by its sys_id.
  const labelOf = (id: string): string => {
    const name = quotedInertText(known.get(id)?.name, 60);
    return name === "" ? id : `"${name}"`;
  };
  const namedList = (ids: readonly string[]): string => {
    const unique = [...new Set(ids)];
    const named = unique.slice(0, limits.namedInWarning).map(labelOf);
    const more = unique.length - named.length;
    return `${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  };
  const capText: Record<Cap, string> = {
    requests: `the ${limits.maxRequests}-request limit`,
    relationship_rows: `the ${limits.maxRelationshipRows}-relationship-row limit`,
    response_bytes: "the response size limit",
    cis: `the ${limits.maxCis}-CI limit`,
    error: "an error",
  };
  let truncatedBy: Record<string, unknown> | undefined;
  if (stop) {
    truncatedBy = {
      cap: stop.cap,
      ...(stop.cap === "requests"
        ? { max: limits.maxRequests }
        : stop.cap === "relationship_rows"
          ? { max: limits.maxRelationshipRows }
          : {}),
      depth: stop.depth,
      unread_cis: stop.unread.length,
    };
    warnings.push(
      `Relationships of ${quantity(stop.unread.length, "CI")} at depth ${stop.depth} were not fully read, ` +
        `stopped by ${capText[stop.cap]}: ${namedList(stop.unread)}. ` +
        "Their relationships and the CIs beyond them may be missing; narrow the walk with a lower depth, a type, or a nearer start CI."
    );
  } else if (ciStop) {
    truncatedBy = {
      cap: ciStop.cap,
      ...(ciStop.cap === "requests"
        ? { max: limits.maxRequests }
        : ciStop.cap === "cis"
          ? { max: limits.maxCis }
          : {}),
      depth: ciStop.depth,
      unread_cis: ciStop.count,
    };
  }
  if (ciStop && ciStop.count > 0) {
    warnings.push(
      `${quantity(ciStop.count, "CI")} found at depth ${ciStop.depth} could not be read, stopped by ${capText[ciStop.cap]}, ` +
        `so ${ciStop.count === 1 ? "it is" : "they are"} left out, with the CIs beyond. ` +
        `They are related to: ${namedList([...skippedVia])}.`
    );
  }
  if (leftOut.size > 0) {
    warnings.push(
      leftOut.size === 1
        ? "1 relationship leads to a CI this profile can't read; it is left out."
        : `${leftOut.size} relationships lead to CIs this profile can't read; they are left out.`
    );
  }
  if (invalidIdentifier) {
    warnings.push("cmdb_rel_ci returned an invalid relationship identifier");
  }

  const shown: RelNode[] = listed
    .filter((entry) => matchesClass({ ...(entry.class === undefined ? {} : { class: entry.class }) }))
    .map((entry) => ({
      ...(nameShown ? { name: entry.name ?? entry.sys_id } : {}),
      ...(entry.class === undefined ? {} : { class: entry.class }),
      type: entry.type,
      direction: entry.direction,
      sys_id: entry.sys_id,
      via: entry.via,
      depth: entry.depth,
    }));
  const page = shown.slice(args.offset, args.offset + args.limit);
  const hasMore = args.offset + page.length < shown.length;

  const data: Record<string, unknown> = {
    root: {
      ...(rootView.name === undefined ? {} : { name: rootView.name }),
      ...(rootView.class === undefined ? {} : { class: rootView.class }),
      sys_id: rootId,
    },
    relationships: page,
    meta: {
      depth: maxDepth,
      direction,
      total: shown.length,
      offset: args.offset,
      limit: args.limit,
      has_more: hasMore,
      ...(hasMore ? { next_offset: args.offset + page.length } : {}),
      traversal_truncated: truncatedBy !== undefined,
      traversal_requests: requests,
      ...(truncatedBy === undefined ? {} : { truncated_by: truncatedBy }),
      ...(leftOut.size > 0 ? { unreadable_relationships: leftOut.size } : {}),
    },
  };

  if (args.map) {
    const node = (entry: { sys_id: string; name?: string; class?: string; depth: number }): MapNode => ({
      sys_id: entry.sys_id,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.class === undefined ? {} : { class: entry.class }),
      depth: entry.depth,
    });
    const pageIds = new Set(page.map((entry) => entry.sys_id));
    const inPage = listed.filter((entry) => pageIds.has(entry.sys_id));
    const map = buildRelationshipMap(
      node({ sys_id: rootId, ...(rootView.name === undefined ? {} : { name: rootView.name }), ...(rootView.class === undefined ? {} : { class: rootView.class }), depth: 0 }),
      inPage.map(node),
      [...edges.values()]
        .sort((a, b) => a.rank - b.rank || ((a.sys_id ?? "") < (b.sys_id ?? "") ? -1 : (a.sys_id ?? "") > (b.sys_id ?? "") ? 1 : 0))
        .map(({ rank: _rank, ...edge }) => edge),
      Math.floor(args.max_response_bytes * limits.mapShare)
    );
    data.nodes = map.nodes;
    data.edges = map.edges;
    data.diagram = map.diagram;
    if (map.omitted_nodes > 0) {
      (data.meta as Record<string, unknown>).map_omitted_cis = map.omitted_nodes;
      warnings.push(
        `The map holds the first ${map.nodes.length} of ${map.nodes.length + map.omitted_nodes} CIs to fit the response budget; ` +
          "lower limit, or page with offset, for the rest."
      );
    }
  }

  return ok(withWarnings(data, warnings));
}
