/**
 * Input and output shapes of the update-set evaluator.
 *
 * The engine reads nothing upstream. Its caller (the `evaluate` view) reads
 * the sets, their rows and the extra facts some rules need, inside its
 * declared access plan, and hands them over here. Instance text in the input
 * is untrusted: the engine never puts payload text into a finding, and it
 * returns row metadata (`name`, `target_name`, `type`) as data for the caller
 * to fence.
 */

export const RULE_GROUPS = Object.freeze(["perf", "sec", "bp"] as const);
export type RuleGroup = (typeof RULE_GROUPS)[number];

/** Lowest first. */
export const SEVERITIES = Object.freeze(["info", "low", "medium", "high", "critical"] as const);
export type Severity = (typeof SEVERITIES)[number];

export type Confidence = "high" | "medium" | "low";

/** One update set: a local `sys_update_set` or a remote `sys_remote_update_set`. */
export interface EvaluateSet {
  readonly sys_id: string;
  readonly name: string;
  /** `in progress`, `complete` or `ignore` for a local set; a remote state otherwise. */
  readonly state?: string | null;
  readonly is_default?: boolean;
  /** Whether the set has a non-empty description. The text itself is not needed. */
  readonly has_description?: boolean;
  /** The set's application sys_id. */
  readonly application?: string | null;
  /** The parent set's sys_id, for batch members. */
  readonly parent?: string | null;
  /** Rows in the set, from a stats read; an absent stats group is 0. */
  readonly update_count: number;
}

/** One `sys_update_xml` row. */
export interface EvaluateUpdate {
  readonly sys_id: string;
  readonly name: string;
  readonly type?: string | null;
  readonly target_name?: string | null;
  /** The set (local or remote) the row belongs to. */
  readonly update_set: string;
  readonly action?: string | null;
  /** The `table` column, when the caller read it. */
  readonly table?: string | null;
  readonly application?: string | null;
  readonly replace_on_upgrade?: boolean;
  /** The payload, or null when it is not readable under field policy or was not read. */
  readonly payload: string | null;
}

/** One `sys_update_preview_problem` row of a remote set. */
export interface PreviewProblem {
  readonly sys_id: string;
  /** The `sys_update_xml` row (`remote_update`) the problem is about, if any. */
  readonly remote_update?: string | null;
  readonly status: string | null;
  readonly type?: string | null;
}

/** What a field-type lookup knows about one table's password-typed fields. */
export type HiddenFieldNames = ReadonlySet<string> | "unavailable";

/**
 * Facts from shared helpers that the engine must not decide by itself. The
 * caller wires these to the shared credential-table list, the type-based
 * hiding helper and the table hierarchy.
 */
export interface EvaluateContext {
  /** True for a table whose rows carry credentials (the shared credential-table list). */
  readonly isCredentialTable: (table: string) => boolean;
  /** Field names typed `password` or `password2` on the table, walking its hierarchy. */
  readonly hiddenFieldNames: (table: string) => HiddenFieldNames;
  /** Whether the table extends `sys_metadata`, or "unknown" when the hierarchy was not read. */
  readonly extendsMetadata: (table: string) => boolean | "unknown";
}

export interface EvaluationInput {
  /** `local`: `sys_update_set` rows. `remote`: a retrieved set's rows (commit-time evaluation). */
  readonly source: "local" | "remote";
  /** Every set in scope: one, or a batch root and its descendants. */
  readonly sets: readonly EvaluateSet[];
  /** The batch root's sys_id, when the scope is a batch. */
  readonly batch_root?: string | null;
  /** The rows read, newest-first or in any order; at most the caller's `max_updates`. */
  readonly updates: readonly EvaluateUpdate[];
  /** Rows in scope according to the stats read; may exceed `updates.length`. */
  readonly updates_total: number;
  /** "denied" when field policy hides `payload`: only metadata rules run. */
  readonly payload_access: "granted" | "denied";
  /** Remote scope only: the sets' preview problems. Absent means not read. */
  readonly problems?: readonly PreviewProblem[];
  /** Local scope only: update name to the number of other open sets that hold it. Absent means not read. */
  readonly open_set_collisions?: ReadonlyMap<string, number>;
  /**
   * Update name to its `sys_update_version` source: `baseline` (a platform or
   * store source) or `customer`. A name missing from the map was not checked.
   */
  readonly baseline_versions?: ReadonlyMap<string, "baseline" | "customer">;
  readonly context: EvaluateContext;
}

export interface EvaluationOptions {
  /** Only these groups' rules run. Default: all. */
  readonly groups?: readonly RuleGroup[];
  /** Findings below this severity are left out of the findings and the summary. Default: info. */
  readonly min_severity?: Severity;
}

/** Engine limits; tests may lower them. */
export interface EngineLimits {
  /** CPU budget per call, counted while the engine runs (not while it yields). */
  readonly cpuBudgetMs: number;
  /** Yield to the event loop after this many rows. */
  readonly yieldEvery: number;
  readonly maxFindings: number;
  /** UTF-8 bytes per payload; a larger one is not scanned. */
  readonly maxPayloadBytes: number;
  /** UTF-8 bytes of payload per call; rows past it are not evaluated. */
  readonly maxTotalBytes: number;
}

export interface FindingUpdate {
  readonly sys_id: string;
  readonly name: string;
  readonly type: string | null;
  readonly target_name: string | null;
  readonly update_set: string;
}

export interface FindingSet {
  readonly sys_id: string;
  readonly name: string;
}

export interface Finding {
  readonly rule_id: string;
  readonly group: RuleGroup;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** The row, for a row finding. */
  readonly update?: FindingUpdate;
  /** The set, for a set finding. */
  readonly update_set?: FindingSet;
  /** A fixed sentence; the only value it may hold is a validated table name. */
  readonly message: string;
  /** The payload element that holds the script (a validated element name). Never set for SEC005 or SEC010. */
  readonly field?: string;
  /** 1-based line in that element's text. Never set for SEC005 or SEC010. */
  readonly line?: number;
}

export interface Coverage {
  readonly updates_total: number;
  /** Rows the engine reached. */
  readonly evaluated: number;
  /** Rows whose payload was read and whose script and payload rules ran. */
  readonly scanned: number;
  /**
   * Rows whose payload was absent, too large or unreadable: metadata rules
   * only. Never counted as clean.
   */
  readonly skipped_unreadable: number;
  /** Credential-table rows: metadata rules and SEC010 only; scripts and values are not scanned. */
  readonly credential_rows: number;
  /** Rows in scope that were not reached: not read (`max_updates`), CPU budget or byte cap. */
  readonly not_evaluated: number;
  /** Rule checks that needed a fact the caller could not supply (field types, hierarchy). */
  readonly checks_unavailable: number;
  /** True when anything above means the result is not the whole scope. */
  readonly partial: boolean;
  readonly cpu_budget_hit: boolean;
  readonly bytes_cap_hit: boolean;
  /** True when field policy hid every payload. */
  readonly metadata_only: boolean;
}

export interface EvaluationResult {
  readonly rules_version: string;
  readonly summary: {
    readonly by_group: Readonly<Record<RuleGroup, number>>;
    readonly by_severity: Readonly<Record<Severity, number>>;
  };
  /** Sorted by severity (highest first), then rule id, then sys_id. */
  readonly findings: readonly Finding[];
  readonly findings_truncated: boolean;
  readonly coverage: Coverage;
}
