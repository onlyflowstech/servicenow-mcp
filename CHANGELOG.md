# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0-dev.5] — 2026-11-16

### Added

- **Read tools now hide `password`/`password2`-typed fields by dictionary type,
  not only by name.** A field whose internal type is `password`, `password2`,
  `masked` or `encrypted_text` is refused when named, left out of `fields=all`,
  detailed and default reads, `"*"` responses and write echoes, refused as a
  filter, order, aggregate, group-by or ATF step-condition field, and refused
  as a write key, whatever it is called. A `sys_properties` row shows `value` only when its
  `type` is a known non-secret type. The types come from one cached
  `sys_dictionary` read per credential. While they cannot be read, field-policy
  tools refuse with a message naming the access needed, unless the profile sets
  `"fieldTypes": { "dictionary": "not_required" }`, which falls back to
  name-only hiding and is flagged on the policy card. `tools/list` is unchanged.

- **`sn_syslog` can tail the system log.** `tail: true` returns the newest
  entries, oldest first, with a `cursor`; each later call with `after_cursor`
  returns only the entries created after it, oldest first, with a new `cursor`,
  so a caller no longer re-reads a window and removes duplicates by hand. The
  cursor holds the creation second and the row's `sys_id`, so entries that share
  a second are neither skipped nor repeated, and it is bound to the `level`,
  `source` and `message` filters it was issued for. A malformed, oversized or
  altered cursor, or one used with other filters, is refused with a fixed message
  that never repeats it. When more entries are waiting than `limit` allows (or the
  response is cut to fit its size limit), the call returns `has_more: true` and a
  cursor at the last entry returned. Tail reads never use the metadata cache,
  carry no total count and no `next_offset`, and follow the same table and field
  policy as any `sn_syslog` read; a call without `tail` or `after_cursor` is
  unchanged. A cursor older than the longest `since` window (one year) is refused,
  so a tail cannot reach further back than a plain read. The two new inputs and the `cursor` output add about 340 characters
  to the `sn_syslog` entry in `tools/list`.

### Changed

- **`sn_atf_author` checks the table, conditions and ACL setting of ATF steps
  when it adds them.** A `record_query`, `record_validation`,
  `field_values_validation` or `open_existing_record` step needs a read grant on
  the table it names, and an `open_new_form` or `set_field_values` step a write
  grant, with the same refusal as any table access (a named-only table such as
  `sys_audit` must be named). The conditions of `record_query`,
  `record_validation` and `field_values_validation` are checked against the
  table's field policy: a field the profile may not read, a dot-walk (`a.b`), a
  condition that is only a pasted step output, and a term the check does not
  recognise are refused, and only the operators that compare a field with a
  literal are allowed (`=`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`, `NOT LIKE`,
  `STARTSWITH`, `ENDSWITH`, `IN`, `NOT IN`, `ISEMPTY`, `ISNOTEMPTY`, `BETWEEN`),
  so an operator that takes a second field, such as `SAMEAS` or `GT_FIELD`, is
  refused. `enforce_security: false` is refused on `record_query` and
  `record_validation` with a fixed message (leave it out, or pass `true`; it
  stays `true` by default). A refused step refuses the whole call, before any
  write. A condition value, and a `set_field_values` value, may refer to an earlier
  step's output only by record id or sys_id (`record_id`, `first_record`,
  `sys_id`, `user`), and the fields a
  `set_field_values` step sets must be writable on its table, as for `sn_update`.
  The impersonated user's ACLs still apply on top; suites authored in the
  instance are not checked by the server's table grants, and `atf.execute` stays
  opt-in. The README and `docs/PRODUCTION-SECURITY.md` now also say that a
  database view or extension table over one of the six named-only tables is not
  covered by the name list.
- **A `"*"` write grant no longer covers `sys_atf_step`, `sys_variable_value`
  and `sys_element_mapping` for the generic write tools.** These tables hold the
  step types, input values and pill mappings that `sn_atf_author` checks when it
  adds a step. Under `"*"`,
  `sn_atf_author` still writes them, but `sn_create`, `sn_update`, `sn_delete`,
  `sn_batch` and attachment uploads reach them only when the profile names the
  table for write; the refusal names the table and the grant that allows it
  (`servicenow-mcp-setup grant --profile <profile> --write sys_atf_step --tools
  sn_update`). Reads are unchanged, and no other table's access changes.
  `sys_variable_value` and `sys_element_mapping` also hold other variables'
  values and mappings (catalog variables, for example), so a profile that writes
  those with the generic tools must now name them. The policy card lists the
  three tables as outside the wildcard row's write access.
- **`sys_audit` and `sys_journal_field` are no longer covered by a `"*"` table
  grant; name them to read them.** A profile whose `readTables` (or
  `writeTables`) holds `"*"` used to reach both tables like any other. Their rows
  hold the old and new values of other tables' fields, comments and work notes,
  so they are now granted by name only. With `"*"` alone, `sn_query`, `sn_get`,
  `sn_aggregate`, `sn_schema`, `sn_batch` and the other tools refuse them, and
  the message names the table and the grant that allows it:
  `servicenow-mcp-setup grant --profile <profile> --read sys_audit --tools
  sn_query`. A profile that already names a table is unaffected, and a `"*"`
  grant beside the name still covers everything else. A read that names no
  `fields` returns `sys_id`, `tablename`, `documentkey`, `fieldname`, `user` and
  `sys_created_on` for `sys_audit`, and `sys_id`, `name`, `element_id`, `element`,
  `sys_created_by` and `sys_created_on` for `sys_journal_field`; ask for
  `oldvalue`, `newvalue` or `value` by name. No other table's access changes. The
  policy card and the setup wizard's wildcard note say the same.
- **Four more tables are granted by name only, and a `"*"` field entry now
  narrows all six.** `sys_history_line`, `sys_audit_delete`, `sys_attachment_doc`
  and `sys_email` join `sys_audit` and `sys_journal_field`: a `"*"` table grant no
  longer covers them, for read or write, and a profile reaches one only when
  `tableAccess` names it. Their rows hold history built from audit, deleted
  records, attachment content and email bodies. The refusal names the table and
  the grant that allows it. A read that names no `fields` leaves out the value
  columns (`old`, `new`, `old_value` and `new_value`; `payload`; `data`; `body`,
  `body_text`, `subject`, `recipients`, `copied`, `blind_copied`, `reply_to`,
  `headers` and `error_string`), so ask for them by name. For field policy
  the six belong to the profile, as the ITSM tables do: once a profile names one,
  its `"*"` field entry narrows it, and an entry for the table itself narrows or
  widens it. The 24 system tables, which a `"*"` field entry never narrows, are
  unchanged. `sn_attach` is unaffected: it uses the Attachment API and never
  reads `sys_attachment_doc`.
  A `relatedTables` list that reaches one of the six under a `"*"` grant still
  stops the profile loading, and the message now names the table and says it
  must be granted by name. `sn_profile` reports these tables with the class
  `named_only`.

### Fixed

- **`sn_atf_results` with action `get` no longer fails with an internal error on
  a completed suite result whose rows have empty references.** Some result rows
  carry an empty suite reference, and their test results an empty test
  reference. The tool failed on the first one as soon as it had read the result
  (and would have failed on the second), so every completed result of that kind
  failed, while a running one that names its suite worked. Such a result now
  returns normally: the run, its tests and its failures, without a `suite_id`,
  with each test that has no reference identified by its test result's own id,
  and with warnings that say so and that the result has no history or comparison
  (the cache is kept per suite and per test). `run.suiteId` is therefore optional
  in the output schema. A row of the wrong shape (a reference that is not a
  sys_id, an unknown status) now ends the call with an upstream error instead of
  an internal one.

- **A client that reads only `structuredContent` no longer loses what the text
  carried.** Some MCP clients give the model the structured result and drop the
  text, and a few tools kept information only in the text. They now carry it as
  typed fields as well, and the text is unchanged. `sn_flow_view` adds `diagram`
  (the Mermaid source, when `format` asks for one), `ref` (the flow record as
  table and sys_id) and `warning_details` (each warning code with its
  explanation). `sn_atf_run` and `sn_atf_results` add `result_ref` (the suite
  result record) and `advice` (how to read a failed step in full).
  `sn_atf_author` adds `advice` after an insert whose outcome could not be
  confirmed; the records it created were already listed with their table and
  sys_id. Record links stay out of `structuredContent`: it names a record by
  table and sys_id, and the instance address stays in the text, so no result
  gains an address. The diagram counts toward `max_response_bytes` and is the first
  thing given up: if the graph and the diagram do not fit together the diagram
  keeps only a note, and its source is never cut short. The published output
  schemas grow by about 1.6 KB in total (1.3%), and the model-visible part of
  `tools/list` by 18 characters.

## [2.3.0-dev.4] — 2026-11-15

### Changed

- **The setup wizard defaults to OAuth client credentials.** The authentication
  prompt now lists `oauth` first and offers it by default, then `apikey`, then
  `basic`, which is marked legacy because ServiceNow is retiring Basic Auth for
  REST calls. Choosing OAuth prints a short note on what the instance needs (an
  Application Registry entry with a client ID and secret, the client credentials
  grant, and an OAuth Application User with only the roles it needs, not an
  administrator) and where the README explains it. When a Basic credential gets a
  401, the wizard now asks what next: retry with the same settings, switch to
  OAuth (keeping the profile name and instance, and discarding the Basic
  credential), or stop; its 401 advice points at that menu, while `doctor --live`
  tells the operator to re-run setup and choose oauth. Nothing else changes for scripts:
  `servicenow-mcp-profile create` without `--auth-type` still creates a Basic
  profile, now with a deprecation notice shown only in an interactive terminal,
  never in captured output (a future release may require the flag), and
  `SN_AUTH_TYPE` still defaults to `basic`. Saved
  profiles are never changed, and a saved profile with no `authType` is still
  read as Basic. The README quick start, the profile and client setup guides and
  their examples now show OAuth first.

## [2.3.0-dev.3] — 2026-11-15

### Added

- **`sn_codesearch` searches ES modules.** `table: "sys_module"` searches the
  `content` column and names each row by its `path` (the table has no `name`);
  with no `table` it takes its turn after the other code tables, labelled "ES
  Modules" (a search that names the table labels rows with the table name, as for
  the others). `sys_module` follows the same rules as the other code tables: a
  plain `--read sys_module` binds `sn_codesearch` to it with the other default
  read tools, `content` goes through the field policy and the sensitive-name
  rules, it is in the default metadata cache list, and a write grant on it is
  flagged as code execution. It also becomes a built-in system table, which
  changes who can read its fields: see Changed.

- **`sn_codesearch` searches ATF step scripts.** `table: "sys_atf_step"` finds
  the script inputs of ATF steps: rows of `sys_variable_value` whose `document`
  is `sys_atf_step` and whose `variable` ends with `script`, a condition fixed in
  the server that no argument can widen (a `field` is refused, and the search
  term cannot add a clause). Each result is the step, named `<test> > step
  <order>`; the steps and then their tests are read by id to name them. The
  profile needs read on `sys_variable_value`, `sys_atf_step` and `sys_atf_test`,
  each bound to `sn_codesearch`; a denial names the missing table, and in a
  search with no `table` the target is left out, and named, unless all three are
  held. `grant --atf` binds those tables to `sn_atf_author` only, so add `grant
  --read sys_variable_value,sys_atf_step,sys_atf_test --tools sn_codesearch` for
  this search. The tables are not in the default metadata cache list.
- **`tools/list` grows by 129 characters.** The `sn_codesearch` entry goes from
  3,655 to 3,784 characters (model-visible total 40,012 to 40,141), for the new
  description and parameter text. The published `inputSchema` shape is
  unchanged.

### Changed

- **`sys_module` is now a built-in system table, so a `"*"` field entry no longer
  narrows it.** Before, `sys_module` was like any table without a built-in entry:
  a profile whose field policy has a `"*"` entry that narrows `readable` (for
  example `"*": { "readable": ["sys_id", "path"] }`) could not read its `content`
  or `sys_scope`, and `fields=all` returned only the listed fields. It is now one
  of the 24 system tables, which keep their own built-in entry and are never
  covered by a `"*"` field entry, as for `sys_script` and the other code tables.
  A profile that reads `sys_module` (granted by name, or by a `"*"` table read
  grant, which still covers it) and narrowed fields with `"*"` now reads
  `content` and its other non-sensitive fields, and gets no warning. To keep it
  narrowed, name `sys_module` in `fieldPolicy`, for example
  `"sys_module": { "readable": ["sys_id", "path"] }`; a named entry still
  narrows it. The sensitive-field-name rules apply as before.
- **A default read of a code table no longer returns the script.** `sn_query`
  and `sn_get` on `sys_script`, `sys_script_include`, `sys_ui_script`,
  `sys_script_client` and `sys_ws_operation` return, with no `fields`,
  identifiers and metadata instead of the script body: for `sys_script_include`
  that is `sys_id`, `name`, `api_name`, `active` and `sys_updated_on` (the other
  tables add what identifies a row, such as `collection` and `when` for a
  business rule). A default read of 87 script includes used to keep 9 rows
  before the response budget cut it; it now returns all 87. **This changes the
  default output:** a caller that relied on the body appearing by default must
  name it, for example `fields: "sys_id,name,script"`. `fields=all` and
  `response_format: "detailed"` still include it, and a profile that states its
  own `defaults` for one of these tables keeps them.

### Fixed

- **A code search with no `table` searches the code tables the profile may read.**
  It needed a read grant on all five (and `sn_codesearch` bound to each), so a
  profile that held only `sys_script_include` was denied outright while the same
  call with `table: "sys_script_include"` worked. It now decides each table on
  its own, by the table policy and by the field policy of its script field,
  searches the ones it may read, and adds a warning that names the others and
  the `grant` command that includes one. It fails only when none can be read: the
  error names the tool and the grant, or, when the tables are granted but their
  script field is not readable, the field and the key to change. The dispatcher
  still authorizes the narrowed plan, so this never widens access.
- **A large code search returns results instead of failing.** `sn_codesearch`
  read the full script of `limit + 1` rows from every table it searched, so
  above about 100 rows (150, 200 and 300 failed every time on an instance of
  6,500 script includes) it passed the 1 MiB response cap, and with no `table`
  the five tables shared one budget. It now reads the rows without their
  scripts and then the scripts of the rows it returns only, 50 at a time, each
  batch in its own response scope; a batch that is still too large is halved,
  and a script too large to read on its own leaves that row with an empty
  snippet and `note: "script too large to preview"`. A search of one table with
  `limit` 49 or less still reads the scripts with the rows, in one request.
  Reads also send `sysparm_no_count`, so the instance skips a row count it never
  used. If the rows alone pass the cap, the error is the too-large message.
- **The script reads of one code search are bounded.** Scripts for the rows of a
  page are read by id in batches of 50, and a call spends at most 12 such
  requests and 8 MiB on them, however large the scripts are (a batch that passes
  the response cap is retried smaller, and what it learns sizes the later
  batches). Scripts are read only for the rows the response can hold, in page
  order. When the budget is spent the remaining rows keep their place with an
  empty snippet, and a warning says how many and to lower `limit`; the call does
  not fail. A search across all code tables makes more requests than before but
  transfers less data.
- **A code search with no `table` no longer fills page 1 with one table.**
  Results were sorted by table name, so the first table (business rules)
  filled the page whenever it had `limit` or more matches and script includes
  appeared only after paging past every one of them. The tables now take turns:
  each table's first match (script includes first, then business rules, UI
  scripts, client scripts, scripted REST operations), then each table's second,
  and so on, each in `sys_id` order. The order depends only on the data, and
  `offset` pages through it without skipping or repeating a row. The result
  metadata's `order_by` is `["round", "table", "sys_id"]` for this search and
  `["sys_id"]` for a search of one table.
- **A code search snippet shows the text around the match.** It was the first
  200 characters of the script, which rarely showed why the record matched. It
  is now about 200 characters centred on the first case-insensitive match, with
  `...` where text was cut, and each row gains `line`, the line the match is on.
  When the text holds no literal match (the instance's comparison can be looser
  than a literal one) the snippet is the head of the script, as before, with no
  `line`.
- **`sn_codesearch` accepts `field: "name"` and `field: "sys_id"`.** The search
  appended its field to a fixed `sys_id,name,<field>` list, so a field already in
  the list became a duplicate and the policy check refused it with
  `invalid_field_selection` before any request. The projection now lists each
  field once, in the access check and in the read. A `field` that names more
  than one field (`"name,script"`) is refused instead of silently searching the
  first.
- **`sn_codesearch` pages in a stable order.** It sent `sysparm_orderby`, which
  is not a Table API parameter, so the order of its windows was not guaranteed
  and an offset could skip or repeat a record. The order is now part of the
  encoded query (`^ORDERBYsys_id`), as `sn_query` does it.
- **A response that passes the byte cap is reported as too large, with the
  remedy, by every tool.** A read that went over the 1 MiB response limit, or
  over the call's cumulative upstream budget, used to reach the caller as "The
  operation failed unexpectedly. Error category: internal. Retry unchanged is
  not recommended." It now reads "The response was too large to return in one
  call. Lower limit, request fewer fields, or narrow the query, then retry.
  Error category: too_large. Retry after correcting the request or
  configuration." The new `too_large` category is also what audit records and
  the HTTP tool-call metrics report as `errorCategory`. The mapping is made once,
  where an error becomes the caller's message, so it covers every tool that
  reads through the client. A write whose response is over the cap is still
  treated as an unknown outcome, as before.

- **A table-policy denial names the table, the tool and the grant that lifts it.**
  It used to say only "Table access was denied by policy." Now, for example,
  `Table access was denied by policy: "sys_script_include" is granted to this
  profile, but not for sn_codesearch. To allow it, run: servicenow-mcp-setup
  grant --profile <profile> --read sys_script_include --tools sn_codesearch,
  then restart the MCP client.` The text says whether the table is missing from
  the profile or only the tool is, and uses `--write` for a write. It carries
  the table and tool of that one call and nothing else of the profile's rules;
  a table name that is not a valid identifier still gets the fixed sentence.
  `grant --help` now says `--tools` adds to a table's tools.
- **A page with more results no longer reports truncation.** `sn_codesearch`,
  `sn_discover` and `sn_aggregate` (with `group_by`) read one row past the page
  to learn whether another page exists. That row is not part of the result, but
  the response counted it as a dropped record, so every page that had a next
  page also said `metadata.truncation: {truncated: true, reason:
  "record_limit", dropped_records: 1}`, which reads as data loss when none was
  lost. `has_more` and `next_offset` are unchanged (`next_offset` is still
  `offset + record_count`), and `metadata.truncation` is now `{truncated:
  false}` for such a page. It still reports rows dropped to fit the response
  size (`byte_limit`), now counting only the rows of the page that were dropped,
  not the extra one, and rows a tool itself cut.

### Removed

- Planning documents that were not part of the published package are no longer
  in the repository.

### Fixed

- **A 401 on a basic-auth profile now explains the Basic Auth restriction.**
  Current ServiceNow instances reject REST Basic auth unless the user has the
  role `snc_basic_auth_api_access` (or is a web-service-access-only account),
  and the rejection is a bare 401. The setup wizard's credential check now says
  so after "check the username and password", and recommends OAuth client
  credentials, because ServiceNow is retiring Basic auth. A tool call that gets
  a 401 on a basic-auth profile returns the same guidance as fixed text: the
  error never contains the response body, the credential or the instance URL.
  OAuth and API-key profiles are unchanged. The README already said the error
  explained the restriction; now it does. The wizard still defaults to `basic`.
- **`sn_query` refuses a `structured_query` filter or order on a field the
  table does not have.** ServiceNow ignores a condition on a field it does not
  know, so a misspelt field returned unrelated rows with no error. The call now
  fails and says the field "was not found on the table, or is not readable by
  this user" (a field hidden by an ACL looks the same as a missing one). No
  extra request is made: the fields a filter or order uses are added to the
  read's `sysparm_fields` and looked for in the rows that come back, then left
  out of the result. A field counts as present when any returned row carries
  it, an existing column with no value is still returned, and a read that
  returns no rows is returned as before, since there is nothing to check. A raw
  encoded `query` is not checked; it is only accepted through a policy rule
  that already pins the query and its fields. The extra columns add bytes to
  each fetched row, and a filter on a very large text field that is not in
  `fields` can take a wide read past the 1 MiB upstream response limit: the
  call then says so and asks for a lower `limit`.

## [2.3.0-dev.2] — 2026-11-15

### Added

- **`sn_query` reads `structured_query.filter` given as a list as an implicit
  AND.** `filter: [c1, c2]` means `{type: "group", operator: "and",
  conditions: [c1, c2]}`, and a one-element list means that element. The
  existing limit of 3 nested group levels is unchanged: a list of two or more
  takes one level, so a list that holds a 3-level group is rejected, and the
  error says so. An empty list is rejected with its own message. A list is read
  this way only as the top-level `filter` and only by `sn_query`: `sn_batch`
  write filters stay one object, so a mutation never selects records through a
  list. The list is part of the published `tools/list` schema (see the schema entry below).
- **`structured_query.filter` shows a working example in `tools/list`.**
  `sn_query`'s `filter` says a list is read as AND and shows one, and the
  `sn_query` description gains a one-line example with the OR group form.
  `sn_batch`'s `filter` has its own text: one condition or group, and a list is
  not accepted, because a mutation never selects records through a list. Its
  example filters on `sys_id`, a field every table has: an example on a field
  such as `name` would match every row of a table without that column, since
  ServiceNow drops a condition on a field the table lacks. Costs 605 characters
  in `tools/list` (`sn_query` +459, `sn_batch` +146).
- **Responses say whether the metadata cache was used and where the time went.** `structuredContent.metadata` gains two optional fields. `cache` is
  `hit`, `miss`, `bypass` (a `force_recache` refresh) or `mixed` (several
  cacheable reads with different outcomes, such as an `sn_codesearch` with no
  `table`), and is absent when the call read no cacheable table. `timing` is
  `{ total_ms, upstream_ms, watermark_ms }` in whole milliseconds, wall-clock:
  `upstream_ms` and `watermark_ms` are the time at least one request of that
  kind was in flight, so overlapping requests count once. Only the server sets
  them (a value a tool supplies is discarded), and they are not counted
  against the result's byte limit, so they never cost a record and are never
  dropped (see the entry on truncated responses below). Every tool's
  `outputSchema` grows by 322 characters (7,728 in `tools/list`). Cache
  behaviour is unchanged.

### Fixed

- **`sn_query` no longer fails with an internal error at the smallest byte
  budgets (a regression from the labelled hint).** A truncated read
  at `max_response_bytes` 1000 with a wide row (eight fields including a long
  `description`, limit 50) returned `The operation failed unexpectedly` every
  time: the envelope's metadata leaves room for little beside the counts at
  that budget, and the fuller labelled hint no longer fitted even with no row.
  When no row fits beside the whole hint, the fit now leaves out the
  whole-page figure and then the field advice, keeping the next-row figure, so
  the result is a normal truncated one (`has_more: true`, no `next_offset`,
  `recovery` set, a hint that parses and equals `dropped_records`). The hint
  never names a value above the effective maximum.
- **A truncation hint says which `max_response_bytes` is for the next row and
  which for the whole page.** The hint's budget was measured for the
  next row only, but a bare `max_response_bytes=1500` read as a value for the
  page: live, a 50-row read at 1000 bytes said 1500 and following it returned
  one row. The hint now reads `... or max_response_bytes=1500 (fits the next
  row) or max_response_bytes=15400 (fits all 50)`. The page figure is measured
  the same way as the next-row one, is never smaller than it, and is left out
  when the page would exceed the effective maximum (1,000,000, or a raw-read
  rule's `maxResponseBytes`) and when one row was dropped (the next row is then
  the rest of the page). The bare figure is gone, so a client that matched
  `max_response_bytes=<n>.` at the end of the hint must match the labelled
  form; the count still equals `dropped_records`, and the hint stays within its
  600 characters. `sn_schema`'s `fields_only` text now says it lists the
  table's own fields only, and that inherited fields need the full schema; it
  costs 68 characters in `tools/list` (`sn_schema` 3518 to 3586, total 128190
  to 128258).
- **The list form of `structured_query.filter` is in the published `tools/list`
  schema, and `tools/list` is smaller.** `sn_query` read a list filter,
  and its descriptions tell clients to send one, but the schema it published
  had no array option, so a client that validates arguments against it (ajv)
  rejected the documented example. The list is now an explicit branch of the
  schema, 1 to 32 conditions. The filter union and the leaf-condition union
  are published once per tool, under `definitions`, and referred to with
  `$ref`, where each use used to be written out again; every `$ref` resolves
  inside the same tool's `inputSchema`; the definitions are named
  `StructuredQueryFilter` and `StructuredQueryCondition`, so clients that merge
  `definitions` across tools or servers do not collide. `sn_batch` shares them
  and still publishes no array option, and a list is still rejected there.
  Behaviour is unchanged: the error messages (including the specific one
  for a bad field name, a control character or an over-long value inside a
  list element, which now names the caller's own position, `filter[1].field`,
  and not a position inside the wrapper group) and the nesting rule (a list of
  two or more takes one group level) are as before. One difference stays between the
  schema and the server: the schema cannot say that a list of two or more
  takes a level, so it accepts a list that holds a 3-level group, which the
  server rejects. `tools/list`: `sn_query` 16,574 to 10,183 characters,
  `sn_batch` 14,818 to 8,328, the whole list 140,887 to 128,006 (the part a
  model reads, without output schemas, 52,641 to 39,760). This delivers most of
  the filter dedupe that was asked for; stripping the bounds the server enforces
  anyway, and sharing the scalar value union, are not done. Clients that do not
  resolve `$ref` to `definitions` are not served by this form, and a client that
  dereferences `$ref` before it validates or shows the schema sees `sn_query` at
  about 22.8k characters (the list option written out), against about 13.7k
  before this change.
- **Truncated responses keep `metadata.cache` and `metadata.timing`.**
  The two fields were added only when the finished response still fit
  `max_response_bytes`, so a response fitted to within about 90 bytes of its
  limit lost them, on exactly the calls where the timing helps most. They are
  no longer counted against the limit: the fit and the truncation hint's numbers
  (see the entries on `has_more` and on the hint's values) are unchanged, and a successful response always carries both. It
  can exceed `max_response_bytes` by their size, under 100 bytes. The
  `max_response_bytes` description of `sn_query`, `sn_get` and `sn_flow_view`
  says so (about 61 characters each in `tools/list`).
- **A rejected `structured_query.filter` names the mistake.** A bad
  operator, an unknown or missing `type`, a bad group, a missing key, a value of
  the wrong kind or a group nested too deep used to get the same shape message,
  even when the condition sat inside a group. The message now says the first
  thing wrong, in fixed words, with an index path, for example `filter.conditions[1]:
  a "text" condition needs operator one of contains, not_contains, starts_with,
  ends_with`, `type must be one of equality, set, range, text, null, group` and
  `a group needs operator and or or, and a non-empty conditions list`, followed
  by the working example. A list filter on `sn_query` is reported at the
  caller's own position (`filter[1]`); `sn_batch` gives the same text and still
  says a list is not accepted. Nothing the caller sent is repeated, and a
  condition type is quoted only when it is one of the known type names. The
  shape message remains for anything the walk cannot name. `tools/list` is
  byte-identical.
- **The `sn_query` truncation hint gives values to use.** The
  `max_response_bytes` description promised exact follow-up arguments, but the
  hint said "a lower limit" and "a higher max_response_bytes" with no numbers,
  and a caller who chose their own `fields` got no field advice. The hint now
  reads like `Dropped 14/22; continue offset=8 limit=8; retry offset=0 with
  fields="sys_id,name" or max_response_bytes=31500.` The `limit` is the number
  of rows that fit. The `max_response_bytes` is measured where the envelope
  refits the result, with its own cost in it, and holds at least the next row;
  if no budget up to 1,000,000 (or up to the `maxResponseBytes` of the raw-read
  rule that approved a raw `query`, when that is lower) could, the hint says
  the next row exceeds that maximum, names it, and offers fields and `sn_get`. A caller's own `fields` list is offered back without its large
  fields (such as `script`); a list with none gets the `limit` and the budget,
  and a read of `fields=all` gets the table's short default list. Only fields
  the profile may read are named, never a sensitive one. The count still equals
  `dropped_records` and the hint stays within 600 characters. The
  `max_response_bytes` description now names what the hint carries (5
  characters shorter; `tools/list` `sn_query` 16,579 to 16,574).
- **`sn_query` no longer stops paging after page 2.** The tool sends
  `sysparm_no_count`, so ServiceNow's `X-Total-Count` header holds the size of
  the response (the page plus the one sentinel row), not the table. The handler
  trusted it: `total` echoed the rows fetched, and `has_more` turned false from
  page 2 on, with thousands of rows unread. `has_more` and `next_offset` now
  come from the sentinel row alone, so they stay true until the last page.
  **`total` is no longer returned by `sn_query`** (the output schema already
  made it optional); counting would need a COUNT query on every call, which
  `sysparm_no_count` exists to avoid. Page on `has_more` and `next_offset`, or
  call `sn_aggregate` with `COUNT` when the table size matters. If ServiceNow
  ACLs strip rows from a page, `has_more` can read false early; cross-check
  with `sn_aggregate` `COUNT`.
- **A read grant now allows code search.** `servicenow-mcp-setup grant
  --read <table>` binds `sn_codesearch` along with `sn_query`, `sn_get`,
  `sn_aggregate` and `sn_schema`, so `--read sys_script_include` is enough to
  search script includes; before, every code search on such a profile was
  denied unless `--tools sn_codesearch` was passed. It is checked per code
  table (`sys_script`, `sys_script_include`, `sys_ui_script`,
  `sys_script_client`, `sys_ws_operation`), does nothing on other tables, and
  field policy still decides the script field exactly as it does for
  `sn_query`. **Profiles saved before this change are not rewritten:** a target
  keeps the tool list it was saved with, so run `servicenow-mcp-setup grant
  --profile <name> --read <code table>` again to add the default tools, or add
  just this one with `--tools sn_codesearch`. Neither removes a tool.
- **A truncation hint on `sn_query` no longer disagrees with `dropped_records`,
  and suggests fields the table has.** A read cut to fit
  `max_response_bytes` is trimmed in two steps, and the second could drop more
  rows than the hint's "Dropped n/m" said. The hint is now restated from the
  final result, so its count, its empty-result advice and its continuation
  match `dropped_records`, `has_more` and `next_offset`. The suggested
  projection was always `fields="sys_id,number"`, wrong for any table without
  a `number` column. It is now the table's default fields without large ones
  such as `script`, at most three; if that leaves only `sys_id`, `sys_id` and a
  display field the profile's field policy names, else `sys_id` alone. A call
  that passed its own `fields` is told to lower `limit` or raise
  `max_response_bytes` instead of being given a field list.
- **A rejected `structured_query.filter` now says what is accepted.**
  Every mistake used to read "Invalid input at structured_query.filter". The
  message now says the filter is one condition or group object, gives a working
  example, shows how to combine conditions with a group, and states the limit
  of 3 nested group levels. It adds nothing to `tools/list`.

### Changed

- **A repeated read of a small cached-table response is one request, not a
  watermark and a read.** A cache hit costs one watermark round trip, so
  for a small response a hit cost about what a plain read did and a miss cost
  two requests. A read of a cacheable table whose response is under 32 KiB is
  no longer kept: the selector is remembered as small, per credential scope,
  for one cache TTL (at most 512 selectors, least recently used out), and its
  later reads go straight to ServiceNow with no watermark. `metadata.cache`
  says `miss` for them; `bypass` stays for `force_recache`. A direct read that
  comes back at 32 KiB or more forgets the mark, so the selector is cached
  from the next read. Responses of 32 KiB and up are cached, checked and
  bounded as before. Measured on a dev instance: a 6 KB read 490 ms before (a
  hit), 81 ms after; a 17 KB read 489 ms before, 98 ms. The threshold is a
  size, not a time: `sys_dictionary` there has a watermark of about 0.5 s, and
  even a 66 KB read was faster uncached. `metadataCache.smallReadBytes` sets
  the threshold per profile (0 keeps every response).
- **`has_more` and `next_offset` count rows dropped for size. Contract
  change for truncated pages.** A page cut to fit `max_response_bytes` kept
  `has_more` and `next_offset` for the rows beyond the page, so a client that
  followed `next_offset` skipped every dropped row, and a cut last page said
  `has_more: false` with `record_count: 0`. Now `record_count`, `truncated` and
  `dropped_records` keep their meaning, and:
  - `has_more` is true when rows were dropped for size **or** rows exist past
    the page: rows exist that the response did not contain.
  - `next_offset` is `offset + record_count` when at least one row came back:
    the first row not returned. A client that only follows it re-reads the
    dropped rows and loses nothing.
  - When no row fit, `next_offset` is omitted and `metadata.pagination.recovery`
    is `adjust_request_and_retry_same_offset`: `has_more: true` with no
    `next_offset` means the request must change (fewer `fields`, a lower
    `limit`, or a higher `max_response_bytes`). The pagination output schema
    accepts `has_more` without `next_offset` only with `recovery`.
  - The old post-page continuation is gone from the hint; `next_offset` covers
    it. A page that lost no rows to size is unchanged.

  Applies to every list tool that fits through the shared envelope:
  `sn_query`, `sn_syslog`, `sn_schema`, `sn_relationships`, `sn_codesearch`,
  `sn_discover`, `sn_attach` (list) and `sn_atf` continue at `offset + rows
  returned`; any other cut collection (for example `sn_aggregate`) reports
  `has_more: true` with no `next_offset`. This also stops a byte drop made only
  by the envelope from skipping the dropped row when `next_offset` is
  followed, and the tool's "More records available. Call sn_query again with
  offset=N." hint is restated at `next_offset` (or says no row fit), so it never
  contradicts it; the envelope's `truncated`/`dropped_records` flags in `data` are not
  added here. See the README, "Paging when a response is cut to size".
- **Code tables are in the default metadata cache.** `sys_script`,
  `sys_script_include`, `sys_ui_script`, `sys_script_client` and
  `sys_ws_operation` now cache like the other system-level metadata tables,
  under the same per-credential scope and watermark freshness, so a repeated
  `sn_codesearch` or `sn_query` of them skips the payload while the table is
  unchanged (one watermark read still runs per call). A profile that sets its
  own `metadataCache.tables` or `SN_METADATA_CACHE_TABLES` replaces the default
  list and must name these tables to cache them. `sn_codesearch` has no
  `force_recache` flag. `sn_get` of a record in these tables is cached too, and
  a cold one costs 2 requests (a watermark read, then the record); `sn_batch`
  and `sn_aggregate` reads are not cached. The cache is also bounded by bytes
  now: a response over 512 KiB is not kept, each credential scope holds at most
  32 MiB and the whole cache 128 MiB (least recently used out first), and
  expired entries are dropped as new ones are stored. A no-table
  `sn_codesearch` reads its five tables concurrently, within the client's
  existing request limit. Cached code-table entries hold full script bodies,
  which can contain hard-coded credentials, in process memory (never on disk)
  for up to the TTL; to keep them out, set `metadataCache.tables` or
  `SN_METADATA_CACHE_TABLES` to
  `sys_glide_object,sys_dictionary,sys_db_object,sys_app,sys_plugins,sys_metadata*,sys_flow*`.

### Security

- **HTTP transport rejects a backslash in the request path.** A request whose
  raw path (the part before `?` or `#`) contains a literal `\` now gets
  `400 Bad Request`, on every route including the health paths. The WHATWG URL
  parser reads `\` as `/` and resolves `..`, so `/x/..\mcp` or `//h\mcp` would
  otherwise pass our path check as `/mcp`; until now only the
  `@hono/node-server` dependency inside the MCP SDK transport refused the ones
  that reached `/mcp`, and the health paths answered them. Backslashes in the
  query string and a percent-encoded `%5C` behave as before.

## [2.3.0-rc.1] — 2026-11-14

Release candidate for 2.3.0, published to the `next` dist-tag. It contains the
changes listed under 2.3.0-dev.1 below and nothing else.

## [2.3.0-dev.1] — 2026-11-14

### Added

- **Release candidates publish to `next`.** A `vX.Y.Z-rc.N` tag (cut on the
  `test` branch by convention) now publishes to the `next` dist-tag. Stable and
  `-dev.N` tags are unchanged, and every other prerelease suffix is still
  rejected.

### Security

- **Container base image.** The runtime base,
  `gcr.io/distroless/nodejs22-debian13:nonroot`, moves to a newer digest whose
  `zlib1g` is 1:1.3.dfsg+really1.3.1-1+deb13u1 and whose Node is 22.23.4,
  clearing CVE-2026-76844 and CVE-2026-85091 from the `container-release`
  scan. The image serves the dormant HTTP transport and is not published.
- **HTTP server dependencies.** `@hono/node-server` moves from 2.1.3 to 2.1.7
  and `hono` (transitive, through the MCP SDK) from 4.13.13 to 4.13.18,
  clearing the advisories that `npm audit --omit=dev` reported:
  GHSA-qv5m-9pm6-hqp3 and GHSA-jpvv-r467-5p4w in `@hono/node-server`, and
  GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq, GHSA-3gg2-335m-rxc6,
  GHSA-4h7h-rv7c-7m2v and GHSA-46wx-v44x-9hh2 in `hono`. The same releases
  also carry the fixes for GHSA-7v5p-43qr-wch5 and GHSA-fj57-4f93-cfw6
  (`@hono/node-server`) and GHSA-92p4-j3wq-jmqx, GHSA-39q9-qp46-w8xg and
  GHSA-74fm-fwc7-3fwp (`hono`). The `tools/inspector` lock moves to `hono`
  4.13.18 and `@hono/node-server` 2.1.8. In the published package, only the
  dormant HTTP transport uses these packages. One behaviour
  change: a request to `/mcp` whose raw path contains a backslash (for example
  `\mcp`, which the server's own path check reads as `/mcp`) now gets 400 Bad
  Request.

## [2.2.0] — 2026-10-30

2.2.0 is the first stable release since 2.1.0. It contains everything
published on the `dev` channel as 2.2.0-dev.1 through 2.2.0-dev.6 (listed
under those versions below) plus the changes in this section. Numbers in
parentheses are the pull requests that made each change.

> **Upgrade every install: this release fixes a denial-of-service
> vulnerability.** A single oversized or deeply nested request could make the
> server exhaust its memory and stop. See **Security** below.
>
> **Read this before upgrading.** 2.2.0 can stop a working install from
> starting, and it changes what some profiles may write:
>
> - The server refuses to start while `SN_FIELD_POLICY_DEFINITIONS` is set and
>   `~/.servicenow-mcp/config.json` exists.
> - A malformed or ambiguous field policy in `config.json` now stops the whole
>   file from loading. The server, `servicenow-mcp-setup` and
>   `servicenow-mcp-profile` all refuse it until you fix it by hand.
> - `sn_create`, `sn_update` and `sn_batch` can append `comments` and
>   `work_notes` on every table a profile may write. Leaving the dedicated
>   journal tools off a target no longer withholds journals.
> - `sn_create` and `sn_update` writes to `incident` are no longer limited to
>   14 typed fields: every field the profile's field policy allows, such as
>   `watch_list`, can now be written.
> - `["*"]` in a field set now means every field. A profile that used it, and
>   so failed every call, becomes fully open.
> - `readable: []` no longer blocks writes to its table. Add `writable: []` to
>   keep writes blocked.
>
> [Upgrading to 2.2.0](docs/V2-MIGRATION.md#upgrading-to-220) lists every case
> with its remedy.

### Security

- **Denial-of-service fix: oversized requests are rejected before
  validation.** A single very large or deeply nested request could make
  the server use far more memory and time than its size suggests, until it
  stopped responding. Every
  incoming message, over stdio and HTTP, now passes plain structural checks
  before any schema runs, and one outside the limits is rejected with a short,
  fixed error. The limits admit the largest call any tool accepts, so
  legitimate calls are not affected. (#16)
  - Messages: arrays of at most 10,000 elements, at most 52,176 array
    elements and object members in total, and at most 32 levels of nesting.
    Over HTTP such a message gets a 400 with JSON-RPC error `-32600`
    `Request exceeds structural limits.`; over stdio a request with a usable
    id gets the same error, and anything else is dropped.
  - Tool arguments: at most 52,112 array elements and object members.
  - `structured_query`: at most 2,048 values, 12 levels deep, arrays of 32,
    objects of 8 keys, 64 conditions and 65 groups. Any query the compiler
    accepts is within these.
  - Existing collection limits (`sn_atf_author` `steps` and `test_sys_ids`,
    `structured_query` `order_by`, group `conditions`, set `values`, ATF
    name-value inputs) are checked before any element is parsed.
- **Dependency advisories.** `zod` moves to 4.6.7, pinned exactly
  (GHSA-mrhx-c7xc-m3w5, CVE-2023-54404; no 3.x release is fixed).
  `@modelcontextprotocol/sdk` moves to 1.32.2 (GHSA-22jm-h49p-29qw,
  GHSA-6prh-2h8m-c8cw, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq, and
  GHSA-6qxp-vccf-f47h in the SDK's client-side OAuth flow, which this server
  does not use). `body-parser` (GHSA-27r3-jxmh-p828), `fast-uri`
  (GHSA-w74x-v6f9-j3xg), `hono`, `iconv-lite`, `ip-address`, `proxy-addr`
  (GHSA-jqcg-44mw-7w3h, critical) and `qs` take their fixed releases, and `npm audit --omit=dev` reports nothing. The
  container's runtime base, `gcr.io/distroless/nodejs22-debian13:nonroot`, is
  pinned to a digest with `libssl3t64` 3.5.7-1~deb13u3 (CVE-2026-84782) and
  Node 22.23.3. (#10, #16)
  - *`@hono/node-server` 2.1.3* (GHSA-rmxm-3fg6-px4f, medium). Its
    `serveStatic` decoded the request path twice, so a crafted path could skip
    middleware mounted on a static prefix. This server never uses
    `serveStatic`: the SDK's HTTP transport uses only the adapter's request
    listener, and the stdio server does not load the adapter at all. The
    upgrade keeps `npm audit` clean. The developer-only inspector's lockfile
    moves to 2.1.5.
- **Redirects are no longer followed.** API calls and the OAuth token request
  used to follow HTTP redirects: a cross-origin redirect forwarded an API-key
  header, and a 307 re-sent the token request body, which holds the client
  secret. Any 3xx now fails with "The instance redirected the request to
  another location", without echoing the `Location`. (#15)
- **Omitting the journal tools no longer withholds journals.** A profile that
  grants `sn_create`, `sn_update` or `sn_batch` on a table can now append
  `comments` and `work_notes` there, and `sn_batch` can post one
  customer-visible comment per matched record, each of which can send a
  notification. To withhold comments, set `fieldPolicy.<table>.writable` to an
  explicit list without `comments`, and narrow parent tables such as `task`
  the same way. (#11)
- **Journal writes are never re-sent.** The HTTP client no longer retries a
  `PATCH` or `PUT` that sets `comments` or `work_notes` after a 502, 503, 504
  or connection error, because the first attempt may already have appended
  the entry. A 429 is still retried and a 401 still refreshes once. Detection is by field
  name (`comments`, `work_notes`); see
  [Production security boundaries](docs/PRODUCTION-SECURITY.md#journal-content). (#11)
- `servicenow-mcp-setup grant` applies its default tools only to the tables,
  and the operations, named in that command. A re-grant could widen a target
  narrowed with `--tools`, or make a table reachable only as a related table
  directly readable or writable. (#11)
- `sn_batch` targets each matched record once per run and stops at a 401
  instead of retrying every remaining record with rejected credentials. It
  always looks up its records on the instance, never in the metadata cache, so
  a repeat run cannot act on an earlier run's matches. (#9, #11)
- **Metadata cache.** The cache no longer reads `sys_user` or
  `sys_properties`; remove any read grant on either table that you added only
  for it, because `sys_properties` rows can hold integration secrets. Cache
  entries are partitioned by credential, not by the ServiceNow user it runs
  as: after re-mapping a client-credentials application or API key to another
  user, or restricting that user, restart the server or rotate the secret.
  Table and field policy still apply on every call, cached or not. Until an
  entry is refetched, a tightened ServiceNow ACL is not seen: by default up to
  24 hours for metadata (configurable to 7 days) and 5 minutes for
  `sn_schema`. `sn_schema`
  returns `inherited_from` only where the profile can read `super_class` on
  `sys_db_object`. (#9)
- **`sn_flow_view` reads `sys_variable_value` and `var_dictionary`.**
  `sys_variable_value` is a system table, so a profile's `"*"` field-policy
  entry does not narrow it; name it to hide older flows' input values. Grant
  the flow tables with `tools: ["sn_flow_view"]`, as `grant --flows` does, to
  keep the generic read tools off them. See
  [docs/FLOW-VIEW.md](docs/FLOW-VIEW.md#field-policy). (#18)

### Added

- **`sn_flow_view`, the 24th tool.** It shows one Flow Designer flow or
  subflow as a Mermaid diagram, a numbered outline and a structured graph:
  trigger, steps, If / Else If / Else, loops, parallel branches, Try / Catch,
  input values and data pill labels, and the subflows it calls to depth 3. It
  is read-only, reads 15 `sys_hub_*` and variable tables through the Table API
  under the profile's table and field policy, and never calls Flow Designer's
  internal API. Input values are shown by default, with sensitive names and
  password types redacted; `include_inputs: false` reads no values. The
  result fits `max_response_bytes` (default 100,000). See
  [docs/FLOW-VIEW.md](docs/FLOW-VIEW.md). Thanks to Jace Benson's `jsn` CLI,
  whose flow inspection informed the approach; no `jsn` code is used. (#18)
- `servicenow-mcp-setup grant --flows` grants read on the `sn_flow_view`
  tables, bound to `sn_flow_view` only. (#18)
- **Policy card.** `sn_profile` returns the profile's effective policy as data
  (`policy`) and as a text table (`policy_card`), and
  `servicenow-mcp-setup policy show --profile <name> [--json]` prints the same
  card: readable and writable tables with their tools, field rules, class and
  domain fields that need explicit listing, auth type, raw encoded-query
  reads, ATF grants and `sn_batch` limits. It never prints a secret, key or
  credential reference, and it enforces nothing new. The data is held to
  40,000 bytes and the text to 24,000; `policy.truncated` says what was cut.
  (#17)
- **`sn_batch` dry runs show a sample.** A dry run also returns up to 5
  matched records (`sys_id` plus a `number`, `name`, `short_description` or
  `title` the profile may read), `fields_to_write` (names, never values) and a
  note that `confirm` re-runs the query. The sample costs one extra read; if
  it fails or takes more than 5 seconds, the dry run still returns the count.
  A target granted only `sn_batch` can therefore now see up to 5 display
  values in a dry run, where before it saw a count. (#17)
- **Warnings on risky grants.** `servicenow-mcp-setup grant` and the setup
  wizard warn when a grant gives write access to a privilege-sensitive table:
  roles, groups, delegation, ACLs, approvals, scripts, `sys_properties`,
  `sys_user`, `sys_user_group` and authentication tables. The wizard also
  warns on the `"*"` write wildcard, which `grant` rejects. The grant still
  goes ahead; `grant --json` carries the text in `warnings`. (#17)
- **Journal fields through the generic write tools, on every table.**
  `sn_create`, `sn_update` and `sn_batch` accept `comments` and `work_notes`
  on every table granted for writes, with the dedicated tools' bounds, and
  field policy decides permission. The dedicated tools remain. (#11)
- `sn_batch` results carry a `message` saying how many records were not
  confirmed or not sent, and why the run stopped. (#11)
- **MCP Registry metadata.** `package.json` declares `mcpName`
  `io.github.onlyflowstech/servicenow-mcp`, and the package ships the
  `server.json` manifest for the official MCP Registry. (#14)
- The README leads with what the server controls and what it does not, lists
  the tools by area, and documents per-profile field policy. (#11, #13, #14)
- From the 2.2.0 dev builds: the ATF tools `sn_atf_author`, `sn_atf_run`,
  `sn_atf_results` and `sn_atf_readiness`, with `setup grant --atf`;
  Windows support in `servicenow-mcp-setup`; and the npm `dev` channel for
  prereleases (`npm install -g @onlyflows/servicenow-mcp@dev`). Details are
  under 2.2.0-dev.1 through 2.2.0-dev.6 below.

### Changed

- **Field policy and journal rules (breaking for some profiles).** Each item
  below has its remedy in
  [Upgrading to 2.2.0](docs/V2-MIGRATION.md#upgrading-to-220). (#11)
  - `SN_FIELD_POLICY_DEFINITIONS` configures only the `SN_PROFILE_NAME`
    environment profile. While it is set and a config file supplies the
    profiles, the server, `servicenow-mcp-setup` and `servicenow-mcp-profile`
    refuse to start and say how to move the policy into each profile's
    `fieldPolicy`.
  - Field policy is validated when profiles load. A malformed `fieldPolicy`,
    `readableTableFields` or `writableTableFields` used to deny every call on
    its profile, or narrow nothing; it now stops startup with the profile, key
    path and table named and no configured value repeated. One bad profile
    stops the whole file from loading.
  - A profile's `"*"` field-policy entry now reaches `incident`,
    `change_request`, `problem`, `sc_request`, `sc_req_item`, `sc_task`,
    `task`, `cmdb_ci`, `cmdb_ci_server`, `cmdb_ci_computer`, `kb_knowledge`
    and every custom table, so `{"*": {"writable": []}}` now denies writes to
    them. The 23 built-in system tables still never take it.
  - `sys_class_name`, `sys_class_path`, `sys_domain` and `sys_domain_path`
    are written only where a profile lists them by name; no wildcard covers
    them.
  - `sn_incident_add_comment` and `sn_incident_add_work_note` are denied when
    the incident's `writable` set leaves out `comments` or `work_notes`.
  - `incident` accepts every field the profile allows, not only the 14 typed
    fields; those 14 keep their typed checks.
  - `["*"]` in a field set means every field; it used to fail every call.
    `readable: []` no longer blocks writes as a side effect; add
    `writable: []` for that.
  - A dot-walked or `variables.*` write key is denied with the reason
    `unsupported_field_path`, and a write-value denial names the field and
    table, never the value.
- **`sn_batch` uses the ServiceNow REST Batch API and never re-sends a batch
  that may have reached the instance.** Confirmed updates and deletes go up to
  50 records per request, with each request kept under 4 MiB unless one
  record alone exceeds about 3 MiB, which is then sent on its own. A batch
  sub-request that fails with a server error is reported as unconfirmed, not
  retried. The run falls back to one Table API call per record only when the
  instance refuses a batch request (401, 403 or 404), and only for that
  batch's records and the ones after it. That fallback follows the HTTP
  client's retry rules: an ordinary update or delete is retried up to twice
  after a 502, 503, 504 or connection error, and a journal write is re-sent
  only after a 429 or a 401 credential refresh, when ServiceNow has not
  processed it. A rate limit (429) that persists through the client's retries
  stops the run with the `Retry-After` hint. Unconfirmed records count as
  neither processed nor failed; records not sent count as failed. (#11)
- `servicenow-mcp-setup grant --write incident` also binds the two incident
  journal tools; comments are customer-visible. An explicit `--tools` list
  withholds them. Existing profiles are not changed. (#11)
- `sn_update` advertises `idempotentHint: false`, because a journal field
  appends an entry on every call. (#11)
- **Metadata caching works in every auth mode.** Freshness is checked against
  the table's row count and newest `sys_updated_on`, so OAuth
  `client_credentials` and API-key profiles, where the cache used to turn
  itself off, now cache too. `sn_schema` results are reused for 5 minutes
  (`schemaCacheTtlMs` / `SN_SCHEMA_CACHE_TTL_MS`, up to 1 hour), and
  `force_recache: true` refreshes one read. (#9)
- **zod 4 is visible to clients in three ways.** Input validation errors
  reported by the MCP SDK use zod 4's wording (for example `Invalid input:
  expected string, received undefined` instead of `Required`); tool schemas
  are served inline instead of with internal `$ref`s, which adds about 18 KB
  to `tools/list`; and integer fields in output schemas state the
  safe-integer range. Tools accept and reject the same input as before. (#16)
- **Less memory at startup.** The startup tool-catalog check no longer
  compiles output-schema validators it never uses, which saves about 6 MB of
  idle memory in a stdio server. Validation of real calls is unchanged. (#19)

### Fixed

- A hibernating developer instance, and any other HTML page returned instead
  of an API response (single sign-on, maintenance, proxy), now gives a clear
  error instead of a generic upstream failure: "The ServiceNow instance
  <host> appears to be hibernating ... wake it at
  https://developer.servicenow.com", or a fixed "returned an HTML page"
  message. A 200 response that is not valid JSON gets a fixed message too,
  and none of these repeats response text. The setup wizard and
  `servicenow-mcp-setup doctor --live` no longer print raw error messages, and
  `doctor --live` checks profiles concurrently with a 10-second timeout. (#15)
- `incident` fields outside the 14 typed ones, such as `cmdb_ci`,
  `business_service`, `watch_list`, `hold_reason` and every `u_`/`x_` custom
  field, are writable. Incident `description`, `close_notes`, choice fields
  and the reference fields `caller_id`, `assignment_group` and `assigned_to`
  can be cleared with `""` or `null`. (#11)
- Generic writes accept `null`, finite decimals such as `12.5`, arrays for
  list fields such as `watch_list`, and the `{value, display_value, link}`
  read shape. (#11)
- `sn_batch` applies the same value policy as `sn_update` and sends the
  canonical values; it used to send the caller's values unchecked. It now
  uses the documented REST Batch API shape, so a batch the instance had
  already applied is no longer replayed one record at a time, and a large
  batch no longer becomes a request of tens of megabytes. (#11)
- Write responses always include the written record's `sys_id`, so a
  successful create no longer reads as a failure that invites a duplicate
  retry. (#11)
- The metadata cache no longer serves stale rows on accounts east of UTC, and
  it detects deletes. A table whose newest row is dated in the future is not
  cached. (#9)
- `sn_schema` and `fields: "all"` follow a table's parents by name instead of
  by label, so hierarchies such as `alm_hardware` keep their inherited
  fields. (#9)
- `servicenow-mcp-setup` offers a table's parent by name, not by label, and
  fetches one OAuth token for its parent lookups. The `relatedTables`
  documentation, `grant` output and `--related` help now say what
  `grant --related` adds. (#12)
- From the 2.2.0 dev builds: tool schemas no longer declare JSON Schema
  draft-07, which clients on the current MCP specification refused
  (2.2.0-dev.6), and `servicenow-mcp-setup` finds client CLIs and registers
  clients on native Windows (2.2.0-dev.6).

## [2.2.0-dev.6] — 2026-09-16

### Fixed

- Tool schemas no longer declare JSON Schema draft-07. Clients on the current
  MCP spec validate with a 2020-12-only validator and refused every tool. The
  schemas now carry no `$schema`, and each is valid under both dialects.
- `servicenow-mcp-setup` works on native Windows. Commands are found through
  PATH and PATHEXT instead of `/bin/sh`, so `doctor` no longer reports a correct
  global install as missing, and Claude Code and Codex are detected and
  registered.
- On Windows, clients are registered to launch `node.exe` with the absolute path
  to `dist\index.js`, because MCP clients can't start npm's `.cmd` shims. Client
  CLIs installed as `.cmd` shims run through `cmd.exe` with escaped arguments.
- The setup wizard rejects an unusable profile name, such as one containing a
  space, where it is typed, and suggests a valid one, instead of failing at the
  final save. `servicenow-mcp-profile create` checks `--name` before reading
  any secret.

### Added

- The setup wizard reports which client CLIs it found before its first
  question. A Claude Code or Codex CLI installed in its default location but
  missing from PATH is found and used by full path, and the wizard explains how
  to fix PATH.

## [2.2.0-dev.5] — 2026-09-16

### Fixed

- ATF failures include result/step IDs, a referenced step label fallback, and
  explicit head/tail excerpts. The new `sn_atf_results step` action retrieves
  complete summary or output text in bounded chunks.
- Return 200 test summaries by default with explicit test/failure pagination,
  replacing the inaccessible 100-test display cap.
- Report observed `status_changed` instead of inferring flakiness from pass/fail
  transitions; the deprecated `flaky` field stays empty.
- Include suite reads in the authoring setup preset for membership verification.

- Container validation expects the current 23-tool contract and reports named,
  bounded asynchronous stages instead of leaving pending checks without diagnostics.
- Docker validation subprocesses have a one-minute timeout.
- Refresh the pinned Distroless runtime base to pick up the OpenSSL security fix
  for CVE-2026-14456; retain the high/critical vulnerability scan gate.

## [2.2.0-dev.4] — 2026-09-15

### Fixed

- Verify that the suite and every requested test are readable before creating
  any memberships. Missing references fail without partial inserts.
- Report duplicate test IDs as invalid input instead of a table-policy denial.
- Normalize ServiceNow reference objects when listing tests by suite name.
- Block readiness for missing or unreadable test references and active tests
  without active steps, including tests in child suites. Inactive tests do not
  count as missing references.

### Validation

- Release gates passed: 1,616 unit tests, 250 protocol checks, 72 profile
  checks, 14 release checks, and no reported production dependency vulnerabilities.
- All four fixes were verified against the fd demo instance using disposable
  Global records; fixtures and their update/deletion metadata were removed.

### Validation limits

- Cloud Runner provisioning and remote execution were verified on the demo
  instance. Positive UI workflows remain blocked by its page JavaScript error
  involving `proActiveTrigger`; this release does not suppress that error.
- Authenticated inbound REST steps still require separate credential validation.

## [2.2.0-dev.3] — 2026-09-15

### Changed

- ATF execution is cloud-only: every suite submission sends `run_in_cloud=true`.
  Requests with `false` are rejected, and cloud failures never fall back to a
  local browser runner.
- Readiness checks the ServiceNow Cloud Runner application instead of requiring
  a local scheduled browser heartbeat. Installation alone remains unverified
  until cloud provisioning and execution are validated.

### Fixed

- Authoring readiness includes the required output-mapping write grant.
- REST JSON element assertions document slash-separated paths such as
  `result/number`, matching native ATF behavior.

### Validation and known limitations

- Added coverage for catalog choices, booleans, REST input maps, script grants,
  cloud-only submission, and absence of a local-runner fallback.
- Cloud UI execution remains unverified: the PDI accepted a cloud submission,
  but its cloud-user setup check could not reach ServiceNow cloud infrastructure.
  This prerelease is intended for validation on a configured demo instance.
- Temporary PDI fixtures and results were removed and original profile grants
  restored. ServiceNow denied deletion of protected internal rollback history;
  no ACLs were changed to remove it.

## [2.2.0-dev.2] — 2026-09-15

### Added

- ATF readiness checks, CI/CD suite execution with bounded polling, detailed
  results, persistent history and comparisons between runs.
- A verified catalog of 13 typed ATF steps, including REST headers/query maps
  and references to outputs from earlier steps in the same test.
- Native authenticated ATF form input saving and stored-value verification,
  without installing a scoped application or changing ServiceNow ACLs.
- Authoring grants now include input mappings and required metadata reads.

### Fixed

- Global scope creation accepts the platform's `global` identifier; new steps
  inherit their parent test's scope.
- Plugin readiness recognizes the platform's `active` choice value.
- Step input verification handles stored boolean values and enforces security
  by default for record queries and validation.
- Failed step authoring performs bounded cleanup even after request cancellation
  and reports remaining input or mapping records.

### Validation

- PDI validation in Global: all 13 types authored and read back; server-side
  assertions, record-output chaining, REST unauthorized-response checks, results,
  failure details, history and comparisons verified. Temporary records removed.
- Browser-driven steps were authored but their execution requires an ATF browser
  runner. Authenticated REST requests need their own ATF request credentials.
- This remains a dev prerelease; native forms must be verified against each
  supported ServiceNow version.

## [2.2.0-dev.1] — 2026-09-14

### Added

- Tag-driven dev prereleases publish to the npm `dev` channel while stable
  releases continue to publish to `latest`.

- `sn_atf_author` creates tests, suites, and ordered suite memberships under
  explicit table and field grants. Failed attempts return a structured rollback
  report and identify uncertain inserts that require inspection before retrying.
- `setup grant --atf` binds the five ATF authoring tables to `sn_atf_author`
  without enabling execution or script steps.
- Per-profile ATF configuration, opt-in execution-policy infrastructure, and
  escaping-first readable tool renderers.
- An identity-bound ATF result-cache library with atomic writes, concurrent-writer
  locking, bounded summaries, private storage and memory fallback. Execution and
  results tools will connect to this library in a subsequent change.

### Fixed

- ATF suite-result table policy fields use `rolled_up_test_*`, matching the
  platform fixtures rather than the CI/CD response spelling.

## [2.1.0] — 2026-09

> **Read this before upgrading if any profile grants `writeTables: ["*"]`, or
> names a table other than `incident`.** In 2.0.0 a hardcoded gate confined
> `sn_create` and `sn_update` to the `incident` table no matter what a profile
> granted, and the README documented them that way. That gate is gone: those
> tools now write any table the profile grants. If you granted a wide write
> allowlist while relying on the documented incident-only behaviour to keep
> single-record writes narrow, that assumption no longer holds — **review the
> `writeTables` allowlist and `targets` on every profile before upgrading.**
> This ships as a minor because the grant was always the operator's, and the
> gate was a defect that stopped it taking effect; the effective write surface
> can still widen without any configuration change on your side.

### Changed

- **`sn_create` and `sn_update` are no longer restricted to `incident`.** They
  write to any table the profile grants, so the configured `tableAccess` and
  field policies are now the only thing deciding which tables are writable —
  the same boundary `sn_batch` and `sn_delete` already answered to. Previously
  a hardcoded gate rejected every other table regardless of configuration,
  which both blocked granted work and left the restriction unenforced on
  `sn_batch`. **A profile granting `writeTables: ["*"]` (or naming other
  tables) now permits single-record writes to those tables through
  `sn_create`/`sn_update`; narrow the grant if that is wider than intended.**
  `incident` keeps its bounded typed value policy (approved ordinary fields,
  required `short_description` on create, range-checked `impact`/`urgency`/
  `priority`/`state`); other tables get generic value bounds — scalar values
  only, no control characters, at most 100,000 characters. The `sn_create`
  result's `table` is now the table written rather than the literal
  `"incident"`.
- **Policy denials are classified separately in errors and audit records.** A
  bounded-value rejection is reported as such and audited as
  `write_value_denied`, instead of being reported as "Table access was denied
  by policy" and audited as `table_access_denied`. The previous message named
  `tableAccess.writeTables` — a key that could not affect the outcome — and
  sent operators to re-issue grants that were already correct. Structured HTTP
  tool events also accept every policy-rejection reason now; previously any
  reason other than `table_access_denied` threw while the event was built.

### Fixed

- A write denied by the bounded value policy was reported as
  `ERROR: Table access was denied by policy.` — naming `tableAccess.writeTables`,
  a per-profile key that was already correct and could not affect the outcome.
  Operators re-issued grants against a restriction no configuration could lift.
  Each failure reason now has its own message, and the four
  reasons (`unsupported_table`, `missing_short_description`, `invalid_value`,
  `invalid_mode`) are no longer flattened into one misleading string.
- The incident restriction was not a boundary: `sn_batch` reached the same
  `PATCH /api/now/table/{table}/{sys_id}` endpoint for any table, on a bulk
  surface, so the gate blocked the documented path while leaving the
  undocumented one open. See **Changed** above for how this was resolved.
- Structured HTTP tool events accepted only `table_access_denied` for a policy
  rejection. Any other reason — including the existing `field_access_denied` —
  threw a `TypeError` while the event was being built.
- The 50,000-envelope validation gate asserted a single wall-clock reading
  against a 1000ms ceiling, which measured CI runner load as much as this code
  and failed at 1117ms while passing locally. It now takes the best of three
  rounds against a ceiling set to catch an order-of-magnitude regression.

## [2.0.0] — 2026-09

2.0 is a local, single-owner stdio server. Your client spawns it and speaks
over that process's stdin and stdout; nothing listens on a port.

**The transport is unchanged from 1.0.0.** A client entry that launches the
package still launches it. If you configured against a 2.0 pre-release that
served Streamable HTTP, see [Migrating to 2.0](docs/V2-MIGRATION.md#1-transport-unchanged).

Upgrading from 1.0.0 requires two changes on every install: name a profile on
every tool call, and grant table access. Everything else applies only if you
used the affected surface.

### Breaking

- **Every tool call must name a `profile`.** There is no default, active, or
  session-selected profile and no switch operation. Missing, empty, unknown or
  invalid names fail before credential resolution or client construction.
  Bare `SN_*` environment configuration now requires `SN_PROFILE_NAME` rather
  than inferring a single implicit connection.
- **Table access is deny-by-default per profile.** A profile with no rules
  denies every call. Grant with `servicenow-mcp-setup grant`. In 1.0.0 a tool
  could reach any table the credential could.
- **`sn_attach` no longer accepts host filesystem paths.** `file_path` and
  `output_path` are removed with no flag to restore them; uploads take
  `content_base64` and downloads return inline base64. The server touches no
  host filesystem, so behavior is identical whether run locally or in a
  sandbox.
- **`sn_script` is withdrawn.** It was never functional — it returned "not yet
  supported" while being advertised as destructive. It remains in the tree as
  future work (SNS-39) and is not registered. `tools/list` returns 19 tools.
- **Incident journal fields moved to dedicated tools.** `sn_update`,
  `sn_create` and `sn_batch` reject generic `comments` and `work_notes` writes
  and point at `sn_incident_add_comment` / `sn_incident_add_work_note`, which
  are append-only.
- **Raw encoded queries are opt-in per tool and table.** Structured filters are
  the default path.
- **`MAX_FIELDS_PER_OPERATION` raised from `32` to `10_000`**, and
  `excessive_field_selection` is removed from the exported
  `FieldPolicyFailureReason` union.
- **One `bin` becomes three**: `servicenow-mcp`, `servicenow-mcp-profile`,
  `servicenow-mcp-setup`.

### Added

- **Multi-instance profiles.** Named connections with credentials encrypted at
  rest (AES-256-GCM) in an owner-only `~/.servicenow-mcp`, or referenced from
  the environment.
- **OAuth 2.0 (`client_credentials` and `password`) and API-key
  authentication**, alongside basic.
- **`servicenow-mcp-setup`.** Run bare on a terminal it walks through one
  connection end to end: instance, credential, live verification against that
  instance, table grants, profile write, and client registration. Nothing is
  written to the profile until ServiceNow accepts the credential, and the
  profile and its grants are written together so there is no window where a
  profile exists that denies everything.
- **`servicenow-mcp-setup doctor`.** Diagnoses an install and prints a specific
  remedy per failure — Node version, `servicenow-mcp` resolving on `PATH`, file
  modes, profile completeness, credential resolution, table access.
- **`servicenow-mcp-setup grant`.** Writes least-privilege table rules onto a
  profile, validated by the same loader the server uses at request time, so a
  bad grant fails at the CLI rather than at the first tool call.
- **`sn_profile` tool** and the `servicenow-mcp.add-profile` prompt, adding the
  `prompts` capability.
- **Metadata caching** for dictionary and schema reads, keyed by instance *and*
  credential identity. Off by default for tables you do not name. Requires a
  resolvable session timezone, so it is disabled for OAuth `client_credentials`
  and API-key profiles, which carry no username.
- **Token-efficient responses** — compact JSON, bounded default field
  selection, pagination metadata, `response_format`, and a
  `max_response_bytes` truncation guard.
- **MCP tool annotations and display titles** on every tool.
- **Per-request failures surface as warnings** rather than being swallowed.

### Changed

- **`fields=all` and `response_format: "detailed"` are capped at 100 columns**
  rather than dropping `sysparm_fields`, which could exceed the response budget
  and fail the call outright. Columns resolve from `sys_dictionary` including
  inherited fields; sensitive names are excluded from the request rather than
  scrubbed from the response. `sn_query` and `sn_get` both report truncation.
- **Journal content is readable on request.** `comments` and `work_notes` are
  returned by `fields=all`, `response_format: "detailed"`, an explicit
  `fields=comments`, and `sn_schema`. The default projection still excludes
  them. Journal content routinely contains customer PII, so asking for all
  fields on `incident` now returns customer-visible commentary.
- **`sn_attach` has no transport size ceiling.** The former ~760 KiB practical
  limit came from the HTTP body cap; the tool's own 10 MiB bound is the only
  one in force.
- **HTTP authentication is opt-in and off by default**, for the dormant
  transport only. An empty `MCP_BEARER_TOKEN` is a startup failure rather than
  a way to disable it, so a half-applied env file stops the service instead of
  silently opening the port. A non-loopback `MCP_HOST` with no token refuses to
  start.

### Security

- **Field policy cannot be widened by configuration into a fail-open.** A
  profile-scoped policy previously discarded the built-in table policies
  wholesale, permitting writes to `sys_script` — arbitrary server-side
  JavaScript executed as the integration account. Configuration now layers onto
  the built-ins and an unspecified `writable` denies rather than permits.
- **`tableAccess` is the sole table-level authority.** The hard-deny list is
  removed; a profile's grants plus ServiceNow's per-user ACLs decide access.
  Deliberate, and documented in [PRODUCTION-SECURITY.md](docs/PRODUCTION-SECURITY.md).
- **Sensitive field names are refused for read, write, schema enumeration and
  query filtering.** Filtering was previously reachable under a wildcard
  readable set, which leaks a value one comparison at a time through row counts.
- **Metadata cache is keyed by credential identity**, so two profiles against
  one instance no longer share cached rows and bypass per-user ACLs.
- **Setup never echoes a typed secret**, and never places one in argv, shell
  history or a client configuration file.
- **`--force` no longer regenerates `SN_PROFILE_ENCRYPTION_KEY`**, which
  silently made every stored credential undecryptable. Rotation is a separate,
  explicit flag, refused while a profile file exists.
- **File modes are repaired on every write**, not only at creation, so a
  pre-existing world-readable env file cannot receive fresh secrets.
- **`http://` endpoints are restricted to loopback** unless explicitly allowed.

### Fixed

- `sn_aggregate` dropped ungrouped `COUNT` results from the Stats API.
- `sn_syslog` level names did not map to numeric values, and query values were
  not escaped.
- The metadata cache freshness probe compared `sys_updated_on` in UTC while
  ServiceNow evaluates it in the session user's timezone, so on a non-UTC
  account an updated record could appear unchanged for a full TTL. The zone
  name is now resolved and cached, and the offset computed per instant so DST
  transitions are correct.
- Inline base64 was decoded before its size was checked, and invalid base64
  raised an internal error rather than a correctable one. Line-wrapped base64
  — what `base64 file.pdf` produces — was rejected.
- `file_name` accepted Unicode bidirectional overrides, so
  `invoice‮gnp.exe` rendered as `invoiceexe.gnp`.
- Field-policy denials were reported and audited as table denials, on tables
  the operator had just granted, with the fix in a configuration key the
  message never named.
- The compiled `bin` entrypoints were not executable, so a globally linked
  install failed with "permission denied" after any rebuild.
- HTTP rate-limit rejections returned an empty body, which benchmarks could not
  distinguish from a fast success.

## [1.0.0] — 2026-07

Initial public release. 17 tools over stdio, single instance configured from
`SN_*` environment variables.
