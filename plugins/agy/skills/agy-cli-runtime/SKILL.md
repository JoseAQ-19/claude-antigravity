---
name: agy-cli-runtime
description: Internal helper contract for calling the agy-companion runtime from Claude Code
user-invocable: false
---

# Antigravity Companion Runtime Contract

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task --write "<prompt>"`

Execution rules:
- Act strictly as a thin forwarder: invoke `task` once and return stdout unchanged.
- Do not read repository files, run git manually, poll status, or attempt your own fix if Antigravity fails.
- Accepted `--model` values: `pro` (default), `flash`, `flash_lite`.
- Add `--resume` when continuing the latest Antigravity conversation (including sessions created via `/agy:transfer`).
- Add `--focus-ui` when the user wants Antigravity 2.0 Desktop brought to focus visually.
