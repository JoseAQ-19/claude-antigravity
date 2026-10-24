# Contributing to `claude-antigravity`

Thank you for helping improve the bidirectional bridge between **Claude Code** and **Google Antigravity 2.0**!

## Engineering Principles

1. **Zero Runtime Dependencies:** Do not add packages to `dependencies` in `package.json`. Everything inside `plugins/agy/scripts/` must run on vanilla **Node.js >= 18 ESM** using standard `node:*` built-in modules.
2. **True Cross-Platform Support (Windows, macOS Apple Silicon/Intel, Linux):** Never introduce Bash-only `.sh` wrappers or Unix-only path assumptions. Every command must run natively on Windows PowerShell/CMD, macOS, and Linux.
3. **Graceful Desktop RPC Degradation:** Internal Connect RPC endpoints on `language_server` (`GetCascadeTrajectory`, `WaitForConversationFullyIdle`, `SmartFocusConversation`, `GetTrajectoryFileDiffs`, `GetCascadeModelConfigData`, `ForkConversation`, `RevertToCascadeStep`) may evolve across Antigravity Desktop 2.x updates. Always guard optional RPCs and fall back cleanly to `agentapi`, git, or `agy` CLI.
4. **Keep Context Footprint Featherlight:** Keep slash command frontmatter concise (`1` clear sentence per command) and mark internal helper skills `user-invocable: false`.

## Local Development & Testing

### 1. Run Release Audit + Hermetic CI Tests (Offline, No Antigravity Required)
```bash
npm run verify
```

### 2. Run Live End-to-End Tests (Requires Antigravity 2.0 Desktop Running)
```bash
npm run test:live
```

### 3. Validate & Test Inside Claude Code Locally
```bash
claude plugin validate .
claude --plugin-dir ./plugins/agy
```
