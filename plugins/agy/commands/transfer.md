---
description: Transfer the entire active Claude Code conversation into Google Antigravity, focus it in Desktop UI, and automatically execute the next pending step
argument-hint: "[--background|--wait] [--handoff-only] [--no-focus] [--model <pro|flash|flash_lite>] [--source <claude-jsonl>] [optional next-step instruction]"
disable-model-invocation: false
allowed-tools: Bash(node:*)
---

Transfer the current Claude Code session into Google Antigravity, open/focus it in Antigravity 2.0 Desktop (when running), and automatically execute the next pending step (unless `--handoff-only` is passed).

Raw arguments:
`$ARGUMENTS`

Execution rules:
- Make a single `Bash` call (with `timeout: 600000`) to run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" transfer "$ARGUMENTS"
```
- Do NOT inspect repository files yourself before or after running that command.
- Present the command output verbatim to the user, preserving:
  1. The Antigravity Conversation ID
  2. The `agy --conversation <id>` resume command and `/agy:rescue --resume` follow-up hint
  3. The executed next-step output and touched files (or the background job ID if `--background` was passed).
