---
description: Delegate investigation, frontend/UI work, debugging, or implementation to Google Antigravity
argument-hint: "[--background|--wait] [--resume|--fresh] [--focus-ui] [--model <pro|flash|flash_lite>] [what Antigravity should solve or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the user's request.
`agy:agy-rescue` is a subagent, not a skill — do not call `Skill(...)`.

Raw user request:
$ARGUMENTS

Routing rules:
- If `--resume` or `--fresh` is not explicitly provided, check whether a resumable Antigravity conversation exists in this workspace:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task-resume-candidate --json
```
- If `available: true`, use `AskUserQuestion` once with:
  - `Continue current Antigravity conversation`
  - `Start a new Antigravity conversation`
  (Put `Continue... (Recommended)` first if the request sounds like a follow-up, otherwise `Start a new... (Recommended)` first, and append `--resume` or `--fresh` accordingly.)
- If `--background` is present, either pass `--background` to `agy-companion.mjs task` or run the subagent in the background.
- Return Antigravity's companion output verbatim to the user without paraphrasing.
