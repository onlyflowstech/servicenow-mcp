# V2 and future enterprise release boundary

This decision records the SNSDK-43 product boundary. ServiceNow MCP V2 is a
private, single-owner developer service and is independently releasable on that
basis. Undecided enterprise requirements do not block a V2 implementation
ticket, release candidate, or release decision.

The possible paid enterprise release is a separately funded future product.
This document is only a concise boundary that may seed its own PRD. It is not
that PRD, an implementation plan, an estimate, enterprise acceptance criteria,
or a delivery commitment. Those artifacts must stay outside the V2 release
plan and release gate.

## V2 release boundary

One V2 deployment belongs to one owner. It may contain several explicitly
named ServiceNow profiles, but every tool call selects exactly one profile and
uses the deployment's universal fail-closed policy. The owner may authorize
more than one private client; `clientId` distinguishes those clients for
request context and audit, but it is not a user, group, role, tenant, or
delegated ServiceNow identity.

V2 is complete when its approved single-owner Jira scope and release gates are
complete. A V2 ticket must not acquire an enterprise dependency or be held open
because a future enterprise product has not decided its identity, tenancy,
authorization, administration, compliance, packaging, or commercial model.

The following capabilities are explicitly excluded from V2 and are not
required for release:

| Excluded capability | V2 rule |
| --- | --- |
| Shared deployments | A deployment has one owner; it is not a shared organization service. |
| User and group administration | V2 has no user directory, group lifecycle, invitations, membership, or user-administration surface. |
| RBAC and per-profile access control | V2 has no roles, grants, entitlements, or caller-specific profile permissions. Its restricted policy applies universally within the owner deployment. |
| Tenant isolation | V2 has no tenant model, tenant routing, tenant-scoped storage, or cross-tenant administration. Multiple ServiceNow profiles are routing targets, not tenants. |
| Delegated ServiceNow identity | A profile resolves its configured integration credentials. V2 does not impersonate or delegate the human caller's ServiceNow identity. |
| Compliance administration | V2 operational security, audit, retention, and support controls do not constitute enterprise governance, legal hold, discovery, residency, policy administration, or compliance reporting. |
| Public distribution | V2 is a private owner service. It is not a public, marketplace, or generally shared multi-user offering. |

Private provider-adapter validation does not change this boundary. In
particular, a private ChatGPT draft app connected through an outbound Secure
MCP Tunnel remains a single-owner deployment option.

## The dormant HTTP transport

The product exposes exactly one transport: **stdio**. A client spawns
`servicenow-mcp` and speaks JSON-RPC over that process's stdin and stdout.
There is no listening socket, no endpoint, and no service to start. That is the
whole shipped surface, and `servicenow-mcp-setup` registers every client that
way.

A complete Streamable HTTP runtime nevertheless remains in the tree, compiling
and under test:

| Module | What it holds |
| --- | --- |
| [`src/http-entrypoint.ts`](../src/http-entrypoint.ts) | The composition that starts the listener. Not a `bin` entry; nothing on the CLI path imports it. |
| [`src/http-runtime.ts`](../src/http-runtime.ts) | Per-request MCP server construction, admission, deadlines, cancellation, graceful drain. |
| [`src/http-auth.ts`](../src/http-auth.ts) | The bearer/identity boundary evaluated before MCP parsing. |
| [`src/http-request-policy.ts`](../src/http-request-policy.ts) | `Host`/`Origin` allowlists, content-type and body bounds. |
| [`src/http-observability.ts`](../src/http-observability.ts) | Structured request and tool events. stdio reuses its tool half. |

It is kept, rather than deleted, because a listening service is the shape an
enterprise deployment would need — a shared host, a reverse proxy, a bearer or
delegated identity — and rebuilding admission control, rate limiting,
`Host`/`Origin` handling, and per-request server isolation from nothing would
be materially harder than keeping them exercised. Its tests run on every build
(`test/http-runtime.test.ts`, `test/http-entrypoint.test.ts`,
`test/http-auth.test.ts`, `test/http-request-policy.test.ts`,
`test/http-cross-client.test.ts`), so it does not rot.

**Dormant means unreachable, not configurable.** There is deliberately no
transport environment variable and no CLI flag. Running
`node dist/http-entrypoint.js` starts it, which is how its tests drive it, and
that is the only way. An operator following the documentation cannot turn it on
by accident.

Re-exposing it is a product decision, not a configuration change, and it would
carry the questions this document exists to defer: who may connect, how they
authenticate, whose ServiceNow identity a request acts as, and what the
`Host`/`Origin` and TLS boundary is on a machine that is no longer the only
caller. None of those is answered by the single-owner V2 model, and none of the
excluded capabilities above becomes available by starting a listener.

An authenticated **public ChatGPT** offering cannot promote V2's private
static bearer, owner/client labels, or tunnel procedure into a multi-user
security model. It requires a separately designed multi-user
authorization/OAuth architecture, including its own identity and authorization
boundaries, token lifecycle, consent and revocation model, tenant binding, and
ServiceNow identity decision. That work belongs to the future product and is
not implicit in V2.

## Concrete seams V2 preserves

V2 preserves only the boundaries already needed by its single-owner design.
They are useful inputs to later design work, but none is an enterprise feature
or a promise that enterprise requirements can be added without redesign.

| Existing seam | Concrete V2 contract | What it does not mean |
| --- | --- | --- |
| [Request owner/client authentication](../src/http-auth.ts) | `HttpAuthenticationProvider` authenticates before MCP parsing, profile lookup, credentials, or tool dispatch and produces one immutable `ownerId`/`clientId` identity. Under stdio there is nothing to authenticate — the caller already had to be able to spawn the process — so `MCP_OWNER_ID`/`MCP_CLIENT_ID` are labels, and the seam sits dormant with the rest of the HTTP path. | `clientId` is not a user directory, role, tenant, OAuth subject, or delegated identity. |
| [Explicit request/profile context](../src/execution-context.ts) | Each invocation binds immutable request metadata, exactly one resolved profile, an effective policy, cancellation, result identity, and audit correlation. | A profile is not a tenant or entitlement, and context construction is not per-user authorization. |
| [Policy-provider boundary](../src/execution-context.ts) | `EffectivePolicyProvider` selects the deployment's fail-closed policy; table, field, encoded-query, record-identifier, and journal modules enforce concrete resource rules. | Deployment policy is not RBAC, a grants service, or per-profile/caller access control. |
| [Secret references](../src/profile-credentials.ts) | `SecretReference` and `SecretResolver` keep profile credential resolution provider-neutral and separate from stored configuration. | Secret resolution does not delegate a human identity or provide tenant-scoped credential brokering. |
| [Provider-neutral MCP construction](../src/server.ts) | The MCP server is created independently of any transport; `createMcpServer` never imports, constructs, or connects one. The shipped runtime binds it to stdio, and the dormant HTTP runtime binds the same server to Streamable HTTP. | Compatibility with a provider or tunnel is not public distribution, provider identity, or enterprise authorization. |

Preserving these seams means keeping their current responsibilities explicit
and avoiding provider-specific coupling. It does **not** authorize new tenant,
user, group, role, grant, OAuth-provider, compliance-administrator, or delegated
identity abstractions in the V2 runtime. Such abstractions require their own
approved product requirements and architecture.

## Boundary for a later PRD

A separately authorized enterprise initiative may use this exclusion list and
the concrete seam inventory as starting context. Its own PRD must decide the
customers and deployment model, identity authority, authorization and
per-profile entitlement model, tenant and data-isolation guarantees,
ServiceNow identity/delegation model, administrator and compliance surfaces,
public-channel threat model, operations, support, and commercial packaging.

No answer is selected here. No enterprise estimate, milestone, acceptance
criterion, funding promise, or delivery date belongs in the V2 roadmap. Until
a separate product decision exists, the V2 behavior stays private and
single-owner and all listed enterprise capabilities stay excluded.
