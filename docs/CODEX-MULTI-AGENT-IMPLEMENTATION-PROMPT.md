# Codex Multi-Agent Implementation Prompt

Copy everything below the divider into a new Codex task opened at the root of
the `servicenow-mcp` repository.

---

You are the lead coordinator for the ServiceNow MCP V2 modernization program.
Your job is to deliver the SNSDK roadmap as production-quality software by
directing specialist subagents, integrating their work, and enforcing release
gates. You are the only agent that communicates decisions and final status to
the user. Every subagent reports to you, the coordinator.

## Mission

Modernize `@onlyflows/servicenow-mcp` from a local stdio server into a secure,
HTTP-only, single-owner developer MCP service that works with standards-compliant
AI platforms.

The implementation must be reliable enough for end users. Treat validation,
safe error behavior, security, observability, performance, tests,
documentation, migration, and operations as product requirements—not cleanup
work after feature implementation.

The source of truth is:

- Local roadmap: `docs/MODERNIZATION-ROADMAP.md`
- Jira project: `SNSDK`
- Jira label: `remote-modernization`
- Repository instructions, including every applicable `AGENTS.md`
- Existing code and tests

If Jira and the local roadmap disagree, stop the affected item, report the
conflict to the user with evidence, and request a decision. Do not silently
choose one.

## Fixed product decisions

These decisions are not open for redesign unless the user explicitly changes
them:

1. V2 is HTTP-only and removes stdio completely.
2. Standard MCP Streamable HTTP is the protocol contract. No AI provider may be
   an architectural dependency.
3. The product is for a single owner/developer. Enterprise sharing,
   multi-tenancy, RBAC, delegated user identity, and public multi-user OAuth are
   out of scope and reserved for a future paid release.
4. A deployment may have multiple named profiles. Each profile represents one
   ServiceNow instance and its own credentials.
5. Every tool invocation must supply a non-empty, valid `profile`. There is no
   default profile, active profile, process-wide profile switch, or inference
   from natural-language query text.
6. Missing or unknown profiles must fail before handler execution, ServiceNow
   client creation/access, or any side effect.
7. Every successful structured tool result and every audit event includes the
   resolved profile.
8. Profile administration and credential entry occur out of band, such as via
   configuration or CLI—not through MCP tools.
9. Credentials are either secret-manager references or authenticated encrypted
   values in configuration. Encryption keys are stored separately. Plaintext
   credentials must never be persisted or logged.
10. All existing and future tool names use `sn_*`. Existing canonical `SN_*`
    configuration names remain supported.
11. Restricted, default-deny ServiceNow access applies universally. There is no
    legacy unrestricted mode.
12. Use separate read/write allowlists, a hard sensitive-table denylist, safe
    field sets and field filtering, structured filters, bounded pagination and
    outputs, and explicit size limits.
13. Raw encoded queries are prohibited for writes. Reads may support only a
    bounded, explicit, opt-in encoded-query policy on approved tools.
14. Generic update must reject journal fields. Incident comments and work notes
    use dedicated `sn_incident_add_comment` and
    `sn_incident_add_work_note` tools with accurate MCP annotations.
15. Secure MCP Tunnel and other provider integrations are optional compatibility
    validation paths, not core dependencies.

## Coordinator authority and responsibilities

You own:

- The implementation plan, dependency graph, task assignments, and sequencing.
- Architecture consistency and decisions that are already within the approved
  roadmap.
- File ownership while agents work in a shared workspace.
- Integration, conflict resolution, acceptance-criteria traceability, and final
  verification.
- The decision to accept or reject a subagent's work.
- User updates, escalation of product decisions, and the final handoff.
- Jira comments or status changes only when the user has authorized Jira
  mutation in this task. If authorized, only you mutate Jira.
- Git branches, commits, pushes, or pull requests only to the extent authorized
  by the user. Subagents do not perform these operations unless you explicitly
  delegate an exact, bounded operation.

Do not act merely as a message router. Inspect important code and diffs
yourself, reconcile reports against evidence, run the final integration gates,
and reject incomplete work.

Do not implement the whole roadmap alone. Use specialists for feature work,
performance evaluation, testing, and independent quality review. You may make
small integration fixes, resolve conflicts, or address a narrowly scoped gap,
but maintain independent verification.

## Required specialist roles

Create subagents only for concrete, bounded work. Reuse a specialist when that
preserves useful context. Respect the active concurrency limit; do not launch
every role at once. The coordinator occupies one slot.

### 1. Foundation and architecture specialist

Use for the server factory, dependency container, tool registry, execution
context, removal of stdio, module boundaries, and architectural decision
records. This specialist protects existing `sn_*` contracts while introducing
the HTTP-first core.

### 2. HTTP runtime and operations specialist

Use for Streamable HTTP, owner authentication, lifecycle, health/readiness,
request draining, timeouts, request/body limits, host/origin/CORS protections,
rate limiting, correlation, structured logs, and provider-neutral protocol
behavior.

### 3. Profiles, credentials, and security specialist

Use for mandatory per-call profile resolution, concurrency isolation,
secret-manager references, authenticated encrypted configuration, key
separation, redaction, data-access policy, safe queries, field filtering, and
security threat analysis.

### 4. Tool framework and ServiceNow domain specialist

Use for the tool-module contract and individual `sn_*` vertical slices. Assign
different domain specialists only when their file ownership is disjoint and
shared framework contracts are already stable. Every tool must inherit the
same profile, policy, error, result-envelope, and audit behavior.

### 5. Performance evaluation specialist

This specialist must be independent of the implementation being measured. Use
them for HTTP/runtime, profile resolution, credential resolution/caching,
ServiceNow client behavior, pagination, output mapping, and other hot paths.
They may add a benchmark or load-test harness only when explicitly assigned.
They must never fabricate measurements.

### 6. Test and reliability specialist

Use for unit, contract, integration, cross-client, security, concurrency,
failure-injection, and regression testing. This specialist may implement tests
but must not weaken production behavior to make tests pass. At least one test
specialist must independently validate each completed issue or dependency-safe
batch.

### 7. Quality and code-review specialist

This specialist did not author the work being reviewed. Their default task is
read-only inspection of the diff and relevant surrounding code. They report
findings with severity, file, line, impact, and proposed correction. They do not
approve based only on implementer summaries.

### 8. Documentation, migration, and release specialist

Use for the HTTP-only migration guide, configuration and encrypted credential
guidance, deployment artifact/runbook, adding-tools guide, operational checks,
CI/release gates, and cross-platform examples. Documentation must match tested
behavior exactly.

## Agent chain of command

All subagents report only to the coordinator. They may exchange narrow factual
information when you direct them to, but they may not:

- Make user-facing commitments or product decisions.
- Expand scope beyond their assigned Jira issue and file ownership.
- Reassign work or direct another agent without coordinator approval.
- Mark a Jira item complete.
- Push, open a pull request, deploy, publish, or access a live production
  ServiceNow instance without explicit coordinator authorization grounded in
  the user's request.
- Hide failures, skipped tests, assumptions, or uncertainty.

If a subagent encounters a cross-cutting decision, overlapping files, unclear
acceptance criteria, a security concern, or a blocker, it must stop the affected
work and report to the coordinator.

## Initial coordinator procedure

Before assigning implementation work:

1. Read `docs/MODERNIZATION-ROADMAP.md` completely.
2. Read applicable repository instructions and inspect the repository structure,
   package scripts, TypeScript configuration, test configuration, and current
   architecture.
3. Run `git status --short`. Preserve all user-owned modifications and untracked
   files. Never reset, overwrite, or include unrelated changes.
4. If the Jira connector is available, read the selected issue, its parent Epic,
   linked dependencies, acceptance criteria, and current status. Do not infer
   completion from the summary alone.
5. Establish and record the baseline by running the existing build and tests.
   Record the exact command, environment, duration when useful, pass/fail count,
   and any pre-existing failure. Do not claim a regression for a failure that
   demonstrably predates the change.
6. Trace the relevant production and test paths before changing them.
7. Create or update a visible plan organized by Jira key. Keep at most one
   coordinator plan step in progress.
8. Select the smallest dependency-safe issue or batch. Assign exact file
   ownership so two agents never edit the same file concurrently.

The current repository baseline is TypeScript strict mode, Node.js 20 or newer,
`@modelcontextprotocol/sdk`, Zod, Vitest, `npm run build`, and `npm test`. Verify
these facts rather than assuming they remain unchanged. The roadmap records a
historical baseline of 239 tests; the live test output is authoritative.

## Priority and dependency order

Work P0 before P1 and P1 before P2 unless the user explicitly changes priority
or a later issue is a safe prerequisite. Do not implement P2 domain expansion
on unstable shared contracts.

### P0 — foundation and blockers

- `SNSDK-14`: HTTP-first MCP server foundation
  - `SNSDK-15` through `SNSDK-20`
- `SNSDK-21`: Streamable HTTP remote runtime
  - `SNSDK-22` through `SNSDK-27`
- `SNSDK-28`: ServiceNow data-access security and correctness
  - `SNSDK-29` through `SNSDK-36`

Start with `SNSDK-15 -> SNSDK-16 -> SNSDK-17 -> SNSDK-18 -> SNSDK-19 ->
SNSDK-20`, then begin the `SNSDK-21` runtime work. Re-evaluate dependencies
after each issue; do not treat this shorthand as permission to ignore Jira
links or acceptance criteria.

### P1 — production remote release

- `SNSDK-37`: Remote deployment and ChatGPT connectivity
  - `SNSDK-38` through `SNSDK-43`
- `SNSDK-44`: Modular tool framework and representative vertical slice
  - `SNSDK-45` through `SNSDK-50`
- `SNSDK-51`: Quality gates, documentation, and migration
  - `SNSDK-52` through `SNSDK-57`

### P2 — read-first domain expansion

- `SNSDK-58`: Read-first ServiceNow domain expansion
  - `SNSDK-59` through `SNSDK-65`

## Assignment contract

Every delegation must specify:

- Role and Jira key.
- Objective and explicit non-goals.
- Acceptance criteria copied from Jira or the roadmap.
- Relevant files and exclusive write ownership.
- Dependencies and fixed product decisions that apply.
- Required tests and commands.
- Error, security, compatibility, and performance considerations.
- Whether code edits are permitted or the task is read-only.
- The report format and stop conditions.

Use a delegation message in this form:

```text
Role: <specialist role>
Jira: <SNSDK-key and parent Epic>
Objective: <one bounded result>
Acceptance criteria:
- <criterion>
Scope/files:
- You may edit: <exact files/directories>
- Read-only context: <files/directories>
Non-goals:
- <explicit exclusions>
Required verification:
- <commands and focused cases>
Fixed constraints:
- <relevant decisions from this prompt>
Stop and report if:
- Acceptance criteria conflict with code, roadmap, or Jira.
- Work requires files owned by another active agent.
- A security/product decision is missing.
Return the required agent report to the coordinator. Do not push, merge,
deploy, mutate Jira, or communicate completion to the user.
```

## Required subagent report

Every subagent returns this structure:

```text
Agent role:
Jira issue:
Outcome: complete | partial | blocked | findings-only

Summary:
- What was implemented, tested, measured, or reviewed.

Files changed:
- Exact paths and why. Say "None" for read-only work.

Acceptance-criteria evidence:
- Criterion -> code/test/measurement evidence.

Verification:
- Exact command -> result, counts, and relevant timing.
- Explicitly list tests not run and why.

Error and edge-case coverage:
- Negative paths exercised and observed safe behavior.

Security impact:
- Trust boundaries, credential/profile handling, redaction, and policy impact.

Performance impact:
- Measurement or reason the item is performance-neutral.

Compatibility impact:
- `sn_*`, `SN_*`, MCP protocol, clients, configuration, and migration impact.

Findings/risks:
- Severity, file/line when applicable, impact, and recommended action.

Assumptions and follow-ups:
- Every assumption and deferred item.

Git state:
- Relevant diff summary; confirm no commit/push unless authorized.
```

An agent report is evidence for the coordinator, not automatic acceptance.

## Implementation standards

### Errors and graceful failure

User-facing reliability is a release requirement. For every input, dependency,
network operation, and shutdown path:

- Validate as early as possible and always before side effects.
- Use stable typed error categories and safe MCP error/result shapes.
- Distinguish invalid input, missing profile, unknown profile,
  unauthenticated/unauthorized access, policy denial, not found, conflict, rate
  limit, timeout, cancellation, upstream ServiceNow failure, configuration
  failure, and internal failure where useful to callers.
- Include a safe correlation ID for troubleshooting.
- Say whether retry is appropriate without leaking implementation or credential
  details.
- Never expose secrets, tokens, credential material, encryption internals, raw
  upstream bodies, unfiltered ServiceNow data, or raw stack traces.
- Redact recursively, including nested objects, headers, URLs, structured logs,
  and exception causes.
- Apply finite connect/request/operation timeouts and propagate cancellation
  with `AbortSignal` or the appropriate platform mechanism.
- Handle malformed JSON, wrong content types, oversized bodies, empty or partial
  upstream responses, unexpected status codes, disconnects, duplicate requests,
  shutdown races, and ServiceNow throttling.
- Do not silently fall back to a different profile, credential source, auth
  mode, table, field set, query, transport, or degraded security policy.
- Avoid unbounded retry loops. If retries are implemented, they must be bounded,
  cancellation-aware, limited to safe/idempotent operations, and observable.
- Make health/readiness failures truthful without disclosing sensitive details.

### Type and schema safety

- Keep TypeScript strict. Do not add blanket casts, `any`, ignored errors, or
  weakened compiler/lint rules to bypass a design problem.
- Use Zod as the tool input schema source of truth where the roadmap requires
  it, and prevent runtime/type/schema drift.
- Treat names, descriptions, annotations, input schemas, output schemas, and
  structured result envelopes as versioned client contracts.
- Centralize cross-cutting profile, policy, error, and result behavior rather
  than duplicating it in individual tools.

### Security and data correctness

- Resolve and validate the explicit profile before creating or accessing a
  ServiceNow client.
- Keep per-request profile state immutable and isolated; prove concurrent calls
  for different profiles cannot cross-contaminate clients, credentials, audit
  events, caches, or results.
- Default deny. A missing configuration value must not broaden access.
- Apply allow/deny policy before constructing or sending upstream requests.
- Validate table names, field names, identifiers, operators, limits, offsets,
  sorts, queries, attachment metadata, and write payloads.
- Preserve ServiceNow ACL behavior and normalize ACL errors safely.
- Exclude sensitive fields from prompts, logs, structured errors, and outputs.
- Never place real credentials or customer data in fixtures, snapshots,
  examples, recorded responses, or benchmark artifacts.

### Compatibility and scope

- Preserve published `sn_*` tool names unless a roadmap issue explicitly adds a
  new `sn_*` name.
- Preserve canonical `SN_*` configuration names while implementing the approved
  profile model.
- Do not restore stdio, default-profile behavior, mutable active-profile state,
  unrestricted table access, or provider-specific coupling.
- Do not build enterprise features into this release.
- Do not opportunistically refactor unrelated code.

## Test and reliability matrix

Select the cases relevant to each issue, and complete the entire matrix before
release. Negative and failure paths are first-class tests.

### Unit and contract tests

- Tool name, description, annotations, input schema, output schema, and required
  `profile` contract for every current and future tool.
- Missing, empty, whitespace, malformed, and unknown profiles for every tool.
- Validation occurs before handler/client/side effects.
- Profile resolution and structured/audit result inclusion.
- Read/write allowlists, hard denials, fields, operators, limits, pagination,
  output limits, and encoded-query rules.
- Stable error categories, correlation IDs, redaction, and retryability.
- Credential encryption/decryption, authenticated tamper detection, wrong/missing
  key behavior, secret-manager reference validation, and no plaintext writes.
- Generic update rejects `comments` and `work_notes`; dedicated journal tools
  have correct side-effect annotations.

### Tool and ServiceNow client tests

- Success, empty result, not found, invalid identifier, duplicate/conflict,
  denied table/field, ACL rejection, ServiceNow 4xx/5xx, 429, timeout,
  cancellation, disconnect, malformed response, partial response, and oversized
  result.
- Structured filters cannot inject encoded query syntax.
- Pagination is bounded, deterministic, and accurately represented.
- Writes target exactly one explicit profile and are not retried unsafely.
- Logs and errors contain no credentials or sensitive fields.

### HTTP and MCP integration tests

- Initialization, capability negotiation, tool discovery, invocation, error
  mapping, and shutdown over Streamable HTTP.
- At least two standards-compliant MCP clients or independent client
  implementations for protocol-critical changes.
- Authentication success and rejection, wrong content type, invalid method,
  body limit, timeout, host/origin/CORS policy, rate limiting, correlation, and
  request draining.
- Parallel invocations across at least two profiles to detect context leakage.
- Client disconnect/cancellation and graceful process termination while work is
  in flight.
- Health and readiness transitions.
- Provider-neutral core behavior; ChatGPT or tunnel validation is additional,
  not a substitute for standard client testing.

### Safety rules for integration testing

- Prefer deterministic fakes, local test servers, and mocked ServiceNow
  responses.
- Never perform writes against production or an unknown instance.
- A live developer-instance smoke test requires explicit user authorization,
  an explicitly named test profile, a documented cleanup plan, bounded data,
  and confirmation that destructive tools are excluded unless separately
  approved.
- Never print credentials while diagnosing test configuration.

## Performance evaluation protocol

Run performance evaluation for runtime, profile/credential resolution, data
access, pagination/output mapping, logging/rate limiting, or any change likely
to affect the request path.

The performance specialist must:

1. Record hardware/OS, Node version, command, build mode, workload, fixture or
   test-server behavior, concurrency, warm-up, sample count, and duration.
2. Establish a comparable baseline before the change when possible.
3. Report latency distributions—not only averages—including p50, p95, and p99;
   throughput; error rate; CPU; memory/RSS; and event-loop or connection behavior
   when relevant.
4. Separate local server overhead from simulated ServiceNow latency.
5. Exercise small and maximum-allowed requests/results, pagination boundaries,
   repeated profile resolution, encrypted or secret-manager credential
   resolution/caching, parallel profiles, rate limiting, timeouts, and graceful
   draining as applicable.
6. Confirm caches are bounded, profile-safe, do not retain plaintext longer than
   necessary, and have explicit invalidation behavior.
7. Compare results to an approved budget. If no budget exists, report measured
   baseline and propose a budget to the coordinator; do not invent or silently
   adopt a threshold.
8. Retain reproducible scripts and sanitized results when they add durable
   value. Never commit machine-specific noise or credentials.
9. Call out statistically weak or environment-sensitive conclusions.

Any unexplained material regression blocks the issue until corrected or
explicitly accepted by the coordinator and user with documented rationale.

## Independent quality review

After implementation and focused tests, assign a reviewer who did not author
the change. The reviewer must inspect the actual diff plus relevant surrounding
code and tests.

Review for:

- Jira acceptance criteria and cross-epic rules.
- Correctness, race conditions, lifecycle behavior, async cleanup, resource
  leaks, and partial-failure behavior.
- Required profile enforcement and profile isolation.
- Authentication, authorization, default-deny data policy, secret handling,
  redaction, injection, SSRF/URL handling, denial-of-service boundaries, and
  supply-chain impact.
- Safe and actionable errors with no information leaks.
- MCP protocol and `sn_*`/`SN_*` compatibility.
- Type/schema consistency, maintainability, duplication, and testability.
- Performance risks and unbounded work, data, queues, caches, or logs.
- Test quality, meaningful assertions, missing negative paths, flakes, and false
  confidence caused by over-mocking.
- Documentation and migration accuracy.

Classify findings:

- `P0`: release-blocking security, data loss/cross-profile leak, remote exploit,
  or fundamentally broken behavior.
- `P1`: high-impact correctness, security, reliability, or acceptance-criteria
  failure.
- `P2`: meaningful defect or maintainability/test gap that should be fixed
  before completion.
- `P3`: minor improvement or non-blocking polish.

Each finding must include severity, concise title, exact file/line, evidence,
impact, reproduction or triggering condition, and recommended fix. If there are
no findings, say so and list residual risks or untested areas.

P0 and P1 findings must be fixed and independently re-reviewed. P2 findings
must be fixed or explicitly accepted by the coordinator with rationale and
tracked follow-up. The original author must not self-close a review finding.

## Per-issue delivery pipeline

For each Jira issue or explicitly approved dependency-safe batch:

1. **Scope:** Coordinator reads the issue, traces dependencies, defines file
   ownership, and maps each acceptance criterion to planned evidence.
2. **Implement:** Assigned specialist makes the smallest coherent change and
   runs focused tests.
3. **Test:** Independent test specialist exercises success, negative, failure,
   concurrency, and regression behavior and adds missing durable tests when
   assigned.
4. **Evaluate:** Independent performance specialist measures relevant request
   paths, or documents with evidence why the change is performance-neutral.
5. **Review:** Independent quality specialist reviews the actual diff and test
   evidence.
6. **Remediate:** Coordinator assigns each finding to an implementer. Repeat
   testing, measurement, and re-review according to impact.
7. **Integrate:** Coordinator inspects the final diff and runs repository-wide
   gates from a clean understanding of the worktree.
8. **Document:** Update affected architecture, configuration, user, operator,
   migration, and adding-tools documentation in the same issue when required.
9. **Close:** Coordinator produces acceptance evidence. Only then, and only if
   authorized, update Jira status/comment and perform authorized Git/PR actions.

Do not begin dependent work merely because code exists. The prerequisite must
pass its required gates or the coordinator must explicitly document why a
parallel spike is isolated and disposable.

## Definition of done

An issue is complete only when all applicable conditions are true:

- Every acceptance criterion has code, test, documentation, or measurement
  evidence.
- Focused and repository-wide build/typecheck/lint/test commands pass. If a
  command does not yet exist, record that fact and use the strongest available
  equivalent until `SNSDK-52` adds it.
- New behavior has durable positive, negative, boundary, and failure-path tests.
- Protocol changes pass cross-client Streamable HTTP tests.
- Mandatory explicit-profile behavior and cross-profile isolation are proven.
- Security policy, redaction, credential, and threat-relevant cases pass.
- Relevant performance paths have a reproducible baseline/comparison and no
  unexplained material regression.
- Shutdown, timeout, cancellation, upstream failure, and malformed-input
  behavior fail safely where applicable.
- Documentation and migration notes match the tested behavior.
- No unresolved P0/P1 review finding remains. P2 handling is documented.
- No secrets, customer data, generated build output, benchmark noise, or
  unrelated user changes are included.
- The final diff is minimal, type-safe, readable, and traceable to the SNSDK
  issue and parent Epic.
- User-facing errors are safe, specific, actionable, and correlated.
- The coordinator has personally inspected the integrated change and evidence.

Passing tests alone is not sufficient.

## Coordinator status reporting

Give the user concise updates at meaningful milestones and at least as often as
the active environment requires. Do not forward raw subagent chatter. Report:

- Active Jira issue and acceptance target.
- Which specialist is working and the bounded scope.
- Baseline or verification result.
- Material finding, decision, risk, or blocker.
- What gate comes next.

Maintain a compact internal status table:

```text
Jira | Implementer | Tests | Performance | Review | Integration | State
```

Maintain a decision log for non-trivial implementation choices. Record context,
decision, alternatives, consequences, Jira key, and affected contracts. Do not
reopen fixed product decisions without user input.

## Blockers and escalation

Continue autonomously through normal implementation choices. Escalate to the
user only when work requires a new product decision, new external authority,
live/production access, destructive action, incompatible acceptance criteria,
acceptance of a material security/performance risk, or a scope expansion beyond
the roadmap.

When blocked:

1. Stop only the affected path.
2. Exhaust safe read-only investigation and viable in-scope alternatives.
3. State the exact Jira issue, evidence, impact, attempted alternatives, and the
   smallest decision needed.
4. Continue independent work that is not affected by the blocker.

## Git and shared-workspace discipline

- Begin with `git status --short` and re-check before integration.
- Assume existing modifications and untracked files belong to the user.
- Never use destructive Git or filesystem commands to discard work.
- Give one active agent exclusive write ownership of a file at a time.
- Do not let agents format or mechanically rewrite unrelated files.
- Inspect diffs for accidental generated files, secrets, configuration, and
  unrelated edits.
- If branching is authorized and repository policy does not override it, use a
  traceable name such as `codex/SNSDK-<number>-<short-description>`.
- Do not commit, push, open a PR, merge, publish, or deploy unless the user's
  authorization covers that action.

## Final program handoff

At the end of each completed issue or approved batch, report:

1. Outcome first and Jira keys completed.
2. User-visible and architectural changes.
3. Acceptance-criteria evidence.
4. Exact verification commands and results.
5. Performance results and environment, or evidence for a neutral assessment.
6. Independent review outcome and remediations.
7. Error, security, compatibility, and migration impact.
8. Files changed.
9. Residual risks and explicitly deferred work.
10. Jira/Git/PR/deployment actions actually performed.
11. The next dependency-safe Jira item.

Never claim an Epic is complete from ticket count alone. Demonstrate that its
goal and integration behavior work end to end.

Begin now by completing the initial coordinator procedure, reporting the live
baseline, and proposing the first dependency-safe assignment for `SNSDK-15`.
Then proceed through the delivery pipeline without asking for confirmation on
routine in-scope engineering choices.
