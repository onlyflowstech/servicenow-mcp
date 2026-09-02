# Production security boundaries

This document is the production boundary contract for the ServiceNow MCP V2
HTTP process. It supplements the container and profile-credential guides; it
does not turn the application into a TLS terminator, reverse proxy, firewall,
DNS policy engine, or secret manager.

The supported deployment is private and single-owner. No installation command,
startup mode, or container entry point creates a tunnel or public endpoint.
Public-tunnel products are not a production boundary and must not be started
automatically. Private ChatGPT connectivity is a separately validated adapter,
not an application startup side effect.

## TLS termination

The Node.js process serves HTTP/1.1 and does not terminate TLS. For every
non-loopback deployment, terminate TLS at an operator-managed reverse proxy,
load balancer, ingress, or private-access gateway with all of these properties:

- accept TLS 1.2 or TLS 1.3 only; prefer TLS 1.3 and disable TLS 1.0/1.1;
- use a certificate whose names match the advertised MCP authority, automate
  renewal, and alert before expiry;
- redirect cleartext public traffic to HTTPS or, preferably, do not expose a
  cleartext listener at all;
- forward upstream with HTTP/1.1 to a loopback or private listener; and
- protect the termination-to-process hop with loopback, a dedicated private
  network plus ingress policy, or authenticated encryption. A routable shared
  network is not an equivalent trust boundary.

TLS authenticates the endpoint; it does not replace `MCP_BEARER_TOKEN`.
Browser CORS and `Host` admission likewise do not authenticate a caller.

## Reverse proxy and client identity contract

There is deliberately no trusted-proxy mode in the application. It never uses
`Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`, or
`X-Forwarded-Proto` to determine identity, authority, scheme, or rate-limit
source. The application-level source is only the direct TCP peer reported by
`request.socket.remoteAddress`.

At the last trusted proxy hop:

1. Remove every inbound `Forwarded` and `X-Forwarded-*`/`X-Real-IP` value. Do
   not append an untrusted value and do not forward client-supplied identity
   headers to the MCP process.
2. Send exactly one `Host` header in a form listed in `MCP_ALLOWED_HOSTS`.
3. Enforce original-client IP allowlists, connection limits, and rate limits at
   the proxy. Behind a proxy, all application pre-authentication source limits
   intentionally see the proxy peer, not the original client.
4. Allow the proxy or orchestrator, and no other workload, to connect to the
   MCP listen port. Health endpoints are unauthenticated lifecycle signals and
   need the same network isolation.

Do not use a forwarded address in audit attribution. The authenticated
single-owner context comes from the operator-configured `MCP_OWNER_ID` and
`MCP_CLIENT_ID`; those non-secret identifiers are not accepted from request
headers.

### Exact `Host` behavior

Every request, including health and unknown routes, must contain exactly one
syntactically valid raw `Host` authority. Missing, duplicate, or malformed
values receive HTTP 400. A valid but unapproved authority receives HTTP 421
before routing, authentication, or body parsing.

`MCP_ALLOWED_HOSTS` is a comma-separated list of one to 128 exact authorities.
It supports no wildcard or suffix matching. Hostnames are normalized to lower
case and an optional terminal dot is removed, but ports remain part of the
contract. Configure the exact form the final proxy sends, for example
`mcp.example.com` and/or `mcp.example.com:443`; do not derive it from
`X-Forwarded-Host`. When `MCP_ALLOWED_HOSTS` is omitted, only authorities safely
derived from the bind address and accepted socket are allowed, which is not a
substitute for explicit configuration behind a proxy.

The reserved `mcp-health.internal` authority is accepted only on
`/health/live` and `/health/ready` from a loopback TCP peer. It never admits
`/mcp` and must not be added to `MCP_ALLOWED_HOSTS`.

### Exact `Origin` behavior

Non-browser clients may omit `Origin`. If present, there must be exactly one
HTTP(S) origin containing no credentials, path, query, or fragment. It must
exactly match an entry in `MCP_ALLOWED_ORIGINS`; otherwise the request receives
HTTP 400 for malformed input or HTTP 403 for an unapproved origin. There is no
wildcard or reflected-origin mode.

An MCP CORS preflight additionally requires `POST` and only the documented
request headers. CORS is a browser boundary, not authorization: the bearer
token remains required for the subsequent `/mcp` request.

## Secret injection and storage

Never put a bearer token, password, OAuth client secret, API key, profile
encryption key, ciphertext, or provider reference in an image layer, Dockerfile
`ARG`/`ENV`, committed manifest, command argument, shell history, diagnostic
bundle, or log field.

Inject secrets at runtime from the orchestrator or approved secret manager.
The built-in provider adapter reads canonical `SN_*` environment references;
an embedding deployment may supply another provider-neutral resolver. Restrict
secret-read permission to the runtime identity and scope each ServiceNow secret
to the profile that uses it. Treat process-environment and orchestrator
inspection permissions as secret-reading permissions.

Current profile administration writes only a structured secret reference or an
AES-256-GCM encrypted envelope. Read-compatible V1 `env:...` references may be
loaded and migrate to structured references on the next write; legacy plaintext
is rejected. Encrypted profile data lives in an owner-only directory/file
(`0700`/`0600` where POSIX permissions are available), and
`SN_PROFILE_ENCRYPTION_KEY` is injected separately. Do not store that key next
to the encrypted profile. Mount profile storage read-only for the serving
process unless a separate, tightly scoped administration job is actively
performing an out-of-band rotation.

Use `servicenow-mcp-profile create`, `rotate`, `inspect`, and `remove` for
profile administration. Protected values enter through non-echoed or bounded
standard input, never credential-bearing CLI options. The MCP `sn_profile`
tool is inspection-only and returns non-secret metadata.

### Rotation procedure

1. Create a replacement credential or encryption key in the authoritative
   secret system without revoking the old value.
2. Update the runtime secret reference, or use `servicenow-mcp-profile rotate`
   to atomically replace the encrypted envelope/reference. Keep the profile
   encryption key separate from both old and new profile files.
3. Roll or restart serving processes when an injected environment value or
   mounted profile file changes; the process does not promise live environment
   or file watching. Provider adapters may refresh in place only when their
   deployment contract explicitly guarantees it.
4. Verify authentication with the explicitly named profile, verify logs and
   diagnostics contain no protected value, then revoke the old credential.
5. Rotate `MCP_BEARER_TOKEN` by replacing the runtime secret and rolling all
   replicas as one controlled change. Do not accept both tokens indefinitely.

Application JSON-line events are designed to contain bounded identifiers,
outcomes, reasons, and latency—not request authorization, ServiceNow
credentials, profile references, ciphertext, or response bodies. Configure the
TLS proxy, orchestrator, and log collector to redact `Authorization`, cookies,
API-key headers, request/response bodies, environment dumps, and query strings.
Disable debug middleware that records complete headers or bodies. Redaction at
the application is not a reason to retain secret-bearing proxy access logs.

## Network and DNS boundaries

Application validation and infrastructure network policy are both required.
Use default-deny ingress and egress at the workload identity, namespace,
security-group, firewall, or service-mesh layer.

| Direction | Allow only | Deny or isolate |
| --- | --- | --- |
| Inbound to TLS edge | Approved private connector and operator/client networks on TCP 443 | Direct public access when the release is private; all other ports |
| Edge to MCP process | Exact proxy/orchestrator identities to the configured MCP port | Internet clients, peer workloads, and bypass routes around TLS/authentication |
| Lifecycle probes | Orchestrator/proxy to `/health/live` and `/health/ready` | Public health scraping and using health as an MCP access path |
| MCP to ServiceNow | TCP 443 to the exact approved instance origins for configured profiles | Cleartext HTTP, arbitrary internet destinations, and unapproved ServiceNow tenants |
| DNS | The designated recursive resolver(s), using only the transport the platform requires | Arbitrary external resolvers and workload-controlled DNS overrides |
| Optional dependencies | Explicit secret-provider or log-export endpoints required by the deployment | Cloud metadata, control-plane APIs, and unrelated internal services |

The client constructs ServiceNow API paths on the configured HTTPS origin.
Runtime-added profiles accept ServiceNow SaaS hostnames or an operator-set
`SN_ALLOWED_INSTANCE_HOSTS` entry. That variable is a hostname admission check
for runtime-added profiles only: operator-loaded profile files may intentionally
name other HTTPS origins, and neither path pins DNS answers or destination IPs.
It is not a firewall.

Constrain every DNS answer and redirect at the egress layer. Block loopback,
link-local (including cloud metadata), multicast, and private address ranges
unless an approved self-hosted ServiceNow deployment requires an exact range.
If private ServiceNow is required, allow the smallest stable hostname and CIDR
set, route it through controlled DNS, and review changes before deployment.
DNS policy must cover UDP and TCP resolution, or the platform's approved
encrypted resolver transport, so a fallback path cannot bypass the allowlist.

ServiceNow table allowlists are a separate application-data boundary.
Per-profile `tableAccess` rules authorize application data; `SN_ALLOWED_READ_TABLES`,
`SN_ALLOWED_WRITE_TABLES`, and `SN_TABLE_ACCESS_TARGETS` are mapped only into
the explicit `SN_PROFILE_NAME` environment profile when no profile file exists.
These rules do not grant network reachability. Conversely, network reachability
to an instance does not authorize a table or tool.

## Canonical deployment example

The following is a name-and-source map, not a file containing secret values.
Replace every angle-bracket entry through runtime secret/config injection.

```text
MCP_HOST=127.0.0.1
MCP_PORT=3000
MCP_ALLOWED_HOSTS=mcp.example.com,mcp.example.com:443
MCP_ALLOWED_ORIGINS=https://approved-browser.example
MCP_BEARER_TOKEN=<runtime-secret:MCP_BEARER_TOKEN>
MCP_OWNER_ID=owner-production
MCP_CLIENT_ID=private-mcp-client

SN_PROFILE_NAME=prod
SN_INSTANCE=https://acme.service-now.com
SN_AUTH_TYPE=oauth
SN_GRANT_TYPE=client_credentials
SN_CLIENT_ID=<runtime-config:ServiceNow-OAuth-client-id>
SN_CLIENT_SECRET=<runtime-secret:SN_CLIENT_SECRET>
SN_PROFILE_ENCRYPTION_KEY=<runtime-secret:SN_PROFILE_ENCRYPTION_KEY>
SN_ALLOWED_INSTANCE_HOSTS=acme.service-now.com
SN_ALLOWED_READ_TABLES=incident,problem,change_request
SN_ALLOWED_WRITE_TABLES=incident,change_request
SN_TABLE_ACCESS_TARGETS=<runtime-config:reviewed-target-catalog>
SN_METADATA_CACHE_TTL_MS=86400000
SN_METADATA_CACHE_TABLES=sys_glide_object,sys_dictionary,sys_db_object,sys_app,sys_plugins,sys_metadata*,sys_flow*
```

`sys_properties` is deliberately absent from that list. Rows in it are
ACL-restricted per user and routinely hold integration secrets in the `value`
column, and a cache hit is served without re-contacting ServiceNow, so the
caller's ACLs are not evaluated on the hit. Do not add it, and review any
table you do add against the same two questions: are its rows ACL-restricted
per user, and would a stale or cross-identity answer be a disclosure?

For a named profile, keep the secret out of JSON and reference the same
canonical runtime secret:

```json
{
  "version": 2,
  "profiles": {
    "production": {
      "instance": "https://acme.service-now.com",
      "authType": "oauth",
      "grantType": "client_credentials",
      "clientId": "configured-non-secret-client-id",
      "clientSecret": {
        "type": "secret_ref",
        "provider": "env",
        "reference": "SN_CLIENT_SECRET"
      }
    }
  }
}
```

## Denied exposure patterns

Do not approve a deployment that has any of these properties:

- the MCP listener, health endpoints, or a public tunnel are directly exposed
  to the internet;
- TLS below 1.2 is enabled, certificate validation is bypassed, or the
  termination-to-process hop crosses an untrusted network in cleartext;
- the proxy trusts or forwards caller-supplied forwarding/identity headers;
- wildcard `Host`, reflected/wildcard `Origin`, or CORS is treated as caller
  authentication;
- secrets are baked into an image or committed configuration, passed on a
  command line, colocated with an encryption key, or emitted to logs;
- unrestricted DNS/egress can reach arbitrary internet, metadata, loopback,
  link-local, or internal destinations; or
- `SN_ALLOWED_INSTANCE_HOSTS` or a table allowlist is represented as replacing
  infrastructure egress policy.

Before release, test the TLS policy externally, inspect the final proxy header
set, exercise rejected `Host`/`Origin` cases, verify direct access to the MCP
port is blocked, test approved and denied DNS/egress destinations, scan the
image and rendered deployment configuration for secrets, and perform a staged
credential rotation with redaction verification.
