#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getConfig, listJobs, resolveWorkspaceRoot, SESSION_ID_ENV } from "./lib/state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const input = readHookInput();
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const workspaceRoot = resolveWorkspaceRoot(cwd);
const config = getConfig(workspaceRoot);

const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
const jobs = listJobs(workspaceRoot).filter((j) => !sessionId || j.sessionId === sessionId);
const running = jobs.find((j) => j.status === "queued" || j.status === "running");

if (running) {
  process.stderr.write(
    `Antigravity job ${running.id} is still running. Use /agy:status or /agy:cancel ${running.id} if needed.\n`
  );
}

if (config.stopReviewGate) {
  const templatePath = path.join(ROOT_DIR, "prompts", "stop-review-gate.md");
  const template = fs.readFileSync(templatePath, "utf8");
  const lastMsg = String(input.last_assistant_message ?? "").trim();
  const prompt = template.replace(
    "{{CLAUDE_RESPONSE_BLOCK}}",
    lastMsg ? `Previous Claude response:\n${lastMsg}` : ""
  );

  const companion = path.join(SCRIPT_DIR, "agy-companion.mjs");
  const res = spawnSync(process.execPath, [companion, "task", "--json", prompt], {
    cwd: workspaceRoot,
    env: { ...process.env, ...(sessionId ? { [SESSION_ID_ENV]: sessionId } : {}) },
    encoding: "utf8",
    windowsHide: true,
    timeout: 10 * 60 * 1000
  });

  if (res.status === 0 && res.stdout.trim()) {
    try {
      const payload = JSON.parse(res.stdout);
      const firstLine = String(payload.rawOutput ?? "").trim().split(/\r?\n/)[0]?.trim() || "";
      if (firstLine.startsWith("BLOCK:")) {
        const reason = firstLine.slice("BLOCK:".length).trim() || payload.rawOutput;
        process.stdout.write(
          `${JSON.stringify({ decision: "block", reason: `Antigravity stop-review gate blocked completion: ${reason}` })}\n`
        );
      }
    } catch {}
  }
}
