# @onlyflows/servicenow-mcp

<!-- Logo placeholder -->
<!-- ![ServiceNow MCP Server](banner.png) -->

**The most comprehensive ServiceNow MCP server.** 19 tools for full CRUD, append-only incident journals, CMDB graph traversal, ATF testing, multi-instance profiles, and more.

Built by [OnlyFlows](https://onlyflows.tech) · Published by [@onlyflowstech](https://github.com/onlyflowstech)

[![npm version](https://img.shields.io/npm/v/@onlyflows/servicenow-mcp)](https://www.npmjs.com/package/@onlyflows/servicenow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---


## Installation

```bash
npm install -g @onlyflows/servicenow-mcp
servicenow-mcp-setup
```

Run bare on a terminal, `servicenow-mcp-setup` walks you through the whole
thing in one command: it generates the local auth material, asks for your
instance and credential, **verifies that credential against the instance**,
asks which tables to grant, writes the profile, and registers any supported
client whose CLI is installed. The credential is entered at a hidden prompt —
never an argument, never shell history — and nothing is written to the profile
until the instance has accepted it, so a typo or a wrong password leaves
nothing behind.

```
ServiceNow MCP setup

This walks through one ServiceNow connection end to end. Nothing is
written to the profile until your credential is verified against the
instance. Press Ctrl+C at any point to stop; nothing will be saved.

Profile name [dev]: dev
ServiceNow instance (for example dev12345.service-now.com): dev12345.service-now.com
Authentication:
  1) basic (default)
  2) oauth
  3) apikey
Choice [1]: 1
How should the credential be stored?:
  1) encrypted (default)
  2) reference
Choice [1]: 1
ServiceNow username: integration.user

Enter each secret now. Input is hidden — nothing you type from here
is displayed.
credential:

Verifying against the instance...
  ok  https://dev12345.service-now.com accepted the credential.

Table access is deny-by-default: a profile with no rules denies every
tool call. Grant the narrowest set that does the job; you can add more
later with servicenow-mcp-setup grant.

Tables to allow for READS:
  1) Just incident (default)
  2) Common ITSM set (incident,change_request,problem,task,sys_user)
  3) All tables (*)
  4) Enter a custom list
  5) None
Choice [1]: 1

Tables to allow for WRITES:
  1) Just incident
  2) Common ITSM set (incident,change_request,problem,task,sys_user)
  3) All tables (*)
  4) Enter a custom list
  5) None (default)
Choice [5]: 1

Wrote profile dev.

Register this server with codex and claude-code? [Y/n]: y

ServiceNow MCP doctor

ok    node: v22.11.0
ok    server command: servicenow-mcp resolves on PATH; clients spawn it over stdio
ok    config directory: ~/.servicenow-mcp (0700)
ok    profile dev: instance: https://dev12345.service-now.com
ok    profile dev: credential: basic credential resolves from its encrypted source
ok    profile dev: table access: 1 read, 1 write, 1 target(s)

All checks passed.

Setup complete.

Profile   dev
Reads     incident
Writes    incident
Transport stdio (each client spawns its own servicenow-mcp)
Clients   codex, claude-code

Start codex or claude-code and it will launch the server itself.
There is nothing to keep running between sessions.
```

There is nothing to start. The server speaks **stdio**: each registered client
spawns its own copy of `servicenow-mcp` on demand and talks to it over that
process's stdin and stdout. Setup finishes by running the same checks `doctor`
runs, so you can re-run them any time:

```bash
servicenow-mcp-setup doctor --profile dev
```

`npx @onlyflows/servicenow-mcp@latest setup` runs the same wizard without a
global install, and `servicenow-mcp setup` is an alias for
`servicenow-mcp-setup`.

### Scripted setup

Pass any flag, or run without a terminal, and the wizard steps aside for the
original non-interactive behavior — so CI and provisioning scripts are
unaffected. `--non-interactive` forces it explicitly:

```bash
servicenow-mcp-setup --non-interactive --clients none --json
servicenow-mcp-profile create --name dev --instance https://yourinstance.service-now.com \
  --auth-type oauth --client-id <client-id> --source reference --provider env
servicenow-mcp-setup grant --profile dev --read incident,problem --write incident
```

### The `servicenow-mcp-setup` commands

| Command | Purpose |
|---------|---------|
| `servicenow-mcp-setup` | Generate local auth material and register supported clients |
| `servicenow-mcp-setup client --client <name>` | Print copy-pasteable config for a client |
| `servicenow-mcp-setup grant --profile <name> --read <tables>` | Add table access rules to a profile |
| `servicenow-mcp-setup doctor` | Diagnose the install and print remedies |

`--force` regenerates the owner/client identifiers but deliberately preserves
`SN_PROFILE_ENCRYPTION_KEY`, which decrypts every credential envelope in
`config.json`. Add `--help` to any command for its full options.

> **The server runs as you, and the client list is the boundary.** Nothing
> listens on a port, so nothing off this machine can reach it and no web page
> can drive it. What that leaves is the registration: every MCP client
> registered here can spawn the server and use whatever ServiceNow access your
> profiles grant, as your integration account. Keep the grants narrow, and
> remove a client you no longer use with `claude mcp remove servicenow-mcp` or
> `codex mcp remove servicenow-mcp`. No ServiceNow credential is copied into a
> client's configuration file — the spawned server reads the profile and its
> encryption key from the owner-only `~/.servicenow-mcp` directory.

### Connecting a client

`servicenow-mcp-setup` registers Codex and Claude Code automatically when their
CLI is on `PATH`. For everything else:

```bash
servicenow-mcp-setup client --client claude-desktop
servicenow-mcp-setup client --client all
```

Every supported client speaks stdio natively, so each one is configured the
same way: a command to spawn.

```bash
claude mcp add servicenow-mcp -- servicenow-mcp
codex mcp add servicenow-mcp -- servicenow-mcp
```

stdio is the default transport for both CLIs, so there is no transport flag to
pass. For clients configured by file:

```json
{
  "mcpServers": {
    "servicenow-mcp": { "command": "servicenow-mcp", "args": [] }
  }
}
```

| Client | Configured by | Config location |
|--------|---------------|-----------------|
| Claude Code | `claude mcp add` or `.mcp.json` | project or `--scope user` |
| Codex | `codex mcp add` or `config.toml` | `~/.codex/config.toml` |
| Cursor | file | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| VS Code | file (`"type": "stdio"`) | `.vscode/mcp.json` or user `mcp.json` |
| Claude Desktop | file | `claude_desktop_config.json` |
| Windsurf | file | `~/.codeium/windsurf/mcp_config.json` |

No client holds a ServiceNow credential. The spawned server resolves its own
from `~/.servicenow-mcp`, which is owner-only.

Full per-client blocks are in
[V2 service and client setup](docs/CLIENT-SETUP.md#7-mcp-client-configuration).

> **`servicenow-mcp` must be on the spawning client's `PATH`.** A global npm
> install puts it there. If it is not — a project-local install, or a GUI
> client with a different `PATH` — register the absolute entrypoint instead;
> `servicenow-mcp-setup doctor` checks this and prints the exact command.

### Guided profile creation from your client

After the bootstrap, a connected MCP client can walk you through profile
creation:

```text
Add a ServiceNow MCP profile for https://yourinstance.service-now.com
```

The MCP prompt is `servicenow-mcp.add-profile`. It guides profile naming, auth
mode, and least-privilege default-deny access, and deliberately does **not**
ask you to paste passwords, API keys, bearer tokens, OAuth client secrets, or
encryption keys into chat.

### What gets installed

- `servicenow-mcp` — the MCP server itself, spawned by a client over stdio
- `servicenow-mcp-profile` — manages profile credentials out of band
- `servicenow-mcp-setup` — bootstrap, client config, grants, and diagnosis

### Manual configuration without the bootstrap

The server keeps configuration explicit. A manual run needs:

- audit identity: `MCP_OWNER_ID` and `MCP_CLIENT_ID` (optional; they label
  audit records and default to `local-owner`/`local-client`)
- one named ServiceNow profile, either in `~/.servicenow-mcp/config.json` or
  through `SN_PROFILE_NAME` + `SN_INSTANCE` + auth-specific `SN_*` variables
- per-profile table access rules; unconfigured access denies everything

The `SN_*` environment path builds a profile **only when
`~/.servicenow-mcp/config.json` does not exist**. Once you create a profile
file, `SN_ALLOWED_READ_TABLES`, `SN_ALLOWED_WRITE_TABLES`, and
`SN_TABLE_ACCESS_TARGETS` stop applying and the rules must live on the profile
(`servicenow-mcp-setup grant`). This is the most common cause of a server that
denies every call; `servicenow-mcp-setup doctor` detects it.

The server reads `~/.servicenow-mcp/server.env` itself at startup, because the
client that spawns it supplies its own environment and will not have sourced
anything. A value already present in the environment always wins over that
file, so container and CI configuration is unaffected.

For a quick environment-only run with no profile file — driving the server by
hand over a pipe, or from a client that passes environment variables — inject
protected values from your keychain or secret manager and pass only non-secret
values on the command line:

```bash
MCP_OWNER_ID=local-owner \
MCP_CLIENT_ID=local-client \
SN_PROFILE_NAME=dev \
SN_INSTANCE=https://yourinstance.service-now.com \
SN_USER=your_user \
SN_ALLOWED_READ_TABLES=incident,problem,change_request \
SN_ALLOWED_WRITE_TABLES=incident,change_request \
SN_TABLE_ACCESS_TARGETS='[{"table":"incident","kind":"canonical","tools":["sn_query","sn_get","sn_create","sn_update","sn_incident_add_comment","sn_incident_add_work_note","sn_delete","sn_batch"],"closureComplete":true,"relatedTables":["incident"]},{"table":"problem","kind":"canonical","tools":["sn_query","sn_get"],"closureComplete":true,"relatedTables":["problem"]},{"table":"change_request","kind":"canonical","tools":["sn_query","sn_get"],"closureComplete":true,"relatedTables":["change_request"]}]' \
servicenow-mcp
```

Do not put `SN_PASSWORD`, OAuth client secrets, or API keys in command history.
Inject them into the server's environment from your approved secret mechanism,
or leave them in the owner-only profile file where the server can resolve them
without any client seeing them.

### Source install for development

Use source install only for development or unreleased changes:

```bash
git clone https://github.com/onlyflowstech/servicenow-mcp.git
cd servicenow-mcp
npm install
npm run build
npm start
```

For local development with a rebuild and source maps:

```bash
npm run dev
```

Container deployment applies to the dormant HTTP transport rather than a 2.0 stdio install; see [Production container deployment](docs/CONTAINER-DEPLOYMENT.md) and the [enterprise boundary](docs/ENTERPRISE-RELEASE-BOUNDARY.md#the-dormant-http-transport).

---

## Multi-Instance Profiles

Manage multiple ServiceNow instances (dev, test, prod, PDI) with named profiles. Every tool call must select one configured profile explicitly; V2 has no active-profile or default-profile fallback.

### Setup

Create profiles with the CLI rather than by hand — it captures credentials
without putting them in argv, and it writes the file with the right ownership
and mode:

```bash
servicenow-mcp-profile create --name dev  --instance https://mydev.service-now.com  --auth-type basic --username admin    --source reference --provider env
servicenow-mcp-profile create --name prod --instance https://myprod.service-now.com --auth-type basic --username api.user --source reference --provider env

servicenow-mcp-setup grant --profile dev  --read incident,problem --write incident
servicenow-mcp-setup grant --profile prod --read incident
```

The resulting `~/.servicenow-mcp/config.json` looks like this. Note
`tableAccess`: **a profile without it denies every tool call.**

```json
{
  "version": 2,
  "profiles": {
    "dev": {
      "instance": "https://mydev.service-now.com",
      "username": "admin",
      "credential": { "type": "secret_ref", "provider": "env", "reference": "SN_PASSWORD_DEV" },
      "description": "Development instance",
      "tableAccess": {
        "readTables": ["incident", "problem"],
        "writeTables": ["incident"],
        "targets": [
          {
            "table": "incident",
            "kind": "canonical",
            "tools": ["sn_query", "sn_get", "sn_aggregate", "sn_schema", "sn_create", "sn_update"],
            "closureComplete": true,
            "relatedTables": ["incident"]
          },
          {
            "table": "problem",
            "kind": "canonical",
            "tools": ["sn_query", "sn_get", "sn_aggregate", "sn_schema"],
            "closureComplete": true,
            "relatedTables": ["problem"]
          }
        ]
      }
    }
  }
}
```

Have the approved supervisor, orchestrator, keychain, or secret manager provide
the values referenced by `SN_PASSWORD_DEV` and `SN_PASSWORD_PROD` in the
environment the server is spawned with, or in `~/.servicenow-mcp/server.env`,
which the server falls back to. Do not type either value into a shell command,
command argument, dotenv file, or command history.

Each `targets` entry asserts `closureComplete: true`, meaning `relatedTables`
lists every backing, ancestor, and descendant table the operation can reach.
When a table extends another, declare it:
`servicenow-mcp-setup grant --profile dev --read change_request --related change_request=task`.
Related tables join the allowlist but get no target of their own, so a caller
cannot address them directly.

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

Three ServiceNow auth types are available per profile, selected with `authType` (default: `basic`). Profile configuration is managed out of band by the service operator. This is the only authentication involved: the transport is stdio, so there is no endpoint in front of the server to protect.

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

ServiceNow upstream can return HTTP 429 with an empty body, while this server's own HTTP rate-limit rejections return a short JSON body plus `Retry-After`. Treat the status and `Retry-After` header as authoritative; do not benchmark or validate tool success from response latency or body shape alone. In normal ServiceNow instances, plan around the Background throttling default of roughly 120 requests per 60 seconds per identity unless the instance limit is explicitly raised.

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
| Attachment management | ❌ | ✅ (list, upload, download; inline base64, no host filesystem) |
| System log queries | ❌ | ✅ |
| Code search across artifacts | ❌ | ✅ |
| Table/app/plugin discovery | ❌ | ✅ |
| ATF test execution | ❌ | 🚧 listing/results available; execution currently policy-denied |
| Natural language interface | ❌ | 🚧 currently policy-denied pending a typed access plan |
| Background scripts | ❌ | 🚧 on the [roadmap](#roadmap) (SNS-39) |
| Multi-instance profiles | ❌ | ✅ (named profiles, per-call override) |
| **Total tools** | **1–3** | **19** |

---

## Quick Start

The server speaks stdio and requires Node.js 20 or newer. The shortest path is
the bootstrap described under [Installation](#installation):

```bash
servicenow-mcp-setup
```

That registers your clients; each one spawns the server when it needs it.

The rest of this section is the manual environment path, for a deployment that
injects everything from a supervisor or secret manager, or for driving the
server by hand over a pipe.

Use [`.env.example`](.env.example) only as a non-secret configuration
inventory. Its protected-value assignments are intentionally empty; inject
ServiceNow secrets through a supervisor, orchestrator, keychain, or secret
manager rather than filling a repository dotenv file.

> The `SN_ALLOWED_*` and `SN_PROFILE_NAME` variables below build a profile only
> when `~/.servicenow-mcp/config.json` does **not** exist. With a profile file
> present, put the rules on the profile with `servicenow-mcp-setup grant`.

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
mechanism must already have injected the authentication-specific ServiceNow
secret into the process. Do not enter it in this shell block.

A client connects by spawning the command; there is no URL and no header:

```json
{
  "mcpServers": {
    "servicenow-mcp": { "command": "servicenow-mcp", "args": [] }
  }
}
```

JSON-RPC messages travel on the child's stdin and stdout, one newline-delimited
message per frame. Everything else the server reports — startup warnings, and
one structured JSON-line event per completed tool call — goes to **stderr**,
which your client captures as its server log. There is no per-message size
limit imposed by the transport.

For complete official SDK and independent client examples, safe two-profile
setup, and crossed profile/result/audit checks, see
[V2 service and client setup](docs/CLIENT-SETUP.md).

### Breaking changes in 2.0

Every tool call must name a `profile`, and table access is deny-by-default.
Those two require action on every install. The transport is stdio, as it was in
`1.0.0`, so a client configured with a `command` entry keeps working.

The breaking changes from `1.0.0`, each with a before/after example, are in
[Migrating to 2.0](docs/V2-MIGRATION.md#breaking-changes-at-a-glance).

### Deployment guides for the dormant HTTP transport

2.0 ships stdio only. The container image, the health and shutdown contract,
the operations runbook, and the Secure MCP Tunnel adapter all describe the
[dormant HTTP transport](docs/ENTERPRISE-RELEASE-BOUNDARY.md#the-dormant-http-transport),
which no CLI path reaches. They are kept because that transport is a planned
enterprise deployment shape, not because they apply to a 2.0 install — nothing
in this section is needed to use this server.

- [Production container deployment](docs/CONTAINER-DEPLOYMENT.md) — OCI
  artifact, non-root runtime, provenance and scanning
- [Remote operations runbook](docs/OPERATIONS-RUNBOOK.md) — health
  interpretation, telemetry, alerts, rotation, incident response
- [Private ChatGPT connectivity](docs/PRIVATE-CHATGPT-CONNECTIVITY.md) —
  outbound-only Secure MCP Tunnel adapter

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
| `sn_attach` | List attachments, return downloads as inline base64, and upload inline base64 content; never touches a host filesystem path |
| `sn_syslog` | Query system logs with severity/source/time filters |
| `sn_codesearch` | Search business rules, script includes, client scripts, etc. |
| `sn_discover` | Discover tables, scoped apps, store apps, plugins |

### Testing & Automation

| Tool | Description |
|------|-------------|
| `sn_atf` | List ATF tests/suites and get results; `run`/`run-suite` currently fail closed |
| `sn_nl` | Currently fails closed until natural-language composition emits a complete typed access plan |

`sn_script` (background script execution) shipped in 1.0.0 as an unimplemented
stub and is **not published in 2.0** — it does not appear in `tools/list`. Use
`sn_query` and `sn_batch` instead. See [Roadmap](#roadmap).

### Profile Management

| Tool | Description |
|------|-------------|
| `sn_profile` | Inspect non-secret metadata for one explicitly named profile; profile configuration is operator-managed out of band |

---

## Environment Variables

### MCP runtime

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MCP_OWNER_ID` | ❌ | `local-owner` | Stable non-secret owner identifier recorded in request/tool context and every audit record. A label, not a credential; it is never checked. |
| `MCP_CLIENT_ID` | ❌ | `local-client` | Stable non-secret client identifier recorded in request/tool context and every audit record. A label, not a credential; it is never checked. |

That is the whole list. There is no bind address, port, `Host`/`Origin`
allowlist, concurrency cap, connection cap, shutdown grace period, bearer
token, or rate limit, because there is no listener: a client spawns the server
and owns its lifetime.

The server reads these from its environment and falls back to
`~/.servicenow-mcp/server.env` for any it does not find there. That file is
owner-only (mode `0600`) and is where `servicenow-mcp-setup` writes the
generated identifiers and `SN_PROFILE_ENCRYPTION_KEY`. It exists because the
client that spawns the server supplies its own environment and will not have
sourced anything. A value already present in the environment always wins, so a
container or CI runner that passes configuration directly is unaffected.
`servicenow-mcp-setup doctor` reports that file's mode and contents.

### Observability

Each completed tool call emits one JSON-line event to **stderr**, which the
spawning client captures as its server log:

```json
{"schemaVersion":1,"type":"mcp_tool","observedAtMs":1737000000000,"latencyMs":42,
 "correlationId":"stdio-<session>-<invocation>","ownerIdHash":"sha256:...",
 "clientIdHash":"sha256:...","tool":"sn_query","profile":"dev",
 "instance":"https://dev00001.service-now.com","outcome":"success","reason":null,
 "errorCategory":null,"retry":null,"retryAfterSeconds":null}
```

Tool audits classify request cancellation and request-deadline expiration
separately from handler failures. Configured owner/client identifiers are
represented only by SHA-256 pseudonyms; headers, URLs/query strings, bodies,
credentials, tokens, config objects, and exception text are not event fields.
Telemetry never blocks a tool result: stderr backpressure retains at most 256
pending lines, drops excess events, and emits a
`{"type":"telemetry_dropped","count":N}` summary after the stream drains.

A correlation ID is `stdio-<session>-<invocation>`. The session half is fixed
for the life of one spawned server, so every record from one client session
groups together; the invocation half is fresh per call. Neither half is derived
from anything the caller sent.

**stdout carries the protocol and nothing else.** Every diagnostic goes to
stderr. One stray byte on stdout would desynchronize the client's JSON-RPC
parser and end the session, so there is no such thing as a harmless
`console.log` on the startup or request path; `test/stdio-entrypoint.test.ts`
spawns a real server and asserts it.

Arguments that fail a tool's schema are rejected by the MCP SDK before any
handler runs, so they return an error to the caller but produce **no audit
event** — the execution context that would issue one is never opened. Every
call that reaches a tool is audited.

### Body size and concurrency (dormant HTTP runtime only)

None of this applies to the shipped server. It describes the dormant HTTP
runtime, which no CLI path reaches — see
[the enterprise release boundary](docs/ENTERPRISE-RELEASE-BOUNDARY.md#the-dormant-http-transport)
— and binds only someone embedding this package and calling `createHttpRuntime`
directly. Over stdio there is no request-body limit and no admission ceiling.

Request body size and concurrency trade directly against each other under the
512 MiB admission ceiling:

| `maxBodyBytes` | Highest concurrency that starts | Effect |
|---|---|---|
| 1 MiB (shipped default) | 2 | 416 MiB budgeted; the intended configuration |
| 1.75 MiB | 2 | 512 MiB — exactly at the ceiling |
| **2 MiB** | **1** | **Single-flight: every tool call serializes** |
| 5.75 MiB | 1 | the last value that starts at all |
| above 5.75 MiB | none | startup fails at any concurrency |

Two failure modes are worth knowing:

- **At 2 MiB and above the server is single-flight.** Concurrency 2 no longer
  fits, so the runtime can only start at 1 and every tool call queues behind
  every other one. There is no warning and no log line — it presents as "the
  server got slow", and one large upload blocks every other tool for its
  duration. Nothing connects the cause to the effect.
- **Above 5.75 MiB the server refuses to start.** A constructor `throw`, not a
  clamp. The message names `maxConcurrentRequests` and `maxBodyBytes` but gives
  neither the ceiling, the arithmetic, nor a working value; the table above is
  the way forward.

**`maxBodyBytes` is not operator-configurable.** `src/http-entrypoint.ts`
builds the request policy with only `allowedHosts` and `allowedOrigins`, so the
limit is always 1 MiB and no environment variable changes it.

### Metadata cache

Stable ServiceNow metadata reads are cached per instance and credential identity
for 24 hours by default. The default cached table patterns are
`sys_glide_object`, `sys_dictionary`, `sys_db_object`, `sys_app`, `sys_plugins`,
`sys_metadata*`, and `sys_flow*`. Set `metadataCache.ttlMs` and
`metadataCache.tables` on a file-backed profile, or `SN_METADATA_CACHE_TTL_MS`
/ `SN_METADATA_CACHE_TABLES` for the explicit environment profile. `sn_query`,
`sn_get`, and `sn_schema` accept `force_recache: true` to refresh metadata. A
cache hit performs a lightweight `sys_updated_on` probe and is used only when no
matching metadata rows changed since the previous sync.

**Prerequisite: a resolvable session timezone.** The freshness probe compares
`sys_updated_on`, which ServiceNow evaluates in the *session user's* timezone,
not UTC. Resolving that zone requires the authenticating account's `user_name`
to look up `sys_user.time_zone`, falling back to the `glide.sys.default.tz`
property. When it cannot be resolved the cache **disables itself** for that
identity rather than assuming UTC — a wrong assumption would silently serve
stale metadata for the length of the offset. The server logs a warning naming
the reads it needs.

This has one consequence worth knowing before you configure it:

| Profile auth | Metadata caching |
|---|---|
| Basic | works — the profile carries a username |
| OAuth **password** grant | works — the profile carries a username |
| OAuth **client_credentials** | **disabled** — no username to resolve a timezone from |
| API key | **disabled** — no username to resolve a timezone from |

The profile also needs read access to `sys_user` (for `time_zone`) and
`sys_properties` (for `glide.sys.default.tz`) for the lookup to succeed at all.

**The honest tradeoff:** the cache only ever saved payload bytes, never round
trips — a cache hit still costs one freshness probe. So on a client-credentials
or API-key profile the practical loss is bandwidth on `sys_dictionary` reads,
not latency. If you are choosing an auth mode, this should not be the deciding
factor.

**Deletions become visible within one TTL.** The freshness probe detects
updates, not deletes, so a row deleted upstream stays served until its entry
expires and is re-fetched — up to 24 hours at the default TTL. This is accepted
behavior, not a defect; lower `SN_METADATA_CACHE_TTL_MS` or pass
`force_recache: true` if you need a deletion reflected sooner.

### Unrestricted field selection (`fields=all`, `response_format=detailed`)

Both resolve to a wildcard selection. They previously dropped `sysparm_fields`
entirely, so ServiceNow returned every column and a wide table could breach the
1 MiB cumulative upstream cap and **fail the call outright**. They are now
bounded to at most **100 columns**.

The cap bounds the *upstream request*, not the response — truncating after
receipt would not help, because the bytes have already crossed the wire and
already breached the limit. Columns are resolved from `sys_dictionary`, walking
`super_class` so an extended table contributes its inherited fields. Ordering is
deterministic: the table's curated default projection first in its declared
order, then every remaining column alphabetically. Defaults lead so a capped
result stays useful; alphabetical afterwards because dictionary row order is not
stable across instances. Every failure path falls back to the table's bounded
default projection, never to dropping `sysparm_fields`.

`sn_query` reports truncation through its `hint` field. `sn_get` will carry the
same notice shortly.

Two behavior changes worth stating plainly, because they change what a caller
gets back:

- **Journal fields are now returned.** `comments` and `work_notes` are included
  in the resolved set for `fields=all` and `detailed`. See
  [Journal content and field selection](#journal-content-and-field-selection).
- **Sensitive-looking field names are excluded from the resolved set entirely.**
  A name matching the sensitive-field pattern is never *requested*, rather than
  being requested and scrubbed on arrival. Under the old wildcard behavior the
  value crossed the wire and was then removed; naming it in `sysparm_fields`
  would have pulled it over deliberately, which is worse.

### Journal content and field selection

Journal content on `incident` — `comments` (customer-visible) and `work_notes`
(internal) — is readable through `fields=all`, `response_format: "detailed"`, an
explicit `fields=comments`, and `sn_schema`. **The default projection still
excludes it**, so an ordinary `sn_query` or `sn_get` does not return it.

Stated as a fact rather than a warning: journal content on real instances
routinely contains customer PII, so asking for all fields on `incident` returns
customer-visible commentary along with everything else. Operators granting
`incident` reads to an agent should know that. If that is not wanted, grant a
narrower read via the field policy rather than relying on the default
projection, since the caller chooses `fields`.

### Attachment payloads

`sn_attach` never reads from or writes to host filesystem paths. Uploads use a
safe leaf `file_name` plus `content_base64`; downloads return
`content_base64`, `file_name`, `content_type`, and `size_bytes`. Download also
requires the owning `table` and record `sys_id`, which are policy-authorized
and verified against attachment metadata before any bytes are returned.

**Size limit: 10 MiB decoded, and that is the only one.** The stdio transport
frames messages by newline with no size bound, so the tool's own limits are
what apply — 10 MiB of decoded bytes for an upload, and a separate 10 MiB raw
budget for a download. The tool's `content_base64` schema description carries
the authoritative figure.

The ~760 KiB practical ceiling documented before 2.1 came from the HTTP body
limit, which no longer applies: the client and server share a pipe, not an
envelope. Base64 still inflates a file by about a third in the message itself,
so a 10 MiB attachment is roughly a 13.3 MiB JSON frame — large, but the
transport will carry it.

Treat `sn_attach` as suitable for logs, configs, screenshots, and documents
rather than bulk transfer; a very large frame still costs memory in both the
client and the server, and ServiceNow's own UI or a dedicated integration is a
better path for bulk file movement.

### Table access policy

2.0 denies every ServiceNow table by default. Table access is selected per
profile, not from a process-wide implicit default. File-backed profiles define
`tableAccess` in `~/.servicenow-mcp/config.json`; the explicit `SN_PROFILE_NAME`
environment profile maps the `SN_ALLOWED_*` variables into that one profile only
when no profile file exists. If a profile has no table rules, it denies all.

Write the rules with the CLI rather than by hand — it validates the result with
the same loader the server uses at request time:

```bash
servicenow-mcp-setup grant --profile dev --read incident,problem --write incident
servicenow-mcp-setup grant --profile dev --read cmdb_ci --tools sn_query,sn_relationships
servicenow-mcp-setup grant --profile dev --read change_request --related change_request=task
```

Allowlist entries may be exact table names or the literal `*` to allow every
table for that operation. Table names are trimmed, lowercased, deduplicated,
and must be valid ServiceNow identifiers.

> **`tableAccess` is the sole table-level authority.** There is no longer a
> built-in list of tables the server refuses unconditionally. A profile that
> grants a table gets it, subject only to ServiceNow's own per-user ACLs — so a
> grant of `sys_script`, `sys_user_role`, or a credential table is honored.
> Writing `sys_script` is server-side script execution under the integration
> account. Least privilege now lives entirely in the grant and in the roles you
> give that account; grant the narrowest set that does the job, and prefer an
> account whose ServiceNow roles cannot reach what the grant does not need.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SN_ALLOWED_READ_TABLES` | ❌ | deny all | Tables permitted for read operations on the explicit `SN_PROFILE_NAME` environment profile only. Use `*` to allow every readable table. |
| `SN_ALLOWED_WRITE_TABLES` | ❌ | deny all | Tables permitted for create, update, incident journal append, delete, upload, and confirmed batch operations on the explicit `SN_PROFILE_NAME` environment profile only. Use `*` to allow every writable table. Write permission never implies read permission. |
| `SN_TABLE_ACCESS_TARGETS` | Required for exact allowlisted caller-addressable tables; optional with `*` | `[]` | Trusted JSON classification with `table`, exact permitted `tools`, `kind` (`canonical`, `alias`, `view`, or `extension`), literal `closureComplete: true`, and the complete backing/ancestor/descendant `relatedTables` closure. With `*`, omitted target entries use the wildcard operation grant; explicit target entries can still narrow tools and validate related-table closure. |
| `SN_FIELD_POLICY_DEFINITIONS` | Required for custom/generic table fields | built-in finite policy | Trusted JSON object keyed by table name or `*`. Each entry may define `defaults`, `readable`, and `writable`; `readable`/`writable` accept exact field arrays or `"*"`. Sensitive field names are still denied. Use `{"*":{"defaults":["sys_id"],"readable":"*","writable":[]}}` for broad read-only custom-table exploration. Use `writable:"*"` only for intentional broad mutation access. |
| `SN_ENCODED_QUERY_READ_POLICY` | ❌ | deny all | Trusted JSON object containing bounded `rules` for an exact `sn_query`/table pair. Each rule requires `maxLength`, `maxTerms`, readable `fields`, supported `operators`, `maxLimit`, `maxOffset`, and `maxResponseBytes`. No rule can authorize a write or another tool. |

Invalid policy configuration fails startup. A composed tool is admitted only
when its complete backing-table plan is allowed before the first ServiceNow
client access. Every related target must have the same read or write
permission, so a base table, alias, view, or extension cannot bypass an
unlisted backing or descendant table.
Related permission does not make a dependency directly caller-addressable
without its own target entry. Field policy narrows what a granted table exposes; it does not deny a table the
operator granted. Sensitive-looking field names remain excluded regardless. Build the
complete target catalog from approved ServiceNow metadata and treat it as
trusted startup configuration; omit a target when reachability cannot be proven
complete. File-backed profile example:

```json
{
  "version": 2,
  "profiles": {
    "dev": {
      "instance": "https://dev.service-now.com",
      "username": "integration.user",
      "credential": "env:SN_PASSWORD",
      "tableAccess": {
        "readTables": ["incident", "sys_dictionary"],
        "writeTables": ["incident"],
        "targets": [
          {
            "table": "incident",
            "kind": "canonical",
            "tools": ["sn_query", "sn_get", "sn_create", "sn_update"],
            "closureComplete": true,
            "relatedTables": ["incident"]
          }
        ]
      }
    }
  }
}
```
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

Have the approved local supervisor or keychain inject the selected ServiceNow
authentication secret before starting the process. The commands below contain
non-secret configuration only; never prepend or append protected values on the
command line.

```bash
# Clone
git clone https://github.com/onlyflowstech/servicenow-mcp.git
cd servicenow-mcp

# Install & build
npm install
npm run build

# Run the server directly, speaking stdio on this terminal's pipes
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
the server itself remains supported on Node.js 20. Set the non-secret
`MCP_PROFILE`, install from `tools/inspector/package-lock.json`, and run the
local-only launcher:

```bash
MCP_PROFILE=dev npm run inspector
```

(Run `npm ci --prefix tools/inspector --engine-strict --ignore-scripts` first.)

The launcher prints the exact **STDIO** command and arguments to enter in the
Inspector UI. There is no endpoint and no bearer to type. Include the explicit
profile in every call. The Inspector spawns the server itself and inherits a
scrubbed environment with every `MCP_*` and `SN_*` value removed; the server
still resolves its credential, because it reads the owner-only
`~/.servicenow-mcp/server.env` at startup rather than relying on what it was
handed. The launcher does not expose Inspector beyond loopback or create a
tunnel.

`npm run smoke` is the second client. It spawns `dist/index.js` the same way and
needs only `MCP_PROFILE`:

```bash
MCP_PROFILE=dev npm run smoke
```

See [`docs/RELEASE-VALIDATION.md`](docs/RELEASE-VALIDATION.md) for the release
gates, write confirmation, evidence, and rollback procedure.

---

## Roadmap

- [x] **stdio transport** — the client spawns the server; a Streamable HTTP runtime exists but is [dormant](docs/ENTERPRISE-RELEASE-BOUNDARY.md#the-dormant-http-transport)
- [x] **OAuth 2.0** authentication support (client_credentials + password grants, API keys)
- [ ] **sn_script** background-script execution (SNS-39) — future state, deliberately not shipped in 2.0; requires automating the `sys.scripts.do` UI endpoint with session auth
- [ ] **Streaming** for large result sets
- [ ] **Caching** for schema and relationship lookups

---

## License

MIT © [OnlyFlows](https://onlyflows.tech)

---

<p align="center">
  Built with ❤️ by <a href="https://onlyflows.tech">OnlyFlows</a> · <a href="https://github.com/onlyflowstech">@onlyflowstech</a>
</p>
