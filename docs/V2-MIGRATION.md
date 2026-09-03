# Migrating to 2.0

2.0 is an authenticated, single-owner HTTP service. It intentionally removes
the 1.x local-process launch contract. Every published release before it is
`1.0.0`, so this guide is written for a 1.0.0 install.

## Breaking changes at a glance

| # | Change | Before (1.0.0) | After (2.0.0) |
|---|--------|----------------|---------------|
| 1 | Transport | stdio; the client spawns `servicenow-mcp` | Streamable HTTP at `/mcp`; the client connects to a URL. A bearer token is optional and off by default |
| 2 | Profile selection | implicit, from `SN_*` in the client's env | every tool call carries an explicit `profile` |
| 3 | Table access | any table the credential could reach | deny-by-default per profile; explicit allowlist plus target entries |
| 4 | Attachments | host `file_path` / `output_path` | inline base64 both directions; no host filesystem access, and no flag restores it |
| 5 | Queries | raw ServiceNow encoded queries | structured filters; raw reads are opt-in per tool/table |
| 6 | Incident journals | `sn_update` accepted `comments` / `work_notes` | dedicated `sn_incident_add_comment` / `sn_incident_add_work_note` |
| 7 | Tool surface | 17 tools, one `bin` | 19 tools, three `bin` entries; `sn_script` withdrawn |
| 8 | Field selection limit | `MAX_FIELDS_PER_OPERATION` was `32`; over-selection raised `excessive_field_selection` | limit is `10_000`; `excessive_field_selection` is removed from the exported `FieldPolicyFailureReason` union |
| 9 | Capabilities | `tools` only | adds `prompts` (`servicenow-mcp.add-profile`) |

Each is expanded below. Items 1-3 require action on every install; the rest
apply only if you used the affected surface.

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

### 1. Transport

**Before** — client config launched a process:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "@onlyflows/servicenow-mcp"],
      "env": { "SN_INSTANCE": "https://yourinstance.service-now.com", "SN_USER": "u", "SN_PASSWORD": "p" }
    }
  }
}
```

**After** — run the service, then point the client at its URL. Delete the
`command`, `args`, and `env` keys entirely; there is no stdio fallback,
compatibility flag, or alternate executable.

```json
{
  "mcpServers": {
    "servicenow-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

The `/mcp` endpoint is unauthenticated unless you set `MCP_BEARER_TOKEN`. Where
you have, add `"headers": { "Authorization": "Bearer ${SERVICENOW_MCP_BEARER_TOKEN}" }`
and export that variable into the client's environment.

Per-client syntax, including the clients that need an `mcp-remote` bridge, is
in [CLIENT-SETUP.md](CLIENT-SETUP.md#7-mcp-client-configuration).
`servicenow-mcp-setup` registers the clients it can.

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

- `servicenow-mcp` — the Streamable HTTP service (and `servicenow-mcp setup`)
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

Remove any MCP client entry that starts `servicenow-mcp` with a local
`command`, executable path, or `args`. Local Claude stdio configuration is no
longer supported. V2 has no stdio compatibility flag, alternate executable, or
fallback transport.

Configure a standards-compliant MCP Streamable HTTP client with:

- URL: `http://127.0.0.1:3000/mcp` by default
- Header: `Authorization: Bearer <MCP_BEARER_TOKEN>`, only where the service is
  configured with one; omit it entirely otherwise

Client configuration syntax varies, but the protocol contract does not depend
on any AI provider. Use TLS or an approved private-access boundary before
binding outside loopback.

For complete official SDK and independent Fetch examples using the same
endpoint, explicit profile selection on every invocation, two isolated named
profiles, and safe result/audit verification, see
[V2 service and client setup](CLIENT-SETUP.md).

## Start the service

`MCP_OWNER_ID` and `MCP_CLIENT_ID` label every audit record and default to
`local-owner` / `local-client`. `MCP_BEARER_TOKEN` is optional: without it the
`/mcp` endpoint is unauthenticated and any local process that reaches it has
whatever access the profiles grant. See
[Production security boundaries](PRODUCTION-SECURITY.md#http-authentication-is-optional-and-off-by-default).

```bash
export MCP_OWNER_ID="your-owner-id"
export MCP_CLIENT_ID="your-client-id"
export SN_ALLOWED_READ_TABLES="incident,problem,change_request"
export SN_ALLOWED_WRITE_TABLES="incident,change_request"
export SN_TABLE_ACCESS_TARGETS='[{"table":"incident","kind":"canonical","tools":["sn_query","sn_get","sn_create","sn_update","sn_incident_add_comment","sn_incident_add_work_note","sn_delete","sn_batch"],"closureComplete":true,"relatedTables":["incident"]},{"table":"problem","kind":"canonical","tools":["sn_query","sn_get"],"closureComplete":true,"relatedTables":["problem"]},{"table":"change_request","kind":"canonical","tools":["sn_query","sn_get"],"closureComplete":true,"relatedTables":["change_request"]}]'
export SN_PROFILE_NAME="dev"
export SN_INSTANCE="https://yourinstance.service-now.com"
export SN_USER="your_username"
npm run build
npm start
```

Before running those non-secret commands, have the approved supervisor,
orchestrator, keychain, or secret manager inject the authentication-specific
ServiceNow secret — and `MCP_BEARER_TOKEN`, if the endpoint is to be
authenticated — directly into the service process.
Do not put either value in shell input, command arguments, dotenv files, or
history.

> **The `SN_*` variables above build a profile only when
> `~/.servicenow-mcp/config.json` does not exist.** Once you create a profile
> with `servicenow-mcp-profile`, that file exists, `SN_PROFILE_NAME` stops
> constructing a profile, and `SN_ALLOWED_READ_TABLES` /
> `SN_ALLOWED_WRITE_TABLES` / `SN_TABLE_ACCESS_TARGETS` stop applying — the
> server then denies every call. Put the rules on the profile instead:
> `servicenow-mcp-setup grant --profile dev --read incident --write incident`.
> `servicenow-mcp-setup doctor` detects exactly this situation.

For the recommended local path, use the bootstrap instead:

```bash
servicenow-mcp-setup                 # generates ~/.servicenow-mcp/server.env
set -a; source ~/.servicenow-mcp/server.env; set +a
servicenow-mcp
```

Production uses `npm start`. Local development uses `npm run dev`, which builds
and starts the same HTTP-only entrypoint with source maps enabled.

Optional runtime settings:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_HOST` | `127.0.0.1` | Bind host |
| `MCP_PORT` | `3000` | Listen port |
| `MCP_ALLOWED_HOSTS` | bind/socket authorities | Comma-separated exact public `Host` authorities; include ports when clients send them. The container's reserved loopback-only health authority is internal and must not be added. |
| `MCP_ALLOWED_ORIGINS` | deny browser origins | Comma-separated exact HTTP(S) origins; requests without `Origin` remain allowed |
| `MCP_MAX_CONCURRENT_REQUESTS` | `2` | Concurrent admitted `/mcp` requests (1–1024 syntactically); excess work receives HTTP 503 and is never queued. Startup **throws** for values above the combined 512 MiB estimate — with the shipped 1 MiB body limit the maximum is 2, and `3` refuses to start |
| `MCP_MAX_CONNECTIONS` | `128` | Accepted TCP connections (1–4096); excess sockets are dropped, and unread early-rejection bodies are limited to a 16 KiB/100 ms drain before destruction |
| `MCP_SHUTDOWN_GRACE_MS` | `10000` | Drain deadline for SIGINT/SIGTERM (1–300000 ms) |
| `MCP_PRE_AUTH_RATE_CAPACITY` | `240` | Direct-source request capacity per refill period (1–1000000) |
| `MCP_PRE_AUTH_RATE_REFILL_MS` | `60000` | Direct-source refill period in milliseconds (1–86400000) |
| `MCP_PRE_AUTH_RATE_MAX_ENTRIES` | `4096` | Retained digested direct-source buckets (1–100000) |
| `MCP_IDENTITY_RATE_CAPACITY` | `120` | Owner/client request capacity per refill period (1–1000000) |
| `MCP_IDENTITY_RATE_REFILL_MS` | `60000` | Owner/client refill period in milliseconds (1–86400000) |
| `MCP_IDENTITY_RATE_MAX_ENTRIES` | `128` | Retained digested owner/client buckets (1–100000) |

The `/mcp` endpoint defaults to a bounded pre-authentication bucket (240
requests per 60 seconds per direct socket source, 4096 retained sources) and
authenticated bucket (120 requests per 60 seconds per owner/client identity,
128 retained identities). Capacity, refill period, and retained-key bounds are
operator-configurable only within the validated ranges above. It does not trust
forwarded-address headers. A rejected request is HTTP 429 with a bounded
`Retry-After` header and this body:

```json
{
  "error": "rate_limited",
  "message": "Rate limited. Retry after the number of seconds in retry_after_seconds or the Retry-After header.",
  "retry_after_seconds": 1
}
```

`retry_after_seconds` always matches the `Retry-After` header. The limits are
process-local and reset on restart. Health probes are exempt from the MCP source bucket so exhausted
client traffic cannot change liveness or readiness semantics.

Each authenticated `/mcp` `POST` accepts one JSON-RPC message in a JSON body of
at most 1 MiB. Oversized bodies are rejected with HTTP 413. Malformed JSON and
JSON-RPC batch arrays are rejected with HTTP 400 before MCP server construction
or tool dispatch; clients must send batch items as separate HTTP requests. The
effective defaults are 15 seconds to read the body, 120 seconds end to end for
an admitted request, 10 seconds for headers, 30 seconds for the Node request,
and 5 seconds for keep-alive.

Configured browser origins receive exact-origin CORS responses for `POST` and
the `Accept`, `Authorization`, `Content-Type`, and `Mcp-Protocol-Version`
headers; preflight is HTTP 204 and `X-Request-Id` is exposed. An omitted
`MCP_ALLOWED_ORIGINS` denies every request that carries `Origin`, while
non-browser requests without `Origin` continue to work.

Admission uses a combined estimate backed by hostile JSON measurements. A
900,001-byte array of 300,000 empty objects expanded 22.4× on the heap and 54×
in RSS, so request JSON plus ServiceNow JSON/text receives a 64× safety factor.
One ExecutionContext can consume at most 1 MiB of ServiceNow JSON/text in total
across parallel calls; declared bytes are reserved atomically and streamed
bytes are charged before `JSON.parse`. Raw attachment downloads preserve a
separate cumulative 10 MiB memory budget with an 8× allowance for Buffer,
base64/UTF-16, and JSON serialization. That figure is an internal memory
reservation, not a usable attachment size.

The constructor enforces `concurrency × (((request MiB + 1 MiB) × 64) +
(10 MiB × 8)) <= 512 MiB`. Defaults therefore estimate 208 MiB per request and
416 MiB for concurrency 2; concurrency 3 needs 624 MiB and **fails startup**.
OAuth token and error bodies are capped at 64 KiB within the remaining default
headroom. This is a conservative admission estimate rather than a hard process
heap/RSS limit, so reduce `MCP_MAX_CONCURRENT_REQUESTS` when the deployment
memory budget requires more headroom for other application state.

Body size and concurrency trade directly against each other:

| `maxBodyBytes` | Highest concurrency that starts | Effect |
|---|---|---|
| 1 MiB (shipped default) | 2 | 416 MiB budgeted; the intended configuration |
| 1.75 MiB | 2 | 512 MiB — exactly at the ceiling |
| **2 MiB** | **1** | **Single-flight: every tool call serializes** |
| 5.75 MiB | 1 | the last value that starts at all |
| above 5.75 MiB | none | startup fails at any concurrency |

Above 5.75 MiB the failure is a constructor `throw`, not a clamp, and its
message — *"HTTP maxConcurrentRequests and maxBodyBytes exceed the estimated
body-memory ceiling"* — names the two settings but not the ceiling, the
arithmetic, or a working value. At 2 MiB there is no failure at all: the
runtime simply cannot start above concurrency 1, so every request serializes
with no warning and no log line. One large upload then blocks every other tool
call, and nothing connects the cause to the effect.

**`maxBodyBytes` is not operator-configurable in the shipped executable.**
`src/index.ts` builds the request policy with only `allowedHosts` and
`allowedOrigins`, so the limit is always 1 MiB and no environment variable
changes it. Both thresholds above bind embedders calling `createHttpRuntime`
directly. For an operator, the only reachable form of this failure is
`MCP_MAX_CONCURRENT_REQUESTS=3`.

A 10 MiB attachment is unreachable over HTTP at any concurrency: base64
inflates it to about 13.33 MiB on the wire, budgeting roughly 997 MiB against a
512 MiB ceiling. Raising the body limit is not a path to it.

Request and tool completion events are written as JSON Lines on stderr. They
contain bounded correlation, latency, outcome/reason, and status fields. Raw
owner/client identifiers are hashed, and request headers, URL/query strings,
bodies, credentials, tokens, config, and exception text are structurally
excluded. Stderr delivery is nonblocking and retains at most 256 pending lines
during backpressure. Excess events are dropped and later summarized as
`{"type":"telemetry_dropped","count":N}` after stderr drains, so collectors
must monitor these records as evidence of telemetry loss.

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

## Shutdown

`GET`/`HEAD /health/live` reports process liveness without contacting
ServiceNow. `GET`/`HEAD /health/ready` reports whether startup has completed and
the runtime can admit MCP work; it changes to 503 before shutdown draining.

The executable handles both SIGINT and SIGTERM. It stops accepting new HTTP
work, drains accepted requests for `MCP_SHUTDOWN_GRACE_MS`, closes owned MCP
resources, and force-closes remaining connections when the bound expires.
Repeated signals share the same shutdown operation.

The production OCI artifact runs as numeric UID/GID `10001:10001`, supports a
read-only root filesystem, and receives all profiles, keys, owner auth, and
ServiceNow credentials at runtime. See
[Production container deployment](CONTAINER-DEPLOYMENT.md) for pinned builds,
least-privilege run flags, profile mounts, two-client validation, provenance,
SBOM, scanning, and version-identification commands.

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
