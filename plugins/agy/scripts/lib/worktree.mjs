import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceHandoffDir } from "./claude-session-parser.mjs";
import { resolveWorkspaceRoot } from "./state.mjs";

function runGit(cwd, args, extraEnv = null) {
  const res = spawnSync("git", args, {
    cwd,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 20000
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? "")
  };
}

export function createIsolatedWorktree(cwd, jobId) {
  const repoRoot = resolveWorkspaceRoot(cwd);
  const check = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!check.ok) {
    throw new Error("`--worktree` requires a Git repository with at least one commit (`HEAD`).");
  }
  const headSha = check.stdout.trim();
  const repoSlug = (path.basename(repoRoot) || "repo").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24);
  const worktreePath = path.join(os.tmpdir(), `claude-agy-wt-${repoSlug}-${jobId}`);

  if (fs.existsSync(worktreePath)) {
    runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  const addRes = runGit(repoRoot, ["worktree", "add", "--detach", worktreePath, headSha]);
  if (!addRes.ok) {
    throw new Error(`Failed to create isolated git worktree: ${addRes.stderr.trim()}`);
  }

  return {
    repoRoot,
    worktreePath,
    baseCommit: headSha
  };
}

export function captureWorktreeChanges(workspaceRoot, worktreePath, jobId) {
  const statusRes = runGit(worktreePath, ["-c", "core.quotepath=false", "status", "--short", "--untracked-files=all"]);
  const statusShort = statusRes.stdout.replace(/[\r\n]+$/, "");

  // Use a temporary GIT_INDEX_FILE so newly created untracked files are included in the unified patch
  // without mutating the worktree's real staging area.
  const tmpIndex = path.join(os.tmpdir(), `agy-wt-idx-${jobId}-${Date.now()}`);
  let patchText = "";
  let diffStat = "";
  let changedFiles = [];

  try {
    const gitIndexRes = runGit(worktreePath, ["rev-parse", "--git-path", "index"]);
    const realIndex = path.resolve(worktreePath, gitIndexRes.stdout.trim());
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tmpIndex);
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    runGit(worktreePath, ["add", "-A"], env);
    const diffRes = runGit(worktreePath, ["diff", "--cached", "--binary", "HEAD"], env);
    const statRes = runGit(worktreePath, ["diff", "--cached", "--stat", "HEAD"], env);
    const namesRes = runGit(worktreePath, ["diff", "--cached", "--name-only", "HEAD"], env);

    patchText = diffRes.stdout;
    diffStat = statRes.stdout.trim();
    changedFiles = namesRes.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith(".claude/agy-handoffs/"));
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  let patchPath = null;
  if (patchText.trim() && changedFiles.length > 0) {
    const handoffDir = resolveWorkspaceHandoffDir(workspaceRoot);
    patchPath = path.join(handoffDir, `worktree-${jobId}.patch`);
    fs.writeFileSync(patchPath, patchText, "utf8");
  }

  return {
    hasChanges: changedFiles.length > 0,
    statusShort,
    diffStat,
    changedFiles,
    patchPath
  };
}

export function applyWorktreePatch(workspaceRoot, patchPath) {
  const repoRoot = resolveWorkspaceRoot(workspaceRoot);
  if (!patchPath || !fs.existsSync(patchPath)) {
    throw new Error(`Worktree patch file not found: ${patchPath}`);
  }
  const check = runGit(repoRoot, ["apply", "--check", patchPath]);
  if (!check.ok) {
    throw new Error(`Patch cannot be applied cleanly to current working tree:\n${check.stderr.trim()}`);
  }
  const apply = runGit(repoRoot, ["apply", "--index", patchPath]);
  if (!apply.ok) {
    // Fallback without --index if untracked conflict on index
    const plain = runGit(repoRoot, ["apply", patchPath]);
    if (!plain.ok) {
      throw new Error(`git apply failed:\n${plain.stderr.trim()}`);
    }
  }
  return { applied: true, patchPath };
}

export function cleanupIsolatedWorktree(workspaceRoot, worktreePath) {
  if (!worktreePath) return;
  const repoRoot = resolveWorkspaceRoot(workspaceRoot);
  runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
}
