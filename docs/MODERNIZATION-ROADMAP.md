# ServiceNow MCP Remote Modernization Roadmap

Status: Approved product scope; Jira backlog created
Date: 2026-07-31
Target Jira project: `SNSDK`

## Objective

Modernize `@onlyflows/servicenow-mcp` from a local, stdio-launched server into
an HTTP-only, single-owner developer service. One deployment belongs to one
developer and manages multiple named ServiceNow profiles. Each profile maps to
one ServiceNow instance and its own credentials. Credentials may be resolved
from a secret manager or stored as ciphertext in the profile configuration
after entry; encryption keys are stored separately. Every MCP tool call must
include a valid `profile`. There is no default or active-profile fallback.

V2 removes stdio and does not preserve the local-process launch contract. It
adds standards-based Streamable HTTP, explicit security boundaries,
operational controls, and a modular tool architecture. Shared enterprise
deployment, multi-user RBAC, tenant isolation, delegated user identity, and
public multi-user distribution are out of scope. Those capabilities may be
delivered later as a separate paid enterprise release. The exact non-blocking
product boundary and concrete V2 seams are recorded in
[V2 and future enterprise release boundary](ENTERPRISE-RELEASE-BOUNDARY.md).

The service is built against the standard MCP Streamable HTTP protocol and must
not depend on a ChatGPT-specific transport, authentication flow, or tunnel.
Provider-specific integrations are validation and deployment options so the
same server can be used by standards-compliant clients across AI platforms.

This is a program of prioritized epics rather than a single large refactor.
Each epic should remain independently reviewable. Published `sn_*` tool names
and canonical `SN_*` configuration names remain stable, but the V2 transport
change is intentionally breaking and requires migration documentation.

## Current baseline

The repository is not greenfield. As of this review:

- Package version: `1.2.0`
- Runtime: Node.js `>=20`
- Module/build configuration: TypeScript strict mode with Node16 resolution
- MCP SDK: `@modelcontextprotocol/sdk` `1.29.0`
- Validation: Zod `3.25.76`
- Transport: stdio through `dist/index.js`
- Authentication to ServiceNow: basic, OAuth client credentials/password grant,
  and configurable API key
- Configuration: named profiles plus the established `SN_*` environment variables
- Tool surface: 18 advertised `sn_*` tools
- Tests: 239 tests across 13 Vitest files
- Baseline verification: `npm run build`, `npm test`, and official SDK-client
  stdio initialization/tool discovery pass
- Missing project gates: dedicated lint and typecheck scripts, HTTP transport
  tests, and remote-runtime tests

Existing tools (19 published in 2.0):

`sn_query`, `sn_get`, `sn_create`, `sn_update`, `sn_incident_add_comment`,
`sn_incident_add_work_note`, `sn_delete`, `sn_batch`, `sn_aggregate`,
`sn_schema`, `sn_health`, `sn_attach`, `sn_relationships`, `sn_syslog`,
`sn_codesearch`, `sn_discover`, `sn_atf`, `sn_nl`, and `sn_profile`.

`sn_script` is **not** published in 2.0. It shipped in 1.0.0 as an
intentionally unavailable stub that returned an error without calling
ServiceNow, and it has been withdrawn from the advertised catalog rather than
shipping a tool that can only fail. Background-script execution remains future
state; see the roadmap entry in `README.md`.

## Confirmed product decisions

1. Work will be split into prioritized epics and implementation tickets.
2. Existing and future tools use the `sn_*` naming convention.
3. V2 is HTTP-only. The stdio entry point and local-process Claude launch
   contract are removed.
4. One deployment has one owner and may contain multiple named ServiceNow
   profiles. Each profile has its own instance and credentials. Credentials are
   either resolved from a secret manager or encrypted in configuration after
   entry; plaintext credentials are never stored at rest with the profile.
5. Every MCP tool call requires an explicit valid `profile`. There is no default
   profile, omitted-profile fallback, or process-wide `sn_profile switch` state.
   Natural-language requests such as "query prod" are translated by the MCP
   client into `profile: "prod"`; the server does not infer routing from query
   text.
6. `comments` and `work_notes` are removed from generic update semantics and
   handled through dedicated journal tools with accurate annotations.
7. The established `SN_*` configuration names remain canonical.
8. Restricted, default-deny data access applies universally; there is no legacy
   stdio compatibility policy.
9. Every successful result includes the resolved profile in structured content,
   and every invocation records it in the audit log. Missing or unknown profiles
   fail before tool execution or ServiceNow access.
10. Standard MCP Streamable HTTP is the cross-platform contract. No AI-provider
    integration is an architectural dependency.
11. Enterprise sharing, multi-user identity/RBAC, multi-tenancy, and public
   multi-user OAuth are reserved for a future paid enterprise release.

## Resolved architecture decisions

### ADR-1: HTTP-only V2 and universal restricted policy

The current generic tools permit broad Table API access, including arbitrary
table writes and raw encoded queries for batch mutations. V2 intentionally
breaks the stdio launch contract and does not retain a legacy unrestricted
mode.

- Use one HTTP tool registry and inject an authorization/data-access policy.
- Use separate read and write table allowlists, a hard sensitive-table denylist,
  field filtering, bounded results, and structured filters.
- Reject raw encoded queries for write operations. Allow bounded, opt-in encoded
  queries only for approved read tools.
- Apply the restricted policy universally.
- Publish V2 migration guidance for users of the removed stdio entry point and
  unrestricted behaviors.

This produces one modern security model instead of maintaining local and remote
behavior branches.

### ADR-2: Single-owner, multi-profile developer service

V2 targets a developer who owns one private deployment. That deployment can
connect to many ServiceNow instances through named profiles:

- Each profile contains an instance URL, an authentication method, and its own
  credentials. Credentials use a secret-manager reference or encrypted
  configuration; the decryption key is held outside the configuration file.
- Every tool request explicitly selects one profile. Omission is a validation
  error; no configured default is consulted.
- Reads across profiles are performed as separate calls and combined by the
  client. Writes always target exactly one explicit profile.
- Every successful structured result and audit entry identifies the resolved
  profile.
- The owner connection must be authenticated or carried over an approved
  private boundary so stored ServiceNow credentials cannot be used by arbitrary
  callers.
- MCP audit records identify the tool, profile, instance, request correlation,
  and owning client context. ServiceNow records the integration identity for the
  selected profile.

Delivery sequence:

- Build the HTTP-only server and explicit per-call profile resolution.
- Provide out-of-band configuration/CLI entry that either stores a secret-manager
  reference or encrypts the credential before writing profile configuration.
- Keep encryption keys outside the encrypted configuration while preserving the
  canonical `SN_*` environment contract.
- Deploy behind TLS or a private boundary and validate official HTTP clients.
- Validate private ChatGPT developer-mode access through Secure MCP Tunnel.
- Validate another standards-compliant MCP client so ChatGPT-specific behavior
  does not become an implementation dependency.
- Document enterprise/public OAuth as a future paid-release boundary; do not
  implement multi-user identity, RBAC, or tenant isolation in V2.

The deployment is single-owner rather than enterprise shared or multi-tenant.

## Priority definitions

- **P0 — Foundation/blocker:** required before non-loopback remote use.
- **P1 — Production remote:** required for a supportable single-owner remote
  release and representative safe tool coverage.
- **P2 — Expansion:** broader domain coverage after the remote foundation is
  stable.
- **Future paid enterprise release:** shared enterprise deployment, user/RBAC
  administration, tenant isolation, delegated identity, and public multi-user
  OAuth. These are not part of the V2 backlog.

## Proposed Jira backlog

The SNSDK project supports Epic, Story, Task, Bug, and Subtask work types.
User-visible capabilities are represented as Stories; architecture, security,
infrastructure, testing, documentation, and other enabling work are represented
as Tasks. The modernization spec does not introduce any Bugs.

Backlog created in Jira on 2026-07-31:

- 7 Epics
- 14 Stories
- 31 Tasks
- All 45 child items are linked to their parent Epic.
- All items carry the `remote-modernization` label plus their priority and
  domain labels.

Jira view: [SNSDK remote modernization backlog](https://onlyflows.atlassian.net/issues/?jql=project%20%3D%20SNSDK%20AND%20labels%20%3D%20%22remote-modernization%22%20ORDER%20BY%20key%20ASC)

### Epic 1 — P0: HTTP-first MCP server foundation ([SNSDK-14](https://onlyflows.atlassian.net/browse/SNSDK-14))

Goal: create a testable HTTP-first server core while removing the stdio entry
point and local-process lifecycle contract.

Tasks:

1. **Task [SNSDK-15]:** Record the HTTP-only and universal restricted-policy decision.
2. **Task [SNSDK-16]:** Introduce the shared `McpServer` factory and dependency container.
3. **Task [SNSDK-17]:** Migrate the registry to high-level `McpServer.registerTool` with Zod as the
   schema source of truth.
4. **Task [SNSDK-18]:** Remove the stdio entry point and publish the HTTP-only startup contract.
5. **Task [SNSDK-19]:** Introduce request/execution context for required profile, correlation ID,
   owner identity, and policy.
6. **Task [SNSDK-20]:** Add contract tests for the existing 18 tool names, required profile input,
   and compatible schemas.

### Epic 2 — P0: Streamable HTTP remote runtime ([SNSDK-21](https://onlyflows.atlassian.net/browse/SNSDK-21))

Goal: provide a secure, stateless, standards-compliant Streamable HTTP entry
point suitable for managed deployment and use across MCP-capable AI platforms.

Stories and tasks:

1. **Story [SNSDK-22]:** Implement stateless Streamable HTTP at `/mcp` using SDK-supported transport.
2. **Task [SNSDK-23]:** Add platform-neutral single-owner HTTP authentication without coupling auth
   to tool handlers.
3. **Task [SNSDK-24]:** Add request size, timeout, content-type, host/origin, and CORS protections.
4. **Task [SNSDK-25]:** Add liveness, readiness, graceful shutdown, and request draining.
5. **Task [SNSDK-26]:** Add structured request/tool logging, correlation IDs, redaction, and rate
   limiting.
6. **Task [SNSDK-27]:** Add cross-client HTTP tests for initialization, discovery, invocation,
   authentication rejection, required-profile validation, and shutdown.

### Epic 3 — P0: ServiceNow data-access security and correctness ([SNSDK-28](https://onlyflows.atlassian.net/browse/SNSDK-28))

Goal: define enforceable least-privilege boundaries for remotely callable tools.

Stories and tasks:

1. **Task [SNSDK-29]:** Implement separate read/write table allowlists and hard sensitive-table
   denials.
2. **Task [SNSDK-30]:** Implement safe default field sets, explicit field validation, sensitive-field
   filtering, and maximum field counts.
3. **Task [SNSDK-31]:** Implement a structured ServiceNow query builder with bounded filters and
   operators.
4. **Task [SNSDK-32]:** Enforce the raw encoded-query policy and prohibit encoded write queries.
5. **Task [SNSDK-33]:** Standardize bounded pagination, response mapping, resolved-profile output,
   and output-size controls.
6. **Task [SNSDK-34]:** Normalize missing/unknown-profile, ServiceNow, configuration, and tool errors
   with safe correlation IDs.
7. **Story [SNSDK-35]:** Add dedicated `sn_incident_add_comment` and `sn_incident_add_work_note` tools
   and reject journal fields from generic `sn_update`.
8. **Story [SNSDK-36]:** Require an explicit profile on every tool call with no default or active
   profile state.

### Epic 4 — P1: Remote deployment and ChatGPT connectivity ([SNSDK-37](https://onlyflows.atlassian.net/browse/SNSDK-37))

Goal: operate the HTTP server outside a developer workstation with a clear
identity, network, and support model.

Stories and tasks:

1. **Task [SNSDK-38]:** Define secret-manager and encrypted-config profile credentials.
2. **Task [SNSDK-39]:** Create a production deployment artifact and non-root runtime configuration.
3. **Task [SNSDK-40]:** Document TLS termination, trusted proxy behavior, secret management, and
   network boundaries.
4. **Task [SNSDK-41]:** Add deployment health checks, metrics/logging guidance, and an operator
   runbook.
5. **Story [SNSDK-42]:** Validate private ChatGPT connectivity through Secure MCP Tunnel.
6. **Task [SNSDK-43]:** Document the future paid enterprise-release boundary.

### Epic 5 — P1: Modular tool framework and representative vertical slice ([SNSDK-44](https://onlyflows.atlassian.net/browse/SNSDK-44))

Goal: prove that new ServiceNow domains can be added safely without registry or
AI-platform-specific duplication.

Stories and tasks:

1. **Task [SNSDK-45]:** Define the tool-module contract, including required profile input,
   permissions, table/API dependencies, annotations, schemas, and tests.
2. **Task [SNSDK-46]:** Modularize metadata/schema functionality while preserving `sn_schema`.
3. **Story [SNSDK-47]:** Modernize `sn_query` as the paginated structured read example.
4. **Story [SNSDK-48]:** Modernize `sn_get` with validated sys_id and human-readable identifier
   resolution.
5. **Story [SNSDK-49]:** Modernize one controlled incident create/update path with field policy.
6. **Task [SNSDK-50]:** Add structured content/output schemas, including resolved profile, to the
   representative tools.

### Epic 6 — P1: Quality gates, documentation, and migration ([SNSDK-51](https://onlyflows.atlassian.net/browse/SNSDK-51))

Goal: make the remote release testable, reproducible, and operable.

Tasks:

1. **Task [SNSDK-52]:** Add dedicated strict typecheck and lint commands without weakening rules.
2. **Task [SNSDK-53]:** Add unit tests for configuration, policies, query building, filtering,
   pagination, errors, and authentication.
3. **Task [SNSDK-54]:** Add mocked tool tests for success, empty, not-found, ACL, timeout, sensitive
   fields, and controlled writes.
4. **Task [SNSDK-55]:** Add cross-platform HTTP protocol integration suites using multiple MCP
   clients.
5. **Task [SNSDK-56]:** Add `.env.example`, profile encryption/secret-manager guidance,
   cross-platform remote deployment documentation, security guidance, and an adding-tools guide.
6. **Task [SNSDK-57]:** Add Inspector scripts, safe smoke tests, migration notes, and CI release
   gates.

### Epic 7 — P2: Read-first ServiceNow domain expansion ([SNSDK-58](https://onlyflows.atlassian.net/browse/SNSDK-58))

Goal: expand coverage only after the shared policies and tool framework are
proven.

Stories:

1. **Story [SNSDK-59]:** Add metadata choice and reference lookup tools.
2. **Story [SNSDK-60]:** Add focused incident list/get tools and complete safe incident mutations.
3. **Story [SNSDK-61]:** Add problem and change read tools before controlled write tools.
4. **Story [SNSDK-62]:** Add user, group, and group-membership lookup tools.
5. **Story [SNSDK-63]:** Add CMDB CI search/get, relationships, and class-list tools.
6. **Story [SNSDK-64]:** Add knowledge search/get tools with safe output fields.
7. **Story [SNSDK-65]:** Add attachment list and metadata tools; assess download separately.

## Cross-epic delivery rules

- Streamable HTTP is the only supported V2 MCP transport.
- The server implements standard MCP behavior without depending on a specific AI
  provider. Provider-specific tunnels and integrations are optional adapters or
  validation paths.
- Every current and future tool name uses the `sn_*` convention.
- `SN_*` variables and named profiles remain supported.
- HTTP requests require the approved single-owner authentication/private access
  boundary.
- No mode can enable legacy unrestricted table access.
- Every MCP tool call includes one explicit validated profile. Missing or unknown
  profiles fail before execution; there is no default-profile fallback.
- Every successful structured result and audit event includes the resolved
  profile.
- Profile credentials are secret-manager references or encrypted configuration
  values. Encryption keys are stored separately and plaintext is never persisted
  in profile configuration.
- Tool descriptions, annotations, input schemas, and output schemas are treated
  as versioned client contracts.
- ServiceNow content is untrusted data and cannot change policy or trigger
  additional server-side actions.
- Write tools require explicit authorization, accurate annotations, bounded
  scope, and dedicated tests.
- No public tunnel is created automatically.

## Release milestones

### Milestone 1 — Remote foundation

Epics 1-3 complete. The stdio entry point is removed; authenticated stateless
HTTP works; explicit profile selection and universal restricted policy are
enforced; missing profiles fail before execution; multiple MCP clients pass
transport and contract tests.

### Milestone 2 — Managed remote release

Epics 4-6 complete. A single-owner, multi-profile developer deployment can be
operated with TLS/private access, profile-specific secrets, health, logging,
documentation, and repeatable validation.

### Milestone 3 — Domain expansion

Epic 7 is delivered incrementally, read tools first, using the proven framework.

### Future paid enterprise release — outside V2

Shared enterprise deployment, multi-user RBAC, tenant isolation, delegated
ServiceNow identity, public distribution, and standards-compliant multi-user
OAuth are intentionally deferred to a separately scoped paid release.
