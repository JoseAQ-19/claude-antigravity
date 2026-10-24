---
description: Show the stored final output and touched files for a finished Google Antigravity job
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result "$ARGUMENTS"`

Present the full stored output verbatim, preserving Conversation ID, touched files, findings, and follow-up commands.
