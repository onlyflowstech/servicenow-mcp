import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../scripts/container-validation-stage.mjs", import.meta.url).href;
const run = (code: string) => spawnSync(process.execPath, ["--input-type=module", "-e", `import { runValidationStage } from ${JSON.stringify(moduleUrl)}; ${code}`], { encoding: "utf8", timeout: 3000 });

describe("container validation deadlines", () => {
  it("reports a named timeout instead of silently exiting with an unresolved await", () => {
    const result = run('await runValidationStage("stalled probe", () => new Promise(() => {}), 25);');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Container validation timed out: stalled probe");
    expect(result.stdout).toContain("Container validation: stalled probe");
  });
  it("releases the deadline when a probe succeeds", () => {
    const result = run('console.log(await runValidationStage("completed probe", () => 42, 60000));');
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain("42");
  });
  it("preserves the original failure and releases the deadline", () => {
    const result = run('await runValidationStage("failed probe", () => { throw new Error("expected failure"); }, 60000);');
    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("expected failure");
  });
});
