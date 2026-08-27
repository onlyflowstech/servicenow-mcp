# Client-safe error contract

Every ServiceNow MCP tool exposes one of eight stable error categories. The
server owns all public message and retry text. Exception messages, ServiceNow
response bodies, URLs, encoded queries, headers, credentials, secret
references, ciphertext, and sensitive record fields are never copied into a
tool error.

| Category | Fixed public meaning | Default retry decision |
| --- | --- | --- |
| `authentication` | ServiceNow authentication could not be completed. | `retry_after_correction` |
| `authorization` | ServiceNow access was denied. | `retry_after_correction` |
| `not_found` | The requested ServiceNow resource was not found. | `do_not_retry` |
| `conflict` | ServiceNow reported a conflicting resource state. | `retry_after_correction` |
| `rate_limit` | ServiceNow rate limit was exceeded. | `retry_later` |
| `timeout` | The ServiceNow request timed out. | `retry_if_safe_and_idempotent` for safe operations; otherwise `do_not_retry` |
| `upstream` | ServiceNow could not complete the request. | `retry_if_safe_and_idempotent` for safe operations; otherwise `do_not_retry` |
| `internal` | The operation failed unexpectedly. | `do_not_retry` |

`retry_later` may include a whole-second `Retry-After` value. The value is
validated and capped at one hour before it becomes caller-visible. A caller
must still respect the tool's idempotency and confirmation rules.

The public category is not inferred from arbitrary exception fields or text.
Only errors issued by the server's private structural error contract retain a
category; every other thrown value maps to `internal`. This prevents hostile
objects from forging an authentication, authorization, or retryable error.

Credential resolution and authentication intentionally have the same public
`authentication` result. In particular, a caller cannot distinguish a missing
environment/provider reference, an unavailable decryption key, invalid
ciphertext, an incorrect credential, or a final ServiceNow HTTP 401 response.
Operator diagnostics use bounded reason codes and correlation IDs, never raw
secret material.

At the MCP callback boundary, every category result ends with the request's
correlation ID. A handler-thrown trusted error keeps its issued category and
retry decision. An arbitrary throw, an `isError` handler return, or malformed,
accessor-backed, Proxy, cyclic, or oversized handler output becomes the fixed
`internal` / `do_not_retry` result. The boundary checks authoritative request
cancellation before inspecting any completed handler output. Successful
handlers must return exactly one plain text content block plus their declared
structured output; handler `_meta`, extra top-level fields, alternate content
blocks, and explicit `isError: false` are rejected rather than forwarded.

When a read-only tool aggregates several independent ServiceNow reads and all
of them fail, a unanimous trusted category and retry decision is preserved. A
mixed failure set deterministically becomes `internal` / `do_not_retry`.
Non-idempotent ATF execution never tries another POST after a timeout, network,
upstream, authorization, or otherwise ambiguous failure. It uses an alternate
endpoint only after a privately issued `not_found` response proves the prior
endpoint did not execute the request.

Configuration errors discovered before the HTTP service becomes ready remain
process-startup failures. The entrypoint emits a fixed fatal message without
configuration values. Errors discovered for a selected profile during a tool
request use the contract above and include the request's correlation ID.
