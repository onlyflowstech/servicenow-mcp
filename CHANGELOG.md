# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
