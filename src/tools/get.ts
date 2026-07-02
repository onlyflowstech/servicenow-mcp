import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import {
  ok,
  err,
  formatError,
  buildTableParams,
  stripEmpty,
  serializedBytes,
  MAX_RESPONSE_BYTES_DEFAULT,
  MAX_RESPONSE_BYTES_MIN,
  MAX_RESPONSE_BYTES_MAX,
} from "../utils.js";
import { resolveFields } from "../table-defaults.js";

export const definition = {
  name: "sn_get",
  description:
    "Get a single ServiceNow record by sys_id. Field verbosity: an explicit " +
    "fields list always wins; otherwise response_format=\"concise\" (default) " +
    "uses a curated default field set on common tables and " +
    "response_format=\"detailed\" returns the full record (same as " +
    "fields=\"all\"). Records larger than max_response_bytes get their longest " +
    "field values shortened with per-field truncation markers.",
  inputSchema: {
    type: "object" as const,
    properties: {
      table: {
        type: "string",
        description: "ServiceNow table name (e.g. incident)",
      },
      sys_id: {
        type: "string",
        description: "The sys_id of the record to retrieve",
      },
      fields: {
        type: "string",
        description:
          'Comma-separated list of fields to return. Always takes precedence ' +
          'over response_format. Omit for a curated default field set on ' +
          'common tables; pass "all" for every field.',
      },
      response_format: {
        type: "string",
        enum: ["concise", "detailed"],
        description:
          'Verbosity when fields is omitted (default "concise"). "concise" ' +
          "returns the curated default field set on common tables (full " +
          'record on tables without one); "detailed" always returns the full ' +
          'record (same as fields="all"). Ignored when fields is provided.',
      },
      max_response_bytes: {
        type: "integer",
        minimum: MAX_RESPONSE_BYTES_MIN,
        maximum: MAX_RESPONSE_BYTES_MAX,
        description:
          "Byte budget for the serialized record (default 100000, min 1000, " +
          "max 1000000). When a single record exceeds it, the longest field " +
          'values are shortened with a per-field "...[truncated N of M ' +
          'chars]" marker and the response gains truncated: true, ' +
          "truncated_fields, and a hint with follow-up arguments.",
      },
      display_value: {
        type: "string",
        enum: ["true", "false", "all"],
        description: "Display values mode: true, false, or all",
      },
      profile: {
        type: "string",
        description: "Named profile to use. Defaults to active profile.",
      },
    },
    required: ["table", "sys_id"],
  },
};

export const schema = z.object({
  table: z.string(),
  sys_id: z.string(),
  fields: z.string().optional(),
  response_format: z.enum(["concise", "detailed"]).optional().default("concise"),
  max_response_bytes: z
    .number()
    .int()
    .min(MAX_RESPONSE_BYTES_MIN)
    .max(MAX_RESPONSE_BYTES_MAX)
    .optional()
    .default(MAX_RESPONSE_BYTES_DEFAULT),
  display_value: z.enum(["true", "false", "all"]).optional(),
  profile: z.string().optional().describe("Named profile to use. Defaults to active profile."),
});

/** Never shorten a field value below this many leading characters. */
const FIELD_KEEP_CHARS = 200;
/** Headroom for the truncation marker (and multi-byte slack) per cut. */
const MARKER_SLACK = 80;

interface StringLeaf {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  path: string;
  length: number;
}

/** Collect every string leaf in the record with its container and path. */
function collectStringLeaves(node: unknown, path: string, out: StringLeaf[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      const p = `${path}[${i}]`;
      if (typeof item === "string") {
        out.push({ parent: node, key: i, path: p, length: item.length });
      } else {
        collectStringLeaves(item, p, out);
      }
    });
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const p = path ? `${path}.${key}` : key;
      if (typeof value === "string") {
        out.push({ parent: node as Record<string, unknown>, key, path: p, length: value.length });
      } else {
        collectStringLeaves(value, p, out);
      }
    }
  }
}

/**
 * Enforce the max_response_bytes budget on a single record by shortening
 * its longest string field VALUES (largest first). The record's structure
 * and small fields stay intact and the JSON is never mangled. Each
 * shortened value ends with a "...[truncated N of M chars]" marker, and the
 * returned record gains truncated: true, truncated_fields, and a hint with
 * follow-up arguments. Records within budget are returned untouched
 * (byte-identical to the unguarded response).
 */
function enforceByteBudget(
  record: Record<string, unknown>,
  maxBytes: number
): Record<string, unknown> {
  if (serializedBytes(record) <= maxBytes) return record;

  const clone = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  const truncatedFields: string[] = [];
  // Top-level field name usable as a fields= arg (strips .nested and [idx]).
  const exampleField = () =>
    (truncatedFields[0] ?? "<field_name>").split(".")[0].split("[")[0];
  const build = (): Record<string, unknown> => ({
    ...clone,
    truncated: true,
    truncated_fields: truncatedFields,
    hint:
      `Record truncated to fit max_response_bytes=${maxBytes}: the longest ` +
      "field values were shortened (see truncated_fields). Fetch a full " +
      `value one field at a time (e.g. fields="${exampleField()}"), or ` +
      `raise max_response_bytes (max ${MAX_RESPONSE_BYTES_MAX}).`,
  });

  const leaves: StringLeaf[] = [];
  collectStringLeaves(clone, "", leaves);
  leaves.sort((a, b) => b.length - a.length);

  let bytes = serializedBytes(build());
  for (const leaf of leaves) {
    if (bytes <= maxBytes) break;
    const container = leaf.parent as Record<string | number, unknown>;
    const value = container[leaf.key];
    if (typeof value !== "string") continue;
    const available = value.length - FIELD_KEEP_CHARS;
    if (available <= MARKER_SLACK) continue; // too small to shrink safely
    const overshoot = bytes - maxBytes;
    const cut = Math.min(available, overshoot + MARKER_SLACK);
    const keepLen = value.length - cut;
    container[leaf.key] =
      value.slice(0, keepLen) + `...[truncated ${cut} of ${value.length} chars]`;
    truncatedFields.push(leaf.path);
    bytes = serializedBytes(build());
  }

  // Nothing was safely shrinkable (e.g. thousands of tiny fields): return
  // the record untouched rather than claim a truncation that never happened.
  if (truncatedFields.length === 0) return record;
  return build();
}

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  config: ServiceNowConfig
) {
  try {
    const params = buildTableParams({
      // Precedence: explicit fields > response_format. "detailed" maps to
      // the full record exactly like fields="all"; "concise" (default)
      // keeps the curated DEFAULT_FIELDS behavior.
      fields: resolveFields(
        args.table,
        args.fields ?? (args.response_format === "detailed" ? "all" : undefined)
      ),
      displayValue: args.display_value ?? config.displayValue,
    });

    const resp = await client.get(
      `/api/now/table/${args.table}/${args.sys_id}`,
      params
    );
    const record = stripEmpty(resp.result);
    if (record !== null && typeof record === "object" && !Array.isArray(record)) {
      return ok(
        enforceByteBudget(record as Record<string, unknown>, args.max_response_bytes)
      );
    }
    return ok(record);
  } catch (error) {
    return err(formatError(error));
  }
}
