import { describe, expect, it, vi } from "vitest";
import { handler as syslogHandler, schema as syslogSchema } from "../src/tools/syslog.js";
import { handler as attachHandler, schema as attachSchema } from "../src/tools/attach.js";
import { handler as discoverHandler, schema as discoverSchema } from "../src/tools/discover.js";
import {
  handler as codesearchHandler,
  schema as codesearchSchema,
} from "../src/tools/codesearch.js";
import { handler as schemaHandler, schema as schemaSchema } from "../src/tools/schema.js";
import {
  handler as relationshipsHandler,
  schema as relationshipsSchema,
} from "../src/tools/relationships.js";
import { handler as atfHandler, schema as atfSchema } from "../src/tools/atf.js";
import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";

const config: ServiceNowConfig = {
  instance: "https://example.service-now.com",
  user: "tester",
  password: "placeholder-not-a-real-credential",
  displayValue: "true",
  relDepth: 3,
};

/**
 * A value that, interpolated verbatim, would append an extra
 * `active=false` OR-condition and silently widen the query.
 */
const INJECTION = "web-server-01^ORactive=false";
const NEUTRALIZED = "web-server-01ORactive=false";
const VALID_SYS_ID = "0123456789abcdef0123456789abcdef";

function getClient(result: unknown = []) {
  const get = vi.fn(async () => ({ result }));
  return { client: { get } as unknown as ServiceNowClient, get };
}

function queryOfCall(get: ReturnType<typeof vi.fn>, call = 0): string {
  const params = get.mock.calls[call][1] as Record<string, string>;
  return params.sysparm_query;
}

describe("encoded-query injection is neutralized", () => {
  it("sn_syslog source and message filters", async () => {
    const getWithMeta = vi.fn(async () => ({
      data: { result: [] },
      status: 200,
      headers: new Headers(),
    }));
    const client = { getWithMeta } as unknown as ServiceNowClient;
    await syslogHandler(
      syslogSchema.parse({ source: INJECTION, message: INJECTION }),
      client,
      config
    );
    const params = getWithMeta.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_query).not.toContain("^ORactive=false");
    expect(params.sysparm_query).toContain(`sourceLIKE${NEUTRALIZED}`);
    expect(params.sysparm_query).toContain(`messageLIKE${NEUTRALIZED}`);
  });

  it("sn_attach list table filter", async () => {
    const { client, get } = getClient();
    await attachHandler(
      attachSchema.parse({
        action: "list",
        table: INJECTION,
        sys_id: VALID_SYS_ID,
      }),
      client,
      config
    );
    expect(queryOfCall(get)).toBe(
      `table_name=${NEUTRALIZED}^table_sys_id=${VALID_SYS_ID}`
    );
  });

  it("sn_attach rejects sys_id injection before client calls", () => {
    const { get } = getClient();
    const parsed = attachSchema.safeParse({
      action: "list",
      table: "incident",
      sys_id: INJECTION,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ["sys_id"], code: "invalid_string" })
      );
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("sn_discover tables name/label search", async () => {
    const { client, get } = getClient();
    await discoverHandler(
      discoverSchema.parse({ type: "tables", query: INJECTION }),
      client,
      config
    );
    expect(queryOfCall(get)).toBe(
      `nameLIKE${NEUTRALIZED}^ORlabelLIKE${NEUTRALIZED}`
    );
  });

  it("sn_discover plugins active filter", async () => {
    const { client, get } = getClient();
    await discoverHandler(
      discoverSchema.parse({ type: "plugins", active: INJECTION }),
      client,
      config
    );
    expect(queryOfCall(get)).toBe(`active=${NEUTRALIZED}`);
  });

  it("sn_codesearch search term (single-table search)", async () => {
    const { client, get } = getClient();
    await codesearchHandler(
      codesearchSchema.parse({ search_term: INJECTION, table: "sys_script" }),
      client,
      config
    );
    expect(queryOfCall(get)).toBe(`scriptLIKE${NEUTRALIZED}`);
  });

  it("sn_schema table name", async () => {
    const { client, get } = getClient();
    await expect(
      schemaHandler(schemaSchema.parse({ table: INJECTION }), client, config)
    ).rejects.toThrow("Field access denied by policy");
    expect(get).not.toHaveBeenCalled();
  });

  it("sn_relationships ci_name lookup", async () => {
    const { client, get } = getClient();
    const result = await relationshipsHandler(
      relationshipsSchema.parse({ ci_name: INJECTION }),
      client,
      config
    );
    expect(queryOfCall(get)).toBe(`name=${NEUTRALIZED}^ORDERBYsys_id`);
    expect(result.isError).toBe(true); // no CI found -- lookup stays scoped
  });

  it("sn_atf suite_name resolution", async () => {
    const { client, get } = getClient();
    const result = await atfHandler(
      atfSchema.parse({ action: "list", suite_name: INJECTION }),
      client,
      config
    );
    expect(queryOfCall(get)).toBe(`name=${NEUTRALIZED}^ORDERBYsys_id`);
    expect(result.isError).toBe(true); // suite not found
  });

  // ServiceNow evaluates values that START with "javascript:" server-side
  // (the mechanism sn_syslog itself uses via gs.minutesAgoStart) -- an
  // interpolated filter value must never opt into evaluation.
  it("sn_relationships ci_name with a javascript: prefix is matched literally", async () => {
    const { client, get } = getClient();
    await relationshipsHandler(
      relationshipsSchema.parse({ ci_name: "javascript:gs.getUserID()" }),
      client,
      config
    );
    expect(queryOfCall(get)).toBe("name=gs.getUserID()^ORDERBYsys_id");
  });

  it("sn_syslog message filter with a javascript: prefix is matched literally", async () => {
    const getWithMeta = vi.fn(async () => ({
      data: { result: [] },
      status: 200,
      headers: new Headers(),
    }));
    const client = { getWithMeta } as unknown as ServiceNowClient;
    await syslogHandler(
      syslogSchema.parse({ message: "javascript:gs.now()" }),
      client,
      config
    );
    const params = getWithMeta.mock.calls[0][1] as Record<string, string>;
    expect(params.sysparm_query).toContain("messageLIKEgs.now()");
    expect(params.sysparm_query).not.toContain("messageLIKEjavascript:");
    // The tool's own deliberate time-window expression must remain.
    expect(params.sysparm_query).toContain(
      "sys_created_on>=javascript:gs.minutesAgoStart(60)"
    );
  });

  it("sn_atf rejects execution_id injection before client calls", () => {
    const get = vi.fn(async () => ({ result: [] }));
    const parsed = atfSchema.safeParse({
      action: "results",
      execution_id: INJECTION,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["execution_id"],
          code: "invalid_string",
        })
      );
    }
    expect(get).not.toHaveBeenCalled();
  });
});
