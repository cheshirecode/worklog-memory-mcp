# worklog-memory-mcp

An MCP agent-memory server where memories are **task files with a state
machine**, not embeddings soup.

Generic memory servers (Mem0, Cognee, OpenMemory) store facts. Agents also
need something they don't provide: durable *work* memory — what task was in
flight, what evidence proved progress, what the next action is — that a
fresh session can hydrate and continue. That is what a git worklog vault
holds, and this server exposes it over MCP.

## Tools

| Tool | Does |
|---|---|
| `memory_search` | slug-grouped search across task bodies + frontmatter |
| `memory_context` | resume pack for a slug: frontmatter, recent commits, next action |
| `memory_task_create` | new draft task file, committed through the vault's own hooks |
| `memory_checkpoint` | append one **typed evidence line** (`command\|artifact\|git\|github\|url: ref — result`), optionally flip status, commit |

Every write goes through the worklog skill's own scripts, so vault lint and
commit hooks apply — the server invents no second rule surface. Writes are
serialized in-process (the vault lock is a single coarse lock by design;
run one server per vault).

## Use

```json
{
  "mcpServers": {
    "worklog-memory": {
      "command": "npx",
      "args": ["worklog-memory-mcp"],
      "env": {
        "WORKLOG_REPO": "/path/to/your/worklog-vault",
        "WORKLOG_BIN": "/path/to/dotfiles/skills/worklog/bin",
        "WORKLOG_LDAP": "you"
      }
    }
  }
}
```

Vault conventions (task file format, FSM, slug grammar) come from the
[worklog skill](https://github.com/cheshirecode/dotfiles/tree/main/skills/worklog).

## Proven round trip

`test/e2e.js` clones a vault to scratch (with a local bare origin — no real
remote is ever touched), then: session A creates a task and checkpoints
typed evidence; a **separate server process** (session B) hydrates that
context and finds the evidence by search. 5 checks, run in CI against a
synthetic vault.

## Publishing (not done yet)

`server.json` is committed and validated against the MCP Registry schema
`2025-12-11`. Nothing is published. Two steps remain, and both need
credentials this repo does not hold:

1. **npm.** `server.json` points at the npm package `worklog-memory-mcp`
   at version `0.1.0`. That package is not on npm yet. Publish it first
   (`npm publish`), or the registry cannot resolve it.
2. **MCP Registry.** Then:

   ```bash
   mcp-publisher login github   # opens a browser device-code flow
   mcp-publisher publish
   ```

   The `io.github.cheshirecode/` namespace is claimed by proving you own
   the matching GitHub account, so the login step is required.

Validation itself needs no login and is safe to run at any time:

```bash
mcp-publisher validate   # ✅ server.json is valid
```

Keep the three versions in step when you cut a release: `package.json`
`version`, the top-level `version` in `server.json`, and the `version`
inside its `packages[0]` entry.
