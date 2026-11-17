# Reading a record's history

`sn_history` shows one record's history, newest first: its audited field
changes (`sys_audit`), its comments and work notes (`sys_journal_field`) and
the flows that ran on it (`sys_flow_context`). It is read-only, reads only
through the Table API, and caches no history row. Every call requires an
explicit `profile`.

```json
{ "profile": "pdi", "table": "incident", "sys_id": "0123456789abcdef0123456789abcdef" }
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `table` | required | The record's class, such as `incident`. A record whose class is another table is not read further: the result says which table to call with. |
| `sys_id` | required | The record's 32-character sys_id. |
| `sources` | every source the profile may read | Any of `audit`, `journal`, `flows`. A source named here that the profile may not read fails the call. |
| `fields` | all | Up to 20 field names. Filters audit and journal entries; flows are unaffected. |
| `since`, `until` | none | UTC `YYYY-MM-DD` or `YYYY-MM-DD hh:mm:ss`. A date alone means the start or end of that day. |
| `include_values` | `true` | `false` asks the instance for no old, new or journal values at all. |
| `limit` | `50` | Events per page, 1 to 200, across all sources. |
| `cursor` | none | To page, repeat the call with the same arguments and `cursor` set to the result's `next_cursor`. |
| `max_response_bytes` | `100000` | Byte budget for the whole result, 1,000 to 1,000,000. |

## What it returns

`structuredContent.data` holds:

- `events`: `time`, `source`, `field`, `old`, `new` (or `value_hidden`), `user`,
  and for a flow its `name`, `state` and whether it was a test run. Values are
  cut at 2,000 characters (`value_truncated`); references stay raw sys_ids.
- `sources`: per source, `status` (`ok`, `not_granted`, `denied`,
  `unavailable`, `done` or `too_large`), the events it returned and whether it
  has more.
- `omitted`: entries left out because the profile may not read their field
  (`unreadable`) or because they were not about this record (`mismatch`).
  They are counted, never named.
- `audit_enabled`, `not_recorded` (business rules and script includes leave no
  history), `next_cursor`, `warnings` and, when relevant, a `hint`.

The envelope reports the page as a collection of its events, paged by cursor
(`pagination.mode: "none"`); there is no offset.

The text shows the same page as a table of sources and the events in an
untrusted-content block. When the events do not fit beside the structured
result within `max_response_bytes`, the text shows the newest events that fit,
or none, and says how many the structured result holds.

## Paging

Each source keeps its own position, and `next_cursor` holds one cursor per
source that has more. A cursor is bound to the record, the source and the
`sources`, `fields`, `since` and `until` it was issued for; a cursor from
another call is refused. Pages never skip or repeat an event.

A source whose newest entry is too large to read even on its own is reported
`too_large`, and the other sources still answer. When every source
that has entries left is `too_large`, the result carries a `hint`: repeating
the call unchanged returns the same page. Use `include_values: false`, a
narrower `since`/`until`, or leave that source out of `sources`. The limit is
the client's size cap on one response from the instance, which
`max_response_bytes` does not change.

## Grants

- **The record's table**, with `sys_id` and `sys_class_name` readable under
  field policy. Without them the call is refused before anything is read.
- **The source tables.** `sys_audit` and `sys_journal_field` are granted by
  name only: a `"*"` table grant never covers them. `sys_flow_context` is
  covered by `"*"`. A source the profile may not read is reported
  `not_granted`, and the others still answer.
- **`sys_db_object` and `sys_dictionary`** for values. A profile with a named
  allowlist must grant both to `sn_history`; `"*"` covers them. Without them
  every entry is returned without its value, with a warning.

Bind these tables to `sn_history` alone, so `sn_query` and `sn_get` do not
read every record's audit rows and notes:

```sh
servicenow-mcp-setup grant --profile pdi \
  --read incident,sys_audit,sys_journal_field,sys_flow_context,sys_db_object,sys_dictionary \
  --tools sn_history
```

`--tools` adds `sn_history` to tables that already have other tools, such as
`incident`.

## What is shown

- **Field policy decides which entries appear.** An audit or journal entry
  whose field the profile may not read on the record's table, or whose name is
  sensitive, is left out and counted in `omitted.unreadable`. Columns that
  carry other records' content are never shown. The user names come from the
  audit and journal tables' own field policy.
- **Journal fields come only through the journal source.** An audit entry for
  a field whose dictionary type is `journal`, `journal_input` or
  `journal_list` is always left out, so comments and work notes are read only
  under the `sys_journal_field` grant. A field counts as a journal field by its
  dictionary type, never by its name: a custom field that holds notes under
  another type is an ordinary field here.
- **Values follow the field's type.** A value whose field is a password type,
  sits on a credential table, or has a type that cannot be read is withheld
  (`value_hidden`). The types come from the class's own dictionary rows,
  walking up its parent tables. When they cannot be read, or the class's
  parent tables cannot all be read, no value is shown. The
  `"fieldTypes": { "dictionary": "not_required" }` profile setting does not
  change this: without field types, history shows no values.
- **Instance field ACLs do not apply to audit rows.** A field ACL on the
  audited record does not reach its rows in `sys_audit`, so a field the
  integration user cannot read on the record can still appear, with its old
  and new values, in the record's audit history. Narrow such fields with field
  policy, or leave `sys_audit` out of the grant.
- **Instance text is untrusted.** Values, user names, field names and flow
  names are data, shown in the text only inside an untrusted-content block.

## Requests

A page makes at most six reads: the record, the class's parent tables and
dictionary rows (kept for an hour per credential after the first call), and
one read per source. A later page, or any call once the class's types are
kept, makes the record read plus one read per source. A flows-only call, or a
journal-only call with `include_values: false`, skips the type reads.
