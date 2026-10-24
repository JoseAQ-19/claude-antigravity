import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureDesktopProjectId,
  extractTurnDataFromSteps,
  normalizeDesktopModelTier,
  normalizeUriPathForCompare,
  runDesktopTurn
} from "../plugins/agy/scripts/lib/agy-runtime.mjs";

test("normalizeUriPathForCompare normalizes encoded URIs, Windows paths, and macOS /private symlinks", () => {
  assert.equal(
    normalizeUriPathForCompare("file:///c%3A/Projects/my%20workspace", "win32"),
    normalizeUriPathForCompare("C:\\Projects\\my workspace\\", "win32")
  );
  assert.equal(
    normalizeUriPathForCompare("file:///private/tmp/my%20workspace/", "darwin"),
    normalizeUriPathForCompare("/tmp/my workspace", "darwin")
  );
  assert.equal(
    normalizeUriPathForCompare("file:///Users/dev/project", "darwin"),
    "/Users/dev/project"
  );
});

test("normalizeDesktopModelTier maps aliases accurately", () => {
  assert.equal(normalizeDesktopModelTier("flash"), "flash");
  assert.equal(normalizeDesktopModelTier("lite"), "flash_lite");
  assert.equal(normalizeDesktopModelTier(null, "pro"), "pro");
});

test("extractTurnDataFromSteps extracts final response and detects active steps", () => {
  const steps = [
    { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" },
    {
      type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      status: "CORTEX_STEP_STATUS_DONE",
      plannerResponse: {
        thinking: "Checking codebase structure\nMore details",
        toolCalls: [{ id: "1", name: "read_file" }]
      }
    },
    {
      type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      status: "CORTEX_STEP_STATUS_DONE",
      plannerResponse: {
        thinking: "Formulating final answer",
        modifiedResponse: "Fixed the bug in `auth.ts`."
      }
    }
  ];
  const out = extractTurnDataFromSteps(steps, 0);
  assert.equal(out.hasActiveSteps, false);
  assert.equal(out.hasPlannerResponse, true);
  assert.equal(out.finalMessage, "Fixed the bug in `auth.ts`.");
  assert.equal(out.reasoningSummary.length, 2);
});

test("ensureDesktopProjectId and runDesktopTurn execute against mock Connect RPC server and degrade gracefully on 404 RPCs", async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-runtime-ws-"));
  const wsUri = pathToFileURL(tmpWs).href;
  const editedFileUri = pathToFileURL(path.join(tmpWs, "src", "feature.js")).href;
  let simulateUnsupportedTrajectory = false;

  const server = http.createServer((req, res) => {
    const method = req.url?.split("/").pop();
    res.setHeader("Content-Type", "application/json");

    if (method === "ListProjects") {
      res.end(JSON.stringify({ projectIds: ["proj-mock-001"] }));
      return;
    }
    if (method === "ReadProjects") {
      res.end(
        JSON.stringify({
          projects: [
            {
              id: "proj-mock-001",
              projectResources: { resources: [{ folderUri: wsUri }] }
            }
          ]
        })
      );
      return;
    }
    if (method === "GetCascadeTrajectory") {
      if (simulateUnsupportedTrajectory) {
        res.writeHead(404);
        res.end(JSON.stringify({ code: "unimplemented", message: "unknown method" }));
        return;
      }
      res.end(
        JSON.stringify({
          trajectory: {
            steps: [
              { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" },
              {
                type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
                status: "CORTEX_STEP_STATUS_DONE",
                plannerResponse: {
                  thinking: "Implementing requested change",
                  response: "Implemented `src/feature.js` cleanly."
                }
              }
            ]
          }
        })
      );
      return;
    }
    if (method === "WaitForConversationFullyIdle" || method === "SmartFocusConversation") {
      res.end(JSON.stringify({}));
      return;
    }
    if (method === "GetTrajectoryFileDiffs") {
      res.end(JSON.stringify({ diffs: [{ uri: editedFileUri }] }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const conn = { address: `localhost:${port}`, csrfToken: "tok-test", exePath: null };

  try {
    const projectId = await ensureDesktopProjectId(conn, tmpWs);
    assert.equal(projectId, "proj-mock-001");

    const normalRes = await runDesktopTurn(conn, tmpWs, {
      prompt: "Implement feature.js",
      focusUi: true,
      pollIntervalMs: 10,
      invokeAgentApiFn: () => ({ response: { newConversation: { conversationId: "conv-mock-100" } } })
    });
    assert.equal(normalRes.exitStatus, 0);
    assert.equal(normalRes.conversationId, "conv-mock-100");
    assert.match(normalRes.finalMessage, /Implemented `src\/feature\.js`/);
    assert.equal(normalRes.touchedFiles.length, 1);

    // Verify graceful fallback when a future Antigravity build returns 404 on internal trajectory RPC
    simulateUnsupportedTrajectory = true;
    const degradedRes = await runDesktopTurn(conn, tmpWs, {
      prompt: "Run under future Desktop build",
      pollIntervalMs: 10,
      invokeAgentApiFn: (_c, args) => {
        if (args[0] === "get-conversation-metadata") {
          return { response: { title: "Future Build Thread" } };
        }
        return { response: { newConversation: { conversationId: "conv-mock-200" } } };
      }
    });
    assert.equal(degradedRes.exitStatus, 0);
    assert.equal(degradedRes.conversationId, "conv-mock-200");
    assert.match(degradedRes.finalMessage, /Future Build Thread/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
