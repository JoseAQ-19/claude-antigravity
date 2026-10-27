import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { diffWorkspaceSnapshots, runDesktopTurn, snapshotWorkspaceFiles } from "../plugins/agy/scripts/lib/agy-runtime.mjs";
import { jobStatus } from "../plugins/agy/scripts/lib/job-outcome.mjs";
import { renderTransferResult, renderTurnResult } from "../plugins/agy/scripts/lib/render.mjs";
import { upsertJob, writeJobFile } from "../plugins/agy/scripts/lib/state.mjs";

const exec = promisify(execFile);
const companion = path.resolve("plugins/agy/scripts/agy-companion.mjs");

async function withDesktop(scenario, check) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agy-recovery-"));
  spawnSync("git", ["init"], { cwd: ws, windowsHide: true });
  let phase = 0;
  let canceled = false;
  const calls = [];
  const checkpoints = [];
  const server = http.createServer((req, res) => {
    const method = req.url.split("/").pop();
    res.setHeader("Content-Type", "application/json");
    if (method === "GetCascadeTrajectory") {
      const status = canceled ? "CANCELED" : scenario === "repeat_timeout" ? "RUNNING" : phase > 1 || scenario === "success" || scenario === "external" ? "IDLE" : scenario === "quota" || scenario === "step_limit" ? "ERROR" : "RUNNING";
      const steps = [{ status: "DONE", type: "USER_INPUT" }];
      if (phase === 1 && ["quota", "step_limit"].includes(scenario)) {
        steps.push({ status: "ERROR", error: { message: scenario === "quota" ? "Individual quota reached. Resets in 135h" : "Maximum number of steps reached: step limit 280" } });
      }
      if (phase > 1) steps.push({ status: "DONE", type: "USER_INPUT" }, { status: "DONE", type: "USER_INPUT" }, { status: "DONE", plannerResponse: { response: "Verified and finished the remaining work." } });
      res.end(JSON.stringify({ status: `CASCADE_RUN_STATUS_${status}`, trajectory: { steps } }));
    } else if (method === "CancelCascadeInvocation") {
      if (scenario === "cannot_stop") { res.writeHead(501); res.end("{}"); return; }
      canceled = true;
      res.end("{}");
    } else if (method === "GetTrajectoryFileDiffs" && scenario === "external") {
      res.end(JSON.stringify({ diffs: [{ uri: pathToFileURL(path.join(`${ws}-sibling`, "other.txt")).href }] }));
    } else { res.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const conn = { address: `127.0.0.1:${server.address().port}`, csrfToken: "mock" };
  const options = {
    write: true, prompt: "Write partial.txt and final.txt", timeoutMs: 180, pollIntervalMs: 5,
    onCheckpoint: (checkpoint) => { checkpoints[checkpoint.attempt - 1] = checkpoint; },
    invokeAgentApiFn: (_conn, args) => {
      calls.push(args);
      if (args[0] === "new-conversation") {
        phase = 1;
        fs.writeFileSync(path.join(ws, "partial.txt"), "partial work");
        return { response: { newConversation: { conversationId: "same-conversation" } } };
      }
      assert.equal(args[0], "send-message");
      assert.equal(args[1], "same-conversation");
      if (scenario !== "step_limit") assert.equal(canceled, true, "Previous executor must be stopped before continuation");
      canceled = false;
      phase += 1;
      fs.writeFileSync(path.join(ws, "final.txt"), "finished");
      return {};
    }
  };
  try { await check({ ws, conn, options, calls, checkpoints }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("desktop timeout checkpoints partial files, stops the executor and resumes the same conversation", async () => {
  await withDesktop("timeout", async ({ ws, conn, options, calls, checkpoints }) => {
    const result = await runDesktopTurn(conn, ws, options);
    assert.equal(jobStatus(result), "completed");
    assert.equal(result.resumeCount, 1);
    assert.equal(result.conversationId, "same-conversation");
    assert.deepEqual(calls.map((args) => args[0]), ["new-conversation", "send-message"]);
    assert.equal(checkpoints.length, 1);
    assert.match(checkpoints[0].reason, /timed out after/);
    assert.ok(checkpoints[0].fileVerification.some((file) => file.path.endsWith("partial.txt") && file.sha256?.length === 64));
    assert.deepEqual(result.touchedFiles.map((file) => path.basename(file)).sort(), ["final.txt", "partial.txt"]);
  });
});

test("an actual desktop step-limit error resumes; quota errors never auto-retry", async () => {
  await withDesktop("step_limit", async ({ ws, conn, options, checkpoints }) => {
    const result = await runDesktopTurn(conn, ws, options);
    assert.equal(result.exitStatus, 0);
    assert.equal(checkpoints.length, 1);
    assert.match(checkpoints[0].reason, /step limit 280/);
  });
  await withDesktop("quota", async ({ ws, conn, options, calls }) => {
    const result = await runDesktopTurn(conn, ws, options);
    assert.equal(jobStatus(result), "failed");
    assert.equal(result.failureKind, "quota");
    assert.match(result.errorMessage, /Resets in 135h/);
    assert.equal(calls.length, 1);
    assert.match(renderTurnResult(result), /FAILED/);
  });
});

test("timeouts stay interrupted with partial files if stopping is unsupported or resumes are disabled", async () => {
  for (const scenario of ["cannot_stop", "timeout"]) {
    await withDesktop(scenario, async ({ ws, conn, options, calls }) => {
      const result = await runDesktopTurn(conn, ws, { ...options, maxResumes: 0 });
      assert.equal(jobStatus(result), "interrupted");
      assert.equal(result.exitStatus, 124);
      assert.equal(calls.length, 1);
      assert.equal(result.remoteStopped, scenario !== "cannot_stop");
      assert.equal(result.checkpoints.length, 1);
      assert.equal(result.fileVerification[0].state, "present");
      assert.match(renderTurnResult(result), /INTERRUPTED/);
    });
  }
});

test("repeated timeouts honor the resume cap without creating more conversations", async () => {
  await withDesktop("repeat_timeout", async ({ ws, conn, options, calls }) => {
    const result = await runDesktopTurn(conn, ws, { ...options, maxResumes: 1 });
    assert.equal(result.exitStatus, 124);
    assert.equal(result.resumeCount, 1);
    assert.equal(result.checkpoints.length, 2);
    assert.equal(calls.length, 2);
  });
});

test("scope checks reject extra edits, read-only writes and a sibling directory sharing the workspace prefix", async () => {
  for (const scenario of ["success", "external"]) {
    await withDesktop(scenario, async ({ ws, conn, options, calls }) => {
      const result = await runDesktopTurn(conn, ws, { ...options, allowedPaths: ["final.txt"] });
      assert.equal(result.failureKind, "scope_violation");
      assert.equal(result.exitStatus, 1);
      assert.equal(calls.length, 1);
      assert.ok(result.scopeViolations.some((file) => file.endsWith("partial.txt")));
      if (scenario === "external") assert.ok(result.scopeViolations.some((file) => file.endsWith("other.txt")));
    });
  }
  await withDesktop("success", async ({ ws, conn, options }) => {
    const result = await runDesktopTurn(conn, ws, { ...options, write: false });
    assert.equal(result.failureKind, "scope_violation");
    assert.equal(result.fileVerification[0].state, "present");
  });
});

test("git snapshots detect unicode paths, same-size dirty edits and restoration of prior changes", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fingerprints-"));
  const git = (args) => {
    const res = spawnSync("git", args, { cwd: ws, windowsHide: true });
    assert.equal(res.status, 0, String(res.stderr));
  };
  try {
    git(["init"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    const file = path.join(ws, process.platform === "win32" ? "niño archivo.txt" : "niño -> archivo.txt");
    fs.writeFileSync(file, "base");
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    fs.writeFileSync(file, "aaaa");
    const before = snapshotWorkspaceFiles(ws);
    fs.writeFileSync(file, "bbbb");
    assert.deepEqual(diffWorkspaceSnapshots(before, snapshotWorkspaceFiles(ws)), [file]);
    fs.writeFileSync(file, "base");
    assert.deepEqual(diffWorkspaceSnapshots(before, snapshotWorkspaceFiles(ws)), [file]);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test("CLI quota failure survives a partial response and a successful shell exit, including background startup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-worker-"));
  const ws = path.join(root, "workspace");
  fs.mkdirSync(ws);
  const server = http.createServer((_req, res) => { res.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const script = path.join(root, "mock.mjs");
  fs.writeFileSync(script, [
    'console.log(JSON.stringify({event:"init", conversation_id:"quota-conversation"}));',
    'await new Promise(r => setTimeout(r, 150));',
    'console.log(JSON.stringify({event:"result", result:{status:"ERROR", response:"I started the work", error:{message:"Individual quota reached. Resets in 135h"}}}));'
  ].join("\n"));
  const bin = path.join(root, process.platform === "win32" ? "agy.cmd" : "agy");
  fs.writeFileSync(bin, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(root, "data"), AGY_CLI_PATH: bin,
    AGY_DISABLE_CLI_SCAN: "1", ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${server.address().port}`, ANTIGRAVITY_CSRF_TOKEN: "test" };
  const run = (...args) => exec(process.execPath, [companion, ...args, "--cwd", ws], { env, encoding: "utf8" });
  try {
    await assert.rejects(run("task", "--backend", "cli", "--json", "Quota test"), (err) => {
      const result = JSON.parse(err.stdout);
      assert.equal(err.code, 1);
      assert.equal(result.failureKind, "quota");
      assert.match(result.errorMessage, /Resets in 135h/);
      assert.equal(result.rawOutput, "I started the work");
      return true;
    });
    const launch = JSON.parse((await run("task", "--background", "--backend", "cli", "--json", "Background quota test")).stdout);
    assert.equal(launch.launchAcknowledged, true);
    assert.ok(launch.startedAt);
    await assert.rejects(run("status", launch.jobId, "--wait", "--json"), (err) => {
      const job = JSON.parse(err.stdout);
      assert.equal(job.status, "failed");
      assert.equal(job.failureKind, "quota");
      assert.match(job.summary, /Resets in 135h/);
      assert.equal(job.pid, null);
      const log = fs.readFileSync(job.logFile, "utf8");
      assert.match(log, /Starting background worker/);
      assert.match(log, /Finished job \(failed\): exitStatus=1/);
      return true;
    });
    assert.match((await run("status")).stdout, /Individual quota reached\. Resets in 135h/);
    assert.match((await run("result", launch.jobId)).stdout, /FAILED/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("transfer output preserves a failure even when a conversation was created", () => {
  const rendered = renderTransferResult({ status: 124, jobStatus: "interrupted", conversationId: "real-id",
    backend: "desktop-live", errorMessage: "Timeout", touchedFiles: ["partial.txt"] });
  assert.match(rendered, /Transfer Failed/);
  assert.match(rendered, /interrupted/);
  assert.match(rendered, /partial.txt/);
  assert.doesNotMatch(rendered, /No Antigravity conversation was created/);
});

test("status reconciles a dead worker and shows diagnostics from older failed records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lost-worker-"));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: root };
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = root;
  try {
    for (const job of [
      { id: "dead", status: "running", pid: 2147483647, startedAt: new Date().toISOString(), summary: "Original task" },
      { id: "never-started", status: "queued", queuedAt: "2020-01-01T00:00:00Z", summary: "Queued task" },
      { id: "legacy", status: "failed", summary: "Old task", result: { rawOutput: "Individual quota reached. Resets in 113h" } }
    ]) { writeJobFile(root, job.id, job); upsertJob(root, job); }
    const { stdout } = await exec(process.execPath, [companion, "status", "--cwd", root], { env, encoding: "utf8" });
    assert.match(stdout, /Worker exited without recording a terminal job state/);
    assert.match(stdout, /Worker never acknowledged startup/);
    assert.match(stdout, /Resets in 113h/);
    const { stdout: detail } = await exec(process.execPath, [companion, "status", "dead", "--cwd", root, "--json"], { env, encoding: "utf8" });
    assert.equal(JSON.parse(detail).status, "failed");
    assert.equal(JSON.parse(detail).failureKind, "worker_lost");
    assert.ok(JSON.parse(detail).completedAt);
    await assert.rejects(exec(process.execPath, [companion, "status", "legacy", "--wait", "--cwd", root], { env }),
      (err) => err.code === 1);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
