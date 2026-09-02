# Live test plan — ServiceNow OAuth through V2 HTTP

This is an opt-in plan for a PDI or sub-production ServiceNow instance. The
normal unit and HTTP contract suites use deterministic fakes and do not need
ServiceNow credentials or network access.

## 1. Configure ServiceNow OAuth

1. Enable `glide.oauth.inbound.client.credential.grant_type.enabled` on the
   test instance if client-credentials is required.
2. Create a dedicated web-service account with the minimum roles needed for
   the checks. Do not use a personal administrator identity.
3. Create an OAuth API endpoint application in **System OAuth → Application
   Registry**, bind its OAuth Application User to that service account, and
   copy the client ID and secret into a secret store.
4. Confirm the instance token endpoint independently before debugging this
   service. Never paste tokens or secrets into test output or issue comments.

## 2. Start the authenticated V2 service

Use an out-of-band named profile, or explicitly map canonical `SN_*` variables
to an environment profile:

```bash
export MCP_OWNER_ID="oauth-test-owner"
export MCP_CLIENT_ID="oauth-test-client"
export SN_PROFILE_NAME="oauth-test"
export SN_INSTANCE="https://devXXXXXX.service-now.com"
export SN_AUTH_TYPE="oauth"
export SN_CLIENT_ID="service-now-oauth-client-id"
npm ci
npm run build
npm test
npm start
```

The approved test supervisor, keychain, or secret manager must inject
`MCP_BEARER_TOKEN` and `SN_CLIENT_SECRET` directly into the service process
before those non-secret commands run. Never type either value into shell input,
an argument, a dotenv file, or command history.

Startup must fail when the MCP bearer secret, owner ID, or client ID is absent
or invalid. The service listens at `http://127.0.0.1:3000/mcp` unless
`MCP_HOST` or `MCP_PORT` is explicitly set.

## 3. Run the HTTP smoke client

In a second terminal whose process environment already receives the same
bearer from the approved injection mechanism, select the non-secret profile
and endpoint explicitly:

```bash
export MCP_PROFILE="oauth-test"
export MCP_URL="http://127.0.0.1:3000/mcp"
npm run smoke
```

The smoke client uses the official MCP Streamable HTTP client and verifies:

- initialization and discovery over `/mcp`;
- exactly 19 tools;
- every discovered schema requires a non-empty `profile`;
- `sn_profile` returns `structuredContent.profile` without credentials;
- a version health check and a bounded incident query return that same resolved
  profile through OAuth; and
- each MCP operation is cancellation-aware and bounded to 30 seconds by default
  (`MCP_SMOKE_TIMEOUT_MS` accepts 1000 through 120000).

To opt into a create / incident work-note append / delete round trip on a
disposable PDI only:

```bash
npm run smoke -- --write --confirm-write-profile=oauth-test
```

The confirmation must exactly equal `MCP_PROFILE`. Never use `--write` against
production or a shared instance. The smoke client reads the created identifier
from `structuredContent.data.sys_id` and attempts deletion in `finally`; a
cleanup failure is a failed run and requires authorized manual cleanup.

## 4. OAuth lifecycle checks

- After several read calls, the ServiceNow OAuth token table should show one
  cached access token rather than one token per call.
- Revoke the test token, then repeat a read. The client should refresh once and
  retry without exposing the token response.
- Start the service once with an intentionally invalid ServiceNow client secret.
  The tool call must fail with a sanitized error; the secret must not appear in
  the MCP result, service output, or audit record.
- Send an absent or invalid MCP bearer header. The HTTP boundary must return a
  generic 401 before parsing MCP input or touching any profile credential.

## 5. Shutdown check

While one request is in flight, send SIGTERM (and repeat with SIGINT). The
listener must stop accepting new work, accepted work may drain only within
`MCP_SHUTDOWN_GRACE_MS`, and the process must release its owned HTTP/MCP
resources at the deadline.
