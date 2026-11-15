/**
 * A small stand-in for the Table API, enough for sn_codesearch: LIKE and IN
 * and equality clauses, ORDERBY, offset and limit, field projection, and the
 * 1 MiB response cap. It records every read. Synthetic rows only.
 */
import { vi } from "vitest";

import { ServiceNowResponseTooLargeError } from "../src/client.js";

export type FakeRow = Record<string, string>;

export interface FakeRead {
  readonly table: string;
  readonly params: Record<string, string>;
  /** Serialized size of the answer, in bytes. */
  bytes: number;
  /** True when the answer passed the cap and the read threw instead. */
  tooLarge: boolean;
}

export const RESPONSE_CAP_BYTES = 1024 * 1024;

export function sysId(index: number, salt = 0): string {
  return (salt * 1_000_000 + index).toString(16).padStart(32, "0");
}

/** A script that holds `term` once, near the middle, in a body of `size` characters. */
export function scriptWith(term: string, size: number): string {
  const half = Math.max(0, Math.floor((size - term.length) / 2));
  return `${"// ".padEnd(half, "x")}${term}${"y".repeat(half)}`;
}

export function fakeInstance(
  tables: Record<string, readonly FakeRow[]>,
  options: {
    readonly capBytes?: number;
    /** Make a table's reads fail with this error. */
    readonly fail?: Record<string, unknown>;
    /** Delay a table's reads, in ms, to reorder completion. */
    readonly delayMs?: Record<string, number>;
    /** Make every read of scripts by id fail with this error. */
    readonly failBodies?: unknown;
    /**
     * Fields the instance returns as `{ link, value }` unless the read sends
     * sysparm_exclude_reference_link=true, as it does for a reference field.
     */
    readonly referenceFields?: readonly string[];
  } = {}
) {
  const reads: FakeRead[] = [];
  let inFlight = 0;
  let peak = 0;
  const cap = options.capBytes ?? RESPONSE_CAP_BYTES;

  const get = vi.fn(async (path: string, params: Record<string, string> = {}) => {
    const table = /\/api\/now\/table\/([a-z_]+)/u.exec(path)![1]!;
    const read: FakeRead = { table, params, bytes: 0, tooLarge: false };
    reads.push(read);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      const delay = options.delayMs?.[table];
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
      const failure = options.fail?.[table];
      if (failure !== undefined) throw failure;
      if (options.failBodies !== undefined && (params.sysparm_query ?? "").startsWith("sys_idIN")) {
        throw options.failBodies;
      }
      const rows = select(tables[table] ?? [], params.sysparm_query ?? "");
      const offset = Number(params.sysparm_offset ?? 0);
      const limit = Number(params.sysparm_limit ?? rows.length);
      const fields = (params.sysparm_fields ?? "").split(",").filter(Boolean);
      const links = params.sysparm_exclude_reference_link !== "true";
      const shaped = (field: string, value: string): unknown =>
        links && options.referenceFields?.includes(field)
          ? { link: `https://fake.service-now.com/api/now/table/x/${value}`, value }
          : value;
      const result = rows.slice(offset, offset + limit).map((row) =>
        Object.fromEntries(
          (fields.length === 0 ? Object.keys(row) : fields.filter((field) => field in row)).map((field) => [
            field,
            shaped(field, row[field]!),
          ])
        )
      );
      read.bytes = Buffer.byteLength(JSON.stringify({ result }), "utf8");
      if (read.bytes > cap) {
        read.tooLarge = true;
        throw new ServiceNowResponseTooLargeError("raw response exceeds configured byte limit");
      }
      return { result };
    } finally {
      inFlight -= 1;
    }
  });

  return {
    get,
    reads,
    peak: () => peak,
    /** Reads that found rows (as opposed to reading bodies by id). */
    finds: () => reads.filter((read) => !(read.params.sysparm_query ?? "").startsWith("sys_idIN")),
    bodies: () => reads.filter((read) => (read.params.sysparm_query ?? "").startsWith("sys_idIN")),
  };
}

/** Apply the encoded-query clauses sn_codesearch sends. */
function select(rows: readonly FakeRow[], query: string): FakeRow[] {
  let out = [...rows];
  let order: string | undefined;
  for (const clause of query.split("^").filter(Boolean)) {
    if (clause.startsWith("ORDERBY")) {
      order = clause.slice("ORDERBY".length);
      continue;
    }
    const like = /^([a-z_]+)LIKE(.*)$/su.exec(clause);
    const endsWith = /^([a-z_]+)ENDSWITH(.*)$/su.exec(clause);
    const inList = /^([a-z_]+)IN(.*)$/su.exec(clause);
    const equals = /^([a-z_]+)=(.*)$/su.exec(clause);
    if (endsWith) {
      const [, field, value] = endsWith;
      out = out.filter((row) => (row[field!] ?? "").toLowerCase().endsWith(value!.toLowerCase()));
    } else if (like) {
      const [, field, value] = like;
      out = out.filter((row) => (row[field!] ?? "").toLowerCase().includes(value!.toLowerCase()));
    } else if (inList) {
      const [, field, value] = inList;
      const wanted = new Set(value!.split(","));
      out = out.filter((row) => wanted.has(row[field!] ?? ""));
    } else if (equals) {
      const [, field, value] = equals;
      out = out.filter((row) => (row[field!] ?? "") === value);
    } else {
      throw new Error(`fake instance: unsupported clause ${clause}`);
    }
  }
  if (order !== undefined) {
    const key = order;
    out.sort((left, right) => (left[key] ?? "").localeCompare(right[key] ?? ""));
  }
  return out;
}
