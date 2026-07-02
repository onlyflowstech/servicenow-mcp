#!/usr/bin/env node
/**
 * Live smoke test for @onlyflows/servicenow-mcp (branch feature/efficiency-auth-hardening).
 * Spawns dist/index.js over stdio and exercises the new behavior against a real instance.
 *
 * Usage:  node smoke-test.mjs [--write] [--bad-auth]
 * Env:    SN_INSTANCE, SN_USER, SN_PASSWORD  (or SN_AUTH_TYPE=oauth + SN_CLIENT_ID/SN_CLIENT_SECRET)
 *
 * --write     also run a create -> update -> delete round-trip on `incident` (sub-prod only!)
 * --bad-auth  also respawn with a wrong password to verify the 401 KB3096078 hint
 */
import { spawn } from "node:child_process";

import { fileURLToPath } from "node:url";
import path from "node:path";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
const BAD_AUTH = process.argv.includes("--bad-auth");

function startServer(envOverride = {}) {
  const server = spawn("node", ["dist/index.js"], {
    cwd: REPO,
    env: { ...process.env, ...envOverride },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderrLines = [];
  server.stderr.on("data", (d) => stderrLines.push(d.toString()));
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  server.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* ignore non-JSON */ }
    }
  });
  function rpc(method, params, timeoutMs = 90000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }
      }, timeoutMs).unref();
    });
  }
  const notify = (method, params) =>
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { server, rpc, notify, stderrLines };
}

async function initialize(h) {
  await h.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  h.notify("notifications/initialized");
}

async function callTool(h, name, args) {
  const resp = await h.rpc("tools/call", { name, arguments: args });
  if (resp.error) return { isError: true, text: JSON.stringify(resp.error) };
  const text = (resp.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return { isError: !!resp.result?.isError, text };
}

const results = [];
function record(name, pass, note = "") {
  results.push({ name, pass, note });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
}

const main = async () => {
  const h = startServer();
  await initialize(h);

  // 1. tools/list
  const list = await h.rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  record("tools/list", tools.length === 18, `${tools.length} tools`);

  // 2. connectivity + instance info
  const health = await callTool(h, "sn_health", { check: "version" });
  record("sn_health version", !health.isError, health.text.slice(0, 160).replace(/\n/g, " "));

  // 3. default-field query: compact, curated fields, pagination metadata
  const q = await callTool(h, "sn_query", { table: "incident", limit: 3 });
  let qNote = `${q.text.length} chars`;
  let qPass = !q.isError;
  if (qPass) {
    const parsed = JSON.parse(q.text);
    const rec = parsed.results?.[0] ?? {};
    const keys = Object.keys(rec);
    qPass =
      !q.text.includes('\n  "') && // compact
      "record_count" in parsed &&
      "has_more" in parsed &&
      keys.length > 0 && keys.length <= 14; // curated default set, not 100+ fields
    qNote += `; keys/record=${keys.length}; total=${parsed.total}; has_more=${parsed.has_more}`;
  } else qNote += `; ${q.text.slice(0, 200)}`;
  record("sn_query incident (defaults)", qPass, qNote);

  // 4. fields="all" escape hatch returns a much fuller record
  const qAll = await callTool(h, "sn_query", { table: "incident", limit: 1, fields: "all" });
  if (!qAll.isError) {
    const keysAll = Object.keys(JSON.parse(qAll.text).results?.[0] ?? {}).length;
    record("sn_query fields=all", keysAll > 30, `${keysAll} keys, ${qAll.text.length} chars`);
  } else record("sn_query fields=all", false, qAll.text.slice(0, 200));

  // 5. pagination follow-up using next_offset
  const p1 = await callTool(h, "sn_query", { table: "incident", limit: 2, fields: "number,sys_id" });
  if (!p1.isError) {
    const parsed = JSON.parse(p1.text);
    if (parsed.has_more && parsed.next_offset !== undefined) {
      const p2 = await callTool(h, "sn_query", {
        table: "incident", limit: 2, offset: parsed.next_offset, fields: "number,sys_id",
      });
      const first = new Set((parsed.results ?? []).map((r) => r.sys_id));
      const second = JSON.parse(p2.text).results ?? [];
      const overlap = second.some((r) => first.has(r.sys_id));
      record("pagination next_offset", !p2.isError && !overlap, overlap ? "OVERLAPPING PAGES" : "no overlap");
    } else record("pagination next_offset", true, "table has <=2 incidents; skipped follow-up");
  } else record("pagination next_offset", false, p1.text.slice(0, 200));

  // 6. validate every DEFAULT_FIELDS column against the live schema
  const { DEFAULT_FIELDS } = await import(`${REPO}/dist/table-defaults.js`);
  const missing = [];
  for (const [table, fields] of Object.entries(DEFAULT_FIELDS)) {
    const s = await callTool(h, "sn_schema", { table });
    if (s.isError) { missing.push(`${table}: schema fetch failed`); continue; }
    const schemaText = s.text;
    for (const f of fields) {
      if (!schemaText.includes(`"${f}"`)) missing.push(`${table}.${f}`);
    }
  }
  record("DEFAULT_FIELDS vs live schema", missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `all columns exist across ${Object.keys(DEFAULT_FIELDS).length} tables`);

  // 7. aggregate count (display_value enum path untouched)
  const agg = await callTool(h, "sn_aggregate", { table: "incident", count: true });
  record("sn_aggregate count", !agg.isError, agg.text.slice(0, 120).replace(/\n/g, " "));

  // 8. error quality on a bad table
  const bad = await callTool(h, "sn_query", { table: "x_no_such_table_zz" });
  record("bad-table error surfaced", bad.isError && /invalid|not exist|400|403/i.test(bad.text), bad.text.slice(0, 160).replace(/\n/g, " "));

  // 9. optional write round-trip
  if (WRITE) {
    const created = await callTool(h, "sn_create", {
      table: "incident",
      data: { short_description: "MCP smoke test — safe to delete", urgency: "3", impact: "3" },
    });
    if (!created.isError) {
      const sysId = JSON.parse(created.text).sys_id;
      record("sn_create incident", !!sysId, `sys_id=${sysId}, ${created.text.length} chars`);
      const upd = await callTool(h, "sn_update", {
        table: "incident", sys_id: sysId, data: { work_notes: "smoke test update" },
      });
      record("sn_update incident", !upd.isError, `${upd.text.length} chars`);
      const del = await callTool(h, "sn_delete", { table: "incident", sys_id: sysId, confirm: true });
      record("sn_delete incident", !del.isError, del.text.slice(0, 100));
    } else record("sn_create incident", false, created.text.slice(0, 200));
  }

  h.server.kill();

  // 10. optional wrong-password run to verify the KB3096078 hint
  if (BAD_AUTH) {
    const hb = startServer({ SN_PASSWORD: "definitely-wrong-password", SN_AUTH_TYPE: "basic" });
    await initialize(hb);
    const r = await callTool(hb, "sn_query", { table: "incident", limit: 1 });
    record("401 basic-auth hint", r.isError && r.text.includes("KB3096078"), r.text.slice(0, 200).replace(/\n/g, " "));
    hb.server.kill();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(2); });
