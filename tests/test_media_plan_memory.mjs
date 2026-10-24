import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildMediaAnalysisBundle,
  buildPlanReviewBundle,
  classifyMediaFile,
  syncAgentMemory
} from "../plugins/agy/scripts/lib/media-plan-memory.mjs";

test("buildMediaAnalysisBundle validates video/audio/image files and builds Gemini multimodal prompt", () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-media-ws-"));
  try {
    assert.equal(classifyMediaFile("bug.mp4"), "video");
    assert.equal(classifyMediaFile("meeting.mp3"), "audio");
    assert.equal(classifyMediaFile("spec.pdf"), "document");

    const videoFile = path.join(tmpWs, "modal-flicker.mp4");
    fs.writeFileSync(videoFile, Buffer.alloc(1024));

    const bundle = buildMediaAnalysisBundle(tmpWs, [videoFile, "Why", "does", "the", "modal", "flicker?"]);
    assert.equal(bundle.mediaFiles.length, 1);
    assert.equal(bundle.mediaFiles[0].kind, "video");
    assert.equal(bundle.focusQuestion, "Why does the modal flicker?");
    assert.match(bundle.prompt, /read_file/);
    assert.match(bundle.prompt, /modal-flicker\.mp4/);
    assert.ok(bundle.fullReportPath.endsWith(".md"));
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test("buildPlanReviewBundle discovers workspace PLAN.md or explicit plan file", () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plan-ws-"));
  try {
    fs.writeFileSync(path.join(tmpWs, "PLAN.md"), "# Migration Plan\n1. Move auth to JWT\n", "utf8");
    const bundle = buildPlanReviewBundle(
      tmpWs,
      "# Rubric\nCheck YAGNI.",
      { preferClaudePlansDir: false, focus: "Check token revocation" }
    );
    assert.equal(bundle.target.sourceType, "workspace-doc");
    assert.match(bundle.prompt, /Move auth to JWT/);
    assert.match(bundle.prompt, /Check token revocation/);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

test("syncAgentMemory performs safe dry-run and non-destructive bidirectional sync with always_on rule and .bak backup", () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-memsync-ws-"));
  try {
    fs.writeFileSync(path.join(tmpWs, "CLAUDE.md"), "# Claude Rules\n- Always run npm test.\n", "utf8");
    fs.writeFileSync(path.join(tmpWs, "AGENTS.md"), "# Existing Agents Header\n- Keep zero dependencies.\n", "utf8");

    const dry = syncAgentMemory(tmpWs, { apply: false });
    assert.equal(dry.applied, false);
    assert.equal(dry.actions.length, 2);
    assert.equal(fs.existsSync(path.join(tmpWs, ".agents", "rules", "claude-memory-sync.md")), false);

    const applied = syncAgentMemory(tmpWs, { apply: true });
    assert.equal(applied.applied, true);
    assert.equal(fs.existsSync(path.join(tmpWs, "AGENTS.md.bak")), true);
    assert.equal(fs.existsSync(path.join(tmpWs, "CLAUDE.md.bak")), true);

    const agentsContent = fs.readFileSync(path.join(tmpWs, "AGENTS.md"), "utf8");
    assert.match(agentsContent, /Keep zero dependencies/);
    assert.match(agentsContent, /Always run npm test/);

    const agyRule = fs.readFileSync(path.join(tmpWs, ".agents", "rules", "claude-memory-sync.md"), "utf8");
    assert.match(agyRule, /trigger: always_on/);
    assert.match(agyRule, /Always run npm test/);

    // Verify idempotency on second run (managed block updated in-place, never duplicated)
    syncAgentMemory(tmpWs, { apply: true });
    const agentsSecond = fs.readFileSync(path.join(tmpWs, "AGENTS.md"), "utf8");
    assert.equal(agentsSecond, agentsContent);
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
