import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SESSION_ID_ENV = "AGY_COMPANION_SESSION_ID";
export const TRANSCRIPT_PATH_ENV = "AGY_COMPANION_TRANSCRIPT_PATH";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT = path.join(os.tmpdir(), "agy-companion");
const MAX_JOBS = 50;

export function nowIso() {
  return new Date().toISOString();
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  const resolved = path.resolve(cwd);
  try {
    const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolved,
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000
    });
    if (res.status === 0 && res.stdout.trim()) {
      return path.resolve(res.stdout.trim());
    }
  } catch {
    // Fallback to resolved cwd when outside a git repo.
  }
  return resolved;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const normalizedKey = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const slug = (path.basename(workspaceRoot) || "workspace")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(normalizedKey).digest("hex").slice(0, 16);
  const pluginData = process.env[PLUGIN_DATA_ENV];
  const root = pluginData ? path.join(pluginData, "state") : FALLBACK_STATE_ROOT;
  return path.join(root, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "state.json");
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function resolveHandoffsDir(cwd) {
  return path.join(resolveStateDir(cwd), "handoffs");
}

export function ensureStateDirs(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
  fs.mkdirSync(resolveHandoffsDir(cwd), { recursive: true });
}

function defaultState() {
  return {
    version: 1,
    config: { stopReviewGate: false },
    jobs: []
  };
}

export function loadState(cwd) {
  const file = resolveStateFile(cwd);
  if (!fs.existsSync(file)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: { ...defaultState().config, ...(parsed.config ?? {}) },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state) {
  const previous = loadState(cwd).jobs;
  ensureStateDirs(cwd);
  const jobs = [...(state.jobs ?? [])]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
  const retained = new Set(jobs.map((j) => j.id));
  for (const oldJob of previous) {
    if (!retained.has(oldJob.id)) {
      for (const f of [resolveJobFile(cwd, oldJob.id), oldJob.logFile]) {
        if (f && fs.existsSync(f)) {
          try { fs.unlinkSync(f); } catch {}
        }
      }
    }
  }
  const next = {
    version: 1,
    config: { ...defaultState().config, ...(state.config ?? {}) },
    jobs
  };
  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function generateJobId(prefix = "job") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDirs(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDirs(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function writeJobFile(cwd, jobId, payload) {
  const file = resolveJobFile(cwd, jobId);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

export function readJobFile(cwd, jobId) {
  const file = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function upsertJob(cwd, patch) {
  const state = loadState(cwd);
  const ts = nowIso();
  const idx = state.jobs.findIndex((j) => j.id === patch.id);
  if (idx === -1) {
    state.jobs.unshift({ createdAt: ts, updatedAt: ts, ...patch });
  } else {
    state.jobs[idx] = { ...state.jobs[idx], ...patch, updatedAt: ts };
  }
  return saveState(cwd, state);
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function setConfig(cwd, key, value) {
  const state = loadState(cwd);
  state.config = { ...state.config, [key]: value };
  return saveState(cwd, state);
}

export function appendJobLog(logFile, message) {
  if (!logFile || !message) return;
  fs.appendFileSync(logFile, `[${nowIso()}] ${String(message).trim()}\n`, "utf8");
}
