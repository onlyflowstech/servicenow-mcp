# Mocked ServiceNow tool testing

SNSDK-54 provides one reusable test boundary for ServiceNow-backed MCP tools:

- `test/fixtures/mock-servicenow.ts` supplies a deterministic FIFO
  `ServiceNowOperations` facade and a connected in-memory MCP harness.
- `test/snsdk-54-tool-matrix.test.ts` exercises the representative read and
  controlled incident-write behavior matrix through the published registry.

This is deterministic mocked evidence. It does **not** prove network reachability,
OAuth or basic-auth configuration, instance ACL behavior, plugin availability, or
successful writes against a live ServiceNow instance. Live qualification remains a
separate release activity and must use a disposable authorized instance and records.

## Fixture contract

Create a FIFO operation fixture when a module-level test only needs the narrow
ServiceNow facade:

```ts
const fixture = createMockServiceNowFixture([
  {
    operation: "get",
    response: { result: { sys_id: "1234567890abcdef1234567890abcdef" } },
  },
]);

await fixture.operations.get("/api/now/table/incident/1234567890abcdef1234567890abcdef");
expect(fixture.calls).toEqual([{
  operation: "get",
  path: "/api/now/table/incident/1234567890abcdef1234567890abcdef",
}]);
fixture.assertConsumed();
```

Each step defines exactly one `response` or `error`. Operations must occur in
order. Exhaustion and operation mismatches fail with deterministic messages. Call
parameters, bodies, buffers, and options are copied before the configured outcome;
the exposed call list and object snapshots are immutable, and buffers are returned
as defensive copies. Proxies and accessor-backed call data are rejected without
invoking their traps.

Use `createMockServiceNowHarness` for registry-level tests. It connects the official
SDK client and server over the in-memory transport, installs the published modules,
resolves an explicit test profile, applies an issued incident table policy, records
safe audit envelopes, and exposes the same exact ServiceNow call ledger. A future
domain module can pass its own issued `tableAccess` and module catalog while keeping
the rest of the boundary unchanged.

## Reference behavior matrix

| Surface | Success behavior | Empty or selection behavior | Failure behavior | Exact upstream assertion |
| --- | --- | --- | --- | --- |
| `sn_query` | Filtered collection with profile, metadata, and pagination | Empty collection; ACL/policy denial before client | Validation, authorization, hostile upstream error | Table path and complete `sysparm_*` map |
| `sn_get` | One filtered record by canonical `sys_id` | Exact identifier produces `not_found` or `conflict` for zero or multiple matches | Timeout and rate limit with bounded retry metadata | Direct record path or bounded stable identifier query |
| `sn_create` | Controlled incident creation with filtered structured output | Invalid or disallowed field rejected before client | Safe normalized failure | Exact incident collection path and allowed body |
| `sn_update` | Controlled incident update with filtered structured output | Invalid value, journal field, or disallowed field rejected before client | Safe normalized failure | Exact canonical record path and allowed body |
| `sn_incident_add_comment`, `sn_incident_add_work_note` | Append-only comment and work-note operation envelopes | Content never appears in result or audit | Normalized upstream failure | Exact canonical incident path and one journal field |
| Shared registry | Strict input/output schemas and explicit annotations | Required profile on all reference tools | Correlation ID and issued audit category/retry metadata | No discovery-time profile, credential, client, or ServiceNow access |

The failure cases intentionally distribute authorization, validation, timeout,
rate-limit, upstream, and unissued-error behavior across representative tools. Tool
local suites can still test deeper branches without duplicating the full matrix.

## Adding a future domain module

1. Add the smallest ordered step sequence needed by the domain behavior.
2. Call the published tool through `createMockServiceNowHarness`; use the facade
   directly only for a deliberately module-local test.
3. Assert the complete path, parameter map, and write body. Finish with
   `assertConsumed()` so missing operations cannot pass silently.
4. Assert structured `profile`, `data`, and `metadata`, plus the issued audit
   outcome and correlation ID.
5. For expected platform failures, throw `createToolError` with the production
   category and bounded retry decision. For redaction canaries, throw an ordinary
   hostile `Error` and assert only the public MCP result and audit collection.
6. Never place real credentials, tokens, cookies, or live instance data in a
   fixture. A request ledger may intentionally contain a synthetic selector or
   journal canary for exact-call assertions, so do not include that private ledger
   in public failure-leak assertions.

Do not relax validation, table/field policy, annotations, error normalization, or
production request semantics to make a mocked case pass. A mismatch should expose
either an outdated test expectation or an implementation defect for review.
