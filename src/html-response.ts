/**
 * Detection of HTML pages returned where a ServiceNow API response was due.
 *
 * A hibernating developer instance (PDI) answers every request, including
 * `/oauth_token.do` and `/api/now/...`, with an HTML "Instance Hibernating"
 * page and HTTP 200. SSO redirects, maintenance pages and proxy error pages
 * look the same. Only a bounded prefix of the body is inspected, and nothing
 * from it is ever copied into an error, log or audit record: the result is
 * one of two fixed trusted errors.
 *
 * Hibernation marker provenance: a live capture of GET /oauth_token.do while a
 * PDI hibernated (Oct 2026) showed HTTP 200, `Content-Type: text/html`, no
 * Location header, and `<title> Instance Hibernating page </title>` within
 * the first 300 characters. The match is therefore anchored to that title,
 * inside the first 2 KB. Any other HTML page, including one that merely
 * mentions hibernation, gets the generic HTML error, so an SSO or proxy page
 * is never reported as a sleeping instance.
 *
 * @module html-response
 */

import {
  createHtmlResponseError,
  createInstanceHibernatingError,
} from "./tool-error.js";

/** Upper bound on body characters (not bytes) inspected for markers. */
export const HTML_SNIFF_BYTES = 16 * 1024;

const HIBERNATION_MARKER = /<title>\s*Instance Hibernating\b/iu;
/** The title sits at the top of the page; only this much is searched for it. */
const HIBERNATION_TITLE_WINDOW = 2048;
const JSON_START = /^\uFEFF?\s*[{[]/u;
const HTML_START = /^﻿?\s*</u;

/** True when the content type or the body prefix says the response is HTML. */
export function isHtmlResponse(contentType: string | null, prefix: string): boolean {
  // A JSON document is never HTML, whatever its content type claims.
  if (JSON_START.test(prefix)) return false;
  if (
    contentType !== null &&
    /^\s*(?:text\/html|application\/xhtml\+xml)\b/iu.test(contentType)
  ) {
    return true;
  }
  // A JSON body never starts with "<".
  return HTML_START.test(prefix) && !/^﻿?\s*<\?xml/iu.test(prefix);
}

/**
 * Map an HTML prefix to the fixed trusted error, or undefined when the
 * response is not HTML. `host` must come from the profile configuration.
 */
export function htmlResponseError(
  contentType: string | null,
  prefix: string,
  host: string | undefined
): Error | undefined {
  if (!isHtmlResponse(contentType, prefix)) return undefined;
  return HIBERNATION_MARKER.test(prefix.slice(0, HIBERNATION_TITLE_WINDOW))
    ? createInstanceHibernatingError(host)
    : createHtmlResponseError();
}

/** Host (with port, if any) of a configured instance URL; never from a response. */
export function configuredHost(instance: string): string | undefined {
  try {
    return new URL(instance).host;
  } catch {
    return undefined;
  }
}

/** The inspected prefix of an already-read body text. */
export function sniffPrefix(text: string): string {
  return text.length > HTML_SNIFF_BYTES ? text.slice(0, HTML_SNIFF_BYTES) : text;
}
