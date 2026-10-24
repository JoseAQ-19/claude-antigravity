import { spawnSync } from "node:child_process";
import { resolveWorkspaceRoot } from "./state.mjs";

function runGit(cwd, args, maxBuffer = 8 * 1024 * 1024) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
    timeout: 15000
  });
  return {
    ok: res.status === 0,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? "")
  };
}

export function getGitSummary(cwd) {
  const check = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isGitRepo: false, repoRoot: cwd, branch: null, statusShort: "", diffStat: "" };
  }
  const repoRoot = resolveWorkspaceRoot(cwd);
  const branchRes = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const statusRes = runGit(repoRoot, ["status", "--short", "--untracked-files=all"]);
  const diffStatRes = runGit(repoRoot, ["diff", "--stat", "HEAD"]);
  return {
    isGitRepo: true,
    repoRoot,
    branch: branchRes.ok ? branchRes.stdout.trim() : "HEAD",
    statusShort: statusRes.stdout.trim(),
    diffStat: diffStatRes.stdout.trim()
  };
}

export function collectReviewContext(cwd, { base = null, scope = "auto", maxDiffChars = 60000 } = {}) {
  const summary = getGitSummary(cwd);
  if (!summary.isGitRepo) {
    throw new Error(`Current workspace is not a Git repository: ${cwd}`);
  }
  const { repoRoot, branch, statusShort } = summary;
  const effectiveScope = base ? "branch" : scope === "auto" ? (statusShort ? "working-tree" : "branch") : scope;

  if (effectiveScope === "working-tree") {
    const staged = runGit(repoRoot, ["diff", "--cached"]);
    const unstaged = runGit(repoRoot, ["diff"]);
    const combined = [
      `Repository: ${repoRoot}`,
      `Branch: ${branch}`,
      `Git status:\n${statusShort || "(clean)"}`,
      staged.stdout.trim() ? `Staged diff:\n${staged.stdout.trim()}` : "",
      unstaged.stdout.trim() ? `Unstaged diff:\n${unstaged.stdout.trim()}` : ""
    ].filter(Boolean).join("\n\n");
    return {
      repoRoot,
      branch,
      targetLabel: "working tree changes",
      content: combined.length > maxDiffChars ? `${combined.slice(0, maxDiffChars)}\n...[diff truncated — inspect remaining files directly]` : combined
    };
  }

  let baseRef = base;
  if (!baseRef) {
    for (const candidate of ["origin/main", "origin/master", "main", "master", "HEAD~1"]) {
      if (runGit(repoRoot, ["rev-parse", "--verify", candidate]).ok) {
        baseRef = candidate;
        break;
      }
    }
  }
  if (!baseRef) {
    throw new Error("Could not resolve a base git ref for branch review. Pass --base <ref>.");
  }
  const diff = runGit(repoRoot, ["diff", `${baseRef}...HEAD`]);
  const log = runGit(repoRoot, ["log", "--oneline", `${baseRef}..HEAD`]);
  const combined = [
    `Repository: ${repoRoot}`,
    `Branch: ${branch} (compared against ${baseRef})`,
    log.stdout.trim() ? `Commits:\n${log.stdout.trim()}` : "",
    `Diff:\n${diff.stdout.trim() || "(no committed diff against base)"}`
  ].filter(Boolean).join("\n\n");

  return {
    repoRoot,
    branch,
    targetLabel: `${baseRef}...HEAD`,
    content: combined.length > maxDiffChars ? `${combined.slice(0, maxDiffChars)}\n...[diff truncated — inspect remaining files directly]` : combined
  };
}
