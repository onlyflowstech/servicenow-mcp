# Production container deployment

The SNSDK-39 artifact is a portable OCI image for the HTTP-only, single-owner
ServiceNow MCP service. It is not coupled to ChatGPT, Claude, or another AI
host: any standards-compliant MCP client uses the same authenticated `/mcp`
URL without rebuilding the image.

This document covers the artifact boundary. TLS termination, trusted proxies,
network topology, full operational response, and provider-specific tunnel or
secret-manager adapters remain separate deployment concerns.

## Artifact contract

The root `Dockerfile` uses an immutable Node 22.21.1 multi-architecture index
for its discarded build stage and an immutable distroless Node 22 Debian 13
multi-architecture index for runtime. The build stage performs `npm ci` from
the lock file with strict Node-engine enforcement, compiles TypeScript, and
prunes development dependencies. The runtime has no shell or package manager
and contains only the Node runtime,
compiled service, production dependencies, package metadata, and the
dependency-free healthcheck.

The resulting image:

- runs as numeric UID/GID `10001:10001`;
- starts Node directly as PID 1 and handles `SIGTERM`/`SIGINT` through the
  application's bounded drain and shutdown coordinator;
- listens on `0.0.0.0:3000` inside the container;
- exposes `/mcp`, `/health/live`, and `/health/ready`;
- has an OCI version, revision, creation time, source, license, and pinned-base
  label;
- contains no profile configuration, bearer token, ServiceNow credential,
  encryption key, provider credential, dotenv file, or local Git data; and
- is validated with a read-only root filesystem, all Linux capabilities
  dropped, `no-new-privileges`, a PID limit, and a bounded `/tmp` tmpfs.

The image does not contain TLS, tunnel, gateway, or cloud secret-manager
logic. Attach those as independently reviewed deployment adapters.

## Deterministic local build

Docker with BuildKit/buildx is required. The default local tag is derived from
`package.json`; a supplied version cannot differ from the package version.
The build does not invoke Git. Release automation must pass the immutable
source revision explicitly.

```sh
SOURCE_DATE_EPOCH=0 \
MCP_CONTAINER_REVISION=release-source-revision \
npm run container:build
```

PowerShell on Windows uses the same platform-neutral Node hook:

```powershell
$env:SOURCE_DATE_EPOCH = "0"
$env:MCP_CONTAINER_REVISION = "release-source-revision"
$env:MCP_CONTAINER_PLATFORM = "linux/amd64"
npm run container:build
```

Docker Desktop on macOS/Windows builds the Linux OCI target; native Linux uses
Docker Engine or another BuildKit-compatible frontend. The hook never invokes
a POSIX shell, Git, or a client-specific command.

Optional settings are:

| Setting | Default | Contract |
|---|---|---|
| `MCP_CONTAINER_IMAGE` | `servicenow-mcp:<package version>` | Local image name/tag; never a credential-bearing value. |
| `MCP_CONTAINER_REVISION` | `local` | OCI source-revision label. Release builds supply an immutable revision. |
| `MCP_CONTAINER_PLATFORM` | Docker's active Linux platform | `linux/amd64` or `linux/arm64`. |
| `MCP_CONTAINER_NO_CACHE` | `0` | Set to `1` for an independent BuildKit execution during reproducibility evidence. |
| `SOURCE_DATE_EPOCH` | `0` | Bounded Unix timestamp used by BuildKit and the OCI creation label. |

Reproducibility is an evidence gate, not an assumption. Build twice from the
same source, lock file, platform, revision, and epoch, then compare the image
IDs:

```sh
MCP_CONTAINER_NO_CACHE=1 npm run container:build
docker image inspect servicenow-mcp:1.2.0 --format '{{.Id}}'
MCP_CONTAINER_NO_CACHE=1 npm run container:build
docker image inspect servicenow-mcp:1.2.0 --format '{{.Id}}'
```

A differing ID blocks release until the changed input is identified. A pinned
multi-architecture index makes each target architecture stable, but amd64 and
arm64 images correctly have different image IDs.

## Runtime configuration boundaries

The only values baked into the image are non-secret runtime defaults:
`NODE_ENV=production`, `MCP_HOST=0.0.0.0`, `MCP_PORT=3000`, and the non-root
home directory. Supply every owner identity, bearer token, ServiceNow setting,
profile, key, and provider credential at runtime.

### Secret-managed `SN_*` profile

The simplest portable deployment injects the documented `SN_*` variables from
the orchestrator's secret mechanism. `SN_PROFILE_NAME` creates the explicit
process-local mapping; calls pass that exact name and no default is inferred.

```text
MCP_BEARER_TOKEN=<32-4096-character owner bearer secret>
MCP_OWNER_ID=<stable non-secret owner id>
MCP_CLIENT_ID=<stable non-secret client id>
SN_PROFILE_NAME=prod
SN_INSTANCE=https://instance.service-now.com
SN_USER=<integration account>
SN_PASSWORD=<injected ServiceNow secret>
```

`SN_PROFILE_NAME` is the explicit name callers must pass as `profile`; without
it, bare connection variables create no profile. `SN_AUTH_TYPE=oauth` plus `SN_CLIENT_ID`/`SN_CLIENT_SECRET`, or
`SN_AUTH_TYPE=apikey` plus `SN_API_KEY`, are supported alternatives. Inject
these through the container platform, never as `docker build` arguments,
Dockerfile `ENV`, labels, image annotations, or source files. Environment
injection is visible to operators with container-inspection authority, so that
authority is part of the secret boundary.

### Encrypted or provider-referenced profile mount

For named profiles, prepare an owner-only host directory with this layout:

```text
runtime-home/                         uid 10001, mode 0700
└── .servicenow-mcp/                 uid 10001, mode 0700
    └── config.json                  uid 10001, mode 0600
```

Mount `runtime-home` read-only at `/home/servicenow-mcp`. The profile loader
opens the file without following symlinks, verifies regular-file type,
ownership, modes, size, and stable parent/final identities, and can read an
already-secure file from a read-only mount without attempting to rewrite its
modes. Broken/final/parent symlinks are fatal and never trigger `SN_*` fallback.

Encrypted envelopes require `SN_PROFILE_ENCRYPTION_KEY` to be injected
separately at runtime. Secret references require the corresponding
deployment-provided resolver credential and adapter. Neither the key nor
provider credential belongs in `config.json` or the image. See
[Profile credentials and out-of-band administration](PROFILE-CREDENTIALS.md).

POSIX ownership checks make this bind-mount form most direct on Linux. Docker
Desktop on macOS/Windows may not preserve numeric bind-mount ownership; use the
orchestrator's secret environment injection or a Linux-managed volume prepared
with UID/GID 10001 rather than weakening file validation.

## Least-privilege run example

Create an owner-only runtime environment file outside the repository, populate
it from a secret manager, and remove it after the container platform has read
it. The values below are placeholders only:

```sh
docker run --detach \
  --name servicenow-mcp \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=128 \
  --memory=512m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=1700 \
  --publish 127.0.0.1:3000:3000 \
  --env-file /protected/path/servicenow-mcp.env \
  servicenow-mcp:1.2.0
```

For a named-profile mount, add:

```sh
--mount type=bind,src=/protected/runtime-home,dst=/home/servicenow-mcp,readonly
```

Do not publish port 3000 directly to an untrusted network. Bind it to loopback
or a private boundary and configure exact `MCP_ALLOWED_HOSTS` and, for browser
clients, `MCP_ALLOWED_ORIGINS`. TLS and proxy policy are tracked separately by
SNSDK-40.

## Health and shutdown

The OCI healthcheck makes an unauthenticated, bounded loopback request to
`GET /health/ready` with the reserved `Host: mcp-health.internal` authority and
requires exactly `200 {"status":"ready"}`. The request boundary accepts that
authority only for `/health/live` and `/health/ready` when the socket peer is
loopback; it is rejected for `/mcp` and for external peers. Do not add it to
`MCP_ALLOWED_HOSTS`. This keeps the internal probe working when public clients
use an unrelated exact authority such as `mcp.example.com:443`, without
broadening the public Host allowlist. It never contacts ServiceNow or
constructs an MCP server. Use:

```sh
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

Liveness means the process can serve local HTTP. Readiness remains false until
startup completes and flips false synchronously when draining begins. Configure
the platform termination grace period to exceed `MCP_SHUTDOWN_GRACE_MS`
(default 10 seconds). `docker stop` sends the image's `SIGTERM`; Node is PID 1,
stops admission, drains accepted work to the bound, closes MCP resources and
sockets, and exits zero on success.

## Validation, identity, provenance, and scanning

Build and validate the local artifact:

```sh
npm run container:build
npm run container:validate
npm run container:scan
npm audit --omit=dev
```

`container:validate` inspects the image and starts it with the least-privilege
flags above. It proves numeric non-root execution, writable bounded `/tmp`, a
read-only root, liveness/readiness, two independent MCP clients against the
same `/mcp` endpoint, clean `SIGTERM`, secret-free logs, required labels, and a
300 MiB image-size ceiling. It prints sanitized timing and size evidence.

`container:scan` selects Trivy, Grype, or Docker Scout (or honors
`MCP_CONTAINER_SCANNER`) and fails on high or critical findings. If none is
installed, it fails: scanner absence is never a passing release result. Owners
must archive the scanner name/version, database timestamp, image digest, and
result with release evidence. The application `npm audit --omit=dev` gate is
separate and includes moderate production dependency findings.

If a local scanner is unavailable, Linux and Docker Desktop operators can run
the same fail-closed gate with the pinned Trivy container (the digest prevents
an unreviewed scanner substitution):

```sh
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:0.67.2@sha256:e2b22eac59c02003d8749f5b8d9bd073b62e30fefaef5b7c8371204e0a4b0c08 \
  image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --no-progress \
  servicenow-mcp:1.2.0
```

Create a local multi-platform OCI archive with maximum BuildKit provenance and
an SBOM attestation:

```sh
MCP_CONTAINER_REVISION=release-source-revision \
SOURCE_DATE_EPOCH=0 \
npm run container:provenance
```

The hook refuses to overwrite output and writes only a new
`artifacts/servicenow-mcp-<version>.oci.tar`. Keep provenance and SBOM attached
when a separately authorized release process later imports or publishes it.
This task does not publish to a registry.

`artifacts/` must be a real owner-only directory beneath the canonical
repository path, not a symlink. BuildKit writes into a validated owner-only
`0700` operating-system temporary directory. Publication opens the resulting
regular archive without following symlinks and validates that held descriptor
against the staged path. It opens the canonical final name directly with
`O_CREAT|O_EXCL|O_NOFOLLOW` and mode `0600`. The held staged descriptor is the
only read authority and the held final descriptor is the only write authority
while exact bytes are copied, flushed, and verified by descriptor size and
identity. Parent and final-path identities are checked before success. A
concurrent file or symlink at the requested name causes failure without
overwrite, and a safely verifiable partial destination is removed on an
ordinary build error. Parent or path swaps are detected and never turn
attacker-controlled content into a successful artifact.

Direct exclusive creation deliberately does not promise rename-style atomic
visibility: the final pathname exists while bytes are copied, and an
unrecoverable process or host crash can leave an incomplete `0600` file. Treat
the build command's successful exit as the publication commit point. After a
crash, inspect and remove the incomplete named artifact before retrying. This
tradeoff avoids using any validated pathname as a later hard-link source
authority.

The runtime payload normalizes file timestamps to `SOURCE_DATE_EPOCH`; repeated
no-cache local builds with identical inputs therefore produce the same platform
manifest digest. The local validation build disables BuildKit's implicit,
time-varying attestation. The provenance build explicitly adds a fresh maximum
provenance statement and SBOM, so compare its platform manifest digest—not the
outer attestation index—when verifying payload reproducibility.

Inspect owner-visible identity without starting the image:

```sh
docker image inspect servicenow-mcp:1.2.0 \
  --format '{{index .Config.Labels "org.opencontainers.image.version"}} {{.Id}}'
```

Changing an AI client changes only client configuration: the HTTPS MCP URL and
bearer token. It never changes the image build inputs.
