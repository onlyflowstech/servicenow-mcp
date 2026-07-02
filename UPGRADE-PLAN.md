# @onlyflows/servicenow-mcp — Upgrade Plan (July 2026)

**Goal:** more efficient (tokens), faster (latency + agent-loop speed), better (capabilities, reliability, survival).

**Inputs:** deep read of this codebase (nightly), the unmerged `feature/servicenow-sdk-flow-integration` branch, echelon-ai-labs/servicenow-mcp (competitor), the official ServiceNow SDK (@servicenow/sdk 4.8.1 / Fluent), MCP spec revisions 2025-03-26 → 2026-07-28 RC, and ServiceNow platform changes through the Australia release (GA May 2026).

---

## Why now — three external clocks are ticking

1. **Basic Auth is being shut off.** ServiceNow's inbound Basic Auth restriction program is live: instance banners since **2026-06-03**, and per-instance hard 401 enforcement can be flipped any day (`glide.authenticate.basic_auth.restriction.enforce`). Our client is **basic-auth only** ([src/client.ts:21-23](src/client.ts)). Without OAuth, this server dies unpredictably in the field. (KBs: KB3025707, KB3055080, KB3096078.)
2. **MCP spec 2026-07-28 lands in ~4 weeks.** Stateless core, Extensions framework, new Tasks lifecycle, deprecation of Roots/Sampling/Logging. TypeScript SDK v2 GA lands the same day; v1 then gets ~6 months of bug fixes only. We're on the low-level `Server` API with hand-written JSON schemas — and our zod `^3.23` is already **below** SDK 1.29's peer range (`^3.25 || ^4.0`), a latent install break.
3. **ServiceNow shipped first-party competition.** Action Fabric's MCP Server Console (Zurich P9 / Australia P2, Now Assist Pro Plus+ licensing, assist-metered) owns the governed-execution lane and their marketing explicitly attacks homegrown Table-API servers. Our winnable lane: **pro-code developer/admin tooling** — scripts, ATF, schema/codesearch, direct CRUD, Fluent codegen — on any release, any auth, zero licensing, multi-instance.

---

## Phase 0 — Hygiene + safety net (days 1–3)

The repo has **zero tests**; the CI "test" stage only runs `npm run build`. Everything below refactors choke points every tool flows through, so this gates all other phases.

| # | Item | Effort |
|---|------|--------|
| 0.1 | **Vitest suite** for pure functions: zod schemas (valid/invalid per tool), `buildTableParams`, `formatError`, `ok`, the flow generator; HTTP-layer tests with mocked fetch (undici MockAgent) | M |
| 0.2 | **Make CI real**: test + typecheck + lint stages in .gitlab-ci.yml; snapshot test of the full `tools/list` output (guards the Phase 4 migration); tool-count assertion (registry length === README claim) | S |
| 0.3 | **Trust fixes**: package.json 1.0.0 vs index.ts "1.1.0" banner; "17 tools" vs 18 claims; delete dead `loadConfig()` (config.ts:19); unreachable branch delete.ts:65; sn_syslog `level=error` string-vs-numeric bug (syslog.ts:75 — the filter likely matches zero rows today); README markets `sn_script` which is a **stub** (script.ts:47-63) — label honestly now, implement in Phase 4 | S |
| 0.4 | **Escape user input interpolated into `sysparm_query`** (relationships.ts:103, atf.ts:99, discover.ts:57, attach, syslog) — a `^` in a CI name silently corrupts query semantics | S |

Echelon is the cautionary tale here: 11 advertised-but-nonexistent tools, tests importing a deleted module. Drift happens when nothing enforces consistency.

## Phase 1 — Token efficiency (weeks 1–2) → **−40–70% output tokens**

The single highest-ROI phase. Two choke points serialize every response.

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 1.1 | `ok()` → **compact JSON** (drop `null, 2` pretty-printing, utils.ts:11) + strip empty-string/null fields (ServiceNow records are full of them) | S | ~20–40% cut on every response |
| 1.2 | **Default field selection**: promote the `DEFAULT_FIELDS` per-table map that already exists in nl.ts:93-105 into a shared module; apply when `fields` is omitted in sn_query/sn_get; sn_create/sn_update return sys_id + changed fields, not the full record | M | The 10–40k-token default incident query becomes ~1–3k |
| 1.3 | **`response_format: 'concise' \| 'detailed'`** param (Anthropic tool-design guidance) + `max_response_bytes` truncation guard whose message states total count and the exact `fields=`/`limit=`/`offset=` args to fetch more | S | Escape hatch so trimmed defaults never trap the agent |
| 1.4 | **Pagination honesty**: stop discarding response headers (client.ts:141-169); read X-Total-Count; every list tool returns `{records, total, has_more, next_offset}` (the same contract the official SDK's `Connector.query` uses) | S–M | Kills blind re-query loops — tokens *and* round-trips |
| 1.5 | **Param tightening**: default `sysparm_exclude_reference_link=true` (reference fields currently return link+URL objects); `display_value` → enum `['true','false','all']`; `.int().min().max()` bounds on limit/offset/depth | S | Strips URL noise from every record |

## Phase 2 — Latency + client hardening (weeks 2–3)

All in the single choke point [src/client.ts](src/client.ts), plus four hot paths.

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 2.1 | **`AbortSignal.timeout`** (~30s default, per-profile configurable). Today a hung instance blocks a tool call **forever** | S | Bounds the p99; worst cliff in the codebase |
| 2.2 | **Retry with backoff** on 429/502/503 honoring `Retry-After` (2–3 attempts). ServiceNow commits rate-limit counts every ~30s/node → burst-then-block is expected behavior | S | Reliability under load |
| 2.3 | **Bounded parallelism (~5)**: sn_batch (up to **10,000 sequential** PATCHes today, batch.ts:106-128), sn_health "all" (~10 serial requests), codesearch (5 tables serially), sn_relationships (replace N+1 per-node class lookups with one `sys_idIN` query per depth level) | M | 5–10× wall-time on the slowest tools |
| 2.4 | **ServiceNow native Batch API** (`/api/now/v1/batch`, stable through Australia, currently unused) for bulk mutations; keep the concurrency pool as fallback | M | Fewer round-trips entirely |
| 2.5 | **Per-profile TTL cache** (5–15 min) for sys_dictionary schema, sn_discover app lists, table labels; deduplicate nl.ts's copy of schema introspection | M | Round-trip savings + foundation for field-suggestion errors and completions |

## Phase 3 — Auth survival (weeks 3–5; existential, parallel with Phase 4)

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 3.1 | **OAuth 2.0 client_credentials** (inbound support since Washington DC = every supported 2026 instance): token cache **with `expires_in` tracking** + single 401 retry-with-refresh; **never log token bodies** (echelon does all three wrong — easy to be strictly better) | M | **Critical** |
| 3.2 | **API-key auth** with configurable header (Inbound Authentication Profiles) in the same auth-provider abstraction | S | Med |
| 3.3 | **Basic-auth deprecation UX**: startup warning on basic profiles; on 401-with-basic return an actionable error citing KB3096078 and the exemption paths (WSAO account, `snc_basic_auth_api_access` role); optional health probe of `glide.authenticate.basic_auth.restriction.*` to warn before enforcement bites | S | Turns a future outage into a nudge |
| 3.4 | **Stop persisting plain-text passwords**: `sn_profile add` currently writes them to ~/.servicenow-mcp/config.json (profile-manager.ts:202-215); require the existing `env:VAR` indirection for secrets | S | Security |

## Phase 4 — MCP surface modernization (weeks 4–6)

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 4.1 | **Bump @modelcontextprotocol/sdk → 1.29.0 + zod → ^3.25** (fixes the latent peer-range break) | S | Enabler |
| 4.2 | **Migrate to `McpServer.registerTool`**, zod as single source of truth; delete every hand-written JSON-schema `definition` (19 tools × 2 schemas today = permanent drift risk); collapse the 17× duplicated `profile` param. **Hold SDK v2** until GA (~2026-07-28) + first patches — the McpServer API survives v2, so this makes that move mechanical | M–L | High |
| 4.3 | **Tool annotations**: `readOnlyHint` on query/get/aggregate/schema/discover/relationships/codesearch/syslog/health/atf-list; `destructiveHint` on delete/batch/script; `idempotentHint` on update; `openWorldHint` everywhere. Clients auto-approve read-only tools → removes a human permission prompt from every read — a bigger agent-loop latency win than any HTTP optimization | S | **High** |
| 4.4 | **Error ergonomics**: stop swallowing errors (discover.ts:97-119, codesearch.ts:97-99, relationships.ts:178-180, health.ts safeGet, atf.ts fallback chain) — return `warnings[]` so the model can distinguish "no results" from "permission denied"; SEP-1303 semantics (`isError: true` + actionable hints: 403 → name the missing role, invalid table → "use sn_discover", invalid field → suggest close matches from the schema cache) | M | High — fewer wasted agent turns |
| 4.5 | **outputSchema + structuredContent** on sn_query/sn_aggregate/sn_schema/sn_health/sn_discover | M | Med-High |
| 4.6 | **Identifier flexibility** (echelon's one great trick): sn_get/update/delete/attach accept `INC0010001`/`CHG…`/`KB…`/user_name/email and auto-resolve to sys_id | M | Saves a round-trip on nearly every targeted op |
| 4.7 | **Implement `sn_script` for real** (README already claims it; echelon's equivalent is vaporware; the official server doesn't expose it). Document ES2021/async-await on Zurich+ | M | Headline differentiator |
| 4.8 | **Retire `sn_nl`** (420-line regex parser in front of an LLM caller); keep TABLE_ALIASES/DEFAULT_FIELDS as shared data; fold its state-machine knowledge into tool descriptions as **recipes** (incident resolve = state 6 + close_code/close_notes; change approval; update-set commit; KB publish — with the caveat that state values vary per instance) | S | One less schema in every tools/list |
| 4.9 | **Progress notifications** (with `message`) for ATF runs (currently up to 300s silent), sn_batch, deploys. NOT the 2025-11-25 experimental Tasks API — the 2026-07-28 RC explicitly breaks it | S–M | Med |
| 4.10 | **Stateless-first profiles**: per-call `profile` param is canonical; `sn_profile switch` becomes documented sugar. Required before any HTTP transport (2026-07-28 stateless core; multi-client cross-talk) | S | High (forward-compat) |

## Phase 5 — The Fluent/SDK flagship (weeks 6–12) — the capability moat

ServiceNow has **no public REST API for flow authoring**; the SDK pipeline is the only supported pro-code path. No competitor has it (echelon: legacy `wf_workflow` only; official server: runtime execution only). ServiceNow's own SDK repo is mostly *agent skills* teaching Claude/Cursor to drive the CLI — they are betting on exactly the workflow our flow-create tool implements.

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 5.1 | **Re-integrate `sn_flow_create` on nightly, fixed**: rebase onto the ProfileManager registry (branch predates it); wire the **dead** `actionSchema` discriminatedUnion into `specSchema.steps` (flow-create.ts:85 — currently `z.array(z.any())`); **drop `@servicenow/sdk` from dependencies** (never imported at runtime — ~7,800 lock lines / 456 packages / 337MB / node>=20.18 engine conflict, pure dead weight); fix the description (`now-sdk install`, not "deploy") | M | High |
| 5.2 | **Retarget the generator to SDK 4.8.x**: 4.4.0's strictProperty enforcement can break 4.3-era templates (`^4.3.0` resolves to 4.8.1 today); emit stages, Try-Catch, DoInParallel, `wfa.subflow`, custom `Action()`, `internalName`; drop any `activate` flag (4.5.0 auto-publishes on install) | M | High |
| 5.3 | **CI compile-check of generated code**: scaffold a scratch Fluent project, run pinned `npx @servicenow/sdk@4.8.1 build` against every template's output. SDK releases monthly — this is the drift alarm | M | High |
| 5.4 | **`sn_sdk_deploy`** — the real deployment tool: ephemeral project → write .now.ts → `build` + `install` via **version-pinned npx subprocess** with `SN_SDK_NODE_ENV=SN_SDK_CI_INSTALL` + per-profile `SN_SDK_*` env vars. Subprocess isolation solves the node-engine mismatch, env-var races on concurrent multi-instance deploys, and keeps the core server at 3 dependencies. **Must** persist keys.ts per profile+scope (`--frozenKeys` — ephemeral projects mint fresh sys_ids and redeploys create duplicates). **Must** refuse/warn on prod-flagged profiles (docs forbid CI-style installs to production) | L | **Very high** |
| 5.5 | **`sn_fluent_docs`**: proxy `now-sdk explain` / the programmatic `scanDocs`/`search` (docs.d.ts explicitly blesses "runtime callers (e.g. agent tools)") with peek/summary modes — ~200 versioned authoritative topics; lets the agent write correct Fluent code we never templated | S–M | High |
| 5.6 | **`sn_ai_agent_create`**: generate `AiAgent`/`AiAgenticWorkflow` Fluent (mandatory securityAcl, tools, triggers; SDK ≥4.4) — hottest surface in the ecosystem, same pure-codegen architecture | M | High |
| 5.7 | **ATF test generation** (`Test()` + 11 `atf.*` namespaces) closing the loop with the existing sn_atf runner; surface Zurich's ATF Failure Insights alongside results | M | Med-High |
| 5.8 | **`sn_transform`** (brownfield): wrap `now-sdk init --from <sys_id>` + `transform` to pull existing instance apps into Fluent source — a consultancy story no Table-API tool offers | M–L | Med-High |

**Packaging decision:** the core server stays SDK-free forever. SDK tools shell out to pinned npx (or later: optional peerDependency + guarded `import('@servicenow/sdk/api')` with `LazyCredential` wired to profiles). Gate SDK tools out of `tools/list` when npx/SDK is unavailable.

## Phase 6 — Distribution, DX & positioning (weeks 8+, overlaps)

| # | Item | Effort |
|---|------|--------|
| 6.1 | **Streamable HTTP transport + Dockerfile** — after MCP SDK v2 GA stabilizes (avoid double migration). Echelon wins deployment mindshare on (deprecated) SSE alone; we leapfrog. Also lets ServiceNow's own MCP Client (Zurich P4+) call *us*. Trusted-network first; full OAuth resource-server compliance (RFC 8707, Origin validation) before advertising public remote deployment | M–L |
| 6.2 | **Per-profile tool gating** (echelon's tool-packages idea, fixed): config-driven allowlists — e.g. `readOnly: true` profile hides create/update/delete/batch/script. Host-config-driven; never advertise a runtime switch the model can't perform | S–M |
| 6.3 | **README truth + positioning pass**: our niche is developer/admin meta-tooling on any release/auth, zero Now Assist licensing, PDIs and pre-Zurich instances the official server can't serve, multi-instance profiles for consultancies. Frame flow tooling as *source-controlled flow generation* vs Action Fabric's *runtime execution*. Answer their "homegrown servers aren't production-ready" objection in writing | S |
| 6.4 | **DX scripts**: `--doctor` connection test, auth setup wizard (incl. the OAuth instance-setup gotchas: grant enablement, `glide.oauth.inbound.client.credential.grant_type.enabled=true`, service user Identity Type=Human), Claude Desktop/Code config snippet generator, PDI wake helper | M |
| 6.5 | **Eval corpus**: adapt echelon's ~90 per-domain NL example prompts into an integration eval suite against a PDI — evaluation-driven iteration is the top tool-design recommendation | M |

---

## What NOT to do

1. **Do not merge `sn_flow_deploy`** (commit 8e3658d). Raw Table-API inserts into sys_hub_flow bypass build-pipeline snapshot compilation and keys.ts identity — it publishes empty/broken flows and attaches action steps as a .txt file. It's already deleted in the working tree (stashed); commit that deletion. `sn_sdk_deploy` (5.4) is the only sane path.
2. **Do not ship `@servicenow/sdk` as a runtime dependency** — 52MB / 456 packages / 337MB node_modules, node>=20.18 conflict, never imported at runtime, and 4.8.1's own notes patched vulnerable transitive deps.
3. **Do not jump to MCP SDK v2 (or zod 4) before GA + first patches** (~2026-07-28). Refactor onto v1.29 McpServer now; v2 becomes mechanical.
4. **Do not build on the 2025-11-25 experimental Tasks API** — the 2026-07-28 RC explicitly breaks it. Plain progress notifications now.
5. **Do not add MCP logging/sampling/roots capabilities** — all three deprecated in the 2026-07-28 RC. stderr is spec-blessed for stdio.
6. **Do not copy echelon's 82-per-entity-tool sprawl** — schema token bloat, 5-file registration workflow, verifiable drift. Recipes in descriptions + at most 2–3 composite tools.
7. **Do not fabricate analytics** (echelon's `get_optimization_recommendations` returns `random.sample()` data as insights). Real Aggregate-API queries or nothing.
8. **Do not deepen hidden session state** — per-call parameters are the contract (stateless 2026-07-28 core, HTTP multi-client).
9. **Do not build protocol-level batching** (added 2025-03-26, removed 2025-06-18). Tool-level sn_batch on the Batch API is the right layer.
10. **Do not scrape servicenow.com/docs at runtime** — JS-rendered, 403s programmatic fetch. The SDK's versioned `explain` corpus is the reliable doc source.

---

## Sequencing

```
Days 1–3    Phase 0  hygiene + tests + CI          → safety net, ship v1.1.x patch
Weeks 1–2   Phase 1  token efficiency              → −40–70% output tokens
Weeks 2–3   Phase 2  timeouts/backoff/parallelism  → bounded p99, 5–10× hot tools
Weeks 3–5   Phase 3  OAuth/API-key/cred hygiene    → survives Basic Auth shutdown
Weeks 4–6   Phase 4  McpServer + annotations + errors (overlaps 3)
Weeks 6–12  Phase 5  Fluent/SDK flagship           → the moat
Weeks 8+    Phase 6  HTTP transport (post-v2 GA), gating, docs, evals
~Aug 2026   Re-evaluate: MCP SDK v2 GA + spec 2026-07-28 final → plan v2 migration
```

## Immediate housekeeping (already done / to do)

- ✅ Local repo synced: `nightly` checked out tracking `origin/nightly` (remote added `dev/nightly/beta/main` strategy + multi-instance profiles; the remote copy of the feature branch was deleted).
- ✅ Feature branch preserved locally: `feature/servicenow-sdk-flow-integration` (2 commits not in nightly: the Fluent generator + flow tools).
- ✅ WIP stash: `stash@{0}` holds the uncommitted deletion of `src/tools/flow-deploy.ts` on the feature branch.
- ⬜ On the feature branch: commit the flow-deploy deletion (it's the correct call), then treat the branch as raw material for Phase 5 (rebase onto nightly, don't merge as-is).
