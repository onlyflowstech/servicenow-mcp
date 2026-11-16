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
 * The tool is not registered here: its `catalog.ts` entry and its
 * result-envelope entry are added when it is. This file exports the module,
 * and the contracts file exports `platformViewDataSchema`, for that.
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
  platformViewDataSchema,
  platformViewInputSchema,
  platformViewReadTables,
  type CanonicalPlatformViewArgs,
  type PlatformView,
  type PlatformViewHandler,
} from "./platform-view-contracts.js";
import { handleEvaluate } from "./platform-view-evaluate.js";
import { handleScanFindings } from "./platform-view-scan.js";
import { handleUpdateSetViews } from "./platform-view-update-sets.js";
import { handleUpgradeSkipped } from "./platform-view-upgrades.js";
import { withStructuredResultEnvelope } from "./result-envelope.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
  type ServiceNowToolHandlerServices,
} from "./tool-module.js";

const schema = withRequiredProfile(platformViewInputSchema);

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
    // The expression to register as
    // `productionToolOutputSchemas.sn_platform_view`.
    outputSchema: withStructuredResultEnvelope(platformViewDataSchema),
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
