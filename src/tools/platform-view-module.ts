/**
 * `sn_platform_view`: read-only platform views behind one `view` argument:
 * update sets and their changes and batches, remote sets with preview
 * problems, skipped upgrade files, instance scan findings, and the update set
 * evaluator.
 *
 * This module is the dispatcher. It reads nothing itself. It declares each
 * view's table closure (`PLATFORM_VIEW_TABLES`), turns the arguments into their
 * canonical form (defaults applied, text escaped for encoded queries, sys_ids
 * lowercase, a selector the view does not take refused), and hands them to the
 * view's handler. Handlers are not held to their plan at run time, so
 * `test/platform-view-skeleton.test.ts` runs the dispatcher against a recording
 * client and asserts that every table it reads is in the call's plan.
 *
 * Registered in `catalog.ts`; its output schema and byte limit are its
 * result-envelope entries, and `platformViewTextRenderer` is its text.
 *
 * @module tools/platform-view-module
 */

import type { TableAccessRequest } from "../table-policy.js";
import { createToolError } from "../tool-error.js";
import {
  PLATFORM_VIEWS,
  PLATFORM_VIEW_ALL_TABLES,
  PLATFORM_VIEW_DESCRIPTION,
  PlatformViewArgumentError,
  canonicalPlatformViewArgs,
  platformViewInputSchema,
  platformViewReadTables,
  type CanonicalPlatformViewArgs,
  type PlatformView,
  type PlatformViewHandler,
} from "./platform-view-contracts.js";
import { envelopeTextFits } from "./envelope-text-fit.js";
import { handleEvaluate, renderEvaluateText } from "./platform-view-evaluate.js";
import { handleScanFindings, renderScanFindingsText } from "./platform-view-scan.js";
import { handleUpdateSetViews, renderUpdateSetViewText } from "./platform-view-update-sets.js";
import { handleUpgradeSkipped, renderUpgradeSkippedText } from "./platform-view-upgrades.js";
import { productionToolOutputSchemas, type EnvelopeTextRenderer } from "./result-envelope.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  type ServiceNowToolHandlerServices,
} from "./tool-module.js";

const schema = withRequiredProfile(platformViewInputSchema);

/**
 * One text renderer per group of views; each returns undefined for a view
 * that is not its own. Every one fences instance text in an `untrustedBlock`.
 */
const VIEW_RENDERERS: Readonly<Record<PlatformView, (data: unknown) => string | undefined>> = Object.freeze({
  update_sets: renderUpdateSetViewText,
  update_set: renderUpdateSetViewText,
  changes: renderUpdateSetViewText,
  batch: renderUpdateSetViewText,
  remote_update_sets: renderUpdateSetViewText,
  upgrade_skipped: renderUpgradeSkippedText,
  scan_findings: renderScanFindingsText,
  evaluate: renderEvaluateText,
});

/** One handler per view. Implementing a view replaces its entry. */
const VIEW_HANDLERS: Readonly<Record<PlatformView, PlatformViewHandler>> = Object.freeze({
  update_sets: handleUpdateSetViews,
  update_set: handleUpdateSetViews,
  changes: handleUpdateSetViews,
  batch: handleUpdateSetViews,
  remote_update_sets: handleUpdateSetViews,
  upgrade_skipped: handleUpgradeSkipped,
  scan_findings: handleScanFindings,
  evaluate: handleEvaluate,
});

function read(table: string): TableAccessRequest {
  return Object.freeze({ operation: "read" as const, table });
}

/**
 * Build the module around a handler per view. The shipped module uses
 * `VIEW_HANDLERS`; a test passes its own to hold a handler to its plan.
 */
export function createPlatformViewToolModule(
  handlers: Readonly<Record<PlatformView, PlatformViewHandler>> = VIEW_HANDLERS
) {
  for (const view of PLATFORM_VIEWS) {
    if (typeof handlers[view] !== "function") throw new TypeError(`sn_platform_view: no handler for ${view}`);
  }
  const handle = async (args: Record<string, unknown>, services: ServiceNowToolHandlerServices) => {
    let canonical: CanonicalPlatformViewArgs;
    try {
      canonical = canonicalPlatformViewArgs(args);
    } catch (error) {
      // A selector the view does not take, a value that is empty once escaped,
      // or a state the view does not have: the caller can correct it.
      if (error instanceof PlatformViewArgumentError) throw createToolError("conflict", "retry_after_correction");
      throw error;
    }
    return handlers[canonical.view](canonical, services);
  };
  return defineServiceNowToolModule({
    runtime: "servicenow",
    definition: {
      name: "sn_platform_view",
      description: PLATFORM_VIEW_DESCRIPTION,
      annotations: {
        title: "View platform data",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    inputSchema: schema,
    outputSchema: productionToolOutputSchemas.sn_platform_view,
    requirements: {
      permissions: ["read"],
      tables: { kind: "static", names: PLATFORM_VIEW_ALL_TABLES },
      apis: ["aggregate", "table"],
      fieldPolicies: ["read"],
      capabilities: ["platform:view"],
    },
    // The plan depends on `view` and two booleans, all checked by the input
    // schema, so there is nothing to canonicalize before the table check.
    resolveAccess: (candidate) => {
      const input = schema.parse(candidate);
      return Object.freeze({
        args: Object.freeze({ ...input }) as Record<string, unknown>,
        requests: Object.freeze(platformViewReadTables(input.view, input).map(read)),
      });
    },
    handler: handle,
  });
}

export const platformViewToolModule = createPlatformViewToolModule();

/** Said in place of a payload the text leaves out; fixed text, not instance data. */
export const PAYLOAD_LEFT_OUT_HINT =
  "it is in the structured result (summary.payload.text) and is not repeated here, to fit max_response_bytes.";

/** The result's data with a shown payload replaced by a note, or undefined when no payload is shown. */
function withoutPayloadText(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  const summary = (data as { summary?: unknown }).summary;
  if (typeof summary !== "object" || summary === null) return undefined;
  const payload = (summary as { payload?: { status?: unknown } }).payload;
  if (payload?.status !== "shown") return undefined;
  return { ...data, summary: { ...summary, payload: { status: "left out", hint: PAYLOAD_LEFT_OUT_HINT } } };
}

/**
 * The text of a result, by its view. It is kept only when it fits beside the
 * structured result within `max_response_bytes`; a shown payload is left out
 * of the text when that alone makes it fit. Otherwise, or for data that is no
 * view's, the text is the dispatcher's one-line summary.
 */
export const platformViewTextRenderer: EnvelopeTextRenderer = (envelope, context) => {
  const view = (envelope.data as { view?: unknown } | null)?.view;
  if (typeof view !== "string" || !(PLATFORM_VIEWS as readonly string[]).includes(view)) return context.summary;
  const render = VIEW_RENDERERS[view as PlatformView];
  const full = render(envelope.data);
  if (full === undefined) return context.summary;
  const fits = envelopeTextFits(envelope);
  if (fits(full)) return full;
  const shorter = withoutPayloadText(envelope.data);
  const text = shorter === undefined ? undefined : render(shorter);
  return text !== undefined && fits(text) ? text : context.summary;
};
