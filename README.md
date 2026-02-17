# @onlyflows/servicenow-mcp

<!-- Logo placeholder -->
<!-- ![ServiceNow MCP Server](banner.png) -->

**The most comprehensive ServiceNow MCP server.** 17 tools for full CRUD, CMDB graph traversal, background scripts, ATF testing, and more.

Built by [OnlyFlows](https://onlyflows.tech) · Published by [@onlyflowstech](https://github.com/onlyflowstech)

[![npm version](https://img.shields.io/npm/v/@onlyflows/servicenow-mcp)](https://www.npmjs.com/package/@onlyflows/servicenow-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

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
| **Total tools** | **1–3** | **17** |

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

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SN_INSTANCE` | ✅ | — | Instance URL (e.g. `https://yourinstance.service-now.com`) |
| `SN_USER` | ✅ | — | ServiceNow username |
| `SN_PASSWORD` | ✅ | — | ServiceNow password |
| `SN_DISPLAY_VALUE` | ❌ | `true` | Default display value mode (`true`, `false`, `all`) |
| `SN_REL_DEPTH` | ❌ | `3` | Default CMDB relationship traversal depth |

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
- [ ] **OAuth 2.0** authentication support
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
