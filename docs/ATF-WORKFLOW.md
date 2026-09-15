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
`v_plugin`, `sys_properties`, `sys_scope`, `sys_atf_test_suite`,
`sys_atf_test_suite_test`, `sys_atf_test`, `sys_atf_step` and
`sys_atf_step_config`; denied probes are reported as unverified.
Execution reads `sys_atf_test_suite` and the three result tables:
`sys_atf_test_suite_result`, `sys_atf_test_result`, `sys_atf_test_result_step`.
Results needs the three result tables, including for cached history.
Step authoring reads `sys_atf_test`, `sys_atf_step`, `sys_atf_step_config`,
`var_dictionary`, `sys_variable_value`, and `sys_element_mapping`. Its write plan
requires `sys_atf_step`, `sys_variable_value`, and `sys_element_mapping`.
ServiceNow ACLs and CI/CD roles still apply.

## Check and run a suite

Call `sn_atf_readiness` with `{"profile":"pdi","suite_name":"Example suite"}`.
The verdict is `ready`, `blocked`, or `unverified`, with actionable checks.
Execution is cloud-only: every submission sends `run_in_cloud=true` to ServiceNow.
UI tests use ServiceNow Cloud Runner; no local browser tab is opened or required.
Configure the ServiceNow ATF Test Generator and Cloud Runner app (`sn_atf_tg`)
and its cloud user before running. There is no manual/local runner fallback.
Readiness checks installation; it cannot guarantee cloud provisioning or successful execution.

Call `sn_atf_run` with:

```json
{"profile":"pdi","suite_name":"Example suite","wait":true,"timeout":300}
```

`run_in_cloud` defaults to `true` and rejects `false`.

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
`{"profile":"pdi","action":"create_test","name":"Example","application_scope":"global"}`.
Use `list_step_types` to obtain the supported catalog and input schemas. Supply
`add_steps`, the created `test_sys_id`, and an ordered `steps` array with
`type` and `inputs` for each step. Inputs use JSON booleans/numbers where the
catalog specifies them. Up to 50 steps can be authored per call.

All input schemas and field grants are checked before writes. The server then
verifies each configuration and input definition against the instance, scopes
input values to each new step, and verifies the stored values. Unknown step
configurations and metadata mismatches fail closed. Rollback only targets rows
created during that invocation, including mapping rows that do not cascade; inspect `outcome`, `rolled_back`,
`rollback_failed`, and `uncertain_insert` before retrying.

The catalog supports 13 step types; executable script steps require the
separate grant. REST headers and query parameters accept a JSON object mapping
names to string values. JSON element assertions use slash-separated paths, such
as `result/number` or `error/message`, rather than JSONPath dot notation.
Inbound REST requests use their own ATF request
authentication; the MCP OAuth token is not copied into test steps.

Step inputs are saved through ServiceNow's authenticated native ATF form. The
server parses HTML as data, verifies the test/configuration/scope, and sends only
requested input controls with the form token and temporary session cookies.
It requires neither a browser inspector nor an installed scoped application,
and makes no ACL changes. Parent-step write permissions and all MCP table/field
grants still apply. Native form contracts can vary by ServiceNow version;
unrecognized forms fail closed and trigger bounded cleanup of newly created steps.

Reference and document inputs can use `{{step['<32-character-step-id>'].first_record}}`.
The source must be an earlier active step in the same test and expose the named
output. The server saves the native mapping and verifies both the mapping and
ordinary input value. Create the source step first to obtain its ID, then add
the dependent step with a higher `start_order`. Steps inherit the test's scope;
use `application_scope:"global"` when creating Global tests and suites.
