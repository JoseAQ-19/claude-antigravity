#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import {
  forkAntigravityConversation,
  getQuotaHud,
  pullFromAntigravity,
  undoAntigravityTurn
} from "./lib/agy-inspector.mjs";
import {
  cancelAntigravityJob,
  getAntigravityStatus,
  resolveExecutionBackendAndValidateModel,
  runDualAntigravityTurn,
  terminateProcessTree,
  SUPPORTED_CLI_MODELS,
  UNIFIED_MODEL_TIERS
} from "./lib/agy-runtime.mjs";
import {
  buildTransferHandoffBundle,
  resolveClaudeTranscriptPath
} from "./lib/claude-session-parser.mjs";
import { collectReviewContext } from "./lib/git.mjs";
import { failureKind, isActiveJob, isWithin, jobStatus } from "./lib/job-outcome.mjs";
import {
  buildMediaAnalysisBundle,
  buildPlanReviewBundle,
  syncAgentMemory
} from "./lib/media-plan-memory.mjs";
import {
  renderPullResult,
  renderQuotaHud,
  renderSetupReport,
  renderStatusTable,
  renderTransferResult,
  renderTurnResult
} from "./lib/render.mjs";
import {
  appendJobLog,
  generateJobId,
  getConfig,
  listJobs,
  nowIso,
  readJobFile,
  resolveJobLogFile,
  resolveWorkspaceRoot,
  SESSION_ID_ENV,
  setConfig,
  setLatestConversationId,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  applyWorktreePatch,
  captureWorktreeChanges,
  cleanupIsolatedWorktree,
  createIsolatedWorktree
} from "./lib/worktree.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");

const MODEL_HELP_FOOTER = [
  "",
  "Canonical Model Tiers (work identically on both desktop-live and cli-headless):",
  ...Object.values(UNIFIED_MODEL_TIERS).map(
    (t) => `  ${t.tier.padEnd(11)} -> desktop: --model=${t.desktopModel} | cli: --model ${t.cliModel}`
  ),
  "",
  `Concrete CLI Models (require --backend cli when Desktop is running):`,
  `  ${SUPPORTED_CLI_MODELS.join(", ")}`,
  "",
  "CLI Execution & Permission Modes (cli-headless):",
  "  - Read-only default: uses --mode=plan (never auto-approves destructive commands).",
  "  - Write tasks (--write, --worktree, transfer w/ next-step, media): uses --mode=auto --dangerously-skip-permissions."
].join("\n");

const SUBCOMMAND_HELP = {
  setup: [
    "Usage: node scripts/agy-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--cwd <dir>] [--json]",
    "",
    "Verify Google Antigravity 2.0 Desktop (live Connect RPC) and agy CLI readiness, or toggle the stop-time review gate."
  ].join("\n"),
  task: [
    "Usage: node scripts/agy-companion.mjs task [options] <prompt>",
    "",
    "Options:",
    "  --background                Run asynchronously in a detached worker process",
    "  --wait                      Run synchronously in foreground (default)",
    "  --write                     Allow file edits (enables --mode=auto --dangerously-skip-permissions on CLI)",
    "  --worktree                  Execute inside a clean, isolated git worktree (zero file collisions)",
    "  --keep-worktree             Preserve temporary git worktree directory after completion",
    "  --resume, --resume-last     Continue the latest workspace Antigravity conversation",
    "  --fresh                     Start a brand-new conversation even if a previous one exists",
    "  --conversation <id>         Resume a specific Antigravity conversation ID",
    "  --backend <auto|desktop|cli> Select engine explicitly (default: auto -> desktop-live if running, else cli)",
    "  --model, -m <tier|model-id> Model tier (pro|flash|flash_lite) or concrete CLI model ID (with --backend cli)",
    "  --prompt-file <path>        Read prompt text from a file instead of positional arguments",
    "  --focus-ui                  Bring Antigravity 2.0 Desktop conversation into visual focus",
    "  --timeout-ms <ms>           Time budget per desktop attempt / CLI invocation (default: 1200000)",
    "  --max-resumes <0..5>        Automatic desktop timeout/step-limit continuations (default: 2)",
    "  --allowed-path <path>      Restrict intended edit scope; repeat for multiple files/directories",
    "  --cwd, -C <dir>             Override target workspace directory",
    "  --json                      Emit structured JSON output",
    "  --help, -h                  Show this help message and exit without creating a job",
    MODEL_HELP_FOOTER
  ].join("\n"),
  "task-resume-candidate": [
    "Usage: node scripts/agy-companion.mjs task-resume-candidate [--cwd <dir>] [--json]",
    "",
    "Inspect whether a resumable Antigravity conversation exists for this workspace."
  ].join("\n"),
  transfer: [
    "Usage: node scripts/agy-companion.mjs transfer [options] [next-step instruction]",
    "",
    "Teleport the active Claude Code session transcript into Google Antigravity and optionally execute the next step.",
    "",
    "Options:",
    "  --source <claude-jsonl>     Explicit path to Claude Code .jsonl session file",
    "  --handoff-only              Transfer context without executing the next pending step",
    "  --no-focus                  Do not focus the conversation in Antigravity 2.0 Desktop UI",
    "  --background | --wait       Run asynchronously or wait in foreground",
    "  --backend <auto|desktop|cli> Select engine explicitly (default: auto)",
    "  --model, -m <tier|model-id> Model tier (pro|flash|flash_lite) or concrete CLI model ID (with --backend cli)",
    "  --cwd, -C <dir>             Override target workspace directory",
    "  --json                      Emit structured JSON output",
    MODEL_HELP_FOOTER
  ].join("\n"),
  pull: [
    "Usage: node scripts/agy-companion.mjs pull [conversation-id] [--list] [--all] [--cwd <dir>] [--json]",
    "",
    "Pull a live or offline Antigravity 2.0 conversation trajectory and file diffs back into Claude Code."
  ].join("\n"),
  media: [
    "Usage: node scripts/agy-companion.mjs media <file...> [--no-correlate] [--background|--wait] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--focus-ui] [--json] [question]",
    "",
    "Analyze video (.mp4/.mov/.webm), audio (.mp3/.wav/.m4a), PDF, or image files natively via Gemini multimodal perception."
  ].join("\n"),
  review: [
    "Usage: node scripts/agy-companion.mjs review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json]",
    "",
    "Run a read-only Google Antigravity code review against uncommitted git changes or a branch diff."
  ].join("\n"),
  "adversarial-review": [
    "Usage: node scripts/agy-companion.mjs adversarial-review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [focus text]",
    "",
    "Run a skeptical, adversarial Google Antigravity security & edge-case review."
  ].join("\n"),
  "review-plan": [
    "Usage: node scripts/agy-companion.mjs review-plan [--plan <file>] [--background|--wait] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [focus text]",
    "",
    "Critique an implementation plan (PLAN.md, PRD.md, or Claude Plan Mode file) before writing code."
  ].join("\n"),
  quota: [
    "Usage: node scripts/agy-companion.mjs quota [--show-account] [--cwd <dir>] [--json]",
    "",
    "Display live per-model Antigravity 2.0 quota progress bars, model IDs, reset timers, and active jobs."
  ].join("\n"),
  undo: [
    "Usage: node scripts/agy-companion.mjs undo [job-id] [--conversation <id>] [--step <n>] [--apply] [--cwd <dir>] [--json]",
    "",
    "Preview (dry-run default) or apply (--apply) a surgical rollback of the latest Antigravity turn."
  ].join("\n"),
  fork: [
    "Usage: node scripts/agy-companion.mjs fork [conversation-id] [--step <n>] [--no-focus] [--cwd <dir>] [--json]",
    "",
    "Clone an existing Antigravity 2.0 Desktop conversation into a new branch via ForkConversation RPC."
  ].join("\n"),
  "sync-memory": [
    "Usage: node scripts/agy-companion.mjs sync-memory [--direction <both|claude-to-agy|agy-to-claude>] [--apply] [--cwd <dir>] [--json]",
    "",
    "Synchronize shared rules non-destructively between CLAUDE.md and AGENTS.md + .agents/rules/claude-memory-sync.md."
  ].join("\n"),
  status: [
    "Usage: node scripts/agy-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--cwd <dir>] [--json]",
    "",
    "List recorded Antigravity jobs for this workspace or inspect a specific job's status, exit code, and recent log."
  ].join("\n"),
  result: [
    "Usage: node scripts/agy-companion.mjs result [job-id] [--apply-worktree] [--cwd <dir>] [--json]",
    "",
    "Retrieve the rendered output of a completed Antigravity job, or apply its isolated git worktree patch."
  ].join("\n"),
  cancel: [
    "Usage: node scripts/agy-companion.mjs cancel [job-id] [--cwd <dir>] [--json]",
    "",
    "Cancel an active background Antigravity job and stop its remote Cascade invocation."
  ].join("\n")
};

function hasHelpFlag(rawArgv) {
  const tokens = normalizeArgv(rawArgv);
  for (const tok of tokens) {
    if (tok === "--") break;
    if (tok === "--help" || tok === "-h" || tok === "--help=true") return true;
  }
  return false;
}

function printSubcommandHelp(subcommand) {
  const body = SUBCOMMAND_HELP[subcommand];
  if (body) {
    console.log(body);
    return;
  }
  printUsage();
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/agy-companion.mjs <command> [options]   (pass --help to any command for detailed options)",
      "",
      "Commands:",
      "  setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  task [--background|--wait] [--write] [--worktree] [--keep-worktree] [--resume|--fresh] [--conversation <id>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--focus-ui] [prompt]",
      "  task-resume-candidate [--json]",
      "  transfer [--source <claude-jsonl>] [--background|--wait] [--handoff-only] [--no-focus] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [instruction]",
      "  pull [conversation-id] [--list] [--all] [--json]",
      "  media <file...> [--no-correlate] [--background|--wait] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [question]",
      "  review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json]",
      "  adversarial-review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [focus text]",
      "  review-plan [--plan <file>] [--background|--wait] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [focus text]",
      "  quota [--show-account] [--json]",
      "  undo [job-id] [--conversation <id>] [--step <n>] [--apply] [--json]",
      "  fork [conversation-id] [--step <n>] [--no-focus] [--json]",
      "  sync-memory [--direction <both|claude-to-agy|agy-to-claude>] [--apply] [--json]",
      "  status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  result [job-id] [--apply-worktree] [--json]",
      "  cancel [job-id] [--json]",
      MODEL_HELP_FOOTER
    ].join("\n")
  );
}

function emitOutput(payload, rendered, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(rendered);
  }
}

function shorten(text, max = 80) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function readPromptTemplate(name, vars = {}) {
  let content = fs.readFileSync(path.join(ROOT_DIR, "prompts", `${name}.md`), "utf8");
  for (const [k, v] of Object.entries(vars)) {
    content = content.replaceAll(`{{${k}}}`, String(v ?? ""));
  }
  return content;
}

function findResumableJob(workspaceRoot, currentSessionOnly = false) {
  const sessionId = process.env[SESSION_ID_ENV] || null;
  const jobs = listJobs(workspaceRoot).filter((j) =>
    !currentSessionOnly || !sessionId ? true : j.sessionId === sessionId
  );
  const eligible = jobs.filter(
    (j) =>
      (j.kind === "task" || j.kind === "transfer" || j.kind === "media") &&
      j.conversationId &&
      j.conversationId !== "null" &&
      !isActiveJob(j) && j.status !== "dispatched"
  );
  return eligible[0] ?? null;
}

async function spawnBackgroundWorker(workspaceRoot, jobId, logFile) {
  const fd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [SCRIPT_PATH, "job-worker", "--cwd", workspaceRoot, "--job-id", jobId], {
      cwd: workspaceRoot,
      env: process.env,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true
    });
  } finally { fs.closeSync(fd); }
  let launchError = null;
  let closed = false;
  child.on("error", (err) => { launchError = err; });
  child.on("exit", () => { closed = true; });
  child.unref();
  const deadline = Date.now() + 10000;
  do {
    const stored = readJobFile(workspaceRoot, jobId);
    if (stored?.startedAt) return stored;
    if (launchError || closed) throw launchError || new Error("Background worker exited before acknowledging startup. Inspect the job log.");
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < deadline);
  terminateProcessTree(child.pid);
  throw new Error("Background worker did not acknowledge startup within 10s. Inspect the job log.");
}

async function executeJobRequest(workspaceRoot, jobId, request, logFile) {
  const onStarted = ({ conversationId, backend }) => {
    appendJobLog(logFile, `Connected via ${backend}; conversationId=${conversationId}`);
    if (conversationId) setLatestConversationId(workspaceRoot, conversationId);
    const current = readJobFile(workspaceRoot, jobId) ?? { id: jobId };
    writeJobFile(workspaceRoot, jobId, { ...current, conversationId, backend, phase: "running" });
    upsertJob(workspaceRoot, { id: jobId, conversationId, backend, phase: "running" });
  };
  const onProgress = (ev) => {
    const msg = typeof ev === "string" ? ev : ev?.message;
    if (msg) appendJobLog(logFile, msg);
    if (ev?.phase) {
      const current = readJobFile(workspaceRoot, jobId);
      writeJobFile(workspaceRoot, jobId, { ...current, phase: ev.phase });
    }
  };
  const onCheckpoint = (checkpoint) => {
    const current = readJobFile(workspaceRoot, jobId);
    const checkpointFile = `${logFile}.checkpoint.json`;
    fs.writeFileSync(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    writeJobFile(workspaceRoot, jobId, { ...current, checkpointFile, checkpoint,
      taskSummary: current.taskSummary || current.summary, fileVerification: checkpoint.fileVerification,
      touchedFiles: checkpoint.touchedFiles, summary: checkpoint.reason, phase: "checkpoint" });
    appendJobLog(logFile, `Checkpoint saved: ${checkpointFile}; ${checkpoint.reason}`);
  };
  const runtimeOptions = { timeoutMs: request.timeoutMs, maxResumes: request.maxResumes,
    allowedPaths: request.allowedPaths, onCheckpoint };

  if (request.type === "transfer") {
    const turn = await runDualAntigravityTurn(workspaceRoot, {
      ...runtimeOptions,
      prompt: request.prompt,
      title: request.conversationTitle,
      backend: request.backend || "auto",
      model: request.model || "pro",
      write: request.executeNextStep !== false,
      focusUi: request.focusUi !== false,
      kind: "transfer",
      onStarted,
      onProgress
    });
    const payload = {
      status: turn.exitStatus,
      jobStatus: jobStatus(turn),
      errorMessage: turn.errorMessage,
      failureKind: turn.failureKind,
      fileVerification: turn.fileVerification,
      completionVerified: turn.completionVerified,
      resumeCount: turn.resumeCount,
      checkpoints: turn.checkpoints,
      backend: turn.backend,
      conversationId: turn.conversationId || null,
      resumeCommand: turn.conversationId ? `agy --conversation ${turn.conversationId}` : null,
      sourcePath: request.sourcePath,
      handoffPath: request.handoffPath,
      focusedUi: request.focusUi !== false && turn.backend === "desktop-live",
      executeNextStep: request.executeNextStep !== false,
      finalMessage: turn.finalMessage,
      touchedFiles: turn.touchedFiles,
      reasoningSummary: turn.reasoningSummary
    };
    const rendered = renderTransferResult(payload);
    return {
      ...turn,
      exitStatus: turn.exitStatus,
      conversationId: turn.conversationId,
      backend: turn.backend,
      touchedFiles: turn.touchedFiles,
      payload,
      rendered
    };
  }

  // Optional isolated git worktree execution (zero file collisions with Claude Code!)
  let wtInfo = null;
  let wtChanges = null;
  let targetCwd = workspaceRoot;
  let preserveWorktree = Boolean(request.keepWorktree);

  if (request.worktree) {
    wtInfo = createIsolatedWorktree(workspaceRoot, jobId);
    targetCwd = wtInfo.worktreePath;
    preserveWorktree = true; // Preserve recovery files until execution and patch export are confirmed.
    const current = readJobFile(workspaceRoot, jobId);
    writeJobFile(workspaceRoot, jobId, { ...current, worktreePath: targetCwd });
    appendJobLog(logFile, `Created isolated git worktree at ${wtInfo.worktreePath}`);
  }

  try {
    const turn = await runDualAntigravityTurn(targetCwd, {
      ...runtimeOptions,
      prompt: request.prompt,
      title: request.title,
      resumeConversationId: request.resumeConversationId || null,
      backend: request.backend || "auto",
      model: request.model || "pro",
      write: Boolean(request.write || request.worktree),
      focusUi: Boolean(request.focusUi),
      kind: request.type,
      onStarted,
      onProgress
    });

    if (wtInfo) {
      wtChanges = captureWorktreeChanges(workspaceRoot, wtInfo.worktreePath, jobId);
      preserveWorktree = Boolean(request.keepWorktree || turn.completionVerified === false ||
        ["timeout", "step_limit"].includes(turn.failureKind));
      if (wtChanges.changedFiles.length > 0) {
        turn.touchedFiles = wtChanges.changedFiles;
      }
    }

    const payload = {
      status: turn.exitStatus,
      jobStatus: jobStatus(turn),
      errorMessage: turn.errorMessage,
      failureKind: turn.failureKind,
      scopeViolations: turn.scopeViolations,
      fileVerification: turn.fileVerification,
      completionVerified: turn.completionVerified,
      resumeCount: turn.resumeCount,
      checkpoints: turn.checkpoints,
      backend: turn.backend,
      conversationId: turn.conversationId,
      rawOutput: turn.finalMessage,
      touchedFiles: turn.touchedFiles,
      reasoningSummary: turn.reasoningSummary,
      ...(wtChanges
        ? {
            worktreeIsolated: true,
            worktreePatchPath: wtChanges.patchPath,
            worktreeDiffStat: wtChanges.diffStat
          }
        : {}),
      ...(wtInfo && preserveWorktree ? { retainedWorktreePath: wtInfo.worktreePath } : {}),
      ...(request.mediaReportPath ? { mediaReportPath: request.mediaReportPath } : {})
    };
    const rendered = renderTurnResult(turn, {
      title: request.title,
      jobId,
      worktreePatchPath: wtChanges?.patchPath || null,
      worktreeDiffStat: wtChanges?.diffStat || null,
      retainedWorktreePath: wtInfo && preserveWorktree ? wtInfo.worktreePath : null,
      mediaReportPath: request.mediaReportPath || null
    });
    return {
      ...turn,
      exitStatus: turn.exitStatus,
      conversationId: turn.conversationId,
      backend: turn.backend,
      touchedFiles: turn.touchedFiles,
      payload,
      rendered
    };
  } finally {
    if (wtInfo && !preserveWorktree) {
      cleanupIsolatedWorktree(workspaceRoot, wtInfo.worktreePath);
    }
  }
}

function finishTrackedJob(workspaceRoot, jobId, execRes, logFile) {
  const current = readJobFile(workspaceRoot, jobId);
  if (current.status === "canceled") return current;
  const status = jobStatus(execRes);
  const completed = { ...current, status, phase: status === "completed" ? "done" : status,
    exitStatus: execRes.exitStatus, conversationId: execRes.conversationId, backend: execRes.backend,
    taskSummary: current.taskSummary || current.summary,
    summary: execRes.errorMessage || shorten(execRes.finalMessage || current.summary, 240),
    errorMessage: execRes.errorMessage || null, failureKind: execRes.failureKind || null,
    touchedFiles: execRes.touchedFiles || [], fileVerification: execRes.fileVerification || [],
    resumeCount: execRes.resumeCount || 0, checkpoints: execRes.checkpoints || [],
    remoteStopped: execRes.remoteStopped, completionVerified: execRes.completionVerified,
    pid: null, completedAt: nowIso(), result: execRes.payload, rendered: execRes.rendered };
  appendJobLog(logFile, `Finished job (${status}): exitStatus=${execRes.exitStatus}, backend=${execRes.backend || "unknown"}, conversationId=${execRes.conversationId || "none"}, touchedFiles=${completed.touchedFiles.length}`);
  if (completed.errorMessage) appendJobLog(logFile, `Reason: ${completed.errorMessage}`);
  writeJobFile(workspaceRoot, jobId, completed);
  upsertJob(workspaceRoot, completed);
  return completed;
}

function failTrackedJob(workspaceRoot, jobId, err, logFile, kind) {
  const current = readJobFile(workspaceRoot, jobId);
  if (current?.status === "canceled") return current;
  const message = err instanceof Error ? err.message : String(err);
  const failed = { ...current, status: "failed", phase: "failed", exitStatus: 1, pid: null,
    taskSummary: current?.taskSummary || current?.summary, summary: message,
    errorMessage: message, failureKind: kind || failureKind(message), completedAt: nowIso() };
  writeJobFile(workspaceRoot, jobId, failed);
  upsertJob(workspaceRoot, failed);
  appendJobLog(logFile, `Finished job (failed): exitStatus=1; ${message}`);
  return failed;
}

async function runTrackedForeground(workspaceRoot, jobRecord, request, asJson) {
  const logFile = resolveJobLogFile(workspaceRoot, jobRecord.id);
  const running = { ...jobRecord, status: "running", phase: "starting", startedAt: nowIso(), pid: process.pid, logFile, request };
  writeJobFile(workspaceRoot, jobRecord.id, running);
  upsertJob(workspaceRoot, running);
  appendJobLog(logFile, `Starting foreground ${jobRecord.kind}: ${jobRecord.title}`);
  try {
    const execRes = await executeJobRequest(workspaceRoot, jobRecord.id, request, logFile);
    finishTrackedJob(workspaceRoot, jobRecord.id, execRes, logFile);
    emitOutput(execRes.payload, execRes.rendered, asJson);
    process.exitCode = execRes.exitStatus;
  } catch (err) {
    failTrackedJob(workspaceRoot, jobRecord.id, err, logFile);
    throw err;
  }
}

async function enqueueBackground(workspaceRoot, jobRecord, request, asJson) {
  const logFile = resolveJobLogFile(workspaceRoot, jobRecord.id);
  const queued = { ...jobRecord, status: "queued", phase: "queued", queuedAt: nowIso(), logFile, request };
  writeJobFile(workspaceRoot, jobRecord.id, queued);
  upsertJob(workspaceRoot, queued);
  appendJobLog(logFile, `Queued background ${jobRecord.kind}: ${jobRecord.title}`);
  let started;
  try {
    started = await spawnBackgroundWorker(workspaceRoot, jobRecord.id, logFile);
  } catch (err) {
    failTrackedJob(workspaceRoot, jobRecord.id, err, logFile, "launch_error");
    throw err;
  }
  const payload = { jobId: jobRecord.id, status: started.status, launchAcknowledged: true,
    startedAt: started.startedAt, kind: jobRecord.kind, title: jobRecord.title,
    summary: started.summary, worktreeIsolated: Boolean(request.worktree), logFile };
  const rendered = `${jobRecord.title} started in background as \`${jobRecord.id}\` (startup acknowledged; status=${started.status}).\nUse \`/agy:status ${jobRecord.id} --wait\` and \`/agy:result ${jobRecord.id}\` to verify the job outcome.\n`;
  emitOutput(payload, rendered, asJson);
}

async function handleJobWorker(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["cwd", "job-id"] });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const jobId = options["job-id"];
  const stored = readJobFile(workspaceRoot, jobId);
  if (!stored?.request) throw new Error(`Missing request for worker job ${jobId}`);
  if (stored.status !== "queued") throw new Error(`Job ${jobId} is already ${stored.status}`);
  const logFile = stored.logFile || resolveJobLogFile(workspaceRoot, jobId);
  const running = { ...stored, status: "running", phase: "starting", startedAt: nowIso(), pid: process.pid };
  appendJobLog(logFile, `Starting background worker: pid=${process.pid}`);
  writeJobFile(workspaceRoot, jobId, running);
  upsertJob(workspaceRoot, running);
  try {
    const execRes = await executeJobRequest(workspaceRoot, jobId, stored.request, logFile);
    finishTrackedJob(workspaceRoot, jobId, execRes, logFile);
    process.exitCode = execRes.exitStatus;
  } catch (err) {
    failTrackedJob(workspaceRoot, jobId, err, logFile);
    process.exitCode = 1;
  }
}

function reconcileJob(workspaceRoot, stored) {
  if (!stored) return stored;
  if (isActiveJob(stored)) {
    let alive = false;
    if (stored.pid) {
      try { process.kill(stored.pid, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; }
    }
    const expiredQueue = stored.status === "queued" && Date.now() - Date.parse(stored.queuedAt || stored.createdAt || 0) > 30000;
    if ((stored.pid && !alive) || (!stored.pid && (stored.status === "running" || expiredQueue))) {
      return failTrackedJob(workspaceRoot, stored.id,
        new Error(stored.startedAt ? "Worker exited without recording a terminal job state; inspect files and conversation before resuming." : "Worker never acknowledged startup."),
        stored.logFile, "worker_lost");
    }
  }
  // Upgrade diagnostics for records created by older plugin versions.
  const errorMessage = stored.errorMessage || stored.result?.errorMessage ||
    (stored.status === "failed" ? stored.result?.rawOutput || stored.result?.finalMessage : null);
  return errorMessage ? { ...stored, errorMessage, summary: errorMessage } : stored;
}

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled stop-time Antigravity review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled stop-time Antigravity review gate for ${workspaceRoot}.`);
  }

  const status = await getAntigravityStatus(workspaceRoot);
  const config = getConfig(workspaceRoot);
  const nextSteps = [];
  if (!status.desktop.available) {
    nextSteps.push("Open Antigravity 2.0 Desktop to enable live visual conversation handoffs, quota HUD & RPC.");
  }
  if (!status.cli.available) {
    const installHint = status.cli.installUrl || status.cli.installCommand || "https://antigravity.google/download";
    nextSteps.push(`Optional headless fallback: install \`agy\` CLI from ${installHint}.`);
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/agy:setup --enable-review-gate` to verify Claude turns before stopping.");
  }

  const report = {
    ...status,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
  emitOutput(report, renderSetupReport(report), Boolean(options.json));
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["cwd"], booleanOptions: ["json"], aliasMap: { C: "cwd" } });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const candidate = findResumableJob(workspaceRoot, false);
  const payload = {
    available: Boolean(candidate?.conversationId),
    conversationId: candidate?.conversationId ?? null,
    jobId: candidate?.id ?? null,
    summary: candidate?.summary ?? null
  };
  emitOutput(payload, `${JSON.stringify(payload)}\n`, Boolean(options.json));
}

function executionSettings(options, workspaceRoot) {
  const timeoutMs = options["timeout-ms"] == null ? 1200000 : Number(options["timeout-ms"]);
  const maxResumes = options["max-resumes"] == null ? 2 : Number(options["max-resumes"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive integer.");
  if (!Number.isInteger(maxResumes) || maxResumes < 0 || maxResumes > 5) throw new Error("--max-resumes must be an integer from 0 to 5.");
  const allowedPaths = options["allowed-path"] || [];
  if (allowedPaths.some((p) => !p || !isWithin(workspaceRoot, path.resolve(workspaceRoot, p)))) {
    throw new Error("Each --allowed-path must be inside the assigned workspace.");
  }
  return { timeoutMs, maxResumes, allowedPaths: allowedPaths.map((p) => path.relative(workspaceRoot, path.resolve(workspaceRoot, p)) || ".") };
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "backend", "model", "timeout-ms", "max-resumes", "conversation", "prompt-file", "allowed-path"],
    repeatableOptions: ["allowed-path"],
    booleanOptions: [
      "json",
      "background",
      "wait",
      "write",
      "worktree",
      "keep-worktree",
      "resume",
      "resume-last",
      "fresh",
      "focus-ui"
    ],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  if (options.help) {
    printSubcommandHelp("task");
    return;
  }
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  let prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ").trim();

  let resumeConversationId =
    options.conversation && options.conversation !== "null" && options.conversation !== "undefined"
      ? options.conversation
      : null;
  if (!resumeConversationId && (options.resume || options["resume-last"]) && !options.fresh) {
    const prev = findResumableJob(workspaceRoot, false);
    if (!prev?.conversationId) {
      throw new Error("No previous Antigravity conversation found for this workspace to resume.");
    }
    if (prev.request?.worktree) throw new Error(`The previous task used an isolated worktree (${prev.worktreePath}). Inspect it or apply its saved patch before starting another task.`);
    resumeConversationId = prev.conversationId;
  }

  if (options.worktree && resumeConversationId) throw new Error("--worktree cannot resume an existing conversation; start a fresh isolated task.");

  if (!prompt && resumeConversationId) {
    prompt = "Continue from the current conversation state. Execute the next highest-value pending step and verify it.";
  }
  if (!prompt) {
    throw new Error("Provide a task prompt for Antigravity (or use --resume).");
  }

  executionSettings(options, workspaceRoot);
  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  const jobId = generateJobId("task");
  const title = resumeConversationId
    ? "Antigravity Follow-up Task"
    : options.worktree
      ? `Antigravity Worktree Task: ${shorten(prompt, 42)}`
      : `Antigravity Task: ${shorten(prompt, 48)}`;
  const jobRecord = {
    id: jobId,
    kind: "task",
    title,
    summary: shorten(prompt, 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: "task",
    prompt,
    title,
    resumeConversationId,
    backend: options.backend || "auto",
    model: options.model || "pro",
    ...executionSettings(options, workspaceRoot),
    write: Boolean(options.write || options.worktree),
    worktree: Boolean(options.worktree),
    keepWorktree: Boolean(options["keep-worktree"]),
    focusUi: Boolean(options["focus-ui"])
  };

  if (options.background) {
    await enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handleTransfer(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "source", "backend", "model", "timeout-ms", "max-resumes"],
    booleanOptions: ["json", "background", "wait", "handoff-only", "no-focus"],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  if (options.help) {
    printSubcommandHelp("transfer");
    return;
  }
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const extraInstruction = positionals.join(" ").trim();
  const executeNextStep = !options["handoff-only"];
  const focusUi = !options["no-focus"];

  executionSettings(options, workspaceRoot);
  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  const sourcePath = resolveClaudeTranscriptPath(cwd, { source: options.source });
  const bundle = buildTransferHandoffBundle(sourcePath, workspaceRoot, {
    executeNextStep,
    extraInstruction
  });

  const jobId = generateJobId("transfer");
  const jobRecord = {
    id: jobId,
    kind: "transfer",
    title: bundle.conversationTitle,
    summary: shorten(extraInstruction || `Session transfer: ${bundle.title}`, 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: "transfer",
    sourcePath,
    handoffPath: bundle.handoffPath,
    conversationTitle: bundle.conversationTitle,
    prompt: bundle.prompt,
    backend: options.backend || "auto",
    model: options.model || "pro",
    ...executionSettings(options, workspaceRoot),
    executeNextStep,
    focusUi
  };

  if (options.background) {
    await enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handlePull(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "list", "all"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const res = await pullFromAntigravity(cwd, {
    conversationId: positionals[0] || null,
    listOnly: Boolean(options.list),
    all: Boolean(options.all)
  });
  emitOutput(res, renderPullResult(res), Boolean(options.json));
}

async function handleMedia(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "backend", "model", "timeout-ms", "max-resumes"],
    booleanOptions: ["json", "background", "wait", "no-correlate", "focus-ui"],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  executionSettings(options, workspaceRoot);
  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  const bundle = buildMediaAnalysisBundle(cwd, positionals, {
    correlate: !options["no-correlate"]
  });

  const jobId = generateJobId("media");
  const jobRecord = {
    id: jobId,
    kind: "media",
    title: bundle.conversationTitle,
    summary: shorten(bundle.focusQuestion || `Media analysis: ${bundle.mediaFiles.map((m) => m.name).join(", ")}`, 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: "media",
    prompt: bundle.prompt,
    title: bundle.conversationTitle,
    mediaReportPath: bundle.fullReportPath,
    backend: options.backend || "auto",
    model: options.model || "pro",
    ...executionSettings(options, workspaceRoot),
    write: true,
    focusUi: Boolean(options["focus-ui"])
  };

  if (options.background) {
    await enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handleReview(argv, adversarial = false) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "base", "scope", "backend", "model", "timeout-ms", "max-resumes"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const focusText = positionals.join(" ").trim();

  executionSettings(options, workspaceRoot);
  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  const ctx = collectReviewContext(workspaceRoot, {
    base: options.base || null,
    scope: options.scope || "auto"
  });
  const prompt = adversarial
    ? readPromptTemplate("adversarial-review", {
        TARGET_LABEL: ctx.targetLabel,
        USER_FOCUS: focusText || "Challenge assumptions, edge cases, and architectural risks.",
        REVIEW_INPUT: ctx.content
      })
    : readPromptTemplate("review", {
        TARGET_LABEL: ctx.targetLabel,
        REVIEW_INPUT: ctx.content
      });

  const kind = adversarial ? "adversarial-review" : "review";
  const title = adversarial
    ? `Antigravity Adversarial Review (${ctx.targetLabel})`
    : `Antigravity Code Review (${ctx.targetLabel})`;
  const jobId = generateJobId("review");
  const jobRecord = {
    id: jobId,
    kind,
    title,
    summary: shorten(`${title} ${focusText}`.trim(), 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: kind,
    prompt,
    title,
    backend: options.backend || "auto",
    model: options.model || "pro",
    ...executionSettings(options, workspaceRoot),
    write: false,
    focusUi: false
  };

  if (options.background) {
    await enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handleReviewPlan(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "plan", "backend", "model", "timeout-ms", "max-resumes"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  executionSettings(options, workspaceRoot);
  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  let explicitPlan = options.plan || null;
  const focusParts = [...positionals];
  if (!explicitPlan && focusParts.length > 0) {
    const maybeFile = path.resolve(cwd, focusParts[0]);
    if (fs.existsSync(maybeFile) && fs.statSync(maybeFile).isFile()) {
      explicitPlan = focusParts.shift();
    }
  }

  const rubric = readPromptTemplate("review-plan");
  const bundle = buildPlanReviewBundle(cwd, rubric, {
    planFile: explicitPlan,
    focus: focusParts.join(" ").trim()
  });

  const jobId = generateJobId("plan-review");
  const jobRecord = {
    id: jobId,
    kind: "review-plan",
    title: bundle.conversationTitle,
    summary: shorten(`Plan critique: ${path.basename(bundle.target.label)}`, 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: "review-plan",
    prompt: bundle.prompt,
    title: bundle.conversationTitle,
    backend: options.backend || "auto",
    model: options.model || "pro",
    ...executionSettings(options, workspaceRoot),
    write: false,
    focusUi: false
  };

  if (options.background) {
    await enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handleQuota(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "show-account"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const hud = await getQuotaHud(cwd, { showAccount: Boolean(options["show-account"]) });
  emitOutput(hud, renderQuotaHud(hud), Boolean(options.json));
}

async function handleUndo(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "conversation", "step"],
    booleanOptions: ["json", "apply"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const res = await undoAntigravityTurn(cwd, {
    jobId: positionals[0] || null,
    conversationId: options.conversation || null,
    stepIndex: options.step != null ? Number(options.step) : null,
    apply: Boolean(options.apply)
  });

  const rendered = res.applied
    ? [
        `## Antigravity Turn Reverted`,
        res.conversationId ? `- **Conversation ID:** \`${res.conversationId}\` (reverted to step ${res.stepIndex})` : null,
        res.revertedViaRpc ? `- **Method:** Live Antigravity Desktop RPC (\`RevertToCascadeStep\`)` : null,
        res.revertedGitFiles?.length
          ? `- **Reverted Git Files:** ${res.revertedGitFiles.map((f) => `\`${f}\``).join(", ")}`
          : null
      ]
        .filter(Boolean)
        .join("\n") + "\n"
    : [
        `## Antigravity Revert Preview (Dry Run)`,
        `- **Target Conversation:** \`${res.conversationId || "none"}\``,
        res.stepIndex != null ? `- **Revert Target Step Index:** ${res.stepIndex}` : null,
        `- **Desktop Revert Preview Edits:** ${res.previewEditsCount}`,
        res.touchedFiles?.length
          ? `- **Tracked Touched Files:** ${res.touchedFiles.map((f) => `\`${f}\``).join(", ")}`
          : `- **Tracked Touched Files:** (none recorded)`,
        "",
        `> ${res.message}`
      ]
        .filter(Boolean)
        .join("\n") + "\n";

  emitOutput(res, rendered, Boolean(options.json));
}

async function handleFork(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "step"],
    booleanOptions: ["json", "no-focus"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const res = await forkAntigravityConversation(cwd, {
    conversationId: positionals[0] || null,
    stepIndex: options.step != null ? Number(options.step) : null,
    focusUi: !options["no-focus"]
  });
  const rendered = [
    `## Forked Antigravity Conversation`,
    `- **Source Conversation ID:** \`${res.sourceConversationId}\``,
    `- **New Forked Conversation ID:** \`${res.newConversationId}\` *(now set as active \`--resume\` target)*`,
    `- **Forked at Step Index:** ${res.forkedAtStepIndex}`,
    `- **Continue on Fork:** \`/agy:rescue --resume "<explore alternative approach>"\``
  ].join("\n") + "\n";
  emitOutput(res, rendered, Boolean(options.json));
}

async function handleSyncMemory(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "direction"],
    booleanOptions: ["json", "apply"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const res = syncAgentMemory(cwd, {
    direction: options.direction || "both",
    apply: Boolean(options.apply)
  });

  const lines = [
    `## Cross-Agent Memory Sync (${res.applied ? "APPLIED" : "DRY-RUN PREVIEW"})`,
    `- **Workspace:** \`${res.workspaceRoot}\``,
    `- **Direction:** \`${res.direction}\``,
    `- **Detected Files:** \`CLAUDE.md\`=${res.detected.claudeMd ? "yes" : "no"}, \`AGENTS.md\`=${res.detected.agentsMd ? "yes" : "no"}, \`GEMINI.md\`=${res.detected.geminiMd ? "yes" : "no"}`
  ];
  if (res.actions.length === 0) {
    lines.push("", "No unsynced memory blocks found (create `CLAUDE.md` or `AGENTS.md` first, or files are already identical).");
  } else {
    lines.push("", "### Sync Operations");
    for (const a of res.actions) {
      lines.push(`- **${a.direction}**: \`${path.basename(a.source)}\` (${a.chars} chars) -> ${a.targets.map((t) => `\`${path.relative(res.workspaceRoot, t)}\``).join(", ")}`);
    }
    if (!res.applied) {
      lines.push("", "> Re-run `/agy:sync-memory --apply` to write these non-destructive managed blocks (with `.bak` backups).");
    }
  }
  emitOutput(res, `${lines.join("\n")}\n`, Boolean(options.json));
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json", "wait", "all"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const jobId = positionals[0] || null;
  const config = getConfig(workspaceRoot);

  if (jobId) {
    const deadline = Date.now() + (Number(options["timeout-ms"]) || 240000);
    let stored = reconcileJob(workspaceRoot, readJobFile(workspaceRoot, jobId));
    if (!stored) throw new Error(`Job not found: ${jobId}`);
    while (options.wait && (stored.status === "queued" || stored.status === "running") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      stored = reconcileJob(workspaceRoot, readJobFile(workspaceRoot, jobId)) ?? stored;
    }
    const logTail =
      stored.logFile && fs.existsSync(stored.logFile)
        ? fs.readFileSync(stored.logFile, "utf8").trim().split(/\r?\n/).slice(-12).join("\n")
        : "";
    const rendered =
      [
        `## Job \`${stored.id}\` — **${stored.status}**`,
        `- **Title:** ${stored.title}`,
        `- **Phase:** ${stored.phase || "-"}`,
        stored.startedAt ? `- **Started At:** ${stored.startedAt}` : null,
        stored.completedAt ? `- **Finished At:** ${stored.completedAt}` : null,
        stored.exitStatus != null ? `- **Exit Code:** \`${stored.exitStatus}\`` : null,
        stored.conversationId ? `- **Antigravity Conversation ID:** \`${stored.conversationId}\`` : null,
        stored.errorMessage ? `- **Error:** ${stored.errorMessage}` : null,
        stored.touchedFiles?.length ? `- **Detected Files:** ${stored.touchedFiles.join(", ")}` : null,
        stored.checkpointFile ? `- **Recovery Checkpoint:** ${stored.checkpointFile}` : null,
        logTail ? `\n### Recent Log\n\`\`\`text\n${logTail}\n\`\`\`` : null
      ]
        .filter(Boolean)
        .join("\n") + "\n";
    emitOutput(stored, rendered, Boolean(options.json));
    if (options.wait) process.exitCode = isActiveJob(stored) || stored.status === "dispatched" ? 124 :
      stored.exitStatus ?? (stored.status === "completed" ? 0 : stored.status === "canceled" ? 130 : 1);
    return;
  }

  const sessionId = process.env[SESSION_ID_ENV] || null;
  const jobs = listJobs(workspaceRoot).map((j) => reconcileJob(workspaceRoot, j)).filter((j) => options.all || !sessionId || j.sessionId === sessionId);
  emitOutput(
    { jobs, reviewGateEnabled: Boolean(config.stopReviewGate) },
    renderStatusTable(jobs, config.stopReviewGate),
    Boolean(options.json)
  );
}

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "apply-worktree"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const requestedId = positionals[0] || listJobs(workspaceRoot)[0]?.id;
  if (!requestedId) throw new Error("No jobs recorded in this workspace yet.");
  const stored = reconcileJob(workspaceRoot, readJobFile(workspaceRoot, requestedId));
  if (!stored) throw new Error(`Job not found: ${requestedId}`);

  if (options["apply-worktree"]) {
    const patchPath = stored.result?.worktreePatchPath;
    if (!patchPath) {
      throw new Error(`Job ${requestedId} has no isolated worktree patch to apply.`);
    }
    const applied = applyWorktreePatch(workspaceRoot, patchPath);
    const msg = `Applied isolated worktree patch from job \`${requestedId}\` (\`${patchPath}\`) cleanly into working tree.\n`;
    emitOutput({ jobId: requestedId, ...applied }, msg, Boolean(options.json));
    return;
  }

  const rendered =
    stored.rendered ||
    (stored.errorMessage
      ? `Job ${requestedId} failed: ${stored.errorMessage}\n`
      : `Job ${requestedId} is currently ${stored.status}.\n`);
  emitOutput(stored, rendered, Boolean(options.json));
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const jobs = listJobs(workspaceRoot);
  const targetId = positionals[0] || jobs.find((j) => j.status === "queued" || j.status === "running")?.id;
  if (!targetId) throw new Error("No active Antigravity job found to cancel.");
  const stored = readJobFile(workspaceRoot, targetId);
  if (!stored) throw new Error(`Job not found: ${targetId}`);

  const cancelRes = await cancelAntigravityJob(workspaceRoot, stored);
  const updated = { ...stored, status: "canceled", phase: "canceled", exitStatus: 130, pid: null, completedAt: nowIso() };
  appendJobLog(stored.logFile, "Finished job (canceled): exitStatus=130; cancellation requested.");
  writeJobFile(workspaceRoot, targetId, updated);
  upsertJob(workspaceRoot, {
    id: targetId,
    status: "canceled",
    phase: "canceled",
    exitStatus: 130,
    pid: null,
    completedAt: updated.completedAt
  });

  const payload = { jobId: targetId, status: "canceled", ...cancelRes };
  const rendered = `Canceled Antigravity job \`${targetId}\`${stored.conversationId ? ` (conversation \`${stored.conversationId}\`)` : ""}.\n`;
  emitOutput(payload, rendered, Boolean(options.json));
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }
  if (subcommand === "help") {
    const target = normalizeArgv(rest)[0];
    printSubcommandHelp(target);
    return;
  }
  if (subcommand !== "job-worker" && SUBCOMMAND_HELP[subcommand] && hasHelpFlag(rest)) {
    printSubcommandHelp(subcommand);
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(rest);
      break;
    case "task":
      await handleTask(rest);
      break;
    case "task-resume-candidate":
      await handleTaskResumeCandidate(rest);
      break;
    case "transfer":
      await handleTransfer(rest);
      break;
    case "pull":
      await handlePull(rest);
      break;
    case "media":
      await handleMedia(rest);
      break;
    case "review":
      await handleReview(rest, false);
      break;
    case "adversarial-review":
      await handleReview(rest, true);
      break;
    case "review-plan":
      await handleReviewPlan(rest);
      break;
    case "quota":
      await handleQuota(rest);
      break;
    case "undo":
      await handleUndo(rest);
      break;
    case "fork":
      await handleFork(rest);
      break;
    case "sync-memory":
      await handleSyncMemory(rest);
      break;
    case "status":
      await handleStatus(rest);
      break;
    case "result":
      await handleResult(rest);
      break;
    case "cancel":
      await handleCancel(rest);
      break;
    case "job-worker":
      await handleJobWorker(rest);
      break;
    default:
      throw new Error(`Unknown command "${subcommand}". Run with --help for usage.`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
