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
- Canonical `--model` tiers (work on both Desktop and CLI): `pro` (default), `flash`, `flash_lite`.
- Concrete CLI model IDs (e.g. `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-3.8-flash-medium`, `claude-opus-5-5-high`, `claude-sonnet-5-5-high`) require `--backend cli` when Antigravity Desktop is running.
- Add `--resume` when continuing the latest Antigravity conversation (including sessions created via `/agy:transfer`).
- Add `--focus-ui` when the user wants Antigravity 2.0 Desktop brought to focus visually.
