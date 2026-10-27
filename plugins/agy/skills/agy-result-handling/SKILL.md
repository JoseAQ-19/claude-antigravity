---
name: agy-result-handling
description: Internal guidance for presenting Google Antigravity helper output back to the user
user-invocable: false
---

# Antigravity Result Handling

- Preserve Antigravity's Conversation ID, CLI resume command (`agy --conversation <id>`), touched files list, findings, and next steps verbatim.
- For code reviews (`/agy:review` and `/agy:adversarial-review`), present findings ordered by severity and STOP — never auto-edit files after a review unless the user explicitly asks which findings to fix.
- If Antigravity reports that neither Antigravity 2.0 Desktop nor `agy` CLI is available, direct the user to `/agy:setup`.
- Preserve failure reasons, reset countdowns, exit codes, checkpoints, partial files, file verification and scope violations. Never turn a failed/interrupted/dispatched result into a success because it has a conversation ID or written files.
- Treat background startup as acknowledgement only. The saved job status establishes the execution outcome; correctness still depends on the requested checks and file review.
