/** Identity-bound, bounded ATF summaries. No raw step output is persisted. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ServiceNowConfig } from "./config.js";
import { credentialFingerprint } from "./profile-manager.js";
import { serviceNowSysIdSchema } from "./servicenow-identifiers.js";

const status = z.enum(["pending", "running", "success", "failure", "error", "skipped", "canceled", "success_with_warnings"]);
const count = z.number().int().nonnegative();
export const atfRunSummarySchema = z.object({
  runId: serviceNowSysIdSchema,
  suiteId: serviceNowSysIdSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  status,
  durationMs: count,
  counts: z.object({ passed: count, failed: count, errors: count, skipped: count }).strict(),
  tests: z.array(z.object({
    testId: serviceNowSysIdSchema,
    status,
    firstFailure: z.string().max(500).optional(),
  }).strict()).max(1000),
}).strict();
export type AtfRunSummary = z.infer<typeof atfRunSummarySchema>;
const suiteSchema = z.object({ suiteId: serviceNowSysIdSchema, runs: z.array(atfRunSummarySchema).max(100) }).strict();
const fileSchema = z.object({ version: z.literal(1), identity: z.string(), suites: z.array(suiteSchema).max(200) }).strict();
type CacheFile = z.infer<typeof fileSchema>;
export const MAX_ATF_CACHE_BYTES = 16 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class AtfResultCache {
  readonly filePath: string;
  private readonly directory: string;
  private readonly identity: string;
  private readonly size: number;
  private memory: CacheFile;
  private disk = true;
  private readonly warnings = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    profile: string;
    policyScope?: string;
    config: ServiceNowConfig;
    warn?: (message: string) => void;
  }) {
    this.directory = options.config.atf?.resultCacheDir ?? join(homedir(), ".servicenow-mcp", "atf-results");
    // Hash the selector so even a profile called ../x cannot escape the directory.
    const selector = createHash("sha256").update(options.profile).digest("hex");
    this.filePath = join(this.directory, `${selector}.json`);
    this.identity = createHash("sha256").update(JSON.stringify([
      new URL(options.config.instance).origin, credentialFingerprint(options.config), options.policyScope ?? "",
    ])).digest("hex");
    this.size = z.number().int().min(1).max(100).parse(options.config.atf?.resultCacheSize ?? 10);
    this.memory = this.empty();
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  }
  private readonly warn: (message: string) => void;
  private empty(): CacheFile { return { version: 1, identity: this.identity, suites: [] }; }
  private warning(key: string, message: string): void {
    if (!this.warnings.has(key)) { this.warnings.add(key); this.warn(message); }
  }

  async put(candidate: AtfRunSummary): Promise<void> {
    // Project the failure length before strict validation; other unknown fields are rejected.
    const run = atfRunSummarySchema.parse({ ...candidate, tests: candidate.tests.map(test => ({
      ...test, ...(test.firstFailure === undefined ? {} : { firstFailure: test.firstFailure.slice(0, 500) }),
    })) });
    await this.transaction(file => {
      const previous = file.suites.find(suite => suite.suiteId === run.suiteId);
      const runs = [...(previous?.runs ?? []).filter(entry => entry.runId !== run.runId), run]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId)).slice(0, this.size);
      file.suites = [...file.suites.filter(suite => suite.suiteId !== run.suiteId), { suiteId: run.suiteId, runs }].slice(-200);
    });
  }

  async history(suiteId: string): Promise<AtfRunSummary[]> {
    const id = serviceNowSysIdSchema.parse(suiteId);
    let results: AtfRunSummary[] = [];
    await this.transaction(file => {
      const suite = file.suites.find(entry => entry.suiteId === id);
      if (suite) {
        results = structuredClone(suite.runs.slice(0, this.size));
        file.suites = [...file.suites.filter(entry => entry !== suite), suite];
      }
    });
    return results;
  }

  async testHistory(testId: string): Promise<AtfRunSummary[]> {
    const id = serviceNowSysIdSchema.parse(testId);
    let results: AtfRunSummary[] = [];
    await this.transaction(file => {
      results = structuredClone(file.suites.flatMap(suite => suite.runs)
        .filter(run => run.tests.some(test => test.testId === id))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    });
    return results;
  }

  private async transaction(update: (file: CacheFile) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      let release: (() => Promise<void>) | undefined;
      let applied = false;
      try {
        if (this.disk) {
          await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
          const stat = await fs.lstat(this.directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe cache directory");
          if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
            throw new Error("cache directory must be owner-only");
          }
          release = await this.lock();
          this.memory = await this.read();
        }
        update(this.memory);
        applied = true;
        // Enforce the byte bound even in the fallback store, evicting least-recently-used suites.
        this.boundMemory();
        if (this.disk) await this.write();
      } catch {
        this.disk = false;
        this.warning("disk", "ATF result cache unavailable; using memory until restart.");
        if (!applied) update(this.memory);
        this.boundMemory();
      } finally {
        if (release) await release().catch(() => {
          this.disk = false;
          this.warning("disk", "ATF result cache unavailable; using memory until restart.");
        });
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  private boundMemory(): void {
    for (const suite of this.memory.suites) suite.runs = suite.runs.slice(0, this.size);
    this.memory.suites = this.memory.suites.slice(-200);
    while (Buffer.byteLength(JSON.stringify(this.memory)) > MAX_ATF_CACHE_BYTES && this.memory.suites.length) this.memory.suites.shift();
  }

  private async lock(): Promise<() => Promise<void>> {
    const path = `${this.filePath}.lock`;
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        const handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
        return async () => { await handle.close(); await fs.unlink(path); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
        await delay(10);
      }
    }
  }

  private async read(): Promise<CacheFile> {
    let handle;
    try { handle = await fs.open(this.filePath, constants.O_RDONLY | NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty(); throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe cache file");
      if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error("cache file must be owner-only");
      if (stat.size > MAX_ATF_CACHE_BYTES) {
        this.warning("corrupt", "ATF result cache is corrupt or oversized; starting empty.");
        return this.empty();
      }
      const parsed = fileSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
      if (!parsed.success) throw new SyntaxError("invalid cache");
      if (parsed.data.identity !== this.identity) return this.empty();
      if (parsed.data.suites.some(suite => suite.runs.some(run => run.suiteId !== suite.suiteId))) throw new SyntaxError("invalid suite");
      for (const suite of parsed.data.suites) suite.runs = suite.runs.slice(0, this.size);
      return parsed.data;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.warning("corrupt", "ATF result cache is corrupt or oversized; starting empty.");
      return this.empty();
    } finally { await handle.close(); }
  }

  private async write(): Promise<void> {
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.memory));
      await handle.sync();
      await handle.close();
      await fs.rename(temp, this.filePath);
      if (process.platform !== "win32") {
        const directory = await fs.open(this.directory, constants.O_RDONLY | NOFOLLOW | (constants.O_DIRECTORY ?? 0));
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await handle.close();
      await fs.unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  }
}

/** The coordinator supplies a narrow cache port; no credentials cross into handlers. */
export type AtfResultStore = Pick<AtfResultCache, "put" | "history" | "testHistory">;
const STORES = new Map<string, AtfResultCache>();
export function atfResultStore(profile: string, config: ServiceNowConfig, policyScope: string): AtfResultStore {
  const key = createHash("sha256").update(JSON.stringify([profile, credentialFingerprint(config), config.atf, policyScope])).digest("hex");
  let cache = STORES.get(key);
  if (!cache) {
    cache = new AtfResultCache({ profile, config, policyScope });
    if (STORES.size >= 32) STORES.delete(STORES.keys().next().value!);
    STORES.set(key, cache);
  }
  return Object.freeze({ put: cache.put.bind(cache), history: cache.history.bind(cache), testHistory: cache.testHistory.bind(cache) });
}
