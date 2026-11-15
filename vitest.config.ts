import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Vitest's 5 s default is too tight for the real-server and sweep tests on
    // a slower or loaded runner (CI ran one file at five times its local
    // time). Tests that need longer, such as the large sweeps, set their own.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    // Restore process.env after every test. Field policy falls back to
    // process.env.SN_FIELD_POLICY_DEFINITIONS when no AsyncLocalStorage scope
    // is active, and process.env is shared by every file in a worker, so a
    // leaked stub silently changed policy resolution in later files.
    unstubEnvs: true,
  },
});
