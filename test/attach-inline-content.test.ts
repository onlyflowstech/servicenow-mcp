import { describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import type { ExecutionContext } from "../src/execution-context.js";
import {
  MAX_ATTACHMENT_BASE64_LENGTH,
  MAX_ATTACHMENT_BYTES,
  handler,
  schema,
} from "../src/tools/attach.js";

const config = {} as ServiceNowConfig;
const context = {} as ExecutionContext;
const RECORD_ID = "11111111111111111111111111111111";
const ATTACHMENT_ID = "22222222222222222222222222222222";

function uploadClient() {
  const postBinary = vi.fn(async () => ({
    result: {
      sys_id: ATTACHMENT_ID,
      file_name: "evidence.txt",
      size_bytes: "4",
      table_name: "incident",
      table_sys_id: RECORD_ID,
    },
  }));
  return { postBinary, client: { postBinary } as unknown as ServiceNowClient };
}

function upload(overrides: Record<string, unknown>) {
  return {
    action: "upload" as const,
    table: "incident",
    sys_id: RECORD_ID,
    file_name: "evidence.txt",
    ...overrides,
  } as Parameters<typeof handler>[0];
}

function errorText(result: Awaited<ReturnType<typeof handler>>): string {
  return (result.content[0] as { text: string }).text;
}

describe("sn_attach inline base64 upload", () => {
  it("round-trips exact bytes through base64 to the binary endpoint", async () => {
    // Non-UTF8 bytes prove the payload is not silently re-encoded as text.
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x7f, 0xc3, 0x28]);
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({
        content_base64: bytes.toString("base64"),
        content_type: "application/octet-stream",
      }),
      client,
      config,
      context
    );

    expect(result.isError).toBeUndefined();
    const [, sent] = postBinary.mock.calls[0]! as unknown as [string, Buffer];
    expect(Buffer.compare(sent, bytes)).toBe(0);
  });

  it("accepts line-wrapped base64 as produced by base64(1)", async () => {
    const bytes = Buffer.alloc(200, 0x41);
    const wrapped = bytes.toString("base64").replace(/(.{76})/gu, "$1\n");
    expect(wrapped).toContain("\n");
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({ content_base64: wrapped }),
      client,
      config,
      context
    );

    expect(result.isError).toBeUndefined();
    const [, sent] = postBinary.mock.calls[0]! as unknown as [string, Buffer];
    expect(Buffer.compare(sent, bytes)).toBe(0);
  });

  it("accepts base64 whose trailing padding was stripped", async () => {
    const bytes = Buffer.from("padding-sensitive-payload");
    const unpadded = bytes.toString("base64").replace(/=+$/u, "");
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({ content_base64: unpadded }),
      client,
      config,
      context
    );

    expect(result.isError).toBeUndefined();
    const [, sent] = postBinary.mock.calls[0]! as unknown as [string, Buffer];
    expect(Buffer.compare(sent, bytes)).toBe(0);
  });

  it("rejects out-of-alphabet base64 instead of uploading truncated bytes", async () => {
    // Buffer.from ignores these characters, so an unvalidated decode would
    // silently upload a corrupted, shorter file.
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({ content_base64: "aGVsbG8*d29ybGQ$" }),
      client,
      config,
      context
    );

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("not valid base64");
    expect(postBinary).not.toHaveBeenCalled();
  });

  it("rejects base64 whose length cannot describe whole bytes", async () => {
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({ content_base64: "QUJDR" }),
      client,
      config,
      context
    );

    expect(result.isError).toBe(true);
    expect(postBinary).not.toHaveBeenCalled();
  });

  it("rejects an empty payload rather than creating a zero-byte attachment", async () => {
    const { postBinary, client } = uploadClient();

    for (const content of ["", "   \n  ", "=="]) {
      const result = await handler(
        upload({ content_base64: content }),
        client,
        config,
        context
      );
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("at least one byte");
    }
    expect(postBinary).not.toHaveBeenCalled();
  });

  it("rejects decoded content above the attachment byte ceiling", async () => {
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 3, 0x42).toString(
      "base64"
    );
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({ content_base64: oversize }),
      client,
      config,
      context
    );

    expect(result.isError).toBe(true);
    // The message must name the offending parameter, both the actual and the
    // allowed size, and what the caller can actually do about it.
    const text = errorText(result);
    expect(text).toContain("content_base64");
    expect(text).toContain(String(MAX_ATTACHMENT_BYTES));
    expect(text).toContain("10 MiB");
    expect(text).toMatch(/split|smaller/iu);
    expect(postBinary).not.toHaveBeenCalled();
  });

  it("rejects oversize content without allocating the decode buffer", async () => {
    // The reported size must come from the encoded length, not from a decoded
    // Buffer: allocating first would concede the memory the bound denies.
    const encodedLength = Math.ceil((MAX_ATTACHMENT_BYTES + 3) / 3) * 4;
    const oversize = "A".repeat(encodedLength);
    const { postBinary, client } = uploadClient();
    const allocated: number[] = [];
    const realFrom = Buffer.from;
    const spy = vi
      .spyOn(Buffer, "from")
      .mockImplementation((...args: Parameters<typeof Buffer.from>) => {
        const buffer = (realFrom as (...a: unknown[]) => Buffer)(...args);
        allocated.push(buffer.length);
        return buffer;
      });

    try {
      const result = await handler(
        upload({ content_base64: oversize }),
        client,
        config,
        context
      );
      expect(result.isError).toBe(true);
      expect(postBinary).not.toHaveBeenCalled();
      expect(Math.max(0, ...allocated)).toBeLessThan(MAX_ATTACHMENT_BYTES);
    } finally {
      spy.mockRestore();
    }
  });

  it("caps content_base64 length in the schema before any decode runs", () => {
    const parsed = schema.safeParse(
      upload({ content_base64: "A".repeat(MAX_ATTACHMENT_BASE64_LENGTH + 1) })
    );
    expect(parsed.success).toBe(false);
    // The cap admits a full-size attachment plus its line breaks.
    expect(MAX_ATTACHMENT_BASE64_LENGTH).toBeGreaterThan(
      Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
    );
  });

  it("reports oversize content as a caller-correctable tool error, not a throw", async () => {
    const { client } = uploadClient();

    // A thrown TypeError would be sanitized to the opaque internal category
    // and told the caller not to retry; these are correctable inputs.
    await expect(
      handler(
        upload({ content_base64: "not base64 at all!!" }),
        client,
        config,
        context
      )
    ).resolves.toMatchObject({ isError: true });
  });
});

describe("sn_attach upload input hardening", () => {
  it.each([
    ["../../etc/passwd", "parent traversal"],
    ["dir/evidence.txt", "posix separator"],
    ["dir\\evidence.txt", "windows separator"],
    ["evidence\u0000.txt", "null byte"],
    ["..", "parent directory"],
    ["...", "dots only"],
    ["invoice\u202Egnp.exe", "bidi override"],
  ])("rejects file_name %j (%s)", async (fileName) => {
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({
        file_name: fileName,
        content_base64: Buffer.from("test").toString("base64"),
      }),
      client,
      config,
      context
    );

    expect(result.isError).toBe(true);
    expect(postBinary).not.toHaveBeenCalled();
  });

  it("rejects a content_type carrying header-injection bytes", async () => {
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({
        content_base64: Buffer.from("test").toString("base64"),
        content_type: "text/plain\r\nX-Injected: yes",
      }),
      client,
      config,
      context
    );

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("content_type");
    expect(postBinary).not.toHaveBeenCalled();
  });

  it("accepts a parameterized content_type unchanged", async () => {
    const { postBinary, client } = uploadClient();

    const result = await handler(
      upload({
        content_base64: Buffer.from("test").toString("base64"),
        content_type: "text/plain; charset=utf-8",
      }),
      client,
      config,
      context
    );

    expect(result.isError).toBeUndefined();
    expect(postBinary).toHaveBeenCalledWith(
      "/api/now/attachment/file",
      Buffer.from("test"),
      "text/plain; charset=utf-8",
      {
        table_name: "incident",
        table_sys_id: RECORD_ID,
        file_name: "evidence.txt",
      }
    );
  });

  it("defaults content_type to application/octet-stream", async () => {
    const { postBinary, client } = uploadClient();

    await handler(
      upload({ content_base64: Buffer.from("test").toString("base64") }),
      client,
      config,
      context
    );

    expect(postBinary.mock.calls[0]![2]).toBe("application/octet-stream");
  });

  it("requires every upload field before contacting ServiceNow", async () => {
    const { postBinary, client } = uploadClient();
    const encoded = Buffer.from("test").toString("base64");

    for (const missing of [
      { table: undefined, content_base64: encoded },
      { sys_id: undefined, content_base64: encoded },
      { file_name: undefined, content_base64: encoded },
      { content_base64: undefined },
    ]) {
      const result = await handler(upload(missing), client, config, context);
      expect(result.isError).toBe(true);
    }
    expect(postBinary).not.toHaveBeenCalled();
  });
});

describe("sn_attach inline base64 download", () => {
  it("returns bytes inline without touching the filesystem", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const get = vi.fn(async () => ({
      result: {
        table_name: "incident",
        table_sys_id: RECORD_ID,
        file_name: "diagram.png",
        content_type: "image/png",
      },
    }));
    const getRaw = vi.fn(async () => ({
      data: bytes,
      contentType: "image/png",
    }));
    const client = { get, getRaw } as unknown as ServiceNowClient;

    const result = await handler(
      {
        action: "download",
        table: "incident",
        sys_id: RECORD_ID,
        attachment_sys_id: ATTACHMENT_ID,
      } as Parameters<typeof handler>[0],
      client,
      config,
      context
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    const payload = body.content_base64 ?? body.result?.content_base64;
    expect(Buffer.from(payload, "base64").equals(bytes)).toBe(true);
  });

  it("bounds the upstream read at the attachment ceiling", async () => {
    const get = vi.fn(async () => ({
      result: { table_name: "incident", table_sys_id: RECORD_ID },
    }));
    const getRaw = vi.fn(async () => ({
      data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
      contentType: "application/octet-stream",
    }));
    const client = { get, getRaw } as unknown as ServiceNowClient;

    const result = await handler(
      {
        action: "download",
        table: "incident",
        sys_id: RECORD_ID,
        attachment_sys_id: ATTACHMENT_ID,
      } as Parameters<typeof handler>[0],
      client,
      config,
      context
    );

    expect(getRaw).toHaveBeenCalledWith(expect.any(String), {
      maxBytes: MAX_ATTACHMENT_BYTES,
    });
    expect(result.isError).toBe(true);
  });
});
