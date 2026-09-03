# Provider-neutral release validation

SNSDK-57 defines one release workflow for the HTTP artifact. It is independent
of ChatGPT, Claude, and every other AI provider. The portable gates use local
fakes and the protected `/mcp` protocol surface; they do not contact ServiceNow.
This workflow does not create a tunnel, public endpoint, deployment, package
publication, or provider integration.

## Portable release gates

Run from a clean checkout on a supported Node.js version:

```sh
npm ci --engine-strict
npm run release:contract
npm run typecheck
npm run lint
npm run build
npm run test:unit
npm run test:protocol
npm run test:profile
npm run test:release
npm pack --dry-run --json --ignore-scripts
npm audit --omit=dev --audit-level=moderate
```

The unit and protocol commands are deliberately separate release records even
though the complete unit suite contains the focused protocol cases. The
protocol gate includes the all-19-tool missing-profile rejection matrix through
the official SDK and independent Fetch clients, plus the catalog-wide resolved
profile/result/audit contract. The profile gate covers encryption,
secret-reference resolution, operator administration, and profile isolation.

Archive the package archive manifest from the dry run, including every path,
size, package version, and integrity value. The production dependency audit
must contain no unresolved moderate-or-higher finding. Never archive an
environment dump, credential, bearer, profile file, ServiceNow response, or
request body.

## Inspector and second-client check

MCP Inspector is an optional release client, not a runtime dependency. Version
`2.0.0` and its registry integrity are locked under `tools/inspector/`; its
Node.js `>=22.19.0` requirement is isolated so the server remains supported on
Node.js 20. Install that toolchain only from the committed lock:

```sh
npm ci --prefix tools/inspector --engine-strict --ignore-scripts
npm audit --prefix tools/inspector --audit-level=moderate
```

Set the non-secret `MCP_URL` to the exact reviewed `/mcp` URL and set
`MCP_PROFILE` to the named test profile. Have the approved supervisor or secret
manager inject the bearer into the service and smoke-client processes. Release
validation always runs against an authenticated service: `MCP_BEARER_TOKEN` is
optional for the product but required for these gates, and `npm run smoke`
refuses to start without it. Do not
put it in shell input or Inspector arguments. On Node.js 22.19 or newer, run:

```sh
npm run inspector
```

The launcher starts the locked Inspector UI and proxy on loopback, preserves
Inspector proxy authentication, disables automatic browser opening, scrubs MCP
and ServiceNow secrets from the child environment, and passes no target or
bearer header in argv. In the local UI:

1. Select Streamable HTTP and enter the exact `MCP_URL` shown by the launcher.
2. Enter the bearer directly from the approved secret store in the local UI.
3. Run `tools/list`; verify exactly 19 tools and required non-empty `profile`
   schemas.
4. Call `sn_profile` once without `profile` and verify rejection.
5. Call it again with the exact `MCP_PROFILE`; verify
   `structuredContent.profile` and the safe audit record match.

Without changing `MCP_URL`, `MCP_PROFILE`, or the protected endpoint, run the
official SDK smoke client as the second client:

```sh
npm run smoke
```

The smoke client requires an explicit URL, bearer, and profile and applies a
30-second per-operation timeout by default. `MCP_SMOKE_TIMEOUT_MS` may be set to
an integer from 1000 through 120000. It validates the resolved profile on every
successful probe. Neither launcher installs a provider adapter or creates a
public tunnel. Inspector is interactive evidence; it cannot replace the
deterministic CI protocol matrix.

## Deliberately enabled disposable writes

The smoke client is read-only unless both the write switch and an exact-profile
confirmation are present. On a disposable authorized PDI only:

```sh
npm run smoke -- --write --confirm-write-profile=oauth-test
```

The confirmation must exactly equal `MCP_PROFILE`. The sequence creates one
incident, reads its canonical `structuredContent.data.sys_id`, appends one work
note, and attempts deletion in `finally`. Never enable it for production or a
shared instance. A failed deletion is a failed smoke result and requires manual
cleanup by an authorized instance owner.

## Container, artifact, and rollback evidence

The container validation and scan gate is separate because it requires Docker
and a supported pinned scanner:

```sh
npm run container:build
npm run container:validate
MCP_CONTAINER_SCANNER=trivy npm run container:scan
```

The checked-in workflows download the immutable Trivy `0.70.0` Linux archive
directly from its official release, verify its committed SHA-256 digest before
installation, and do not invoke a mutable scanner setup action.

CI builds before validation, runs the official SDK and independent Fetch client
against the same local image, and scans that exact tag. Record the image ID,
platform manifest digest, labels, validation summary, scanner/version/database
timestamp, and result. The provenance archive remains a separately authorized
release action and is never published by these checks.

Before any rollout, record the previous immutable artifact digest and the exact
configuration revision needed for rollback. Rollback means redeploying that
previous reviewed digest—not rebuilding a mutable tag—then repeating health,
two-client discovery, explicit-profile, audit, and secret-leak checks. Stop the
release when the tag differs from `v<package.json version>`, evidence is
missing, a scan/audit fails, cleanup fails, or any gate requires weakening a
profile, authentication, table, field, or transport boundary.

The roadmap does not authorize SNSDK-57 to choose a new semantic version. The
current package and lock version remain unchanged until a release owner selects
the target; stable-tag publication fails unless the tag exactly matches them.

The Inspector operating model and security constraints are documented by the
[official MCP Inspector project](https://github.com/modelcontextprotocol/inspector).
