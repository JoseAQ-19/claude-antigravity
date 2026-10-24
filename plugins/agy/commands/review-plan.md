---
description: Critique an implementation plan (Claude Plan Mode, PLAN.md, PRD.md, or active session plan) with Google Antigravity before writing code
argument-hint: "[plan-file] [--background] [--model <pro|flash>] [specific architectural focus]"
---

Run an independent Principal Architect & YAGNI critique on your implementation plan via Google Antigravity before spending tokens implementing code.

Raw arguments:
`$ARGUMENTS`

Execution rules:
- Run a single `Bash` call (with `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review-plan "$ARGUMENTS"
```
- Present the full verdict (`READY TO IMPLEMENT` vs `REVISE PLAN FIRST`) and prioritized findings (`[P0]`, `[P1]`, `[P2]`) verbatim, then STOP so the user can decide which plan adjustments to adopt.
