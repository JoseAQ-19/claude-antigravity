---
description: Cancel an active Google Antigravity background job and stop its live cascade invocation
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel "$ARGUMENTS"`
