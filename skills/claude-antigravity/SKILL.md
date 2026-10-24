---
name: claude-antigravity
description: Bidirectional live bridge between Claude Code and Google Antigravity 2.0 Desktop IDE + agy CLI — teleport sessions both ways (/agy:transfer & /agy:pull), give Claude multimodal video/audio eyes (/agy:media), race tasks in isolated git worktrees (/agy:race), critique plans (/agy:review-plan), inspect live model quotas (/agy:quota), undo/fork turns, and sync memory.
---

# Claude ↔ Google Antigravity 2.0 (`claude-antigravity`)

Connect **Claude Code** (or any Agent Skills-compatible harness) directly with **Google Antigravity 2.0 Desktop IDE** (`language_server` Connect RPC + `agentapi`) and **`agy` CLI** in dual mode.

## Install the Full Native Claude Code Plugin (Recommended)

Inside **Claude Code**, install the native plugin to unlock all 16 `/agy:*` slash commands, proactive `agy:agy-rescue` subagent, and session hooks:

```text
/plugin marketplace add JoseAQ-19/claude-antigravity
/plugin install agy@claude-antigravity
/reload-plugins
```

### Core Capabilities When Installed
- **Bidirectional Session Teleport:** `/agy:transfer` (Claude `.jsonl` -> live Antigravity 2.0 IDE + auto-executes next step) & `/agy:pull` (Antigravity 2.0 -> Claude Code).
- **Multimodal Video & Audio Eyes:** `/agy:media <video/audio/pdf/image> [question]` — Gemini watches screen-recorded UI bugs (`.mp4`/`.mov`) or listens to audio (`.mp3`/`.wav`), archives the full transcript to disk, and returns a timestamped `file:line` root-cause digest to Claude.
- **Zero-Collision Parallel Worktrees & Racing:** `/agy:rescue --worktree` and `/agy:race "<task>"` isolate Antigravity in a temporary `git worktree` and export a clean patch (`/agy:result <id> --apply-worktree`).
- **Pre-Code Plan Critique & Reviews:** `/agy:review-plan`, `/agy:review`, and `/agy:adversarial-review`.
- **Live Quota HUD, Time-Travel & Memory Sync:** `/agy:quota`, `/agy:undo`, `/agy:fork`, and `/agy:sync-memory`.

## Standalone Companion / CLI Usage

If invoked outside the Claude plugin via `npx skills add JoseAQ-19/claude-antigravity`:
- Health check: `node plugins/agy/scripts/agy-companion.mjs setup --json`
- Quota HUD: `node plugins/agy/scripts/agy-companion.mjs quota`
- Media eyes: `node plugins/agy/scripts/agy-companion.mjs media bug.mp4 "Why does the modal flicker?"`
- Isolated worktree task: `node plugins/agy/scripts/agy-companion.mjs task --worktree --write "<task>"`

## Safety Contract
- Always verify delegated file changes (`git diff` + project tests) before merging.
- Never extract or proxy OAuth tokens; delegate strictly through the user's running Antigravity 2.0 Desktop app or authenticated `agy` CLI.
