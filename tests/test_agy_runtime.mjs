import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildCliTurnArgs,
  ensureDesktopProjectId,
  extractCliStreamEvent,
  extractTurnDataFromSteps,
  normalizeCliModelArgs,
  normalizeDesktopModelTier,
  normalizeUriPathForCompare,
  runCliTurn,
  runDesktopTurn
} from "../plugins/agy/scripts/lib/agy-runtime.mjs";
import { renderTransferResult } from "../plugins/agy/scripts/lib/render.mjs";

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

test("ensureDesktopProjectId matches gitFolder.folderUri and creates new projects with a non-empty UUID id", async () => {
  const gitWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-proj-"));
  const freshWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fresh-proj-"));
  fs.mkdirSync(path.join(freshWs, ".git"));
  const gitWsUri = pathToFileURL(gitWs).href;
  let capturedCreatePayload = null;

  const server = http.createServer((req, res) => {
    const method = req.url?.split("/").pop();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (method === "ListProjects") {
        res.end(JSON.stringify({ projectIds: ["git-proj-999", "default-cli-project"] }));
        return;
      }
      if (method === "ReadProjects") {
        res.end(
          JSON.stringify({
            projects: [
              {
                id: "git-proj-999",
                name: "Nexo Reels",
                projectResources: {
                  resources: [{ gitFolder: { folderUri: gitWsUri, allowWrite: true } }]
                }
              }
            ]
          })
        );
        return;
      }
      if (method === "CreateProject") {
        capturedCreatePayload = JSON.parse(body);
        if (!capturedCreatePayload?.project?.id) {
          res.writeHead(409);
          res.end(JSON.stringify({ code: "already_exists", message: 'project with id "" already exists' }));
          return;
        }
        // Real Antigravity 2.0 returns `{}` on HTTP 200
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const conn = { address: `127.0.0.1:${port}`, csrfToken: "tok" };

  try {
    const matchedGitId = await ensureDesktopProjectId(conn, gitWs);
    assert.equal(matchedGitId, "git-proj-999");

    const createdId = await ensureDesktopProjectId(conn, freshWs);
    assert.ok(createdId && createdId.length >= 32, "Expected non-empty UUID from CreateProject");
    assert.equal(createdId, capturedCreatePayload.project.id);
    assert.ok(capturedCreatePayload.project.projectResources.resources[0].gitFolder?.folderUri);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(gitWs, { recursive: true, force: true });
    fs.rmSync(freshWs, { recursive: true, force: true });
  }
});

test("buildCliTurnArgs, normalizeCliModelArgs, runCliTurn, and renderTransferResult handle agy v1.4+ flags and stream-json", async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cli-turn-"));
  try {
    // 1. Verify `--print=...` is attached LAST and `--model pro` is never sent to `agy` CLI
    assert.deepEqual(normalizeCliModelArgs("pro"), []);
    assert.deepEqual(normalizeCliModelArgs("flash"), ["--effort", "medium"]);
    assert.deepEqual(normalizeCliModelArgs("flash_lite"), ["--effort", "low"]);
    assert.deepEqual(normalizeCliModelArgs("gemini-4-argon-high"), ["--model", "gemini-4-argon-high"]);

    const cliArgs = buildCliTurnArgs(tmpWs, {
      prompt: "Execute next step",
      model: "pro",
      write: true,
      resumeConversationId: "conv-123"
    });
    assert.equal(cliArgs[0], "--output-format");
    assert.equal(cliArgs[1], "stream-json");
    assert.equal(cliArgs.includes("--model"), false);
    assert.equal(cliArgs[cliArgs.length - 1], "--print=Execute next step");

    // 2. Verify real `agy` v1.4.7 NDJSON stream-json event extraction
    const initEv = extractCliStreamEvent({ event: "init", conversation_id: "cid-real-1" });
    assert.equal(initEv.conversationId, "cid-real-1");

    const stepEv = extractCliStreamEvent({
      event: "step_update",
      step_update: { conversation_id: "cid-real-1", step_type: "agent_response", text_delta: "PONG" }
    });
    assert.equal(stepEv.streamedDelta, "PONG");

    const resultEv = extractCliStreamEvent({
      event: "result",
      result: { conversation_id: "cid-real-1", status: "SUCCESS", response: "PONG\n" }
    });
    assert.equal(resultEv.finalResponse, "PONG\n");

    // 3. Verify `runCliTurn` end-to-end against a mock `agy` executable validating `--print=...` flag syntax
    const mockAgyScript = path.join(tmpWs, "mock-agy.mjs");
    fs.writeFileSync(
      mockAgyScript,
      [
        'const args = process.argv.slice(2);',
        'const printArg = args.find((a) => a.startsWith("--print="));',
        'if (!printArg || args[0] === "--print") {',
        '  process.stderr.write("Error: --print took \\"--output-format\\" as its prompt\\n");',
        '  process.exit(2);',
        '}',
        'if (args.includes("pro") && args[args.indexOf("pro") - 1] === "--model") {',
        '  process.stderr.write("error: model pro is not recognized\\n");',
        '  process.exit(1);',
        '}',
        'console.log(JSON.stringify({ event: "init", conversation_id: "cli-conv-777" }));',
        'console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: "cli-conv-777", step_type: "agent_response", text_delta: "Done!" } }));',
        'console.log(JSON.stringify({ event: "result", result: { conversation_id: "cli-conv-777", status: "SUCCESS", response: "Done via CLI!" } }));'
      ].join("\n"),
      "utf8"
    );

    // Wrap via node on POSIX/Windows using a tiny wrapper or direct node test:
    const wrapperPath =
      process.platform === "win32" ? path.join(tmpWs, "mock-agy.cmd") : path.join(tmpWs, "mock-agy.sh");
    if (process.platform === "win32") {
      fs.writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${mockAgyScript}" %*\r\n`, "utf8");
    } else {
      fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${mockAgyScript}" "$@"\n`, "utf8");
      fs.chmodSync(wrapperPath, 0o755);
    }

    const cliTurn = await runCliTurn({ path: wrapperPath }, tmpWs, {
      prompt: "Transfer & run next step",
      model: "pro",
      write: true
    });
    assert.equal(cliTurn.exitStatus, 0);
    assert.equal(cliTurn.conversationId, "cli-conv-777");
    assert.equal(cliTurn.finalMessage, "Done via CLI!");

    // 4. Verify failed transfers never render fake success or `null` commands
    const failedRendered = renderTransferResult({
      status: 2,
      backend: "cli-headless",
      conversationId: null,
      handoffPath: "/tmp/handoff.md",
      finalMessage: "Error: CLI failed"
    });
    assert.match(failedRendered, /Google Antigravity Transfer Failed/);
    assert.equal(failedRendered.includes("agy --conversation null"), false);
    assert.equal(failedRendered.includes("/agy:pull null"), false);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
