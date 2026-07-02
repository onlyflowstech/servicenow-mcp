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
  // syslog.level stores numeric severities: 0=error, 1=warn, 2=info, 3=debug.
  it.each([
    ["error", "0"],
    ["warning", "1"],
    ["info", "2"],
    ["debug", "3"],
  ])("maps level name %s to its numeric value %s", async (name, numeric) => {
    const query = await queryFor({ level: name });
    expect(query).toContain(`level=${numeric}`);
    expect(query).not.toContain(`level=${name}`);
  });

  it.each(["0", "1", "2", "3"])(
    "passes numeric level %s through unchanged",
    async (numeric) => {
      const query = await queryFor({ level: numeric });
      expect(query).toContain(`level=${numeric}`);
    }
  );

  it("rejects unknown level values in the zod schema", () => {
    expect(schema.safeParse({ level: "fatal" }).success).toBe(false);
    expect(schema.safeParse({ level: "4" }).success).toBe(false);
    expect(schema.safeParse({ level: 2 }).success).toBe(false);
  });

  it("leaves a raw encoded query untouched (no level mapping)", async () => {
    const query = await queryFor({ query: "level=0^messageLIKEboom" });
    expect(query).toBe("level=0^messageLIKEboom^ORDERBYDESCsys_created_on");
  });
});
