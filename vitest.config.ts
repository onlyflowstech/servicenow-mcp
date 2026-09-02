import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Restore process.env after every test. Field policy falls back to
    // process.env.SN_FIELD_POLICY_DEFINITIONS when no AsyncLocalStorage scope
    // is active, and process.env is shared by every file in a worker, so a
    // leaked stub silently changed policy resolution in later files.
    unstubEnvs: true,
  },
});
