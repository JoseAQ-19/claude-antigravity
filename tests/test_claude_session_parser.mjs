import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTransferHandoffBundle,
  parseClaudeTranscript,
  resolveClaudeTranscriptPath
} from "../plugins/agy/scripts/lib/claude-session-parser.mjs";

test("parseClaudeTranscript and buildTransferHandoffBundle extract turns, touched files, and next-step directive", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-parser-"));
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmpDir, "data");
  try {
    const projectsDir = path.join(tmpDir, "projects", "C--repo-demo");
    fs.mkdirSync(projectsDir, { recursive: true });
    const jsonlPath = path.join(projectsDir, "sess-abc-123.jsonl");
    const sampleLines = [
      JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: "sess-abc-123" }),
      JSON.stringify({
        type: "user",
        cwd: "C:\\repo\\demo",
        gitBranch: "feat/login",
        sessionId: "sess-abc-123",
        message: { role: "user", content: "Create auth.js and add unit tests for login." }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let's write auth.js first." },
            { type: "text", text: "I created `auth.js`. Next I need to write `test_auth.js`." },
            { type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "C:\\repo\\demo\\auth.js" } }
          ]
        }
      }),
      // Tool result disguised as user message should be ignored as human text
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "File created" }] }
      }),
      // Self-invocation of /agy:transfer should be stripped automatically
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "/agy:transfer" }
      })
    ];
    fs.writeFileSync(jsonlPath, sampleLines.join("\n") + "\n", "utf8");

    const resolved = resolveClaudeTranscriptPath("C:\\repo\\demo", { claudeProjectsDir: path.join(tmpDir, "projects") });
    assert.equal(resolved, jsonlPath);

    const parsed = parseClaudeTranscript(jsonlPath);
    assert.equal(parsed.sessionId, "sess-abc-123");
    assert.equal(parsed.gitBranch, "feat/login");
    assert.equal(parsed.turns.length, 2);
    assert.deepEqual(parsed.touchedFiles, ["C:\\repo\\demo\\auth.js"]);

    const bundle = buildTransferHandoffBundle(jsonlPath, tmpDir, { executeNextStep: true });
    assert.equal(fs.existsSync(bundle.handoffPath), true);
    assert.match(bundle.prompt, /Execute Next Step Immediately/);
    assert.match(bundle.prompt, /Create auth\.js and add unit tests for login/);
    assert.doesNotMatch(bundle.prompt, /\/agy:transfer/);
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevData;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
