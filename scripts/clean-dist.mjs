#!/usr/bin/env node

/** Remove only this repository's generated dist directory before compilation. */
import { existsSync, lstatSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const distDirectory = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));

if (
  basename(distDirectory) !== "dist" ||
  dirname(distDirectory) !== repositoryRoot
) {
  throw new Error("Refusing to clean an unexpected build-output path");
}

if (existsSync(distDirectory)) {
  if (lstatSync(distDirectory).isSymbolicLink()) {
    throw new Error("Refusing to clean a symbolic-link build-output path");
  }
  rmSync(distDirectory, { recursive: true, force: true });
}
