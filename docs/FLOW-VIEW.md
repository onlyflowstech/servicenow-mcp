# Viewing Flow Designer flows

`sn_flow_view` shows one Flow Designer flow or subflow: its trigger, steps,
branches, loops, error handling and the subflows it calls. It is read-only and
reads only through the Table API. Every call requires an explicit `profile`.

```json
{ "profile": "pdi", "flow": "Route new incidents", "depth": 2 }
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `flow` | required | A 32-character sys_id, or the flow's exact, case-sensitive name (at most 100 characters). A name that matches more than one flow fails with a conflict: pass the sys_id instead. |
| `depth` | `1` | `1` shows this flow only. `2` or `3` also expand the subflows it calls, and theirs. |
| `include_inputs` | `true` | Show step input values. `false` requests no value field from the instance at all. |
| `format` | `both` | Text output: `both`, `mermaid` or `outline`. The structured graph is always complete. |
| `max_nodes` | `150` | Most graph nodes returned, 10 to 300, counting the trigger. Steps past the limit collapse into one "more" node. |
| `max_response_bytes` | `100000` | Byte budget for the whole result, 10,000 to 1,000,000. |

## What it returns

- **`structuredContent.data`** is the flow graph: flow headers (root first,
  then each expanded subflow), the trigger, nodes, typed edges (`next`,
  `true`, `false`, `loop_body`, `loop_back`, `parallel`, `error`, `subflow`),
  data pills, flow variables, the limits that were hit and fixed-vocabulary
  warnings. Node ids are generated (`n0` is the trigger), never instance
  data.
- **The text** holds a headline, a summary table, a Mermaid `flowchart TD`
  diagram and a numbered outline in an untrusted-content block.

Branches are drawn the way Flow Designer stores them. The `false` edge of an If
or Else If enters the next Else If or the Else node, which then leads into its
own steps. A Try or Top Level Try has an `error` edge into its Catch node. An
expanded subflow is numbered under its call site (a call at step `3` has steps
`3.1`, `3.2`, …), its node `depth` counts from its own top level, and the
outline indents it one level below the call.

Flow names, step labels and values are untrusted instance text. Mermaid labels
are entity-encoded into a closed alphabet, the diagram is built from a fixed
line grammar, and input values never appear in it. The outline flattens each
value to one line, so instance text cannot forge outline lines.

## Granting access

A profile with no table rules denies every tool call. `sn_flow_view` needs
**read on all 15 tables** below, all or nothing, and each table's target must
list `sn_flow_view` in its `tools`, unless the read allowlist is `"*"`:

`sys_hub_flow`, `sys_hub_flow_snapshot`, `sys_hub_trigger_instance`,
`sys_hub_trigger_instance_v2`, `sys_hub_action_instance`,
`sys_hub_action_instance_v2`, `sys_hub_flow_logic`,
`sys_hub_flow_logic_instance_v2`, `sys_hub_sub_flow_instance`,
`sys_hub_sub_flow_instance_v2`, `sys_hub_flow_variable`, `sys_hub_flow_input`,
`sys_hub_flow_output`, `sys_variable_value`, `var_dictionary`.

The setup CLI grants exactly that, bound to `sn_flow_view` alone:

```sh
servicenow-mcp-setup grant --profile pdi --flows --dry-run
servicenow-mcp-setup grant --profile pdi --flows
```

`--flows` adds to existing rules. A table that another grant already binds,
such as `sys_variable_value` and `var_dictionary` under `--atf`, keeps its
other tools and gains `sn_flow_view`. No write access is ever granted. Restart
the MCP client after a profile change.

To write the rules by hand, give each table a target like this one:

```json
{ "table": "sys_hub_flow", "kind": "canonical", "tools": ["sn_flow_view"],
  "closureComplete": true, "relatedTables": ["sys_hub_flow"] }
```

Binding these targets to `sn_flow_view` only keeps `sn_query`, `sn_get` and the
other generic tools off the flow tables, which hold scripts and configuration.

On the instance, the profile's user also needs ServiceNow read access to the
same tables. Every reported read so far ran as `admin`. Whether a non-admin
role can read `var_dictionary` and `sys_variable_value` through their ACLs is
not yet confirmed.

## Field policy

Each part of the graph is read from known `(table, field)` pairs, and it is
shown only when **every** pair it comes from is readable, across both storage
formats. The same profile therefore shows the same parts whether a flow is
stored in the older (V1) tables or the `_v2` tables.

Structural fields are required. If a profile's field policy hides one, the
whole call is denied with a message naming the table and field:

| Table | Required fields |
| --- | --- |
| `sys_hub_flow` | `sys_id`, `name`, `type` |
| `sys_hub_flow_snapshot` | `sys_id`, `parent_flow` |
| trigger tables | `sys_id`, `flow` |
| action and subflow tables | `sys_id`, `flow`, `order`, `ui_id`, `parent_ui_id` (subflow tables also `subflow`) |
| logic tables | the step fields plus `logic_definition`, `connected_to` |
| flow variable, input and output tables | `sys_id`, `model`, `element` |
| `sys_variable_value` | `sys_id`, `document`, `document_key`, `variable` |
| `var_dictionary` | `sys_id` |

Everything else is optional and simply hidden when unreadable. The switches
that matter most:

| To hide | Make unreadable |
| --- | --- |
| All input values | Any one of `sys_hub_trigger_instance_v2.trigger_inputs`, `sys_hub_action_instance_v2.values`, `sys_hub_flow_logic_instance_v2.values`, `sys_hub_sub_flow_instance_v2.subflow_inputs` hides that kind of value; `sys_variable_value.value`, `var_dictionary.element` or `var_dictionary.internal_type` hides every kind. Or pass `include_inputs: false`. |
| Data pill labels | `sys_hub_flow.label_cache` (pills then show their raw `{{token}}`) |
| Step annotations | `comment` on the action, logic or subflow tables |
| Flow description | `sys_hub_flow.description` |
| Flow variables, inputs, outputs | `element`, `label` or `internal_type` on the matching table |

Regardless of policy, an input is redacted when its name or label looks
sensitive (the same check as everywhere else in the server, applied to
camelCase and spaced forms such as `clientSecret` and `API Key`) or its type
is `password`, `password2`, `masked` or `encrypted_text`. Script inputs are
shown as their first line in the outline; the structured graph keeps at most
2,000 characters of any value.

### Caveats

- **`sys_variable_value` is a system table.** A profile's `"*"` field-policy
  entry does not reach it, so it is not narrowed unless you name it. The ATF
  tools read it too. To hide older (V1) flows' input values, name it:
  `"sys_variable_value": { "readable": ["sys_id", "document", "document_key", "variable", "order"] }`.
- **`var_dictionary` is needed for V1 values.** `sys_variable_value` has no
  input type, so without `var_dictionary.internal_type` a V1 `password2`
  value could be recognized only by its name. Both `element` and
  `internal_type` are in the sources of every input value, so hiding either
  hides all input values (fail closed); the call itself still succeeds.
  `var_dictionary` is not a system table, so a `"*"` entry narrows it.
- Logic step titles come from the logic definition's English display name.
  A session in another language shows those steps as generic steps with an
  "unknown logic type" warning.

## Why it never calls Flow Designer's internal API

Flow Designer has an internal REST API (`/api/now/processflow/...`) that
returns a whole flow in one call. `sn_flow_view` never calls it. Its flow GET
is not read-only: on a developer instance it created a Workflow Studio history
(version) record for the flow and linked the flow to it. That most likely
happens once per flow that has no history yet, but a tool that declares
`readOnlyHint: true` must not change the instance at all, and the API is
undocumented and can change in any release.

Everything the view needs is in the Table API: the step tables, the
compressed input values (decoded with bounded gzip), `sys_variable_value` for
older flows and `sys_hub_flow.label_cache` for pill labels. Each read goes
through the same table and field policy as any other tool, and the code never
requests the flow version table. Tests assert that no `processflow` path is
ever requested.

## Limits and size

| Limit | Value |
| --- | --- |
| Subflows expanded per call | 8 |
| Response scopes per call | 12 (each holds at most 1 MiB of instance JSON): 2 for the root, 1 per subflow, the rest for retries without input values |
| Rows read per table and flow | 500 |
| Logic nesting levels | 16 |
| Inputs per step | 40 |
| Characters per value (structured) | 2,000 |
| Edges | 600 |

Each flow is read in one or two batches of requests issued together; the
server sends at most four requests to an instance at a time. Compressed input
values are read in their own requests without display values, which would
repeat them. The root flow's record lookup and its load each run in their own
response scope, and each subflow (its record and its load) runs in its own;
the subflows of one level load together.

When a flow is too large for its scope with its input values, it is read
again without them, in a new scope while any remain, and the result carries
the warning that input values were left out. A root flow too large even
without input values is shown as its record only, with a warning; it does not
fail the call. A subflow that cannot be loaded (missing, denied or too large)
is marked on its call site and never fails the call.

Older (V1) steps keep their values in `sys_variable_value`. Those reads are
paged past the 500-row cap, up to 40 values per step (the most a step shows);
if a step stores more, the result says its inputs may be incomplete.

The result fits `max_response_bytes`. The graph gets about 55% of it and is
reduced in fixed steps when needed: values cut to 500 then 120 characters,
then values dropped, then descriptions, annotations and conditions cut to 200
characters, then steps halved behind a "more" node, then pills and variables
dropped. The text gets the rest: diagram and full outline, then a shortened
outline, then the outline alone, then the summary table. Every reduction is
reported in `limits_hit`.

## How clients show it

| Client | What to expect |
| --- | --- |
| Clients that read `structuredContent` | The full graph, for their own rendering. |
| Chat clients that render Markdown with Mermaid support | The diagram drawn, plus the outline. Whether a `mermaid` block is drawn depends on the client and its version. |
| Terminal clients (Claude Code, Codex CLI) | The Mermaid source and the outline as text. `format: "outline"` saves space; paste the diagram into any Mermaid viewer to draw it. |

## Credit

The approach, reading a flow's structure from the `sys_hub_*` tables, nesting
steps by `parent_ui_id`, relabelling data pills from `label_cache` and
recognizing compressed values by their gzip prefix, follows the flow
inspection in Jace Benson's `jsn` ServiceNow CLI. No `jsn` code was copied.
