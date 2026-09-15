# ATF workflow

The server exposes four ATF workflow tools alongside the legacy `sn_atf`
listing/results interface. Every call requires an explicit `profile`.

| Tool | Purpose |
| --- | --- |
| `sn_atf_readiness` | Check plugins, runner properties, permissions and optional suite dependencies |
| `sn_atf_author` | Create tests/suites, add memberships and typed steps |
| `sn_atf_run` | Submit a suite through CI/CD and optionally wait |
| `sn_atf_results` | Fetch results, read cached history and compare runs |

## Configure a PDI profile

Use the existing setup workflow to save PDI credentials; do not put passwords
in tool arguments. The authoring preset can be previewed before applying:

```sh
servicenow-mcp-setup grant --profile pdi --atf --dry-run
servicenow-mcp-setup grant --profile pdi --atf
```

Execution additionally requires `"atf": {"execute": true}` on the profile.
Script-step authoring separately requires `allowScriptSteps: true`. Both default
to false. Restart the MCP client after changing profile configuration.

Grant the selected tools their required read tables and fields. Readiness uses
`v_plugin`, `sys_properties`, `sys_atf_agent`, `sys_atf_test_suite`,
`sys_atf_test_suite_test`, `sys_atf_test`, `sys_atf_step` and
`sys_atf_step_config`; denied probes are reported as unverified.
Execution reads `sys_atf_test_suite` and the three result tables:
`sys_atf_test_suite_result`, `sys_atf_test_result`, `sys_atf_test_result_step`.
Results needs the three result tables, including for cached history.
Step authoring reads `sys_atf_step_config`, `var_dictionary`, and
`sys_variable_value` and writes `sys_atf_step` and `sys_variable_value`.
ServiceNow ACLs and CI/CD roles still apply.

## Check and run a suite

Call `sn_atf_readiness` with `{"profile":"pdi","suite_name":"Example suite"}`.
The verdict is `ready`, `blocked`, or `unverified`, with actionable checks.
A missing browser runner is normal for server-only suites. Readiness checks
configuration; it cannot guarantee successful execution.

Call `sn_atf_run` with:

```json
{"profile":"pdi","suite_name":"Example suite","wait":true,"timeout":300}
```

Use exactly one of `suite_name` or `suite_sys_id`. Names must resolve to one
active suite. `wait:false` returns submission identifiers immediately. Polling
backs off from 5 to 15 seconds and observes cancellation and the timeout.
A local timeout or cancellation does not cancel the ServiceNow run. Follow
returned IDs with `sn_atf_results`; avoid resubmitting an uncertain submission.
Single-test execution is not supported: add the test to a suite first.
Legacy `sn_atf run` and `run-suite` return migration guidance without execution.

## Results and history

Call `sn_atf_results` with `action:"get"` and exactly one `result_id` or
`progress_id`. Completed results show roll-up counts, duration and first failing
steps, including tests in nested suite results. CI/CD IDs must be verified
against the suite-result table before caching; unavailable mappings are reported.

For history use `action:"history"`, `suite_sys_id` (or `test_sys_id`) and
optional `limit` (default 10, maximum 100). For comparison use `action:"compare"`
and `suite_sys_id`; optional `result_id` and `previous_result_id` choose the two
runs. Otherwise the newest two cached runs are used. Comparison identifies new,
fixed, continuing and intermittent failures and duration regressions (default
threshold 20%, configurable with `regression_percent`). Comparisons only cover
visible cached test records. History and comparison make no ServiceNow requests.

The cache retains compact summaries, up to 1000 tests per run and 500 characters
of the first failure per test. Displayed execution detail is bounded to 100 test
summaries and 20 failures. History shows run summaries. Private cache storage,
retention and memory fallback are described in [profile configuration](PROFILE-CREDENTIALS.md#atf-authoring-and-result-cache).
Failure text is untrusted instance content.

## Author typed steps

Create a test with `sn_atf_author`:
`{"profile":"pdi","action":"create_test","name":"Example"}`.
Use `list_step_types` to obtain the supported catalog and input schemas. Supply
`add_steps`, the created `test_sys_id`, and an ordered `steps` array with
`type` and `inputs` for each step. Inputs use JSON booleans/numbers where the
catalog specifies them. Up to 50 steps can be authored per call.

All input schemas and field grants are checked before writes. The server then
verifies each configuration and input definition against the instance, scopes
input values to each new step, and verifies the stored values. Unknown step
configurations and metadata mismatches fail closed. Rollback only targets rows
created during that invocation; inspect `outcome`, `rolled_back`,
`rollback_failed`, and `uncertain_insert` before retrying.

The catalog supports 13 step types; executable script steps require the
separate grant. Nonempty `simple_name_values` inputs (such as REST headers and
query parameters) are rejected until their instance encoding is verified.
These features have automated mocked coverage. PDI validation is still required
for the installed ServiceNow release, plugins, roles and catalog definitions.
