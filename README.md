# `agy` — Google Antigravity Plugin for Claude Code (`antigravity-cc`)

Bridge **Claude Code** directly with **Google Antigravity** (Dual Engine: live **Antigravity 2.0 Desktop** Connect RPC / `agentapi` + automatic fallback to **`agy` CLI**).

## Key Features
- **`/agy:transfer [instrucción opcional]`** — Captures your **entire active Claude Code conversation** (`.jsonl`), distills out telemetry bloat, saves the full verbatim session archive in `.claude/agy-handoffs/`, opens & focuses the new thread live in **Antigravity 2.0 Desktop**, **and immediately executes the next logical pending step** (pass `--handoff-only` to sync context without executing, or `--background` to run detached).
- **`/agy:rescue [prompt]`** & proactive **`agy:agy-rescue` subagent** — Delegate complex debugging, UI/frontend work, browser verification, or implementation tasks (`--wait`, `--background`, `--resume`, `--fresh`, `--focus-ui`, `--model pro|flash|flash_lite`).
- **`/agy:review`** & **`/agy:adversarial-review`** — Read-only code & architecture reviews against uncommitted changes or git branches.
- **`/agy:status`**, **`/agy:result`**, **`/agy:cancel`**, **`/agy:setup`** — Full background job lifecycle & optional `Stop` review gate.

## Local Installation in Claude Code
```bash
claude plugin validate .
claude plugin marketplace add "c:/Users/usuario/Desktop/plugin antigravity"
claude plugin install agy@antigravity-cc
```
