---
description: Preview or revert the latest delegated Google Antigravity turn via RevertToCascadeStep RPC (or git touched-files fallback)
argument-hint: "[job-id] [--conversation <id>] [--step <n>] [--apply]"
allowed-tools: Bash(node:*)
---

Preview (dry-run by default) or execute (`--apply`) a clean rollback of the most recent Google Antigravity turn.

Raw arguments:
`$ARGUMENTS`

Execution rules:
- Run a single `Bash` call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" undo "$ARGUMENTS"
```
- Present the revert preview or applied rollback summary verbatim. If `--apply` was not passed, remind the user to run `/agy:undo --apply` to execute it.
