import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptFiles = ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"];

export default tseslint.config(
  {
    name: "servicenow-mcp/ignores",
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    ...eslint.configs.recommended,
    name: "servicenow-mcp/javascript-recommended",
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    name: "servicenow-mcp/typescript-runtime",
    files: typescriptFiles,
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Under the stdio transport, stdout carries the JSON-RPC frames. Anything
    // else written there corrupts the stream and every session fails, with no
    // error and nothing in a test likely to catch it. Diagnostics go to stderr.
    // `src/setup.ts` is exempt: it is a CLI, where stdout is the output.
    name: "servicenow-mcp/stdout-belongs-to-the-protocol",
    files: ["src/**/*.ts"],
    ignores: ["src/setup.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "stdout",
          message:
            "stdout carries the MCP protocol under stdio; write diagnostics to process.stderr.",
        },
      ],
    },
  }
);
