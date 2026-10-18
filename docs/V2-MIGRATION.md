# Migrating to 2.0

2.0 is a local, single-owner stdio server, the same launch shape as 1.x: your
client spawns `servicenow-mcp` and speaks to it over that process's stdin and
stdout. Nothing listens on a port. Every published release before it is
`1.0.0`, so this guide is written for a 1.0.0 install.

**Your transport does not change.** A 1.0.0 client entry that launches the
package still launches it. What changes is what the server expects once it is
running: every call names a profile, and table access is granted rather than
inherited from the credential. Those two are the migration; the rest apply only
if you used the affected surface.

**Already on 2.x?** The release after 2.2.0-dev.6 changes how field policy
loads and who may write journal fields, and it can refuse to start on a
configuration that loads today. Read
[Upgrading to the next release](#upgrading-to-the-next-release) before you
upgrade.

## Breaking changes at a glance

| # | Change | Before (1.0.0) | After (2.0.0) |
|---|--------|----------------|---------------|
| 1 | Transport | stdio; the client spawns `servicenow-mcp` | unchanged — stdio; the client spawns `servicenow-mcp` |
| 2 | Profile selection | implicit, from `SN_*` in the client's env | every tool call carries an explicit `profile` |
| 3 | Table access | any table the credential could reach | deny-by-default per profile; explicit allowlist plus target entries |
| 4 | Attachments | host `file_path` / `output_path` | inline base64 both directions; no host filesystem access, and no flag restores it |
| 5 | Queries | raw ServiceNow encoded queries | structured filters; raw reads are opt-in per tool/table |
| 6 | Incident journals | `sn_update` accepted `comments` / `work_notes` | dedicated `sn_incident_add_comment` / `sn_incident_add_work_note`; from the [next release](#upgrading-to-the-next-release) the generic write tools accept both fields again, on every table, under field policy |
| 7 | Tool surface | 17 tools, one `bin` | 19 tools, three `bin` entries; `sn_script` withdrawn |
| 8 | Field selection limit | `MAX_FIELDS_PER_OPERATION` was `32`; over-selection raised `excessive_field_selection` | limit is `10_000`; `excessive_field_selection` is removed from the exported `FieldPolicyFailureReason` union |
| 9 | Capabilities | `tools` only | adds `prompts` (`servicenow-mcp.add-profile`) |

Each is expanded below. Items 2 and 3 require action on every install; the rest
apply only if you used the affected surface. Item 1 is listed because an
earlier 2.0 pre-release did move to HTTP — if you configured against that, see
[Transport](#1-transport-unchanged).

## Also new in 2.0

- **Inline base64 attachments.** `sn_attach` uploads and downloads file content
  in the tool call itself, with no host filesystem access on either side. See
  breaking change 4 — this is the replacement for the removed path arguments.
- **`servicenow-mcp-setup`.** A bootstrap that generates the local server
  environment, registers the clients that have a CLI, emits copy-pasteable
  config for the rest, writes least-privilege table-access rules onto a profile,
  and diagnoses an install end to end with `doctor`.
- **`servicenow-mcp.add-profile` prompt.** A guided profile-creation flow that
  never asks for a secret in chat.
- **Append-only incident journal tools.** `sn_incident_add_comment` and
  `sn_incident_add_work_note`.
- **Metadata caching.** Per-instance-and-identity caching of dictionary and
  schema reads, off by default for tables you do not name. It works in every
  auth mode, including OAuth client_credentials and API key — see
  [Metadata caching](CLIENT-SETUP.md#metadata-caching).
- **Bounded unrestricted field selection.** `fields=all` and
  `response_format: "detailed"` are capped at 100 columns instead of dropping
  `sysparm_fields` and risking a failed call on a wide table.
- **Journal content is readable on request.** `comments` and `work_notes` are
  returned by `fields=all`, `response_format: "detailed"`, an explicit
  `fields=comments`, and `sn_schema`. The default projection still excludes
  them. Journal content on real instances routinely contains customer PII, so
  asking for all fields on `incident` now returns customer-visible commentary.

### 1. Transport (unchanged)

Your 1.0.0 client entry keeps working. The server still runs as a subprocess of
the client, framed over stdin and stdout:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "@onlyflows/servicenow-mcp"],
      "env": { "SN_PROFILE_NAME": "dev", "SN_INSTANCE": "https://yourinstance.service-now.com", "SN_USER": "u", "SN_PASSWORD": "p" }
    }
  }
}
```

The one addition is `SN_PROFILE_NAME`. 1.x inferred a single implicit
connection from the bare `SN_*` variables; 2.0 requires you to name it, because
every tool call now carries a profile (breaking change 2) and the name in the
call has to match something. Bare `SN_*` without `SN_PROFILE_NAME` is refused
rather than guessed at.

You do not have to keep credentials in your client config. `servicenow-mcp-setup`
writes them to an owner-only `~/.servicenow-mcp` instead, verifies them against
your instance before saving, and registers your clients for you — after which
the client entry carries no secret at all:

```json
{
  "mcpServers": {
    "servicenow-mcp": {
      "type": "stdio",
      "command": "servicenow-mcp"
    }
  }
}
```

Per-client syntax is in [CLIENT-SETUP.md](CLIENT-SETUP.md#7-mcp-client-configuration).

**If you configured against a 2.0 pre-release that served HTTP**, that
transport still exists but is dormant: no CLI path reaches it, it is not a
`bin` entry, and setup never registers a client against a URL. Replace a
`"type": "http"` entry with the stdio entry above. The endpoint, the readiness
check, and the service you had to keep running are all gone.
The `/mcp` endpoint is unauthenticated unless you set `MCP_BEARER_TOKEN`. See the
[enterprise boundary](ENTERPRISE-RELEASE-BOUNDARY.md#the-dormant-http-transport)
for why it is kept.

### 2. Explicit profile on every call

**Before:** `{"table": "incident", "limit": 5}`

**After:** `{"profile": "dev", "table": "incident", "limit": 5}`

There is no default, active, current, or session-selected profile, and no
switch operation. Missing, empty, unknown, or invalid names fail before
credential resolution or ServiceNow client construction. Successful results
carry the resolved name in `structuredContent.profile`.

### 3. Deny-by-default table access

**Before:** no MCP-side table policy; the integration account's ACLs were the
only boundary.

**After:** a profile with no rules denies every tool call. Grant explicitly:

```sh
servicenow-mcp-setup grant --profile dev --read incident,problem --write incident
```

`SN_ALLOWED_READ_TABLES`, `SN_ALLOWED_WRITE_TABLES`, and
`SN_TABLE_ACCESS_TARGETS` configure the `SN_PROFILE_NAME` environment profile,
and **only when `~/.servicenow-mcp/config.json` does not exist**. If you have a
profile file, those variables are ignored and the rules must live on the
profile. `servicenow-mcp-setup doctor` reports this case explicitly.

### 4. Attachments: no host filesystem paths

`sn_attach` no longer accepts `file_path` or `output_path`. The tool holds no
filesystem access at all — there is no `readFileSync`, no path parameter, and
no flag that restores the old behavior. Uploads take inline base64; downloads
return inline base64.

This is deliberate hardening, not a regression. The server touches no host
filesystem, so behavior is identical whether it runs on a desktop or in a
container. Under the old contract a `file_path` that worked on a laptop
silently failed once the same server ran in a container against the same
client — exactly the kind of environment-dependent break that makes an install
hard to trust.

**Upload — before:**

```json
{ "action": "upload", "table": "incident", "sys_id": "…", "file_path": "/local/report.pdf" }
```

**Upload — after.** Encode the file yourself and send the bytes inline:

```json
{
  "profile": "dev",
  "action": "upload",
  "table": "incident",
  "sys_id": "0123456789abcdef0123456789abcdef",
  "file_name": "report.pdf",
  "content_base64": "JVBERi0xLjcKJc…"
}
```

`file_name` must be a safe leaf name — no directory separators. To produce the
payload:

```sh
base64 report.pdf                 # macOS / BSD
base64 -w0 report.pdf             # GNU coreutils, single line
```

`base64` wraps at 76 columns by default. That is fine: the tool tolerates
whitespace in `content_base64`, so either form works.

**Download — before:**

```json
{ "action": "download", "table": "incident", "sys_id": "…", "output_path": "/local/out.pdf" }
```

**Download — after.** The result carries the bytes; decode them client-side:

```json
{
  "profile": "dev",
  "action": "download",
  "table": "incident",
  "sys_id": "0123456789abcdef0123456789abcdef",
  "attachment_sys_id": "…"
}
```

The result returns `content_base64`, `file_name`, `content_type`, and
`size_bytes`. Write the file yourself:

```sh
# from a saved result document
jq -r '.structuredContent.content_base64' result.json | base64 -d > out.pdf
```

Download also requires the owning `table` and record `sys_id`; both are
policy-authorized and verified against ServiceNow's attachment metadata before
any bytes are returned.

**Size.** Both directions travel inside the 1 MiB `/mcp` JSON request envelope,
and base64 inflates a file by roughly a third on the way in, so the effective
ceiling is well under a megabyte — far below the 10 MiB decoded cap the tool
also enforces, which is therefore never the binding constraint over HTTP. The
tool's own `content_base64` schema description carries the current figure;
read it there rather than from this guide, because reconciling the two limits
is still in flight for 2.0. An oversized upload is rejected with HTTP `413`
before the tool runs. Treat `sn_attach` as suitable for logs, configs,
screenshots, and small documents rather than bulk transfer.

### 5. Structured queries

**Before:** `{"query": "active=true^priority=1"}`

**After:**

```json
{
  "profile": "dev",
  "table": "incident",
  "structured_query": {
    "filter": {
      "type": "group",
      "operator": "and",
      "conditions": [
        { "type": "equality", "field": "active", "operator": "eq", "value": true },
        { "type": "equality", "field": "priority", "operator": "eq", "value": 1 }
      ]
    }
  }
}
```

Condition types are `equality`, `set`, `range`, `between`, `text`, and `null`;
groups nest three levels deep at most. Field names are restricted to
`^[a-z][a-z0-9_]{0,79}$`, so dot-walking is not expressible.

`sn_batch` now requires `structured_query.filter`. Create, update, delete, ATF,
aggregate, and syslog have no raw encoded-query input at all. Raw reads on
`sn_query` are opt-in through `SN_ENCODED_QUERY_READ_POLICY`, described at the
end of this document.

### 6. Incident journal fields

**Before:** `sn_update` on `incident` with `{"comments": "…"}`.

**After (2.0.0 through 2.2.0-dev.6):** `sn_incident_add_comment` with
`{profile, sys_id, content}` for a customer-visible comment, or
`sn_incident_add_work_note` for an internal note. `sn_update` rejects both
fields before credentials are resolved.

**After (the [next release](#upgrading-to-the-next-release)):** both shapes
work. `sn_create`, `sn_update` and `sn_batch` accept `comments` and
`work_notes` again, on `incident` and every other table granted for writes,
and the configured field policy decides whether a profile may write them,
through either route. The dedicated tools remain. See
[Incident journal migration](#incident-journal-migration).

### 7. Tool surface and executables

17 tools become 19: `sn_incident_add_comment`, `sn_incident_add_work_note`, and
`sn_profile` are added, and `sn_script` is removed. `sn_script` never executed
anything in 1.0.0 — it returned an explanatory error — so removing it changes
`tools/list` but no working behavior. Use `sn_query` and `sn_batch` instead.

One `bin` becomes three:

- `servicenow-mcp` — the stdio server your client spawns (and `servicenow-mcp setup`)
- `servicenow-mcp-profile` — out-of-band profile administration
- `servicenow-mcp-setup` — bootstrap, client config, grants, and diagnosis

### 8. Field-selection limit

`MAX_FIELDS_PER_OPERATION` rises from `32` to `10_000`, and
`excessive_field_selection` is removed from the exported
`FieldPolicyFailureReason` union. Code that switched on that member no longer
compiles, and a selection that previously failed now succeeds.

### 9. New `prompts` capability

The server advertises `prompts` and registers `servicenow-mcp.add-profile`,
which guides safe profile creation without asking for secrets in chat. This is
additive, but it changes the advertised capability set, which matters if you
assert on it.

### Client behavior

`MCP_MAX_CONCURRENT_REQUESTS` defaults to `2` and there is no admission queue:
a third concurrent request receives HTTP `503` immediately. Clients and agents
must cap their own parallelism at two and honor `Retry-After` on `429` and
`503`. See
[client behavior requirements](CLIENT-SETUP.md#client-behavior-requirements).

## Required client change

**None for the transport.** A 1.0.0 entry that launches `servicenow-mcp` with a
`command` keeps working — see [Transport](#1-transport-unchanged). Local stdio
configuration is the supported shape, not a deprecated one.

Two things do change inside the calls your client makes:

- **Name a profile on every tool call.** See
  [Profile-call change](#profile-call-change).
- **Grant table access.** A profile with no rules denies every call. See
  [Table-policy change](#table-policy-change).

The simplest path is to let setup do it:

```bash
npm install -g @onlyflows/servicenow-mcp
servicenow-mcp-setup
```

It asks for your instance and credential, verifies the credential against the
instance before writing anything, asks which tables to grant, writes an
owner-only profile, and registers the clients whose CLI it can find. Your
client entry then carries no credential at all.

For official SDK and independent examples, explicit profile selection, two
isolated named profiles, and safe result/audit verification, see
[V2 service and client setup](CLIENT-SETUP.md).

## Starting the server

You do not. Each registered client spawns its own `servicenow-mcp` when it
needs one and stops it when the session ends. There is no daemon, no port, no
readiness probe, and nothing to keep running between sessions.

To check an install without a client:

```bash
servicenow-mcp-setup doctor --profile dev
```

That verifies the Node version, that `servicenow-mcp` resolves on `PATH` — the
command every client is registered with — the config directory and file modes,
the profile, its credential resolution, and its table-access rules.

## Profile-call change

Every one of the 19 `sn_*` tools now requires a non-empty `profile` argument.
Missing, empty, unknown, or invalid profiles fail before ServiceNow client or
credential initialization. There is no omitted-profile or session-active
fallback.

Named profiles remain in `~/.servicenow-mcp/config.json`, and canonical `SN_*`
variables remain supported through explicit configuration. If no profile file
exists, set `SN_PROFILE_NAME` to the desired profile name alongside the
canonical connection variables, then pass that same name on every tool call.
Without `SN_PROFILE_NAME`, bare connection variables create no profile. There
is no synthetic `default`, active selection, or omitted-profile fallback.

Successful tool results include the resolved profile in
`structuredContent.profile`.

There is no release, Inspector, smoke, environment, or migration escape hatch
for this selector. CI invokes every advertised tool without `profile` and
requires rejection, then proves every successful catalog probe returns the
resolved profile. The same rule applies to interactive Inspector calls and the
second-client smoke check. See
[Provider-neutral release validation](RELEASE-VALIDATION.md).

Profile changes are now an out-of-band operator action. After installing the
package, use the `servicenow-mcp-profile` executable to create, inspect, rotate,
or remove profiles; it rejects secret-bearing command-line arguments and reads
sensitive values from a protected prompt or bounded standard input. For local
encrypted sources, inject exactly 32 random bytes encoded as base64 or base64url
through `SN_PROFILE_ENCRYPTION_KEY`. Keep that key in the deployment secret
mechanism or OS keychain, separate from `config.json`, logs, and command history.
See [Profile credentials and out-of-band administration](PROFILE-CREDENTIALS.md)
for command syntax and recovery guidance.

## Attachment-call change

V2 attachment transfers do not accept host `file_path` or `output_path`
arguments. For upload, send a safe leaf `file_name` and `content_base64`; for
download, read `content_base64` from the tool result and decode it client-side.
The 1 MiB `/mcp` JSON request envelope, not the tool schema's advertised cap,
sets the practical size limit; see
[Attachments: no host filesystem paths](#4-attachments-no-host-filesystem-paths)
for worked before/after examples. List, upload, and download require the owning
`table` and record `sys_id`; downloads verify those values against ServiceNow
attachment metadata before returning bytes.

## Lifecycle and shutdown

The server's lifetime is its client's. The client spawns it, and it exits when
stdin closes or the client stops it. There is no health endpoint, no readiness
gate, no drain period, and nothing to signal — a stopped client leaves nothing
behind.

The health contract, the `MCP_SHUTDOWN_GRACE_MS` drain, and the OCI artifact
all belong to the
[dormant HTTP transport](ENTERPRISE-RELEASE-BOUNDARY.md#the-dormant-http-transport)
and do not apply to a 2.0 install. They are documented in
[Production container deployment](CONTAINER-DEPLOYMENT.md) for the enterprise
shape that will use them.

## Table-policy change

V2 denies table access unless the service operator configures per-profile table
rules. File-backed profiles use a `tableAccess` object in
`~/.servicenow-mcp/config.json`; the explicit `SN_PROFILE_NAME` environment
profile maps `SN_ALLOWED_READ_TABLES` and `SN_ALLOWED_WRITE_TABLES` into that
one profile only when no profile file exists. A profile with no table rules
denies all. Use exact table names or the literal `*` for a broad grant. There is
no built-in list of tables the server refuses unconditionally: `tableAccess`
plus ServiceNow's own per-user ACLs decide everything, so a granted table is
reachable and least privilege lives in the grant and in the integration
account's roles. Both
variables are comma-separated and default to an empty allowlist. Read and write grants
are independent: a table listed for reads is not writable, and a table listed
for writes is not implicitly readable. Every caller-addressable name must also
have a trusted entry in `SN_TABLE_ACCESS_TARGETS` unless the relevant operation
uses `*`. Target entries still narrow permitted tools when present, and identify whether the table is canonical,
an alias, a view, or an extension and listing every backing/ancestor table it
can reach, including descendant tables reachable through base-table access.
Each entry must explicitly set `closureComplete: true`, and each related table
needs the same operation permission. A related permission does not make that
table caller-addressable unless it also has its own target entry. Omit the
target—and therefore deny direct access—when the metadata closure cannot be
proven complete.

Table allowlists are paired with a separate field-policy gate. Field policy
narrows what a granted table exposes; it never denies the table itself. Each
`config.json` profile states its own with `fieldPolicy`, or with
`readableTableFields` and `writableTableFields`; for the `SN_PROFILE_NAME`
environment profile, `SN_FIELD_POLICY_DEFINITIONS` supplies it. Entries are
keyed by exact table name or `*`, and each may define `defaults`, `readable`,
and `writable` as exact field lists or `"*"`. Sensitive field-name families
remain denied even when wildcard field access is configured. The
[field policy reference](../README.md#field-policy) covers the forms, the `*`
entry, and the fields that must be listed explicitly. Example read-only
exploration on the environment profile, with no `config.json`:

```sh
export SN_ALLOWED_READ_TABLES='*'
export SN_ALLOWED_WRITE_TABLES=''
export SN_FIELD_POLICY_DEFINITIONS='{"*":{"defaults":["sys_id"],"readable":"*","writable":[]}}'
```

`SN_ALLOWED_WRITE_TABLES=''` is what makes this read-only: the `*` entry never
reaches the built-in system tables, so `writable: []` alone does not stop
every write. Use `writable:"*"` only when broad mutation access is
intentional; write field wildcards do not imply read field access or table
write access.

The service normalizes identifiers and rejects malformed entries. It does not
refuse any particular table: since 2.0 there is no built-in deny list, so a
credential, authentication, or role-grant table configured in `tableAccess` is
granted, bounded only by the integration account's ServiceNow roles.
Multi-table tools must have their complete operation plan authorized before the
first ServiceNow client access. `sn_nl` remains denied without a complete typed
side-effect plan. Legacy ATF execution actions return migration guidance; use
`sn_atf_run` with the explicit `atf.execute` profile grant. See
[ATF workflow](ATF-WORKFLOW.md).

### Incident journal migration

**The [next release](#upgrading-to-the-next-release) reverses the
generic-write rule below.** From 2.0.0 through 2.2.0-dev.6 the generic write
tools rejected `comments` and `work_notes` by name, on every table, ahead of
field policy, and no configuration could lift the rejection. Tables other than
`incident` had no journal route at all. From the next release:

- `sn_create`, `sn_update` and `sn_batch` write `comments` and `work_notes`
  on any table granted for writes. A Table API write to a journal field
  appends one entry; it cannot rewrite earlier entries.
- Each value gets the same content bounds as the dedicated tools (below).
- Field policy decides permission, for the generic tools and the dedicated
  tools alike. With no field policy, every write-granted table accepts both
  fields. To withhold customer-visible comments from a profile, set
  `writable` to an explicit list without `comments`; on `incident` this also
  denies `sn_incident_add_comment`. See
  [Journal fields and the dedicated tools](#journal-fields-and-the-dedicated-tools).
- Calls written for 2.0 keep working, except where field policy now denies a
  dedicated tool.

From 2.0.0 through 2.2.0-dev.6, generic `sn_update` did not accept the
append-only incident fields `comments` or `work_notes`. Those inputs failed
before profile credentials or a ServiceNow client were resolved and directed
the caller to the matching dedicated tool:

- use `sn_incident_add_comment` with `{profile, sys_id, content}` for a
  customer-visible comment;
- use `sn_incident_add_work_note` with `{profile, sys_id, content}` for an
  internal work note.

Both tools always PATCH the `incident` table and send exactly one journal
field. Content must be non-whitespace, contain valid Unicode without unsafe
control/format characters, and fit both the 8,000-character and 16,384-byte
UTF-8 limits. Each call appends a new journal entry and is intentionally not
idempotent: invoking the same request twice appends twice. Operators must grant
the selected dedicated tool on the exact `incident` target and grant that table
write access; neither tool bypasses table or field policy.

## Encoded-query change

Structured filters are the V2 query interface. `sn_batch` now requires
`structured_query.filter`; raw `query` selectors are rejected for dry runs and
confirmed writes alike. Create, update, delete, ATF, aggregate, and syslog also
have no raw encoded-query input surface.

Legacy raw reads on `sn_query` are disabled by default. An operator may opt in
only through `SN_ENCODED_QUERY_READ_POLICY`, whose JSON rules name one exact
`sn_query`/table pair and bound query length and complexity, readable query
fields, operators, pagination, and output bytes. For example:

```sh
export SN_ENCODED_QUERY_READ_POLICY='{"rules":[{"tool":"sn_query","table":"incident","maxLength":256,"maxTerms":8,"fields":["active","priority"],"operators":["=","!="],"maxLimit":100,"maxOffset":1000,"maxResponseBytes":100000}]}'
```

The server parses every opted-in query and still rejects OR/NQ/order/group
control tokens, JavaScript values, unsupported fields/operators, malformed
Unicode, and any request exceeding the rule. Policy errors never echo the raw
query value. There is no stdio or transport-specific exception.

## Upgrading to the next release

This section is for installs already on 2.x, from 2.0.0 through
2.2.0-dev.6. "The next release" means the first release after 2.2.0-dev.6;
until it ships, its notes are under `[Unreleased]` in the
[CHANGELOG](../CHANGELOG.md).

Check this table before you upgrade. The first two rows can stop the server
from starting.

| Change | Affects you if | What to do |
|---|---|---|
| [`SN_FIELD_POLICY_DEFINITIONS` applies only to the environment profile](#sn_field_policy_definitions-and-configjson) | the variable is set and `~/.servicenow-mcp/config.json` exists | Move the policy into each profile's `fieldPolicy`, then unset the variable |
| [Field policy is validated at load](#field-policy-load-errors) | a profile states `fieldPolicy`, `readableTableFields` or `writableTableFields` | Fix any load error by editing `config.json` |
| [Journal fields through the generic write tools](#journal-fields-and-the-dedicated-tools) | a profile grants `sn_create`, `sn_update` or `sn_batch` on a table | State an explicit `writable` list wherever comments must be withheld |
| [The dedicated journal tools follow field policy](#journal-fields-and-the-dedicated-tools) | a profile narrows `writable` on `incident` or on a `"*"` entry | List `comments` or `work_notes` wherever the matching tool must keep working |
| [`incident` accepts every field](#incident-accepts-every-field) | a profile grants `sn_create` or `sn_update` on `incident` without an explicit `writable` list | If you relied on the old 14-field limit, set `fieldPolicy.incident.writable` (or a `"*"` entry's `writable`) to the fields agents may set |
| [A `"*"` entry reaches the ITSM and custom tables](#the--entry-reaches-the-itsm-and-custom-tables) | a profile has a `"*"` entry that states `readable` or `writable` | State the key on each table that must stay open |
| [`["*"]` now means every field](#a-wildcard-list-now-means-every-field) | a profile used `["*"]` in a field set, so every call on it failed | Replace it with an explicit list unless every field is intended |
| [Class and domain fields must be listed](#class-and-domain-fields) | anything writes `sys_class_name`, `sys_class_path`, `sys_domain` or `sys_domain_path` | List each field in the table's `writable` |
| [`readable: []` no longer blocks writes](#readable--and-writable-) | a profile uses `readable: []` to hide a table | Add `writable: []`, or leave the table out of `tableAccess` |
| [Setup grant defaults](#setup-grant-defaults) | you run `servicenow-mcp-setup grant` | Review the incident target after `--write incident` |
| [Metadata caching no longer reads `sys_user` or `sys_properties`](#metadata-caching-in-every-auth-mode) | you granted reads on `sys_user` or `sys_properties` only so the metadata cache could resolve a time zone | Remove those grants; `sys_properties` can hold integration secrets |
| [OAuth client_credentials and API-key profiles start caching](#metadata-caching-in-every-auth-mode) | a profile uses OAuth `client_credentials` or an API key | After re-mapping its credential to another ServiceNow user, or tightening that user's roles or ACLs, restart the server or rotate the secret |

The [field policy reference](../README.md#field-policy) describes the
settings these changes refer to.

### `SN_FIELD_POLICY_DEFINITIONS` and `config.json`

Through 2.2.0-dev.6, `SN_FIELD_POLICY_DEFINITIONS` narrowed every profile that
stated no field policy of its own, including the profiles in `config.json`.
It now configures only the `SN_PROFILE_NAME` environment profile, the one used
when no `config.json` exists, the same way the `SN_ALLOWED_*` variables do.

Ignoring the variable would silently widen any `config.json` profile it used
to narrow. So when `config.json` exists and the variable is set to anything
but a blank value, the server refuses to start:

```text
[servicenow-mcp] Fatal stdio startup error: SN_FIELD_POLICY_DEFINITIONS is set, but profiles are loaded from the config file; it now applies only to the SN_PROFILE_NAME environment profile. Move the policy into each profile's fieldPolicy, or unset the variable.
```

`servicenow-mcp-setup` and `servicenow-mcp-profile` refuse the same way when
the variable is set in their own environment.

To fix it:

1. Copy the variable's value into each `config.json` profile it should narrow.
   A table map such as `{"*": {...}, "incident": {...}}` becomes that
   profile's `fieldPolicy`. A value that holds the profile keys
   (`fieldPolicy`, or `readableTableFields` and `writableTableFields`)
   supplies those keys.
2. Remove the variable everywhere the server reads it: the client's `env`
   block, your shell profile, and `~/.servicenow-mcp/server.env`, which the
   server reads at startup.
3. Restart the client, which starts the server again.

If no profile relied on the variable, step 2 is enough.

The environment profile still takes the variable. It is now read once, at
startup, and a malformed value stops startup with the key named, instead of
denying every request.

### Field-policy load errors

`fieldPolicy`, `readableTableFields` and `writableTableFields` are validated
when profiles load, with the same rules each request applies. A malformed
entry used to load and then deny every call on its profile, and a few
mistakes loaded and narrowed nothing. Each case below now stops startup.

One bad profile stops the whole `config.json` from loading, so every profile
in the file is unavailable until you fix it. `servicenow-mcp-setup` and
`servicenow-mcp-profile` load the same file and refuse it too, and
`servicenow-mcp-setup doctor` reports the message under its `profiles` check,
so fix the file by hand.

For a `config.json` profile the server prints:

```text
[servicenow-mcp] Fatal stdio startup error: Profile configuration is invalid: profile "<name>": <message>
```

A message names the key path and table, never a configured value. For the
environment profile there is no prefix, and the key path starts with
`SN_FIELD_POLICY_DEFINITIONS` instead of `fieldPolicy`. Under the dormant HTTP
transport, these load errors and the `SN_FIELD_POLICY_DEFINITIONS` refusal
print only `[servicenow-mcp] Fatal HTTP service startup error.`; run the stdio
server with the same environment, or `servicenow-mcp-setup doctor`, to see the
full message.

| Configuration | Message (after the prefix) |
|---|---|
| A field that is not a field name: a pattern such as `"u_*"`, or `"*"` mixed with names | `fieldPolicy.u_audit.writable[0] is not a field name. List exact field names (letters, digits, and underscores, starting with a letter, at most 80 characters), or use "*" on its own for every field; patterns such as "u_*" are not supported.` |
| The same field twice in one set, ignoring case | `fieldPolicy.incident.writable[4] repeats the field "state".` |
| A field set that is neither `"*"` nor a list | `fieldPolicy.incident.writable must be "*" or a list of field names.` |
| `fieldPolicy` that is not an object | `fieldPolicy must be an object that maps table names to { defaults, readable, writable }.` |
| A table key that is not a table name | `fieldPolicy key 2 is not a valid table name. Use a table name (letters, digits, and underscores, starting with a letter, at most 80 characters) or "*".` |
| A table entry that is not an object | `fieldPolicy.incident must be an object with defaults, readable, or writable.` |
| `defaults` outside `readable`, including a named table's `defaults` outside a `"*"` entry's `readable` | `fieldPolicy.incident.defaults lists "caller_id", which fieldPolicy.incident.readable does not allow.` |
| `defaults: "*"` beside a narrowed `readable` | `fieldPolicy.u_card.defaults is "*" (every field), which fieldPolicy.u_card.readable does not allow. List the default fields, or make readable "*".` |
| `fieldPolicy` together with one or both table lists | `fieldPolicy cannot be combined with readableTableFields. State the field policy in one form: fieldPolicy alone, or readableTableFields and writableTableFields without fieldPolicy.` |
| An unknown key in a table entry | `fieldPolicy.incident has an unknown key "writeable". A table entry accepts only defaults, readable, and writable.` |
| Two table keys that differ only in case | `fieldPolicy key 2 names table "incident" again (table names are case-insensitive); it repeats key 1. State each table once.` |
| A table list that is not a list | `writableTableFields must be a list of { table, fields } entries.` |
| A list entry that is not an object | `writableTableFields[0] must be an object with table and fields.` |
| An unknown key in a list entry | `writableTableFields[0] (table "incident") has an unknown key "writable". A list entry accepts only table and fields.` |
| One table twice in the same list, ignoring case | `writableTableFields[2] (table "incident") repeats a table already listed at writableTableFields[0]. List each table once.` |

An unknown key is named only when it is a valid identifier. Any other key,
including a comment key such as `_comment`, is reported by position, as in
`fieldPolicy.incident has an unknown key at position 2.` There is no
exemption for comment keys, so keep notes outside the policy.

`SN_FIELD_POLICY_DEFINITIONS` can also fail on its own:

| Value | Message |
|---|---|
| Set while `config.json` exists | The refusal [above](#sn_field_policy_definitions-and-configjson) |
| Not valid JSON | `SN_FIELD_POLICY_DEFINITIONS is not valid JSON.` |
| Valid JSON, but not an object | `SN_FIELD_POLICY_DEFINITIONS must be a JSON object.` |
| Longer than 65,536 characters | `SN_FIELD_POLICY_DEFINITIONS exceeds 65536 characters.` |
| Table keys mixed with the profile keys | `SN_FIELD_POLICY_DEFINITIONS mixes table keys with the profile keys writableTableFields. Use either a table map or the profile keys (fieldPolicy, readableTableFields, writableTableFields), not both.` |

### Journal fields and the dedicated tools

`sn_create`, `sn_update` and `sn_batch` now append `comments` and
`work_notes` on every table a profile may write
([Incident journal migration](#incident-journal-migration)). Two consequences
need a decision before you upgrade.

**Omitting the dedicated tools no longer withholds journals.** In 2.x
releases up to 2.2.0-dev.6, a profile whose `incident` target listed
`sn_update` but not `sn_incident_add_comment` could not post comments. After
the upgrade it can, through `sn_update`, `sn_create` and, where granted,
`sn_batch`, and on every other write-granted table too. To withhold
customer-visible comments, set `writable` to an explicit list without
`comments`. With no field policy, the effective list is every field, so there
is nothing to leave a field out of until you write one:

```json
{
  "fieldPolicy": {
    "incident": {
      "writable": ["short_description", "description", "state", "assigned_to", "assignment_group", "work_notes"]
    }
  }
}
```

State it on every table that needs it, or once on a `"*"` entry, which also
reaches the other ITSM tables and every custom table. Field policy is
evaluated against the table a call names, so narrow write-granted parent
tables such as `task` the same way, or do not grant writes on them.

**The dedicated tools now follow field policy.** `sn_incident_add_comment` is
denied when the incident's effective `writable` set leaves out `comments`, and
`sn_incident_add_work_note` when it leaves out `work_notes`. The effective set
comes from `fieldPolicy.incident.writable`, or from a `"*"` entry's
`writable` when `incident` does not state one. A profile that already narrows
either without the journal fields loses the matching tool, with a denial that
names the field and `fieldPolicy.incident.writable`. To keep a tool, add its
field to the list, for example `"incident": {"writable": [..., "comments"]}`.

### `incident` accepts every field

Through 2.2.0-dev.6, `sn_create` and `sn_update` accepted only the 14
`incident` fields with typed checks (`short_description`, `description`,
`caller_id`, `assignment_group`, `assigned_to`, `impact`, `urgency`,
`priority`, `category`, `subcategory`, `state`, `close_code`, `close_notes`
and `contact_type`), whatever the field policy said. (`sn_batch` applied no
value checks at all then, so it was never limited this way.) Every other
incident field is now writable wherever field policy allows it, with the
generic value bounds: for example `watch_list`, `active`, `parent_incident`,
`opened_by`, `company`, `cmdb_ci`, and every `u_` or `x_` field. The 14 keep
their typed checks.

So a profile with no field policy that grants `sn_create` or `sn_update` on
`incident` can now write all of them. Combined with journal
writes, a profile that may write both `watch_list` and `comments` can direct
comment notifications to any address (see
[Production security boundaries](PRODUCTION-SECURITY.md#writing-journals)).
If you relied on the old limit, list the fields agents may set:

```json
{
  "fieldPolicy": {
    "incident": {
      "writable": ["short_description", "description", "state", "assigned_to", "assignment_group", "work_notes"]
    }
  }
}
```

A `"*"` entry's `writable` list covers `incident` too, when `incident` does
not state its own.

### A wildcard list now means every field

`["*"]` in `defaults`, `readable` or `writable`, or as a list entry's
`fields`, now means the same as `"*"`. Through 2.2.0-dev.6 it was read as a
field named `*`, which is not a field name, so every call on the profile
failed. After the upgrade, a profile that used it is fully open for that set.
If you did not intend every field, replace it with an explicit list. Only the
exact form `["*"]` is widened: `["*", "number"]` and similar look-alikes now
fail at load.

### The `"*"` entry reaches the ITSM and custom tables

Through 2.2.0-dev.6, a profile's `"*"` entry applied only to tables that had
no entry of their own, built-in or named. The 34 built-in tables were never
narrowed by it, and a custom table the profile named took its unstated keys
from the open default.

Now `readable` and `writable` resolve key by key, from the table's own entry,
then the `"*"` entry, then every field, on:

- the 11 ITSM tables: `incident`, `change_request`, `problem`, `sc_request`,
  `sc_req_item`, `sc_task`, `task`, `cmdb_ci`, `cmdb_ci_server`,
  `cmdb_ci_computer`, `kb_knowledge`;
- every table without a built-in entry, named in the policy or not.

The other 23 built-in tables are system tables, listed in the
[field policy reference](../README.md#field-policy). A `"*"` entry never
reaches them, named or not.

What changes:

- `{"*": {"writable": []}}` on a profile that grants writes on `incident` used
  to allow incident writes, and now denies them, including the dedicated
  journal tools.
- `{"*": {"writable": []}, "u_x": {"readable": ["sys_id", "name"]}}` used to
  leave `u_x` writable, and now denies writes to it.
- A named custom table that states only `defaults`, under a `"*"` entry that
  states `readable`, now fails to load if its defaults fall outside that
  readable set.
- The ITSM tables' default read projections are trimmed to a narrowed `"*"`
  `readable` set.

To keep a key open on one table, state it on that table:

```json
{
  "fieldPolicy": {
    "*": { "writable": [] },
    "incident": { "writable": "*" },
    "u_x": { "readable": ["sys_id", "name"], "writable": "*" }
  }
}
```

A `"*"` entry still does not make a profile read-only, because it never
reaches the system tables. Use `tableAccess.writeTables: []` for that.

### Class and domain fields

`sys_class_name`, `sys_class_path`, `sys_domain` and `sys_domain_path` move a
record to another class or domain. No writable wildcard covers them any more,
including the open default of a profile with no field policy. Up to
2.2.0-dev.6, any table except `incident` accepted them under a wildcard.

To allow one, list it by name in the table's `writable`, or in a `"*"`
entry's `writable` for a table that entry reaches. Listing `sys_domain` does
not list `sys_domain_path`, and the reverse. Otherwise the write is denied
with:

```text
Write denied by policy: field "sys_domain" on "incident" changes the record's class or domain, so a writable wildcard never covers it. List it explicitly in fieldPolicy.incident.writable to allow this write.
```

### `readable: []` and `writable: []`

`readable: []` used to block writes to a table as a side effect: the write
was denied while its response projection was prepared, before anything was
sent. Writes to such a table now succeed and
return only the record's `sys_id`. Reads stay denied, and `sn_batch` still
cannot run there, because it reads the matching `sys_id`s first.

If you used `readable: []` to hide a table entirely, add `writable: []`, or
leave the table out of `tableAccess`.

Every write response now includes the written record's `sys_id`, even when
the readable set leaves it out. Every other field, `number` included, follows
the readable set.

### Setup grant defaults

- Without `--tools`, `servicenow-mcp-setup grant --write incident` now binds
  `sn_incident_add_comment` and `sn_incident_add_work_note` to the incident
  target, next to `sn_create` and `sn_update`. Existing profiles are not
  changed on upgrade; re-run the grant to add the tools.
- Defaults apply only to the tables, and the operations, named in that
  command. A read grant adds no write tools and a write grant adds no read
  tools, including on a table that was reachable only as another target's
  related table.

See [Granting table access](CLIENT-SETUP.md#granting-table-access) for the
opt-outs.

### Metadata caching in every auth mode

Through 2.2.0-dev.6, the metadata cache needed the session time zone. It read
`sys_user.time_zone` for the profile's username, falling back to the
`glide.sys.default.tz` property in `sys_properties`, and it turned itself off
for OAuth `client_credentials` and API-key profiles, which have no username.
It now checks freshness against the cached table's own row count and newest
row, so it reads neither table and works the same in every auth mode.

- **Remove grants made only for the old cache.** If you granted read access
  to `sys_user` or `sys_properties` only for this lookup, whether in
  `tableAccess.readTables`, in `SN_ALLOWED_READ_TABLES`, or as a role on the
  integration user, remove it. `sys_properties` rows routinely hold
  integration secrets.
- **Client-credentials and API-key profiles start caching.** Cache entries are
  partitioned by credential, not by the ServiceNow user it runs as, and a hit
  re-reads only the table's watermark. After you re-map the OAuth application
  or API key to another user, or tighten that user's roles or ACLs, restart
  the server or rotate the secret; until then, rows cached earlier can be
  served for up to one TTL. A profile's `tableAccess` and `fieldPolicy` still
  apply on every call.

See [Metadata caching](CLIENT-SETUP.md#metadata-caching) for how the
watermark works and what it can miss.
