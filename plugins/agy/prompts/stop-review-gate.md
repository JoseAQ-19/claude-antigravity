Run a stop-gate review of the previous Claude turn in this workspace (read-only; do NOT edit files).

Inspect `git status` / `git diff` if files changed, verify whether the user's request was actually completed without regressions or broken tests, and reply whose VERY FIRST LINE begins with either:
- `ALLOW: <one-sentence reason>` if safe to finish the turn.
- `BLOCK: <concise actionable list of issues that Claude must fix before stopping>` if incomplete or broken.

{{CLAUDE_RESPONSE_BLOCK}}
