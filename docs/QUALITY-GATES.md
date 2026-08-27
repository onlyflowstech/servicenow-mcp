# Quality gates

The repository exposes separate deterministic checks for type safety, linting,
artifact compilation, and tests. Run them from a clean install before opening a
release change:

```bash
npm ci
npm run typecheck
npm run lint
npm run build
npm run test:unit
npm run test:protocol
npm run test:profile
npm run test:release
npm run release:contract
npm pack --dry-run --json --ignore-scripts
npm audit --omit=dev --audit-level=moderate
```

`npm run test:unit` is the complete deterministic suite. `npm run
test:protocol` is the focused HTTP protocol gate. It
proves the cross-client release matrix, profile and selected-instance
isolation, request boundaries, cancellation/deadline behavior, concurrency and
rate admission, and lifecycle shutdown without ServiceNow network access. The
full unit command includes the same files; release CI runs both commands as
separate evidence so the named protocol contract cannot silently disappear.
`test:profile` isolates encryption and credential/profile behavior, while
`test:release` locks the Inspector, smoke, workflow, package, rollback, and
no-tunnel contracts. See
`docs/CROSS-CLIENT-RELEASE-MATRIX.md` for the evidence-to-contract mapping.

For a production container release, also run:

```bash
npm run container:build
npm run container:validate
npm run container:scan
```

`npm run container:validate` exercises the official SDK and an independent
Fetch JSON-RPC client against the same immutable image. It compares all 20 tool
names, input schemas, output schemas, and annotations and verifies the explicit
profile boundary with synthetic local configuration. Provider tunnel coverage
is separate and optional; it is not part of this portable gate.

The container scan gate fails when no supported scanner is installed and fails
on high or critical image findings. The npm production audit separately treats
unresolved moderate-or-higher application findings as release evidence. A
release also requires two same-input builds with matching image IDs on each
target platform; cache hits alone are not sufficient evidence, so repeat once
with a clean BuildKit cache in the controlled release environment.

## Type checking

`npm run typecheck` runs the strict project TypeScript configuration with
`--noEmit`. It validates `src/` without creating or changing `dist/`. The gate
does not override or relax any compiler option from `tsconfig.json`.

## Linting

`npm run lint` runs ESLint with the maintained TypeScript ESLint parser and
recommended TypeScript rules over `src/`, `test/`, `vitest.config.ts`, and the
JavaScript files in `scripts/`. Warnings are treated as failures. The command
does not apply fixes; use the reported file and rule to make an intentional
source change.

The runtime and lint toolchain require Node.js 20 or newer. This matches the
Hono 2 server adapter and is enforced fail-closed by the package `engines`
field, the repository's `engine-strict=true` npm configuration, explicit
`npm ci --engine-strict` clean installs, and CI's Node 20/22 test matrix. A
separate CI contract job proves Node 18 is rejected while Node 20 installs.

Function parameters whose names begin with `_` are the one intentional-unused
convention. This is useful for required callback or interface parameters and is
encoded as `argsIgnorePattern: "^_"`; unused local variables and imports still
fail the gate.

## Continuous integration and publishing

Both pull-request CI and the stable-tag publish workflow run the portable
release contract, typecheck, lint, build, unit, protocol, profile, release,
package-manifest, production-audit, isolated pinned-Inspector, container-build,
container-validation, and pinned-scanner gates. A violation therefore stops
artifact creation and package publication. Tag publication additionally fails
unless `GITHUB_REF_NAME` exactly equals `v<package.json version>`.

Typecheck and lint alone cover SNSDK-52; the protocol command and full unit pass
additionally enforce the SNSDK-55 cross-client release matrix. SNSDK-57's full
evidence and rollback procedure is in
[`RELEASE-VALIDATION.md`](RELEASE-VALIDATION.md). Provider-hosted tunnel
validation remains optional and cannot replace any portable release gate.
