---
description: Show active and recent Google Antigravity jobs for this repository
argument-hint: "[job-id] [--wait] [--timeout-ms <ms>] [--all]"
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status "$ARGUMENTS"
```

Present the command output cleanly to the user without dropping job IDs, conversation IDs, statuses, or follow-up commands.

Preserve the Summary/error reason, exit code, partial files and recovery checkpoint. `--wait` returns the job's saved outcome; an expired wait or interrupted job returns 124. A shell notifier's “completed” does not establish success.
