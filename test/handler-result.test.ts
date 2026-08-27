import { describe, expect, it, vi } from "vitest";

import { ATTACHMENT_RESULT_BYTE_LIMIT } from "../src/tools/result-envelope.js";
import { guardedHandlerResult } from "../src/tools/handler-result.js";

describe("guarded handler result", () => {
  it("snapshots a plain successful result without retaining aliases", () => {
    const structuredContent = { count: 1, nested: ["safe"] };
    const source = {
      content: [{ type: "text", text: "safe" }],
      structuredContent,
    };
    const guarded = guardedHandlerResult(source);

    expect(guarded).toMatchObject({ kind: "success" });
    if (guarded.kind !== "success") throw new Error("expected success");
    expect(guarded.result).toEqual(source);
    expect(guarded.result).not.toBe(source);
    expect(guarded.result.structuredContent).not.toBe(structuredContent);
  });

  it("classifies a well-formed error without retaining its text", () => {
    const canary = "RAW_HANDLER_ERROR_SECRET";
    const guarded = guardedHandlerResult({
      content: [{ type: "text", text: canary }],
      structuredContent: { query: canary },
      isError: true,
    });

    expect(guarded).toEqual({ kind: "error" });
    expect(JSON.stringify(guarded)).not.toContain(canary);
  });

  it.each([null, undefined, false, 1, "result", [], () => ({})])(
    "rejects malformed top-level value %s",
    (candidate) => {
      expect(() => guardedHandlerResult(candidate)).toThrow();
    }
  );

  it("rejects Proxies without invoking traps", () => {
    const get = vi.fn(() => {
      throw new Error("RAW_PROXY_SECRET");
    });
    const ownKeys = vi.fn(() => {
      throw new Error("RAW_KEYS_SECRET");
    });
    const candidate = new Proxy({}, { get, ownKeys });

    expect(() => guardedHandlerResult(candidate)).toThrow(
      "handler result contains unsupported data"
    );
    expect(get).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => {
      throw new Error("RAW_GETTER_SECRET");
    });
    const candidate = Object.defineProperty({}, "content", {
      enumerable: true,
      get: getter,
    });

    expect(() => guardedHandlerResult(candidate)).toThrow(
      "handler result must not contain accessors"
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects nested accessors, cycles, sparse arrays, and unsupported keys", () => {
    const nestedGetter = vi.fn(() => "RAW_NESTED_SECRET");
    const nested = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: nestedGetter,
    });
    expect(() =>
      guardedHandlerResult({
        content: [{ type: "text", text: "safe" }],
        structuredContent: nested,
      })
    ).toThrow("handler result.structuredContent must not contain accessors");
    expect(nestedGetter).not.toHaveBeenCalled();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      guardedHandlerResult({
        content: [{ type: "text", text: "safe" }],
        structuredContent: cyclic,
      })
    ).toThrow("handler result must not contain cycles");

    expect(() =>
      guardedHandlerResult({
        content: new Array(2),
        structuredContent: {},
      })
    ).toThrow("arrays must not be sparse");

    expect(() =>
      guardedHandlerResult({
        content: [{ type: "text", text: "safe" }],
        structuredContent: {},
        credential: "RAW_UNSUPPORTED_SECRET",
      })
    ).toThrow("unsupported properties");
  });

  it.each([
    {
      label: "top-level MCP metadata",
      candidate: {
        content: [{ type: "text", text: "safe" }],
        structuredContent: {},
        _meta: { credential: "RAW_META_SECRET" },
      },
      message: "unsupported properties",
    },
    {
      label: "extra content fields",
      candidate: {
        content: [
          { type: "text", text: "safe", credential: "RAW_CONTENT_SECRET" },
        ],
        structuredContent: {},
      },
      message: "one exact text block",
    },
    {
      label: "non-text content",
      candidate: {
        content: [
          { type: "image", data: "RAW_IMAGE_SECRET", mimeType: "image/png" },
        ],
        structuredContent: {},
      },
      message: "one exact text block",
    },
    {
      label: "multiple content blocks",
      candidate: {
        content: [
          { type: "text", text: "safe" },
          { type: "text", text: "RAW_SECOND_BLOCK_SECRET" },
        ],
        structuredContent: {},
      },
      message: "content count is invalid",
    },
    {
      label: "explicit false isError",
      candidate: {
        content: [{ type: "text", text: "safe" }],
        structuredContent: {},
        isError: false,
      },
      message: "must omit isError",
    },
  ])("rejects unsupported successful $label", ({ candidate, message }) => {
    expect(() => guardedHandlerResult(candidate)).toThrow(message);
  });

  it("rejects oversized output before JSON parsing or schema traversal", () => {
    expect(() =>
      guardedHandlerResult({
        content: [
          {
            type: "text",
            text: "x".repeat(ATTACHMENT_RESULT_BYTE_LIMIT + 64 * 1024 + 1),
          },
        ],
        structuredContent: {},
      })
    ).toThrow("handler result string budget exceeded");
  });
});
