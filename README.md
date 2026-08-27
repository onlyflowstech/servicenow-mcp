# @onlyflows/servicenow-mcp

<!-- Logo placeholder -->
<!-- ![ServiceNow MCP Server](banner.png) -->

**The most comprehensive ServiceNow MCP server.** 20 tools for full CRUD, append-only incident journals, CMDB graph traversal, ATF testing, multi-instance profiles, and more.

Built by [OnlyFlows](https://onlyflows.tech) · Published by [@onlyflowstech](https://github.com/onlyflowstech)

[![npm version](https://img.shields.io/npm/v/@onlyflows/servicenow-mcp)](https://www.npmjs.com/package/@onlyflows/servicenow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Multi-Instance Profiles

Manage multiple ServiceNow instances (dev, test, prod, PDI) with named profiles. Every tool call must select one configured profile explicitly; V2 has no active-profile or default-profile fallback.

### Setup

Create `~/.servicenow-mcp/config.json`:

```json
{
  "version": 2,
  "profiles": {
    "dev": {
      "instance": "https://mydev.service-now.com",
      "username": "admin",
      "credential": "env:SN_PASSWORD_DEV",
      "description": "Development instance"
    },
    "prod": {
      "instance": "https://myprod.service-now.com",
      "username": "api.user",
      "credential": "env:SN_PASSWORD_PROD",
      "description": "Production instance"
    }
  }
}
```

Have the approved supervisor, orchestrator, keychain, or secret manager inject
the values referenced by `SN_PASSWORD_DEV` and `SN_PASSWORD_PROD` into the HTTP
service process. Do not type either value into a shell command, command
argument, dotenv file, or command history.

### Credential Options

| Format | Example | Description |
|--------|---------|-------------|
| Legacy environment reference | `"env:SN_PASSWORD_DEV"` | Read-compatible V1 form; migrated to a structured reference on the next write |
| Secret reference | `{"type":"secret_ref","provider":"env","reference":"SN_PASSWORD_DEV"}` | Provider-neutral reference resolved only for the selected request |
| Encrypted envelope | `{"type":"encrypted","version":1,...}` | AES-256-GCM value created by the protected administration CLI |

Plaintext profile secrets are rejected. Use the installed `servicenow-mcp-profile`
operator command to create, inspect, rotate, or remove profiles; it reads secrets
through a protected prompt or bounded standard input and rejects credential-bearing
command-line arguments. Encrypted sources require exactly 32 random bytes encoded
as base64 or base64url in `SN_PROFILE_ENCRYPTION_KEY`, supplied separately by the
deployment secret mechanism and never stored in the profile file. See the
[profile credential and administration guide](docs/PROFILE-CREDENTIALS.md).

The legacy `env:VAR_NAME` indirection remains readable for every secret field:
`credential`, `clientSecret`, and `apiKey`.

### Using Profiles

Pass the `profile` parameter on every tool call:

- *"query incidents on prod"* — calls `sn_query` with `profile: "prod"`
- *"get incident INC0010001 on dev"* — calls `sn_get` with `profile: "dev"`
- *"show me the dev profile endpoint"* — calls the read-only `sn_profile` diagnostic with `profile: "dev"`

Profiles are created and changed out of band by the service operator. Legacy
`default_profile` metadata is ignored and is not persisted on the next
administrative write; the MCP boundary never consults it.

### `SN_*` configuration compatibility

If no config file exists, canonical `SN_*` connection values are exposed only
through an explicit `SN_PROFILE_NAME` mapping. For example, set
`SN_PROFILE_NAME=dev` with `SN_INSTANCE`, `SN_USER`, and `SN_PASSWORD`, then
call tools with `profile: "dev"`. Without `SN_PROFILE_NAME`, bare connection
variables create no profile and cannot route a request. Secret values remain
runtime-only environment references and are never persisted as plaintext.

---

## Authentication

Three ServiceNow auth types are available per profile, selected with `authType` (default: `basic`). Profile configuration is managed out of band by the service operator. This is separate from the required bearer authentication protecting the MCP HTTP endpoint.

> **Heads up:** ServiceNow's [inbound Basic Auth restriction program](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB3096078) is phasing out basic auth for API requests — instances can start hard-rejecting it at any time (exemptions: Web-Service-Access-Only accounts or the `snc_basic_auth_api_access` role). **OAuth is the recommended auth type.** The server prints a startup warning for basic-auth profiles.

### OAuth 2.0 (recommended)

`client_credentials` grant (default) — create an OAuth API endpoint client in ServiceNow (**System OAuth → Application Registry**) and reference the secret via `env:` indirection:

```json
{
  "version": 2,
  "profiles": {
    "dev": {
      "instance": "https://mydev.service-now.com",
      "authType": "oauth",
      "clientId": "your-oauth-client-id",
      "clientSecret": "env:SN_CLIENT_SECRET",
      "description": "OAuth client_credentials"
    }
  }
}
```

`password` grant — set `grantType` and provide the user credentials as well:

```json
{
  "instance": "https://mydev.service-now.com",
  "authType": "oauth",
  "grantType": "password",
  "clientId": "your-oauth-client-id",
  "clientSecret": "env:SN_CLIENT_SECRET",
  "username": "integration.user",
  "credential": "env:SN_PASSWORD_DEV"
}
```

Tokens are cached until shortly before their `expires_in` expiry and refreshed automatically (including a single refresh + retry on 401). Token responses are never logged.

### API key

For instances using Inbound Authentication Profiles with API keys. The header name is configurable (default `x-sn-apikey`):

```json
{
  "instance": "https://mydev.service-now.com",
  "authType": "apikey",
  "apiKey": "env:SN_API_KEY",
  "apiKeyHeader": "x-sn-apikey"
}
```

### Basic (default, deprecated by ServiceNow)

```json
{
  "instance": "https://mydev.service-now.com",
  "username": "admin",
  "credential": "env:SN_PASSWORD_DEV"
}
```

On a 401, the error explains the Basic Auth restriction program (KB3096078) and how to move to OAuth.

### Timeouts & retries

Every request is bounded by a timeout (default 30s; per-profile `timeoutMs` or env `SN_TIMEOUT_MS`) and retried up to twice with exponential backoff on 429/502/503/504, honoring `Retry-After`. POST requests are only retried on 429 — never after a 5xx that may have executed side effects.

---

## Why This MCP Server?

Most ServiceNow MCP integrations are **read-only** and support a handful of
tables. This service offers a broader tool catalog behind explicit,
deny-by-default table and tool policy:

| Feature | Others | @onlyflows/servicenow-mcp |
|---------|--------|--------------------------|
| Query records | ✅ | ✅ |
| Create records | ❌ | ✅ |
| Update records | ❌ | ✅ |
| Delete records | ❌ | ✅ (with safety confirm) |
| Bulk operations | ❌ | ✅ (dry-run by default) |
| Aggregations (COUNT/AVG/MIN/MAX/SUM) | ❌ | ✅ |
| Table schema introspection | ❌ | ✅ |
| CMDB relationship traversal | ❌ | ✅ (recursive, configurable depth) |
| Instance health monitoring | ❌ | ✅ (version, nodes, jobs, stats) |
| Attachment management | ❌ | ✅ (list, upload, download) |
| System log queries | ❌ | ✅ |
| Code search across artifacts | ❌ | ✅ |
| Table/app/plugin discovery | ❌ | ✅ |
| ATF test execution | ❌ | 🚧 listing/results available; execution currently policy-denied |
| Natural language interface | ❌ | 🚧 currently policy-denied pending a typed access plan |
| Background scripts | ❌ | 🚧 on the [roadmap](#roadmap) (SNS-39) |
| Multi-instance profiles | ❌ | ✅ (named profiles, per-call override) |
| **Total tools** | **1–3** | **20** |

---

## Quick Start

V2 is an HTTP service and requires Node.js 20 or newer. Set the required single-owner authentication values and ServiceNow profile configuration in the service environment, then start it:

Use [`.env.example`](.env.example) only as a non-secret configuration
inventory. Its protected-value assignments are intentionally empty; inject
bearer tokens and ServiceNow secrets through a supervisor, orchestrator,
keychain, or secret manager rather than filling a repository dotenv file.

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

Before running those non-secret commands, the approved runtime secret
mechanism must already have injected `MCP_BEARER_TOKEN` and the
authentication-specific ServiceNow secret into the service process. Do not
enter either value in this shell block or append it to `npm start`.

The MCP endpoint is `http://127.0.0.1:3000/mcp` by default. Configure a standards-compliant Streamable HTTP client with that URL and this request header:

```text
Authorization: Bearer <the MCP_BEARER_TOKEN value>
```

The endpoint uses standard MCP Streamable HTTP and does not require a provider-specific adapter. Use TLS or an approved private-access boundary before any non-loopback deployment.

For complete official SDK and independent Fetch client examples, safe
two-profile setup, crossed profile/result/audit checks, and optional provider
connectivity, see [V2 service and client setup](docs/CLIENT-SETUP.md).

Unauthenticated `GET`/`HEAD` probes are available at `/health/live` and
`/health/ready`. Liveness is process-local and never calls ServiceNow;
readiness reports whether this runtime is currently able to admit MCP work.
The production container's baked probe connects over loopback with the reserved
`Host: mcp-health.internal` authority. That authority is accepted only for the
two health paths from a loopback peer; it never grants `/mcp` access and should
not be added to `MCP_ALLOWED_HOSTS`.
Authenticated `/mcp` requests accept one JSON-RPC message per HTTP `POST` and
are limited to a 1 MiB JSON body. Oversized bodies receive HTTP 413; malformed
JSON and JSON-RPC batch arrays receive HTTP 400 before MCP server construction
or tool dispatch. The effective transport defaults are a 15-second body-read
timeout, a 120-second end-to-end admitted-request deadline, a 10-second header
deadline, a 30-second Node request timeout, and a 5-second keep-alive timeout.

### Breaking change from V1

V2 no longer supports local child-process or command/arguments-based MCP configuration. In particular, local Claude stdio configuration is not supported and there is no compatibility flag or alternate executable that restores it. Replace the old local-process entry with the authenticated `/mcp` URL. See [V2 migration](docs/V2-MIGRATION.md) for the complete checklist.

For the pinned, numeric non-root OCI artifact, read-only runtime flags,
runtime-only secret/profile injection, health/shutdown contract, provenance,
scanning, and cross-platform build guidance, see
[Production container deployment](docs/CONTAINER-DEPLOYMENT.md).
For health interpretation, derived telemetry, alerts, dashboards, retention,
deployment, rollback, rotation, incident response, and redacted support
collection, see the [Remote operations runbook](docs/OPERATIONS-RUNBOOK.md).
For an optional outbound-only Secure MCP Tunnel adapter, ChatGPT developer-mode
setup, redacted validation evidence, and teardown, see
[Private ChatGPT connectivity](docs/PRIVATE-CHATGPT-CONNECTIVITY.md).

---

## Tools Reference

### Core CRUD

| Tool | Description |
|------|-------------|
| `sn_query` | Query an approved table with structured filters, field selection, pagination, and sorting; bounded raw reads require an explicit policy rule |
| `sn_get` | Get a single record by sys_id from an approved table |
| `sn_create` | Create an incident using only controlled ordinary writable fields |
| `sn_update` | Update one incident selected by exact `sys_id`, using only controlled ordinary writable fields; rejects `comments` and `work_notes` with dedicated-tool migration guidance |
| `sn_incident_add_comment` | Append one bounded customer-visible comment to an incident; repeated calls append again |
| `sn_incident_add_work_note` | Append one bounded internal work note to an incident; repeated calls append again |
| `sn_delete` | Delete a record on an approved write table (requires `confirm: true`) |
| `sn_batch` | Bulk update/delete using a required structured filter and dry-run safety (raw encoded selectors are prohibited; requires `confirm: true` to execute) |

### Analytics & Schema

| Tool | Description |
|------|-------------|
| `sn_aggregate` | COUNT, AVG, MIN, MAX, SUM with grouping |
| `sn_schema` | Table field definitions, types, references |
| `sn_health` | Instance version, cluster nodes, stuck jobs, key stats |

### CMDB & Operations

| Tool | Description |
|------|-------------|
| `sn_relationships` | CMDB CI graph traversal — upstream/downstream/both, configurable depth |
| `sn_attach` | List attachments, return downloads as base64, and upload base64 content (10 MiB decoded cap) |
| `sn_syslog` | Query system logs with severity/source/time filters |
| `sn_codesearch` | Search business rules, script includes, client scripts, etc. |
| `sn_discover` | Discover tables, scoped apps, store apps, plugins |

### Testing & Automation

| Tool | Description |
|------|-------------|
| `sn_atf` | List ATF tests/suites and get results; `run`/`run-suite` currently fail closed |
| `sn_nl` | Currently fails closed until natural-language composition emits a complete typed access plan |
| `sn_script` | Background script execution — **not yet supported**; returns an explanatory error pointing to `sn_query`/`sn_batch` alternatives (see [Roadmap](#roadmap)) |

### Profile Management

| Tool | Description |
|------|-------------|
| `sn_profile` | Inspect non-secret metadata for one explicitly named profile; profile configuration is operator-managed out of band |

---

## Environment Variables

### MCP HTTP runtime

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_BEARER_TOKEN` | ✅ | — | Static bearer secret protecting `/mcp`; 32–4096 valid bearer characters. Startup fails if absent or invalid. |
| `MCP_OWNER_ID` | ✅ | — | Stable non-secret owner identifier recorded in request/tool context. |
| `MCP_CLIENT_ID` | ✅ | — | Stable non-secret client identifier recorded in request/tool context. |
| `MCP_HOST` | ❌ | `127.0.0.1` | HTTP bind host. Non-loopback binding requires an approved private-access or TLS boundary. |
| `MCP_PORT` | ❌ | `3000` | HTTP listen port. |
| `MCP_ALLOWED_HOSTS` | ❌ | bind/socket authorities | Comma-separated exact HTTP `Host` authorities. When omitted, only safe authorities derived from the bind address and accepted socket are allowed. Include ports when clients send them. |
| `MCP_ALLOWED_ORIGINS` | ❌ | deny browser origins | Comma-separated exact HTTP(S) browser origins. Requests with no `Origin` remain allowed; an `Origin` or CORS preflight must match this list exactly. |
| `MCP_MAX_CONCURRENT_REQUESTS` | ❌ | `2` | Accepted `/mcp` requests that may execute concurrently (1–1024 syntactically). Excess work is not queued; it receives HTTP 503 and `Retry-After: 1`. Startup rejects values whose combined request/upstream estimate exceeds 512 MiB; with default body limits the maximum is 2. |
| `MCP_MAX_CONNECTIONS` | ❌ | `128` | Accepted TCP connections (1–4096). Excess sockets are dropped before HTTP request admission. Unread bodies after an early response are drained for at most 16 KiB and 100 ms, then destroyed. |
| `MCP_SHUTDOWN_GRACE_MS` | ❌ | `10000` | Bound from 1–300000 ms for draining accepted HTTP work before active sockets/resources are forced closed. |
| `MCP_PRE_AUTH_RATE_CAPACITY` | ❌ | `240` | Pre-authentication requests available per direct socket-source refill period (1–1000000). |
| `MCP_PRE_AUTH_RATE_REFILL_MS` | ❌ | `60000` | Pre-authentication token refill period in milliseconds (1–86400000). |
| `MCP_PRE_AUTH_RATE_MAX_ENTRIES` | ❌ | `4096` | Maximum retained digested source buckets (1–100000). |
| `MCP_IDENTITY_RATE_CAPACITY` | ❌ | `120` | Authenticated requests available per owner/client refill period (1–1000000). |
| `MCP_IDENTITY_RATE_REFILL_MS` | ❌ | `60000` | Authenticated identity token refill period in milliseconds (1–86400000). |
| `MCP_IDENTITY_RATE_MAX_ENTRIES` | ❌ | `128` | Maximum retained digested owner/client buckets (1–100000). |

CORS permits `POST` and the `Accept`, `Authorization`, `Content-Type`, and
`Mcp-Protocol-Version` request headers for configured origins. Successful
preflights return HTTP 204. CORS responses expose `X-Request-Id`, and every
HTTP or parser-boundary rejection also returns a fresh opaque request ID when
the socket can still receive a response.

Admission uses a combined conservative estimate derived from hostile JSON
measurements: a 900,001-byte array containing 300,000 empty objects expanded
by 22.4× on the heap and 54× in RSS, so request JSON plus ServiceNow JSON/text
uses a 64× safety factor. Each ExecutionContext may consume at most 1 MiB of
ServiceNow JSON/text cumulatively across parallel calls; declared lengths are
reserved atomically before reading and streamed bytes are charged before
parse. Raw attachment downloads retain their separate cumulative 10 MiB cap
and use an 8× allowance for the source Buffer, base64/UTF-16 representation,
and JSON serialization.

Startup enforces `concurrency × (((request MiB + 1 MiB) × 64) +
(10 MiB × 8)) <= 512 MiB`. With the default 1 MiB request body and concurrency
2, this is 208 MiB per request and 416 MiB combined; concurrency 3 is rejected.
OAuth token and error bodies remain capped at 64 KiB, within the remaining
default headroom. The 512 MiB value is a conservative admission estimate, not
a process-wide heap or RSS limit; operators should still choose a lower
concurrency where the container budget or other application state requires it.

The MCP endpoint defaults to two bounded token buckets: 240 requests per
60-second period per pre-authentication socket source (up to 4096 retained
sources) and 120 requests per 60-second period per authenticated owner/client
identity (up to 128 retained identities). Operators can reduce or increase each
capacity, refill period, and retained-key cap only within the startup-validated
bounds above. Forwarded IP headers are not trusted. Excess requests receive
HTTP 429, `Retry-After`, `Cache-Control: no-store`, and
`{"error":"rate_limited"}`. The source bucket covers `/mcp` and unknown
routes before authentication. Lifecycle probes are deliberately exempt so MCP
traffic cannot starve orchestrator liveness/readiness checks.

Each HTTP request and completed tool call emits one JSON-line event to stderr
with correlation, latency, outcome, rejection reason, and status. Tool audits
classify request cancellation and request-deadline expiration separately from
handler failures. Configured
owner/client identifiers are represented only by SHA-256 pseudonyms; headers,
URLs/query strings, bodies, credentials, tokens, config objects, and exception
text are not event fields. Telemetry never blocks request completion: stderr
backpressure retains at most 256 pending lines, drops excess events, and emits
a `{"type":"telemetry_dropped","count":N}` summary after the stream drains.

### Attachment payloads

`sn_attach` never reads from or writes to host filesystem paths. Uploads use a
safe leaf `file_name` plus `content_base64`; downloads return
`content_base64`, `file_name`, `content_type`, and `size_bytes`. Upload and
download content is capped at 10 MiB decoded; base64 uploads must also fit in
the 1 MiB `/mcp` JSON request envelope, so that transport limit is lower in
practice. Download also requires the owning `table` and record `sys_id`, which
are policy-authorized and verified against attachment metadata before any bytes
are returned.

### Table access policy

V2 denies every ServiceNow table by default. Operators configure comma-separated
allowlists; entries may be exact table names or the literal `*` to allow every
non-hard-denied table for that operation. Table names are trimmed, lowercased,
deduplicated, and must be valid ServiceNow identifiers.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SN_ALLOWED_READ_TABLES` | ❌ | deny all | Tables permitted for read operations. Use `*` to allow all non-hard-denied readable tables. |
| `SN_ALLOWED_WRITE_TABLES` | ❌ | deny all | Tables permitted for create, update, incident journal append, delete, upload, and confirmed batch operations. Use `*` to allow all non-hard-denied writable tables. Write permission never implies read permission. |
| `SN_TABLE_ACCESS_TARGETS` | Required for exact allowlisted caller-addressable tables; optional with `*` | `[]` | Trusted JSON classification with `table`, exact permitted `tools`, `kind` (`canonical`, `alias`, `view`, or `extension`), literal `closureComplete: true`, and the complete backing/ancestor/descendant `relatedTables` closure. With `*`, omitted target entries use the wildcard operation grant; explicit target entries can still narrow tools and validate related-table closure. |
| `SN_FIELD_POLICY_DEFINITIONS` | Required for custom/generic table fields | built-in finite policy | Trusted JSON object keyed by table name or `*`. Each entry may define `defaults`, `readable`, and `writable`; `readable`/`writable` accept exact field arrays or `"*"`. Sensitive field names are still denied. Use `{"*":{"defaults":["sys_id"],"readable":"*","writable":[]}}` for broad read-only custom-table exploration. Use `writable:"*"` only for intentional broad mutation access. |
| `SN_ENCODED_QUERY_READ_POLICY` | ❌ | deny all | Trusted JSON object containing bounded `rules` for an exact `sn_query`/table pair. Each rule requires `maxLength`, `maxTerms`, readable `fields`, supported `operators`, `maxLimit`, `maxOffset`, and `maxResponseBytes`. No rule can authorize a write or another tool. |

Credential, authentication, encryption, and security-policy tables remain
hard-denied even when `*` is configured. Invalid or prohibited policy configuration fails
startup. A composed tool is admitted only when its complete backing-table plan
is allowed before the first ServiceNow client access. Every related target must
have the same read or write permission, so a base table, alias, view, or
extension cannot bypass an unlisted or hard-denied backing or descendant table.
Related permission does not make a dependency directly caller-addressable
without its own target entry. Table access is necessary but not sufficient:
field access is also deny-by-default unless the table is covered by the built-in
field policy or `SN_FIELD_POLICY_DEFINITIONS` exact/`*` fallback. Build the
complete target catalog from approved ServiceNow metadata and treat it as
trusted startup configuration; omit a target when reachability cannot be proven
complete.
`sn_nl` and ATF `run`/`run-suite` currently fail closed because they do not emit
a complete typed side-effect plan; use the corresponding typed tool instead.
Incident journal fields are append-only: generic `sn_update` rejects `comments`
and `work_notes` before credentials or client creation. Use
`sn_incident_add_comment` or `sn_incident_add_work_note` with exactly
`profile`, incident `sys_id`, and bounded `content`; grant the selected tool
explicitly on the `incident` target as well as write access to that table.

### ServiceNow profiles

> **Note:** A profile file is authoritative when present. Without one,
> `SN_PROFILE_NAME` must explicitly map the canonical connection variables to
> a named profile; there is no synthetic or default profile.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SN_PROFILE_NAME` | ✅* | — | Explicit name for the process-local environment profile; required before bare connection variables define any profile. |
| `SN_INSTANCE` | ✅* | — | Instance URL (e.g. `https://yourinstance.service-now.com`) |
| `SN_USER` | ✅* | — | ServiceNow username (basic auth / OAuth password grant) |
| `SN_PASSWORD` | ✅* | — | ServiceNow password (basic auth / OAuth password grant) |
| `SN_AUTH_TYPE` | ❌ | `basic` | Auth scheme: `basic`, `oauth`, or `apikey` |
| `SN_CLIENT_ID` | ❌ | — | OAuth client id (`SN_AUTH_TYPE=oauth`) |
| `SN_CLIENT_SECRET` | ❌ | — | OAuth client secret (`SN_AUTH_TYPE=oauth`) |
| `SN_GRANT_TYPE` | ❌ | `client_credentials` | OAuth grant: `client_credentials` or `password` |
| `SN_API_KEY` | ❌ | — | API key (`SN_AUTH_TYPE=apikey`) |
| `SN_API_KEY_HEADER` | ❌ | `x-sn-apikey` | Header the API key is sent in |
| `SN_TIMEOUT_MS` | ❌ | `30000` | Per-request timeout in milliseconds |
| `SN_DISPLAY_VALUE` | ❌ | `true` | Default display value mode (`true`, `false`, `all`) |
| `SN_REL_DEPTH` | ❌ | `3` | Default CMDB relationship traversal depth |

*`SN_PROFILE_NAME` and `SN_INSTANCE` are not required when using
`~/.servicenow-mcp/config.json`. Authentication-specific variables depend on
the selected auth type.

---

## Usage Examples

Once connected, your AI assistant can:

**Query incidents:**
> "On dev, show me all P1 incidents assigned to the Network team" (`profile: "dev"`)

**Create a record:**
> "On staging, create an incident for the approved VPN test" (`profile: "staging"`)

**Aggregate data:**
> "On prod, how many incidents are grouped by priority?" (`profile: "prod"`)

**Check health:**
> "Run the dev instance health check" (`profile: "dev"`)

**CMDB traversal:**
> "On prod, show upstream dependencies for email-server-01" (`profile: "prod"`)

**Schema introspection:**
> "On dev, what fields are on change_request?" (`profile: "dev"`)

**Code search:**
> "On dev, find business rules that reference GlideRecord('incident')" (`profile: "dev"`)

**ATF testing:**
> "On staging, list the approved ATF suite" (`profile: "staging"`)

**Explicit profile selection:**
> "Query incidents on dev" (the client sends `profile: "dev"` on that call)

The client must translate every example into a tool invocation containing that
exact `profile`; no prior call creates default, active, or switch-profile state.

---

## Safety Features

This server is designed for production use with multiple safety layers:

- **Delete operations** require explicit `confirm: true`
- **Batch operations** run in dry-run mode by default — shows match count without making changes
- **Bulk operations** require `confirm: true` to leave dry-run mode
- **Unclassified composition is denied** — `sn_nl` and ATF execution do not run until they can emit complete typed access plans
- **Table access is deny-by-default** with independent exact read/write allowlists and non-configurable sensitive-table denials
- **User input is neutralized** before interpolation into encoded queries (`^` is stripped from filter values — ServiceNow's query syntax has no escape sequence)

---

## Development

Have the approved local supervisor or keychain inject `MCP_BEARER_TOKEN` and
the selected ServiceNow authentication secret before starting the process.
The commands below contain non-secret configuration only; never prepend or
append protected values on the command line.

```bash
# Clone
git clone https://github.com/onlyflowstech/servicenow-mcp.git
cd servicenow-mcp

# Install & build
npm install
npm run build

# Run the production HTTP service
MCP_OWNER_ID=local-owner \
MCP_CLIENT_ID=local-client \
SN_ALLOWED_READ_TABLES=incident,problem,change_request \
SN_ALLOWED_WRITE_TABLES=incident,change_request \
SN_TABLE_ACCESS_TARGETS='[{"table":"incident","kind":"canonical","tools":["sn_query","sn_get","sn_create","sn_update","sn_incident_add_comment","sn_incident_add_work_note","sn_delete","sn_batch"],"closureComplete":true,"relatedTables":["incident"]},{"table":"problem","kind":"canonical","tools":["sn_query","sn_get"],"closureComplete":true,"relatedTables":["problem"]},{"table":"change_request","kind":"canonical","tools":["sn_query","sn_get"],"closureComplete":true,"relatedTables":["change_request"]}]' \
SN_PROFILE_NAME=dev \
SN_INSTANCE=https://yourinstance.service-now.com \
SN_USER=your_user \
npm start

# Build and run with source maps for local development
MCP_OWNER_ID=local-owner \
MCP_CLIENT_ID=local-client \
SN_ALLOWED_READ_TABLES=incident,problem,change_request \
SN_ALLOWED_WRITE_TABLES=incident,change_request \
SN_TABLE_ACCESS_TARGETS='[{"table":"incident","kind":"canonical","tools":["sn_query","sn_get","sn_create","sn_update","sn_incident_add_comment","sn_incident_add_work_note","sn_delete","sn_batch"],"closureComplete":true,"relatedTables":["incident"]},{"table":"problem","kind":"canonical","tools":["sn_query","sn_get"],"closureComplete":true,"relatedTables":["problem"]},{"table":"change_request","kind":"canonical","tools":["sn_query","sn_get"],"closureComplete":true,"relatedTables":["change_request"]}]' \
SN_PROFILE_NAME=dev \
SN_INSTANCE=https://yourinstance.service-now.com \
SN_USER=your_user \
npm run dev
```

### Testing with MCP Inspector

Use the isolated, exactly locked Inspector toolchain on Node.js 22.19 or newer;
the server itself remains supported on Node.js 20. Set the non-secret `MCP_URL`
and `MCP_PROFILE`, install from `tools/inspector/package-lock.json`, and run the
local-only launcher:

```bash
npm ci --prefix tools/inspector --engine-strict --ignore-scripts
npm run inspector
```

Select Streamable HTTP in the local UI, use the exact protected `/mcp` URL,
enter the bearer from the approved secret store in the UI, and include the
explicit profile in every call. The launcher does not pass the bearer in argv,
expose Inspector beyond loopback, or create a tunnel. Run `npm run smoke` as the
second client against the same `MCP_URL` and `MCP_PROFILE`. See
[`docs/RELEASE-VALIDATION.md`](docs/RELEASE-VALIDATION.md) for the release gates,
write confirmation, evidence, and rollback procedure.

---

## Roadmap

- [x] **Streamable HTTP transport** at `/mcp`
- [x] **OAuth 2.0** authentication support (client_credentials + password grants, API keys)
- [ ] **sn_script** background-script execution (SNS-39) — requires automating the `sys.scripts.do` UI endpoint with session auth; the tool currently returns an explanatory error without executing anything
- [ ] **Streaming** for large result sets
- [ ] **Caching** for schema and relationship lookups

---

## License

MIT © [OnlyFlows](https://onlyflows.tech)

---

<p align="center">
  Built with ❤️ by <a href="https://onlyflows.tech">OnlyFlows</a> · <a href="https://github.com/onlyflowstech">@onlyflowstech</a>
</p>
