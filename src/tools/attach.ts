import { z } from "zod";
import {
  MAX_CUMULATIVE_RAW_RESPONSE_BYTES,
  type ServiceNowOperations,
} from "../client.js";
import type { ExecutionContext } from "../execution-context.js";
import type { ServiceNowToolSettings } from "./tool-module.js";
import {
  serviceNowSysIdPathSegment,
  serviceNowSysIdSchema,
} from "../servicenow-identifiers.js";
import { normalizeTableName } from "../table-policy.js";
import { ok, err, escapeQueryValue } from "../utils.js";

export const MAX_ATTACHMENT_BYTES = MAX_CUMULATIVE_RAW_RESPONSE_BYTES;
/** Columns emitted per line by `base64(1)` and MIME encoders before wrapping. */
const BASE64_WRAP_COLUMNS = 76;
const BASE64_CHARS_FOR_MAX_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
/**
 * Base64 characters required for MAX_ATTACHMENT_BYTES plus headroom for the
 * CRLF line breaks wrapped encoders insert. Whitespace is stripped before
 * decoding, so this headroom never widens the decoded-byte bound below.
 */
export const MAX_ATTACHMENT_BASE64_LENGTH =
  BASE64_CHARS_FOR_MAX_BYTES +
  Math.ceil(BASE64_CHARS_FOR_MAX_BYTES / BASE64_WRAP_COLUMNS) * 2;
const MAX_CONTENT_TYPE_LENGTH = 255;
/** Standard alphabet only: `-` and `_` would silently decode to other bytes. */
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*$/u;
/** RFC 6838 type/subtype with unquoted parameters; excludes every control byte. */
const CONTENT_TYPE =
  /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:[ \t]*;[ \t]*[A-Za-z0-9!#$%&'*+.^_`|~-]+=[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/u;
/** C0/C1 controls plus the bidi and zero-width formats used to spoof names. */
const UNSAFE_FILENAME_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

export const definition = {
  name: "sn_attach",
  description:
    "Manage attachments on ServiceNow records. List, download, or upload attachments. " +
    "Bytes are exchanged inline as base64; this tool never reads or writes the host " +
    "filesystem, so it behaves identically for local, containerized, and remote servers.",
  annotations: {
    title: "Manage attachments",
    // upload POSTs new attachments (list/download are reads); there is no
    // delete action, and re-uploading duplicates rather than replaces.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const schema = z.object({
  action: z.enum(["list", "download", "upload"]).describe("Attachment operation: list, download, or upload"),
  table: z.string().optional().describe("Owning table name (required for list, download, and upload)"),
  sys_id: serviceNowSysIdSchema.optional().describe("Owning 32-hex record sys_id (required for list, download, and upload)"),
  attachment_sys_id: serviceNowSysIdSchema.optional().describe("32-hex attachment sys_id (required for download)"),
  file_name: z.string().trim().min(1).max(255).optional().describe("Leaf filename without path separators (required for upload)"),
  content_base64: z.string().max(MAX_ATTACHMENT_BASE64_LENGTH).optional().describe(
    "Base64 attachment bytes (required for upload). Standard base64 alphabet; line breaks " +
      "are accepted and trailing '=' padding is optional. Decoded bytes must not exceed 10 MiB, " +
      "and the whole tool call must also fit the transport request-body limit — over HTTP " +
      "that defaults to 1 MiB, allowing roughly 760 KiB of attachment; stdio has no such limit."
  ),
  content_type: z.string().max(MAX_CONTENT_TYPE_LENGTH).optional().describe("MIME type for upload, e.g. 'application/pdf' or 'text/plain; charset=utf-8' (default: application/octet-stream)"),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe("Maximum attachments to list (default 100, max 1000)"),
  offset: z.number().int().min(0).max(10000).optional().default(0).describe("Deterministic list offset (default 0)"),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  switch (args.action) {
    case "list": {
      if (!args.table || !args.sys_id) {
        return err("table and sys_id are required for listing attachments");
      }
      const resp = await client.get("/api/now/attachment", {
        sysparm_query: `table_name=${escapeQueryValue(args.table)}^table_sys_id=${escapeQueryValue(args.sys_id)}`,
        sysparm_limit: String(args.limit ?? 100),
        sysparm_offset: String(args.offset ?? 0),
        sysparm_orderby: "sys_id",
      });
      const attachments = (resp.result || []).map(
        (a: Record<string, string>) => ({
          sys_id: a.sys_id,
          file_name: a.file_name,
          size_bytes: a.size_bytes,
          content_type: a.content_type,
          download_link: a.download_link,
        })
      );
      return ok(attachments);
    }

    case "download": {
      if (!args.table || !args.sys_id || !args.attachment_sys_id) {
        return err(
          "table, sys_id, and attachment_sys_id are required for download"
        );
      }
      const metadataResponse = await client.get(
        `/api/now/attachment/${serviceNowSysIdPathSegment(args.attachment_sys_id)}`
      );
      const metadata = metadataResponse?.result;
      let owningTable: string;
      try {
        owningTable = normalizeTableName(metadata?.table_name);
      } catch {
        return err("Attachment ownership could not be verified");
      }
      if (
        owningTable !== args.table ||
        typeof metadata?.table_sys_id !== "string" ||
        metadata.table_sys_id !== args.sys_id
      ) {
        return err("Attachment ownership could not be verified");
      }

      const { data } = await client.getRaw(
        `/api/now/attachment/${serviceNowSysIdPathSegment(args.attachment_sys_id)}/file`,
        { maxBytes: MAX_ATTACHMENT_BYTES }
      );
      if (data.length > MAX_ATTACHMENT_BYTES) {
        return err("Attachment exceeds the 10 MiB response limit");
      }
      return ok({
        status: "downloaded",
        size_bytes: data.length,
        content_type: metadata?.content_type,
        file_name: metadata?.file_name,
        content_base64: data.toString("base64"),
      });
    }

    case "upload": {
      if (!args.table || !args.sys_id || !args.file_name || args.content_base64 === undefined) {
        return err(
          "table, sys_id, file_name, and content_base64 are required for upload"
        );
      }
      if (!isSafeLeafFilename(args.file_name)) {
        return err("file_name must be a safe leaf filename without path separators");
      }
      const contentType = args.content_type ?? "application/octet-stream";
      if (!CONTENT_TYPE.test(contentType)) {
        return err(
          "content_type must be a MIME type such as 'application/pdf' or " +
            "'text/plain; charset=utf-8'"
        );
      }
      // Caller-correctable input is rejected as a tool error, never thrown: a
      // throw here is sanitized into the opaque internal "operation failed
      // unexpectedly" category, which tells the caller not to retry.
      const decoded = decodeBoundedBase64(args.content_base64);
      if (!decoded.ok) return err(decoded.reason);

      const resp = await client.postBinary(
        "/api/now/attachment/file",
        decoded.data,
        contentType,
        {
          table_name: args.table,
          table_sys_id: args.sys_id,
          file_name: args.file_name,
        }
      );
      const result = resp.result || {};
      return ok({
        sys_id: result.sys_id,
        file_name: result.file_name,
        size_bytes: result.size_bytes,
        table_name: result.table_name,
        table_sys_id: result.table_sys_id,
      });
    }

    default:
      return err(`Unknown attachment action: ${args.action}`);
  }
}

function isSafeLeafFilename(candidate: string): boolean {
  return (
    !/^\.+$/u.test(candidate) &&
    !candidate.includes("/") &&
    !candidate.includes("\\") &&
    !UNSAFE_FILENAME_CHARS.test(candidate)
  );
}

type Base64Decoding =
  | { readonly ok: true; readonly data: Buffer }
  | { readonly ok: false; readonly reason: string };

/**
 * Decode caller-supplied base64 under an explicit byte ceiling.
 *
 * `Buffer.from(value, "base64")` silently discards characters outside the
 * alphabet, so a corrupted or wrong-alphabet payload would otherwise upload as
 * truncated bytes rather than failing. The alphabet is validated first, and the
 * decoded length is the authoritative bound, independent of the schema's
 * character-length cap.
 *
 * The byte ceiling is applied to the length implied by the encoding, before any
 * decode buffer is allocated: decoding an oversize payload only to reject it
 * would let a caller allocate the very memory the bound exists to deny.
 */
function decodeBoundedBase64(candidate: string): Base64Decoding {
  const compact = candidate.replace(/[\t\n\f\r ]+/gu, "");
  const body = compact.replace(/={1,2}$/u, "");
  if (body.length === 0) {
    return {
      ok: false,
      reason: "content_base64 must decode to at least one byte",
    };
  }
  if (!BASE64_ALPHABET.test(body) || body.length % 4 === 1) {
    return {
      ok: false,
      reason:
        "content_base64 is not valid base64; expected the standard alphabet " +
        "(A-Z, a-z, 0-9, '+', '/') with optional '=' padding",
    };
  }
  // Decoded size is exactly derivable from the encoded length, so an oversize
  // payload is rejected arithmetically rather than by allocating it first.
  const decodedLength = Math.floor((body.length * 3) / 4);
  if (decodedLength > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason:
        `content_base64 decodes to ${decodedLength} bytes, above the ` +
        `${MAX_ATTACHMENT_BYTES}-byte (10 MiB) limit for one attachment. ` +
        "There is no chunked upload: attach a smaller file, or split it and " +
        "upload each part as its own attachment.",
    };
  }
  const data = Buffer.from(
    body.padEnd(Math.ceil(body.length / 4) * 4, "="),
    "base64"
  );
  return { ok: true, data };
}
