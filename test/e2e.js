#!/usr/bin/env node
// Two-session round trip against a SCRATCH CLONE of a vault:
// "session A" creates a task and checkpoints typed evidence, then a second,
// fresh server instance ("session B") hydrates that context. Proves the
// memory survives the process — the whole point of the product.
//
// Env: WORKLOG_SOURCE (a real vault to clone; never written), WORKLOG_BIN.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOURCE = process.env.WORKLOG_SOURCE;
const BIN = process.env.WORKLOG_BIN;
if (!SOURCE || !BIN) {
  console.log("SKIP e2e: set WORKLOG_SOURCE (vault to clone) and WORKLOG_BIN");
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wmm-e2e-"));
// checkpoint.sh pulls and pushes by design, so the scratch vault gets a
// LOCAL bare origin — the push path is exercised without any real remote.
const bare = path.join(scratch, "origin.git");
const vault = path.join(scratch, "vault");
execFileSync("git", ["clone", "-q", "--bare", "--no-hardlinks", SOURCE, bare]);
execFileSync("git", ["clone", "-q", bare, vault]);
execFileSync("git", ["-C", vault, "config", "user.name", "e2e"]);
execFileSync("git", ["-C", vault, "config", "user.email", "e2e@test"]);

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); pass++; };
const bad = (m) => { console.log(`  FAIL  ${m}`); fail++; };

function session() {
  const child = spawn("node", [path.join(import.meta.dirname, "..", "server.js")], {
    env: { ...process.env, WORKLOG_REPO: vault, WORKLOG_BIN: BIN, WORKLOG_LDAP: "oss", WORKLOG_NO_HOOK: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch { /* non-JSON line */ }
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 30000);
  });
  return {
    request,
    async init() {
      await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {}, clientInfo: { name: "e2e", version: "0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args) => request("tools/call", { name, arguments: args }),
    close: () => child.kill(),
  };
}

const a = session();
await a.init();

const tools = await a.request("tools/list", {});
if (tools.result.tools.length === 4) ok("session A lists 4 tools");
else bad(`expected 4 tools, got ${tools.result?.tools?.length}`);

const created = await a.call("memory_task_create", {
  slug: "e2e-memory-round-trip", kind: "spike",
  context: "Created by worklog-memory-mcp e2e.",
  next_action: "hydrate this from a second session",
});
if (!created.result.isError) ok("session A creates a task");
else bad(`create failed: ${JSON.stringify(created.result)}`);

const checkpointed = await a.call("memory_checkpoint", {
  slug: "e2e-memory-round-trip",
  evidence: "command: node test/e2e.js — round trip in flight",
  status: "in-progress",
});
if (!checkpointed.result.isError) ok("session A checkpoints typed evidence");
else bad(`checkpoint failed: ${JSON.stringify(checkpointed.result)}`);
a.close();

// Fresh process = fresh session.
const b = session();
await b.init();
const context = await b.call("memory_context", { slug: "e2e-memory-round-trip", for: "resume" });
const textOut = context.result?.content?.[0]?.text || "";
if (!context.result.isError && textOut.includes("e2e-memory-round-trip")) ok("session B hydrates the task context");
else bad(`hydrate failed: ${textOut.slice(0, 200)}`);

const search = await b.call("memory_search", { pattern: "round trip in flight" });
if ((search.result?.content?.[0]?.text || "").includes("e2e-memory-round-trip")) ok("session B finds the evidence by search");
else bad("search did not find the checkpointed evidence");
b.close();

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`e2e: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
