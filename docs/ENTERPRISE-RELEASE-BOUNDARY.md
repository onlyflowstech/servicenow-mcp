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
| [Request owner/client authentication](../src/http-auth.ts) | `HttpAuthenticationProvider` authenticates before MCP parsing, profile lookup, credentials, or tool dispatch and produces one immutable `ownerId`/`clientId` identity. | `clientId` is not a user directory, role, tenant, OAuth subject, or delegated identity. |
| [Explicit request/profile context](../src/execution-context.ts) | Each invocation binds immutable request metadata, exactly one resolved profile, an effective policy, cancellation, result identity, and audit correlation. | A profile is not a tenant or entitlement, and context construction is not per-user authorization. |
| [Policy-provider boundary](../src/execution-context.ts) | `EffectivePolicyProvider` selects the deployment's fail-closed policy; table, field, encoded-query, record-identifier, and journal modules enforce concrete resource rules. | Deployment policy is not RBAC, a grants service, or per-profile/caller access control. |
| [Secret references](../src/profile-credentials.ts) | `SecretReference` and `SecretResolver` keep profile credential resolution provider-neutral and separate from stored configuration. | Secret resolution does not delegate a human identity or provide tenant-scoped credential brokering. |
| [Provider-neutral MCP construction](../src/server.ts) | The MCP server is created independently of transport and AI-provider adapters; the V2 runtime exposes standard Streamable HTTP. | Compatibility with a provider or tunnel is not public distribution, provider identity, or enterprise authorization. |

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
