# Profile credentials and out-of-band administration

ServiceNow MCP V2 stores each authentication secret as either a provider-neutral
secret reference or a versioned encrypted envelope. It never stores plaintext
credentials or the encryption key in `~/.servicenow-mcp/config.json`.

## Administration entry point

After installing the package, invoke the dedicated operator-only executable:

```sh
servicenow-mcp-profile create \
  --name dev \
  --instance https://dev.service-now.com \
  --auth-type basic \
  --username integration.user \
  --source encrypted
```

When working from a source checkout, build first and invoke the same artifact
directly:

```sh
npm run build
node dist/profile-admin.js create \
  --name dev \
  --instance https://dev.service-now.com \
  --auth-type basic \
  --username integration.user \
  --source encrypted
```

When run in a terminal, the command prompts without echo. When standard input is
not a terminal, it reads bounded newline-delimited values from standard input.
Do not put passwords, API keys, client secrets, ciphertext, or secret references
in arguments. Credential-bearing options such as `--password`, `--credential`,
`--client-secret`, `--api-key`, and `--reference` are rejected.

For OAuth password grant, protected inputs are read in this order: user
credential, then OAuth client secret. Other modes read one value.

Available commands are:

```text
create  --name ... --instance ... [authentication metadata] --source encrypted
create  --name ... --instance ... [authentication metadata] --source reference --provider ...
inspect --name ...
rotate  --name ... --field credential|clientSecret|apiKey --source encrypted
rotate  --name ... --field credential|clientSecret|apiKey --source reference --provider ...
remove  --name ...
```

`inspect` reports only safe profile metadata and source kinds. It never returns
references, ciphertext, keys, or decrypted credentials. The MCP `sn_profile`
tool remains read-only and has no create, remove, or rotation operation.

## Two-profile isolation and recovery

For a complete two-profile walkthrough, create one profile with
`--source reference --provider env` and another with `--source encrypted` as
documented in [V2 service and client setup](CLIENT-SETUP.md). Enter the
reference name or protected value only through the non-echoed prompt or bounded
standard input. Never pass either value, ciphertext, or an encryption key in a
tool argument or command-line argument.

Each call still names exactly one profile. Resolving a referenced profile must
not resolve or construct the encrypted profile, and vice versa. Successful
results and bounded audit events identify the same resolved profile and
canonical instance. There is no default, active-profile state, or switch
operation.

Keep `SN_PROFILE_ENCRYPTION_KEY` in a separate approved key system, distinct
from the MCP bearer and every ServiceNow credential. A process has one key for
the encrypted envelopes in its profile file; profiles that require independent
key trust domains require separate private service deployments.

Back up only the owner-only encrypted/reference profile file and non-secret
version metadata. Exclude keys, plaintext, secret-manager exports, environment
dumps, and resolver credentials. Track the matching key version separately so
the backup is a recoverable pair without colocating its parts. For rotation,
prepare a complete working file under the new key, re-enter every encrypted
field, verify both explicit profiles, deploy the new file/key pair together,
and only then retire the old pair. Never serve mixed envelopes requiring
different keys.

Test recovery in an isolated private environment: restore owner-only
permissions, inject the matching key and resolver access separately, inspect
safe metadata, start the server, and run one bounded read for each explicit
profile. Verify crossed result/audit profile bindings and that a wrong key or
resolver failure stops before client construction. Retain the old pair until
that verification succeeds.

## Local encrypted storage

Encrypted values use AES-256-GCM with a fresh 96-bit nonce. The envelope records
only version, algorithm, nonce, authentication tag, and ciphertext. Authenticated
metadata binds the value to its profile name and credential field, so moving an
envelope to another profile or field fails authentication.

Supply exactly 32 random key bytes encoded as base64 or base64url through the
canonical `SN_PROFILE_ENCRYPTION_KEY` setting. Inject it separately through the
deployment secret mechanism or OS keychain; never add it to the profile file,
source tree, command arguments, logs, or diagnostics. A missing, malformed, or
wrong key fails before ServiceNow client construction.

## Secret references

The core defines a provider-neutral resolver interface and includes only an
environment adapter. New environment references use the canonical `SN_*`
namespace. Other providers are supplied as adapters by the embedding
deployment; no cloud SDK is linked into the core. References resolve only when
`ProfileManager.getConfig(profile)` constructs the selected execution
configuration.

## Storage and migration behavior

Configuration updates use an owner-only lock, write and sync a unique temporary
file, atomically rename it, and enforce mode `0600` on the file and `0700` on its
directory where the platform supports POSIX permissions.

V1 `env:...` references remain readable. Canonical `env:SN_*` values migrate to
structured references on the next write. A raw legacy plaintext credential is
rejected instead of being loaded or silently falling back to environment
configuration. To recover such a file, keep any backup owner-only, remove every
plaintext secret from the active configuration, and recreate or rotate each
credential through the protected administration entry point.
