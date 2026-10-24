---
description: Pull an active or recent Google Antigravity 2.0 conversation and its touched files live into Claude Code
argument-hint: "[conversation-id] [--list] [--all]"
---

Import a live conversation from Google Antigravity 2.0 Desktop (or offline `~/.gemini/antigravity/brain` logs) directly into this Claude Code session so you can seamlessly continue Antigravity's work here.

Raw arguments:
`$ARGUMENTS`

Execution rules:
- Run in a single `Bash` call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" pull "$ARGUMENTS"
```
- Present the imported Antigravity conversation summary, Conversation ID, archive file path, and modified files clearly to the user.
- Absorb the imported conversation context as active working memory so you are immediately ready to continue from where Antigravity left off.
