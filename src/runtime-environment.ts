/**
 * Environment reading shared by both transport compositions.
 *
 * Every accessor here treats an empty string as a configuration error rather
 * than as an absent value, so a half-applied env file fails at startup instead
 * of silently taking a default.
 *
 * @module runtime-environment
 */

/**
 * Identity used for audit attribution when the operator has not named one.
 *
 * These are labels, never credentials: they were always read from configuration
 * rather than proved by the caller, so defaulting them changes nothing about
 * who is admitted. They exist so every audit record has a stable, well-formed
 * `OwnerClientIdentity`.
 */
export const DEFAULT_OWNER_ID = "local-owner";
export const DEFAULT_CLIENT_ID = "local-client";

export function optionalEnvironmentVariable(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw new TypeError(`Environment variable ${name} must not be empty`);
  }
  return value;
}

export function optionalIntegerEnvironmentVariable(
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`Environment variable ${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(
      `Environment variable ${name} must be from ${minimum} through ${maximum}`
    );
  }
  return parsed;
}

export function optionalCommaSeparatedEnvironmentVariable(
  name: string
): readonly string[] | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new TypeError(
      `Environment variable ${name} must contain comma-separated exact values`
    );
  }
  return Object.freeze(entries);
}
