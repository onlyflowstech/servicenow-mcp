/** Shared response hardening for the dedicated ordinary write modules. */

import { types as nodeUtilTypes } from "node:util";

import {
  filterReadableRecord,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { normalizeServiceNowSysId } from "../servicenow-identifiers.js";
import { createToolError, type ToolErrorRetry } from "../tool-error.js";
import { stripEmpty } from "../utils.js";

const RECORD_NUMBER = /^[A-Za-z0-9_-]{1,80}$/u;

export function filteredWriteRecord(
  args: Readonly<Record<string, unknown>>,
  response: unknown,
  retry: ToolErrorRetry
): Record<string, unknown> {
  const readableFields =
    preparedReadableFields(args, args.table) ??
    resolveReadableFields(args.table, { fields: "all" });
  const candidate = filterReadableRecord(
    resultProperty(response, retry),
    readableFields
  );
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw createToolError("upstream", retry);
  }
  return stripEmpty(candidate as Record<string, unknown>);
}

export function requiredCreatedSysId(record: Record<string, unknown>): string {
  try {
    return normalizeServiceNowSysId(record.sys_id);
  } catch {
    throw createToolError("upstream", "do_not_retry");
  }
}

/** Tables that carry no `number` column simply omit it. */
export function optionalRecordNumber(
  record: Record<string, unknown>
): string | undefined {
  const candidate = record.number;
  if (candidate === undefined || candidate === "" || candidate === null) {
    return undefined;
  }
  if (typeof candidate !== "string") {
    throw createToolError("upstream", "do_not_retry");
  }
  const number = candidate.trim();
  if (!RECORD_NUMBER.test(number)) {
    throw createToolError("upstream", "do_not_retry");
  }
  return number;
}

/** Read a Table API wrapper without invoking accessors or Proxy traps. */
function resultProperty(response: unknown, retry: ToolErrorRetry): unknown {
  if (
    typeof response !== "object" ||
    response === null ||
    nodeUtilTypes.isProxy(response) ||
    Array.isArray(response)
  ) {
    throw createToolError("upstream", retry);
  }
  const prototype = Object.getPrototypeOf(response);
  if (prototype !== Object.prototype && prototype !== null) {
    throw createToolError("upstream", retry);
  }
  const descriptor = Object.getOwnPropertyDescriptor(response, "result");
  if (!descriptor || !("value" in descriptor)) {
    throw createToolError("upstream", retry);
  }
  return descriptor.value;
}
