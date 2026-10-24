---
description: Give Claude Code multimodal eyes and ears â€” analyze videos (.mp4/.mov), audio (.mp3/.wav), PDFs, or screenshots via Gemini and correlate bugs with your codebase
argument-hint: "<video/audio/pdf/image-file...> [--no-correlate] [--background] [--model <pro|flash>] [question or bug description]"
---

Delegate video, screen-recording, audio, PDF, or visual perception to Google Antigravity's native Gemini multimodal engine, save the exhaustive timestamped breakdown to `.claude/agy-handoffs/` (keeping Claude's context lean), and return an actionable root-cause digest correlated with the repository's source files.

Raw arguments:
`$ARGUMENTS`

Execution rules:
- Run a single `Bash` call (with `timeout: 600000`):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" media "$ARGUMENTS"
```
- Present Antigravity's timestamped findings, `file:line` root-cause diagnosis, recommended fix, and full transcript archive path verbatim to the user.
- Do NOT auto-edit code after a media diagnosis unless the user explicitly asks you to apply the recommended fix.
