/**
 * Canonical sn_schema metadata module.
 *
 * This is the representative read-only module: public MCP metadata, compatible
 * input schemas, complete access requirements, handler composition, field
 * filtering, and safe errors live together. `schema.ts` remains only as the
 * legacy source-level export facade.
 *
 * @module tools/schema-module
 */

import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ServiceNowOperations } from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import { FORCE_RECACHE_PARAM } from "../metadata-cache.js";
import {
  filterSchemaEntries,
  fieldSelectionToSysparmFields,
  MAX_FIELDS_PER_OPERATION,
  isAllFieldSelection,
  preparedReadableFields,
  resolveReadableFields,
  type FieldSelection,
} from "../field-policy.js";
import { resolveToolTableAccess } from "../tool-table-access.js";
import { escapeQueryValue, ok } from "../utils.js";
import {
  envelopeCompatibilityResult,
  productionToolOutputSchemas,
} from "./result-envelope.js";
import { resolveTableHierarchy } from "./table-hierarchy.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  type SchemaCacheBinding,
  type ServiceNowToolSettings,
  type ToolDefinition,
} from "./tool-module.js";

export const definition = Object.freeze({
  name: "sn_schema",
  description:
    "Get the schema (field definitions) for a ServiceNow table. Returns field names, types, max lengths, mandatory flags, and reference targets.",
  annotations: Object.freeze({
    title: "Get table schema",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  }),
} satisfies ToolDefinition);

function compatibleInputSchema() {
  return z.object({
    table: z.string().describe("ServiceNow table name (e.g. incident)"),
    fields_only: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, return only a sorted list of field names"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(500)
      .describe("Maximum dictionary rows to return (1-500)"),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .default(0)
      .describe("Zero-based dictionary row offset (0-10000)"),
    force_recache: z
      .boolean()
      .optional()
      .default(false)
      .describe("Bypass the per-instance metadata cache and refresh schema metadata from ServiceNow."),
  });
}

/** Legacy source-level schema; MCP registration uses `moduleInputSchema`. */
export const schema = compatibleInputSchema();

/** Exact public MCP input, including the mandatory shared profile selector. */
export const moduleInputSchema = withRequiredProfile(compatibleInputSchema());

type SchemaArguments = z.output<typeof schema>;

const MAX_DICTIONARY_ROWS = MAX_FIELDS_PER_OPERATION + 1;
const MAX_SCHEMA_HIERARCHY_DEPTH = 8;
export const DEFAULT_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000;
/** Process-wide entry cap, evicted least recently used. An entry holds at most
 * MAX_DICTIONARY_ROWS rows plus their choices. */
export const MAX_SCHEMA_CACHE_ENTRIES = 256;

interface CachedSchema {
  readonly expiresAt: number;
  readonly rows: readonly Record<string, unknown>[];
  readonly hierarchy: readonly string[];
}

/**
 * Assembled sn_schema results across tool calls, keyed by the binding's scope
 * plus everything else the result depends on (table, enrichment, readable
 * fields). Entries are served for their TTL without revalidation -- several
 * upstream reads go into one, so there is no single watermark to check -- and
 * `force_recache` bypasses and replaces them.
 */
const SCHEMA_CACHE = new Map<string, CachedSchema>();

/**
 * Derive the partition for one profile's sn_schema calls.
 *
 * Every input changes what a caller may see: ServiceNow applies ACLs per
 * credential identity, and the profile's effective policy decides which fields
 * are readable. The digest keeps the credential fingerprint out of the
 * handler. A TTL outside 1 ms..1 h falls back to the default.
 *
 * Like the metadata cache, an unconfigured cache is off under NODE_ENV=test,
 * so suites that reuse one profile and identity across cases stay isolated;
 * the default applies everywhere else.
 */
export function schemaCacheBinding(input: {
  readonly profile: string;
  readonly instance: string;
  readonly credentialIdentity: string;
  readonly policy: unknown;
  readonly ttlMs?: number;
}): SchemaCacheBinding | undefined {
  const { ttlMs } = input;
  if (ttlMs === undefined && process.env.NODE_ENV === "test") return undefined;
  return Object.freeze({
    scope: createHash("sha256")
      .update(JSON.stringify([input.profile, input.instance, input.credentialIdentity, input.policy]))
      .digest("base64url"),
    ttlMs:
      typeof ttlMs === "number" && Number.isSafeInteger(ttlMs) && ttlMs >= 1 && ttlMs <= MAX_SCHEMA_CACHE_TTL_MS
        ? ttlMs
        : DEFAULT_SCHEMA_CACHE_TTL_MS,
  });
}

interface SchemaEnvelopeMetadata {
  readonly kind: "collection";
  readonly record_count: number;
  readonly limits: Readonly<Record<string, unknown>>;
  readonly truncation: Readonly<Record<string, unknown>>;
}

/**
 * Compatibility handler retained for direct source consumers. Registered MCP
 * calls use the module below and receive the same implementation.
 */
export async function handler(
  args: SchemaArguments,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
): Promise<CallToolResult> {
  return executeSchema(args, client);
}

/**
 * @param cacheBinding Partition for cross-call reuse. Without one, as for
 *   direct source consumers, every call reads upstream.
 */
async function executeSchema(
  args: SchemaArguments,
  client: ServiceNowOperations,
  cacheBinding?: SchemaCacheBinding
): Promise<CallToolResult> {
  try {
    const readableFields =
      preparedReadableFields(args, args.table) ??
      resolveReadableFields(args.table, { fields: "all" });
    const schema = await loadSchemaMetadata(
      client,
      cacheBinding,
      args.table,
      readableFields,
      !args.fields_only,
      args.force_recache
    );
    const results = filterSchemaEntries(schema.rows, readableFields)
      .filter(
        (record) => typeof record.element === "string" && record.element !== ""
      )
      .sort((left, right) => {
        const fieldOrder = String(left.element).localeCompare(
          String(right.element)
        );
        return fieldOrder !== 0
          ? fieldOrder
          : String(left.sys_id).localeCompare(String(right.sys_id));
      });
    const page = results.slice(args.offset, args.offset + args.limit);
    const hasMore = args.offset + page.length < results.length;
    const showInheritance = canReadTableParents();

    if (args.fields_only) {
      return schemaEnvelopeResult(
        args,
        page.map((record) => record.element as string),
        hasMore
      );
    }

    return schemaEnvelopeResult(
      args,
      page.map((record) => ({
        field: record.element as string,
        label: record.column_label,
        type: record.internal_type,
        max_length: record.max_length,
        mandatory: record.mandatory,
        reference: record.reference || null,
        ...(record.help !== undefined ? { help: record.help } : {}),
        ...(Array.isArray(record.choices) ? { choices: record.choices } : {}),
        ...(showInheritance && record.inherited_from !== undefined
          ? { inherited_from: record.inherited_from }
          : {}),
      })),
      hasMore
    );
  } catch (error) {
    throw error;
  }
}


/**
 * `inherited_from` names an ancestor table, which is what
 * `sys_db_object.super_class` holds. Show it only to a caller whose field
 * policy can read that field; any other outcome hides it.
 */
function canReadTableParents(): boolean {
  try {
    resolveReadableFields("sys_db_object", { fields: "super_class" });
    return true;
  } catch {
    return false;
  }
}

async function loadSchemaMetadata(
  client: ServiceNowOperations,
  cacheBinding: SchemaCacheBinding | undefined,
  table: string,
  readableFields: FieldSelection,
  enrich: boolean,
  forceRecache: boolean
): Promise<CachedSchema> {
  const key =
    cacheBinding === undefined
      ? undefined
      : JSON.stringify([
          cacheBinding.scope,
          table,
          enrich,
          isAllFieldSelection(readableFields) ? "*" : [...readableFields].sort(),
        ]);
  const cached = key === undefined ? undefined : SCHEMA_CACHE.get(key);
  const now = Date.now();
  if (key !== undefined && cached !== undefined) {
    SCHEMA_CACHE.delete(key);
    if (!forceRecache && cached.expiresAt > now) {
      // Re-insert to mark the entry most recently used for eviction order.
      SCHEMA_CACHE.set(key, cached);
      return cached;
    }
  }

  const hierarchy = enrich
    ? await resolveTableHierarchy(client, table, MAX_SCHEMA_HIERARCHY_DEPTH, forceRecache)
    : Object.freeze([table]);
  const rows = enrich
    ? await fetchDictionaryRows(client, hierarchy, readableFields, forceRecache)
    : await fetchLocalDictionaryRows(client, table, readableFields, forceRecache);
  const enriched = enrich
    ? await enrichSchemaRows(client, table, readableFields, rows, forceRecache)
    : rows;
  const snapshot: CachedSchema = Object.freeze({
    expiresAt: now + (cacheBinding?.ttlMs ?? DEFAULT_SCHEMA_CACHE_TTL_MS),
    rows: Object.freeze(enriched.map((row) => Object.freeze({ ...row }))),
    hierarchy: Object.freeze([...hierarchy]),
  });
  if (key !== undefined) {
    // Sweep expired entries first. Otherwise they linger until LRU pressure,
    // and a recently used expired entry outlives an older one still valid.
    const sweptAt = Date.now();
    for (const [candidate, entry] of SCHEMA_CACHE) {
      if (entry.expiresAt <= sweptAt) SCHEMA_CACHE.delete(candidate);
    }
    SCHEMA_CACHE.delete(key);
    SCHEMA_CACHE.set(key, snapshot);
    while (SCHEMA_CACHE.size > MAX_SCHEMA_CACHE_ENTRIES) {
      const oldest = SCHEMA_CACHE.keys().next();
      if (oldest.done) break;
      SCHEMA_CACHE.delete(oldest.value);
    }
  }
  return snapshot;
}

async function fetchLocalDictionaryRows(
  client: ServiceNowOperations,
  table: string,
  readableFields: FieldSelection,
  forceRecache: boolean
): Promise<readonly Record<string, unknown>[]> {
  const authorizedElements = fieldSelectionToSysparmFields(readableFields)
    ?.split(",")
    .map((field) => escapeQueryValue(field))
    .join(",");
  const response = await client.get<{ result?: unknown[] }>(
    "/api/now/table/sys_dictionary",
    {
      sysparm_query:
        `name=${escapeQueryValue(table)}` +
        "^internal_type!=collection" +
        (authorizedElements ? `^elementIN${authorizedElements}` : "") +
        "^ORDERBYelement^ORDERBYsys_id",
      sysparm_fields:
        "sys_id,element,column_label,internal_type,max_length,mandatory,reference",
      sysparm_limit: String(MAX_DICTIONARY_ROWS),
      sysparm_offset: "0",
      sysparm_display_value: "true",
      ...(forceRecache ? { [FORCE_RECACHE_PARAM]: "true" } : {}),
    }
  );
  const rawResults = Array.isArray(response?.result) ? response.result : [];
  if (rawResults.length > MAX_FIELDS_PER_OPERATION) {
    throw new Error("dictionary result exceeded the authorized field bound");
  }
  return Object.freeze(
    rawResults.filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && !Array.isArray(row)
    )
  );
}

async function fetchDictionaryRows(
  client: ServiceNowOperations,
  hierarchy: readonly string[],
  readableFields: FieldSelection,
  forceRecache: boolean
): Promise<readonly Record<string, unknown>[]> {
  const authorizedElements = fieldSelectionToSysparmFields(readableFields)
    ?.split(",")
    .map((field) => escapeQueryValue(field))
    .join(",");
  const response = await client.get<{ result?: unknown[] }>(
    "/api/now/table/sys_dictionary",
    {
      sysparm_query:
        `nameIN${hierarchy.map((name) => escapeQueryValue(name)).join(",")}` +
        "^internal_type!=collection" +
        (authorizedElements ? `^elementIN${authorizedElements}` : "") +
        "^ORDERBYelement^ORDERBYsys_id",
      sysparm_fields:
        "sys_id,name,element,column_label,internal_type,max_length,mandatory,reference",
      sysparm_limit: String(MAX_DICTIONARY_ROWS),
      sysparm_offset: "0",
      sysparm_display_value: "true",
      ...(forceRecache ? { [FORCE_RECACHE_PARAM]: "true" } : {}),
    }
  );
  const rawResults = Array.isArray(response?.result) ? response.result : [];
  if (rawResults.length > MAX_FIELDS_PER_OPERATION) {
    throw new Error("dictionary result exceeded the authorized field bound");
  }
  const byElement = new Map<string, Record<string, unknown>>();
  const rank = new Map(hierarchy.map((name, index) => [name, index] as const));
  for (const candidate of rawResults) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    const element = typeof row.element === "string" ? row.element : "";
    if (!isAllFieldSelection(readableFields) && !readableFields.includes(element)) continue;
    const name = typeof row.name === "string" ? row.name : hierarchy[0];
    const previous = byElement.get(element);
    if (!previous) {
      byElement.set(element, { ...row, ...(name !== hierarchy[0] ? { inherited_from: name } : {}) });
      continue;
    }
    const previousName = typeof previous.name === "string" ? previous.name : hierarchy[0];
    if ((rank.get(name) ?? Number.MAX_SAFE_INTEGER) < (rank.get(previousName) ?? Number.MAX_SAFE_INTEGER)) {
      byElement.set(element, { ...row, ...(name !== hierarchy[0] ? { inherited_from: name } : {}) });
    }
  }
  return Object.freeze([...byElement.values()]);
}

async function enrichSchemaRows(
  client: ServiceNowOperations,
  table: string,
  readableFields: FieldSelection,
  rows: readonly Record<string, unknown>[],
  forceRecache: boolean
): Promise<readonly Record<string, unknown>[]> {
  const labels = await fetchDocumentation(client, table, readableFields, forceRecache);
  const choices = await fetchChoices(client, table, readableFields, forceRecache);
  return rows.map((row) => {
    const field = typeof row.element === "string" ? row.element : "";
    return {
      ...row,
      ...(labels.get(field) ?? {}),
      ...(choices.has(field) ? { choices: choices.get(field) } : {}),
    };
  });
}

async function fetchDocumentation(
  client: ServiceNowOperations,
  table: string,
  readableFields: FieldSelection,
  forceRecache: boolean
): Promise<Map<string, Record<string, unknown>>> {
  const response = await client.get<{ result?: unknown[] }>(
    "/api/now/table/sys_documentation",
    {
      sysparm_query:
        `name=${escapeQueryValue(table)}` +
        (isAllFieldSelection(readableFields) ? "" : `^elementIN${readableFields.map((field) => escapeQueryValue(field)).join(",")}`) +
        "^ORDERBYelement",
      sysparm_fields: "element,label,plural,help",
      sysparm_limit: String(MAX_DICTIONARY_ROWS),
      sysparm_display_value: "true",
      sysparm_exclude_reference_link: "true",
      ...(forceRecache ? { [FORCE_RECACHE_PARAM]: "true" } : {}),
    }
  );
  const out = new Map<string, Record<string, unknown>>();
  for (const row of Array.isArray(response?.result) ? response.result : []) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const element = typeof record.element === "string" ? record.element : undefined;
    if (!element || (!isAllFieldSelection(readableFields) && !readableFields.includes(element))) continue;
    const entry: Record<string, unknown> = {};
    if (typeof record.label === "string" && record.label.trim()) entry.column_label = record.label;
    if (typeof record.help === "string" && record.help.trim()) entry.help = record.help;
    if (Object.keys(entry).length > 0) out.set(element, entry);
  }
  return out;
}

async function fetchChoices(
  client: ServiceNowOperations,
  table: string,
  readableFields: FieldSelection,
  forceRecache: boolean
): Promise<Map<string, readonly Record<string, unknown>[]>> {
  const response = await client.get<{ result?: unknown[] }>(
    "/api/now/table/sys_choice",
    {
      sysparm_query:
        `name=${escapeQueryValue(table)}` +
        (isAllFieldSelection(readableFields) ? "" : `^elementIN${readableFields.map((field) => escapeQueryValue(field)).join(",")}`) +
        "^inactive=false^ORDERBYelement^ORDERBYsequence^ORDERBYvalue",
      sysparm_fields: "element,value,label,sequence",
      sysparm_limit: String(MAX_DICTIONARY_ROWS),
      sysparm_display_value: "true",
      sysparm_exclude_reference_link: "true",
      ...(forceRecache ? { [FORCE_RECACHE_PARAM]: "true" } : {}),
    }
  );
  const out = new Map<string, Record<string, unknown>[]>();
  for (const row of Array.isArray(response?.result) ? response.result : []) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const element = typeof record.element === "string" ? record.element : undefined;
    if (!element || (!isAllFieldSelection(readableFields) && !readableFields.includes(element))) continue;
    const value = typeof record.value === "string" ? record.value : undefined;
    const label = typeof record.label === "string" ? record.label : value;
    if (!value) continue;
    const list = out.get(element) ?? [];
    list.push(Object.freeze({ value, label }));
    out.set(element, list);
  }
  return new Map([...out.entries()].map(([key, value]) => [key, Object.freeze(value)]));
}

/** Overlay the authoritative local-page continuation on the shared envelope. */
function schemaEnvelopeResult(
  args: SchemaArguments,
  data: unknown[],
  hasMore: boolean
): CallToolResult {
  const adapted = envelopeCompatibilityResult("sn_schema", args, ok(data));
  const structured = adapted.structuredContent;
  const metadata = structured?.metadata as SchemaEnvelopeMetadata | undefined;
  if (!structured || !metadata) {
    throw new TypeError("schema envelope construction failed");
  }
  return {
    ...adapted,
    structuredContent: {
      ...structured,
      metadata: {
        ...metadata,
        pagination: {
          mode: "offset",
          limit: args.limit,
          offset: args.offset,
          returned: data.length,
          has_more: hasMore,
          ...(hasMore ? { next_offset: args.offset + data.length } : {}),
          order_by: ["field", "sys_id"],
        },
      },
    },
  };
}

/** Dedicated contract-bearing module for production registration. */
export const schemaToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition,
  inputSchema: moduleInputSchema,
  outputSchema: productionToolOutputSchemas.sn_schema,
  requirements: {
    permissions: ["read"],
    tables: {
      kind: "dynamic",
      names: ["sys_dictionary", "sys_db_object", "sys_documentation", "sys_choice"],
      description:
        "Caller-selected policy-approved target plus ServiceNow dictionary metadata, inheritance, labels, help, and choices.",
    },
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["metadata:schema"],
  },
  resolveAccess: (args, policy) =>
    resolveToolTableAccess("sn_schema", args, policy.encodedQueryAccess),
  // The contract has already parsed public fields and the access resolver has
  // retained its private issued field-policy marker on this exact object.
  handler: (args, services) =>
    executeSchema(
      args as unknown as SchemaArguments,
      services.serviceNow,
      services.schemaCache
    ),
});
