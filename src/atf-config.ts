/**
 * Per-profile Automated Test Framework (ATF) settings.
 *
 * Two kinds of setting live here, and they are resolved differently:
 *
 * - Grants (`execute`, `allowScriptSteps`) widen what a caller may make the
 *   instance do. Like `tableAccess`, they come only from the profile itself;
 *   the SN_ATF_* environment variables supply them solely to the explicitly
 *   named environment-only profile. A process-wide variable never grants ATF
 *   execution to every profile in config.json.
 * - Result-cache settings (`resultCacheSize`, `resultCacheDir`) are ordinary
 *   tuning. Like `metadataCache`, the profile value wins and the environment
 *   is the fallback for every profile.
 *
 * Every error message names the offending key and never echoes its value.
 *
 * @module atf-config
 */

import * as path from "path";

import { parseBooleanEnv, parsePositiveIntegerEnv } from "./config.js";

export const DEFAULT_ATF_RESULT_CACHE_SIZE = 10;
export const MAX_ATF_RESULT_CACHE_SIZE = 100;
const MAX_ATF_RESULT_CACHE_DIR_LENGTH = 1024;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const ATF_CONFIG_KEYS = Object.freeze([
  "execute",
  "resultCacheSize",
  "resultCacheDir",
  "allowScriptSteps",
] as const);

/** The `atf` block as written in a profile or read from the environment. */
export interface AtfConfigInput {
  /** Permit ATF execution tools to run suites (default false). */
  readonly execute?: boolean;
  /** Runs retained per suite in the local result cache (1-100, default 10). */
  readonly resultCacheSize?: number;
  /** Absolute directory for the local result cache (default chosen by the cache). */
  readonly resultCacheDir?: string;
  /** Permit authoring ATF steps that run server-side script (default false). */
  readonly allowScriptSteps?: boolean;
}

/** Fully resolved, frozen ATF settings for one profile. */
export interface AtfConfig {
  readonly execute: boolean;
  readonly allowScriptSteps: boolean;
  readonly resultCacheSize: number;
  readonly resultCacheDir?: string;
}

/**
 * The non-secret slice a tool handler receives. Execution grants are not here:
 * they are enforced before the handler runs, from the resolved policy.
 */
export interface AtfHandlerSettings {
  readonly resultCacheSize: number;
  readonly resultCacheDir?: string;
}

/** Operator-authored configuration error; the message is safe to display. */
export class AtfConfigurationError extends Error {
  public override readonly name = "AtfConfigurationError";
}

interface AtfEnvironment {
  readonly SN_ATF_EXECUTE?: string;
  readonly SN_ATF_RESULT_CACHE_SIZE?: string;
  readonly SN_ATF_RESULT_CACHE_DIR?: string;
  readonly SN_ATF_ALLOW_SCRIPT_STEPS?: string;
}

/** Read the SN_ATF_* variables, keeping only the keys that are set. */
export function atfConfigFromEnvironment(
  environment: AtfEnvironment = process.env as AtfEnvironment
): AtfConfigInput {
  const execute = parseBooleanEnv(environment.SN_ATF_EXECUTE, "SN_ATF_EXECUTE");
  const allowScriptSteps = parseBooleanEnv(
    environment.SN_ATF_ALLOW_SCRIPT_STEPS,
    "SN_ATF_ALLOW_SCRIPT_STEPS"
  );
  const resultCacheSize = parsePositiveIntegerEnv(
    environment.SN_ATF_RESULT_CACHE_SIZE,
    "SN_ATF_RESULT_CACHE_SIZE",
    { max: MAX_ATF_RESULT_CACHE_SIZE }
  );
  const rawDirectory = environment.SN_ATF_RESULT_CACHE_DIR;
  const resultCacheDir =
    rawDirectory === undefined || rawDirectory.trim() === ""
      ? undefined
      : validateResultCacheDir(rawDirectory, "SN_ATF_RESULT_CACHE_DIR");
  return Object.freeze({
    ...(execute === undefined ? {} : { execute }),
    ...(resultCacheSize === undefined ? {} : { resultCacheSize }),
    ...(resultCacheDir === undefined ? {} : { resultCacheDir }),
    ...(allowScriptSteps === undefined ? {} : { allowScriptSteps }),
  });
}

/**
 * Validate a profile's `atf` block and return a frozen copy holding only the
 * keys it states. Throws AtfConfigurationError on any unsupported shape.
 */
export function validateAtfConfigInput(candidate: unknown): AtfConfigInput {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new AtfConfigurationError("atf must be an object");
  }
  const source = candidate as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(ATF_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new AtfConfigurationError(
        `atf supports only ${ATF_CONFIG_KEYS.join(", ")}`
      );
    }
  }
  const { execute, resultCacheSize, resultCacheDir, allowScriptSteps } = source;
  if (execute !== undefined && typeof execute !== "boolean") {
    throw new AtfConfigurationError("atf.execute must be true or false");
  }
  if (allowScriptSteps !== undefined && typeof allowScriptSteps !== "boolean") {
    throw new AtfConfigurationError("atf.allowScriptSteps must be true or false");
  }
  if (
    resultCacheSize !== undefined &&
    (typeof resultCacheSize !== "number" ||
      !Number.isSafeInteger(resultCacheSize) ||
      resultCacheSize < 1 ||
      resultCacheSize > MAX_ATF_RESULT_CACHE_SIZE)
  ) {
    throw new AtfConfigurationError(
      `atf.resultCacheSize must be an integer between 1 and ${MAX_ATF_RESULT_CACHE_SIZE}`
    );
  }
  const directory =
    resultCacheDir === undefined
      ? undefined
      : validateResultCacheDir(resultCacheDir, "atf.resultCacheDir");
  return Object.freeze({
    ...(execute === undefined ? {} : { execute }),
    ...(resultCacheSize === undefined ? {} : { resultCacheSize }),
    ...(directory === undefined ? {} : { resultCacheDir: directory }),
    ...(allowScriptSteps === undefined ? {} : { allowScriptSteps }),
  });
}

/**
 * Merge a profile's `atf` block with the environment. Grants come from the
 * profile alone; cache settings fall back to the environment, then defaults.
 */
export function resolveAtfConfig(
  profile: AtfConfigInput | undefined,
  environment: AtfConfigInput
): AtfConfig {
  const resultCacheDir = profile?.resultCacheDir ?? environment.resultCacheDir;
  return Object.freeze({
    execute: profile?.execute === true,
    allowScriptSteps: profile?.allowScriptSteps === true,
    resultCacheSize:
      profile?.resultCacheSize ??
      environment.resultCacheSize ??
      DEFAULT_ATF_RESULT_CACHE_SIZE,
    ...(resultCacheDir === undefined ? {} : { resultCacheDir }),
  });
}

/** Project resolved settings onto what a handler may see. */
export function atfHandlerSettings(
  config: AtfConfig | undefined
): AtfHandlerSettings {
  return Object.freeze({
    resultCacheSize: config?.resultCacheSize ?? DEFAULT_ATF_RESULT_CACHE_SIZE,
    ...(config?.resultCacheDir === undefined
      ? {}
      : { resultCacheDir: config.resultCacheDir }),
  });
}

/**
 * Accept only an absolute, normalized directory. The cache opens it later
 * with its own no-symlink checks; this rejects values that are wrong on their
 * face so a typo fails when the profile loads, not on the first ATF run.
 */
function validateResultCacheDir(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AtfConfigurationError(`${label} must be a non-empty string`);
  }
  if (value.length > MAX_ATF_RESULT_CACHE_DIR_LENGTH) {
    throw new AtfConfigurationError(
      `${label} must not exceed ${MAX_ATF_RESULT_CACHE_DIR_LENGTH} characters`
    );
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new AtfConfigurationError(`${label} must not contain control characters`);
  }
  if (!path.isAbsolute(value)) {
    throw new AtfConfigurationError(`${label} must be an absolute path`);
  }
  if (value.split(/[\\/]/u).includes("..")) {
    throw new AtfConfigurationError(`${label} must not contain ".." segments`);
  }
  return value;
}
