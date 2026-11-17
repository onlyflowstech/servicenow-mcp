# Platform views

`sn_platform_view` reads platform records behind one `view` argument: update
sets and their changes, batches and retrieved sets, files an upgrade skipped,
Instance Scan findings, and an evaluation of an update set's changes. It is
read-only, reads only through the Table and Aggregate APIs with queries the
server builds, and caches nothing new. Every call requires an explicit
`profile`.

```json
{ "profile": "pdi", "view": "changes", "update_set": "Release 1" }
```

Every view takes `limit` (default 25, at most 200), `offset` (default 0) and
`max_response_bytes` (default 100,000, 1,000 to 1,000,000). A view takes only
its own selectors; any other is refused. List views page with `has_more` and
`next_offset`, and a page cut to fit `max_response_bytes` continues at
`next_offset`.

## Views

| View | Selectors | Tables read | Returns |
| --- | --- | --- | --- |
| `update_sets` | `state` (`in progress`, `complete`, `ignore`), `name_contains`, `application` (scope sys_id or `global`), `updated_since`, `batch_root` | `sys_update_set`, `sys_update_xml` | Sets with their state, scope, parent, batch base, author, dates, description (cut at 200 characters) and change count. |
| `update_set` | `update_set` (sys_id or exact name) | + `sys_remote_update_set` | One set, its changes counted by type and action, its batch parent and children, and the retrieved set it came from. |
| `changes` | `update_set` or `remote_update_set`, `include_children`, `type`, `action`, `change` with `payload: true` | `sys_update_set`, `sys_update_xml`, `sys_remote_update_set`; with `payload`, also `sys_db_object` and `sys_dictionary` | Change rows: type, name, target, table, action, scope, who and when. With `payload: true` and one `change`, that change's XML, masked (below). |
| `batch` | `update_set` (any member) | `sys_update_set`, `sys_update_xml` | The batch tree from its root: at most 10 levels and 200 sets, with change counts. |
| `remote_update_sets` | `state`, `remote_update_set` with `problems: true` | `sys_remote_update_set`; with `problems`, also `sys_update_preview_problem` | Retrieved sets with their preview counts and source; with `problems: true`, one set's preview problems. |
| `upgrade_skipped` | `upgrade` (`latest` or sys_id), `kind` (`upgrade`, `app_install`, `all`), `type`, `disposition` | `sys_upgrade_history`, `sys_upgrade_history_log`, `sys_choice` | The run, its four skipped counters, and the files it skipped, with their dispositions. `kind` is read from the run's `from_version` and is labelled as a heuristic. |
| `scan_findings` | `result` (`latest` or sys_id), `check`, `category`, `priority`, `source_table`, `include_muted` | `scan_result`, `scan_finding`, `scan_check` | One result's header, its findings counted by check, and the finding rows. |
| `evaluate` | one of `update_set`, `batch_root` or `remote_update_set`; `include_children`, `groups` (`perf`, `sec`, `bp`), `min_severity`, `max_updates` | the update set tables, `sys_update_preview_problem`, `sys_update_version`, `sys_db_object`, `sys_dictionary` | Findings of the evaluator's rules over the set's changes, with coverage counts (below). |

A table the profile may not read denies the call before anything is read: each
call's plan is the tables listed for its view and arguments, all or nothing. A
read the instance refuses, or a plugin that is not installed, gives
`status: "denied"` or `"unavailable"` with a fixed hint, never an empty
success. On `upgrade_skipped`, reading the upgrade log needs the
`upgrade_admin` role; without it the run's summary is returned with
`log: "denied"`.

## Grants and field policy

`sys_update_xml`, `sys_upgrade_history_log`, `scan_finding`, `scan_result` and
`scan_check` are **platform tables**: a `"*"` table grant covers them, and a
profile's `"*"` field-policy entry narrows them whether or not the profile
names them. The policy card shows them as class `platform`. Their default reads
leave out the XML, script and matched-code columns: `payload` and
`payload_diff`, `finding_details`, `scan_finding.task` and `.user`,
`scan_check.script` and `scan_result.message`. The views never ask for them,
except `payload` as below.

Naming a table in field policy does not narrow the tables that extend it (for
example the subclasses of `scan_check`). Use the `"*"` entry, or name each one.

## Payloads

`changes` with `payload: true` shows one change's XML, and `evaluate` scans the
XML of the changes it reads. Both read `sys_update_xml.payload` only when the
profile's own `sys_update_xml` entry names `payload` in `readable`; a `"*"`
entry, at either level, never covers it. Without it, `changes` returns the
metadata and says how to open the payload, and `evaluate` runs its metadata
rules only. For example:

```json
"fieldPolicy": {
  "sys_update_xml": {
    "readable": ["sys_id", "name", "type", "target_name", "table", "action", "application",
                 "sys_updated_by", "sys_updated_on", "replace_on_upgrade", "update_set",
                 "remote_update_set", "payload"]
  }
}
```

A shown payload is masked:

- an element whose field is a password type on the payload's table is replaced
  with `[hidden]`, and so is an element with a sensitive name;
- a value that looks like a credential is replaced with `[masked]`;
- a change to a credential table, or to a table that extends one, is refused
  and only its metadata is shown;
- a payload in a layout the server cannot check, or on a table whose parent
  tables or field types cannot be read, is withheld.

Masking is by type, name and pattern: a secret written into a script in
another form may still show, and the result says so. Both views need the field
types: the `"fieldTypes": { "dictionary": "not_required" }` profile setting
does not apply to them, and without the types a payload is withheld or not
scanned.

The payload shown is capped at 32,768 characters by default. A larger
`max_response_bytes` shows up to half of it, at most 204,800 characters. The readable text repeats the payload
only when both fit; otherwise the payload stays in the structured result and
the text says where it is.

## The evaluator

`evaluate` runs fixed rules over a set's changes, in three groups: `perf`
(for example queries inside loops, unfiltered queries, synchronous client
calls), `sec` (for example access rule and role changes, dynamic code,
credential-like literals, updates that carry credentials) and `bp` (for
example deletions, unresolved preview problems, baseline records, an empty or
undescribed set). Each finding has a rule id, severity, confidence and a fixed
message; it never quotes script text. `min_severity` (`info`, `low`, `medium`,
`high` or `critical`) leaves out findings below it.

- **Scope.** `update_set` (a sys_id or exact name) evaluates that set and,
  unless `include_children: false`, its children. `batch_root` evaluates a
  whole batch. `remote_update_set` evaluates a retrieved set's changes, which
  is what a commit would apply.
- **Size.** `max_updates` is the number of changes read, default 400, at most
  5,000. A call also stops when its read budget is spent, and says so.
- **Coverage.** The result always says how many changes it scanned and how
  many it could not, and whether it is `partial` or `metadata_only`. A change
  on a table whose parent tables cannot all be read is treated as a possible
  credential table and is not scanned.
- **A clean result is not an approval.** The rules are heuristics over the
  changes read.

## Text

Names, descriptions, states and payload text come from the instance and are
untrusted. The readable text shows them only inside untrusted-content blocks;
counts, statuses and the fixed hints are outside them.
