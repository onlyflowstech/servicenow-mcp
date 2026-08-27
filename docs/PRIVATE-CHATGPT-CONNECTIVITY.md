# Private ChatGPT connectivity through Secure MCP Tunnel

This guide is the SNSDK-42 operator contract for connecting the private,
single-owner ServiceNow MCP HTTP service to ChatGPT through an optional Secure
MCP Tunnel adapter. The adapter runs outside the application and starts an
outbound-only connection. It does not make `/mcp`, either health endpoint, or
the tunnel-client administration UI publicly reachable.

This repository change supplies a repeatable procedure and automated document
contracts only. It is **not live-validation evidence**: no tunnel, Platform
credential, ChatGPT app, public endpoint, or ServiceNow write is created by the
build or tests. SNSDK-42 remains blocked on an authorized private live run until
the evidence checklist below is completed in the intended Platform
organization, ChatGPT workspace, private staging environment, and disposable
ServiceNow test scope.

The current primary references are:

- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI tunnel-client configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
- [ChatGPT developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)
- [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
- [latest tunnel-client release](https://github.com/openai/tunnel-client/releases/latest)

Review the current versions before every live validation. Product availability,
UI labels, and workspace policy can change; do not treat a prior screenshot as
authority for a new run.

## Boundary and ownership

The components have separate responsibilities:

1. `servicenow-mcp` owns MCP Streamable HTTP, its bearer boundary, explicit
   ServiceNow profiles, table/field policy, structured results, and audit data.
2. `tunnel-client` runs as a separately installed provider adapter in the same
   trust boundary that can already reach the private `/mcp` origin. It polls the
   OpenAI tunnel control plane over outbound HTTPS and forwards MCP traffic to
   that one configured origin.
3. The OpenAI Platform organization owns the tunnel identity, runtime key,
   permissions, and organization/workspace associations.
4. The ChatGPT workspace owns developer-mode access, the draft app, action
   permissions, confirmations, and who may test it.
5. The ServiceNow test owner supplies an explicit least-privilege profile and
   authorizes the exact read and controlled write.

Removing the ChatGPT draft app, stopping and removing `tunnel-client`, and
revoking its runtime key must leave the core server and the provider-neutral
client suite unchanged. No file under `src/`, server startup path, tool handler,
profile schema, Docker image, or required package dependency may import or
start `tunnel-client` or depend on ChatGPT.

## Preconditions and permissions

Do not begin a live run until one named operator verifies all of these items:

- The target is ChatGPT web in a plan/workspace where the required full MCP
  read and write actions are available. A read-only product entitlement cannot
  satisfy the controlled-write acceptance case.
- Creating or editing a tunnel is performed by a principal with Platform
  Tunnels **Read + Manage**. Running `tunnel-client` and selecting the tunnel
  while creating the app require Tunnels **Read + Use**.
- Tunnel roles are granted at the Platform organization level by an
  organization owner or RBAC administrator, not assumed from project access.
- ChatGPT developer mode is granted separately. For Enterprise/Edu, an admin
  grants the appropriate Connected Data/developer-mode permission through
  workspace RBAC and the authorized tester enables developer mode under the
  current **Settings → Apps → Advanced Settings** surface. For Business, only
  an admin/owner may enable developer mode and create the app. Follow the
  current plan-specific Help Center path if UI labels have moved.
- The tunnel is associated with the exact Platform organization and target
  ChatGPT workspace. Association with a personal or Platform organization alone
  does not make it visible in an unrelated Enterprise/Edu workspace.
- A separately authorized private staging deployment is healthy and uses a
  disposable or sub-production ServiceNow instance. Production records and
  personal administrator credentials are prohibited.
- A dedicated ServiceNow integration identity has only the roles required by
  the approved read and controlled-write cases. The table target catalog,
  read/write allowlists, field policies, and explicit profile are reviewed.
- Change owner, tester, evidence reviewer, rollback owner, time window, and
  incident contact are recorded before the run.

If organization/workspace association cannot be verified automatically, stop
and use the reviewed OpenAI account-team process described in the official
guide. Do not work around missing association or permissions with a public
tunnel, a personal workspace, a shared key, or a different organization.

## Network requirements

Secure MCP Tunnel is outbound-only; it requires no new inbound internet rule.
Apply default-deny network policy and allow only:

| Source | Destination | Purpose |
| --- | --- | --- |
| `tunnel-client` host | `api.openai.com:443`, path `/v1/tunnel/*` | Default control-plane polling and response posting. |
| `tunnel-client` host | `mtls.api.openai.com:443`, path `/v1/tunnel/*` | Control-plane traffic only when the reviewed mTLS mode is configured. |
| `tunnel-client` process | The single configured private MCP origin, preferably `http://127.0.0.1:3000/mcp` in one host boundary | Forwarding MCP requests. |
| ServiceNow MCP process | The exact approved ServiceNow instance and required secret/log providers | Existing application dependencies, unchanged by the tunnel. |

Deny direct internet ingress to the MCP listener, `/health/live`,
`/health/ready`, tunnel-client `/healthz`, `/readyz`, `/metrics`, and `/ui`.
The tunnel-client health/admin listener remains on loopback. Do not use
`--allow-remote-ui`, `ALLOW_REMOTE_UI=true`, a public port-forward, or a
catch-all egress rule for this validation.

## Prepare the private MCP server

Build and validate the same immutable artifact intended for staging:

```sh
npm ci
npm run build
npm run container:build
npm run container:validate
```

Inject all runtime values through the approved secret/config mechanism. For a
same-host adapter, bind the application to loopback and keep its existing
bearer authentication enabled:

```text
MCP_HOST=127.0.0.1
MCP_PORT=3000
MCP_ALLOWED_HOSTS=127.0.0.1:3000
MCP_BEARER_TOKEN=<runtime-secret-reference>
MCP_OWNER_ID=<approved-owner-id>
MCP_CLIENT_ID=<approved-private-client-id>
SN_PROFILE_NAME=<approved-test-profile>
SN_INSTANCE=<approved-sub-production-origin>
```

Supply the authentication-specific `SN_*` values, table target catalog, and
read/write allowlists described by the deployment and security guides. Confirm
locally that `/health/live` and `/health/ready` are healthy and that an
authenticated provider-neutral client can initialize, list the release tool
manifest, reject a missing profile, and perform the approved read. Do not start
the tunnel while the local baseline is failing.

## Install and verify tunnel-client

Download the binary from Platform tunnel settings or the latest official
`openai/tunnel-client` release. Record its version and release digest in the
private evidence record, then use the installed binary as the first source for
its exact supported options:

```sh
tunnel-client --version
tunnel-client help quickstart
tunnel-client profiles samples list
tunnel-client profiles samples show sample_mcp_remote_no_auth
tunnel-client run --help
```

The installed version must support an HTTP `main` channel, `mcp.extra_headers`
(or `--mcp.extra-headers` / `MCP_EXTRA_HEADERS`), `env:` or `file:` secret
references, `doctor --explain`, and the loopback health/admin surfaces. If any
required option is absent, stop. Do not guess a flag, downgrade the server to
unauthenticated mode, or place a secret literal in argv, a URL, or YAML.

## Create the secret-backed adapter profile

Tunnel creation and retrieval are authorized external operations. An operator
with Tunnels Read + Manage creates or reuses the private tunnel in Platform
tunnel settings. A runtime principal with Tunnels Read + Use receives a
short-lived or separately managed `CONTROL_PLANE_API_KEY`; do not use a broad
admin key for the long-lived daemon.

Create a named profile without putting either secret on the command line:

```sh
tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile servicenow-mcp-private \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-server-url http://127.0.0.1:3000/mcp

tunnel-client profiles edit servicenow-mcp-private
```

The tunnel ID above is a format-only placeholder. The protected profile must
use secret references and keep both admin surfaces on loopback:

```yaml
config_version: 1
control_plane:
  tunnel_id: tunnel_0123456789abcdef0123456789abcdef
  api_key: env:CONTROL_PLANE_API_KEY
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:3000/mcp
  extra_headers:
    Authorization: env:MCP_BEARER_TOKEN
health:
  listen_addr: 127.0.0.1:8080
admin_ui:
  open_browser: false
log:
  level: info
  format: json
```

`mcp.extra_headers` sends the static header only to the configured MCP origin;
it is not sent to the OpenAI control plane or unrelated authorization hosts.
Do not repeat the bearer in `mcp.discovery_extra_headers`: ordinary
`extra_headers` also supplies discovery/probe requests unless an explicit
discovery override is configured.

Connector-forwarded headers are applied last and override static headers
case-insensitively. Configure the ChatGPT draft app with no conflicting
`Authorization` mechanism for this static-bearer deployment, then prove during
validation that the MCP server receives the intended owner credential. If
workspace policy requires a different app authentication mode, stop and review
that design; never silently allow a connector header to replace the owner
bearer.

Store the named profile owner-only. Inject `CONTROL_PLANE_API_KEY` and
`MCP_BEARER_TOKEN` from the supervisor or secret manager at runtime. Never type
their values into shell history, commit them, place them in YAML, include them
in screenshots, or enable `--log.http-raw-unsafe`.

## Doctor and run

With the private MCP server already healthy and both secret variables supplied
by the runtime secret mechanism, validate before starting the polling loop:

```sh
tunnel-client doctor --profile servicenow-mcp-private --explain
tunnel-client run --profile servicenow-mcp-private
```

`doctor` must identify the intended tunnel/profile and the healthy `main`
channel without printing credentials. Treat any authorization failure,
unexpected origin, workspace mismatch, TLS-verification failure, or missing
header option as a hard stop.

Keep `run` supervised and healthy throughout validation. Confirm `/healthz`,
`/readyz`, `/metrics`, and `/ui` only through the loopback listener. Raw HTTP
logging remains disabled. A redacted tunnel support export is still reviewed as
sensitive before it leaves the owner boundary.

## Create the ChatGPT developer-mode app

Perform these steps in the associated ChatGPT workspace on ChatGPT web:

1. Confirm the tester has the plan-specific developer-mode permission and has
   enabled it for their account.
2. Open **Apps → Create** from the current workspace or user-settings surface.
3. Choose **Tunnel** under **Connection**, select the associated tunnel (or
   paste its reviewed tunnel ID), and do not enter a public MCP URL.
4. Configure no connector authentication that would override the
   secret-backed static `Authorization` header described above.
5. Select **Scan Tools**. Compare discovery with the frozen release tool
   manifest: names, input/output schemas, and annotations, not a historical
   hard-coded tool count.
6. Keep the app as a private draft labeled for development. Do not publish it
   to the workspace or submit it publicly during this story.
7. Open a new chat, select only this draft app, and run the approved validation
   cases below. Review each write confirmation before approval.

If the tunnel is not visible, verify its target ChatGPT workspace association,
the tester's Tunnels Read + Use role, developer-mode access, and propagation
time. If discovery or calls fail, keep `tunnel-client run` active and rerun
`doctor --explain`; do not replace the connection with an ad hoc public tunnel.

## Live validation and redacted evidence

Use a single change record and record **PASS**, **FAIL**, or **BLOCKED** for
every case. A checkbox or this document is not evidence. Evidence must come
from the authorized live run and be reviewed by a second authorized person.

| Case | Required live observation | Redacted evidence |
| --- | --- | --- |
| Private path | `tunnel-client` is ready/polling; no inbound/public listener or remote admin UI exists. | Version/digest, timestamp, network-policy result, and sanitized readiness state. Omit tunnel ID, URLs, org/workspace names, keys, headers, and payloads. |
| Initialization and discovery | ChatGPT scans the release tool manifest through the tunnel. | Manifest hash or approved name/schema/annotation comparison and correlation ID; no screenshots containing identifiers or prompts. |
| Required-profile rejection | Invoke a harmless read-only tool without `profile`; it fails before profile credentials, client construction, or ServiceNow access. | Sanitized error category/correlation ID and audit outcome only. |
| Representative read | Invoke `sn_query` with the explicit test profile, approved table, narrow fields, structured filter, limit, and byte budget. | Tool, approved profile alias, record count, pagination outcome, and correlation ID. No query values, instance URL, record fields, or response body. |
| Controlled write | After separate human authorization and ChatGPT confirmation, invoke an approved dedicated write tool—prefer `sn_incident_add_comment` or `sn_incident_add_work_note` when present in the frozen manifest—against one designated disposable incident. | Change approval ID, tool name, approved profile alias, sanitized success category, target-record evidence alias, and correlation ID. Never capture journal text, sys_id, record body, or credential. |
| Result and audit binding | Successful read/write structured results identify the same explicit profile; the matching application audit events identify that profile and expected outcome. | Approved profile alias plus correlation IDs. Verify the instance privately by an approved alias/hash; omit the origin itself. |
| Provider-neutral second client | The official MCP SDK and independent JSON-RPC Fetch client pass against the same frozen server artifact without ChatGPT or tunnel code in the core. | `npm run container:validate` version/digest and pass summary, or equivalent frozen CI artifact. No environment or container inspection dump. |
| Teardown and decoupling | Draft app/tunnel adapter is removed and the provider-neutral clients still pass locally. | Sanitized teardown checklist and post-removal validation summary. |

For the controlled write, pre-record the exact tool, profile, instance alias,
table/record alias, permitted fields, expected effect, cleanup decision, and
approver. Stop if the release manifest lacks a suitable dedicated tool, if
ChatGPT does not present the expected confirmation, or if the record is not
disposable. Do not substitute generic journal updates, production data, batch
execution, ATF, scripts, or an unplanned write.

Never collect or attach:

- `CONTROL_PLANE_API_KEY`, `MCP_BEARER_TOKEN`, ServiceNow credentials, profile
  encryption keys, OAuth/API-key material, secret references, or ciphertext;
- `Authorization`, cookie, API-key, connector, tunnel shard, or proxy headers;
- raw environment/config/profile files, argv/process dumps, complete tunnel
  support exports, or container inspection output;
- tunnel IDs, organization/workspace IDs or names, private/public URLs, full
  instance origins, usernames, or raw owner/client hashes;
- prompts, query values, journal text, sys_ids, record/attachment bodies, tool
  response bodies, exception text, or raw HTTP logs.

Use approved aliases, hashes produced for this evidence purpose, counts,
categories, versions, timestamps, image digests, and correlation IDs. Store the
bundle with the access and retention controls in the operations runbook, have a
second authorized reviewer inspect it, then delete it on schedule.

## Teardown and rollback

At the end of the window, or immediately on unexpected access or behavior:

1. Stop new ChatGPT tests and disable or delete the private draft app. Do not
   publish it.
2. Stop `tunnel-client` and verify its `/readyz` no longer reports ready.
3. Revoke the dedicated control-plane runtime API key and remove its secret
   reference from the supervisor.
4. An authorized Tunnels Read + Manage operator removes the temporary
   organization/workspace association or deletes the temporary tunnel when the
   change record calls for it.
5. Remove the tunnel-client profile and any temporary local secret mount using
   the owner-approved recoverable process. Retain no copied secret or raw log.
6. Perform the pre-approved cleanup for the disposable ServiceNow test record;
   do not improvise a delete.
7. Verify no inbound/public listener, port-forward, remote `/ui`, public DNS,
   proxy route, or firewall exception was created.
8. Re-run the provider-neutral local client/container validation. The core MCP
   service must initialize, discover, reject missing profiles, and perform its
   safe read exactly as it did before the adapter existed.
9. Record the sanitized result and close or escalate the change. Rotate the MCP
   bearer or ServiceNow credential if exposure is suspected.

The tunnel is not a public-submission mechanism. This story must never create
or claim a public endpoint, publish the draft app, bake tunnel-client into the
server image, add provider behavior to tool handlers, weaken bearer/profile
policy, or claim live success from local tests alone.
