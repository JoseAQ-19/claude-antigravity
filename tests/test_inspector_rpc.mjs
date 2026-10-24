import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  forkAntigravityConversation,
  getQuotaHud,
  pullFromAntigravity,
  renderProgressBar,
  undoAntigravityTurn
} from "../plugins/agy/scripts/lib/agy-inspector.mjs";

test("pullFromAntigravity, getQuotaHud, forkAntigravityConversation, and undoAntigravityTurn work end-to-end against mock Connect RPC", async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-inspector-ws-"));
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "agy-inspector-data-"));
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmpData;

  const wsUri = pathToFileURL(tmpWs).href;
  const touchedUri = pathToFileURL(path.join(tmpWs, "src", "navbar.tsx")).href;
  let revertCalled = false;

  const server = http.createServer((req, res) => {
    const method = req.url?.split("/").pop();
    res.setHeader("Content-Type", "application/json");

    if (method === "Heartbeat") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (method === "GetAllCascadeTrajectories") {
      res.end(
        JSON.stringify({
          trajectorySummaries: {
            "conv-live-777": {
              stepCount: 4,
              status: "CASCADE_RUN_STATUS_IDLE",
              lastModifiedTime: "2026-10-24T22:00:00Z",
              workspaces: [{ workspaceFolderAbsoluteUri: wsUri }]
            }
          }
        })
      );
      return;
    }
    if (method === "GetCascadeTrajectory") {
      res.end(
        JSON.stringify({
          trajectory: {
            steps: [
              {
                type: "CORTEX_STEP_TYPE_USER_INPUT",
                status: "CORTEX_STEP_STATUS_DONE",
                userInput: { userResponse: "Design the responsive navbar in Antigravity." }
              },
              {
                type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
                status: "CORTEX_STEP_STATUS_DONE",
                plannerResponse: {
                  response: "Created `src/navbar.tsx` with responsive mobile drawer.",
                  toolCalls: [{ name: "write_file" }]
                }
              }
            ]
          }
        })
      );
      return;
    }
    if (method === "GetTrajectoryFileDiffs") {
      res.end(JSON.stringify({ diffs: [{ uri: touchedUri }] }));
      return;
    }
    if (method === "GetUserStatus") {
      res.end(
        JSON.stringify({
          userStatus: {
            email: "private-user@example.com",
            planStatus: { planInfo: { planName: "Pro", teamsTier: "TEAMS_TIER_PRO" } }
          }
        })
      );
      return;
    }
    if (method === "GetCascadeModelConfigData") {
      res.end(
        JSON.stringify({
          clientModelConfigs: [
            {
              label: "Gemini 4 Argon (High)",
              supportsImages: true,
              isRecommended: true,
              quotaInfo: { remainingFraction: 0.75, resetTime: "2026-10-25T10:00:00Z" }
            }
          ]
        })
      );
      return;
    }
    if (method === "ForkConversation") {
      res.end(JSON.stringify({ newCascadeId: "conv-forked-888", forkedAtStepIndex: 1 }));
      return;
    }
    if (method === "SmartFocusConversation") {
      res.end(JSON.stringify({}));
      return;
    }
    if (method === "GetRevertPreview") {
      res.end(JSON.stringify({ codeEdits: [{ uri: touchedUri }] }));
      return;
    }
    if (method === "RevertToCascadeStep") {
      revertCalled = true;
      res.end(JSON.stringify({}));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const discoveryOptions = {
    env: {
      ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
      ANTIGRAVITY_CSRF_TOKEN: "tok-inspector"
    }
  };

  try {
    assert.equal(renderProgressBar(0.5, 10), "█████░░░░░");

    // 1. /agy:pull live RPC
    const pulled = await pullFromAntigravity(tmpWs, { discoveryOptions });
    assert.equal(pulled.backend, "desktop-live");
    assert.equal(pulled.conversationId, "conv-live-777");
    assert.match(pulled.excerpt, /responsive mobile drawer/);
    assert.equal(pulled.touchedFiles.length, 1);
    assert.equal(fs.existsSync(pulled.archivePath), true);

    // 2. /agy:quota privacy redaction by default vs --show-account
    const hudDefault = await getQuotaHud(tmpWs, {
      discoveryOptions,
      nowMs: Date.parse("2026-10-25T08:00:00Z")
    });
    assert.equal(hudDefault.available, true);
    assert.equal(hudDefault.planName, "Pro");
    assert.equal(hudDefault.accountLabel, null, "Email must be hidden by default for safe screenshots");
    assert.equal(hudDefault.models[0].remainingPct, 75);
    assert.equal(hudDefault.models[0].resetIn, "2h");

    const hudWithAccount = await getQuotaHud(tmpWs, { discoveryOptions, showAccount: true });
    assert.equal(hudWithAccount.accountLabel, "private-user@example.com");

    // 3. /agy:fork
    const forked = await forkAntigravityConversation(tmpWs, { discoveryOptions });
    assert.equal(forked.sourceConversationId, "conv-live-777");
    assert.equal(forked.newConversationId, "conv-forked-888");

    // 4. /agy:undo dry-run preview then --apply
    const preview = await undoAntigravityTurn(tmpWs, { discoveryOptions, apply: false });
    assert.equal(preview.applied, false);
    assert.equal(preview.previewEditsCount, 1);
    assert.equal(revertCalled, false);

    const applied = await undoAntigravityTurn(tmpWs, { discoveryOptions, apply: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.revertedViaRpc, true);
    assert.equal(revertCalled, true);
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevData;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test("pullFromAntigravity falls back cleanly to offline ~/.gemini/antigravity/brain transcript.jsonl when Desktop is closed", async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-offline-pull-ws-"));
  const tmpBrain = fs.mkdtempSync(path.join(os.tmpdir(), "agy-offline-brain-"));
  const convDir = path.join(tmpBrain, "conv-offline-999", ".system_generated", "logs");
  fs.mkdirSync(convDir, { recursive: true });
  fs.writeFileSync(
    path.join(convDir, "transcript.jsonl"),
    [
      JSON.stringify({ type: "USER_INPUT", content: "Offline prompt in Antigravity" }),
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "Offline response ready for Claude." })
    ].join("\n") + "\n",
    "utf8"
  );

  try {
    const pulled = await pullFromAntigravity(tmpWs, {
      discoveryOptions: { env: {}, mockCandidates: [] },
      brainRoots: [tmpBrain]
    });
    assert.equal(pulled.backend, "brain-offline");
    assert.equal(pulled.conversationId, "conv-offline-999");
    assert.match(pulled.excerpt, /Offline response ready for Claude/);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});
