---
description: Check whether Google Antigravity Desktop RPC or agy CLI is ready and optionally toggle the stop-time review gate
argument-hint: "[--enable-review-gate|--disable-review-gate]"
allowed-tools: AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

- If `ready` is `true`, present a clean summary showing the active engine (`desktop-live` or `cli-headless`), connection status, and whether the stop review gate is enabled.
- If `ready` is `false` (neither Antigravity 2.0 Desktop is running nor `agy` CLI is installed), instruct the user to open Antigravity 2.0 Desktop or install it from `https://antigravity.google/download`, then rerun `/agy:setup`.
