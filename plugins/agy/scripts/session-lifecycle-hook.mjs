#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { terminateProcessTree } from "./lib/agy-runtime.mjs";
import {
  loadState,
  resolveStateFile,
  resolveWorkspaceRoot,
  saveState,
  SESSION_ID_ENV,
  TRANSCRIPT_PATH_ENV
} from "./lib/state.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") return;
  const envFile = process.env.CLAUDE_ENV_FILE;
  const line = `export ${name}=${shellEscape(value)}`;
  const prefix = `export ${name}=`;
  if (fs.existsSync(envFile)) {
    const existingLines = fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter(Boolean);
    if (existingLines.includes(line)) return;
    const filtered = existingLines.filter((l) => !l.startsWith(prefix));
    filtered.push(line);
    fs.writeFileSync(envFile, `${filtered.join("\n")}\n`, "utf8");
    return;
  }
  fs.appendFileSync(envFile, `${line}\n`, "utf8");
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!cwd || !sessionId) return;

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) return;
  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((j) => j.sessionId === sessionId);
  for (const job of sessionJobs) {
    if ((job.status === "queued" || job.status === "running") && job.pid) {
      terminateProcessTree(job.pid);
    }
  }
  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((j) => j.sessionId !== sessionId || (j.status !== "queued" && j.status !== "running"))
  });
}

const input = readHookInput();
const eventName = process.argv[2] ?? input.hook_event_name ?? "";
if (eventName === "SessionStart") {
  handleSessionStart(input);
} else if (eventName === "SessionEnd") {
  handleSessionEnd(input);
}
