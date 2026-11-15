/**
 * `sn_platform_view`, view `upgrade_skipped`: a stub. It returns a fixed tool error
 * until the view is implemented. The dispatcher
 * (`platform-view-module.ts`) and the schema (`platform-view-contracts.ts`)
 * need no change when it does.
 *
 * @module tools/platform-view-upgrades
 */

import { createToolError } from "../tool-error.js";
import type { PlatformViewHandler } from "./platform-view-contracts.js";

export const handleUpgradeSkipped: PlatformViewHandler = async () => {
  // Not implemented: the `internal` category is the fixed error the dispatcher
  // passes through, and no argument or instance text is part of it.
  throw createToolError("internal", "do_not_retry");
};
