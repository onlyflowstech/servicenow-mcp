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
import {
  defineServiceNowToolModule,
  withRequiredProfile,
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
const DEFAULT_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedSchema {
  readonly expiresAt: number;
  readonly rows: readonly Record<string, unknown>[];
  readonly hierarchy: readonly string[];
}

const SCHEMA_CACHE = new WeakMap<ServiceNowOperations, Map<string, CachedSchema>>();

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

async function executeSchema(
  args: SchemaArguments,
  client: ServiceNowOperations
): Promise<CallToolResult> {
  try {
    const readableFields =
      preparedReadableFields(args, args.table) ??
      resolveReadableFields(args.table, { fields: "all" });
    const schema = await loadSchemaMetadata(
      client,
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
        ...(record.inherited_from !== undefined ? { inherited_from: record.inherited_from } : {}),
      })),
      hasMore
    );
  } catch (error) {
    throw error;
  }
}


async function loadSchemaMetadata(
  client: ServiceNowOperations,
  table: string,
  readableFields: FieldSelection,
  enrich: boolean,
  forceRecache: boolean
): Promise<CachedSchema> {
  const key = `${table}|${enrich ? "full" : "fields"}|${isAllFieldSelection(readableFields) ? "*" : [...readableFields].sort().join(",")}`;
  const cache = schemaCacheFor(client);
  const cached = cache.get(key);
  const now = Date.now();
  if (!forceRecache && cached && cached.expiresAt > now) return cached;

  const hierarchy = enrich ? await resolveTableHierarchy(client, table, forceRecache) : Object.freeze([table]);
  const rows = enrich
    ? await fetchDictionaryRows(client, hierarchy, readableFields, forceRecache)
    : await fetchLocalDictionaryRows(client, table, readableFields, forceRecache);
  const enriched = enrich
    ? await enrichSchemaRows(client, table, readableFields, rows, forceRecache)
    : rows;
  const snapshot: CachedSchema = Object.freeze({
    expiresAt: now + DEFAULT_SCHEMA_CACHE_TTL_MS,
    rows: Object.freeze(enriched.map((row) => Object.freeze({ ...row }))),
    hierarchy: Object.freeze([...hierarchy]),
  });
  cache.set(key, snapshot);
  return snapshot;
}

function schemaCacheFor(client: ServiceNowOperations): Map<string, CachedSchema> {
  const existing = SCHEMA_CACHE.get(client);
  if (existing) return existing;
  const next = new Map<string, CachedSchema>();
  SCHEMA_CACHE.set(client, next);
  return next;
}

async function resolveTableHierarchy(
  client: ServiceNowOperations,
  table: string,
  forceRecache: boolean
): Promise<readonly string[]> {
  const hierarchy: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = table;
  for (let depth = 0; current && depth < MAX_SCHEMA_HIERARCHY_DEPTH; depth += 1) {
    const normalized = normalizeTableName(current);
    if (!normalized || seen.has(normalized)) break;
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
    current = extractSuperClassName(row);
  }
  return hierarchy.length > 0 ? Object.freeze(hierarchy) : Object.freeze([table]);
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

function normalizeTableName(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,79}$/u.test(trimmed) ? trimmed : undefined;
}

function extractSuperClassName(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
  const value = (row as Record<string, unknown>).super_class;
  if (typeof value === "string") return normalizeTableName(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return normalizeTableName(record.display_value ?? record.value);
  }
  return undefined;
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
    executeSchema(args as unknown as SchemaArguments, services.serviceNow),
});
