---
description: Check whether Google Antigravity Desktop RPC or agy CLI is ready and optionally toggle the stop-time review gate
argument-hint: "[--enable-review-gate|--disable-review-gate]"
allowed-tools: Bash(node:*), Bash(powershell:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

- If `ready` is `true`, present a clean summary showing the active engine (`desktop-live` or `cli-headless`), connection status, and whether the stop review gate is enabled.
- If `ready` is `false` (neither Antigravity 2.0 Desktop is running nor `agy` CLI is installed), use `AskUserQuestion` once with:
  - `Install agy CLI now (Recommended)`
  - `Skip (I will open Antigravity 2.0 Desktop manually)`
  If the user chooses install, run the `cli.installCommand` returned in the setup JSON and rerun `setup`.
