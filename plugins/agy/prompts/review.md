Perform a rigorous, read-only code review of {{TARGET_LABEL}}.

Rules:
- Do NOT modify any files or run mutating git commands.
- Prioritize findings by severity (Critical, High, Medium, Low) with exact file paths and line numbers.
- Focus on real bugs, regressions, security issues, race conditions, broken edge cases, and missing test coverage.
- If there are no defects, explicitly state "Verdict: LGTM (no blocking issues found)" and note any brief residual risks.

Review input:
{{REVIEW_INPUT}}
