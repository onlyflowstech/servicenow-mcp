# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Release candidates publish to `next`.** A `vX.Y.Z-rc.N` tag (cut on the
  `test` branch by convention) now publishes to the `next` dist-tag. Stable and
  `-dev.N` tags are unchanged, and every other prerelease suffix is still
  rejected.

### Security

- **Container base image.** The runtime base,
  `gcr.io/distroless/nodejs22-debian13:nonroot`, moves to a newer digest whose
  `zlib1g` is 1:1.3.dfsg+really1.3.1-1+deb13u1 and whose Node is 22.23.4,
  clearing CVE-2026-76844 and CVE-2026-85091 from the `container-release`
  scan. The image serves the dormant HTTP transport and is not published.
- **HTTP server dependencies.** `@hono/node-server` moves from 2.1.3 to 2.1.7
  and `hono` (transitive, through the MCP SDK) from 4.13.13 to 4.13.18,
  clearing the advisories that `npm audit --omit=dev` reported:
  GHSA-qv5m-9pm6-hqp3 and GHSA-jpvv-r467-5p4w in `@hono/node-server`, and
  GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq, GHSA-3gg2-335m-rxc6,
  GHSA-4h7h-rv7c-7m2v and GHSA-46wx-v44x-9hh2 in `hono`. The same releases
  also carry the fixes for GHSA-7v5p-43qr-wch5 and GHSA-fj57-4f93-cfw6
  (`@hono/node-server`) and GHSA-92p4-j3wq-jmqx, GHSA-39q9-qp46-w8xg and
  GHSA-74fm-fwc7-3fwp (`hono`). The `tools/inspector` lock moves to `hono`
  4.13.18 and `@hono/node-server` 2.1.8. In the published package, only the
  dormant HTTP transport uses these packages. One behaviour
  change: a request to `/mcp` whose raw path contains a backslash (for example
  `\mcp`, which the server's own path check reads as `/mcp`) now gets 400 Bad
  Request.

## [2.2.0] — 2026-10-30

2.2.0 is the first stable release since 2.1.0. It contains everything
published on the `dev` channel as 2.2.0-dev.1 through 2.2.0-dev.6 (listed
under those versions below) plus the changes in this section. Numbers in
parentheses are the pull requests that made each change.

> **Upgrade every install: this release fixes a denial-of-service
> vulnerability.** A single oversized or deeply nested request could make the
> server exhaust its memory and stop. See **Security** below.
>
> **Read this before upgrading.** 2.2.0 can stop a working install from
> starting, and it changes what some profiles may write:
>
> - The server refuses to start while `SN_FIELD_POLICY_DEFINITIONS` is set and
>   `~/.servicenow-mcp/config.json` exists.
> - A malformed or ambiguous field policy in `config.json` now stops the whole
>   file from loading. The server, `servicenow-mcp-setup` and
>   `servicenow-mcp-profile` all refuse it until you fix it by hand.
> - `sn_create`, `sn_update` and `sn_batch` can append `comments` and
>   `work_notes` on every table a profile may write. Leaving the dedicated
>   journal tools off a target no longer withholds journals.
> - `sn_create` and `sn_update` writes to `incident` are no longer limited to
>   14 typed fields: every field the profile's field policy allows, such as
>   `watch_list`, can now be written.
> - `["*"]` in a field set now means every field. A profile that used it, and
>   so failed every call, becomes fully open.
> - `readable: []` no longer blocks writes to its table. Add `writable: []` to
>   keep writes blocked.
>
> [Upgrading to 2.2.0](docs/V2-MIGRATION.md#upgrading-to-220) lists every case
> with its remedy.

### Security

- **Denial-of-service fix: oversized requests are rejected before
  validation.** A single very large or deeply nested request could make
  the server use far more memory and time than its size suggests, until it
  stopped responding. Every
  incoming message, over stdio and HTTP, now passes plain structural checks
  before any schema runs, and one outside the limits is rejected with a short,
  fixed error. The limits admit the largest call any tool accepts, so
  legitimate calls are not affected. (#16)
  - Messages: arrays of at most 10,000 elements, at most 52,176 array
    elements and object members in total, and at most 32 levels of nesting.
    Over HTTP such a message gets a 400 with JSON-RPC error `-32600`
    `Request exceeds structural limits.`; over stdio a request with a usable
    id gets the same error, and anything else is dropped.
  - Tool arguments: at most 52,112 array elements and object members.
  - `structured_query`: at most 2,048 values, 12 levels deep, arrays of 32,
    objects of 8 keys, 64 conditions and 65 groups. Any query the compiler
    accepts is within these.
  - Existing collection limits (`sn_atf_author` `steps` and `test_sys_ids`,
    `structured_query` `order_by`, group `conditions`, set `values`, ATF
    name-value inputs) are checked before any element is parsed.
- **Dependency advisories.** `zod` moves to 4.6.7, pinned exactly
  (GHSA-mrhx-c7xc-m3w5, CVE-2023-54404; no 3.x release is fixed).
  `@modelcontextprotocol/sdk` moves to 1.32.2 (GHSA-22jm-h49p-29qw,
  GHSA-6prh-2h8m-c8cw, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq, and
  GHSA-6qxp-vccf-f47h in the SDK's client-side OAuth flow, which this server
  does not use). `body-parser` (GHSA-27r3-jxmh-p828), `fast-uri`
  (GHSA-w74x-v6f9-j3xg), `hono`, `iconv-lite`, `ip-address`, `proxy-addr`
  (GHSA-jqcg-44mw-7w3h, critical) and `qs` take their fixed releases, and `npm audit --omit=dev` reports nothing. The
  container's runtime base, `gcr.io/distroless/nodejs22-debian13:nonroot`, is
  pinned to a digest with `libssl3t64` 3.5.7-1~deb13u3 (CVE-2026-84782) and
  Node 22.23.3. (#10, #16)
  - *`@hono/node-server` 2.1.3* (GHSA-rmxm-3fg6-px4f, medium). Its
    `serveStatic` decoded the request path twice, so a crafted path could skip
    middleware mounted on a static prefix. This server never uses
    `serveStatic`: the SDK's HTTP transport uses only the adapter's request
    listener, and the stdio server does not load the adapter at all. The
    upgrade keeps `npm audit` clean. The developer-only inspector's lockfile
    moves to 2.1.5.
- **Redirects are no longer followed.** API calls and the OAuth token request
  used to follow HTTP redirects: a cross-origin redirect forwarded an API-key
  header, and a 307 re-sent the token request body, which holds the client
  secret. Any 3xx now fails with "The instance redirected the request to
  another location", without echoing the `Location`. (#15)
- **Omitting the journal tools no longer withholds journals.** A profile that
  grants `sn_create`, `sn_update` or `sn_batch` on a table can now append
  `comments` and `work_notes` there, and `sn_batch` can post one
  customer-visible comment per matched record, each of which can send a
  notification. To withhold comments, set `fieldPolicy.<table>.writable` to an
  explicit list without `comments`, and narrow parent tables such as `task`
  the same way. (#11)
- **Journal writes are never re-sent.** The HTTP client no longer retries a
  `PATCH` or `PUT` that sets `comments` or `work_notes` after a 502, 503, 504
  or connection error, because the first attempt may already have appended
  the entry. A 429 is still retried and a 401 still refreshes once. Detection is by field
  name (`comments`, `work_notes`); see
  [Production security boundaries](docs/PRODUCTION-SECURITY.md#journal-content). (#11)
- `servicenow-mcp-setup grant` applies its default tools only to the tables,
  and the operations, named in that command. A re-grant could widen a target
  narrowed with `--tools`, or make a table reachable only as a related table
  directly readable or writable. (#11)
- `sn_batch` targets each matched record once per run and stops at a 401
  instead of retrying every remaining record with rejected credentials. It
  always looks up its records on the instance, never in the metadata cache, so
  a repeat run cannot act on an earlier run's matches. (#9, #11)
- **Metadata cache.** The cache no longer reads `sys_user` or
  `sys_properties`; remove any read grant on either table that you added only
  for it, because `sys_properties` rows can hold integration secrets. Cache
  entries are partitioned by credential, not by the ServiceNow user it runs
  as: after re-mapping a client-credentials application or API key to another
  user, or restricting that user, restart the server or rotate the secret.
  Table and field policy still apply on every call, cached or not. Until an
  entry is refetched, a tightened ServiceNow ACL is not seen: by default up to
  24 hours for metadata (configurable to 7 days) and 5 minutes for
  `sn_schema`. `sn_schema`
  returns `inherited_from` only where the profile can read `super_class` on
  `sys_db_object`. (#9)
- **`sn_flow_view` reads `sys_variable_value` and `var_dictionary`.**
  `sys_variable_value` is a system table, so a profile's `"*"` field-policy
  entry does not narrow it; name it to hide older flows' input values. Grant
  the flow tables with `tools: ["sn_flow_view"]`, as `grant --flows` does, to
  keep the generic read tools off them. See
  [docs/FLOW-VIEW.md](docs/FLOW-VIEW.md#field-policy). (#18)

### Added

- **`sn_flow_view`, the 24th tool.** It shows one Flow Designer flow or
  subflow as a Mermaid diagram, a numbered outline and a structured graph:
  trigger, steps, If / Else If / Else, loops, parallel branches, Try / Catch,
  input values and data pill labels, and the subflows it calls to depth 3. It
  is read-only, reads 15 `sys_hub_*` and variable tables through the Table API
  under the profile's table and field policy, and never calls Flow Designer's
  internal API. Input values are shown by default, with sensitive names and
  password types redacted; `include_inputs: false` reads no values. The
  result fits `max_response_bytes` (default 100,000). See
  [docs/FLOW-VIEW.md](docs/FLOW-VIEW.md). Thanks to Jace Benson's `jsn` CLI,
  whose flow inspection informed the approach; no `jsn` code is used. (#18)
- `servicenow-mcp-setup grant --flows` grants read on the `sn_flow_view`
  tables, bound to `sn_flow_view` only. (#18)
- **Policy card.** `sn_profile` returns the profile's effective policy as data
  (`policy`) and as a text table (`policy_card`), and
  `servicenow-mcp-setup policy show --profile <name> [--json]` prints the same
  card: readable and writable tables with their tools, field rules, class and
  domain fields that need explicit listing, auth type, raw encoded-query
  reads, ATF grants and `sn_batch` limits. It never prints a secret, key or
  credential reference, and it enforces nothing new. The data is held to
  40,000 bytes and the text to 24,000; `policy.truncated` says what was cut.
  (#17)
- **`sn_batch` dry runs show a sample.** A dry run also returns up to 5
  matched records (`sys_id` plus a `number`, `name`, `short_description` or
  `title` the profile may read), `fields_to_write` (names, never values) and a
  note that `confirm` re-runs the query. The sample costs one extra read; if
  it fails or takes more than 5 seconds, the dry run still returns the count.
  A target granted only `sn_batch` can therefore now see up to 5 display
  values in a dry run, where before it saw a count. (#17)
- **Warnings on risky grants.** `servicenow-mcp-setup grant` and the setup
  wizard warn when a grant gives write access to a privilege-sensitive table:
  roles, groups, delegation, ACLs, approvals, scripts, `sys_properties`,
  `sys_user`, `sys_user_group` and authentication tables. The wizard also
  warns on the `"*"` write wildcard, which `grant` rejects. The grant still
  goes ahead; `grant --json` carries the text in `warnings`. (#17)
- **Journal fields through the generic write tools, on every table.**
  `sn_create`, `sn_update` and `sn_batch` accept `comments` and `work_notes`
  on every table granted for writes, with the dedicated tools' bounds, and
  field policy decides permission. The dedicated tools remain. (#11)
- `sn_batch` results carry a `message` saying how many records were not
  confirmed or not sent, and why the run stopped. (#11)
- **MCP Registry metadata.** `package.json` declares `mcpName`
  `io.github.onlyflowstech/servicenow-mcp`, and the package ships the
  `server.json` manifest for the official MCP Registry. (#14)
- The README leads with what the server controls and what it does not, lists
  the tools by area, and documents per-profile field policy. `AGENTS.md`
  describes how contributors' AI agents work in this repository. (#11, #13,
  #14)
- From the 2.2.0 dev builds: the ATF tools `sn_atf_author`, `sn_atf_run`,
  `sn_atf_results` and `sn_atf_readiness`, with `setup grant --atf`;
  Windows support in `servicenow-mcp-setup`; and the npm `dev` channel for
  prereleases (`npm install -g @onlyflows/servicenow-mcp@dev`). Details are
  under 2.2.0-dev.1 through 2.2.0-dev.6 below.

### Changed

- **Field policy and journal rules (breaking for some profiles).** Each item
  below has its remedy in
  [Upgrading to 2.2.0](docs/V2-MIGRATION.md#upgrading-to-220). (#11)
  - `SN_FIELD_POLICY_DEFINITIONS` configures only the `SN_PROFILE_NAME`
    environment profile. While it is set and a config file supplies the
    profiles, the server, `servicenow-mcp-setup` and `servicenow-mcp-profile`
    refuse to start and say how to move the policy into each profile's
    `fieldPolicy`.
  - Field policy is validated when profiles load. A malformed `fieldPolicy`,
    `readableTableFields` or `writableTableFields` used to deny every call on
    its profile, or narrow nothing; it now stops startup with the profile, key
    path and table named and no configured value repeated. One bad profile
    stops the whole file from loading.
  - A profile's `"*"` field-policy entry now reaches `incident`,
    `change_request`, `problem`, `sc_request`, `sc_req_item`, `sc_task`,
    `task`, `cmdb_ci`, `cmdb_ci_server`, `cmdb_ci_computer`, `kb_knowledge`
    and every custom table, so `{"*": {"writable": []}}` now denies writes to
    them. The 23 built-in system tables still never take it.
  - `sys_class_name`, `sys_class_path`, `sys_domain` and `sys_domain_path`
    are written only where a profile lists them by name; no wildcard covers
    them.
  - `sn_incident_add_comment` and `sn_incident_add_work_note` are denied when
    the incident's `writable` set leaves out `comments` or `work_notes`.
  - `incident` accepts every field the profile allows, not only the 14 typed
    fields; those 14 keep their typed checks.
  - `["*"]` in a field set means every field; it used to fail every call.
    `readable: []` no longer blocks writes as a side effect; add
    `writable: []` for that.
  - A dot-walked or `variables.*` write key is denied with the reason
    `unsupported_field_path`, and a write-value denial names the field and
    table, never the value.
- **`sn_batch` uses the ServiceNow REST Batch API and never re-sends a batch
  that may have reached the instance.** Confirmed updates and deletes go up to
  50 records per request, with each request kept under 4 MiB unless one
  record alone exceeds about 3 MiB, which is then sent on its own. A batch
  sub-request that fails with a server error is reported as unconfirmed, not
  retried. The run falls back to one Table API call per record only when the
  instance refuses a batch request (401, 403 or 404), and only for that
  batch's records and the ones after it. That fallback follows the HTTP
  client's retry rules: an ordinary update or delete is retried up to twice
  after a 502, 503, 504 or connection error, and a journal write is re-sent
  only after a 429 or a 401 credential refresh, when ServiceNow has not
  processed it. A rate limit (429) that persists through the client's retries
  stops the run with the `Retry-After` hint. Unconfirmed records count as
  neither processed nor failed; records not sent count as failed. (#11)
- `servicenow-mcp-setup grant --write incident` also binds the two incident
  journal tools; comments are customer-visible. An explicit `--tools` list
  withholds them. Existing profiles are not changed. (#11)
- `sn_update` advertises `idempotentHint: false`, because a journal field
  appends an entry on every call. (#11)
- **Metadata caching works in every auth mode.** Freshness is checked against
  the table's row count and newest `sys_updated_on`, so OAuth
  `client_credentials` and API-key profiles, where the cache used to turn
  itself off, now cache too. `sn_schema` results are reused for 5 minutes
  (`schemaCacheTtlMs` / `SN_SCHEMA_CACHE_TTL_MS`, up to 1 hour), and
  `force_recache: true` refreshes one read. (#9)
- **zod 4 is visible to clients in three ways.** Input validation errors
  reported by the MCP SDK use zod 4's wording (for example `Invalid input:
  expected string, received undefined` instead of `Required`); tool schemas
  are served inline instead of with internal `$ref`s, which adds about 18 KB
  to `tools/list`; and integer fields in output schemas state the
  safe-integer range. Tools accept and reject the same input as before. (#16)
- **Less memory at startup.** The startup tool-catalog check no longer
  compiles output-schema validators it never uses, which saves about 6 MB of
  idle memory in a stdio server. Validation of real calls is unchanged. (#19)

### Fixed

- A hibernating developer instance, and any other HTML page returned instead
  of an API response (single sign-on, maintenance, proxy), now gives a clear
  error instead of a generic upstream failure: "The ServiceNow instance
  <host> appears to be hibernating ... wake it at
  https://developer.servicenow.com", or a fixed "returned an HTML page"
  message. A 200 response that is not valid JSON gets a fixed message too,
  and none of these repeats response text. The setup wizard and
  `servicenow-mcp-setup doctor --live` no longer print raw error messages, and
  `doctor --live` checks profiles concurrently with a 10-second timeout. (#15)
- `incident` fields outside the 14 typed ones, such as `cmdb_ci`,
  `business_service`, `watch_list`, `hold_reason` and every `u_`/`x_` custom
  field, are writable. Incident `description`, `close_notes`, choice fields
  and the reference fields `caller_id`, `assignment_group` and `assigned_to`
  can be cleared with `""` or `null`. (#11)
- Generic writes accept `null`, finite decimals such as `12.5`, arrays for
  list fields such as `watch_list`, and the `{value, display_value, link}`
  read shape. (#11)
- `sn_batch` applies the same value policy as `sn_update` and sends the
  canonical values; it used to send the caller's values unchecked. It now
  uses the documented REST Batch API shape, so a batch the instance had
  already applied is no longer replayed one record at a time, and a large
  batch no longer becomes a request of tens of megabytes. (#11)
- Write responses always include the written record's `sys_id`, so a
  successful create no longer reads as a failure that invites a duplicate
  retry. (#11)
- The metadata cache no longer serves stale rows on accounts east of UTC, and
  it detects deletes. A table whose newest row is dated in the future is not
  cached. (#9)
- `sn_schema` and `fields: "all"` follow a table's parents by name instead of
  by label, so hierarchies such as `alm_hardware` keep their inherited
  fields. (#9)
- `servicenow-mcp-setup` offers a table's parent by name, not by label, and
  fetches one OAuth token for its parent lookups. The `relatedTables`
  documentation, `grant` output and `--related` help now say what
  `grant --related` adds. (#12)
- From the 2.2.0 dev builds: tool schemas no longer declare JSON Schema
  draft-07, which clients on the current MCP specification refused
  (2.2.0-dev.6), and `servicenow-mcp-setup` finds client CLIs and registers
  clients on native Windows (2.2.0-dev.6).

## [2.2.0-dev.6] — 2026-09-16

### Fixed

- Tool schemas no longer declare JSON Schema draft-07. Clients on the current
  MCP spec validate with a 2020-12-only validator and refused every tool. The
  schemas now carry no `$schema`, and each is valid under both dialects.
- `servicenow-mcp-setup` works on native Windows. Commands are found through
  PATH and PATHEXT instead of `/bin/sh`, so `doctor` no longer reports a correct
  global install as missing, and Claude Code and Codex are detected and
  registered.
- On Windows, clients are registered to launch `node.exe` with the absolute path
  to `dist\index.js`, because MCP clients can't start npm's `.cmd` shims. Client
  CLIs installed as `.cmd` shims run through `cmd.exe` with escaped arguments.
- The setup wizard rejects an unusable profile name, such as one containing a
  space, where it is typed, and suggests a valid one, instead of failing at the
  final save. `servicenow-mcp-profile create` checks `--name` before reading
  any secret.

### Added

- The setup wizard reports which client CLIs it found before its first
  question. A Claude Code or Codex CLI installed in its default location but
  missing from PATH is found and used by full path, and the wizard explains how
  to fix PATH.

## [2.2.0-dev.5] — 2026-09-16

### Fixed

- ATF failures include result/step IDs, a referenced step label fallback, and
  explicit head/tail excerpts. The new `sn_atf_results step` action retrieves
  complete summary or output text in bounded chunks.
- Return 200 test summaries by default with explicit test/failure pagination,
  replacing the inaccessible 100-test display cap.
- Report observed `status_changed` instead of inferring flakiness from pass/fail
  transitions; the deprecated `flaky` field stays empty.
- Include suite reads in the authoring setup preset for membership verification.

- Container validation expects the current 23-tool contract and reports named,
  bounded asynchronous stages instead of leaving pending checks without diagnostics.
- Docker validation subprocesses have a one-minute timeout.
- Refresh the pinned Distroless runtime base to pick up the OpenSSL security fix
  for CVE-2026-14456; retain the high/critical vulnerability scan gate.

## [2.2.0-dev.4] — 2026-09-15

### Fixed

- Verify that the suite and every requested test are readable before creating
  any memberships. Missing references fail without partial inserts.
- Report duplicate test IDs as invalid input instead of a table-policy denial.
- Normalize ServiceNow reference objects when listing tests by suite name.
- Block readiness for missing or unreadable test references and active tests
  without active steps, including tests in child suites. Inactive tests do not
  count as missing references.

### Validation

- Release gates passed: 1,616 unit tests, 250 protocol checks, 72 profile
  checks, 14 release checks, and no reported production dependency vulnerabilities.
- All four fixes were verified against the fd demo instance using disposable
  Global records; fixtures and their update/deletion metadata were removed.

### Validation limits

- Cloud Runner provisioning and remote execution were verified on the demo
  instance. Positive UI workflows remain blocked by its page JavaScript error
  involving `proActiveTrigger`; this release does not suppress that error.
- Authenticated inbound REST steps still require separate credential validation.

## [2.2.0-dev.3] — 2026-09-15

### Changed

- ATF execution is cloud-only: every suite submission sends `run_in_cloud=true`.
  Requests with `false` are rejected, and cloud failures never fall back to a
  local browser runner.
- Readiness checks the ServiceNow Cloud Runner application instead of requiring
  a local scheduled browser heartbeat. Installation alone remains unverified
  until cloud provisioning and execution are validated.

### Fixed

- Authoring readiness includes the required output-mapping write grant.
- REST JSON element assertions document slash-separated paths such as
  `result/number`, matching native ATF behavior.

### Validation and known limitations

- Added coverage for catalog choices, booleans, REST input maps, script grants,
  cloud-only submission, and absence of a local-runner fallback.
- Cloud UI execution remains unverified: the PDI accepted a cloud submission,
  but its cloud-user setup check could not reach ServiceNow cloud infrastructure.
  This prerelease is intended for validation on a configured demo instance.
- Temporary PDI fixtures and results were removed and original profile grants
  restored. ServiceNow denied deletion of protected internal rollback history;
  no ACLs were changed to remove it.

## [2.2.0-dev.2] — 2026-09-15

### Added

- ATF readiness checks, CI/CD suite execution with bounded polling, detailed
  results, persistent history and comparisons between runs.
- A verified catalog of 13 typed ATF steps, including REST headers/query maps
  and references to outputs from earlier steps in the same test.
- Native authenticated ATF form input saving and stored-value verification,
  without installing a scoped application or changing ServiceNow ACLs.
- Authoring grants now include input mappings and required metadata reads.

### Fixed

- Global scope creation accepts the platform's `global` identifier; new steps
  inherit their parent test's scope.
- Plugin readiness recognizes the platform's `active` choice value.
- Step input verification handles stored boolean values and enforces security
  by default for record queries and validation.
- Failed step authoring performs bounded cleanup even after request cancellation
  and reports remaining input or mapping records.

### Validation

- PDI validation in Global: all 13 types authored and read back; server-side
  assertions, record-output chaining, REST unauthorized-response checks, results,
  failure details, history and comparisons verified. Temporary records removed.
- Browser-driven steps were authored but their execution requires an ATF browser
  runner. Authenticated REST requests need their own ATF request credentials.
- This remains a dev prerelease; native forms must be verified against each
  supported ServiceNow version.

## [2.2.0-dev.1] — 2026-09-14

### Added

- Tag-driven dev prereleases publish to the npm `dev` channel while stable
  releases continue to publish to `latest`.

- `sn_atf_author` creates tests, suites, and ordered suite memberships under
  explicit table and field grants. Failed attempts return a structured rollback
  report and identify uncertain inserts that require inspection before retrying.
- `setup grant --atf` binds the five ATF authoring tables to `sn_atf_author`
  without enabling execution or script steps.
- Per-profile ATF configuration, opt-in execution-policy infrastructure, and
  escaping-first readable tool renderers.
- An identity-bound ATF result-cache library with atomic writes, concurrent-writer
  locking, bounded summaries, private storage and memory fallback. Execution and
  results tools will connect to this library in a subsequent change.

### Fixed

- ATF suite-result table policy fields use `rolled_up_test_*`, matching the
  platform fixtures rather than the CI/CD response spelling.

## [2.1.0] — 2026-09

> **Read this before upgrading if any profile grants `writeTables: ["*"]`, or
> names a table other than `incident`.** In 2.0.0 a hardcoded gate confined
> `sn_create` and `sn_update` to the `incident` table no matter what a profile
> granted, and the README documented them that way. That gate is gone: those
> tools now write any table the profile grants. If you granted a wide write
> allowlist while relying on the documented incident-only behaviour to keep
> single-record writes narrow, that assumption no longer holds — **review the
> `writeTables` allowlist and `targets` on every profile before upgrading.**
> This ships as a minor because the grant was always the operator's, and the
> gate was a defect that stopped it taking effect; the effective write surface
> can still widen without any configuration change on your side.

### Changed

- **`sn_create` and `sn_update` are no longer restricted to `incident`.** They
  write to any table the profile grants, so the configured `tableAccess` and
  field policies are now the only thing deciding which tables are writable —
  the same boundary `sn_batch` and `sn_delete` already answered to. Previously
  a hardcoded gate rejected every other table regardless of configuration,
  which both blocked granted work and left the restriction unenforced on
  `sn_batch`. **A profile granting `writeTables: ["*"]` (or naming other
  tables) now permits single-record writes to those tables through
  `sn_create`/`sn_update`; narrow the grant if that is wider than intended.**
  `incident` keeps its bounded typed value policy (approved ordinary fields,
  required `short_description` on create, range-checked `impact`/`urgency`/
  `priority`/`state`); other tables get generic value bounds — scalar values
  only, no control characters, at most 100,000 characters. The `sn_create`
  result's `table` is now the table written rather than the literal
  `"incident"`.
- **Policy denials are classified separately in errors and audit records.** A
  bounded-value rejection is reported as such and audited as
  `write_value_denied`, instead of being reported as "Table access was denied
  by policy" and audited as `table_access_denied`. The previous message named
  `tableAccess.writeTables` — a key that could not affect the outcome — and
  sent operators to re-issue grants that were already correct. Structured HTTP
  tool events also accept every policy-rejection reason now; previously any
  reason other than `table_access_denied` threw while the event was built.

### Fixed

- A write denied by the bounded value policy was reported as
  `ERROR: Table access was denied by policy.` — naming `tableAccess.writeTables`,
  a per-profile key that was already correct and could not affect the outcome.
  Operators re-issued grants against a restriction no configuration could lift.
  Each failure reason now has its own message, and the four
  reasons (`unsupported_table`, `missing_short_description`, `invalid_value`,
  `invalid_mode`) are no longer flattened into one misleading string.
- The incident restriction was not a boundary: `sn_batch` reached the same
  `PATCH /api/now/table/{table}/{sys_id}` endpoint for any table, on a bulk
  surface, so the gate blocked the documented path while leaving the
  undocumented one open. See **Changed** above for how this was resolved.
- Structured HTTP tool events accepted only `table_access_denied` for a policy
  rejection. Any other reason — including the existing `field_access_denied` —
  threw a `TypeError` while the event was being built.
- The 50,000-envelope validation gate asserted a single wall-clock reading
  against a 1000ms ceiling, which measured CI runner load as much as this code
  and failed at 1117ms while passing locally. It now takes the best of three
  rounds against a ceiling set to catch an order-of-magnitude regression.

## [2.0.0] — 2026-09

2.0 is a local, single-owner stdio server. Your client spawns it and speaks
over that process's stdin and stdout; nothing listens on a port.

**The transport is unchanged from 1.0.0.** A client entry that launches the
package still launches it. If you configured against a 2.0 pre-release that
served Streamable HTTP, see [Migrating to 2.0](docs/V2-MIGRATION.md#1-transport-unchanged).

Upgrading from 1.0.0 requires two changes on every install: name a profile on
every tool call, and grant table access. Everything else applies only if you
used the affected surface.

### Breaking

- **Every tool call must name a `profile`.** There is no default, active, or
  session-selected profile and no switch operation. Missing, empty, unknown or
  invalid names fail before credential resolution or client construction.
  Bare `SN_*` environment configuration now requires `SN_PROFILE_NAME` rather
  than inferring a single implicit connection.
- **Table access is deny-by-default per profile.** A profile with no rules
  denies every call. Grant with `servicenow-mcp-setup grant`. In 1.0.0 a tool
  could reach any table the credential could.
- **`sn_attach` no longer accepts host filesystem paths.** `file_path` and
  `output_path` are removed with no flag to restore them; uploads take
  `content_base64` and downloads return inline base64. The server touches no
  host filesystem, so behavior is identical whether run locally or in a
  sandbox.
- **`sn_script` is withdrawn.** It was never functional — it returned "not yet
  supported" while being advertised as destructive. It remains in the tree as
  future work (SNS-39) and is not registered. `tools/list` returns 19 tools.
- **Incident journal fields moved to dedicated tools.** `sn_update`,
  `sn_create` and `sn_batch` reject generic `comments` and `work_notes` writes
  and point at `sn_incident_add_comment` / `sn_incident_add_work_note`, which
  are append-only.
- **Raw encoded queries are opt-in per tool and table.** Structured filters are
  the default path.
- **`MAX_FIELDS_PER_OPERATION` raised from `32` to `10_000`**, and
  `excessive_field_selection` is removed from the exported
  `FieldPolicyFailureReason` union.
- **One `bin` becomes three**: `servicenow-mcp`, `servicenow-mcp-profile`,
  `servicenow-mcp-setup`.

### Added

- **Multi-instance profiles.** Named connections with credentials encrypted at
  rest (AES-256-GCM) in an owner-only `~/.servicenow-mcp`, or referenced from
  the environment.
- **OAuth 2.0 (`client_credentials` and `password`) and API-key
  authentication**, alongside basic.
- **`servicenow-mcp-setup`.** Run bare on a terminal it walks through one
  connection end to end: instance, credential, live verification against that
  instance, table grants, profile write, and client registration. Nothing is
  written to the profile until ServiceNow accepts the credential, and the
  profile and its grants are written together so there is no window where a
  profile exists that denies everything.
- **`servicenow-mcp-setup doctor`.** Diagnoses an install and prints a specific
  remedy per failure — Node version, `servicenow-mcp` resolving on `PATH`, file
  modes, profile completeness, credential resolution, table access.
- **`servicenow-mcp-setup grant`.** Writes least-privilege table rules onto a
  profile, validated by the same loader the server uses at request time, so a
  bad grant fails at the CLI rather than at the first tool call.
- **`sn_profile` tool** and the `servicenow-mcp.add-profile` prompt, adding the
  `prompts` capability.
- **Metadata caching** for dictionary and schema reads, keyed by instance *and*
  credential identity. Off by default for tables you do not name. Requires a
  resolvable session timezone, so it is disabled for OAuth `client_credentials`
  and API-key profiles, which carry no username.
- **Token-efficient responses** — compact JSON, bounded default field
  selection, pagination metadata, `response_format`, and a
  `max_response_bytes` truncation guard.
- **MCP tool annotations and display titles** on every tool.
- **Per-request failures surface as warnings** rather than being swallowed.

### Changed

- **`fields=all` and `response_format: "detailed"` are capped at 100 columns**
  rather than dropping `sysparm_fields`, which could exceed the response budget
  and fail the call outright. Columns resolve from `sys_dictionary` including
  inherited fields; sensitive names are excluded from the request rather than
  scrubbed from the response. `sn_query` and `sn_get` both report truncation.
- **Journal content is readable on request.** `comments` and `work_notes` are
  returned by `fields=all`, `response_format: "detailed"`, an explicit
  `fields=comments`, and `sn_schema`. The default projection still excludes
  them. Journal content routinely contains customer PII, so asking for all
  fields on `incident` now returns customer-visible commentary.
- **`sn_attach` has no transport size ceiling.** The former ~760 KiB practical
  limit came from the HTTP body cap; the tool's own 10 MiB bound is the only
  one in force.
- **HTTP authentication is opt-in and off by default**, for the dormant
  transport only. An empty `MCP_BEARER_TOKEN` is a startup failure rather than
  a way to disable it, so a half-applied env file stops the service instead of
  silently opening the port. A non-loopback `MCP_HOST` with no token refuses to
  start.

### Security

- **Field policy cannot be widened by configuration into a fail-open.** A
  profile-scoped policy previously discarded the built-in table policies
  wholesale, permitting writes to `sys_script` — arbitrary server-side
  JavaScript executed as the integration account. Configuration now layers onto
  the built-ins and an unspecified `writable` denies rather than permits.
- **`tableAccess` is the sole table-level authority.** The hard-deny list is
  removed; a profile's grants plus ServiceNow's per-user ACLs decide access.
  Deliberate, and documented in [PRODUCTION-SECURITY.md](docs/PRODUCTION-SECURITY.md).
- **Sensitive field names are refused for read, write, schema enumeration and
  query filtering.** Filtering was previously reachable under a wildcard
  readable set, which leaks a value one comparison at a time through row counts.
- **Metadata cache is keyed by credential identity**, so two profiles against
  one instance no longer share cached rows and bypass per-user ACLs.
- **Setup never echoes a typed secret**, and never places one in argv, shell
  history or a client configuration file.
- **`--force` no longer regenerates `SN_PROFILE_ENCRYPTION_KEY`**, which
  silently made every stored credential undecryptable. Rotation is a separate,
  explicit flag, refused while a profile file exists.
- **File modes are repaired on every write**, not only at creation, so a
  pre-existing world-readable env file cannot receive fresh secrets.
- **`http://` endpoints are restricted to loopback** unless explicitly allowed.

### Fixed

- `sn_aggregate` dropped ungrouped `COUNT` results from the Stats API.
- `sn_syslog` level names did not map to numeric values, and query values were
  not escaped.
- The metadata cache freshness probe compared `sys_updated_on` in UTC while
  ServiceNow evaluates it in the session user's timezone, so on a non-UTC
  account an updated record could appear unchanged for a full TTL. The zone
  name is now resolved and cached, and the offset computed per instant so DST
  transitions are correct.
- Inline base64 was decoded before its size was checked, and invalid base64
  raised an internal error rather than a correctable one. Line-wrapped base64
  — what `base64 file.pdf` produces — was rejected.
- `file_name` accepted Unicode bidirectional overrides, so
  `invoice‮gnp.exe` rendered as `invoiceexe.gnp`.
- Field-policy denials were reported and audited as table denials, on tables
  the operator had just granted, with the fix in a configuration key the
  message never named.
- The compiled `bin` entrypoints were not executable, so a globally linked
  install failed with "permission denied" after any rebuild.
- HTTP rate-limit rejections returned an empty body, which benchmarks could not
  distinguish from a fast success.

## [1.0.0] — 2026-07

Initial public release. 17 tools over stdio, single instance configured from
`SN_*` environment variables.
