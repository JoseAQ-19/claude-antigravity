import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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
    ANTIGRAVITY_LS_ADDRESS: `localhost:${port}`,
    ANTIGRAVITY_CSRF_TOKEN: "mock-csrf-setup",
    AGY_DISABLE_CLI_SCAN: "1"
  };

  try {
    const res = spawnSync(process.execPath, [COMPANION, "setup", "--enable-review-gate", "--json"], {
      encoding: "utf8",
      env: mockEnv
    });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ready, true);
    assert.equal(payload.activeBackend, "desktop-live");
    assert.equal(payload.reviewGateEnabled, true);

    const statusRes = spawnSync(process.execPath, [COMPANION, "status"], {
      encoding: "utf8",
      env: mockEnv
    });
    assert.equal(statusRes.status, 0);
    assert.match(statusRes.stdout, /No Antigravity jobs recorded/);
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
