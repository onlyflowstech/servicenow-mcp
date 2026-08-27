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
  }
);
