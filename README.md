# @onlyflows/servicenow-mcp

<!-- Logo placeholder -->
<!-- ![ServiceNow MCP Server](banner.png) -->

**The most comprehensive ServiceNow MCP server.** 18 tools for full CRUD, CMDB graph traversal, background scripts, ATF testing, multi-instance profiles, and more.

Built by [OnlyFlows](https://onlyflows.tech) · Published by [@onlyflowstech](https://github.com/onlyflowstech)

[![npm version](https://img.shields.io/npm/v/@onlyflows/servicenow-mcp)](https://www.npmjs.com/package/@onlyflows/servicenow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Multi-Instance Profiles

Manage multiple ServiceNow instances (dev, test, prod, PDI) with named profiles. Switch between them per-tool-call or for the entire session — no more restarting to change instances.

### Setup

Create `~/.servicenow-mcp/config.json`:

```json
{
  "version": 1,
  "default_profile": "dev",
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

Then pass the credential environment variables in your MCP client config:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "@onlyflows/servicenow-mcp"],
      "env": {
        "SN_PASSWORD_DEV": "your-dev-password",
        "SN_PASSWORD_PROD": "your-prod-password"
      }
    }
  }
}
```

### Credential Options

| Format | Example | Description |
|--------|---------|-------------|
| `env:VAR_NAME` | `"env:SN_PASSWORD_DEV"` | Read from environment variable (recommended) |
| Plain string | `"mypassword"` | Stored directly in config (not recommended, warns on startup) |

The `env:VAR_NAME` indirection works for every secret field: `credential`, `clientSecret`, and `apiKey`.

### Using Profiles

With natural language:
- *"list all profiles"* — shows all configured profiles and which is active
- *"switch to prod"* — changes the active profile for the session
- *"which instance am I connected to?"* — shows active profile details
- *"show me the dev profile info"* — inspect a specific profile's config
- *"add a new profile called staging at https://staging.service-now.com with user admin and credential env:SN_PASSWORD_STAGING"* — add a new profile (persisted to config file)

With the `profile` parameter on any tool:
- *"query incidents on prod"* — uses the prod profile for this call only
- *"get incident INC0010001 on dev"* — uses dev regardless of active profile

### Backward Compatibility

If no config file exists, the server falls back to environment variables (`SN_INSTANCE`, `SN_USER`, `SN_PASSWORD`) exactly as before. No changes needed for existing setups.

---

## Authentication

Three auth types per profile, selected with `authType` (default: `basic`). Existing basic-auth configs keep working unchanged.

> **Heads up:** ServiceNow's [inbound Basic Auth restriction program](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB3096078) is phasing out basic auth for API requests — instances can start hard-rejecting it at any time (exemptions: Web-Service-Access-Only accounts or the `snc_basic_auth_api_access` role). **OAuth is the recommended auth type.** The server prints a startup warning for basic-auth profiles.

### OAuth 2.0 (recommended)

`client_credentials` grant (default) — create an OAuth API endpoint client in ServiceNow (**System OAuth → Application Registry**) and reference the secret via `env:` indirection:

```json
{
  "version": 1,
  "default_profile": "dev",
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

Most ServiceNow MCP integrations are **read-only** and support a handful of tables. This one gives your AI assistant **full access** to the ServiceNow platform:

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
| ATF test execution | ❌ | ✅ |
| Natural language interface | ❌ | ✅ |
| Background scripts | ❌ | ✅ (with Playwright) |
| Multi-instance profiles | ❌ | ✅ (named profiles, per-call override) |
| **Total tools** | **1–3** | **18** |

---

## Quick Start

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "@onlyflows/servicenow-mcp"],
      "env": {
        "SN_INSTANCE": "https://yourinstance.service-now.com",
        "SN_USER": "your_username",
        "SN_PASSWORD": "your_password"
      }
    }
  }
}
```

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "@onlyflows/servicenow-mcp"],
      "env": {
        "SN_INSTANCE": "https://yourinstance.service-now.com",
        "SN_USER": "your_username",
        "SN_PASSWORD": "your_password"
      }
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "@onlyflows/servicenow-mcp"],
      "env": {
        "SN_INSTANCE": "https://yourinstance.service-now.com",
        "SN_USER": "your_username",
        "SN_PASSWORD": "your_password"
      }
    }
  }
}
```

### VS Code (Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "servicenow": {
      "command": "npx",
      "args": ["-y", "@onlyflows/servicenow-mcp"],
      "env": {
        "SN_INSTANCE": "https://yourinstance.service-now.com",
        "SN_USER": "your_username",
        "SN_PASSWORD": "your_password"
      }
    }
  }
}
```

---

## Tools Reference

### Core CRUD

| Tool | Description |
|------|-------------|
| `sn_query` | Query any table with encoded queries, field selection, pagination, sorting |
| `sn_get` | Get a single record by sys_id |
| `sn_create` | Create a new record on any table |
| `sn_update` | Update an existing record (PATCH) |
| `sn_delete` | Delete a record (requires `confirm: true`) |
| `sn_batch` | Bulk update/delete with dry-run safety (requires `confirm: true` to execute) |

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
| `sn_attach` | List, download, upload attachments |
| `sn_syslog` | Query system logs with severity/source/time filters |
| `sn_codesearch` | Search business rules, script includes, client scripts, etc. |
| `sn_discover` | Discover tables, scoped apps, store apps, plugins |

### Testing & Automation

| Tool | Description |
|------|-------------|
| `sn_atf` | Run ATF tests and suites, get results |
| `sn_nl` | Natural language → ServiceNow API calls |
| `sn_script` | Execute background scripts (requires Playwright) |

### Profile Management

| Tool | Description |
|------|-------------|
| `sn_profile` | List, switch, inspect, and add instance profiles |

---

## Environment Variables

> **Note:** If using [multi-instance profiles](#multi-instance-profiles), these env vars are only needed as a fallback when no config file exists.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
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

*Not required when using `~/.servicenow-mcp/config.json` profiles, or when `SN_AUTH_TYPE` is `oauth` (client_credentials) / `apikey`.

---

## Usage Examples

Once connected, your AI assistant can:

**Query incidents:**
> "Show me all P1 incidents assigned to the Network team"

**Create a record:**
> "Create an incident for VPN outage affecting 50 users, P2, assign to Network Operations"

**Aggregate data:**
> "How many incidents are there grouped by priority?"

**Check health:**
> "Run a health check on our ServiceNow instance"

**CMDB traversal:**
> "Show all upstream dependencies for the email-server-01 CI"

**Schema introspection:**
> "What fields are on the change_request table?"

**Code search:**
> "Find all business rules that reference GlideRecord('incident')"

**ATF testing:**
> "Run ATF test suite abc123 and wait for results"

**Profile management:**
> "Switch to the prod profile"
> "Query incidents on dev" (per-call profile override)

---

## Safety Features

This server is designed for production use with multiple safety layers:

- **Delete operations** require explicit `confirm: true`
- **Batch operations** run in dry-run mode by default — shows match count without making changes
- **Bulk deletes** require both `confirm` and `force` flags
- **Background scripts** require `confirm` for destructive keywords (`deleteRecord`, `deleteMultiple`, etc.)
- **Natural language writes** require `execute: true` (reads execute immediately)

---

## Development

```bash
# Clone
git clone https://github.com/onlyflowstech/servicenow-mcp.git
cd servicenow-mcp

# Install & build
npm install
npm run build

# Run locally
SN_INSTANCE=https://yourinstance.service-now.com \
SN_USER=your_user \
SN_PASSWORD=your_pass \
node dist/index.js

# Watch mode
npm run dev
```

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## Roadmap

- [ ] **SSE transport** for remote hosting
- [x] **OAuth 2.0** authentication support (client_credentials + password grants, API keys)
- [ ] **sn_script** full implementation with Playwright (SNS-39)
- [ ] **Streaming** for large result sets
- [ ] **Caching** for schema and relationship lookups

---

## License

MIT © [OnlyFlows](https://onlyflows.tech)

---

<p align="center">
  Built with ❤️ by <a href="https://onlyflows.tech">OnlyFlows</a> · <a href="https://github.com/onlyflowstech">@onlyflowstech</a>
</p>
