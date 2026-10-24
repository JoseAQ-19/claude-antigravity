---
description: Run a read-only Google Antigravity code review against local git changes or a base branch
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <pro|flash|flash_lite>]"
disable-model-invocation: true
allowed-tools: AskUserQuestion
---

Run a read-only Google Antigravity code review.

Raw arguments:
`$ARGUMENTS`

Rules:
- Review-only: NEVER modify files or auto-apply fixes after presenting findings.
- Run via `Bash` (`timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "$ARGUMENTS"
```
- Return the stdout verbatim to the user and ask which issues (if any) they want fixed before making any edits.
