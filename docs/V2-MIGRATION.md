# V2 HTTP migration

V2 is an authenticated, single-owner HTTP service. It intentionally removes
the V1 local-process launch contract.

## Required client change

Remove any MCP client entry that starts `servicenow-mcp` with a local
`command`, executable path, or `args`. Local Claude stdio configuration is no
longer supported. V2 has no stdio compatibility flag, alternate executable, or
fallback transport.

Configure a standards-compliant MCP Streamable HTTP client with:

- URL: `http://127.0.0.1:3000/mcp` by default
- Header: `Authorization: Bearer <MCP_BEARER_TOKEN>`

Client configuration syntax varies, but the protocol contract does not depend
on any AI provider. Use TLS or an approved private-access boundary before
binding outside loopback.

For complete official SDK and independent Fetch examples using the same
endpoint, explicit profile selection on every invocation, two isolated named
profiles, and safe result/audit verification, see
[V2 service and client setup](CLIENT-SETUP.md).

## Start the service

The HTTP runtime fails closed unless the bearer secret and audit identity are
explicitly configured.

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
orchestrator, keychain, or secret manager inject `MCP_BEARER_TOKEN` and the
authentication-specific ServiceNow secret directly into the service process.
Do not put either value in shell input, command arguments, dotenv files, or
history.

Production uses `npm start`. Local development uses `npm run dev`, which builds
and starts the same HTTP-only entrypoint with source maps enabled.

Optional runtime settings:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_HOST` | `127.0.0.1` | Bind host |
| `MCP_PORT` | `3000` | Listen port |
| `MCP_ALLOWED_HOSTS` | bind/socket authorities | Comma-separated exact public `Host` authorities; include ports when clients send them. The container's reserved loopback-only health authority is internal and must not be added. |
| `MCP_ALLOWED_ORIGINS` | deny browser origins | Comma-separated exact HTTP(S) origins; requests without `Origin` remain allowed |
| `MCP_MAX_CONCURRENT_REQUESTS` | `2` | Concurrent admitted `/mcp` requests (1–1024 syntactically); excess work receives HTTP 503 and is never queued, and startup rejects values above the combined 512 MiB estimate (maximum 2 with default limits) |
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
forwarded-address headers. A rejected request is
HTTP 429 with a bounded `Retry-After` header and
`{"error":"rate_limited"}` body. The limits are process-local and reset on
restart. Health probes are exempt from the MCP source bucket so exhausted
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
separate cumulative 10 MiB limit with an 8× allowance for Buffer, base64/UTF-16,
and JSON serialization.

The constructor enforces `concurrency × (((request MiB + 1 MiB) × 64) +
(10 MiB × 8)) <= 512 MiB`. Defaults therefore estimate 208 MiB per request and
416 MiB for concurrency 2; concurrency 3 fails startup. OAuth token and error
bodies are capped at 64 KiB within the remaining default headroom. This is a
conservative admission estimate rather than a hard process heap/RSS limit, so
reduce `MCP_MAX_CONCURRENT_REQUESTS` when the deployment memory budget requires
more headroom for other application state.

Request and tool completion events are written as JSON Lines on stderr. They
contain bounded correlation, latency, outcome/reason, and status fields. Raw
owner/client identifiers are hashed, and request headers, URL/query strings,
bodies, credentials, tokens, config, and exception text are structurally
excluded. Stderr delivery is nonblocking and retains at most 256 pending lines
during backpressure. Excess events are dropped and later summarized as
`{"type":"telemetry_dropped","count":N}` after stderr drains, so collectors
must monitor these records as evidence of telemetry loss.

## Profile-call change

Every one of the 20 `sn_*` tools now requires a non-empty `profile` argument.
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
Both directions enforce a 10 MiB decoded-content cap. Base64 uploads must also
fit in the 1 MiB `/mcp` JSON request envelope, which is the lower practical
transport limit. List, upload, and download require the owning `table` and
record `sys_id`; downloads verify those values against ServiceNow attachment
metadata before returning bytes.

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

V2 denies table access unless the service operator configures the table name or
the literal `*` in `SN_ALLOWED_READ_TABLES` or `SN_ALLOWED_WRITE_TABLES`. Both
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

The service normalizes identifiers, rejects malformed or wildcard entries, and
refuses to start when a built-in credential, authentication, encryption, or
security-policy table is configured. Multi-table tools must have their complete
operation plan authorized before the first ServiceNow client access. `sn_nl`
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
