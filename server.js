#!/usr/bin/env node
// worklog-memory-mcp: MCP agent-memory server over a git worklog vault.
//
// Differentiator vs generic memory servers: memories are task FILES with an
// FSM (draft -> in-progress -> ... -> archived), typed evidence lines, and
// git history — durable, lintable, human-readable. This server wraps the
// worklog skill's own scripts, so every write passes the vault's lint and
// commit hooks; it invents no second rule surface.
//
// Env:
//   WORKLOG_REPO  path to the vault clone (required)
//   WORKLOG_BIN   path to the worklog skill's bin/ (required)
//   WORKLOG_LDAP  namespace under people/ (default: from vault convention)
//
// Concurrency: the vault's own lock (_flock.py) is a single coarse lock and
// the git index is not multi-writer; this server therefore serializes all
// write tools through one in-process queue. Run one server per vault.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const exec = promisify(execFile);

const REPO = process.env.WORKLOG_REPO;
const BIN = process.env.WORKLOG_BIN;
if (!REPO || !BIN) {
  console.error("worklog-memory-mcp: WORKLOG_REPO and WORKLOG_BIN are required");
  process.exit(78);
}
const LDAP = process.env.WORKLOG_LDAP || "oss";

async function run(script, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec("bash", [path.join(BIN, script), ...args], {
      cwd: REPO,
      env: { ...process.env, WORKLOG_REPO: REPO, WORKLOG_LDAP: LDAP },
      maxBuffer: 4 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, out: stdout || stderr };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ""}${err.stderr || err.message}` };
  }
}

function text(result) {
  return { content: [{ type: "text", text: result.out.trim() || "(empty)" }], isError: !result.ok };
}

// One in-process queue serializes every vault write.
let writeChain = Promise.resolve();
function serialized(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const server = new McpServer({ name: "worklog-memory", version: "0.1.0" });

server.tool(
  "memory_search",
  "Search the worklog vault (task bodies + frontmatter index). Returns slug-grouped hits.",
  { pattern: z.string().min(1) },
  async ({ pattern }) => text(await run("search.sh", [pattern]))
);

server.tool(
  "memory_context",
  "Hydrate resume context for a task slug: frontmatter, recent commits, open next steps.",
  { slug: z.string().regex(SLUG), for: z.enum(["resume", "review", "compact"]).default("resume") },
  async ({ slug, for: mode }) => text(await run("context.sh", [slug, `--for=${mode}`]))
);

server.tool(
  "memory_task_create",
  "Create a new task file (draft) in the vault and commit it. Body is markdown after the frontmatter.",
  {
    slug: z.string().regex(SLUG),
    kind: z.enum(["plan", "impl", "investigation", "design", "spike", "proposal", "bug", "tooling"]).default("plan"),
    context: z.string().min(1),
    next_action: z.string().min(1),
  },
  ({ slug, kind, context, next_action }) =>
    serialized(async () => {
      const file = path.join(REPO, "people", LDAP, "active", `${slug}.md`);
      if (fs.existsSync(file)) {
        return text({ ok: false, out: `task ${slug} already exists — use memory_checkpoint` });
      }
      const today = new Date().toISOString().slice(0, 10);
      const body = `---
slug: ${slug}
status: draft
kind: ${kind}
author: ${LDAP}
created: ${today}
last_updated: ${today}
project: none
next_action: "${next_action.replaceAll('"', "'")}"
---

## Context

${context}

## Next

- [ ] ${next_action}
`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return text(await run("checkpoint.sh", [slug]));
    })
);

server.tool(
  "memory_checkpoint",
  "Record typed evidence ('kind: ref — result') on a task and commit. Optionally flip status or next_action.",
  {
    slug: z.string().regex(SLUG),
    evidence: z.string().min(1).describe("one typed line: command|artifact|git|github|url: <ref> — <result>"),
    status: z.enum(["draft", "in-progress", "in-review", "blocked", "shipping"]).optional(),
    next_action: z.string().optional(),
  },
  ({ slug, evidence, status, next_action }) =>
    serialized(async () => {
      const file = path.join(REPO, "people", LDAP, "active", `${slug}.md`);
      if (!fs.existsSync(file)) {
        return text({ ok: false, out: `task ${slug} not found — use memory_task_create` });
      }
      const today = new Date().toISOString().slice(0, 10);
      const note = `- ${today}: ${evidence}`;
      let content = fs.readFileSync(file, "utf8");
      // Append under an ## Evidence section, creating it once.
      if (content.includes("\n## Evidence\n")) {
        content = content.replace("\n## Evidence\n", `\n## Evidence\n${note}\n`);
      } else {
        content += `\n## Evidence\n${note}\n`;
      }
      fs.writeFileSync(file, content);
      const args = [slug];
      if (status) args.push(`--status=${status}`);
      if (next_action) args.push(`--next=${next_action}`);
      return text(await run("checkpoint.sh", args));
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`worklog-memory-mcp: serving vault ${REPO} as ${LDAP}`);
