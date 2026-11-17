/**
 * Whether a tool's readable text fits beside its structured result.
 *
 * The dispatcher keeps a renderer's text only when the whole result, text and
 * structured content together, fits the result's byte limit; otherwise it
 * falls back to its one-line summary. A renderer whose full text may not fit
 * uses this to try a shorter text first, so a large page still gets readable
 * text instead of the bare summary.
 *
 * @module tools/envelope-text-fit
 */

import { DEFAULT_RESULT_BYTE_LIMIT, type RenderableEnvelope } from "./result-envelope.js";

/** Bytes kept back for what the dispatcher adds around the text and the envelope. */
export const TEXT_FIT_MARGIN_BYTES = 512;

function maxBytes(envelope: RenderableEnvelope): number {
  const limit = (envelope.metadata as { limits?: { max_bytes?: unknown } } | undefined)?.limits?.max_bytes;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_RESULT_BYTE_LIMIT;
}

/**
 * A test of whether `text` fits beside `envelope` within its byte limit. The
 * envelope is measured once: the text is the only part that varies.
 */
export function envelopeTextFits(envelope: RenderableEnvelope): (text: string) => boolean {
  const budget = maxBytes(envelope) - TEXT_FIT_MARGIN_BYTES;
  // The empty string serializes as `""`, two bytes, in the text's position.
  const fixed =
    Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: "" }], structuredContent: envelope }), "utf8") - 2;
  return (text) => fixed + Buffer.byteLength(JSON.stringify(text), "utf8") <= budget;
}
