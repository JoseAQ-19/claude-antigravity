---
name: antigravity-bridge
description: Delegate tasks, run cross-model code reviews, or transfer full active Claude Code conversations (.jsonl) live into Google Antigravity 2.0 Desktop IDE or agy CLI. Use when the user asks to hand off a conversation, delegate heavy coding/research/UI tasks, or get a second opinion from Google Antigravity / Gemini.
---

# Claude ↔ Google Antigravity Bridge (`antigravity-bridge`)

Bridge **Claude Code** (or any Agent Skills-compatible harness) with **Google Antigravity 2.0 Desktop IDE** (`language_server` Connect RPC + `agentapi`) and **`agy` CLI** in dual mode.

## Prefer the Native Claude Code Plugin When Available

If running inside **Claude Code**, check whether the native `agy@antigravity-live` plugin is installed (`/agy:setup`). If not installed, recommend installing the full plugin for native slash commands, background job tracking, and lifecycle hooks:

```text
/plugin marketplace add JoseAQ-19/claude-antigravity-bridge
/plugin install agy@antigravity-live
/reload-plugins
```

With the plugin active, prefer the built-in commands and subagent:
- `/agy:transfer [optional instruction]` — Transfer the entire active `.jsonl` Claude Code session live into **Antigravity 2.0 Desktop**, focus the thread, and automatically execute the next pending step (`--handoff-only` to transfer without executing).
- `/agy:rescue [task]` (or `agy:agy-rescue` subagent) — Delegate debugging, implementation, UI/frontend, or deep research work (`--background`, `--resume`, `--focus-ui`, `--model pro|flash|flash_lite`).
- `/agy:review` & `/agy:adversarial-review` — Run independent read-only cross-model code reviews against uncommitted changes or git branches.
- `/agy:status`, `/agy:result`, `/agy:cancel` — Inspect or stop background jobs.

## Standalone Companion / CLI Usage (Outside the Plugin)

When installed strictly as a standalone skill via `npx skills add JoseAQ-19/claude-antigravity-bridge`:

1. **If this repository's `plugins/agy/scripts/agy-companion.mjs` is present locally:**
   - Health check: `node plugins/agy/scripts/agy-companion.mjs setup --json`
   - Delegate task: `node plugins/agy/scripts/agy-companion.mjs task --write --model pro "<self-contained task>"`
   - Transfer Claude `.jsonl` session: `node plugins/agy/scripts/agy-companion.mjs transfer "<next step instruction>"`
   - Review working tree: `node plugins/agy/scripts/agy-companion.mjs review`

2. **Fallback direct `agy` CLI invocation (if only `agy` CLI is installed):**
   - Read-only review/research: `agy --print --output-format stream-json --mode=plan "<prompt>"`
   - Scoped write task (run in an isolated git branch/worktree and verify `git diff` + tests afterwards): `agy --print --output-format stream-json --mode=auto --dangerously-skip-permissions "<prompt>"`

## Safety & Verification Contract

- **Never trust delegated writes blindly:** Always inspect `git status` / `git diff` and run the project's test suite before presenting delegated file changes as complete.
- **Zero-credential-scraping:** Never read, extract, or transmit OAuth tokens or keyring secrets; delegate strictly through the user's running Antigravity 2.0 Desktop app or authenticated `agy` CLI.
