# Security Policy & Architecture Guarantee

## Zero-Auth-Scraping Guarantee (100% ToS-Compliant Design)

Unlike third-party OAuth scrapers or reverse-API proxies, **`claude-antigravity` NEVER reads, extracts, stores, proxies, or transmits OAuth tokens, API keys, cookies, or system keyring credentials**.

- **Localhost Official Sidecar & CLI Only:** All requests are dispatched strictly on `127.0.0.1` / `localhost` through the user's already-running **Google Antigravity 2.0 Desktop** process (`agentapi` + local CSRF-protected Connect RPC) or the official **`agy` CLI** binary installed on the user's machine.
- **Privacy-By-Default HUD (`/agy:quota`):** Account email addresses are redacted by default so terminal screenshots can be shared safely on GitHub, X, or Slack without leaking personal data.
- **Zero External Network Calls & Zero Dependencies:** This plugin contains **zero `npm` runtime dependencies** and makes **zero outbound internet requests**. Only Node.js built-in modules (`node:fs`, `node:http`, `node:child_process`, `node:path`, `node:os`, `node:crypto`, `node:url`) are used.
- **Session & Media Handoff Privacy:** Exported transcripts, media digests, and worktree patches inside `.claude/agy-handoffs/` automatically create a local `.gitignore` (`*`) so sensitive conversation data is never accidentally committed.

## Supported Versions

| Version | Supported |
| :--- | :---: |
| `1.1.x` | Yes |
| `1.0.x` | Yes |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities. Report vulnerabilities privately via **[GitHub Private Vulnerability Reporting](https://github.com/JoseAQ-19/claude-antigravity/security/advisories/new)** on this repository. You can expect an initial response within 72 hours.
