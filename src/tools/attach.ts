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
const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const definition = {
  name: "sn_attach",
  description:
    "Manage attachments on ServiceNow records. List, download, or upload attachments.",
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
  content_base64: z.string().max(MAX_ATTACHMENT_BASE64_LENGTH).optional().describe("Base64 attachment bytes (required for upload; max 10 MiB decoded)"),
  content_type: z.string().optional().describe("MIME type for upload (default: application/octet-stream)"),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe("Maximum attachments to list (default 100, max 1000)"),
  offset: z.number().int().min(0).max(10000).optional().default(0).describe("Deterministic list offset (default 0)"),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowOperations,
  _config: ServiceNowToolSettings,
  _context: ExecutionContext
) {
  try {
    switch (args.action) {
      case "list": {
        if (!args.table || !args.sys_id) {
          return err("table and sys_id are required for listing attachments");
        }
        const resp = await client.get("/api/now/attachment", {
          sysparm_query: `table_name=${escapeQueryValue(args.table)}^table_sys_id=${escapeQueryValue(args.sys_id)}`,
          sysparm_limit: String(args.limit),
          sysparm_offset: String(args.offset),
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
        const data = decodeBoundedBase64(args.content_base64);
        const contentType = args.content_type || "application/octet-stream";

        const resp = await client.postBinary(
          "/api/now/attachment/file",
          data,
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
  } catch (error) {
    throw error;
  }
}

function isSafeLeafFilename(candidate: string): boolean {
  return (
    candidate !== "." &&
    candidate !== ".." &&
    !candidate.includes("/") &&
    !candidate.includes("\\") &&
    !/[\u0000-\u001F\u007F]/u.test(candidate)
  );
}

function decodeBoundedBase64(candidate: string): Buffer {
  if (!BASE64.test(candidate)) throw new TypeError("content_base64 is invalid");
  const decoded = Buffer.from(candidate, "base64");
  if (decoded.length > MAX_ATTACHMENT_BYTES) {
    throw new TypeError("attachment exceeds the decoded size limit");
  }
  return decoded;
}
