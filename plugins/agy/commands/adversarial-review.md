---
description: Run an adversarial Google Antigravity review challenging architecture, assumptions, and failure modes
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <pro|flash|flash_lite>] [focus ...]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Google Antigravity architecture and implementation review.

Raw arguments:
`$ARGUMENTS`

Rules:
- Review-only: NEVER modify files or auto-apply fixes after presenting findings.
- Run via `Bash` (`timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return the stdout verbatim to the user and stop for user direction.
