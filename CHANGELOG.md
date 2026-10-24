# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Read this before upgrading.** This release can stop a working install from
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
>
> [Upgrading to the next release](docs/V2-MIGRATION.md#upgrading-to-the-next-release)
> lists every case with its remedy.

### Breaking

- **`SN_FIELD_POLICY_DEFINITIONS` configures only the `SN_PROFILE_NAME`
  environment profile.** Through 2.2.0-dev.6 it also narrowed every
  `config.json` profile that stated no field policy of its own. Ignoring it
  there would silently widen those profiles, so while the variable is set to
  a non-blank value and a config file supplies the profiles, the server
  refuses to start with: `SN_FIELD_POLICY_DEFINITIONS is set, but profiles are
  loaded from the config file; it now applies only to the SN_PROFILE_NAME
  environment profile. Move the policy into each profile's fieldPolicy, or
  unset the variable.` The setup and profile CLIs refuse the same way when
  the variable is set in their environment. On the environment profile the
  variable is now read once, at startup, and a malformed value stops startup
  instead of denying every request.
- **Field policy is validated when profiles load.** A malformed `fieldPolicy`,
  `readableTableFields` or `writableTableFields` used to deny every call on its
  profile, and some mistakes loaded and narrowed nothing. Each of these now
  stops startup, with the profile, key path and table named and no configured
  value repeated:
  - a pattern such as `"u_*"`, a name that is not a field name, or `"*"` mixed
    with field names;
  - the same field listed twice in one set;
  - `defaults` outside `readable`, including `defaults: "*"` beside a narrowed
    `readable`;
  - `fieldPolicy` stated together with `readableTableFields` or
    `writableTableFields` (the request path used to drop `fieldPolicy`
    silently);
  - an unknown key in a table entry or a `{ table, fields }` entry, such as
    the typo `writeable` or a comment key such as `_comment`;
  - two `fieldPolicy` table keys that differ only in case, or one table listed
    twice in the same list;
  - in `SN_FIELD_POLICY_DEFINITIONS`, table keys mixed with the profile keys,
    or a value that is not a JSON object.

  One bad profile stops the whole file from loading, and the CLIs refuse the
  file too, so edit `~/.servicenow-mcp/config.json` by hand.
- **A profile's `"*"` field-policy entry reaches the ITSM tables and every
  custom table.** On `incident`, `change_request`, `problem`, `sc_request`,
  `sc_req_item`, `sc_task`, `task`, `cmdb_ci`, `cmdb_ci_server`,
  `cmdb_ci_computer` and `kb_knowledge`, and on every table without a built-in
  entry, named in the profile or not, `readable` and `writable` now resolve
  from the table's own entry, then the `"*"` entry, then the open default.
  `{"*": {"writable": []}}` used to leave those ITSM tables, and any custom
  table the profile named without stating `writable`, writable; it now denies
  writes to them. To keep a key open on one table, state it on that table,
  such as `"u_x": {"writable": "*"}`. The 23 built-in system tables (scripts,
  users and groups, ATF, application and dictionary metadata, `syslog`) still
  never take the `"*"` entry; narrow one by naming it.
- **`sys_class_name`, `sys_class_path`, `sys_domain` and `sys_domain_path` are
  written only where a profile lists them.** They move a record to another
  class or domain, so no writable wildcard covers them, including the open
  default of a profile with no field policy. List each one by name in the
  table's `writable`; listing `sys_domain` does not list `sys_domain_path`.
  The denial reason is the new `explicit_field_required`.
- **The dedicated journal tools follow field policy.**
  `sn_incident_add_comment` and `sn_incident_add_work_note` are denied when the
  incident's effective `writable` set leaves out `comments` or `work_notes`,
  the same way `sn_update` is. A profile that already narrows
  `fieldPolicy.incident.writable`, or a `"*"` entry's `writable`, without those
  fields loses the matching tool.

### Added

- **Journal fields through the generic write tools, on every table.**
  `sn_create`, `sn_update` and `sn_batch` accept `comments` and `work_notes` on
  every table granted for writes. This reverses the 2.0 rule that rejected
  both names on every table ahead of field policy, which no configuration
  could lift and which left tables other than `incident` with no journal
  route. Each entry gets the bounds of the dedicated tools (1-8,000
  characters, 16,384 UTF-8 bytes, no control or format characters other than
  newline, carriage return and tab), and field policy decides permission. The
  dedicated tools remain.
- `sn_batch` results carry a `message` when records were not confirmed or not
  sent, saying how many and why the run stopped.
- The README documents per-profile field policy: `fieldPolicy`, the
  `readableTableFields` / `writableTableFields` lists, the `"*"` entry, and the
  fields that need explicit listing.

### Changed

- **`sn_batch` never re-sends a batch request that may have reached the
  instance.**
  Confirmed updates and deletes go through the ServiceNow REST Batch API, up
  to 50 records per request and fewer when values are large, so a request
  body stays under 4 MiB unless one record's fields alone exceed about 3 MiB
  of JSON; such a record is sent one per request. Each request gets its own
  1 MiB response budget.
  - Serial Table API calls replace the batch only when the instance refuses
    it outright (401, 403 or 404), and only for the records not yet sent.
  - A rate limit (429) stops the run with the `Retry-After` hint instead.
  - A record whose sub-request returns a server error (5xx or 408) is
    unconfirmed: it is reported, never retried, and the run continues. The
    run stops, reporting the rest as not sent, when a batch request fails or
    its response cannot be read or matched to the records sent, when every
    serviced record in one batch returns a server error, or when more than 10
    records in the run are unconfirmed.
  - The serial fallback stops at the first outcome it cannot confirm, at a
    429, and at a 401. It follows the HTTP client's retry rules: a journal
    write is never re-sent, and an ordinary (non-journal) `PATCH` is retried
    up to twice after a 502, 503, 504 or connection error.
  - Unconfirmed records count as neither processed nor failed. Records not
    sent count as failed.
- `servicenow-mcp-setup grant --write incident` also binds
  `sn_incident_add_comment` and `sn_incident_add_work_note` to the incident
  target. Comments are customer-visible and can notify the caller. An
  explicit `--tools` list withholds them; on a profile that already has them,
  use `--replace` with `--tools`. Re-run the grant to add them to an existing
  profile; existing profiles are not changed on upgrade.
- `sn_update` advertises `idempotentHint: false`, because a journal field
  appends an entry on every call.
- `["*"]` in a field set means `"*"`, in that exact form only. It used to fail
  every call on the profile.
- `readable: []` no longer blocks writes as a side effect. Writes to such a
  table return only `sys_id`; reads stay denied. Add `writable: []` to block
  writes.
- A dot-walked or `variables.*` write key, such as `caller_id.email`, is
  denied with a message saying why, under the new reason
  `unsupported_field_path`. Such keys were already denied.
- A write-value denial names the field and table it rejected, never the
  value.
- **Metadata caching works in every auth mode.** Freshness is checked against
  a server watermark: the cached table's row count (`X-Total-Count`) and its
  newest row by `sys_updated_on`, as the instance stores it. No time-zone,
  `sys_user` or `sys_properties` lookup is made, so OAuth `client_credentials`
  and API-key profiles, where the cache used to turn itself off, now cache
  like Basic and OAuth password profiles. A tool call reads each table's
  watermark once, however many times it reads the table. A table whose
  watermark cannot be used is read straight through for up to 15 minutes, or
  30 seconds after a transient failure. Empty tables cache. See
  [Upgrading](docs/V2-MIGRATION.md#metadata-caching-in-every-auth-mode).
- `sn_schema` results are reused across tool calls for 5 minutes, partitioned
  by profile, credential identity and effective policy. `schemaCacheTtlMs` /
  `SN_SCHEMA_CACHE_TTL_MS` (up to 1 hour) is honoured, and
  `force_recache: true` refreshes a result. The cache never hit before.

### Security

- **Omitting the journal tools no longer withholds journals.** A profile that
  grants `sn_create`, `sn_update` or `sn_batch` on a table can now append
  `comments` and `work_notes` there, including a profile whose incident target
  leaves out the dedicated journal tools. `sn_batch` can post one
  customer-visible comment per matched record, and each can trigger a
  notification. To withhold comments, set `fieldPolicy.<table>.writable` to
  an explicit list without `comments`; the default is every field. Narrow
  parent tables such as `task` the same way, because field policy is
  evaluated against the table each call names.
- **Journal writes are never re-sent.** The HTTP client no longer retries a
  `PATCH` or `PUT` that sets `comments` or `work_notes` after a 502, 503, 504
  or connection error, because the first attempt may already have appended
  the entry. It still retries a 429 and refreshes once after a 401, since
  neither was processed. This covers `sn_update`, the dedicated tools and the
  `sn_batch` serial fallback. Detection is by field name; see
  [Production security boundaries](docs/PRODUCTION-SECURITY.md#journal-content).
- `servicenow-mcp-setup grant` applies its default tools only to the tables,
  and the operations, named in that command. A read-only re-grant could add
  `sn_create` and `sn_update` to a target narrowed with `--tools`, and a
  re-grant could make a table that was reachable only as another target's
  related table directly writable or readable.
- `sn_batch` targets each matched record once per run, even when the lookup
  names a record twice, and `matched` counts it once. The serial
  fallback stops at a 401 instead of retrying every remaining record with
  credentials ServiceNow has rejected.
- **Read grants made for the old metadata cache can go.** The cache no longer
  reads `sys_user` or `sys_properties`. Remove any read grant on either table,
  in `tableAccess`, `SN_ALLOWED_READ_TABLES` or on the instance, that was
  added only for it; `sys_properties` rows can hold integration secrets.
- **Cache entries are partitioned by credential, not by the ServiceNow user
  it runs as.** A cache hit re-reads only the table's watermark, so tightening
  that user's ServiceNow row- or field-level ACLs is not seen until the entry
  is refetched: by default up to 24 hours for metadata (configurable to 7
  days) and 5 minutes for `sn_schema` (up to 1 hour).
  After re-mapping a client_credentials application or API key to another
  user, or restricting that user, restart the server or rotate the secret;
  `force_recache: true` refreshes only the read it is passed on. A profile's
  `tableAccess` and `fieldPolicy` apply on every call, cached or not.
- `sn_batch` looks up the records it will update or delete on the instance on
  every run, never in the metadata cache. On a cached table (`sys_flow*` and
  `sys_metadata*` by default), a repeat run could be served an earlier run's
  matches, and so update or delete records that no longer matched its filter.
- `sn_schema` returns `inherited_from` only where the profile can read
  `super_class` on `sys_db_object`.
- **Dependency and base-image advisories.** `@modelcontextprotocol/sdk` is
  1.31.0 (GHSA-6qxp-vccf-f47h, in the SDK's client-side OAuth flow, which
  this server does not use). `proxy-addr` 2.0.8 (GHSA-jqcg-44mw-7w3h,
  critical), `fast-uri` 3.1.8, `hono` 4.13.13 and `ip-address` 10.7.4 close
  the remaining production advisories. The container's runtime base,
  `gcr.io/distroless/nodejs22-debian13:nonroot`, is pinned to a digest that
  carries `libssl3t64` 3.5.7-1~deb13u3 (CVE-2026-84782) and Node 22.23.3. The
  developer-only inspector toolchain, which is not shipped, takes the same
  fixes plus `undici` and `source-map-js`.

### Fixed

- A hibernating developer instance, and any other HTML page returned in place
  of an API response (single sign-on, maintenance, proxy), now produces a
  clear error instead of a generic upstream failure. The OAuth token fetch and
  every API call report "The ServiceNow instance <host> appears to be
  hibernating ... wake it at https://developer.servicenow.com" (retry later,
  never retried automatically), or a fixed "returned an HTML page" message for
  any other HTML page. The hibernation page is recognised by its
  `Instance Hibernating` title. A 200 body that is not valid JSON also gets a
  fixed message. None of these repeats response text, and the setup wizard and
  `servicenow-mcp-setup doctor --live` (one authenticated read per profile,
  run concurrently with a 10 s timeout) no longer print raw error messages.
- The server no longer follows HTTP redirects on API calls or the OAuth token
  request. A cross-origin redirect used to forward an API-key header, and a 307
  re-sent the token request body, which holds the client secret. Any 3xx now
  fails with "The instance redirected the request to another location" and
  does not echo the `Location`.
- `incident` fields outside the 14 with typed checks are writable. Task fields
  such as `cmdb_ci`, `business_service`, `watch_list` and `hold_reason`, and
  every `u_`/`x_` custom field, were rejected whatever the field policy said.
  They now get the generic value bounds; the 14 fields keep their typed
  checks, and the sensitive-name blocklist is unchanged.
- Incident `description`, `close_notes`, choice fields and the reference
  fields `caller_id`, `assignment_group` and `assigned_to` can be cleared with
  `""` or `null`. `short_description` stays required.
- Generic writes accept `null` (clears the field), finite decimals such as
  `12.5`, arrays of comma-free scalars for list fields such as `watch_list`,
  and the `{value, display_value, link}` read shape, which is written as its
  `value`. Unsafe integers and exponent forms are still rejected.
- `sn_batch` applies the same value policy as `sn_update`, before any
  credential or client is used, and sends the canonical values. It used to
  send the caller's values unchecked.
- `sn_batch` uses the documented REST Batch API shape: per-request headers,
  base64 bodies, and `serviced_requests`/`unserviced_requests` in the
  response. The old request and parser did not match it, so a batch the
  instance had already applied was replayed one record at a time.
- A rate-limited `sn_batch` (429) no longer falls back to one request per
  record, each retried against the same limit, and a batch request stays
  under 4 MiB unless one record's fields alone exceed about 3 MiB of JSON;
  such a record is sent one per request. Fifty records with large values
  used to make a request of tens of megabytes.
- Write responses always include the written record's `sys_id`. A readable
  set that left it out made a successful create read as an upstream failure,
  which invited a retry and a duplicate record. Every other field, `number`
  included, still follows the readable set.
- The metadata cache's freshness probe formatted its cutoff in the session
  time zone, although ServiceNow reads query date literals as UTC, so on an
  account east of UTC an updated record could be served stale for up to the
  TTL. The watermark compares values the instance stores, so the session time
  zone plays no part.
- Deletes in a cached metadata table are detected, through the row count. A
  table whose newest row is dated after the instance's clock is not cached,
  because that row would stay the newest however many others changed.
- `sn_schema` and `fields: "all"` follow a table's parents by name. They
  followed the parent's label, so any hierarchy whose labels differ from table
  names lost its inherited fields; `alm_hardware`, for example, lost nearly
  all of them. The whole chain is read in one request.
- `servicenow-mcp-setup` offers a table's parent by name. It followed the
  parent's label, so it offered `server` for `cmdb_ci_linux_server`, a table
  that does not exist, and nothing for a parent labelled with a space, such as
  `cmdb_ci`. It also fetches one OAuth token for its parent lookups rather
  than one per table.
- The `relatedTables` documentation, the `grant` output and `--related` help
  say what the loader and `grant` do. The loader checks that each declared
  related table has every operation permission its target has, so
  `grant --related` adds the table to the allowlist of each of those
  operations, including one a later grant adds. That makes it addressable only
  through a target of its own, or a `*` allowlist, and a target the table has
  or later gets can then use those operations on it. A self-only list is enough
  to read inherited fields, and a view or alias should declare every table it
  reads. They described the list as the complete set of tables an operation
  can reach, and the help called `--related` required for any table that
  extends another. A target without `closureComplete: true` is now rejected
  with an error that names the field.

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
