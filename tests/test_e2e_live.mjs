import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectRpcPost, discoverLanguageServer } from "../plugins/agy/scripts/lib/ls-discovery.mjs";

const COMPANION = path.resolve("plugins/agy/scripts/agy-companion.mjs");

test("LIVE E2E: /agy:transfer executes next step on real Antigravity 2.0 and /agy:rescue --resume continues it", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-live-"));
  const tmpData = path.join(tmpRoot, "plugin-data");
  const jsonlPath = path.join(tmpRoot, "claude-session-e2e.jsonl");

  // Strip ANTIGRAVITY_* env vars to simulate running inside a completely external Claude Code terminal!
  const externalEnv = { ...process.env, CLAUDE_PLUGIN_DATA: tmpData };
  delete externalEnv.ANTIGRAVITY_LS_ADDRESS;
  delete externalEnv.ANTIGRAVITY_CSRF_TOKEN;
  delete externalEnv.ANTIGRAVITY_CONVERSATION_ID;
  delete externalEnv.ANTIGRAVITY_PROJECT_ID;
  delete externalEnv.ANTIGRAVITY_AGENTAPI_EXE;

  let createdConversationId = null;

  try {
    const sampleTranscript = [
      JSON.stringify({
        type: "user",
        cwd: process.cwd(),
        gitBranch: "main",
        sessionId: "claude-session-e2e",
        message: {
          role: "user",
          content: "We are testing secret codeword ALPHA-742. In step 1 you acknowledged it. In step 2 (the next step), reply ONLY with DONE-ALPHA-742 without touching any files."
        }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_e2e_1",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Step 1 complete: I acknowledged secret codeword ALPHA-742. Pending next step: reply with DONE-ALPHA-742 without editing files."
            }
          ]
        }
      })
    ].join("\n") + "\n";

    fs.writeFileSync(jsonlPath, sampleTranscript, "utf8");

    // 1. Run real transfer (auto-discovers LS, creates conversation, executes next step!)
    const transferRes = spawnSync(
      process.execPath,
      [
        COMPANION,
        "transfer",
        "--source",
        jsonlPath,
        "--no-focus",
        "--model",
        "flash_lite",
        "--json",
        "Do not call any write tools; reply in one short line containing DONE-ALPHA-742."
      ],
      {
        cwd: process.cwd(),
        env: externalEnv,
        encoding: "utf8",
        timeout: 120000
      }
    );

    assert.equal(transferRes.status, 0, `transfer stderr: ${transferRes.stderr}`);
    const transferPayload = JSON.parse(transferRes.stdout);
    createdConversationId = transferPayload.conversationId;
    assert.ok(createdConversationId, "Expected a real Antigravity conversationId");
    assert.equal(transferPayload.backend, "desktop-live");
    assert.match(transferPayload.finalMessage, /ALPHA-742/i);

    // 2. Run follow-up --resume on that exact transferred conversation!
    const resumeRes = spawnSync(
      process.execPath,
      [
        COMPANION,
        "task",
        "--resume",
        "--model",
        "flash_lite",
        "--json",
        "What was the secret codeword from our transferred Claude session? Reply in one short line without calling tools."
      ],
      {
        cwd: process.cwd(),
        env: externalEnv,
        encoding: "utf8",
        timeout: 120000
      }
    );

    assert.equal(resumeRes.status, 0, `resume stderr: ${resumeRes.stderr}`);
    const resumePayload = JSON.parse(resumeRes.stdout);
    assert.equal(resumePayload.conversationId, createdConversationId);
    assert.match(resumePayload.rawOutput, /ALPHA-742/i);
  } finally {
    // Clean up temporary test conversation from Antigravity Desktop + local .claude/agy-handoffs
    if (createdConversationId) {
      const ls = await discoverLanguageServer();
      if (ls.available) {
        await connectRpcPost(ls.address, "DeleteCascadeTrajectory", { cascadeId: createdConversationId }, ls.csrfToken, 5000).catch(() => {});
      }
    }
    const wsHandoff = path.join(process.cwd(), ".claude", "agy-handoffs");
    if (fs.existsSync(wsHandoff)) {
      fs.rmSync(wsHandoff, { recursive: true, force: true });
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
