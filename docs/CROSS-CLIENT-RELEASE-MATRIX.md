# Cross-client protocol release matrix

This is the release contract for the HTTP MCP surface. A release must expose
one immutable server artifact at `/mcp` and pass the same contract through both
the official Model Context Protocol SDK client and an independent Fetch
JSON-RPC client. The required production catalog contains exactly 19 tools.
User-facing configuration and examples for both clients are in
`docs/CLIENT-SETUP.md`.

The core gate is deterministic and local. It never contacts ServiceNow, never
uses a live credential, and does not depend on a provider tunnel. Private
ChatGPT tunnel validation is a separate, optional provider integration check;
it cannot replace this protocol gate. The packaged server has no stdio
transport.

## Release matrix

| Contract | Required evidence | Blocking evidence |
| --- | --- | --- |
| One artifact and endpoint | Both clients initialize, list, and invoke the same runtime at `/mcp`; the container check repeats discovery against one image ID | `test/snsdk-55-release-matrix.test.ts`, `scripts/container-validate.mjs` |
| Exact discovery parity | Both clients return the same sorted 20 tool names, input schemas, output schemas, and annotations; every input schema requires non-empty `profile` | `test/snsdk-55-release-matrix.test.ts`, `test/http-cross-client.test.ts`, `scripts/container-validate.mjs` |
| Profile boundary | Missing and unknown profiles fail before configuration or client construction; `sn_profile` succeeds without ServiceNow access or secret disclosure | `test/snsdk-55-release-matrix.test.ts`, `test/http-cross-client.test.ts`, `scripts/container-validate.mjs` |
| Selected-instance isolation | Crossed read/write calls from both clients bind only to the selected profile's fake ServiceNow adapter | `test/snsdk-55-release-matrix.test.ts`, `test/execution-context.test.ts` |
| Representative read and controlled write | Each client executes `sn_query` and the dedicated append-only incident journal tool against local fakes | `test/snsdk-55-release-matrix.test.ts`, `test/http-cross-client.test.ts` |
| Structured result and audit | Successful results and audit records contain the resolved profile and canonical instance while excluding credentials | `test/snsdk-55-release-matrix.test.ts`, `test/http-cross-client.test.ts` |
| Authentication and negotiation | Authentication precedes request parsing/server construction; Accept, Content-Type, protocol-version, origin, host, and CORS rules fail closed | `test/http-auth.test.ts`, `test/http-request-policy.test.ts`, `test/http-runtime.test.ts`, `test/http-cross-client.test.ts` |
| Malformed and batch requests | Invalid JSON, unsupported protocol versions, and JSON-RPC batch behavior are deterministic for the HTTP surface | `test/http-cross-client.test.ts`, `test/http-runtime.test.ts` |
| Cancellation and deadlines | Client abort, body/auth/parser/tool deadlines, and hung factories release their resources | `test/http-request-policy.test.ts`, `test/http-runtime.test.ts` |
| Concurrency, admission, and rate limits | Concurrent request IDs remain isolated; admission and identity/pre-auth rate limits fail closed and recover capacity | `test/http-runtime.test.ts`, `test/http-entrypoint.test.ts` |
| Drain and shutdown | Readiness changes during drain, accepted requests complete within grace, forced close is bounded, and SIGINT/SIGTERM are clean | `test/http-health.test.ts`, `test/http-runtime.test.ts`, `test/http-cross-client.test.ts`, `test/http-entrypoint.test.ts`, `scripts/container-validate.mjs` |

## Commands and release interpretation

Run the focused portable protocol gate while developing protocol changes:

```bash
npm run test:protocol
```

Pull-request CI runs `npm test`, which includes every file in the focused gate
and the SNSDK-55 matrix. CI intentionally does not invoke `test:protocol` a
second time, so the same expensive suites are not duplicated. A failure in any
matrix row therefore blocks the ordinary release pipeline.

Before publishing the production image, build it once and validate that same
tag without replacing or restarting it between clients:

```bash
npm run container:build
npm run container:validate
```

The container validator uses a synthetic local profile. `sn_profile`, missing
profile, and unknown profile calls are safe because they must finish before a
ServiceNow client or outbound request exists. The validator compares a
canonical projection of every name, input schema, output schema, and annotation
returned to both clients, and it fails if a bearer token or configured secret
appears in results or logs.

Provider-tunnel evidence belongs to the private-connectivity procedure in
`docs/PRIVATE-CHATGPT-CONNECTIVITY.md`. That procedure may be required by a
specific hosted integration, but is not portable and is not part of this local
release matrix.
