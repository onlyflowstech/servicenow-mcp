/**
 * Regression guard for the wizard echoing a credential.
 *
 * A live OAuth client secret was rendered in plaintext under a prompt reading
 * "Input is hidden". Cause: the readline interface stayed attached to stdin
 * during the hidden read, and readline echoes what it reads. Unit tests with a
 * faked prompter could not have caught it, because the defect lives in the
 * real prompter's handling of the shared stream. These tests drive the real
 * prompter over a fake TTY and assert nothing secret reaches the output.
 */
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createTtyPrompter, resolveChoice } from "../src/setup.js";

const SECRET = "z`Yv-NOT-A-REAL-SECRET-9182";

interface FakeTty {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
  written(): string;
  type(text: string): void;
}

/** A duplex pair that presents as a terminal, so readline echoes as it would. */
function fakeTty(): FakeTty {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.defineProperty(input, "isTTY", { value: true });
  Object.defineProperty(output, "isTTY", { value: true });
  Object.defineProperty(output, "columns", { value: 80 });
  let raw = false;
  (input as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = (mode) => {
    raw = mode;
  };
  Object.defineProperty(input, "isRaw", { get: () => raw });
  const chunks: string[] = [];
  (output as unknown as PassThrough).on("data", (chunk: Buffer) =>
    chunks.push(chunk.toString())
  );
  return {
    input,
    output,
    written: () => chunks.join(""),
    type: (text) => (input as unknown as PassThrough).write(text),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("wizard never echoes a secret", () => {
  // Every field the four auth paths can ask for: basic and the OAuth password
  // grant use `credential`, client_credentials uses `clientSecret`, and an API
  // key profile uses `apiKey`.
  for (const field of ["credential", "clientSecret", "apiKey"]) {
    it(`keeps ${field} off the terminal after a preceding visible prompt`, async () => {
      const tty = fakeTty();
      const prompter = createTtyPrompter({ input: tty.input, output: tty.output });

      // The exact shape that leaked: a visible prompt, then a hidden one.
      const asked = prompter.ask("How should the credential be stored?", {
        default: "encrypted",
        choices: ["encrypted", "reference"],
      });
      await settle();
      tty.type("1\n");
      expect(await asked).toBe("encrypted");

      const secret = prompter.secret(field);
      await settle();
      tty.type(`${SECRET}\n`);
      expect(await secret).toBe(SECRET);

      prompter.close();
      expect(tty.written()).not.toContain(SECRET);
      expect(tty.written()).toContain(`${field}: `);
    });
  }

  it("still reads later visible prompts after the handoff", async () => {
    const tty = fakeTty();
    const prompter = createTtyPrompter({ input: tty.input, output: tty.output });

    const secret = prompter.secret("credential");
    await settle();
    tty.type(`${SECRET}\n`);
    await secret;

    const after = prompter.ask("Tables to allow for READS", {
      default: "incident",
    });
    await settle();
    tty.type("problem\n");
    expect(await after).toBe("problem");

    prompter.close();
    expect(tty.written()).not.toContain(SECRET);
  });

  it("does not echo a secret pasted into a visible prompt's retry", async () => {
    // The operator pasted their secret at the storage-mode question. readline
    // echoes a visible prompt by design, so the mitigation is ordering, not
    // suppression -- but a rejected answer must never be repeated back.
    const tty = fakeTty();
    const prompter = createTtyPrompter({ input: tty.input, output: tty.output });
    const asked = prompter.ask("How should the credential be stored?", {
      default: "encrypted",
      choices: ["encrypted", "reference"],
    });
    await settle();
    tty.type(`${SECRET}\n`);
    await settle();
    tty.type("1\n");
    expect(await asked).toBe("encrypted");
    prompter.close();

    // The rejection names the valid choices, never the rejected input.
    const rendered = tty.written();
    const afterEcho = rendered.slice(rendered.indexOf("Enter a number"));
    expect(afterEcho).not.toContain(SECRET);
  });
});

describe("numbered choice resolution", () => {
  const options = { choices: ["basic", "oauth", "apikey"], default: "basic" } as const;

  it("accepts the ordinal", () => {
    expect(resolveChoice("2", options)).toBe("oauth");
  });

  it("accepts the literal value", () => {
    expect(resolveChoice("apikey", options)).toBe("apikey");
  });

  it("accepts an empty answer as the default", () => {
    expect(resolveChoice("", options)).toBe("basic");
  });

  it("rejects an out-of-range ordinal and an unknown word", () => {
    expect(resolveChoice("9", options)).toBeUndefined();
    expect(resolveChoice("0", options)).toBeUndefined();
    expect(resolveChoice("sso", options)).toBeUndefined();
  });
});
