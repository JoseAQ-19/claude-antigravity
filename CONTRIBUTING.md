# Contributing to `claude-antigravity-bridge`

Thank you for helping improve the live bridge between **Claude Code** and **Google Antigravity 2.0**!

## Engineering Principles

1. **Zero Runtime Dependencies:** Do not add packages to `dependencies` in `package.json`. Everything inside `plugins/agy/scripts/` must run on vanilla **Node.js >= 18 ESM** using standard `node:*` built-in modules.
2. **True Cross-Platform Support (Windows, macOS, Linux):** Never introduce Bash-only `.sh` wrappers or Unix-only path assumptions. Every command must run natively on Windows PowerShell/CMD, macOS, and Linux.
3. **Graceful Desktop RPC Degradation:** Internal Connect RPC endpoints on `language_server` (`GetCascadeTrajectory`, `WaitForConversationFullyIdle`, `SmartFocusConversation`, `GetTrajectoryFileDiffs`) may evolve across Antigravity Desktop 2.x updates. Always guard optional RPCs and fall back cleanly to `agentapi` or `agy` CLI.
4. **Keep Token Footprint Minimal:** Skills and commands inside `plugins/agy/` load into Claude Code's session metadata. Keep frontmatter descriptions concise and keep internal skills marked `user-invocable: false`.

## Local Development & Testing

### 1. Run Hermetic CI Tests (Offline, No Antigravity Required)
All unit, mock-RPC, release-readiness, and CLI tests in `tests/test_*.mjs` must pass offline without Antigravity installed:

```bash
npm run verify
```

### 2. Run Live End-to-End Tests (Requires Antigravity 2.0 Desktop Running)
With **Google Antigravity 2.0 Desktop** open on your machine, run the live round-trip E2E test (creates a real conversation via `/agy:transfer`, executes the pending step, verifies `--resume`, and cleans up the test thread automatically):

```bash
npm run test:live
```

### 3. Validate & Test Inside Claude Code Locally
```bash
claude plugin validate .
claude --plugin-dir ./plugins/agy
```
