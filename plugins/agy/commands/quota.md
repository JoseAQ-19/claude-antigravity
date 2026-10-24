---
description: Display the live Google Antigravity 2.0 HUD â€” per-model quota bars, reset countdown timers, plan tier, and active background jobs
argument-hint: "[--show-account]"
---

Display live model availability, remaining quota bars, reset countdown timers, and active workspace jobs from Google Antigravity 2.0 Desktop.

Raw arguments:
`$ARGUMENTS`

Execution rules:
- Run a single `Bash` call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" quota "$ARGUMENTS"
```
- Present the rendered Markdown table and HUD verbatim to the user.
