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

## Breaking changes at a glance

| # | Change | Before (1.0.0) | After (2.0.0) |
|---|--------|----------------|---------------|
| 1 | Transport | stdio; the client spawns `servicenow-mcp` | unchanged — stdio; the client spawns `servicenow-mcp` |
| 2 | Profile selection | implicit, from `SN_*` in the client's env | every tool call carries an explicit `profile` |
| 3 | Table access | any table the credential could reach | deny-by-default per profile; explicit allowlist plus target entries |
| 4 | Attachments | host `file_path` / `output_path` | inline base64 both directions; no host filesystem access, and no flag restores it |
| 5 | Queries | raw ServiceNow encoded queries | structured filters; raw reads are opt-in per tool/table |
| 6 | Incident journals | `sn_update` accepted `comments` / `work_notes` | dedicated `sn_incident_add_comment` / `sn_incident_add_work_note` |
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
  schema reads, off by default for tables you do not name. It requires a
  resolvable session timezone, so it is **disabled for OAuth
  client_credentials and API-key profiles**, which carry no username — see
  [Metadata caching prerequisites](CLIENT-SETUP.md#metadata-caching-prerequisites).
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

**After:** `sn_incident_add_comment` with `{profile, sys_id, content}` for a
customer-visible comment, or `sn_incident_add_work_note` for an internal note.
`sn_update` rejects both fields before credentials are resolved.

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

Table allowlists are paired with a separate field-policy gate. Built-in field
policy remains finite for known tables, and operators can extend/override it
with `SN_FIELD_POLICY_DEFINITIONS`, keyed by exact table name or `*` for a
generic fallback. Each entry may define `defaults`, `readable`, and `writable`;
`readable`/`writable` accept exact field arrays or `"*"`. Sensitive field-name
families remain denied even when wildcard field access is configured. Example
read-only custom-table exploration:

```sh
export SN_ALLOWED_READ_TABLES='*'
export SN_ALLOWED_WRITE_TABLES=''
export SN_FIELD_POLICY_DEFINITIONS='{"*":{"defaults":["sys_id"],"readable":"*","writable":[]}}'
```

Use `writable:"*"` only when broad mutation access is intentional; write field
wildcards do not imply read field access or table write access.

The service normalizes identifiers and rejects malformed entries. It does not
refuse any particular table: since 2.0 there is no built-in deny list, so a
credential, authentication, or role-grant table configured in `tableAccess` is
granted, bounded only by the integration account's ServiceNow roles.
Multi-table tools must have their complete operation plan authorized before the
first ServiceNow client access. `sn_nl`
and ATF `run`/`run-suite` are temporarily denied at this boundary because they
do not yet expose complete typed side-effect plans; select typed CRUD/query
tools or non-executing ATF actions directly.

### Incident journal migration

Generic `sn_update` no longer accepts the append-only incident fields
`comments` or `work_notes`. Those inputs fail before profile credentials or a
ServiceNow client are resolved and direct the caller to the matching dedicated
tool:

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
