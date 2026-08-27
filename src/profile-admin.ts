#!/usr/bin/env node

/** Out-of-band profile administration. This module is never registered as MCP. */

import type { Readable, Writable } from "node:stream";
import {
  EnvironmentProfileEncryptionKeyProvider,
  type CredentialSource,
  type ProfileEncryptionKeyProvider,
  type ProfileSecretField,
  credentialSourceKind,
  encryptCredential,
  secretReference,
} from "./profile-credentials.js";
import {
  ProfileManager,
  type Profile,
} from "./profile-manager.js";
import type { AuthType, GrantType } from "./config.js";

type Command = "create" | "inspect" | "rotate" | "remove";
type SourceMode = "encrypted" | "reference";

export const MAX_SENSITIVE_VALUE_CHARACTERS = 16_384;
export const MAX_PROTECTED_INPUT_BYTES = 65_536;
export const MAX_PROTECTED_INPUT_VALUES = 4;

const OPTION_ARITY: Readonly<Record<string, 0 | 1>> = Object.freeze({
  "--name": 1,
  "--instance": 1,
  "--auth-type": 1,
  "--username": 1,
  "--client-id": 1,
  "--grant-type": 1,
  "--api-key-header": 1,
  "--description": 1,
  "--timeout-ms": 1,
  "--source": 1,
  "--provider": 1,
  "--field": 1,
});

export interface ProfileAdminIO {
  readSensitive(label: string): Promise<string>;
  write(value: string): void;
}

export interface ProfileAdminDependencies {
  manager?: ProfileManager;
  keyProvider?: ProfileEncryptionKeyProvider;
  io?: ProfileAdminIO;
}

interface ParsedArguments {
  command: Command;
  values: ReadonlyMap<string, string>;
}

export async function runProfileAdmin(
  argv: readonly string[],
  dependencies: ProfileAdminDependencies = {}
): Promise<void> {
  const parsed = parseProfileAdminArguments(argv);
  const manager = dependencies.manager ?? new ProfileManager();
  const keyProvider =
    dependencies.keyProvider ?? new EnvironmentProfileEncryptionKeyProvider();
  const io = dependencies.io ?? createProtectedInputIO(process.stdin, process.stderr);
  const name = required(parsed.values, "--name");

  switch (parsed.command) {
    case "create": {
      const authType = parseChoice<AuthType>(
        parsed.values.get("--auth-type") ?? "basic",
        ["basic", "oauth", "apikey"],
        "auth type"
      );
      const grantType = parseChoice<GrantType>(
        parsed.values.get("--grant-type") ?? "client_credentials",
        ["client_credentials", "password"],
        "grant type"
      );
      const profile: Profile = {
        instance: required(parsed.values, "--instance"),
        authType,
        ...(parsed.values.has("--username")
          ? { username: parsed.values.get("--username") }
          : {}),
        ...(parsed.values.has("--client-id")
          ? { clientId: parsed.values.get("--client-id") }
          : {}),
        ...(parsed.values.has("--api-key-header")
          ? { apiKeyHeader: parsed.values.get("--api-key-header") }
          : {}),
        ...(parsed.values.has("--description")
          ? { description: parsed.values.get("--description") }
          : {}),
        ...(parsed.values.has("--timeout-ms")
          ? { timeoutMs: positiveInteger(parsed.values.get("--timeout-ms")) }
          : {}),
      };
      if (authType === "oauth") profile.grantType = grantType;

      const fields = requiredSecretFields(authType, grantType);
      validateCreateMetadata(profile, fields);
      for (const field of fields) {
        profile[field] = await readCredentialSource(
          parsed.values,
          io,
          keyProvider,
          name,
          field
        );
      }
      manager.addProfile(name, profile);
      io.write(`${JSON.stringify(safeProfileView(name, profile))}\n`);
      return;
    }
    case "inspect": {
      rejectOptions(parsed.values, ["--name"]);
      io.write(`${JSON.stringify(safeProfileView(name, manager.getProfile(name)))}\n`);
      return;
    }
    case "rotate": {
      const field = parseChoice<ProfileSecretField>(
        required(parsed.values, "--field"),
        ["credential", "clientSecret", "apiKey"],
        "credential field"
      );
      const current = manager.getProfile(name);
      const expectedFields = requiredSecretFields(
        current.authType ?? "basic",
        current.grantType ?? "client_credentials"
      );
      if (!expectedFields.includes(field)) {
        throw new Error("Credential field is not used by this profile");
      }
      const source = await readCredentialSource(
        parsed.values,
        io,
        keyProvider,
        name,
        field
      );
      manager.rotateCredential(name, field, source);
      io.write(`${JSON.stringify({ name, rotated: field })}\n`);
      return;
    }
    case "remove": {
      rejectOptions(parsed.values, ["--name"]);
      manager.removeProfile(name);
      io.write(`${JSON.stringify({ name, removed: true })}\n`);
    }
  }
}

/** Strict parsing is the shell-history/process-list credential boundary. */
export function parseProfileAdminArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 0 || !["create", "inspect", "rotate", "remove"].includes(argv[0])) {
    throw new Error("Expected profile command: create, inspect, rotate, or remove");
  }
  const command = argv[0] as Command;
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--") || raw.includes("=")) {
      throw new Error("Profile administration arguments are invalid");
    }
    const arity = OPTION_ARITY[raw];
    if (arity === undefined || values.has(raw)) {
      // In particular, --credential, --password, --secret, --client-secret,
      // --api-key, and --reference can never carry material in argv.
      throw new Error("Unsupported profile administration option");
    }
    if (arity === 1) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Profile administration option is missing a value");
      }
      values.set(raw, value);
      index += 1;
    }
  }

  const allowedByCommand: Record<Command, readonly string[]> = {
    create: [
      "--name", "--instance", "--auth-type", "--username", "--client-id",
      "--grant-type", "--api-key-header", "--description", "--timeout-ms",
      "--source", "--provider",
    ],
    inspect: ["--name"],
    rotate: ["--name", "--field", "--source", "--provider"],
    remove: ["--name"],
  };
  rejectOptions(values, allowedByCommand[command]);
  return { command, values };
}

export function createProtectedInputIO(
  input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void },
  output: Writable
): ProfileAdminIO {
  let pendingLines: Promise<string[]> | undefined;
  return {
    async readSensitive(label: string): Promise<string> {
      if (input.isTTY && typeof input.setRawMode === "function") {
        return readHiddenLine(input, output, label);
      }
      pendingLines ??= readAllProtectedInput(input);
      const lines = await pendingLines;
      const value = lines.shift();
      if (!value) throw new Error("Protected standard input did not contain a value");
      return validateSensitiveInput(value);
    },
    write(value: string): void {
      output.write(value);
    },
  };
}

async function readCredentialSource(
  values: ReadonlyMap<string, string>,
  io: ProfileAdminIO,
  keyProvider: ProfileEncryptionKeyProvider,
  profile: string,
  field: ProfileSecretField
): Promise<CredentialSource> {
  const mode = parseChoice<SourceMode>(
    values.get("--source") ?? "encrypted",
    ["encrypted", "reference"],
    "credential source"
  );
  if (mode === "reference") {
    const provider = required(values, "--provider");
    const reference = validateSensitiveInput(
      await io.readSensitive(`${field} reference`)
    );
    return secretReference(provider, reference);
  }
  if (values.has("--provider")) {
    throw new Error("Provider is valid only for a reference source");
  }
  const plaintext = await io.readSensitive(field);
  return encryptCredential(validateSensitiveInput(plaintext), profile, field, keyProvider);
}

function requiredSecretFields(
  authType: AuthType,
  grantType: GrantType
): ProfileSecretField[] {
  if (authType === "basic") return ["credential"];
  if (authType === "apikey") return ["apiKey"];
  return grantType === "password"
    ? ["credential", "clientSecret"]
    : ["clientSecret"];
}

function validateCreateMetadata(
  profile: Profile,
  fields: readonly ProfileSecretField[]
): void {
  if (fields.includes("credential") && !profile.username?.trim()) {
    throw new Error("Username is required for the selected authentication mode");
  }
  if (profile.authType === "oauth" && !profile.clientId?.trim()) {
    throw new Error("Client ID is required for OAuth");
  }
}

function safeProfileView(name: string, profile: Profile): object {
  return {
    name,
    instance: profile.instance,
    auth_type: profile.authType ?? "basic",
    ...(profile.grantType ? { grant_type: profile.grantType } : {}),
    credential_sources: {
      credential: credentialSourceKind(profile.credential),
      client_secret: credentialSourceKind(profile.clientSecret),
      api_key: credentialSourceKind(profile.apiKey),
    },
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value?.trim()) throw new Error(`Required option is missing: ${key}`);
  return value;
}

function rejectOptions(
  values: ReadonlyMap<string, string>,
  allowed: readonly string[]
): void {
  for (const key of values.keys()) {
    if (!allowed.includes(key)) throw new Error("Option is not valid for this command");
  }
}

function parseChoice<T extends string>(
  value: string,
  choices: readonly T[],
  label: string
): T {
  if (!choices.includes(value as T)) throw new Error(`Invalid ${label}`);
  return value as T;
}

function positiveInteger(value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) throw new Error("Timeout must be positive");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Timeout must be positive");
  }
  return parsed;
}

async function readAllProtectedInput(input: Readable): Promise<string[]> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_PROTECTED_INPUT_BYTES) {
        buffer.fill(0);
        throw new Error("Protected standard input exceeds the size limit");
      }
      chunks.push(buffer);
    }
    const combined = Buffer.concat(chunks);
    try {
      const lines = combined
        .toString("utf8")
        .split(/\r?\n/u)
        .filter((line) => line.length > 0);
      if (lines.length > MAX_PROTECTED_INPUT_VALUES) {
        throw new Error("Protected standard input contains too many values");
      }
      return lines.map(validateSensitiveInput);
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function readHiddenLine(
  input: Readable & { setRawMode?: (mode: boolean) => void },
  output: Writable,
  label: string
): Promise<string> {
  output.write(`${label}: `);
  input.setEncoding("utf8");
  input.resume();
  input.setRawMode?.(true);
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Credential entry cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          if (!value) reject(new Error("Credential value must not be empty"));
          else resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          if (value.length >= MAX_SENSITIVE_VALUE_CHARACTERS) {
            cleanup();
            reject(new Error("Credential input exceeds the size limit"));
            return;
          }
          value += character;
        } else {
          cleanup();
          reject(new Error("Credential input contains control characters"));
          return;
        }
      }
    };
    input.on("data", onData);
  });
}

function validateSensitiveInput(value: string): string {
  if (value.length === 0) throw new Error("Credential value must not be empty");
  if (value.length > MAX_SENSITIVE_VALUE_CHARACTERS) {
    throw new Error("Credential input exceeds the size limit");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error("Credential input contains control characters");
  }
  return value;
}

async function main(): Promise<void> {
  try {
    await runProfileAdmin(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profile administration failed";
    process.stderr.write(`[servicenow-mcp] ${message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
