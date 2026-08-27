# V2 service and client setup

This is the shortest complete path from a clean install to two
provider-neutral clients using the same ServiceNow MCP V2 service. The server
exposes Streamable HTTP at `/mcp`; it does not expose stdio and it does not
select a default or active ServiceNow profile.

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

All 20 tools require a non-empty `profile`. Missing, empty, unknown, or invalid
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
entry and a complete `SN_TABLE_ACCESS_TARGETS` entry naming the exact tool.
Structured filters are the normal query interface; raw encoded reads remain
denied unless an explicit bounded read-only rule authorizes one exact
tool/table pair.

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

## 7. Optional AI-platform setup paths

The official SDK and independent Fetch paths above are the portable release
contract. AI-platform integrations are optional client configuration: both
paths below preserve the same protected Streamable HTTP `/mcp` endpoint,
secret-backed bearer boundary, tool schemas, and explicit-profile rule. They
must not redefine the core server, image, profile schema, policy, handler, or
result/audit contract.

### ChatGPT developer-mode app through Secure MCP Tunnel

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
4. Scan tools and compare the 20 names, schemas, and annotations with the
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

### Claude Code over Streamable HTTP

Claude Code can connect directly when it already has private/TLS reachability
to the same protected `/mcp` endpoint. Its current MCP configuration supports
HTTP servers and `${VAR}` expansion in `url` and `headers`. Have the approved
supervisor, keychain, or secret manager inject `SERVICENOW_MCP_URL` and
`MCP_BEARER_TOKEN` into the Claude Code process; never pass the bearer with
`claude mcp add --header`, a shell assignment, or another command argument.

Use an owner-controlled MCP JSON configuration containing references only:

```json
{
  "mcpServers": {
    "servicenow-v2": {
      "type": "http",
      "url": "${SERVICENOW_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${MCP_BEARER_TOKEN}"
      }
    }
  }
}
```

`SERVICENOW_MCP_URL` must resolve to the same reviewed `/mcp` origin used by
the SDK and Fetch release checks—HTTPS for any non-loopback route. Claude Code
logs a warning and leaves the `${VAR}` placeholder unexpanded when a referenced
environment variable is absent; the MCP configuration still loads, but the
server cannot use the missing value. Treat that warning or a disconnected
`/mcp` status as a failed setup. Start a new session, use `/mcp` to confirm
`servicenow-v2` is connected, and ask Claude to invoke one tool with the profile
stated explicitly. The expected arguments for the first bounded read are:

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

Neither platform path is a prerequisite for the other or for the core
official-SDK/Fetch gates. Removing either platform configuration leaves the
same server artifact and endpoint working unchanged.

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
