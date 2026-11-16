/**
 * The evaluator's 32 rules.
 *
 * Row rules run once per prepared row, and set rules once per call. Every
 * rule reads the shared preparation (the parsed records, tokenized scripts
 * and secret matches) and never rescans payload text. Messages are fixed
 * sentences; the only value one may hold is a table name that has passed
 * `isTableName`. SEC005 and SEC010 findings carry no field and no line.
 */

import {
  TokenKind,
  callArguments,
  findCall,
  findIdentifier,
  findMethod,
  scriptLine,
  tokensAre,
  type ScriptTokens,
} from "./script-scan.js";
import { isFieldName, isTableName, type PreparedRecord, type PreparedRow, type PreparedScript, type ScriptSide } from "./prepare.js";
import type { Confidence, EvaluateSet, EvaluationInput, RuleGroup, Severity } from "./types.js";

export const RULES_VERSION = "1";

export const RULE_IDS = Object.freeze([
  "PERF001", "PERF002", "PERF003", "PERF004", "PERF005", "PERF006", "PERF007", "PERF008", "PERF009",
  "SEC001", "SEC002", "SEC003", "SEC004", "SEC005", "SEC006", "SEC007", "SEC008", "SEC009", "SEC010", "SEC011",
  "BP001", "BP002", "BP003", "BP004", "BP005", "BP006", "BP007", "BP008", "BP009", "BP010", "BP011", "BP012",
] as const);
export type RuleId = (typeof RULE_IDS)[number];

export function ruleGroup(id: RuleId): RuleGroup {
  return id.startsWith("PERF") ? "perf" : id.startsWith("SEC") ? "sec" : "bp";
}

/** Fixed messages. `{table}` is replaced only with a name that passed `isTableName`. */
export const RULE_MESSAGES = Object.freeze({
  PERF001: "A query runs inside a loop over query results (N+1 queries).",
  PERF002: "A GlideRecord query runs with no filter or limit (full-table scan).",
  PERF003: "getRowCount() counts rows by reading them; use GlideAggregate.",
  PERF004: "A business rule runs on every query of its table.",
  PERF004_QUERY: "A business rule runs on every query of its table and itself queries.",
  PERF005: "A client script makes a synchronous server round trip.",
  PERF006: "A business rule that is not async makes an outbound call the user waits on.",
  PERF007: "A business rule calls current.update(), which writes twice and can recurse.",
  PERF008: "A script sleeps or busy-waits, holding a worker.",
  PERF009: "The set has more than 1,000 updates, which slows preview and commit.",
  PERF009_HIGH: "The set has more than 5,000 updates, which slows preview and commit.",
  PERF009_BATCH: "The batch has more than 1,000 updates, which slows preview and commit.",
  PERF009_BATCH_HIGH: "The batch has more than 5,000 updates, which slows preview and commit.",
  SEC001: "An access control rule changes.",
  SEC001_HIGH: "An access control rule is deleted, always grants access, or has no role, condition or script.",
  SEC002: "A role or role containment changes.",
  SEC002_CRITICAL: "A role or role containment change involves an elevated role.",
  SEC003: "A script include is callable from the browser.",
  SEC003_HIGH: "A script include is callable from the browser and its isPublic() returns true.",
  SEC004: "A script evaluates dynamic code.",
  SEC005: "A script or value holds what looks like a credential literal.",
  SEC006: "A system property changes.",
  SEC006_HIGH: "A security-related or password-typed system property changes.",
  SEC007: "A cross-scope access is allowed, or a script include is public across scopes.",
  SEC008: "An unauthenticated entry point is added or changed.",
  SEC009: "A script turns off business rules or system-field updates for its writes.",
  SEC010: "The update carries credentials to the target instance.",
  SEC011: "The update writes a data record, which overwrites data on the target instance.",
  SEC011_TABLE: "The update writes a data record on table {table}, which does not extend sys_metadata.",
  BP001: "The set is the Default update set, which cannot be promoted.",
  BP002: "The set's updates belong to more than one application, or to another application than the set.",
  BP003: "The update deletes a record, which is hard to back out.",
  BP004: "A preview problem is not resolved, so the commit is blocked.",
  BP004_LOCAL: "Another open update set holds the same update; the last writer wins.",
  BP005: "The update changes a baseline record, so upgrades will skip it.",
  BP006: "The set has no description.",
  BP007: "A batch member's state differs from its root's (partial promotion).",
  BP008: "The same update is in more than one set of the batch; the result depends on order.",
  BP009: "The set is empty.",
  BP010: "A script holds a hard-coded sys_id, which differs between instances.",
  BP011: "Server code logs with gs.log, gs.print or console.log.",
  BP012: "The update is marked replace on upgrade.",
} as const);

export interface RuleFinding {
  readonly rule_id: RuleId;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly message: string;
  readonly field?: string;
  readonly line?: number;
}

export type Emit = (finding: RuleFinding) => void;

/** Counters a rule bumps when it needs a fact the caller did not supply. */
export interface RuleNotes {
  unavailable: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function at(script: PreparedScript, token: number): { field?: string; line?: number } {
  const t = script.scan.tokens[token];
  const out: { field?: string; line?: number } = {};
  if (isFieldName(script.field)) out.field = script.field;
  if (t !== undefined) out.line = scriptLine(script.scan, t.start);
  return out;
}

function scriptsOf(row: PreparedRow, side?: ScriptSide): readonly PreparedScript[] {
  return side === undefined ? row.scripts : row.scripts.filter((s) => s.side === side);
}

function mainRecord(row: PreparedRow): PreparedRecord | undefined {
  return row.records[0];
}

function field(row: PreparedRow, name: string): string | undefined {
  return mainRecord(row)?.fields.get(name);
}

const isTrue = (value: string | undefined) => value?.trim().toLowerCase() === "true";
const isFalse = (value: string | undefined) => value?.trim().toLowerCase() === "false";

function isDelete(row: PreparedRow): boolean {
  return (row.update.action ?? "").toUpperCase() === "DELETE" || (mainRecord(row)?.action ?? "").toUpperCase() === "DELETE";
}

/**
 * True when token `k` is `new` followed by one of `classes` and `(`:
 * `new GlideRecord(` or `new sn_ws.RESTMessageV2(`, where the class is the
 * last name before `(`. It reads at most seven tokens.
 */
function isNewAt(scan: ScriptTokens, k: number, classes: ReadonlySet<string>): boolean {
  const { tokens } = scan;
  if (tokens[k]?.value !== "new" || tokens[k].kind !== TokenKind.Identifier || k + 2 >= tokens.length) return false;
  let j = k + 1;
  while (j + 2 < tokens.length && tokens[j + 1].value === "." && tokens[j + 2].kind === TokenKind.Identifier && j < k + 7) j += 2;
  return tokens[j].kind === TokenKind.Identifier && classes.has(tokens[j].value) && tokens[j + 1]?.value === "(";
}

/** The first token at or after `from` where `isNewAt` holds, or -1. */
function findNew(scan: ScriptTokens, classes: ReadonlySet<string>, from = 0): number {
  for (let k = from; k < scan.tokens.length; k++) if (isNewAt(scan, k, classes)) return k;
  return -1;
}

const QUERY_CLASSES = new Set(["GlideRecord", "GlideRecordSecure", "GlideAggregate"]);
const RECORD_CLASSES = new Set(["GlideRecord", "GlideRecordSecure"]);

/** Header tokens a loop check reads at most; a longer header is judged on its start. */
const HEADER_TOKENS = 64;

function headerHas(scan: ScriptTokens, header: number, test: (k: number) => boolean): boolean {
  const end = Math.min(scan.match[header], header + HEADER_TOKENS);
  for (let k = header + 1; k < end; k++) if (test(k)) return true;
  return false;
}

/** How many qualifying loop bodies hold each token: a difference array, so linear. */
function loopCover(scan: ScriptTokens, qualifies: (loop: ScriptTokens["loops"][number]) => boolean): Int32Array {
  const count = scan.tokens.length;
  const diff = new Int32Array(count + 1);
  for (const loop of scan.loops) {
    if (loop.body < 0 || !qualifies(loop)) continue;
    diff[loop.body + 1]++;
    diff[scan.match[loop.body]]--;
  }
  let depth = 0;
  for (let k = 0; k < count; k++) {
    depth += diff[k];
    diff[k] = depth;
  }
  return diff;
}

const isQueryCall = (scan: ScriptTokens, k: number) =>
  scan.tokens[k].kind === TokenKind.Identifier && scan.tokens[k].value === "query" && scan.tokens[k - 1]?.value === "." && scan.tokens[k + 1]?.value === "(";

// ---------------------------------------------------------------------------
// Row rules
// ---------------------------------------------------------------------------

export interface RowRule {
  readonly id: RuleId;
  /** Runs only when the payload was read (and, for script rules, not on credential rows). */
  readonly needs: "payload" | "metadata";
  readonly run: (row: PreparedRow, input: EvaluationInput, emit: Emit, notes: RuleNotes) => void;
}

const RESTRICTING_METHODS = new Set([
  "addQuery", "addEncodedQuery", "addActiveQuery", "addInactiveQuery", "addNullQuery", "addNotNullQuery",
  "addJoinQuery", "addDomainQuery", "setLimit", "chooseWindow", "get",
]);

const ELEVATED_ROLES = new Set([
  "admin", "security_admin", "maint", "impersonator", "oauth_admin", "user_admin", "web_service_admin",
  "snc_internal_admin", "credential_admin", "sn_vault_admin",
]);

const SECURITY_PROPERTY_PREFIXES = [
  "glide.security.", "glide.authenticate.", "glide.basicauth.", "glide.oauth.", "glide.sso.", "glide.cookies.",
  "glide.login.", "glide.password.", "glide.ui.escape", "glide.html.escape", "glide.xmlhttp.", "glide.sys.restrict",
  "glide.script.block", "glide.http.outbound", "glide.attachment.", "glide.entropy", "glide.ui.session_timeout",
  "glide.ui.attachment", "glide.cors.", "glide.rest.", "com.glide.communications.httpclient",
];

/** `g_form` calls that show a field's label or a message: the second argument is text, not a credential. */
const UI_DISPLAY_CALLS = new Set([
  "showFieldMsg", "hideFieldMsg", "setLabelOf", "getLabelOf", "setMandatory", "setDisplay", "setVisible",
  "setReadOnly", "setReadonly", "setDisabled", "addDecoration", "removeDecoration", "flash", "addInfoMessage",
  "addErrorMessage", "showErrorBox", "hideErrorBox",
]);
/** Calls whose argument is a filter: a matched `key=value` is usually a condition, not a credential. */
const QUERY_CALLS = new Set(["addEncodedQuery", "addQuery", "setEncodedQuery", "addOrCondition", "addCondition"]);

const isQuote = (c: number) => c === 39 || c === 34 || c === 96;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isIdent = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;

function backOverSpace(text: string, from: number): number {
  let i = from;
  const stop = Math.max(-1, from - 16);
  while (i > stop && isSpace(text.charCodeAt(i))) i--;
  return i;
}

function identBefore(text: string, end: number): string {
  let i = end;
  const stop = Math.max(-1, end - 64);
  while (i > stop && isIdent(text.charCodeAt(i))) i--;
  return text.slice(i + 1, end + 1);
}

/**
 * The call a matched value is an argument of: `g_form.setMandatory('password', '…')`
 * or `gr.addEncodedQuery('…key=…')`. Every backward read is bounded, so a
 * check costs a constant; null when the shape is anything else.
 */
export function callBefore(text: string, start: number): { receiver: string; method: string } | null {
  let i = start - 1;
  const floor = Math.max(0, start - 1024);
  while (i >= floor) {
    const c = text.charCodeAt(i);
    if (isQuote(c)) break;
    if (c === 10 || c === 13) return null;
    i--;
  }
  if (i < floor || text.charCodeAt(i - 1) === 92) return null; // an escaped quote: a nested string
  i = backOverSpace(text, i - 1);
  if (text.charCodeAt(i) === 44) {
    // ,  a quoted key argument comes first
    i = backOverSpace(text, i - 1);
    const quote = text.charCodeAt(i);
    if (!isQuote(quote)) return null;
    let j = i - 1;
    const keyFloor = Math.max(0, i - 256);
    while (j >= keyFloor && text.charCodeAt(j) !== quote) {
      if (text.charCodeAt(j) === 10) return null;
      j--;
    }
    if (j < keyFloor) return null;
    i = backOverSpace(text, j - 1);
  }
  if (text.charCodeAt(i) !== 40) return null; // (
  i = backOverSpace(text, i - 1);
  const method = identBefore(text, i);
  if (method.length === 0) return null;
  i -= method.length;
  const receiver = text.charCodeAt(i) === 46 ? identBefore(text, i - 1) : "";
  return { receiver, method };
}

export const ROW_RULES: readonly RowRule[] = Object.freeze([
  {
    id: "PERF001",
    needs: "payload",
    run(row, _input, emit) {
      for (const script of scriptsOf(row, "server")) {
        const scan = script.scan;
        const cover = loopCover(scan, (loop) => {
          const keyword = scan.tokens[loop.keyword].value;
          if (keyword !== "while") return keyword === "for";
          return headerHas(scan, loop.header, (k) => isQueryNext(scan, k));
        });
        for (let k = 0; k < scan.tokens.length; k++) {
          if (cover[k] === 0) continue;
          const t = scan.tokens[k];
          const hit = (t.value === "new" && isNewAt(scan, k, QUERY_CLASSES)) || isQueryCall(scan, k);
          if (hit) {
            emit({ rule_id: "PERF001", severity: "high", confidence: "high", message: RULE_MESSAGES.PERF001, ...at(script, k) });
            return;
          }
        }
      }
    },
  },
  {
    id: "PERF002",
    needs: "payload",
    run(row, _input, emit) {
      for (const script of scriptsOf(row, "server")) {
        const { tokens } = script.scan;
        const records = new Set<string>();
        for (let k = 2; k + 1 < tokens.length; k++) {
          if (tokens[k].value === "new" && tokens[k - 1].value === "=" && tokens[k - 2].kind === TokenKind.Identifier) {
            if (isNewAt(script.scan, k, RECORD_CLASSES)) records.add(tokens[k - 2].value);
          }
        }
        if (records.size === 0) continue;
        const restricted = new Set<string>();
        const queried = new Map<string, number>();
        for (let k = 2; k + 1 < tokens.length; k++) {
          const name = tokens[k - 2].value;
          if (tokens[k - 1].value !== "." || tokens[k + 1].value !== "(" || !records.has(name)) continue;
          if (tokens[k - 2].kind !== TokenKind.Identifier) continue;
          const method = tokens[k].value;
          if (RESTRICTING_METHODS.has(method)) restricted.add(name);
          else if (method === "query") {
            // query('field', value) filters too.
            if (tokens[k + 2]?.value !== ")") restricted.add(name);
            else if (!queried.has(name)) queried.set(name, k);
          }
        }
        for (const [name, k] of queried) {
          if (restricted.has(name)) continue;
          emit({ rule_id: "PERF002", severity: "high", confidence: "medium", message: RULE_MESSAGES.PERF002, ...at(script, k) });
          return;
        }
      }
    },
  },
  {
    id: "PERF003",
    needs: "payload",
    run(row, _input, emit) {
      for (const script of scriptsOf(row, "server")) {
        const k = findMethod(script.scan, "getRowCount");
        if (k >= 0) {
          emit({ rule_id: "PERF003", severity: "medium", confidence: "high", message: RULE_MESSAGES.PERF003, ...at(script, k) });
          return;
        }
      }
    },
  },
  {
    id: "PERF004",
    needs: "payload",
    run(row, _input, emit) {
      if (row.table !== "sys_script" || !isTrue(field(row, "action_query"))) return;
      const queries = scriptsOf(row, "server").some(
        (s) => findMethod(s.scan, "query") >= 0 || findNew(s.scan, QUERY_CLASSES) >= 0
      );
      emit({
        rule_id: "PERF004",
        severity: queries ? "high" : "medium",
        confidence: "high",
        message: queries ? RULE_MESSAGES.PERF004_QUERY : RULE_MESSAGES.PERF004,
      });
    },
  },
  {
    id: "PERF005",
    needs: "payload",
    run(row, _input, emit) {
      for (const script of scriptsOf(row, "client")) {
        const scan = script.scan;
        let k = findMethod(scan, "getXMLWait");
        if (k < 0) k = findNew(scan, RECORD_CLASSES);
        if (k < 0) {
          for (let from = 0; ; from = k + 1) {
            k = findCall(scan, "g_form", "getReference", from);
            if (k < 0 || callArguments(scan, k + 1).length < 2) break;
          }
        }
        if (k >= 0) {
          emit({ rule_id: "PERF005", severity: "high", confidence: "high", message: RULE_MESSAGES.PERF005, ...at(script, k) });
          return;
        }
      }
    },
  },
  {
    id: "PERF006",
    needs: "payload",
    run(row, _input, emit) {
      if (row.table !== "sys_script") return;
      const when = (field(row, "when") ?? "").trim().toLowerCase();
      if (when === "async" || when === "async_always") return;
      for (const script of scriptsOf(row, "server")) {
        const outbound =
          findIdentifier(script.scan, "RESTMessageV2") >= 0 || findIdentifier(script.scan, "SOAPMessageV2") >= 0;
        const k = outbound ? findMethod(script.scan, "execute") : -1;
        if (k >= 0) {
          emit({ rule_id: "PERF006", severity: "medium", confidence: "medium", message: RULE_MESSAGES.PERF006, ...at(script, k) });
          return;
        }
      }
    },
  },
  {
    id: "PERF007",
    needs: "payload",
    run(row, _input, emit) {
      if (row.table !== "sys_script") return;
      for (const script of scriptsOf(row, "server")) {
        const k = findCall(script.scan, "current", "update");
        if (k >= 0) {
          emit({ rule_id: "PERF007", severity: "high", confidence: "high", message: RULE_MESSAGES.PERF007, ...at(script, k) });
          return;
        }
      }
    },
  },
  {
    id: "PERF008",
    needs: "payload",
    run(row, _input, emit) {
      const clock = new Set(["Date", "GlideDateTime", "getNumericValue", "getTime", "nowDateTime"]);
      for (const script of scriptsOf(row)) {
        const scan = script.scan;
        const sleep = findCall(scan, "gs", "sleep");
        if (sleep >= 0) {
          emit({ rule_id: "PERF008", severity: "medium", confidence: "high", message: RULE_MESSAGES.PERF008, ...at(script, sleep) });
          return;
        }
        for (const loop of scan.loops) {
          if (loop.header < 0 || scan.tokens[loop.keyword].value !== "while") continue;
          if (headerHas(scan, loop.header, (k) => scan.tokens[k].kind === TokenKind.Identifier && clock.has(scan.tokens[k].value))) {
            emit({ rule_id: "PERF008", severity: "medium", confidence: "low", message: RULE_MESSAGES.PERF008, ...at(script, loop.keyword) });
            return;
          }
        }
      }
    },
  },
  {
    id: "SEC001",
    needs: "metadata",
    run(row, _input, emit) {
      if (row.table !== "sys_security_acl") return;
      let high = isDelete(row);
      const confidence: Confidence = row.payload === "read" ? "high" : "medium";
      if (!high && row.payload === "read") {
        const script = row.scripts.find((s) => s.record === 0 && s.field === "script");
        // The whole script is `answer = true;` (a few tokens), with no condition around it.
        const alwaysTrue =
          script !== undefined &&
          script.scan.tokens.length <= 6 &&
          script.scan.tokens.filter((t) => t.value !== ";" && t.value !== "var").map((t) => t.value).join(" ") === "answer = true";
        const hasRole = row.records.some((r) => r.table === "sys_security_acl_role");
        const condition = (field(row, "condition") ?? "").trim();
        const advanced = isTrue(field(row, "advanced"));
        const noScript = !advanced || script === undefined;
        high = alwaysTrue || (!hasRole && condition.length === 0 && noScript);
      }
      emit({ rule_id: "SEC001", severity: high ? "high" : "medium", confidence, message: high ? RULE_MESSAGES.SEC001_HIGH : RULE_MESSAGES.SEC001 });
    },
  },
  {
    id: "SEC002",
    needs: "metadata",
    run(row, _input, emit) {
      const tables = ["sys_user_role", "sys_user_role_contains", "sys_user_has_role", "sys_user_group_has_role"];
      if (row.table === null || !tables.includes(row.table)) return;
      let elevated = false;
      for (const record of row.records) {
        const names = [record.fields.get("name"), record.displayValues.get("role"), record.displayValues.get("contains")];
        if (names.some((n) => n !== undefined && ELEVATED_ROLES.has(n.trim().toLowerCase()))) elevated = true;
        if (isTrue(record.fields.get("elevated_privilege"))) elevated = true;
      }
      emit({
        rule_id: "SEC002",
        severity: elevated ? "critical" : "high",
        confidence: row.payload === "read" ? "high" : "medium",
        message: elevated ? RULE_MESSAGES.SEC002_CRITICAL : RULE_MESSAGES.SEC002,
      });
    },
  },
  {
    id: "SEC003",
    needs: "payload",
    run(row, _input, emit) {
      if (row.table !== "sys_script_include" || !isTrue(field(row, "client_callable"))) return;
      let publicTrue = false;
      for (const script of scriptsOf(row, "server")) {
        const { tokens } = script.scan;
        for (let k = 0; k < tokens.length && !publicTrue; k++) {
          if (tokens[k].value !== "isPublic") continue;
          publicTrue =
            tokensAre(script.scan, k + 1, [":", "function", "(", ")", "{", "return", "true"]) ||
            tokensAre(script.scan, k + 1, ["(", ")", "{", "return", "true"]);
        }
      }
      emit({
        rule_id: "SEC003",
        severity: publicTrue ? "high" : "medium",
        confidence: "high",
        message: publicTrue ? RULE_MESSAGES.SEC003_HIGH : RULE_MESSAGES.SEC003,
      });
    },
  },
  {
    id: "SEC004",
    needs: "payload",
    run(row, _input, emit) {
      for (const script of scriptsOf(row)) {
        const scan = script.scan;
        const { tokens } = scan;
        for (let k = 0; k < tokens.length; k++) {
          const t = tokens[k];
          if (t.kind !== TokenKind.Identifier) continue;
          const previous = tokens[k - 1]?.value;
          const hit =
            (t.value === "eval" && tokens[k + 1]?.value === "(" && (previous !== "." || tokens[k - 2]?.value === "gs")) ||
            t.value === "GlideEvaluator" ||
            t.value === "GlideScopedEvaluator" ||
            (t.value === "Function" && previous === "new" && tokens[k + 1]?.value === "(");
          if (hit) {
            emit({ rule_id: "SEC004", severity: "high", confidence: "high", message: RULE_MESSAGES.SEC004, ...at(script, k) });
            return;
          }
        }
      }
    },
  },
  {
    id: "SEC005",
    needs: "payload",
    run(row, _input, emit) {
      let real = false;
      let doubtful = false;
      let examined = 0;
      outer: for (const secrets of row.secrets) {
        for (const match of secrets.matches) {
          if (++examined > 64) {
            // Too many to look at each one: report rather than skip.
            real = true;
            break outer;
          }
          const call = callBefore(secrets.text, match.start);
          if (call !== null && call.receiver === "g_form" && UI_DISPLAY_CALLS.has(call.method)) continue;
          if (call !== null && QUERY_CALLS.has(call.method)) {
            doubtful = true;
            continue;
          }
          real = true;
          break outer;
        }
        if (secrets.truncated) doubtful = true;
      }
      if (!real && !doubtful) return;
      // No field, no line, no text: where a credential sits is information about it.
      emit({
        rule_id: "SEC005",
        severity: real ? "high" : "medium",
        confidence: real ? "high" : "low",
        message: RULE_MESSAGES.SEC005,
      });
    },
  },
  {
    id: "SEC006",
    needs: "metadata",
    run(row, _input, emit) {
      if (row.table !== "sys_properties") return;
      const name = (field(row, "name") ?? row.update.target_name ?? "").trim().toLowerCase();
      const type = (field(row, "type") ?? "").trim().toLowerCase();
      const high = type === "password" || type === "password2" || SECURITY_PROPERTY_PREFIXES.some((p) => name.startsWith(p));
      emit({
        rule_id: "SEC006",
        severity: high ? "high" : "medium",
        confidence: name.length > 0 ? "high" : "medium",
        message: high ? RULE_MESSAGES.SEC006_HIGH : RULE_MESSAGES.SEC006,
      });
    },
  },
  {
    id: "SEC007",
    needs: "payload",
    run(row, _input, emit) {
      const record = mainRecord(row);
      if (record === undefined) return;
      const allowed = (name: string) =>
        (record.fields.get(name) ?? "").trim().toLowerCase() === "allowed" ||
        (record.displayValues.get(name) ?? "").trim().toLowerCase() === "allowed";
      const hit =
        ((row.table === "sys_scope_privilege" || row.table === "sys_restricted_caller_access") && allowed("status")) ||
        (row.table === "sys_script_include" && (record.fields.get("access") ?? "").trim() === "public");
      if (hit) emit({ rule_id: "SEC007", severity: "medium", confidence: "high", message: RULE_MESSAGES.SEC007 });
    },
  },
  {
    id: "SEC008",
    needs: "payload",
    run(row, _input, emit) {
      const record = mainRecord(row);
      if (record === undefined || isDelete(row)) return;
      const f = (name: string) => record.fields.get(name);
      const hit =
        (row.table === "sys_public" && !isFalse(f("active"))) ||
        (row.table === "sp_page" && isTrue(f("public"))) ||
        (row.table === "sys_ws_operation" && isFalse(f("requires_authentication"))) ||
        (row.table === "sys_processor" && isFalse(f("require_role")));
      if (hit) {
        emit({
          rule_id: "SEC008",
          severity: "high",
          confidence: row.table === "sys_processor" ? "medium" : "high",
          message: RULE_MESSAGES.SEC008,
        });
      }
    },
  },
  {
    id: "SEC009",
    needs: "payload",
    run(row, _input, emit) {
      for (const script of scriptsOf(row, "server")) {
        const { tokens } = script.scan;
        for (let k = 1; k < tokens.length; k++) {
          const name = tokens[k].value;
          if ((name !== "setWorkflow" && name !== "autoSysFields") || tokens[k - 1].value !== ".") continue;
          if (tokensAre(script.scan, k + 1, ["(", "false", ")"])) {
            emit({ rule_id: "SEC009", severity: "low", confidence: "high", message: RULE_MESSAGES.SEC009, ...at(script, k) });
            return;
          }
        }
      }
    },
  },
  {
    id: "SEC010",
    needs: "metadata",
    run(row, input, emit, notes) {
      const table = row.table;
      if (table === null) return;
      const found = () => emit({ rule_id: "SEC010", severity: "high", confidence: "high", message: RULE_MESSAGES.SEC010 });
      if (row.payload === "credential" || input.context.isCredentialTable(table)) return found();
      if (row.payload !== "read") return;
      const record = mainRecord(row);
      if (record === undefined) return;
      if (/^sys_(?:rest|soap)_message(?:_fn|_function)?$/u.test(table)) {
        const auth = (record.fields.get("authentication_type") ?? "").trim().toLowerCase();
        if (auth.length > 0 && auth !== "no_authentication" && auth !== "inherit_from_parent") return found();
      }
      const hidden = input.context.hiddenFieldNames(table);
      if (hidden === "unavailable") {
        notes.unavailable++;
        return;
      }
      for (const [name, value] of record.fields) {
        if (hidden.has(name) && value.trim().length > 0) return found();
      }
    },
  },
  {
    id: "SEC011",
    needs: "metadata",
    run(row, input, emit, notes) {
      const table = row.table;
      if (table === null || isDelete(row)) return;
      const metadata = input.context.extendsMetadata(table);
      if (metadata === "unknown") {
        notes.unavailable++;
        return;
      }
      if (metadata) return;
      const message = isTableName(table) ? RULE_MESSAGES.SEC011_TABLE.replace("{table}", table) : RULE_MESSAGES.SEC011;
      emit({ rule_id: "SEC011", severity: "medium", confidence: "high", message });
    },
  },
  {
    id: "BP003",
    needs: "metadata",
    run(row, _input, emit) {
      if (isDelete(row)) emit({ rule_id: "BP003", severity: "medium", confidence: "high", message: RULE_MESSAGES.BP003 });
    },
  },
  {
    id: "BP004",
    needs: "metadata",
    run(row, input, emit) {
      if (input.source === "remote") {
        const blocking = (input.problems ?? []).some(
          (p) => p.remote_update === row.update.sys_id && !RESOLVED_PROBLEM_STATUS.has((p.status ?? "").trim())
        );
        if (blocking) emit({ rule_id: "BP004", severity: "high", confidence: "high", message: RULE_MESSAGES.BP004 });
        return;
      }
      const others = input.open_set_collisions?.get(row.update.name) ?? 0;
      if (others > 0) emit({ rule_id: "BP004", severity: "high", confidence: "high", message: RULE_MESSAGES.BP004_LOCAL });
    },
  },
  {
    id: "BP005",
    needs: "metadata",
    run(row, input, emit, notes) {
      const versions = input.baseline_versions;
      if (versions === undefined) return;
      const source = versions.get(row.update.name);
      if (source === undefined) notes.unavailable++;
      else if (source === "baseline") emit({ rule_id: "BP005", severity: "medium", confidence: "high", message: RULE_MESSAGES.BP005 });
    },
  },
  {
    id: "BP010",
    needs: "payload",
    run(row, _input, emit) {
      for (const script of scriptsOf(row)) {
        const { tokens } = script.scan;
        for (let k = 0; k < tokens.length; k++) {
          const t = tokens[k];
          if (t.kind === TokenKind.String && t.value.length === 32 && /^[0-9a-f]{32}$/iu.test(t.value)) {
            emit({ rule_id: "BP010", severity: "low", confidence: "high", message: RULE_MESSAGES.BP010, ...at(script, k) });
            return;
          }
        }
      }
    },
  },
  {
    id: "BP011",
    needs: "payload",
    run(row, _input, emit) {
      for (const script of scriptsOf(row, "server")) {
        let k = findCall(script.scan, "gs", "log");
        if (k < 0) k = findCall(script.scan, "gs", "print");
        if (k < 0) k = findCall(script.scan, "console", "log");
        if (k >= 0) {
          emit({ rule_id: "BP011", severity: "low", confidence: "high", message: RULE_MESSAGES.BP011, ...at(script, k) });
          return;
        }
      }
    },
  },
  {
    id: "BP012",
    needs: "metadata",
    run(row, _input, emit) {
      if (row.update.replace_on_upgrade === true) {
        emit({ rule_id: "BP012", severity: "info", confidence: "high", message: RULE_MESSAGES.BP012 });
      }
    },
  },
] satisfies RowRule[]);

function isQueryNext(scan: ScriptTokens, k: number): boolean {
  const t = scan.tokens[k];
  return t.kind === TokenKind.Identifier && t.value === "next" && scan.tokens[k - 1]?.value === "." && scan.tokens[k + 1]?.value === "(";
}

/** Preview-problem statuses that no longer block a commit; anything else, empty included, blocks. */
export const RESOLVED_PROBLEM_STATUS: ReadonlySet<string> = new Set(["ignored", "skipped", "skip_collision"]);

// ---------------------------------------------------------------------------
// Set rules
// ---------------------------------------------------------------------------

export type SetEmit = (set: EvaluateSet, finding: RuleFinding) => void;

export interface SetRule {
  readonly id: RuleId;
  readonly run: (input: EvaluationInput, emit: SetEmit, notes: RuleNotes) => void;
}

export const SET_RULES: readonly SetRule[] = Object.freeze([
  {
    id: "PERF009",
    run(input, emit) {
      for (const set of input.sets) {
        if (set.update_count > 5_000) emit(set, { rule_id: "PERF009", severity: "high", confidence: "high", message: RULE_MESSAGES.PERF009_HIGH });
        else if (set.update_count > 1_000) emit(set, { rule_id: "PERF009", severity: "medium", confidence: "high", message: RULE_MESSAGES.PERF009 });
      }
      const root = input.sets.find((s) => s.sys_id === input.batch_root);
      if (root === undefined || input.sets.length < 2 || root.update_count > 1_000) return;
      const total = input.sets.reduce((sum, s) => sum + Math.max(0, s.update_count), 0);
      if (total > 5_000) emit(root, { rule_id: "PERF009", severity: "high", confidence: "high", message: RULE_MESSAGES.PERF009_BATCH_HIGH });
      else if (total > 1_000) emit(root, { rule_id: "PERF009", severity: "medium", confidence: "high", message: RULE_MESSAGES.PERF009_BATCH });
    },
  },
  {
    id: "BP001",
    run(input, emit) {
      for (const set of input.sets) {
        if (set.is_default === true) emit(set, { rule_id: "BP001", severity: "high", confidence: "high", message: RULE_MESSAGES.BP001 });
      }
    },
  },
  {
    id: "BP002",
    run(input, emit) {
      const bySet = new Map<string, Set<string>>();
      for (const update of input.updates) {
        if (typeof update.application !== "string" || update.application.length === 0) continue;
        let apps = bySet.get(update.update_set);
        if (apps === undefined) bySet.set(update.update_set, (apps = new Set()));
        apps.add(update.application);
      }
      for (const set of input.sets) {
        const apps = bySet.get(set.sys_id);
        if (apps === undefined) continue;
        const own = typeof set.application === "string" && set.application.length > 0 ? set.application : null;
        if (apps.size > 1 || (own !== null && !apps.has(own))) {
          emit(set, { rule_id: "BP002", severity: "high", confidence: "high", message: RULE_MESSAGES.BP002 });
        }
      }
    },
  },
  {
    id: "BP004",
    run(input, emit, notes) {
      if (input.source === "remote") {
        if (input.problems === undefined) {
          notes.unavailable++;
          return;
        }
        // A blocking problem with no row in scope is reported on the first set.
        const rows = new Set(input.updates.map((u) => u.sys_id));
        const orphan = input.problems.some(
          (p) => !RESOLVED_PROBLEM_STATUS.has((p.status ?? "").trim()) && (typeof p.remote_update !== "string" || !rows.has(p.remote_update))
        );
        if (orphan && input.sets[0] !== undefined) {
          emit(input.sets[0], { rule_id: "BP004", severity: "high", confidence: "high", message: RULE_MESSAGES.BP004 });
        }
      } else if (input.open_set_collisions === undefined) {
        notes.unavailable++;
      }
    },
  },
  {
    id: "BP005",
    run(input, _emit, notes) {
      if (input.baseline_versions === undefined) notes.unavailable++;
    },
  },
  {
    id: "BP006",
    run(input, emit) {
      for (const set of input.sets) {
        if (set.has_description === false) emit(set, { rule_id: "BP006", severity: "low", confidence: "high", message: RULE_MESSAGES.BP006 });
      }
    },
  },
  {
    id: "BP007",
    run(input, emit) {
      const root = input.sets.find((s) => s.sys_id === input.batch_root);
      if (root === undefined) return;
      const state = (s: EvaluateSet) => (s.state ?? "").trim().toLowerCase();
      for (const set of input.sets) {
        if (set === root) continue;
        const mismatch =
          (state(set) === "in progress" && state(root) === "complete") || (state(set) === "complete" && state(root) === "in progress");
        if (mismatch) emit(set, { rule_id: "BP007", severity: "medium", confidence: "high", message: RULE_MESSAGES.BP007 });
      }
    },
  },
  {
    id: "BP009",
    run(input, emit) {
      for (const set of input.sets) {
        if (set.update_count === 0) emit(set, { rule_id: "BP009", severity: "low", confidence: "high", message: RULE_MESSAGES.BP009 });
      }
    },
  },
] satisfies SetRule[]);

/**
 * BP008 needs every row of the batch at once: the same update name in more
 * than one set. It reports each row whose name another set also holds.
 */
export function duplicateNamesAcrossSets(input: EvaluationInput): ReadonlySet<string> {
  if (input.sets.length < 2) return new Set();
  const setsByName = new Map<string, Set<string>>();
  for (const update of input.updates) {
    let sets = setsByName.get(update.name);
    if (sets === undefined) setsByName.set(update.name, (sets = new Set()));
    sets.add(update.update_set);
  }
  const out = new Set<string>();
  for (const [name, sets] of setsByName) if (sets.size > 1) out.add(name);
  return out;
}
