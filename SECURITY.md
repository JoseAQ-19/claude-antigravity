# Security Policy & Architecture Guarantee

## Zero-Auth-Scraping Guarantee (100% ToS-Compliant Design)

Unlike third-party OAuth scrapers or reverse-API proxies, **`claude-antigravity-bridge` NEVER reads, extracts, stores, proxies, or transmits OAuth tokens, API keys, cookies, or system keyring credentials**.

- **Localhost Official Sidecar & CLI Only:** All requests are dispatched strictly on `127.0.0.1` / `localhost` through the user's already-running **Google Antigravity 2.0 Desktop** process (`agentapi` + local CSRF-protected Connect RPC) or the official **`agy` CLI** binary installed on the user's machine.
- **Zero External Network Calls:** This plugin contains **zero `npm` runtime dependencies** and makes **zero outbound internet requests**. Only Node.js built-in modules (`node:fs`, `node:http`, `node:child_process`, `node:path`, `node:os`, `node:crypto`, `node:url`) are used.
- **Session Handoff Privacy:** When `/agy:transfer` exports a Claude Code `.jsonl` session into `.claude/agy-handoffs/`, keep `.claude/agy-handoffs/` in your repository's `.gitignore` so conversation transcripts are never accidentally committed to version control.

## Supported Versions

| Version | Supported |
| :--- | :---: |
| `1.0.x` | Yes |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities (such as command injection, arbitrary file overwrite, or local privilege escalation). Instead, report vulnerabilities privately via **[GitHub Private Vulnerability Reporting](https://github.com/JoseAQ-19/claude-antigravity-bridge/security/advisories/new)** on this repository. You can expect an initial response within 72 hours.
