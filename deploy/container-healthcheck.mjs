#!/usr/bin/env node

/** Bounded, dependency-free readiness probe for the production container. */

import { request } from "node:http";

const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 256;
const INTERNAL_HEALTHCHECK_AUTHORITY = "mcp-health.internal";

const port = boundedInteger(process.env.MCP_PORT, DEFAULT_PORT, 1, 65_535);
const timeoutMs = boundedInteger(
  process.env.MCP_HEALTHCHECK_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  100,
  10_000
);

let finished = false;
const finish = (successful) => {
  if (finished) return;
  finished = true;
  if (!successful) process.stderr.write("readiness probe failed\n");
  process.exitCode = successful ? 0 : 1;
};

const probe = request(
  {
    host: "127.0.0.1",
    port,
    path: "/health/ready",
    method: "GET",
    headers: {
      accept: "application/json",
      connection: "close",
      host: INTERNAL_HEALTHCHECK_AUTHORITY,
    },
  },
  (response) => {
    let body = "";
    let bytes = 0;
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE_BYTES) {
        response.destroy();
        finish(false);
        return;
      }
      body += chunk;
    });
    response.on("end", () => {
      finish(response.statusCode === 200 && body === '{"status":"ready"}\n');
    });
    response.on("error", () => finish(false));
  }
);

probe.setTimeout(timeoutMs, () => {
  probe.destroy();
  finish(false);
});
probe.on("error", () => finish(false));
probe.end();

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    process.stderr.write("readiness probe configuration is invalid\n");
    process.exit(1);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    process.stderr.write("readiness probe configuration is invalid\n");
    process.exit(1);
  }
  return parsed;
}
