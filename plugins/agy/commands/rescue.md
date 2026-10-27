---
description: Delegate investigation, frontend/UI work, debugging, or isolated --worktree implementation to Google Antigravity
argument-hint: "[--background|--wait] [--worktree] [--resume|--fresh] [--focus-ui] [--model <pro|flash|flash_lite>] [what Antigravity should solve or continue]"
allowed-tools: AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the user's request.
`agy:agy-rescue` is a subagent, not a skill â€” do not call `Skill(...)`.

Raw user request:
$ARGUMENTS

Routing rules:
- If `--worktree` is passed, forward `--worktree` directly (starts a clean isolated git worktree so Antigravity never collides with files Claude Code is editing).
- Otherwise, if `--resume` or `--fresh` is not explicitly provided, check whether a resumable Antigravity conversation exists in this workspace:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task-resume-candidate --json
```
- If `available: true`, use `AskUserQuestion` once with:
  - `Continue current Antigravity conversation`
  - `Start a new Antigravity conversation`
  (Put `Continue... (Recommended)` first if the request sounds like a follow-up, otherwise `Start a new... (Recommended)` first, and append `--resume` or `--fresh` accordingly.)
- Use the companion's built-in `--background` launcher by default for long delegated work. Always forward `--background` when requested; never replace it with shell detachment or merely backgrounding the forwarding subagent.
- Preserve `--timeout-ms`, `--max-resumes`, and repeated `--allowed-path` options. A launch acknowledgement only confirms startup; retain the job ID and status/result commands.
- Return Antigravity's companion output verbatim to the user without paraphrasing.
