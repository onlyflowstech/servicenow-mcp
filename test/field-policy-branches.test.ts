import { describe, expect, it, vi } from "vitest";

import type { ServiceNowClient } from "../src/client.js";
import type { ServiceNowConfig } from "../src/config.js";
import { handler as atfHandler, schema as atfSchema } from "../src/tools/atf.js";
import {
  handler as codeSearchHandler,
  schema as codeSearchSchema,
} from "../src/tools/codesearch.js";
import {
  handler as discoverHandler,
  schema as discoverSchema,
} from "../src/tools/discover.js";
import {
  handler as syslogHandler,
  schema as syslogSchema,
} from "../src/tools/syslog.js";

const CONFIG: ServiceNowConfig = {
  instance: "https://field-branches.service-now.com",
  user: "field-branches",
  password: "unused-placeholder",
  displayValue: "true",
  relDepth: 3,
};

function responseData(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("SNSDK-30 fixed-table response branches", () => {
  it("filters syslog raw rows according to the validated caller projection", async () => {
    const getWithMeta = vi.fn(async () => ({
      data: {
        result: [
          {
            sys_id: "1".repeat(32),
            level: "2",
            source: "safe",
            message: "must be omitted by the selected projection",
            password: "secret",
          },
        ],
      },
      headers: new Headers(),
    }));
    const result = await syslogHandler(
      syslogSchema.parse({ fields: "sys_id,level" }),
      { getWithMeta } as unknown as ServiceNowClient,
      CONFIG
    );

    expect(getWithMeta).toHaveBeenCalledWith(
      "/api/now/table/syslog",
      expect.objectContaining({ sysparm_fields: "sys_id,level" })
    );
    expect(responseData(result)).toMatchObject({
      results: [{ sys_id: "1".repeat(32), level: "2" }],
    });
    expect(JSON.stringify(responseData(result))).not.toMatch(/password|message/u);
  });

  it("filters code-search records before deriving the public snippet", async () => {
    const get = vi.fn(async () => ({
      result: [
        {
          sys_id: "2".repeat(32),
          name: "Safe rule",
          script: "gs.info('safe')",
          client_secret: "secret",
          u_unapproved: "secret",
        },
      ],
    }));
    const result = await codeSearchHandler(
      codeSearchSchema.parse({
        search_term: "safe",
        table: "sys_script",
        field: "script",
      }),
      { get } as unknown as ServiceNowClient,
      CONFIG
    );

    expect(responseData(result)).toEqual([
      {
        table: "sys_script",
        table_label: "sys_script",
        sys_id: "2".repeat(32),
        name: "Safe rule",
        snippet: "gs.info('safe')",
      },
    ]);
    expect(JSON.stringify(responseData(result))).not.toMatch(
      /client_secret|u_unapproved/u
    );
  });

  it("removes unexpected raw app fields before adding the source label", async () => {
    const get = vi.fn(async (path: string) => ({
      result:
        path === "/api/now/table/sys_app"
          ? [
              {
                sys_id: "3".repeat(32),
                name: "Safe app",
                version: "1.0",
                scope: "x_safe",
                active: "true",
                password: "secret",
                u_unapproved: "secret",
              },
            ]
          : [],
    }));
    const result = await discoverHandler(
      discoverSchema.parse({ type: "apps" }),
      { get } as unknown as ServiceNowClient,
      CONFIG
    );

    expect(responseData(result)).toEqual([
      {
        sys_id: "3".repeat(32),
        name: "Safe app",
        version: "1.0",
        scope: "x_safe",
        active: "true",
        source: "scoped",
      },
    ]);
    expect(JSON.stringify(responseData(result))).not.toMatch(
      /password|u_unapproved/u
    );
  });

  it.each([
    ["list", "/api/now/table/sys_atf_test", { sys_id: "4".repeat(32), name: "Safe test" }],
    ["suites", "/api/now/table/sys_atf_test_suite", { sys_id: "5".repeat(32), name: "Safe suite" }],
  ] as const)("filters ATF %s raw records", async (action, path, safeRecord) => {
    const get = vi.fn(async () => ({
      result: [{ ...safeRecord, output: "unapproved", password: "secret" }],
    }));
    const result = await atfHandler(
      atfSchema.parse({ action, fields: "sys_id,name" }),
      { get } as unknown as ServiceNowClient,
      CONFIG
    );

    expect(get).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ sysparm_fields: "sys_id,name" })
    );
    expect(responseData(result)).toEqual({
      record_count: 1,
      limit: 20,
      offset: 0,
      has_more: false,
      results: [safeRecord],
    });
    expect(JSON.stringify(responseData(result))).not.toMatch(/output|password/u);
  });

  it("filters ATF direct result output through the result-table policy", async () => {
    const sysId = "6".repeat(32);
    const get = vi.fn(async () => ({
      result: {
        sys_id: sysId,
        status: "Success",
        output: "approved result output",
        password: "secret",
        u_unapproved: "secret",
      },
    }));
    const result = await atfHandler(
      atfSchema.parse({
        action: "results",
        execution_id: sysId,
        fields: "sys_id,status,output",
      }),
      { get } as unknown as ServiceNowClient,
      CONFIG
    );

    expect(responseData(result)).toEqual({
      sys_id: sysId,
      status: "Success",
      output: "approved result output",
    });
    expect(JSON.stringify(responseData(result))).not.toMatch(
      /password|u_unapproved/u
    );
  });
});
