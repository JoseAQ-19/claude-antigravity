---
description: Race Google Antigravity (in an isolated git worktree) and Claude Code in parallel on the same task, then compare both solutions
argument-hint: "[--model <pro|flash>] <bug fix, refactor, or feature specification>"
allowed-tools: Read, Edit, Write, Glob, Grep
---

Launch a parallel dual-agent race: Google Antigravity solves the task inside an isolated `git worktree` in the background (zero file collisions), while you (Claude Code) solve the same task concurrently in the current workspace, followed by a side-by-side comparison.

Task to race on:
`$ARGUMENTS`

Execution protocol:
1. Immediately dispatch Google Antigravity in an isolated background git worktree:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task --background --worktree --write "$ARGUMENTS"
```
2. Record the returned `<job-id>`, then solve the exact same task yourself cleanly in the current workspace (and verify tests if applicable).
3. Once your implementation is ready, wait for and collect Antigravity's isolated worktree solution:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status <job-id> --wait
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result <job-id>
```
4. Present an objective side-by-side comparison of **Claude's diff** vs **Antigravity's isolated worktree diff** (simplicity, edge cases covered, test results), and remind the user they can adopt Antigravity's patch via `/agy:result <job-id> --apply-worktree` (after `git checkout -- .`) or keep Claude's version.
