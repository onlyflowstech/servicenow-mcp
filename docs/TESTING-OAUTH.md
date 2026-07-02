# Live Test Guide — OAuth Profile Onboarding

Tests the `feature/efficiency-auth-hardening` branch against a real instance with the new
OAuth `client_credentials` auth. Use a **PDI or sub-prod instance**.

## Part A — Instance-side OAuth setup (one-time, ~10 min)

1. **Enable the grant type.** In the filter navigator open `sys_properties.list`, find or create
   `glide.oauth.inbound.client.credential.grant_type.enabled`, set it to `true` (type: true/false).
2. **Create a service account.** New user (e.g. `mcp.service`), *Web service access only* checked,
   with the roles you want the MCP server to have (`admin` is fine on a PDI; least-privilege on
   shared instances). On Zurich+ the user's **Identity Type must be "Human"** — Machine identities
   fail the client_credentials flow with AngularProcessor errors.
3. **Create the OAuth client.** System OAuth → Application Registry → New →
   **"Create an OAuth API endpoint for external clients"**. Name it (e.g. `servicenow-mcp`),
   leave the redirect URL empty, save, then copy the generated **Client ID** and **Client Secret**.
   Set **OAuth Application User** = the service account from step 2 (this is the user the token
   acts as). Default *Access Token Lifespan* is 1800s — fine as-is.
4. **Verify outside the MCP server first:**
   ```bash
   curl -s https://<instance>.service-now.com/oauth_token.do \
     -d grant_type=client_credentials -d client_id=<ID> -d client_secret=<SECRET>
   ```
   Expect JSON with `access_token` and `expires_in`. Fix instance-side issues before continuing —
   the usual culprits are the sys_property (step 1) and the missing OAuth Application User (step 3).

## Part B — Build the branch

```bash
git checkout feature/efficiency-auth-hardening
npm ci && npm run build && npm test    # expect 127/127 passing
```

## Part C — Onboard the OAuth profile

Secrets are **never persisted in plain text** — `clientSecret` in the config file must use
`env:VAR_NAME` indirection, and the referenced variable must be set in the environment that
launches the server (the MCP client's `env` block).

**Option 1 — env-only default profile** (quickest). Claude Code:

```bash
claude mcp add servicenow \
  -e SN_INSTANCE=https://devXXXXXX.service-now.com \
  -e SN_AUTH_TYPE=oauth \
  -e SN_CLIENT_ID=<client_id> \
  -e SN_CLIENT_SECRET=<client_secret> \
  -- node /path/to/servicenow-mcp/dist/index.js
```

**Option 2 — named profile** in `~/.servicenow-mcp/config.json` (chmod 600):

```json
{
  "version": 1,
  "default_profile": "pdi-oauth",
  "profiles": {
    "pdi-oauth": {
      "instance": "https://devXXXXXX.service-now.com",
      "authType": "oauth",
      "clientId": "<client_id>",
      "clientSecret": "env:SN_PDI_CLIENT_SECRET",
      "description": "PDI via OAuth client_credentials"
    }
  }
}
```

…and add `SN_PDI_CLIENT_SECRET=<client_secret>` to the MCP client's `env` block.
No `username`/`credential` is needed for the client_credentials grant.

> Note: the runtime `sn_profile add` action currently onboards **basic-auth profiles only**;
> OAuth/API-key profiles are configured as above.

## Part D — Test checklist

| # | Step | Expected |
|---|------|----------|
| 1 | Start the server / open the session, check stderr banner | Server starts; **no** basic-auth deprecation warning (all profiles OAuth) |
| 2 | `sn_profile` action=list, then action=info | `auth_type: "oauth"`; **no secret material** in either output |
| 3 | `sn_health` check=version | Succeeds — proves token mint + authenticated call |
| 4 | `sn_query` table=incident limit=3 | Compact JSON, ~8–12 curated fields per record, `record_count`/`total`/`has_more` present |
| 5 | `sn_query` table=incident limit=1 fields=all | Full record (many more fields) |
| 6 | Repeat step 4 a few times, then on the instance open `oauth_credential.list` | **One** access token for the client — proves caching (no token-per-call) |
| 7 | Delete that token row on the instance, run another query | Succeeds transparently — proves the single 401 refresh-and-retry |
| 8 | Restart the server with a wrong `SN_CLIENT_SECRET`, run a query | Clear error naming the token endpoint + HTTP status; **no secret text** in the message |
| 9 | (Optional) Set the registry record's Access Token Lifespan to 60s, wait, query again | New token minted automatically, no error (60s safety margin forces refresh) |
| 10 | Add a second profile with `authType: "basic"`, restart | Startup deprecation warning appears; `profile` param routes calls per profile |
| 11 | Full harness: `SN_INSTANCE=... SN_AUTH_TYPE=oauth SN_CLIENT_ID=... SN_CLIENT_SECRET=... node scripts/smoke-test.mjs --write` | All checks pass (`--write` does a create→update→delete incident round-trip — PDI/sub-prod only; add `--bad-auth` on basic profiles to test the KB3096078 hint) |

The harness (`scripts/smoke-test.mjs`) also validates every `DEFAULT_FIELDS` column against the
live schema — the one check that could not be done with mocked HTTP.
