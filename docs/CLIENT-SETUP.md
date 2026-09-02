# V2 service and client setup

This is the shortest complete path from a clean install to two
provider-neutral clients using the same ServiceNow MCP V2 service. The server
exposes Streamable HTTP at `/mcp`; it does not expose stdio and it does not
select a default or active ServiceNow profile.

## Quickstart: zero to a working connection

Five commands. Nothing here puts a secret in argv or shell history.

```sh
# 1. Install.
npm install -g @onlyflows/servicenow-mcp

# 2. Generate owner-only local auth material and register the clients whose
#    CLI can hold a bearer by reference (Codex and Claude Code today).
servicenow-mcp-setup

# 3. Create one explicit ServiceNow profile. The credential is read at a
#    non-echoed prompt or from bounded stdin, never from the command line.
servicenow-mcp-profile create \
  --name dev \
  --instance https://yourinstance.service-now.com \
  --auth-type oauth \
  --client-id <non-secret-oauth-client-id> \
  --source reference \
  --provider env

# 4. Grant that profile least-privilege table access. THIS STEP IS REQUIRED:
#    a profile with no rules denies every tool call.
servicenow-mcp-setup grant --profile dev --read incident,problem --write incident

# 5. Start the service, then verify the whole path.
set -a; source ~/.servicenow-mcp/server.env; set +a; servicenow-mcp &
servicenow-mcp-setup doctor --profile dev
```

`doctor` checks the Node version, file ownership and modes, profile
completeness, credential resolution, table-access rules, and the live endpoint,
and prints the exact remedy for anything it finds. It never prints a secret and
exits non-zero when a check fails.

### What the bootstrap writes

| File | Mode | Contents |
|------|------|----------|
| `~/.servicenow-mcp/server.env` | `0600` | `MCP_BEARER_TOKEN`, `MCP_OWNER_ID`, `MCP_CLIENT_ID`, `MCP_HOST`, `MCP_PORT`, `SN_PROFILE_ENCRYPTION_KEY` |
| `~/.servicenow-mcp/client.env` | `0600` | `SERVICENOW_MCP_BEARER_TOKEN` for clients that read the bearer from their own environment |
| `~/.servicenow-mcp/client-headers.txt` | `0600` | An `Authorization: Bearer …` line for `mcp-remote --header-file` |

The directory is `0700`. Modes are re-applied on every run, so a file that was
loosened by hand is tightened again rather than silently receiving a fresh
bearer at the wrong permissions.

`--force` regenerates the bearer and owner/client identifiers. It deliberately
does **not** regenerate `SN_PROFILE_ENCRYPTION_KEY`: that key decrypts every
AES-256-GCM envelope in `config.json`, and replacing it would make those
credentials permanently unreadable. `--rotate-encryption-key` exists for a
clean machine and is refused outright while a profile file is present.

If you install globally first, `servicenow-mcp setup` and
`servicenow-mcp-setup` run the same bootstrap. `npx @onlyflows/servicenow-mcp@latest setup`
works without a global install.

### Granting table access

The server denies every table until the selected profile carries explicit
rules. For a **file-backed profile** — anything created with
`servicenow-mcp-profile` — those rules live in the profile itself, and
`SN_ALLOWED_READ_TABLES` / `SN_ALLOWED_WRITE_TABLES` / `SN_TABLE_ACCESS_TARGETS`
in the environment **do not apply**. This is the single most common reason a
freshly installed server answers every call with a policy denial.

```sh
# Reads on two tables, writes on one.
servicenow-mcp-setup grant --profile dev --read incident,problem --write incident

# Narrow the tools permitted on a target.
servicenow-mcp-setup grant --profile dev --read cmdb_ci --tools sn_query,sn_relationships

# A table that extends another must declare the tables it reaches. Related
# tables join the allowlist but get no target of their own, so a caller cannot
# address them directly.
servicenow-mcp-setup grant --profile dev --read change_request --related change_request=task

# Inspect the result without writing it.
servicenow-mcp-setup grant --profile dev --read incident --dry-run
```

Grants are additive; `--replace` discards the existing rules instead. Every
grant is validated with the same loader the server uses at request time, so a
rejected policy fails at the CLI rather than at the first tool call. Default
tools are `sn_query,sn_get,sn_aggregate,sn_schema` for a read grant and those
plus `sn_create,sn_update` for a write grant — `sn_delete`, `sn_batch`, and
`sn_atf` are never granted implicitly and must be named with `--tools`.

`grant` refuses `*` and refuses the hard-denied credential, authentication,
encryption, and security-policy table families. A wildcard allowlist skips both
the per-tool binding and the related-table closure check; configure one
deliberately in the profile file after reading `PRODUCTION-SECURITY.md`.

Restart the service after changing a profile.

## 1. Configure and start the HTTP service

Use Node.js 20 or newer. Review `.env.example` as a configuration inventory,
but do not put protected values in it or another repository file. Its bearer,
password, client-secret, API-key, and encryption-key assignments are
intentionally empty. Inject those values at process start through the approved
supervisor, orchestrator, OS keychain, or secret manager.

For the one-profile environment compatibility path, set the non-secret values
from `.env.example`, inject `MCP_BEARER_TOKEN` and the authentication-specific
ServiceNow secret, and keep the explicit `SN_PROFILE_NAME=example-dev`
mapping. Bare `SN_*` connection values without `SN_PROFILE_NAME` create no
profile. This path is not the recommended way to maintain two profiles; use
the protected configuration workflow below for that.

Then build and start the same HTTP-only entrypoint used by the production
container:

```sh
npm ci
npm run build
npm start
```

The default endpoint is `http://127.0.0.1:3000/mcp`. Startup fails closed when
the MCP bearer or owner/client identity is missing or invalid. `/health/live`
and `/health/ready` are unauthenticated lifecycle probes; they are not
ServiceNow health checks and do not grant `/mcp` access.

Keep a loopback listener for local use. Before any non-loopback deployment,
put the process behind the private ingress and operator-managed TLS boundary
in `PRODUCTION-SECURITY.md`, configure exact Host/Origin admission, and keep
the MCP bearer enabled. The process does not terminate TLS itself. On SIGINT
or SIGTERM it stops admission, flips readiness false, drains accepted requests
up to `MCP_SHUTDOWN_GRACE_MS`, then closes remaining MCP and HTTP resources.

## 2. Create two isolated named profiles out of band

The serving MCP surface cannot create, activate, switch, rotate, or remove a
profile. Use the protected operator CLI. Do not place a credential, secret
reference, ciphertext, or encryption key in tool arguments or command-line
arguments.

The following creates a development OAuth profile whose protected prompt reads
the environment-secret reference name. The reference value itself is supplied
through the prompt or bounded standard input, not `argv`:

```sh
servicenow-mcp-profile create \
  --name dev \
  --instance https://dev.service-now.com \
  --auth-type oauth \
  --client-id dev-non-secret-client-id \
  --source reference \
  --provider env
```

At the protected prompt, enter the name of the supervisor-injected environment
secret for this profile. The stored entry is a structured `secret_ref`; the
referenced secret is resolved only when a call explicitly selects `dev`.

The following creates a separate basic-auth staging profile with an encrypted
credential. First inject `SN_PROFILE_ENCRYPTION_KEY` from the secret manager
into the CLI process. The key is exactly 32 random bytes encoded as base64 or
base64url and remains separate from the profile file, MCP bearer, and
ServiceNow credentials. Then run:

```sh
servicenow-mcp-profile create \
  --name staging \
  --instance https://staging.service-now.com \
  --auth-type basic \
  --username staging.integration \
  --source encrypted
```

Enter the staging credential only at the non-echoed prompt or bounded standard
input. The resulting owner-only `~/.servicenow-mcp/config.json` contains the
two non-secret instance definitions plus a structured secret reference for
`dev` and a versioned encrypted envelope for `staging`. It contains neither
plaintext secret nor encryption key. The commands
`servicenow-mcp-profile inspect --name dev` and
`servicenow-mcp-profile inspect --name staging` report only safe metadata and
source kinds.

One process accepts one `SN_PROFILE_ENCRYPTION_KEY` for encrypted envelopes in
its profile file. That key must be dedicated to this deployment and separated
from all bearer and ServiceNow secrets. If two profiles require independent
encryption-key trust domains, operate them as separate private service
deployments with separate profile files, keys, bearer credentials, and network
policy; do not weaken the single process key boundary.

### Rotation, backup, and recovery

Rotate a referenced ServiceNow secret in its authoritative secret system,
update the reference through `servicenow-mcp-profile rotate` when the reference
name changes, roll the serving process, verify an explicit-profile bounded
read, and only then revoke the prior secret.

For an encryption-key rotation, prepare a protected working copy while the old
file/key pair remains active. Inject the new key only into the administration
job, re-enter and rotate every encrypted field in the working profile file,
then deploy the complete new file/key pair together. Verify both profiles
before retiring the old pair. Never serve a file containing a mixture of
envelopes that require different keys.

Back up only the owner-only encrypted/reference profile file and its
non-secret version metadata. Exclude plaintext values, environment dumps,
secret-manager exports, and the encryption key. Retain the matching key
version separately in the approved key system, with independent access and
retention controls. A backup without its approved key version or live secret
references is not a tested recovery point.

Recover into an isolated private environment: restore the file with owner-only
permissions, inject the matching key and resolver access separately, run safe
CLI inspection, start the service, and use the explicit `dev` and `staging`
calls below. Recovery is complete only when each selected profile performs its
own bounded read, the other profile's adapter is untouched, result/audit
bindings match, and no secret appears in output or logs. A missing/wrong key or
resolver failure must stop before ServiceNow client construction.

## 3. Connect with the official MCP SDK

Inject `MCP_BEARER_TOKEN`, set the non-secret `MCP_URL` and `MCP_PROFILE`, and
run client code without placing any secret in a URL or command argument. Every
tool invocation includes the selected profile; initialization and discovery
naturally have no tool arguments.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp");
const bearer = process.env.MCP_BEARER_TOKEN;
const profile = process.env.MCP_PROFILE;
if (!bearer || !profile) throw new Error("injected client configuration missing");

const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { authorization: `Bearer ${bearer}` } },
});
const client = new Client({ name: "official-sdk-example", version: "1.0.0" });
await client.connect(transport);
await client.listTools();
const result = await client.callTool({
  name: "sn_query",
  arguments: {
    profile,
    table: "incident",
    fields: "sys_id,number,short_description",
    limit: 5,
  },
});
if (result.structuredContent?.profile !== profile) {
  throw new Error("resolved profile mismatch");
}
await client.close();
```

## 4. Connect with independent Fetch JSON-RPC

This client uses the same `MCP_URL`, bearer injection, and `/mcp` artifact. It
initializes, sends the initialized notification, discovers the same tools, and
invokes a read with an explicit profile.

```js
const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const bearer = process.env.MCP_BEARER_TOKEN;
const profile = process.env.MCP_PROFILE;
if (!bearer || !profile) throw new Error("injected client configuration missing");

let id = 0;
let protocolVersion;
const headers = () => ({
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${bearer}`,
  "content-type": "application/json",
  ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
});
const rpc = async (method, params) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const message = await response.json();
  if (!response.ok || message.error) throw new Error("MCP request failed");
  return message.result;
};

const initialized = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "fetch-example", version: "1.0.0" },
});
protocolVersion = initialized.protocolVersion;
await fetch(endpoint, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
await rpc("tools/list", {});
const result = await rpc("tools/call", {
  name: "sn_query",
  arguments: {
    profile,
    table: "incident",
    fields: "sys_id,number,short_description",
    limit: 5,
  },
});
if (result.structuredContent?.profile !== profile) {
  throw new Error("resolved profile mismatch");
}
```

The repository release gate runs these two client families against the same
runtime and immutable image. See `CROSS-CLIENT-RELEASE-MATRIX.md`.

## 5. Profile selection, results, and audit evidence

All 19 tools require a non-empty `profile`. Missing, empty, unknown, or invalid
names fail before credentials or a ServiceNow client. There is no default,
active, current, selected-session, or switch-profile operation. To work across
instances, make separate calls and include the intended name each time:

```ts
const devResult = await client.callTool({
  name: "sn_query",
  arguments: { profile: "dev", table: "incident", limit: 1 },
});
const stagingResult = await client.callTool({
  name: "sn_query",
  arguments: { profile: "staging", table: "incident", limit: 1 },
});
```

Verify `devResult.structuredContent.profile === "dev"` and
`stagingResult.structuredContent.profile === "staging"`. Their corresponding
bounded audit events must carry the same profile names, canonical instance
bindings, outcome, and correlation IDs. Treat profile and instance as
restricted operational metadata. Never copy credentials, secret references,
request/result bodies, or raw audit streams into evidence.

## 6. Restricted reads and controlled writes

Table access is deny-by-default. A table needs the correct read/write allowlist
entry and a complete target entry naming the exact tool. For a file-backed
profile that is the profile's own `tableAccess` object, written by
`servicenow-mcp-setup grant`; the `SN_ALLOWED_*_TABLES` and
`SN_TABLE_ACCESS_TARGETS` environment variables apply only to the
`SN_PROFILE_NAME` environment profile, and only when no profile file exists.
Structured filters are the normal query interface; raw encoded reads remain
denied unless an explicit bounded read-only rule authorizes one exact
tool/table pair.

`servicenow-mcp-setup doctor` reports a profile whose rules are missing or
whose allowlist names a table with no target entry, which is the failure that
otherwise surfaces only as a generic policy denial at call time.

Incident `comments` and `work_notes` are append-only. Generic `sn_update`
rejects them before credentials/client construction. After separate human
authorization on a disposable non-production incident, use a dedicated tool:

```ts
const writeResult = await client.callTool({
  name: "sn_incident_add_comment",
  arguments: {
    profile: "staging",
    sys_id: "0123456789abcdef0123456789abcdef",
    content: "Approved bounded validation comment",
  },
});
```

The staging policy must grant write access to `incident` and list
`sn_incident_add_comment` on its exact target. A repeated call appends again;
the operation is intentionally non-idempotent. Do not substitute a generic
journal update, production record, unrestricted query, batch, ATF execution,
or script.

## 7. MCP client configuration

The official SDK and independent Fetch paths above are the portable release
contract. Everything in this section is optional client configuration around
the same endpoint. `servicenow-mcp-setup client --client <name>` prints any of
these blocks with your own endpoint substituted, and
`servicenow-mcp-setup client --client all` prints all of them.

Two rules apply to every client:

- The bearer must reach the client **by reference** — an environment variable,
  a `0600` header file, or the client's own secret storage. Never paste it into
  a config file that is synced or version-controlled, and never pass it as a
  command-line argument, where any other user on the machine can read it from
  the process list.
- Every tool call must name a `profile`. There is no default, active, or
  remembered profile.

| Client | Native Streamable HTTP | How the bearer is held |
|--------|------------------------|------------------------|
| Claude Code | yes | `${VAR}` expansion in `.mcp.json`, resolved at load |
| Codex | yes | `--bearer-token-env-var`, name only in config |
| Cursor | yes (1.0+) | `${env:VAR}` expansion in `headers` |
| VS Code | yes | `${input:id}`, stored in VS Code secret storage |
| Claude Desktop | no (stdio only) | `mcp-remote --header-file` |
| Windsurf | no (stdio only) | `mcp-remote --header-file` |

### Client behavior requirements

**Keep at most two tool calls in flight per server.** The runtime admits
`MCP_MAX_CONCURRENT_REQUESTS` concurrent `/mcp` requests, which defaults to
`2` and cannot safely be raised: startup refuses any value whose combined body
estimate exceeds the 512 MiB admission ceiling, so `MCP_MAX_CONCURRENT_REQUESTS=3`
makes the server fail to start rather than degrade. There is **no admission
queue**. A third simultaneous request is answered immediately with HTTP `503`
and `retry-after: 1`, and the official `StreamableHTTPClientTransport` does not
retry it — the model sees a hard tool error. An agent that fans out five
parallel tool calls will therefore get three failures and may summarize from
partial results.

Configure the client, or the agent driving it, to issue ServiceNow tool calls
sequentially, or to cap its own parallelism at two. If a client cannot be
constrained, put a queueing reverse proxy in front of `/mcp`.

**Raising the request body limit costs you concurrency — and it is not an
operator knob.** The admission guard at `src/http-runtime.ts:232-240` enforces

```
concurrency × ((maxBodyBytes + 1 MiB) × 64 + 80 MiB)  ≤  512 MiB
```

where the 64× and 8× factors are safety allowances for JSON heap expansion and
the raw-attachment budget. The two settings trade directly against each other:

| `maxBodyBytes` | Highest concurrency that starts | Effect |
|---|---|---|
| 1 MiB (shipped default) | 2 | 416 MiB budgeted; the intended configuration |
| 1.75 MiB | 2 | 512 MiB — exactly at the ceiling |
| **2 MiB** | **1** | **Single-flight: one request at a time, serialized** |
| 5.75 MiB | 1 | 512 MiB — the last value that starts at all |
| above 5.75 MiB | none | **Startup fails at any concurrency** |

Two failure modes are worth knowing before you touch either value:

- **At 2 MiB and above, the server is single-flight.** Concurrency 2 no longer
  fits the ceiling, so the runtime can only start at concurrency 1, and every
  tool call queues behind every other one. There is no warning and no log line —
  it presents as "the server got slow", and one large upload blocks every other
  tool for its duration. This is the more dangerous of the two, because nothing
  connects the cause to the effect.
- **Above 5.75 MiB the server refuses to start.** This is a `throw` in the
  constructor, not a clamp and not a warning. The message reads *"HTTP
  maxConcurrentRequests and maxBodyBytes exceed the estimated body-memory
  ceiling"* — it names the two settings but gives neither the ceiling, the
  arithmetic, nor a working value, so on its own it offers no way forward. The
  table above is that way forward.

**In the shipped `servicenow-mcp` executable, `maxBodyBytes` cannot be changed.**
`src/index.ts:167-170` builds the request policy with only `allowedHosts` and
`allowedOrigins`, so the limit is always the 1 MiB default and there is no
environment variable for it. The two thresholds above therefore bind anyone
embedding this package and calling `createHttpRuntime` directly, not an
operator running the binary. For an operator the only reachable version of this
failure is `MCP_MAX_CONCURRENT_REQUESTS=3`, which needs 624 MiB against the
512 MiB ceiling and so refuses to start.

**A 10 MiB attachment is unreachable over HTTP at any concurrency.** Base64
inflates 10 MiB to about 13.33 MiB on the wire, which budgets roughly 997 MiB —
nearly double the ceiling even at concurrency 1. No combination of settings
gets there, so "just raise the body limit" is not a path. At the shipped 1 MiB
body the usable payload is about 768 KiB of raw file before JSON envelope
overhead. Send large files through ServiceNow's own UI or a separate integration.

**Honor `Retry-After` on both `429` and `503`.**

| Status | Meaning | Client action |
|--------|---------|---------------|
| `429` | Rate limited. Body is `{"error":"rate_limited","message":"…","retry_after_seconds":N}` and the `Retry-After` header carries the same bounded value. Two buckets apply: 240 requests/60 s per direct socket source and 120 requests/60 s per owner/client identity. | Wait `retry_after_seconds`, then retry the same request. |
| `503` | Admission slots are full, or the runtime is starting or draining. `retry-after: 1`, `connection: close`. | Wait, then retry with reduced parallelism. |
| `401` | Bearer missing, malformed, or not the one the service is running with. | Do not retry. Re-source the bearer. |
| `421` | `Host` authority not in `MCP_ALLOWED_HOSTS`. | Do not retry. Fix the configured URL or the allowlist. |
| `403` | `Origin` rejected. `MCP_ALLOWED_ORIGINS` is unset by default, which denies every request carrying an `Origin`. | Do not retry. Add the exact origin, or send no `Origin`. |
| `413` | Body exceeded 1 MiB. | Do not retry unchanged. Reduce `limit`, narrow `fields`, or split the batch. |

Rate-limit state is process-local and resets on restart. Health probes are
exempt from the source bucket, so a saturated client cannot change liveness or
readiness.

### Per-client configuration

Every block below preserves the same protected Streamable HTTP `/mcp` endpoint,
secret-backed bearer boundary, tool schemas, and explicit-profile rule. They
must not redefine the core server, image, profile schema, policy, handler, or
result/audit contract.

#### ChatGPT developer-mode app through Secure MCP Tunnel

Use this path only when the private deployment and OpenAI organization/workspace
have been separately authorized. The current official OpenAI flow is:

1. Create or select the tunnel in
   [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
   and associate the target ChatGPT workspace.
2. Run `tunnel-client` inside the private boundary using the secret-backed
   profile in `PRIVATE-CHATGPT-CONNECTIVITY.md`. Its `main` channel points to
   this service's unchanged `/mcp` origin and its static Authorization header
   reads `env:MCP_BEARER_TOKEN`; the approved supervisor injects both the
   control-plane credential and MCP bearer directly into that process.
3. In [ChatGPT Plugins](https://chatgpt.com/plugins), use the plus button to
   create a developer-mode app, choose **Tunnel** under **Connection**, and
   select the associated tunnel. Do not enter a public MCP URL or a second
   Authorization value in the app.
4. Scan tools and compare the 19 names, schemas, and annotations with the
   frozen release manifest. Keep the app private and draft-only.
5. On every use, name the profile in the request. For example, instruct the
   app to invoke `sn_query` with these exact non-secret arguments:

```json
{
  "profile": "staging",
  "table": "incident",
  "fields": "sys_id,number,short_description",
  "limit": 5
}
```

Confirm the approval surface shows `profile: "staging"` before allowing the
call, then verify the structured result and bounded audit event bind to the
same profile. No chat or previous invocation creates active-profile state.
Follow the complete authorization, validation, evidence, and teardown procedure
in `PRIVATE-CHATGPT-CONNECTIVITY.md`. The authoritative product flow is the
[OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

#### Claude Code over Streamable HTTP

`servicenow-mcp-setup` registers Claude Code automatically when the `claude`
CLI is on `PATH`. To do it by hand:

```sh
set -a; source ~/.servicenow-mcp/client.env; set +a
claude mcp add --transport http --scope user \
  --header 'Authorization: Bearer ${SERVICENOW_MCP_BEARER_TOKEN}' \
  servicenow-mcp http://127.0.0.1:3000/mcp
```

The single quotes matter: the literal `${SERVICENOW_MCP_BEARER_TOKEN}` text is
what gets stored, and Claude Code expands it when the config loads. The token
therefore never enters argv, the config file, or shell history. `--scope user`
makes the server available in every project; use `--scope project` to write a
checked-in `.mcp.json` instead — safe here precisely because the file holds a
placeholder rather than a secret.

The equivalent `.mcp.json` entry:

```json
{
  "mcpServers": {
    "servicenow-mcp": {
      "type": "http",
      "url": "${SERVICENOW_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${SERVICENOW_MCP_BEARER_TOKEN}"
      }
    }
  }
}
```

`SERVICENOW_MCP_BEARER_TOKEN` must be present in Claude Code's own environment,
and `SERVICENOW_MCP_URL` must resolve to the same reviewed `/mcp` origin used by
the SDK and Fetch release checks — HTTPS for any non-loopback route. When a
referenced variable is absent, Claude Code
logs a warning and leaves the `${VAR}` placeholder unexpanded;
the MCP configuration still loads, but the server receives the literal
placeholder and rejects it with HTTP `401`. Treat that warning, or a
disconnected `/mcp` status, as a failed setup.

Start a new session, run `/mcp` to confirm `servicenow-mcp` is connected, and
ask Claude to invoke one tool with the profile stated explicitly. The expected
arguments for the first bounded read are:

```json
{
  "profile": "dev",
  "table": "incident",
  "fields": "sys_id,number,short_description",
  "limit": 5
}
```

Verify `structuredContent.profile` and the matching audit event both say
`dev`. Repeat with `profile: "staging"` as a separate call when cross-instance
work is authorized; never ask Claude to remember or switch an active profile.
The current configuration shape and environment-expansion behavior are in the
[official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).

#### Codex

`servicenow-mcp-setup` registers Codex automatically when the `codex` CLI is on
`PATH`. By hand:

```sh
set -a; source ~/.servicenow-mcp/client.env; set +a
codex mcp add servicenow-mcp \
  --url http://127.0.0.1:3000/mcp \
  --bearer-token-env-var SERVICENOW_MCP_BEARER_TOKEN
```

Only the variable *name* is written to Codex's config. Codex must be launched
from an environment where `SERVICENOW_MCP_BEARER_TOKEN` is set.

#### Claude Desktop and Windsurf

Neither client can send a static `Authorization` header to a Streamable HTTP
server; both speak stdio. Bridge them with `mcp-remote`, and pass the bearer
with `--header-file` so it stays out of argv and out of the config file:

```json
{
  "mcpServers": {
    "servicenow-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:3000/mcp",
        "--transport", "http-only",
        "--allow-http",
        "--header-file", "/Users/you/.servicenow-mcp/client-headers.txt"
      ]
    }
  }
}
```

Use the absolute path that `servicenow-mcp-setup` printed; `~` is not expanded.
Drop `--allow-http` once the endpoint is HTTPS. Config file locations:

- Claude Desktop, macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Claude Desktop, Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Windsurf: `~/.codeium/windsurf/mcp_config.json`

Restart the application completely after editing. Claude Desktop's MCP logs are
at `~/Library/Logs/Claude/mcp*.log` on macOS and `%APPDATA%\Claude\logs` on
Windows.

#### Cursor

Cursor 1.0 and newer addresses the endpoint directly and expands `${env:VAR}`
in `headers`. Put this in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json`
(per project):

```json
{
  "mcpServers": {
    "servicenow-mcp": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${env:SERVICENOW_MCP_BEARER_TOKEN}"
      }
    }
  }
}
```

On an older Cursor, use the `mcp-remote` bridge above instead.

#### VS Code

VS Code supports HTTP servers natively and holds the token in its own secret
storage via an `inputs` prompt. Put this in `.vscode/mcp.json` for a workspace,
or the user-level `mcp.json`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "servicenow-mcp-bearer",
      "description": "ServiceNow MCP bearer token",
      "password": true
    }
  ],
  "servers": {
    "servicenow-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${input:servicenow-mcp-bearer}"
      }
    }
  }
}
```

VS Code prompts once and stores the value itself, so this file is safe to commit.
Read the token from `~/.servicenow-mcp/client.env` when it prompts.

#### Any other Streamable HTTP client

The contract is: `POST` to the `/mcp` URL, `Authorization: Bearer <token>`,
`accept: application/json, text/event-stream`, one JSON-RPC message per request
in a body of at most 1 MiB. There is no `GET`/SSE stream, no session id, and no
`DELETE`; any method other than `POST` returns `405`. Follow the client-behavior
requirements above.

No platform path is a prerequisite for another or for the core
official-SDK/Fetch gates. Removing any client configuration leaves the same
server artifact and endpoint working unchanged.

## 8. Migrating clients and extending tools

Remove V1 client entries that launch a local command or pass executable
arguments. V2 has no stdio fallback; configure the authenticated Streamable
HTTP URL and migrate every tool call to an explicit profile as described in
`V2-MIGRATION.md`.

New tools must use the provider-neutral module contract in `ADDING-TOOLS.md`:
compose required-profile input and resolved-profile output, declare all
permissions/tables/APIs/field policies/capabilities and annotations, authorize
the complete access plan before client construction, use only injected safe
services, and extend both-client HTTP contract coverage. Do not register a tool
directly with the MCP SDK or import provider/tunnel code into a module.

## Related operator guides

- `CONTAINER-DEPLOYMENT.md`: immutable image, runtime injection, health, and
  least-privilege container execution.
- `OPERATIONS-RUNBOOK.md`: deployment, rollback, rotation, monitoring,
  incident response, and recovery verification.
- `PRODUCTION-SECURITY.md`: TLS, proxy, Host/Origin, secret, network, and DNS
  boundaries.
- `PROFILE-CREDENTIALS.md`: exact out-of-band CLI and storage contract.
- `TESTING-OAUTH.md`: opt-in sub-production OAuth validation.
- `V2-MIGRATION.md`: complete V1-to-V2 transport, profile, policy, attachment,
  and incident-journal changes.
- `PRIVATE-CHATGPT-CONNECTIVITY.md`: optional provider adapter workflow.
- `CROSS-CLIENT-RELEASE-MATRIX.md`: release-blocking protocol evidence.
