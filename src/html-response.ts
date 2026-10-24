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
 * Hibernation marker provenance: ServiceNow Community reports of the page
 * quote "Your instance is hibernating" and "Instance is Hibernating, please
 * use the 'wake up' action in the action menu to wake it up" (community
 * threads td-p/3452667 and td-p/2849600). No captured page source is
 * available, so the match is deliberately conservative: an HTML body whose
 * inspected prefix contains the text "hibernat" (case-insensitive). The exact
 * markup is unverified.
 *
 * @module html-response
 */

import {
  createHtmlResponseError,
  createInstanceHibernatingError,
} from "./tool-error.js";

/** Upper bound on body bytes inspected for markers. */
export const HTML_SNIFF_BYTES = 16 * 1024;

const HIBERNATION_MARKER = /hibernat/iu;
const HTML_START = /^﻿?\s*</u;

/** True when the content type or the body prefix says the response is HTML. */
export function isHtmlResponse(contentType: string | null, prefix: string): boolean {
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
  return HIBERNATION_MARKER.test(prefix)
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
