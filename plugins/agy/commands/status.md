---
description: Show active and recent Google Antigravity jobs for this repository
argument-hint: "[job-id] [--wait] [--timeout-ms <ms>] [--all]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "$ARGUMENTS"`

Present the command output cleanly to the user without dropping job IDs, conversation IDs, statuses, or follow-up commands.
