/**
 * Single source of truth for the package version at runtime.
 *
 * Keep in sync with package.json "version" -- test/version.test.ts
 * asserts the two match, so a release bump cannot silently drift.
 *
 * @module version
 */

export const VERSION = "2.0.0";
