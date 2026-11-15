import { afterEach, describe, expect, it } from "vitest";

import { ServiceNowResponseTooLargeError } from "../src/client.js";
import { callError, closeHarnesses, harness } from "./structured-filter-harness.js";

afterEach(closeHarnesses);

/**
 * A response that passes the byte cap is a request the caller can change, so
 * every tool reports it the same way: as too_large, with the remedy, and not
 * as an unexplained internal failure. The mapping is central, so one read tool
 * per client method is enough to show it is not specific to one handler.
 */
const REMEDY = "too large to return in one call";

describe("a tool whose read passes the response cap", () => {
  it("sn_query says the response was too large, not that it failed unexpectedly", async () => {
    const connected = await harness([], {
      upstream: async () => {
        throw new ServiceNowResponseTooLargeError("raw response exceeds configured byte limit");
      },
    });
    const message = await callError(connected, "sn_query", { table: "incident", limit: 5 });
    expect(message).toContain(REMEDY);
    expect(message).toContain("Error category: too_large.");
    expect(message).toContain("Correlation ID:");
    expect(message).not.toContain("failed unexpectedly");
    expect(message).not.toContain("category: internal");
    expect(message).not.toContain("byte limit");
  });

  it("sn_codesearch, which reads through the other client method, says the same", async () => {
    const connected = await harness([], { codeTables: true });
    connected.get.mockRejectedValue(
      new ServiceNowResponseTooLargeError("cumulative upstream response exceeds configured byte limit")
    );
    const message = await callError(connected, "sn_codesearch", {
      search_term: "needle",
      table: "sys_script_include",
    });
    expect(message).toContain(REMEDY);
    expect(message).toContain("Error category: too_large.");
    expect(message).not.toContain("category: internal");
  });

  it("still reports any other RangeError as an internal failure", async () => {
    const connected = await harness([], {
      upstream: async () => {
        throw new RangeError("Maximum call stack size exceeded");
      },
    });
    const message = await callError(connected, "sn_query", { table: "incident", limit: 5 });
    expect(message).toContain("Error category: internal.");
    expect(message).not.toContain("too_large");
  });
});
