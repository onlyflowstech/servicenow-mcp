#!/usr/bin/env node

/**
 * Make the compiled bin entrypoints executable.
 *
 * `prebuild` removes dist/ and tsc recreates the files at the default 0644, so
 * every build leaves the three bin targets non-executable. A globally linked or
 * installed CLI then fails with "permission denied" even though the shebang and
 * the symlink are both correct. npm chmods bin targets when it installs a
 * published tarball, but not after a local rebuild behind an existing link,
 * which is the documented development path.
 *
 * Modes are derived from package.json#bin so a new entrypoint cannot be missed.
 */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const manifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8")
);

const targets = Object.values(manifest.bin ?? {});
if (targets.length === 0) {
  console.error("[set-bin-mode] package.json declares no bin entries");
  process.exit(1);
}

const missing = [];
for (const target of targets) {
  const absolute = resolve(repositoryRoot, target);
  if (!absolute.startsWith(resolve(repositoryRoot, "dist"))) {
    console.error(`[set-bin-mode] refusing to chmod outside dist/: ${target}`);
    process.exit(1);
  }
  if (!existsSync(absolute)) {
    missing.push(target);
    continue;
  }
  chmodSync(absolute, 0o755);
}

if (missing.length > 0) {
  console.error(`[set-bin-mode] declared bin missing from dist: ${missing.join(", ")}`);
  process.exit(1);
}
