import { describe, expect, it } from "vitest";
import { definition, handler, schema } from "../src/tools/script.js";
import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

describe("sn_script stub honesty", () => {
  it("advertises the unsupported status in the tool description", () => {
    expect(definition.description).toContain("NOT YET SUPPORTED");
    expect(definition.description).toContain("SNS-39");
  });

  it("returns isError with alternatives and never touches the client", async () => {
    const client = new Proxy({} as ServiceNowClient, {
      get() {
        throw new Error("sn_script must not call the ServiceNow client");
      },
    });
    const result = await handler(
      schema.parse({ code: "gs.print('hi');" }),
      client,
      config
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not yet supported");
    expect(result.content[0].text).toContain("no script was executed");
    expect(result.content[0].text).toContain("sn_query");
    expect(result.content[0].text).toContain("sn_batch");
  });
});
