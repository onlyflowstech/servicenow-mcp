/**
 * sn_batch chooses the records it changes from the instance, never from the
 * metadata cache.
 *
 * Real profile file -> ProfileManager -> ServiceNowClient -> the registered
 * dispatcher, with the metadata cache configured (so its wrapper is in place)
 * on sys_flow_context, which the default sys_flow* pattern caches. Only global
 * fetch is stubbed, standing in for the instance. Between two identical runs
 * the filter's matches change without moving the table's watermark, as an
 * update within the watermark's second to another row, or one that skips the
 * system fields, can.
 */
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEncodedQueryAccessPolicy } from "../src/encoded-query-policy.js";
import type {
  EffectivePolicyProvider,
  ExecutionContextDependencies,
} from "../src/execution-context.js";
import { FORCE_RECACHE_PARAM } from "../src/metadata-cache.js";
import { ProfileManager } from "../src/profile-manager.js";
import { createMcpServer } from "../src/server.js";
import { createTableAccessPolicy } from "../src/table-policy.js";
import { registerServiceNowTools } from "../src/tools/index.js";

const TABLE = "sys_flow_context";
const INSTANCE = "https://batch-cached-lookup.service-now.com";
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

interface WireCall {
  readonly method: string;
  readonly kind: "watermark" | "lookup" | "batch" | "other";
  readonly params: Readonly<Record<string, string>>;
  /** For a batch POST: each sub-request's method and target sys_id. */
  readonly requests?: readonly { readonly method: string; readonly sysId: string }[];
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The instance: the filter matches `state.matching`; the watermark never moves. */
function stubInstance() {
  const state = { matching: [A, B] as string[] };
  const wire: WireCall[] = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const params = Object.fromEntries(url.searchParams);
    const watermarkHeaders = {
      "x-total-count": "3",
      date: "Wed, 15 Jan 2025 13:00:00 GMT",
    };
    if (method === "GET" && url.pathname === `/api/now/table/${TABLE}`) {
      if (params.sysparm_query === "ORDERBYDESCsys_updated_on") {
        wire.push({ method, kind: "watermark", params });
        return json(
          200,
          { result: [{ sys_id: "e".repeat(32), sys_updated_on: "2025-01-15 12:00:00" }] },
          watermarkHeaders
        );
      }
      wire.push({ method, kind: "lookup", params });
      return json(200, { result: state.matching.map((sysId) => ({ sys_id: sysId })) }, watermarkHeaders);
    }
    if (method === "POST" && url.pathname === "/api/now/v1/batch") {
      const payload = JSON.parse(String(init?.body)) as {
        batch_request_id: string;
        rest_requests: { id: string; method: string; url: string }[];
      };
      wire.push({
        method,
        kind: "batch",
        params,
        requests: payload.rest_requests.map((request) => ({
          method: request.method,
          sysId: request.url.split("/")[5]!.split("?")[0]!,
        })),
      });
      return json(200, {
        batch_request_id: payload.batch_request_id,
        serviced_requests: payload.rest_requests.map(({ id }) => ({
          id,
          status_code: 200,
          body: Buffer.from(JSON.stringify({ result: {} })).toString("base64"),
        })),
        unserviced_requests: [],
      });
    }
    wire.push({ method, kind: "other", params });
    return json(404, { error: { message: "not stubbed" } });
  });
  return { state, wire, fetchStub };
}

let directory = "";
const openClients: Client[] = [];

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "batch-cached-lookup-"));
  vi.stubEnv("BATCH_CACHED_LOOKUP_PASSWORD", `secret-${Math.random()}`);
  for (const name of ["SN_METADATA_CACHE_TTL_MS", "SN_METADATA_CACHE_TABLES", "SN_FIELD_POLICY_DEFINITIONS"]) {
    vi.stubEnv(name, undefined as unknown as string);
  }
});

afterEach(async () => {
  for (const client of openClients.splice(0)) await client.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function connect() {
  const configFilePath = path.join(directory, "config.json");
  fs.writeFileSync(
    configFilePath,
    JSON.stringify({
      version: 2,
      profiles: {
        flows: {
          instance: INSTANCE,
          authType: "basic",
          username: "integration.user",
          credential: "env:BATCH_CACHED_LOOKUP_PASSWORD",
          tableAccess: { readTables: ["*"], writeTables: ["*"] },
          // Any explicit setting turns the cache on under NODE_ENV=test, as it
          // is by default in production; sys_flow* is a default pattern.
          metadataCache: { ttlMs: 24 * 60 * 60 * 1000 },
        },
      },
    }),
    { mode: 0o600 }
  );
  const manager = new ProfileManager({ configFilePath });
  const policyProvider: EffectivePolicyProvider = Object.freeze({
    resolve: ({ profile }: { profile: { name: string } }) =>
      Object.freeze({
        id: `restricted-table-policy:${profile.name}`,
        revision: "batch-cached-lookup",
        tableAccess: createTableAccessPolicy(manager.getProfile(profile.name).tableAccess ?? {}),
        fieldPolicy: {},
        encodedQueryAccess: createEncodedQueryAccessPolicy(),
        atf: manager.getAtfConfig(profile.name),
      }),
  });
  const executionContext: ExecutionContextDependencies = Object.freeze({
    requestMetadataProvider: {
      resolve: ({ requestId }: { requestId: unknown }) => ({
        correlationId: `batch-cached-${String(requestId)}`,
        identity: { ownerId: "batch-owner", clientId: "batch-client" },
      }),
    },
    effectivePolicyProvider: policyProvider,
    auditSink: { write: () => {}, writePreContext: () => {} },
  });
  const server = await createMcpServer({
    dependencies: { manager, executionContext },
    register: (surface, injected) =>
      registerServiceNowTools(surface, injected.manager, injected.executionContext),
  });
  const client = new Client({ name: "batch-cached-lookup", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

describe("sn_batch target lookup on a cached metadata table", () => {
  async function run(
    client: Client,
    instance: ReturnType<typeof stubInstance>,
    action: "update" | "delete",
    confirm = true
  ) {
    const start = instance.wire.length;
    const result = await client.callTool({
      name: "sn_batch",
      arguments: {
        profile: "flows",
        table: TABLE,
        action,
        structured_query: {
          filter: { type: "equality", field: "state", operator: "eq", value: "waiting" },
        },
        ...(action === "update" ? { fields: { state: "cancelled" } } : {}),
        confirm,
      },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const sent = instance.wire.slice(start);
    return {
      data: (result.structuredContent as { data: Record<string, unknown> }).data,
      kinds: sent.map((call) => call.kind),
      targets: sent.flatMap((call) => call.requests ?? []),
      lookups: sent.filter((call) => call.kind === "lookup"),
    };
  }

  it.each([
    ["update", "PATCH"],
    ["delete", "DELETE"],
  ] as const)(
    "re-reads its targets on every %s run and acts only on the records that match now",
    async (action, method) => {
      const instance = stubInstance();
      vi.stubGlobal("fetch", instance.fetchStub);
      const client = await connect();

      const first = await run(client, instance, action);
      expect(first.targets).toEqual([
        { method, sysId: A },
        { method, sysId: B },
      ]);
      expect(first.data).toMatchObject({ matched: 2, processed: 2, failed: 0 });

      // A and B leave the filter and C enters; the watermark does not move.
      instance.state.matching = [C];

      const preview = await run(client, instance, action, false);
      expect(preview.data).toMatchObject({ matched: 1, dry_run: true });

      const second = await run(client, instance, action);
      expect(second.targets).toEqual([{ method, sysId: C }]);
      expect(second.data).toMatchObject({ matched: 1, processed: 1, failed: 0 });

      // Straight to the instance every time: one lookup and no watermark per
      // run, and the cache's own parameter never reaches ServiceNow. A dry run
      // adds exactly one bounded sample read of the sys_ids it just found.
      expect([first.kinds, preview.kinds, second.kinds]).toEqual([
        ["lookup", "batch"],
        ["lookup", "lookup"],
        ["lookup", "batch"],
      ]);
      for (const lookup of [
        ...first.lookups,
        preview.lookups[0]!,
        ...second.lookups,
      ]) {
        expect(lookup.params).toEqual({
          sysparm_fields: "sys_id",
          sysparm_limit: "200",
          sysparm_query: "state=waiting",
        });
      }
      expect(preview.lookups[1]!.params).toEqual({
        sysparm_fields: "sys_id,number",
        sysparm_limit: "5",
        sysparm_query: `sys_idIN${C}`,
      });
      for (const lookup of [...first.lookups, ...preview.lookups, ...second.lookups]) {
        expect(lookup.params).not.toHaveProperty(FORCE_RECACHE_PARAM);
      }
    }
  );

  it("leaves the table's other reads cached", async () => {
    const instance = stubInstance();
    vi.stubGlobal("fetch", instance.fetchStub);
    const client = await connect();
    const query = async () => {
      const start = instance.wire.length;
      const result = await client.callTool({
        name: "sn_query",
        arguments: { profile: "flows", table: TABLE, fields: "sys_id", limit: 5 },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      return instance.wire.slice(start).map((call) => call.kind);
    };

    expect(await query()).toEqual(["watermark", "lookup"]);
    await run(client, instance, "update");
    // The batch wrote, so the newest row would move on a real instance; here
    // the watermark is fixed, so the cached read is still served.
    expect(await query()).toEqual(["watermark"]);
  });
});
