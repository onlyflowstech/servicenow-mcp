import { describe, expect, it, vi } from "vitest";
import { handler, schema } from "../src/tools/syslog.js";
import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

function metaClient() {
  const getWithMeta = vi.fn(async () => ({
    data: { result: [] },
    status: 200,
    headers: new Headers(),
  }));
  return { client: { getWithMeta } as unknown as ServiceNowClient, getWithMeta };
}

async function queryFor(args: Record<string, unknown>): Promise<string> {
  const { client, getWithMeta } = metaClient();
  await handler(schema.parse(args), client, config);
  const params = getWithMeta.mock.calls[0][1] as Record<string, string>;
  return params.sysparm_query;
}

describe("sn_syslog level filter", () => {
  // syslog.level stores numeric severities on the OUT-OF-BOX scale:
  // -1=debug, 0=information, 1=warning, 2=error (the "System Log >
  // Errors" module filters on level=2). An earlier revision shipped the
  // inverted map (error->0, info->2, debug->3), which silently returned
  // informational rows for level=error -- these expectations lock in the
  // corrected direction.
  it.each([
    ["debug", "-1"],
    ["info", "0"],
    ["warning", "1"],
    ["error", "2"],
  ])("maps level name %s to its numeric value %s", async (name, numeric) => {
    const query = await queryFor({ level: name });
    expect(query).toContain(`level=${numeric}`);
    expect(query).not.toContain(`level=${name}`);
  });

  it("maps level=error to level=2, never the informational level 0", async () => {
    const query = await queryFor({ level: "error" });
    expect(query).toContain("level=2");
    expect(query).not.toContain("level=0");
  });

  it.each(["-1", "0", "1", "2"])(
    "passes numeric level %s through unchanged",
    async (numeric) => {
      const query = await queryFor({ level: numeric });
      expect(query).toContain(`level=${numeric}`);
    }
  );

  it("rejects unknown level values in the zod schema", () => {
    expect(schema.safeParse({ level: "fatal" }).success).toBe(false);
    expect(schema.safeParse({ level: "3" }).success).toBe(false);
    expect(schema.safeParse({ level: "4" }).success).toBe(false);
    expect(schema.safeParse({ level: 2 }).success).toBe(false);
  });

  it("keeps the level values and description in the authoritative Zod schema", () => {
    expect(schema.shape.level.unwrap().options).toEqual([
      "error", "warning", "info", "debug", "-1", "0", "1", "2",
    ]);
    expect(schema.shape.level.description).toContain("-1=debug");
  });

  it("denies raw encoded syslog reads instead of forwarding them", async () => {
    const { client, getWithMeta } = metaClient();
    await expect(
      handler(
        { ...schema.parse({}), query: "level=0^messageLIKEboom" } as never,
        client,
        config
      )
    ).rejects.toThrow(
      "Raw encoded query denied by policy. Use structured_query with policy-authorized filters."
    );
    expect(getWithMeta).not.toHaveBeenCalled();
  });
});
