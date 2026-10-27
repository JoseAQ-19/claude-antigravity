# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.3] - 2026-10-27

### Fixed
- Desktop timeouts and explicit executor step-limit errors now save a recovery checkpoint (conversation, partial output, changed files and SHA-256 fingerprints), stop and confirm the previous invocation is idle, and continue in the same conversation up to two times. Unrecoverable or exhausted attempts remain `interrupted` with exit 124 rather than claiming success. Quota errors never auto-retry.
- Job records, status Summary, result headers and logs retain the actual quota/reset, timeout, write or execution error even when the model returned partial text or created a conversation. Older failed job records also expose their stored output as diagnostics.
- Background launch uses a startup acknowledgement and explicit starting/terminal records, preserves boot stderr, and no longer overwrites a worker's state with stale queued data. Dead workers and launches without acknowledgement become explicit failures. `status <id> --wait` exits with the recorded job outcome.
- Missing trajectory monitoring is reported as `dispatched` with unverified completion. Interrupted or unmonitored isolated worktrees are retained for recovery.
- Atomic JSON writes and authoritative per-job records prevent truncated reads and hide fewer concurrent-index races. Git file snapshots handle NUL-separated Unicode paths, same-size edits and restoration of previously dirty files.

### Added
- `--timeout-ms` and bounded `--max-resumes <0..5>` on job commands; `task --allowed-path <path>` can be repeated to declare file/directory scope. Prompt boundaries and post-run scope checks report unexpected edits without deleting them. This is detection, not an OS sandbox.
- Hermetic regressions cover recovery, quota failures with partial output, background acknowledgement, lost workers, file fingerprints, scope violations and false success rendering. Existing `task --help` protection remains covered.

## [1.1.2] - 2026-10-26

### Fixed
- **False `failed` Job Status & Premature Loop Exit on Long Multi-Step Trajectories (`runDesktopTurn`):** Fixed polling loop exiting prematurely between tool calls while `GetCascadeTrajectory.status` was still `CASCADE_RUN_STATUS_RUNNING` (`isTrajectoryRunning`), fixed `exitStatus` returning `1` when a conversation finished cleanly without prose output, and added explicit `exitStatus` logging to job `.log` files and `/agy:status <job-id>`.
- **Per-Backend `--model` Validation & Unified Canonical Tier Map (`UNIFIED_MODEL_TIERS`):** Added a single canonical tier map (`pro` -> `gemini-4-argon-high`, `flash` -> `gemini-3.8-flash-medium`, `flash_lite` -> `gemini-3.8-flash-low`) across `desktop-live` and `cli-headless`, added `--backend <auto|desktop|cli>`, and strictly rejected unsupported/concrete CLI model IDs on `desktop-live` upfront before creating any job (eliminating silent downgrades).
- **Subcommand `--help` / `-h` Safety (`args.mjs` & `agy-companion.mjs`):** Added per-subcommand `--help` / `-h` and `help <subcommand>` handling across all 16 subcommands so `--help` is never treated as a task prompt or queued as a job.
- **File-Aware Empty-Response Summary & Deep Git Snapshot Diff (`formatEmptyTurnMessage`):** Upgraded workspace file tracking to `git status --porcelain -uall` with `(gitCode, mtimeMs, size)` diffing merged with `GetTrajectoryFileDiffs`, reporting exact created/modified files when Antigravity completes a turn without prose text.
- **Model IDs in Quota HUD & CLI Permission Documentation:** Added concrete `modelId` badges to `/agy:quota` and documented canonical tiers, concrete CLI models, and `--mode=plan` vs `--mode=auto --dangerously-skip-permissions` security boundaries in `README.md`.

## [1.1.1] - 2026-10-25

### Fixed
- **`cli-headless` (`agy` v1.4+ Flag Ordering & Stream-JSON Schema):** Fixed `--print` consuming `--output-format` as its prompt by attaching `--print=<prompt>` as the final flag, added prompt spilling (`<= 12k` chars) for CLI turns, avoided sending invalid `--model pro` tier aliases to `agy` CLI (mapping tiers cleanly to default/`--effort`), and updated `extractCliStreamEvent` for `agy` v1.4+ nested `init` / `step_update` / `result.response` NDJSON events.
- **Desktop Git Project Resolution (`ensureDesktopProjectId`):** Matched `gitFolder.folderUri` resources in `ReadProjects` (used by Antigravity 2.0 for Git repositories), supplied mandatory UUID `project.id` to `CreateProject` (handling `{}` 200 responses), and added `default-cli-project` fallback so `agentapi` never fails on Hub instances.
- **Fast Windows Process Discovery (`ls-discovery.mjs`):** Replaced per-process `Get-NetTCPConnection` PowerShell loops (which could exceed 6s under load) with instant native `netstat -ano -p tcp` port mapping + single lightweight WMI query (~10x faster discovery).
- **Transfer Failure Diagnostics & Session Parser Compaction:** Prevented failed transfers from rendering fake success headers or `agy --conversation null` / `/agy:pull null` hints, deduplicated `touchedFiles` across `/` and `\` separators, filtered scratchpad paths, and capped inline touched-file headers on 1,000+ turn transcripts.

## [1.1.0] - 2026-10-24

### Added
- **Canonical Identity (`claude-antigravity`):** Unified repository, package, marketplace (`agy@claude-antigravity`), and `skills.sh` skill (`skills/claude-antigravity/SKILL.md`).
- **`/agy:pull` (Reverse Live Teleport):** Import active or recent conversations and modified file lists from Antigravity 2.0 Desktop (`GetAllCascadeTrajectories` + `GetCascadeTrajectory` + `ConvertTrajectoryToMarkdown`) or offline `~/.gemini/antigravity/brain` logs directly into Claude Code.
- **`/agy:media` (Multimodal Eyes & Ears for Claude Code):** Analyze screen-recorded bug videos (`.mp4`, `.mov`, `.webm`), audio recordings (`.mp3`, `.wav`, `.m4a`), PDFs, and screenshots via Gemini's native multimodal perception, archive exhaustive transcripts to `.claude/agy-handoffs/`, and return a timestamped `file:line` root-cause digest to Claude.
- **`--worktree` & `/agy:race` (Zero-Collision Parallel Git Worktrees):** Run Antigravity inside a clean isolated `git worktree` (capturing both modified and newly created untracked files into `.patch` archives) and race Antigravity vs Claude Code side-by-side, with 1-command patch application (`/agy:result <id> --apply-worktree`).
- **`/agy:review-plan` (Pre-Implementation Plan Critique):** Auto-discover plans from Claude Plan Mode (`~/.claude/plans`), `PLAN.md`, `PRD.md`, or active `.jsonl` turns and run a Principal Architect & YAGNI review before writing code.
- **`/agy:quota` (Live Antigravity HUD):** Display real-time per-model remaining quota progress bars, reset countdown timers, multimodal badges, and plan tier with privacy-by-default email redaction.
- **`/agy:undo` & `/agy:fork` (Time-Travel & Branching RPCs):** Preview (`GetRevertPreview`) or apply (`RevertToCascadeStep` + git fallback) turn rollbacks, and branch conversations via `ForkConversation`.
- **`/agy:sync-memory` (Cross-Agent Memory Bridge):** Non-destructively synchronize `CLAUDE.md` and `AGENTS.md` / `.agents/rules/claude-memory-sync.md` (`trigger: always_on`) with `.bak` backups.

### Fixed
- Deduplicated `CLAUDE_ENV_FILE` exports across `SessionStart` resumes/compactions.
- Preserved leading status columns (`" M file"`) and UTF-8 paths in `git status --short`.
- Removed `disable-model-invocation` from `status`, `result`, and `cancel` so all 16 `/agy:*` commands remain visible and invocable.

## [1.0.0] - 2026-10-24

### Added
- Initial Dual-Engine runtime (`desktop-live` Connect RPC + `agentapi` primary, `agy` CLI fallback), `/agy:transfer`, `/agy:rescue`, `/agy:review`, `/agy:adversarial-review`, lifecycle hooks, stop-review-gate, and cross-platform Windows/macOS/Linux support.
