---
description: Non-destructively sync project rules and memory between Claude Code (CLAUDE.md) and Google Antigravity (AGENTS.md / .agents/rules/)
argument-hint: "[--direction <both|claude-to-agy|agy-to-claude>] [--apply]"
allowed-tools: Bash(node:*)
---

Preview (dry-run by default) or apply (`--apply`) non-destructive bidirectional rule & memory synchronization between `CLAUDE.md` and `AGENTS.md` / `.agents/rules/claude-memory-sync.md` (with automatic `.bak` backups).

Raw arguments:
`$ARGUMENTS`

Execution rules:
- Run a single `Bash` call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" sync-memory "$ARGUMENTS"
```
- Present the sync summary verbatim to the user.
