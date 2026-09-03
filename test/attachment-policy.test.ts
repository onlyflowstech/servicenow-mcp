import { describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContext } from "../src/execution-context.js";
import { handler } from "../src/tools/attach.js";

const config = {} as ServiceNowConfig;
const context = {} as ExecutionContext;
const RECORD_ID = "11111111111111111111111111111111";
const ATTACHMENT_ID = "22222222222222222222222222222222";

describe("SNSDK-29 attachment ownership boundary", () => {
  it("denies download when metadata does not match the authorized owner", async () => {
    const get = vi.fn(async () => ({
      result: {
        table_name: "problem",
        table_sys_id: "33333333333333333333333333333333",
      },
    }));
    const getRaw = vi.fn(async () => ({
      data: Buffer.from("must-not-be-read"),
      contentType: "application/octet-stream",
    }));
    const client = { get, getRaw } as unknown as ServiceNowClient;

    const result = await handler(
      {
        action: "download",
        table: "incident",
        sys_id: RECORD_ID,
        attachment_sys_id: ATTACHMENT_ID,
      },
      client,
      config,
      context
    );

    expect(result.isError).toBe(true);
    expect(get).toHaveBeenCalledWith(`/api/now/attachment/${ATTACHMENT_ID}`);
    expect(getRaw).not.toHaveBeenCalled();
  });

  it("returns bounded base64 only after exact owner verification", async () => {
    const bytes = Buffer.from("authorized-attachment");
    const get = vi.fn(async () => ({
      result: {
        table_name: "INCIDENT",
        table_sys_id: RECORD_ID,
        file_name: "evidence.txt",
        content_type: "text/plain",
      },
    }));
    const getRaw = vi.fn(async () => ({
      data: bytes,
      contentType: "application/octet-stream",
    }));
    const client = { get, getRaw } as unknown as ServiceNowClient;

    const result = await handler(
      {
        action: "download",
        table: "incident",
        sys_id: RECORD_ID,
        attachment_sys_id: ATTACHMENT_ID,
      },
      client,
      config,
      context
    );

    expect(result.isError).toBeUndefined();
    expect(getRaw).toHaveBeenCalledWith(
      `/api/now/attachment/${ATTACHMENT_ID}/file`,
      { maxBytes: 10 * 1024 * 1024 }
    );
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body).toMatchObject({
      status: "downloaded",
      size_bytes: bytes.length,
      file_name: "evidence.txt",
      content_type: "text/plain",
      content_base64: bytes.toString("base64"),
    });
  });

  it("uploads bounded bytes without accepting a host filesystem path", async () => {
    const postBinary = vi.fn(async () => ({
      result: {
        sys_id: ATTACHMENT_ID,
        file_name: "evidence.txt",
        size_bytes: "4",
        table_name: "incident",
        table_sys_id: RECORD_ID,
      },
    }));
    const client = { postBinary } as unknown as ServiceNowClient;

    const result = await handler(
      {
        action: "upload",
        table: "incident",
        sys_id: RECORD_ID,
        file_name: "evidence.txt",
        content_base64: Buffer.from("test").toString("base64"),
        content_type: "text/plain",
      },
      client,
      config,
      context
    );

    expect(result.isError).toBeUndefined();
    expect(postBinary).toHaveBeenCalledWith(
      "/api/now/attachment/file",
      Buffer.from("test"),
      "text/plain",
      {
        table_name: "incident",
        table_sys_id: RECORD_ID,
        file_name: "evidence.txt",
      }
    );
  });
});
