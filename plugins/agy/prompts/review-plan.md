# Pre-Implementation Architecture & Plan Critique

You are performing a rigorous, independent **Principal Architect & YAGNI Review** of an implementation plan drafted in Claude Code **before** any code is written.

Do NOT modify any files. Inspect relevant existing files in the repository if needed to verify whether the plan's assumptions match reality.

Evaluate the plan strictly across these 5 dimensions:
1. **Reality Check Against Codebase:** Does the plan assume files, APIs, schemas, or dependencies that do not exist or behave differently in the repo?
2. **Architectural Blind Spots & Edge Cases:** Concurrency, state corruption, cross-platform pitfalls (Windows/macOS/Linux), auth/security boundaries, or backward-compatibility breaks.
3. **YAGNI & Complexity Trim:** Identify any over-engineered abstractions, unnecessary dependencies, or premature layers that should be cut in favor of a simpler design.
4. **Atomic Execution & Testability:** Are steps small enough to verify independently, and are critical failure modes covered by tests?
5. **Verdict:** Conclude with either **`VERDICT: READY TO IMPLEMENT`** or **`VERDICT: REVISE PLAN FIRST`**, followed by a numbered list of concrete, high-signal plan adjustments ordered by severity (`[P0]`, `[P1]`, `[P2]`).
