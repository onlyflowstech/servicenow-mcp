# Adding ServiceNow MCP tools

`defineServiceNowToolModule` is the canonical extension contract. A tool is a
single provider-neutral module: MCP metadata and Zod schemas, explicit security
and ServiceNow dependencies, one access preflight, and a handler that receives
only profile-resolved runtime services. Do not register tools directly with the
MCP SDK.

## Canonical module

`sn_schema` is the production reference module. Its complete implementation is
in `src/tools/schema-module.ts`; `src/tools/schema.ts` is only a compatibility
facade for existing source consumers. The excerpt below shows the contract
shape. Production modules live beside their domain implementation and are
added once to `allToolModules` in `src/tools/catalog.ts`.

```ts
import { z } from "zod";

import {
  filterSchemaEntries,
  MAX_FIELDS_PER_OPERATION,
  preparedReadableFields,
  resolveReadableFields,
} from "../field-policy.js";
import { resolveToolTableAccess } from "../tool-table-access.js";
import { escapeQueryValue, ok } from "../utils.js";
import {
  envelopeCompatibilityResult,
  productionToolOutputSchemas,
} from "./result-envelope.js";
import {
  defineServiceNowToolModule,
  withRequiredProfile,
} from "./tool-module.js";

const inputSchema = withRequiredProfile(
  z.object({
    table: z.string(),
    fields_only: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(500),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
);

export const schemaToolModule = defineServiceNowToolModule({
  runtime: "servicenow",
  definition: {
    name: "sn_schema",
    description: "Get policy-approved field metadata for a ServiceNow table.",
    annotations: {
      title: "Get table schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  inputSchema,
  outputSchema: productionToolOutputSchemas.sn_schema,
  requirements: {
    permissions: ["read"],
    tables: {
      kind: "dynamic",
      names: ["sys_dictionary"],
      description: "Policy-approved target plus dictionary metadata.",
    },
    apis: ["table"],
    fieldPolicies: ["read"],
    capabilities: ["metadata:schema"],
  },
  resolveAccess: (args, policy) =>
    resolveToolTableAccess("sn_schema", args, policy.encodedQueryAccess),
  handler: async (args, services) => {
    const readableFields =
      preparedReadableFields(args, args.table) ??
      resolveReadableFields(args.table, { fields: "all" });
    const response = await services.serviceNow.get(
      "/api/now/table/sys_dictionary",
      {
        sysparm_query:
          `name=${escapeQueryValue(args.table)}^internal_type!=collection` +
          `^elementIN${readableFields.map(escapeQueryValue).join(",")}` +
          "^ORDERBYelement^ORDERBYsys_id",
        sysparm_fields:
          "sys_id,element,column_label,internal_type,max_length,mandatory,reference",
        sysparm_offset: "0",
        sysparm_limit: String(MAX_FIELDS_PER_OPERATION + 1),
      }
    );
    const safeRows = filterSchemaEntries(response.result, readableFields);
    const page = safeRows.slice(args.offset, args.offset + args.limit);
    return schemaEnvelopeResult(args, page, args.offset + page.length < safeRows.length);
  },
});
```

The real handler additionally escapes the table identifier, applies the issued
field-policy marker before and after the request, maps dictionary records to a
stable public shape, and converts upstream failures to safe errors. Its stable
ServiceNow order is `element, sys_id`; the public envelope describes the mapped
order as `field, sys_id`. The issued policy contains at most 32 exact field
names, so the handler pushes that bounded set into `elementIN`, fetches the
complete set once at upstream offset zero, filters it again, and applies public
`limit` and `offset` locally. Denied or ACL-hidden dictionary rows therefore
cannot consume a caller page and hide later approved fields. The local page
helper uses the shared envelope adapter, then records authoritative `has_more`
and `next_offset` from the complete filtered set.

For a smaller fixed-table tool, the same registration pattern can use a static
table declaration and a fixed access request:

```ts
requirements: {
  permissions: ["read"],
  tables: { kind: "static", names: ["incident"] },
  apis: ["table"],
  fieldPolicies: ["read"],
  capabilities: ["incident:read"],
},
resolveAccess: (args) => ({
  args: Object.freeze(inputSchema.parse(args)),
  requests: Object.freeze([
    Object.freeze({ operation: "read" as const, table: "incident" }),
  ]),
}),
```

The handler intentionally does not add `profile`. The shared dispatcher adds
the canonical resolved name to `structuredContent` after a successful handler
return, then validates that enriched object against the module's strict output
schema before either raw JSON-RPC or an SDK client can receive it. Therefore the
declared output schema must include it through `withResolvedProfileOutput`, and
handlers must return every declared local field without undeclared extras.

Both composition helpers treat their source Zod objects as untrusted shape
containers. They snapshot a bounded plain data-field map once, validate that
the fields can be parsed, and rebuild a fresh contract-owned `z.object(...)`.
The top-level source object's prototype, bound methods, descriptors, and
identity are not used as proof of provenance and are not retained. Only the
normalized instances issued by these helpers may enter a module catalog.

Composition also hardens the complete reachable schema graph with cycle,
depth, node, property, and container-size bounds. Every nested Zod node gets a
contract-owned definition; object shapes and lazy targets are materialized
once; checks, arrays, plain objects, maps, sets, and regular expressions are
copied into parse-stable containers; Zod parse caches are initialized; and
schema definitions, methods, prototype behavior, and nodes are locked. Map,
set, and regular-expression mutation methods are disabled. References to an
older definition or collection therefore cannot change parsing or discovery.
Field schema nodes supplied to a composition helper become immutable and must
not be configured or reused for further schema construction afterward.

## Contract checklist

Every module must declare all of the following:

- an `sn_*` name, non-empty description, and all five MCP annotation fields;
- input composed with `withRequiredProfile` and output composed with
  `withResolvedProfileOutput`—local schemas cannot redefine `profile`;
- explicit read/write permissions;
- every ServiceNow API family (`table`, `aggregate`, `attachment`, or `atf`),
  including an explicit empty list when none is used;
- read/write field-policy dependencies and at least one reviewable capability;
- an access resolver that canonicalizes inputs and returns the complete table
  plan before client construction; and
- a handler using only the injected opaque ServiceNow operation facade, non-secret settings,
  immutable execution context and resolved policy, and provider-neutral logger.

The contract rejects missing fields, duplicate dependency entries,
permission/annotation conflicts, invalid or unnormalized schemas, missing
shared profile schemas, and duplicate tool names. It does not claim that
JavaScript prototype inspection can prove where a source object was
constructed. `registerServiceNowToolModules` snapshots the issued catalog and
preflights every configuration against the official SDK before the first
target registration call, so a late mutation or bad catalog cannot partially
register.

Use `runtime: "context-only"` only for a client-free diagnostic such as
`sn_profile`. Context-only modules cannot declare ServiceNow tables or APIs and
never receive a ServiceNow operation facade or configuration.

## Security and portability rules

- The access resolver is mandatory even when it returns an empty plan. A
  dynamic/composed operation must fail closed if it cannot determine the full
  plan before handler entry.
- Table declarations are review metadata; `resolveAccess` is the authoritative
  invocation-specific authorization input. Declare both accurately.
- Never put credentials, credential references, or the full resolved
  configuration in handler services. `settings` contains only the canonical
  instance origin, display-value preference, and relationship-depth bound.
  `serviceNow` is a frozen null-prototype facade of closure-bound operations;
  it exposes neither the underlying client nor authentication/configuration
  state.
- Do not import ChatGPT, Claude, OpenAI, Anthropic, tunnel, browser, or other
  AI-client integration code into a tool module. MCP transport and client
  compatibility remain outside the domain contract.
- Treat all ServiceNow content as untrusted. Apply field policy before requests
  and after responses, keep output bounded, and return safe errors.
- A write needs write permission, accurate non-read-only annotations, bounded
  scope, dedicated mutation tests, and a complete preflight before the first
  side effect.

## Required tests

Add evidence at three levels:

1. Unit-test the schema, access plan, handler, error paths, output bounds, and
   read/write behavior with fake injected services.
2. Contract-test registration failures, discovery metadata, required profile,
   output schema, resolved-profile envelope, and pre-handler rejection for a
   missing or unknown profile.
3. Extend `test/http-cross-client.test.ts` so both the official MCP SDK client
   and independent Fetch JSON-RPC fixture discover and invoke the same module
   over Streamable HTTP.

Run the focused module tests, then `npm run typecheck`, `npm run lint`,
`npm run build`, and `npm test`.

## Registration performance evidence

`test/tool-module.test.ts` validates the complete 20-module production catalog
2,000 times (40,000 module validations) under a one-second bound. This guards
against accidental network, credential, client, or other super-linear work in
startup preflight. The bound is deliberately much wider than local execution
for shared CI hosts.
