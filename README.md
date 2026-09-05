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
