# Live Test Plan — OAuth Onboarding + Efficiency Branch

Branch under test: `feature/efficiency-auth-hardening`. Six changes are being validated end to end:

1. Dependency bumps (MCP SDK 1.29, zod 3.25) — server still works
2. Compact JSON + empty-field stripping in tool responses
3. HTTP client hardening: timeouts, retry/backoff, rate-limit handling
4. Default field selection + `sysparm_exclude_reference_link`
5. Pagination metadata (`total`, `has_more`, `next_offset`) from `X-Total-Count`
6. OAuth `client_credentials` auth: token mint, caching, expiry refresh, 401 recovery, secret redaction

Use a **PDI or sub-prod instance**. Every test below states **What it verifies → How → Pass evidence → If it fails**.

---

## Part A — Instance-side OAuth setup (one-time, ~10 min)

1. Filter navigator → `sys_properties.list` → find or create
   `glide.oauth.inbound.client.credential.grant_type.enabled` (type true/false) → set **true**.
2. Create service account `mcp.service`: *Web service access only* checked, role `admin` (PDI) or
   least-privilege. Zurich+: **Identity Type must be "Human"**.
3. System OAuth → Application Registry → New → **"Create an OAuth API endpoint for external clients"**:
   name `servicenow-mcp`, save, copy **Client ID** + **Client Secret**, set **OAuth Application User**
   = `mcp.service`.

### A-1: Token endpoint sanity check (do this before anything else)

- **Verifies:** the instance mints client_credentials tokens at all (isolates instance problems from server problems).
- **How:**
  ```bash
  curl -s https://<instance>.service-now.com/oauth_token.do \
    -d grant_type=client_credentials -d client_id=<ID> -d client_secret=<SECRET>
  ```
- **Pass:** JSON containing `"access_token"` and `"expires_in":1800`.
- **If it fails:**
  | Response | Cause |
  |---|---|
  | `invalid_client` | wrong client_id/secret |
  | `unauthorized_client` / grant-type error | step 1 property not set, or grant not enabled on the registry record |
  | token works but API calls later 401 | **OAuth Application User** not set on the registry record, or the user lacks roles / is a Machine identity |

## Part B — Build

```bash
cd ~/Development/servicenow-mcp-test        # clean clone, already created
git log --oneline -1                        # expect 3e9a7bd or later
npm ci && npm run build && npm test         # expect: Tests 127 passed
```

## Part C — Onboard the OAuth profile

Register the server for Claude Code (run inside the test directory so it scopes to this project):

```bash
cd ~/Development/servicenow-mcp-test
claude mcp add servicenow \
  -e SN_INSTANCE=https://devXXXXXX.service-now.com \
  -e SN_AUTH_TYPE=oauth \
  -e SN_CLIENT_ID=<client_id> \
  -e SN_CLIENT_SECRET=<client_secret> \
  -- node /Users/openclaw/Development/servicenow-mcp-test/dist/index.js
```

(Alternative: named profile in `~/.servicenow-mcp/config.json` with `"clientSecret": "env:VAR"` —
plain-text secrets are rejected. `sn_profile add` at runtime is basic-auth-only today.)

For the terminal-based tests below, also export the same four variables in your shell:

```bash
export SN_INSTANCE=https://devXXXXXX.service-now.com
export SN_AUTH_TYPE=oauth SN_CLIENT_ID=<client_id> SN_CLIENT_SECRET=<client_secret>
```

---

## Part D — Automated harness (run FIRST, from the terminal)

```bash
cd ~/Development/servicenow-mcp-test
node scripts/smoke-test.mjs --write        # --write is safe on a PDI; omit on shared instances
```

**Pass = final line `11/11 checks passed`, exit code 0** (9/9 without `--write`). What each check proves:

| Check line | Verifies | Pass evidence in the note |
|---|---|---|
| `tools/list` | server boots on SDK 1.29, registry intact | `18 tools` |
| `sn_health version` | OAuth token minted + authenticated GET works | instance version/build info printed |
| `sn_query incident (defaults)` | change #2 + #4 + #5 together | `keys/record=` ≤ 14 (curated defaults, not 100+); `total=` a number; `has_more=` present; chars low (≈1–3k, not 10k+) |
| `sn_query fields=all` | the escape hatch returns full records | `keys` > 30 |
| `pagination next_offset` | change #5, incl. the ACL-trim bug fix | `no overlap` (two pages share no sys_ids) |
| `DEFAULT_FIELDS vs live schema` | every curated column exists on YOUR instance — the one check mocks couldn't do | `all columns exist across 13 tables` |
| `sn_aggregate count` | display_value enum path unbroken | a count is returned |
| `bad-table error surfaced` | error quality: agent can self-correct | `isError` + a ServiceNow message (400/403/invalid), not a stack trace |
| `sn_create/sn_update/sn_delete incident` (`--write`) | write path + new compact response shapes | create note shows `sys_id=`; all three PASS |

- **If `DEFAULT_FIELDS vs live schema` fails:** the note lists exactly which `table.field` is missing —
  report those; they're one-line fixes in `src/table-defaults.ts`.
- **If nothing works:** run the server directly to see its stderr banner/error:
  `node dist/index.js` (Ctrl-C to exit). A config problem prints a descriptive missing-variable error.

## Part E — Interactive session tests (inside `claude`)

Start: `cd ~/Development/servicenow-mcp-test && claude`, then check `/mcp` shows **servicenow ✔ connected**.
For each test: type the prompt, watch which tool gets called and what comes back.

### E-1: Profile info leaks no secrets
- **Verifies:** #6 (redaction in sn_profile output)
- **Prompt:** `Show me the active ServiceNow profile details using sn_profile.`
- **Pass:** output shows instance URL and `auth_type: "oauth"`; contains **no** client secret, token, or password — search the response for any 8+ char fragment of your real secret.
- **Fail if:** any secret material appears anywhere. Stop and report — that's a critical bug.

### E-2: Default-field query (the token-efficiency headline)
- **Verifies:** #2 + #4
- **Prompt:** `Query the 3 most recently updated incidents.`
- **Pass:** expect `sn_query {table:"incident", limit:3, orderby:"-sys_updated_on"}` (or similar); each
  record has ~10 fields — `sys_id, number, short_description, state, priority, assigned_to,
  assignment_group, caller_id, opened_at, sys_updated_on` — with empty fields absent entirely;
  reference fields (assigned_to, caller_id) are display-value strings, **not** `{link:..., value:...}` objects.
- **Fail if:** records have 50–100+ fields (defaults not applied) or contain `"link":"https://..."` noise.

### E-3: Full-record escape hatch
- **Prompt:** `Get that first incident again with ALL of its fields.`
- **Pass:** the model passes `fields: "all"` and the record comes back with the full column set.

### E-4: Pagination follow-through
- **Verifies:** #5 — and that the metadata actually *steers the model*
- **Prompt:** `List incidents 2 at a time and show me the second page.`
- **Pass:** first call returns `has_more: true` + `next_offset: 2`; the model's second call uses
  `offset: 2` **without you telling it how**; no incident number repeats across pages.

### E-5: Error quality on a bad table
- **Prompt:** `Query the table x_totally_fake_table_zz for any records.`
- **Pass:** a clean error (`Invalid table` / 400) that the model relays sensibly — ideally it suggests
  checking the table name or using sn_discover; no crash, no raw stack trace.

### E-6: Write round-trip (PDI only)
- **Prompt:** `Create an incident with short description "MCP live test — safe to delete", then add the work note "tested via MCP", then delete it (confirm the deletion).`
- **Pass:** create returns `{sys_id, number, table, record}`; update returns `{sys_id, record}`;
  delete requires and uses `confirm: true`; afterwards the incident number is gone from the instance
  (spot-check `incident.list`).

## Part F — Instance-side verifications (the OAuth lifecycle)

### F-1: Token caching (ONE token, not one per call)
- **Verifies:** #6 expiry-tracked cache
- **How:** after E-1…E-5, on the instance open `oauth_credential.list` (or System OAuth → Manage Tokens)
  and filter by the `servicenow-mcp` application.
- **Pass:** exactly **1** access-token row exists despite many tool calls.
- **Fail if:** a row per call → caching broken; report immediately (it would hammer real instances).

### F-2: Mid-session token revocation (the 401 retry)
- **Verifies:** #6 single refresh-and-retry
- **How:** delete that token row on the instance, then back in the session:
  `Query the most recent incident.`
- **Pass:** the query **succeeds with no visible error** (server got 401, refreshed, retried once);
  `oauth_credential.list` now shows exactly 1 fresh token.

### F-3: Wrong-secret failure is clean and redacted
- **How (terminal):**
  ```bash
  SN_CLIENT_SECRET=definitely-wrong node scripts/smoke-test.mjs
  ```
- **Pass:** checks fail fast with an error naming the token endpoint + HTTP status
  (e.g. `OAuth token request failed (HTTP 401)`); the string `definitely-wrong` appears **nowhere** in output.

### F-4 (optional): Basic-auth deprecation UX
- **How:** in a terminal, `SN_AUTH_TYPE=basic SN_USER=admin SN_PASSWORD=<pw> node scripts/smoke-test.mjs --bad-auth`
- **Pass:** stderr shows the one-line Basic Auth deprecation warning at startup; the final
  `401 basic-auth hint` check PASSes (error text cites **KB3096078** and the exemption paths).

---

## Results template

```
Date: ____  Instance: ____  Release: ____
A-1 token curl        [ ]   E-3 fields=all        [ ]
Part B build/tests    [ ]   E-4 pagination        [ ]
Part D harness  __/11 [ ]   E-5 error quality     [ ]
E-1 no secret leak    [ ]   E-6 write round-trip  [ ]
E-2 default fields    [ ]   F-1 single token      [ ]
F-2 401 recovery      [ ]   F-3 redacted failure  [ ]
F-4 basic-auth UX     [ ]
Notes / failures (paste the exact FAIL line or response): 
```

Anything that fails: paste the exact output into the dev session and it can be fixed on the branch.
