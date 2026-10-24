import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyWorktreePatch,
  captureWorktreeChanges,
  cleanupIsolatedWorktree,
  createIsolatedWorktree
} from "../plugins/agy/scripts/lib/worktree.mjs";

test("isolated git worktree captures modified and newly created untracked files without colliding with main repo, then applies patch cleanly", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-wt-repo-"));
  let wtPath = null;

  try {
    spawnSync("git", ["init"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "index.js"), "export const v = 1;\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: repo });

    const wt = createIsolatedWorktree(repo, "job-wt-1");
    wtPath = wt.worktreePath;
    assert.equal(fs.existsSync(wtPath), true);

    // Simulate Antigravity editing an existing file AND creating a new untracked file inside the worktree
    fs.writeFileSync(path.join(wtPath, "index.js"), "export const v = 2;\n", "utf8");
    fs.writeFileSync(path.join(wtPath, "helper.js"), "export function help() { return 'ok'; }\n", "utf8");

    // Main repo must remain 100% untouched while Antigravity works in parallel!
    assert.equal(fs.readFileSync(path.join(repo, "index.js"), "utf8"), "export const v = 1;\n");
    assert.equal(fs.existsSync(path.join(repo, "helper.js")), false);

    const changes = captureWorktreeChanges(repo, wtPath, "job-wt-1");
    assert.equal(changes.hasChanges, true);
    assert.deepEqual(changes.changedFiles.sort(), ["helper.js", "index.js"]);
    assert.ok(changes.patchPath && fs.existsSync(changes.patchPath));

    cleanupIsolatedWorktree(repo, wtPath);
    assert.equal(fs.existsSync(wtPath), false);
    wtPath = null;

    // Now apply the captured worktree patch into main repo cleanly
    const applied = applyWorktreePatch(repo, changes.patchPath);
    assert.equal(applied.applied, true);
    assert.equal(fs.readFileSync(path.join(repo, "index.js"), "utf8").replace(/\r\n/g, "\n"), "export const v = 2;\n");
    assert.equal(fs.existsSync(path.join(repo, "helper.js")), true);
  } finally {
    if (wtPath) cleanupIsolatedWorktree(repo, wtPath);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
