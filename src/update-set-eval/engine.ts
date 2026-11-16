/**
 * The update-set evaluator's engine: runs the 32 rules over rows the caller
 * has read, within a CPU budget, and reports what it covered.
 *
 * - CPU: the budget (250 ms) counts the time the engine itself runs, checked
 *   between rows; the time it spends yielding (every 50 rows) is not counted,
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
  type EvaluateSet,
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

export interface EngineHooks {
  /** Milliseconds, monotonic. Tests pass a fake clock. */
  readonly now?: () => number;
  /** Lets other work run; default `setImmediate`. */
  readonly yieldToLoop?: () => Promise<void>;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze(
  Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>
);

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
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.rule_id !== b.rule_id) return a.rule_id < b.rule_id ? -1 : 1;
  const idA = a.update?.sys_id ?? a.update_set?.sys_id ?? "";
  const idB = b.update?.sys_id ?? b.update_set?.sys_id ?? "";
  if (idA !== idB) return idA < idB ? -1 : 1;
  return (a.line ?? 0) - (b.line ?? 0);
}

/** Evaluates the rows and sets in `input`. Never throws on instance content. */
export async function evaluateUpdateSets(
  input: EvaluationInput,
  options: EvaluationOptions = {},
  limits: EngineLimits = ENGINE_LIMITS,
  hooks: EngineHooks = {}
): Promise<EvaluationResult> {
  checkLimits(limits);
  const now = hooks.now ?? (() => performance.now());
  const yieldToLoop = hooks.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));

  const groups = new Set<RuleGroup>(options.groups && options.groups.length > 0 ? options.groups : RULE_GROUPS);
  const floor = SEVERITY_RANK[options.min_severity ?? "info"];
  const enabled = (id: RuleId) => groups.has(ruleGroup(id));

  const findings: Finding[] = [];
  const notes: RuleNotes = { unavailable: 0 };
  const keep = (finding: RuleFinding): boolean => SEVERITY_RANK[finding.severity] >= floor && enabled(finding.rule_id);

  // Set rules: cheap, and they need no payload.
  for (const rule of SET_RULES) {
    if (!enabled(rule.id)) continue;
    rule.run(
      input,
      (set: EvaluateSet, finding) => {
        if (!keep(finding) || !isSysId(set.sys_id)) return;
        const name = typeof set.name === "string" ? set.name.slice(0, SET_NAME_MAX) : "";
        findings.push({
          rule_id: finding.rule_id,
          group: ruleGroup(finding.rule_id),
          severity: finding.severity,
          confidence: finding.confidence,
          update_set: { sys_id: set.sys_id, name },
          message: finding.message,
        });
      },
      notes
    );
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
    if (index > 0 && index % limits.yieldEvery === 0) {
      spent += now() - segmentStart;
      await yieldToLoop();
      segmentStart = now();
    }
    if (spent + (now() - segmentStart) >= limits.cpuBudgetMs) {
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

    const row: PreparedRow = prepareRow(update, finding, payloadGranted, input.context, {
      maxPayloadBytes: limits.maxPayloadBytes,
      scripts: scriptRules,
      secrets: secretRule,
    });
    totalBytes += row.bytes;
    if (row.payload === "read") scanned++;
    else if (row.payload === "credential") credentialRows++;
    else if (payloadGranted) skippedUnreadable++;

    const emit = (result: RuleFinding) => {
      if (!keep(result)) return;
      const located = NO_LOCATION.has(result.rule_id) ? {} : { field: result.field, line: result.line };
      findings.push({
        rule_id: result.rule_id,
        group: ruleGroup(result.rule_id),
        severity: result.severity,
        confidence: result.confidence,
        update: row.finding,
        message: result.message,
        ...(located.field !== undefined ? { field: located.field } : {}),
        ...(located.line !== undefined ? { line: located.line } : {}),
      });
    };
    for (const rule of rowRules) {
      if (rule.needs === "payload" && row.payload !== "read") continue;
      rule.run(row, input, emit, notes);
    }
    if (duplicates.has(update.name)) {
      emit({ rule_id: "BP008", severity: "medium", confidence: "high", message: RULE_MESSAGES.BP008 });
    }
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
      partial: notEvaluated > 0 || skippedUnreadable > 0 || notes.unavailable > 0 || cpuBudgetHit || bytesCapHit,
      cpu_budget_hit: cpuBudgetHit,
      bytes_cap_hit: bytesCapHit,
      metadata_only: !payloadGranted,
    },
  };
}
