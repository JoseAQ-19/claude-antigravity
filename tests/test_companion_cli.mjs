import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMPANION = path.resolve("plugins/agy/scripts/agy-companion.mjs");
const LIFECYCLE_HOOK = path.resolve("plugins/agy/scripts/session-lifecycle-hook.mjs");

test("agy-companion setup --json reports ready state and toggles review gate hermetically", async () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-test-"));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const mockEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: tmpData,
    ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
    ANTIGRAVITY_CSRF_TOKEN: "mock-csrf-setup",
    AGY_DISABLE_CLI_SCAN: "1"
  };

  try {
    const { stdout } = await execFileAsync(process.execPath, [COMPANION, "setup", "--enable-review-gate", "--json"], {
      encoding: "utf8",
      env: mockEnv
    });
    const payload = JSON.parse(stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.activeBackend, "desktop-live");
    assert.equal(payload.reviewGateEnabled, true);

    const { stdout: statusStdout } = await execFileAsync(process.execPath, [COMPANION, "status"], {
      encoding: "utf8",
      env: mockEnv
    });
    assert.match(statusStdout, /No Antigravity jobs recorded/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test("session-lifecycle-hook SessionStart writes AGY_COMPANION_* exports to CLAUDE_ENV_FILE", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hook-test-"));
  const envFile = path.join(tmpDir, "session-env.sh");
  const sampleTranscriptPath = path.join(tmpDir, "projects", "demo", "sess-999.jsonl");
  try {
    const hookInput = JSON.stringify({
      session_id: "sess-999",
      transcript_path: sampleTranscriptPath
    });
    const res = spawnSync(process.execPath, [LIFECYCLE_HOOK, "SessionStart"], {
      input: hookInput,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: tmpDir }
    });
    assert.equal(res.status, 0, res.stderr);
    const content = fs.readFileSync(envFile, "utf8");
    assert.match(content, /export AGY_COMPANION_SESSION_ID='sess-999'/);
    assert.ok(content.includes("AGY_COMPANION_TRANSCRIPT_PATH="));
    assert.ok(content.includes("sess-999.jsonl"));

    // Run SessionStart a second time (simulating resume/compaction) and verify no duplicate lines are appended
    spawnSync(process.execPath, [LIFECYCLE_HOOK, "SessionStart"], {
      input: hookInput,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: tmpDir }
    });
    const secondContent = fs.readFileSync(envFile, "utf8");
    assert.equal(secondContent, content, "CLAUDE_ENV_FILE exports must be deduplicated across resumes");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agy-companion subcommands handle --help/-h without creating jobs and reject unsupported --model per backend", async () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "agy-help-model-"));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const mockEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: tmpData,
    ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
    ANTIGRAVITY_CSRF_TOKEN: "mock-csrf",
    AGY_DISABLE_CLI_SCAN: "1"
  };

  try {
    // 1. `task --help` and `task "--background --help"` print usage and create ZERO jobs
    const helpRes = spawnSync(process.execPath, [COMPANION, "task", "--help"], {
      encoding: "utf8",
      env: mockEnv
    });
    assert.equal(helpRes.status, 0, helpRes.stderr);
    assert.match(helpRes.stdout, /Usage: node scripts\/agy-companion\.mjs task/);
    assert.match(helpRes.stdout, /Canonical Model Tiers/);

    const singleArgHelp = spawnSync(process.execPath, [COMPANION, "transfer", "--background -h"], {
      encoding: "utf8",
      env: mockEnv
    });
    assert.equal(singleArgHelp.status, 0, singleArgHelp.stderr);
    assert.match(singleArgHelp.stdout, /Usage: node scripts\/agy-companion\.mjs transfer/);

    // Confirm zero jobs were created by --help
    const statusAfterHelp = spawnSync(process.execPath, [COMPANION, "status", "--json"], {
      encoding: "utf8",
      env: mockEnv
    });
    const statusJson = JSON.parse(statusAfterHelp.stdout);
    assert.equal(statusJson.jobs.length, 0, "--help must NEVER create a job record");

    // 2. Concrete CLI model ID passed to desktop-live fails immediately BEFORE creating any job
    const badModelRes = spawnSync(
      process.execPath,
      [COMPANION, "task", "--background", "--model", "gemini-4-argon-high", "Write a file"],
      { encoding: "utf8", env: mockEnv }
    );
    assert.notEqual(badModelRes.status, 0);
    assert.match(badModelRes.stderr, /Unsupported --model "gemini-4-argon-high" for backend "desktop-live"/);
    assert.match(badModelRes.stderr, /--backend cli/);

    const statusAfterBadModel = spawnSync(process.execPath, [COMPANION, "status", "--json"], {
      encoding: "utf8",
      env: mockEnv
    });
    assert.equal(JSON.parse(statusAfterBadModel.stdout).jobs.length, 0, "Rejected --model must not enqueue a job");

    // 3. Execute a real cli-headless job via mock agy binary and verify job state = "completed" + exitStatus=0 in log
    const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mock-bin-"));
    const mockScript = path.join(mockBinDir, "mock-agy.mjs");
    fs.writeFileSync(
      mockScript,
      [
        'console.log(JSON.stringify({ event: "init", conversation_id: "conv-job-ok-1" }));',
        'console.log(JSON.stringify({ event: "result", result: { conversation_id: "conv-job-ok-1", status: "SUCCESS", response: "" } }));'
      ].join("\n"),
      "utf8"
    );
    const mockBin =
      process.platform === "win32" ? path.join(mockBinDir, "agy.cmd") : path.join(mockBinDir, "agy");
    if (process.platform === "win32") {
      fs.writeFileSync(mockBin, `@echo off\r\n"${process.execPath}" "${mockScript}" %*\r\n`, "utf8");
    } else {
      fs.writeFileSync(mockBin, `#!/bin/sh\nexec "${process.execPath}" "${mockScript}" "$@"\n`, "utf8");
      fs.chmodSync(mockBin, 0o755);
    }

    const cliJobEnv = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: tmpData,
      AGY_CLI_PATH: mockBin
    };
    const jobRes = spawnSync(
      process.execPath,
      [COMPANION, "task", "--backend", "cli", "--model", "flash", "--json", "Run empty-text test"],
      { encoding: "utf8", env: cliJobEnv }
    );
    assert.equal(jobRes.status, 0, jobRes.stderr);
    const allJobsRes = spawnSync(process.execPath, [COMPANION, "status", "--json"], {
      encoding: "utf8",
      env: cliJobEnv
    });
    const jobsList = JSON.parse(allJobsRes.stdout).jobs;
    assert.equal(jobsList.length, 1);
    assert.equal(jobsList[0].status, "completed");
    assert.equal(jobsList[0].exitStatus, 0);

    const detailRes = spawnSync(process.execPath, [COMPANION, "status", jobsList[0].id], {
      encoding: "utf8",
      env: cliJobEnv
    });
    assert.match(detailRes.stdout, /Exit Code:\*\* `0`/);
    assert.match(detailRes.stdout, /Finished job \(completed\): exitStatus=0/);

    fs.rmSync(mockBinDir, { recursive: true, force: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});
