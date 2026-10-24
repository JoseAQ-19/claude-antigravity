---
description: Fork an active Google Antigravity 2.0 conversation at the current or specified step to explore an alternative approach
argument-hint: "[conversation-id] [--step <n>] [--no-focus]"
allowed-tools: Bash(node:*)
---

Branch an existing Google Antigravity 2.0 Desktop conversation via `ForkConversation` RPC and set the new branch as the active `--resume` target.

Raw arguments:
`$ARGUMENTS`

Execution rules:
- Run a single `Bash` call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" fork "$ARGUMENTS"
```
- Present the forked conversation ID and follow-up `/agy:rescue --resume` hint verbatim.
