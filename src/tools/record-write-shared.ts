/** Shared response hardening for the dedicated ordinary write modules. */

import { types as nodeUtilTypes } from "node:util";

import {
  filterReadableRecord,
  isAllFieldSelection,
  preparedReadableFields,
  resolveWriteResponseFields,
  type FieldSelection,
} from "../field-policy.js";
import { normalizeServiceNowSysId } from "../servicenow-identifiers.js";
import { createToolError, type ToolErrorRetry } from "../tool-error.js";
import { stripEmpty } from "../utils.js";

const RECORD_NUMBER = /^[A-Za-z0-9_-]{1,80}$/u;

/**
 * Identity of the record a write just touched. It is returned whatever the
 * readable set says: without `sys_id` a create that succeeded upstream reads
 * as an upstream failure, the caller retries, and the record is duplicated
 * (or, for ATF authoring, orphaned because rollback has no handle).
 */
const WRITTEN_RECORD_IDENTITY_FIELDS = Object.freeze(["sys_id", "number"]);

export function filteredWriteRecord(
  args: Readonly<Record<string, unknown>>,
  response: unknown,
  retry: ToolErrorRetry
): Record<string, unknown> {
  const readableFields =
    preparedReadableFields(args, args.table) ??
    resolveWriteResponseFields(args.table);
  const candidate = filterReadableRecord(
    resultProperty(response, retry),
    withWrittenRecordIdentity(readableFields)
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

function withWrittenRecordIdentity(readable: FieldSelection): FieldSelection {
  if (isAllFieldSelection(readable)) return readable;
  const missing = WRITTEN_RECORD_IDENTITY_FIELDS.filter(
    (field) => !readable.includes(field)
  );
  return missing.length === 0 ? readable : [...readable, ...missing];
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
