import { z } from "zod";
import { ServiceNowClient } from "../client.js";
import { ServiceNowConfig } from "../config.js";
import { ok, err, formatError } from "../utils.js";
import * as fs from "fs";
import * as path from "path";

export const definition = {
  name: "sn_attach",
  description:
    "Manage attachments on ServiceNow records. List, download, or upload attachments.",
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
        description: "Local file path to save downloaded attachment",
      },
      file_path: {
        type: "string",
        description: "Local file path to upload",
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
  file_path: z.string().optional(),
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
        if (!args.output_path) {
          return err("output_path is required for download");
        }
        const { data } = await client.getRaw(
          `/api/now/attachment/${args.attachment_sys_id}/file`
        );
        fs.writeFileSync(args.output_path, data);
        return ok({
          status: "downloaded",
          path: args.output_path,
          size_bytes: data.length,
        });
      }

      case "upload": {
        if (!args.table || !args.sys_id || !args.file_path) {
          return err("table, sys_id, and file_path are required for upload");
        }
        if (!fs.existsSync(args.file_path)) {
          return err(`File not found: ${args.file_path}`);
        }
        const filename = path.basename(args.file_path);
        const data = fs.readFileSync(args.file_path);
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
