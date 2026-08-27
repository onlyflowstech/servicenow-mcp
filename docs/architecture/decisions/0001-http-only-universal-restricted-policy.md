# ADR 0001: HTTP-only V2 and universal restricted/default-deny policy

- **Status:** Approved
- **Date:** 2026-07-31
- **Decision issue:** SNSDK-15
- **Parent epic:** SNSDK-14 — P0: HTTP-first MCP server foundation
- **Applies to:** ServiceNow MCP V2

## Context

The V1 implementation is a local-process MCP server. Its package executable
starts `dist/index.js`, which connects an MCP `Server` to
`StdioServerTransport`. Client configuration supplies a command, arguments,
and environment variables rather than an HTTP endpoint.

V1 also has routing and data-access behaviors that are inappropriate for a
remotely callable service:

- A tool's `profile` input is optional. Omission selects mutable, process-wide
  active-profile state initialized from `default_profile`. When a profile file
  is unavailable or invalid, V1 falls back to a synthetic `default` profile
  built from canonical `SN_*` environment variables.
- The `sn_profile` MCP tool lists, inspects, adds, and switches profiles.
  Profile additions persist configuration, and switching changes the target
  used by later calls that omit `profile`.
- The MCP profile-add path requires `env:` references for secrets, but a
  hand-authored legacy profile file can contain a plaintext credential,
  client secret, or API key. V1 accepts such a value and warns when resolving
  it.
- Generic tools accept caller-selected table names and field maps. Read tools
  accept raw ServiceNow encoded queries, and `sn_batch` uses a raw encoded
  query to select records for update or deletion.

These are descriptions of the legacy baseline, not claims that V1 already
conforms to this decision. V2 is a deliberately breaking security and
transport modernization.

The target remains a private service owned by one developer or operator. One
deployment may contain multiple named ServiceNow profiles, each mapping to one
instance and its own credentials. Shared enterprise operation, multi-user
identity, RBAC, tenant isolation, delegated user identity, and public
multi-user OAuth are outside this decision and outside V2.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, and **MAY** in
this ADR are normative.

## Decision

### 1. One transport contract

V2 **MUST** expose standard MCP Streamable HTTP as its sole MCP transport.
The stdio server entry point, local child-process lifecycle contract, and
stdio compatibility path **MUST** be removed. There **MUST NOT** be a hidden
flag, alternate executable, or policy mode that restores stdio or legacy
unrestricted behavior.

The core server **MUST NOT** depend on ChatGPT, Claude, or any other AI
provider's transport, authentication flow, or tunnel. Provider-specific
integrations, including Secure MCP Tunnel, are optional compatibility and
deployment validation paths only.

The HTTP service is a private, single-owner deployment. HTTP owner
authentication and the approved TLS or private-network boundary apply before
MCP tool execution. Their concrete mechanism is defined by the HTTP runtime
delivery tickets; it does not change the single-owner boundary or the tool
policy defined here.

### 2. Explicit profile routing on every tool call

Every `tools/call` request **MUST** contain a `profile` string that is non-empty
after validation and resolves uniquely to a configured named profile. The
server **MUST NOT** consult a default or active profile, infer a profile from
natural-language arguments, remember a prior selection, or fall back to
`SN_*` values as an unnamed/default target. A client interpreting “query
prod” is responsible for sending `profile: "prod"` explicitly.

A missing, empty, malformed, unknown, or ambiguous profile **MUST** fail before
tool-handler entry, ServiceNow client construction or retrieval, network
access, credential resolution for the target, or any side effect. The server
**MUST NOT** retry such a call against another profile.

Once resolved, the profile binding **MUST** be immutable and scoped to that
request and its execution context. The same binding **MUST** govern
configuration, credentials, ServiceNow client selection, policy evaluation,
handler execution, result construction, logs and audit, and every
profile-dependent cache key. Concurrent or interleaved calls for different
profiles **MUST NOT** cross-contaminate clients, credentials, policy decisions,
results, logs, audit events, or cached data.

Profile creation, modification, deletion, credential entry, and stateful
switching **MUST** occur out of band through operator-controlled configuration
or administrative tooling, never through an MCP tool. The V1 `sn_profile`
actions that add profiles or expose active/default switching **MUST** be
removed. If a later registry ticket retains a non-administrative diagnostic
surface under the published `sn_profile` name, it **MUST** require an explicit
profile, remain read-only, reveal no secret material, and be unable to change
routing or stored configuration.

### 3. One universal, fail-closed authorization and data policy

There is one restricted policy for all V2 tool calls. No transport, tool,
profile, caller, environment, or deployment mode may bypass it. The common
dispatch path **MUST**, before handler or client access:

1. validate the tool input and explicit profile;
2. load a valid policy and authorize the named tool/capability;
3. resolve the operation's resources, tables, fields, filters, and bounds;
4. apply the hard denials and applicable read or write permissions; and
5. reject the call unless every required decision is an explicit allow.

Policy absence, load failure, invalid policy, an unknown capability, or an
unclassified operation **MUST** deny the call. Invalid policy also **MUST**
make readiness fail. There is no permissive default and no insecure fallback.
Tool composition, natural-language tools, batch operations, attachments,
metadata operations, and non-Table APIs remain subject to the same dispatcher
and may not invoke a ServiceNow client through an unguarded path.

The policy **MUST** provide all of the following:

- separate read-table and write-table allowlists;
- a hard sensitive-table denylist that takes precedence over every allowlist;
- explicit permission for non-table capabilities and ServiceNow API families;
- safe readable and writable field sets, maximum field counts, and sensitive
  field filtering on both requests and responses;
- structured filters with an allowlist of fields and operators;
- finite, explicit limits for page size, pagination depth or total returned
  records, serialized output bytes, request/input bytes, attachment sizes when
  applicable, and mutation/batch cardinality; and
- tool-specific limits that callers may lower but **MUST NOT** raise above the
  configured maximum.

Exact numeric defaults are owned by the corresponding implementation and
security tickets, but none of the listed maximums may be absent, infinite, or
disabled in a releasable V2 configuration.

An allowlisted table is not sufficient by itself. The tool/capability,
operation type, target table, fields, filter operators, and bounds all
**MUST** be permitted. The sensitive-table denial **MUST** also cover indirect
access through table inheritance, aliases, alternate ServiceNow endpoints, or
composed tools. Unknown tables, fields, operators, and capabilities are
denied.

Read responses **MUST** enforce field filtering and output bounds after the
ServiceNow response is received as well as before it is requested. A response
may be safely truncated only at record or field boundaries and must then carry
unambiguous truncation/continuation metadata; otherwise it is rejected. A
write that exceeds a mutation or input bound **MUST** be rejected before the
first mutation.

### 4. Encoded-query contract

Structured filters are the normal V2 query interface.

Raw ServiceNow encoded-query input **MUST NOT** be accepted by a write tool.
Within one invocation or composed server-side operation, the server **MUST
NOT** use caller-supplied raw encoded-query input, or records or identifiers
returned by executing that raw input, to select targets for update, delete,
create, attachment mutation, journal mutation, batch, or other side-effecting
behavior. Confirmation or dry-run flags do not relax this prohibition. This
does not prevent the server from compiling policy-approved, validated
structured filters into an internal or ServiceNow query representation,
provided all applicable write policy and bounds are enforced. This server-side
provenance rule does not claim that a stateless server can infer whether a
caller obtained an explicit record identifier during an earlier, independent
invocation.

Encoded queries for reads are disabled by default. They **MAY** be enabled only
by an explicit policy entry that names the approved read-only tool and target
table. That entry **MUST** also define finite query-length and term/complexity
limits, permitted fields and operators, and the applicable pagination and
output bounds. The implementation **MUST** parse and validate the query and
reject unsupported or unparseable syntax; it may not treat policy opt-in as
permission to forward an arbitrary string. Approval for one tool/table pair
does not approve another tool/table pair or any write path.

### 5. Write and journal-field contract

Writes require the write allowlist and safe writable-field policy in addition
to the universal checks above. Generic `sn_update` **MUST** reject journal
fields, including `comments` and `work_notes`, before handler/client access.
Incident comments and work notes **MUST** use dedicated
`sn_incident_add_comment` and `sn_incident_add_work_note` tools with accurate
read-only, destructive, idempotency, and open-world annotations. Dedicated
journal tools do not bypass table, profile, field, size, audit, or other policy
checks.

### 6. Result, audit, and error contract

Every successful structured tool result **MUST** include the canonical resolved
profile name as `profile`. Every tool audit event **MUST** have a `profile`
field: it contains that same canonical name after successful resolution, and
is `null` only for a rejection that occurs because the requested profile is
missing, invalid, or unknown. Such an event must record the rejection reason
without inventing or inferring a profile. Audit records and errors **MUST NOT**
contain credentials, tokens, ciphertext, encryption keys, secret-manager
values, raw sensitive records, or unredacted sensitive arguments.

Policy and validation rejections **MUST** be safe, deterministic, and
actionable enough to identify the denied tool/input class and a correlation
identifier without disclosing the denylist, secrets, or sensitive ServiceNow
data. An error **MUST NOT** trigger a less-restricted retry or another profile.

### 7. Profile credentials and configuration contracts

Each named profile contains its ServiceNow instance, authentication method,
and credential references. Persisted credentials **MUST** be either
secret-manager references or authenticated ciphertext. Encryption keys
**MUST** be stored separately from ciphertext and profile configuration.
Authentication failure, missing keys, invalid references, and ciphertext
authentication failure are fail-closed conditions. Plaintext credentials
**MUST NOT** be persisted or logged.

Established `SN_*` configuration names remain canonical and supported through
the V2 out-of-band configuration/secret-resolution contract. This compatibility
does not restore the V1 synthetic default profile, authorize plaintext
persistence, or permit a call to omit `profile`. The delivery tickets define
the exact V2 configuration mapping and commands.

All existing and future MCP tool names use the `sn_*` namespace. Preserving
that namespace and the canonical configuration names does not negate the
intentional V2 breaks described in this ADR.

## Migration requirements

V2 migration documentation **MUST** identify these changes as release-blocking
operator/client work. It must:

1. replace command/arguments-based stdio client configuration with the V2
   Streamable HTTP endpoint and its owner-authentication/private-boundary
   configuration; no stdio shim may be offered;
2. remove use of `default_profile`, active-profile state, omitted `profile`
   inputs, natural-language server routing, and `sn_profile` add/switch/admin
   flows; every client call must send a valid named profile;
3. inventory named profiles and migrate stored credentials to secret-manager
   references or authenticated ciphertext with separately stored keys,
   explicitly including any manually authored legacy plaintext values;
4. explain that canonical `SN_*` names remain supported but no longer create an
   implicit call target;
5. call out policy-related breakages for arbitrary tables, sensitive tables,
   unrestricted field sets, unsupported filters, oversized pages/responses,
   raw encoded reads without explicit policy approval, all encoded write
   selection, and over-limit batch behavior;
6. replace generic `comments`/`work_notes` updates with the dedicated journal
   tools; and
7. distinguish standards-based client support from optional provider-specific
   validation paths.

The migration guide must provide enough mapping for an operator to identify
every affected V1 behavior. Exact commands, endpoint layout, authentication
syntax, numeric policy defaults, credential-provider syntax, and client
configuration examples are deferred to their delivery tickets and must match
the shipped implementation.

## V2 release gates derived from this decision

A V2 release is blocked until automated tests and release evidence establish
all of the following:

- only standard MCP Streamable HTTP starts; the stdio import, executable
  startup contract, compatibility path, and unrestricted mode are absent;
- initialization, discovery, and invocation work with standards-compliant HTTP
  clients, while any provider-specific tunnel test is supplemental;
- every tool input requires a non-empty explicit profile; missing and unknown
  profiles are proven to fail before handler/client access and side effects;
- deliberately interleaved calls across at least two profiles prove immutable
  request/execution scoping for clients, credentials, policy decisions, audit
  events, structured results, and profile-dependent caches, with no
  cross-profile contamination;
- every successful structured result and every audit event satisfies the
  resolved-profile contract;
- the universal policy is exercised for every registered tool/capability, and
  missing/invalid policy or unclassified operations fail closed;
- read/write allowlist separation, hard-deny precedence, safe field handling,
  structured filter validation, pagination/output/request/attachment/mutation
  bounds, and indirect-access denial have positive and negative tests;
- write tools always reject caller-supplied raw encoded-query input, and
  same-invocation or composed server-side operations cannot use that raw input
  or records or identifiers returned by executing it to select mutation
  targets; tests also prove that policy-approved, validated structured filters
  may be compiled into an internal or ServiceNow query representation only
  with all applicable write policy and bounds enforced; encoded reads remain
  disabled by default and succeed only for explicitly approved, bounded read
  tool/table pairs;
- generic updates reject journal fields and the dedicated comment/work-note
  tools have correct annotations and policy enforcement;
- no MCP tool can administer credentials/profiles or establish active/default
  routing state;
- persisted profile data and logs contain no plaintext secrets, encrypted
  values authenticate correctly, keys are separate, and secret/key failures
  fail closed;
- preserved `sn_*` names and canonical `SN_*` names have contract tests, with
  intentional breaks documented; and
- release notes and migration documentation cover the changes listed above.

## Consequences

### Positive

- One transport and one policy eliminate divergent local/remote security
  branches.
- Explicit profiles make routing observable and prevent cross-instance actions
  caused by mutable defaults or inference.
- Default denial, bounded reads, and the encoded-write prohibition reduce the
  blast radius of prompt injection, tool misuse, and policy mistakes.
- Provider-neutral Streamable HTTP preserves cross-platform MCP compatibility.

### Negative and intentional compatibility breaks

- V1 stdio client configurations stop working and require HTTP endpoint and
  owner-authentication configuration.
- Every tool caller must add `profile`; active/default profile workflows and
  MCP-based profile administration stop working.
- Previously valid broad table/field access, encoded batch updates/deletes,
  some encoded reads, generic journal updates, and oversized requests may be
  denied.
- Legacy plaintext profile credentials require explicit migration before V2
  can use those profiles.
- Implementations must maintain policy metadata, audit context, secret
  providers/encryption, and negative security tests.

### Performance

This ADR changes the normative contract only and introduces no runtime code or
measured performance result. It is therefore performance-neutral as an
authoring change. Later implementation tickets must keep policy evaluation
bounded and verify request/output limits and representative latency/throughput;
this ADR does not fabricate or pre-approve performance measurements.

## Alternatives rejected

- **Support both stdio and HTTP:** rejected because it preserves two lifecycle
  and security paths and invites an unrestricted compatibility mode.
- **Keep a trusted/local unrestricted mode:** rejected because deployment mode
  is not a reliable authorization boundary and contradicts universal default
  denial.
- **Keep default/active profile fallback:** rejected because routing becomes
  dependent on mutable process state and omitted inputs.
- **Permit encoded writes with confirmation or dry-run:** rejected because a
  raw selector remains difficult to bound and confirmation does not make the
  resulting mutation scope policy-safe.
- **Make provider integration part of the core:** rejected because standard
  MCP Streamable HTTP is the portability contract.

## Traceability

This ADR completes the decision-record deliverable for **SNSDK-15** under
**SNSDK-14**. Runtime implementation, exact policy values and schemas, HTTP
startup, profile context, tests, deployment, migration examples, and release
evidence remain the responsibility of their later roadmap tickets. Those
tickets may choose implementation details only within the normative boundaries
above; changing a boundary requires a superseding ADR and an approved product
decision.
