import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  generateJobId,
  getConfig,
  listJobs,
  readJobFile,
  setConfig,
  upsertJob,
  writeJobFile
} from "../plugins/agy/scripts/lib/state.mjs";
import { collectReviewContext, getGitSummary } from "../plugins/agy/scripts/lib/git.mjs";

test("state persistence stores config and jobs cleanly", () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-data-"));
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-ws-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmpData;
  try {
    setConfig(tmpWs, "stopReviewGate", true);
    assert.equal(getConfig(tmpWs).stopReviewGate, true);

    const jobId = generateJobId("task");
    const record = { id: jobId, status: "running", conversationId: "conv-123", summary: "Fix bug" };
    writeJobFile(tmpWs, jobId, record);
    upsertJob(tmpWs, record);

    assert.equal(listJobs(tmpWs).length, 1);
    assert.equal(readJobFile(tmpWs, jobId).conversationId, "conv-123");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test("git helpers collect working-tree review context", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-git-"));
  try {
    spawnSync("git", ["init"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "app.js"), "console.log('v1');\n");
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repo });

    fs.writeFileSync(path.join(repo, "app.js"), "console.log('v2');\n");
    const summary = getGitSummary(repo);
    assert.equal(summary.isGitRepo, true);
    assert.match(summary.statusShort, /app\.js/);

    const ctx = collectReviewContext(repo, { scope: "working-tree" });
    assert.equal(ctx.targetLabel, "working tree changes");
    assert.match(ctx.content, /\+console\.log\('v2'\)/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
