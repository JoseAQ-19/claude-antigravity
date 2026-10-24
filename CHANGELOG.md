# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-24

### Added
- **Dual-Engine Runtime (`desktop-live` + `cli-headless`):** Auto-discovers a running **Google Antigravity 2.0 Desktop** `language_server` across Windows (PowerShell CIM/TCP), macOS (`ps` + `lsof`), and Linux (`ps` + `lsof` / `ss -tlnp`), with automatic fallback to the standalone `agy` CLI (`--print --output-format stream-json`).
- **Live `/agy:transfer` Command:** Parses the active Claude Code `.jsonl` transcript, strips tool/telemetry noise, archives the verbatim transcript in `.claude/agy-handoffs/`, creates and focuses (`SmartFocusConversation`) a live visual conversation inside Antigravity 2.0 Desktop, and **automatically executes the next pending step** (`--handoff-only` supported to transfer without executing).
- **Full Slash Command Suite (`/agy:*`):** `/agy:setup`, `/agy:rescue`, `/agy:transfer`, `/agy:review`, `/agy:adversarial-review`, `/agy:status`, `/agy:result`, and `/agy:cancel`.
- **Proactive Subagent (`agy:agy-rescue`):** Thin-forwarder subagent for autonomous background delegation (`--resume`, `--fresh`, `--focus-ui`, `--model pro|flash|flash_lite`).
- **Lifecycle & Stop-Review-Gate Hooks:** `SessionStart` / `SessionEnd` session tracking and opt-in `Stop` quality gate (`ALLOW:` / `BLOCK:`).
- **Future-Proof RPC Resilience:** Automatic fallback if internal Connect RPCs return `404`/`501`, `git status` touched-file fallback, and wall-clock timeout protection for non-TTY CLI runs.
- **Omnichannel Distribution:** Native Claude Code Marketplace (`antigravity-live`) + universal Agent Skill (`skills/antigravity-bridge/SKILL.md`) for `skills.sh` (`npx skills add`).
