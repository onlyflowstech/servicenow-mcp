import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";
import * as fs from "fs";
import * as path from "path";

export const definition = {
  name: "sn_attach",
  description:
    "Manage attachments on ServiceNow records. List, download, or upload attachments. " +
    "Upload accepts either a local file_path or inline base64 content (for remote/hosted " +
    "servers with no local filesystem). Download writes to output_path or, with " +
    "return_content, returns the bytes as base64 inline.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "download", "upload"],
        description: "Attachment operation: list, download, or upload",
      },
      table: {
        type: "string",
        description: "Table name (required for list and upload)",
      },
      sys_id: {
        type: "string",
        description: "Record sys_id (required for list and upload)",
      },
      attachment_sys_id: {
        type: "string",
        description: "Attachment sys_id (required for download)",
      },
      output_path: {
        type: "string",
        description:
          "Local file path to save downloaded attachment (omit and set return_content=true to get base64 inline)",
      },
      return_content: {
        type: "boolean",
        description:
          "For download: return the attachment bytes as base64 in the response instead of writing to output_path. Default false.",
      },
      file_path: {
        type: "string",
        description: "Local file path to upload (alternative to content)",
      },
      content: {
        type: "string",
        description:
          "For upload: base64-encoded file bytes to upload directly, without a local file. Requires file_name. Use this from remote/hosted servers that can't read a local file_path.",
      },
      file_name: {
        type: "string",
        description:
          "File name for the uploaded attachment. Required when uploading via content; optional with file_path (defaults to the file's basename).",
      },
      content_type: {
        type: "string",
        description: "MIME type for upload (default: application/octet-stream)",
      },
    },
    required: ["action"],
  },
};

export const schema = z.object({
  action: z.enum(["list", "download", "upload"]),
  table: z.string().optional(),
  sys_id: z.string().optional(),
  attachment_sys_id: z.string().optional(),
  output_path: z.string().optional(),
  return_content: z.boolean().optional(),
  file_path: z.string().optional(),
  content: z.string().optional(),
  file_name: z.string().optional(),
  content_type: z.string().optional(),
});

export async function handler(
  args: z.infer<typeof schema>,
  client: ServiceNowClient,
  _config: ServiceNowConfig
) {
  try {
    switch (args.action) {
      case "list": {
        if (!args.table || !args.sys_id) {
          return err("table and sys_id are required for listing attachments");
        }
        const resp = await client.get("/api/now/attachment", {
          sysparm_query: `table_name=${args.table}^table_sys_id=${args.sys_id}`,
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
        if (!args.attachment_sys_id) {
          return err("attachment_sys_id is required for download");
        }
        if (!args.output_path && !args.return_content) {
          return err(
            "either output_path or return_content=true is required for download"
          );
        }
        const { data } = await client.getRaw(
          `/api/now/attachment/${args.attachment_sys_id}/file`
        );
        if (args.return_content) {
          return ok({
            status: "downloaded",
            size_bytes: data.length,
            encoding: "base64",
            content: Buffer.from(data).toString("base64"),
          });
        }
        fs.writeFileSync(args.output_path as string, data);
        return ok({
          status: "downloaded",
          path: args.output_path,
          size_bytes: data.length,
        });
      }

      case "upload": {
        if (!args.table || !args.sys_id) {
          return err("table and sys_id are required for upload");
        }

        let data: Buffer;
        let filename: string;
        if (args.content !== undefined) {
          if (!args.file_name) {
            return err(
              "file_name is required when uploading via content (base64)"
            );
          }
          data = Buffer.from(args.content, "base64");
          filename = args.file_name;
        } else if (args.file_path) {
          if (!fs.existsSync(args.file_path)) {
            return err(`File not found: ${args.file_path}`);
          }
          data = fs.readFileSync(args.file_path);
          filename = args.file_name || path.basename(args.file_path);
        } else {
          return err(
            "either file_path or content (base64) is required for upload"
          );
        }
        const contentType = args.content_type || "application/octet-stream";

        const resp = await client.postBinary(
          "/api/now/attachment/file",
          data,
          contentType,
          {
            table_name: args.table,
            table_sys_id: args.sys_id,
            file_name: filename,
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
    return err(formatError(error));
  }
}
