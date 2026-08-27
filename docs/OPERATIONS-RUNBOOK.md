# Remote operations runbook

This runbook is the operator contract for the private, single-owner ServiceNow
MCP V2 service. It covers normal operation, degradation, deployment, rollback,
credential rotation, rate-limit tuning, incident response, and safe support
collection. It does not authorize a public tunnel, public endpoint, production
deployment, or a change to the network boundary. Use it with
[Production container deployment](CONTAINER-DEPLOYMENT.md),
[Production security boundaries](PRODUCTION-SECURITY.md), and
[Profile credentials](PROFILE-CREDENTIALS.md).

## Operating model and ownership

The Node process owns `/mcp`, `/health/live`, `/health/ready`, bounded request
admission, graceful drain, and JSON Lines telemetry on stderr. The deployment
platform owns TLS, private ingress, original-client controls, restart policy,
resource limits, secret injection, log collection, metrics derivation, alerts,
and dashboards. ServiceNow remains an upstream dependency with its own
availability, latency, ACL, credential, and rate-limit behavior.

There is no application `/metrics` endpoint. Derive the metrics below from the
documented JSONL events, lifecycle probes, container/orchestrator state, and an
explicit low-frequency ServiceNow synthetic check. Do not add a public scrape
endpoint to satisfy this runbook.

## Health and dependency semantics

| Signal | Healthy response | Meaning | It deliberately does not prove |
| --- | --- | --- | --- |
| `GET` or `HEAD /health/live` | HTTP 200; GET body `{"status":"live"}` | The process can serve local HTTP. Use for restart decisions. | Startup completion, MCP authentication, profile validity, or ServiceNow reachability. |
| `GET` or `HEAD /health/ready` | HTTP 200; GET body `{"status":"ready"}` | Startup completed, the listener is admitting MCP work, and shutdown drain has not begun. Use for load-balancer admission. | ServiceNow reachability, ServiceNow credentials/ACLs, or successful tool execution. |
| `/health/ready` unavailable | HTTP 503; GET body `{"status":"not_ready"}` | The runtime is starting, closing, draining, or its local readiness gate failed closed. | That ServiceNow itself is unavailable. |
| Opt-in ServiceNow synthetic | Successful bounded, read-only tool call | The selected profile can authenticate, reach its instance, and perform that specific permitted read. | Every table, ACL, tool, node, or ServiceNow subsystem is healthy. |

Health requests are unauthenticated lifecycle signals, are exempt from MCP
rate limiting, and never construct an MCP server or contact ServiceNow. Restrict
them to the orchestrator or trusted proxy network. The container's internal
probe uses `GET /health/ready` over loopback with the reserved
`Host: mcp-health.internal`; that authority is valid only for the two health
paths from a loopback peer and must not be added to `MCP_ALLOWED_HOSTS`.

Do not make ServiceNow availability part of liveness or readiness. Doing so
would restart or remove every healthy MCP replica during a shared upstream
incident. Instead, keep the service ready, report safe typed tool failures, and
use the dependency telemetry and synthetic check below.

For an upstream synthetic, use a dedicated monitoring identity and a profile
with the minimum read access needed. Prefer a five-minute-or-slower
`sn_health` call with `check: "version"`, or one equivalently bounded read from
an approved non-sensitive table when the integration account cannot read
ServiceNow properties. Never use a create, update, delete, batch execution, ATF
run, script, attachment upload, or unrestricted query as a health check. Do not
persist its result payload; retain only success/failure category and latency.

## Telemetry contract

Every completed HTTP request and tool call emits one bounded JSON object per
line on stderr. Treat stdout/stderr as a structured stream: configure the
collector to parse JSON when possible and retain the bounded non-JSON startup,
basic-auth warning, and shutdown lines separately.

Both event types contain `schemaVersion`, `type`, `observedAtMs`, `latencyMs`,
`correlationId`, `ownerIdHash`, and `clientIdHash`. An `http_request` event adds
only `outcome`, `reason`, and `statusCode`. An `mcp_tool` event instead adds
`tool`, `profile`, `instance`, `outcome`, `reason`, `errorCategory`, `retry`,
and `retryAfterSeconds`; it has no HTTP status or request path. Owner and client
values are SHA-256 pseudonyms. Profile names and canonical instance origins are
operational metadata, not credentials, but still require restricted log access.

The application structurally excludes authorization headers, cookies, URL and
query strings, request and response bodies, configuration objects, credentials,
tokens, ciphertext, secret references, and exception text. Proxy, platform,
collector, and APM configuration must independently exclude the same data.

Telemetry delivery never blocks request completion. During stderr
backpressure, at most 256 lines are pending; excess events are summarized after
drain as `{"type":"telemetry_dropped","count":N}`. Any positive count is an
observability incident because metric denominators and forensic sequences are
then incomplete.

### Derived metrics

Use deployment/environment as low-cardinality collector-added labels. Do not
use `correlationId`, `ownerIdHash`, `clientIdHash`, `profile`, or `instance` as
metric labels. Keep those fields only in access-controlled logs for scoped
diagnosis.

| Metric | Source and aggregation |
| --- | --- |
| `servicenow_mcp_probe_live` | Gauge from `/health/live`: 1 only for the exact healthy response, otherwise 0. |
| `servicenow_mcp_probe_ready` | Gauge from `/health/ready`: 1 only for the exact healthy response, otherwise 0. |
| `servicenow_mcp_http_requests_total` | Count `http_request`, labeled by `outcome`, bounded `reason`, and status class. |
| `servicenow_mcp_http_duration_ms` | Histogram of `http_request.latencyMs`; calculate p50, p95, and p99. |
| `servicenow_mcp_tool_calls_total` | Count `mcp_tool`, labeled by `tool`, `outcome`, bounded `reason`, `errorCategory`, and `retry`. |
| `servicenow_mcp_tool_duration_ms` | Histogram of `mcp_tool.latencyMs`, split by `tool`; calculate p50, p95, and p99. |
| `servicenow_mcp_telemetry_dropped_total` | Sum `telemetry_dropped.count`. |
| `servicenow_mcp_dependency_check_success` | Gauge from the separate bounded read-only ServiceNow synthetic; never feed this into readiness. |
| `servicenow_mcp_dependency_check_duration_ms` | Histogram from the same synthetic, without retaining its response payload. |
| `servicenow_mcp_restarts_total` | Container/orchestrator restart count, not an application log approximation. |

### Initial alerts

These are conservative starting points, not universal SLOs. Establish a
fourteen-day baseline, preserve the safety bounds, and tune thresholds by tool
and deployment. Every ratio alert needs both a percentage and a minimum count
to avoid paging on one request.

| Signal | Initial condition | Action |
| --- | --- | --- |
| Liveness | Two consecutive failed probes | Page; inspect process exit/restart and platform events. |
| Readiness | Not ready for 2 minutes outside an announced rollout; page at 5 minutes | Stop rollout and diagnose startup/drain/configuration. Do not infer a ServiceNow outage. |
| Availability | HTTP 5xx at least 5% for 5 minutes with at least 20 requests | Page and split `service_unavailable`, `concurrency_limited`, and `internal_error`. |
| Latency | HTTP p95 above 5 seconds or tool p95 above its baseline by 2x for 10 minutes with at least 20 samples | Warn; correlate by tool and upstream category before changing capacity. |
| Authentication rejection | Five or more HTTP 401/403 responses in 5 minutes | Notify security/operations; verify client token coordination without logging the token. |
| Rate rejection | HTTP 429 at least 1% and at least 10 responses in 5 minutes | Warn; separate pre-authentication from authenticated-identity reasons and follow the tuning procedure. |
| Saturation | Five or more `concurrency_limited` HTTP 503 events in 5 minutes | Warn; inspect latency and memory before increasing concurrency. |
| Upstream failure | `mcp_tool.errorCategory` in `upstream`, `timeout`, or `rate_limit` at least 5% and at least 5 calls in 5 minutes | Page the dependency path; honor `retry` and `retryAfterSeconds`. |
| Credential/ACL failure | Three `authentication` or `authorization` tool errors for one scoped deployment in 5 minutes | Page the credential/ACL owner; do not retry blindly. |
| Internal tool failure | Three `internal` tool errors in 5 minutes | Page the service owner; correlate by tool and release without requesting exception text or payloads. |
| Dependency synthetic | Two consecutive failures; page if failure persists 5 minutes | Diagnose ServiceNow/DNS/egress/credentials while leaving lifecycle readiness independent. |
| Telemetry loss | Any increase in `servicenow_mcp_telemetry_dropped_total` | Page the logging pipeline and mark the incident window incomplete. |
| Certificate expiry | TLS-edge certificate has fewer than 30 days remaining; page at 7 days | Renew at the operator-managed TLS boundary. |

### Dashboard layout

Maintain one dashboard per deployment with release annotations and these rows:

1. **Lifecycle:** live/ready gauges, replicas ready/desired, restarts, rollout
   revision, and shutdown duration.
2. **Traffic and latency:** request rate, success/4xx/5xx, HTTP p50/p95/p99,
   tool call rate, and per-tool p95.
3. **ServiceNow dependency:** synthetic success/latency plus tool
   `errorCategory` counts for authentication, authorization, rate limit,
   timeout, and upstream.
4. **Rejection and security:** 401, 403, 429, concurrency 503, malformed input,
   body-limit, timeout, and host/origin rejection trends.
5. **Telemetry quality and capacity:** dropped telemetry, log-ingest lag,
   container memory/CPU, open connections, and configured replica count.

Do not place raw bodies, URLs, credentials, profile references, correlation IDs,
owner/client hashes, profile names, or instance origins in dashboard labels or
annotations.

### Retention and access

- Keep detailed application JSONL searchable for 14 days and delete it after
  30 days unless an approved incident, legal, or compliance policy requires a
  different period. Restrict it to the service operations/security roles.
- Keep aggregate, low-cardinality metrics and alert history for 90 days for
  capacity and regression analysis. Aggregates must not contain profile,
  instance, owner/client hash, or correlation labels.
- Keep deployment revision, image digest, validation, scan, and rollback
  evidence for the release-retention period defined by the organization.
- Encrypt data in transit and at rest, audit access, and apply deletion to
  replicas, archives, and support exports. Delete a support export when its
  case closes, or within 7 days after closure if the support process requires a
  short confirmation window.

## Deployment procedure

Only an authorized release process deploys externally. The commands below
build and validate locally; they do not publish an image, create a tunnel, or
create a public endpoint.

1. Freeze the exact source revision and lock file. Run `npm ci`,
   `npm run typecheck`, `npm run lint`, `npm test -- --run --no-file-parallelism`,
   and `npm run build`.
2. Build the pinned artifact with an immutable revision and run
   `npm run container:validate`, `npm run container:scan`, and
   `npm audit --omit=dev`. Archive only the sanitized result, image digest,
   scanner/version/database timestamp, and source revision.
3. Review the rendered deployment without secret values. Confirm numeric
   non-root identity, read-only root, dropped capabilities, bounded `/tmp`,
   private ingress, exact Host/Origin allowlists, default-deny egress, resource
   limits, termination grace greater than `MCP_SHUTDOWN_GRACE_MS`, and runtime
   secret references.
4. Deploy the immutable image digest to a private staging environment. Do not
   substitute a mutable tag. Verify live then ready, initialize with two
   independent MCP clients, and verify discovery exactly matches the release
   tool manifest/contract (names, schemas, and annotations). Exercise one
   approved read-only synthetic, send SIGTERM, and confirm readiness drops
   before the bounded clean exit. Verify the injected canary secret never
   appears in collected logs.
5. Start a one-replica or small-percentage production canary. Confirm the same
   signals, compare request/tool latency and rejection/upstream rates to the
   prior revision, then increase traffic in bounded stages. Stop automatically
   on a readiness, error-rate, telemetry-loss, or secret-redaction gate.
6. Record source revision, immutable image digest, configuration revision
   without values, validation evidence, deployment time, operator, and the
   tested rollback digest.

The local staging-equivalent gate is:

```sh
npm run container:build
npm run container:validate
```

It uses loopback only and disposable validation credentials. It verifies the
non-root/read-only container, health semantics, two independent MCP clients,
clean SIGTERM, secret-free logs, labels, and image-size ceiling. It performs no
ServiceNow write and does not create an external deployment. It complements,
but does not replace, an authorized private staging deployment.

## Rollback procedure

Rollback is a release change, not an attempt to mask a ServiceNow incident.

1. Stop rollout and remove the failing revision from admission by using its
   truthful readiness state or the platform rollout control. Preserve the
   bounded incident window; do not dump environment or request payloads.
2. Classify the failure. If live/ready and MCP protocol are healthy while only
   ServiceNow calls fail, follow upstream incident response instead of rolling
   replicas indefinitely.
3. Redeploy the last known-good immutable image digest with its compatible,
   previously reviewed non-secret configuration revision. Never restore a
   revoked credential, expired certificate, vulnerable artifact, or plaintext
   secret as part of rollback.
4. Verify live, ready, two-client initialize/list, the approved read-only
   synthetic, error/latency rates, and telemetry delivery. Confirm the failed
   digest no longer receives traffic.
5. Record the rollback reason, digests, configuration revisions, health
   evidence, and incident link. Keep the failed release quarantined for
   analysis; do not silently retag it as the prior version.

## Credential and key rotation

### ServiceNow credential or secret reference

1. Create the replacement in the authoritative secret system without revoking
   the old value. Preserve the same least-privilege ServiceNow roles.
2. Atomically update the secret reference or use
   `servicenow-mcp-profile rotate` with protected stdin. Never pass a protected
   value or reference on the command line.
3. Roll a staging/canary replica because environment and mounted profile files
   are not promised to reload live. Verify live/ready, then run the scoped
   read-only ServiceNow synthetic through the explicitly named profile.
4. Verify the canary marker is absent from application, proxy, platform, and
   collector logs. Complete the rollout, then revoke the old credential.
5. If verification fails, restore the prior reference while it remains valid;
   do not expose either value in the incident record.

### Profile encryption key

Re-encrypt each affected envelope through the out-of-band administration
workflow, inject the new `SN_PROFILE_ENCRYPTION_KEY` separately, and roll the
serving processes. Treat the profile file and matching key as one versioned
pair for rollback. Verify before retiring the prior key; never store both keys
in the profile file or support bundle.

### MCP bearer token

The process accepts one configured bearer token. It has no dual-token overlap
mode. Coordinate a maintenance window or a parallel **private** endpoint:
deploy the new token, update the authorized client/connector, verify MCP
initialize/list, then remove the old private endpoint and revoke the old token.
Do not create a public tunnel, log either token, or leave both endpoints active
indefinitely.

## Rate-limit and capacity tuning

The pre-authentication bucket defaults to 240 requests per 60 seconds per
direct socket source with 4096 retained sources. The authenticated bucket
defaults to 120 requests per 60 seconds per owner/client identity with 128
retained identities. Buckets are process-local and reset on restart, so an
N-replica deployment has approximately N times the aggregate capacity; this is
not a global quota.

| Setting | Valid range | Operational effect |
| --- | --- | --- |
| `MCP_PRE_AUTH_RATE_CAPACITY` | 1–1000000 | Direct-source burst/refill capacity; default 240. |
| `MCP_PRE_AUTH_RATE_REFILL_MS` | 1–86400000 ms | Direct-source refill period; default 60000 ms. |
| `MCP_PRE_AUTH_RATE_MAX_ENTRIES` | 1–100000 | Retained digested direct-source buckets; default 4096. |
| `MCP_IDENTITY_RATE_CAPACITY` | 1–1000000 | Owner/client burst/refill capacity; default 120. |
| `MCP_IDENTITY_RATE_REFILL_MS` | 1–86400000 ms | Owner/client refill period; default 60000 ms. |
| `MCP_IDENTITY_RATE_MAX_ENTRIES` | 1–100000 | Retained digested identity buckets; default 128. |
| `MCP_MAX_CONCURRENT_REQUESTS` | 1–1024 syntactically; lower memory-safety limit enforced at startup | Concurrent admitted MCP requests; excess is rejected, never queued. |
| `MCP_MAX_CONNECTIONS` | 1–4096 | Accepted TCP connections before excess sockets are dropped. |

Behind a reverse proxy, the application sees the proxy as the direct source.
Enforce original-client limits at the trusted edge and never enable forwarded
IP trust in the application. Tune in this order:

1. Establish request, 429, concurrency-503, latency, memory, and ServiceNow
   rate-limit baselines by replica and authenticated identity.
2. Confirm retries honor HTTP `Retry-After` and typed tool `retry` guidance.
   Remove retry storms before raising limits.
3. Change one capacity or refill period at a time, normally by no more than
   25%, through reviewed configuration and a rolling restart. Observe at least
   one peak period.
4. Raise concurrency only after proving memory headroom and upstream capacity;
   startup rejects unsafe combined estimates, but that is not a substitute for
   a container memory limit.
5. Roll back when latency, 5xx, upstream rate limits, memory, or telemetry loss
   worsens. Never disable a bucket or set an extreme retained-key bound to make
   an alert disappear.

## Incident response

| Observation | Likely scope | First actions |
| --- | --- | --- |
| Live fails | Process/container/platform | Check restart/exit reason, resource pressure, image revision, and platform events; rollback a release regression. |
| Live succeeds, ready fails | Startup, drain, or local configuration | Check rollout state and bounded startup/shutdown messages. Stop routing; do not blame ServiceNow without dependency evidence. |
| Live and ready succeed, synthetic and tool calls fail | ServiceNow, DNS/egress, credential, ACL, or upstream rate limit | Split by `errorCategory`, profile-scoped internal evidence, and retry guidance. Do not restart healthy replicas in a loop. |
| HTTP 401/403 | MCP caller authentication/authorization boundary | Check token rollout coordination and authorized connector configuration without collecting headers. |
| Tool `authentication`/`authorization` | ServiceNow credential or ACL boundary | Stop blind retries; verify secret reference version, account state, and least-privilege role changes. |
| HTTP 429 | Application or edge rate limit | Honor `Retry-After`, identify pre-auth versus identity reason, stop retry storms, then tune from evidence. |
| HTTP 503 with `concurrency_limited` | Local saturation | Reduce arrival rate, inspect per-tool latency and memory, and scale safely before changing concurrency. |
| Tool `rate_limit`, `timeout`, or `upstream` | ServiceNow/dependency path | Honor typed retry guidance, check ServiceNow status and egress/DNS, and use the bounded synthetic. |
| `telemetry_dropped` increases | Collector/stderr backpressure | Restore ingest, mark metrics incomplete, and avoid confident rate calculations for the affected window. |

For every incident: assign an incident commander, record UTC start/end and
release/configuration revisions, preserve only the safe evidence below, choose
rollback versus upstream mitigation explicitly, and verify recovery across
live, ready, MCP protocol, dependency synthetic, latency, errors, and telemetry.

## Least-privilege support collection

Create a case-specific, access-controlled export for the smallest UTC window
that reproduces the problem. The default support allowlist is:

- package version, immutable image digest, architecture, replica count, and
  non-secret configuration **names and revision identifiers only**;
- live/ready status codes and exact generic bodies;
- aggregate counts and percentiles from the metrics table;
- deployment, restart, and sanitized scanner/validation timestamps;
- when essential, only these fields from selected structured events:
  `schemaVersion`, `type`, `observedAtMs`, `latencyMs`, `correlationId`, `tool`,
  `outcome`, `reason`, `statusCode`, `errorCategory`, `retry`, and
  `retryAfterSeconds`.

Omit `profile`, `instance`, `ownerIdHash`, and `clientIdHash` from external
support exports by default. An internal incident responder may retain one of
those operational identifiers only when it is necessary to distinguish the
affected scope and access is already authorized.

Never collect or request bearer tokens, Authorization/cookie/API-key headers,
passwords, OAuth secrets, API keys, encryption keys, secret references,
ciphertext, environment dumps, profile/configuration files, `docker container
inspect`, command history, request/response bodies, attachments, raw URLs or
query strings, ServiceNow record payloads, or unrestricted proxy/APM traces.
Do not ask an operator to reproduce a secret in a ticket. If a suspected leak
requires confirmation, compare a one-way case-local fingerprint inside the
authorized environment and export only the yes/no result.

Before sending the export, have a second authorized person inspect it for the
forbidden classes above. Encrypt it in transit and at rest, grant it only to
named case responders, record access, and delete it according to the retention
rule. A support request to weaken redaction, widen ServiceNow roles, expose a
health endpoint, or create a public tunnel must be refused and escalated.

## Recovery verification checklist

- [ ] `/health/live` and `/health/ready` return their exact healthy responses.
- [ ] Two independent MCP clients can initialize; discovery exactly matches the release tool manifest/contract (names, schemas, and annotations).
- [ ] The approved read-only ServiceNow synthetic succeeds for the intended profile.
- [ ] HTTP/tool latency and error/rejection rates returned to baseline.
- [ ] No telemetry-drop count is increasing and log-ingest delay is normal.
- [ ] No canary or production secret appears in any collected log surface.
- [ ] The active immutable image digest and non-secret configuration revision are recorded.
- [ ] Temporary support exports and obsolete credentials/endpoints have an owner and deletion/revocation time.
