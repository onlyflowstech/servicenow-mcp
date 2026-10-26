// Drives oversized and boundary-sized messages through the built server over a
// real stdio transport (in-memory streams) and reports, per case, how long
// rejection took and what came back. The parent test runs this under a reduced
// heap, so a case that needs more memory than the bounds allow ends the
// process.
//
// Usage: node --max-old-space-size=<MB> input-hardening-harness.mjs <layer> <runs>
//   layer "stdio":  the stdio runtime, with its structural guard, then the server.
//   layer "server": the server alone, so only the tool-level bounds apply.
// Prints one JSON line per case on stdout.

import { PassThrough } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "../../dist/server.js";
import { startStdioRuntime } from "../../dist/stdio-runtime.js";
import { registerServiceNowTools } from "../../dist/tools/index.js";

const [layer = "stdio", runsArg = "3"] = process.argv.slice(2);
const runs = Number(runsArg);
const ONE_MIB = 1024 * 1024;
const SYS_ID = "0123456789abcdef0123456789abcdef";

/** Repeat `element` into a JSON array whose text is about `bytes` long. */
function arrayOf(element, bytes) {
  const count = Math.max(1, Math.floor(bytes / (element.length + 1)));
  return `[${new Array(count).fill(element).join(",")}]`;
}
const call = (tool, args) =>
  `{"jsonrpc":"2.0","id":__ID__,"method":"tools/call","params":{"name":"${tool}","arguments":${args}}}`;
const query = (structured) =>
  call("sn_query", `{"profile":"p","table":"incident","structured_query":${structured}}`);
const group = (conditions) => `{"type":"group","operator":"and","conditions":${conditions}}`;
const repeat = (count, text) => `[${new Array(count).fill(text).join(",")}]`;
const leaf = `{"type":"equality","field":"number","operator":"eq","value":"INC1"}`;

function fieldWrite(nodes) {
  // Arrays at the field-policy array bound; each array is one node plus one
  // node per element.
  const fields = {};
  let remaining = nodes;
  for (let index = 0; remaining > 0; index += 1) {
    const length = Math.min(10_000, remaining - 1);
    fields[`u_list_${index}`] = new Array(length).fill("x");
    remaining -= length + 1;
  }
  return fields;
}

const cases = [
  { name: "flat-conditions-1mib", hostile: true, body: () => query(`{"filter":${group(arrayOf("{}", ONE_MIB))}}`) },
  {
    name: "nested-k32",
    hostile: true,
    body: () => query(`{"filter":${group(repeat(32, group(repeat(32, group(repeat(32, "{}"))))))}}`),
  },
  {
    name: "set-values-1mib",
    hostile: true,
    body: () => query(`{"filter":{"type":"set","field":"state","operator":"in","values":${arrayOf("null", ONE_MIB)}}}`),
  },
  { name: "order-by-1mib", hostile: true, body: () => query(`{"order_by":${arrayOf("0", ONE_MIB)}}`) },
  {
    name: "steps-1mib-objects",
    hostile: true,
    body: () => call("sn_atf_author", `{"profile":"p","action":"add_steps","test_sys_id":"${SYS_ID}","steps":${arrayOf("{}", ONE_MIB)}}`),
  },
  {
    name: "steps-1mib-zero",
    hostile: true,
    body: () => call("sn_atf_author", `{"profile":"p","action":"add_steps","test_sys_id":"${SYS_ID}","steps":${arrayOf("0", ONE_MIB)}}`),
  },
  {
    name: "test-sys-ids-1mib",
    hostile: true,
    body: () => call("sn_atf_author", `{"profile":"p","action":"add_tests_to_suite","suite_sys_id":"${SYS_ID}","test_sys_ids":${arrayOf("0", ONE_MIB)}}`),
  },
  // Inside the element budget, so only the schema-level bounds apply.
  { name: "flat-conditions-50k", hostile: true, body: () => query(`{"filter":${group(repeat(50_000, "{}"))}}`) },
  {
    name: "set-values-50k",
    hostile: true,
    body: () => query(`{"filter":{"type":"set","field":"state","operator":"in","values":${repeat(50_000, "null")}}}`),
  },
  {
    name: "steps-50k-objects",
    hostile: true,
    body: () => call("sn_atf_author", `{"profile":"p","action":"add_steps","test_sys_id":"${SYS_ID}","steps":${repeat(50_000, "{}")}}`),
  },
  {
    name: "test-sys-ids-50k",
    hostile: true,
    body: () => call("sn_atf_author", `{"profile":"p","action":"add_tests_to_suite","suite_sys_id":"${SYS_ID}","test_sys_ids":${repeat(50_000, "0")}}`),
  },
  {
    name: "initialize-icons-1mib",
    hostile: true,
    layers: ["stdio"],
    body: () =>
      `{"jsonrpc":"2.0","id":__ID__,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1","icons":${arrayOf("0", ONE_MIB)}}}}`,
  },
  {
    name: "prompts-get-1mib",
    hostile: true,
    layers: ["stdio"],
    body: () => {
      const entries = [];
      for (let size = 0, index = 0; size < ONE_MIB; index += 1) {
        const entry = `"k${index}":0`;
        entries.push(entry);
        size += entry.length + 1;
      }
      return `{"jsonrpc":"2.0","id":__ID__,"method":"prompts/get","params":{"name":"x","arguments":{${entries.join(",")}}}}`;
    },
  },
  {
    name: "legit-64-leaf-query",
    hostile: false,
    body: () => query(`{"filter":${group(repeat(2, group(repeat(32, leaf))))}}`),
  },
  {
    name: "legit-50-steps",
    hostile: false,
    body: () =>
      call("sn_atf_author", `{"profile":"p","action":"add_steps","test_sys_id":"${SYS_ID}","steps":${repeat(50, `{"type":"open_form","inputs":{}}`)}}`),
  },
  {
    name: "legit-50000-node-field-write",
    hostile: false,
    body: () => call("sn_create", JSON.stringify({ profile: "p", table: "incident", fields: fieldWrite(50_000) })),
  },
].filter((entry) => entry.layers === undefined || entry.layers.includes(layer));

// Profile resolution fails, so no handler goes past its first step; the cases
// are about what happens before the handler.
const profileManager = {
  getProfile: () => {
    throw new Error("unknown profile");
  },
  getConfig: () => {
    throw new Error("unknown profile");
  },
  getClient: () => {
    throw new Error("unknown profile");
  },
};
const executionContext = (requestMetadataProvider) => ({
  requestMetadataProvider,
  effectivePolicyProvider: {
    resolve: () => {
      throw new Error("no policy in the harness");
    },
  },
  auditSink: { write() {}, writePreContext() {} },
});
const buildServer = (requestMetadataProvider) =>
  createMcpServer({
    dependencies: {},
    register: (surface) =>
      registerServiceNowTools(surface, profileManager, executionContext(requestMetadataProvider)),
  });

const stdin = new PassThrough();
const stdout = new PassThrough();
const transport = new StdioServerTransport(stdin, stdout);
const pending = new Map();
let buffered = "";
stdout.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    pending.get(message.id)?.({ line, message });
  }
});

if (layer === "stdio") {
  const identity = { ownerId: "harness", clientId: "harness" };
  await startStdioRuntime({
    identity,
    createServer: (context) => buildServer(context.requestMetadataProvider),
    createTransport: () => transport,
  });
} else {
  const fixedMetadata = {
    resolve: () => ({ correlationId: "harness", identity: { ownerId: "harness", clientId: "harness" } }),
  };
  await (await buildServer(fixedMetadata)).connect(transport);
}
// The stdio guard reports rejections on stderr; keep the parent's output clean.
process.stderr.write = () => true;

let nextId = 1;
function send(text) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response to request ${id}`)), 30_000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(response);
    });
    stdin.write(`${text.replace("__ID__", String(id))}\n`);
  });
}

for (const entry of cases) {
  const body = entry.body();
  const timings = [];
  let response;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    response = await send(body);
    timings.push(performance.now() - started);
  }
  const { line, message } = response;
  let kind;
  let text = "";
  if (message.error) {
    kind = "rpc-error";
    text = message.error.message;
  } else {
    text = message.result?.content?.[0]?.text ?? JSON.stringify(message.result ?? {});
    kind = /^Input validation error|^MCP error -32602/u.test(text) ? "validation-error" : "tool-result";
  }
  const issues = kind === "validation-error" ? text.split("\n").length : 0;
  console.log(
    JSON.stringify({
      name: entry.name,
      layer,
      hostile: entry.hostile,
      bodyBytes: body.length,
      minMs: Math.round(Math.min(...timings) * 10) / 10,
      maxMs: Math.round(Math.max(...timings) * 10) / 10,
      kind,
      issues,
      responseBytes: line.length,
      head: text.slice(0, 160),
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20),
      rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
    })
  );
}
process.exit(0);
