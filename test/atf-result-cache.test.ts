import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtfResultCache, MAX_ATF_CACHE_BYTES, type AtfRunSummary } from "../src/atf-result-cache.js";
import type { ServiceNowConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const id = (n: number) => n.toString(16).padStart(32, "0");
const run = (n: number, suite = 1): AtfRunSummary => ({ runId: id(n), suiteId: id(suite), startedAt: new Date(n * 1000).toISOString(), status: "failure", durationMs: 1000, counts: { passed: 0, failed: 1, errors: 0, skipped: 0 }, tests: [{ testId: id(999), status: "failure", firstFailure: "failure" }] });
async function fixture(size = 10) {
  const root = await mkdtemp(join(tmpdir(), "atf-cache-")); roots.push(root);
  const config: ServiceNowConfig = { instance: "https://example.service-now.com", user: "test", password: "test-secret", displayValue: "true", relDepth: 3, atf: { execute: false, allowScriptSteps: false, resultCacheSize: size, resultCacheDir: join(root, "cache") } };
  const warn = vi.fn();
  const create = (override: Partial<ServiceNowConfig> = {}, profile = "test") => new AtfResultCache({ profile, config: { ...config, ...override }, warn });
  return { root, config, warn, create };
}
describe("ATF result cache", () => {
  it("retains newest N per suite, deduplicates runs and survives restart", async () => {
    const { create } = await fixture(2); const cache = create();
    await cache.put(run(3)); await cache.put(run(1)); await cache.put(run(2)); await cache.put({ ...run(3), status: "success" });
    expect((await create().history(id(1))).map(r => [r.runId, r.status])).toEqual([[id(3), "success"], [id(2), "failure"]]);
    expect(await cache.testHistory(id(999))).toHaveLength(2);
    expect(await cache.history(id(2))).toEqual([]);
  });
  it("bounds failure text and excludes raw output and secrets", async () => {
    const { create } = await fixture(); const cache = create(); const value = run(1);
    value.tests[0]!.firstFailure = "x".repeat(900);
    await cache.put(value);
    expect((await cache.history(id(1)))[0]!.tests[0]!.firstFailure).toHaveLength(500);
    await expect(cache.put({ ...value, output: "raw" } as AtfRunSummary)).rejects.toThrow();
    expect(await readFile(cache.filePath, "utf8")).not.toContain("test-secret");
  });
  it("isolates profiles, instance origins and credentials", async () => {
    const { create } = await fixture(); await create().put(run(1));
    expect(await create({}, "other").history(id(1))).toEqual([]);
    expect(await create({ password: "changed" }).history(id(1))).toEqual([]);
    await create().put(run(1));
    expect(await create({ instance: "https://other.service-now.com" }).history(id(1))).toEqual([]);
  });
  it("serializes independent writers without losing runs", async () => {
    const { create } = await fixture(100);
    await Promise.all(Array.from({ length: 20 }, (_, n) => create().put(run(n + 1))));
    expect(await create().history(id(1))).toHaveLength(20);
  });
  it("evicts the least recently accessed suite at 200", async () => {
    const { create } = await fixture(); const cache = create();
    for (let n = 1; n <= 200; n++) await cache.put(run(n, n));
    await cache.history(id(1)); await cache.put(run(201, 201));
    expect(await cache.history(id(2))).toEqual([]);
    expect(await cache.history(id(1))).toHaveLength(1);
  });
  it("uses private file and directory permissions", async () => {
    const { create, config } = await fixture(); const cache = create(); await cache.put(run(1));
    if (process.platform !== "win32") {
      expect((await stat(cache.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(config.atf!.resultCacheDir!)).mode & 0o777).toBe(0o700);
    }
  });
  it("discards corrupt and oversized files, warning only once", async () => {
    const { create, warn } = await fixture(); const cache = create(); await cache.put(run(1));
    await writeFile(cache.filePath, "bad json"); expect(await cache.history(id(1))).toEqual([]);
    await writeFile(cache.filePath, " ".repeat(MAX_ATF_CACHE_BYTES + 1)); expect(await cache.history(id(1))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("falls back to bounded memory when the directory cannot be used", async () => {
    const { create, config, warn } = await fixture(1);
    await writeFile(config.atf!.resultCacheDir!, "not a directory");
    const cache = create(); await cache.put(run(1)); await cache.put(run(2));
    expect((await cache.history(id(1))).map(r => r.runId)).toEqual([id(2)]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("does not follow a cache-file symlink or allow a profile path escape", async () => {
    const { root, config, create, warn } = await fixture();
    await mkdir(config.atf!.resultCacheDir!); const victim = join(root, "victim"); await writeFile(victim, "keep");
    const cache = create({}, "../../victim"); await symlink(victim, cache.filePath);
    await cache.put(run(1)); expect(await readFile(victim, "utf8")).toBe("keep"); expect(warn).toHaveBeenCalledTimes(1);
  });
});
