/**
 * The update-set evaluator's engine: runs the 32 rules over rows the caller
 * has read, within a CPU budget, and reports what it covered.
 *
 * - CPU: the budget (250 ms) counts the time the engine itself runs, checked
 *   between rows; the time it spends yielding (every 50 rows, or after 20 ms
 *   of work) is not counted,
 *   because other requests run then. When the budget runs out, the rows left
 *   are `not_evaluated` and the result is `partial`. One row can overshoot by
 *   at most its own cost, which the per-payload byte cap bounds.
 * - Bytes: 256 KiB per payload (a larger one is not scanned) and 16 MiB per
 *   call (rows past it are not evaluated).
 * - Findings: at most 500 are returned, highest severity first; the summary
 *   counts all of them.
 * - Unread or unreadable payloads count as not scanned, never as clean.
 */

import { findingUpdate, isSysId, prepareRow, type PreparedRow } from "./prepare.js";
import {
  RULES_VERSION,
  ROW_RULES,
  SET_RULES,
  RULE_MESSAGES,
  duplicateNamesAcrossSets,
  ruleGroup,
  type RuleFinding,
  type RuleId,
  type RuleNotes,
} from "./rules.js";
import {
  RULE_GROUPS,
  SEVERITIES,
  type EngineLimits,
  type EvaluateContext,
  type EvaluateSet,
  type EvaluateUpdate,
  type PreviewProblem,
  type EvaluationInput,
  type EvaluationOptions,
  type EvaluationResult,
  type Finding,
  type RuleGroup,
  type Severity,
} from "./types.js";
import { XML_READER_MAX_BYTES } from "./xml-reader.js";

export const ENGINE_LIMITS: EngineLimits = Object.freeze({
  cpuBudgetMs: 250,
  yieldEvery: 50,
  maxFindings: 500,
  maxPayloadBytes: 262_144,
  maxTotalBytes: 16 * 1024 * 1024,
});

/** Work, in ms, after which the engine yields even before `yieldEvery` rows. */
export const YIELD_AFTER_MS = 20;

export interface EngineHooks {
  /** Milliseconds, monotonic. Tests pass a fake clock. */
  readonly now?: () => number;
  /** Lets other work run; default `setImmediate`. */
  readonly yieldToLoop?: () => Promise<void>;
}

const SEVERITY_RANK: ReadonlyMap<string, number> = new Map(SEVERITIES.map((s, i) => [s, i]));

/** Rules whose findings never say where in the payload they are. */
const NO_LOCATION: ReadonlySet<RuleId> = new Set(["SEC005", "SEC010"]);

const SET_NAME_MAX = 200;

function checkLimits(limits: EngineLimits): void {
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  if (
    !positive(limits.cpuBudgetMs) ||
    !Number.isInteger(limits.yieldEvery) || limits.yieldEvery < 1 ||
    !Number.isInteger(limits.maxFindings) || limits.maxFindings < 1 ||
    !Number.isInteger(limits.maxPayloadBytes) || limits.maxPayloadBytes < 1 || limits.maxPayloadBytes > XML_READER_MAX_BYTES ||
    !positive(limits.maxTotalBytes)
  ) {
    throw new RangeError("Evaluator limits are out of range.");
  }
}

function compare(a: Finding, b: Finding): number {
  const bySeverity = (SEVERITY_RANK.get(b.severity) ?? 0) - (SEVERITY_RANK.get(a.severity) ?? 0);
  if (bySeverity !== 0) return bySeverity;
  if (a.rule_id !== b.rule_id) return a.rule_id < b.rule_id ? -1 : 1;
  const idA = a.update?.sys_id ?? a.update_set?.sys_id ?? "";
  const idB = b.update?.sys_id ?? b.update_set?.sys_id ?? "";
  if (idA !== idB) return idA < idB ? -1 : 1;
  return (a.line ?? 0) - (b.line ?? 0);
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const flag = (value: unknown): boolean | undefined => (value === true ? true : value === false ? false : undefined);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The caller's input, with every field reduced to the type the rules expect.
 * Anything malformed is dropped or neutralised, and counted in
 * `unavailable` when it means a check could not be made.
 */
function normalize(raw: EvaluationInput, notes: RuleNotes): { input: EvaluationInput; totalValid: boolean } {
  // Copy the top-level fields once; a getter that throws reads as absent.
  const value: Record<string, unknown> = {};
  if (isObject(raw)) {
    for (const key of [
      "source", "sets", "batch_root", "updates", "updates_total", "payload_access", "problems",
      "open_set_collisions", "baseline_versions", "context",
    ]) {
      try {
        value[key] = raw[key];
      } catch {
        notes.unavailable++;
      }
    }
  }
  const updates: EvaluateUpdate[] = [];
  if (Array.isArray(value.updates)) {
    for (const u of value.updates as unknown[]) {
      try {
        if (!isObject(u)) throw new TypeError();
        updates.push(normalizeUpdate(u));
      } catch {
        // Not a row the engine can read: it counts as not evaluated.
        updates.push({ sys_id: "", name: "", update_set: "", payload: null });
      }
    }
  } else {
    notes.unavailable++;
  }
  const sets: EvaluateSet[] = [];
  if (Array.isArray(value.sets)) {
    for (const s of value.sets as unknown[]) {
      try {
        if (!isObject(s)) throw new TypeError();
        sets.push(normalizeSet(s, notes));
      } catch {
        notes.unavailable++;
      }
    }
  } else {
    notes.unavailable++;
  }
  return finish(value, updates, sets, notes);
}

function normalizeUpdate(u: Record<string, unknown>): EvaluateUpdate {
  return {
    sys_id: str(u.sys_id) ?? "",
    name: str(u.name) ?? "",
    type: str(u.type),
    target_name: str(u.target_name),
    update_set: str(u.update_set) ?? "",
    action: str(u.action),
    table: str(u.table),
    application: str(u.application),
    replace_on_upgrade: u.replace_on_upgrade === true,
    payload: str(u.payload),
  };
}

function normalizeSet(s: Record<string, unknown>, notes: RuleNotes): EvaluateSet {
  const count = s.update_count;
  const validCount = typeof count === "number" && Number.isFinite(count) && count >= 0;
  if (!validCount) notes.unavailable++;
  return {
    sys_id: str(s.sys_id) ?? "",
    name: str(s.name) ?? "",
    state: str(s.state),
    is_default: flag(s.is_default),
    has_description: flag(s.has_description),
    application: str(s.application),
    parent: str(s.parent),
    update_count: validCount ? count : Number.NaN,
  };
}

function finish(
  value: Record<string, unknown>,
  updates: EvaluateUpdate[],
  sets: EvaluateSet[],
  notes: RuleNotes
): { input: EvaluationInput; totalValid: boolean } {
  let problems: PreviewProblem[] | undefined;
  let collisions: Map<string, number> | undefined;
  let baseline: Map<string, "baseline" | "customer"> | undefined;
  try {
    if (Array.isArray(value.problems)) {
      problems = (value.problems as unknown[]).filter(isObject).map((p) => ({
        sys_id: str(p.sys_id) ?? "",
        remote_update: str(p.remote_update),
        // A status that is not a string blocks, like an empty one.
        status: str(p.status),
        type: str(p.type),
      }));
    } else if (value.problems !== undefined) {
      notes.unavailable++;
    }
    if (value.open_set_collisions instanceof Map) {
      collisions = new Map();
      for (const [name, count] of value.open_set_collisions as Map<unknown, unknown>) {
        // A count that is not a number reads as a collision: fail closed.
        if (typeof name === "string") collisions.set(name, typeof count === "number" && Number.isFinite(count) ? count : 1);
      }
    } else if (value.open_set_collisions !== undefined) {
      notes.unavailable++;
    }
    if (value.baseline_versions instanceof Map) {
      baseline = new Map();
      for (const [name, source] of value.baseline_versions as Map<unknown, unknown>) {
        if (typeof name === "string" && (source === "baseline" || source === "customer")) baseline.set(name, source);
      }
    } else if (value.baseline_versions !== undefined) {
      notes.unavailable++;
    }
  } catch {
    // A problem list or map that cannot be read: the checks it feeds are unavailable.
    notes.unavailable++;
    problems = undefined;
    collisions = undefined;
    baseline = undefined;
  }
  const source = value.source === "remote" ? "remote" : "local";
  if (value.source !== "remote" && value.source !== "local") notes.unavailable++;
  const total = value.updates_total;
  const totalValid = typeof total === "number" && Number.isFinite(total) && total >= 0;
  return {
    input: {
      source,
      sets,
      batch_root: str(value.batch_root),
      updates,
      updates_total: totalValid ? total : updates.length,
      payload_access: value.payload_access === "granted" ? "granted" : "denied",
      ...(problems !== undefined ? { problems } : {}),
      ...(collisions !== undefined ? { open_set_collisions: collisions } : {}),
      ...(baseline !== undefined ? { baseline_versions: baseline } : {}),
      context: safeContext(value.context, notes),
    },
    totalValid,
  };
}

/**
 * The caller's checks, failing closed: only the exact return types count. A
 * credential check that throws or returns anything but a boolean answers
 * "credential table" and is counted; a type or hierarchy check that does so
 * answers its "unavailable" sentinel, which the rule counts. Thrown errors,
 * and their text, never leave the engine.
 */
function safeContext(raw: unknown, notes: RuleNotes): EvaluateContext {
  const context: Partial<Record<keyof EvaluateContext, unknown>> = isObject(raw) ? raw : {};
  const call = (name: keyof EvaluateContext, table: string): unknown => {
    try {
      const check = context[name];
      return typeof check === "function" ? (check as (t: string) => unknown).call(context, table) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    isCredentialTable(table) {
      const answer = call("isCredentialTable", table);
      if (answer === true || answer === false) return answer;
      notes.unavailable++;
      return true;
    },
    hiddenFieldNames(table) {
      const answer = call("hiddenFieldNames", table);
      return answer instanceof Set ? (answer as ReadonlySet<string>) : "unavailable";
    },
    extendsMetadata(table) {
      const answer = call("extendsMetadata", table);
      return answer === true || answer === false ? answer : "unknown";
    },
  };
}

/** Evaluates the rows and sets in `input`. Never throws on instance content or on the caller's checks. */
export async function evaluateUpdateSets(
  raw: EvaluationInput,
  options: EvaluationOptions = {},
  limits: EngineLimits = ENGINE_LIMITS,
  hooks: EngineHooks = {}
): Promise<EvaluationResult> {
  checkLimits(limits);
  const now = hooks.now ?? (() => performance.now());
  const yieldToLoop = hooks.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));

  const requested = Array.isArray(options.groups) ? options.groups.filter((g) => RULE_GROUPS.includes(g)) : [];
  const groups = new Set<RuleGroup>(requested.length > 0 ? requested : RULE_GROUPS);
  const floor = SEVERITY_RANK.get(options.min_severity ?? "info") ?? 0;
  const enabled = (id: RuleId) => groups.has(ruleGroup(id));

  const findings: Finding[] = [];
  const notes: RuleNotes = { unavailable: 0 };
  const { input, totalValid } = normalize(raw, notes);
  const keep = (finding: RuleFinding): boolean => (SEVERITY_RANK.get(finding.severity) ?? 0) >= floor && enabled(finding.rule_id);

  // Set rules: cheap, and they need no payload.
  for (const rule of SET_RULES) {
    if (!enabled(rule.id)) continue;
    const pending: Finding[] = [];
    try {
      rule.run(
        input,
        (set: EvaluateSet, finding) => {
          if (!keep(finding) || !isSysId(set.sys_id)) return;
          pending.push({
            rule_id: finding.rule_id,
            group: ruleGroup(finding.rule_id),
            severity: finding.severity,
            confidence: finding.confidence,
            update_set: { sys_id: set.sys_id, name: (set.name ?? "").slice(0, SET_NAME_MAX) },
            message: finding.message,
          });
        },
        notes
      );
      findings.push(...pending);
    } catch {
      notes.unavailable++;
    }
  }

  const rowRules = ROW_RULES.filter((rule) => enabled(rule.id));
  const scriptRules = rowRules.some((rule) => rule.needs === "payload" && rule.id !== "SEC005");
  const secretRule = rowRules.some((rule) => rule.id === "SEC005");
  const duplicates = enabled("BP008") ? duplicateNamesAcrossSets(input) : new Set<string>();
  const payloadGranted = input.payload_access === "granted";

  let spent = 0;
  let segmentStart = now();
  let evaluated = 0;
  let scanned = 0;
  let skippedUnreadable = 0;
  let credentialRows = 0;
  let totalBytes = 0;
  let cpuBudgetHit = false;
  let bytesCapHit = false;

  for (let index = 0; index < input.updates.length; index++) {
    // Yield every `yieldEvery` rows, and also after YIELD_AFTER_MS of work,
    // so a few large rows cannot hold the event loop for the whole budget.
    // The time spent so far is charged before the yield, as before.
    let elapsed = now() - segmentStart;
    if (index > 0 && (index % limits.yieldEvery === 0 || elapsed >= YIELD_AFTER_MS)) {
      spent += elapsed;
      await yieldToLoop();
      segmentStart = now();
      elapsed = 0;
    }
    if (spent + elapsed >= limits.cpuBudgetMs) {
      cpuBudgetHit = true;
      break;
    }
    if (totalBytes >= limits.maxTotalBytes) {
      bytesCapHit = true;
      break;
    }
    const update = input.updates[index];
    const finding = findingUpdate(update);
    if (finding === null) continue; // not a valid row: counted as not evaluated
    evaluated++;

    // One row's findings are kept only when the whole row ran: a row that
    // throws counts as not scanned and the call goes on.
    const pending: Finding[] = [];
    let row: PreparedRow;
    try {
      row = prepareRow(update, finding, payloadGranted, input.context, {
        maxPayloadBytes: limits.maxPayloadBytes,
        scripts: scriptRules,
        secrets: secretRule,
      });
      const prepared = row;
      const emit = (result: RuleFinding) => {
        if (!keep(result)) return;
        const located = NO_LOCATION.has(result.rule_id) ? {} : { field: result.field, line: result.line };
        pending.push({
          rule_id: result.rule_id,
          group: ruleGroup(result.rule_id),
          severity: result.severity,
          confidence: result.confidence,
          update: prepared.finding,
          message: result.message,
          ...(located.field !== undefined ? { field: located.field } : {}),
          ...(located.line !== undefined ? { line: located.line } : {}),
          ...(result.table !== undefined ? { table: result.table } : {}),
        });
      };
      for (const rule of rowRules) {
        if (rule.needs === "payload" && row.payload !== "read") continue;
        rule.run(row, input, emit, notes);
      }
      if (duplicates.has(update.name)) {
        emit({ rule_id: "BP008", severity: "medium", confidence: "high", message: RULE_MESSAGES.BP008 });
      }
    } catch {
      skippedUnreadable++;
      continue;
    }
    totalBytes += row.bytes;
    if (row.payload === "read") scanned++;
    else if (row.payload === "credential") credentialRows++;
    else if (payloadGranted) skippedUnreadable++;
    findings.push(...pending);
  }

  const total = Math.max(input.updates_total, input.updates.length, 0);
  const notEvaluated = Math.max(0, total - evaluated);
  findings.sort(compare);

  const byGroup = Object.fromEntries(RULE_GROUPS.map((g) => [g, 0])) as Record<RuleGroup, number>;
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const finding of findings) {
    byGroup[finding.group]++;
    bySeverity[finding.severity]++;
  }

  return {
    rules_version: RULES_VERSION,
    summary: { by_group: byGroup, by_severity: bySeverity },
    findings: findings.slice(0, limits.maxFindings),
    findings_truncated: findings.length > limits.maxFindings,
    coverage: {
      updates_total: total,
      evaluated,
      scanned,
      skipped_unreadable: skippedUnreadable,
      credential_rows: credentialRows,
      not_evaluated: notEvaluated,
      checks_unavailable: notes.unavailable,
      partial:
        !totalValid || notEvaluated > 0 || skippedUnreadable > 0 || notes.unavailable > 0 || cpuBudgetHit || bytesCapHit,
      cpu_budget_hit: cpuBudgetHit,
      bytes_cap_hit: bytesCapHit,
      metadata_only: !payloadGranted,
    },
  };
}
